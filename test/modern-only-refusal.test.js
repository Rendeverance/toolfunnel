'use strict';

/**
 * modern-only-refusal.test.js - the serveLegacy:false refusal shape (0.7.0).
 *
 * 0.6.0 answers a legacy-era request under serveLegacy:false with `-32020` - but -32020 is
 * HeaderMismatch and no header is involved: the allocation policy (2026-07-28
 * basic-index.mdx:122-127, "MUST use defined codes only with their specified meanings") forbids
 * it. THE DESIGN (decided at the code, per the v5 design-item instruction):
 *
 *   - Mint `-32601` (method not found) - the compatibility matrix's own answer: a true
 *     modern-only server HAS no legacy methods, so -32601 is the recognised shape a probing
 *     legacy client already understands. The policy-naming message text is KEPT (a versioning
 *     SHOULD), and `data.policy = 'modern-only'` is the machine-readable marker.
 *   - HTTP adds a NARROW remap -> 404 gated on that exact marker, mirroring the existing
 *     modern-body -32601->404 signal. An ORDINARY legacy -32601 keeps its frozen 200 - the
 *     zero-unsigned golden diff is the guard for that path (default-config captures).
 *   - The mint is transport-agnostic (stdio reaches the same site): stdio callers get the same
 *     body, no status involved.
 *
 * In-process with a sandboxed TOOLFUNNEL_HOME carrying serveLegacy:false (era-policy.test.js
 * pattern - the home is written BEFORE any src/ module loads). era-policy.test.js's A1/A2
 * expectations are updated to this contract as part of the same item.
 *
 * Exit 0 = new shape holds; 1 = the shipped -32020 shape; 2 = sanity broke.
 * CommonJS. Node built-ins only.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// Sandbox home with the modern-only policy WRITTEN BEFORE any src/ module loads.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-modernonly-'));
fs.writeFileSync(path.join(HOME, 'toolfunnel.json'), JSON.stringify({ serveLegacy: false }));
process.env.TOOLFUNNEL_HOME = HOME;
require('../src/core/config-home').initConfigHome({});

const s = require('../src/mcp/server.js');
const { createHttpMcpServer } = require('../src/mcp/http-transport.js');
const authConfig = require('../src/auth/config.js');

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'modern-only-test', version: '0.0.0' },
};

let fails = 0;
let sanityBroke = false;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

/** Is this response the NEW refusal shape? -32601 + policy marker + policy-naming message. */
function isNewRefusal(resp) {
  return resp && resp.error && resp.error.code === -32601 &&
    /serveLegacy:false/.test(resp.error.message || '') &&
    resp.error.data && resp.error.data.policy === 'modern-only';
}

function request(o) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, o.headers || {});
    if (o.body != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(o.body, 'utf8');
    }
    const req = http.request({ host: '127.0.0.1', port: o.port, method: 'POST', path: '/mcp', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_e) { /* non-JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (o.body != null) req.write(o.body);
    req.end();
  });
}

(async () => {
  try { authConfig.setConfig({ enabled: false }); } catch (_e) { /* default is off */ }
  const build = s.buildProtocol();

  // ── stdio-shape (handleMessage directly - the transport-agnostic mint) ──────────────────────
  // 1. SANITY: a modern request is served normally.
  const m1 = await s.handleMessage(build, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } });
  const m1ok = m1 && m1.result && Array.isArray(m1.result.tools);
  check('sanity: modern tools/list served under serveLegacy:false', m1ok, JSON.stringify(m1).slice(0, 160));
  if (!m1ok) sanityBroke = true;

  // 2. RED: legacy initialize -> -32601 + data.policy marker (was -32020, no data).
  const m2 = await s.handleMessage(build, {
    jsonrpc: '2.0', id: 2, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
  });
  check('legacy initialize -> -32601 with data.policy="modern-only" (allocation policy)', isNewRefusal(m2),
    'got ' + JSON.stringify(m2 && m2.error).slice(0, 200));

  // 3. RED: any other legacy request -> same shape.
  const m3 = await s.handleMessage(build, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  check('legacy tools/list -> the same marked -32601 refusal', isNewRefusal(m3),
    'got ' + JSON.stringify(m3 && m3.error).slice(0, 200));

  // 4. The negotiation exemption is intact: meta-less server/discover still answered.
  const m4 = await s.handleMessage(build, { jsonrpc: '2.0', id: 4, method: 'server/discover', params: {} });
  check('meta-less server/discover still answered (negotiation exemption intact)',
    m4 && m4.result && Array.isArray(m4.result.supportedVersions), JSON.stringify(m4).slice(0, 160));

  // 5. Legacy NOTIFICATION still dropped silently.
  const m5 = await s.handleMessage(build, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  check('legacy notification still dropped silently (null)', m5 === null, 'got ' + JSON.stringify(m5));

  // ── HTTP: the narrow 404 remap, this refusal only ───────────────────────────────────────────
  const server = createHttpMcpServer({ host: '127.0.0.1', port: 0 });
  const { port } = await server.start();
  try {
    // 6. RED: legacy initialize over HTTP -> 404 + the marked -32601 (was 200 + -32020). The
    //    exact shape a probing legacy client gets from a REAL modern-only server (matrix row).
    const h6 = await request({ port, body: JSON.stringify({
      jsonrpc: '2.0', id: 6, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
    }) });
    check('HTTP legacy initialize -> 404 + marked -32601', h6.status === 404 && isNewRefusal(h6.json),
      `status=${h6.status} body=${h6.text.slice(0, 200)}`);

    // 7. The EXISTING modern remap is untouched: modern unknown method -> 404 -32601 (no marker).
    //    (Modern-over-HTTP requires MCP-Protocol-Version AND Mcp-Method headers - 0.6.0 behaviour.)
    const modernHdr = (method) => ({ 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method });
    const h7 = await request({ port, headers: modernHdr('no/such-method'), body: JSON.stringify({
      jsonrpc: '2.0', id: 7, method: 'no/such-method', params: { _meta: META },
    }) });
    check('HTTP modern unknown method still 404 -32601 (existing remap intact)',
      h7.status === 404 && h7.json && h7.json.error && h7.json.error.code === -32601,
      `status=${h7.status} body=${h7.text.slice(0, 160)}`);

    // 8. SANITY: modern tools/list over HTTP -> 200 served.
    const h8 = await request({ port, headers: modernHdr('tools/list'), body: JSON.stringify({
      jsonrpc: '2.0', id: 8, method: 'tools/list', params: { _meta: META },
    }) });
    const h8ok = h8.status === 200 && h8.json && h8.json.result && Array.isArray(h8.json.result.tools);
    check('sanity: HTTP modern tools/list -> 200 served', h8ok, `status=${h8.status} body=${h8.text.slice(0, 160)}`);
    if (!h8ok) sanityBroke = true;
  } finally {
    try { await server.stop(); } catch (_e) { /* ignore */ }
  }

  console.log(fails ? `\n${fails} modern-only refusal failure(s).` : '\nmodern-only refusal shape holds.');
  process.exit(sanityBroke ? 2 : (fails ? 1 : 0));
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
