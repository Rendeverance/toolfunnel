'use strict';

/**
 * hidden.test.js — proves the `hidden` matrix axis is WIRED (manager-view declutter), not just
 * write-and-report-only. `hidden` must NOT affect what the connected AI sees (the lean list /
 * top-level surface) — only the MANAGER views (tf_list + the UI). This test exercises the two
 * server-side consumers directly as scripts (the register's script contract: structured args in
 * env TOOLFUNNEL_TOOL_ARGS, one JSON line on stdout, exit 0):
 *
 *   A — tf_tool_set { action:'hide' }   sets hidden:true in the overlay (preserving other axes).
 *   B — tf_list { kind:'tools' }         OMITS the hidden tool by default (the declutter).
 *   C — tf_list { kind:'tools', includeHidden:true } INCLUDES it (annotated hidden:true).
 *   D — tf_tool_set { action:'unhide' } clears it; tf_list shows it again.
 *   E — hide preserves a co-set axis (enabled) — independent merge, not replace.
 *
 * NON-DESTRUCTIVE: tools/tools.state.json is snapshotted and restored. Node built-ins only.
 *
 * Run:  node test/hidden.test.js     (exit 0 = pass, non-zero = fail)
 */

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(REPO_ROOT, 'tools', 'tools.state.json');
const TF_SET = path.join(REPO_ROOT, 'tools', 'scripts', 'tf-tool-set.js');
const TF_LIST = path.join(REPO_ROOT, 'tools', 'scripts', 'tf-list.js');
const TARGET = 'echo'; // a real register tool

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function snapshot(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_e) { return null; } }
function restore(p, snap) {
  try { if (snap === null) { if (fs.existsSync(p)) fs.unlinkSync(p); } else { fs.writeFileSync(p, snap); } }
  catch (_e) { /* best-effort */ }
}
function writeState(obj) { fs.writeFileSync(STATE_PATH, JSON.stringify(obj, null, 2) + '\n'); }

/** Run a register script with structured args; parse its single stdout JSON line. */
function runScript(scriptPath, args) {
  const res = spawnSync(process.execPath, [scriptPath], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { TOOLFUNNEL_TOOL_ARGS: JSON.stringify(args == null ? null : args) }),
    encoding: 'utf8',
    windowsHide: true,
  });
  const out = (res.stdout || '').trim();
  try { return JSON.parse(out); } catch (_e) { return { ok: false, error: 'unparseable stdout: ' + out, _raw: out, _stderr: res.stderr }; }
}
function toolIds(listResult) {
  return (listResult && Array.isArray(listResult.items)) ? listResult.items.map((t) => t && t.id) : [];
}

(async () => {
  const stateSnap = snapshot(STATE_PATH);
  let fatal = null;
  try {
    writeState({}); // clean defaults: nothing hidden

    // A — hide via tf_tool_set.
    const hide = runScript(TF_SET, { id: TARGET, action: 'hide' });
    check('A: tf_tool_set {action:hide} sets hidden:true', () => {
      assert.strictEqual(hide.ok, true, 'hide not ok: ' + JSON.stringify(hide));
      assert.strictEqual(hide.hidden, true, 'hide.hidden should be true');
      assert.ok(hide.state && hide.state[TARGET] && hide.state[TARGET].hidden === true, 'overlay not set: ' + JSON.stringify(hide.state));
    });

    // B — tf_list omits the hidden tool by default (the declutter consumer).
    const def = runScript(TF_LIST, { kind: 'tools' });
    check('B: tf_list {kind:tools} OMITS the hidden tool by default', () => {
      assert.strictEqual(def.ok, true, 'list not ok: ' + JSON.stringify(def));
      assert.ok(!toolIds(def).includes(TARGET), TARGET + ' should be decluttered; got ' + JSON.stringify(toolIds(def)));
      // sanity: other tools still present
      assert.ok(toolIds(def).length > 0, 'list unexpectedly empty');
    });

    // C — includeHidden:true brings it back, annotated hidden:true.
    const inc = runScript(TF_LIST, { kind: 'tools', includeHidden: true });
    check('C: tf_list {includeHidden:true} INCLUDES the hidden tool, annotated hidden:true', () => {
      assert.ok(toolIds(inc).includes(TARGET), TARGET + ' missing with includeHidden; got ' + JSON.stringify(toolIds(inc)));
      const t = inc.items.find((x) => x.id === TARGET);
      assert.strictEqual(t && t.hidden, true, 'annotation hidden!=true: ' + JSON.stringify(t));
    });

    // D — unhide restores it to the default list.
    const unhide = runScript(TF_SET, { id: TARGET, action: 'unhide' });
    const back = runScript(TF_LIST, { kind: 'tools' });
    check('D: tf_tool_set {action:unhide} clears it; tf_list shows it again', () => {
      assert.strictEqual(unhide.ok, true, 'unhide not ok: ' + JSON.stringify(unhide));
      assert.strictEqual(unhide.hidden, false, 'unhide.hidden should be false');
      assert.ok(toolIds(back).includes(TARGET), TARGET + ' should be back; got ' + JSON.stringify(toolIds(back)));
    });

    // E — hide preserves a co-set axis (independence): disable, then hide, enabled stays false.
    writeState({});
    runScript(TF_SET, { id: TARGET, action: 'disable' });
    const hide2 = runScript(TF_SET, { id: TARGET, action: 'hide' });
    check('E: hide preserves the enabled axis (merge, not replace)', () => {
      assert.ok(hide2.state && hide2.state[TARGET], 'overlay missing');
      assert.strictEqual(hide2.state[TARGET].enabled, false, 'enabled clobbered by hide: ' + JSON.stringify(hide2.state[TARGET]));
      assert.strictEqual(hide2.state[TARGET].hidden, true, 'hidden not set');
    });
  } catch (err) {
    fatal = err;
  } finally {
    restore(STATE_PATH, stateSnap);
  }

  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));

  const passed = results.filter((r) => r.ok).length;
  const expected = 5;
  const ok = !fatal && passed === results.length && results.length === expected;
  if (ok) {
    console.log(`\nPASS: hidden test — ${passed}/${expected} assertions passed (hidden axis declutters tf_list, settable via tf_tool_set, axis-independent)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: hidden test — ${passed}/${results.length} assertions passed`);
    process.exit(1);
  }
})().catch((e) => { console.log('HIDDEN TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
