#!/usr/bin/env node
/**
 * progress-scoping.test.js - upstream progress reaches ONLY the caller that asked for it.
 *
 * Client progress tokens are client-chosen, so two callers can both use `progressToken: 7` over ONE
 * shared upstream connection. The aggregator now rewrites a caller's token to a gateway-scoped one
 * before the upstream sees it, routes that token's beats to the caller's own sink with the ORIGINAL
 * token restored, accepts beats only from the upstream the token was issued to, and drops beats
 * after the call settles (a gateway token never reaches a client). Without a sink the token goes
 * upstream unchanged, as before (it still keeps the upstream's payload timeout alive).
 *
 * Run:  node test/progress-scoping.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const path = require('node:path');
const assert = require('node:assert');
const { useTempHome, REPO_ROOT } = require('./helpers/temp-home');

const HOME = useTempHome({ prefix: 'tf-progress-scoping-' }); // claimed before any src/ require
const { Aggregator } = require(path.join(REPO_ROOT, 'src', 'mcp', 'aggregator.js'));

const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

/** A fake upstream whose calls stay open until released, recording the token each call carried. */
function makeUpstream(id) {
  const u = { id, client: null, calls: [] };
  u.factory = () => {
    const client = {
      id,
      _connected: false,
      get connected() { return this._connected; },
      initializeResult: { protocolVersion: '2024-11-05', serverInfo: { name: id, version: '1.0.0' } },
      era: 'legacy', eraDefinitive: true, clientInfo: { name: 'toolfunnel', version: 'x' },
      onNotification: null, onServerRequest: null,
      async connect() { this._connected = true; return this.initializeResult; },
      async listTools() { return [{ name: 'work', description: 'Does work.', inputSchema: { type: 'object' } }]; },
      callTool(name, args, meta) {
        return new Promise((resolve) => { u.calls.push({ token: meta && meta.progressToken, meta, done: () => resolve({ content: [{ type: 'text', text: 'done' }] }) }); });
      },
      request(method, params) {
        return new Promise((resolve) => { u.calls.push({ token: params && params._meta && params._meta.progressToken, meta: params && params._meta, done: () => resolve({ content: [{ type: 'text', text: 'done' }] }) }); });
      },
      close() { this._connected = false; },
      respondToServerError() {},
    };
    u.client = client;
    return client;
  };
  u.beat = (token, progress) => u.client.onNotification({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress, total: 10 } });
  return u;
}

const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  const A = makeUpstream('ua');
  const B = makeUpstream('ub');
  const byId = { ua: A, ub: B };
  const store = {
    listUpstreams: () => ['ua', 'ub'].map((id) => ({ id, command: 'x', args: [], env: {}, enabled: true })),
    getUpstream: (id) => (byId[id] ? { id, command: 'x', args: [], env: {}, enabled: true } : undefined),
    listExposed: () => [{ upstream: 'ua', tool: 'work', as: 'ua_work', enabled: true }],
    exposedName: (e) => e.as,
  };
  const agg = new Aggregator({ store, gatewayRoot: HOME.home, clientFactory: (u) => byId[u.id].factory(), onToolsChanged: () => {} });
  const leaked = [];
  agg.onUpstreamNotification = (uid, n) => leaked.push({ uid, n });
  await agg.connectAll();

  // Two concurrent LEAN calls to the same upstream, SAME client token, different sinks.
  const got1 = [];
  const got2 = [];
  const r1 = agg.resolveLeanExecution('ua_work', {}, { meta: { progressToken: 7 }, progress: (p) => got1.push(p) });
  const r2 = agg.resolveLeanExecution('ua_work', {}, { meta: { progressToken: 7 }, progress: (p) => got2.push(p) });
  const p1 = r1.execute();
  const p2 = r2.execute();
  await tick(); await tick();
  const [c1, c2] = A.calls;

  await check('the upstream never sees the client token; each call carries its own gateway token', () => {
    assert.ok(c1 && c2, 'both calls did not reach the upstream: ' + A.calls.length);
    assert.notStrictEqual(c1.token, 7);
    assert.notStrictEqual(c2.token, 7);
    assert.notStrictEqual(c1.token, c2.token);
  });

  A.beat(c1.token, 1);
  A.beat(c2.token, 2);
  A.beat(c1.token, 3);
  B.client.onNotification({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: c2.token, progress: 9 } }); // another upstream, a live token
  await check('each caller gets ONLY its own beats, with its own token restored', () => {
    assert.deepStrictEqual(got1.map((p) => [p.progressToken, p.progress]), [[7, 1], [7, 3]], JSON.stringify(got1));
    assert.deepStrictEqual(got2.map((p) => [p.progressToken, p.progress]), [[7, 2]], JSON.stringify(got2));
    assert.strictEqual(got1[0].total, 10, 'the rest of the params did not ride along');
  });
  await check('a beat from a DIFFERENT upstream carrying a live gateway token is not delivered anywhere', () => {
    assert.ok(!got2.some((p) => p.progress === 9));
    assert.ok(!leaked.some((l) => l.n.params && l.n.params.progress === 9), 'forwarded to the broadcast bridge');
  });

  c1.done(); c2.done();
  await p1; await p2;
  A.beat(c1.token, 4);
  await check('after the call settles, a beat with its gateway token is dropped (never forwarded)', () => {
    assert.ok(!got1.some((p) => p.progress === 4));
    assert.ok(!leaked.some((l) => l.n.method === 'notifications/progress'), 'a gateway-token beat reached the broadcast bridge: ' + JSON.stringify(leaked));
  });

  // Curated and raw routes scope too.
  const gotC = [];
  const rc = agg.resolveExposedExecution('ua_work', {}, { progressToken: 'c' }, (p) => gotC.push(p));
  const pc = rc.execute();
  await tick();
  const cc = A.calls[A.calls.length - 1];
  A.beat(cc.token, 5);
  cc.done(); await pc;
  const gotR = [];
  const rr = agg.resolveRawExecution('ua_work', {}, { progressToken: 'r' }, undefined, (p) => gotR.push(p));
  const pr = rr.execute();
  await tick(); await tick();
  const cr = A.calls[A.calls.length - 1];
  A.beat(cr.token, 6);
  cr.done(); await pr;
  await check('curated-direct and wrap (raw) calls are scoped the same way', () => {
    assert.notStrictEqual(cc.token, 'c');
    assert.deepStrictEqual(gotC.map((p) => [p.progressToken, p.progress]), [['c', 5]]);
    assert.notStrictEqual(cr.token, 'r');
    assert.deepStrictEqual(gotR.map((p) => [p.progressToken, p.progress]), [['r', 6]]);
  });

  // No sink: the token goes upstream unchanged (keep-alive semantics as before).
  const rn = agg.resolveLeanExecution('ua_work', {}, { meta: { progressToken: 'plain' } });
  const pn = rn.execute();
  await tick(); await tick();
  const cn = A.calls[A.calls.length - 1];
  cn.done(); await pn;
  await check('without a sink the client token is forwarded unchanged (lean now forwards _meta at all)', () => {
    assert.strictEqual(cn.token, 'plain');
  });

  await agg.closeAll();
  const EXPECTED = 6;
  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  if (passed === results.length && results.length === EXPECTED) {
    console.log(`\nPASS: progress-scoping test - ${passed}/${EXPECTED} assertions passed (per-caller tokens, own beats only, dropped after settle)`);
    process.exit(0);
  }
  console.log(`\nFAIL: progress-scoping test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
  process.exit(1);
})().catch((e) => { console.log('PROGRESS-SCOPING TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(2); });
