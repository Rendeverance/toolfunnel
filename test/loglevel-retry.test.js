#!/usr/bin/env node
/**
 * loglevel-retry.test.js - a refused logging/setLevel is re-issued on the next call at that level.
 *
 * A legacy upstream that declared the `logging` capability gets the caller's logLevel translated to
 * a `logging/setLevel` request issued BEFORE the main request, deduped per distinct level via
 * _lastSetLogLevel. The memo was written BEFORE the request settled and never reverted, so an
 * upstream that refused (or timed out on) the setLevel was never asked again for that level: every
 * later call at the same level silently ran at whatever level the upstream had. The memo is now
 * reverted when the setLevel fails, so the next call re-issues it. The ordering contract stays:
 * setLevel is still written before the main request ("ordered by the pipe").
 *
 * Unit-level with the fake stdio child (no process): initialize answers with logging capability;
 * the first logging/setLevel is answered with a JSON-RPC error, later ones succeed.
 *
 * Run:  node test/loglevel-retry.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const path = require('node:path');
const assert = require('node:assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const { McpClient } = require(path.join(REPO_ROOT, 'src', 'mcp', 'mcp-client.js'));
const { makeFakeChild } = require('./helpers/fake-stdio-child');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
const LEVEL_KEY = 'io.modelcontextprotocol/logLevel';
const keepalive = setInterval(() => {}, 1000);

(async () => {
  let setLevelSeen = 0;
  const answer = (child, msg) => {
    if (msg.id === undefined) return; // notifications/initialized etc.
    if (msg.method === 'initialize') {
      return child.reply({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { logging: {} }, serverInfo: { name: 'fake-logging', version: '0' } } });
    }
    if (msg.method === 'logging/setLevel') {
      setLevelSeen += 1;
      if (setLevelSeen === 1) return child.reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'simulated setLevel refusal' } });
      return child.reply({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
    if (msg.method === 'tools/call') {
      return child.reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } });
    }
    return child.reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  };
  let child = null;
  const client = new McpClient({ id: 'loglevel', command: 'fake', forceLegacy: true, requestTimeoutMs: 600, toolTimeoutMs: 600, spawnImpl: () => { child = makeFakeChild('loglevel', answer); return child; } });

  await client.connect();
  check('sanity: the legacy handshake completed against the fake (logging capability declared)', () => {
    assert.ok(client.connected === true);
    assert.ok(client.initializeResult && client.initializeResult.capabilities && client.initializeResult.capabilities.logging, 'no logging capability recorded');
  });

  const first = await client.callTool('echo', {}, { [LEVEL_KEY]: 'debug' });
  const orderFirst = child.requests.filter((m) => m.method === 'logging/setLevel' || m.method === 'tools/call').map((m) => m.method);
  check('the first call issues logging/setLevel BEFORE tools/call (ordered by the pipe)', () => {
    assert.deepStrictEqual(orderFirst, ['logging/setLevel', 'tools/call'], 'order: ' + orderFirst.join(','));
    assert.strictEqual(first && first.content && first.content[0] && first.content[0].text, 'ok', 'the main call must not fail because setLevel was refused');
  });

  // Let the refused setLevel settle (it was fire-and-forget) before the second call.
  await new Promise((r) => setTimeout(r, 50));
  await client.callTool('echo', {}, { [LEVEL_KEY]: 'debug' });
  const setLevels = child.requests.filter((m) => m.method === 'logging/setLevel');
  check('after a REFUSED setLevel, the next call at the same level re-issues it', () => {
    assert.strictEqual(setLevels.length, 2, `logging/setLevel was issued ${setLevels.length} time(s); the refusal should not have been memoised as done`);
  });

  await new Promise((r) => setTimeout(r, 50));
  const before3 = child.requests.filter((m) => m.method === 'logging/setLevel').length;
  await client.callTool('echo', {}, { [LEVEL_KEY]: 'debug' });
  check('after an ACCEPTED setLevel, the same level is NOT re-issued (dedup still holds)', () => {
    assert.strictEqual(child.requests.filter((m) => m.method === 'logging/setLevel').length, before3, 'setLevel re-issued after it had succeeded');
  });

  client.close();
  clearInterval(keepalive);
  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  const expected = 4;
  if (passed === results.length && results.length === expected) {
    console.log(`\nPASS: loglevel-retry test - ${passed}/${expected} assertions passed (a refused setLevel is retried, an accepted one is not)`);
    process.exit(0);
  }
  console.log(`\nFAIL: loglevel-retry test - ${passed}/${results.length} assertions passed`);
  process.exit(1);
})().catch((e) => { console.log('LOGLEVEL-RETRY TEST CRASHED: ' + ((e && e.stack) || e)); clearInterval(keepalive); process.exit(1); });
