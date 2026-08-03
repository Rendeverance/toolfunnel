'use strict';

/**
 * origin.test.js - Origin-header validation on the HTTP transport (0.7.0).
 *
 * 0.6.0 never reads the Origin header: a browser page on ANY site can script POSTs into the
 * loopback-bound gateway (DNS rebinding / cross-origin CSRF), proven by the frozen golden
 * `http.origin.denied.post` = 200. This test is the acceptance contract for OUR validation policy
 * (a policy, not a spec quote - the spec's blanket "MUST validate Origin" is written for servers
 * in general; what a loopback gateway should DO with it is an engineering call):
 *
 *   - Origin ABSENT  -> pass. Non-browser clients (stdio bridges, SDKs, curl) send no Origin;
 *                       requiring one would break every legitimate client we serve.
 *   - Origin PRESENT + loopback -> pass (a local web UI is a first-class client).
 *   - Origin PRESENT + anything else -> 403. Includes the opaque `Origin: null` (sandboxed
 *     iframes / file:// pages) - present-and-not-loopback is the rejection rule.
 *   - Auth ENABLED   -> the bearer token is the boundary (same rationale as the Host guard):
 *                       remote browser clients legitimately present non-loopback Origins, so the
 *                       origin guard applies only to the auth-off loopback gateway.
 *
 * The policy is era-independent: it gates the HTTP request before any JSON-RPC body is read, so
 * legacy and modern callers are treated identically.
 *
 * Checks 3-5 are RED on 0.6.0 (no validation exists). Exit 0 = policy holds; 1 = violations;
 * 2 = sanity broke (the no-Origin path must work before AND after the fix).
 *
 * Mutates the SHARED on-disk auth config for check 6; snapshots + restores it (auth.test.js
 * pattern). Node built-ins only. Run:  node test/origin.test.js
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { createHttpMcpServer } = require(path.join(ROOT, 'src', 'mcp', 'http-transport.js'));
const authConfig = require(path.join(ROOT, 'src', 'auth', 'config.js'));
const CONFIG_PATH = authConfig.CONFIG_PATH;

let fails = 0;
let sanityBroke = false;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

/**
 * One HTTP request, stream-safe: resolves on response HEADERS, then collects the body for at most
 * bodyMs before destroying the socket. A 0.6.0 denied-Origin GET /mcp opens a never-ending SSE
 * stream - waiting for 'end' would hang exactly the way the golden capture did.
 */
function request(o) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, o.headers || {});
    if (o.body != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(o.body, 'utf8');
    }
    const req = http.request({ host: '127.0.0.1', port: o.port, method: o.method, path: o.path, headers }, (res) => {
      const chunks = [];
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_e) { /* non-JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      };
      const timer = setTimeout(() => { finish(); try { res.destroy(); } catch (_e) { /* ignore */ } }, o.bodyMs || 2000);
      res.on('data', (c) => chunks.push(c));
      res.on('end', finish);
      res.on('error', finish);
    });
    req.on('error', reject);
    if (o.body != null) req.write(o.body);
    req.end();
  });
}

const rpcBody = (id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping', params: {} });

(async () => {
  // Snapshot the shared auth config; force auth OFF for the loopback-boundary checks (http.test.js
  // belt-and-braces - a leaked enabled config would 401 everything here).
  const hadConfig = fs.existsSync(CONFIG_PATH);
  const originalConfig = hadConfig ? fs.readFileSync(CONFIG_PATH, 'utf8') : null;
  const restoreConfig = () => {
    try {
      if (originalConfig != null) fs.writeFileSync(CONFIG_PATH, originalConfig);
      else if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    } catch (_e) { /* best-effort */ }
  };
  process.on('SIGINT', () => { restoreConfig(); process.exit(1); });
  process.on('SIGTERM', () => { restoreConfig(); process.exit(1); });
  try { authConfig.setConfig({ enabled: false }); } catch (_e) { /* default is off */ }

  const server = createHttpMcpServer({ host: '127.0.0.1', port: 0 });
  const { port } = await server.start();

  try {
    // 1. SANITY: no Origin -> served. Must hold before AND after the fix.
    const absent = await request({ port, method: 'POST', path: '/mcp', body: rpcBody(1) });
    const absentOk = absent.status === 200 && absent.json && absent.json.result !== undefined;
    check('sanity: POST /mcp with NO Origin is served (200 result)', absentOk,
      `status=${absent.status} body=${absent.text.slice(0, 120)}`);
    if (!absentOk) sanityBroke = true;

    // 2. Loopback Origins pass (localhost + 127.0.0.1 + IPv6, with and without ports).
    const loopbacks = ['http://127.0.0.1', 'http://localhost:3000', 'http://[::1]:8080'];
    for (const o of loopbacks) {
      const r = await request({ port, method: 'POST', path: '/mcp', headers: { Origin: o }, body: rpcBody(2) });
      check(`loopback Origin passes: ${o}`, r.status === 200 && r.json && r.json.result !== undefined,
        `status=${r.status} body=${r.text.slice(0, 120)}`);
    }

    // 3. RED on 0.6.0: a non-loopback Origin is refused with 403.
    const denied = await request({ port, method: 'POST', path: '/mcp', headers: { Origin: 'http://disallowed.example' }, body: rpcBody(3) });
    check('non-loopback Origin on POST /mcp -> 403', denied.status === 403,
      `status=${denied.status} (0.6.0 serves it: no Origin validation exists) body=${denied.text.slice(0, 120)}`);
    check('403 body is a JSON-RPC error naming the Origin refusal',
      denied.json && denied.json.error && /origin/i.test(denied.json.error.message || ''),
      `body=${denied.text.slice(0, 160)}`);

    // 4. RED on 0.6.0: the opaque `Origin: null` (sandboxed iframe / file:// page) is refused.
    const nul = await request({ port, method: 'POST', path: '/mcp', headers: { Origin: 'null' }, body: rpcBody(4) });
    check('opaque "Origin: null" on POST /mcp -> 403', nul.status === 403,
      `status=${nul.status} body=${nul.text.slice(0, 120)}`);

    // 4b. A PRESENT Origin with an EMPTY host is refused (red against e5070a7). "http://" slices
    //     to a "" host part, which inherited isLoopbackHost's absent-HOST-header allowance - but
    //     that allowance is for a request with NO Host at all; a present Origin with no host is
    //     not a loopback web origin. Present-and-not-loopback is the rejection rule.
    for (const o of ['http://', 'https://']) {
      const r = await request({ port, method: 'POST', path: '/mcp', headers: { Origin: o }, body: rpcBody(4) });
      check(`hostless Origin "${o}" on POST /mcp -> 403`, r.status === 403,
        `status=${r.status} body=${r.text.slice(0, 120)}`);
    }

    // 5. RED on 0.6.0: the GET-SSE channel is guarded too (0.6.0 opens the stream for disallowed.example).
    const sse = await request({ port, method: 'GET', path: '/mcp', headers: { Origin: 'http://disallowed.example', Accept: 'text/event-stream' }, bodyMs: 1500 });
    check('non-loopback Origin on GET /mcp (SSE) -> 403', sse.status === 403,
      `status=${sse.status} contentType=${sse.headers['content-type']} (200+text/event-stream = the stream opened)`);

    // 6. Auth ENABLED -> the token is the boundary; the origin guard steps aside. No token is
    //    presented so the auth gate answers 401 (never fetches the JWKS) - the point is the status
    //    is the AUTH challenge, not the origin 403. Pins the guard's auth-off scope so the fix
    //    cannot over-reach and break remote browser clients.
    authConfig.setConfig({
      enabled: true, issuer: 'https://issuer.test', audience: 'https://gateway.test',
      jwksUri: 'http://127.0.0.1:1/jwks', algorithms: ['RS256'], requiredScopes: [], clockToleranceSec: 30,
    });
    const authed = await request({ port, method: 'POST', path: '/mcp', headers: { Origin: 'http://disallowed.example' }, body: rpcBody(6) });
    check('auth ENABLED: denied Origin gets the 401 auth challenge, not an origin 403', authed.status === 401,
      `status=${authed.status} body=${authed.text.slice(0, 120)}`);
  } finally {
    restoreConfig();
    try { await server.stop(); } catch (_e) { /* ignore */ }
  }

  console.log(fails ? `\n${fails} origin-policy failure(s).` : '\norigin policy holds.');
  process.exit(sanityBroke ? 2 : (fails ? 1 : 0));
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
