'use strict';

/**
 * mode.test.js — proves the per-tool EXECUTION MODE on the register.
 *
 * A register entry may carry an optional "mode":
 *   "gateway"   → ToolFunnel EXECUTES the invoke server-side through the gated run path
 *                 (the original behaviour — every shipped script tool keeps doing this).
 *   "reference" → ToolFunnel does NOT execute. toolfunnel_run_tool returns the tool's
 *                 instructions so the connected AI performs the action in ITS OWN
 *                 environment. No spawn, no gate (nothing runs here).
 * When "mode" is ABSENT it is inferred: a script/shell invoke ⇒ "gateway", else "reference".
 *
 * This test drives the SAME real-wiring path the model uses (mirrors management.test.js):
 *
 *     const { protocol } = buildProtocol();                          // real wiring
 *     protocol.dispatch('toolfunnel_run_tool', { name, args })       // the run path
 *
 * Assertions:
 *   1. BACKWARD-COMPAT: every shipped register tool (the 7 demo + 9 management) resolves to
 *      "gateway" — they all carry script invokes and no explicit mode.
 *   2. REFERENCE: a sacrificial reference tool (mode:"reference", instructions:"do X") whose
 *      invoke points at a SPY script returns { ok:true, mode:"reference", instructions:"do X",
 *      message, name } and the spy was NEVER spawned (its marker file is absent).
 *   3. CONTRAST: the SAME spy script registered as a "gateway" tool DOES spawn (its marker
 *      file appears) — so the marker's absence in (2) is load-bearing, not an artefact.
 *   4. GATEWAY: the shipped "echo" demo tool still executes and returns its output (unchanged).
 *
 * Sacrificial ids are prefixed "__tf_test_". The register file is SNAPSHOTTED up front and
 * RESTORED byte-for-byte in a finally; the spy script + marker it may write are deleted too —
 * so a failure mid-flight still leaves the real config exactly as it was found.
 *
 * Convention (matches the sibling tests): a standalone node script, exit 0 = pass, non-zero =
 * fail. Node built-ins only (node:assert, node:fs, node:path).
 *
 * Run:  node test/mode.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildProtocol } = require(path.join(__dirname, '..', 'src', 'mcp', 'server.js'));
const { loadRegistry } = require(path.join(__dirname, '..', 'src', 'tools', 'registry.js'));

const ROOT = path.resolve(__dirname, '..');
const REGISTER = path.join(ROOT, 'tools', 'tools.register.json');
const SCRIPTS_DIR = path.join(ROOT, 'tools', 'scripts');
const SPY_SCRIPT = path.join(SCRIPTS_DIR, '__tf_test_spy.js');
const SPY_MARKER = path.join(SCRIPTS_DIR, '__tf_test_spy.marker');

const REF_ID = '__tf_test_reference';
const GATEWAY_SPY_ID = '__tf_test_gateway_spy';
const REF_INSTRUCTIONS = 'do X';
const REF_MESSAGE = 'reference tool — perform this in your own environment per the instructions';

// A spy script: if it is ever spawned it leaves a marker file beside itself. Its presence
// after a run is unambiguous proof that the invoke was executed (spawned).
const SPY_BODY = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "fs.writeFileSync(path.join(__dirname, '__tf_test_spy.marker'), 'spawned\\n');",
  "process.stdout.write(JSON.stringify({ ok: true, spawned: true }) + '\\n');",
  'process.exit(0);',
  '',
].join('\n');

// ── tiny harness (matches gate.test.js / management.test.js) ──────────────────────────
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

// Add the sacrificial entries to the register on disk (a fresh buildProtocol() reads them).
function addTestTools() {
  const data = JSON.parse(fs.readFileSync(REGISTER, 'utf8'));
  data.tools.push({
    id: REF_ID,
    name: REF_ID,
    summary: 'sacrificial reference-mode tool',
    category: 'testing',
    instructions: REF_INSTRUCTIONS,
    mode: 'reference',
    // An invoke is PRESENT (and points at the spy) on purpose — a reference tool must not
    // spawn it. invoke is optional for reference, but keeping it makes the no-spawn proof real.
    invoke: { type: 'script', path: 'scripts/__tf_test_spy.js' },
  });
  data.tools.push({
    id: GATEWAY_SPY_ID,
    name: GATEWAY_SPY_ID,
    summary: 'sacrificial gateway-mode tool (same spy script)',
    category: 'testing',
    instructions: 'spawns the spy',
    mode: 'gateway',
    invoke: { type: 'script', path: 'scripts/__tf_test_spy.js' },
  });
  fs.writeFileSync(REGISTER, JSON.stringify(data, null, 2) + '\n');
}

// ── the run path (a fresh build per call → reads the current on-disk register) ─────────
async function runTool(name, args) {
  const { protocol } = buildProtocol();
  return protocol.dispatch('toolfunnel_run_tool', { name, args: args || {} });
}

(async () => {
  let fatal = null;
  const registerSnapshot = snapshotRegister();
  cleanupSpy(); // start from a known-clean state (no stale marker/spy)

  try {
    // ── 1. BACKWARD-COMPAT: every shipped tool resolves to "gateway". ──────────────────
    {
      const reg = loadRegistry(REGISTER, { scriptsRoot: SCRIPTS_DIR });
      const briefs = reg.list();
      // The backward-compat rule is: a tool with a SCRIPT/SHELL invoke infers/resolves to "gateway".
      // A tool with no such invoke (an explicit mode:"reference" tool) legitimately resolves to
      // "reference" — so we exclude those rather than asserting "no tool is non-gateway", which would
      // be a false failure if a reference tool ships (or a test fixture leaks one onto disk).
      const nonGateway = briefs.filter((b) => {
        let inv = null;
        try { inv = reg.getEntry(b.id).invoke; } catch (_e) { /* treat as no-invoke */ }
        const hasScriptOrShell = inv && (inv.type === 'script' || inv.type === 'shell');
        return hasScriptOrShell && reg.mode(b.id) !== 'gateway';
      }).map((b) => b.id);
      check('BACKWARD-COMPAT: every script/shell-invoke tool resolves to mode "gateway"', () => {
        assert.deepStrictEqual(nonGateway, [],
          'these script/shell tools did NOT resolve to gateway: ' + JSON.stringify(nonGateway));
      });
      check('BACKWARD-COMPAT: at least the 15 shipped tools are present (7 demo + 8 mgmt)', () => {
        assert.ok(briefs.length >= 15, 'register has only ' + briefs.length + ' tools');
      });
      check('BACKWARD-COMPAT: the "echo" demo tool resolves to gateway', () => {
        assert.strictEqual(reg.mode('echo'), 'gateway');
      });
    }

    // Author the spy script + add the sacrificial reference + gateway tools to the register.
    fs.writeFileSync(SPY_SCRIPT, SPY_BODY);
    addTestTools();

    // ── 2. REFERENCE: returns instructions, never spawns. ──────────────────────────────
    {
      const res = await runTool(REF_ID, { anything: 1 });
      check('REFERENCE: ok:true', () => {
        assert.strictEqual(res && res.ok, true, 'result = ' + JSON.stringify(res));
      });
      check('REFERENCE: mode === "reference"', () => {
        assert.strictEqual(res && res.mode, 'reference', 'result = ' + JSON.stringify(res));
      });
      check('REFERENCE: instructions === "do X"', () => {
        assert.strictEqual(res && res.instructions, REF_INSTRUCTIONS, 'result = ' + JSON.stringify(res));
      });
      check('REFERENCE: carries the reference message + name', () => {
        assert.strictEqual(res && res.message, REF_MESSAGE, 'message = ' + JSON.stringify(res && res.message));
        assert.strictEqual(res && res.name, REF_ID, 'name = ' + JSON.stringify(res && res.name));
      });
      check('REFERENCE: NO gateway output payload (nothing executed)', () => {
        assert.ok(!(res && 'output' in res), 'reference result leaked an output: ' + JSON.stringify(res));
      });
      check('REFERENCE: the invoke was NEVER spawned (spy marker absent)', () => {
        assert.ok(!fs.existsSync(SPY_MARKER), 'spy marker exists — the reference tool spawned its invoke');
      });
    }

    // ── 3. CONTRAST: the SAME spy as a gateway tool DOES spawn. ────────────────────────
    {
      const res = await runTool(GATEWAY_SPY_ID, {});
      check('CONTRAST: gateway run ok:true', () => {
        assert.strictEqual(res && res.ok, true, 'result = ' + JSON.stringify(res));
      });
      check('CONTRAST: gateway run DID spawn the same spy (marker present)', () => {
        assert.ok(fs.existsSync(SPY_MARKER), 'spy marker missing — the gateway tool did not spawn');
      });
    }

    // ── 4. GATEWAY: the shipped "echo" demo tool still executes + returns output. ──────
    {
      const res = await runTool('echo', { hello: 'world' });
      check('GATEWAY: echo executed (ok:true with a stdout payload)', () => {
        assert.strictEqual(res && res.ok, true, 'result = ' + JSON.stringify(res));
        assert.ok(res.output && typeof res.output.stdout === 'string',
          'echo output = ' + JSON.stringify(res && res.output));
      });
      check('GATEWAY: echo returned the args it was given', () => {
        const parsed = JSON.parse(res.output.stdout.trim());
        assert.deepStrictEqual(parsed.args, { hello: 'world' }, 'echo parsed = ' + JSON.stringify(parsed));
      });
      check('GATEWAY: a gateway result does NOT carry mode:"reference"', () => {
        assert.notStrictEqual(res && res.mode, 'reference', 'result = ' + JSON.stringify(res));
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
    console.log(`\nPASS: mode test — ${passed}/${results.length} assertions passed ` +
      `(reference tool yields instructions + never spawns; gateway tools execute unchanged; register restored)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: mode test — ${passed}/${results.length} assertions passed, ${failed} failed`);
    process.exit(1);
  }
})().catch((e) => {
  console.log('MODE TEST CRASHED: ' + ((e && e.stack) || e));
  process.exit(1);
});
