#!/usr/bin/env node
/**
 * metrics.test.js - the in-memory tool-call counters stay bounded and honest under raw names.
 *
 * record() is keyed on the tools/call name exactly as the client sent it - including names that
 * never existed. Two defects followed:
 *   - unbounded growth: every distinct raw name became a permanent byTool entry, so a client
 *     spraying fresh names grew the gateway's memory for the life of the process;
 *   - a name of "__proto__": byTool itself is null-prototype, so it stored the entry - but
 *     snapshot() copied into a plain {} where assigning "__proto__" sets the PROTOTYPE instead of a
 *     key, so the entry vanished from /health and the UI.
 * Both fixed entirely inside metrics.js (record() is the single never-throw chokepoint).
 *
 * Run:  node test/metrics.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const path = require('node:path');
const assert = require('node:assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const metrics = require(path.join(REPO_ROOT, 'src', 'core', 'metrics.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

// A - a raw name of "__proto__" is a counter like any other, and pollutes nothing.
metrics.reset();
metrics.record({ tool: '__proto__', ok: false });
metrics.record({ tool: 'echo', ok: true });
const snapA = metrics.snapshot();
check('A: a tool named "__proto__" is reported as its own counter in the snapshot', () => {
  assert.ok(Object.prototype.hasOwnProperty.call(snapA.byTool, '__proto__'), 'entry missing: ' + JSON.stringify(snapA.byTool));
  assert.strictEqual(snapA.byTool['__proto__'].calls, 1);
  assert.strictEqual(snapA.byTool['__proto__'].errors, 1);
});
check('A: ...and the snapshot did not pollute Object.prototype or lose the other counters', () => {
  assert.strictEqual(({}).calls, undefined, 'Object.prototype gained a "calls" property');
  assert.strictEqual(snapA.byTool.echo.calls, 1);
  assert.strictEqual(snapA.calls, 2);
  assert.strictEqual(snapA.errors, 1);
});

// B - distinct names are capped; the overflow is counted under one bucket, totals stay exact.
metrics.reset();
const N = 1500;
for (let i = 0; i < N; i += 1) metrics.record({ tool: 'spray-' + i, ok: i % 2 === 0 });
const snapB = metrics.snapshot();
const keys = Object.keys(snapB.byTool);
const sumCalls = keys.reduce((a, k) => a + snapB.byTool[k].calls, 0);
const sumErrors = keys.reduce((a, k) => a + snapB.byTool[k].errors, 0);
check('B: 1500 distinct raw names do NOT become 1500 entries (bounded)', () => {
  assert.ok(keys.length <= 1001, `byTool has ${keys.length} entries`);
});
check('B: the totals are exact and every call lands in some entry (overflow bucket included)', () => {
  assert.strictEqual(snapB.calls, N);
  assert.strictEqual(snapB.errors, N / 2);
  assert.strictEqual(sumCalls, N, 'per-entry calls do not add up to the total');
  assert.strictEqual(sumErrors, N / 2, 'per-entry errors do not add up to the total');
});
check('B: a name seen BEFORE the cap keeps its own counter afterwards', () => {
  metrics.record({ tool: 'spray-0', ok: true });
  const s = metrics.snapshot();
  assert.strictEqual(s.byTool['spray-0'].calls, 2, 'got ' + JSON.stringify(s.byTool['spray-0']));
});
metrics.reset();

for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
const passed = results.filter((r) => r.ok).length;
const expected = 5;
if (passed === results.length && results.length === expected) {
  console.log(`\nPASS: metrics test - ${passed}/${expected} assertions passed (bounded, prototype-safe counters)`);
  process.exit(0);
}
console.log(`\nFAIL: metrics test - ${passed}/${results.length} assertions passed`);
process.exit(1);
