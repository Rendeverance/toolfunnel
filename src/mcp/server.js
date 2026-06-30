#!/usr/bin/env node
'use strict';

/**
 * server.js — the HAND-ROLLED minimal MCP server over stdio (see the architecture notes §7).
 *
 * Runnable as:  node src/mcp/server.js
 *
 * This is the THIN transport. It speaks JSON-RPC 2.0 over stdin/stdout and delegates ALL logic
 * to the pure protocol layer (src/mcp/protocol.js). It is NOT an SDK wrapper — there is no
 * @modelcontextprotocol/sdk and no new npm dependency; everything here is Node built-ins.
 *
 * JSON-RPC methods handled (MCP, the subset our test client speaks):
 *   - "initialize"  -> { protocolVersion, serverInfo, capabilities: { tools: {} } }
 *   - "tools/list"  -> { tools: [ ...protocol.toolDefinitions() ] }   (the 4 meta-tools;
 *                       a clear seam is left for curated-direct tools — Phase 2)
 *   - "tools/call"  { name, arguments } -> protocol.dispatch(name, arguments), wrapped in the
 *                       MCP tools/call result shape: { content:[{ type:"text", text: JSON }],
 *                       isError? }. On a protocol error result we set isError:true.
 *   - notifications (no `id`) are acknowledged silently and never answered.
 *   - any bad / unknown message NEVER crashes the process — it gets a JSON-RPC error object.
 *
 * Framing: we READ both LSP-style `Content-Length:` framing AND newline-delimited JSON (the test
 * client writes Content-Length with a trailing newline; a simple client may send line-delimited),
 * and we WRITE newline-delimited JSON (the test reader accepts either framing on the wire). One
 * framing on the way out keeps the transport trivial and matches "newline-delimited JSON is fine
 * for our test client".
 *
 * Wiring (see the architecture notes §8 — Phase 1): a real Registry (loaded from
 * src/tools/tools.register.json — the canonical tool register), a real HookEngine over the hooks
 * manifest, the real gatedRun, and the real howto. A small ADAPTER bridges the register's
 * resolveExecution({type,run}) shape to the { execute, toolName, args } shape protocol.runTool
 * injects into gatedRun — keeping the pure modules untouched while making `toolfunnel_run_tool`
 * actually gate + execute end to end.
 *
 * CommonJS only. Node built-ins only. No transport SDK.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { makeProtocol } = require('./protocol');
const { gatedRun } = require('./gated-run');
const { Aggregator } = require('./aggregator');
const { loadExposeStore } = require('./expose-store');
const { loadRegistry } = require('../tools/registry');
const { loadToolState, isToolEnabled, isToolHot } = require('../tools/tool-state');
const { loadManifest } = require('../core/hook-loader');
const { HookEngine } = require('../core/hook-engine');
const { howto } = require('../extend/howto');
const logger = require('../core/logger');
const metrics = require('../core/metrics');

// ── Path anchors (everything stays under the host root) ───────────────────────────────────────
const ROOT = path.resolve(__dirname, '..', '..'); // <…>/<root>
const REGISTER_PATH = path.join(ROOT, 'tools', 'tools.register.json');
// The ACTIVE/DISABLED overlay (tool-state.js). toolfunnel_list_tools filters DISABLED tools out so
// they are not surfaced to the client. Read FRESH per list() call so UI toggles take effect with no
// restart. HIDDEN is a manager-list-only axis — it is NEVER consulted here (it must not affect the
// client's view).
const TOOL_STATE_PATH = path.join(ROOT, 'tools', 'tools.state.json');
const MANIFEST_PATH = path.join(ROOT, 'hooks', 'hooks.manifest.json');
const SCRIPTS_ROOT = path.join(ROOT, 'tools', 'scripts');
// Phase 2: the persisted curated-expose + upstream-MCP config. Default is EMPTY, so the
// aggregator connects to nothing and the curated-direct surface is empty — the server is
// behaviourally identical to Phase 1 until an upstream + expose entry is added.
const EXPOSE_PATH = path.join(ROOT, 'mcp', 'expose.json');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'toolfunnel', version: '0.3.0' };

// ── Diagnostics → stderr only (stdout is the JSON-RPC channel; never pollute it). ─────────────
function logErr(...parts) {
  try {
    process.stderr.write('[toolfunnel] ' + parts.join(' ') + '\n');
  } catch (_e) {
    /* never let logging throw */
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Registry adapter — bridge the real Registry to what protocol.runTool consumes.
//
// protocol.runTool expects:  registry.resolveExecution(name, args) -> { execute, toolName, args }
// The real Registry returns:  resolveExecution(id, args)           -> { type, run }
//   - it looks up by `id` only (throws on unknown id),
//   - returns `run` (not `execute`),
//   - for a SHELL invoke it returns a DEFERRED descriptor instead of running (the gated runner
//     is meant to own shell execution — registry.js keeps un-gated shell out of itself by design).
//
// The adapter therefore:
//   - resolves the meta-tool `name` to a register id (accepting id OR display name),
//   - wraps `run` into an `execute` thunk that returns a clean tool output,
//   - for the shell-deferred case, performs the actual shell spawn INSIDE the execute thunk — so
//     it only ever runs after gatedRun's PreToolUse gate has allowed it.
// list()/instructions() pass straight through (with the same name→id resolution for instructions).
// ─────────────────────────────────────────────────────────────────────────────────────────────
function makeRegistryAdapter(registry, opts) {
  // opts.toolStatePath: when set, list() filters DISABLED tools out (the enabled-filter for
  // toolfunnel_list_tools). When absent (the Tool Manager's runOnce adapter, tests) list() is unfiltered.
  const toolStatePath = (opts && opts.toolStatePath) || null;
  // opts.getAggregator: an OPTIONAL live getter () => Aggregator|null. NEVER a captured instance —
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

  /** Run a shell command synchronously, normalising to { ok, code, stdout, stderr }. */
  function runShell(command, args) {
    const res = spawnSync(command, {
      shell: true,
      cwd: ROOT,
      env: Object.assign({}, process.env, { TOOLFUNNEL_TOOL_ARGS: JSON.stringify(args == null ? null : args) }),
      encoding: 'utf8',
      windowsHide: true,
    });
    if (res.error) throw new Error(`shell spawn failed: ${res.error.message}`);
    const code = typeof res.status === 'number' ? res.status : -1;
    return {
      ok: code === 0,
      code,
      stdout: res.stdout != null ? String(res.stdout) : '',
      stderr: res.stderr != null ? String(res.stderr) : '',
    };
  }

  return {
    // Briefs only (protocol forwards { filter, category }). When a tool-state overlay is configured,
    // DISABLED (✗) tools are dropped so toolfunnel_list_tools never surfaces them to the client —
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
      //  - drop any whose name is a local tool (local-register WINS — matches resolveExecution),
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
        upstream = []; // a throwing aggregator must never sink toolfunnel_list_tools — local-only fallback
      }
      return local.concat(upstream);
    },

    // Full instructions for one tool (by id or display name). Registry.instructions throws on an
    // unknown id; protocol.toolInstructions catches that and returns a clean error result.
    instructions(nameOrId) {
      const id = resolveId(nameOrId);
      if (id) return registry.instructions(id);
      // Not a local tool — synthesise instructions for a lean upstream tool from its discovered def.
      const agg = liveAggregator();
      if (!agg || typeof agg.leanToolDefinitions !== 'function') return null;
      try {
        const def = agg.leanToolDefinitions().find((d) => d.name === nameOrId);
        return def ? renderUpstreamInstructions(def) : null; // null → protocol's "no tool named …"
      } catch (_e) {
        return null;
      }
    },

    // Build the { execute, toolName, args, mode } resolution protocol.runTool hands to gatedRun.
    resolveExecution(nameOrId, args) {
      const id = resolveId(nameOrId);
      if (id) {
        // LOCAL tool — byte-for-byte the pre-slice-2 path. A local name that resolves but isn't
        // runnable returns null and does NOT fall through to upstream (local-register WINS: a local
        // name never silently resolves to a remote upstream).
        const entry = registry.getEntry(id); // { id, name, summary, category, instructions, invoke, mode? }
        const desc = registry.resolveExecution(id, args); // { type, mode, run? } | reference: { type, mode, instructions }
        if (!desc) return null;

        // Reference mode: nothing executes here. Hand back the instructions (no execute thunk)
        // so protocol.runTool short-circuits BEFORE gatedRun — no spawn, no gate.
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
          // Shell invokes come back deferred — the registry hands shell execution to the gated path.
          if (out && out.deferred === true && out.type === 'shell') {
            return runShell(out.command, out.args);
          }
          return out;
        };

        return { execute, toolName: entry.name || id, args: args == null ? {} : args, mode: desc.mode || 'gateway' };
      }

      // No local tool by this name — try the LEAN upstream forward. resolveLeanExecution returns a
      // resolution whose execute thunk lazy-(re)connects + unwraps; the gate matches fwd.toolName (the
      // surfaced name). mode is 'gateway' so it goes THROUGH gatedRun — never the reference handoff.
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
// instead of dying — a dead server hangs the client (and the test).
//
// Returns an OBJECT, not just the protocol, because the Phase-2 curated-direct call path needs
// more than the protocol:
//   { protocol, aggregator, engine, ctx }
//   - protocol   : the 4 meta-tools (unchanged Phase-1 logic) — callers needing just the
//                  protocol read it off `.protocol` (backward compat).
//   - aggregator : the upstream-MCP connection + curated-expose set (built from expose.json).
//                  Default expose.json is EMPTY so it connects to nothing.
//   - engine, ctx: threaded into gatedRun for the curated-direct path (a curated tool runs
//                  THROUGH the same PreToolUse gate as toolfunnel_run_tool — the safety invariant).
function buildProtocol() {
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

  // Phase 2: the aggregator over expose.json (EMPTY by default → nothing connects).
  // loadExposeStore on a missing/empty file returns an empty store; Aggregator over an empty store
  // advertises no curated-direct tools and connectAll() is an instant no-op.
  const store = loadExposeStore(EXPOSE_PATH);
  build.aggregator = new Aggregator({ store, v3Root: ROOT });

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
function handleInitialize(params) {
  // protocolVersion + serverInfo + capabilities { tools:{} } (see the architecture notes §7,
  // mcp-server.test.js asserts a `tools` capability + a protocolVersion).
  // Activity log (self-gating; no-op unless logging is enabled): the CLIENT-connected half of
  // connect logging — the aggregator logs the upstream half. Wrapped though logger.log never throws.
  try {
    const info = params && params.clientInfo;
    logger.log({
      type: 'client',
      event: 'connect',
      client: info && typeof info.name === 'string' ? info.name : 'unknown',
      protocolVersion: params && typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined,
    });
  } catch (_e) { /* never let logging affect the handshake */ }
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: SERVER_INFO,
    capabilities: {
      // We are a tool host. `tools: {}` declares the capability. Phase 2 wires curated-direct
      // hot-updates, so we now advertise listChanged:true — the server may emit
      // notifications/tools/list_changed when the curated-direct expose set changes (see
      // emitToolsListChanged). The mcp-server.test.js assertion only requires a `tools`
      // capability key + a protocolVersion, both still present.
      tools: { listChanged: true },
    },
  };
}

function handleToolsList(protocol, aggregator, opts) {
  // The TOP-LEVEL surface (tools/list — injected EVERY turn) is assembled from the per-tool `hot`
  // axis of the visibility MATRIX, deduped by name with a fixed precedence (first writer wins):
  //
  //   1. META-TOOLS         hot defaults TRUE  — the 4 management tools; a meta-tool can be HIDDEN
  //                                              from the top level (state[name].hot === false).
  //   2. LOCAL hot tools    hot defaults FALSE — a register tool promoted hot (and enabled); its def
  //                                              carries the entry's inputSchema (or {type:object}).
  //   3. CURATED-DIRECT     the existing expose[] path (an enabled expose entry == top-level).
  //   4. UPSTREAM hot tools hot defaults FALSE — a connected upstream tool promoted hot by its
  //                                              surfaced name (lean run semantics; not via expose[]).
  //
  // Precedence is local-register-wins over an upstream of the same name (matches the lean rule), and
  // a META-tool can NEVER be shadowed by a local/upstream tool of the same name (safety). With the
  // default EMPTY state + EMPTY expose.json this is exactly the 4 meta-tools — byte-identical to the
  // pre-matrix surface. `opts` is OPTIONAL: a Phase-1 / bare-protocol caller (no registry/state) gets
  // meta-tools (all hot) + curated-direct, the prior behaviour. NEVER throws.
  const o = opts || {};
  const registry = o.registry || null;
  const statePath = typeof o.toolStatePath === 'string' && o.toolStatePath ? o.toolStatePath : null;
  let state = {};
  if (statePath) { try { state = loadToolState(statePath); } catch (_e) { state = {}; } }

  const byName = new Map(); // name -> MCP tool def; first writer wins (the precedence above)

  // The 4 meta-tool names are RESERVED: nothing else may be advertised under them, even when a meta
  // is hidden (else a curated-direct/upstream tool aliased onto a meta name would be advertised yet
  // uncallable — handleToolsCall routes a meta name to the meta gate first).
  const metaNames = new Set(protocol.toolDefinitions().map((d) => d && d.name));

  // 1. META-TOOLS — hot by default; hideable via state[name].hot === false (footgun: hiding all is
  //    the "ordinary tools as an MCP" pattern — warned below + at the write site).
  for (const def of protocol.toolDefinitions()) {
    if (def && isToolHot(state, def.name, true) && !byName.has(def.name)) byName.set(def.name, def);
  }

  // 2. LOCAL hot tools — opt-in (hot:true) AND enabled. A real MCP def from the register entry.
  if (registry) {
    for (const def of localHotDefinitions(registry, state)) {
      if (def && !byName.has(def.name)) byName.set(def.name, def);
    }
  }

  // 3. CURATED-DIRECT (expose[]) — unchanged. exposedToolDefinitions never throws, but guard anyway.
  //    Skip any def colliding with a RESERVED meta name (never advertise a phantom uncallable tool).
  if (aggregator && typeof aggregator.exposedToolDefinitions === 'function') {
    try {
      const defs = aggregator.exposedToolDefinitions();
      if (Array.isArray(defs)) for (const def of defs) if (def && !byName.has(def.name) && !metaNames.has(def.name)) byName.set(def.name, def);
    } catch (err) {
      logErr('exposedToolDefinitions failed:', (err && err.message) || String(err));
    }
  }

  // 4. UPSTREAM hot tools — a connected upstream tool promoted hot by its surfaced name (and enabled),
  //    not already surfaced. Skip a name that is RESERVED (meta) or TAKEN by a local tool's id/display
  //    name — local-register-wins, AND it keeps the advertised name resolving to what actually runs
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
  // discovery/run is gone — recovery is the --ui console or hand-editing tools/tools.state.json.
  const metaPresent = [...metaNames].some((n) => byName.has(n));
  if (!metaPresent && !_noMetaWarned) {
    logErr('WARNING: all meta-tools are hidden (hot:false) — no in-band tool discovery/run remains. Recover via `--ui` or by editing tools/tools.state.json.');
    _noMetaWarned = true;
  } else if (metaPresent) {
    _noMetaWarned = false;
  }

  return { tools: [...byName.values()] };
}

/** Module flag so the all-metas-hidden warning logs ONCE per episode (not on every tools/list). */
let _noMetaWarned = false;

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
 *                   gate authored via the UI — which keys the matcher on that same `entry.name || id`
 *                   — gates both routes identically. No new gate-naming footgun vs run_tool today.
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
  //   1. A meta-tool name → protocol.dispatch (unchanged; a meta-tool can NEVER be shadowed).
  //   2. ELSE a LOCAL tool promoted HOT, called directly → run it exactly like toolfunnel_run_tool
  //      {name,args}: ONE path, reusing the PreToolUse gate + reference-mode + register resolution.
  //      Local-register wins over a curated-direct of the same name (the lean rule + list precedence).
  //   3. ELSE a curated-direct tool (expose[]) → run THROUGH gatedRun with transparent upstream-
  //      envelope passthrough. THE INVARIANT: it can NEVER reach the upstream without the gate.
  //   4. ELSE an UPSTREAM tool promoted HOT (by surfaced name, not via expose[]), called directly →
  //      run it like toolfunnel_run_tool: the adapter falls through to the aggregator's lean forward,
  //      so the gate fires on the surfaced name and the upstream envelope is unwrapped.
  //   5. ELSE → protocol.dispatch, which returns the clean unknown-tool error.
  // Only tools ACTUALLY advertised hot are directly callable (the advertised surface == the callable
  // surface — a non-promoted tool called directly gets the clean unknown-tool error, not a silent run).
  // Load the tool-state overlay ONCE for the routing checks — fresh per call so a UI toggle is live.
  const d0 = deps || {};
  let state = {};
  if (d0.toolStatePath) { try { state = loadToolState(d0.toolStatePath); } catch (_e) { state = {}; } }

  // 1. A meta-tool — but callable ONLY while it is on the advertised top-level surface (hot, default
  //    true). A meta HIDDEN via hot:false is dropped from tools/list AND becomes uncallable, so the
  //    callable surface == the advertised surface even for the meta-tools — the "ordinary tools as an
  //    MCP" lockdown is REAL, not cosmetic. (A meta-tool is still never SHADOWED by a same-named
  //    local/upstream tool: this check runs FIRST, so a hot meta always wins precedence.)
  if (isMetaTool(protocol, name)) {
    if (isToolHot(state, name, true)) {
      return wrapProtocolResult(await protocol.dispatch(name, args || {}));
    }
    // Hidden meta-tool: not advertised, so not callable — the clean unknown-tool error (never run it).
    return { content: [{ type: 'text', text: `Unknown tool "${name}".` }], isError: true };
  }

  if (d0.registry && isPromotedLocal(d0.registry, state, name)) {
    return wrapProtocolResult(await protocol.runTool({ name, args: args == null ? {} : args }));
  }

  if (aggregator && typeof aggregator.isExposed === 'function' && aggregator.isExposed(name)) {
    return await runCuratedDirect(aggregator, deps, name, args);
  }

  if (isPromotedUpstream(aggregator, d0.registry, state, name)) {
    return wrapProtocolResult(await protocol.runTool({ name, args: args == null ? {} : args }));
  }

  // Not a meta-tool, not promoted, not exposed → let the protocol return its clean unknown-tool error.
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
  // display-name resolution — advertised-upstream / executed-local). Matches handleToolsList step 4.
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
  // protocol.META_TOOLS is { LIST, INSTRUCTIONS, RUN, HOWTO } → string values.
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
 * (a thrown upstream call). NEVER throws — a misbehaving aggregator/gate becomes a clean error
 * result so the loop survives.
 */
async function runCuratedDirect(aggregator, deps, name, args) {
  const d = deps || {};
  // resolveExposedExecution → { execute, toolName, upstream } | null. It can change between the
  // isExposed() check and here only if the expose set mutated mid-call; guard for null.
  let resolution = null;
  try {
    resolution = aggregator.resolveExposedExecution(name, args);
  } catch (err) {
    return {
      content: [{ type: 'text', text: `curated tool "${name}" failed to resolve: ${(err && err.message) || String(err)}` }],
      isError: true,
    };
  }
  if (!resolution || typeof resolution.execute !== 'function') {
    // Raced away (or never really runnable) — surface a clean error rather than reaching upstream.
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
  // informative message — a block carries `reason`, a thrown call carries `error`.
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
  // (text / image / etc.) AND its isError flag — rather than the whole envelope JSON-stringified
  // into one text block (which also used to swallow the upstream's isError). runCuratedDirect only
  // ever runs FORWARDED upstream tools, so result.output is always an MCP envelope here.
  const out = result.output;
  if (out && typeof out === 'object' && Array.isArray(out.content)) {
    return { content: out.content, isError: out.isError === true };
  }
  // Defensive fallback: a non-standard upstream payload — wrap it as text so the client still gets
  // a well-formed envelope rather than an empty/invalid content array.
  return { content: [{ type: 'text', text: stringifyContent(out) }], isError: false };
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
      // gatedRun returns `error` as an Error INSTANCE on a thrown tool — extract its message
      // (firstString only takes strings, so a bare Error would be dropped → generic text).
      // Mirrors runCuratedDirect's error shaping so the two paths report identically.
      result && result.error && (result.error.message || String(result.error)),
      result && result.reason,
      'tool call failed'
    );
  } else if (result && result.output !== undefined) {
    payload = result.output;
  } else if (result && result.mode === 'reference') {
    // A reference HANDOFF carries no `output` — its `instructions` ARE the payload. Surface them
    // (with the handoff message) so a reference tool returns usable text whether reached via
    // toolfunnel_run_tool OR called directly after being promoted hot (the matrix). Falls back to
    // the whole result object if neither field is a string.
    payload = firstString(result.instructions, result.message) || result;
  } else {
    payload = result && result.output; // undefined → stringifyContent guards it to a string
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

/** Serialise a protocol payload into a text block. Strings pass through; everything else → JSON.
 *  NEVER returns a non-string: JSON.stringify(undefined) / a function yields `undefined`, so guard it
 *  (an MCP content block's `text` must be a string — an undefined text is a malformed envelope). */
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
  lines.push(`${def.name} — forwarded from upstream MCP "${def.upstream}" (upstream tool: ${def.tool}).`);
  if (def.description) lines.push('', def.description);
  lines.push('', 'Run it through the gateway with:', `  toolfunnel_run_tool { "name": "${def.name}", "args": { … } }`);
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
 * bare protocol (Phase-1 callers / older tests) — we wrap it with a null aggregator + no deps so
 * the meta-tool path is identical and the curated-direct path is simply never taken (isExposed
 * is unreachable without an aggregator). A protocol is detected by its dispatch() method.
 * @param {object} arg  either { protocol, aggregator, engine, ctx } or a bare protocol
 * @returns {{ protocol:object, aggregator:(object|null), engine:(object|null), ctx:(object|null) }}
 */
function normaliseBuild(arg) {
  const a = arg || {};
  if (a && typeof a.dispatch === 'function') {
    // It's a bare protocol — Phase-1 shape (no register/state → no hot promotion; meta + curated only).
    return { protocol: a, aggregator: null, engine: null, ctx: null, registry: null, toolStatePath: null };
  }
  return {
    protocol: a.protocol,
    aggregator: a.aggregator || null,
    engine: a.engine || null,
    ctx: a.ctx || null,
    // The MATRIX inputs: the raw register (for a hot LOCAL tool's full MCP def) + the state overlay
    // path (read fresh per call). Absent → the surface is meta + curated-direct, the prior behaviour.
    registry: a.registry || null,
    toolStatePath: a.toolStatePath || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Dispatch ONE parsed JSON-RPC message. Returns a response object to send, or null for
// notifications / messages that take no reply. NEVER throws.
//
// `build` is the Phase-2 build object { protocol, aggregator, engine, ctx } (a bare protocol is
// still accepted for backward compat — see normaliseBuild). The aggregator + engine + ctx are
// threaded into tools/list and tools/call so the curated-direct surface is advertised and runs
// THROUGH the PreToolUse gate.
// ─────────────────────────────────────────────────────────────────────────────────────────────
async function handleMessage(build, msg) {
  const { protocol, aggregator, engine, ctx, registry, toolStatePath } = normaliseBuild(build);

  // Basic envelope validation — a non-object or wrong jsonrpc is an Invalid Request.
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return makeError(null, ERR.INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC object');
  }

  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null;
  const id = hasId ? msg.id : null;
  const method = msg.method;

  // A message with no method but with an id is a response/garbage to us — acknowledge nothing.
  if (typeof method !== 'string') {
    if (hasId) return makeError(id, ERR.INVALID_REQUEST, 'Invalid Request: missing "method"');
    return null; // notification-shaped junk: ignore
  }

  try {
    switch (method) {
      case 'initialize':
        return makeResult(id, handleInitialize(msg.params));

      case 'initialized':
      case 'notifications/initialized':
        // Client → server notification that init handshake is complete. No reply.
        return null;

      case 'tools/list':
        return makeResult(id, handleToolsList(protocol, aggregator, { registry, toolStatePath }));

      case 'tools/call': {
        const result = await handleToolsCall(protocol, aggregator, { engine, ctx, registry, toolStatePath }, msg.params);
        // Observability (in-memory counters; never throws). Count every tools/call by name + whether
        // it errored (an isError envelope = a tool failure OR a PreToolUse denial). Single chokepoint
        // → covers stdio AND the HTTP transport, which both route through handleMessage.
        metrics.record({ tool: (msg.params && msg.params.name) || 'unknown', ok: !(result && result.isError === true) });
        return makeResult(id, result);
      }

      case 'ping':
        // MCP keep-alive: empty result.
        return makeResult(id, {});

      default:
        // Unknown notification (no id) → silently ignore. Unknown request → method-not-found.
        if (!hasId) {
          if (method.startsWith('notifications/')) return null;
          return null;
        }
        return makeError(id, ERR.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch (err) {
    // Any unexpected internal failure becomes a JSON-RPC error (request) or is swallowed
    // (notification) — the loop never crashes on one bad message.
    logErr('handler error for', method + ':', (err && err.stack) || String(err));
    if (hasId) {
      return makeError(id, ERR.INTERNAL, `Internal error handling "${method}"`, (err && err.message) || String(err));
    }
    return null;
  }
}

/**
 * emitToolsListChanged(send) — write the MCP `notifications/tools/list_changed` JSON-RPC
 * notification (NO id — it is a notification, not a request) via the provided `send` fn. The
 * server emits this when the curated-direct expose set hot-updates so a CLI that honours
 * listChanged re-fetches tools/list (see the architecture notes §1 "no restart for register
 * changes"; §7 the host runs the server). `send` is injected so this is unit-testable with a spy
 * and reused by both the stdio loop and (later) the host.
 *
 * @param {(obj: object) => void} send  the transport's writer (stdio loop's send, or a spy)
 * @returns {void}
 */
function emitToolsListChanged(send) {
  if (typeof send !== 'function') return; // never throw — a missing transport is a no-op
  send({ jsonrpc: JSONRPC, method: 'notifications/tools/list_changed' });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// HOT-RELOAD — pick up on-disk config changes with NO restart, NO user intervention.
//
// The tf_* management tools (and the UI) write expose.json / the hooks files from a SEPARATE
// process, so the running gateway's in-memory aggregator + hook engine never saw the change — that
// was the root cause of "you have to restart to attach an MCP / change a hook". These reloaders
// re-read the on-disk config and SWAP build.aggregator / build.engine IN PLACE. handleMessage reads
// the build object fresh on every message, so the next tools/list or tools/call uses the new state.
// startConfigWatchers wires them to fs.watch so the gateway heals/updates itself automatically.
// Everything here is contracted NEVER to throw — a bad reload keeps the last-good state.
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
  let store;
  try {
    store = loadExposeStore(EXPOSE_PATH);
  } catch (err) {
    logErr('reloadExpose: cannot read expose.json (keeping current upstreams):', (err && err.message) || String(err));
    return;
  }
  const next = new Aggregator({ store, v3Root: ROOT });
  next.onToolsChanged = () => emitToolsListChanged(send); // re-wire the background-reconnect → list_changed signal
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
  const prev = build.aggregator;
  build.aggregator = next; // swap BEFORE closing the old one (handleMessage reads build fresh)
  if (prev && typeof prev.closeAll === 'function') {
    try { await prev.closeAll(); } catch (_e) { /* closeAll never throws, but guard teardown */ }
  }
  emitToolsListChanged(send);
  // Activity log (self-gating): mark the reload trigger; the per-upstream connect/disconnect lines
  // (from the aggregator) carry the detail. Together they record the reconnect.
  logger.log({
    type: 'mcp',
    event: 'reload',
    connected: res && Array.isArray(res.connected) ? res.connected : [],
    failed: res && Array.isArray(res.failed) ? res.failed.map((f) => f.id) : [],
  });
  logErr('reloadExpose: expose.json reloaded — upstreams reconnected');
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
 * Watch the config directories and hot-reload on change. Watches the DIRECTORIES (robust to the
 * atomic temp+rename writes expose-store / hook-loader use, which replace the file inode) and
 * filters by basename. Debounced (a temp+rename burst → one reload), with a re-entrancy guard so a
 * mid-flight expose reload can't overlap itself. A watch failure (an fs that doesn't support
 * fs.watch) is logged and ignored — the server still runs, just without auto-reload. NEVER throws.
 *
 * @param {object} build  the live build object (mutated by the reloaders)
 * @param {(obj:object)=>void} send  the stdio writer
 * @returns {void}
 */
function startConfigWatchers(build, send) {
  const DEBOUNCE_MS = 150;
  const mcpDir = path.dirname(EXPOSE_PATH);
  const hooksDir = path.dirname(MANIFEST_PATH);

  let exposeTimer = null;
  let reloadingExpose = false;
  function scheduleExpose() {
    if (exposeTimer) clearTimeout(exposeTimer);
    exposeTimer = setTimeout(async () => {
      exposeTimer = null;
      if (reloadingExpose) { scheduleExpose(); return; } // a reload is mid-flight; re-arm
      reloadingExpose = true;
      try { await reloadExpose(build, send); } finally { reloadingExpose = false; }
    }, DEBOUNCE_MS);
    if (exposeTimer && typeof exposeTimer.unref === 'function') exposeTimer.unref(); // don't pin the loop
  }

  let hooksTimer = null;
  function scheduleHooks() {
    if (hooksTimer) clearTimeout(hooksTimer);
    hooksTimer = setTimeout(() => { hooksTimer = null; reloadHooks(build); }, DEBOUNCE_MS);
    if (hooksTimer && typeof hooksTimer.unref === 'function') hooksTimer.unref();
  }

  try {
    const w = fs.watch(mcpDir, (_event, filename) => {
      // null filename (some platforms don't report it) → reload to be safe; else only expose.json.
      if (!filename || path.basename(String(filename)) === 'expose.json') scheduleExpose();
    });
    // unref so an FSWatcher never keeps the process alive after the client closes stdin — the
    // gateway must still exit naturally when its transport closes (it did before this feature).
    if (w && typeof w.unref === 'function') w.unref();
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
    logErr('startConfigWatchers: watching', hooksDir, 'for hook changes');
  } catch (err) {
    logErr('startConfigWatchers: cannot watch', hooksDir + ':', (err && err.message) || String(err));
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// stdin framing reader — accepts BOTH Content-Length framing and newline-delimited JSON.
// We write newline-delimited JSON on stdout.
//
// `build` is the Phase-2 build object { protocol, aggregator, engine, ctx } (a bare protocol is
// accepted too — see normaliseBuild). It is threaded straight into handleMessage so tools/list
// advertises the curated-direct surface and tools/call gates curated-direct calls.
// ─────────────────────────────────────────────────────────────────────────────────────────────
function createStdioLoop(build) {
  let buf = Buffer.alloc(0);
  // Serialise message handling so responses are written in request order even though handlers
  // are async (avoids interleaving partial writes on stdout).
  let chain = Promise.resolve();

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

  function enqueue(msg) {
    chain = chain.then(async () => {
      const response = await handleMessage(build, msg);
      send(response);
    });
  }

  // Try to pull one Content-Length-framed message off the front of `buf`. Returns true if it
  // consumed one (and enqueued it), false if there isn't a complete header-framed message yet.
  function tryHeaderFramed() {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd === -1) return false;
    const header = buf.slice(0, headerEnd).toString('utf8');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) return false; // header block without a Content-Length → not this framing
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
    // A leftover header line ("Content-Length: …") that wasn't consumed by tryHeaderFramed means
    // the body hasn't arrived; but since we always try header framing FIRST, a stray header line
    // here is junk — ignore non-JSON lines rather than erroring on framing artifacts.
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
    // Flush any complete trailing message, then let the process exit naturally.
    drain();
  });
  process.stdin.on('error', (err) => {
    logErr('stdin error:', (err && err.message) || String(err));
  });

  // Begin reading.
  process.stdin.resume();

  // Expose the writer so the entry point can wire hot-reload watchers (they emit
  // notifications/tools/list_changed through this same send).
  return { send };
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
    // request with a clean internal error — so the client gets a message instead of a hang. The
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
  // failed[]) and with the default EMPTY expose.json it is an instant no-op — so this never
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

  // Keep the process alive on the stdio loop; never let an unhandled rejection kill it.
  process.on('uncaughtException', (err) => logErr('uncaughtException:', (err && err.stack) || String(err)));
  process.on('unhandledRejection', (err) => logErr('unhandledRejection:', (err && (err.stack || err.message)) || String(err)));

  const loop = createStdioLoop(build);

  // Wire the aggregator's out-of-band tool-set-change signal (a background reconnect recovering — or
  // finally losing — an upstream) to notifications/tools/list_changed, so the client refreshes when a
  // dead upstream heals itself. Set on the live instance; reloadExpose re-wires the swapped-in one.
  if (build.aggregator) build.aggregator.onToolsChanged = () => emitToolsListChanged(loop.send);

  // Hot-reload: pick up expose.json / hook changes written by the tf_* tools or the UI (a separate
  // process) with NO restart and NO user intervention — the missing primitive that previously made
  // a live MCP attach or a hook change need a bounce. Auto is the default; the meta-tools/UI button
  // are just optional manual levers on top of this.
  startConfigWatchers(build, loop.send);

  logErr('ready —', SERVER_INFO.name, SERVER_INFO.version, '(pid', process.pid + ')');
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
  // The stdio entry point — an external bin/ can require this module and call main() to start the
  // server (build → connect upstreams → run the stdio loop). main() is async and takes no args.
  main,
  // Phase-2 + MATRIX handlers: handleToolsList(protocol, aggregator, { registry?, toolStatePath? })
  // and handleToolsCall(protocol, aggregator, { engine, ctx, registry?, toolStatePath? }, params).
  handleToolsList,
  handleToolsCall,
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
  PROTOCOL_VERSION,
  SERVER_INFO,
};
