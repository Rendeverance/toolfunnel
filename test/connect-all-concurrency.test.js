'use strict';

/**
 * connect-all-concurrency.test.js - startup pin for Aggregator.connectAll()
 * (in-process, fake clients - no spawned children, so the timing is deterministic):
 *
 *   A - CONCURRENT: connectAll() connects every enabled upstream TOGETHER, so startup costs
 *       the SLOWEST upstream, not the SUM of all of them. A sequential loop fails this on
 *       wall-clock alone (4 x 250 ms serial = ~1000 ms vs the 700 ms ceiling asserted here).
 *       The ceiling sits between the concurrent floor (~250 ms) and the sequential cost, with
 *       enough slack for a loaded CI runner's timer granularity.
 *   B - ACCOUNTING: every enabled upstream lands in EXACTLY ONE of connected[]/failed[].
 *       A failing upstream never sinks the batch, is reported with its error, and its
 *       half-built client is closed (no zombie child, no cache entry).
 *   C - ORDER: connected[]/failed[] follow STORE order, not completion order - a fast upstream
 *       declared last must not jump ahead of a slow one declared first.
 *   D - CACHED: an already-connected upstream is reported as connected WITHOUT a second
 *       factory call (no double-spawn on a reload).
 *   E - SELF-HEAL: a failed STARTUP connect arms the background reconnect, so a transient
 *       failure (a slow boot that missed its handshake window) does not strand the upstream
 *       for the whole session.
 *
 * Run:  node test/connect-all-concurrency.test.js     (exit 0 = pass, non-zero = fail)
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeStore(upstreams) {
  return {
    listUpstreams: () => upstreams.map((u) => ({ ...u })),
    getUpstream: (id) => { const u = upstreams.find((x) => x.id === id); return u ? { ...u } : undefined; },
    listExposed: () => [],
    exposedName: (e) => `${e.upstream}_${e.tool}`,
  };
}

/** A fake client whose connect() resolves (or rejects) after `delayMs`; records close() in `log`. */
function makeSlowClient(id, delayMs, log, failConnect) {
  let closed = false;
  return {
    id,
    _connected: false,
    get connected() { return this._connected && !closed; },
    initializeResult: { protocolVersion: '2024-11-05', serverInfo: { name: id } },
    era: 'legacy',
    eraDefinitive: true,
    clientInfo: { name: 'toolfunnel', version: 'x' },
    onNotification: null,
    onServerRequest: null,
    async connect() {
      log.push(`${id}:connect`);
      await sleep(delayMs);
      if (closed) throw new Error('connection closed');
      if (failConnect) throw new Error('simulated connect failure');
      this._connected = true;
      return this.initializeResult;
    },
    async listTools() { return [{ name: 'ping' }]; },
    close() { closed = true; this._connected = false; log.push(`${id}:close`); },
    request: async () => ({}),
  };
}

(async () => {
  // A - four 250 ms upstreams. Concurrent => ~250 ms total. Sequential => ~1000 ms.
  {
    const log = [];
    const ids = ['u1', 'u2', 'u3', 'u4'];
    const agg = new Aggregator({
      store: makeStore(ids.map((id) => ({ id, command: 'x', args: [], env: {}, enabled: true }))),
      clientFactory: (u) => makeSlowClient(u.id, 250, log, false),
    });
    const t0 = Date.now();
    const res = await agg.connectAll();
    const elapsed = Date.now() - t0;
    check('A: connectAll connects upstreams CONCURRENTLY (wall-clock = slowest, not sum)', () => {
      assert.deepStrictEqual(res.connected, ids, 'not all upstreams connected: ' + JSON.stringify(res));
      assert.deepStrictEqual(res.failed, [], 'unexpected failures: ' + JSON.stringify(res.failed));
      assert.ok(
        elapsed < 700,
        `connectAll took ${elapsed}ms for 4x250ms upstreams - sequential (expected <700ms)`
      );
    });
    await agg.closeAll();
  }

  // B - one upstream fails: the batch survives, the failure is reported, the client is closed.
  {
    const log = [];
    const agg = new Aggregator({
      store: makeStore([
        { id: 'ok1', command: 'x', args: [], env: {}, enabled: true },
        { id: 'bad', command: 'x', args: [], env: {}, enabled: true },
        { id: 'ok2', command: 'x', args: [], env: {}, enabled: true },
        { id: 'off', command: 'x', args: [], env: {}, enabled: false },
      ]),
      clientFactory: (u) => makeSlowClient(u.id, 60, log, u.id === 'bad'),
    });
    const res = await agg.connectAll();
    check('B: a failing upstream is reported, never sinks the batch, leaves no zombie client', () => {
      assert.deepStrictEqual(res.connected, ['ok1', 'ok2'], 'connected wrong: ' + JSON.stringify(res.connected));
      assert.strictEqual(res.failed.length, 1, 'failed wrong: ' + JSON.stringify(res.failed));
      assert.strictEqual(res.failed[0].id, 'bad');
      assert.match(res.failed[0].error, /simulated connect failure/);
      assert.ok(log.includes('bad:close'), 'half-built client not discarded: ' + log.join('|'));
      // Every ENABLED upstream is accounted for exactly once; the disabled one in neither list.
      const seen = res.connected.concat(res.failed.map((f) => f.id));
      assert.deepStrictEqual(seen.sort(), ['bad', 'ok1', 'ok2'], 'accounting gap: ' + seen.join(','));
    });
    await agg.closeAll();
  }

  // C - a fast upstream declared LAST must still be reported last (store order, not finish order).
  {
    const log = [];
    const agg = new Aggregator({
      store: makeStore([
        { id: 'slow', command: 'x', args: [], env: {}, enabled: true },
        { id: 'fast', command: 'x', args: [], env: {}, enabled: true },
      ]),
      clientFactory: (u) => makeSlowClient(u.id, u.id === 'slow' ? 200 : 10, log, false),
    });
    const res = await agg.connectAll();
    check('C: connected[] follows STORE order, not completion order', () => {
      assert.deepStrictEqual(res.connected, ['slow', 'fast'], 'order drifted: ' + JSON.stringify(res.connected));
    });
    await agg.closeAll();
  }

  // D - a second connectAll() reuses the cached client instead of spawning a second one.
  {
    const log = [];
    let factoryCalls = 0;
    const agg = new Aggregator({
      store: makeStore([{ id: 'u1', command: 'x', args: [], env: {}, enabled: true }]),
      clientFactory: (u) => { factoryCalls++; return makeSlowClient(u.id, 20, log, false); },
    });
    await agg.connectAll();
    const res = await agg.connectAll();
    check('D: an already-connected upstream is not re-spawned', () => {
      assert.deepStrictEqual(res.connected, ['u1'], 'cached upstream not reported: ' + JSON.stringify(res));
      assert.strictEqual(factoryCalls, 1, 'factory ran ' + factoryCalls + 'x (double-spawn)');
    });
    await agg.closeAll();
  }

  // E - a TRANSIENT startup failure self-heals: connectAll arms the background reconnect, so an
  //     upstream that missed its handshake window comes back on its own instead of being lost
  //     for the whole session.
  {
    const log = [];
    let attempt = 0;
    const agg = new Aggregator({
      store: makeStore([{ id: 'flaky', command: 'x', args: [], env: {}, enabled: true }]),
      clientFactory: (u) => makeSlowClient(u.id, 20, log, ++attempt === 1), // first connect fails
    });
    const res = await agg.connectAll();
    const failedFirst = res.failed.length === 1 && res.failed[0].id === 'flaky';
    await sleep(1400); // attempt-0 backoff is 1000ms
    const healed = agg._clients.has('flaky');
    check('E: a failed STARTUP connect arms the background reconnect (self-heals)', () => {
      assert.ok(failedFirst, 'first connectAll should report the failure: ' + JSON.stringify(res));
      assert.deepStrictEqual(res.connected, [], 'nothing should be connected on the first pass');
      assert.ok(healed, 'upstream was stranded - no background reconnect was scheduled');
      assert.strictEqual(attempt, 2, 'expected exactly one retry, saw ' + attempt + ' connects');
    });
    await agg.closeAll();
  }

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} - ${r.name}${r.ok ? '' : '\n       ' + r.detail}`);
  if (passed !== results.length) {
    console.error(`\nFAIL: connect-all-concurrency - ${passed}/${results.length} checks passed`);
    process.exit(1);
  }
  console.log(`\nPASS: connect-all-concurrency test - ${passed}/${results.length} checks passed (concurrency, accounting, order, cache, self-heal)`);
})().catch((err) => { console.error('FATAL:', err); process.exit(1); });
