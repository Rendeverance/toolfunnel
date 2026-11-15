#!/usr/bin/env node
/**
 * progress-relay-http.test.js - upstream progress reaches the RIGHT HTTP caller, on its own stream.
 *
 * The HTTP host used to drop upstream progress entirely: POST /mcp answered one JSON object, and
 * broadcasting progress on the shared GET stream would hand client A's beats to client B. Now a POST
 * that carries params._meta.progressToken AND accepts text/event-stream gets its answer as an SSE
 * stream the moment the first beat arrives: its own progress (its own token), then its result, then
 * the end - the Streamable-HTTP rule ("MAY send ... notifications before sending the JSON-RPC
 * response. These messages SHOULD relate to the originating client request"). Everything else is
 * the same application/json answer as before, and the GET stream never carries progress.
 *
 * In-process host against a scratch home with the bundled mock upstream (`prog`: two beats, then a
 * result saying whether it saw a token).
 *
 * Run:  node test/progress-relay-http.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert');
const { useTempHome, writeJson, REPO_ROOT } = require('./helpers/temp-home');

const HOME = useTempHome({ prefix: 'tf-progress-http-', seed: true }); // claimed before any src/ require
writeJson(HOME.expose, {
  version: 1,
  upstreams: [{ id: 'mock', transport: 'stdio', command: process.execPath, args: [path.join(HOME.mcpDir, 'servers', 'mock-upstream', 'server.js')], enabled: true }],
  expose: [{ upstream: 'mock', tool: 'prog', as: 'mock_prog', enabled: true }],
});
const { createHttpMcpServer } = require(path.join(REPO_ROOT, 'src', 'mcp', 'http-transport.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

function post(port, body, accept, extra) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers: Object.assign({
      'Content-Type': 'application/json', Accept: accept, 'Content-Length': Buffer.byteLength(data),
    }, extra || {}) }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: String(res.headers['content-type'] || ''), text: d }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
const sseEvents = (text) => text.split(/\r?\n\r?\n/).map((blk) => blk.split(/\r?\n/).filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n'))
  .filter(Boolean).map((s) => JSON.parse(s));
const BOTH = 'application/json, text/event-stream';
const call = (id, name, token, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: Object.assign({ name, arguments: args || {} }, token === undefined ? {} : { _meta: { progressToken: token } }) });

(async () => {
  const server = createHttpMcpServer({ host: '127.0.0.1', port: 0 });
  const { port } = await server.start();
  // A legacy GET stream listening the whole time: it must never see progress.
  const getSeen = [];
  const getReq = http.get({ host: '127.0.0.1', port, path: '/mcp', headers: { Accept: 'text/event-stream' } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (c) => { getSeen.push(c); });
  });
  getReq.on('error', () => {});
  try {
    const [a, b] = await Promise.all([post(port, call(11, 'mock_prog', 1), BOTH), post(port, call(12, 'mock_prog', 1), BOTH)]);
    check('two concurrent callers with the SAME token each get an SSE stream with ONLY their own two beats, then their own result', () => {
      for (const [r, id] of [[a, 11], [b, 12]]) {
        assert.ok(r.type.includes('text/event-stream'), `id ${id}: content-type ${r.type}; body ${r.text.slice(0, 200)}`);
        const ev = sseEvents(r.text);
        const beats = ev.filter((e) => e.method === 'notifications/progress');
        assert.deepStrictEqual(beats.map((e) => [e.params.progressToken, e.params.progress]), [[1, 1], [1, 2]], `id ${id}: ${r.text.slice(0, 400)}`);
        const last = ev[ev.length - 1];
        assert.strictEqual(last.id, id, 'the final event is not this request\'s result');
        assert.ok(/token seen/.test(last.result.content[0].text));
      }
    });

    const lean = await post(port, { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'toolfunnel_run_tool', arguments: { name: 'mock_prog', args: {} }, _meta: { progressToken: 'L' } } }, BOTH);
    check('the lean route (toolfunnel_run_tool) streams its progress the same way', () => {
      assert.ok(lean.type.includes('text/event-stream'), lean.type + ' ' + lean.text.slice(0, 200));
      const ev = sseEvents(lean.text);
      assert.deepStrictEqual(ev.filter((e) => e.method === 'notifications/progress').map((e) => e.params.progressToken), ['L', 'L']);
      assert.strictEqual(ev[ev.length - 1].id, 13);
    });

    const MODERN_META = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'progress-http-test', version: '0.0.0' },
      progressToken: 'M',
    };
    const mod = await post(port, { jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'mock_prog', arguments: {}, _meta: MODERN_META } }, BOTH,
      { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'mock_prog' });
    check('a MODERN-era (2026-07-28) call streams its progress on its own response stream too', () => {
      assert.ok(mod.type.includes('text/event-stream'), mod.status + ' ' + mod.type + ' ' + mod.text.slice(0, 300));
      const ev = sseEvents(mod.text);
      assert.deepStrictEqual(ev.filter((e) => e.method === 'notifications/progress').map((e) => [e.params.progressToken, e.params.progress]), [['M', 1], ['M', 2]]);
      const last = ev[ev.length - 1];
      assert.strictEqual(last.id, 16);
      assert.ok(last.result && /token seen/.test(last.result.content[0].text), JSON.stringify(last).slice(0, 300));
    });

    const jsonOnly = await post(port, call(14, 'mock_prog', 7), 'application/json');
    const noToken = await post(port, call(15, 'mock_prog'), BOTH);
    check('without text/event-stream in Accept, or without a token, the answer is plain JSON as before', () => {
      assert.ok(jsonOnly.type.includes('application/json'), jsonOnly.type);
      assert.strictEqual(JSON.parse(jsonOnly.text).id, 14);
      assert.ok(/token seen/.test(JSON.parse(jsonOnly.text).result.content[0].text), 'the token was not forwarded upstream');
      assert.ok(noToken.type.includes('application/json'), noToken.type);
      assert.ok(/NO token/.test(JSON.parse(noToken.text).result.content[0].text));
    });

    await new Promise((r) => setTimeout(r, 200));
    check('the shared GET stream never carries anyone\'s progress', () => {
      assert.ok(!getSeen.join('').includes('notifications/progress'), getSeen.join('').slice(0, 300));
    });
  } catch (e) {
    results.push({ name: 'the run completed', ok: false, detail: (e && e.stack) || String(e) });
  } finally {
    try { getReq.destroy(); } catch (_e) { /* ignore */ }
    await server.stop();
  }

  const EXPECTED = 5;
  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  if (passed === results.length && results.length === EXPECTED) {
    console.log(`\nPASS: progress-relay-http test - ${passed}/${EXPECTED} assertions passed (per-request SSE progress, scoped; JSON otherwise)`);
    process.exit(0);
  }
  console.log(`\nFAIL: progress-relay-http test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
  process.exit(1);
})().catch((e) => { console.log('PROGRESS-RELAY-HTTP TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(2); });
