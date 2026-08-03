'use strict';

/**
 * header-enforcement.test.js - MCP-Protocol-Version enforcement on legacy HTTP (0.7.0).
 *
 * A MUST from 2025-06-18: "If the server receives a request with an invalid or unsupported
 * MCP-Protocol-Version, it MUST respond with 400 Bad Request." 0.6.0 documents the lenient
 * read as a roadmap item and ignores the header on legacy bodies entirely. The split:
 *
 *   - ABSENT header  -> passes, frozen (the spec's own default-assumption case; also every
 *                       pre-2025-06-18 client).
 *   - PRESENT + a version we support -> passes (any of the four legacy + modern).
 *   - PRESENT + anything else -> 400 + -32600 naming the header (the MUST).
 *
 * Composes with: 2.3's batch gate (its OWN admission rule runs first for arrays) and the
 * existing modern HeaderMismatch machinery (modern bodies validate the full header trio; a
 * modern header on a legacy initialize already 400s as HeaderMismatch - both pinned here).
 *
 * In-process HTTP host, default config. Exit 0 = enforced; 1 = the lenient 0.6.0 read;
 * 2 = sanity broke. CommonJS. Node built-ins only.
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

function request(port, body, headers) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body, 'utf8') }, headers || {});
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

const ping = (id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping', params: {} });

(async () => {
  // Heal WITHOUT creating (mirrors run-all's backstop): an absent config already means
  // disabled, and an unconditional setConfig would CREATE the file on every clean run -
  // this rig only needs auth off, it must not leave a config where none existed.
  try {
    if (authConfig.getConfig().enabled === true) authConfig.setConfig({ enabled: false });
  } catch (_e) { /* best-effort; default is off anyway */ }
  const server = createHttpMcpServer({ host: '127.0.0.1', port: 0 });
  const { port } = await server.start();

  try {
    // 1. SANITY: absent header passes, frozen.
    const r1 = await request(port, ping(1));
    const r1ok = r1.status === 200 && r1.json && r1.json.result !== undefined;
    check('sanity: legacy POST with NO header -> 200 (frozen)', r1ok, `status=${r1.status} body=${r1.text.slice(0, 120)}`);
    if (!r1ok) sanityBroke = true;

    // 2. Every supported LEGACY version passes. (The modern version is NOT in this loop: a
    //    2026-07-28 header on a legacy body already 400s as HeaderMismatch - the modern header
    //    machinery demands matching modern _meta. Pinned in check 5b below.)
    for (const v of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']) {
      const r = await request(port, ping(2), { 'MCP-Protocol-Version': v });
      check(`supported header ${v} on a legacy body -> 200`,
        r.status === 200 && r.json && r.json.result !== undefined,
        `status=${r.status} body=${r.text.slice(0, 140)}`);
    }

    // 3. RED: present-and-INVALID -> 400 (the 2025-06-18 MUST). 0.6.0 ignores it (200).
    const r3 = await request(port, ping(3), { 'MCP-Protocol-Version': 'garbage' });
    check('invalid header "garbage" -> 400', r3.status === 400,
      `status=${r3.status} (0.6.0 reads the header leniently) body=${r3.text.slice(0, 140)}`);
    check('the 400 body is a JSON-RPC error naming the header',
      r3.json && r3.json.error && /MCP-Protocol-Version/i.test(r3.json.error.message || ''),
      `body=${r3.text.slice(0, 180)}`);

    // 4. RED: well-formed but UNSUPPORTED version -> 400 too.
    const r4 = await request(port, ping(4), { 'MCP-Protocol-Version': '2020-01-01' });
    check('unsupported version header 2020-01-01 -> 400', r4.status === 400,
      `status=${r4.status} body=${r4.text.slice(0, 140)}`);

    // 4b. The CODE has to be the specific one. -32600 (Invalid Request) is true but useless: it
    // tells a client its request was bad and nothing about what to send instead. -32022 is the
    // code allocated to exactly this condition and it carries the answer with it - the versions
    // this server WILL accept - so a client can retry without a human reading the message. The
    // body-level version check already answers this way (modern.js); the header path did not, so
    // the same condition got two different codes depending on where it was detected.
    check('an unsupported version header is -32022 (not the generic -32600)',
      !!(r4.json && r4.json.error && r4.json.error.code === -32022),
      `code=${r4.json && r4.json.error && r4.json.error.code} body=${r4.text.slice(0, 200)}`);
    check('the -32022 carries data.supported (what to retry with) and data.requested',
      !!(r4.json && r4.json.error && r4.json.error.data
         && Array.isArray(r4.json.error.data.supported) && r4.json.error.data.supported.length > 0
         && r4.json.error.data.requested === '2020-01-01'),
      `data=${JSON.stringify(r4.json && r4.json.error && r4.json.error.data)}`);
    // The header path advertises the FULL supported set, unlike the _meta path whose only lawful
    // value is the modern version - a header may legitimately carry any era this server speaks.
    check('data.supported spans the eras the server actually speaks (not modern-only)',
      !!(r4.json && r4.json.error && r4.json.error.data
         && r4.json.error.data.supported.includes('2024-11-05')),
      `supported=${JSON.stringify(r4.json && r4.json.error && r4.json.error.data && r4.json.error.data.supported)}`);

    // 5. Composition guard: a MODERN header on a legacy initialize keeps its EXISTING
    //    HeaderMismatch 400 (that machinery predates this item and must not be shadowed).
    const init = JSON.stringify({
      jsonrpc: '2.0', id: 5, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
    });
    const r5 = await request(port, init, { 'MCP-Protocol-Version': '2026-07-28' });
    check('modern header on legacy initialize -> existing HeaderMismatch 400 (-32020) untouched',
      r5.status === 400 && r5.json && r5.json.error && r5.json.error.code === -32020,
      `status=${r5.status} body=${r5.text.slice(0, 180)}`);
    const r5b = await request(port, ping(50), { 'MCP-Protocol-Version': '2026-07-28' });
    check('modern header on a legacy ping -> existing HeaderMismatch 400 (-32020) untouched',
      r5b.status === 400 && r5b.json && r5b.json.error && r5b.json.error.code === -32020,
      `status=${r5b.status} body=${r5b.text.slice(0, 180)}`);

    // 6. Composition guard: 2.3's batch gate still runs FIRST for arrays - an invalid header on
    //    an array keeps the frozen -32600 at 200 (the batch gate's "anything else" branch), it
    //    does NOT become this item's 400. (Batch admission is its own rule.)
    const r6 = await request(port, JSON.stringify([JSON.parse(ping(6))]), { 'MCP-Protocol-Version': '2025-06-18' });
    check('array with non-batching header: the batch gate answers (frozen -32600 at 200)',
      r6.status === 200 && r6.json && !Array.isArray(r6.json) && r6.json.error && r6.json.error.code === -32600,
      `status=${r6.status} body=${r6.text.slice(0, 160)}`);

    // 7. SANITY: fully-headed modern request untouched.
    const modernBody = JSON.stringify({
      jsonrpc: '2.0', id: 7, method: 'tools/list',
      params: { _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'hdr-test', version: '0' },
      } },
    });
    const r7 = await request(port, modernBody, { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' });
    const r7ok = r7.status === 200 && r7.json && r7.json.result && Array.isArray(r7.json.result.tools);
    check('sanity: modern request with full headers -> 200 served', r7ok, `status=${r7.status} body=${r7.text.slice(0, 140)}`);
    if (!r7ok) sanityBroke = true;
  } finally {
    try { await server.stop(); } catch (_e) { /* ignore */ }
  }

  console.log(fails ? `\n${fails} header-enforcement failure(s).` : '\nheader enforcement holds.');
  process.exit(sanityBroke ? 2 : (fails ? 1 : 0));
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
