'use strict';

/**
 * mcp-client.js - the MCP CLIENT (architecture notes §1, §7; Phase 2 aggregator).
 *
 * This is the REVERSE of src/mcp/server.js. Where server.js is a JSON-RPC 2.0
 * server that the CLI connects TO, this is a JSON-RPC 2.0 client that spawns an
 * UPSTREAM MCP server as a child process and talks to it over stdio. The Phase 2
 * aggregator owns one McpClient per upstream MCP server, lists their tools, and
 * routes curated calls through them.
 *
 * Transport contract (mirrors server.js's framing helpers but in the other direction):
 *   WRITE: newline-delimited JSON - one compact message per line, which is what real
 *          SDK-based MCP servers read on stdin (Content-Length framing silently broke
 *          every real upstream - see frameRequest()).
 *   READ:  tolerate BOTH `Content-Length:` framing AND newline-delimited JSON, so the
 *          same client works against a real MCP server AND against our own server.js
 *          (which WRITES newline-delimited JSON). This is server.js's dual-drain logic
 *          re-used in the client.
 *
 * JSON-RPC requests are matched to responses by `id`. Every request carries a
 * timeout (requestTimeoutMs) - a slow/dead upstream rejects the in-flight promise
 * instead of leaking it. Notifications (no `id`) from the server are ignored.
 *
 * SAFETY / defensiveness:
 *   - close() is idempotent and NEVER leaves a zombie child: it ends stdin, then if the
 *     child is still alive tree-kills it (win32: taskkill /T /F; else child.kill()).
 *   - connect() that fails (spawn error or initialize timeout) calls close() so no child
 *     is left running, then rejects with a clear error.
 *   - A child that exits while requests are in flight rejects every waiter (no hang).
 *   - spawnImpl is injectable so a unit test can fake the child, but the real round-trip
 *     against the fixture is the load-bearing test.
 *
 * CommonJS only. Node built-ins only. No @modelcontextprotocol/sdk.
 */

const childProcess = require('node:child_process');
const path = require('node:path');

const JSONRPC = '2.0';
const PROTOCOL_VERSION = '2024-11-05';
// The 2026-07-28 ("modern") protocol version this client can SPEAK to a modern upstream. Over
// stdio the modern era needs only per-request `_meta` - the Mcp-Method/Mcp-Name/MCP-Protocol-Version
// headers are HTTP-transport-only, so a stdio client is modern by adding `_meta` + skipping the
// initialize handshake. Built to the RC spec (locked 2026-05-21); reconcile minor final deltas 28 July.
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const CLIENT_INFO = Object.freeze({ name: 'toolfunnel', version: '3.0.0-client' });

/**
 * Cross-platform launch resolution for the upstream command.
 *
 * POSIX: pass through unchanged - execvp resolves `npx` / `uvx` / `node` / ... on PATH.
 *
 * Windows: child_process with shell:false CANNOT run a `.cmd` / `.bat` shim - a bare name ENOENTs,
 * and an explicit `.cmd` throws EINVAL (the CVE-2024-27980 mitigation). Most MCP servers launch via
 * exactly such shims (`npx`, `npm`, `uvx`, `pnpm`, ...), so on Windows route anything that isn't already
 * a concrete `.exe`/`.com` through cmd.exe, which resolves PATHEXT shims. The args stay DISCRETE
 * (never shell-concatenated into one string) and there is none of the `shell:true` DEP0190 hazard.
 * HONEST CAVEAT: because the spawned binary here is cmd.exe itself (an .exe), Node applies its
 * STANDARD argv quoting - not cmd.exe ^-metacharacter escaping (that special-casing only fires when
 * the command IS the .cmd/.bat). An arg containing cmd metacharacters (& | > < ") outside quotes can
 * therefore still be reinterpreted by cmd.exe. These args come from the operator's own expose.json,
 * so this is a correctness caveat on operator-authored config, not a privilege boundary; the fully
 * escaped alternative (resolve the real interpreter à la auth/install.js's `node + npm-cli.js` and
 * spawn it directly) is the upgrade path if it ever bites. close()'s taskkill /T still reaps the
 * whole cmd -> shim -> server process tree.
 *
 * @param {string} command  the configured upstream command (e.g. "npx", "node", an abs path)
 * @param {string[]} args   the configured argv
 * @returns {{ command: string, args: string[] }} what to actually hand to spawn()
 */
function winLaunch(command, args) {
  const argv = Array.isArray(args) ? args : [];
  if (process.platform !== 'win32') return { command, args: argv };
  // A concrete executable can be spawned directly - no shim resolution needed.
  if (path.isAbsolute(command) && /\.(exe|com)$/i.test(command)) return { command, args: argv };
  // Otherwise hand it to cmd.exe, which resolves the .cmd/.bat shim via PATHEXT.
  const comspec = process.env.ComSpec || 'cmd.exe';
  return { command: comspec, args: ['/c', command, ...argv] };
}

/**
 * McpClient - a hand-rolled JSON-RPC 2.0 client over a child process's stdio.
 *
 * Lifecycle: `new McpClient(opts)` -> `await connect()` -> `listTools()` / `callTool()`
 *            -> `close()` (idempotent).
 */
// Payload-bearing methods get the LONG window (toolTimeoutMs): a tool call legitimately runs as
// long as the tool runs. Everything else (handshake, lists, discover, ping) keeps the SHORT
// requestTimeoutMs - that is the dead-upstream detector.
const PAYLOAD_METHODS = new Set(['tools/call', 'prompts/get', 'resources/read']);

class McpClient {
  /**
   * @param {object} opts
   * @param {string} [opts.id]                 caller-chosen id for this upstream (diagnostics only)
   * @param {string} opts.command              executable to spawn (e.g. process.execPath)
   * @param {string[]} [opts.args]             argv for the child (e.g. [serverPath])
   * @param {object} [opts.env]                extra env merged over process.env for the child
   * @param {string} [opts.cwd]                child working directory
   * @param {Function} [opts.spawnImpl]        injectable spawn (default node:child_process.spawn)
   * @param {number} [opts.requestTimeoutMs]   control-plane timeout in ms (default 10000) -
   *                                           handshake/list/discover/ping; the dead-upstream detector
   * @param {number} [opts.toolTimeoutMs]      PAYLOAD timeout in ms (default 120000) for
   *                                           tools/call | prompts/get | resources/read; a
   *                                           token-matched progress beat re-arms it
   * @param {Function} [opts.onClose]          called ONCE if the child dies UNEXPECTEDLY (exit/error
   *                                           while not deliberately close()d). Lets the owner
   *                                           (the aggregator) schedule a background reconnect.
   */
  constructor({ id, command, args = [], env = {}, cwd, spawnImpl, requestTimeoutMs, toolTimeoutMs, onClose, forceLegacy = false, modernOnly = false, onNotification, clientInfo } = {}) {
    if (typeof command !== 'string' || command.length === 0) {
      throw new Error('McpClient: "command" (non-empty string) is required');
    }
    this.id = typeof id === 'string' && id.length ? id : 'mcp-client';
    // clientInfo: the identity this client PRESENTS to the upstream (legacy initialize and the
    // modern _meta trio). Defaults to the built-in - absent the opt, wire behaviour is byte-identical
    // to before. The wrap's identity mirroring hands the REAL downstream client's info through here.
    // The FULL object is carried (title etc.), not a name/version whitelist - the wrap's serverInfo
    // direction proved a whitelist silently eats spec fields.
    this._clientInfo =
      clientInfo && typeof clientInfo === 'object' &&
      typeof clientInfo.name === 'string' && clientInfo.name.length
        ? Object.freeze(Object.assign({}, clientInfo, {
            version: typeof clientInfo.version === 'string' ? clientInfo.version : '0.0.0',
          }))
        : CLIENT_INFO;
    this._command = command;
    this._args = Array.isArray(args) ? args.slice() : [];
    this._env = env && typeof env === 'object' ? env : {};
    this._cwd = cwd;
    this._spawn = typeof spawnImpl === 'function' ? spawnImpl : childProcess.spawn;
    this._requestTimeoutMs =
      Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 10000;
    // An EXPLICITLY configured control window also governs the era probe in connect(): the
    // operator opted into slower connects for a slow-boot upstream, and the probe must not
    // quietly undo that (a slow-boot modern-only server could otherwise never attach).
    this._explicitRequestTimeout = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0;
    // The PAYLOAD window (tools/call | prompts/get | resources/read): a tool legitimately runs
    // as long as the tool runs - the fixed 10 s window hard-killed every wrapped tool slower
    // than that and silently dropped the upstream's eventual result. Per-upstream
    // `timeoutMs` config lands here; a token-matched progress beat re-arms the window.
    this._toolTimeoutMs =
      Number.isFinite(toolTimeoutMs) && toolTimeoutMs > 0 ? toolTimeoutMs : 120000;
    this._onClose = typeof onClose === 'function' ? onClose : null;
    // forceLegacy (legacyPin): skip the modern server/discover probe and speak legacy unconditionally.
    this._forceLegacy = forceLegacy === true;
    // modernOnly: the MIRROR of legacyPin - refuse the legacy fallback entirely. A modernOnly
    // upstream that does not answer server/discover with the modern protocol FAILS the connect
    // with a clear error instead of silently negotiating down (era-policy switches, 2026-07-18).
    this._modernOnly = modernOnly === true;
    // onNotification: called with each server-initiated NOTIFICATION (a message with a method and
    // NO id) - e.g. notifications/resources/updated, .../resources/list_changed, .../prompts/
    // list_changed, .../tools/list_changed. Lets the aggregator bridge upstream change-notifications
    // to a modern client's subscriptions/listen stream. Settable post-construction too.
    this.onNotification = typeof onNotification === 'function' ? onNotification : null;
    // onServerRequest: called with each SERVER-INITIATED REQUEST (a message with a method AND an
    // id - elicitation/create, sampling/createMessage, roots/list). The owner answers it via
    // respondToServer/respondToServerError. Unset -> every such request is answered -32601, so a
    // conformant upstream is never left holding an unanswered request (Bridge B infrastructure).
    this.onServerRequest = null;
    this._onCloseFired = false; // onClose fires at most once, and never for a deliberate close()
    this._everConnected = false; // true once the handshake completed - onClose fires ONLY for the
    //                              death of an ESTABLISHED connection, never a connect-time failure

    // Transport state.
    this._child = null;
    this._connected = false;
    this._closed = false;
    this._buf = Buffer.alloc(0);
    this._stderr = '';
    this._nextId = 1;
    /** @type {Map<number|string, {resolve:Function, reject:Function, timer:any, method:string}>} */
    this._waiters = new Map();

    // The initialize result, captured for connect()'s return value.
    this._initializeResult = null;
  }

  /** @returns {boolean} true once the initialize handshake has completed and not yet closed. */
  get connected() {
    return this._connected === true && this._closed === false;
  }

  /** @returns {object|null} the upstream's raw `initialize` result ({ protocolVersion, serverInfo,
   *  capabilities, instructions }) captured at connect. Used by the passthrough WRAP to present the
   *  wrapped server's OWN identity (a wrapped MCP must be indistinguishable from the real thing). */
  get initializeResult() {
    return this._initializeResult;
  }

  /**
   * Raw JSON-RPC passthrough for the WRAP: forward a method to the upstream verbatim and return its
   * result. Used to relay non-tool methods (resources/*, prompts/*, logging/*, ping...) so a wrapped
   * server behaves exactly as it would connected directly. Tool calls do NOT use this - they go
   * through the gated forward path. Rejects on timeout / transport failure (same as callTool).
   * @param {string} method
   * @param {any} [params]
   * @returns {Promise<any>} the upstream's raw result
   */
  async request(method, params, out) {
    if (typeof method !== 'string' || method.length === 0) {
      throw new Error('McpClient.request: "method" (non-empty string) is required');
    }
    let p = params == null ? {} : params;
    // Modern upstream: ensure the per-request `_meta` protocol trio is present. MERGE with any
    // caller-supplied _meta (progressToken, trace keys survive a wrap forward) - the trio wins on
    // collision; a partial caller _meta must never reach a strict modern upstream trio-less.
    if (this._modern && p && typeof p === 'object' && !Array.isArray(p)) {
      const callerMeta = (p._meta && typeof p._meta === 'object' && !Array.isArray(p._meta)) ? p._meta : null;
      p = Object.assign({}, p, { _meta: Object.assign({}, callerMeta, this._modernMeta()) });
    }
    return await this._request(method, p, out);
  }

  /**
   * Send a NOTIFICATION to the upstream - no id, no waiter, no reply. Used by a wrap to relay
   * client notifications (notifications/cancelled, notifications/progress ...) that a
   * directly-connected server would receive. Fire-and-forget; NEVER throws.
   * @param {string} method
   * @param {any}    params
   */
  notify(method, params) {
    try {
      if (this._closed || !this._child || !this._child.stdin) return;
      if (typeof method !== 'string' || method.length === 0) return;
      const payload = { jsonrpc: JSONRPC, method };
      if (params !== undefined) payload.params = params;
      this._child.stdin.write(frameRequest(payload));
    } catch (_e) { /* fire-and-forget */ }
  }

  /**
   * Answer a SERVER-INITIATED request (Bridge B): write a JSON-RPC RESPONSE carrying the
   * upstream's own request id. Fire-and-forget; NEVER throws.
   * @param {number|string} id  the id the UPSTREAM used on its request
   * @param {any} result        the result payload (e.g. an ElicitResult { action, content })
   */
  respondToServer(id, result) {
    try {
      if (this._closed || !this._child || !this._child.stdin) return;
      if (id === undefined || id === null) return;
      this._child.stdin.write(frameRequest({ jsonrpc: JSONRPC, id, result: result === undefined ? {} : result }));
    } catch (_e) { /* fire-and-forget */ }
  }

  /**
   * Extend the timeout of an in-flight request (Bridge B): a mid-call elicitation proves the
   * upstream is alive and deliberately holding the call open while a HUMAN answers - the normal
   * dead-upstream timeout must not kill the suspension. Re-arms the waiter's timer; returns
   * false if the request already settled. NEVER throws.
   * @param {number|string} id  the rpc id of the in-flight request
   * @param {number} ms         the new timeout window from now
   */
  extendRequestTimeout(id, ms) {
    try {
      const w = this._waiters.get(id);
      if (!w) return false;
      clearTimeout(w.timer);
      // The extension becomes the waiter's WINDOW, not just its current timer: a token-matched
      // progress beat re-arms to w.win, so leaving the old (short) win in place let a single
      // beat during a Bridge-B suspension collapse the human-answer hold back to toolTimeoutMs
      //Progress during a hold now re-arms to the hold.
      const win = Number.isFinite(ms) && ms > 0 ? ms : this._requestTimeoutMs;
      w.win = win;
      w.timer = setTimeout(() => {
        this._waiters.delete(id);
        w.reject(new Error(`McpClient: request("${w.method}") timed out (suspended-call window elapsed)`));
      }, win);
      if (w.timer && typeof w.timer.unref === 'function') w.timer.unref();
      return true;
    } catch (_e) {
      return false;
    }
  }

  /**
   * Re-arm the timeout of the in-flight request matching this progressToken:
   * a progress beat is proof of life for THAT request. Token-matched only - a dead upstream
   * still times out on its full window. NEVER throws.
   * @param {number|string} token  the progressToken from a notifications/progress params
   */
  _bumpProgressWaiter(token) {
    try {
      for (const [id, w] of this._waiters) {
        if (w.progressToken === undefined || w.progressToken !== token) continue;
        clearTimeout(w.timer);
        const win = Number.isFinite(w.win) && w.win > 0 ? w.win : this._toolTimeoutMs;
        w.timer = setTimeout(() => {
          this._waiters.delete(id);
          w.reject(new Error(
            `McpClient: timeout after ${win}ms without progress waiting for "${w.method}". stderr so far:\n${this._stderr}`
          ));
        }, win);
        if (w.timer && typeof w.timer.unref === 'function') w.timer.unref();
        return;
      }
    } catch (_e) { /* re-arm is best-effort; the original timer stands */ }
  }

  /** Answer a server-initiated request with a JSON-RPC ERROR. Fire-and-forget; NEVER throws. */
  respondToServerError(id, code, message) {
    try {
      if (this._closed || !this._child || !this._child.stdin) return;
      if (id === undefined || id === null) return;
      this._child.stdin.write(frameRequest({
        jsonrpc: JSONRPC, id,
        error: { code: typeof code === 'number' ? code : -32603, message: String(message || 'error') },
      }));
    } catch (_e) { /* fire-and-forget */ }
  }

  // ── Diagnostics -> never throw. ───────────────────────────────────────────────────────────────
  _logErr(...parts) {
    try {
      process.stderr.write(`[mcp-client:${this.id}] ${parts.join(' ')}\n`);
    } catch (_e) {
      /* never let logging throw */
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // connect(): spawn the child, perform the MCP initialize handshake, send the
  // notifications/initialized notification, set connected. On ANY failure (spawn
  // error, initialize timeout/error) close() the child and reject - never leave a zombie.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  async connect() {
    if (this._closed) throw new Error('McpClient: connect() called after close()');
    if (this._connected) return this._initializeResult;

    // 1) Spawn the child (shared with probeDiscover - a probe may already have spawned it).
    if (!this._child) this._spawnChild();

    // 2) DUAL-ERA negotiation (the spec's dual-era CLIENT rule: try MODERN first). Probe
    //    `server/discover`: a modern or dual-era upstream answers with a DiscoverResult that lists
    //    the modern version; a legacy-only upstream rejects it (method-not-found) or drops. On a
    //    valid modern answer we speak MODERN (no initialize; per-request `_meta` on every call).
    //    Otherwise (or when legacyPin FORCES legacy) we fall back to the LEGACY initialize handshake
    //    (byte-for-byte the prior behaviour).
    let discovered = null;
    if (!this._forceLegacy) {
      let probe = null;
      // The probe gets a SHORT timeout of its own: a legacy server that silently DROPS unknown
      // methods (instead of answering -32601) would otherwise stall every connect by the full
      // request timeout - serialised across upstreams at startup. An EXPLICIT per-upstream
      // requestTimeoutMs overrides the clamp - a slow-boot modern-only server needs the raised
      // window HERE, and the bin-side era probe already honours it (keep the two symmetric).
      const fullTimeout = this._requestTimeoutMs;
      this._requestTimeoutMs = this._explicitRequestTimeout
        ? fullTimeout : Math.min(3000, fullTimeout || 3000);
      try {
        probe = await this._request('server/discover', { _meta: this._modernMeta() });
      } catch (_probeErr) {
        probe = null; // legacy upstream (method-not-found) - fall through to initialize
        if (this._closed) throw new Error('McpClient: connect() aborted (closed during discover probe)');
        if (!this._child) this._spawnChild(); // a fragile legacy server may have died on the probe
      } finally {
        this._requestTimeoutMs = fullTimeout;
      }
      // Only treat the reply as MODERN if it is a real DiscoverResult advertising the modern
      // version - a permissive legacy server that answers unknown methods with `{}`/an empty object
      // must NOT be misdetected as modern.
      if (probe && typeof probe === 'object' && Array.isArray(probe.supportedVersions) &&
          probe.supportedVersions.includes(MODERN_PROTOCOL_VERSION)) {
        discovered = probe;
      } else if (probe && this._child) {
        // Answered, but not a modern DiscoverResult -> legacy. The child is alive (it replied), so the
        // legacy initialize below runs on the same child.
        discovered = null;
      }
    }

    // modernOnly refuses the legacy fallback: no valid modern DiscoverResult means no connection,
    // with an error that names the policy - never a silent downgrade.
    if (!discovered && this._modernOnly) {
      this.close();
      throw new Error(`McpClient: upstream "${this.id}" is modernOnly but did not answer server/discover with the 2026-07-28 protocol - refusing the legacy fallback`);
    }

    if (discovered) {
      // MODERN upstream - identity from discover; NO initialize / notifications/initialized.
      this._modern = true;
      this._initializeResult = this._identityFromDiscover(discovered);
    } else {
      // LEGACY upstream - the initialize handshake. A spawn 'error' rejects via the waiter path; a
      // silent server hits the request timeout. Either way close() + a clear error.
      try {
        const result = await this._request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: this._clientInfo,
          // elicitation: real SDK-based servers GATE ctx.elicit() on the client declaring this
          // capability - without it they answer "Method not found" and never elicit at all
          // (wild-scout finding, 2026-07-17). We honestly handle every elicitation now: the
          // Bridge B MRTR path for modern callers, a clean decline otherwise.
          capabilities: { elicitation: {} },
        });
        this._initializeResult = result;
      } catch (err) {
        this.close();
        throw new Error(`McpClient: initialize failed: ${(err && err.message) || String(err)}`);
      }
      // Tell the server the handshake is complete (notification - no id, no reply).
      this._notify('notifications/initialized', {});
      this._modern = false;
    }

    this._connected = true;
    this._everConnected = true; // from here on, an exit/error is an ESTABLISHED-connection death
    return this._initializeResult;
  }

  /** @returns {'modern'|'legacy'} the era negotiated at connect (default 'legacy' before connect). */
  get era() {
    return this._modern === true ? 'modern' : 'legacy';
  }

  /** The per-request `_meta` a modern client MUST send on every request (stdio: no headers). */
  _modernMeta() {
    return {
      'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': this._clientInfo,
    };
  }

  /** @returns {{name:string, version:string}} the identity this client presents upstream. */
  get clientInfo() {
    return this._clientInfo;
  }

  /**
   * Normalise a `server/discover` result into the common identity shape wrappedIdentity + connect()
   * consumers expect ({ protocolVersion, serverInfo, capabilities, instructions }) - so a MODERN
   * upstream's identity reads the same as a legacy `initialize` result. serverInfo lives in the
   * discover result's `_meta['io.modelcontextprotocol/serverInfo']`.
   */
  _identityFromDiscover(disc) {
    const d = disc && typeof disc === 'object' ? disc : {};
    const meta = d._meta && typeof d._meta === 'object' ? d._meta : {};
    const si = meta['io.modelcontextprotocol/serverInfo'];
    const versions = Array.isArray(d.supportedVersions) ? d.supportedVersions : [];
    return {
      // We negotiated MODERN (this path is only reached for a modern DiscoverResult), so report the
      // modern version - not `versions[0]`, whose ordering the spec does not guarantee (a dual-era
      // upstream listing legacy first would otherwise yield a contradictory identity).
      protocolVersion: versions.includes(MODERN_PROTOCOL_VERSION) ? MODERN_PROTOCOL_VERSION : (versions[0] || MODERN_PROTOCOL_VERSION),
      serverInfo: si && typeof si === 'object' ? si : undefined,
      capabilities: d.capabilities && typeof d.capabilities === 'object' ? d.capabilities : undefined,
      instructions: typeof d.instructions === 'string' ? d.instructions : undefined,
      supportedVersions: versions,
    };
  }

  /**
   * Spawn the child + wire its pipes (no handshake). A synchronous spawn throw (bad command) is
   * caught and rethrown clean. Extracted from connect() so probeDiscover() can share it.
   */
  _spawnChild() {
    try {
      // Cross-platform: POSIX passes through; Windows routes a .cmd/.bat shim through cmd.exe.
      const launch = winLaunch(this._command, this._args);
      this._child = this._spawn(launch.command, launch.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this._cwd,
        env: Object.assign({}, process.env, this._env),
        windowsHide: true,
      });
    } catch (err) {
      this._child = null;
      throw new Error(`McpClient: failed to spawn "${this._command}": ${(err && err.message) || String(err)}`);
    }

    if (!this._child || !this._child.stdin || !this._child.stdout) {
      // A fake/odd spawnImpl that didn't give us pipes - bail cleanly.
      this.close();
      throw new Error('McpClient: spawned child is missing stdio pipes');
    }

    this._wireChild();
  }

  /**
   * Era probe - the 2026-07-28 spec's dual-era client rule for stdio: try `server/discover`
   * BEFORE any legacy `initialize`. A modern or dual-era server answers with its
   * supportedVersions; a legacy server rejects it (-32601 Method not found) or times out.
   * Resolves the DiscoverResult, rejects otherwise. Sends the request with modern per-request
   * `_meta` (required in the modern era). Does NOT set connected - this is a probe, not a
   * handshake; call connect() for the legacy handshake (fresh client recommended: a badly
   * behaved legacy server may react badly to an unknown method).
   * @returns {Promise<object>} the server/discover result
   */
  async probeDiscover() {
    if (this._closed) throw new Error('McpClient: probeDiscover() called after close()');
    if (!this._child) this._spawnChild();
    try {
      return await this._request('server/discover', {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': this._clientInfo,
        },
      });
    } catch (err) {
      // Mirror connect()'s close-on-failure contract: a probe that times out or errors must not
      // leave a zombie child (the caller may not have a finally). close() is idempotent.
      this.close();
      throw err;
    }
  }

  /**
   * tools/list -> the upstream's tool definitions. Returns the raw array
   * [{name, description, inputSchema}] from result.tools (empty array if the
   * server returned no tools). Rejects on timeout / transport failure.
   * @returns {Promise<Array<{name:string, description?:string, inputSchema?:object}>>}
   */
  async listTools() {
    // Modern upstream: every request carries per-request `_meta` (stdio needs no headers).
    const params = this._modern ? { _meta: this._modernMeta() } : {};
    const result = await this._request('tools/list', params);
    const tools = result && Array.isArray(result.tools) ? result.tools : [];
    return tools;
  }

  /**
   * tools/call -> invoke one upstream tool. Returns the MCP tools/call result
   * envelope { content, isError }. Rejects on timeout / transport failure (a tool
   * that ran but returned an error sets isError:true in the resolved value - that
   * is NOT a rejection).
   * @param {string} name  the upstream tool name
   * @param {any}    args  structured arguments (forwarded as the `arguments` field)
   * @param {object} [meta] the caller's request-scoped _meta (progressToken et al., protocol keys
   *                 already stripped by the server). Rides the forward: without it the upstream
   *                 never emits progress for the call, so a long funnel tool cannot keep its
   *                 own call alive.
   * @returns {Promise<{content:any[], isError:boolean}>}
   */
  async callTool(name, args, meta) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('McpClient.callTool: "name" (non-empty string) is required');
    }
    const params = { name, arguments: args == null ? {} : args };
    if (meta && typeof meta === 'object' && !Array.isArray(meta) && Object.keys(meta).length) {
      params._meta = { ...meta };
    }
    // modern upstream: the per-request protocol trio always wins over caller keys
    if (this._modern) params._meta = { ...(params._meta || {}), ...this._modernMeta() };
    const result = await this._request('tools/call', params);
    const r = result && typeof result === 'object' ? result : {};
    const out = {
      content: Array.isArray(r.content) ? r.content : [],
      isError: r.isError === true,
    };
    // structuredContent rides along verbatim - dropping it silently stripped modern upstreams'
    // structured results on the curated-direct path while the raw wrap path kept them
    if (r.structuredContent !== undefined) out.structuredContent = r.structuredContent;
    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // close(): idempotent teardown. End child stdin so a well-behaved server exits on
  // EOF; if it is still alive, tree-kill it (win32 taskkill /T /F to reap the whole
  // process tree; else child.kill()). Reject every in-flight request so nothing leaks.
  // NEVER throws - it is called from error paths.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  close() {
    if (this._closed) return;
    this._closed = true;
    this._connected = false;

    const child = this._child;

    // Reject any in-flight requests first (so they don't fire their timers after teardown).
    this._rejectAllWaiters(new Error('McpClient: connection closed'));

    if (!child) return;

    // Best-effort: end stdin to let the server exit on EOF.
    try {
      if (child.stdin && !child.stdin.destroyed) child.stdin.end();
    } catch (_e) {
      /* ignore */
    }

    // If still alive, tree-kill so no descendant is orphaned (zombie guard).
    try {
      const alive = child.exitCode === null && child.signalCode === null && child.killed !== true;
      if (alive && typeof child.pid === 'number') {
        if (process.platform === 'win32') {
          // /T = whole tree, /F = force. spawnSync so it completes synchronously here.
          try {
            childProcess.spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
              windowsHide: true,
            });
          } catch (_e) {
            // Fall back to a plain kill if taskkill is unavailable.
            try { child.kill(); } catch (_e2) { /* ignore */ }
          }
        } else {
          child.kill();
        }
      } else if (typeof child.kill === 'function') {
        // Already exited or a fake child - a no-op kill is harmless.
        try { child.kill(); } catch (_e) { /* ignore */ }
      }
    } catch (_e) {
      /* never throw out of close */
    }

    this._child = null;
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // Internals.
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  /** Attach the stdout reader, stderr capture, and exit/error handlers to the child. */
  _wireChild() {
    const child = this._child;

    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stdout.on('error', (err) => this._logErr('stdout error:', (err && err.message) || String(err)));

    if (child.stderr) {
      child.stderr.on('data', (d) => {
        this._stderr += d.toString('utf8');
        // Keep the captured stderr bounded so a chatty child can't grow memory unbounded.
        if (this._stderr.length > 64 * 1024) {
          this._stderr = this._stderr.slice(-32 * 1024);
        }
      });
      child.stderr.on('error', () => { /* ignore */ });
    }

    // Either of these means the child is gone - fail every in-flight request so nothing hangs, and
    // NULL this._child so a later connect() on the same instance respawns instead of writing to a
    // dead stdin (connect() reuses `this._child` when set - a probeDiscover() against a legacy
    // server that dies on the unknown method would otherwise poison a follow-up connect()). Only
    // null it if it is still THIS child (a fresh respawn may have replaced it).
    child.on('exit', (code, signal) => {
      this._connected = false;
      if (this._child === child) this._child = null;
      this._rejectAllWaiters(
        new Error(`McpClient: upstream exited (code=${code}, signal=${signal}). stderr:\n${this._stderr}`)
      );
      this._fireOnClose(`exited (code=${code}, signal=${signal})`);
    });
    child.on('error', (err) => {
      // Spawn-level failure (e.g. ENOENT) - surfaces here, not as a throw from spawn().
      this._connected = false;
      if (this._child === child) this._child = null;
      this._rejectAllWaiters(
        new Error(`McpClient: child process error: ${(err && err.message) || String(err)}`)
      );
      this._fireOnClose(`error: ${(err && err.message) || String(err)}`);
    });
  }

  /**
   * Fire the onClose callback ONCE, and ONLY for an UNEXPECTED death - never when close() was
   * called deliberately (close() sets _closed=true before tree-killing the child, so the resulting
   * 'exit' is suppressed here). This is the signal the aggregator uses to schedule a background
   * reconnect. Wrapped - a throwing callback must not escape an event handler.
   * @param {string} reason
   */
  _fireOnClose(reason) {
    // ONLY an established connection dying counts. A connect-time failure (child exits during the
    // handshake, ENOENT, etc.) must NOT fire onClose: it surfaces as connect()'s thrown error, and
    // the aggregator's reconnect-retry path owns the backoff. Firing here would let a death inside a
    // reconnect attempt reset the backoff counter to 0 -> an unbounded ~1s respawn storm.
    if (!this._everConnected) return;
    if (this._closed) return;        // deliberate close() - not an unexpected death
    if (this._onCloseFired) return;  // exit AND error can both fire; notify once
    this._onCloseFired = true;
    if (typeof this._onClose === 'function') {
      try { this._onClose(reason); } catch (_e) { this._logErr('onClose callback threw (ignored)'); }
    }
  }

  /** Reject + clear every pending waiter (used on close / exit / error). */
  _rejectAllWaiters(err) {
    if (this._waiters.size === 0) return;
    for (const [, w] of this._waiters) {
      try { clearTimeout(w.timer); } catch (_e) { /* ignore */ }
      try { w.reject(err); } catch (_e) { /* ignore */ }
    }
    this._waiters.clear();
  }

  /**
   * Send a JSON-RPC request with an id and await its matching response. Rejects on
   * timeout (requestTimeoutMs) after deleting the waiter so it can't leak. Resolves
   * with the response's `result` (or rejects with its `error`).
   */
  _request(method, params, out) {
    if (this._closed) {
      return Promise.reject(new Error(`McpClient: request("${method}") after close()`));
    }
    if (!this._child || !this._child.stdin) {
      return Promise.reject(new Error(`McpClient: request("${method}") with no live child`));
    }

    const id = this._nextId++;
    // Report the issued rpc id synchronously (before any I/O) - a wrap needs the client-id ->
    // upstream-id mapping LIVE to translate notifications/cancelled for in-flight forwards.
    if (out && typeof out === 'object') out.rpcId = id;
    const payload = { jsonrpc: JSONRPC, id, method };
    if (params !== undefined) payload.params = params;

    // Method-class window: payload methods wait toolTimeoutMs, control-plane keeps the short
    // dead-upstream window. The caller's progressToken (rides params._meta on
    // a wrap forward) is remembered so a matching progress beat can re-arm the window.
    const win = PAYLOAD_METHODS.has(method) ? this._toolTimeoutMs : this._requestTimeoutMs;
    const ptok = params && params._meta && typeof params._meta === 'object' &&
      params._meta.progressToken !== undefined ? params._meta.progressToken : undefined;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(id);
        reject(new Error(
          `McpClient: timeout after ${win}ms waiting for "${method}". stderr so far:\n${this._stderr}`
        ));
      }, win);
      // Don't let a pending timer keep the event loop (and the test process) alive.
      if (timer && typeof timer.unref === 'function') timer.unref();

      this._waiters.set(id, { resolve, reject, timer, method, win, progressToken: ptok });

      let framed;
      try {
        framed = frameRequest(payload);
      } catch (err) {
        this._waiters.delete(id);
        clearTimeout(timer);
        reject(new Error(`McpClient: failed to serialise "${method}": ${(err && err.message) || String(err)}`));
        return;
      }

      try {
        this._child.stdin.write(framed, (err) => {
          if (err) {
            this._waiters.delete(id);
            clearTimeout(timer);
            reject(new Error(`McpClient: stdin write failed for "${method}": ${(err && err.message) || String(err)}`));
          }
        });
      } catch (err) {
        this._waiters.delete(id);
        clearTimeout(timer);
        reject(new Error(`McpClient: stdin write threw for "${method}": ${(err && err.message) || String(err)}`));
      }
    });
  }

  /** Fire-and-forget JSON-RPC notification (no id, no reply expected). Never throws. */
  _notify(method, params) {
    if (this._closed || !this._child || !this._child.stdin) return;
    const payload = { jsonrpc: JSONRPC, method };
    if (params !== undefined) payload.params = params;
    let framed;
    try {
      framed = frameRequest(payload);
    } catch (err) {
      this._logErr('failed to serialise notification', method + ':', (err && err.message) || String(err));
      return;
    }
    try {
      this._child.stdin.write(framed);
    } catch (err) {
      this._logErr('notification write failed', method + ':', (err && err.message) || String(err));
    }
  }

  /** Buffer incoming stdout bytes and drain every complete message (dual framing). */
  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    this._drain();
  }

  /**
   * Drain as many complete messages as are buffered. Header (Content-Length) framing
   * is tried FIRST (it counts exact bytes and is unambiguous), then newline-delimited
   * JSON. Mirrors server.js's dual-drain so the client reads either wire format.
   */
  _drain() {
    for (;;) {
      if (this._tryHeaderFramed()) continue;
      if (this._tryLineFramed()) continue;
      break;
    }
  }

  /** Pull one Content-Length-framed message off the front of the buffer. */
  _tryHeaderFramed() {
    const headerEnd = this._buf.indexOf('\r\n\r\n');
    if (headerEnd === -1) return false;
    const header = this._buf.slice(0, headerEnd).toString('utf8');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) return false; // a \r\n\r\n that isn't a Content-Length header -> not this framing
    const len = parseInt(m[1], 10);
    const bodyStart = headerEnd + 4;
    if (this._buf.length < bodyStart + len) return false; // body not all here yet
    const body = this._buf.slice(bodyStart, bodyStart + len).toString('utf8');
    this._buf = this._buf.slice(bodyStart + len);
    this._parseAndDispatch(body);
    return true;
  }

  /** Pull one newline-delimited JSON message off the front of the buffer. */
  _tryLineFramed() {
    const nl = this._buf.indexOf(0x0a); // '\n'
    if (nl === -1) return false;
    const line = this._buf.slice(0, nl).toString('utf8').trim();
    this._buf = this._buf.slice(nl + 1);
    if (line.length === 0) return true; // blank line (e.g. trailing from header framing): skip
    // A stray header line ("Content-Length: ...") on the line path means the body hasn't
    // arrived yet - but header framing is always tried first, so anything non-JSON here is
    // a framing artifact; ignore it rather than erroring.
    if (line[0] !== '{' && line[0] !== '[') return true;
    this._parseAndDispatch(line);
    return true;
  }

  /** Parse one JSON body and route it to its waiter by id. Bad JSON / unmatched ids are ignored. */
  _parseAndDispatch(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (_e) {
      this._logErr('dropping unparseable message from upstream');
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;

    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null;
    if (!hasId) {
      // A progress beat for an in-flight request proves the upstream is alive and WORKING that
      // request - re-arm its window so a slow-but-progressing call never dies to the fixed
      // timeout. The notification still relays below, untouched.
      if (msg.method === 'notifications/progress' && msg.params &&
          msg.params.progressToken !== undefined) {
        this._bumpProgressWaiter(msg.params.progressToken);
      }
      // Server-initiated NOTIFICATION (method, no id) - surface it so the aggregator can bridge
      // change-notifications to a modern subscriptions/listen stream. NEVER throws.
      if (typeof msg.method === 'string' && typeof this.onNotification === 'function') {
        try { this.onNotification(msg); } catch (_e) { this._logErr('onNotification threw (ignored)'); }
      }
      return;
    }

    if (typeof msg.method === 'string') {
      // SERVER->CLIENT REQUEST (id + method): the upstream is asking ITS client something -
      // elicitation/create, sampling/createMessage, roots/list. Previously dropped, which left
      // a conformant upstream holding an open request forever (Bridge B). Surface to the owner;
      // unhandled -> answer -32601 (the honest "this client cannot do that").
      if (typeof this.onServerRequest === 'function') {
        try { this.onServerRequest(msg); return; } catch (_e) { this._logErr('onServerRequest threw (ignored)'); }
      }
      this.respondToServerError(msg.id, -32601, 'Method not found: ' + msg.method);
      return;
    }

    const w = this._waiters.get(msg.id);
    if (!w) return; // response to an id we no longer await (timed out / closed) - drop it
    this._waiters.delete(msg.id);
    try { clearTimeout(w.timer); } catch (_e) { /* ignore */ }

    if (msg.error) {
      const e = msg.error;
      const message = e && e.message ? e.message : 'JSON-RPC error';
      const code = e && typeof e.code === 'number' ? ` (code ${e.code})` : '';
      const err = new Error(`McpClient: upstream error for "${w.method}": ${message}${code}`);
      // Preserve the VERBATIM JSON-RPC error object - a wrap must relay the upstream's own error
      // (code/message/data) untouched; the stringified message above is for logs and lean paths.
      err.rpcError = { code: e && typeof e.code === 'number' ? e.code : -32603, message };
      if (e && e.data !== undefined) err.rpcError.data = e.data;
      w.reject(err);
      return;
    }
    w.resolve(msg.result);
  }
}

/**
 * Frame a JSON-RPC message for the MCP stdio transport: one compact newline-delimited
 * JSON message. NOT Content-Length framing - see the field note inside.
 * @param {object} payload
 * @returns {string}
 */
function frameRequest(payload) {
  // MCP stdio transport framing: one compact JSON-RPC message per line, newline-delimited - NOT
  // LSP-style Content-Length. JSON.stringify emits no literal newlines, so a single trailing "\n"
  // cleanly delimits the message. This is what real SDK-based MCP servers read on stdin; writing
  // Content-Length here is what silently broke every real upstream (the read side still tolerates
  // both framings for robustness against the occasional Content-Length server).
  return JSON.stringify(payload) + '\n';
}

module.exports = {
  McpClient,
  // exported for unit tests / reuse
  frameRequest,
  winLaunch,
  PROTOCOL_VERSION,
  CLIENT_INFO,
};
