'use strict';

/**
 * http-transport.js — the HTTP/SSE transport (the design doc §7).
 *
 * The SAME hand-rolled MCP protocol as the stdio `server.js`, served over HTTP/SSE so a
 * LONG-LIVED host process can HOST the server and any CLI client connects to it over
 * `localhost:<port>` — instead of the CLI spawning a short-lived stdio child. This is the
 * north-star rung: the host owns the server, not a console.
 *
 * It is THIN. It reuses `server.js` for ALL JSON-RPC routing:
 *   - the 4 lean meta-tools (toolfunnel_list_tools / toolfunnel_tool_instructions / toolfunnel_run_tool / toolfunnel_howto),
 *   - the curated-direct call path THROUGH the PreToolUse gate (the safety invariant).
 * This file owns ONLY the wire: parse an HTTP request → `handleMessage(build, msg)` →
 * shape the HTTP response. The protocol logic is identical to stdio precisely because
 * protocol.js + the server's handleMessage are transport-free.
 *
 * Endpoints (bind 127.0.0.1 only; non-loopback Host headers are rejected defensively):
 *   - POST /mcp       : one JSON-RPC request → 200 application/json (a result) | 202 no body
 *                       (a notification, handleMessage returned null) | a -32700 parse-error
 *                       object at HTTP 200 for bad JSON. An oversized body is rejected with the
 *                       SAME clean -32700 at HTTP 200: a Content-Length over the cap is refused
 *                       up-front (before the body is read) with `Connection: close`; a chunked
 *                       over-cap body is bounded by readBody's streaming cap. NEVER crashes.
 *   - GET  /mcp       : the server→client SSE stream (Accept: text/event-stream). This is the
 *                       current Streamable-HTTP standard: a SINGLE /mcp endpoint serves POST
 *                       (client→server messages) AND GET (the server→client SSE stream the host
 *                       pushes notifications/tools/list_changed down). A CLI (type:"http")
 *                       connects on this path.
 *   - GET  /mcp/sse   : a WORKING ALIAS for the same SSE stream (the older HTTP+SSE shape,
 *                       deprecated but still supported). Identical behaviour to GET /mcp.
 *   - GET  /health    : 200 application/json with health() (a synchronous snapshot).
 *   - anything else   : 404 JSON.
 *
 * SAFETY CONTRACT (mirrors the rest of src/mcp/):
 *   - start() rejects cleanly on EADDRINUSE (caller decides) — it does NOT crash the process.
 *   - stop() is idempotent and NEVER throws (ends SSE clients, closes the server, closes the
 *     aggregator). It also clears + unrefs the keep-alive timers so the process can exit.
 *   - A bad/oversized/garbage HTTP request becomes a clean response, never an unhandled throw.
 *   - All SSE keep-alive timers are unref()-ed so a live stream never blocks process exit.
 *
 * CommonJS only. Node BUILT-INS only (node:http) — no new npm dep, no MCP SDK.
 */

const http = require('node:http');

const serverModule = require('./server');
const { handleMessage } = serverModule;

// OPTIONAL OAuth 2.1 resource-server validation. These modules are zero-runtime-dep themselves;
// the actual jose import is lazy + inside resource-server.js, pulled in only when auth is enabled.
const authConfig = require('../auth/config');
const { createValidator, protectedResourceMetadata, isJoseInstalled } = require('../auth/resource-server');
const metrics = require('../core/metrics');
const logger = require('../core/logger');

const PROTOCOL_VERSION = serverModule.PROTOCOL_VERSION;
const SERVER_INFO = serverModule.SERVER_INFO;

// ── Tunables ──────────────────────────────────────────────────────────────────────────────────
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9998;
// SSE keep-alive comment interval. The browser/CLI EventSource treats a stalled stream as dead;
// a periodic ":" comment line keeps the pipe warm without emitting a real event. ~25s is well
// under typical 30–60s proxy idle timeouts. The timer is unref()-ed so it never blocks exit.
const SSE_KEEPALIVE_MS = 25000;
// Hard cap on a POSTed JSON-RPC body so a pathological/huge request can't exhaust memory. A
// JSON-RPC tools/call payload is tiny; 4 MiB is generous headroom. Over the cap → -32700.
const MAX_BODY_BYTES = 4 * 1024 * 1024;
// RFC 9728 Protected Resource Metadata path — served UNAUTHENTICATED (it is the discovery document
// that tells a client which authorization server to use), and ONLY when auth is enabled.
const WELL_KNOWN_PRM = '/.well-known/oauth-protected-resource';

// Standard JSON-RPC error codes (subset used here — same values as server.js).
const JSONRPC = '2.0';
const ERR = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  INTERNAL: -32603,
});

/**
 * Build a JSON-RPC error object with a null id (used for transport-level failures — a parse
 * error has no determinable request id). Mirrors server.js makeError for the null-id case.
 * @param {number} code
 * @param {string} message
 * @param {*} [data]
 * @returns {{ jsonrpc: string, id: null, error: { code: number, message: string, data?: * } }}
 */
function makeError(code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC, id: null, error };
}

/** Diagnostics → logger (default: stderr). NEVER throws (a logging failure must not sink a call). */
function makeLog(logger) {
  const sink =
    logger && typeof logger.error === 'function'
      ? (msg) => logger.error('[toolfunnel-http] ' + msg)
      : (msg) => {
          try {
            process.stderr.write('[toolfunnel-http] ' + msg + '\n');
          } catch (_e) {
            /* never let logging throw */
          }
        };
  return (...parts) => {
    try {
      sink(parts.join(' '));
    } catch (_e) {
      /* never throw out of the logger */
    }
  };
}

/** Default build factory — the real Phase-2 build over the on-disk (EMPTY by default) expose.json. */
function defaultBuildFactory() {
  return require('./server').buildProtocol();
}

/**
 * Is the Host header loopback? We bind 127.0.0.1 only, but a forwarded/rebound request could still
 * arrive with a non-loopback Host. Defence-in-depth: reject anything whose host part is not a
 * recognised loopback name (DNS-rebinding guard). A MISSING Host header is allowed (HTTP/1.0 / a
 * raw node:http client may omit it) — the bind address is already the hard boundary.
 * @param {string|undefined} hostHeader  the raw `Host` request header
 * @returns {boolean}
 */
function isLoopbackHost(hostHeader) {
  if (hostHeader == null || hostHeader === '') return true; // no Host → bind addr is the boundary
  // Strip an optional :port. IPv6 hosts are bracketed: "[::1]:9998".
  let host = String(hostHeader).trim();
  if (host[0] === '[') {
    const end = host.indexOf(']');
    host = end === -1 ? host.slice(1) : host.slice(1, end);
  } else {
    // Strip an optional :port ONLY when unambiguous — exactly one colon means "host:port". A string
    // with MULTIPLE colons is a bare IPv6 literal (e.g. "::1", "0:0:0:0:0:0:0:1"); compare it whole,
    // else slicing at the first colon mangles it to "" and a valid IPv6 loopback bind is rejected.
    const first = host.indexOf(':');
    if (first !== -1 && first === host.lastIndexOf(':')) host = host.slice(0, first);
  }
  host = host.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1';
}

/** Read a request body up to MAX_BODY_BYTES. Resolves the buffered string, or rejects 'too large'. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let done = false;
    const finish = (fn, val) => {
      if (done) return;
      done = true;
      fn(val);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop reading; the caller turns this into a parse-error response.
        finish(reject, new Error('request body too large'));
        try {
          req.destroy();
        } catch (_e) {
          /* ignore */
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => finish(reject, err));
  });
}

/** Write a JSON response with a status code. Defensive: a serialise failure degrades to 500 text. */
function sendJson(res, status, obj) {
  let body;
  try {
    body = JSON.stringify(obj);
  } catch (_e) {
    body = JSON.stringify(makeError(ERR.INTERNAL, 'failed to serialise response'));
  }
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * Send a JSON response and then CLOSE the connection, draining the unread request body WITHOUT
 * buffering it. Used by the Content-Length pre-check (handleMcpPost): when a client announces an
 * oversized body we must reply cleanly (the documented -32700) *without* reading the multi-MiB
 * payload off the socket. The naive fix — `req.destroy()` straight after `res.end()` — resets the
 * socket before the response bytes flush, surfacing to the client as ECONNRESET instead of the
 * clean parse-error body. The robust sequence is:
 *   1. announce `Connection: close` so the client/keep-alive agent expects the socket to end here,
 *   2. write the full response body, and
 *   3. ONLY in the res.end(...) flush callback destroy the request — by then the response has been
 *      handed to the kernel, so the client receives the -32700 body, THEN sees the close. The
 *      unread request body is discarded (never buffered → no DoS) rather than politely resumed.
 * Defensive: like sendJson, a serialise failure degrades to a 500-shaped error body; the whole
 * function is wrapped so a write-after-headers race can never throw out of handleMcpPost.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} obj
 */
function sendJsonAndClose(req, res, status, obj) {
  let body;
  try {
    body = JSON.stringify(obj);
  } catch (_e) {
    body = JSON.stringify(makeError(ERR.INTERNAL, 'failed to serialise response'));
  }
  const destroyReq = () => {
    try {
      req.destroy();
    } catch (_e) {
      /* the socket may already be gone; nothing more to do */
    }
  };
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body, 'utf8'),
      'Cache-Control': 'no-store',
      // Signal end-of-connection so the client agent does not try to reuse the socket for a
      // pipelined follow-up (whose body would collide with the one we are about to discard).
      Connection: 'close',
    });
    // Destroy the request ONLY after the response body has flushed to the kernel, so the client
    // receives the clean -32700 first and the unread oversized body is dropped, not buffered.
    res.end(body, destroyReq);
  } catch (_e) {
    // writeHead/end can throw if headers were already sent by a racing path — fall back to a
    // straight destroy so the socket can never be left half-open.
    destroyReq();
  }
}

/**
 * createHttpMcpServer — construct (but do NOT start) the HTTP/SSE MCP host.
 *
 * @param {object}   [opts]
 * @param {Function} [opts.buildFactory]  () => { protocol, aggregator, engine, ctx }. Injectable so
 *                                        tests pass a sandbox build. Default = buildProtocol().
 * @param {string}   [opts.host]          bind address (default 127.0.0.1 — loopback only).
 * @param {number}   [opts.port]          bind port (default 9998; pass 0 for an OS-assigned port).
 * @param {object}   [opts.logger]        an object with .error(msg); default writes to stderr.
 * @returns {{
 *   start: () => Promise<{ port:number, url:string }>,
 *   stop: () => Promise<void>,
 *   reload: () => Promise<void>,
 *   broadcastToolsListChanged: () => number,
 *   health: () => object,
 *   get port(): (number|null),
 *   get url(): (string|null),
 *   get sseClientCount(): number,
 * }}
 */
function createHttpMcpServer(opts = {}) {
  const o = opts || {};
  const buildFactory = typeof o.buildFactory === 'function' ? o.buildFactory : defaultBuildFactory;
  const host = typeof o.host === 'string' && o.host.length > 0 ? o.host : DEFAULT_HOST;
  // A port of 0 is VALID (OS-assigned) so we must distinguish "not provided" from 0.
  const requestedPort = Number.isInteger(o.port) && o.port >= 0 ? o.port : DEFAULT_PORT;
  const log = makeLog(o.logger);

  // ── Mutable runtime state ─────────────────────────────────────────────────────────────────
  /** @type {object|null} the current Phase-2 build { protocol, aggregator, engine, ctx }. */
  let build = null;
  /** @type {import('node:http').Server|null} */
  let httpServer = null;
  /** @type {number|null} the actual bound port (resolved after listen — matters for port 0). */
  let boundPort = null;
  /** @type {Set<import('node:http').ServerResponse>} connected SSE client responses. */
  const sseClients = new Set();
  /** @type {boolean} latch so stop() is idempotent and start() can't double-bind. */
  let started = false;
  let stopping = false;
  /**
   * The result of the LAST connectAll() (from start() or reload()), surfaced by health() so a
   * silent upstream connect-failure becomes VISIBLE (otherwise it only reaches stderr via log()).
   * Shape mirrors Aggregator.connectAll's return: { connected: string[], failed: [{id,error}] }.
   * Defensive: only ever holds the well-formed arrays — a connectAll throw (which shouldn't happen)
   * or a malformed result leaves it EMPTY rather than half-populated. Reset to empty by stop().
   * @type {{ connected: string[], failed: Array<{id:string, error:string}> }}
   */
  let lastConnect = { connected: [], failed: [] };

  /**
   * Record a connectAll() result into lastConnect, defensively. A well-formed result has BOTH a
   * `connected` array and a `failed` array; anything else (a throw upstream, a malformed return)
   * leaves lastConnect EMPTY so health() never reports stale/partial connect state.
   * @param {*} res  the value returned by Aggregator.connectAll()
   */
  function recordConnect(res) {
    if (res && Array.isArray(res.connected) && Array.isArray(res.failed)) {
      lastConnect = { connected: res.connected.slice(), failed: res.failed.slice() };
    } else {
      lastConnect = { connected: [], failed: [] };
    }
  }

  /** The advertised base URL once bound (null before start / after stop). */
  function currentUrl() {
    return boundPort == null ? null : `http://${host}:${boundPort}`;
  }

  // ── SSE plumbing ──────────────────────────────────────────────────────────────────────────

  /**
   * Open an SSE stream on a GET /mcp request (the Streamable-HTTP standard server→client stream) or
   * its GET /mcp/sse alias. Registers the response in the client set, writes the SSE preamble + a
   * ": connected" comment, and starts an unref()-ed keep-alive timer. On close (client disconnect,
   * server stop) the client is deregistered and its timer cleared.
   */
  function openSse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Disable proxy buffering so events flush immediately (harmless when no proxy is present).
      'X-Accel-Buffering': 'no',
    });
    // Initial comment so the client knows the stream is live (comments start with ':').
    res.write(': connected\n\n');

    // Periodic keep-alive comment. unref() so a dangling stream NEVER blocks process exit, and
    // clear it on close/stop so we don't write to a dead socket.
    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (_e) {
        /* a write to a half-closed socket is benign; close handler will clean up */
      }
    }, SSE_KEEPALIVE_MS);
    if (typeof keepAlive.unref === 'function') keepAlive.unref();

    // Track the timer ON the response object so stop()/close can clear it.
    res._keepAlive = keepAlive;
    sseClients.add(res);

    const cleanup = () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  /**
   * Push one JSON-RPC notification to every connected SSE client as a `data:` event. Each client
   * that errors mid-write is dropped (and cleaned up) so one dead socket can't sink the broadcast.
   * @param {object} notification  a NO-ID JSON-RPC notification object
   * @returns {number} how many clients were written to
   */
  function pushToSse(notification) {
    let line;
    try {
      line = JSON.stringify(notification);
    } catch (_e) {
      return 0; // an unserialisable notification is a no-op rather than a throw
    }
    let count = 0;
    for (const res of Array.from(sseClients)) {
      try {
        res.write('data: ' + line + '\n\n');
        count += 1;
      } catch (_e) {
        // Drop a dead client so it never blocks future broadcasts or process exit.
        try {
          if (res._keepAlive) clearInterval(res._keepAlive);
        } catch (_e2) {
          /* ignore */
        }
        sseClients.delete(res);
      }
    }
    return count;
  }

  /**
   * broadcastToolsListChanged — push notifications/tools/list_changed (no id) to every SSE client.
   * A CLI honouring listChanged re-fetches tools/list (the design doc). Returns the
   * number of clients notified.
   * @returns {number}
   */
  function broadcastToolsListChanged() {
    return pushToSse({ jsonrpc: JSONRPC, method: 'notifications/tools/list_changed' });
  }

  // ── OAuth 2.1 resource-server gate (OPTIONAL; default OFF) ──────────────────────────────────
  // The validator is memoised and rebuilt ONLY when the relevant auth config changes — so a live
  // enable/disable/edit takes effect on the next request WITHOUT discarding jose's JWKS cache in
  // steady state. The config is read FRESH per request (mirrors the logger + tool-state overlays),
  // so the on/off decision is always live; the cache key just avoids rebuilding the remote-JWKS
  // resolver when nothing relevant changed.
  let _validator = null;
  let _validatorSig = '';

  function validatorFor(authCfg) {
    const resourceMetadataUrl = boundPort == null ? '' : currentUrl() + WELL_KNOWN_PRM;
    const sig = JSON.stringify([
      authCfg.issuer, authCfg.audience, authCfg.jwksUri, authCfg.algorithms,
      authCfg.requiredScopes, authCfg.clockToleranceSec, resourceMetadataUrl,
    ]);
    if (_validator && sig === _validatorSig) return _validator;
    _validator = createValidator(authCfg, { resourceMetadataUrl, log });
    _validatorSig = sig;
    return _validator;
  }

  /**
   * Enforce the OAuth gate for a protected route. Returns true if the request may proceed, false if
   * it has ALREADY been answered (401/403/500). Fails CLOSED — any error rejects rather than allows.
   */
  async function passesAuth(req, res, authCfg) {
    let verdict;
    try {
      const validator = validatorFor(authCfg);
      verdict = await validator.validate(req.headers && req.headers.authorization);
    } catch (err) {
      // validate() is contracted never to throw; guard anyway and fail CLOSED (never allow on error).
      log('auth validate threw (failing closed):', (err && err.message) || String(err));
      verdict = { ok: false, status: 401, error: 'invalid_token', errorDescription: 'authentication error', wwwAuthenticate: 'Bearer' };
    }
    if (verdict && verdict.ok === true) return true;
    // Audit the DENIAL (self-gating; no-op unless logging is on). A rejected access attempt is the
    // security-relevant event — without this it was invisible (rejected at the gate, before the
    // protocol/logging layer), so a run of failed auth attempts left no trace in the activity log.
    try {
      const rawUrl = req.url || '/';
      const q = rawUrl.indexOf('?');
      logger.log({
        type: 'auth',
        event: 'deny',
        error: verdict && verdict.error,
        status: verdict && verdict.status,
        path: q === -1 ? rawUrl : rawUrl.slice(0, q),
      });
    } catch (_e) { /* never let audit logging break the gate */ }
    sendAuthChallenge(res, verdict);
    return false;
  }

  /** Send an OAuth-style challenge (401/403/500) with the WWW-Authenticate header. NEVER throws. */
  function sendAuthChallenge(res, verdict) {
    const status = (verdict && Number.isInteger(verdict.status)) ? verdict.status : 401;
    const payload = { error: (verdict && verdict.error) || 'invalid_token' };
    if (verdict && verdict.errorDescription) payload.error_description = verdict.errorDescription;
    let body;
    try { body = JSON.stringify(payload); } catch (_e) { body = '{"error":"invalid_token"}'; }
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body, 'utf8'),
      'Cache-Control': 'no-store',
    };
    if (verdict && verdict.wwwAuthenticate) headers['WWW-Authenticate'] = verdict.wwwAuthenticate;
    try {
      res.writeHead(status, headers);
      res.end(body);
    } catch (_e) {
      /* response may already be committed; nothing more to do */
    }
  }

  // ── HTTP request handling ─────────────────────────────────────────────────────────────────

  /** POST /mcp — one JSON-RPC request → handleMessage(build, msg) → HTTP response. NEVER throws. */
  async function handleMcpPost(req, res) {
    // ── Content-Length pre-check ──────────────────────────────────────────────────────────────
    // A client that ANNOUNCES an oversized body (Content-Length > MAX_BODY_BYTES) is rejected
    // BEFORE a single byte of that body is read, so a multi-MiB POST never touches memory. We reply
    // with the SAME clean -32700 parse-error contract as bad JSON / a streamed over-cap body, then
    // close the connection (draining the unread body without buffering — see sendJsonAndClose).
    // Chunked / Content-Length-less requests skip this branch and fall through to readBody's
    // streaming cap (which still bounds memory and keeps the server alive).
    const clHeader = req.headers && req.headers['content-length'];
    if (clHeader != null) {
      const declared = Number(clHeader);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        log('POST /mcp rejected by Content-Length pre-check:', declared, '>', MAX_BODY_BYTES);
        return sendJsonAndClose(
          req,
          res,
          200,
          makeError(ERR.PARSE, 'Parse error: request body too large')
        );
      }
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      // Oversized / aborted body → a clean parse error, server stays alive.
      log('POST /mcp body read failed:', (err && err.message) || String(err));
      return sendJson(res, 200, makeError(ERR.PARSE, 'Parse error: ' + ((err && err.message) || 'bad body')));
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_e) {
      // Bad JSON → JSON-RPC parse error at HTTP 200 (the body is the error object).
      return sendJson(res, 200, makeError(ERR.PARSE, 'Parse error: invalid JSON body'));
    }

    let response;
    try {
      response = await handleMessage(build, msg);
    } catch (err) {
      // handleMessage is contracted never to throw, but the transport must survive even if a
      // wiring bug breaks that contract — a single bad request can never crash the host.
      log('handleMessage threw (should not):', (err && err.stack) || String(err));
      return sendJson(res, 200, makeError(ERR.INTERNAL, 'Internal error', (err && err.message) || String(err)));
    }

    // A notification (no reply) → 202 Accepted, no body. A request → 200 with the JSON-RPC result.
    if (response == null) {
      res.writeHead(202, { 'Content-Length': 0, 'Cache-Control': 'no-store' });
      return res.end();
    }
    return sendJson(res, 200, response);
  }

  /**
   * The single node:http request listener. Dispatches by method + path. async (it may await the
   * OAuth gate). NEVER throws — start() wraps it so a rejection can't escape into the http server.
   *
   * Note on MCP-Protocol-Version: a client MAY send an `MCP-Protocol-Version` header on post-
   * initialize requests. We read it leniently (unknown headers are ignored) and do not 400 on a
   * mismatch — the version is negotiated in `initialize`. Strict per-request enforcement is a
   * roadmap item; rejecting working clients over a header is the worse default for a local gateway.
   */
  async function onRequest(req, res) {
    // Auth config is read FRESH per request (default OFF). When OFF the transport is loopback-only
    // and unauthenticated (the original behaviour). When ON, a valid bearer token is the boundary.
    const authCfg = authConfig.getConfig();
    const authEnabled = authCfg.enabled === true;

    // DNS-rebinding / non-loopback guard. With auth DISABLED the bind address is the ONLY boundary,
    // so we reject any non-loopback Host (defence-in-depth, unchanged). With auth ENABLED the token
    // is the boundary — remote clients legitimately present a non-loopback Host — so we skip this
    // check and let the OAuth gate below authenticate every protected route.
    if (!authEnabled && !isLoopbackHost(req.headers && req.headers.host)) {
      return sendJson(res, 403, makeError(ERR.INVALID_REQUEST, 'forbidden: non-loopback Host'));
    }

    // Parse the path only (ignore query) without pulling in node:url's WHATWG parser overhead.
    const rawUrl = req.url || '/';
    const qIndex = rawUrl.indexOf('?');
    const pathName = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
    const method = (req.method || 'GET').toUpperCase();

    try {
      // RFC 9728 discovery document — the ONE unauthenticated route, and only when auth is enabled.
      // A client hits this (or follows the `resource_metadata` hint from a 401) to learn which
      // authorization server issues tokens for this gateway.
      if (method === 'GET' && pathName === WELL_KNOWN_PRM) {
        if (!authEnabled) return sendJson(res, 404, makeError(ERR.INVALID_REQUEST, 'not found: auth is not enabled'));
        return sendJson(res, 200, protectedResourceMetadata(authCfg));
      }

      // OAuth gate: when auth is enabled, EVERY remaining route requires a valid bearer token —
      // /mcp (POST + SSE) and /health alike. The discovery document above is the sole exception.
      if (authEnabled) {
        const allowed = await passesAuth(req, res, authCfg);
        if (!allowed) return; // a 401/403/500 challenge has already been sent
      }

      if (method === 'POST' && pathName === '/mcp') {
        // handleMcpPost is async + self-contained (it owns its try/catch); a rejection here would
        // be unusual but we still guard so an unhandled rejection can't escape the listener.
        handleMcpPost(req, res).catch((err) => {
          log('handleMcpPost rejected (should not):', (err && err.stack) || String(err));
          try {
            sendJson(res, 200, makeError(ERR.INTERNAL, 'Internal error'));
          } catch (_e) {
            /* response may be partly written; nothing more to do */
          }
        });
        return;
      }

      // Streamable-HTTP standard: a GET to the SINGLE /mcp endpoint with Accept: text/event-stream
      // opens the server→client SSE stream. We serve that here, AND keep GET /mcp/sse as a working
      // alias (the older HTTP+SSE shape, deprecated but still supported). Both routes
      // hand off to the same openSse() — the loopback/auth guard above already gated the request.
      if (method === 'GET' && (pathName === '/mcp' || pathName === '/mcp/sse')) {
        return openSse(req, res);
      }

      if (method === 'GET' && pathName === '/health') {
        return sendJson(res, 200, health());
      }

      // Unknown route.
      return sendJson(res, 404, makeError(ERR.INVALID_REQUEST, 'not found: ' + method + ' ' + pathName));
    } catch (err) {
      // Last-resort guard: a synchronous throw in routing becomes a 500 JSON, never a crash.
      log('onRequest threw:', (err && err.stack) || String(err));
      try {
        sendJson(res, 500, makeError(ERR.INTERNAL, 'Internal error'));
      } catch (_e) {
        /* response may already be committed */
      }
    }
  }

  // ── Health snapshot ───────────────────────────────────────────────────────────────────────

  /**
   * health — a SYNCHRONOUS snapshot of the host. `upstreamsConnected` + `toolsExposed` are read
   * from the live aggregator (defensively — a degraded build has a null aggregator). NEVER throws.
   *
   * `connected` + `failed` mirror the LAST connectAll() (start/reload) so a per-upstream connect
   * FAILURE is visible to the renderer instead of only landing on stderr. Both are fresh copies so
   * a caller cannot mutate the internal snapshot. `connected` is the list of upstream ids that
   * connected; `failed` is [{ id, error }] for the ones that did not (isolation guard, spawn
   * failure, handshake/listTools failure, …). When the host is down both are empty (stop() resets).
   *
   * @returns {{ ok:boolean, server:object, protocolVersion:string, url:(string|null),
   *             upstreamsConnected:number, upstreams:number, toolsExposed:number,
   *             connected:string[], failed:Array<{id:string, error:string}> }}
   */
  function health() {
    let toolsExposed = 0;
    let upstreamsConnected = 0;
    const agg = build && build.aggregator;
    if (agg) {
      try {
        if (typeof agg.exposedToolDefinitions === 'function') {
          const defs = agg.exposedToolDefinitions();
          if (Array.isArray(defs)) toolsExposed = defs.length;
        }
      } catch (_e) {
        /* a failing aggregator reports 0, never throws out of health */
      }
      try {
        if (typeof agg.toolsByUpstream === 'function') {
          // toolsByUpstream() returns a clone map of upstreamId -> tools for CONNECTED upstreams.
          upstreamsConnected = Object.keys(agg.toolsByUpstream() || {}).length;
        }
      } catch (_e) {
        /* ignore — report 0 */
      }
    }
    // The advertised meta-tool count, DERIVED from the protocol so it never drifts from what
    // tools/list actually returns (all four meta-tools — list, instructions, run, howto — are
    // advertised; deriving rather than hardcoding keeps health honest through future changes).
    let metaCount = 0;
    try {
      const proto = build && build.protocol;
      const defs = proto && typeof proto.toolDefinitions === 'function' ? proto.toolDefinitions() : null;
      if (Array.isArray(defs)) metaCount = defs.length;
    } catch (_e) {
      /* degraded build → metaCount stays 0 */
    }
    return {
      ok: started === true && stopping === false,
      server: SERVER_INFO,
      protocolVersion: PROTOCOL_VERSION,
      // The MCP endpoint the CLI points at (includes the /mcp path) — matches the .mcp.json
      // target and what the status tooltip should show, not the bare origin.
      url: boundPort == null ? null : currentUrl() + '/mcp',
      upstreamsConnected,
      // `upstreams` is an alias of upstreamsConnected for the renderer status tooltip
      // (the renderer reads snap.upstreams / snap.url for its title text).
      upstreams: upstreamsConnected,
      toolsExposed,
      // `tools` = what the CLI sees in tools/list: the four advertised meta-tools
      // (toolfunnel_list_tools/tool_instructions/run_tool/howto) + the curated-direct surface.
      // DERIVED from protocol.toolDefinitions() (metaCount) so it never drifts from the real
      // advertised count. The register's long tail lives behind toolfunnel_list_tools, not as
      // separate tools/list entries (a fresh host's status cell reads "up.4").
      tools: metaCount + toolsExposed,
      // Per-upstream connect outcome from the last connectAll() — makes silent connect-failures
      // visible. Fresh copies so the caller can never mutate the internal snapshot.
      connected: lastConnect.connected.slice(),
      failed: lastConnect.failed.map((f) => ({ id: f.id, error: f.error })),
      // OAuth resource-server status (no secrets — issuer/audience live in the well-known doc):
      // whether auth is enabled, whether the optional jose dependency is installed, and whether the
      // current config is coherent enough to enforce (misconfigured: configError() reason present).
      auth: authSnapshot(),
      // Lightweight in-memory observability: process-lifetime tools/call counters (total + per-tool
      // + error counts). Resets on restart; complementary to the on-disk JSONL audit log.
      metrics: metricsSnapshot(),
    };
  }

  /** A defensive copy of the in-memory tool-call counters. NEVER throws. */
  function metricsSnapshot() {
    try {
      return metrics.snapshot();
    } catch (_e) {
      return { startedAt: '', calls: 0, errors: 0, byTool: {} };
    }
  }

  /** A no-secrets snapshot of the OAuth gate state for /health + the UI. NEVER throws. */
  function authSnapshot() {
    try {
      const cfg = authConfig.getConfig();
      return {
        enabled: cfg.enabled === true,
        joseInstalled: isJoseInstalled(),
        configError: cfg.enabled ? authConfig.configError(cfg) : null,
      };
    } catch (_e) {
      return { enabled: false, joseInstalled: false, configError: null };
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────────────────

  /**
   * start — build the protocol+aggregator, connect every enabled upstream, then bind HTTP. On
   * EADDRINUSE the returned promise REJECTS with a clear error (the caller decides what to do) —
   * it does NOT crash the process. Resolves to { port, url } once listening.
   *
   * Port 0 → an OS-assigned ephemeral port; the actual port is read back from server.address().
   * @returns {Promise<{ port:number, url:string }>}
   */
  async function start() {
    if (started) {
      // Idempotent-ish: a second start() on a running host just reports the live binding.
      return { port: boundPort, url: currentUrl() };
    }

    // ── Fail-fast safety guards (BEFORE building/binding) ───────────────────────────────────────
    // These throw a clear, typed error the caller surfaces — they NEVER start a misconfigured host.
    const authCfg = authConfig.getConfig();
    if (authCfg.enabled) {
      // OAuth on but the dependency missing → refuse (else every request would fail closed anyway,
      // but failing at start with an actionable message is far better than a dead host).
      if (!isJoseInstalled()) {
        throw new Error(
          'OAuth is enabled but the "jose" dependency is not installed — run `toolfunnel install-oauth` ' +
            '(or click Install in the UI Auth panel), or disable auth in auth/auth.config.json.'
        );
      }
      const cfgErr = authConfig.configError(authCfg);
      if (cfgErr) throw new Error('OAuth is enabled but misconfigured: ' + cfgErr);
    } else if (!isLoopbackHost(host)) {
      // Binding off-loopback with NO auth would expose an UNAUTHENTICATED gateway to the network —
      // exactly the footgun the loopback default exists to prevent. Require auth before exposing it.
      throw new Error(
        `refusing to bind non-loopback host "${host}" without OAuth enabled — enable auth ` +
          '(and install jose) before exposing the gateway off localhost.'
      );
    }

    // Build + connect upstreams BEFORE binding so tools/list advertises the curated surface from
    // the very first request. connectAll() NEVER throws (failures land in failed[]); with the
    // default EMPTY expose.json it is an instant no-op.
    build = buildFactory();
    if (build && build.aggregator && typeof build.aggregator.connectAll === 'function') {
      try {
        const res = await build.aggregator.connectAll();
        recordConnect(res); // surface connect outcome (connected[]/failed[]) via health()
        if (res && Array.isArray(res.failed) && res.failed.length > 0) {
          log('connectAll: ' + res.failed.length + ' upstream(s) failed:',
            res.failed.map((f) => `${f.id}(${f.error})`).join('; '));
        }
      } catch (err) {
        recordConnect(null); // a throw leaves connect state EMPTY rather than stale/partial
        log('connectAll threw (ignored):', (err && err.message) || String(err));
      }
    } else {
      recordConnect(null); // no aggregator → no upstreams; report empty connect state
    }

    // onRequest is async (it may await the OAuth gate); wrap it so a rejection can NEVER escape into
    // the http server as an unhandled rejection — it degrades to a clean 500 instead.
    httpServer = http.createServer((req, res) => {
      onRequest(req, res).catch((err) => {
        log('onRequest rejected (should not):', (err && err.stack) || String(err));
        try { sendJson(res, 500, makeError(ERR.INTERNAL, 'Internal error')); } catch (_e) { /* committed */ }
      });
    });

    return new Promise((resolve, reject) => {
      // A bind failure (EADDRINUSE, EACCES) surfaces as an 'error' event before 'listening'. We
      // reject ONCE and detach the listener so a later runtime error can't double-settle.
      const onListenError = (err) => {
        httpServer.removeListener('listening', onListening);
        httpServer = null;
        // connectAll() ran BEFORE listen() and may have spawned upstream children; a bind failure
        // here would otherwise orphan them. Tear the aggregator down before rejecting. closeAll()
        // never throws; fire-and-forget (this is a sync 'error' handler) — it's cleanup only.
        const agg = build && build.aggregator;
        build = null; // nothing bound — drop the half-built state so a retry rebuilds cleanly
        if (agg && typeof agg.closeAll === 'function') {
          try { agg.closeAll(); } catch (_e) { /* never throw */ }
        }
        reject(err); // clear, typed error (err.code === 'EADDRINUSE' etc.) — caller decides
      };
      const onListening = () => {
        httpServer.removeListener('error', onListenError);
        const addr = httpServer.address();
        boundPort = addr && typeof addr === 'object' ? addr.port : requestedPort;
        started = true;
        stopping = false;
        // Swap the one-shot bind-error handler for a steady-state one so a later socket error
        // (a client RST, etc.) is logged, not thrown.
        httpServer.on('error', (e) => log('http server error:', (e && e.message) || String(e)));
        log('listening on', currentUrl(), '(pid', process.pid + ')');
        resolve({ port: boundPort, url: currentUrl() });
      };
      httpServer.once('error', onListenError);
      httpServer.once('listening', onListening);
      httpServer.listen(requestedPort, host);
    });
  }

  /**
   * stop — end every SSE client, close the HTTP server, then close the aggregator. Idempotent and
   * NEVER throws. Clears every keep-alive timer so the process can exit cleanly (no dangling
   * server, sockets, or timers).
   * @returns {Promise<void>}
   */
  async function stop() {
    if (!started && !httpServer) {
      // Never started (or already fully stopped) — still close any build the caller may have left.
      await closeAggregatorSafely();
      return;
    }
    stopping = true;

    // 1. Tear down SSE clients: clear their keep-alive timers and end the responses so their
    //    sockets close (an open SSE socket would otherwise keep the server from closing).
    for (const res of Array.from(sseClients)) {
      try {
        if (res._keepAlive) clearInterval(res._keepAlive);
      } catch (_e) {
        /* ignore */
      }
      try {
        res.end();
      } catch (_e) {
        /* ignore */
      }
    }
    sseClients.clear();

    // 2. Close the HTTP server (stops accepting + waits for in-flight sockets to drain). We also
    //    actively destroy any lingering sockets so close() can never hang the process exit.
    if (httpServer) {
      const srv = httpServer;
      httpServer = null;
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        try {
          srv.close(done);
        } catch (_e) {
          done();
        }
        // Destroy any keep-alive sockets still attached so close() resolves promptly.
        try {
          if (typeof srv.closeAllConnections === 'function') {
            srv.closeAllConnections();
          }
        } catch (_e) {
          /* closeAllConnections is Node ≥18.2; absent → close() still resolves on its own */
        }
      });
    }

    // 3. Close the aggregator (idempotent; never throws).
    await closeAggregatorSafely();

    boundPort = null;
    started = false;
    stopping = false;
    lastConnect = { connected: [], failed: [] }; // drop the connect snapshot — the host is down
  }

  /** Close the current build's aggregator if present. Idempotent + never throws. */
  async function closeAggregatorSafely() {
    const agg = build && build.aggregator;
    build = null;
    if (agg && typeof agg.closeAll === 'function') {
      try {
        await agg.closeAll();
      } catch (err) {
        log('aggregator.closeAll threw (ignored):', (err && err.message) || String(err));
      }
    }
  }

  /**
   * reload — apply an expose.json edit live: fully tear down the current aggregator, rebuild from
   * the (now-edited) config, reconnect every enabled upstream, then broadcast list_changed so a
   * connected CLI re-fetches tools/list. A clean full rebuild because expose edits are rare +
   * user-driven (the design doc). The HTTP server keeps running across the reload — only
   * the build is swapped. NEVER throws (connectAll never throws; closeAll never throws).
   * @returns {Promise<void>}
   */
  async function reload() {
    // 1. Close the old aggregator (this nulls `build`).
    await closeAggregatorSafely();
    // 2. Rebuild from the edited config + reconnect.
    build = buildFactory();
    if (build && build.aggregator && typeof build.aggregator.connectAll === 'function') {
      try {
        const res = await build.aggregator.connectAll();
        recordConnect(res); // refresh the health() connect snapshot for the new build
        if (res && Array.isArray(res.failed) && res.failed.length > 0) {
          log('reload connectAll: ' + res.failed.length + ' upstream(s) failed:',
            res.failed.map((f) => `${f.id}(${f.error})`).join('; '));
        }
      } catch (err) {
        recordConnect(null); // a throw leaves connect state EMPTY rather than stale/partial
        log('reload connectAll threw (ignored):', (err && err.message) || String(err));
      }
    } else {
      recordConnect(null); // no aggregator → no upstreams; report empty connect state
    }
    // 3. Tell connected clients the tool surface changed.
    broadcastToolsListChanged();
  }

  // ── Public handle ───────────────────────────────────────────────────────────────────────────
  return {
    start,
    stop,
    reload,
    broadcastToolsListChanged,
    health,
    get port() {
      return boundPort;
    },
    get url() {
      return currentUrl();
    },
    get sseClientCount() {
      return sseClients.size;
    },
  };
}

module.exports = {
  createHttpMcpServer,
  // Exported for unit tests / reuse — the small pure seams.
  isLoopbackHost,
  PROTOCOL_VERSION,
  SERVER_INFO,
};
