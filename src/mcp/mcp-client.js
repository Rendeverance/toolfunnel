'use strict';

/**
 * mcp-client.js — the MCP CLIENT (architecture notes §1, §7; Phase 2 aggregator).
 *
 * This is the REVERSE of src/mcp/server.js. Where server.js is a JSON-RPC 2.0
 * server that the CLI connects TO, this is a JSON-RPC 2.0 client that spawns an
 * UPSTREAM MCP server as a child process and talks to it over stdio. The Phase 2
 * aggregator owns one McpClient per upstream MCP server, lists their tools, and
 * routes curated calls through them.
 *
 * Transport contract (mirrors server.js's framing helpers but in the other direction):
 *   WRITE: LSP-style `Content-Length: N\r\n\r\n<body>` framing — this is what a real
 *          MCP server requires on its stdin.
 *   READ:  tolerate BOTH `Content-Length:` framing AND newline-delimited JSON, so the
 *          same client works against a real MCP server AND against our own server.js
 *          (which WRITES newline-delimited JSON). This is server.js's dual-drain logic
 *          re-used in the client.
 *
 * JSON-RPC requests are matched to responses by `id`. Every request carries a
 * timeout (requestTimeoutMs) — a slow/dead upstream rejects the in-flight promise
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
const CLIENT_INFO = Object.freeze({ name: 'toolfunnel', version: '3.0.0-client' });

/**
 * Cross-platform launch resolution for the upstream command.
 *
 * POSIX: pass through unchanged — execvp resolves `npx` / `uvx` / `node` / … on PATH.
 *
 * Windows: child_process with shell:false CANNOT run a `.cmd` / `.bat` shim — a bare name ENOENTs,
 * and an explicit `.cmd` throws EINVAL (the CVE-2024-27980 mitigation). Most MCP servers launch via
 * exactly such shims (`npx`, `npm`, `uvx`, `pnpm`, …), so on Windows route anything that isn't already
 * a concrete `.exe`/`.com` through cmd.exe, which resolves PATHEXT shims. The args stay DISCRETE
 * (never shell-concatenated into one string) and there is none of the `shell:true` DEP0190 hazard.
 * HONEST CAVEAT: because the spawned binary here is cmd.exe itself (an .exe), Node applies its
 * STANDARD argv quoting — not cmd.exe ^-metacharacter escaping (that special-casing only fires when
 * the command IS the .cmd/.bat). An arg containing cmd metacharacters (& | > < ") outside quotes can
 * therefore still be reinterpreted by cmd.exe. These args come from the operator's own expose.json,
 * so this is a correctness caveat on operator-authored config, not a privilege boundary; the fully
 * escaped alternative (resolve the real interpreter à la auth/install.js's `node + npm-cli.js` and
 * spawn it directly) is the upgrade path if it ever bites. close()'s taskkill /T still reaps the
 * whole cmd → shim → server process tree.
 *
 * @param {string} command  the configured upstream command (e.g. "npx", "node", an abs path)
 * @param {string[]} args   the configured argv
 * @returns {{ command: string, args: string[] }} what to actually hand to spawn()
 */
function winLaunch(command, args) {
  const argv = Array.isArray(args) ? args : [];
  if (process.platform !== 'win32') return { command, args: argv };
  // A concrete executable can be spawned directly — no shim resolution needed.
  if (path.isAbsolute(command) && /\.(exe|com)$/i.test(command)) return { command, args: argv };
  // Otherwise hand it to cmd.exe, which resolves the .cmd/.bat shim via PATHEXT.
  const comspec = process.env.ComSpec || 'cmd.exe';
  return { command: comspec, args: ['/c', command, ...argv] };
}

/**
 * McpClient — a hand-rolled JSON-RPC 2.0 client over a child process's stdio.
 *
 * Lifecycle: `new McpClient(opts)` → `await connect()` → `listTools()` / `callTool()`
 *            → `close()` (idempotent).
 */
class McpClient {
  /**
   * @param {object} opts
   * @param {string} [opts.id]                 caller-chosen id for this upstream (diagnostics only)
   * @param {string} opts.command              executable to spawn (e.g. process.execPath)
   * @param {string[]} [opts.args]             argv for the child (e.g. [serverPath])
   * @param {object} [opts.env]                extra env merged over process.env for the child
   * @param {string} [opts.cwd]                child working directory
   * @param {Function} [opts.spawnImpl]        injectable spawn (default node:child_process.spawn)
   * @param {number} [opts.requestTimeoutMs]   per-request timeout in ms (default 10000)
   * @param {Function} [opts.onClose]          called ONCE if the child dies UNEXPECTEDLY (exit/error
   *                                           while not deliberately close()d). Lets the owner
   *                                           (the aggregator) schedule a background reconnect.
   */
  constructor({ id, command, args = [], env = {}, cwd, spawnImpl, requestTimeoutMs = 10000, onClose } = {}) {
    if (typeof command !== 'string' || command.length === 0) {
      throw new Error('McpClient: "command" (non-empty string) is required');
    }
    this.id = typeof id === 'string' && id.length ? id : 'mcp-client';
    this._command = command;
    this._args = Array.isArray(args) ? args.slice() : [];
    this._env = env && typeof env === 'object' ? env : {};
    this._cwd = cwd;
    this._spawn = typeof spawnImpl === 'function' ? spawnImpl : childProcess.spawn;
    this._requestTimeoutMs =
      Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 10000;
    this._onClose = typeof onClose === 'function' ? onClose : null;
    this._onCloseFired = false; // onClose fires at most once, and never for a deliberate close()
    this._everConnected = false; // true once the handshake completed — onClose fires ONLY for the
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

  // ── Diagnostics → never throw. ───────────────────────────────────────────────────────────────
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
  // error, initialize timeout/error) close() the child and reject — never leave a zombie.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  async connect() {
    if (this._closed) throw new Error('McpClient: connect() called after close()');
    if (this._connected) return this._initializeResult;

    // 1) Spawn the child. A synchronous spawn throw (bad command) is caught and rethrown clean.
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
      // A fake/odd spawnImpl that didn't give us pipes — bail cleanly.
      this.close();
      throw new Error('McpClient: spawned child is missing stdio pipes');
    }

    this._wireChild();

    // 2) initialize handshake. If the child fails to spawn the 'error' event fires and
    //    rejects this request (via the waiter-reject path); if it never answers the
    //    request timeout fires. Either way we close() and surface a clear error.
    try {
      const result = await this._request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: CLIENT_INFO,
        capabilities: {},
      });
      this._initializeResult = result;
    } catch (err) {
      this.close();
      throw new Error(`McpClient: initialize failed: ${(err && err.message) || String(err)}`);
    }

    // 3) Tell the server the handshake is complete (notification — no id, no reply).
    this._notify('notifications/initialized', {});

    this._connected = true;
    this._everConnected = true; // from here on, an exit/error is an ESTABLISHED-connection death
    return this._initializeResult;
  }

  /**
   * tools/list → the upstream's tool definitions. Returns the raw array
   * [{name, description, inputSchema}] from result.tools (empty array if the
   * server returned no tools). Rejects on timeout / transport failure.
   * @returns {Promise<Array<{name:string, description?:string, inputSchema?:object}>>}
   */
  async listTools() {
    const result = await this._request('tools/list', {});
    const tools = result && Array.isArray(result.tools) ? result.tools : [];
    return tools;
  }

  /**
   * tools/call → invoke one upstream tool. Returns the MCP tools/call result
   * envelope { content, isError }. Rejects on timeout / transport failure (a tool
   * that ran but returned an error sets isError:true in the resolved value — that
   * is NOT a rejection).
   * @param {string} name  the upstream tool name
   * @param {any}    args  structured arguments (forwarded as the `arguments` field)
   * @returns {Promise<{content:any[], isError:boolean}>}
   */
  async callTool(name, args) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('McpClient.callTool: "name" (non-empty string) is required');
    }
    const result = await this._request('tools/call', { name, arguments: args == null ? {} : args });
    const r = result && typeof result === 'object' ? result : {};
    return {
      content: Array.isArray(r.content) ? r.content : [],
      isError: r.isError === true,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // close(): idempotent teardown. End child stdin so a well-behaved server exits on
  // EOF; if it is still alive, tree-kill it (win32 taskkill /T /F to reap the whole
  // process tree; else child.kill()). Reject every in-flight request so nothing leaks.
  // NEVER throws — it is called from error paths.
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
        // Already exited or a fake child — a no-op kill is harmless.
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

    // Either of these means the child is gone — fail every in-flight request so nothing hangs.
    child.on('exit', (code, signal) => {
      this._connected = false;
      this._rejectAllWaiters(
        new Error(`McpClient: upstream exited (code=${code}, signal=${signal}). stderr:\n${this._stderr}`)
      );
      this._fireOnClose(`exited (code=${code}, signal=${signal})`);
    });
    child.on('error', (err) => {
      // Spawn-level failure (e.g. ENOENT) — surfaces here, not as a throw from spawn().
      this._connected = false;
      this._rejectAllWaiters(
        new Error(`McpClient: child process error: ${(err && err.message) || String(err)}`)
      );
      this._fireOnClose(`error: ${(err && err.message) || String(err)}`);
    });
  }

  /**
   * Fire the onClose callback ONCE, and ONLY for an UNEXPECTED death — never when close() was
   * called deliberately (close() sets _closed=true before tree-killing the child, so the resulting
   * 'exit' is suppressed here). This is the signal the aggregator uses to schedule a background
   * reconnect. Wrapped — a throwing callback must not escape an event handler.
   * @param {string} reason
   */
  _fireOnClose(reason) {
    // ONLY an established connection dying counts. A connect-time failure (child exits during the
    // handshake, ENOENT, etc.) must NOT fire onClose: it surfaces as connect()'s thrown error, and
    // the aggregator's reconnect-retry path owns the backoff. Firing here would let a death inside a
    // reconnect attempt reset the backoff counter to 0 → an unbounded ~1s respawn storm.
    if (!this._everConnected) return;
    if (this._closed) return;        // deliberate close() — not an unexpected death
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
  _request(method, params) {
    if (this._closed) {
      return Promise.reject(new Error(`McpClient: request("${method}") after close()`));
    }
    if (!this._child || !this._child.stdin) {
      return Promise.reject(new Error(`McpClient: request("${method}") with no live child`));
    }

    const id = this._nextId++;
    const payload = { jsonrpc: JSONRPC, id, method };
    if (params !== undefined) payload.params = params;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(id);
        reject(new Error(
          `McpClient: timeout after ${this._requestTimeoutMs}ms waiting for "${method}". stderr so far:\n${this._stderr}`
        ));
      }, this._requestTimeoutMs);
      // Don't let a pending timer keep the event loop (and the test process) alive.
      if (timer && typeof timer.unref === 'function') timer.unref();

      this._waiters.set(id, { resolve, reject, timer, method });

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
    if (!m) return false; // a \r\n\r\n that isn't a Content-Length header → not this framing
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
    // A stray header line ("Content-Length: …") on the line path means the body hasn't
    // arrived yet — but header framing is always tried first, so anything non-JSON here is
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
    if (!hasId) return; // server-initiated notification — we don't consume these yet

    const w = this._waiters.get(msg.id);
    if (!w) return; // response to an id we no longer await (timed out / closed) — drop it
    this._waiters.delete(msg.id);
    try { clearTimeout(w.timer); } catch (_e) { /* ignore */ }

    if (msg.error) {
      const e = msg.error;
      const message = e && e.message ? e.message : 'JSON-RPC error';
      const code = e && typeof e.code === 'number' ? ` (code ${e.code})` : '';
      w.reject(new Error(`McpClient: upstream error for "${w.method}": ${message}${code}`));
      return;
    }
    w.resolve(msg.result);
  }
}

/**
 * Frame a JSON-RPC message with LSP-style Content-Length headers (the format a real
 * MCP server requires on its stdin). UTF-8 byte length is used so multi-byte payloads
 * frame correctly.
 * @param {object} payload
 * @returns {string}
 */
function frameRequest(payload) {
  // MCP stdio transport framing: one compact JSON-RPC message per line, newline-delimited — NOT
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
