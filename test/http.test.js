'use strict';

/**
 * http.test.js — end-to-end test of the HTTP/SSE transport (src/mcp/http-transport.js).
 *
 * Stands up a REAL host on an OS-assigned ephemeral port (port 0 — never 9998, which is taken
 * by a long-lived process) and drives it over the loopback socket with node:http only:
 *
 *   1. GET  /health           → 200, body.ok === true, body.server.name === "toolfunnel".
 *   2. POST /mcp initialize    → 200, a JSON-RPC result with a protocolVersion + serverInfo.
 *   3. POST /mcp tools/list    → 200, the three advertised lean meta-tools are present.
 *   4. POST /mcp tools/call    → 200, toolfunnel_list_tools returns a non-empty briefs array.
 *
 * Then stop() tears the host down cleanly. Run:  node test/http.test.js   (exit 0 = pass).
 *
 * Node built-ins only (node:assert, node:http) — no npm dependency, no MCP SDK.
 */

const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

const { createHttpMcpServer } = require(path.join(__dirname, '..', 'src', 'mcp', 'http-transport.js'));
const authConfig = require(path.join(__dirname, '..', 'src', 'auth', 'config.js'));

// This test drives the HTTP transport WITHOUT a bearer token and asserts 200s. If a prior suite run
// was hard-killed mid-test and left auth/auth.config.json ENABLED, every request here would 401.
// Force auth OFF at startup (the committed default) so this test is robust to such a leak, however
// it occurred — including the runner's uncatchable Windows timeout-kill.
try { authConfig.setConfig({ enabled: false }); } catch (_e) { /* best-effort; default is off anyway */ }

// ── A tiny loopback HTTP client over node:http ────────────────────────────────────────────────
/**
 * Issue one HTTP request and buffer the full response. Resolves { status, headers, text, json }.
 * `json` is the parsed body when it is valid JSON, else null. Never hangs: rejects on socket error.
 * @param {{host:string, port:number, method:string, path:string, body?:string}} o
 * @returns {Promise<{status:number, headers:object, text:string, json:(object|null)}>}
 */
function request(o) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (o.body != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(o.body, 'utf8');
    }
    const req = http.request(
      { host: o.host, port: o.port, method: o.method, path: o.path, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_e) {
            /* leave json null for non-JSON bodies */
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', reject);
    if (o.body != null) req.write(o.body);
    req.end();
  });
}

/** Convenience: POST one JSON-RPC message to /mcp and return the parsed response. */
function rpc(host, port, message) {
  return request({ host, port, method: 'POST', path: '/mcp', body: JSON.stringify(message) });
}

(async () => {
  const pass = [];

  const server = createHttpMcpServer({ host: '127.0.0.1', port: 0 });
  const { port, url } = await server.start();
  assert.ok(Number.isInteger(port) && port > 0, 'start() resolved an OS-assigned port: ' + port);
  assert.ok(typeof url === 'string' && url.includes(String(port)), 'start() resolved a url: ' + url);
  pass.push('start() bound an ephemeral port (' + port + ') at ' + url);

  const host = '127.0.0.1';

  try {
    // ── 1. GET /health ──────────────────────────────────────────────────────────────────────
    const health = await request({ host, port, method: 'GET', path: '/health' });
    assert.strictEqual(health.status, 200, 'GET /health status is 200 (got ' + health.status + ')');
    assert.ok(health.json && typeof health.json === 'object', 'GET /health returned a JSON body');
    assert.strictEqual(health.json.ok, true, 'GET /health body.ok === true');
    assert.ok(health.json.server && typeof health.json.server === 'object', 'GET /health has a server object');
    assert.strictEqual(
      health.json.server.name,
      'toolfunnel',
      'GET /health body.server.name === "toolfunnel" (got ' + (health.json.server && health.json.server.name) + ')'
    );
    pass.push('GET /health → 200, ok:true, server.name="toolfunnel"');

    // ── 2. POST /mcp initialize ─────────────────────────────────────────────────────────────
    const init = await rpc(host, port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'http.test', version: '0' } },
    });
    assert.strictEqual(init.status, 200, 'POST /mcp initialize status is 200 (got ' + init.status + ')');
    assert.ok(init.json && init.json.result, 'initialize returned a JSON-RPC result');
    assert.strictEqual(init.json.id, 1, 'initialize response echoes id 1');
    assert.ok(
      typeof init.json.result.protocolVersion === 'string' && init.json.result.protocolVersion.length > 0,
      'initialize result has a protocolVersion'
    );
    assert.strictEqual(
      init.json.result.serverInfo && init.json.result.serverInfo.name,
      'toolfunnel',
      'initialize result serverInfo.name === "toolfunnel"'
    );
    pass.push('POST /mcp initialize → 200, protocolVersion + serverInfo.name="toolfunnel"');

    // ── 3. POST /mcp tools/list ─────────────────────────────────────────────────────────────
    const list = await rpc(host, port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.strictEqual(list.status, 200, 'POST /mcp tools/list status is 200 (got ' + list.status + ')');
    assert.ok(list.json && list.json.result && Array.isArray(list.json.result.tools), 'tools/list returned a tools array');
    const toolNames = list.json.result.tools.map((t) => t && t.name);
    const metas = ['toolfunnel_list_tools', 'toolfunnel_tool_instructions', 'toolfunnel_howto'];
    for (const m of metas) {
      assert.ok(toolNames.includes(m), 'tools/list advertises meta-tool "' + m + '" (got ' + JSON.stringify(toolNames) + ')');
    }
    pass.push('POST /mcp tools/list → 200, meta-tools present: ' + metas.join(', '));

    // ── 4. POST /mcp tools/call {name:"toolfunnel_list_tools"} ───────────────────────────────
    const call = await rpc(host, port, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'toolfunnel_list_tools', arguments: {} },
    });
    assert.strictEqual(call.status, 200, 'POST /mcp tools/call status is 200 (got ' + call.status + ')');
    assert.ok(call.json && call.json.result, 'tools/call returned a JSON-RPC result');
    assert.notStrictEqual(call.json.result.isError, true, 'tools/call toolfunnel_list_tools is not an error result');
    const content = call.json.result.content;
    assert.ok(Array.isArray(content) && content[0] && typeof content[0].text === 'string', 'tools/call returned a text content block');
    let briefs = null;
    try {
      briefs = JSON.parse(content[0].text);
    } catch (_e) {
      /* leave null → assertion below fails with the raw text */
    }
    assert.ok(
      Array.isArray(briefs) && briefs.length > 0,
      'toolfunnel_list_tools returned a non-empty briefs array (raw: ' + String(content[0].text).slice(0, 200) + ')'
    );
    const ids = briefs.map((b) => b && b.id).filter(Boolean);
    assert.ok(ids.length > 0, 'each brief carries an id (got ' + JSON.stringify(ids) + ')');
    pass.push('POST /mcp tools/call toolfunnel_list_tools → ' + briefs.length + ' briefs: ' + ids.join(', '));
  } finally {
    // Always tear the host down, even if an assertion threw, so the test process can exit.
    await server.stop();
    assert.strictEqual(server.port, null, 'stop() cleared the bound port');
  }
  pass.push('stop() tore the host down cleanly');

  for (const p of pass) console.log('  ok - ' + p);
  console.log('\nPASS http.test.js — ' + pass.length + ' assertions, all green');
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL http.test.js — ' + ((e && e.message) || e));
  if (e && e.stack) console.error(e.stack);
  process.exit(1);
});
