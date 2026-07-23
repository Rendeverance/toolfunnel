'use strict';

/**
 * aggregator-races.test.js - regression pins for connect/reconnect race conditions
 * (in-process, fake clients - no spawned children, so the races are deterministic):
 *
 *   A - JOIN-BEFORE-INSPECT: a second ensureConnected arriving while a connect is in flight
 *       JOINS it - it must not see the pre-handshake cached client as "stale", close it
 *       (killing the in-flight child), then join the connect it just doomed (M1).
 *   B - RUN-PATH CONTRACT: allowConnect:false during an in-flight connect still fails clean
 *       (never joins - joining would block the serialized stdio chain).
 *   C - RECONNECT SELF-HEAL: Aggregator.reconnect() destroyed a connection deliberately, so a
 *       failed reconnect MUST schedule the background retry - one transient connect failure
 *       must not wedge the upstream with no client, no in-flight connect and no timer (M2).
 *   D - STRUCTURED CONTENT: McpClient.callTool passes structuredContent through verbatim -
 *       the curated-direct path must not strip what the raw wrap path preserves.
 *
 * Run:  node test/aggregator-races.test.js     (exit 0 = pass, non-zero = fail)
 */

const path = require('node:path');
const assert = require('node:assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const { Aggregator } = require(path.join(REPO_ROOT, 'src', 'mcp', 'aggregator.js'));
const { McpClient } = require(path.join(REPO_ROOT, 'src', 'mcp', 'mcp-client.js'));

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

/** A fake client whose connect() resolves after a delay; records close() calls in `log`. */
function makeSlowClient(id, delayMs, log, failConnect) {
  let closed = false;
  return {
    id,
    _connected: false,
    get connected() { return this._connected && !closed; },
    initializeResult: { protocolVersion: '2024-11-05', serverInfo: { name: id } },
    era: 'legacy',
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
  // A - concurrent ensureConnected during an in-flight connect: both succeed, ONE factory call,
  //     no close() of the mid-handshake client.
  {
    const log = [];
    let factoryCalls = 0;
    const agg = new Aggregator({
      store: makeStore([{ id: 'u1', command: 'x', args: [], env: {}, enabled: true }]),
      clientFactory: () => { factoryCalls++; return makeSlowClient('c' + factoryCalls, 150, log, false); },
    });
    const a = agg.ensureConnected('u1');
    await sleep(40); // B arrives mid-handshake
    const b = agg.ensureConnected('u1');
    const [ra, rb] = await Promise.all([a.catch((e) => e), b.catch((e) => e)]);
    check('A: both concurrent callers get the SAME live client (no doomed join)', () => {
      assert.ok(!(ra instanceof Error), 'caller A failed: ' + (ra && ra.message));
      assert.ok(!(rb instanceof Error), 'caller B failed: ' + (rb && rb.message));
      assert.strictEqual(ra, rb, 'callers got different clients');
      assert.strictEqual(factoryCalls, 1, 'factory ran ' + factoryCalls + '× (dup connect)');
      assert.ok(!log.includes('c1:close'), 'mid-handshake client was closed: ' + log.join('|'));
    });
    await agg.closeAll();
  }

  // B - RUN path (allowConnect:false) during an in-flight connect: clean failure, no join.
  {
    const log = [];
    const agg = new Aggregator({
      store: makeStore([{ id: 'u1', command: 'x', args: [], env: {}, enabled: true }]),
      clientFactory: () => makeSlowClient('c1', 150, log, false),
    });
    const a = agg.ensureConnected('u1');
    await sleep(40);
    let runErr = null;
    try { await agg.ensureConnected('u1', { allowConnect: false }); } catch (e) { runErr = e; }
    check('B: allowConnect:false mid-connect fails clean, never joins', () => {
      assert.ok(runErr, 'RUN path did not fail');
      assert.match(runErr.message, /not connected/, 'unexpected error: ' + runErr.message);
    });
    await a; // in-flight connect completes untouched
    check('B: ...and the in-flight connect still completed', () => {
      assert.ok(!log.includes('c1:close'), 'in-flight client was closed');
    });
    await agg.closeAll();
  }

  // C - reconnect() failure schedules the background retry (self-heal, not a wedge) - and it
  //     CLEARS a stale pending timer first: a prior death's slow 30s keepalive would otherwise
  //     make _scheduleReconnect's one-timer guard no-op the immediate retry, stranding the
  // upstream on the long window.
  {
    const log = [];
    let calls = 0;
    const agg = new Aggregator({
      store: makeStore([{ id: 'u1', command: 'x', args: [], env: {}, enabled: true }]),
      // call 1: healthy. call 2 (the reconnect): fails. call 3 (the background retry): healthy.
      clientFactory: () => { calls++; return makeSlowClient('c' + calls, 10, log, calls === 2); },
    });
    await agg.ensureConnected('u1');
    // Plant a stale 30s timer, as a prior unexpected death's slow keepalive would leave.
    const staleTimer = setTimeout(() => {}, 30000);
    staleTimer.unref();
    agg._reconnectTimers.set('u1', staleTimer);
    let recErr = null;
    try { await agg.reconnect('u1'); } catch (e) { recErr = e; }
    check('C: failed reconnect() rejects AND schedules the background retry', () => {
      assert.ok(recErr, 'reconnect unexpectedly succeeded');
      assert.strictEqual(agg._reconnectTimers.size, 1,
        'no retry timer - upstream would be wedged (clients=' + agg._clients.size + ')');
      assert.notStrictEqual(agg._reconnectTimers.get('u1'), staleTimer,
        'the stale 30s timer survived - the immediate retry was swallowed');
    });
    await sleep(1400); // attempt-0 backoff is ~1s; the healthy third client should be back
    check('C: ...and the retry actually heals the upstream (not stranded on the 30s window)', () => {
      assert.strictEqual(calls, 3, 'retry never ran (factory calls=' + calls + ')');
      const client = agg._clients.get('u1');
      assert.ok(client && client.connected, 'upstream not healed');
    });
    await agg.closeAll();
  }

  // D - callTool passes structuredContent through verbatim.
  {
    const client = new McpClient({ command: 'unused' });
    client._connected = true;
    client._request = async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { answer: 42 },
      isError: false,
    });
    const out = await client.callTool('t', {});
    check('D: callTool carries structuredContent (curated-direct fidelity)', () => {
      assert.deepStrictEqual(out.structuredContent, { answer: 42 });
      assert.strictEqual(out.isError, false);
    });
    const out2 = await (async () => {
      client._request = async () => ({ content: [], isError: false });
      return client.callTool('t', {});
    })();
    check('D: ...and absent structuredContent stays absent (no undefined key)', () => {
      assert.ok(!('structuredContent' in out2), 'phantom structuredContent key');
    });
  }

  let failed = 0;
  for (const r of results) {
    console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
    if (!r.ok) failed++;
  }
  console.log(failed === 0
    ? `PASS: aggregator-races test - ${results.length}/${results.length} assertions passed`
    : `FAIL: aggregator-races test - ${results.length - failed}/${results.length} assertions passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => { console.error('aggregator-races test crashed:', err); process.exit(1); });
