'use strict';

/**
 * dual-era.test.js - the 2026-07-28 ("modern") era alongside legacy, protocol + HTTP.
 *
 * Unlike most of the suite, this test runs against a SANDBOXED config home (a temp dir seeded
 * via initConfigHome + TOOLFUNNEL_HOME), not the shared on-disk config - the era behaviour under
 * test is config-independent, and a sandbox keeps this file out of the shared-config
 * snapshot/restore choreography entirely.
 *
 * Asserts:
 *   protocol (handleMessage):
 *     1. modern tools/list - resultType:'complete' + ttlMs/cacheScope + serverInfo _meta
 *     2. legacy tools/list - BYTE-CLEAN of modern fields (the 0.5.0 shape, untouched)
 *     3. server/discover - answered modern AND as a meta-less probe; lists BOTH eras
 *     4. unsupported version -> -32022 with data.supported; missing caps -> -32602
 *     5. ping: removed in modern (-32601), alive in legacy ({})
 *     6. initialize ALWAYS selects legacy, even carrying modern _meta
 *   HTTP transport:
 *     7. modern POST with correct headers works; missing Mcp-Method -> 400 -32020;
 *        Mcp-Name mismatch -> 400 -32020; modern header on a legacy body -> 400 -32020
 *     8. legacy POST (no headers) unchanged
 *     9. subscriptions/listen: SSE stream, ack FIRST (agreed subset trimmed + subscriptionId),
 *        broadcast delivers a TAGGED notification, stop() sends the graceful close RESULT
 *
 * Exit code 0 on success; 1 with a FAIL line per failed assertion.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Sandbox home FIRST - before any src/ module resolves its config-home anchors.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-dualera-'));
process.env.TOOLFUNNEL_HOME = HOME;
require('../src/core/config-home').initConfigHome({});

const s = require('../src/mcp/server.js');
const modern = require('../src/mcp/modern.js');
const { createHttpMcpServer } = require('../src/mcp/http-transport.js');

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'dual-era-test', version: '0' },
};
const SUB = 'io.modelcontextprotocol/subscriptionId';

let fails = 0;
function check(label, cond) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label);
  if (!cond) fails += 1;
}

function post(port, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {}) },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

async function protocolChecks() {
  const build = s.buildProtocol();

  const r1 = await s.handleMessage(build, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } });
  check('modern tools/list decorated', r1.result.resultType === 'complete' &&
    r1.result.ttlMs === modern.CACHE_HINTS.toolsList.ttlMs && r1.result.cacheScope === 'private' &&
    !!r1.result._meta['io.modelcontextprotocol/serverInfo'] && r1.result.tools.length >= 4);

  const r2 = await s.handleMessage(build, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  check('legacy tools/list byte-clean of modern fields', r2.result.resultType === undefined &&
    r2.result.ttlMs === undefined && r2.result.cacheScope === undefined && r2.result._meta === undefined);

  const r3 = await s.handleMessage(build, { jsonrpc: '2.0', id: 3, method: 'server/discover', params: { _meta: META } });
  const r4 = await s.handleMessage(build, { jsonrpc: '2.0', id: 4, method: 'server/discover', params: {} });
  check('discover lists both eras (modern + probe)',
    JSON.stringify(r3.result.supportedVersions) === JSON.stringify(modern.supportedVersions()) &&
    JSON.stringify(r4.result.supportedVersions) === JSON.stringify(modern.supportedVersions()) &&
    r3.result.resultType === 'complete');

  const badV = { 'io.modelcontextprotocol/protocolVersion': '1900-01-01', 'io.modelcontextprotocol/clientCapabilities': {} };
  const r5 = await s.handleMessage(build, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: { _meta: badV } });
  check('unsupported version -> -32022 + data.supported', r5.error.code === -32022 &&
    Array.isArray(r5.error.data.supported) && r5.error.data.requested === '1900-01-01');

  const noCaps = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
  const r6 = await s.handleMessage(build, { jsonrpc: '2.0', id: 6, method: 'tools/list', params: { _meta: noCaps } });
  check('missing clientCapabilities -> -32602', r6.error.code === -32602);

  const r7 = await s.handleMessage(build, { jsonrpc: '2.0', id: 7, method: 'ping', params: { _meta: META } });
  const r8 = await s.handleMessage(build, { jsonrpc: '2.0', id: 8, method: 'ping', params: {} });
  check('ping removed in modern, alive in legacy', r7.error.code === -32601 && JSON.stringify(r8.result) === '{}');

  const r9 = await s.handleMessage(build, { jsonrpc: '2.0', id: 9, method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 't', version: '0' }, _meta: META } });
  check('initialize always selects legacy', r9.result.protocolVersion === s.PROTOCOL_VERSION);

  if (build.aggregator) await build.aggregator.closeAll();
}

async function httpChecks() {
  const host = createHttpMcpServer({ port: 0 });
  const { port } = await host.start();

  const h1 = await post(port, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } },
    { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' });
  check('HTTP modern tools/list works', h1.status === 200 && h1.body.result.resultType === 'complete');

  const h2 = await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: META } },
    { 'MCP-Protocol-Version': '2026-07-28' });
  check('missing Mcp-Method -> 400 -32020 (id preserved)', h2.status === 400 && h2.body.error.code === -32020 && h2.body.id === 2);

  const h3 = await post(port, { jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'toolfunnel_list_tools', arguments: {}, _meta: META } },
    { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'wrong' });
  check('Mcp-Name mismatch -> 400 -32020', h3.status === 400 && h3.body.error.code === -32020);

  const h4 = await post(port, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
    { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' });
  check('modern header + legacy body -> 400 -32020', h4.status === 400 && h4.body.error.code === -32020);

  const h5 = await post(port, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }, {});
  check('HTTP legacy tools/list unchanged', h5.status === 200 && h5.body.result.resultType === undefined);

  // subscriptions/listen: SSE ack -> tagged broadcast -> graceful close on stop().
  const events = [];
  await new Promise((resolve, reject) => {
    const data = JSON.stringify({ jsonrpc: '2.0', id: 'sub-1', method: 'subscriptions/listen',
      params: { _meta: META, notifications: { toolsListChanged: true, bogusChannel: true } } });
    const req = http.request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
          'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'subscriptions/listen' } },
      (res) => {
        check('listen response is an SSE stream', res.statusCode === 200 && /text\/event-stream/.test(res.headers['content-type'] || ''));
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (line) events.push(JSON.parse(line.slice(6)));
          }
        });
        res.on('end', resolve);
        res.on('error', resolve); // a torn stream still resolves; the event asserts below decide
        setTimeout(() => {
          const n = host.broadcastToolsListChanged();
          check('broadcast reached the listener', n === 1);
          setTimeout(() => host.stop(), 150); // resolve comes from the STREAM's end
        }, 200);
      }
    );
    req.on('error', reject);
    req.end(data);
  });

  check('ack first, agreed subset trims UNSUPPORTED channels, tagged',
    events.length >= 1 && events[0].method === 'notifications/subscriptions/acknowledged' &&
    events[0].params.notifications.toolsListChanged === true &&
    events[0].params.notifications.bogusChannel === undefined &&
    events[0].params._meta[SUB] === 'sub-1');
  check('tagged tools/list_changed delivered',
    events.some((e) => e.method === 'notifications/tools/list_changed' && e.params && e.params._meta && e.params._meta[SUB] === 'sub-1'));
  check('graceful close result on stop',
    events.some((e) => e.id === 'sub-1' && e.result && e.result.resultType === 'complete'));
}

(async () => {
  try {
    await protocolChecks();
    await httpChecks();
  } catch (err) {
    console.error('dual-era.test.js CRASH:', (err && err.stack) || String(err));
    fails += 1;
  }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_e) { /* temp dir; best effort */ }
  if (fails === 0) console.log('dual-era.test.js: all assertions passed');
  process.exit(fails === 0 ? 0 : 1);
})();
