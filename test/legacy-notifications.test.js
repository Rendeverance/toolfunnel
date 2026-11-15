#!/usr/bin/env node
/**
 * legacy-notifications.test.js - a legacy-era NOTIFICATION (no id) never gets a reply.
 *
 * JSON-RPC 2.0: a message without an id is a notification and MUST NOT be answered. The modern
 * dispatcher guards every case on hasId (tools/call executes, then returns null). The legacy
 * dispatcher only guarded its default branch: `initialize`, `tools/list`, `ping` and `tools/call`
 * answered an id-less message with a response carrying `"id": null` - which a strict client
 * rejects as an unmatched reply, and which is not what the same message gets on the modern path.
 *
 * In-process over buildProtocol()/handleMessage() (the smoke.js shape) against a scratch home.
 * tools/call is asserted as EXECUTED-but-unanswered via the metrics chokepoint, the modern rule.
 *
 * Run:  node test/legacy-notifications.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const path = require('node:path');
const assert = require('node:assert');

const { useTempHome } = require('./helpers/temp-home');
useTempHome({ prefix: 'tf-legacy-notif-' }); // scratch config home, claimed BEFORE any src/ module captures the repo's
const REPO_ROOT = path.resolve(__dirname, '..');
const { buildProtocol, handleMessage } = require(path.join(REPO_ROOT, 'src', 'mcp', 'server.js'));
const metrics = require(path.join(REPO_ROOT, 'src', 'core', 'metrics.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
const notify = (build, method, params) => handleMessage(build, { jsonrpc: '2.0', method, params: params || {} }, 'stdio');

(async () => {
  const build = buildProtocol();

  // Sanity: the same methods WITH an id are answered (the guard must not over-reach).
  const pinged = await handleMessage(build, { jsonrpc: '2.0', id: 1, method: 'ping', params: {} }, 'stdio');
  check('sanity: a ping REQUEST (with id) is answered', () => {
    assert.ok(pinged && pinged.id === 1 && pinged.result, 'got ' + JSON.stringify(pinged));
  });

  const cases = [
    ['ping', {}],
    ['tools/list', {}],
    ['initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'legacy-notifications.test', version: '0' } }],
  ];
  for (const [method, params] of cases) {
    const r = await notify(build, method, params);
    check(`a legacy ${method} NOTIFICATION (no id) gets NO reply`, () => {
      assert.strictEqual(r, null, 'replied to a notification: ' + JSON.stringify(r));
    });
  }

  // tools/call: executed (the metrics chokepoint counts it) but never answered - the modern rule.
  const before = metrics.snapshot().calls;
  const called = await notify(build, 'tools/call', { name: 'toolfunnel_list_tools', arguments: {} });
  const after = metrics.snapshot().calls;
  check('a legacy tools/call NOTIFICATION is EXECUTED (counted) but gets NO reply', () => {
    assert.strictEqual(after, before + 1, `metrics.calls ${before} -> ${after}: the call did not run`);
    assert.strictEqual(called, null, 'replied to a notification-shaped call: ' + JSON.stringify(called));
  });

  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  const expected = 5;
  if (passed === results.length && results.length === expected) {
    console.log(`\nPASS: legacy-notifications test - ${passed}/${expected} assertions passed (id-less legacy messages are never answered)`);
    process.exit(0);
  }
  console.log(`\nFAIL: legacy-notifications test - ${passed}/${results.length} assertions passed`);
  process.exit(1);
})().catch((e) => { console.log('LEGACY-NOTIFICATIONS TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
