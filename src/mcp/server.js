#!/usr/bin/env node
'use strict';

/**
 * server.js - the HAND-ROLLED minimal MCP server over stdio (see the architecture notes §7).
 *
 * Runnable as:  node src/mcp/server.js
 *
 * This is the THIN transport. It speaks JSON-RPC 2.0 over stdin/stdout and delegates ALL logic
 * to the pure protocol layer (src/mcp/protocol.js). It is NOT an SDK wrapper - there is no
 * @modelcontextprotocol/sdk and no new npm dependency; everything here is Node built-ins.
 *
 * JSON-RPC methods handled (MCP, the subset our test client speaks):
 *   - "initialize"  -> { protocolVersion, serverInfo, capabilities: { tools: {} } }
 *   - "tools/list"  -> { tools: [ ...protocol.toolDefinitions() ] }   (the 4 meta-tools;
 *                       a clear seam is left for curated-direct tools - Phase 2)
 *   - "tools/call"  { name, arguments } -> protocol.dispatch(name, arguments), wrapped in the
 *                       MCP tools/call result shape: { content:[{ type:"text", text: JSON }],
 *                       isError? }. On a protocol error result we set isError:true.
 *   - notifications (no `id`) are acknowledged silently and never answered.
 *   - any bad / unknown message NEVER crashes the process - it gets a JSON-RPC error object.
 *
 * Framing: we READ both LSP-style `Content-Length:` framing AND newline-delimited JSON (the test
 * client writes Content-Length with a trailing newline; a simple client may send line-delimited),
 * and we WRITE newline-delimited JSON (the test reader accepts either framing on the wire). One
 * framing on the way out keeps the transport trivial and matches "newline-delimited JSON is fine
 * for our test client".
 *
 * Wiring (see the architecture notes §8 - Phase 1): a real Registry (loaded from
 * src/tools/tools.register.json - the canonical tool register), a real HookEngine over the hooks
 * manifest, the real gatedRun, and the real howto. A small ADAPTER bridges the register's
 * resolveExecution({type,run}) shape to the { execute, toolName, args } shape protocol.runTool
 * injects into gatedRun - keeping the pure modules untouched while making `toolfunnel_run_tool`
 * actually gate + execute end to end.
 *
 * CommonJS only. Node built-ins only. No transport SDK.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { makeProtocol } = require('./protocol');
const { gatedRun } = require('./gated-run');
const { Aggregator } = require('./aggregator');
const { loadExposeStore } = require('./expose-store');
const { loadRegistry } = require('../tools/registry');
const { loadToolState, loadToolStateResult, isToolEnabled, isToolHot, getPassthrough } = require('../tools/tool-state');
const { loadManifest } = require('../core/hook-loader');
const { HookEngine } = require('../core/hook-engine');
const { howto } = require('../extend/howto');
const logger = require('../core/logger');
const metrics = require('../core/metrics');

// ── Path anchors (everything stays under the host root) ───────────────────────────────────────
// The CODE lives in the package; the mutable CONFIG lives in the resolved config home - the same
// directory in a git clone, distinct when TOOLFUNNEL_HOME / --config-dir points elsewhere (npm
// installs, npm-wrapped MCPs - an `npm update` must never eat the user's tools). Every anchor
// below derives from the HOME.
const { PKG_ROOT, resolveConfigHome, ensureConfigHome } = require('../core/config-home');
const ROOT = resolveConfigHome(); // <...>/<config home>
// The process-tree contract for child tools (defaultRunScript spawns with process.env): a
// management script SEEDED into an external home finds the engine code via TOOLFUNNEL_PKG, and
// the resolved ABSOLUTE home is written back so no child re-resolves a relative value against a
// different cwd.
process.env.TOOLFUNNEL_PKG = PKG_ROOT;
if (ROOT !== PKG_ROOT) process.env.TOOLFUNNEL_HOME = ROOT;
const REGISTER_PATH = path.join(ROOT, 'tools', 'tools.register.json');
// The ACTIVE/DISABLED overlay (tool-state.js). toolfunnel_list_tools filters DISABLED tools out so
// they are not surfaced to the client. Read FRESH per list() call so UI toggles take effect with no
// restart. HIDDEN is a manager-list-only axis - it is NEVER consulted here (it must not affect the
// client's view).
const TOOL_STATE_PATH = path.join(ROOT, 'tools', 'tools.state.json');
const MANIFEST_PATH = path.join(ROOT, 'hooks', 'hooks.manifest.json');
const SCRIPTS_ROOT = path.join(ROOT, 'tools', 'scripts');
// Phase 2: the persisted curated-expose + upstream-MCP config. Default is EMPTY, so the
// aggregator connects to nothing and the curated-direct surface is empty - the server is
// behaviourally identical to Phase 1 until an upstream + expose entry is added.
const EXPOSE_PATH = path.join(ROOT, 'mcp', 'expose.json');

const PROTOCOL_VERSION = '2024-11-05';
// The 2026-07-28 ("modern") era, as a pure module - era detection, validation, result decoration,
// server/discover and subscriptions/listen shapes. This server is DUAL-ERA: a request carrying
// modern per-request _meta is served under 2026-07-28 semantics; initialize selects THIS legacy
// path, byte-for-byte the 0.5.0 behaviour. modern.js needs the legacy version string only for
// server/discover's supportedVersions - seeded once here so it is never duplicated.
const modern = require('./modern');
modern.setLegacyVersion(PROTOCOL_VERSION);
// Identity comes from the OPTIONAL toolfunnel.json at the root (absent -> name "toolfunnel",
// version from package.json - serverInfo can never drift from the released version). The config
// seam is what lets a wrapped MCP introduce itself as ITSELF in the initialize handshake and
// /health. Loaded once at module init: clients cache serverInfo from initialize, so identity is
// deliberately NOT hot-reloaded (a mid-session identity swap would lie to connected clients).
const { loadServerConfig } = require('../core/server-config');
const SERVER_CONFIG = loadServerConfig(ROOT);
const SERVER_INFO = { name: SERVER_CONFIG.serverName, version: SERVER_CONFIG.serverVersion };

// ── Diagnostics -> stderr only (stdout is the JSON-RPC channel; never pollute it). ─────────────
function logErr(...parts) {
  try {
    process.stderr.write('[toolfunnel] ' + parts.join(' ') + '\n');
  } catch (_e) {
    /* never let logging throw */
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Registry adapter - bridge the real Registry to what protocol.runTool consumes.
//
// protocol.runTool expects:  registry.resolveExecution(name, args) -> { execute, toolName, args }
// The real Registry returns:  resolveExecution(id, args)           -> { type, run }
//   - it looks up by `id` only (throws on unknown id),
//   - returns `run` (not `execute`),
//   - for a SHELL invoke it returns a DEFERRED descriptor instead of running (the gated runner
//     is meant to own shell execution - registry.js keeps un-gated shell out of itself by design).
//
// The adapter therefore:
//   - resolves the meta-tool `name` to a register id (accepting id OR display name),
//   - wraps `run` into an `execute` thunk that returns a clean tool output,
//   - for the shell-deferred case, performs the actual shell spawn INSIDE the execute thunk - so
//     it only ever runs after gatedRun's PreToolUse gate has allowed it.
// list()/instructions() pass straight through (with the same name->id resolution for instructions).
// ─────────────────────────────────────────────────────────────────────────────────────────────
function makeRegistryAdapter(registry, opts) {
  // opts.toolStatePath: when set, list() filters DISABLED tools out (the enabled-filter for
  // toolfunnel_list_tools). When absent (the Tool Manager's runOnce adapter, tests) list() is unfiltered.
  const toolStatePath = (opts && opts.toolStatePath) || null;
  // opts.getAggregator: an OPTIONAL live getter () => Aggregator|null. NEVER a captured instance -
  // reloadExpose swaps build.aggregator, so the adapter must read it fresh each call. When absent the
  // adapter is local-only, byte-for-byte its pre-slice-2 behaviour (preserves the runOnce adapter + tests).
  const getAggregator = (opts && typeof opts.getAggregator === 'function') ? opts.getAggregator : null;

  /** The live aggregator, or null. Defensive: a throwing/absent getter yields null (local-only). */
  function liveAggregator() {
    if (!getAggregator) return null;
    try { const a = getAggregator(); return a && typeof a === 'object' ? a : null; } catch (_e) { return null; }
  }

  /** Resolve a meta-tool name (which may be a display name) to a register id. */
  function resolveId(nameOrId) {
    if (typeof nameOrId !== 'string' || nameOrId.length === 0) return null;
    if (registry.has(nameOrId)) return nameOrId; // it's already an id
    // Fall back to matching the display name.
    const hit = registry.list().find((b) => b.name === nameOrId);
    return hit ? hit.id : null;
  }

  /**
   * Run a shell command, normalising to { ok, code, stdout, stderr }. ASYNC spawn - the old
   * spawnSync blocked the event loop for the tool's whole duration, stalling every concurrent
   * HTTP client (and pings) behind one long shell tool (0.5.0 debt). Its
   * only caller is the gated async execute thunk, so the promise is awaited naturally; the
   * spawn-failure contract (throw/reject with the same message) is unchanged.
   */
  function runShell(command, args) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(command, {
          shell: true,
          cwd: ROOT,
          env: Object.assign({}, process.env, { TOOLFUNNEL_TOOL_ARGS: JSON.stringify(args == null ? null : args) }),
          windowsHide: true,
        });
      } catch (err) {
        reject(new Error(`shell spawn failed: ${err.message}`));
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
      if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(new Error(`shell spawn failed: ${err.message}`));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        const c = typeof code === 'number' ? code : -1;
        resolve({ ok: c === 0, code: c, stdout, stderr });
      });
    });
  }

  return {
    // Briefs only (protocol forwards { filter, category }). When a tool-state overlay is configured,
    // DISABLED (✗) tools are dropped so toolfunnel_list_tools never surfaces them to the client -
    // read FRESH each call so a UI toggle takes effect immediately, no host restart. HIDDEN (👁) is
    // UI-only and is deliberately NOT consulted here (it must never change what the client sees).
    list(listOpts) {
      const o = listOpts || {};
      let local = registry.list(o);
      const state = toolStatePath ? loadToolState(toolStatePath) : null;
      if (state) local = local.filter((b) => isToolEnabled(state, b.id));

      const agg = liveAggregator();
      if (!agg || typeof agg.leanToolDefinitions !== 'function') return local;
      // Append the LEAN upstream tools (the full discovered set of connected upstreams), then:
      //  - drop any whose name is a local tool (local-register WINS - matches resolveExecution),
      //  - apply the SAME {filter,category} registry.list applied (parity), and
      //  - apply the SAME tool-state enable filter local tools get, so the lean list is CURATABLE
      //    per-tool: disable an upstream tool by its surfaced id, exactly like a local tool.
      let upstream = [];
      try {
        upstream = agg.leanToolDefinitions()
          .map((d) => ({ id: d.name, name: d.name, summary: d.description || '', category: `mcp:${d.upstream}` }))
          .filter((b) => resolveId(b.id) === null)
          .filter((b) => briefMatches(b, o))
          .filter((b) => !state || isToolEnabled(state, b.id));
      } catch (_e) {
        upstream = []; // a throwing aggregator must never sink toolfunnel_list_tools - local-only fallback
      }
      return local.concat(upstream);
    },

    // Full instructions for one tool (by id or display name). Registry.instructions throws on an
    // unknown id; protocol.toolInstructions catches that and returns a clean error result.
    instructions(nameOrId) {
      const id = resolveId(nameOrId);
      if (id) return registry.instructions(id);
      // Not a local tool - synthesise instructions for a lean upstream tool from its discovered def.
      const agg = liveAggregator();
      if (!agg || typeof agg.leanToolDefinitions !== 'function') return null;
      try {
        const def = agg.leanToolDefinitions().find((d) => d.name === nameOrId);
        return def ? renderUpstreamInstructions(def) : null; // null -> protocol's "no tool named ..."
      } catch (_e) {
        return null;
      }
    },

    // Build the { execute, toolName, args, mode } resolution protocol.runTool hands to gatedRun.
    resolveExecution(nameOrId, args) {
      const id = resolveId(nameOrId);
      if (id) {
        // LOCAL tool - byte-for-byte the pre-slice-2 path. A local name that resolves but isn't
        // runnable returns null and does NOT fall through to upstream (local-register WINS: a local
        // name never silently resolves to a remote upstream).
        const entry = registry.getEntry(id); // { id, name, summary, category, instructions, invoke, mode? }
        const desc = registry.resolveExecution(id, args); // { type, mode, run? } | reference: { type, mode, instructions }
        if (!desc) return null;

        // Reference mode: nothing executes here. Hand back the instructions (no execute thunk)
        // so protocol.runTool takes the no-spawn path (execute() is never called). Note this is
        // NOT ungated: protocol.runTool still fires PreToolUse on the instruction handoff, so a
        // deny withholds the instructions. What's absent is server-side EXECUTION, not the gate.
        if (desc.mode === 'reference') {
          return {
            mode: 'reference',
            toolName: entry.name || id,
            instructions: typeof desc.instructions === 'string' ? desc.instructions : (entry.instructions || ''),
          };
        }

        if (typeof desc.run !== 'function') return null;

        const execute = async () => {
          const out = await desc.run();
          // Shell invokes come back deferred - the registry hands shell execution to the gated path.
          if (out && out.deferred === true && out.type === 'shell') {
            return runShell(out.command, out.args);
          }
          return out;
        };

        return { execute, toolName: entry.name || id, args: args == null ? {} : args, mode: desc.mode || 'gateway' };
      }

      // No local tool by this name - try the LEAN upstream forward. resolveLeanExecution returns a
      // resolution whose execute thunk lazy-(re)connects + unwraps; the gate matches fwd.toolName (the
      // surfaced name). mode is 'gateway' so it goes THROUGH gatedRun - never the reference handoff.
      const agg = liveAggregator();
      if (!agg || typeof agg.resolveLeanExecution !== 'function') return null;
      let fwd = null;
      try { fwd = agg.resolveLeanExecution(nameOrId, args); } catch (_e) { fwd = null; }
      if (!fwd || typeof fwd.execute !== 'function') return null;
      return { execute: fwd.execute, toolName: fwd.toolName, args: args == null ? {} : args, mode: 'gateway' };
    },
  };
}

// ── Build the protocol + aggregator (the meta-tool logic + the curated-direct seam). ──────────
// All wiring failures are caught so the server still starts and reports a clean JSON-RPC error
// instead of dying - a dead server hangs the client (and the test).
//
// Returns an OBJECT, not just the protocol, because the Phase-2 curated-direct call path needs
// more than the protocol:
//   { protocol, aggregator, engine, ctx }
//   - protocol   : the 4 meta-tools (unchanged Phase-1 logic) - callers needing just the
//                  protocol read it off `.protocol` (backward compat).
//   - aggregator : the upstream-MCP connection + curated-expose set (built from expose.json).
//                  Default expose.json is EMPTY so it connects to nothing.
//   - engine, ctx: threaded into gatedRun for the curated-direct path (a curated tool runs
//                  THROUGH the same PreToolUse gate as toolfunnel_run_tool - the safety invariant).
function buildProtocol() {
  // Make the config home real before anything reads from it: seeds an external home's register/
  // scripts/expose/hooks from the shipped defaults on first use. A no-op when home === package
  // root; idempotent and never-overwriting afterwards. A failure falls through to loadRegistry's
  // own clear error.
  try { ensureConfigHome(ROOT); } catch (err) { logErr('config-home init failed:', (err && err.message) || String(err)); }
  const registry = loadRegistry(REGISTER_PATH, { scriptsRoot: SCRIPTS_ROOT });
  const loader = loadManifest(MANIFEST_PATH);

  // The hook context every gated run carries (the common hook fields).
  const ctx = {
    session_id: `toolfunnel-mcp-${process.pid}`,
    transcript_path: '',
    cwd: ROOT,
  };

  // The LIVE build holder, created FIRST so both the adapter and the protocol read the CURRENT
  // aggregator/engine after a hot-reload swaps them in place (reloadExpose mutates build.aggregator,
  // reloadHooks mutates build.engine). main() threads this SAME object into the stdio loop and the
  // watchers, so nothing below captures a stale instance.
  //   - registry      : the raw Registry, so handleToolsList can build a full MCP def (with the
  //                      entry's inputSchema) for a LOCAL tool promoted hot to the top-level surface.
  //   - toolStatePath  : the per-tool overlay path, read FRESH per tools/list & tools/call so a UI
  //                      hot/enabled toggle takes effect with no restart (the visibility MATRIX).
  const build = { protocol: null, aggregator: null, engine: null, ctx, registry, toolStatePath: TOOL_STATE_PATH };

  // Engine PROXY: protocol/gatedRun only need engine.fire. Delegating to build.engine means a
  // reloadHooks swap gates the lean-forward (and local run_tool) path with the NEW engine, exactly
  // like curated-direct (which reads build.engine live via deps). Without this the protocol would
  // capture the engine at construction and a runtime hook change would gate one route, not the other.
  const engineProxy = { fire: (event, hookCtx, extra) => build.engine.fire(event, hookCtx, extra) };

  // The adapter reads the aggregator through a LIVE getter (never a captured instance).
  const registryAdapter = makeRegistryAdapter(registry, {
    toolStatePath: TOOL_STATE_PATH,
    getAggregator: () => build.aggregator,
  });

  build.protocol = makeProtocol({
    registry: registryAdapter,
    gatedRun,
    engine: engineProxy,
    ctx,
    howto,
  });
  build.engine = new HookEngine(loader, { cwd: ROOT });

  // Phase 2: the aggregator over expose.json (EMPTY by default -> nothing connects).
  // loadExposeStore on a missing/empty file returns an empty store; Aggregator over an empty store
  // advertises no curated-direct tools and connectAll() is an instant no-op.
  const store = loadExposeStore(EXPOSE_PATH);
  build.aggregator = new Aggregator({
    store, v3Root: ROOT,
    // The WRAPPED upstream is exempt from the path-isolation guard (transparent-wrapper mode,
    // by design). Fresh state read per connect, so a live wrap change counts.
    wrapTargetProvider: () => {
      try { return getPassthrough(loadToolStateResult(TOOL_STATE_PATH).state); } catch (_e) { return null; }
    },
    // Outbound identity per upstream: captured wrap mirror > configured clientName > built-in.
    clientInfoProvider: clientInfoFor,
  });

  // /health downgrade flag: while a wrap is ACTIVE the /mcp surface impersonates the wrapped
  // server, so the transport serves liveness-only health. Fresh read per call -
  // a live wrap change counts, same as wrapTargetProvider above.
  build.wrapActive = () => {
    try { return getPassthrough(loadToolStateResult(TOOL_STATE_PATH).state) != null; } catch (_e) { return false; }
  };

  // MODERN-ONLY POLICY flag for the transport (the legacy GET-SSE channel refuses on it) + the
  // LOUD startup warning the opt-in demands: today every real client is legacy-era, so a flipped
  // switch must never be quiet. The wrap interaction gets its own line - a wrapped legacy server
  // stays reachable ONLY by modern clients while this is set.
  build.serveLegacy = SERVER_CONFIG.serveLegacy !== false;
  if (!build.serveLegacy) {
    let wrapNote = '';
    try {
      const pt = getPassthrough(loadToolStateResult(TOOL_STATE_PATH).state);
      if (pt) wrapNote = ` A wrap ("${pt}") is active: LEGACY clients cannot reach the wrapped server through this gateway while modern-only is set.`;
    } catch (_e) { /* state unreadable - the base warning still fires */ }
    process.stderr.write('[toolfunnel] MODERN-ONLY: serveLegacy:false in toolfunnel.json - legacy-era clients are REFUSED ' +
      '(initialize disabled, legacy requests get a clear error, the legacy SSE channel is off). ' +
      'Every current mainstream client speaks legacy: only set this once your clients are 2026-07-28 era.' + wrapNote + '\n');
  }

  return build;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// JSON-RPC 2.0 helpers.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const JSONRPC = '2.0';
// Standard JSON-RPC error codes.
const ERR = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
});

function makeResult(id, result) {
  return { jsonrpc: JSONRPC, id, result };
}
function makeError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  // A null id is valid for errors where the request id couldn't be determined.
  return { jsonrpc: JSONRPC, id: id === undefined ? null : id, error };
}

// ── MCP method handlers. ──────────────────────────────────────────────────────────────────────
// `wrapId` (optional): when a passthrough WRAP is active, the wrapped upstream's OWN identity
// ({ protocolVersion, serverInfo, capabilities, instructions } from aggregator.wrappedIdentity).
// A wrap must be indistinguishable from connecting to the wrapped MCP directly, so we present ITS
// identity verbatim - name, version, capabilities, instructions - instead of ToolFunnel's own.
function handleInitialize(params, wrapId) {
  // protocolVersion + serverInfo + capabilities { tools:{} } (see the architecture notes §7,
  // mcp-server.test.js asserts a `tools` capability + a protocolVersion).
  // Activity log (self-gating; no-op unless logging is enabled): the CLIENT-connected half of
  // connect logging - the aggregator logs the upstream half. Wrapped though logger.log never throws.
  try {
    const info = params && params.clientInfo;
    logger.log({
      type: 'client',
      event: 'connect',
      client: info && typeof info.name === 'string' ? info.name : 'unknown',
      protocolVersion: params && typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined,
    });
  } catch (_e) { /* never let logging affect the handshake */ }

  // WRAP: present the wrapped upstream's OWN handshake, verbatim - a wrapped MCP must look like
  // itself, not ToolFunnel. EXCEPT protocolVersion: initialize is the LEGACY path, and a legacy
  // client handed a modern version (a wrapped MODERN upstream's identity carries 2026-07-28)
  // would correctly disconnect. Clamp to a version this handshake's era can speak; identity
  // fields (serverInfo/capabilities/instructions) stay verbatim.
  if (wrapId) {
    const upstreamVersion = typeof wrapId.protocolVersion === 'string' ? wrapId.protocolVersion : null;
    const out = {
      protocolVersion: (upstreamVersion && upstreamVersion !== modern.MODERN_PROTOCOL_VERSION)
        ? upstreamVersion : PROTOCOL_VERSION,
      serverInfo: wrapId.serverInfo || SERVER_INFO,
      capabilities: wrapId.capabilities || { tools: { listChanged: true } },
    };
    if (typeof wrapId.instructions === 'string' && wrapId.instructions) out.instructions = wrapId.instructions;
    return out;
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: SERVER_INFO,
    capabilities: {
      // We are a tool host. `tools: {}` declares the capability. Phase 2 wires curated-direct
      // hot-updates, so we now advertise listChanged:true - the server may emit
      // notifications/tools/list_changed when the curated-direct expose set changes (see
      // emitToolsListChanged). The mcp-server.test.js assertion only requires a `tools`
      // capability key + a protocolVersion, both still present.
      tools: { listChanged: true },
    },
  };
}

function handleToolsList(protocol, aggregator, opts) {
  // The TOP-LEVEL surface (tools/list - injected EVERY turn) is assembled from the per-tool `hot`
  // axis of the visibility MATRIX, deduped by name with a fixed precedence (first writer wins):
  //
  //   1. META-TOOLS         hot defaults TRUE  - the 4 management tools; a meta-tool can be HIDDEN
  //                                              from the top level (state[name].hot === false).
  //   2. LOCAL hot tools    hot defaults FALSE - a register tool promoted hot (and enabled); its def
  //                                              carries the entry's inputSchema (or {type:object}).
  //   3. CURATED-DIRECT     the existing expose[] path (an enabled expose entry == top-level).
  //   4. UPSTREAM hot tools hot defaults FALSE - a connected upstream tool promoted hot by its
  //                                              surfaced name (lean run semantics; not via expose[]).
  //
  // Precedence is local-register-wins over an upstream of the same name (matches the lean rule), and
  // a META-tool can NEVER be shadowed by a local/upstream tool of the same name (safety). With the
  // default EMPTY state + EMPTY expose.json this is exactly the 4 meta-tools - byte-identical to the
  // pre-matrix surface. `opts` is OPTIONAL: a Phase-1 / bare-protocol caller (no registry/state) gets
  // meta-tools (all hot) + curated-direct, the prior behaviour. NEVER throws.
  const o = opts || {};
  const registry = o.registry || null;
  const statePath = typeof o.toolStatePath === 'string' && o.toolStatePath ? o.toolStatePath : null;
  let state = {};
  if (statePath) {
    // A CORRUPT overlay (present but unparseable) is not silent: it warns. A wrap lives in this
    // file, so a corrupt overlay would otherwise SILENTLY drop the wrap and leak the funnel surface
    // (meta-tools included) to a wrapped client. We keep serving
    // defaults (fail-open is right for the common non-wrapped case) but the operator now SEES it.
    const res = loadToolStateResult(statePath);
    state = res.state;
    if (res.parseError) warnCorruptToolState(statePath);
  }

  // ── PASSTHROUGH (0.6.0): the transparent-wrapper mode ────────────────────────────────────────
  // When tools.state.json carries `"passthrough": "<upstreamId>"`, the advertised surface is
  // EXACTLY that upstream's tools (real schemas, implicitly hot) - no meta-tools, no locals, no
  // curated-direct. handleToolsCall routes by the same rule, so the callable surface stays equal
  // to the advertised one, and every call still fires the PreToolUse gate. The wrap survives an
  // upstream that is down (empty list + a throttled warning) rather than falling back to the
  // funnel surface - a wrapped gateway must never leak its own tools because a child was slow.
  const passthroughId = getPassthrough(state);
  if (passthroughId) {
    return { tools: passthroughDefinitions(aggregator, state, passthroughId) };
  }

  const byName = new Map(); // name -> MCP tool def; first writer wins (the precedence above)

  // The 4 meta-tool names are RESERVED: nothing else may be advertised under them, even when a meta
  // is hidden (else a curated-direct/upstream tool aliased onto a meta name would be advertised yet
  // uncallable - handleToolsCall routes a meta name to the meta gate first).
  const metaNames = new Set(protocol.toolDefinitions().map((d) => d && d.name));

  // 1. META-TOOLS - hot by default; hideable via state[name].hot === false (footgun: hiding all is
  //    the "ordinary tools as an MCP" pattern - warned below + at the write site).
  for (const def of protocol.toolDefinitions()) {
    if (def && isToolHot(state, def.name, true) && !byName.has(def.name)) byName.set(def.name, def);
  }

  // 2. LOCAL hot tools - opt-in (hot:true) AND enabled. A real MCP def from the register entry.
  if (registry) {
    for (const def of localHotDefinitions(registry, state)) {
      if (def && !byName.has(def.name)) byName.set(def.name, def);
    }
  }

  // 3. CURATED-DIRECT (expose[]) - unchanged. exposedToolDefinitions never throws, but guard anyway.
  //    Skip any def colliding with a RESERVED meta name (never advertise a phantom uncallable tool).
  if (aggregator && typeof aggregator.exposedToolDefinitions === 'function') {
    try {
      const defs = aggregator.exposedToolDefinitions();
      if (Array.isArray(defs)) for (const def of defs) if (def && !byName.has(def.name) && !metaNames.has(def.name)) byName.set(def.name, def);
    } catch (err) {
      logErr('exposedToolDefinitions failed:', (err && err.message) || String(err));
    }
  }

  // 4. UPSTREAM hot tools - a connected upstream tool promoted hot by its surfaced name (and enabled),
  //    not already surfaced. Skip a name that is RESERVED (meta) or TAKEN by a local tool's id/display
  //    name - local-register-wins, AND it keeps the advertised name resolving to what actually runs
  //    (a local display-name collision would otherwise advertise the upstream but run the local tool).
  if (aggregator && typeof aggregator.leanToolDefinitions === 'function') {
    try {
      for (const d of aggregator.leanToolDefinitions()) {
        if (!d || byName.has(d.name) || metaNames.has(d.name) || localNameTaken(registry, d.name)) continue;
        if (isToolHot(state, d.name, false) && isToolEnabled(state, d.name)) {
          byName.set(d.name, { name: d.name, description: d.description || '', inputSchema: d.inputSchema || { type: 'object' } });
        }
      }
    } catch (err) {
      logErr('leanToolDefinitions (hot) failed:', (err && err.message) || String(err));
    }
  }

  // Footgun warning (server-side, throttled): if NO meta-tool is on the surface, in-band tool
  // discovery/run is gone - recovery is the --ui console or hand-editing tools/tools.state.json.
  const metaPresent = [...metaNames].some((n) => byName.has(n));
  if (!metaPresent && !_noMetaWarned) {
    logErr('WARNING: all meta-tools are hidden (hot:false) - no in-band tool discovery/run remains. Recover via `--ui` or by editing tools/tools.state.json.');
    _noMetaWarned = true;
  } else if (metaPresent) {
    _noMetaWarned = false;
  }

  return { tools: [...byName.values()] };
}

/** Module flag so the all-metas-hidden warning logs ONCE per episode (not on every tools/list). */
let _noMetaWarned = false;

/** Throttled (once per episode) warning that tools.state.json is present but corrupt - so a dropped
 *  wrap / lost off-switch is never SILENT. Reset would need a process restart; that's fine. */
let _corruptStateWarned = false;
function warnCorruptToolState(statePath) {
  if (_corruptStateWarned) return;
  _corruptStateWarned = true;
  logErr(`WARNING: ${statePath} is present but not valid JSON - ignoring it and serving DEFAULTS. ` +
    'If a passthrough wrap or a per-tool disable was set, it is NOT in effect right now. Fix the file.');
}

/**
 * The advertised surface under PASSTHROUGH: exactly the wrapped upstream's tools, presented
 * under their ORIGINAL names (`d.tool`, not the collision-proof surfaced `<upstream>_<tool>`) -
 * with ONE upstream, collisions are impossible, and a transparent wrapper must look like the
 * MCP it wraps, tool names included. Each def carries its real discovered schema. An explicit
 * enabled:false (keyed by the SURFACED name - the stable key the UI/tf_* tools write) still
 * filters a tool out; the hot axis is ignored (the wrap makes everything implicitly hot). A down
 * or unknown upstream yields an EMPTY list plus a throttled stderr warning - never a fallback to
 * the funnel surface. NEVER throws.
 */
function passthroughDefinitions(aggregator, state, upstreamId) {
  const out = [];
  if (!aggregator || typeof aggregator.leanToolDefinitions !== 'function') {
    warnPassthroughEmpty(upstreamId, 'no aggregator');
    return out;
  }
  try {
    // The upstream's RAW discovered defs - a wrapped surface must advertise the tool exactly as
    // the upstream does (annotations, title, outputSchema, future fields). The old projection to
    // {name, description, inputSchema} made all 13 real server-everything tools differ from a
    // direct connection (wrap-lab, 2026-07-17). leanToolDefinitions still drives the walk: it
    // carries the SURFACED name (the stable enabled:false key) and the collision guard.
    const rawByName = new Map();
    if (typeof aggregator.toolsByUpstream === 'function') {
      for (const t of (aggregator.toolsByUpstream()[upstreamId] || [])) {
        if (t && typeof t.name === 'string') rawByName.set(t.name, t);
      }
    }
    for (const d of aggregator.leanToolDefinitions()) {
      if (!d || d.upstream !== upstreamId) continue;
      if (!isToolEnabled(state, d.name)) continue;
      const original = typeof d.tool === 'string' && d.tool ? d.tool : d.name;
      const raw = rawByName.get(original);
      out.push(raw || {
        name: original,
        description: d.description || '',
        inputSchema: d.inputSchema || { type: 'object' },
      });
    }
  } catch (err) {
    logErr('passthrough: leanToolDefinitions failed:', (err && err.message) || String(err));
  }
  if (out.length === 0) warnPassthroughEmpty(upstreamId, 'upstream not connected or has no tools');
  else _passthroughWarned = false;
  return out;
}

/** Throttled (once per episode) warning when a wrapped gateway has nothing to advertise. */
let _passthroughWarned = false;
function warnPassthroughEmpty(upstreamId, why) {
  if (_passthroughWarned) return;
  _passthroughWarned = true;
  logErr(`WARNING: passthrough wrap of upstream "${upstreamId}" advertises NO tools (${why}). ` +
    'Check the upstream is attached + enabled in mcp/expose.json, or clear the wrap with `toolfunnel wrap --off`.');
}

/**
 * Resolve a PASSTHROUGH call name (the ORIGINAL upstream tool name, as advertised) back to the
 * SURFACED name the aggregator/register resolve internally. Returns the surfaced name, or null
 * when the name is not an advertised wrapped tool (unknown, other upstream, or explicitly
 * disabled - callable == advertised). The call-routing twin of passthroughDefinitions. The
 * PreToolUse gate fires on the SURFACED name - stable whether the wrap is on or off, so a gate
 * authored before wrapping keeps gating the same tool after. NEVER throws.
 */
function resolvePassthroughName(aggregator, state, upstreamId, name) {
  if (!aggregator || typeof aggregator.leanToolDefinitions !== 'function') return null;
  try {
    const d = aggregator
      .leanToolDefinitions()
      .find((x) => x && x.upstream === upstreamId && ((x.tool || x.name) === name));
    if (!d) return null;
    return isToolEnabled(state, d.name) ? d.name : null;
  } catch (_e) {
    return null;
  }
}

/** Is `name` already a LOCAL register tool's id OR display name? Used to keep the lean-rule
 *  "local-register wins" consistent on the top-level surface (and so an advertised upstream name is
 *  never run as a local tool via the run path's display-name resolution). NEVER throws. */
function localNameTaken(registry, name) {
  if (!registry) return false;
  try {
    return registry.list().some((b) => b && (b.id === name || b.name === name));
  } catch (_e) {
    return false;
  }
}

/**
 * The MCP tool definitions for every LOCAL register tool promoted HOT (and enabled). Each is built
 * from the register entry so a directly-callable top-level tool carries a real input schema:
 *   - name        = the register `id` (an identifier-clean MCP tool name; the human `name` may carry
 *                   spaces, which is a poor MCP tool name). The id is also what toolfunnel_run_tool
 *                   resolves, and the PreToolUse gate fires on `entry.name || id` for BOTH the direct
 *                   call and a run_tool call (the adapter's resolveExecution sets that toolName), so a
 *                   gate authored via the UI - which keys the matcher on that same `entry.name || id`
 *                   - gates both routes identically. No new gate-naming footgun vs run_tool today.
 *   - description = the entry summary (falls back to the human name, then the id).
 *   - inputSchema = the entry's optional `inputSchema` object, else a free-form {type:object}.
 * NEVER throws.
 * @param {object} registry  the raw Registry
 * @param {object} state     the loaded tool-state overlay
 * @returns {Array<{name:string, description:string, inputSchema:object}>}
 */
function localHotDefinitions(registry, state) {
  const out = [];
  let briefs;
  try { briefs = registry.list(); } catch (_e) { return out; }
  for (const b of briefs) {
    if (!b || typeof b.id !== 'string') continue;
    if (!isToolHot(state, b.id, false)) continue;     // opt-in only (default off)
    if (!isToolEnabled(state, b.id)) continue;         // a disabled tool is never hot
    let entry;
    try { entry = registry.getEntry(b.id); } catch (_e) { continue; }
    out.push(localToolDefinition(entry));
  }
  return out;
}

/** Build one top-level MCP def from a register entry. name = the id (clean identifier). description
 *  = summary || name || id. inputSchema = entry.inputSchema when an object, else free-form {type:object}. */
function localToolDefinition(entry) {
  const schema = entry && entry.inputSchema && typeof entry.inputSchema === 'object' && !Array.isArray(entry.inputSchema)
    ? entry.inputSchema
    : { type: 'object' };
  const description = (entry && typeof entry.summary === 'string' && entry.summary)
    ? entry.summary
    : ((entry && typeof entry.name === 'string' && entry.name) ? entry.name : entry.id);
  return { name: entry.id, description, inputSchema: schema };
}

async function handleToolsCall(protocol, aggregator, deps, params) {
  const p = params || {};
  const name = p.name;
  const args = p.arguments;
  if (typeof name !== 'string' || name.length === 0) {
    // Shape the bad-params case as an MCP tools/call error result (isError) rather than a
    // protocol-level JSON-RPC error, so the model sees a usable message.
    return {
      content: [{ type: 'text', text: 'tools/call requires a string "name".' }],
      isError: true,
    };
  }

  // ── Routing (see the architecture notes §2; the curated-direct invariant in §9; the MATRIX) ────
  //   1. A meta-tool name -> protocol.dispatch (unchanged; a meta-tool can NEVER be shadowed).
  //   2. ELSE a LOCAL tool promoted HOT, called directly -> run it exactly like toolfunnel_run_tool
  //      {name,args}: ONE path, reusing the PreToolUse gate + reference-mode + register resolution.
  //      Local-register wins over a curated-direct of the same name (the lean rule + list precedence).
  //   3. ELSE a curated-direct tool (expose[]) -> run THROUGH gatedRun with transparent upstream-
  //      envelope passthrough. THE INVARIANT: it can NEVER reach the upstream without the gate.
  //   4. ELSE an UPSTREAM tool promoted HOT (by surfaced name, not via expose[]), called directly ->
  //      run it through the gate with the upstream envelope passed through VERBATIM, exactly like
  //      route 3 - a hot upstream tool and a curated one must be indistinguishable to the caller.
  //   5. ELSE -> protocol.dispatch, which returns the clean unknown-tool error.
  // Only tools ACTUALLY advertised hot are directly callable (the advertised surface == the callable
  // surface - a non-promoted tool called directly gets the clean unknown-tool error, not a silent run).
  // Load the tool-state overlay ONCE for the routing checks - fresh per call so a UI toggle is live.
  const d0 = deps || {};
  let state = {};
  if (d0.toolStatePath) { try { state = loadToolState(d0.toolStatePath); } catch (_e) { state = {}; } }

  // 0. PASSTHROUGH: under a wrap the callable surface is EXACTLY the wrapped upstream's tools -
  //    the meta-tools and everything else are uncallable (the advertised surface is the callable
  //    surface, same invariant as the matrix). The call runs the UPSTREAM tool directly through the
  //    gate (runLeanForward), NOT via protocol.runTool - protocol.runTool's adapter is local-first,
  //    so a local register tool whose id collides with the wrapped upstream's surfaced name would
  // silently execute INSTEAD of the upstream. A transparent
  //    wrap must run the upstream regardless of a local shadow; runLeanForward resolves straight off
  //    the aggregator, so the gate still fires on the surfaced name and the upstream always runs.
  const passthroughId = getPassthrough(state);
  // Bridge B RESUME: an MRTR retry carries requestState (+ inputResponses) - answer the
  // upstream's held question and continue the SUSPENDED call. It never re-enters the gate:
  // the gate fired when the original call started, and no new upstream call is issued.
  // Checked BEFORE the passthrough guard: a retry after the wrap was CLEARED mid-suspension
  // (A->null) must still reach the token machinery - whose identity check cancels the stranded
  // upstream question and answers neutrally - instead of falling into funnel routing and
  // leaking an "Unknown meta-tool" funnel tell mid-conversation. requestState
  // is protocol-level MRTR vocabulary, never ordinary tool args, so this intercept is safe.
  if (p.requestState !== undefined || p.inputResponses !== undefined) {
    return await resumeElicit(p, d0.modernCaller === true, passthroughId, d0.cancelKey || null);
  }
  if (passthroughId) {
    // The client calls the ORIGINAL tool name (as advertised); resolve it to the SURFACED name the
    // aggregator + gate use (stable whether wrapped or not).
    const surfaced = resolvePassthroughName(aggregator, state, passthroughId, name);
    if (surfaced) {
      // Forward the caller's request-scoped _meta minus the modern protocol trio - same
      // strip-and-merge as forwardWrapped. progressToken lives here; dropping it killed progress
      // for every wrapped call.
      const meta = stripProtocolMeta(p._meta);
      return await runLeanForward(aggregator, { engine: d0.engine, ctx: d0.ctx }, surfaced, args,
        { calledName: name, meta, cancelKey: d0.cancelKey || null, modernCaller: d0.modernCaller === true });
    }
    return { content: [{ type: 'text', text: `Unknown tool "${name}".` }], isError: true };
  }

  // 1. A meta-tool - but callable ONLY while it is on the advertised top-level surface (hot, default
  //    true). A meta HIDDEN via hot:false is dropped from tools/list AND becomes uncallable, so the
  //    callable surface == the advertised surface even for the meta-tools - the "ordinary tools as an
  //    MCP" lockdown is REAL, not cosmetic. (A meta-tool is still never SHADOWED by a same-named
  //    local/upstream tool: this check runs FIRST, so a hot meta always wins precedence.)
  if (isMetaTool(protocol, name)) {
    if (isToolHot(state, name, true)) {
      return wrapProtocolResult(await protocol.dispatch(name, args || {}));
    }
    // Hidden meta-tool: not advertised, so not callable - the clean unknown-tool error (never run it).
    return { content: [{ type: 'text', text: `Unknown tool "${name}".` }], isError: true };
  }

  if (d0.registry && isPromotedLocal(d0.registry, state, name)) {
    return wrapProtocolResult(await protocol.runTool({ name, args: args == null ? {} : args }));
  }

  if (aggregator && typeof aggregator.isExposed === 'function' && aggregator.isExposed(name)) {
    // The caller's non-protocol _meta rides the forward here too - the progressToken is the
    // upstream-side keep-alive (beats are NOT fanned out to funnel clients; wrap mode relays them).
    return await runCuratedDirect(aggregator, deps, name, args, stripProtocolMeta(p._meta));
  }

  if (isPromotedUpstream(aggregator, d0.registry, state, name)) {
    // VERBATIM envelope, exactly like curated-direct - routing this through protocol.runTool's
    // lean adapter flattened multi-block content to one JSON-stringified text block and dropped
    // structuredContent: identical advertised def, broken results.
    return await runHotUpstreamDirect(aggregator, { engine: d0.engine, ctx: d0.ctx }, name, args,
      stripProtocolMeta(p._meta));
  }

  // Not a meta-tool, not promoted, not exposed -> let the protocol return its clean unknown-tool error.
  return wrapProtocolResult(await protocol.dispatch(name, args || {}));
}

/**
 * Is `name` a LOCAL register tool that is promoted HOT and enabled (so it's on the top-level surface
 * AND therefore directly callable)? Resolves the advertised name (entry.name || id) back to the
 * register entry, then checks the hot+enabled flags by the tool's id (the state key). NEVER throws.
 */
function isPromotedLocal(registry, state, name) {
  const entry = localEntryByAdvertisedName(registry, name);
  if (!entry) return false;
  return isToolHot(state, entry.id, false) && isToolEnabled(state, entry.id);
}

/** Resolve a top-level call name back to its register brief. The advertised top-level name is the
 *  `id`; the human `name` is accepted too (forgiving callers). Returns the brief {id,name,...} or
 *  null. NEVER throws. */
function localEntryByAdvertisedName(registry, name) {
  try {
    const briefs = registry.list();
    let hit = briefs.find((b) => b && b.id === name);
    if (!hit) hit = briefs.find((b) => b && b.name === name);
    return hit || null;
  } catch (_e) {
    return null;
  }
}

/**
 * Is `name` a connected UPSTREAM tool (by surfaced name) promoted HOT and enabled? Only reached for a
 * name that is NOT a meta-tool, NOT a promoted local tool, and NOT curated-direct (those are routed
 * first), so this is the "hot upstream, not via expose[]" case. NEVER throws.
 */
function isPromotedUpstream(aggregator, registry, state, name) {
  if (!aggregator || typeof aggregator.leanToolDefinitions !== 'function') return false;
  // local-register wins: a name that is a local tool's id/display name is NOT an upstream-hot route,
  // even if an upstream surfaces that name (it would otherwise run the LOCAL tool via the run path's
  // display-name resolution - advertised-upstream / executed-local). Matches handleToolsList step 4.
  if (localNameTaken(registry, name)) return false;
  try {
    const d = aggregator.leanToolDefinitions().find((x) => x && x.name === name);
    if (!d) return false;
    return isToolHot(state, d.name, false) && isToolEnabled(state, d.name);
  } catch (_e) {
    return false;
  }
}

/** Is `name` one of the 4 lean meta-tools the protocol owns? */
function isMetaTool(protocol, name) {
  // protocol.META_TOOLS is { LIST, INSTRUCTIONS, RUN, HOWTO } -> string values.
  const meta = protocol && protocol.META_TOOLS;
  if (!meta || typeof meta !== 'object') return false;
  for (const key of Object.keys(meta)) {
    if (meta[key] === name) return true;
  }
  return false;
}

/**
 * Run a CURATED-DIRECT tool through the hook gate. Resolve {execute} from the aggregator, then
 * hand it to gatedRun with the threaded engine + ctx so PreToolUse fires on the DOWNSTREAM name
 * (the gate's matcher target) BEFORE the upstream tool is ever invoked. The result is wrapped in
 * the MCP tools/call envelope: isError when !ok, surfacing reason (a PreToolUse block) or error
 * (a thrown upstream call). NEVER throws - a misbehaving aggregator/gate becomes a clean error
 * result so the loop survives.
 */
/** The caller's request-scoped _meta minus the modern protocol keys - one strip shared by the
 *  wrap forward and both funnel forward paths. Returns undefined when nothing survives. */
function stripProtocolMeta(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return undefined;
  const out = {};
  for (const k of Object.keys(m)) {
    if (!k.startsWith('io.modelcontextprotocol/')) out[k] = m[k];
  }
  return Object.keys(out).length ? out : undefined;
}

async function runCuratedDirect(aggregator, deps, name, args, meta) {
  const d = deps || {};
  // resolveExposedExecution -> { execute, toolName, upstream } | null. It can change between the
  // isExposed() check and here only if the expose set mutated mid-call; guard for null.
  let resolution = null;
  try {
    resolution = aggregator.resolveExposedExecution(name, args, meta);
  } catch (err) {
    return {
      content: [{ type: 'text', text: `curated tool "${name}" failed to resolve: ${(err && err.message) || String(err)}` }],
      isError: true,
    };
  }
  if (!resolution || typeof resolution.execute !== 'function') {
    // Raced away (or never really runnable) - surface a clean error rather than reaching upstream.
    return {
      content: [{ type: 'text', text: `curated tool "${name}" is no longer runnable` }],
      isError: true,
    };
  }

  // The gate matches on the DOWNSTREAM name (resolution.toolName === the `as` name). gatedRun is
  // contracted never to throw, but we still try/catch so a wiring bug can't crash the loop.
  let result;
  try {
    result = await gatedRun({
      engine: d.engine,
      ctx: d.ctx,
      toolName: resolution.toolName || name,
      args: args == null ? {} : args,
      execute: resolution.execute,
    });
  } catch (err) {
    return {
      content: [{ type: 'text', text: `gated execution of "${name}" failed: ${(err && err.message) || String(err)}` }],
      isError: true,
    };
  }

  // Gate-level failure (a PreToolUse block, or a thrown upstream call): surface the most
  // informative message - a block carries `reason`, a thrown call carries `error`.
  if (!(result && result.ok === true)) {
    const message = firstString(
      result && result.error && (result.error.message || String(result.error)),
      result && result.reason,
      'curated tool call failed'
    );
    return { content: [{ type: 'text', text: stringifyContent(message) }], isError: true };
  }

  // Success: result.output IS the upstream's own tools/call envelope ({ content, isError }).
  // Pass it THROUGH transparently so the client receives the upstream's real content blocks
  // (text / image / etc.) AND its isError flag - rather than the whole envelope JSON-stringified
  // into one text block (which also used to swallow the upstream's isError). runCuratedDirect only
  // ever runs FORWARDED upstream tools, so result.output is always an MCP envelope here.
  const out = result.output;
  if (out && typeof out === 'object' && Array.isArray(out.content)) {
    const shaped = { content: out.content, isError: out.isError === true };
    // structuredContent rides along - callTool preserves it from the upstream; dropping it HERE
    // silently stripped modern upstreams' structured results on the curated-direct path while
    // the wrap path returned them verbatim.
    if (out.structuredContent !== undefined) shaped.structuredContent = out.structuredContent;
    return shaped;
  }
  // Defensive fallback: a non-standard upstream payload - wrap it as text so the client still gets
  // a well-formed envelope rather than an empty/invalid content array.
  return { content: [{ type: 'text', text: stringifyContent(out) }], isError: false };
}

/**
 * Run a HOT-PROMOTED upstream tool (matrix route 4 - on the top-level surface WITHOUT an
 * expose[] entry) through the hook gate with the upstream's envelope passed through VERBATIM -
 * multi-block content, isError, structuredContent - exactly like curated-direct. The lean
 * adapter's unwrap flattened all of that into one JSON-stringified text block.
 * resolveRawExecution is the envelope-verbatim resolver (nothing about it is wrap-specific);
 * gatedRun still fires PreToolUse on the surfaced name BEFORE the upstream is invoked. Error
 * text is funnel-honest (this is funnel mode - no invisibility requirement). NEVER throws.
 */
async function runHotUpstreamDirect(aggregator, deps, name, args, meta) {
  const d = deps || {};
  let resolution = null;
  try {
    if (aggregator && typeof aggregator.resolveRawExecution === 'function') {
      resolution = aggregator.resolveRawExecution(name, args, meta);
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `tool "${name}" failed to resolve: ${(err && err.message) || String(err)}` }],
      isError: true,
    };
  }
  if (!resolution || typeof resolution.execute !== 'function') {
    // Raced away (tools changed / upstream dropped) - clean unknown-tool error, never a silent run.
    return { content: [{ type: 'text', text: `Unknown tool "${name}".` }], isError: true };
  }
  let result;
  try {
    result = await gatedRun({
      engine: d.engine,
      ctx: d.ctx,
      toolName: resolution.toolName || name,
      args: args == null ? {} : args,
      execute: resolution.execute,
    });
  } catch (err) {
    return {
      content: [{ type: 'text', text: `gated execution of "${name}" failed: ${(err && err.message) || String(err)}` }],
      isError: true,
    };
  }
  if (!(result && result.ok === true)) {
    const message = firstString(
      result && result.error && (result.error.message || String(result.error)),
      result && result.reason,
      'tool call failed'
    );
    return { content: [{ type: 'text', text: stringifyContent(message) }], isError: true };
  }
  // Success: result.output IS the upstream's own tools/call envelope - pass it through, with
  // structuredContent riding along (same shaping as runCuratedDirect).
  const out = result.output;
  if (out && typeof out === 'object' && Array.isArray(out.content)) {
    const shaped = { content: out.content, isError: out.isError === true };
    if (out.structuredContent !== undefined) shaped.structuredContent = out.structuredContent;
    return shaped;
  }
  // Defensive fallback: a non-standard upstream payload still returns a well-formed envelope.
  return { content: [{ type: 'text', text: stringifyContent(out) }], isError: false };
}

/**
 * runLeanForward - run a wrapped upstream tool (by surfaced name) through the gate DIRECTLY off
 * the aggregator, bypassing the local-first register adapter. Used by passthrough so a local
 * register tool sharing the surfaced name can never shadow the wrapped upstream's tool. The
 * execution is RAW (resolveRawExecution): the upstream's tools/call envelope - multi-block
 * content, isError, structuredContent - returns VERBATIM, exactly as a direct connection would
 * deliver it. Only a gate block or a transport failure synthesises an envelope. NEVER throws.
 * Synthetic error text is NEUTRAL and keyed to the name the CLIENT called: the surfaced
 * `<upstream>_<tool>` form and internal error strings ("Aggregator.ensureConnected: ...") are both
 * naked wrap tells. A PreToolUse gate block keeps its reason - the gate is deliberate
 * operator policy, not an internal leak.
 * @param {object} aggregator
 * @param {{engine?:object, ctx?:object}} deps
 * @param {string} surfaced  the surfaced upstream tool name (`<upstream>_<tool>` or its `as`)
 * @param {any}    args
 * @param {{calledName?:string, meta?:object}} [opts]  the client-called name (for error text) +
 *        the request-scoped non-protocol _meta to forward (progressToken et al.)
 * @returns {Promise<object>} the upstream's verbatim result, or a synthetic { content, isError }
 */
async function runLeanForward(aggregator, deps, surfaced, args, opts) {
  const d = deps || {};
  const o = opts || {};
  const called = typeof o.calledName === 'string' && o.calledName ? o.calledName : surfaced;
  if (!aggregator || typeof aggregator.resolveRawExecution !== 'function') {
    return { content: [{ type: 'text', text: `tool "${called}" failed` }], isError: true };
  }
  // Cancel translation for the TOOL path: register the upstream rpc id
  // under the caller's (connection, client id) the moment the forward is issued, exactly like
  // forwardWrapped - a wrapped tools/call is the DOMINANT long-running-cancel case and was the
  // one hole left in the map. Registered post-gate: a cancel landing during the gate phase is a
  // best-effort drop (micro-window, same accepted class as the rpc-issue microtask window).
  // The rpc id is ALSO captured locally: a Bridge B suspension must extend that request's
  // timeout (a human answers at human speed; the dead-upstream clock must not kill the hold).
  let upstreamRpcId = null;
  const track = {
    set rpcId(v) {
      upstreamRpcId = v;
      if (o.cancelKey) inflightForwards.set(o.cancelKey, v);
    },
  };
  let resolution = null;
  try {
    resolution = aggregator.resolveRawExecution(surfaced, args, o.meta, track);
  } catch (_err) {
    return { content: [{ type: 'text', text: `tool "${called}" failed` }], isError: true };
  }
  if (!resolution || typeof resolution.execute !== 'function') {
    return { content: [{ type: 'text', text: `tool "${called}" failed` }], isError: true };
  }
  // Bridge B: the upstream may send `elicitation/create` mid-call and hold the call open. Race
  // the real forward against an elicit INSIDE the gated execute, so the gate + PostToolUse fire
  // exactly once around whichever wins. An elicit win resolves gatedRun with a sentinel; the real
  // upstream promise keeps running and is either suspended (modern caller -> MRTR) or completed
  // after an auto-decline (legacy caller - no backwards-request relay yet; see KNOWN_BUGS).
  // The sentinel handed back through gatedRun is SANITISED: PostToolUse hooks JSON-stringify
  // tool_response onto hook stdin, and the full elicit object carries the live McpClient -
  // transport guts + the upstream's env (API keys). Hooks see only the question; the real
  // elicit object (with the client to answer on) rides this closure.
  let realPromise = null;
  let elicitCaught = null;
  const racedExecute = async () => {
    realPromise = resolution.execute();
    const winner = await raceElicit(resolution.upstream, realPromise);
    if (winner.kind === 'elicit') {
      elicitCaught = winner.value;
      return { __tfElicit: { elicitation: winner.value.params } };
    }
    return winner.value;
  };
  let result;
  try {
    result = await gatedRun({
      engine: d.engine,
      ctx: d.ctx,
      toolName: resolution.toolName || surfaced, // the gate matches the surfaced name (stable)
      args: args == null ? {} : args,
      execute: racedExecute,
    });
  } catch (_err) {
    return { content: [{ type: 'text', text: `tool "${called}" failed` }], isError: true };
  } finally {
    if (o.cancelKey) inflightForwards.delete(o.cancelKey); // settled - cancels can no longer target it
  }
  if (result && result.ok === true && result.output && result.output.__tfElicit && elicitCaught) {
    const elicit = elicitCaught;
    if (o.modernCaller === true) {
      return suspendForElicit(elicit, realPromise, resolution.upstream, called, upstreamRpcId);
    }
    // Legacy caller: it cannot receive a backwards request, and the relay is future work -
    // DECLINE so the upstream's held call completes, then serve its actual outcome.
    logErr(`bridge-b: legacy client cannot receive elicitation - auto-declined for "${called}"`);
    try { elicit.client.respondToServer(elicit.elicitId, { action: 'decline' }); } catch (_e) { /* ignore */ }
    try {
      const out = await realPromise;
      result = { ok: true, blocked: false, output: out };
    } catch (_err) {
      return { content: [{ type: 'text', text: `tool "${called}" failed` }], isError: true };
    }
  }
  // Success -> the upstream's envelope, VERBATIM (never re-shaped: re-stringifying multi-block or
  // structured results both destroys data and is a wrap tell).
  if (result && result.ok === true && result.output && typeof result.output === 'object' &&
      Array.isArray(result.output.content)) {
    return result.output;
  }
  // A gate BLOCK carries its reason ONLY when it is deliberate operator policy. An INTERNAL
  // fail-closed (engine wiring/crash - gatedRun marks it internal:true) holds gateway strings:
  // neutralise those too.
  if (result && result.ok !== true && typeof result.reason === 'string' && result.reason &&
      result.internal !== true) {
    return wrapProtocolResult(result);
  }
  if (result && result.ok === true) return wrapProtocolResult(result); // malformed envelope - legacy shaping
  return { content: [{ type: 'text', text: `tool "${called}" failed` }], isError: true };
}

/**
 * Wrap a protocol dispatch result ({ ok, output, error?, reason? }) in the MCP tools/call
 * envelope. Extracted so the meta-tool path and the unknown-tool path share one shaping.
 */
function wrapProtocolResult(result) {
  const isError = !(result && result.ok === true);
  // On error surface the most informative message (a PreToolUse block carries `reason`, a thrown
  // tool carries `error`); on success serialise the output payload.
  let payload;
  if (isError) {
    payload = firstString(
      // gatedRun returns `error` as an Error INSTANCE on a thrown tool - extract its message
      // (firstString only takes strings, so a bare Error would be dropped -> generic text).
      // Mirrors runCuratedDirect's error shaping so the two paths report identically.
      result && result.error && (result.error.message || String(result.error)),
      result && result.reason,
      'tool call failed'
    );
  } else if (result && result.output !== undefined) {
    payload = result.output;
  } else if (result && result.mode === 'reference') {
    // A reference HANDOFF carries no `output` - its `instructions` ARE the payload. Surface them
    // (with the handoff message) so a reference tool returns usable text whether reached via
    // toolfunnel_run_tool OR called directly after being promoted hot (the matrix). Falls back to
    // the whole result object if neither field is a string.
    payload = firstString(result.instructions, result.message) || result;
  } else {
    payload = result && result.output; // undefined -> stringifyContent guards it to a string
  }

  return {
    content: [{ type: 'text', text: stringifyContent(payload) }],
    isError,
  };
}

/** Return the first argument that is a non-empty string (used to pick the best error message). */
function firstString(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return '';
}

/** Serialise a protocol payload into a text block. Strings pass through; everything else -> JSON.
 *  NEVER returns a non-string: JSON.stringify(undefined) / a function yields `undefined`, so guard it
 *  (an MCP content block's `text` must be a string - an undefined text is a malformed envelope). */
function stringifyContent(value) {
  if (typeof value === 'string') return value;
  try {
    const s = JSON.stringify(value);
    return typeof s === 'string' ? s : String(value);
  } catch (_e) {
    return String(value);
  }
}

/**
 * Filter predicate replicating Registry.list's brief filtering (src/tools/registry.js:211-228) so
 * LEAN upstream briefs filter IDENTICALLY to local briefs: exact `category` match + case-insensitive
 * substring `filter` over `id name summary`. Kept in lockstep with registry.list (a parity test covers
 * it); if registry.list's filter semantics ever change, change this too.
 */
function briefMatches(b, opts) {
  const { filter, category } = opts || {};
  if (category && b.category !== category) return false;
  if (typeof filter === 'string' && filter.length) {
    const hay = `${b.id} ${b.name} ${b.summary || ''}`.toLowerCase();
    if (!hay.includes(filter.toLowerCase())) return false;
  }
  return true;
}

/**
 * Render a lean upstream tool's instructions as a STRING (homogeneous with registry.instructions),
 * synthesised from its discovered def { name, description, inputSchema, upstream, tool }: the exact
 * toolfunnel_run_tool invocation, provenance, description, the input schema + required fields, and a
 * note that the call passes the same PreToolUse gate as any local tool.
 */
function renderUpstreamInstructions(def) {
  const lines = [];
  lines.push(`${def.name} - forwarded from upstream MCP "${def.upstream}" (upstream tool: ${def.tool}).`);
  if (def.description) lines.push('', def.description);
  lines.push('', 'Run it through the gateway with:', `  toolfunnel_run_tool { "name": "${def.name}", "args": { ... } }`);
  lines.push('', 'Every call passes the same PreToolUse gate as a local tool (a hook may deny it).');
  let schemaStr;
  try { schemaStr = JSON.stringify(def.inputSchema || { type: 'object' }, null, 2); } catch (_e) { schemaStr = '{ "type": "object" }'; }
  lines.push('', 'Input schema:', schemaStr);
  const req = def.inputSchema && Array.isArray(def.inputSchema.required) ? def.inputSchema.required : [];
  if (req.length) lines.push('', 'Required: ' + req.join(', '));
  return lines.join('\n');
}

/**
 * Normalise the first argument of handleMessage / createStdioLoop into the canonical Phase-2
 * build shape { protocol, aggregator, engine, ctx }. Backward compat: a caller may still pass a
 * bare protocol (Phase-1 callers / older tests) - we wrap it with a null aggregator + no deps so
 * the meta-tool path is identical and the curated-direct path is simply never taken (isExposed
 * is unreachable without an aggregator). A protocol is detected by its dispatch() method.
 * @param {object} arg  either { protocol, aggregator, engine, ctx } or a bare protocol
 * @returns {{ protocol:object, aggregator:(object|null), engine:(object|null), ctx:(object|null) }}
 */
function normaliseBuild(arg) {
  const a = arg || {};
  if (a && typeof a.dispatch === 'function') {
    // It's a bare protocol - Phase-1 shape (no register/state -> no hot promotion; meta + curated only).
    return { protocol: a, aggregator: null, engine: null, ctx: null, registry: null, toolStatePath: null };
  }
  return {
    protocol: a.protocol,
    aggregator: a.aggregator || null,
    engine: a.engine || null,
    ctx: a.ctx || null,
    // The MATRIX inputs: the raw register (for a hot LOCAL tool's full MCP def) + the state overlay
    // path (read fresh per call). Absent -> the surface is meta + curated-direct, the prior behaviour.
    registry: a.registry || null,
    toolStatePath: a.toolStatePath || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Dispatch ONE parsed JSON-RPC message. Returns a response object to send, or null for
// notifications / messages that take no reply. NEVER throws.
//
// `build` is the Phase-2 build object { protocol, aggregator, engine, ctx } (a bare protocol is
// still accepted for backward compat - see normaliseBuild). The aggregator + engine + ctx are
// threaded into tools/list and tools/call so the curated-direct surface is advertised and runs
// THROUGH the PreToolUse gate.
// ─────────────────────────────────────────────────────────────────────────────────────────────
async function handleMessage(build, msg, connKey) {
  // connKey: OPTIONAL stable per-connection identity from the transport. stdio (one client per
  // process) passes a constant; HTTP passes nothing - each POST is a fresh connection, so no
  // cross-POST identity exists in the modern (sessionless) era. Cancel translation under a wrap
  // is only safe WITH an identity: JSON-RPC ids are per-client, and two clients both at id=3
  // must never cancel each other's calls.
  const { protocol, aggregator, engine, ctx, registry, toolStatePath } = normaliseBuild(build);

  // Basic envelope validation - a non-object or wrong jsonrpc is an Invalid Request.
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return makeError(null, ERR.INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC object');
  }

  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null;
  const id = hasId ? msg.id : null;
  const method = msg.method;

  // MODERN-ONLY POLICY (serveLegacy:false in toolfunnel.json - explicit hardening opt-in):
  // refuse every LEGACY-shaped request with a clear error naming the policy. Exemptions:
  // `server/discover` stays answerable meta-less (it is the negotiation endpoint - both eras
  // may knock to learn what this gateway speaks), and modern-SHAPED-but-invalid requests fall
  // through so the standard validator returns its precise -32602/-32022 instead of a blanket
  // refusal. Legacy NOTIFICATIONS are dropped silently - a notification never gets a response.
  if (SERVER_CONFIG.serveLegacy === false && !modern.isModernRequest(msg) &&
      method !== 'server/discover') {
    if (!hasId) return null;
    const text = method === 'initialize'
      ? 'modern-only gateway (serveLegacy:false): the legacy initialize handshake is disabled - connect with the 2026-07-28 protocol (per-request _meta)'
      : 'modern-only gateway (serveLegacy:false): legacy-era requests are refused - send the 2026-07-28 per-request _meta';
    return makeError(id, -32020, text);
  }

  // A message with no method but with an id is a response/garbage to us - acknowledge nothing.
  if (typeof method !== 'string') {
    if (hasId) return makeError(id, ERR.INVALID_REQUEST, 'Invalid Request: missing "method"');
    return null; // notification-shaped junk: ignore
  }

  try {
    // ── WRAP identity (computed once) ─────────────────────────────────────────────────────────
    // Under a passthrough wrap, the handshake + non-tool methods present the WRAPPED upstream, so
    // a client cannot tell it is wrapped (the design requirement: "no one should know it's wrapped,
    // save the ToolFunnel dependency"). ptId = the wrapped upstream id (null when not wrapped);
    // wrapId = its captured identity (null when not wrapped OR not yet connected).
    let ptId = null;
    if (toolStatePath) {
      try {
        const stateRes = loadToolStateResult(toolStatePath);
        if (stateRes.parseError) warnCorruptToolState(toolStatePath); // corrupt file must WARN on every path, not just tools/list
        ptId = getPassthrough(stateRes.state);
      } catch (_e) { ptId = null; }
    }
    // A wrap retarget (A->B, A->null, null->A) invalidates the captured identity mirror - it belongs
    // to the OLD wrap context; presenting it to a different upstream mirrors the wrong client
    //Same-value passes clear nothing.
    if (ptId !== wrapMirrorPtId) { wrapMirrorClientInfo = null; wrapMirrorPtId = ptId; }
    if (aggregator) {
      // Keep the chatter bridge live with the wrap state. Through the setter: a target CHANGE
      // clears the recorded subscriptions (old wrap context); same-value
      // re-arms (every message) clear nothing.
      if (typeof aggregator.setWrapChatterUpstream === 'function') aggregator.setWrapChatterUpstream(ptId);
      else aggregator.wrapChatterUpstream = ptId;
    }
    let wrapId = (ptId && aggregator && typeof aggregator.wrappedIdentity === 'function')
      ? aggregator.wrappedIdentity(ptId) : null;
    if (ptId) {
      // Identity continuity: cache the last-known wrapped identity so an upstream death or a
      // reconnect window never answers a handshake as ToolFunnel (identity leak + visible swap).
      // Never-connected + handshake -> refuse neutrally rather than leak the funnel.
      if (wrapId) lastWrappedIdentity.set(ptId, wrapId);
      else wrapId = lastWrappedIdentity.get(ptId) || null;
      // No identity at all (never connected this process): refuse neutrally - for the handshake
      // AND for any modern request, whose result decoration would otherwise carry ToolFunnel's
      // serverInfo (modern clients are stateless, tools/list without a prior
      // discover is normal - the leak window is real). Legacy non-handshake results carry no
      // identity fields, so they pass.
      if (!wrapId && (method === 'initialize' || method === 'server/discover' || modern.isModernRequest(msg))) {
        return hasId ? makeError(id, ERR.INTERNAL, 'request failed') : null;
      }
    }

    // ── Dual-era routing ─────────────────────────────────────────────────────────────────────
    // server/discover is answered in EITHER era: it is the spec's era probe (a dual-era client
    // uses it on stdio to detect what the server speaks), and the RC leaves the meta-less-probe
    // case undefined - answering is the honest choice (an error would read as "legacy-only").
    // A modern-shaped discover still validates its _meta first. Under a wrap it presents the
    // wrapped server's identity (but keeps OUR supportedVersions - modern-compliance is the point).
    if (method === 'server/discover') {
      if (!hasId) return null;
      if (modern.isModernRequest(msg)) {
        const vErr = modern.validateModernRequest(msg);
        if (vErr) return makeError(id, vErr.code, vErr.message, vErr.data);
      }
      return makeResult(id, handleServerDiscover(wrapId));
    }

    // ── WRAP passthrough for NON-tool methods ─────────────────────────────────────────────────
    // Under a wrap, any method ToolFunnel does not own itself (resources/*, prompts/*, logging/*,
    // completion/*, ...) is FORWARDED verbatim to the wrapped upstream, so a wrapped server behaves
    // exactly as it would connected directly (its advertised capabilities are honest). ToolFunnel
    // keeps ownership of: the handshake (initialize/discover - identity), the tool surface
    // (tools/list + tools/call - GATED, and re-presented under original names), the change stream
    // (subscriptions/listen), and ping. Tool calls NEVER forward here - they stay gated.
    if (ptId && !WRAP_OWNED_METHODS.has(method)) {
      return await forwardWrapped(aggregator, ptId, msg, hasId, id, wrapId, connKey);
    }

    // A request carrying modern per-request _meta -> the 2026-07-28 path. `initialize` ALWAYS
    // selects legacy semantics (the spec's dual-era server rule), even if it carries _meta.
    if (method !== 'initialize' && modern.isModernRequest(msg)) {
      return await handleModernMessage(
        { protocol, aggregator, engine, ctx, registry, toolStatePath },
        msg, hasId, id, method, wrapId, connKey
      );
    }

    switch (method) {
      case 'initialize': {
        // CLIENT IDENTITY MIRRORING (wrap, STDIO only - HTTP is sessionless/multi-client, the
        // configured identity applies there). Capture the real downstream client's clientInfo;
        // if the live wrapped connection introduced itself differently, reconnect it INLINE -
        // the client is waiting on the handshake anyway. Honest cost bound: one full reconnect
        // inside the handshake - up to ~3 s for the era re-probe on an upstream that ignores
        // server/discover, plus the initialize wait on a wedged one (the old
        // "+1-2s once" claim understated it). Once per client session, and only when the
        // presented identity differs.
        // Best-effort: any failure answers from the cached identity; the mirror must never
        // break the handshake.
        if (ptId && connKey === 'stdio' && aggregator) {
          const ci = msg.params && msg.params.clientInfo;
          if (ci && typeof ci === 'object' && typeof ci.name === 'string' && ci.name.length) {
            // Carry the FULL clientInfo through (title etc. - the wrap's serverInfo direction
            // learned this the hard way: a name/version whitelist eats spec fields). Only
            // name/version are normalised; the comparison below uses just those two.
            wrapMirrorClientInfo = Object.assign({}, ci, {
              name: ci.name,
              version: typeof ci.version === 'string' ? ci.version : '0.0.0',
            });
            try {
              const live = await aggregator.ensureConnected(ptId, { allowConnect: false })
                .catch(() => null); // not connected right now -> reconnect() below presents the mirror
              const presented = live && live.clientInfo;
              if (!presented || presented.name !== wrapMirrorClientInfo.name ||
                  presented.version !== wrapMirrorClientInfo.version) {
                // reconnect() settles any in-flight connect before discarding - never join a
                // connect this path just poisoned.
                await aggregator.reconnect(ptId);
              }
              // The (re)connect refreshed the upstream identity - recompute wrapId from it.
              const freshId = typeof aggregator.wrappedIdentity === 'function'
                ? aggregator.wrappedIdentity(ptId) : null;
              if (freshId) { wrapId = freshId; lastWrappedIdentity.set(ptId, freshId); }
            } catch (_e) { /* mirror is best-effort - wrapId (cached identity) still answers */ }
          }
        }
        return makeResult(id, handleInitialize(msg.params, wrapId));
      }

      case 'initialized':
      case 'notifications/initialized':
        // Client -> server notification that init handshake is complete. No reply.
        return null;

      case 'tools/list':
        return makeResult(id, handleToolsList(protocol, aggregator, { registry, toolStatePath }));

      case 'tools/call': {
        // cancelKey: lets a wrapped tools/call register its upstream rpc id for cancel
        // translation, same (connection, client id) contract as forwardWrapped.
        const cancelKey = (connKey !== undefined && hasId) ? `${connKey}:${id}` : null;
        const result = await handleToolsCall(protocol, aggregator,
          { engine, ctx, registry, toolStatePath, cancelKey, modernCaller: false }, msg.params);
        // Observability (in-memory counters; never throws). Count every tools/call by name + whether
        // it errored (an isError envelope = a tool failure OR a PreToolUse denial). Single chokepoint
        // -> covers stdio AND the HTTP transport, which both route through handleMessage.
        metrics.record({ tool: (msg.params && msg.params.name) || 'unknown', ok: !(result && result.isError === true) });
        return makeResult(id, result);
      }

      case 'ping':
        // MCP keep-alive: empty result.
        return makeResult(id, {});

      default:
        // Unknown notification (no id) -> silently ignore. Unknown request -> method-not-found.
        if (!hasId) {
          if (method.startsWith('notifications/')) return null;
          return null;
        }
        return makeError(id, ERR.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch (err) {
    // Any unexpected internal failure becomes a JSON-RPC error (request) or is swallowed
    // (notification) - the loop never crashes on one bad message.
    logErr('handler error for', method + ':', (err && err.stack) || String(err));
    if (hasId) {
      return makeError(id, ERR.INTERNAL, `Internal error handling "${method}"`, (err && err.message) || String(err));
    }
    return null;
  }
}

/**
 * handleServerDiscover - the server/discover result (modern era; servers MUST implement it).
 * Capabilities mirror what initialize advertises so the two eras never drift.
 *
 * `wrapId` (optional): under a passthrough WRAP, present the wrapped upstream's serverInfo +
 * capabilities + instructions verbatim (invisible wrap) - but keep OUR supportedVersions (both
 * eras): the wrap's value is that a legacy MCP becomes modern-compliant, so a modern client
 * SHOULD see modern support. Identity from the upstream; protocol reach from ToolFunnel.
 */
function handleServerDiscover(wrapId) {
  if (wrapId) {
    return modern.discoverResult(
      wrapId.serverInfo || SERVER_INFO,
      wrapId.capabilities || { tools: { listChanged: true } },
      typeof wrapId.instructions === 'string' ? wrapId.instructions : undefined
    );
  }
  return modern.discoverResult(
    SERVER_INFO,
    { tools: { listChanged: true } },
    'ToolFunnel is a dual-era MCP gateway: it speaks the ' + modern.MODERN_PROTOCOL_VERSION +
      ' revision (per-request _meta, server/discover, subscriptions/listen) and the ' +
      PROTOCOL_VERSION + ' revision (initialize handshake) on the same endpoint. ' +
      'Every tool call passes a server-side policy gate before it runs.'
  );
}

/**
 * The methods ToolFunnel OWNS even under a wrap - everything else is forwarded to the wrapped
 * upstream (see forwardWrapped). The handshake (identity), the gated tool surface, the change
 * stream, and ping stay ours; resources/prompts/logging/completion/etc. pass straight through.
 */
const WRAP_OWNED_METHODS = new Set([
  'initialize', 'initialized', 'notifications/initialized',
  'tools/list', 'tools/call', 'server/discover', 'subscriptions/listen', 'ping',
]);

/** Forwarded methods whose modern result is a CacheableResult (MUST carry ttlMs + cacheScope per
 *  spec). tools/list is NOT here - it's ToolFunnel-owned and decorated with its own hints. */
const CACHEABLE_FORWARD_METHODS = new Set([
  'resources/list', 'resources/read', 'resources/templates/list', 'prompts/list',
]);

/** Last-known wrapped identity per upstream id - survives upstream deaths and reconnect windows
 *  so the wrap NEVER answers a handshake as ToolFunnel (identity leak). Keyed by passthrough id;
 *  entries are tiny and bounded by the number of upstreams ever wrapped in-process. */
const lastWrappedIdentity = new Map();

/** CLIENT IDENTITY MIRRORING (wrap, stdio): the real downstream client's clientInfo, captured at
 *  its initialize handshake. While set, the wrapped upstream is (re)connected presenting THIS
 *  identity instead of ToolFunnel's - the outbound half of two-way wrap invisibility for
 *  legacy/stdio downstream clients (modern clients send no initialize; HTTP is multi-client -
 *  both keep the configured identity). */
let wrapMirrorClientInfo = null;
/** The passthrough id the mirror was captured under - a retarget clears the mirror (see the
 *  transition check in handleMessage). */
let wrapMirrorPtId = null;

/** The identity to PRESENT to `upstreamId` (Aggregator clientInfoProvider - read fresh at each
 *  connect). Chain: wrap target with a captured mirror -> the mirror; configured clientName ->
 *  the configured identity; else null (McpClient's built-in). NEVER throws. */
function clientInfoFor(upstreamId) {
  try {
    const pt = getPassthrough(loadToolStateResult(TOOL_STATE_PATH).state);
    if (pt && pt === upstreamId && wrapMirrorClientInfo) return wrapMirrorClientInfo;
  } catch (_e) { /* state unreadable -> fall through to the configured identity */ }
  if (SERVER_CONFIG.clientName) {
    return { name: SERVER_CONFIG.clientName, version: SERVER_CONFIG.clientVersion || '0.0.0' };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// BRIDGE B - legacy elicitation ↔ modern MRTR (the stateful adapter).
//
// A legacy upstream may send a SERVER-INITIATED `elicitation/create` mid-tool-call and hold the
// call open until it is answered. A modern client cannot receive backwards requests (stateless
// era): instead its tools/call RETURNS `resultType:"input_required"` with the question(s) and an
// opaque `requestState` token, and the client RETRIES the call with `inputResponses` + the token.
// ToolFunnel holds the suspended legacy call in the middle. Design + verified MRTR schema:
// toolfunnel_060_design.md §BRIDGE B (spec draft/basic/patterns/mrtr).
//
// Correlation (the id-translation discipline from day one): a legacy
// elicit carries NO originating-call marker, so it can only be bound to an in-flight wrapped call
// when EXACTLY ONE such call is in flight for that upstream (always true on stdio - the chain
// serialises; HTTP concurrency can produce >1, in which case the elicit is DECLINED rather than
// guessed - a wrong binding would hand one client's question to another client's call).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Suspended elicitations: requestState token -> the held call + how to answer the upstream.
 *  Tokens are unguessable (128-bit random); state never leaves this process, so the token needs
 *  no integrity protection - a tampered/unknown token is simply not in the map. */
const pendingElicits = new Map(); // token -> { upstreamId, elicitId, client, executePromise, calledName, createdAt, timer }
const ELICIT_TTL_MS = 5 * 60 * 1000; // an unanswered suspension is cancelled upstream + dropped

/** In-flight wrapped calls willing to receive an elicit, per upstream id. Each entry is a
 *  deliver() that hands the elicit to that call's race. Set size ≠ 1 -> no safe binding. */
const elicitWaiters = new Map(); // upstreamId -> Set<{ deliver: (elicit) => void }>

function registerElicitWaiter(upstreamId, waiter) {
  let set = elicitWaiters.get(upstreamId);
  if (!set) { set = new Set(); elicitWaiters.set(upstreamId, set); }
  set.add(waiter);
  return () => {
    set.delete(waiter);
    if (set.size === 0) elicitWaiters.delete(upstreamId);
  };
}

/**
 * The aggregator's onUpstreamServerRequest handler. Bridges `elicitation/create` from the WRAPPED
 * upstream to the one in-flight wrapped call; everything else (sampling/createMessage, roots/list
 * - future work) is answered -32601, and an unbindable elicit is DECLINED so the upstream's held
 * call resolves instead of hanging. NEVER throws.
 */
function handleUpstreamServerRequest(build, upstreamId, msg, client) {
  try {
    if (!msg || msg.id === undefined || msg.id === null) return;
    if (msg.method === 'ping') {
      // A server-initiated ping is a keepalive, not a capability - answer it (an error reply
      // could read as a FAILED ping and kill a session that used to survive).
      client.respondToServer(msg.id, {});
      return;
    }
    if (msg.method !== 'elicitation/create') {
      client.respondToServerError(msg.id, -32601, 'Method not found: ' + msg.method);
      return;
    }
    // Only the WRAPPED upstream's elicitations bridge (the funnel has no client to ask).
    let ptId = null;
    try {
      ptId = build && build.toolStatePath ? getPassthrough(loadToolStateResult(build.toolStatePath).state) : null;
    } catch (_e) { ptId = null; }
    // The binding invariant: "exactly one wrapped call in flight" must mean it in
    // GROUND TRUTH, not just one tools/call race waiter. A SUSPENDED call's upstream request is
    // still open (it may re-elicit), and a raw non-tool forward (resources/read, prompts/get -
    // both legal elicit triggers) holds an open upstream call with NO waiter. Any of those
    // in-flight -> the elicit's origin is ambiguous -> DECLINE rather than hand one caller's
    // question to another caller's call.
    let suspendedHere = false;
    for (const e of pendingElicits.values()) {
      if (e.upstreamId === upstreamId) { suspendedHere = true; break; }
    }
    const rawInFlight = (inflightRawForwards.get(upstreamId) || 0) > 0;
    const waiters = ptId === upstreamId ? elicitWaiters.get(upstreamId) : null;
    if (!waiters || waiters.size !== 1 || suspendedHere || rawInFlight) {
      // No call to bind to (or an ambiguous set) - decline, so the upstream's held call completes.
      client.respondToServer(msg.id, { action: 'decline' });
      logErr('bridge-b: declined elicitation from "' + upstreamId + '" (' +
        (ptId !== upstreamId ? 'not the wrapped upstream'
          : suspendedHere ? 'a suspension is already pending'
          : rawInFlight ? 'a non-tool forward is in flight (ambiguous origin)'
          : (waiters ? 'ambiguous concurrent calls' : 'no in-flight wrapped call')) + ')');
      return;
    }
    const waiter = waiters.values().next().value;
    waiter.deliver({ elicitId: msg.id, params: msg.params || {}, client });
  } catch (_e) {
    try { client.respondToServerError(msg.id, -32603, 'request failed'); } catch (_e2) { /* ignore */ }
  }
}

/**
 * Race a held upstream promise against an incoming elicitation for that upstream. Registers a
 * single-use waiter (a SECOND elicit during the same round is auto-declined - one question per
 * round is what MRTR's retry loop models); always unregisters. Returns { kind:'result'|'elicit',
 * value }. Rejects if the upstream promise rejects first.
 */
async function raceElicit(upstreamId, promise) {
  let resolveElicit;
  const elicitP = new Promise((res) => { resolveElicit = res; });
  let delivered = false;
  const unregister = registerElicitWaiter(upstreamId, {
    deliver: (e) => {
      if (delivered) {
        try { e.client.respondToServer(e.elicitId, { action: 'decline' }); } catch (_e) { /* ignore */ }
        return;
      }
      delivered = true;
      resolveElicit(e);
    },
  });
  try {
    return await Promise.race([
      promise.then((v) => ({ kind: 'result', value: v })),
      elicitP.then((e) => ({ kind: 'elicit', value: e })),
    ]);
  } finally {
    unregister();
  }
}

/** Resume a suspended elicitation (the MRTR retry): answer the upstream's held question with the
 *  client's inputResponse, then await the held call - which may elicit AGAIN (multi-round) or
 *  finish. Token misses get a clean, neutral error. NEVER throws. */
async function resumeElicit(params, modernCaller, currentPtId, cancelKey) {
  const p = params || {};
  const token = typeof p.requestState === 'string' ? p.requestState : null;
  const entry = token && modernCaller === true ? pendingElicits.get(token) : null;
  if (!entry) {
    // Unknown/expired/foreign token - or a legacy caller, which cannot do MRTR at all.
    return { content: [{ type: 'text', text: 'unknown or expired requestState' }], isError: true };
  }
  pendingElicits.delete(token);
  try { clearTimeout(entry.timer); } catch (_e) { /* ignore */ }
  // The wrap may have been RETARGETED mid-suspension (A->B). Serving A's result under B's
  // identity is a mixed-identity response - refuse, and cancel A's held question so its call
  // resolves.
  if (currentPtId !== entry.upstreamId) {
    try { entry.client.respondToServer(entry.elicitId, { action: 'cancel' }); } catch (_e) { /* ignore */ }
    return { content: [{ type: 'text', text: 'unknown or expired requestState' }], isError: true };
  }
  // The resume may block for the held call's remaining work: re-extend its timeout (a resume at
  // TTL-minus-seconds must not lose the result to the original clock) and make
  // the RETRY id cancellable against the held upstream call.
  if (entry.rpcId !== null && typeof entry.client.extendRequestTimeout === 'function') {
    entry.client.extendRequestTimeout(entry.rpcId, ELICIT_TTL_MS + 30000);
  }
  if (cancelKey && entry.rpcId !== null) inflightForwards.set(cancelKey, entry.rpcId);
  // One question per round (r0) -> one response. The client's InputResponse passes VERBATIM as
  // the upstream's ElicitResult ({ action, content? }); a malformed response declines - never
  // invent an "accept" the user did not give.
  const responses = p.inputResponses && typeof p.inputResponses === 'object' && !Array.isArray(p.inputResponses)
    ? p.inputResponses : {};
  const keys = Object.keys(responses);
  const r = keys.length ? responses[keys[0]] : null;
  const elicitResult = (r && typeof r === 'object' && typeof r.action === 'string') ? r : { action: 'decline' };
  try { entry.client.respondToServer(entry.elicitId, elicitResult); } catch (_e) { /* ignore */ }
  let winner;
  try {
    winner = await raceElicit(entry.upstreamId, entry.executePromise);
  } catch (_err) {
    return { content: [{ type: 'text', text: `tool "${entry.calledName}" failed` }], isError: true };
  } finally {
    if (cancelKey) inflightForwards.delete(cancelKey); // settled (or re-suspended) - retry cancel window over
  }
  if (winner.kind === 'elicit') {
    return suspendForElicit(winner.value, entry.executePromise, entry.upstreamId, entry.calledName, entry.rpcId);
  }
  const out = winner.value;
  if (out && typeof out === 'object' && Array.isArray(out.content)) return out; // verbatim envelope
  return { content: [{ type: 'text', text: `tool "${entry.calledName}" failed` }], isError: true };
}

/** Suspend a wrapped call that hit an elicitation: mint the token, hold the still-running
 *  execute promise, extend the held request's timeout to the suspension window (a human answers
 *  at human speed), arm the TTL, and shape the modern InputRequiredResult. */
function suspendForElicit(elicit, executePromise, upstreamId, calledName, rpcId) {
  const token = require('node:crypto').randomBytes(16).toString('base64url');
  executePromise.catch(() => { /* held in the background - its rejection surfaces on resume */ });
  if (rpcId !== null && rpcId !== undefined && typeof elicit.client.extendRequestTimeout === 'function') {
    // +grace beyond the TTL: the TTL path CANCELS the question upstream, and the upstream still
    // needs time to complete/fail its held call before the waiter finally dies.
    elicit.client.extendRequestTimeout(rpcId, ELICIT_TTL_MS + 30000);
  }
  const entry = {
    upstreamId,
    elicitId: elicit.elicitId,
    client: elicit.client,
    executePromise,
    calledName,
    rpcId: rpcId === undefined ? null : rpcId,
    createdAt: Date.now(),
    timer: setTimeout(() => {
      // Unclaimed suspension: cancel the upstream's question so its held call resolves, drop the
      // token. A later retry with this token gets the clean unknown-token error.
      pendingElicits.delete(token);
      try { elicit.client.respondToServer(elicit.elicitId, { action: 'cancel' }); } catch (_e) { /* ignore */ }
      logErr('bridge-b: elicitation "' + token.slice(0, 8) + '..." expired unanswered (' + calledName + ')');
    }, ELICIT_TTL_MS),
  };
  if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
  pendingElicits.set(token, entry);
  // The MRTR result: the upstream's question under a minted key + the resume token. One
  // translation applies: MRTR's ElicitRequest params REQUIRE `mode:"form"`, which pre-MRTR
  // legacy upstreams never send - default-inject it when absent (the caller's own
  // mode, if any, wins). Everything else passes verbatim.
  const params = Object.assign({ mode: 'form' }, elicit.params);
  return {
    resultType: 'input_required',
    inputRequests: { r0: { method: 'elicitation/create', params } },
    requestState: token,
  };
}

/**
 * armWrapChatter - sync the aggregator's wrapChatterUpstream from the on-disk wrap state.
 * handleMessage re-arms per message, but three paths bypass it: startup (notifications before the
 * first client message), a reloadExpose swap, and a listen-first modern client (the listen branch
 * is transport-owned). Each of those calls this so the N3 cross-upstream filter is never unarmed.
 * NEVER throws.
 */
function armWrapChatter(build) {
  try {
    if (!build || !build.aggregator) return;
    const statePath = build.toolStatePath;
    // Route through the aggregator's setter - a passthrough TARGET CHANGE clears the recorded
    // resource subscriptions (they belong to the old wrap context).
    const arm = (v) => (typeof build.aggregator.setWrapChatterUpstream === 'function'
      ? build.aggregator.setWrapChatterUpstream(v)
      : (build.aggregator.wrapChatterUpstream = v));
    if (!statePath) { arm(null); return; }
    arm(getPassthrough(loadToolStateResult(statePath).state));
    // F2 companion: hot-promoted upstream tools put their upstream on the top-level surface with
    // no expose[] entry - give the aggregator a live predicate so death/recovery of such an
    // upstream still fires list_changed. Reads the state file fresh (a UI toggle is live), keyed
    // by the standard `<upstream>_<tool>` surfaced shape; the reserved wrap key is a string, not
    // a tool entry, so it never matches.
    build.aggregator.topLevelUpstreamExtra = (upstreamId) => {
      try {
        const st = loadToolStateResult(statePath).state || {};
        const prefix = String(upstreamId) + '_';
        return Object.keys(st).some((k) =>
          k !== 'passthrough' && k.startsWith(prefix) && st[k] && st[k].hot === true);
      } catch (_e) { return false; }
    };
  } catch (_e) { /* never let arming break the caller */ }
}

/** In-flight forwarded requests under a wrap: CLIENT JSON-RPC id -> the McpClient rpc id the
 *  forward was re-issued under. The two id spaces are disjoint, so a client's
 *  notifications/cancelled must be TRANSLATED before relay - relaying its requestId verbatim
 * would cancel the wrong upstream call. Entries live only for the duration
 *  of the forward (deleted in the finally). Gated tools/call is NOT tracked here - full
 *  id-translation for the tool path arrives with Bridge B's correlation machinery. */
const inflightForwards = new Map();

/** In-flight RAW (non-tool) forwards per upstream id - part of Bridge B's binding invariant: a
 *  resources/read or prompts/get holds an open upstream call that may legally elicit, so while
 * one is in flight an elicit's origin is ambiguous and must be declined. */
const inflightRawForwards = new Map();

/**
 * forwardWrapped - relay a non-tool method to the wrapped upstream and shape the reply for the
 * caller's era. Strips the modern per-request `_meta` before forwarding (the legacy upstream never
 * saw modern params); a modern caller's result is decorated (resultType + the WRAPPED server's
 * serverInfo in `_meta`, never ToolFunnel's - the wrap must stay invisible). A notification (no id)
 * is dropped (we do not relay unknown client notifications). NEVER throws.
 */
async function forwardWrapped(aggregator, ptId, msg, hasId, id, wrapId, connKey) {
  if (!hasId) {
    // A client NOTIFICATION under a wrap (notifications/cancelled, notifications/progress ...)
    // must still reach the upstream - a directly-connected server would receive it, and eating
    // notifications/cancelled leaves the upstream running a call the client abandoned.
    // Fire-and-forget; notifications are never answered.
    if (typeof msg.method === 'string' && msg.method.startsWith('notifications/') &&
        aggregator && typeof aggregator.notifyRaw === 'function') {
      if (msg.method === 'notifications/cancelled') {
        // params.requestId lives in the CLIENT's id space; the forward ran under the McpClient's
        // own id. TRANSLATE via the in-flight map - an untranslatable cancel is DROPPED, because
        // relaying it verbatim could cancel a DIFFERENT in-flight call. The
        // map is scoped by connKey: without a connection identity (HTTP - sessionless modern era,
        // every POST is a stranger) translation is impossible and the cancel is dropped whole.
        if (connKey !== undefined && msg.params && msg.params.requestId !== undefined) {
          const rpcId = inflightForwards.get(`${connKey}:${msg.params.requestId}`);
          if (rpcId !== undefined) {
            aggregator.notifyRaw(ptId, msg.method, Object.assign({}, msg.params, { requestId: rpcId }));
          }
        }
        return null;
      }
      aggregator.notifyRaw(ptId, msg.method, msg.params);
    }
    return null;
  }
  if (!aggregator || typeof aggregator.forwardRaw !== 'function') {
    // Neutral text - naming the wrap or the upstream id here would announce the funnel.
    return makeError(id, ERR.INTERNAL, 'request failed');
  }
  let params = msg.params;
  if (params && typeof params === 'object' && !Array.isArray(params) &&
      params._meta && typeof params._meta === 'object' && !Array.isArray(params._meta)) {
    // Strip ONLY the modern protocol keys from _meta. The rest - progressToken, trace keys, app
    // keys - is legitimate in BOTH eras and a direct connection would deliver it verbatim.
    // (McpClient.request() re-injects the trio, merged, when the upstream itself is modern.)
    const meta = Object.assign({}, params._meta);
    let changed = false;
    for (const k of Object.keys(meta)) {
      if (k.startsWith('io.modelcontextprotocol/')) { delete meta[k]; changed = true; }
    }
    if (changed) {
      params = Object.assign({}, params);
      if (Object.keys(meta).length) params._meta = meta; else delete params._meta;
    }
  }
  let raw;
  // Track the forward's upstream rpc id LIVE (the setter fires synchronously at issue time inside
  // McpClient._request) so a concurrent notifications/cancelled can be translated (N1). Keyed by
  // (connection, client id) - raw client ids collide across connections (focused review).
  const mapKey = connKey !== undefined ? `${connKey}:${id}` : null;
  const track = mapKey === null ? undefined : { set rpcId(v) { inflightForwards.set(mapKey, v); } };
  inflightRawForwards.set(ptId, (inflightRawForwards.get(ptId) || 0) + 1); // Bridge B binding invariant
  try {
    raw = await aggregator.forwardRaw(ptId, msg.method, params, track);
  } catch (err) {
    // Relay the upstream's OWN error verbatim - code, message, data. Re-wrapping loses fidelity
    // AND announces the wrap (the old text carried `wrapped upstream "<id>"`; one probe of any
    // unimplemented method exposed the funnel). Only a pure transport failure (no rpcError on
    // the rejection) gets a synthetic error - neutral: no wrap, no id, no McpClient prefix.
    if (err && err.rpcError && typeof err.rpcError === 'object') {
      return makeError(id, err.rpcError.code, err.rpcError.message, err.rpcError.data);
    }
    return makeError(id, ERR.INTERNAL, 'request failed');
  } finally {
    if (mapKey !== null) inflightForwards.delete(mapKey); // settled - cancels can no longer target it
    const n = (inflightRawForwards.get(ptId) || 1) - 1;
    if (n <= 0) inflightRawForwards.delete(ptId); else inflightRawForwards.set(ptId, n);
  }
  // A legacy client's DIRECT resources/subscribe rides this forward - record it for replay. The
  // wrap hides upstream deaths behind silent background reconnects, so it inherits the duty of
  // re-arming the subscription on the fresh process: a direct
  // connection's client would have SEEN the death and re-subscribed itself.
  if (aggregator && aggregator._subscribedUris instanceof Set &&
      params && typeof params.uri === 'string') {
    if (msg.method === 'resources/subscribe') aggregator._subscribedUris.add(params.uri);
    else if (msg.method === 'resources/unsubscribe') aggregator._subscribedUris.delete(params.uri);
  }
  // A modern caller needs a modern-shaped result (resultType + serverInfo). Present the WRAPPED
  // server's serverInfo so the decoration is not a ToolFunnel tell. The CacheableResult surfaces
  // (resources/list|read, resources/templates/list, prompts/list) MUST carry ttlMs + cacheScope
  // per spec - the legacy upstream can't supply them, so we add a conservative default
  if (modern.isModernRequest(msg)) {
    const si = (wrapId && wrapId.serverInfo) || SERVER_INFO;
    const cacheHints = CACHEABLE_FORWARD_METHODS.has(msg.method) ? modern.CACHE_HINTS.toolsList : undefined;
    return makeResult(id, modern.decorateResult(raw, si, cacheHints));
  }
  return makeResult(id, raw); // legacy caller - verbatim upstream result
}

/**
 * handleModernMessage - dispatch ONE request under 2026-07-28 semantics. The tool surface and
 * the gate are the SAME handlers the legacy path uses (handleToolsList / handleToolsCall) - the
 * modern era only changes the envelope: validated per-request _meta in, `resultType` +
 * `_meta[serverInfo]` (+ ttlMs/cacheScope on the CacheableResult surfaces) out. Methods the
 * modern revision removed (ping, logging/setLevel, the initialized notification) fall through
 * to method-not-found / ignored, per spec. NEVER throws (the caller's try/catch backstops it).
 */
async function handleModernMessage(build, msg, hasId, id, method, wrapId, connKey) {
  const { protocol, aggregator, engine, ctx, registry, toolStatePath } = build;

  const vErr = modern.validateModernRequest(msg);
  if (vErr) return hasId ? makeError(id, vErr.code, vErr.message, vErr.data) : null;

  // Under a wrap, the serverInfo in every decorated result must be the WRAPPED server's, not
  // ToolFunnel's (the wrap is invisible). Also latch whether a wrap is active, to suppress the
  // legacyShim _meta tell (it would reveal the wrapping - the invisibility requirement).
  const wrapped = !!wrapId;
  const resultServerInfo = (wrapId && wrapId.serverInfo) || SERVER_INFO;

  switch (method) {
    case 'tools/list':
      // A notification (no id) MUST NOT get a reply (JSON-RPC 2.0). Every case guards on hasId.
      if (!hasId) return null;
      return makeResult(
        id,
        modern.decorateResult(
          handleToolsList(protocol, aggregator, { registry, toolStatePath }),
          resultServerInfo,
          modern.CACHE_HINTS.toolsList
        )
      );

    case 'tools/call': {
      const result = await handleToolsCall(
        protocol, aggregator,
        // cancelKey: same cancel-translation contract as the legacy path.
        // modernCaller: a modern client can receive input_required + retry (Bridge B / MRTR).
        { engine, ctx, registry, toolStatePath, modernCaller: true,
          cancelKey: (connKey !== undefined && hasId) ? `${connKey}:${id}` : null },
        msg.params
      );
      // Same observability chokepoint as the legacy path - both eras count in one place.
      metrics.record({ tool: (msg.params && msg.params.name) || 'unknown', ok: !(result && result.isError === true) });
      if (!hasId) return null; // notification-shaped call: executed (side effects), but never replied to
      const decorated = modern.decorateResult(result, resultServerInfo);
      // Legacy-shim transparency for MODERN clients: when the call ACTUALLY forwarded to a PINNED
      // legacy upstream, say so in result _meta - metadata, never content. NOT under a wrap: a wrap
      // must be invisible, and this tag would reveal the wrapping (the invisibility requirement). Gated on
      // !isError so a PreToolUse deny / unknown-tool error is not falsely tagged as "forwarded".
      if (!wrapped && aggregator && typeof aggregator.legacyShimInfo === 'function' && result && result.isError !== true) {
        try {
          const shim = aggregator.legacyShimInfo(msg.params && msg.params.name);
          if (shim) decorated._meta['io.toolfunnel/legacyShim'] = shim;
        } catch (_e) { /* decoration only - never affects the result */ }
      }
      return makeResult(id, decorated);
    }

    case 'subscriptions/listen':
      // Transport-owned: the ack + the notification stream need the transport's writer, and the
      // final result is only sent at close. Both transports intercept BEFORE handleMessage;
      // reaching here means a wiring gap - answer honestly rather than hang the client.
      return hasId
        ? makeError(id, ERR.INTERNAL, 'subscriptions/listen must be handled by the transport')
        : null;

    default:
      // ping / logging/setLevel / resources / prompts are removed-or-absent in the modern era of
      // this tools-only server: unknown request -> method-not-found; unknown notification -> ignored.
      return hasId ? makeError(id, ERR.METHOD_NOT_FOUND, `Method not found: ${method}`) : null;
  }
}

/**
 * emitToolsListChanged(send) - write the MCP `notifications/tools/list_changed` JSON-RPC
 * notification (NO id - it is a notification, not a request) via the provided `send` fn. The
 * server emits this when the curated-direct expose set hot-updates so a CLI that honours
 * listChanged re-fetches tools/list (see the architecture notes §1 "no restart for register
 * changes"; §7 the host runs the server). `send` is injected so this is unit-testable with a spy
 * and reused by both the stdio loop and (later) the host.
 *
 * @param {(obj: object) => void} send  the transport's writer (stdio loop's send, or a spy)
 * @returns {void}
 */
function emitToolsListChanged(send) {
  if (typeof send !== 'function') return; // never throw - a missing transport is a no-op
  send({ jsonrpc: JSONRPC, method: 'notifications/tools/list_changed' });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// HOT-RELOAD - pick up on-disk config changes with NO restart, NO user intervention.
//
// The tf_* management tools (and the UI) write expose.json / the hooks files from a SEPARATE
// process, so the running gateway's in-memory aggregator + hook engine never saw the change - that
// was the root cause of "you have to restart to attach an MCP / change a hook". These reloaders
// re-read the on-disk config and SWAP build.aggregator / build.engine IN PLACE. handleMessage reads
// the build object fresh on every message, so the next tools/list or tools/call uses the new state.
// startConfigWatchers wires them to fs.watch so the gateway heals/updates itself automatically.
// Everything here is contracted NEVER to throw - a bad reload keeps the last-good state.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Re-read expose.json, rebuild + reconnect the aggregator, swap it into `build`, then emit
 * notifications/tools/list_changed so a listChanged-honouring client (Claude Code does) refreshes
 * its curated-direct surface. The new aggregator is connected BEFORE the old one is closed so there
 * is never a window with no upstreams. NEVER throws.
 *
 * @param {{aggregator?:object}} build  the live build object (mutated in place)
 * @param {(obj:object)=>void} send     the stdio writer, for the list_changed notification
 * @returns {Promise<void>}
 */
async function reloadExpose(build, send) {
  // NEVER-throws contract. A null/absent build means the caller (e.g. the HTTP host mid-teardown,
  // which nulls its build) has moved on - do nothing rather than deref null. (reloadHooks/
  // reloadRegister already guard this; expose was the one unguarded reloader - a proven crash.)
  if (!build || typeof build !== 'object') return;
  let store;
  try {
    store = loadExposeStore(EXPOSE_PATH);
  } catch (err) {
    logErr('reloadExpose: cannot read expose.json (keeping current upstreams):', (err && err.message) || String(err));
    return;
  }
  const next = new Aggregator({
    store, v3Root: ROOT,
    wrapTargetProvider: () => {
      try { return getPassthrough(loadToolStateResult(TOOL_STATE_PATH).state); } catch (_e) { return null; }
    },
    // Outbound identity per upstream: captured wrap mirror > configured clientName > built-in.
    clientInfoProvider: clientInfoFor,
  });
  next.onToolsChanged = () => emitToolsListChanged(send); // re-wire the background-reconnect -> list_changed signal
  // Identity-continuity invalidation: the lastWrappedIdentity cache exists to bridge
  // RECONNECT windows of the SAME server - but if this reload REPLACED an upstream entry (same id,
  // different command/args/env) or removed it, serving the previous server's identity during the
  // new one's connect window presents the WRONG server. Drop cache entries whose upstream config
  // changed; a pure reconnect (config untouched) keeps its bridge.
  try {
    const prevStore = build.aggregator && build.aggregator._store;
    for (const cachedId of Array.from(lastWrappedIdentity.keys())) {
      const before = prevStore && typeof prevStore.getUpstream === 'function' ? prevStore.getUpstream(cachedId) : null;
      const after = store && typeof store.getUpstream === 'function' ? store.getUpstream(cachedId) : null;
      const shape = (u) => u ? JSON.stringify({ c: u.command, a: u.args, e: u.env }) : null;
      if (!after || shape(before) !== shape(after)) lastWrappedIdentity.delete(cachedId);
    }
  } catch (_e) { /* invalidation is best-effort; a stale entry self-heals on connect */ }
  // Carry the notification bridge to the new instance - the hook closes over the TRANSPORT
  // (loop.notify / pushToListeners), not the aggregator, so the function transfers verbatim.
  // Without this every expose.json hot-reload (including a live tf_mcp_add) silently killed
  // Bridge A.
  const prevAgg = build.aggregator;
  if (prevAgg && typeof prevAgg.onUpstreamNotification === 'function') {
    next.onUpstreamNotification = prevAgg.onUpstreamNotification;
  }
  // Bridge B carryover - same contract as the notification bridge above: the handler closes over
  // the stable build object, so it transfers verbatim onto the swapped-in aggregator.
  if (prevAgg && typeof prevAgg.onUpstreamServerRequest === 'function') {
    next.onUpstreamServerRequest = prevAgg.onUpstreamServerRequest;
  }
  // Arm the wrap scope on the NEW aggregator BEFORE connectAll - _connectOne's subscription
  // replay checks wrapChatterUpstream, and an unarmed (null) scope replayed the URIs onto EVERY
  // subscribe-capable upstream during the reload window. Must precede the
  // carryover below: arming through the setter clears the set on a target change.
  armWrapChatter({ aggregator: next, toolStatePath: build.toolStatePath });
  // Carry the agreed resource-subscription set BEFORE connectAll, so the new aggregator's
  // _connectOne replays them onto the fresh upstream processes (a hot reload used
  // to silently kill every agreed subscription channel).
  if (prevAgg && prevAgg._subscribedUris instanceof Set && prevAgg._subscribedUris.size) {
    next._subscribedUris = new Set(prevAgg._subscribedUris);
  }
  let res = null;
  try {
    res = await next.connectAll();
    if (res && Array.isArray(res.failed) && res.failed.length > 0) {
      logErr('reloadExpose: ' + res.failed.length + ' upstream(s) failed:',
        res.failed.map((f) => `${f.id}(${f.error})`).join('; '));
    }
  } catch (err) {
    logErr('reloadExpose: connectAll threw (ignored):', (err && err.message) || String(err));
  }
  // The swap/close/notify is guarded too: even a surprise (a build torn down DURING the async
  // connectAll above) must be a caught no-op, not an escaped rejection that crashes the host.
  try {
    const prev = build.aggregator;
    build.aggregator = next; // swap BEFORE closing the old one (handleMessage reads build fresh)
    armWrapChatter(build); // the fresh aggregator's N3 filter must not wait for a client message
    if (prev && typeof prev.closeAll === 'function') {
      try { await prev.closeAll(); } catch (_e) { /* closeAll never throws, but guard teardown */ }
    }
    emitToolsListChanged(send);
  } catch (err) {
    logErr('reloadExpose: swap failed (keeping last-good):', (err && err.message) || String(err));
    try { await next.closeAll(); } catch (_e) { /* orphan-avoidance; never throw */ }
    return;
  }
  // Activity log (self-gating): mark the reload trigger; the per-upstream connect/disconnect lines
  // (from the aggregator) carry the detail. Together they record the reconnect.
  logger.log({
    type: 'mcp',
    event: 'reload',
    connected: res && Array.isArray(res.connected) ? res.connected : [],
    failed: res && Array.isArray(res.failed) ? res.failed.map((f) => f.id) : [],
  });
  logErr('reloadExpose: expose.json reloaded - upstreams reconnected');
}

/**
 * Re-read tools.register.json and swap the ONE live Registry's index IN PLACE (Registry.reload -
 * last-good on any failure). In-place mutation is the point: the Registry instance is CAPTURED by
 * the protocol adapter at build time, so swapping internals means every reader - the lean
 * meta-tools, run_tool resolution, and the top-level hot surface - sees the new entries on its
 * next call with no rewiring. Emits list_changed: a hot-promoted local tool's definition may have
 * appeared, changed, or gone. NEVER throws.
 *
 * @param {{registry?:object}} build
 * @param {(obj:object)=>void} send  the stdio writer, for the list_changed notification
 * @returns {void}
 */
function reloadRegister(build, send) {
  try {
    if (build && build.registry && typeof build.registry.reload === 'function' && build.registry.reload()) {
      emitToolsListChanged(send);
      logErr('reloadRegister: tools.register.json reloaded');
    } else {
      logErr('reloadRegister: reload failed (bad JSON / invalid entry / mid-write?) - keeping the last-good register');
    }
  } catch (err) {
    logErr('reloadRegister: unexpected failure (keeping current register):', (err && err.message) || String(err));
  }
}

/**
 * Re-read the hooks manifest + state overlay and swap a fresh HookEngine into `build`. The next
 * gated call (toolfunnel_run_tool / curated-direct) uses the new engine, so an added/changed/toggled
 * hook takes effect with no restart. NEVER throws (a bad manifest keeps the current engine).
 *
 * @param {{engine?:object}} build
 * @returns {void}
 */
function reloadHooks(build) {
  try {
    const loader = loadManifest(MANIFEST_PATH);
    build.engine = new HookEngine(loader, { cwd: ROOT });
    logErr('reloadHooks: hooks manifest/state reloaded');
  } catch (err) {
    logErr('reloadHooks: cannot reload hooks (keeping current engine):', (err && err.message) || String(err));
  }
}

/**
 * Watch the config and hot-reload on change. TWO mechanisms, belt-and-braces:
 *   1. fs.watch on the DIRECTORIES - fast, event-driven, filtered by basename.
 *   2. fs.watchFile POLLING on each specific config file - the reliable fallback.
 * The directory watch alone is NOT enough: fs.watch is event-based and on Windows frequently
 * MISSES the atomic temp+rename writes the stores use (the target's inode is replaced without a
 * usable change event on the directory), so a `tf_hook_set` / UI toggle could fail to hot-reload
 * until restart. fs.watchFile polls each file's stat, so it catches every create/modify (including
 * atomic rename) on every platform. Both paths feed the SAME debounced schedulers, so a change
 * that trips both still collapses to one reload. Debounced (a temp+rename burst -> one reload),
 * with a re-entrancy guard so a mid-flight expose reload can't overlap itself. A watch failure (an
 * fs that supports neither) is logged and ignored - the server still runs, just without
 * auto-reload. NEVER throws.
 *
 * @param {object} build  the live build object (mutated by the reloaders)
 * @param {(obj:object)=>void} send  the stdio writer
 * @returns {void}
 */
function startConfigWatchers(buildArg, send) {
  // buildArg may be the build OBJECT (stdio: one stable object, mutated in place) OR a GETTER
  // () => build. The HTTP host REBUILDS its build (reload()/stop() reassign it), so it passes a
  // getter - the reloaders then always target the LIVE build and a rebuild can never desync the
  // watchers. Backward-compatible: a plain object is wrapped in a getter, so stdio is unchanged.
  const getBuild = typeof buildArg === 'function' ? buildArg : () => buildArg;
  const DEBOUNCE_MS = 150;
  const mcpDir = path.dirname(EXPOSE_PATH);
  const hooksDir = path.dirname(MANIFEST_PATH);
  const openWatchers = []; // fs.watch handles, closed by the returned stop()
  const polledFiles = [];  // fs.watchFile paths, unwatched by the returned stop()

  let exposeTimer = null;
  let reloadingExpose = false;
  function scheduleExpose() {
    if (exposeTimer) clearTimeout(exposeTimer);
    exposeTimer = setTimeout(async () => {
      exposeTimer = null;
      if (reloadingExpose) { scheduleExpose(); return; } // a reload is mid-flight; re-arm
      reloadingExpose = true;
      // reloadExpose is contracted never to throw, but a debounced setTimeout callback has no
      // caller to catch an escaped rejection - so guard here too (an unhandled rejection would
      // crash the host on default Node). Belt and braces.
      try { await reloadExpose(getBuild(), send); }
      catch (e) { logErr('scheduleExpose: reload rejected (should not):', (e && e.message) || String(e)); }
      finally { reloadingExpose = false; }
    }, DEBOUNCE_MS);
    if (exposeTimer && typeof exposeTimer.unref === 'function') exposeTimer.unref(); // don't pin the loop
  }

  let hooksTimer = null;
  function scheduleHooks() {
    if (hooksTimer) clearTimeout(hooksTimer);
    hooksTimer = setTimeout(() => { hooksTimer = null; reloadHooks(getBuild()); }, DEBOUNCE_MS);
    if (hooksTimer && typeof hooksTimer.unref === 'function') hooksTimer.unref();
  }

  let registerTimer = null;
  function scheduleRegister() {
    if (registerTimer) clearTimeout(registerTimer);
    registerTimer = setTimeout(() => { registerTimer = null; reloadRegister(getBuild(), send); }, DEBOUNCE_MS);
    if (registerTimer && typeof registerTimer.unref === 'function') registerTimer.unref();
  }

  // tools.state.json needs NO reload (it is read fresh per tools/list & tools/call) - but a
  // hot/hidden/enabled toggle CHANGES the top-level surface, so a connected client must be told
  // to re-fetch. Notification only.
  let stateTimer = null;
  function scheduleStateNotify() {
    if (stateTimer) clearTimeout(stateTimer);
    stateTimer = setTimeout(() => {
      stateTimer = null;
      // A LIVE wrap-set may target an upstream this process refused at boot (path-isolation -
      // the wrap exemption is read per CONNECT, not retroactively). Kick a background connect
      // for the wrap target if it isn't connected; fire-and-forget, NEVER throws (the
      // transparent-wrapper ruling).
      try {
        const b = getBuild();
        const agg = b && b.aggregator;
        const ptId = b && b.toolStatePath
          ? getPassthrough(loadToolStateResult(b.toolStatePath).state) : null;
        if (agg && ptId && typeof agg.ensureConnected === 'function') {
          Promise.resolve(agg.ensureConnected(ptId)).catch(() => { /* background; reconnect owns retries */ });
        }
      } catch (_e) { /* a state-notify must never die on the kick */ }
      emitToolsListChanged(send);
    }, DEBOUNCE_MS);
    if (stateTimer && typeof stateTimer.unref === 'function') stateTimer.unref();
  }

  try {
    const w = fs.watch(mcpDir, (_event, filename) => {
      // null filename (some platforms don't report it) -> reload to be safe; else only expose.json.
      if (!filename || path.basename(String(filename)) === 'expose.json') scheduleExpose();
    });
    // unref so an FSWatcher never keeps the process alive after the client closes stdin - the
    // gateway must still exit naturally when its transport closes (it did before this feature).
    if (w && typeof w.unref === 'function') w.unref();
    openWatchers.push(w);
    logErr('startConfigWatchers: watching', mcpDir, 'for expose.json changes');
  } catch (err) {
    logErr('startConfigWatchers: cannot watch', mcpDir + ':', (err && err.message) || String(err));
  }

  try {
    const w = fs.watch(hooksDir, (_event, filename) => {
      const base = filename ? path.basename(String(filename)) : '';
      if (!filename || base === 'hooks.manifest.json' || base === 'hooks.state.json') scheduleHooks();
    });
    if (w && typeof w.unref === 'function') w.unref();
    openWatchers.push(w);
    logErr('startConfigWatchers: watching', hooksDir, 'for hook changes');
  } catch (err) {
    logErr('startConfigWatchers: cannot watch', hooksDir + ':', (err && err.message) || String(err));
  }

  // The register + state overlay live in tools/. Register edits (tf_tool_add from its child
  // process, the UI, a hand edit) were the ONE config surface with no watcher - a running gateway
  // served its startup snapshot until restart, which broke the "add a tool live" story the moment
  // the server outlived the edit. State toggles only need the list_changed nudge (read-fresh).
  const toolsDir = path.dirname(REGISTER_PATH);
  try {
    const w = fs.watch(toolsDir, (_event, filename) => {
      const base = filename ? path.basename(String(filename)) : '';
      if (!filename || base === 'tools.register.json') scheduleRegister();
      if (!filename || base === 'tools.state.json') scheduleStateNotify();
    });
    if (w && typeof w.unref === 'function') w.unref();
    openWatchers.push(w);
    logErr('startConfigWatchers: watching', toolsDir, 'for register/state changes');
  } catch (err) {
    logErr('startConfigWatchers: cannot watch', toolsDir + ':', (err && err.message) || String(err));
  }

  // ── Reliable fallback: fs.watchFile POLLS each config file's stat, so it catches every
  // create/modify - including the atomic temp+rename writes that fs.watch misses on Windows.
  // A 1s interval is ample for config (no sub-second reload need); the schedulers debounce, so a
  // change caught by BOTH the directory watch and the file poll still yields a single reload.
  // The state overlays (hooks.state.json / tools.state.json) may not exist yet - watchFile fires
  // when they first appear (a tf_hook_set / tf_tool_set toggle CREATES them), which is the case
  // the directory watch was dropping.
  const pollWatch = (file, schedule) => {
    try {
      // Retain the listener ref so stop() can unwatchFile(file, listener) - a bare
      // unwatchFile(file) would remove ALL listeners on that path, clobbering a second host/watcher
      // set in the same process (parallel tests, an embedder running two hosts).
      const listener = (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) schedule();
      };
      const sw = fs.watchFile(file, { interval: 1000 }, listener);
      if (sw && typeof sw.unref === 'function') sw.unref(); // never pin the event loop
      polledFiles.push({ file, listener });
    } catch (err) {
      logErr('startConfigWatchers: cannot poll-watch', file + ':', (err && err.message) || String(err));
    }
  };
  pollWatch(EXPOSE_PATH, scheduleExpose);
  pollWatch(MANIFEST_PATH, scheduleHooks);
  pollWatch(path.join(hooksDir, 'hooks.state.json'), scheduleHooks);
  pollWatch(REGISTER_PATH, scheduleRegister);
  pollWatch(path.join(toolsDir, 'tools.state.json'), scheduleStateNotify);
  logErr('startConfigWatchers: fs.watchFile polling fallback armed (Windows-safe)');

  // Teardown handle. The stdio path never calls it (the process dies when stdin closes and the
  // watchers are all unref'd); the HTTP host calls it in stop() so a started->stopped host leaves
  // no dangling directory watchers or file pollers.
  return function stopConfigWatchers() {
    // Clear any PENDING debounced reload so a change caught just before teardown can't fire a
    // reload against a torn-down build after the caller has moved on. (It would be a caught no-op,
    // but a truly-stopped watcher must not schedule work.)
    for (const t of [exposeTimer, hooksTimer, registerTimer, stateTimer]) {
      if (t) { try { clearTimeout(t); } catch (_e) { /* ignore */ } }
    }
    for (const w of openWatchers) {
      try { if (w && typeof w.close === 'function') w.close(); } catch (_e) { /* ignore */ }
    }
    for (const p of polledFiles) {
      try { fs.unwatchFile(p.file, p.listener); } catch (_e) { /* ignore */ }
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// stdin framing reader - accepts BOTH Content-Length framing and newline-delimited JSON.
// We write newline-delimited JSON on stdout.
//
// `build` is the Phase-2 build object { protocol, aggregator, engine, ctx } (a bare protocol is
// accepted too - see normaliseBuild). It is threaded straight into handleMessage so tools/list
// advertises the curated-direct surface and tools/call gates curated-direct calls.
// ─────────────────────────────────────────────────────────────────────────────────────────────
function createStdioLoop(build) {
  let buf = Buffer.alloc(0);
  // Serialise message handling so responses are written in request order even though handlers
  // are async (avoids interleaving partial writes on stdout).
  let chain = Promise.resolve();

  // Requests waiting on (or running in) the chain, keyed by client id - the pre-cancellation
  // registry. A notifications/cancelled processed out-of-band marks a still-queued
  // target here; its chain link then skips processing and answers nothing (per spec). One client
  // per pipe, so raw client ids are unique keys.
  const queuedRequests = new Map();

  // Modern subscriptions/listen registrations. stdio has ONE client, so era-correct notification
  // delivery is: any active modern subscription -> tagged copies only (the client declared itself
  // modern by subscribing); none -> the raw legacy notification, byte-for-byte the 0.5.0 shape.
  const modernSubs = [];

  // Era latch: once the pipe's client has sent ONE modern-_meta request, it is a modern client -
  // and a modern client that opened no listen stream gets NOTHING unsolicited (in its era nothing
  // arrives outside a subscription). Only a never-modern (legacy) pipe gets raw notifications.
  let sawModern = false;

  function send(obj) {
    if (obj == null) return;
    let line;
    try {
      line = JSON.stringify(obj);
    } catch (_e) {
      line = JSON.stringify(makeError(null, ERR.INTERNAL, 'failed to serialise response'));
    }
    process.stdout.write(line + '\n');
  }

  /**
   * Era-aware notification writer for the hot-reload watchers + the aggregator's tools-changed
   * signal. tools/list_changed fans out to active modern subscriptions (tagged, filtered on the
   * agreed toolsListChanged) or falls back to the raw legacy notification; anything else passes
   * straight through to send().
   */
  function notify(n) {
    if (!n || typeof n.method !== 'string') return;
    // Era rule: NO modern subscriber -> raw notification (a legacy client on the pipe gets the legacy
    // shape - tools/list_changed, resources/updated, etc.). At least one modern subscriber -> tagged
    // copies ONLY to those whose AGREED filter includes this notification's channel; a modern client
    // that declined a channel must NOT get it (the ack's agreed
    // subset is the contract). Bridges upstream change-notifications (resources/prompts/tools) too.
    if (modernSubs.length === 0) return sawModern ? undefined : send(n);
    for (const s of modernSubs) {
      if (modern.notificationMatchesFilter(n, s.agreed)) send(modern.tagNotification(n, s.id));
    }
  }

  function enqueue(msg) {
    // Era latch - only a VALID modern request latches (an otherwise-legacy client that once sent
    // a malformed _meta must not lose its raw notifications forever). initialize
    // never latches: routing serves it as LEGACY regardless of decoration (a dual-era client that
    // stamps its trio on the handshake would otherwise lose raw notifications for the pipe's
    // lifetime while being served legacy semantics).
    if (msg && msg.method !== 'initialize' &&
        modern.isModernRequest(msg) && !modern.validateModernRequest(msg)) sawModern = true;

    // notifications/cancelled leaves the chain - chaining it queued a pipelined
    // cancel BEHIND the very forward it was trying to cancel: by the time it ran, the forward
    // had settled and the in-flight entry was gone (the whole translation machinery was
    // unreachable on the real wire; live-repro'd). A cancel produces no response, so immediate
    // processing cannot disorder the response stream. ONLY cancels jump the queue: cancellation
    // is the one notification with hard timing semantics - everything else stays chained so the
    // upstream sees the client's wire order untouched.
    const hasId = msg && msg.id !== undefined && msg.id !== null;
    if (msg && msg.method === 'notifications/cancelled' && !hasId) {
      // A cancel whose target request is still QUEUED (its chain link not started) marks it:
      // the link skips processing and sends NO reply (spec: a cancelled request is never
      // answered). Nothing is relayed upstream - the forward never started, so the upstream
      // never saw the request. `started` closes the mid-processing race: once the link runs,
      // the cancel falls through to handleMessage, whose in-flight map translates + relays.
      if (msg.params && msg.params.requestId !== undefined) {
        const queued = queuedRequests.get(msg.params.requestId);
        if (queued) {
          // Started or not: a cancelled request receives NO response (spec). For a STARTED
          // forward the upstream goes silent after the translated cancel - our own eventual
          // settle/timeout envelope must not become a response to the cancelled id
          //the send site drops it via this flag.
          queued.cancelled = true;
          if (!queued.started) return; // never started -> nothing was relayed; nothing to translate
        }
      }
      Promise.resolve(handleMessage(build, msg, 'stdio'))
        .then((r) => { if (r != null) send(r); }) // a cancel answers nothing; belt-and-braces
        .catch((err) => logErr('out-of-band cancel failed:', (err && err.message) || String(err)));
      return;
    }

    // Requests register for pre-cancellation while they wait their turn on the chain. The listen
    // request is transport-owned + long-lived (its "reply" is a stream) - cancel does not apply.
    const isListen = msg && msg.method === 'subscriptions/listen' && modern.isModernRequest(msg);
    const reg = (hasId && !isListen) ? { started: false, cancelled: false } : null;
    if (reg) queuedRequests.set(msg.id, reg);

    chain = chain.then(async () => {
      if (reg) {
        reg.started = true;
        if (reg.cancelled) { queuedRequests.delete(msg.id); return; } // pre-cancelled: no reply (spec)
      }
      try {
        // subscriptions/listen (modern) is TRANSPORT-owned: the ack and every later notification
        // ride this same stdout pipe, and the final result is written when stdin closes (see the
        // 'end' handler). Everything else routes through handleMessage unchanged.
        if (msg && msg.method === 'subscriptions/listen' && modern.isModernRequest(msg)) {
          const vErr = modern.validateModernRequest(msg);
          if (vErr) {
            if (hasId) send(makeError(msg.id, vErr.code, vErr.message, vErr.data));
            return;
          }
          if (!hasId) return; // a listen with no id can never be acknowledged or closed - ignore
          armWrapChatter(build); // a listen-FIRST client bypasses handleMessage's per-message arming
          const { agreed } = modern.normaliseListenFilter(msg.params);
          // resourceSubscriptions is only agreed when some upstream can DELIVER per-URI updates
          // (modern era emits spontaneously; a subscribe-capable legacy upstream gets the
          // subscribes forwarded). An ack must never promise a dead channel.
          if (agreed.resourceSubscriptions) {
            const agg = build && build.aggregator;
            if (agg && typeof agg.canHonourResourceSubscriptions === 'function' && agg.canHonourResourceSubscriptions()) {
              agg.subscribeResources(agreed.resourceSubscriptions);
            } else {
              delete agreed.resourceSubscriptions;
            }
          }
          // Replace-on-same-id: a client re-sending listen with the same id (a retry after a missed
          // ack) must not accumulate a duplicate registration -> doubled notifications forever
          //Overwrite the existing entry; otherwise append.
          const existing = modernSubs.findIndex((s) => s.id === msg.id);
          if (existing !== -1) modernSubs[existing] = { id: msg.id, agreed };
          else modernSubs.push({ id: msg.id, agreed });
          send(modern.listenAck(msg.id, agreed));
          return;
        }
        // 'stdio' - the pipe has exactly ONE client for the process lifetime, so a constant
        // connection key is a true identity (enables safe cancel translation under a wrap).
        const response = await handleMessage(build, msg, 'stdio');
        // Cancelled while in flight -> the client gets NO response for that id (spec); whatever
        // settled - the upstream's late result or our timeout envelope - is dropped here
        if (reg && reg.cancelled) return;
        send(response);
      } finally {
        if (reg) queuedRequests.delete(msg.id); // settled (or skipped) - pre-cancel can no longer apply
      }
    });
  }

  // Try to pull one Content-Length-framed message off the front of `buf`. Returns true if it
  // consumed one (and enqueued it), false if there isn't a complete header-framed message yet.
  function tryHeaderFramed() {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd === -1) return false;
    const header = buf.slice(0, headerEnd).toString('utf8');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) return false; // header block without a Content-Length -> not this framing
    const len = parseInt(m[1], 10);
    const bodyStart = headerEnd + 4;
    if (buf.length < bodyStart + len) return false; // body not all here yet
    const body = buf.slice(bodyStart, bodyStart + len).toString('utf8');
    buf = buf.slice(bodyStart + len);
    let obj = null;
    try {
      obj = JSON.parse(body);
    } catch (_e) {
      send(makeError(null, ERR.PARSE, 'Parse error: invalid JSON body'));
      return true;
    }
    enqueue(obj);
    return true;
  }

  // Try to pull one newline-delimited JSON message off the front of `buf`. Returns true if it
  // consumed a line (whether or not it parsed), false if no complete line is buffered.
  function tryLineFramed() {
    const nl = buf.indexOf(0x0a); // '\n'
    if (nl === -1) return false;
    const line = buf.slice(0, nl).toString('utf8').trim();
    buf = buf.slice(nl + 1);
    if (line.length === 0) return true; // blank line (e.g. trailing from header framing): skip
    // A leftover header line ("Content-Length: ...") that wasn't consumed by tryHeaderFramed means
    // the body hasn't arrived; but since we always try header framing FIRST, a stray header line
    // here is junk - ignore non-JSON lines rather than erroring on framing artifacts.
    if (line[0] !== '{' && line[0] !== '[') return true;
    let obj = null;
    try {
      obj = JSON.parse(line);
    } catch (_e) {
      send(makeError(null, ERR.PARSE, 'Parse error: invalid JSON line'));
      return true;
    }
    enqueue(obj);
    return true;
  }

  function drain() {
    // Header framing first (it counts exact bytes and is unambiguous); fall back to line framing.
    // Loop until neither can make progress.
    for (;;) {
      if (tryHeaderFramed()) continue;
      if (tryLineFramed()) continue;
      break;
    }
  }

  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    drain();
  });
  process.stdin.on('end', () => {
    // Flush any complete trailing message, then gracefully close each modern listen subscription
    // (the spec ends a subscription with a final RESULT to the listen id) before the process exits.
    drain();
    for (const sub of modernSubs.splice(0)) {
      try { send(modern.listenClose(sub.id)); } catch (_e) { /* pipe may already be gone */ }
    }
  });
  process.stdin.on('error', (err) => {
    logErr('stdin error:', (err && err.message) || String(err));
  });

  // Begin reading.
  process.stdin.resume();

  // Expose the writer so the entry point can wire hot-reload watchers (they emit
  // notifications/tools/list_changed through this same send). `notify` is the era-aware wrapper
  // the watchers should prefer - it fans tools/list_changed out to modern subscriptions.
  return { send, notify };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Entry point.
// ─────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  // The Phase-2 build object { protocol, aggregator, engine, ctx }.
  let build;
  try {
    build = buildProtocol();
  } catch (err) {
    // If wiring failed (e.g. a missing register/manifest), still start a server that answers every
    // request with a clean internal error - so the client gets a message instead of a hang. The
    // degraded build has a null aggregator (no curated-direct surface) but a working meta-tool
    // path that reports the wiring failure.
    logErr('FATAL wiring error:', (err && err.stack) || String(err));
    const message = `MCP server failed to initialise: ${(err && err.message) || String(err)}`;
    const protocol = makeProtocol({
      registry: { list: () => { throw new Error(message); }, instructions: () => { throw new Error(message); }, resolveExecution: () => null },
      gatedRun,
      howto: () => { throw new Error(message); },
    });
    build = { protocol, aggregator: null, engine: null, ctx: null };
  }

  // Connect every ENABLED upstream BEFORE the loop starts so tools/list advertises the curated
  // surface from the first request. connectAll() NEVER throws (per-upstream failures land in
  // failed[]) and with the default EMPTY expose.json it is an instant no-op - so this never
  // delays or crashes startup. await-safe either way.
  if (build.aggregator && typeof build.aggregator.connectAll === 'function') {
    try {
      const res = await build.aggregator.connectAll();
      if (res && Array.isArray(res.failed) && res.failed.length > 0) {
        logErr('aggregator.connectAll: ' + res.failed.length + ' upstream(s) failed:',
          res.failed.map((f) => `${f.id}(${f.error})`).join('; '));
      }
    } catch (err) {
      // connectAll is contracted not to throw; guard anyway so startup never dies on it.
      logErr('aggregator.connectAll threw (ignored):', (err && err.message) || String(err));
    }
  }
  armWrapChatter(build); // N3 filter armed from boot - not only from the first client message

  // Keep the process alive on the stdio loop; never let an unhandled rejection kill it.
  process.on('uncaughtException', (err) => logErr('uncaughtException:', (err && err.stack) || String(err)));
  process.on('unhandledRejection', (err) => logErr('unhandledRejection:', (err && (err.stack || err.message)) || String(err)));

  const loop = createStdioLoop(build);

  // Wire the aggregator's out-of-band tool-set-change signal (a background reconnect recovering - or
  // finally losing - an upstream) to notifications/tools/list_changed, so the client refreshes when a
  // dead upstream heals itself. Set on the live instance; reloadExpose re-wires the swapped-in one.
  // loop.notify is the era-aware writer: it fans the notification out to modern subscriptions
  // (tagged) or falls back to the raw legacy shape - same for the watchers below.
  if (build.aggregator) build.aggregator.onToolsChanged = () => emitToolsListChanged(loop.notify);
  // Bridge an upstream's server-initiated change-notifications (resources/prompts/tools list_changed,
  // resources/updated) to the era-aware notify path - so a modern client's subscriptions/listen
  // stream receives them, tagged + filtered. This is what makes wrapping a resource/prompt-bearing
  // legacy MCP transparent for a modern client (2026-07-16).
  if (build.aggregator) build.aggregator.onUpstreamNotification = (uid, n) => {
    // Under a wrap, ONLY the wrapped upstream's notifications reach the client - another attached
    // upstream's events are ones the impersonated server would never emit: a transparency tell
    // and a cross-server information leak. Funnel mode (no wrap) fans all.
    const wrapOnly = build.aggregator && build.aggregator.wrapChatterUpstream;
    if (wrapOnly && uid !== wrapOnly) return;
    loop.notify(n);
  };
  // Bridge B: server-initiated upstream requests (elicitation/create) route to the bridge; it
  // binds them to the one in-flight wrapped call or declines. `build` is the stable stdio object.
  if (build.aggregator) build.aggregator.onUpstreamServerRequest =
    (uid, m, c) => handleUpstreamServerRequest(build, uid, m, c);

  // Hot-reload: pick up expose.json / hook changes written by the tf_* tools or the UI (a separate
  // process) with NO restart and NO user intervention - the missing primitive that previously made
  // a live MCP attach or a hook change need a bounce. Auto is the default; the meta-tools/UI button
  // are just optional manual levers on top of this.
  startConfigWatchers(build, loop.notify);

  logErr('ready -', SERVER_INFO.name, SERVER_INFO.version, '(pid', process.pid + ')');
}

// Run only when invoked directly (so the module can also be required by tests). main() is async
// (it awaits aggregator.connectAll); a startup rejection is logged to stderr, never thrown so the
// process can't die unhandled before the loop is even up.
if (require.main === module) {
  Promise.resolve()
    .then(main)
    .catch((err) => logErr('FATAL startup error:', (err && err.stack) || String(err)));
}

module.exports = {
  // Exported for unit tests / reuse (the transport is thin; these are the seams).
  buildProtocol,
  makeRegistryAdapter,
  handleMessage,
  handleInitialize,
  // The stdio entry point - an external bin/ can require this module and call main() to start the
  // server (build -> connect upstreams -> run the stdio loop). main() is async and takes no args.
  main,
  // Phase-2 + MATRIX handlers: handleToolsList(protocol, aggregator, { registry?, toolStatePath? })
  // and handleToolsCall(protocol, aggregator, { engine, ctx, registry?, toolStatePath? }, params).
  handleToolsList,
  handleToolsCall,
  // N3 filter arming - the HTTP transport calls this at start/reload and in its listen branch.
  armWrapChatter,
  // Bridge B: the HTTP transport wires this as the aggregator's onUpstreamServerRequest handler.
  handleUpstreamServerRequest,
  // Matrix helpers (exported for unit tests / reuse).
  localHotDefinitions,
  localToolDefinition,
  isPromotedLocal,
  isPromotedUpstream,
  // Phase-2: emit the hot-update notification (no-id notifications/tools/list_changed) via send.
  emitToolsListChanged,
  // Hot-reload: re-read on-disk config live (no restart). Wired to fs.watch in main().
  reloadExpose,
  reloadHooks,
  startConfigWatchers,
  // Helpers exported for tests / reuse.
  isMetaTool,
  runCuratedDirect,
  wrapProtocolResult,
  normaliseBuild,
  stringifyContent,
  firstString,
  // Dual-era (2026-07-28) handlers - the modern module itself is at ./modern.
  handleServerDiscover,
  handleModernMessage,
  PROTOCOL_VERSION,
  SERVER_INFO,
};
