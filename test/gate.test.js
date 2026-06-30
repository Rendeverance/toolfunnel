'use strict';

/**
 * gate.test.js — proves the SAFETY CRUX of the gateway: the hook gate BLOCKS.
 *
 * The load-bearing invariant (src/mcp/gated-run.js, docs/hooks-and-gating.md):
 *
 *     A PreToolUse deny MUST prevent execute() from ever being called.
 *
 * This test exercises the real wiring end to end — loadManifest → HookEngine → gatedRun,
 * with a real child-process hook spawned by the runner — and asserts both directions:
 *
 *   BLOCK : a fixture manifest with an enabled, MATCHING deny hook ⇒ result.blocked===true,
 *           result.ok===false, and the execute() side effect (a sentinel temp file) is
 *           NEVER written.
 *   ALLOW : (a) the SHIPPED hooks/hooks.manifest.json (empty = allow-all) ⇒ execute() runs,
 *           result.ok===true, sentinel written, output returned.
 *           (b) a fixture manifest whose deny hook does NOT match the tool ⇒ same allow.
 *
 * It does this WITHOUT mutating the shipped hooks/hooks.manifest.json. The deny hook and
 * its manifest are FIXTURES under test/fixtures/. The shipped manifest is only ever READ,
 * proving it ships allow-all.
 *
 * Convention (matches the other tests in this dir): a standalone node script, exit 0 = pass,
 * non-zero = fail. Node built-ins only (node:assert, node:fs, node:os, node:path, node:crypto).
 *
 * Run:  node test/gate.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadManifest } = require('../src/core/hook-loader');
const { HookEngine } = require('../src/core/hook-engine');
const { gatedRun } = require('../src/mcp/gated-run');

const REPO_ROOT = path.resolve(__dirname, '..');

// Fixtures (NEVER the shipped manifest).
const DENY_MANIFEST = path.join(__dirname, 'fixtures', 'deny.manifest.json');
const ALLOW_MANIFEST = path.join(__dirname, 'fixtures', 'allow.manifest.json');

// The SHIPPED manifest — read-only here, to prove the default ships allow-all.
const SHIPPED_MANIFEST = path.join(REPO_ROOT, 'hooks', 'hooks.manifest.json');

// Common hook context for every gated run (the task's fixed shape; cwd = the repo root).
const CTX = { session_id: 't', transcript_path: '', cwd: REPO_ROOT };

// ── tiny harness: collect named assertions, report tap-ish lines, exit by outcome ────────
const results = [];
const sentinels = []; // temp files to clean up at the end

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}

/** A fresh, guaranteed-absent sentinel path under the OS temp dir. */
function freshSentinel(tag) {
  const p = path.join(os.tmpdir(), `toolfunnel-gate-${tag}-${process.pid}-${crypto.randomUUID()}.sentinel`);
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_e) {
    /* ignore */
  }
  sentinels.push(p);
  return p;
}

/** Build a thunk that records it ran by writing `sentinelPath`, and a probe for "did it run?". */
function makeExecute(sentinelPath) {
  let calls = 0;
  const execute = () => {
    calls += 1;
    fs.writeFileSync(sentinelPath, 'SIDE EFFECT — execute() ran\n', 'utf8');
    return { ok: true, ran: true, calls };
  };
  return {
    execute,
    ranCount: () => calls,
    wroteFile: () => fs.existsSync(sentinelPath),
  };
}

function engineFor(manifestPath) {
  // loadManifest expands ${HOOKS_DIR} to the manifest's own directory and applies any
  // hooks.state.json overlay (none exists for these fixtures, so manifest flags stand).
  const loader = loadManifest(manifestPath);
  return new HookEngine(loader, { cwd: REPO_ROOT });
}

(async () => {
  let fatal = null;
  try {
    // ── 1. BLOCK: matching enabled deny hook ⇒ blocked, and execute() NEVER runs. ──────────
    {
      const sentinel = freshSentinel('block');
      const spy = makeExecute(sentinel);
      const engine = engineFor(DENY_MANIFEST);

      // Pre-condition: the side effect must not already exist.
      assert.strictEqual(spy.wroteFile(), false, 'pre-condition: block sentinel should not pre-exist');

      const res = await gatedRun({
        engine,
        ctx: CTX,
        toolName: 'danger',
        args: {},
        execute: spy.execute,
      });

      check('BLOCK: result.blocked === true', () => {
        assert.strictEqual(res.blocked, true, 'expected blocked:true, got ' + JSON.stringify(res));
      });
      check('BLOCK: result.ok === false', () => {
        assert.strictEqual(res.ok, false, 'expected ok:false, got ' + JSON.stringify(res));
      });
      check('BLOCK: result.output === null', () => {
        assert.strictEqual(res.output, null, 'expected output:null, got ' + JSON.stringify(res.output));
      });
      check('BLOCK: deny reason propagated ("blocked by test")', () => {
        assert.strictEqual(res.reason, 'blocked by test', 'reason was ' + JSON.stringify(res.reason));
      });
      check('BLOCK: execute() was NEVER called', () => {
        assert.strictEqual(spy.ranCount(), 0, 'execute() was called ' + spy.ranCount() + ' time(s)');
      });
      check('BLOCK: the sentinel side-effect file was NOT written', () => {
        assert.strictEqual(spy.wroteFile(), false, 'sentinel file exists — the gate FAILED OPEN');
      });
    }

    // ── 2. ALLOW (a): the SHIPPED empty manifest is allow-all ⇒ execute() runs. ─────────────
    {
      // Guard: confirm we are reading the genuine shipped, UNMUTATED allow-all manifest.
      const shipped = JSON.parse(fs.readFileSync(SHIPPED_MANIFEST, 'utf8'));
      check('ALLOW(shipped): hooks/hooks.manifest.json ships NO ENABLED hooks (allow-all preserved)', () => {
        assert.strictEqual(shipped.version, 1, 'shipped manifest version changed');
        assert.ok(Array.isArray(shipped.hooks),
          'shipped manifest hooks must be an array — got ' + JSON.stringify(shipped.hooks));
        // The allow-all invariant is NOT "no hooks" but "no ENABLED hooks": the engine fires only
        // specs with enabled===true (src/core/hook-loader.enabledHooksFor). The shipped manifest may
        // carry DISABLED example hooks (so they surface in the UI Hooks tab for one-click enabling)
        // without changing the default — a fresh install still ships allow-all.
        const enabled = shipped.hooks.filter((h) => h && h.enabled === true);
        assert.strictEqual(enabled.length, 0,
          'shipped manifest has ENABLED hooks (would break the default allow-all) — got ' + JSON.stringify(enabled));
      });

      const sentinel = freshSentinel('allow-shipped');
      const spy = makeExecute(sentinel);
      const engine = engineFor(SHIPPED_MANIFEST);

      const res = await gatedRun({
        engine,
        ctx: CTX,
        toolName: 'danger',
        args: { confirm: true },
        execute: spy.execute,
      });

      check('ALLOW(shipped): result.ok === true', () => {
        assert.strictEqual(res.ok, true, 'expected ok:true, got ' + JSON.stringify(res));
      });
      check('ALLOW(shipped): result.blocked === false', () => {
        assert.strictEqual(res.blocked, false, 'expected blocked:false, got ' + JSON.stringify(res));
      });
      check('ALLOW(shipped): execute() ran exactly once', () => {
        assert.strictEqual(spy.ranCount(), 1, 'execute() ran ' + spy.ranCount() + ' time(s)');
      });
      check('ALLOW(shipped): the sentinel side-effect file WAS written', () => {
        assert.strictEqual(spy.wroteFile(), true, 'sentinel file missing — execute() did not run');
      });
      check('ALLOW(shipped): execute() output is returned', () => {
        assert.deepStrictEqual(res.output, { ok: true, ran: true, calls: 1 },
          'output was ' + JSON.stringify(res.output));
      });
    }

    // ── 3. ALLOW (b): a non-matching enabled deny hook ⇒ allow (matcher excludes the tool). ─
    {
      const sentinel = freshSentinel('allow-nomatch');
      const spy = makeExecute(sentinel);
      const engine = engineFor(ALLOW_MANIFEST);

      const res = await gatedRun({
        engine,
        ctx: CTX,
        toolName: 'danger', // the fixture deny hook matches "some-other-tool", NOT this
        args: {},
        execute: spy.execute,
      });

      check('ALLOW(non-matching): result.ok === true', () => {
        assert.strictEqual(res.ok, true, 'expected ok:true, got ' + JSON.stringify(res));
      });
      check('ALLOW(non-matching): result.blocked === false', () => {
        assert.strictEqual(res.blocked, false, 'expected blocked:false, got ' + JSON.stringify(res));
      });
      check('ALLOW(non-matching): execute() ran and wrote the sentinel', () => {
        assert.strictEqual(spy.ranCount(), 1, 'execute() ran ' + spy.ranCount() + ' time(s)');
        assert.strictEqual(spy.wroteFile(), true, 'sentinel file missing — execute() did not run');
      });
    }
  } catch (err) {
    fatal = err;
  } finally {
    // Clean up any sentinel files we created.
    for (const p of sentinels) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (_e) {
        /* best-effort */
      }
    }
  }

  // ── Report ───────────────────────────────────────────────────────────────────────────
  for (const r of results) {
    console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  }
  if (fatal) {
    console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const ok = !fatal && failed === 0 && results.length > 0;

  if (ok) {
    console.log(`\nPASS: gate test — ${passed}/${results.length} assertions passed ` +
      `(PreToolUse deny blocks execute(); empty/non-matching manifest allows; shipped manifest untouched)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: gate test — ${passed}/${results.length} assertions passed, ${failed} failed`);
    process.exit(1);
  }
})().catch((e) => {
  console.log('GATE TEST CRASHED: ' + ((e && e.stack) || e));
  process.exit(1);
});
