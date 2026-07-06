'use strict';

/**
 * auth.test.js — the OPTIONAL OAuth 2.1 resource-server gate (src/auth/* + the HTTP transport).
 *
 * Four parts:
 *   A. config module    — default-OFF, merge, tolerant load, configError() coherence checks.
 *   B. validator (unit) — mint RS256 tokens against a local JWKS and assert the security decisions:
 *                         valid passes; wrong issuer / wrong audience (confused-deputy) / expired
 *                         fail; alg:none rejected; HS256-when-RS256-pinned (algorithm confusion)
 *                         rejected; missing/garbage Authorization → bare 401 challenge.
 *   C. transport (e2e)  — auth ENABLED: POST /mcp with no token → 401 (+ WWW-Authenticate); with a
 *                         valid token → 200; /.well-known/oauth-protected-resource reachable
 *                         UNauthenticated; /health gated. Auth DISABLED: unchanged (no token → 200).
 *   D. start guards     — non-loopback bind refused without auth; auth-enabled-but-misconfigured
 *                         refused at start (fail-fast).
 *
 * Mutates the SHARED on-disk auth config (auth/auth.config.json); snapshots + restores it. Run
 * SEQUENTIALLY via run-all.js (never `node --test`). Uses jose (a devDependency) for key+token
 * minting — the same library the gateway validates with.
 *
 * Node built-ins (assert, http, fs, path) + jose. Run:  node test/auth.test.js  (exit 0 = pass).
 */

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { generateKeyPair, exportJWK, SignJWT } = require('jose');

const ROOT = path.resolve(__dirname, '..');
const authConfig = require(path.join(ROOT, 'src', 'auth', 'config.js'));
const resourceServer = require(path.join(ROOT, 'src', 'auth', 'resource-server.js'));
const { createHttpMcpServer } = require(path.join(ROOT, 'src', 'mcp', 'http-transport.js'));
const { createUiServer } = require(path.join(ROOT, 'src', 'ui', 'server.js'));

const CONFIG_PATH = authConfig.CONFIG_PATH;
const KID = 'test-key-1';
const ISSUER = 'https://issuer.test';
const AUDIENCE = 'https://gateway.test';

// ── tiny loopback HTTP client (mirrors http.test.js) ────────────────────────────────────────────
function request(o) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, o.headers || {});
    if (o.body != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(o.body, 'utf8');
    }
    const req = http.request({ host: o.host, port: o.port, method: o.method, path: o.path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_e) { /* non-JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (o.body != null) req.write(o.body);
    req.end();
  });
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

(async () => {
  const pass = [];

  // Snapshot the shared auth config so the suite leaves it byte-identical.
  const hadConfig = fs.existsSync(CONFIG_PATH);
  const originalConfig = hadConfig ? fs.readFileSync(CONFIG_PATH, 'utf8') : null;

  // On a catchable interrupt (Ctrl-C / POSIX SIGTERM) restore the config synchronously, so a killed
  // run can't leave auth ENABLED and break the NEXT suite's http.test.js (which expects auth off).
  // The runner's Windows timeout-kill (TerminateProcess) is uncatchable — http.test.js force-disables
  // auth at startup as the belt-and-braces guard for that case.
  function restoreConfigSync() {
    try {
      if (originalConfig != null) fs.writeFileSync(CONFIG_PATH, originalConfig);
      else fs.unlinkSync(CONFIG_PATH);
    } catch (_e) { /* best-effort */ }
  }
  process.on('SIGINT', () => { restoreConfigSync(); process.exit(1); });
  process.on('SIGTERM', () => { restoreConfigSync(); process.exit(1); });

  // ── Key material + local JWKS servers (shared by parts B + C) ─────────────────────────────────
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  // A SECOND keypair whose public key is NOT in the trusted JWKS — for the wrong-key signature test.
  const wrong = await generateKeyPair('RS256');

  const jwksServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((r) => jwksServer.listen(0, '127.0.0.1', r));
  const jwksUri = `http://127.0.0.1:${jwksServer.address().port}/jwks`;

  // A JWKS serving the SAME RSA public key but WITHOUT an `alg` pin. This is what makes the
  // algorithm-allowlist test meaningful: with no per-key alg, jose would ACCEPT an RS384 token if
  // `algorithms` were omitted — so a rejection there proves the validator's allowlist is doing the
  // work (not jose's key-type/alg matching). (A JWKS whose key pins alg:RS256 would reject RS384 on
  // its own, masking the control.)
  const jwkNoAlg = Object.assign({}, jwk);
  delete jwkNoAlg.alg;
  const jwksServerNoAlg = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwkNoAlg] }));
  });
  await new Promise((r) => jwksServerNoAlg.listen(0, '127.0.0.1', r));
  const jwksUriNoAlg = `http://127.0.0.1:${jwksServerNoAlg.address().port}/jwks`;

  /** Mint an RS256 token, overridable per field for the negative cases. */
  async function mint(over) {
    const o = over || {};
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT(o.claims || {})
      .setProtectedHeader({ alg: 'RS256', kid: o.kid || KID, typ: 'at+jwt' })
      .setIssuedAt(now)
      .setIssuer(o.issuer || ISSUER)
      .setAudience(o.audience || AUDIENCE)
      .setExpirationTime(o.exp != null ? o.exp : now + 300)
      .setSubject(o.sub || 'user-123');
    return jwt.sign(privateKey);
  }

  let host;
  let port;
  let uiHost;
  let discoServer = null;

  try {
    // ════════════════════════════════════════════════════════════════════════════════════════
    // PART A — config module
    // ════════════════════════════════════════════════════════════════════════════════════════
    // A1: a clean default (delete the file → absent = disabled).
    try { fs.unlinkSync(CONFIG_PATH); } catch (_e) { /* may not exist */ }
    let cfg = authConfig.getConfig();
    assert.strictEqual(cfg.enabled, false, 'A1: absent config → enabled:false (default OFF)');
    assert.deepStrictEqual(cfg.algorithms, ['RS256', 'ES256'], 'A1: default algorithms pinned');
    assert.strictEqual(authConfig.configError(cfg), null, 'A1: disabled config has no configError');
    pass.push('A1: absent auth config defaults to OFF, no error');

    // A2: setConfig merges + persists; partial patch preserves other fields.
    authConfig.setConfig({ enabled: true, issuer: ISSUER });
    authConfig.setConfig({ audience: AUDIENCE }); // a second partial patch must keep enabled+issuer
    cfg = authConfig.getConfig();
    assert.strictEqual(cfg.enabled, true, 'A2: enabled persisted across a second partial patch');
    assert.strictEqual(cfg.issuer, ISSUER, 'A2: issuer preserved by the audience-only patch (merge)');
    assert.strictEqual(cfg.audience, AUDIENCE, 'A2: audience set by the second patch');
    pass.push('A2: setConfig merges partial patches atomically');

    // A3: configError flags the confused-deputy hole — enabled with no audience is refused.
    authConfig.setConfig({ enabled: true, issuer: ISSUER, audience: '' });
    const errNoAud = authConfig.configError(authConfig.getConfig());
    assert.ok(errNoAud && /audience/i.test(errNoAud), 'A3: enabled-without-audience is a configError (RFC 8707)');
    // and a coherent config clears it:
    authConfig.setConfig({ audience: AUDIENCE, jwksUri });
    assert.strictEqual(authConfig.configError(authConfig.getConfig()), null, 'A3: coherent config has no error');
    pass.push('A3: configError catches missing-audience (confused-deputy) and clears when coherent');

    // A4: tolerant load — a malformed file degrades to defaults, never throws.
    fs.writeFileSync(CONFIG_PATH, '{ this is not json');
    cfg = authConfig.getConfig();
    assert.strictEqual(cfg.enabled, false, 'A4: malformed config → safe default (disabled)');
    pass.push('A4: malformed config loads as default-OFF, never throws');

    // ════════════════════════════════════════════════════════════════════════════════════════
    // PART B — validator (unit), no disk; inline cfg pointing at the local JWKS
    // ════════════════════════════════════════════════════════════════════════════════════════
    const vcfg = {
      enabled: true, issuer: ISSUER, audience: AUDIENCE, jwksUri,
      algorithms: ['RS256'], requiredScopes: [], clockToleranceSec: 30,
    };
    const validator = resourceServer.createValidator(vcfg, { resourceMetadataUrl: 'http://x/.well-known/oauth-protected-resource' });

    // B1: a valid token passes and surfaces claims.
    const good = await validator.validate('Bearer ' + (await mint()));
    assert.strictEqual(good.ok, true, 'B1: a valid RS256 token validates');
    assert.strictEqual(good.sub, 'user-123', 'B1: the sub claim is surfaced');
    pass.push('B1: valid RS256 token → ok, claims surfaced');

    // B2: missing / malformed Authorization → bare 401 challenge (no error code).
    const none = await validator.validate(undefined);
    assert.strictEqual(none.ok, false, 'B2: missing header is not ok');
    assert.strictEqual(none.status, 401, 'B2: missing header → 401');
    assert.ok(/^Bearer/.test(none.wwwAuthenticate), 'B2: WWW-Authenticate is a Bearer challenge');
    assert.ok(/resource_metadata=/.test(none.wwwAuthenticate), 'B2: challenge carries resource_metadata (RFC 9728)');
    const garbage = await validator.validate('Basic abc123');
    assert.strictEqual(garbage.ok, false, 'B2: a non-Bearer scheme is rejected');
    pass.push('B2: missing/garbage Authorization → 401 bare Bearer challenge w/ resource_metadata');

    // B3: wrong audience (the confused-deputy attack) is rejected.
    const wrongAud = await validator.validate('Bearer ' + (await mint({ audience: 'https://evil.test' })));
    assert.strictEqual(wrongAud.ok, false, 'B3: a token for a different audience is rejected');
    assert.strictEqual(wrongAud.error, 'invalid_token', 'B3: → invalid_token');
    pass.push('B3: wrong-audience token rejected (confused-deputy defence)');

    // B4: wrong issuer rejected.
    const wrongIss = await validator.validate('Bearer ' + (await mint({ issuer: 'https://evil.test' })));
    assert.strictEqual(wrongIss.ok, false, 'B4: a token from a different issuer is rejected');
    pass.push('B4: wrong-issuer token rejected');

    // B5: expired token rejected (exp in the past, beyond clock tolerance).
    const expired = await validator.validate('Bearer ' + (await mint({ exp: Math.floor(Date.now() / 1000) - 600 })));
    assert.strictEqual(expired.ok, false, 'B5: an expired token is rejected');
    pass.push('B5: expired token rejected');

    // B6: alg:none rejected (a hand-crafted unsigned token).
    const noneTok = b64({ alg: 'none', typ: 'JWT' }) + '.' +
      b64({ iss: ISSUER, aud: AUDIENCE, sub: 'x', exp: Math.floor(Date.now() / 1000) + 300 }) + '.';
    const algNone = await validator.validate('Bearer ' + noneTok);
    assert.strictEqual(algNone.ok, false, 'B6: an alg:none token is rejected');
    pass.push('B6: alg:none token rejected');

    // B7: algorithm confusion — an HS256 token is rejected because the validator PINS RS256.
    //     (The classic attack signs HS256 using the RSA public key as the HMAC secret; whatever the
    //     secret, an HS256 token must never validate against an RS256-pinned resource server.)
    const hsTok = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: KID })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('attacker-chosen-secret-or-the-rsa-public-key-bytes'));
    const algConfusion = await validator.validate('Bearer ' + hsTok);
    assert.strictEqual(algConfusion.ok, false, 'B7: an HS256 token is rejected under an RS256 allowlist');
    pass.push('B7: HS256 token rejected (algorithm-confusion defence — pinned allowlist)');

    // B8: scope enforcement — a token missing a required scope → 403 insufficient_scope.
    const scopedValidator = resourceServer.createValidator(
      Object.assign({}, vcfg, { requiredScopes: ['tools:run'] }),
      { resourceMetadataUrl: 'http://x/.well-known/oauth-protected-resource' }
    );
    const noScope = await scopedValidator.validate('Bearer ' + (await mint()));
    assert.strictEqual(noScope.ok, false, 'B8: a token without the required scope is rejected');
    assert.strictEqual(noScope.status, 403, 'B8: insufficient scope → 403');
    assert.strictEqual(noScope.error, 'insufficient_scope', 'B8: → insufficient_scope');
    const withScope = await scopedValidator.validate('Bearer ' + (await mint({ claims: { scope: 'tools:run other' } })));
    assert.strictEqual(withScope.ok, true, 'B8: a token WITH the required scope passes');
    pass.push('B8: scope enforcement → 403 insufficient_scope, passes with the scope');

    // B9: the algorithm ALLOWLIST is genuinely exercised. An RS384 token (same RSA key) validated
    //     against the no-alg JWKS is rejected ONLY because RS384 is not in the pinned ['RS256'] list
    //     — if the allowlist were dropped, jose would accept it (the no-alg key matches). This is the
    //     test B7 could not be (B7's HS256 token is rejected by key-type handling regardless of pin).
    const algValidator = resourceServer.createValidator(
      { enabled: true, issuer: ISSUER, audience: AUDIENCE, jwksUri: jwksUriNoAlg, algorithms: ['RS256'], requiredScopes: [], clockToleranceSec: 30 },
      { resourceMetadataUrl: 'http://x/.well-known/oauth-protected-resource' }
    );
    const rs384 = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS384', kid: KID })
      .setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('5m').setSubject('x')
      .sign(privateKey);
    const algOff = await algValidator.validate('Bearer ' + rs384);
    assert.strictEqual(algOff.ok, false, 'B9: an RS384 token is rejected under an RS256-only allowlist (proves the pin)');
    // sanity: the SAME RS256 token validates fine against the no-alg JWKS (so the rejection above is
    // the allowlist, not a broken key/fixture).
    const rs256ok = await algValidator.validate('Bearer ' + (await mint()));
    assert.strictEqual(rs256ok.ok, true, 'B9: an RS256 token still validates against the no-alg JWKS');
    pass.push('B9: algorithm allowlist genuinely exercised (RS384 rejected, RS256 accepted on a no-alg key)');

    // B10: signature verification is BOUND to the trusted key set. A token signed with a DIFFERENT
    //      key but carrying kid=KID resolves the trusted public key, then fails signature verify.
    const wrongKeyTok = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('5m').setSubject('x')
      .sign(wrong.privateKey);
    const wrongKey = await validator.validate('Bearer ' + wrongKeyTok);
    assert.strictEqual(wrongKey.ok, false, 'B10: a token signed by an untrusted key fails signature verification');
    assert.strictEqual(wrongKey.error, 'invalid_token', 'B10: → invalid_token');
    pass.push('B10: wrong-key token rejected (signature bound to the trusted JWKS)');

    // B11: a token with NO exp claim is rejected (requiredClaims:['exp'] — no never-expiring tokens).
    const noExpTok = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setSubject('x')
      .sign(privateKey); // deliberately no setExpirationTime
    const noExp = await validator.validate('Bearer ' + noExpTok);
    assert.strictEqual(noExp.ok, false, 'B11: a token without exp is rejected (no never-expiring tokens)');
    pass.push('B11: token without exp rejected (requiredClaims enforcement)');

    // ════════════════════════════════════════════════════════════════════════════════════════
    // PART C — transport e2e with auth ENABLED
    // ════════════════════════════════════════════════════════════════════════════════════════
    authConfig.setConfig({
      enabled: true, issuer: ISSUER, audience: AUDIENCE, jwksUri,
      algorithms: ['RS256'], requiredScopes: [], clockToleranceSec: 30,
    });
    host = createHttpMcpServer({ host: '127.0.0.1', port: 0 });
    const started = await host.start();
    port = started.port;
    const H = '127.0.0.1';
    const initBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'auth.test', version: '0' } } });

    // C1: no token → 401 + WWW-Authenticate.
    const noTok = await request({ host: H, port, method: 'POST', path: '/mcp', body: initBody });
    assert.strictEqual(noTok.status, 401, 'C1: POST /mcp without a token → 401 (got ' + noTok.status + ')');
    assert.ok(/Bearer/.test(noTok.headers['www-authenticate'] || ''), 'C1: 401 carries a WWW-Authenticate: Bearer header');
    pass.push('C1: auth-enabled POST /mcp without token → 401 + WWW-Authenticate');

    // C2: a valid token → 200 with the initialize result.
    const token = await mint();
    const okReq = await request({ host: H, port, method: 'POST', path: '/mcp', body: initBody, headers: { Authorization: 'Bearer ' + token } });
    assert.strictEqual(okReq.status, 200, 'C2: POST /mcp with a valid token → 200 (got ' + okReq.status + ')');
    assert.ok(okReq.json && okReq.json.result && okReq.json.result.serverInfo, 'C2: a JSON-RPC initialize result came back');
    pass.push('C2: auth-enabled POST /mcp with valid token → 200 initialize result');

    // C3: the RFC 9728 discovery doc is reachable UNAUTHENTICATED.
    const prm = await request({ host: H, port, method: 'GET', path: '/.well-known/oauth-protected-resource' });
    assert.strictEqual(prm.status, 200, 'C3: well-known PRM reachable without a token → 200');
    assert.strictEqual(prm.json && prm.json.resource, AUDIENCE, 'C3: PRM.resource === the configured audience');
    assert.ok(Array.isArray(prm.json.authorization_servers) && prm.json.authorization_servers[0] === ISSUER, 'C3: PRM.authorization_servers lists the issuer');
    pass.push('C3: /.well-known/oauth-protected-resource served unauthenticated (RFC 9728)');

    // C4: /health is GATED when auth is on (no token → 401; valid token → 200).
    const healthNoTok = await request({ host: H, port, method: 'GET', path: '/health' });
    assert.strictEqual(healthNoTok.status, 401, 'C4: /health without a token → 401 when auth is enabled');
    const healthTok = await request({ host: H, port, method: 'GET', path: '/health', headers: { Authorization: 'Bearer ' + token } });
    assert.strictEqual(healthTok.status, 200, 'C4: /health with a valid token → 200');
    assert.ok(healthTok.json && healthTok.json.auth && healthTok.json.auth.enabled === true, 'C4: /health reports auth.enabled true');
    pass.push('C4: /health gated by auth (401 without token, 200 with)');

    await host.stop();
    host = null;

    // C5: auth DISABLED → behaviour is unchanged (no token needed).
    authConfig.setConfig({ enabled: false });
    const host2 = createHttpMcpServer({ host: '127.0.0.1', port: 0 });
    const s2 = await host2.start();
    try {
      const open = await request({ host: H, port: s2.port, method: 'POST', path: '/mcp', body: initBody });
      assert.strictEqual(open.status, 200, 'C5: auth-disabled POST /mcp with no token → 200 (unchanged)');
      const prm404 = await request({ host: H, port: s2.port, method: 'GET', path: '/.well-known/oauth-protected-resource' });
      assert.strictEqual(prm404.status, 404, 'C5: well-known PRM is 404 when auth is disabled');
    } finally {
      await host2.stop();
    }
    pass.push('C5: auth-disabled transport unchanged (no token → 200; PRM → 404)');

    // ════════════════════════════════════════════════════════════════════════════════════════
    // PART D — start guards (fail-fast)
    // ════════════════════════════════════════════════════════════════════════════════════════
    // D1: non-loopback bind with auth DISABLED is refused (never binds).
    authConfig.setConfig({ enabled: false });
    let refusedBind = false;
    try {
      await createHttpMcpServer({ host: '0.0.0.0', port: 0 }).start();
    } catch (e) {
      refusedBind = /non-loopback/i.test((e && e.message) || '');
    }
    assert.ok(refusedBind, 'D1: binding 0.0.0.0 without auth is refused at start');
    pass.push('D1: non-loopback bind refused without OAuth (fail-fast)');

    // D2: auth ENABLED but misconfigured (no audience) is refused at start.
    authConfig.setConfig({ enabled: true, issuer: ISSUER, audience: '', jwksUri });
    let refusedCfg = false;
    try {
      await createHttpMcpServer({ host: '127.0.0.1', port: 0 }).start();
    } catch (e) {
      refusedCfg = /misconfigured/i.test((e && e.message) || '');
    }
    assert.ok(refusedCfg, 'D2: auth-enabled-but-misconfigured is refused at start');
    pass.push('D2: auth-enabled-but-misconfigured refused at start (fail-fast)');

    // ════════════════════════════════════════════════════════════════════════════════════════
    // PART E — UI auth endpoints (GET /api/auth, POST /api/auth/config). The install endpoint is
    // NOT invoked here (it shells out to npm); jose is already present as a devDependency.
    // ════════════════════════════════════════════════════════════════════════════════════════
    // Reset to a clean disabled state for the UI round-trip.
    authConfig.setConfig({ enabled: false, issuer: '', audience: '', jwksUri: '' });
    uiHost = createUiServer({ host: '127.0.0.1', port: 0, root: ROOT });
    const ui = await uiHost.start();
    const UH = '127.0.0.1';

    // E1: GET /api/auth reports the dependency state (jose IS installed as a devDep) + the pin.
    const authGet = await request({ host: UH, port: ui.port, method: 'GET', path: '/api/auth' });
    assert.strictEqual(authGet.status, 200, 'E1: GET /api/auth → 200');
    assert.strictEqual(authGet.json && authGet.json.joseInstalled, true, 'E1: joseInstalled true (devDependency present)');
    assert.ok(authGet.json && typeof authGet.json.josePin === 'string' && authGet.json.josePin.length > 0, 'E1: josePin is reported');
    assert.ok(authGet.json && authGet.json.config && authGet.json.config.enabled === false, 'E1: config.enabled false after reset');
    pass.push('E1: GET /api/auth reports dependency state + pin + config');

    // E2: POST /api/auth/config persists a partial (disabled) config and round-trips.
    const setCfg = await request({ host: UH, port: ui.port, method: 'POST', path: '/api/auth/config', body: JSON.stringify({ issuer: ISSUER, audience: AUDIENCE, jwksUri }) });
    assert.strictEqual(setCfg.status, 200, 'E2: POST /api/auth/config → 200');
    assert.strictEqual(setCfg.json && setCfg.json.ok, true, 'E2: config write ok');
    const authGet2 = await request({ host: UH, port: ui.port, method: 'GET', path: '/api/auth' });
    assert.strictEqual(authGet2.json && authGet2.json.config && authGet2.json.config.issuer, ISSUER, 'E2: issuer round-tripped');
    pass.push('E2: POST /api/auth/config persists + round-trips via GET /api/auth');

    // E3: enabling auth while coherent + jose present is accepted and reports ready.
    const enable = await request({ host: UH, port: ui.port, method: 'POST', path: '/api/auth/config', body: JSON.stringify({ enabled: true }) });
    assert.strictEqual(enable.json && enable.json.ok, true, 'E3: enabling a coherent config is accepted');
    assert.strictEqual(enable.json && enable.json.ready, true, 'E3: reports ready (jose present + coherent)');
    pass.push('E3: enabling auth (coherent + jose present) → ok + ready');

    // ════════════════════════════════════════════════════════════════════════════════════════
    // PART F — OIDC discovery hardening (origin-pin on the discovered jwks_uri + no-redirect)
    // ════════════════════════════════════════════════════════════════════════════════════════
    // One local "issuer" serving three personas by path prefix. BOTH well-known candidates are
    // handled per persona, so an assertion sees the pin's refusal — not a 404-fallback error.
    discoServer = http.createServer((req, res) => {
      const base = `http://127.0.0.1:${discoServer.address().port}`;
      const wk = /^\/(same|cross|redir)\/\.well-known\/(openid-configuration|oauth-authorization-server)$/.exec(req.url || '');
      if (!wk) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{}'); }
      if (wk[1] === 'same') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jwks_uri: `${base}/same/jwks` }));
      }
      if (wk[1] === 'cross') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jwks_uri: 'https://elsewhere.test/jwks' }));
      }
      // redir — bounce toward the same-origin persona; discovery must REFUSE to follow.
      res.writeHead(302, { Location: `${base}/same/.well-known/openid-configuration` });
      return res.end();
    });
    await new Promise((r) => discoServer.listen(0, '127.0.0.1', r));
    const discoBase = `http://127.0.0.1:${discoServer.address().port}`;

    // F1: a same-origin discovered jwks_uri resolves normally.
    const sameUri = await resourceServer.resolveJwksUri({ issuer: `${discoBase}/same` }, 3000);
    assert.strictEqual(sameUri, `${discoBase}/same/jwks`, 'F1: same-origin discovered jwks_uri resolves');
    pass.push('F1: discovery resolves a same-origin jwks_uri');

    // F2: a cross-origin discovered jwks_uri is refused, naming the explicit-trust escape hatch.
    let crossErr = null;
    try { await resourceServer.resolveJwksUri({ issuer: `${discoBase}/cross` }, 3000); }
    catch (e) { crossErr = e; }
    assert.ok(crossErr, 'F2: cross-origin discovered jwks_uri must reject');
    assert.ok(/not on the issuer origin/i.test(crossErr.message), 'F2: rejection names the origin pin (got: ' + crossErr.message + ')');
    assert.ok(/jwksUri/.test(crossErr.message), 'F2: rejection points at the explicit jwksUri escape hatch');
    pass.push('F2: cross-origin discovered jwks_uri refused (origin pin) with the explicit-trust hint');

    // F3: the escape hatch — an EXPLICIT cfg.jwksUri is honoured untouched (operator-stated trust;
    // no discovery request is made, so the pin does not apply). This is how cross-origin IdPs
    // (e.g. Google) are configured deliberately rather than trusted implicitly.
    const explicit = await resourceServer.resolveJwksUri({ jwksUri: 'https://elsewhere.test/jwks', issuer: `${discoBase}/same` }, 3000);
    assert.strictEqual(explicit, 'https://elsewhere.test/jwks', 'F3: explicit jwksUri bypasses discovery');
    pass.push('F3: explicit cfg.jwksUri honoured as stated trust (no discovery, no pin)');

    // F4: a REDIRECTING discovery endpoint is refused — the metadata must come from the exact
    // well-known URL derived from the trusted issuer (fetch redirect:"error").
    let redirErr = null;
    try { await resourceServer.resolveJwksUri({ issuer: `${discoBase}/redir` }, 3000); }
    catch (e) { redirErr = e; }
    assert.ok(redirErr, 'F4: redirecting discovery must reject');
    pass.push('F4: redirecting discovery endpoint refused (no-follow)');
  } finally {
    // Tear down servers + restore the shared auth config to its pre-test bytes.
    try { if (host) await host.stop(); } catch (_e) { /* ignore */ }
    try { if (uiHost) await uiHost.stop(); } catch (_e) { /* ignore */ }
    try { await new Promise((r) => jwksServer.close(r)); } catch (_e) { /* ignore */ }
    try { await new Promise((r) => jwksServerNoAlg.close(r)); } catch (_e) { /* ignore */ }
    try {
      if (discoServer) {
        await new Promise((r) => {
          discoServer.close(r);
          // Destroy undici's keep-alive sockets NOW: plain close() waits out their idle timeout,
          // and live undici handles at process.exit trip a libuv assert on Windows.
          if (typeof discoServer.closeAllConnections === 'function') discoServer.closeAllConnections();
        });
      }
    } catch (_e) { /* ignore */ }
    if (originalConfig != null) {
      try { fs.writeFileSync(CONFIG_PATH, originalConfig); } catch (_e) { /* ignore */ }
    } else {
      try { fs.unlinkSync(CONFIG_PATH); } catch (_e) { /* ignore */ }
    }
    // Part F used global fetch → undici holds keep-alive sockets + async handles, and live undici
    // handles at process.exit trip a libuv assert on Windows (UV_HANDLE_CLOSING → exit 0xC0000409,
    // AFTER the PASS line). Tear the global dispatcher down explicitly (undici's own global slot),
    // then let one macrotask pass so the handles unwind before exit. Best-effort by design.
    try {
      const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')];
      if (dispatcher && typeof dispatcher.destroy === 'function') await dispatcher.destroy();
      else if (dispatcher && typeof dispatcher.close === 'function') await dispatcher.close();
    } catch (_e) { /* ignore */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  for (const p of pass) console.log('  ok   - ' + p);
  console.log('\nPASS auth.test.js — ' + pass.length + ' assertions, all green (config + validator + transport + guards)');
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL auth.test.js — ' + ((e && e.message) || e));
  if (e && e.stack) console.error(e.stack);
  process.exit(1);
});
