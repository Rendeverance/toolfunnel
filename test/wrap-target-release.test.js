#!/usr/bin/env node
/**
 * wrap-target-release.test.js - changing the wrap target tells the OUTGOING upstream to
 * unsubscribe before the subscriptions are forgotten.
 *
 * setWrapChatterUpstream() cleared the recorded resource subscriptions when the passthrough target
 * changed (A -> B, A -> null) - the right call, a client of wrap B never subscribed to wrap A's
 * URIs - but it only cleared the LOCAL record. Upstream A had been told resources/subscribe for
 * every one of them and was never told resources/unsubscribe, so it kept emitting
 * resources/updated for URIs nothing consumed, for the life of its process. The release fan-out
 * already exists (releaseResources, era/capability-filtered, never throws) and it filters on the
 * CURRENT wrapChatterUpstream, so it must run against the outgoing target BEFORE the reassignment.
 *
 * In-process with fake clients (no processes). Run:  node test/wrap-target-release.test.js
 */
'use strict';

const path = require('node:path');
const assert = require('node:assert');

const { useTempHome } = require('./helpers/temp-home');
useTempHome({ prefix: 'tf-wrap-target-release-' }); // scratch config home, so the src/ modules below never resolve the repo's
const REPO_ROOT = path.resolve(__dirname, '..');
const { Aggregator } = require(path.join(REPO_ROOT, 'src', 'mcp', 'aggregator.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function makeStore(upstreams) {
  return {
    listUpstreams: () => upstreams.map((u) => ({ ...u })),
    getUpstream: (id) => { const u = upstreams.find((x) => x.id === id); return u ? { ...u } : undefined; },
    listExposed: () => [],
    exposedName: (e) => `${e.upstream}_${e.tool}`,
  };
}
/** A subscribe-capable LEGACY client whose requests are logged as "<id>:<method>:<uri>". */
function makeClient(id, log) {
  return {
    id,
    _connected: false,
    get connected() { return this._connected; },
    initializeResult: { protocolVersion: '2024-11-05', serverInfo: { name: id }, capabilities: { resources: { subscribe: {} } } },
    era: 'legacy',
    eraDefinitive: true,
    clientInfo: { name: 'toolfunnel', version: 'x' },
    onNotification: null,
    onServerRequest: null,
    async connect() { this._connected = true; return this.initializeResult; },
    async listTools() { return [{ name: 'ping' }]; },
    close() { this._connected = false; },
    request: async (method, params) => { log.push(`${id}:${method}:${(params && params.uri) || ''}`); return {}; },
  };
}

(async () => {
  const log = [];
  const agg = new Aggregator({
    store: makeStore([{ id: 'A', command: 'x', args: [], env: {}, enabled: true }, { id: 'B', command: 'x', args: [], env: {}, enabled: true }]),
    clientFactory: (u) => makeClient(u.id, log),
  });
  await agg.connectAll();

  agg.setWrapChatterUpstream('A');
  agg.subscribeResources(['mock://x']);
  await new Promise((r) => setTimeout(r, 10));
  check('sanity: under wrap A the subscribe goes to A only', () => {
    assert.deepStrictEqual(log.filter((l) => l.includes(':resources/subscribe:')), ['A:resources/subscribe:mock://x'], 'log: ' + log.join(' | '));
  });

  agg.setWrapChatterUpstream('B'); // target change: A's subscriptions belong to the old context
  await new Promise((r) => setTimeout(r, 10));
  check('a wrap-target change tells the OUTGOING upstream to unsubscribe (not just forgotten locally)', () => {
    assert.ok(log.includes('A:resources/unsubscribe:mock://x'), 'A was never told resources/unsubscribe; log: ' + log.join(' | '));
    assert.ok(!log.some((l) => l.startsWith('B:resources/unsubscribe')), 'B (the incoming target) was told to unsubscribe something it never subscribed');
  });

  agg.subscribeResources(['mock://y']);
  await new Promise((r) => setTimeout(r, 10));
  check('after the change, a new subscribe goes to B only and A\'s old uri is not replayed', () => {
    assert.ok(log.includes('B:resources/subscribe:mock://y'), 'log: ' + log.join(' | '));
    assert.ok(!log.includes('B:resources/subscribe:mock://x'), 'the old context\'s uri replayed onto B');
  });

  agg.setWrapChatterUpstream(null); // B -> no wrap: B's subscriptions are released too
  await new Promise((r) => setTimeout(r, 10));
  check('a change to NO wrap releases the outgoing target\'s subscriptions as well', () => {
    assert.ok(log.includes('B:resources/unsubscribe:mock://y'), 'log: ' + log.join(' | '));
  });

  await agg.closeAll();
  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  const expected = 4;
  if (passed === results.length && results.length === expected) {
    console.log(`\nPASS: wrap-target-release test - ${passed}/${expected} assertions passed (the outgoing wrap target is unsubscribed)`);
    process.exit(0);
  }
  console.log(`\nFAIL: wrap-target-release test - ${passed}/${results.length} assertions passed`);
  process.exit(1);
})().catch((e) => { console.log('WRAP-TARGET-RELEASE TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
