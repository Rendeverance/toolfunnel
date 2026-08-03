'use strict';

/**
 * reconnect-era-memo.test.js - pins the ERA MEMO: a death-driven reconnect reuses the era the
 * upstream negotiated last time instead of re-running the full negotiation (KNOWN_BUGS: "worst
 * case ~3s extra" per respawn against a legacy upstream that silently drops server/discover).
 *
 * The wire is the only honest witness: the mock upstream journals every incoming method
 * (TF_MOCK_METHOD_LOG), so each phase asserts WHICH negotiation a fresh connection actually ran -
 * `server/discover` first (full probe) vs `initialize` first (memoised legacy).
 *
 * Phases (real Aggregator + real McpClient + real spawned mock upstream, in-process):
 *   P1 - FIRST connect runs the FULL negotiation (discover probe, then initialize). No memo yet.
 *   P2 - a crash + background reconnect goes STRAIGHT to initialize - no re-probe. THE fix.
 *   P3 - an explicit Aggregator.reconnect() re-runs the full negotiation (a manual kick clears
 *        the memo - the operator may have just upgraded the server).
 *   P4 - SELF-HEAL: while the upstream refuses initialize (TF_MOCK_INIT_REFUSE_FILE - the shape
 *        of a server upgraded across a restart), the first retry is still hinted (initialize,
 *        fails), the FAILURE clears the memo, and the next retry re-probes. Removing the refusal
 *        recovers the upstream fully.
 *   P5 - modernOnly BEATS the hint: eraHint:'legacy' + modernOnly:true still probes (and still
 *        refuses the legacy fallback) - a stale observation can never undo the probe policy.
 *   P6 - a probe TIMEOUT is NOT memoised: a dual-era upstream whose discover was slow ONCE boots
 *        legacy (the fallback), but the death-driven reconnect RE-PROBES and climbs back to
 *        modern - silence observed nothing, so there is nothing to remember.
 *   P7 - the memo only records a FULLY successful connect: a handshake that then fails tools/list
 *        is a failed connect, and the next attempt re-runs the full negotiation.
 *
 * NON-DESTRUCTIVE: touches no config; writes only its own journal/flag files under logs/.
 * Node built-ins only. Run:  node test/reconnect-era-memo.test.js   (exit 0 = pass)
 */

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const MOCK_SERVER = path.join(REPO_ROOT, 'mcp', 'servers', 'mock-upstream', 'server.js');
const DUAL_SERVER = path.join(REPO_ROOT, 'test', 'fixtures', 'servers', 'dual-era-upstream.js');
const JOURNAL = path.join(REPO_ROOT, 'logs', 'test-era-memo.' + process.pid + '.log');
const JOURNAL2 = path.join(REPO_ROOT, 'logs', 'test-era-memo-p5.' + process.pid + '.log');
const JOURNAL3 = path.join(REPO_ROOT, 'logs', 'test-era-memo-p6.' + process.pid + '.log');
const JOURNAL4 = path.join(REPO_ROOT, 'logs', 'test-era-memo-p7.' + process.pid + '.log');
const REFUSE_FLAG = path.join(REPO_ROOT, 'logs', 'test-era-refuse.' + process.pid + '.flag');
const SLOW_FLAG = path.join(REPO_ROOT, 'logs', 'test-era-slow.' + process.pid + '.flag');
const LISTFAIL_FLAG = path.join(REPO_ROOT, 'logs', 'test-era-listfail.' + process.pid + '.flag');

const { Aggregator } = require(path.join(REPO_ROOT, 'src', 'mcp', 'aggregator.js'));
const { McpClient } = require(path.join(REPO_ROOT, 'src', 'mcp', 'mcp-client.js'));

const RECOVER_BUDGET_MS = 20000; // backoff is 1s,2s,4s...; generous so a loaded CI box cannot flake it

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The journal as an array of method names (arrival order). */
function methods() {
  try { return fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean); }
  catch (_e) { return []; }
}
/** Assert helper: within `slice`, discover strictly precedes initialize (a FULL negotiation). */
function assertFullNegotiation(slice, label) {
  const d = slice.indexOf('server/discover');
  const i = slice.indexOf('initialize');
  assert.ok(d !== -1, label + ': no server/discover probe in ' + JSON.stringify(slice));
  assert.ok(i !== -1, label + ': no initialize in ' + JSON.stringify(slice));
  assert.ok(d < i, label + ': probe did not precede initialize in ' + JSON.stringify(slice));
}

function makeStore(upstreams) {
  return {
    listUpstreams: () => upstreams.map((u) => ({ ...u })),
    getUpstream: (id) => { const u = upstreams.find((x) => x.id === id); return u ? { ...u } : undefined; },
    listExposed: () => [],
    exposedName: (e) => `${e.upstream}_${e.tool}`,
  };
}

/** Poll until the upstream reports CONNECTED via the run-path contract (allowConnect:false never
 *  triggers a connect itself - recovery must come from the BACKGROUND reconnect, which is the
 *  path under test). Returns the live client, or null on deadline. */
async function waitRecovered(agg, id, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try { return await agg.ensureConnected(id, { allowConnect: false }); }
    catch (_e) { await sleep(250); }
  }
  return null;
}

(async () => {
  fs.mkdirSync(path.join(REPO_ROOT, 'logs'), { recursive: true });
  for (const p of [JOURNAL, JOURNAL2, JOURNAL3, JOURNAL4, REFUSE_FLAG, SLOW_FLAG, LISTFAIL_FLAG]) {
    try { fs.unlinkSync(p); } catch (_e) { /* absent */ }
  }

  const store = makeStore([{
    id: 'mock', command: process.execPath, args: [MOCK_SERVER],
    env: { TF_MOCK_METHOD_LOG: JOURNAL, TF_MOCK_INIT_REFUSE_FILE: REFUSE_FLAG },
    enabled: true,
  }]);
  const agg = new Aggregator({ store, gatewayRoot: REPO_ROOT });
  let agg6 = null;
  let agg7 = null;
  let fatal = null;

  try {
    // ── P1: first connect = FULL negotiation ────────────────────────────────────────────────────
    const boot = await agg.connectAll();
    check('P1: mock connects at boot', () => {
      assert.deepStrictEqual(boot.connected, ['mock'], 'connect failed: ' + JSON.stringify(boot.failed));
    });
    const p1 = methods();
    check('P1: the FIRST connect ran the full negotiation (discover probe, then initialize)', () => {
      assertFullNegotiation(p1, 'first connect');
    });

    // ── P2: death-driven reconnect = memoised legacy, NO re-probe (THE fix) ─────────────────────
    let mark = p1.length;
    const c1 = await agg.ensureConnected('mock');
    await c1.callTool('crash', {}).catch(() => null); // the mock exits without replying
    const c2 = await waitRecovered(agg, 'mock', RECOVER_BUDGET_MS);
    check('P2: the upstream recovers via the background reconnect', () => {
      assert.ok(c2, 'never recovered within ' + RECOVER_BUDGET_MS + 'ms of the crash');
    });
    const p2 = methods().slice(mark);
    check('P2: the reconnect ran the legacy handshake', () => {
      assert.ok(p2.includes('initialize'), 'no initialize after the crash: ' + JSON.stringify(p2));
    });
    check('P2: ...WITHOUT re-running the server/discover probe (the era memo)', () => {
      assert.ok(!p2.includes('server/discover'),
        'the reconnect re-probed - era memo not used: ' + JSON.stringify(p2));
    });
    const pong = c2 ? await c2.callTool('ping', {}) : null;
    check('P2: the memoised reconnect is fully functional (ping -> pong)', () => {
      const text = pong && pong.content && pong.content[0] && pong.content[0].text;
      assert.strictEqual(text, 'pong', 'expected pong, got ' + JSON.stringify(pong));
    });

    // ── P3: an EXPLICIT reconnect() re-negotiates (manual kick clears the memo) ─────────────────
    mark = methods().length;
    await agg.reconnect('mock');
    check('P3: an explicit reconnect() re-runs the FULL negotiation (memo deliberately dropped)', () => {
      assertFullNegotiation(methods().slice(mark), 'manual reconnect');
    });

    // ── P4: self-heal - a FAILED hinted connect clears the memo ─────────────────────────────────
    fs.writeFileSync(REFUSE_FLAG, 'refuse\n'); // the upstream now refuses initialize on respawn
    mark = methods().length;
    const c3 = await agg.ensureConnected('mock');
    await c3.callTool('crash', {}).catch(() => null);
    // Watch the background retries on the wire: attempt 1 is HINTED (initialize, refused); the
    // failure clears the memo, so a LATER attempt probes again. allowConnect:false polling only -
    // the test must never trigger a connect itself here.
    const deadline = Date.now() + RECOVER_BUDGET_MS;
    let p4 = [];
    while (Date.now() < deadline) {
      p4 = methods().slice(mark);
      if (p4.includes('server/discover')) break;
      await sleep(250);
    }
    check('P4: the first retry was HINTED - initialize with no probe before it', () => {
      const i = p4.indexOf('initialize');
      const d = p4.indexOf('server/discover');
      assert.ok(i !== -1, 'no initialize attempt after the crash: ' + JSON.stringify(p4));
      assert.ok(d === -1 || i < d, 'the first retry re-probed - memo not used: ' + JSON.stringify(p4));
    });
    check('P4: the FAILED hinted connect cleared the memo - a later retry re-probed', () => {
      assert.ok(p4.includes('server/discover'),
        'no re-probe after the hinted failure - memo never cleared: ' + JSON.stringify(p4));
    });
    fs.unlinkSync(REFUSE_FLAG); // the upstream accepts initialize again
    const c4 = await waitRecovered(agg, 'mock', RECOVER_BUDGET_MS);
    const pong4 = c4 ? await c4.callTool('ping', {}) : null;
    check('P4: the upstream fully recovers once initialize is accepted again', () => {
      const text = pong4 && pong4.content && pong4.content[0] && pong4.content[0].text;
      assert.strictEqual(text, 'pong', 'no recovery after removing the refusal: ' + JSON.stringify(pong4));
    });

    // ── P5: modernOnly BEATS the hint ───────────────────────────────────────────────────────────
    const pinned = new McpClient({
      id: 'p5', command: process.execPath, args: [MOCK_SERVER],
      env: { TF_MOCK_METHOD_LOG: JOURNAL2 },
      modernOnly: true, eraHint: 'legacy',
    });
    let p5err = null;
    try { await pinned.connect(); } catch (e) { p5err = e; } finally { try { pinned.close(); } catch (_e) { /* ignore */ } }
    check('P5: modernOnly still refuses the legacy upstream (the hint cannot undo the policy)', () => {
      assert.ok(p5err, 'connect unexpectedly succeeded');
      assert.match(p5err.message, /modernOnly/, 'unexpected error: ' + p5err.message);
    });
    check('P5: ...and the probe RAN despite eraHint:legacy', () => {
      let j2 = [];
      try { j2 = fs.readFileSync(JOURNAL2, 'utf8').split('\n').filter(Boolean); } catch (_e) { /* empty */ }
      assert.ok(j2.includes('server/discover'), 'no probe on the wire: ' + JSON.stringify(j2));
    });

    // ── P6: a probe TIMEOUT is NOT memoised - the dual-era upstream climbs back ─────────────────
    // A dual-era fixture whose discover is SLOW at boot (past the 3s probe clamp) connects via the
    // legacy fallback - correct. But silence observed NOTHING about the upstream's eras, so once
    // the blip is over, a death-driven reconnect must re-run the probe and find modern.
    const j3 = () => {
      try { return fs.readFileSync(JOURNAL3, 'utf8').split('\n').filter(Boolean); }
      catch (_e) { return []; }
    };
    fs.writeFileSync(SLOW_FLAG, 'slow\n');
    const store6 = makeStore([{
      id: 'dual', command: process.execPath, args: [DUAL_SERVER],
      env: { TF_DUAL_METHOD_LOG: JOURNAL3, TF_DUAL_SLOW_FILE: SLOW_FLAG },
      enabled: true,
    }]);
    agg6 = new Aggregator({ store: store6, gatewayRoot: REPO_ROOT });
    const boot6 = await agg6.connectAll();
    check('P6: a dual-era upstream whose discover is SLOW still connects at boot', () => {
      assert.deepStrictEqual(boot6.connected, ['dual'], 'connect failed: ' + JSON.stringify(boot6.failed));
    });
    const d1 = await agg6.ensureConnected('dual');
    check('P6: ...via the LEGACY fallback (the probe timed out)', () => {
      assert.strictEqual(d1.era, 'legacy', 'expected the timeout fallback, got era ' + d1.era);
    });
    fs.unlinkSync(SLOW_FLAG); // the blip is over - discover answers instantly from here on
    const mark6 = j3().length;
    await d1.callTool('crash', {}).catch(() => null);
    const d2 = await waitRecovered(agg6, 'dual', RECOVER_BUDGET_MS);
    check('P6: the upstream recovers via the background reconnect', () => {
      assert.ok(d2, 'never recovered within ' + RECOVER_BUDGET_MS + 'ms of the crash');
    });
    const p6 = j3().slice(mark6);
    check('P6: the reconnect RE-PROBED - a timeout observation is never memoised', () => {
      assert.ok(p6.includes('server/discover'),
        'the reconnect was hinted - the timeout fallback was memoised: ' + JSON.stringify(p6));
    });
    check('P6: ...and the dual-era upstream climbed back to MODERN', () => {
      assert.ok(d2, 'no client recovered');
      assert.strictEqual(d2.era, 'modern', 'still pinned to ' + (d2 && d2.era));
    });

    // ── P7: the memo only records a FULLY successful connect ────────────────────────────────────
    // Handshake OK + tools/list erroring = a FAILED connect to every caller. The era observation
    // (here a DEFINITIVE legacy - the mock answers discover with -32601) must not survive it: the
    // next attempt re-runs the full negotiation.
    const j4 = () => {
      try { return fs.readFileSync(JOURNAL4, 'utf8').split('\n').filter(Boolean); }
      catch (_e) { return []; }
    };
    fs.writeFileSync(LISTFAIL_FLAG, 'fail\n');
    const store7 = makeStore([{
      id: 'm7', command: process.execPath, args: [MOCK_SERVER],
      env: { TF_MOCK_METHOD_LOG: JOURNAL4, TF_MOCK_LIST_FAIL_FILE: LISTFAIL_FLAG },
      enabled: true,
    }]);
    agg7 = new Aggregator({ store: store7, gatewayRoot: REPO_ROOT });
    const boot7 = await agg7.connectAll();
    check('P7: a handshake that succeeds but cannot LIST reports a FAILED connect', () => {
      assert.ok(!boot7.connected.includes('m7'),
        'connect unexpectedly succeeded: ' + JSON.stringify(boot7));
    });
    fs.unlinkSync(LISTFAIL_FLAG); // tools/list works again
    const mark7 = j4().length;
    const m7 = await agg7.ensureConnected('m7');
    check('P7: the FAILED connect cleared the memo - the next attempt re-ran the FULL negotiation', () => {
      assertFullNegotiation(j4().slice(mark7), 'post-list-failure retry');
    });
    const pong7 = m7 ? await m7.callTool('ping', {}) : null;
    check('P7: ...and that attempt fully connects once tools/list works again', () => {
      const text = pong7 && pong7.content && pong7.content[0] && pong7.content[0].text;
      assert.strictEqual(text, 'pong', 'expected pong, got ' + JSON.stringify(pong7));
    });
  } catch (err) {
    fatal = err;
  } finally {
    try { await agg.closeAll(); } catch (_e) { /* ignore */ }
    if (agg6) { try { await agg6.closeAll(); } catch (_e) { /* ignore */ } }
    if (agg7) { try { await agg7.closeAll(); } catch (_e) { /* ignore */ } }
    for (const p of [JOURNAL, JOURNAL2, JOURNAL3, JOURNAL4, REFUSE_FLAG, SLOW_FLAG, LISTFAIL_FLAG]) {
      try { fs.unlinkSync(p); } catch (_e) { /* absent */ }
    }
  }

  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));

  const passed = results.filter((r) => r.ok).length;
  const expected = 20;
  const ok = !fatal && passed === results.length && results.length === expected;
  if (ok) {
    console.log(`\nPASS: era-memo test - ${passed}/${expected} assertions (reconnect reuses the negotiated era; manual kick + failure re-negotiate; modernOnly wins; timeouts and failed connects are never memoised)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: era-memo test - ${passed}/${results.length} assertions passed`);
    process.exit(1);
  }
})().catch((e) => { console.log('ERA-MEMO TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
