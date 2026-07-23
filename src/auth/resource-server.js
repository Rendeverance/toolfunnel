'use strict';

/**
 * auth/resource-server.js - OPTIONAL OAuth 2.1 resource-server token validation.
 *
 * This is the ONLY module that touches `jose`, and it does so with a LAZY require so the core
 * gateway keeps `dependencies: {}` (zero runtime deps). `jose` is installed on demand - the CLI
 * `toolfunnel install-oauth` or the admin-UI button (see src/auth/install.js) - and pulled in here
 * only when auth is enabled. If it is not installed, every entry point fails CLOSED with a clear,
 * actionable message; it never silently allows a request through.
 *
 * Why a library and not hand-rolled node:crypto: validating a JWT securely is not the signature
 * math (node:crypto has that) - it is the protocol discipline around it. The dangerous, CVE-prone
 * decisions are (1) PINNING the accepted algorithm so an attacker can't downgrade RS256->HS256 and
 * forge a token by signing with the public key as an HMAC secret, (2) rejecting `alg:none`, (3)
 * ignoring attacker-controlled header params (jku/jwk/x5u), (4) validating iss/aud/exp/nbf, and (5)
 * JWKS caching + key rotation. `jose` encodes all of these into its API; we MUST drive that API
 * correctly - above all, ALWAYS pass the `algorithms` allowlist and the `audience` (the RFC 8707
 * confused-deputy defence). `jose` v5's `require` build uses Node's native crypto (Node ≥18, no
 * Web-Crypto-global dependency), which is why it is the pinned major for this CommonJS project.
 *
 * NOTHING here throws out of validate() - a verification failure is a structured unauthorized
 * result, not an exception. CommonJS only; Node built-ins (node:url, global fetch) + lazy jose.
 */

/**
 * The PINNED jose version installed on demand. A caret range so patch/minor security fixes flow,
 * but the major (v5 - the CommonJS, Node-native-crypto build; v6 is ESM-only and would force a
 * Node ≥22 require-of-ESM floor incompatible with this project's `engines: >=18`) is fixed.
 */
const JOSE_PIN = '^5.10.0';

/** Lazy jose handle: undefined = not yet attempted, null = attempted + absent, object = loaded. */
let _jose = undefined;

/**
 * loadJose - lazily require('jose'), cached. Returns the module or null if it is not installed.
 * NEVER throws (a missing/incompatible jose returns null; the caller fails closed with a message).
 * @returns {object|null}
 */
function loadJose() {
  if (_jose !== undefined) return _jose;
  try {
    // eslint-disable-next-line global-require
    _jose = require('jose');
  } catch (_e) {
    _jose = null;
  }
  return _jose;
}

/** Is jose importable in this runtime? (installed AND loadable as CommonJS). */
function isJoseInstalled() {
  return loadJose() != null;
}

/** Reset the lazy cache - used by tests and by the UI right after an on-demand install. */
function _resetJoseCache() {
  _jose = undefined;
}

/**
 * Build the value of a WWW-Authenticate response header for the Bearer scheme. Per RFC 6750 +
 * RFC 9728: a bare challenge (no credentials) omits the error code; an invalid/insufficient token
 * carries error= and error_description=. `resource_metadata` points the client at the protected-
 * resource-metadata document so it can discover the authorization server (RFC 9728).
 *
 * @param {{ resourceMetadataUrl?:string, error?:string, description?:string }} o
 * @returns {string}
 */
function buildWwwAuthenticate(o) {
  const parts = [];
  if (o && o.resourceMetadataUrl) parts.push(`resource_metadata="${o.resourceMetadataUrl}"`);
  if (o && o.error) parts.push(`error="${o.error}"`);
  if (o && o.description) parts.push(`error_description="${String(o.description).replace(/"/g, "'")}"`);
  return parts.length ? `Bearer ${parts.join(', ')}` : 'Bearer';
}

/**
 * Extract the bearer token from an Authorization header. Returns the token string, or null if the
 * header is absent/malformed/not the Bearer scheme. Exactly one whitespace-delimited token after a
 * case-insensitive "Bearer" is accepted.
 * @param {string|undefined} authorizationHeader
 * @returns {string|null}
 */
function extractBearer(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') return null;
  const m = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(authorizationHeader.trim());
  return m ? m[1] : null;
}

/**
 * Resolve the JWKS URI: prefer an explicit cfg.jwksUri, else discover it from the issuer via OIDC
 * Discovery (RFC 8414 / OpenID Connect Discovery). Tries the OIDC well-known first, then the OAuth
 * Authorization Server Metadata well-known. Bounded by a timeout. Returns the URL string or throws
 * a plain Error (the caller turns a throw into a fail-closed unauthorized result).
 *
 * @param {object} cfg  the resolved auth config
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
async function resolveJwksUri(cfg, timeoutMs) {
  if (cfg.jwksUri) return cfg.jwksUri;
  if (!cfg.issuer) throw new Error('no jwksUri and no issuer to discover one from');

  const base = cfg.issuer.replace(/\/+$/, '');
  const candidates = [
    `${base}/.well-known/openid-configuration`,
    `${base}/.well-known/oauth-authorization-server`,
  ];
  let lastErr = null;
  for (const url of candidates) {
    try {
      const doc = await fetchJson(url, timeoutMs);
      if (doc && typeof doc.jwks_uri === 'string' && doc.jwks_uri.length > 0) {
        // ORIGIN-PIN the discovered value. The ISSUER is operator-trusted config, but the discovery
        // DOCUMENT arrives over the network - it must not be able to point key fetching at a
        // foreign origin (key-substitution + SSRF-adjacent surface). Cross-origin JWKS hosting is
        // real (e.g. Google's issuer and JWKS live on different hosts), so the escape hatch is an
        // EXPLICIT trust statement: set "jwksUri" in the auth config and discovery is skipped.
        let sameOrigin = false;
        try {
          sameOrigin = new URL(doc.jwks_uri).origin === new URL(cfg.issuer).origin;
        } catch (_e) {
          /* malformed URL on either side -> treat as cross-origin -> refuse */
        }
        if (!sameOrigin) {
          throw new Error(
            `discovered jwks_uri "${doc.jwks_uri}" is not on the issuer origin - refusing the ` +
              'cross-origin discovery result. If your IdP intentionally hosts JWKS on a separate ' +
              'origin, state that trust explicitly by setting "jwksUri" in auth/auth.config.json.'
          );
        }
        return doc.jwks_uri;
      }
      lastErr = new Error(`discovery doc at ${url} has no jwks_uri`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('OIDC discovery failed');
}

/**
 * GET + parse JSON with a hard timeout. Throws on non-2xx, network error, bad JSON - or a REDIRECT:
 * discovery metadata must come from the exact well-known URL derived from the trusted issuer
 * (following a redirect would let a bounced endpoint serve the document from anywhere, hollowing
 * out the origin pin above). Only discovery uses this helper; the JWKS fetch itself is jose's.
 */
async function fetchJson(url, timeoutMs) {
  const ac = new AbortController();
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000;
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'error' });
    if (!res || !res.ok) throw new Error(`GET ${url} -> HTTP ${res ? res.status : 'no-response'}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Collect the scopes carried by a verified token: the space-delimited `scope` claim (RFC 8693) or
 * an array `scp` claim (some issuers). Returns a Set of scope strings.
 * @param {object} claims
 * @returns {Set<string>}
 */
function scopesOf(claims) {
  const out = new Set();
  if (claims && typeof claims.scope === 'string') {
    for (const s of claims.scope.split(/\s+/)) if (s) out.add(s);
  }
  if (claims && Array.isArray(claims.scp)) {
    for (const s of claims.scp) if (typeof s === 'string' && s) out.add(s);
  }
  return out;
}

/**
 * createValidator - build a token validator from a resolved auth config.
 *
 * @param {object} cfg  the resolved config (see auth/config.js getConfig()).
 * @param {object} [opts]
 * @param {string}   [opts.resourceMetadataUrl]  the absolute URL of this gateway's protected-
 *                                                resource-metadata document, embedded in 401
 *                                                WWW-Authenticate challenges (RFC 9728).
 * @param {number}   [opts.discoveryTimeoutMs]   OIDC discovery + JWKS fetch timeout (default 10s).
 * @param {Function} [opts.log]                  optional (msg)=>void for server-side diagnostics
 *                                                (the real reason is logged, NOT leaked to clients).
 * @returns {{ validate:(authHeader:string|undefined)=>Promise<object>, unauthorized:Function,
 *             jwksReady:()=>boolean }}
 */
function createValidator(cfg, opts) {
  const o = opts || {};
  const resourceMetadataUrl = typeof o.resourceMetadataUrl === 'string' ? o.resourceMetadataUrl : '';
  const log = typeof o.log === 'function' ? o.log : () => {};
  const discoveryTimeoutMs = Number.isFinite(o.discoveryTimeoutMs) ? o.discoveryTimeoutMs : 10000;

  // The JWKS resolver is built ONCE, lazily, on first validate - memoised across calls. jose's
  // createRemoteJWKSet owns the HTTP fetch, in-memory cache, cooldown, and refetch-on-unknown-kid
  // (key rotation) - we do not hand-roll any of that. A build failure is recomputed next call so a
  // transient discovery outage self-heals.
  let jwks = null;
  let jwksBuildPromise = null;

  function unauthorized(status, error, description, logReason) {
    if (logReason) log(`auth reject: ${logReason}`);
    return {
      ok: false,
      status: status || 401,
      error: error || 'invalid_token',
      errorDescription: description || '',
      wwwAuthenticate: buildWwwAuthenticate({ resourceMetadataUrl, error, description }),
    };
  }

  async function ensureJwks() {
    if (jwks) return jwks;
    if (!jwksBuildPromise) {
      jwksBuildPromise = (async () => {
        const jose = loadJose();
        if (!jose) throw new Error('jose is not installed');
        const uri = await resolveJwksUri(cfg, discoveryTimeoutMs);
        // cooldownDuration throttles refetches on unknown-kid; cacheMaxAge bounds key staleness.
        return jose.createRemoteJWKSet(new URL(uri), { cooldownDuration: 30000, cacheMaxAge: 600000 });
      })().catch((e) => {
        jwksBuildPromise = null; // allow a retry on the next request (self-heal)
        throw e;
      });
    }
    jwks = await jwksBuildPromise;
    return jwks;
  }

  async function validate(authorizationHeader) {
    // Fail closed if the dependency or configuration is not coherent - never allow on misconfig.
    const jose = loadJose();
    if (!jose) {
      return unauthorized(500, 'server_error', 'authentication unavailable', 'jose not installed');
    }
    if (!cfg.audience) {
      // Without an audience we cannot bind the token to THIS resource (RFC 8707) - refuse rather
      // than validate an unbound token (the confused-deputy hole). Belt-and-braces: the transport
      // refuses to start in this state, but a request must still never slip through.
      return unauthorized(500, 'server_error', 'authentication misconfigured', 'no audience configured');
    }

    const token = extractBearer(authorizationHeader);
    if (!token) {
      // No credentials -> a BARE challenge (no error code), the canonical "authenticate, please".
      return unauthorized(401, '', '', 'missing or malformed Authorization header');
    }

    let resolver;
    try {
      resolver = await ensureJwks();
    } catch (e) {
      // Cannot reach/parse the key source -> cannot verify -> reject (do not leak the URL/reason).
      return unauthorized(401, 'invalid_token', 'unable to verify token', `jwks unavailable: ${(e && e.message) || e}`);
    }

    let result;
    try {
      // The security-critical call. algorithms PINS the allowlist (blocks alg-confusion + alg:none);
      // issuer + audience are ENFORCED by jose; clockTolerance bounds exp/nbf skew. We never read the
      // token header to choose the algorithm - the allowlist is fixed from config.
      result = await jose.jwtVerify(token, resolver, {
        issuer: cfg.issuer || undefined,
        audience: cfg.audience,
        algorithms: cfg.algorithms,
        clockTolerance: cfg.clockToleranceSec,
        // Require `exp` to be PRESENT - jose only checks exp/nbf when present, so without this a
        // token that omits exp would be accepted as never-expiring. RFC 9068 access tokens carry
        // exp; a resource server should reject one that does not.
        requiredClaims: ['exp'],
      });
    } catch (e) {
      return unauthorized(401, 'invalid_token', 'token verification failed', `jwtVerify: ${(e && e.code) || (e && e.message) || e}`);
    }

    const claims = result && result.payload ? result.payload : {};

    // Optional scope enforcement - every required scope must be present, else 403 insufficient_scope.
    if (Array.isArray(cfg.requiredScopes) && cfg.requiredScopes.length > 0) {
      const have = scopesOf(claims);
      const missing = cfg.requiredScopes.filter((s) => !have.has(s));
      if (missing.length > 0) {
        return {
          ok: false,
          status: 403,
          error: 'insufficient_scope',
          errorDescription: `missing scope: ${missing.join(' ')}`,
          wwwAuthenticate: buildWwwAuthenticate({
            resourceMetadataUrl,
            error: 'insufficient_scope',
            description: `missing scope: ${missing.join(' ')}`,
          }),
        };
      }
    }

    return {
      ok: true,
      sub: typeof claims.sub === 'string' ? claims.sub : undefined,
      claims,
      scopes: Array.from(scopesOf(claims)),
    };
  }

  return { validate, unauthorized, jwksReady: () => jwks != null };
}

/**
 * protectedResourceMetadata - the RFC 9728 Protected Resource Metadata document for this gateway.
 * Served (unauthenticated) at /.well-known/oauth-protected-resource so a client can discover which
 * authorization server issues tokens for this resource. NEVER throws.
 * @param {object} cfg  the resolved auth config
 * @returns {{ resource:string, authorization_servers:string[], bearer_methods_supported:string[],
 *             scopes_supported?:string[] }}
 */
function protectedResourceMetadata(cfg) {
  const doc = {
    resource: (cfg && cfg.audience) || '',
    authorization_servers: cfg && cfg.issuer ? [cfg.issuer] : [],
    bearer_methods_supported: ['header'],
  };
  if (cfg && Array.isArray(cfg.requiredScopes) && cfg.requiredScopes.length > 0) {
    doc.scopes_supported = cfg.requiredScopes.slice();
  }
  return doc;
}

module.exports = {
  JOSE_PIN,
  isJoseInstalled,
  createValidator,
  protectedResourceMetadata,
  buildWwwAuthenticate,
  extractBearer,
  scopesOf,
  resolveJwksUri,
  _resetJoseCache,
};
