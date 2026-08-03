'use strict';

/**
 * disabled-upstream-surface.test.js - proves the upstream off switch covers EVERY surface,
 * not just the lean list. A switched-off upstream whose client is still cached (the operator
 * clicked Discover on it - a documented allowance) must stay unreachable end to end:
 *
 *   A - DISCOVER:  discover() on the switched-off upstream still works (the operator
 *                  allowance - "what does this have, before I enable it?" - must not regress),
 *                  and the lean list still hides its tools (pins the behaviour that was
 *                  already correct).
 *   B - LEAN RUN:  resolveLeanExecution / resolveRawExecution both return null for the
 *                  switched-off upstream's tool - hidden means not runnable, on both the
 *                  unwrapping and passthrough routes.
 *   C - EXPOSE:    an enabled expose[] row pointing at the switched-off upstream does not
 *                  put the tool back on the top-level list, and isExposed /
 *                  resolveExposedExecution refuse it - the row's own flag cannot override
 *                  the upstream's.
 *   D - CONTROL:   an identical upstream that is enabled resolves and executes everywhere -
 *                  the new checks refuse `enabled === false`, not connected upstreams in
 *                  general.
 *
 * Runs in-process against the real Aggregator + ExposeStore in its own temp config home
 * (the bundled mock server is COPIED in - the isolation guard requires upstream scripts
 * inside the gateway root). The checkout's own config is never touched. Node built-ins only.
 *
 * Run:  node test/disabled-upstream-surface.test.js     (exit 0 = pass, non-zero = fail)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const { Aggregator } = require(path.join(REPO_ROOT, 'src', 'mcp', 'aggregator.js'));
const { loadExposeStore } = require(path.join(REPO_ROOT, 'src', 'mcp', 'expose-store.js'));
const MOCK_SERVER = path.join(REPO_ROOT, 'mcp', 'servers', 'mock-upstream', 'server.js');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-disabled-surface-'));
  const serverDir = path.join(home, 'mcp', 'servers', 'mock');
  fs.mkdirSync(serverDir, { recursive: true });
  const localMock = path.join(serverDir, 'server.js');
  fs.copyFileSync(MOCK_SERVER, localMock);

  // Two identical upstreams - one switched off, one on - and an enabled expose row for
  // EACH, so every refusal check has a live control proving the predicate is the upstream's
  // own flag and nothing wider.
  const exposePath = path.join(home, 'mcp', 'expose.json');
  fs.writeFileSync(exposePath, JSON.stringify({
    version: 1,
    upstreams: [
      { id: 'offserver', transport: 'stdio', command: process.execPath, args: [localMock], enabled: false },
      { id: 'onserver', transport: 'stdio', command: process.execPath, args: [localMock], enabled: true },
    ],
    expose: [
      { upstream: 'offserver', tool: 'ping', as: 'offserver_ping', category: 'test', enabled: true },
      { upstream: 'onserver', tool: 'ping', as: 'onserver_ping', category: 'test', enabled: true },
    ],
  }, null, 2) + '\n');

  const store = loadExposeStore(exposePath);
  const agg = new Aggregator({ store, gatewayRoot: home });
  let fatal = null;

  try {
    // Connect + cache BOTH upstreams' tools. Discover is the documented allowance for a
    // switched-off upstream, and it is exactly what leaves a live cached client behind.
    const offTools = await agg.discover('offserver');
    const onTools = await agg.discover('onserver');

    // ── A: the operator allowance + the already-correct list behaviour ──────────────────
    check('A1: discover on the switched-off upstream still returns its tools', () => {
      assert.ok(Array.isArray(offTools) && offTools.length > 0, 'got ' + JSON.stringify(offTools));
    });
    check('A2: the lean list hides the switched-off upstream\'s tools', () => {
      const names = agg.leanToolDefinitions().map((d) => d.name);
      assert.ok(!names.some((n) => n.startsWith('offserver')), 'lean list = ' + JSON.stringify(names));
    });

    // ── B: the lean run path - both routes ──────────────────────────────────────────────
    check('B1: resolveLeanExecution refuses the switched-off upstream\'s tool', () => {
      assert.strictEqual(agg.resolveLeanExecution('offserver_ping', {}), null);
    });
    check('B2: resolveRawExecution refuses the switched-off upstream\'s tool', () => {
      assert.strictEqual(agg.resolveRawExecution('offserver_ping', {}, null, {}), null);
    });

    // ── C: the expose surface - list, membership, resolver ──────────────────────────────
    check('C1: the top-level list omits the switched-off upstream\'s exposed tool', () => {
      const names = agg.exposedToolDefinitions().map((d) => d.name);
      assert.ok(!names.includes('offserver_ping'), 'exposed list = ' + JSON.stringify(names));
    });
    check('C2: isExposed refuses the switched-off upstream\'s exposed name', () => {
      assert.strictEqual(agg.isExposed('offserver_ping'), false);
    });
    check('C3: resolveExposedExecution refuses the switched-off upstream\'s exposed name', () => {
      assert.strictEqual(agg.resolveExposedExecution('offserver_ping', {}), null);
    });

    // ── D: the enabled control - identical shape, everything works ──────────────────────
    check('D1: the enabled upstream\'s tools are on the lean list', () => {
      assert.ok(Array.isArray(onTools) && onTools.length > 0, 'got ' + JSON.stringify(onTools));
      const names = agg.leanToolDefinitions().map((d) => d.name);
      assert.ok(names.includes('onserver_ping'), 'lean list = ' + JSON.stringify(names));
    });
    await checkAsync('D2: the enabled upstream resolves AND executes on the lean run path', async () => {
      const hit = agg.resolveLeanExecution('onserver_ping', {});
      assert.ok(hit, 'resolveLeanExecution returned null for the enabled upstream');
      const out = await hit.execute();
      assert.strictEqual(out, 'pong', 'execute returned ' + JSON.stringify(out));
    });
    check('D3: the enabled upstream is exposed top-level and resolvable there too', () => {
      const names = agg.exposedToolDefinitions().map((d) => d.name);
      assert.ok(names.includes('onserver_ping'), 'exposed list = ' + JSON.stringify(names));
      assert.strictEqual(agg.isExposed('onserver_ping'), true);
      assert.ok(agg.resolveExposedExecution('onserver_ping', {}), 'resolveExposedExecution returned null');
    });
  } catch (err) {
    fatal = err;
  } finally {
    try { await agg.closeAll(); } catch (_e) { /* ignore */ }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }

  // ── Report ────────────────────────────────────────────────────────────────────────────
  for (const r of results) {
    console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  }
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));

  const passed = results.filter((r) => r.ok).length;
  const expected = 10;
  const ok = !fatal && passed === results.length && results.length === expected;
  if (ok) {
    console.log(`\nPASS: disabled-upstream-surface test - ${passed}/${expected} assertions passed (off switch covers list + lean run + raw run + expose surface; enabled control unaffected)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: disabled-upstream-surface test - ${passed}/${results.length} assertions passed`);
    process.exit(1);
  }
})().catch((e) => { console.log('DISABLED-UPSTREAM-SURFACE TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
