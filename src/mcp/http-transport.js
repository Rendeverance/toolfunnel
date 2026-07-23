'use strict';

/**
 * http-transport.js - the HTTP/SSE transport (the design doc §7).
 *
 * The SAME hand-rolled MCP protocol as the stdio `server.js`, served over HTTP/SSE so a
 * LONG-LIVED host process can HOST the server and any CLI client connects to it over
 * `localhost:<port>` - instead of the CLI spawning a short-lived stdio child. This is the
 * north-star rung: the host owns the server, not a console.
 *
 * It is THIN. It reuses `server.js` for ALL JSON-RPC routing:
 *   - the 4 lean meta-tools (toolfunnel_list_tools / toolfunnel_tool_instructions / toolfunnel_run_tool / toolfunnel_howto),
 *   - the curated-direct call path THROUGH the PreToolUse gate (the safety invariant).
 * This file owns ONLY the wire: parse an HTTP request -> `handleMessage(build, msg)` ->
 * shape the HTTP response. The protocol logic is identical to stdio precisely because
 * protocol.js + the server's handleMessage are transport-free.
 *
 * Endpoints (bind 127.0.0.1 only; non-loopback Host headers are rejected defensively):
 *   - POST /mcp       : one JSON-RPC request -> 200 application/json (a result) | 202 no body
 *                       (a notification, handleMessage returned null) | a -32700 parse-error
 *                       object at HTTP 200 for bad JSON. An oversized body is rejected with the
 *                       SAME clean -32700 at HTTP 200: a Content-Length over the cap is refused
 *                       up-front (before the body is read) with `Connection: close`; a chunked
 *                       over-cap body is bounded by readBody's streaming cap. NEVER crashes.
 *   - GET  /mcp       : the server->client SSE stream (Accept: text/event-stream). This is the
 *                       current Streamable-HTTP standard: a SINGLE /mcp endpoint serves POST
 *                       (client->server messages) AND GET (the server->client SSE stream the host
 *                       pushes notifications/tools/list_changed down). A CLI (type:"http")
 *                       connects on this path.
 *   - GET  /mcp/sse   : a WORKING ALIAS for the same SSE stream (the older HTTP+SSE shape,
 *                       deprecated but still supported). Identical behaviour to GET /mcp.
 *   - GET  /health    : 200 application/json with health() (a synchronous snapshot).
 *   - anything else   : 404 JSON.
 *
 * SAFETY CONTRACT (mirrors the rest of src/mcp/):
 *   - start() rejects cleanly on EADDRINUSE (caller decides) - it does NOT crash the process.
 *   - stop() is idempotent and NEVER throws (ends SSE clients, closes the server, closes the
 *     aggregator). It also clears + unrefs the keep-alive timers so the process can exit.
 *   - A bad/oversized/garbage HTTP request becomes a clean response, never an unhandled throw.
 *   - All SSE keep-alive timers are unref()-ed so a live stream never blocks process exit.
 *
 * CommonJS only. Node BUILT-INS only (node:http) - no new npm dep, no MCP SDK.
 */

const http = require('node:http');

const serverModule = require('./server');
const { handleMessage } = serverModule;
// The 2026-07-28 ("modern") era shapes - era detection, header validation, subscriptions/listen.
// This transport is DUAL-ERA: modern requests get strict header enforcement + the listen stream;
// legacy requests (initialize-handshake clients, the GET /mcp SSE stream) are byte-for-byte 0.5.0.
const modern = require('./modern');

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
// under typical 30-60s proxy idle timeouts. The timer is unref()-ed so it never blocks exit.
const SSE_KEEPALIVE_MS = 25000;
// Hard cap on a POSTed JSON-RPC body so a pathological/huge request can't exhaust memory. A
// JSON-RPC tools/call payload is tiny; 4 MiB is generous headroom. Over the cap -> -32700.
const MAX_BODY_BYTES = 4 * 1024 * 1024;
// RFC 9728 Protected Resource Metadata path - served UNAUTHENTICATED (it is the discovery document
// that tells a client which authorization server to use), and ONLY when auth is enabled.
const WELL_KNOWN_PRM = '/.well-known/oauth-protected-resource';

// Standard JSON-RPC error codes (subset used here - same values as server.js).
const JSONRPC = '2.0';
const ERR = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  INTERNAL: -32603,
});

/**
 * Build a JSON-RPC error object with a null id (used for transport-level failures - a parse
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

/** A JSON-RPC error carrying the REQUEST's id (modern header/validation failures know their id -
 *  a null id there would orphan the client's pending request). */
function makeErrorWithId(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC, id: id === undefined ? null : id, error };
}

/** Diagnostics -> logger (default: stderr). NEVER throws (a logging failure must not sink a call). */
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

/** Default build factory - the real Phase-2 build over the on-disk (EMPTY by default) expose.json. */
function defaultBuildFactory() {
  return require('./server').buildProtocol();
}

/**
 * Is the Host header loopback? We bind 127.0.0.1 only, but a forwarded/rebound request could still
 * arrive with a non-loopback Host. Defence-in-depth: reject anything whose host part is not a
 * recognised loopback name (DNS-rebinding guard). A MISSING Host header is allowed (HTTP/1.0 / a
 * raw node:http client may omit it) - the bind address is already the hard boundary.
 * @param {string|undefined} hostHeader  the raw `Host` request header
 * @returns {boolean}
 */
function isLoopbackHost(hostHeader) {
  if (hostHeader == null || hostHeader === '') return true; // no Host -> bind addr is the boundary
  // Strip an optional :port. IPv6 hosts are bracketed: "[::1]:9998".
  let host = String(hostHeader).trim();
  if (host[0] === '[') {
    const end = host.indexOf(']');
    host = end === -1 ? host.slice(1) : host.slice(1, end);
  } else {
    // Strip an optional :port ONLY when unambiguous - exactly one colon means "host:port". A string
    // with MULTIPLE colons is a bare IPv6 literal (e.g. "::1", "0:0:0:0:0:0:0:1"); compare it whole,
    // else slicing at the first colon mangles it to "" and a valid IPv6 loopback bind is rejected.
    const first = host.indexOf(':');
    if (first !== -1 && first === host.lastIndexOf(':')) host = host.slice(0, first);
  }
  host = host.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1';
}

/**
 * Read a request body up to MAX_BODY_BYTES. Resolves the buffered string, or rejects 'too large'.
 * On over-cap it does NOT destroy the request - destroying here tears down the shared req/res
 * socket before the caller's -32700 reply can flush (the client saw ECONNRESET instead of the clean
 * parse error the declared-Content-Length path produces). Instead: stop BUFFERING (later chunks are
 * discarded, so memory stays bounded) and reject; the caller replies via sendJsonAndClose, which
 * flushes the error body first and destroys the request only in the res.end callback.
 */
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
      if (done) return; // over-cap already signalled - discard, don't buffer
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering; the caller flush-then-closes with the same -32700 as the declared-CL path.
        finish(reject, new Error('request body too large'));
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
 * buffering it. Used by both over-cap paths (the Content-Length pre-check and readBody's streaming
 * cap): the client must receive the documented -32700 cleanly while the oversized payload never
 * touches memory. The naive close - `req.destroy()`, even deferred to the res.end flush callback -
 * is NOT safe: destroy() sends a TCP RST whenever request bytes are still unread/in-flight, and on
 * RST Windows discards the peer's receive queue, eating the response we just flushed (the client
 * saw ECONNRESET instead of the -32700; proven by test 5 in http.test.js). The robust sequence:
 *   1. announce `Connection: close` so the client/keep-alive agent expects the socket to end here,
 *   2. write the full response body, then in the res.end(...) flush callback:
 *   3. resume() the request so any still-arriving body is DISCARDED (never buffered -> no DoS),
 *   4. HALF-CLOSE the socket (socket.end()) - the FIN travels in-order AFTER the response bytes,
 *      so the client always reads the -32700 first, and
 *   5. arm an unref'd hard-destroy timer as the backstop: a client that never stops sending and
 *      never closes gets its socket torn down after a grace window (bounded lifetime, no leak).
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
    res.end(body, () => {
      // The response has flushed to the kernel. Close down WITHOUT an RST (see the doc above):
      try {
        req.resume(); // discard (never buffer) whatever request body is still arriving
        if (req.socket && !req.socket.destroyed) req.socket.end(); // FIN, in-order after the body
      } catch (_e) {
        return destroyReq(); // a torn socket at this point -> plain destroy is all that is left
      }
      // Backstop: bound the socket's lifetime if the client neither finishes nor closes. The
      // timer is unref'd so it never keeps the process alive; a normal close clears it.
      const t = setTimeout(destroyReq, 10000);
      if (t && typeof t.unref === 'function') t.unref();
      if (req.socket) req.socket.once('close', () => clearTimeout(t));
    });
  } catch (_e) {
    // writeHead/end can throw if headers were already sent by a racing path - fall back to a
    // straight destroy so the socket can never be left half-open.
    destroyReq();
  }
}

/**
 * createHttpMcpServer - construct (but do NOT start) the HTTP/SSE MCP host.
 *
 * @param {object}   [opts]
 * @param {Function} [opts.buildFactory]  () => { protocol, aggregator, engine, ctx }. Injectable so
 *                                        tests pass a sandbox build. Default = buildProtocol().
 * @param {string}   [opts.host]          bind address (default 127.0.0.1 - loopback only).
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
  /** @type {number|null} the actual bound port (resolved after listen - matters for port 0). */
  let boundPort = null;
  /** @type {Set<import('node:http').ServerResponse>} connected SSE client responses. */
  const sseClients = new Set();
  /**
   * Modern subscriptions/listen streams: { res, subId, agreed } per open listen POST. Kept
   * SEPARATE from the legacy sseClients set - the two eras have different wire shapes (tagged +
   * filtered vs raw) and different close semantics (a final result vs a plain end).
   * @type {Set<{ res: import('node:http').ServerResponse, subId: *, agreed: object }>}
   */
  const modernListeners = new Set();
  // Cap on concurrent modern listen streams - loopback bounds this in practice, but a looping
  // client that re-listens without closing could still exhaust the process.
  // The stdio transport needs no cap: one client per pipe, and re-listens replace-on-same-id.
  const MODERN_LISTENERS_MAX = 64;
  /** @type {boolean} latch so stop() is idempotent and start() can't double-bind. */
  let started = false;
  let stopping = false;
  /** @type {(() => void)|null} teardown for the config hot-reload watchers (armed in start()). */
  let configWatchersStop = null;
  /**
   * The result of the LAST connectAll() (from start() or reload()), surfaced by health() so a
   * silent upstream connect-failure becomes VISIBLE (otherwise it only reaches stderr via log()).
   * Shape mirrors Aggregator.connectAll's return: { connected: string[], failed: [{id,error}] }.
   * Defensive: only ever holds the well-formed arrays - a connectAll throw (which shouldn't happen)
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
   * Open an SSE stream on a GET /mcp request (the Streamable-HTTP standard server->client stream) or
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
   * Open a modern subscriptions/listen stream: the POST's response becomes a long-lived SSE
   * stream. Per spec the FIRST message is the acknowledgment notification (carrying the agreed
   * filter subset + the subscription id = the listen request's JSON-RPC id); every later
   * notification is tagged with that id; a graceful server-side close sends a final RESULT to
   * the listen id then ends the stream. Keep-alive comments mirror the legacy openSse.
   */
  function openListenStream(req, res, msg) {
    const subId = msg.id;
    // A listen-FIRST modern client bypasses handleMessage - arm the N3 filter here too.
    if (typeof serverModule.armWrapChatter === 'function') serverModule.armWrapChatter(build);
    const { agreed } = modern.normaliseListenFilter(msg.params);
    // resourceSubscriptions is only agreed when some upstream can DELIVER per-URI updates (modern
    // era emits spontaneously; a subscribe-capable legacy upstream gets the subscribes forwarded).
    // An ack must never promise a dead channel.
    if (agreed.resourceSubscriptions) {
      const agg = build && build.aggregator;
      if (agg && typeof agg.canHonourResourceSubscriptions === 'function' && agg.canHonourResourceSubscriptions()) {
        agg.subscribeResources(agreed.resourceSubscriptions);
      } else {
        delete agreed.resourceSubscriptions;
      }
    }

    // At capacity -> refuse the NEW stream with a clear error BEFORE any SSE bytes are written;
    // existing streams are never evicted (they may carry subscriptions the client relies on).
    if (modernListeners.size >= MODERN_LISTENERS_MAX) {
      return sendJson(res, 503, makeErrorWithId(subId, ERR.INTERNAL,
        'listen stream limit reached (' + MODERN_LISTENERS_MAX + ') - close an existing subscriptions/listen stream first'));
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Spec: the acknowledgment MUST be the first message on the stream.
    try {
      res.write('data: ' + JSON.stringify(modern.listenAck(subId, agreed)) + '\n\n');
    } catch (_e) {
      /* a client that died mid-open is cleaned up by the close handlers below */
    }

    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (_e) {
        /* benign - close handler cleans up */
      }
    }, SSE_KEEPALIVE_MS);
    if (typeof keepAlive.unref === 'function') keepAlive.unref();
    res._keepAlive = keepAlive;

    const entry = { res, subId, agreed };
    modernListeners.add(entry);

    const cleanup = () => {
      clearInterval(keepAlive);
      modernListeners.delete(entry);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  /**
   * Push one notification to every modern listener whose agreed filter includes it (only
   * toolsListChanged exists on this tools-only server), TAGGED with each stream's subscription
   * id. A dead client is dropped, mirroring pushToSse. Returns how many were written to.
   */
  function pushToListeners(notification) {
    let count = 0;
    for (const entry of Array.from(modernListeners)) {
      // Deliver only to streams whose AGREED filter includes this notification's channel
      // (tools/prompts/resources list_changed, or resources/updated for a subscribed uri).
      if (!modern.notificationMatchesFilter(notification, entry.agreed)) continue;
      let line;
      try {
        line = JSON.stringify(modern.tagNotification(notification, entry.subId));
      } catch (_e) {
        continue;
      }
      try {
        entry.res.write('data: ' + line + '\n\n');
        count += 1;
      } catch (_e) {
        try {
          if (entry.res._keepAlive) clearInterval(entry.res._keepAlive);
        } catch (_e2) {
          /* ignore */
        }
        modernListeners.delete(entry);
      }
    }
    return count;
  }

  /**
   * broadcastToolsListChanged - push notifications/tools/list_changed (no id) to every legacy SSE
   * client AND (tagged + filtered) to every modern listen stream. A client honouring listChanged
   * re-fetches tools/list (the design doc). Returns the number of clients notified.
   * @returns {number}
   */
  function broadcastToolsListChanged() {
    const note = { jsonrpc: JSONRPC, method: 'notifications/tools/list_changed' };
    return pushToSse(note) + pushToListeners(note);
  }

  /**
   * Wire the CURRENT build's aggregator "tools changed" signal (a background reconnect finally
   * winning an upstream) to the SSE broadcast, so an HTTP client honouring listChanged re-fetches.
   * Re-called after every build (re)creation because a fresh aggregator has no listener - the stdio
   * path does the equivalent in main(). NEVER throws.
   */
  function wireAggregatorNotify() {
    if (build && build.aggregator) {
      // Arm the N3 cross-upstream filter from wiring time - bridged notifications can arrive
      // before the first client message computes the wrap state.
      if (typeof serverModule.armWrapChatter === 'function') serverModule.armWrapChatter(build);
      build.aggregator.onToolsChanged = () => broadcastToolsListChanged();
      // Bridge an upstream's server-initiated change-notifications (resources/prompts/tools
      // list_changed, resources/updated) to legacy SSE clients (raw) AND modern listen streams
      // (tagged + filtered per subscription). NEVER throws.
      build.aggregator.onUpstreamNotification = (uid, n) => {
        // Under a wrap, ONLY the wrapped upstream's notifications reach clients - another attached
        // upstream's events are a transparency tell + cross-server leak.
        const wrapOnly = build.aggregator && build.aggregator.wrapChatterUpstream;
        if (wrapOnly && uid !== wrapOnly) return;
        // Request-scoped chatter (ONE client's in-flight progress/log lines) must not BROADCAST on
        // the multi-client HTTP transport - client B would receive client A's progress tokens and
        // log output. stdio (one client per process) keeps the relay;
        // chat-scoped change notifications (list_changed, resources/updated) still broadcast here.
        const m = n && n.method;
        if (m === 'notifications/progress' || m === 'notifications/message') return;
        try { pushToSse(n); } catch (_e) { /* legacy SSE best-effort */ }
        try { pushToListeners(n); } catch (_e) { /* modern listeners best-effort */ }
      };
      // Bridge B: elicitations from the wrapped upstream bind to the one in-flight wrapped call
      // (or decline). The handler reads `build` live via this closure, same as the bridge above.
      if (typeof serverModule.handleUpstreamServerRequest === 'function') {
        build.aggregator.onUpstreamServerRequest = (uid, m, c) =>
          serverModule.handleUpstreamServerRequest(build, uid, m, c);
      }
    }
  }

  // ── OAuth 2.1 resource-server gate (OPTIONAL; default OFF) ──────────────────────────────────
  // The validator is memoised and rebuilt ONLY when the relevant auth config changes - so a live
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
   * it has ALREADY been answered (401/403/500). Fails CLOSED - any error rejects rather than allows.
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
    // security-relevant event - without this it was invisible (rejected at the gate, before the
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

  /** POST /mcp - one JSON-RPC request -> handleMessage(build, msg) -> HTTP response. NEVER throws. */
  async function handleMcpPost(req, res) {
    // ── Content-Length pre-check ──────────────────────────────────────────────────────────────
    // A client that ANNOUNCES an oversized body (Content-Length > MAX_BODY_BYTES) is rejected
    // BEFORE a single byte of that body is read, so a multi-MiB POST never touches memory. We reply
    // with the SAME clean -32700 parse-error contract as bad JSON / a streamed over-cap body, then
    // close the connection (draining the unread body without buffering - see sendJsonAndClose).
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
      // Oversized / aborted body -> the SAME flush-then-close -32700 as the Content-Length pre-check
      // (readBody no longer destroys the request, so the reply can actually reach the client; a
      // genuinely-dead socket is fine too - sendJsonAndClose's writes are defensively wrapped).
      log('POST /mcp body read failed:', (err && err.message) || String(err));
      return sendJsonAndClose(req, res, 200, makeError(ERR.PARSE, 'Parse error: ' + ((err && err.message) || 'bad body')));
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_e) {
      // Bad JSON -> JSON-RPC parse error at HTTP 200 (the body is the error object).
      return sendJson(res, 200, makeError(ERR.PARSE, 'Parse error: invalid JSON body'));
    }

    // ── Modern era (2026-07-28): strict header enforcement + the listen stream ────────────────
    // Era detection is by BODY (per-request _meta - the spec's dual-era rule); initialize always
    // selects legacy. Legacy requests skip ALL of this and flow byte-for-byte as 0.5.0 (their
    // optional MCP-Protocol-Version header stays leniently ignored - pre-modern values carry no
    // enforcement contract for a dual-era server).
    const bodyIsModern = msg && msg.method !== 'initialize' && modern.isModernRequest(msg);
    const headerVersion = req.headers && req.headers['mcp-protocol-version'];
    if (bodyIsModern) {
      // Headers are REQUIRED for compliance on modern requests: MCP-Protocol-Version, Mcp-Method,
      // and (tools/call | resources/read | prompts/get) Mcp-Name must all mirror the body.
      // A mismatch is 400 + HeaderMismatch (-32020) per spec.
      const hErr = modern.validateModernHeaders(req.headers, msg);
      if (hErr) {
        logger.log({ type: 'client', event: 'modern-header-reject', method: msg.method });
        return sendJson(res, hErr.httpStatus, makeErrorWithId(msg.id, hErr.code, hErr.message));
      }
      const vErr = modern.validateModernRequest(msg);
      if (vErr) {
        return sendJson(res, vErr.httpStatus, makeErrorWithId(msg.id, vErr.code, vErr.message, vErr.data));
      }
      // subscriptions/listen is transport-owned: the POST's response IS the SSE stream.
      if (msg.method === 'subscriptions/listen') {
        if (msg.id === undefined || msg.id === null) {
          // A listen with no id can never be acknowledged or closed - reject it clearly.
          return sendJson(res, 400, makeError(ERR.INVALID_REQUEST, 'subscriptions/listen requires an id'));
        }
        return openListenStream(req, res, msg);
      }
    } else if (headerVersion === modern.MODERN_PROTOCOL_VERSION) {
      // The header announces the modern era but the request is not a modern one. Two cases, so the
      // message is TRUTHFUL rather than always blaming a missing _meta:
      //  - `initialize` carrying a modern header: initialize ALWAYS selects the legacy era, so the
      //    modern header is contradictory - tell them to drop it on the fallback handshake.
      //  - any other body with no modern _meta: a genuine header/_meta mismatch.
      const isInit = msg && msg.method === 'initialize';
      const message = isInit
        ? 'Header mismatch: `initialize` always selects the legacy era - drop the MCP-Protocol-Version: ' +
          modern.MODERN_PROTOCOL_VERSION + ' header on the legacy handshake (or send a modern request instead)'
        : 'Header mismatch: MCP-Protocol-Version announces ' + modern.MODERN_PROTOCOL_VERSION +
          ' but the body carries no matching _meta protocolVersion';
      return sendJson(res, 400, makeErrorWithId(msg && msg.id, modern.ERR_MODERN.HEADER_MISMATCH, message));
    }

    let response;
    try {
      response = await handleMessage(build, msg);
    } catch (err) {
      // handleMessage is contracted never to throw, but the transport must survive even if a
      // wiring bug breaks that contract - a single bad request can never crash the host.
      log('handleMessage threw (should not):', (err && err.stack) || String(err));
      return sendJson(res, 200, makeError(ERR.INTERNAL, 'Internal error', (err && err.message) || String(err)));
    }

    // A notification (no reply) -> 202 Accepted, no body. A request -> 200 with the JSON-RPC result.
    if (response == null) {
      res.writeHead(202, { 'Content-Length': 0, 'Cache-Control': 'no-store' });
      return res.end();
    }
    // Modern-era unknown method pairs -32601 with HTTP 404 (spec: the status IS the era-detection
    // signal distinguishing a modern server from a legacy one). Legacy bodies keep the
    // JSON-RPC-over-HTTP convention of 200-with-error.
    if (modern.isModernRequest(msg) && response && response.error && response.error.code === -32601) {
      return sendJson(res, 404, response);
    }
    return sendJson(res, 200, response);
  }

  /**
   * The single node:http request listener. Dispatches by method + path. async (it may await the
   * OAuth gate). NEVER throws - start() wraps it so a rejection can't escape into the http server.
   *
   * Note on MCP-Protocol-Version: a client MAY send an `MCP-Protocol-Version` header on post-
   * initialize requests. We read it leniently (unknown headers are ignored) and do not 400 on a
   * mismatch - the version is negotiated in `initialize`. Strict per-request enforcement is a
   * roadmap item; rejecting working clients over a header is the worse default for a local gateway.
   */
  async function onRequest(req, res) {
    // Auth config is read FRESH per request (default OFF). When OFF the transport is loopback-only
    // and unauthenticated (the original behaviour). When ON, a valid bearer token is the boundary.
    const authCfg = authConfig.getConfig();
    const authEnabled = authCfg.enabled === true;

    // DNS-rebinding / non-loopback guard. With auth DISABLED the bind address is the ONLY boundary,
    // so we reject any non-loopback Host (defence-in-depth, unchanged). With auth ENABLED the token
    // is the boundary - remote clients legitimately present a non-loopback Host - so we skip this
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
      // RFC 9728 discovery document - the ONE unauthenticated route, and only when auth is enabled.
      // A client hits this (or follows the `resource_metadata` hint from a 401) to learn which
      // authorization server issues tokens for this gateway.
      if (method === 'GET' && pathName === WELL_KNOWN_PRM) {
        if (!authEnabled) return sendJson(res, 404, makeError(ERR.INVALID_REQUEST, 'not found: auth is not enabled'));
        return sendJson(res, 200, protectedResourceMetadata(authCfg));
      }

      // OAuth gate: when auth is enabled, EVERY remaining route requires a valid bearer token -
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
      // opens the server->client SSE stream. We serve that here, AND keep GET /mcp/sse as a working
      // alias (the older HTTP+SSE shape, deprecated but still supported). Both routes
      // hand off to the same openSse() - the loopback/auth guard above already gated the request.
      if (method === 'GET' && (pathName === '/mcp' || pathName === '/mcp/sse')) {
        // MODERN-ONLY POLICY: the GET-SSE stream is a LEGACY-era channel (modern uses
        // subscriptions/listen on POST) - refuse it with the policy named, like every other
        // legacy-shaped request (era-policy switches, 2026-07-18).
        if (build && build.serveLegacy === false) {
          return sendJson(res, 400, makeError(-32020,
            'modern-only gateway (serveLegacy:false): the legacy SSE channel is disabled - use subscriptions/listen'));
        }
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
   * health - a SYNCHRONOUS snapshot of the host. `upstreamsConnected` + `toolsExposed` are read
   * from the live aggregator (defensively - a degraded build has a null aggregator). NEVER throws.
   *
   * `connected` + `failed` mirror the LAST connectAll() (start/reload) so a per-upstream connect
   * FAILURE is visible to the renderer instead of only landing on stderr. Both are fresh copies so
   * a caller cannot mutate the internal snapshot. `connected` is the list of upstream ids that
   * connected; `failed` is [{ id, error }] for the ones that did not (isolation guard, spawn
   * failure, handshake/listTools failure, ...). When the host is down both are empty (stop() resets).
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
        /* ignore - report 0 */
      }
    }
    // The advertised meta-tool count, DERIVED from the protocol so it never drifts from what
    // tools/list actually returns (all four meta-tools - list, instructions, run, howto - are
    // advertised; deriving rather than hardcoding keeps health honest through future changes).
    // ACTIVE WRAP -> liveness only. The /mcp surface on this very port impersonates the wrapped
    // server; the full body (server:toolfunnel, versions, upstream ids, connect-failure strings)
    // would hand any unauthenticated loopback GET the funnel's existence wholesale - undoing the
    // error-text neutralisation the wrap paths pay for.
    try {
      if (build && typeof build.wrapActive === 'function' && build.wrapActive()) {
        return { ok: started === true && stopping === false };
      }
    } catch (_e) { /* degraded flag -> serve the full body */ }
    let metaCount = 0;
    try {
      const proto = build && build.protocol;
      const defs = proto && typeof proto.toolDefinitions === 'function' ? proto.toolDefinitions() : null;
      if (Array.isArray(defs)) metaCount = defs.length;
    } catch (_e) {
      /* degraded build -> metaCount stays 0 */
    }
    return {
      ok: started === true && stopping === false,
      server: SERVER_INFO,
      protocolVersion: PROTOCOL_VERSION,
      // Dual-era: every revision this host speaks (modern first). `protocolVersion` above stays
      // the legacy string for backward compatibility with 0.5.0 health consumers (the UI).
      protocolVersions: modern.supportedVersions(),
      // Open modern subscriptions/listen streams (legacy SSE clients are sseClientCount).
      listenStreams: modernListeners.size,
      // The MCP endpoint the CLI points at (includes the /mcp path) - matches the .mcp.json
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
      // Per-upstream connect outcome from the last connectAll() - makes silent connect-failures
      // visible. Fresh copies so the caller can never mutate the internal snapshot.
      connected: lastConnect.connected.slice(),
      failed: lastConnect.failed.map((f) => ({ id: f.id, error: f.error })),
      // OAuth resource-server status (no secrets - issuer/audience live in the well-known doc):
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
   * start - build the protocol+aggregator, connect every enabled upstream, then bind HTTP. On
   * EADDRINUSE the returned promise REJECTS with a clear error (the caller decides what to do) -
   * it does NOT crash the process. Resolves to { port, url } once listening.
   *
   * Port 0 -> an OS-assigned ephemeral port; the actual port is read back from server.address().
   * @returns {Promise<{ port:number, url:string }>}
   */
  async function start() {
    if (started) {
      // Idempotent-ish: a second start() on a running host just reports the live binding.
      return { port: boundPort, url: currentUrl() };
    }

    // ── Fail-fast safety guards (BEFORE building/binding) ───────────────────────────────────────
    // These throw a clear, typed error the caller surfaces - they NEVER start a misconfigured host.
    const authCfg = authConfig.getConfig();
    if (authCfg.enabled) {
      // OAuth on but the dependency missing -> refuse (else every request would fail closed anyway,
      // but failing at start with an actionable message is far better than a dead host).
      if (!isJoseInstalled()) {
        throw new Error(
          'OAuth is enabled but the "jose" dependency is not installed - run `toolfunnel install-oauth` ' +
            '(or click Install in the UI Auth panel), or disable auth in auth/auth.config.json.'
        );
      }
      const cfgErr = authConfig.configError(authCfg);
      if (cfgErr) throw new Error('OAuth is enabled but misconfigured: ' + cfgErr);
    } else if (!isLoopbackHost(host)) {
      // Binding off-loopback with NO auth would expose an UNAUTHENTICATED gateway to the network -
      // exactly the footgun the loopback default exists to prevent. Require auth before exposing it.
      throw new Error(
        `refusing to bind non-loopback host "${host}" without OAuth enabled - enable auth ` +
          '(and install jose) before exposing the gateway off localhost.'
      );
    }

    // Build + connect upstreams BEFORE binding so tools/list advertises the curated surface from
    // the very first request. connectAll() NEVER throws (failures land in failed[]); with the
    // default EMPTY expose.json it is an instant no-op.
    build = buildFactory();
    wireAggregatorNotify();
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
      recordConnect(null); // no aggregator -> no upstreams; report empty connect state
    }

    // onRequest is async (it may await the OAuth gate); wrap it so a rejection can NEVER escape into
    // the http server as an unhandled rejection - it degrades to a clean 500 instead.
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
        // never throws; fire-and-forget (this is a sync 'error' handler) - it's cleanup only.
        const agg = build && build.aggregator;
        build = null; // nothing bound - drop the half-built state so a retry rebuilds cleanly
        if (agg && typeof agg.closeAll === 'function') {
          try { agg.closeAll(); } catch (_e) { /* never throw */ }
        }
        reject(err); // clear, typed error (err.code === 'EADDRINUSE' etc.) - caller decides
      };
      const onListening = () => {
        httpServer.removeListener('error', onListenError);
        const addr = httpServer.address();
        boundPort = addr && typeof addr === 'object' ? addr.port : requestedPort;
        started = true;
        stopping = false;
        // Arm config hot-reload now the build is live + bound. Pass a GETTER so the reloaders
        // always target the CURRENT build (reload() rebuilds it); send = pushToSse so a
        // hook/register/expose change broadcasts notifications/tools/list_changed to SSE clients.
        // This is the wiring the HTTP host was missing - stdio's main() has always done it.
        try {
          configWatchersStop = require('./server').startConfigWatchers(() => build, (n) => {
            // Era-aware fanout: legacy SSE clients get the raw notification; modern listen
            // streams get tagged + filtered copies (tools/list_changed is the only channel).
            pushToSse(n);
            if (n && n.method === 'notifications/tools/list_changed') pushToListeners(n);
          });
        } catch (e) {
          log('config watchers failed to arm (host runs, without hot-reload):', (e && e.message) || String(e));
        }
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
   * stop - end every SSE client, close the HTTP server, then close the aggregator. Idempotent and
   * NEVER throws. Clears every keep-alive timer so the process can exit cleanly (no dangling
   * server, sockets, or timers).
   * @returns {Promise<void>}
   */
  async function stop() {
    if (!started && !httpServer) {
      // Never started (or already fully stopped) - still close any build the caller may have left.
      await closeAggregatorSafely();
      return;
    }
    stopping = true;

    // 0. Disarm the config watchers FIRST, so no debounced reload can fire against the build we're
    //    about to tear down (a reload mutating a half-closed aggregator would be a benign no-op, but
    //    disarming first is the clean order).
    if (configWatchersStop) {
      try { configWatchersStop(); } catch (_e) { /* never throw */ }
      configWatchersStop = null;
    }

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

    // 1b. Close modern listen streams GRACEFULLY per spec: a final RESULT to the listen id
    //     (resultType complete, tagged), then end the stream - and WAIT (bounded) for the ends to
    //     flush before step 2's closeAllConnections destroys the sockets, else the close result is
    //     written but torn out of the kernel buffer before it ever reaches the client (the same
    //     flush-vs-destroy race sendJsonAndClose documents). A dead socket just gets ended.
    const listenFlushes = [];
    for (const entry of Array.from(modernListeners)) {
      try {
        if (entry.res._keepAlive) clearInterval(entry.res._keepAlive);
      } catch (_e) {
        /* ignore */
      }
      try {
        entry.res.write('data: ' + JSON.stringify(modern.listenClose(entry.subId)) + '\n\n');
      } catch (_e) {
        /* half-closed socket - ending below is all that is left */
      }
      listenFlushes.push(
        new Promise((resolve) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          try {
            entry.res.once('finish', done);
            entry.res.once('close', done);
            entry.res.once('error', done);
            entry.res.end();
          } catch (_e) {
            done();
          }
        })
      );
    }
    modernListeners.clear();
    if (listenFlushes.length > 0) {
      // Bounded: a client that never drains cannot wedge stop() - 500ms then move on regardless.
      await Promise.race([
        Promise.all(listenFlushes),
        new Promise((resolve) => {
          const t = setTimeout(resolve, 500);
          if (t && typeof t.unref === 'function') t.unref();
        }),
      ]);
    }

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
          /* closeAllConnections is Node ≥18.2; absent -> close() still resolves on its own */
        }
      });
    }

    // 3. Close the aggregator (idempotent; never throws).
    await closeAggregatorSafely();

    boundPort = null;
    started = false;
    stopping = false;
    lastConnect = { connected: [], failed: [] }; // drop the connect snapshot - the host is down
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
   * reload - apply an expose.json edit live: fully tear down the current aggregator, rebuild from
   * the (now-edited) config, reconnect every enabled upstream, then broadcast list_changed so a
   * connected CLI re-fetches tools/list. A clean full rebuild because expose edits are rare +
   * user-driven (the design doc). The HTTP server keeps running across the reload - only
   * the build is swapped. NEVER throws (connectAll never throws; closeAll never throws).
   * @returns {Promise<void>}
   */
  async function reload() {
    // 1. Build + connect the NEW build FIRST - the live build keeps serving throughout. The old
    //    null-then-rebuild order left a `build == null` window (upstream spawn + handshake long)
    //    during which a wrapped host answered initialize/server/discover as ToolFunnel - an
    // identity leak on the exported API. Swap-then-close, like reloadExpose.
    const next = buildFactory();
    // Arm the wrap scope on the NEW build BEFORE connectAll - the subscription replay in
    // _connectOne is scope-checked, and an unarmed aggregator replayed onto every upstream
    // Arm first, THEN carry the set: the arming setter clears on target change.
    if (next && next.aggregator && typeof serverModule.armWrapChatter === 'function') {
      serverModule.armWrapChatter(next);
    }
    // Subscription carryover - must land BEFORE connectAll so the new aggregator's
    // _connectOne replays the agreed URIs onto the fresh upstream processes.
    const prevAggForSubs = build && build.aggregator;
    if (next && next.aggregator && prevAggForSubs &&
        prevAggForSubs._subscribedUris instanceof Set && prevAggForSubs._subscribedUris.size) {
      next.aggregator._subscribedUris = new Set(prevAggForSubs._subscribedUris);
    }
    if (next && next.aggregator && typeof next.aggregator.connectAll === 'function') {
      try {
        const res = await next.aggregator.connectAll();
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
      recordConnect(null); // no aggregator -> no upstreams; report empty connect state
    }
    // 2. Swap, re-wire the notification bridges onto the new build, then close the OLD aggregator.
    const prev = build && build.aggregator;
    build = next;
    wireAggregatorNotify();
    if (prev && typeof prev.closeAll === 'function') {
      try {
        await prev.closeAll();
      } catch (err) {
        log('aggregator.closeAll threw (ignored):', (err && err.message) || String(err));
      }
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
  // Exported for unit tests / reuse - the small pure seams.
  isLoopbackHost,
  PROTOCOL_VERSION,
  SERVER_INFO,
};
