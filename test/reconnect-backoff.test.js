'use strict';

/**
 * reconnect-backoff.test.js - the death-driven reconnect backoff ESCALATES (1s,2s,4s,8s,...) even
 * when the upstream dies DURING each reconnect attempt's tools/list.
 *
 * The bug: _handleUpstreamDown (onClose) hardcoded _scheduleReconnect(id, 0). A reconnect attempt
 * deletes its own timer before awaiting ensureConnected; if the upstream then dies mid-list, onClose
 * fires WHILE the attempt is in flight, re-seeding an attempt-0 (1s) timer. The attempt's own catch
 * then tries to escalate to attempt+1, but the one-timer guard sees the just-installed attempt-0
 * timer and drops the escalation. Result: a permanent 1-second respawn loop instead of backing off -
 * an npm-resolve + Node boot every second, forever, for an npx upstream.
 *
 * Deterministic: fake clients + a MANUAL timer queue (patched global.setTimeout records the delay and
 * queues the callback; the test drains it by hand), so no wall-clock and no flake. The fake dies
 * during tools/list on every reconnect attempt (handshake ok, list calls onClose then throws) - the
 * exact reported trigger. Asserts the recorded delays escalate rather than pinning at 1000.
 *
 * Run:  node test/reconnect-backoff.test.js     (exit 0 = escalates, non-zero = pinned loop)
 */

const path = require('node:path');
const assert = require('node:assert');
const REPO_ROOT = path.resolve(__dirname, '..');
const { Aggregator } = require(path.join(REPO_ROOT, 'src', 'mcp', 'aggregator.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

function makeStore(upstreams) {
  return {
    listUpstreams: () => upstreams.map((u) => ({ ...u })),
    getUpstream: (id) => { const u = upstreams.find((x) => x.id === id); return u ? { ...u } : undefined; },
    listExposed: () => [],
    exposedName: (e) => `${e.upstream}_${e.tool}`,
  };
}

(async () => {
  // A fake client: connect() (handshake) always succeeds; listTools() is healthy on the FIRST client
  // (the live upstream) and, on every later client (a reconnect attempt), fires onClose mid-list then
  // throws - "dies during the initial tools/list", the reported trigger.
  let connectCount = 0;
  let firstOnClose = null;
  const factory = (upstream, _gatewayRoot, onClose) => {
    connectCount += 1;
    const myCount = connectCount;
    if (myCount === 1) firstOnClose = onClose;
    let closed = false;
    return {
      _connected: false,
      get connected() { return this._connected && !closed; },
      initializeResult: { protocolVersion: '2024-11-05', serverInfo: { name: upstream.id } },
      era: 'legacy',
      eraDefinitive: true,
      clientInfo: { name: 'toolfunnel', version: 'x' },
      onNotification: null,
      onServerRequest: null,
      async connect() { this._connected = true; return this.initializeResult; },
      async listTools() {
        if (myCount === 1) return [{ name: 'ping' }];
        onClose();                                   // the upstream dies WHILE listing
        throw new Error('died during tools/list');
      },
      close() { closed = true; this._connected = false; },
      request: async () => ({}),
      respondToServerError() {},
    };
  };

  const agg = new Aggregator({
    store: makeStore([{ id: 'u1', command: 'x', args: [], env: {}, enabled: true }]),
    clientFactory: (upstream, gatewayRoot, onClose) => factory(upstream, gatewayRoot, onClose),
    onToolsChanged: () => {},
  });

  // Initial healthy connect (uses no timers).
  await agg.ensureConnected('u1');

  // ── manual timer queue: capture reconnect delays, drive cycles by hand (no wall-clock) ──────────
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const recorded = [];
  const queue = [];
  global.setTimeout = (fn, delay, ...args) => {
    if (delay >= 1000) { recorded.push(delay); const h = { _fn: fn, unref() {} }; queue.push(h); return h; }
    return realSetTimeout(fn, delay, ...args); // any small delay (unexpected) still runs normally
  };
  global.clearTimeout = (h) => {
    if (h && typeof h._fn === 'function') { const i = queue.indexOf(h); if (i >= 0) queue.splice(i, 1); return; }
    return realClearTimeout(h);
  };

  try {
    // Start the loop exactly as an unexpected death would: the live client's onClose.
    firstOnClose();
    // Drain a handful of cycles by hand. Each fired callback re-schedules the next attempt.
    for (let i = 0; i < 6 && queue.length; i++) {
      const t = queue.shift();
      await t._fn();
      await Promise.resolve();
    }
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    try { await agg.closeAll(); } catch (_e) { /* ignore */ }
  }

  check('the backoff ESCALATES across mid-list deaths (not a permanent 1s loop)',
    () => {
      assert.ok(recorded.length >= 4, 'too few cycles observed: ' + JSON.stringify(recorded));
      assert.deepStrictEqual(recorded.slice(0, 4), [1000, 2000, 4000, 8000],
        'expected exponential backoff, got ' + JSON.stringify(recorded));
    });

  check('no attempt after the first is scheduled at the 1s floor (the loop signature)',
    () => {
      const flooredAfterFirst = recorded.slice(1).filter((d) => d === 1000).length;
      assert.strictEqual(flooredAfterFirst, 0,
        'a reconnect re-seeded the 1s floor ' + flooredAfterFirst + '× - the permanent loop: ' + JSON.stringify(recorded));
    });

  for (const r of results) {
    console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  }
  const passed = results.filter((r) => r.ok).length;
  if (passed === results.length && results.length === 2) {
    console.log('\nPASS: reconnect-backoff test - backoff escalates through mid-list deaths (no 1s respawn loop)');
    process.exit(0);
  } else {
    console.log('\nFAIL: reconnect-backoff test - ' + passed + '/' + results.length);
    process.exit(1);
  }
})().catch((e) => { console.log('RECONNECT-BACKOFF TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(2); });
