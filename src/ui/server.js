'use strict';

/**
 * server.js — the OPTIONAL config web UI for the gateway (loopback-only).
 *
 * A zero-dependency node:http server that lets a human VIEW / SEARCH / CONFIGURE
 * the gateway's tools, upstream MCPs, and hooks without hand-editing JSON. It does
 * NOT reinvent any state: every read and write goes THROUGH the gateway's proven stores —
 *   - the tool register     (src/tools/registry.js     :: loadRegistry → add/update/remove/writeScript)
 *   - the enabled overlay   (src/tools/tool-state.js    :: loadToolState / setToolEnabled / clearToolState)
 *   - the MCP expose store  (src/mcp/expose-store.js    :: loadExposeStore → addUpstream/addExpose/…)
 *   - the hook loader       (src/core/hook-loader.js    :: loadManifest → addEntry/setEnabled/removeEntry)
 *   - the hook matcher      (src/core/matcher.js        :: matches)
 *   - the atomic writer     (src/tools/registry.js      :: atomicWriteJson)        [tool Pre/Post gate writes]
 * so a UI edit is byte-identical to a CLI edit and is visible to the running MCP
 * server with no restart (the register/state/manifest are all re-read per call).
 *
 * The UI runs in-process for the trusted human operator, so it uses the stores
 * DIRECTLY (no MCP round-trip). Every write is atomic (temp + rename) inside the store.
 *
 * SAFETY CONTRACT (mirrors src/mcp/http-transport.js):
 *   - start() HARD-REFUSES a non-loopback bind host. The UI has no auth path at all, and it can
 *     spawn processes (mcp add/discover) and write scripts (tools/hooks) — off-loopback it would be
 *     an unauthenticated remote console. Loopback-only by design; no flag overrides it.
 *   - Binds 127.0.0.1 by default; a non-loopback Host header is rejected (DNS-rebind guard).
 *   - The request listener NEVER throws — a bad request becomes a clean JSON error.
 *   - start() rejects cleanly on EADDRINUSE (caller decides); stop() is idempotent.
 *   - Every store read is FRESH per request, so edits made elsewhere show immediately.
 *
 * CommonJS only. Node BUILT-INS only (node:http, node:fs, node:path) — no new npm dep,
 * no CDN, no framework. The static assets under src/ui/public are vanilla HTML/CSS/JS.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { loadRegistry, atomicWriteJson, resolveMode } = require('../tools/registry');
const { loadToolState, isToolEnabled, isToolHidden, isToolHot, setToolEnabled, setToolHidden, setToolHot, clearToolState } = require('../tools/tool-state');
const { loadExposeStore } = require('../mcp/expose-store');
const { Aggregator } = require('../mcp/aggregator');
const { loadManifest } = require('../core/hook-loader');
const { matches } = require('../core/matcher');
const { META_TOOLS } = require('../mcp/protocol');
const logger = require('../core/logger');
const authConfig = require('../auth/config');
const { isJoseInstalled, JOSE_PIN } = require('../auth/resource-server');
const { installJose } = require('../auth/install');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9777;
// Config POST bodies are small, but an "add" may carry a scriptText file body; 256 KiB is
// generous headroom for a tool/hook script while still capping an abusive request.
const MAX_BODY_BYTES = 256 * 1024;
const VALID_HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

// Static asset content types (vanilla, offline — no external fonts/CDN).
const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
});

/**
 * Is the Host header loopback? We bind 127.0.0.1 only, but a forwarded/rebound
 * request could still arrive with a non-loopback Host. Defence-in-depth: reject
 * anything whose host part is not a recognised loopback name (mirrors
 * http-transport.js::isLoopbackHost). A MISSING Host header is allowed — the bind
 * address is already the hard boundary.
 * @param {string|undefined} hostHeader
 * @returns {boolean}
 */
function isLoopbackHost(hostHeader) {
  if (hostHeader == null || hostHeader === '') return true;
  let host = String(hostHeader).trim();
  if (host[0] === '[') {
    const end = host.indexOf(']');
    host = end === -1 ? host.slice(1) : host.slice(1, end);
  } else {
    // Strip an optional :port ONLY when unambiguous — exactly one colon means "host:port". A string
    // with MULTIPLE colons is a bare IPv6 literal (e.g. "::1"); compare it whole rather than slicing
    // it to "" at the first colon (which would mis-classify IPv6 loopback as non-loopback).
    const first = host.indexOf(':');
    if (first !== -1 && first === host.lastIndexOf(':')) host = host.slice(0, first);
  }
  host = host.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1';
}

/**
 * Is the BIND address loopback? STRICTER than the Host-header check above: a missing Host header
 * is legitimately loopback (the bind address is the boundary), but a missing/empty BIND address is
 * not a loopback claim — it must name a loopback host explicitly to pass.
 * @param {string|undefined} bindHost
 * @returns {boolean}
 */
function isLoopbackBindHost(bindHost) {
  return typeof bindHost === 'string' && bindHost.trim() !== '' && isLoopbackHost(bindHost);
}

/** Regex-escape a literal so a matcher built from it FULL-matches the string verbatim. */
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The SURFACED name a discovered upstream tool is exposed under — an ENABLED expose `as` for
 * (upstream, tool) if one exists, else the namespaced default `<upstream>_<tool>`. Mirrors
 * Aggregator._surfacedName so the UI's per-tool curation keys match what the running gateway reads.
 * @param {object} store           the ExposeStore (for exposedName)
 * @param {Array}  enabledExposed  store.listExposed({ upstream, enabledOnly:true })
 * @param {string} upstreamId
 * @param {string} toolName
 * @returns {string}
 */
function surfacedNameFor(store, enabledExposed, upstreamId, toolName) {
  for (const e of enabledExposed || []) {
    if (e && e.tool === toolName) return store.exposedName(e);
  }
  return `${upstreamId}_${toolName}`;
}

/** Race a promise against a timeout so a wedged upstream never hangs a UI request. Rejects with
 *  `msg` on timeout; the timer is unref'd so it never keeps the process alive. */
function withTimeout(promise, ms, msg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg || 'timed out')), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/** Diagnostics → stderr (never the response). NEVER throws. */
function logErr(...parts) {
  try {
    process.stderr.write('[toolfunnel-ui] ' + parts.join(' ') + '\n');
  } catch (_e) {
    /* never let logging throw */
  }
}

// ── Config-change audit (UI → activity log) ─────────────────────────────────────────────────────
// A management console mutates the gateway's security posture (which tools are visible/hot, which
// MCPs are attached, which hooks gate, whether OAuth is on). Auditing those changes is arguably more
// important than logging individual tool runs. This maps each config-MUTATING POST path to an audit
// record (body -> fields). Read-only / test endpoints (e.g. /api/mcp/discover) are deliberately ABSENT
// so they never log as a "change". Logging self-gates (logger.log is a no-op unless logging is on),
// so this is silent until the operator enables the activity log.
const CONFIG_EVENTS = {
  '/api/tools/state': (b) => ({ event: 'tool_state', id: b.id, enabled: b.enabled, hidden: b.hidden, hot: b.hot }),
  '/api/tools/hook': (b) => ({ event: 'tool_hook', id: b.id, hook: b.event, on: !!b.on }),
  '/api/tools/add': (b) => ({ event: 'tool_add', id: b.entry && b.entry.id }),
  '/api/tools/remove': (b) => ({ event: 'tool_remove', id: b.id }),
  '/api/tools/mode': (b) => ({ event: 'tool_mode', id: b.id, mode: b.mode }),
  '/api/tools/update': (b) => ({ event: 'tool_update', id: b.id }),
  '/api/hooks/add': (b) => ({ event: 'hook_add', id: b.entry && b.entry.id }),
  '/api/hooks/state': (b) => ({ event: 'hook_state', id: b.id, action: b.action }),
  '/api/mcp/add': (b) => ({ event: 'mcp_add', id: b.upstream && b.upstream.id }),
  '/api/mcp/state': (b) => ({ event: 'mcp_state', id: b.id, action: b.action }),
  '/api/auth/config': (b) => ({ event: 'auth_config', enabled: b.enabled, issuer: b.issuer }),
  '/api/logs/config': (b) => ({ event: 'log_config', enabled: b.enabled }),
  '/api/oauth/install': () => ({ event: 'oauth_install' }),
};

/**
 * Write a config-change audit record (type:'config', via:'ui'). Drops undefined fields so a partial
 * change (e.g. only `hot` toggled) records only what actually changed. Self-gating via logger.log
 * (no-op unless logging is enabled). NEVER throws — an audit failure must not break a config write.
 * @param {object} fields  { event, ...changed }
 */
function logConfigChange(fields) {
  try {
    const rec = { type: 'config', via: 'ui' };
    const f = fields || {};
    for (const k of Object.keys(f)) {
      if (f[k] !== undefined) rec[k] = f[k];
    }
    logger.log(rec);
  } catch (_e) {
    /* never let audit logging break the caller */
  }
}

/**
 * createUiServer — construct (but do NOT start) the config web UI server.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.host]  bind address (default 127.0.0.1 — loopback only).
 * @param {number}  [opts.port]  bind port (default 9777; pass 0 for an OS-assigned port).
 * @param {string}  [opts.root]  config root holding tools/ mcp/ hooks/ (default: the resolved
 *                               config home — TOOLFUNNEL_HOME / --config-dir / the package root).
 * @returns {{ start: () => Promise<{url:string, port:number}>, stop: () => Promise<void>, get url():(string|null) }}
 */
function createUiServer(opts = {}) {
  const o = opts || {};
  const host = typeof o.host === 'string' && o.host.length > 0 ? o.host : DEFAULT_HOST;
  // A port of 0 is VALID (OS-assigned) so distinguish "not provided" from 0.
  const requestedPort = Number.isInteger(o.port) && o.port >= 0 ? o.port : DEFAULT_PORT;
  // The config root: tools.register.json etc. live under <root>/tools, <root>/mcp, <root>/hooks.
  // Default = the resolved config home (see src/core/config-home.js), so a --config-dir /
  // TOOLFUNNEL_HOME gateway and its UI edit the SAME stores.
  const { resolveConfigHome } = require('../core/config-home');
  const root = typeof o.root === 'string' && o.root.length > 0 ? o.root : resolveConfigHome();

  // ── Path anchors (everything resolved from the repo root) ────────────────────────────────────
  const REGISTER_PATH = path.join(root, 'tools', 'tools.register.json');
  const TOOL_STATE_PATH = path.join(root, 'tools', 'tools.state.json');
  const EXPOSE_PATH = path.join(root, 'mcp', 'expose.json');
  const MANIFEST_PATH = path.join(root, 'hooks', 'hooks.manifest.json');
  const SCRIPTS_ROOT = path.join(root, 'tools', 'scripts');
  // Where a Pre/Post hook script for a tool must be authored. The manifest command carries the
  // PORTABLE ${HOOKS_DIR} token (expanded by the hook-loader at load); this is its real on-disk dir.
  const HOOK_SCRIPTS_DIR = path.join(root, 'hooks', 'scripts');
  const PUBLIC_DIR = path.join(__dirname, 'public');

  // ── Mutable runtime state ─────────────────────────────────────────────────────────────────────
  /** @type {import('node:http').Server|null} */
  let httpServer = null;
  /** @type {number|null} the actual bound port (resolved after listen — matters for port 0). */
  let boundPort = null;
  let started = false;

  function currentUrl() {
    return boundPort == null ? null : `http://${host}:${boundPort}`;
  }

  // ── Store-backed config reads (FRESH per call so external edits show immediately) ──────────────

  /** Read the hook manifest defensively → { version, hooks:[] }. Never throws. */
  function readManifest() {
    try {
      const d = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        return {
          version: typeof d.version === 'number' ? d.version : 1,
          hooks: Array.isArray(d.hooks) ? d.hooks : [],
        };
      }
    } catch (_e) {
      /* missing/malformed → empty manifest */
    }
    return { version: 1, hooks: [] };
  }

  /** Does any ENABLED manifest hook for `event` fire for `gateName`? (matcher.matches semantics) */
  function hookFires(hooks, event, gateName) {
    for (const h of hooks) {
      if (!h || h.event !== event || h.enabled !== true) continue;
      if (matches(h.matcher, gateName)) return true;
    }
    return false;
  }

  /** The gate name the hook matcher is tested against: register `name`, falling back to `id`. */
  function gateNameFor(entry) {
    return (entry && entry.name) || (entry && entry.id) || '';
  }

  // GET /api/tools → [{ id,name,summary,category, mode, enabled, hidden, hot, pre, post }]
  function apiTools() {
    const registry = loadRegistry(REGISTER_PATH, { scriptsRoot: SCRIPTS_ROOT });
    const state = loadToolState(TOOL_STATE_PATH);
    const hooks = readManifest().hooks;
    return registry.list().map((b) => {
      const gateName = b.name || b.id;
      return {
        id: b.id,
        name: b.name,
        summary: b.summary || '',
        category: b.category || '',
        // The RESOLVED execution mode ("gateway" runs the invoke here; "reference"
        // hands the instructions back so the connected AI runs it). b.id is from the
        // register so registry.mode never throws here.
        mode: registry.mode(b.id),
        // The visibility MATRIX axes (all keyed by the tool id):
        //   enabled — LEAN-VISIBLE in toolfunnel_list_tools + runnable (default ON).
        //   hidden  — manager-list declutter only (default OFF).
        //   hot     — promoted to the TOP-LEVEL every-turn surface (default OFF; opt-in).
        enabled: isToolEnabled(state, b.id),
        hidden: isToolHidden(state, b.id),
        hot: isToolHot(state, b.id, false),
        pre: hookFires(hooks, 'PreToolUse', gateName),
        post: hookFires(hooks, 'PostToolUse', gateName),
      };
    });
  }

  // POST /api/tools/state {id, enabled?, hidden?, hot?} → persist whichever axes are present. Each
  // is an independent merge-write (preserves the others). Backward-compatible: {id, enabled} still
  // just flips enabled. `id` may be a local tool id, an upstream surfaced name, or a meta-tool name
  // (the `hot` axis is keyed by the surfaced name the matrix assembler reads).
  function apiSetState(body) {
    const id = body && body.id;
    if (typeof id !== 'string' || id.length === 0) {
      return { status: 400, json: { ok: false, error: 'id (non-empty string) is required' } };
    }
    let touched = false;
    // Wrap the atomic writes (they can throw on EACCES/EPERM/ENOSPC) so the handler honours the
    // POST contract "never throws" and returns a clean {ok:false} with a useful message, like the
    // other write handlers — rather than escaping to the generic outer 500.
    try {
      if (Object.prototype.hasOwnProperty.call(body, 'enabled')) { setToolEnabled(TOOL_STATE_PATH, id, !!body.enabled); touched = true; }
      if (Object.prototype.hasOwnProperty.call(body, 'hidden')) { setToolHidden(TOOL_STATE_PATH, id, !!body.hidden); touched = true; }
      if (Object.prototype.hasOwnProperty.call(body, 'hot')) { setToolHot(TOOL_STATE_PATH, id, !!body.hot); touched = true; }
    } catch (err) {
      return { status: 500, json: { ok: false, error: (err && err.message) || 'tool state write failed' } };
    }
    if (!touched) {
      return { status: 400, json: { ok: false, error: 'provide at least one of enabled, hidden, hot' } };
    }
    return { status: 200, json: { ok: true } };
  }

  // GET /api/surface → the TOP-LEVEL (every-turn) surface summary + footgun warnings.
  //   meta          — the 4 meta-tools with their hot state (default ON; hot:false hides one).
  //   promotedLocal — register tools promoted hot AND enabled.
  //   promotedOther — other hot+enabled state keys (upstream surfaced names) — a count proxy (the
  //                   UI server can't enumerate live upstream tools without a discover, so this may
  //                   over-count typo'd / disabled-upstream keys; it errs toward over-warning).
  //   curatedDirect — ENABLED expose[] entries: these are on the top-level surface every turn too
  //                   (handleToolsList step 3 promotes every enabled expose entry, with NO hot flag),
  //                   so the bloat warning MUST count them or it reports a false all-clear.
  //   warnings      — hiding the management tools / promoting many (context bloat).
  function apiSurface() {
    const state = loadToolState(TOOL_STATE_PATH);
    const metaNames = Object.values(META_TOOLS);
    const meta = metaNames.map((name) => ({ name, hot: isToolHot(state, name, true) }));

    let localIds = new Set();
    try { localIds = new Set(loadRegistry(REGISTER_PATH, { scriptsRoot: SCRIPTS_ROOT }).list().map((b) => b.id)); }
    catch (_e) { /* report 0 promotions on a malformed register */ }

    // Enabled expose[] entries are curated-direct: top-level every turn (no hot flag needed), so they
    // count toward the bloat threshold exactly like a hot tool — statically enumerable, no discover.
    // Collect their SURFACED names so a hot key that is ALSO an enabled-expose name isn't double-counted.
    let curatedDirect = 0;
    const exposedNames = new Set();
    try {
      const store = loadExposeStore(EXPOSE_PATH);
      const exposed = store.listExposed({ enabledOnly: true });
      curatedDirect = exposed.length;
      for (const e of exposed) exposedNames.add(store.exposedName(e));
    } catch (_e) { /* 0 on a malformed store */ }

    let promotedLocal = 0;
    let promotedOther = 0;
    for (const key of Object.keys(state)) {
      const e = state[key];
      if (!e || e.hot !== true) continue;          // only explicit promotions
      if (metaNames.includes(key)) continue;        // meta handled separately
      if (e.enabled === false) continue;            // disabled → not actually on the surface
      if (localIds.has(key)) promotedLocal += 1;
      else if (exposedNames.has(key)) continue;     // already counted as curated-direct (no double-count)
      else promotedOther += 1;
    }
    const promotedTotal = promotedLocal + promotedOther + curatedDirect;

    const warnings = [];
    const listHot = (meta.find((m) => m.name === META_TOOLS.LIST) || {}).hot;
    const runHot = (meta.find((m) => m.name === META_TOOLS.RUN) || {}).hot;
    const metaOff = meta.filter((m) => !m.hot).length;
    if (metaOff === metaNames.length) {
      warnings.push('All four management tools are hidden from the top-level surface. A connected AI can no longer discover or run tools via the meta-tools — only the tools you have promoted are reachable. This is the "ordinary tools as an MCP" pattern; otherwise re-enable at least toolfunnel_list_tools and toolfunnel_run_tool.');
    } else if (!listHot || !runHot) {
      warnings.push('toolfunnel_list_tools and/or toolfunnel_run_tool is hidden — the AI may be unable to discover or run tools by name. Promote the specific tools it needs, or re-enable these meta-tools.');
    }
    if (promotedTotal > 10) {
      warnings.push(promotedTotal + ' tools are promoted to every turn (including any enabled curated-direct expose entries). Each injects its schema into the model context on EVERY message — the opposite of the lean register. Promote only the few you call constantly; surface the rest leanly via toolfunnel_list_tools.');
    }

    return { meta, promotedLocal, promotedOther, curatedDirect, promotedTotal, warnings };
  }

  // POST /api/tools/hook {id, event, on} → read-modify-write hooks.manifest.json atomically.
  function apiSetHook(body) {
    const id = body && body.id;
    const event = body && body.event;
    const on = !!(body && body.on);
    if (typeof id !== 'string' || id.length === 0) {
      return { status: 400, json: { ok: false, error: 'id (non-empty string) is required' } };
    }
    if (!VALID_HOOK_EVENTS.has(event)) {
      return { status: 400, json: { ok: false, error: 'event must be "PreToolUse" or "PostToolUse"' } };
    }

    // Resolve the tool's GATE NAME (register name, falling back to id). Reuse the registry so an
    // unknown id is rejected cleanly rather than fabricating a manifest entry for nothing.
    const registry = loadRegistry(REGISTER_PATH, { scriptsRoot: SCRIPTS_ROOT });
    if (!registry.has(id)) {
      return { status: 404, json: { ok: false, error: `unknown tool id "${id}"` } };
    }
    const gateName = gateNameFor(registry.getEntry(id));

    const manifest = readManifest();
    const hooks = manifest.hooks;
    const eventLower = event.toLowerCase();
    const scriptName = `${id}-${eventLower}.js`;
    const scriptPath = path.join(HOOK_SCRIPTS_DIR, scriptName);

    if (on) {
      // Append a literal-full-match hook iff one is not already enabled for (event, gateName).
      if (!hookFires(hooks, event, gateName)) {
        hooks.push({
          event,
          matcher: escapeRegex(gateName),
          // The command carries the PORTABLE ${HOOKS_DIR} token (NOT interpolated here) — the
          // hook-loader expands it to the absolute hooks dir at load time.
          command: 'node "${HOOKS_DIR}/scripts/' + scriptName + '"',
          enabled: true,
        });
        manifest.hooks = hooks;
        atomicWriteJson(MANIFEST_PATH, manifest);
      }
      return {
        status: 200,
        json: {
          ok: true,
          scriptPath,
          note:
            `Create ${scriptName} at this path to define the ${event} behaviour. ` +
            'Until the script exists the gate is configured but has no script to run.',
        },
      };
    }

    // OFF: drop every entry for this event whose matcher fires for this tool's gate name.
    const next = hooks.filter((h) => !(h && h.event === event && matches(h.matcher, gateName)));
    if (next.length !== hooks.length) {
      manifest.hooks = next;
      atomicWriteJson(MANIFEST_PATH, manifest);
    }
    return { status: 200, json: { ok: true } };
  }

  // GET /api/upstreams → { upstreams:[...], expose:[...] } (READ-ONLY for v1).
  function apiUpstreams() {
    const store = loadExposeStore(EXPOSE_PATH);
    return { upstreams: store.listUpstreams(), expose: store.listExposed() };
  }

  // GET /api/status → { tools, upstreams, hooks }.
  function apiStatus() {
    let tools = 0;
    let upstreams = 0;
    let hooks = 0;
    try {
      tools = loadRegistry(REGISTER_PATH, { scriptsRoot: SCRIPTS_ROOT }).list().length;
    } catch (_e) { /* report 0 on a malformed register */ }
    try {
      upstreams = loadExposeStore(EXPOSE_PATH).listUpstreams().length;
    } catch (_e) { /* report 0 */ }
    hooks = readManifest().hooks.length;
    return { tools, upstreams, hooks };
  }

  // ── Activity log (logger.js — toggleable JSONL; never throws) ────────────────────────────────────
  // The logger is its own self-gating store (DEFAULT OFF). getConfig/tail are contracted never to
  // throw; setConfig is the writer and CAN throw, so its handler wraps it into a clean 500.

  // GET /api/logs → { entries:[...] } the last 100 parsed records (file order, oldest→newest).
  function apiLogs() {
    let entries = [];
    try {
      const t = logger.tail(100);
      entries = Array.isArray(t) ? t : [];
    } catch (_e) { /* tail is contracted not to throw; stay empty on any surprise */ }
    return { entries };
  }

  // GET /api/logs/config → { enabled, path } the resolved logger config (missing file → disabled).
  function apiLogsConfig() {
    try {
      return logger.getConfig();
    } catch (_e) {
      return { enabled: false, path: '' };
    }
  }

  // POST /api/logs/config { enabled?, path? } → logger.setConfig (atomic merge). Validates field
  // types so a bad shape is a clean 400 rather than reaching the writer; a write failure → 500.
  function apiSetLogsConfig(body) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(b, 'enabled')) {
      if (typeof b.enabled !== 'boolean') {
        return { status: 400, json: { ok: false, error: 'enabled must be a boolean' } };
      }
      patch.enabled = b.enabled;
    }
    if (Object.prototype.hasOwnProperty.call(b, 'path')) {
      if (typeof b.path !== 'string' || b.path.length === 0) {
        return { status: 400, json: { ok: false, error: 'path must be a non-empty string' } };
      }
      patch.path = b.path;
    }
    try {
      const config = logger.setConfig(patch);
      return { status: 200, json: { ok: true, config } };
    } catch (err) {
      return { status: 500, json: { ok: false, error: (err && err.message) || 'log config write failed' } };
    }
  }

  // ── OAuth 2.1 (OPTIONAL; default OFF) — auth config + on-demand jose install ────────────────────
  // No secrets here: issuer / audience / jwksUri are public identifiers (the JWKS itself is public),
  // so the full config is safe to surface. `joseInstalled` + `configError` + `ready` drive the panel.

  // GET /api/auth → { config, joseInstalled, josePin, configError, ready }.
  function apiAuth() {
    let config;
    try { config = authConfig.getConfig(); } catch (_e) { config = { enabled: false }; }
    let jose = false;
    try { jose = isJoseInstalled(); } catch (_e) { jose = false; }
    let cfgErr = null;
    try { cfgErr = authConfig.configError(config); } catch (_e) { cfgErr = null; }
    // "ready" = if enabled, jose is present AND the config is coherent (the host would start).
    const ready = !config.enabled || (jose && !cfgErr);
    return { config, joseInstalled: jose, josePin: JOSE_PIN, configError: cfgErr, ready };
  }

  // POST /api/auth/config { enabled?, issuer?, audience?, jwksUri?, algorithms?, requiredScopes?,
  //   clockToleranceSec? } → validate field types (clean 400 on a bad shape) then authConfig.setConfig
  //   (atomic merge). Permissive about partial configuration (you may set issuer now, audience later);
  //   the response reports joseInstalled + configError + ready so the UI can warn that an ENABLED but
  //   not-yet-ready config will be refused by the HTTP host at start.
  function apiSetAuthConfig(body) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const patch = {};
    const bad = (msg) => ({ status: 400, json: { ok: false, error: msg } });

    if (Object.prototype.hasOwnProperty.call(b, 'enabled')) {
      if (typeof b.enabled !== 'boolean') return bad('enabled must be a boolean');
      patch.enabled = b.enabled;
    }
    for (const f of ['issuer', 'audience', 'jwksUri']) {
      if (Object.prototype.hasOwnProperty.call(b, f)) {
        if (typeof b[f] !== 'string') return bad(f + ' must be a string');
        patch[f] = b[f];
      }
    }
    for (const f of ['algorithms', 'requiredScopes']) {
      if (Object.prototype.hasOwnProperty.call(b, f)) {
        if (!Array.isArray(b[f]) || b[f].some((x) => typeof x !== 'string')) return bad(f + ' must be an array of strings');
        patch[f] = b[f];
      }
    }
    if (Object.prototype.hasOwnProperty.call(b, 'clockToleranceSec')) {
      if (typeof b.clockToleranceSec !== 'number' || !Number.isFinite(b.clockToleranceSec) || b.clockToleranceSec < 0) {
        return bad('clockToleranceSec must be a non-negative number');
      }
      patch.clockToleranceSec = b.clockToleranceSec;
    }

    // Guard the classic footgun: enabling auth with no jose installed would make the HTTP host refuse
    // to start. Block it with an actionable message rather than writing a config that breaks the host.
    if (patch.enabled === true && !isJoseInstalled()) {
      return bad('install the OAuth dependency first (click Install, or run `toolfunnel install-oauth`) before enabling auth');
    }

    let config;
    try {
      config = authConfig.setConfig(patch);
    } catch (err) {
      return { status: 500, json: { ok: false, error: (err && err.message) || 'auth config write failed' } };
    }
    const cfgErr = authConfig.configError(config);
    const ready = !config.enabled || (isJoseInstalled() && !cfgErr);
    return { status: 200, json: { ok: true, config, joseInstalled: isJoseInstalled(), configError: cfgErr, ready } };
  }

  // POST /api/oauth/install → install the single optional dependency (jose@PIN) on demand. Async +
  // potentially slow (it shells out to npm); installJose() owns a hard timeout and never throws.
  async function apiOauthInstall() {
    let res;
    try {
      res = await installJose();
    } catch (err) {
      return { status: 500, json: { ok: false, error: (err && err.message) || 'install failed' } };
    }
    // Trim npm's chatty output so the panel shows a useful tail without flooding the response.
    const tail = (s) => (typeof s === 'string' ? s.slice(-2000) : '');
    return {
      status: res.ok ? 200 : 500,
      json: { ok: res.ok, message: res.message, code: res.code, stdout: tail(res.stdout), stderr: tail(res.stderr), joseInstalled: isJoseInstalled() },
    };
  }

  // ── Tool register writes (registry.js — atomic via the store) ──────────────────────────────────

  // POST /api/tools/add {entry} → registry.add. When entry.scriptText is supplied for a SCRIPT
  // invoke the body is authored under tools/scripts/<basename> FIRST (registry.writeScript, which
  // is path-guarded), then the entry is registered. registry.add validates id/name/invoke/mode and
  // rejects a duplicate id. Never throws — a bad shape becomes a clean 400.
  function apiToolAdd(body) {
    const entry = body && body.entry;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { status: 400, json: { ok: false, error: 'entry (object) is required' } };
    }
    const registry = loadRegistry(REGISTER_PATH, { scriptsRoot: SCRIPTS_ROOT });
    try {
      const scriptText = entry.scriptText;
      const clean = { ...entry };
      delete clean.scriptText; // scriptText is a UI affordance, not a register field
      // Author the script body before registering, so a script invoke points at a real file.
      if (typeof scriptText === 'string' && clean.invoke && clean.invoke.type === 'script') {
        registry.writeScript(clean.invoke.path, scriptText);
      }
      const added = registry.add(clean);
      return { status: 200, json: { ok: true, entry: added } };
    } catch (err) {
      return { status: 400, json: { ok: false, error: (err && err.message) || 'tool add failed' } };
    }
  }

  // POST /api/tools/remove {id} → registry.remove + clearToolState (drop the enabled/hidden overlay
  // key so a re-added id starts clean). Unknown id → 404.
  function apiToolRemove(body) {
    const id = body && body.id;
    if (typeof id !== 'string' || id.length === 0) {
      return { status: 400, json: { ok: false, error: 'id (non-empty string) is required' } };
    }
    const registry = loadRegistry(REGISTER_PATH, { scriptsRoot: SCRIPTS_ROOT });
    try {
      registry.remove(id);
    } catch (err) {
      return { status: 404, json: { ok: false, error: (err && err.message) || 'tool remove failed' } };
    }
    // Best-effort overlay cleanup — a failure here must not undo the register removal.
    try { clearToolState(TOOL_STATE_PATH, id); } catch (_e) { /* overlay cleanup is best-effort */ }
    return { status: 200, json: { ok: true } };
  }

  // POST /api/tools/mode {id, mode} → registry.update(id,{mode}). Switching a reference tool that has
  // no invoke to "gateway" fails validation (nothing to run) and surfaces as a clean 400.
  function apiToolMode(body) {
    const id = body && body.id;
    const mode = body && body.mode;
    if (typeof id !== 'string' || id.length === 0) {
      return { status: 400, json: { ok: false, error: 'id (non-empty string) is required' } };
    }
    if (mode !== 'reference' && mode !== 'gateway') {
      return { status: 400, json: { ok: false, error: 'mode must be "reference" or "gateway"' } };
    }
    const registry = loadRegistry(REGISTER_PATH, { scriptsRoot: SCRIPTS_ROOT });
    try {
      const updated = registry.update(id, { mode });
      return { status: 200, json: { ok: true, mode: resolveMode(updated) } };
    } catch (err) {
      return { status: 400, json: { ok: false, error: (err && err.message) || 'tool mode update failed' } };
    }
  }

  // GET /api/tools/detail?id=<id> → the FULL entry (name, summary, category, instructions, invoke,
  // mode) plus the script BODY for a script invoke, so the UI can show + edit everything about one
  // tool. Read fresh; unknown id → 404.
  function apiToolDetail(id) {
    if (typeof id !== 'string' || id.length === 0) {
      return { status: 400, json: { ok: false, error: 'id (non-empty string) is required' } };
    }
    const registry = loadRegistry(REGISTER_PATH, { scriptsRoot: SCRIPTS_ROOT });
    let entry;
    try {
      entry = registry.getEntry(id);
    } catch (err) {
      return { status: 404, json: { ok: false, error: (err && err.message) || `unknown tool id "${id}"` } };
    }
    // For a script invoke, read the body so the user can view/edit it. Resolve strictly inside the
    // scripts root (defence-in-depth via basename); a missing/unreadable file leaves scriptText null.
    let scriptText = null;
    try {
      if (entry.invoke && entry.invoke.type === 'script' && entry.invoke.path) {
        const sp = path.join(SCRIPTS_ROOT, path.basename(entry.invoke.path));
        if (fs.existsSync(sp)) scriptText = fs.readFileSync(sp, 'utf8');
      }
    } catch (_e) { /* leave scriptText null on any read failure */ }
    return { status: 200, json: { ok: true, entry, scriptText } };
  }

  // POST /api/tools/update {id, patch:{name?,summary?,category?,instructions?,mode?,invoke?}, scriptText?}
  // → registry.update (shallow-merge + re-validate + atomic persist). When scriptText is supplied for
  // a script invoke, the body is authored under tools/scripts/ (path-guarded) first. A bad shape /
  // unknown id surfaces as a clean 400/404 (registry.update throws → caught).
  function apiToolUpdate(body) {
    const id = body && body.id;
    if (typeof id !== 'string' || id.length === 0) {
      return { status: 400, json: { ok: false, error: 'id (non-empty string) is required' } };
    }
    const patch = body && body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch) ? body.patch : {};
    const registry = loadRegistry(REGISTER_PATH, { scriptsRoot: SCRIPTS_ROOT });
    if (!registry.has(id)) {
      return { status: 404, json: { ok: false, error: `unknown tool id "${id}"` } };
    }
    try {
      // Author the script body first (if provided) so the file matches the (possibly updated) invoke.
      if (typeof body.scriptText === 'string') {
        const inv = (patch.invoke && patch.invoke.type) ? patch.invoke : registry.getEntry(id).invoke;
        if (inv && inv.type === 'script' && inv.path) registry.writeScript(inv.path, body.scriptText);
      }
      const updated = registry.update(id, patch);
      return { status: 200, json: { ok: true, entry: updated } };
    } catch (err) {
      return { status: 400, json: { ok: false, error: (err && err.message) || 'tool update failed' } };
    }
  }

  // ── Hook manifest writes (hook-loader.js — atomic; overlay-aware) ───────────────────────────────

  /** The relative scripts/<file> a hook command references, if any (so a scriptText lands where the
   *  command will run it). Returns null when the command names no scripts/ file. */
  function deriveHookScriptRel(command) {
    if (typeof command !== 'string') return null;
    const m = command.match(/scripts[\\/]([A-Za-z0-9._-]+)/);
    return m ? 'scripts/' + m[1] : null;
  }

  // GET /api/hooks → { hooks:[{ id,event,matcher,enabled,description }] }. loadManifest applies the
  // hooks.state.json overlay over the manifest seed, so `enabled` is the LIVE state. Tool Pre/Post
  // gates authored via /api/tools/hook have no id and are surfaced with id:"" (managed on the Tools tab).
  function apiHooks() {
    let loader;
    try {
      loader = loadManifest(MANIFEST_PATH);
    } catch (_e) {
      return { hooks: [] };
    }
    return {
      hooks: loader.hooks.map((h) => ({
        id: typeof h.id === 'string' ? h.id : '',
        event: h.event || '',
        matcher: h.matcher == null ? '' : String(h.matcher),
        enabled: h.enabled === true,
        description: h.description || '',
      })),
    };
  }

  // POST /api/hooks/add {entry} → hookLoader.addEntry (validates id/event/command + rejects dup id).
  // When entry.scriptText is supplied the body is authored under hooks/scripts/ AFTER the entry exists
  // (writeScript resolves the path from the entry's `script`, derived from the command if not given).
  function apiHookAdd(body) {
    const entry = body && body.entry;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { status: 400, json: { ok: false, error: 'entry (object) is required' } };
    }
    let loader;
    try {
      loader = loadManifest(MANIFEST_PATH);
    } catch (err) {
      return { status: 500, json: { ok: false, error: 'cannot read hook manifest: ' + ((err && err.message) || err) } };
    }
    try {
      const scriptText = entry.scriptText;
      const spec = { ...entry };
      delete spec.scriptText;
      // If a script body is supplied but no explicit `script`, derive it from the command so the
      // file written is the one the command runs.
      if (typeof scriptText === 'string' && scriptText.length > 0 && (typeof spec.script !== 'string' || !spec.script)) {
        const rel = deriveHookScriptRel(spec.command);
        if (rel) spec.script = rel;
      }
      loader.addEntry(spec); // validates id/event/command; throws on duplicate id
      if (typeof scriptText === 'string' && scriptText.length > 0) {
        loader.writeScript(spec.id, scriptText); // path-guarded to hooks/scripts
      }
      return { status: 200, json: { ok: true, id: spec.id } };
    } catch (err) {
      return { status: 400, json: { ok: false, error: (err && err.message) || 'hook add failed' } };
    }
  }

  // POST /api/hooks/state {id, action} → enable/disable (setEnabled, overlay-backed) or remove
  // (removeEntry). Unknown id → 404. setEnabled does not itself verify existence, so we check first
  // to avoid writing a stray overlay key for a non-existent hook.
  function apiHookState(body) {
    const id = body && body.id;
    const action = body && body.action;
    if (typeof id !== 'string' || id.length === 0) {
      return { status: 400, json: { ok: false, error: 'id (non-empty string) is required' } };
    }
    if (action !== 'enable' && action !== 'disable' && action !== 'remove') {
      return { status: 400, json: { ok: false, error: 'action must be "enable", "disable", or "remove"' } };
    }
    let loader;
    try {
      loader = loadManifest(MANIFEST_PATH);
    } catch (err) {
      return { status: 500, json: { ok: false, error: 'cannot read hook manifest: ' + ((err && err.message) || err) } };
    }
    try {
      if (action === 'remove') {
        const removed = loader.removeEntry(id);
        if (!removed) {
          return { status: 404, json: { ok: false, error: `unknown hook id "${id}"` } };
        }
      } else {
        if (!loader.getSpec(id)) {
          return { status: 404, json: { ok: false, error: `unknown hook id "${id}"` } };
        }
        loader.setEnabled(id, action === 'enable');
      }
      return { status: 200, json: { ok: true } };
    } catch (err) {
      return { status: 400, json: { ok: false, error: (err && err.message) || 'hook state update failed' } };
    }
  }

  // ── MCP upstream / expose writes (expose-store.js — atomic) ─────────────────────────────────────

  // POST /api/mcp/add {upstream, expose?:[...]} → addUpstream then addExpose per item. addUpstream
  // validates a unique non-empty id, transport, and a stdio command. Each expose item is keyed to the
  // new upstream id.
  function apiMcpAdd(body) {
    const upstream = body && body.upstream;
    if (!upstream || typeof upstream !== 'object' || Array.isArray(upstream)) {
      return { status: 400, json: { ok: false, error: 'upstream (object) is required' } };
    }
    const store = loadExposeStore(EXPOSE_PATH);
    try {
      const added = store.addUpstream(upstream);
      const items = Array.isArray(body && body.expose) ? body.expose : [];
      const exposed = [];
      for (const item of items) {
        exposed.push(store.addExpose({ ...item, upstream: added.id }));
      }
      return { status: 200, json: { ok: true, upstream: added, expose: exposed } };
    } catch (err) {
      return { status: 400, json: { ok: false, error: (err && err.message) || 'mcp add failed' } };
    }
  }

  // POST /api/mcp/state {id, action} → enable/disable (setUpstreamEnabled) or remove (removeUpstream,
  // which cascades the upstream's expose entries). Unknown id → 404.
  function apiMcpState(body) {
    const id = body && body.id;
    const action = body && body.action;
    if (typeof id !== 'string' || id.length === 0) {
      return { status: 400, json: { ok: false, error: 'id (non-empty string) is required' } };
    }
    if (action !== 'enable' && action !== 'disable' && action !== 'remove') {
      return { status: 400, json: { ok: false, error: 'action must be "enable", "disable", or "remove"' } };
    }
    const store = loadExposeStore(EXPOSE_PATH);
    try {
      if (action === 'remove') {
        store.removeUpstream(id);
      } else {
        store.setUpstreamEnabled(id, action === 'enable');
      }
      return { status: 200, json: { ok: true } };
    } catch (err) {
      return { status: 404, json: { ok: false, error: (err && err.message) || 'mcp state update failed' } };
    }
  }

  // POST /api/mcp/discover {id} → LIVE connect + tools/list of one upstream (the "Test / Discover"
  // button). Constructs a throwaway Aggregator over the SAME store (so the isolation guard applies),
  // connects + lists, then closes it. Returns each discovered tool with its SURFACED name (an enabled
  // expose `as` else `<id>_<tool>` — exactly the name the lean list / matrix use) and its current
  // lean (enabled) + hot state, so the UI can curate per upstream tool. A connect/list failure (bad
  // command, crash, isolation) is a real user-facing outcome → 200 { ok:false, error }, not a 500.
  async function apiMcpDiscover(body) {
    const id = body && body.id;
    if (typeof id !== 'string' || id.length === 0) {
      return { status: 400, json: { ok: false, error: 'id (non-empty string) is required' } };
    }
    const store = loadExposeStore(EXPOSE_PATH);
    if (!store.getUpstream(id)) {
      return { status: 404, json: { ok: false, error: `unknown upstream "${id}"` } };
    }
    const agg = new Aggregator({ store, v3Root: root });
    let tools;
    try {
      // discover() connects the upstream lazily (isolation-guarded), lists its tools, caches+returns.
      // Race a timeout so a wedged upstream never hangs the UI request (closeAll reaps the child).
      tools = await withTimeout(agg.discover(id), 20000, `discover "${id}" timed out`);
    } catch (err) {
      try { await agg.closeAll(); } catch (_e) { /* best-effort teardown */ }
      return { status: 200, json: { ok: false, id, error: (err && err.message) || 'discover failed' } };
    }
    try { await agg.closeAll(); } catch (_e) { /* best-effort teardown */ }

    const state = loadToolState(TOOL_STATE_PATH);
    const enabledExposed = store.listExposed({ upstream: id, enabledOnly: true });
    const items = (Array.isArray(tools) ? tools : []).map((t) => {
      const surfaced = surfacedNameFor(store, enabledExposed, id, t && t.name);
      return {
        tool: (t && t.name) || '',
        name: surfaced,
        description: (t && typeof t.description === 'string') ? t.description : '',
        enabled: isToolEnabled(state, surfaced),
        hot: isToolHot(state, surfaced, false),
      };
    });
    return { status: 200, json: { ok: true, id, tools: items } };
  }

  // The POST routing table — path → handler. Each handler takes the parsed body and returns
  // { status, json } (or a Promise of it — the dispatcher awaits); none throws (every store call is
  // wrapped). Built once per server instance.
  const POST_HANDLERS = {
    '/api/tools/state': apiSetState,
    '/api/tools/hook': apiSetHook,
    '/api/tools/add': apiToolAdd,
    '/api/tools/remove': apiToolRemove,
    '/api/tools/mode': apiToolMode,
    '/api/tools/update': apiToolUpdate,
    '/api/hooks/add': apiHookAdd,
    '/api/hooks/state': apiHookState,
    '/api/mcp/add': apiMcpAdd,
    '/api/mcp/state': apiMcpState,
    '/api/mcp/discover': apiMcpDiscover,
    '/api/logs/config': apiSetLogsConfig,
    '/api/auth/config': apiSetAuthConfig,
    '/api/oauth/install': apiOauthInstall,
  };

  // ── HTTP plumbing ───────────────────────────────────────────────────────────────────────────

  /** Read a request body up to MAX_BODY_BYTES, then JSON.parse. Resolves {} for an empty body. */
  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      let done = false;
      const finish = (fn, val) => { if (!done) { done = true; fn(val); } };
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          finish(reject, new Error('request body too large'));
          try { req.destroy(); } catch (_e) { /* ignore */ }
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (raw.length === 0) return finish(resolve, {});
        try {
          finish(resolve, JSON.parse(raw));
        } catch (_e) {
          finish(reject, new Error('invalid JSON body'));
        }
      });
      req.on('error', (err) => finish(reject, err));
    });
  }

  /** Write a JSON response. Defensive: a serialise failure degrades to a 500 text body. */
  function sendJson(res, status, obj) {
    let bodyStr;
    try {
      bodyStr = JSON.stringify(obj);
    } catch (_e) {
      bodyStr = '{"ok":false,"error":"failed to serialise response"}';
      status = 500;
    }
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(bodyStr, 'utf8'),
      'Cache-Control': 'no-store',
    });
    res.end(bodyStr);
  }

  /** Serve a static file from PUBLIC_DIR (read FRESH). 404 JSON when absent / outside the dir. */
  function sendStatic(res, relName) {
    // Resolve strictly inside PUBLIC_DIR (defence-in-depth against traversal).
    const resolved = path.resolve(PUBLIC_DIR, relName);
    const baseWithSep = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
    if (resolved !== PUBLIC_DIR && !resolved.startsWith(baseWithSep)) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }
    let data;
    try {
      data = fs.readFileSync(resolved);
    } catch (_e) {
      return sendJson(res, 404, { ok: false, error: 'not found: ' + relName });
    }
    const type = CONTENT_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  }

  /** The single request listener. Dispatches by method + path. NEVER throws. */
  async function onRequest(req, res) {
    try {
      // DNS-rebinding / non-loopback guard (defence-in-depth on top of the bind address).
      if (!isLoopbackHost(req.headers && req.headers.host)) {
        return sendJson(res, 403, { ok: false, error: 'forbidden: non-loopback Host' });
      }

      const rawUrl = req.url || '/';
      const qIndex = rawUrl.indexOf('?');
      const pathName = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
      const method = (req.method || 'GET').toUpperCase();

      // ── Static assets ─────────────────────────────────────────────────────────────────────────
      if (method === 'GET' && (pathName === '/' || pathName === '/index.html')) {
        return sendStatic(res, 'index.html');
      }
      if (method === 'GET' && pathName === '/app.js') {
        return sendStatic(res, 'app.js');
      }
      if (method === 'GET' && pathName === '/styles.css') {
        return sendStatic(res, 'styles.css');
      }
      // Image assets (logo, favicon, …): serve any safe-named image file from public/. The filename
      // regex + sendStatic's traversal guard keep this strictly inside the public dir.
      if (method === 'GET' && /^\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|svg|ico|webp)$/.test(pathName)) {
        return sendStatic(res, pathName.slice(1));
      }

      // ── JSON API (read fresh each call) ─────────────────────────────────────────────────────────
      if (method === 'GET' && pathName === '/api/tools') {
        return sendJson(res, 200, apiTools());
      }
      if (method === 'GET' && pathName === '/api/tools/detail') {
        let id = '';
        try {
          const qi = rawUrl.indexOf('?');
          id = qi === -1 ? '' : (new URLSearchParams(rawUrl.slice(qi + 1)).get('id') || '');
        } catch (_e) { id = ''; }
        const d = apiToolDetail(id);
        return sendJson(res, d.status, d.json);
      }
      if (method === 'GET' && pathName === '/api/upstreams') {
        return sendJson(res, 200, apiUpstreams());
      }
      if (method === 'GET' && pathName === '/api/hooks') {
        return sendJson(res, 200, apiHooks());
      }
      if (method === 'GET' && pathName === '/api/status') {
        return sendJson(res, 200, apiStatus());
      }
      if (method === 'GET' && pathName === '/api/surface') {
        return sendJson(res, 200, apiSurface());
      }
      if (method === 'GET' && pathName === '/api/logs') {
        return sendJson(res, 200, apiLogs());
      }
      if (method === 'GET' && pathName === '/api/logs/config') {
        return sendJson(res, 200, apiLogsConfig());
      }
      if (method === 'GET' && pathName === '/api/auth') {
        return sendJson(res, 200, apiAuth());
      }

      if (method === 'POST' && Object.prototype.hasOwnProperty.call(POST_HANDLERS, pathName)) {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: (err && err.message) || 'bad request body' });
        }
        // Handlers may be sync OR async (apiMcpDiscover connects an upstream) — await covers both.
        const result = await POST_HANDLERS[pathName](body);
        // Audit a config-MUTATING write that SUCCEEDED (self-gating — no-op unless logging is on).
        if (result && result.status >= 200 && result.status < 300 && result.json && result.json.ok === true && CONFIG_EVENTS[pathName]) {
          logConfigChange(CONFIG_EVENTS[pathName](body || {}));
        }
        return sendJson(res, result.status, result.json);
      }

      return sendJson(res, 404, { ok: false, error: 'not found: ' + method + ' ' + pathName });
    } catch (err) {
      // Last-resort guard: any unexpected failure becomes a clean 500 JSON, never a crash.
      logErr('onRequest error:', (err && err.stack) || String(err));
      try {
        sendJson(res, 500, { ok: false, error: (err && err.message) || 'internal error' });
      } catch (_e) {
        /* response may already be committed */
      }
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────────────────────

  /**
   * start — bind the HTTP server. On EADDRINUSE the returned promise REJECTS with a clear error
   * (the caller decides) — it does NOT crash the process. Resolves to { url, port } once listening.
   * Port 0 → an OS-assigned ephemeral port (read back from server.address()).
   * @returns {Promise<{url:string, port:number}>}
   */
  function start() {
    if (started) return Promise.resolve({ url: currentUrl(), port: boundPort });
    // The HTTP transport refuses a non-loopback bind unless OAuth is enabled; the UI has NO auth
    // path, so its refusal is unconditional. This endpoint spawns processes and writes scripts —
    // "--ui --host 0.0.0.0" would hand an unauthenticated remote console to the LAN.
    if (!isLoopbackBindHost(host)) {
      return Promise.reject(new Error(
        `refusing to bind the config UI to non-loopback host "${host}" — the UI is unauthenticated ` +
          'and can spawn processes / write tool scripts. It is loopback-only by design; to configure ' +
          'the gateway from another machine, use an SSH tunnel to 127.0.0.1 instead.'
      ));
    }
    httpServer = http.createServer(onRequest);
    return new Promise((resolve, reject) => {
      const onListenError = (err) => {
        httpServer.removeListener('listening', onListening);
        httpServer = null;
        reject(err);
      };
      const onListening = () => {
        httpServer.removeListener('error', onListenError);
        const addr = httpServer.address();
        boundPort = addr && typeof addr === 'object' ? addr.port : requestedPort;
        started = true;
        // Swap the one-shot bind-error handler for a steady-state one so a later socket error
        // (a client RST, etc.) is logged, not thrown.
        httpServer.on('error', (e) => logErr('http server error:', (e && e.message) || String(e)));
        resolve({ url: currentUrl(), port: boundPort });
      };
      httpServer.once('error', onListenError);
      httpServer.once('listening', onListening);
      httpServer.listen(requestedPort, host);
    });
  }

  /** stop — close the HTTP server. Idempotent and NEVER throws. */
  function stop() {
    return new Promise((resolve) => {
      if (!httpServer) {
        started = false;
        boundPort = null;
        return resolve();
      }
      const srv = httpServer;
      httpServer = null;
      let settled = false;
      const done = () => { if (!settled) { settled = true; started = false; boundPort = null; resolve(); } };
      try {
        srv.close(done);
      } catch (_e) {
        done();
      }
      try {
        if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
      } catch (_e) {
        /* closeAllConnections is Node ≥18.2; absent → close() still resolves */
      }
    });
  }

  return {
    start,
    stop,
    get url() {
      return currentUrl();
    },
  };
}

module.exports = {
  createUiServer,
  // Exported for unit tests / reuse — the small pure seams.
  isLoopbackHost,
  isLoopbackBindHost,
  escapeRegex,
};
