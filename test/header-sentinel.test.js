'use strict';

/**
 * header-sentinel.test.js - Base64 sentinel decode on Mcp-Name before comparison
 * (0.7.0; streamable-http.mdx:480-508).
 *
 * The spec: values outside the header-safe set ride as `=?base64?{data}?=` (markers lowercase,
 * case-sensitive), and servers MUST decode before comparing to the body during validation.
 * Clients MUST encode ANY value that even looks like the sentinel - so the decode is
 * UNCONDITIONAL on sentinel shape, never try-decode-and-fall-back: a sentinel-shaped header
 * either decodes and matches, or it is a mismatch. 0.6.0 compares RAW: an encoded Mcp-Name
 * (e.g. a non-ASCII resources/read URI - the live wrap case) wrongly 400s as HeaderMismatch.
 *
 * In-process HTTP host, default config. Exit 0 = decode-then-compare holds; 1 = the raw
 * comparison; 2 = sanity broke. CommonJS. Node built-ins only.
 */

const http = require('node:http');
const { createHttpMcpServer } = require('../src/mcp/http-transport.js');
const authConfig = require('../src/auth/config.js');

let fails = 0;
let sanityBroke = false;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

const b64 = (s) => '=?base64?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'sentinel-test', version: '0.0.0' },
};

function request(port, headers, body) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body, 'utf8') }, headers);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers: h }, (res) => {
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
    req.write(body);
    req.end();
  });
}

(async () => {
  // Heal WITHOUT creating (mirrors run-all's backstop): an absent config already means
  // disabled - an unconditional setConfig would CREATE the file on every clean run.
  try {
    if (authConfig.getConfig().enabled === true) authConfig.setConfig({ enabled: false });
  } catch (_e) { /* best-effort; default is off anyway */ }
  const server = createHttpMcpServer({ host: '127.0.0.1', port: 0 });
  const { port } = await server.start();

  const callBody = (name) => JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name, arguments: {}, _meta: META },
  });
  const hdr = (method, name) => ({ 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, 'Mcp-Name': name });

  try {
    // 1. SANITY: plain ASCII Mcp-Name matches raw - untouched.
    const r1 = await request(port, hdr('tools/call', 'toolfunnel_list_tools'), callBody('toolfunnel_list_tools'));
    const r1ok = r1.status === 200 && r1.json && r1.json.result;
    check('sanity: plain Mcp-Name still validates and serves', r1ok, `status=${r1.status} body=${r1.text.slice(0, 140)}`);
    if (!r1ok) sanityBroke = true;

    // 2. RED: an ENCODED Mcp-Name for the same plain value MUST decode-then-match (clients MAY
    //    encode anything; the spec's MUST is on the server's decode).
    const r2 = await request(port, hdr('tools/call', b64('toolfunnel_list_tools')), callBody('toolfunnel_list_tools'));
    check('encoded Mcp-Name decodes before comparison (no false HeaderMismatch)',
      r2.status === 200 && r2.json && r2.json.result,
      `status=${r2.status} body=${r2.text.slice(0, 180)} (0.6.0 compares the raw sentinel to the name)`);

    // 3. RED: the live wrap shape - a NON-ASCII resources/read URI must pass header validation
    //    (the dispatch answer is -32601/404 here - no resources in the bare funnel - the point
    //    is it is NOT -32020 HeaderMismatch).
    const uri = 'file:///tmp/世界.txt';
    const r3 = await request(port,
      hdr('resources/read', b64(uri)),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri, _meta: META } }));
    check('non-ASCII resources/read URI passes validation via the sentinel (dispatch answers, not -32020)',
      r3.json && (!r3.json.error || r3.json.error.code !== -32020),
      `status=${r3.status} body=${r3.text.slice(0, 180)}`);

    // 4. Guard: an encoded but WRONG value is still a mismatch 400.
    const r4 = await request(port, hdr('tools/call', b64('some_other_tool')), callBody('toolfunnel_list_tools'));
    check('encoded-but-wrong Mcp-Name still 400 HeaderMismatch',
      r4.status === 400 && r4.json && r4.json.error && r4.json.error.code === -32020,
      `status=${r4.status} body=${r4.text.slice(0, 160)}`);

    // 5. Guard: sentinel-SHAPED garbage never falls back to a raw comparison (fail closed).
    //    The body name literally equals the garbage sentinel string; if the server "helpfully"
    //    compared raw it would MATCH - the spec forbids exactly that (clients MUST encode
    //    sentinel-lookalikes, so a raw sentinel-shaped value cannot be a plain value).
    const garbage = '=?base64?!!!not-base64!!!?=';
    const r5 = await request(port, hdr('tools/call', garbage), callBody(garbage));
    check('sentinel-shaped garbage is decoded (to mismatch), NEVER raw-compared to a lookalike body',
      r5.status === 400 && r5.json && r5.json.error && r5.json.error.code === -32020,
      `status=${r5.status} body=${r5.text.slice(0, 160)}`);
  } finally {
    try { await server.stop(); } catch (_e) { /* ignore */ }
  }

  console.log(fails ? `\n${fails} sentinel failure(s).` : '\nsentinel decode-then-compare holds.');
  process.exit(sanityBroke ? 2 : (fails ? 1 : 0));
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
