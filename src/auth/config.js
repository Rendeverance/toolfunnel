'use strict';

/**
 * auth/config.js — the toggle + settings for OPTIONAL OAuth 2.1 resource-server validation.
 *
 * DEFAULT OFF (the gateway is loopback-only and unauthenticated until you turn this on). Nothing
 * is read or required unless auth has been explicitly enabled via setConfig(). A MISSING config
 * file means disabled — the safe default — so a fresh checkout authenticates nothing and pulls in
 * no dependency.
 *
 * Design rules (mirrors src/core/logger.js — the proven config pattern):
 *   - Zero RUNTIME dependencies. Node built-ins only (fs, path). The jose library is pulled in ONLY
 *     by the validator (src/auth/resource-server.js), ONLY when auth is enabled, and is installed
 *     on demand (CLI `install-oauth` / the UI button). This module never touches jose.
 *   - Config is read FRESH on every call (no caching), so a toggle/edit takes effect for the very
 *     next request without a reconnect or restart — exactly like the logger + tool-state overlays.
 *   - Nothing here throws. A bad/unreadable/malformed config degrades to the safe default (disabled)
 *     so a misconfiguration can never crash the transport.
 *
 * Config file: <root>/auth/auth.config.json  (NOT created until setConfig() writes it)
 *   {
 *     "enabled": false,
 *     "issuer": "https://auth.example.com",      // the OAuth 2.1 / OIDC authorization server
 *     "audience": "https://gateway.example.com", // THIS gateway's resource URI — RFC 8707 audience
 *                                                //   binding; the confused-deputy defence
 *     "jwksUri": "https://auth.example.com/.well-known/jwks.json", // explicit JWKS; else derived
 *                                                //   from the issuer via OIDC discovery
 *     "algorithms": ["RS256", "ES256"],          // the PINNED signature-algorithm allowlist
 *     "requiredScopes": [],                      // optional — every listed scope must be present
 *     "clockToleranceSec": 30                    // exp/nbf skew tolerance (seconds)
 *   }
 *
 * CommonJS only.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Repo root: <root>/src/auth/config.js -> two dirs up. */
const ROOT = path.resolve(__dirname, '..', '..');

/** The toggle/config file. NOT created until setConfig() writes it. */
const CONFIG_PATH = path.join(ROOT, 'auth', 'auth.config.json');

/** Safe defaults — used whenever the config file is absent or unreadable. */
const DEFAULTS = Object.freeze({
  enabled: false,
  issuer: '',
  audience: '',
  jwksUri: '',
  algorithms: ['RS256', 'ES256'],
  requiredScopes: [],
  clockToleranceSec: 30,
});

/** A string field, defaulting to '' when not a non-empty string. */
function str(v, dflt) {
  return typeof v === 'string' && v.length > 0 ? v : dflt;
}

/** A string[] field — keep only non-empty strings; fall back to `dflt` when not a usable array. */
function strArray(v, dflt) {
  if (!Array.isArray(v)) return dflt.slice();
  const out = v.filter((x) => typeof x === 'string' && x.length > 0);
  return out.length > 0 ? out : dflt.slice();
}

/**
 * getConfig — the resolved auth config. Reads the file fresh; a missing/unreadable/malformed file
 * resolves to the safe defaults (disabled). NEVER throws.
 *
 * @returns {{ enabled:boolean, issuer:string, audience:string, jwksUri:string,
 *             algorithms:string[], requiredScopes:string[], clockToleranceSec:number }}
 */
function getConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return cloneDefaults();
    }
    const clock = Number(parsed.clockToleranceSec);
    return {
      enabled: parsed.enabled === true,
      issuer: str(parsed.issuer, DEFAULTS.issuer),
      audience: str(parsed.audience, DEFAULTS.audience),
      jwksUri: str(parsed.jwksUri, DEFAULTS.jwksUri),
      algorithms: strArray(parsed.algorithms, DEFAULTS.algorithms),
      requiredScopes: strArray(parsed.requiredScopes, DEFAULTS.requiredScopes),
      // Clamp to a sane, non-negative tolerance; a >5min skew signals a clock problem, not validity.
      clockToleranceSec:
        Number.isFinite(clock) && clock >= 0 ? Math.min(Math.floor(clock), 300) : DEFAULTS.clockToleranceSec,
    };
  } catch (_err) {
    // Missing file = disabled (the safe default); also covers unreadable/malformed.
    return cloneDefaults();
  }
}

/** A fresh, mutation-safe copy of the defaults (arrays cloned so a caller can't poison the frozen one). */
function cloneDefaults() {
  return {
    enabled: DEFAULTS.enabled,
    issuer: DEFAULTS.issuer,
    audience: DEFAULTS.audience,
    jwksUri: DEFAULTS.jwksUri,
    algorithms: DEFAULTS.algorithms.slice(),
    requiredScopes: DEFAULTS.requiredScopes.slice(),
    clockToleranceSec: DEFAULTS.clockToleranceSec,
  };
}

/**
 * configError — a human-readable reason the CURRENT config could not gate requests, or null if it
 * is coherent enough to enforce. Used by the transport + UI to fail CLOSED with a clear message
 * rather than silently mis-validating. Only meaningful when `enabled` is true.
 *
 * Enforcement requires: an issuer, an audience (the RFC 8707 confused-deputy defence — a gateway
 * that does not bind tokens to its own resource URI is exploitable), at least one pinned algorithm,
 * and a key source (explicit jwksUri OR an issuer to derive one from via OIDC discovery).
 *
 * @param {object} [cfg]  defaults to getConfig()
 * @returns {string|null}
 */
function configError(cfg) {
  const c = cfg || getConfig();
  if (!c.enabled) return null; // disabled → nothing to enforce, no error
  if (!c.issuer) return 'auth enabled but "issuer" is not set';
  if (!c.audience) return 'auth enabled but "audience" (this gateway\'s resource URI) is not set — required to bind tokens (RFC 8707)';
  if (!Array.isArray(c.algorithms) || c.algorithms.length === 0) return 'auth enabled but no signature "algorithms" are pinned';
  // (A key source is always available: issuer is mandatory above, and jwksUri is derived from it
  // via OIDC discovery when not given — so no separate jwksUri-or-issuer check is needed here.)
  return null;
}

/**
 * setConfig — atomically merge a patch into auth/auth.config.json (temp + rename). Merges with the
 * current resolved config so a partial patch (e.g. { enabled: true }) preserves the other fields.
 * Creates the auth/ dir and the file if absent — this is the ONLY function that creates it.
 *
 * @param {object} patch  any subset of the config fields
 * @returns {object} the merged, written config
 */
function setConfig(patch) {
  const current = getConfig();
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};

  const next = {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : current.enabled,
    issuer: typeof p.issuer === 'string' ? p.issuer : current.issuer,
    audience: typeof p.audience === 'string' ? p.audience : current.audience,
    jwksUri: typeof p.jwksUri === 'string' ? p.jwksUri : current.jwksUri,
    algorithms: Array.isArray(p.algorithms) ? strArray(p.algorithms, current.algorithms) : current.algorithms,
    requiredScopes: Array.isArray(p.requiredScopes)
      ? p.requiredScopes.filter((x) => typeof x === 'string' && x.length > 0)
      : current.requiredScopes,
    clockToleranceSec:
      Number.isFinite(Number(p.clockToleranceSec)) && Number(p.clockToleranceSec) >= 0
        ? Math.min(Math.floor(Number(p.clockToleranceSec)), 300)
        : current.clockToleranceSec,
  };

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  // Atomic write: unique temp file in the same dir, then rename over the target.
  const tmp = CONFIG_PATH + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);

  return next;
}

module.exports = { getConfig, setConfig, configError, CONFIG_PATH, DEFAULTS };
