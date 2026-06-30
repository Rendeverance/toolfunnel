'use strict';

/**
 * reference-gate.test.js — proves the REFERENCE-mode HANDOFF GATE.
 *
 * A reference tool executes NOTHING server-side: toolfunnel_run_tool hands back the tool's
 * instructions so the connected AI performs the action in ITS OWN environment. Prior to this
 * wave the reference branch short-circuited BEFORE the gate fired. It now fires PreToolUse
 * ADVISORILY — a deny gates the instructions HANDOFF, not the AI's own-environment execution:
 *
 *   DENY  : a fixture manifest with an enabled, MATCHING deny hook ⇒ run_tool returns
 *           { ok:false, blocked:true, mode:"reference", reason }, hands over NO instructions,
 *           and (reference never executes anyway) NEVER spawns the invoke.
 *   ALLOW : (a) the SHIPPED hooks/hooks.manifest.json (empty = allow-all) ⇒ the instructions are
 *               returned exactly as before ({ ok:true, mode:"reference", instructions, message }),
 *               still NO spawn.
 *           (b) a fixture manifest whose deny hook does NOT match the tool ⇒ same allow.
 *
 * Mirrors gate.test.js (fixture deny hook + shipped read-only allow-all) and mode.test.js
 * (register snapshot/restore of a sacrificial reference tool). The shipped manifest is only
 * ever READ; the deny hook + its manifest are FIXTURES under test/fixtures/. The register is
 * SNAPSHOTTED up front and RESTORED byte-for-byte in a finally; the sacrificial spy script +
 * any marker it could write are deleted too — a failure mid-flight still leaves the real config
 * exactly as found.
 *
 * Convention (matches the sibling tests): a standalone node script, exit 0 = pass, non-zero =
 * fail. Node built-ins only (node:assert, node:fs, node:path).
 *
 * Run:  node test/reference-gate.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { makeProtocol } = require(path.join(__dirname, '..', 'src', 'mcp', 'protocol.js'));
const { makeRegistryAdapter } = require(path.join(__dirname, '..', 'src', 'mcp', 'server.js'));
const { gatedRun } = require(path.join(__dirname, '..', 'src', 'mcp', 'gated-run.js'));
const { loadRegistry } = require(path.join(__dirname, '..', 'src', 'tools', 'registry.js'));
const { loadManifest } = require(path.join(__dirname, '..', 'src', 'core', 'hook-loader.js'));
const { HookEngine } = require(path.join(__dirname, '..', 'src', 'core', 'hook-engine.js'));
const { howto } = require(path.join(__dirname, '..', 'src', 'extend', 'howto.js'));

const ROOT = path.resolve(__dirname, '..');
const REGISTER = path.join(ROOT, 'tools', 'tools.register.json');
const SCRIPTS_DIR = path.join(ROOT, 'tools', 'scripts');
const SPY_SCRIPT = path.join(SCRIPTS_DIR, '__tf_test_ref_gate_spy.js');
const SPY_MARKER = path.join(SCRIPTS_DIR, '__tf_test_ref_gate_spy.marker');

// Fixtures (NEVER the shipped manifest).
const DENY_MANIFEST = path.join(__dirname, 'fixtures', 'reference-deny.manifest.json');
const ALLOW_NOMATCH_MANIFEST = path.join(__dirname, 'fixtures', 'allow.manifest.json');
// The SHIPPED manifest — read-only here, to prove the default ships allow-all.
const SHIPPED_MANIFEST = path.join(ROOT, 'hooks', 'hooks.manifest.json');

const REF_ID = '__tf_test_ref_gate';
const REF_INSTRUCTIONS = 'REFERENCE INSTRUCTIONS — do the thing in your own environment';
const REF_MESSAGE = 'reference tool — perform this in your own environment per the instructions';
const DENY_REASON = 'blocked by test'; // what fixtures/scripts/deny-hook.js returns

// A spy script: if it is EVER spawned it leaves a marker file beside itself. Its presence after
// a run is unambiguous proof the invoke was executed — a reference tool must never reach it.
const SPY_BODY = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "fs.writeFileSync(path.join(__dirname, '__tf_test_ref_gate_spy.marker'), 'spawned\\n');",
  "process.stdout.write(JSON.stringify({ ok: true, spawned: true }) + '\\n');",
  'process.exit(0);',
  '',
].join('\n');

// ── tiny harness (matches gate.test.js / mode.test.js) ────────────────────────────────
const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}

// ── snapshot / restore (register bytes + spy script + marker) ─────────────────────────
function snapshotRegister() {
  return fs.readFileSync(REGISTER, 'utf8');
}
function restoreRegister(bytes) {
  // Write the exact original bytes back (preserves LF; no re-serialisation).
  fs.writeFileSync(REGISTER, bytes);
}
function cleanupSpy() {
  for (const f of [SPY_SCRIPT, SPY_MARKER]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (_e) {
      /* best-effort */
    }
  }
}

// Add the sacrificial reference tool to the register on disk (a fresh build reads it). Its invoke
// points at the spy on purpose — a reference tool must NOT spawn it, gated or not.
function addReferenceTool() {
  const data = JSON.parse(fs.readFileSync(REGISTER, 'utf8'));
  data.tools.push({
    id: REF_ID,
    name: REF_ID,
    summary: 'sacrificial reference-mode tool for the handoff-gate test',
    category: 'testing',
    instructions: REF_INSTRUCTIONS,
    mode: 'reference',
    invoke: { type: 'script', path: 'scripts/__tf_test_ref_gate_spy.js' },
  });
  fs.writeFileSync(REGISTER, JSON.stringify(data, null, 2) + '\n');
}

// Build the real protocol wiring but over a CHOSEN hook manifest (fixture or shipped), exactly
// as server.buildProtocol() does — registry adapter + gatedRun + HookEngine + ctx → makeProtocol.
function protocolOver(manifestPath) {
  const registry = loadRegistry(REGISTER, { scriptsRoot: SCRIPTS_DIR });
  const loader = loadManifest(manifestPath);
  const engine = new HookEngine(loader, { cwd: ROOT });
  const ctx = { session_id: 'reference-gate-test', transcript_path: '', cwd: ROOT };
  const adapter = makeRegistryAdapter(registry, {});
  return makeProtocol({ registry: adapter, gatedRun, engine, ctx, howto });
}

async function runRef(manifestPath, args) {
  const protocol = protocolOver(manifestPath);
  return protocol.dispatch('toolfunnel_run_tool', { name: REF_ID, args: args || {} });
}

(async () => {
  let fatal = null;
  const registerSnapshot = snapshotRegister();
  cleanupSpy(); // start from a known-clean state (no stale marker/spy)

  try {
    // Author the spy + register the sacrificial reference tool.
    fs.writeFileSync(SPY_SCRIPT, SPY_BODY);
    addReferenceTool();

    // ── 1. DENY: matching enabled deny hook ⇒ blocked, NO instructions, NO spawn. ──────────
    {
      cleanupSpyMarker();
      const res = await runRef(DENY_MANIFEST, { anything: 1 });

      check('DENY: result.ok === false', () => {
        assert.strictEqual(res && res.ok, false, 'expected ok:false, got ' + JSON.stringify(res));
      });
      check('DENY: result.blocked === true', () => {
        assert.strictEqual(res && res.blocked, true, 'expected blocked:true, got ' + JSON.stringify(res));
      });
      check('DENY: result.mode === "reference"', () => {
        assert.strictEqual(res && res.mode, 'reference', 'result = ' + JSON.stringify(res));
      });
      check('DENY: deny reason propagated ("blocked by test")', () => {
        assert.strictEqual(res && res.reason, DENY_REASON, 'reason was ' + JSON.stringify(res && res.reason));
      });
      check('DENY: NO instructions handed over (the handoff was gated)', () => {
        assert.ok(!(res && 'instructions' in res), 'blocked reference result leaked instructions: ' + JSON.stringify(res));
      });
      check('DENY: the invoke was NEVER spawned (spy marker absent)', () => {
        assert.ok(!fs.existsSync(SPY_MARKER), 'spy marker exists — a blocked reference tool spawned its invoke');
      });
    }

    // ── 2. ALLOW (a): the SHIPPED empty manifest is allow-all ⇒ instructions returned, no spawn. ─
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

      cleanupSpyMarker();
      const res = await runRef(SHIPPED_MANIFEST, { anything: 1 });

      check('ALLOW(shipped): result.ok === true', () => {
        assert.strictEqual(res && res.ok, true, 'expected ok:true, got ' + JSON.stringify(res));
      });
      check('ALLOW(shipped): result.mode === "reference"', () => {
        assert.strictEqual(res && res.mode, 'reference', 'result = ' + JSON.stringify(res));
      });
      check('ALLOW(shipped): instructions returned exactly as before', () => {
        assert.strictEqual(res && res.instructions, REF_INSTRUCTIONS, 'instructions = ' + JSON.stringify(res && res.instructions));
      });
      check('ALLOW(shipped): carries the reference message + name', () => {
        assert.strictEqual(res && res.message, REF_MESSAGE, 'message = ' + JSON.stringify(res && res.message));
        assert.strictEqual(res && res.name, REF_ID, 'name = ' + JSON.stringify(res && res.name));
      });
      check('ALLOW(shipped): NOT blocked, NO gateway output payload', () => {
        assert.ok(!(res && res.blocked === true), 'allow result was blocked: ' + JSON.stringify(res));
        assert.ok(!(res && 'output' in res), 'reference result leaked an output: ' + JSON.stringify(res));
      });
      check('ALLOW(shipped): the invoke was NEVER spawned (spy marker absent)', () => {
        assert.ok(!fs.existsSync(SPY_MARKER), 'spy marker exists — an allowed reference tool spawned its invoke');
      });
    }

    // ── 3. ALLOW (b): a non-matching enabled deny hook ⇒ allow (matcher excludes the tool). ─
    {
      cleanupSpyMarker();
      const res = await runRef(ALLOW_NOMATCH_MANIFEST, { anything: 1 });

      check('ALLOW(non-matching): result.ok === true', () => {
        assert.strictEqual(res && res.ok, true, 'expected ok:true, got ' + JSON.stringify(res));
      });
      check('ALLOW(non-matching): instructions returned (deny hook did not match)', () => {
        assert.strictEqual(res && res.instructions, REF_INSTRUCTIONS, 'instructions = ' + JSON.stringify(res && res.instructions));
      });
      check('ALLOW(non-matching): the invoke was NEVER spawned (spy marker absent)', () => {
        assert.ok(!fs.existsSync(SPY_MARKER), 'spy marker exists — reference tool spawned its invoke');
      });
    }
  } catch (err) {
    fatal = err;
  } finally {
    // Restore the register byte-for-byte and remove the spy + marker. Idempotent.
    try {
      restoreRegister(registerSnapshot);
    } catch (_e) {
      /* best-effort */
    }
    cleanupSpy();
  }

  // ── verify restore left the register byte-for-byte as found ──────────────────────────
  check('RESTORE: register is byte-for-byte the snapshot', () => {
    assert.strictEqual(fs.readFileSync(REGISTER, 'utf8'), registerSnapshot, 'register not restored');
  });
  check('RESTORE: spy script + marker removed', () => {
    assert.ok(!fs.existsSync(SPY_SCRIPT), 'spy script left behind');
    assert.ok(!fs.existsSync(SPY_MARKER), 'spy marker left behind');
  });

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
    console.log(`\nPASS: reference-gate test — ${passed}/${results.length} assertions passed ` +
      `(PreToolUse deny gates the reference HANDOFF; allow/empty manifest returns instructions; reference never spawns; register restored)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: reference-gate test — ${passed}/${results.length} assertions passed, ${failed} failed`);
    process.exit(1);
  }
})().catch((e) => {
  console.log('REFERENCE-GATE TEST CRASHED: ' + ((e && e.stack) || e));
  process.exit(1);
});

// Remove only the marker between sub-tests (the spy script persists for the whole run).
function cleanupSpyMarker() {
  try {
    if (fs.existsSync(SPY_MARKER)) fs.unlinkSync(SPY_MARKER);
  } catch (_e) {
    /* best-effort */
  }
}
