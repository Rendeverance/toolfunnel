'use strict';

/**
 * modern.js - the 2026-07-28 ("modern") protocol era, as a pure module.
 *
 * The 2026-07-28 MCP revision is a BREAKING change: it removes the `initialize` handshake,
 * protocol-level sessions and the standalone GET/SSE stream, and replaces them with per-request
 * `_meta` protocol fields, required HTTP routing headers, `server/discover` and
 * `subscriptions/listen`. ToolFunnel 0.6.0 is a DUAL-ERA server: a request carrying modern
 * per-request `_meta` is served under these semantics; an `initialize` request selects the
 * legacy (2024-11-05) path, which is byte-for-byte the 0.5.0 behaviour. The spec's dual-era
 * server rule ("MAY serve both eras concurrently on the same endpoint or process") is exactly
 * what this module enables.
 *
 * This module is PURE and transport-free (the protocol.js philosophy): it owns every modern-era
 * SHAPE - era detection, request validation, header validation, result decoration,
 * `server/discover`, the `subscriptions/listen` message shapes and the modern error codes - and
 * executes nothing. `server.js` (stdio) and `http-transport.js` bind it to their wires.
 *
 * Spec sources (RC, locked 2026-05-21; re-verify against the FINAL spec before release):
 *   - modelcontextprotocol.io/specification/draft/changelog
 *   - .../draft/basic/transports/streamable-http   (headers, validation, error examples)
 *   - .../draft/basic/versioning                   (era model, compatibility matrix)
 *   - .../draft/server/discover                    (DiscoverResult shape)
 *   - .../draft/basic/patterns/subscriptions       (subscriptions/listen shapes)
 *   - .../draft/basic/index                        (_meta table, resultType, error allocation)
 *
 * CommonJS only. Node built-ins only. No transport. No SDK.
 */

/** The modern protocol revision this server implements. */
const MODERN_PROTOCOL_VERSION = '2026-07-28';

/** Reserved `_meta` key prefix + the specific keys the spec defines. */
const META_KEYS = Object.freeze({
  PROTOCOL_VERSION: 'io.modelcontextprotocol/protocolVersion',
  CLIENT_CAPABILITIES: 'io.modelcontextprotocol/clientCapabilities',
  CLIENT_INFO: 'io.modelcontextprotocol/clientInfo',
  SERVER_INFO: 'io.modelcontextprotocol/serverInfo',
  SUBSCRIPTION_ID: 'io.modelcontextprotocol/subscriptionId',
  LOG_LEVEL: 'io.modelcontextprotocol/logLevel',
});

/** Modern-era JSON-RPC error codes (-32020..-32099 is the spec-reserved range). */
const ERR_MODERN = Object.freeze({
  HEADER_MISMATCH: -32020,
  MISSING_REQUIRED_CLIENT_CAPABILITY: -32021,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
});

/** JSON-RPC codes shared with the legacy path (kept local so this module stays dependency-free). */
const ERR_INVALID_PARAMS = -32602;
const ERR_METHOD_NOT_FOUND = -32601;

/**
 * Cache hints for the modern CacheableResult surfaces. tools/list can change on any config edit
 * (and we push list_changed when it does), so the freshness hint is short; discover output only
 * changes on upgrade/identity edits, so it can live longer. Both are 'private': this is a
 * per-user gateway whose surface is the USER's visibility matrix - a shared cache must not serve
 * one user's tool surface to another.
 */
const CACHE_HINTS = Object.freeze({
  toolsList: Object.freeze({ ttlMs: 60000, cacheScope: 'private' }),
  discover: Object.freeze({ ttlMs: 3600000, cacheScope: 'private' }),
});

/** The methods whose Mcp-Name header must mirror params.name / params.uri. */
const NAMED_METHODS = Object.freeze({
  'tools/call': 'name',
  'resources/read': 'uri',
  'prompts/get': 'name',
});

/** Safely pull params._meta from a parsed JSON-RPC message. Returns null when absent/malformed. */
function getMeta(msg) {
  const meta = msg && msg.params && msg.params._meta;
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null;
}

/**
 * Era detection (the spec's dual-era server rule): a request is MODERN iff its params._meta
 * carries the protocolVersion key. `initialize` is ALWAYS legacy - the spec says an initialize
 * request selects legacy semantics, so callers must check the method first (server.js does).
 * @param {object} msg  a parsed JSON-RPC message
 * @returns {boolean}
 */
function isModernRequest(msg) {
  const meta = getMeta(msg);
  return !!(meta && typeof meta[META_KEYS.PROTOCOL_VERSION] === 'string');
}

/**
 * Validate a modern request's `_meta` protocol fields. Returns null when valid, else a
 * descriptor { code, message, data?, httpStatus } the caller turns into a JSON-RPC error
 * (HTTP transports also use httpStatus - the spec mandates 400 for all of these).
 *
 * Spec: protocolVersion + clientCapabilities are MUST; a missing required field is malformed
 * (-32602 + HTTP 400); an unsupported version is -32022 with data.supported/requested.
 * @param {object} msg  a parsed JSON-RPC message already known to be modern-shaped
 * @returns {null | { code:number, message:string, data?:object, httpStatus:number }}
 */
function validateModernRequest(msg) {
  const meta = getMeta(msg);
  if (!meta) {
    return {
      code: ERR_INVALID_PARAMS,
      message: 'Invalid params: modern requests require params._meta',
      httpStatus: 400,
    };
  }
  const version = meta[META_KEYS.PROTOCOL_VERSION];
  if (version !== MODERN_PROTOCOL_VERSION) {
    return {
      code: ERR_MODERN.UNSUPPORTED_PROTOCOL_VERSION,
      message: 'Unsupported protocol version',
      data: { supported: supportedVersions(), requested: version },
      httpStatus: 400,
    };
  }
  const caps = meta[META_KEYS.CLIENT_CAPABILITIES];
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
    return {
      code: ERR_INVALID_PARAMS,
      message:
        'Invalid params: _meta["' + META_KEYS.CLIENT_CAPABILITIES + '"] (object) is required',
      httpStatus: 400,
    };
  }
  return null;
}

/**
 * Validate the modern HTTP routing headers against the request body (HTTP transport only -
 * stdio has no headers). Called ONLY for requests already detected as modern. Enforcement is
 * strict per the spec ("These headers are REQUIRED for compliance"):
 *   - MCP-Protocol-Version MUST be present and MUST match the body's _meta protocolVersion.
 *   - Mcp-Method MUST be present on all requests and MUST match the body method.
 *   - Mcp-Name MUST be present on tools/call | resources/read | prompts/get and MUST match
 *     params.name / params.uri.
 * Returns null when valid, else { code, message, httpStatus:400 }.
 * @param {object} headers  node req.headers (lower-cased keys)
 * @param {object} msg      the parsed JSON-RPC body
 * @returns {null | { code:number, message:string, httpStatus:number }}
 */
function validateModernHeaders(headers, msg) {
  const h = headers || {};
  const mismatch = (message) => ({ code: ERR_MODERN.HEADER_MISMATCH, message, httpStatus: 400 });

  const meta = getMeta(msg) || {};
  const bodyVersion = meta[META_KEYS.PROTOCOL_VERSION];
  const headerVersion = h['mcp-protocol-version'];
  if (typeof headerVersion !== 'string' || headerVersion.length === 0) {
    return mismatch('Header mismatch: MCP-Protocol-Version header is required on modern requests');
  }
  if (headerVersion !== bodyVersion) {
    return mismatch(
      `Header mismatch: MCP-Protocol-Version header value '${headerVersion}' does not match body value '${bodyVersion}'`
    );
  }

  const headerMethod = h['mcp-method'];
  if (typeof headerMethod !== 'string' || headerMethod.length === 0) {
    return mismatch('Header mismatch: Mcp-Method header is required on modern requests');
  }
  if (headerMethod !== msg.method) {
    return mismatch(
      `Header mismatch: Mcp-Method header value '${headerMethod}' does not match body value '${msg.method}'`
    );
  }

  const nameField = NAMED_METHODS[msg.method];
  if (nameField) {
    const bodyName = msg.params ? msg.params[nameField] : undefined;
    const headerName = h['mcp-name'];
    if (typeof headerName !== 'string' || headerName.length === 0) {
      return mismatch(`Header mismatch: Mcp-Name header is required for ${msg.method}`);
    }
    if (headerName !== bodyName) {
      return mismatch(
        `Header mismatch: Mcp-Name header value '${headerName}' does not match body value '${bodyName}'`
      );
    }
  }
  return null;
}

/** The protocol versions this dual-era server speaks (modern first; legacy negotiated via
 *  initialize). Kept as a function so the legacy version is injected once by the server, not
 *  duplicated here. server.js seeds it via setLegacyVersion(). */
let _legacyVersion = null;
function setLegacyVersion(v) {
  if (typeof v === 'string' && v.length > 0) _legacyVersion = v;
}
function supportedVersions() {
  return _legacyVersion ? [MODERN_PROTOCOL_VERSION, _legacyVersion] : [MODERN_PROTOCOL_VERSION];
}

/**
 * Decorate a result object for the modern era, in place-safe copy:
 *   - `resultType: 'complete'` when absent - the preserve-if-present branch below is
 *     LOAD-BEARING for Bridge B, whose suspensions arrive here already carrying
 *     `resultType: 'input_required'` and must pass through undamaged (the elicitation
 * bridge DOES originate input_required).
 *   - `_meta[serverInfo]` (SHOULD on every result).
 *   - cache hints (`ttlMs` + `cacheScope`, REQUIRED on the CacheableResult surfaces) when
 *     `cacheHints` is given.
 * @param {object} result      the legacy-shaped result payload (e.g. { tools: [...] })
 * @param {object} serverInfo  { name, version }
 * @param {{ttlMs:number, cacheScope:string}} [cacheHints]
 * @returns {object} a new result object carrying the modern fields
 */
function decorateResult(result, serverInfo, cacheHints) {
  const base = result && typeof result === 'object' && !Array.isArray(result) ? result : { value: result };
  const out = Object.assign({}, base);
  if (typeof out.resultType !== 'string') out.resultType = 'complete';
  const meta = Object.assign({}, out._meta);
  if (serverInfo && !meta[META_KEYS.SERVER_INFO]) meta[META_KEYS.SERVER_INFO] = serverInfo;
  out._meta = meta;
  if (cacheHints) {
    if (typeof out.ttlMs !== 'number') out.ttlMs = cacheHints.ttlMs;
    if (typeof out.cacheScope !== 'string') out.cacheScope = cacheHints.cacheScope;
  }
  return out;
}

/**
 * Build the `server/discover` result (servers MUST implement it; calling it is optional and
 * doubles as the spec's stdio era-probe). Answered for modern AND meta-less probes - the RC
 * does not define the meta-less case, so we answer rather than reject (a probe that errors
 * tells a dual-era client we are legacy-only, which would be a lie).
 * @param {object} serverInfo    { name, version }
 * @param {object} capabilities  the capability object to advertise (tools etc.)
 * @param {string} [instructions] optional natural-language guidance for LLM clients
 * @returns {object}
 */
function discoverResult(serverInfo, capabilities, instructions) {
  const out = {
    resultType: 'complete',
    supportedVersions: supportedVersions(),
    capabilities: capabilities && typeof capabilities === 'object' ? capabilities : { tools: {} },
    _meta: {},
    ttlMs: CACHE_HINTS.discover.ttlMs,
    cacheScope: CACHE_HINTS.discover.cacheScope,
  };
  if (serverInfo) out._meta[META_KEYS.SERVER_INFO] = serverInfo;
  if (typeof instructions === 'string' && instructions.length > 0) out.instructions = instructions;
  return out;
}

/**
 * Normalise a subscriptions/listen request's notification filter into the subset the SHAPE
 * supports: toolsListChanged, promptsListChanged, resourcesListChanged, resourceSubscriptions
 * (per-URI). This is the SYNTACTIC pass only - whether resourceSubscriptions can actually be
 * HONOURED depends on the connected upstreams (a legacy upstream needs a forwarded
 * resources/subscribe), so the transports refine `agreed` against the aggregator before acking.
 * The ack's `notifications` is what the server actually honours, not what was asked for.
 * @param {object} params  the listen request params
 * @returns {{ requested: object, agreed: object }}
 */
function normaliseListenFilter(params) {
  const req = params && params.notifications && typeof params.notifications === 'object'
    ? params.notifications
    : {};
  const agreed = {};
  if (req.toolsListChanged === true) agreed.toolsListChanged = true;
  if (req.promptsListChanged === true) agreed.promptsListChanged = true;
  if (req.resourcesListChanged === true) agreed.resourcesListChanged = true;
  // resourceSubscriptions: an array of resource URIs the client wants change notifications for.
  if (Array.isArray(req.resourceSubscriptions) && req.resourceSubscriptions.length) {
    agreed.resourceSubscriptions = req.resourceSubscriptions.filter((u) => typeof u === 'string');
  }
  return { requested: req, agreed };
}

/** Map a change-notification METHOD to the subscriptions/listen filter channel that gates it. */
const NOTIFICATION_CHANNEL = Object.freeze({
  'notifications/tools/list_changed': 'toolsListChanged',
  'notifications/prompts/list_changed': 'promptsListChanged',
  'notifications/resources/list_changed': 'resourcesListChanged',
  'notifications/resources/updated': 'resourceSubscriptions',
});

/**
 * Does a change-notification belong to a channel this subscription AGREED to? tools/prompts/
 * resources-list-changed gate on the boolean flag; resources/updated gates on the uri appearing in
 * the agreed resourceSubscriptions list. A notification with no known channel is never delivered on
 * a listen stream (request-scoped notifications ride their own request's stream, not this one).
 * @param {object} notification  a JSON-RPC notification
 * @param {object} agreed        the agreed filter from normaliseListenFilter
 * @returns {boolean}
 */
function notificationMatchesFilter(notification, agreed) {
  if (!notification || typeof notification.method !== 'string' || !agreed) return false;
  const channel = NOTIFICATION_CHANNEL[notification.method];
  if (!channel) return false;
  if (channel === 'resourceSubscriptions') {
    const subs = agreed.resourceSubscriptions;
    if (!Array.isArray(subs) || !subs.length) return false;
    const uri = notification.params && notification.params.uri;
    return typeof uri === 'string' && subs.includes(uri);
  }
  return agreed[channel] === true;
}

/**
 * The acknowledgment notification a server MUST send as the FIRST message on a listen stream.
 * @param {*} subscriptionId  the JSON-RPC id of the subscriptions/listen request
 * @param {object} agreed     the honoured filter subset from normaliseListenFilter
 * @returns {object} a JSON-RPC notification object
 */
function listenAck(subscriptionId, agreed) {
  return {
    jsonrpc: '2.0',
    method: 'notifications/subscriptions/acknowledged',
    params: {
      _meta: { [META_KEYS.SUBSCRIPTION_ID]: subscriptionId },
      notifications: agreed || {},
    },
  };
}

/**
 * Tag a notification with the subscription id it belongs to (every notification on a listen
 * stream MUST carry it). Returns a copy; the input is not mutated.
 * @param {object} notification  a JSON-RPC notification (e.g. tools/list_changed)
 * @param {*} subscriptionId
 * @returns {object}
 */
function tagNotification(notification, subscriptionId) {
  const n = notification || {};
  const params = Object.assign({}, n.params);
  params._meta = Object.assign({}, params._meta, { [META_KEYS.SUBSCRIPTION_ID]: subscriptionId });
  return Object.assign({}, n, { params });
}

/**
 * The graceful-closure result for a listen stream (the server ends a subscription by sending a
 * final RESULT to the listen request's id, then closing the stream).
 * @param {*} subscriptionId  the listen request's JSON-RPC id
 * @returns {object} a JSON-RPC result object
 */
function listenClose(subscriptionId) {
  return {
    jsonrpc: '2.0',
    id: subscriptionId,
    result: {
      resultType: 'complete',
      _meta: { [META_KEYS.SUBSCRIPTION_ID]: subscriptionId },
    },
  };
}

module.exports = {
  MODERN_PROTOCOL_VERSION,
  META_KEYS,
  ERR_MODERN,
  CACHE_HINTS,
  getMeta,
  isModernRequest,
  validateModernRequest,
  validateModernHeaders,
  setLegacyVersion,
  supportedVersions,
  decorateResult,
  discoverResult,
  normaliseListenFilter,
  notificationMatchesFilter,
  NOTIFICATION_CHANNEL,
  listenAck,
  tagNotification,
  listenClose,
};
