'use strict';

/**
 * aggregator.js — the upstream-MCP connection + curated-expose layer.
 *
 * The aggregator is the bridge between the persisted MCP config (src/mcp/expose-store.js)
 * and the live upstream MCP servers (src/mcp/mcp-client.js). It:
 *
 *   1. CONNECTS one McpClient per ENABLED upstream in the ExposeStore (connectAll),
 *      caching the connected client + its discovered tools. A failed upstream never
 *      sinks the others — failures are collected, not thrown.
 *   2. DISCOVERS an upstream's tool surface on demand (discover) — what the MCP
 *      Manager UI's 'discover' button calls.
 *   3. Computes the CURATED-DIRECT tool definitions to advertise downstream
 *      (exposedToolDefinitions) — only for ENABLED expose[] entries whose upstream
 *      is connected AND actually advertises the named tool. Each definition is
 *      renamed to its downstream `as` name (what the CLI / PreToolUse matchers see).
 *   4. RESOLVES a downstream call back to its upstream client + real tool name
 *      (resolveExposedExecution) — the seam the MCP server's curated-direct call
 *      path uses to actually execute, AFTER the hook gate has run.
 *
 * Decoupling note: downstream the CLI sees the renamed `as` tool; upstream we call
 * the REAL tool name. resolveExposedExecution carries BOTH so the gate (PreToolUse)
 * matches on the downstream name while execution hits the real upstream.
 *
 * SAFETY CONTRACT (mirrors expose-store.js / mcp-client.js):
 *   - connectAll / discover / closeAll NEVER throw. connectAll collects per-upstream
 *     failures into failed[]; a dead/misconfigured upstream cannot crash the server
 *     start. closeAll is idempotent and tears down every cached client.
 *   - The DEFAULT clientFactory enforces the HARD ISOLATION rule: a vendored upstream
 *     may only reference CODE/FILES inside the gateway root. The
 *     guard is applied to the ARGS (the script path, db files, … that the interpreter
 *     is pointed at): any arg that is an absolute path, or that looks like a file path
 *     (contains a path separator), MUST resolve inside v3Root — otherwise the factory
 *     throws and connectAll records the upstream in failed[]. The COMMAND slot is the
 *     interpreter/executable (node, npx, or an absolute path to a node binary that by
 *     definition lives OUTSIDE the project, e.g. process.execPath / a system node.exe)
 *     and is therefore NOT subject to the in-sandbox requirement — bare commands AND an
 *     absolute interpreter path are both allowed. Isolation is about WHAT CODE runs in
 *     the spawned process, not which interpreter binary runs it; the args are that code.
 *     This is what stops a config from pointing at a live `.mcp.json` server's script
 *     outside the sandbox while still letting the system node interpreter spawn it.
 *
 * CommonJS only. Node built-ins only. No new npm dependency. No @modelcontextprotocol/sdk.
 */

const path = require('node:path');

const { McpClient } = require('./mcp-client');
const logger = require('../core/logger');

// The sandbox root, resolved exactly the way server.js does (this file lives in
// src/mcp/, so two levels up is the gateway root). Used as the isolation boundary the
// default clientFactory enforces. A caller may override via opts.v3Root for tests.
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');

/** True for a non-empty string. */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Does this argv token LOOK like a file path? An absolute path (path.isAbsolute) or
 * any token containing a path separator ('/' or '\\') is treated as a path reference
 * and must be confined to v3Root. A bare token like 'node', 'npx', 'server' or a flag
 * like '--port' is NOT a path and is always allowed.
 * @param {string} arg
 * @returns {boolean}
 */
function looksLikePath(arg) {
  if (!isNonEmptyString(arg)) return false;
  if (path.isAbsolute(arg)) return true;
  return arg.indexOf('/') !== -1 || arg.indexOf('\\') !== -1;
}

/**
 * Is `target` inside `root` (or equal to it)? Compares fully-resolved, normalised
 * absolute paths. A relative `target` is resolved AGAINST root (so 'vendor/x/server.js'
 * checks the in-sandbox location). Returns false for anything that escapes root via
 * '..' or an absolute path elsewhere on disk.
 * @param {string} root    absolute sandbox root
 * @param {string} target  path token (absolute or relative)
 * @returns {boolean}
 */
function isInside(root, target) {
  const resolvedRoot = path.resolve(root);
  // An absolute target is checked as-is; a relative one is resolved within the root so
  // a vendored relative path ('vendor/foo/server.js') is judged at its in-sandbox spot.
  const resolvedTarget = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(resolvedRoot, target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  // Inside iff the relative path neither starts with '..' nor is itself absolute
  // (an absolute `rel` happens on win32 across drive letters). '' (equal) counts as inside.
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * The DEFAULT clientFactory. Constructs a McpClient for an upstream entry AFTER
 * enforcing the isolation guard on the ARGS: every arg that looks like a file path
 * (an absolute path, or any token containing a path separator) must resolve inside
 * `v3Root`. Throws a clear 'isolation: …' error otherwise — connectAll catches that
 * into failed[].
 *
 * The COMMAND slot is intentionally NOT guarded: it names the interpreter/executable
 * (e.g. 'node', 'npx', or an absolute path to a node binary such as process.execPath /
 * a system node.exe) which by definition lives OUTSIDE the project. Isolation is about
 * WHAT CODE the spawned process runs — that is the args (the server script + any data
 * files it loads) — not which interpreter binary launches it. Guarding the command too
 * would wrongly reject every vendored upstream the moment it is run by the system node.
 *
 * @param {object} upstream  a normalised ExposeStore upstream { id, command, args, env, … }
 * @param {string} v3Root    the sandbox root the upstream's path-shaped ARGS must stay inside
 * @returns {McpClient}
 */
function defaultClientFactory(upstream, v3Root, onClose) {
  const id = isNonEmptyString(upstream && upstream.id) ? upstream.id : '(unknown)';
  const args = Array.isArray(upstream && upstream.args) ? upstream.args : [];

  // Guard every path-shaped arg (server scripts, db files, …). The command (interpreter)
  // is NOT guarded — see the function doc: it is the executable, not the code being run.
  for (const arg of args) {
    if (looksLikePath(arg) && !isInside(v3Root, arg)) {
      throw new Error(`isolation: upstream ${id} references a path outside the gateway root`);
    }
  }

  return new McpClient({
    id: upstream.id,
    command: upstream.command,
    args: upstream.args,
    env: upstream.env,
    onClose, // unexpected death → the aggregator schedules a background reconnect
  });
}

/**
 * Aggregator — owns the live upstream connections and the curated-expose computation.
 *
 * Lifecycle: `new Aggregator({ store, v3Root, clientFactory })`
 *            → `await connectAll()` (or `await discover(id)` lazily)
 *            → `exposedToolDefinitions()` / `resolveExposedExecution(name, args)`
 *            → `await closeAll()` (idempotent).
 */
class Aggregator {
  /**
   * @param {object} opts
   * @param {object} opts.store            an ExposeStore (the on-disk MCP config).
   * @param {string} [opts.v3Root]         sandbox root for the isolation guard (default: the gateway root).
   * @param {Function} [opts.clientFactory] (upstreamEntry, v3Root) -> McpClient. Default enforces isolation.
   */
  constructor({ store, v3Root, clientFactory, onToolsChanged } = {}) {
    if (!store || typeof store !== 'object') {
      throw new Error('Aggregator: a `store` (ExposeStore) is required');
    }
    this._store = store;
    this._v3Root = isNonEmptyString(v3Root) ? v3Root : DEFAULT_ROOT;
    // Called when the LIVE tool set changes OUT OF BAND (a background reconnect recovers or finally
    // loses an upstream) so the transport can emit notifications/tools/list_changed. Default no-op;
    // the server wires it to emitToolsListChanged(send). Settable so reloadExpose can re-wire the
    // new instance.
    this.onToolsChanged = typeof onToolsChanged === 'function' ? onToolsChanged : () => {};
    // The factory receives (upstream, v3Root, onClose). A caller-supplied factory may ignore the
    // extra args; the default uses v3Root for isolation and onClose for death-driven reconnect.
    this._clientFactory =
      typeof clientFactory === 'function'
        ? (upstream, onClose) => clientFactory(upstream, this._v3Root, onClose)
        : (upstream, onClose) => defaultClientFactory(upstream, this._v3Root, onClose);

    /** @type {Map<string, object>} upstreamId -> connected McpClient */
    this._clients = new Map();
    /** @type {Map<string, Array>} upstreamId -> discovered tool defs [{name,description,inputSchema}] */
    this._tools = new Map();
    /** @type {Map<string, Promise>} upstreamId -> in-flight connect promise (race guard for ensureConnected) */
    this._connecting = new Map();
    /** @type {Map<string, any>} upstreamId -> pending background-reconnect timer (one per upstream) */
    this._reconnectTimers = new Map();
    /** Set true by closeAll(). A torn-down aggregator (e.g. swapped out by reloadExpose) must NEVER
     *  (re)connect — a captured execute thunk holding this instance would otherwise spawn an orphan
     *  upstream child on it that nothing ever closes. ensureConnected/connectAll check this. */
    this._closed = false;
  }

  /**
   * Connect every ENABLED upstream in the store, caching each connected client and its
   * discovered tools. NEVER throws — a per-upstream failure (isolation guard, spawn
   * failure, handshake timeout, listTools failure) is collected into failed[]. An
   * upstream already connected (cached) is treated as connected without reconnecting.
   *
   * @returns {Promise<{ connected: string[], failed: Array<{id:string, error:string}> }>}
   */
  async connectAll() {
    const connected = [];
    const failed = [];
    if (this._closed) return { connected, failed }; // a closed (torn-down) aggregator never connects

    let upstreams;
    try {
      upstreams = this._store.listUpstreams();
    } catch (err) {
      // listUpstreams() shouldn't throw (it clones), but never let it sink connectAll.
      return { connected, failed: [{ id: '(store)', error: errMsg(err) }] };
    }

    for (const upstream of upstreams) {
      if (!upstream || upstream.enabled !== true) continue; // only ENABLED upstreams

      const id = upstream.id;
      if (this._clients.has(id)) {
        // Already connected this session — keep it; don't double-spawn.
        connected.push(id);
        continue;
      }

      try {
        await this._connectOne(upstream);
        connected.push(id);
      } catch (err) {
        // Clean up any half-built client so a failure leaves no zombie/cache entry.
        this._discard(id);
        const error = errMsg(err);
        logger.log({ type: 'mcp', event: 'connect_failed', upstream: id, error });
        failed.push({ id, error });
      }
    }

    return { connected, failed };
  }

  /**
   * Discover one upstream's tool surface. Connects the upstream if it isn't already
   * (lazily, honouring the isolation guard), runs tools/list, caches and returns the
   * raw tool definitions [{name, description, inputSchema}]. This is what the MCP
   * Manager 'discover' button calls.
   *
   * Unlike connectAll this MAY reject (it is a direct user action, so the UI wants the
   * error) — but it cleans up a failed connection so no zombie child is left.
   *
   * @param {string} upstreamId
   * @returns {Promise<Array<{name:string, description?:string, inputSchema?:object}>>}
   */
  async discover(upstreamId) {
    if (!isNonEmptyString(upstreamId)) {
      throw new Error('Aggregator.discover: upstreamId (non-empty string) is required');
    }

    // If connected already, re-list so the discover button always reflects live state.
    if (this._clients.has(upstreamId)) {
      const tools = await this._listAndCache(upstreamId);
      return tools;
    }

    const upstream = this._store.getUpstream(upstreamId);
    if (!upstream) {
      throw new Error(`Aggregator.discover: unknown upstream "${upstreamId}"`);
    }

    try {
      await this._connectOne(upstream);
    } catch (err) {
      this._discard(upstreamId);
      throw new Error(`Aggregator.discover: cannot connect "${upstreamId}": ${errMsg(err)}`);
    }
    // _connectOne already cached the tools; return them (clone so callers can't mutate).
    return cloneTools(this._tools.get(upstreamId) || []);
  }

  /**
   * @returns {Object<string, Array>} a clone map of upstreamId -> cached discovered tools.
   * Only includes upstreams that have been connected/discovered this session.
   */
  toolsByUpstream() {
    const out = {};
    for (const [id, tools] of this._tools) {
      out[id] = cloneTools(tools);
    }
    return out;
  }

  /**
   * The CURATED-DIRECT tool definitions to advertise downstream. For each ENABLED
   * expose[] entry whose upstream is CONNECTED and ACTUALLY advertises the named tool:
   *   - name        = store.exposedName(entry)  (the downstream `as` name)
   *   - description = '[' + upstream + '] ' + (upstream tool description || 'tool')
   *   - inputSchema = the upstream tool's inputSchema || { type:'object' }
   *
   * Entries whose upstream isn't connected, or whose named tool the upstream doesn't
   * advertise, are silently skipped (you can't expose a tool that isn't there).
   *
   * @returns {Array<{name:string, description:string, inputSchema:object}>}
   */
  exposedToolDefinitions() {
    const defs = [];
    let exposed;
    try {
      exposed = this._store.listExposed({ enabledOnly: true });
    } catch (_err) {
      return defs; // never throw out of a definition build
    }

    for (const e of exposed) {
      if (!e || !this._clients.has(e.upstream)) continue; // upstream not connected
      const upstreamTools = this._tools.get(e.upstream) || [];
      const upstreamTool = upstreamTools.find((t) => t && t.name === e.tool);
      if (!upstreamTool) continue; // upstream doesn't actually advertise this tool

      const name = this._store.exposedName(e);
      const desc =
        isNonEmptyString(upstreamTool.description) ? upstreamTool.description : 'tool';
      const inputSchema =
        upstreamTool.inputSchema && typeof upstreamTool.inputSchema === 'object'
          ? upstreamTool.inputSchema
          : { type: 'object' };

      defs.push({
        name,
        description: `[${e.upstream}] ${desc}`,
        inputSchema: cloneJson(inputSchema),
      });
    }
    return defs;
  }

  /**
   * Is `name` a downstream `as` name currently exposed (enabled) AND backed by a
   * connected upstream that advertises the underlying tool? Mirrors the set
   * exposedToolDefinitions() advertises.
   * @param {string} name
   * @returns {boolean}
   */
  isExposed(name) {
    return this._findExposedExecution(name) !== null;
  }

  /**
   * Resolve a downstream `as` name + args into an executor. Returns
   *   { execute, toolName, upstream }  | null
   * where:
   *   - execute()  invokes the connected client's callTool(<real upstream tool name>, args)
   *   - toolName   = the downstream `as` (what PreToolUse matchers see — the gate matches
   *                  the downstream name, execution hits the real upstream tool)
   *   - upstream   = the upstream id
   * Returns null if `name` is not exposed/enabled or its upstream isn't connected.
   *
   * @param {string} name  downstream `as` name
   * @param {any}    args   structured arguments forwarded verbatim to callTool
   * @returns {{ execute: Function, toolName: string, upstream: string } | null}
   */
  resolveExposedExecution(name, args) {
    const hit = this._findExposedExecution(name);
    if (!hit) return null;
    const { client, realTool, upstream, exposedName } = hit;
    return {
      // The execute thunk is the seam the server calls AFTER the PreToolUse gate allows it.
      execute: this._forwardExecutor(client, realTool, args),
      toolName: exposedName, // downstream name — the gate's matcher target
      upstream,
    };
  }

  // ── lean register forwarding (slice 2) ──────────────────────────────────────
  // The LEAN path surfaces an attached upstream's tools through the 4 meta-tools (toolfunnel_list_tools
  // / _tool_instructions / _run_tool) instead of injecting them top-level every turn. The full
  // discovered set of every CONNECTED + enabled upstream is surfaced (attaching an MCP makes its
  // tools appear with no per-tool curation); expose[]/hot governs only the SEPARATE top-level
  // (curated-direct) promotion. A lean tool is surfaced under its enabled expose `as` if one exists,
  // else the namespaced default `<upstream>_<tool>` — so the lean name equals the curated-direct name
  // for an exposed tool and ONE PreToolUse rule gates both routes. All of this lives here in the
  // aggregator (it owns the connections, the _clients/_tools caches, and the connect log chokepoint).

  /**
   * The single forward seam: a thunk that calls the upstream's real tool. Shared by the
   * curated-direct path (resolveExposedExecution, transparent envelope passthrough) and the lean
   * path (resolveLeanExecution, which unwraps). Kept tiny so both routes execute identically.
   * @param {object} client   a connected McpClient
   * @param {string} realTool the upstream's own tool name
   * @param {any}    args
   * @returns {() => Promise<any>}
   */
  _forwardExecutor(client, realTool, args) {
    return () => client.callTool(realTool, args);
  }

  /**
   * The downstream name a discovered upstream tool is surfaced under: its ENABLED expose `as` if one
   * exists for (upstream, tool), else the namespaced default `<upstream>_<tool>` (matching
   * expose-store.exposedName). Keeps the lean list and the lean run path in agreement, and aligns an
   * exposed tool's lean name with its curated-direct top-level name. Never throws.
   * @param {string} upstreamId
   * @param {string} toolName
   * @returns {string}
   */
  _surfacedName(upstreamId, toolName) {
    try {
      const exposed = this._store.listExposed({ enabledOnly: true });
      for (const e of exposed) {
        if (e && e.upstream === upstreamId && e.tool === toolName) return this._store.exposedName(e);
      }
    } catch (_e) {
      /* fall through to the default */
    }
    return `${upstreamId}_${toolName}`;
  }

  /**
   * Connect an upstream ON DEMAND and return the ready McpClient. Idempotent + race-safe:
   *   - fast path: a cached client that is still `connected` is returned as-is; a cached-but-DEAD
   *     client (its child exited — McpClient flips `connected` but stays in the cache) is logged as a
   *     disconnect, discarded, and reconnected — a reconnect re-lists the upstream's tools.
   *   - concurrent callers JOIN the same in-flight connect promise (keyed in _connecting), which
   *     resolves only AFTER _listAndCache — so no caller ever sees the half-built client that
   *     _connectOne caches BEFORE the handshake completes (the double-spawn / mid-handshake race).
   * Throws on an unknown/disabled upstream or a connect/list failure (the caller surfaces it; for the
   * lean run path that means gatedRun returns { ok:false, error } cleanly).
   * @param {string} upstreamId
   * @returns {Promise<object>} the connected McpClient
   */
  async ensureConnected(upstreamId, opts) {
    if (!isNonEmptyString(upstreamId)) throw new Error('Aggregator.ensureConnected: upstreamId (non-empty string) is required');
    // allowConnect:false (the RUN path) must NEVER block on a connect — not a from-scratch connect
    // (connect()+tools/list, ~20s, would freeze the serialized stdio chain and starve pings) AND not
    // by JOINING an in-flight background reconnect (same latency). It returns a live client or fails
    // clean; the background reconnect owns recovery and the run retries next turn. allowConnect
    // defaults true (the background path connects / joins).
    const allowConnect = !(opts && opts.allowConnect === false);
    // A torn-down aggregator (swapped out by reloadExpose, then closeAll'd) must NEVER (re)connect:
    // a captured execute thunk holding this instance would otherwise spawn an ORPHAN child on it.
    if (this._closed) throw new Error('Aggregator.ensureConnected: aggregator is closed (config reloaded) — retry on the current one');

    // Fast path: a live cached client serves BOTH modes immediately.
    const existing = this._clients.get(upstreamId);
    if (existing) {
      const alive = typeof existing.connected === 'boolean' ? existing.connected : true;
      if (alive) return existing;
      // Dead cached client. The RUN path fails clean (never (re)connects); the background path drops
      // it and reconnects below.
      if (!allowConnect) {
        throw new Error(`Aggregator.ensureConnected: upstream "${upstreamId}" disconnected (reconnecting in background)`);
      }
      logger.log({ type: 'mcp', event: 'disconnect', upstream: upstreamId, reason: 'stale' });
      this._discard(upstreamId);
    } else if (!allowConnect) {
      // Not connected. The RUN path neither connects NOR joins an in-flight connect — joining would
      // block the stdio chain for the connect+list latency (the head-of-line freeze this mode avoids).
      throw new Error(`Aggregator.ensureConnected: upstream "${upstreamId}" is not connected (reconnecting in background)`);
    }

    // Background path only (allowConnect): join an in-flight connect, else connect from scratch. The
    // _connecting promise resolves only AFTER _listAndCache, so _connectOne caching the client before
    // its handshake completes never exposes a half-built client to a joiner.
    if (this._connecting.has(upstreamId)) return this._connecting.get(upstreamId);

    const upstream = this._store.getUpstream(upstreamId);
    if (!upstream) throw new Error(`Aggregator.ensureConnected: unknown upstream "${upstreamId}"`);
    if (upstream.enabled !== true) throw new Error(`Aggregator.ensureConnected: upstream "${upstreamId}" is disabled`);

    const promise = (async () => {
      await this._connectOne(upstream); // caches client + tools, logs the connect
      return this._clients.get(upstreamId);
    })();
    this._connecting.set(upstreamId, promise);
    try {
      return await promise;
    } catch (err) {
      this._discard(upstreamId); // reap the half-spawned child; leave no zombie/cache entry
      throw err;
    } finally {
      this._connecting.delete(upstreamId);
    }
  }

  /**
   * UNEXPECTED upstream death (fired by McpClient.onClose). Log it, drop the dead client so it
   * leaves the lean list, tell the client the tool set shrank, then schedule a BACKGROUND reconnect.
   * Keeping recovery off the serialized stdio chain is what closes the head-of-line regression: a run
   * during the down-window fails clean (ensureConnected allowConnect:false) instead of blocking.
   * @param {string} upstreamId
   */
  _handleUpstreamDown(upstreamId) {
    if (this._closed) return;
    logger.log({ type: 'mcp', event: 'disconnect', upstream: upstreamId, reason: 'died' });
    this._discard(upstreamId); // remove the dead client + its tools → drops from the lean list
    this._signalToolsChanged(upstreamId); // list_changed only if the upstream is on the top-level surface
    this._scheduleReconnect(upstreamId, 0);
  }

  /**
   * Does this upstream contribute to the TOP-LEVEL tools/list (i.e. has an ENABLED expose[] entry)?
   * Only then does its death/recovery change tools/list and warrant a notifications/tools/list_changed.
   * A lean-only upstream's tools live behind toolfunnel_list_tools (pulled per call), so notifying for
   * one is spurious (the client re-fetches and sees no diff). Never throws.
   * @param {string} upstreamId
   * @returns {boolean}
   */
  _affectsTopLevel(upstreamId) {
    try {
      return this._store.listExposed({ enabledOnly: true }).some((e) => e && e.upstream === upstreamId);
    } catch (_e) {
      return false;
    }
  }

  /** Fire onToolsChanged ONLY when the upstream is actually on the top-level surface (else the
   *  notification is spurious — its lean tools refresh on the next toolfunnel_list_tools). Never throws. */
  _signalToolsChanged(upstreamId) {
    if (!this._affectsTopLevel(upstreamId)) return;
    try { this.onToolsChanged(); } catch (_e) { /* never throw out of an event handler */ }
  }

  /**
   * Schedule ONE background reconnect attempt with exponential backoff: 1s,2s,4s,8s,16s, then capped
   * at 30s. After the fast phase it does NOT give up — it falls back to a slow 30s keepalive so a long
   * transient outage still self-heals (a detached/disabled upstream stops it via getUpstream; closeAll
   * stops it via _closed). On success the tools are re-listed and a top-level change is signalled. One
   * timer per upstream (no pile-up); the timer is unref'd so it never keeps the process alive. NEVER throws.
   * @param {string} upstreamId
   * @param {number} attempt
   */
  _scheduleReconnect(upstreamId, attempt) {
    if (this._closed) return;
    if (this._reconnectTimers.has(upstreamId)) return; // a reconnect is already pending for this id
    const upstream = this._store.getUpstream(upstreamId);
    if (!upstream || upstream.enabled !== true) return; // detached/disabled — stop trying
    const MAX_FAST_ATTEMPTS = 6; // exponential phase; beyond it, a slow keepalive at the 30s cap
    if (attempt === MAX_FAST_ATTEMPTS) {
      logger.log({ type: 'mcp', event: 'reconnect_slow', upstream: upstreamId, attempts: attempt });
    }
    const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
    const timer = setTimeout(async () => {
      this._reconnectTimers.delete(upstreamId);
      if (this._closed) return;
      const u = this._store.getUpstream(upstreamId);
      if (!u || u.enabled !== true) return;
      try {
        await this.ensureConnected(upstreamId); // allowConnect default — connects + re-lists, off-chain
        logger.log({ type: 'mcp', event: 'reconnect', upstream: upstreamId, attempt });
        this._signalToolsChanged(upstreamId);
      } catch (err) {
        logger.log({ type: 'mcp', event: 'reconnect_failed', upstream: upstreamId, attempt, error: errMsg(err) });
        // Keep escalating to the cap, then keep retrying slowly (cap the counter so the delay stays
        // at 30s) — never permanently give up while the upstream stays enabled.
        this._scheduleReconnect(upstreamId, Math.min(attempt + 1, MAX_FAST_ATTEMPTS));
      }
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    this._reconnectTimers.set(upstreamId, timer);
  }

  /**
   * The LEAN tool definitions: every discovered tool of every CONNECTED + enabled upstream, surfaced
   * for toolfunnel_list_tools. Each: { name, description, inputSchema, upstream, tool }. The FULL
   * discovered set (not just expose[]) — attaching an MCP makes its tools appear leanly with no
   * curation. Only connected upstreams contribute (we need their real schemas); a not-yet-connected
   * upstream's tools simply appear once it connects (the next list call reflects it — no
   * notification needed, the lean surface is delivered inside a per-call meta-tool). Never throws.
   * @returns {Array<{name:string, description:string, inputSchema:object, upstream:string, tool:string}>}
   */
  leanToolDefinitions() {
    const defs = [];
    const seen = new Set(); // surfaced-name collision guard — the list must agree with resolve (first wins)
    try {
      for (const [upstreamId, tools] of this._tools) {
        if (!this._clients.has(upstreamId)) continue; // connected only
        const upstream = this._store.getUpstream(upstreamId);
        if (upstream && upstream.enabled === false) continue; // skip an explicitly-disabled upstream
        if (!Array.isArray(tools)) continue;
        for (const t of tools) {
          if (!t || !isNonEmptyString(t.name)) continue;
          const name = this._surfacedName(upstreamId, t.name);
          if (seen.has(name)) {
            // Two tools collapse to one surfaced name (underscore ambiguity, or a duplicate `as`).
            // resolveLeanExecution returns the FIRST match, so advertise only the first — the list
            // must never show a name that resolves to a different tool. Log the shadowing.
            logger.log({ type: 'mcp', event: 'name_collision', upstream: upstreamId, tool: t.name, surfaced: name });
            continue;
          }
          seen.add(name);
          const schema = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object' };
          defs.push({
            name,
            description: isNonEmptyString(t.description) ? t.description : '',
            inputSchema: cloneJson(schema),
            upstream: upstreamId,
            tool: t.name,
          });
        }
      }
    } catch (_e) {
      /* never throw out of a definition build — return what we have */
    }
    return defs;
  }

  /**
   * Resolve a lean downstream name + args into a forwarding executor for toolfunnel_run_tool. Matches
   * by ITERATION over discovered tools (computing each tool's surfaced name) — never by parsing the
   * name (underscore-ambiguous). The execute thunk lazy-(re)connects via ensureConnected and UNWRAPS
   * the upstream MCP envelope to a clean payload, so run_tool returns the upstream's content (e.g.
   * "pong"), not a stringified envelope. The connect is INSIDE the thunk → a PreToolUse deny spawns
   * nothing. The gate matches `toolName` (the surfaced name). Returns null if no connected upstream
   * advertises a tool with this surfaced name (→ protocol's clean "not runnable" error).
   * @param {string} name surfaced downstream name
   * @param {any}    args
   * @returns {{ execute: () => Promise<any>, toolName: string, upstream: string } | null}
   */
  resolveLeanExecution(name, args) {
    if (!isNonEmptyString(name)) return null;
    for (const [upstreamId, tools] of this._tools) {
      if (!this._clients.has(upstreamId)) continue;
      if (!Array.isArray(tools)) continue;
      for (const t of tools) {
        if (!t || !isNonEmptyString(t.name)) continue;
        if (this._surfacedName(upstreamId, t.name) !== name) continue;
        const realTool = t.name;
        const self = this;
        const execute = async () => {
          // allowConnect:false — the run path NEVER synchronously (re)connects (that would freeze the
          // stdio loop, starving pings). It uses a live client or joins an in-flight background
          // reconnect, else fails clean; the onClose-driven background reconnect owns recovery.
          const client = await self.ensureConnected(upstreamId, { allowConnect: false });
          const envelope = await client.callTool(realTool, args);
          // Preserve the upstream's failure signal. callTool RESOLVES even on isError:true, so a
          // failed upstream call must become a THROW → gatedRun returns { ok:false } → run_tool
          // surfaces isError:true. Otherwise a failed call would be reported as success — and the
          // lean path must agree with curated-direct's isError passthrough.
          const payload = unwrapEnvelope(envelope);
          if (envelope && typeof envelope === 'object' && envelope.isError === true) {
            const text = typeof payload === 'string' ? payload : safeStringify(payload);
            const err = new Error(text && text.length ? text : 'upstream tool reported an error');
            err.upstreamToolError = true;
            throw err;
          }
          return payload;
        };
        return { execute, toolName: name, upstream: upstreamId };
      }
    }
    return null;
  }

  /**
   * Close every cached client and clear the caches. Idempotent — safe to call twice and
   * safe when nothing was ever connected. NEVER throws (close() on McpClient never throws).
   * @returns {Promise<void>}
   */
  async closeAll() {
    this._closed = true; // latch BEFORE teardown so any in-flight execute thunk refuses to re-spawn
    for (const [, timer] of this._reconnectTimers) {
      try { clearTimeout(timer); } catch (_e) { /* ignore */ }
    }
    this._reconnectTimers.clear();
    for (const [id, client] of this._clients) {
      try {
        if (client && typeof client.close === 'function') client.close();
        // Activity log (self-gating): the disconnect half. A reload closes the old aggregator here,
        // so a reconnect reads as a disconnect line followed by a connect line for the same id.
        logger.log({ type: 'mcp', event: 'disconnect', upstream: id });
      } catch (_e) {
        /* McpClient.close never throws, but never let teardown sink the loop */
      }
    }
    this._clients.clear();
    this._tools.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Connect a single upstream entry and cache the client + its discovered tools.
   * Throws on factory (isolation), connect, or listTools failure — callers decide
   * whether to collect (connectAll) or surface (discover) the error. On throw, the
   * caller is responsible for _discard()-ing the id.
   * @param {object} upstream  a normalised ExposeStore upstream
   */
  async _connectOne(upstream) {
    // The factory may throw (isolation guard) — that propagates out as a connect failure. Pass an
    // onClose so an UNEXPECTED upstream death triggers a BACKGROUND reconnect (not a lazy one in the
    // run path, which would freeze the stdio chain).
    const client = this._clientFactory(upstream, () => this._handleUpstreamDown(upstream.id));
    if (!client || typeof client.connect !== 'function') {
      throw new Error(`clientFactory returned an invalid client for "${upstream.id}"`);
    }
    // Cache the client BEFORE connect so a connect-failure path can still _discard() and
    // close any half-spawned child.
    this._clients.set(upstream.id, client);
    await client.connect();
    await this._listAndCache(upstream.id);
    // Activity log (self-gating; no-op unless logging is enabled): the upstream half of connect
    // logging. EVERY connect flows through here — startup connectAll, a live reload, a lazy
    // discover, and (later) a health-driven reconnect — so all of them are logged uniformly.
    logger.log({
      type: 'mcp',
      event: 'connect',
      upstream: upstream.id,
      command: upstream.command,
      tools: (this._tools.get(upstream.id) || []).length,
    });
  }

  /** tools/list one connected upstream and cache the result; returns a clone. */
  async _listAndCache(upstreamId) {
    const client = this._clients.get(upstreamId);
    if (!client) throw new Error(`no connected client for "${upstreamId}"`);
    const tools = await client.listTools();
    const safe = Array.isArray(tools) ? tools.filter((t) => t && isNonEmptyString(t.name)) : [];
    this._tools.set(upstreamId, safe);
    return cloneTools(safe);
  }

  /** Tear down + forget a cached client (used on a failed connect). Never throws. */
  _discard(upstreamId) {
    const client = this._clients.get(upstreamId);
    if (client && typeof client.close === 'function') {
      try { client.close(); } catch (_e) { /* never throw */ }
    }
    this._clients.delete(upstreamId);
    this._tools.delete(upstreamId);
  }

  /**
   * Shared lookup behind isExposed / resolveExposedExecution: find the ENABLED expose
   * entry whose downstream name === `name`, whose upstream is connected, and whose real
   * tool the upstream advertises. Returns the resolution context or null.
   * @param {string} name
   * @returns {{ client:object, realTool:string, upstream:string, exposedName:string } | null}
   */
  _findExposedExecution(name) {
    if (!isNonEmptyString(name)) return null;
    let exposed;
    try {
      exposed = this._store.listExposed({ enabledOnly: true });
    } catch (_err) {
      return null;
    }
    for (const e of exposed) {
      if (!e) continue;
      if (this._store.exposedName(e) !== name) continue;
      const client = this._clients.get(e.upstream);
      if (!client) continue; // upstream not connected
      const upstreamTools = this._tools.get(e.upstream) || [];
      if (!upstreamTools.some((t) => t && t.name === e.tool)) continue; // tool not advertised
      return { client, realTool: e.tool, upstream: e.upstream, exposedName: name };
    }
    return null;
  }
}

// ── small helpers (no external deps) ───────────────────────────────────────────

/** Extract a clean message from any thrown value. */
function errMsg(err) {
  return (err && err.message) || String(err);
}

/** JSON.stringify that never throws (circular/oddball values fall back to String). */
function safeStringify(value) {
  try { return JSON.stringify(value); } catch (_e) { return String(value); }
}

/**
 * Turn an upstream MCP tools/call envelope { content:[...], isError? } into a clean payload for the
 * LEAN run path. A single text block -> its string (so toolfunnel_run_tool returns "pong", matching
 * what the curated-direct content passthrough surfaces); otherwise the content array; otherwise the
 * value as-is when it isn't an envelope. This is what avoids double-wrapping the envelope as JSON
 * inside wrapProtocolResult (the curated-direct path passes the envelope through transparently
 * instead; the lean path goes through protocol.runTool -> wrapProtocolResult, so it unwraps here).
 * NOTE (slice 2): an upstream isError:true is surfaced as its text content with ok:true (homogeneous
 * with how local tools surface error text) — mapping isError -> ok:false is a later concern.
 * @param {*} envelope
 * @returns {*}
 */
function unwrapEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return envelope;
  const content = envelope.content;
  if (Array.isArray(content)) {
    if (content.length === 1 && content[0] && content[0].type === 'text' && typeof content[0].text === 'string') {
      return content[0].text;
    }
    return content;
  }
  return envelope;
}

/** Plain-JSON deep clone (schemas are JSON; structuredClone may be absent on old node). */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Clone an array of tool defs so callers can't mutate the aggregator's cache. */
function cloneTools(tools) {
  return Array.isArray(tools) ? tools.map((t) => cloneJson(t)) : [];
}

module.exports = {
  Aggregator,
  // exported for unit tests / reuse
  defaultClientFactory,
  looksLikePath,
  isInside,
  unwrapEnvelope,
  DEFAULT_ROOT,
};
