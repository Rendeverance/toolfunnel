#!/usr/bin/env node
/**
 * config-home-new-tools.test.js - a new shipped tool reaches an existing config home, once.
 *
 * A home keeps its own register (seeding never overwrites a file), so a tool shipped in a later
 * release would never reach it. Each start now adds the shipped register entries this home has
 * never been offered, and records every offered id in tools/tools.seeded.json: an added tool
 * arrives once, a shipped tool the user deleted is never added back, and existing entries are
 * never touched. A home from before the ledger counts the 0.7.x shipped tools as already offered.
 *
 * Run:  node test/config-home-new-tools.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const { ensureConfigHome } = require(path.join(REPO_ROOT, 'src', 'core', 'config-home.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

const SHIPPED = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tools', 'tools.register.json'), 'utf8'));
const shippedIds = SHIPPED.tools.map((t) => t.id);
const homes = [];
const newHome = () => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-newtools-')); homes.push(h); return h; };
const regOf = (home) => JSON.parse(fs.readFileSync(path.join(home, 'tools', 'tools.register.json'), 'utf8'));
const idsOf = (home) => regOf(home).tools.map((t) => t.id);
const ledgerOf = (home) => JSON.parse(fs.readFileSync(path.join(home, 'tools', 'tools.seeded.json'), 'utf8'));

/** A home as 0.7.x left it: the old register (no tf_accept_change), minus `danger` the user deleted, plus a tool of their own. */
function upgradedHome() {
  const home = newHome();
  fs.mkdirSync(path.join(home, 'tools'), { recursive: true });
  const old = SHIPPED.tools.filter((t) => t.id !== 'tf_accept_change' && t.id !== 'danger');
  old.push({ id: 'my_tool', name: 'my_tool', summary: 'Mine.', category: 'mine', invoke: { type: 'shell', command: 'echo hi' } });
  fs.writeFileSync(path.join(home, 'tools', 'tools.register.json'), JSON.stringify({ ...SHIPPED, tools: old }, null, 2) + '\n');
  return home;
}

try {
  check('the shipped register has tf_accept_change (the tool this release adds)', () => {
    assert.ok(shippedIds.includes('tf_accept_change'), shippedIds.join(', '));
  });

  const up = upgradedHome();
  const r1 = ensureConfigHome(up);
  check('an upgraded home gains the new shipped tool, once, and says so', () => {
    assert.deepStrictEqual(r1.added, ['tf_accept_change']);
    assert.ok(idsOf(up).includes('tf_accept_change'), idsOf(up).join(', '));
    assert.ok(fs.existsSync(path.join(up, 'tools', 'scripts', 'tf-accept-change.js')), 'its script was not seeded');
  });
  check('a shipped tool the user deleted stays deleted; their own tools and entries are untouched', () => {
    assert.ok(!idsOf(up).includes('danger'), 'danger came back');
    const mine = regOf(up).tools.find((t) => t.id === 'my_tool');
    assert.deepStrictEqual(mine, { id: 'my_tool', name: 'my_tool', summary: 'Mine.', category: 'mine', invoke: { type: 'shell', command: 'echo hi' } });
  });
  check('the ledger records every shipped id as offered', () => {
    assert.deepStrictEqual(ledgerOf(up).ids.slice().sort(), shippedIds.slice().sort());
  });

  const reg = regOf(up);
  reg.tools = reg.tools.filter((t) => t.id !== 'tf_accept_change');
  fs.writeFileSync(path.join(up, 'tools', 'tools.register.json'), JSON.stringify(reg, null, 2) + '\n');
  const r2 = ensureConfigHome(up);
  check('deleting the added tool is respected on the next start', () => {
    assert.deepStrictEqual(r2.added, []);
    assert.ok(!idsOf(up).includes('tf_accept_change'));
  });

  const fresh = newHome();
  const r3 = ensureConfigHome(fresh);
  const before = fs.readFileSync(path.join(fresh, 'tools', 'tools.register.json'), 'utf8');
  const r4 = ensureConfigHome(fresh);
  check('a fresh home gets the full register and a full ledger; a second start changes nothing', () => {
    assert.deepStrictEqual(idsOf(fresh), shippedIds);
    assert.deepStrictEqual(ledgerOf(fresh).ids.slice().sort(), shippedIds.slice().sort());
    assert.deepStrictEqual([r3.added, r4.added], [[], []]);
    assert.strictEqual(fs.readFileSync(path.join(fresh, 'tools', 'tools.register.json'), 'utf8'), before);
  });

  const broken = newHome();
  fs.mkdirSync(path.join(broken, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(broken, 'tools', 'tools.register.json'), '{ not json');
  const r5 = ensureConfigHome(broken);
  check('an unreadable register is left exactly as it is', () => {
    assert.deepStrictEqual(r5.added, []);
    assert.strictEqual(fs.readFileSync(path.join(broken, 'tools', 'tools.register.json'), 'utf8'), '{ not json');
  });

  const ro = upgradedHome();
  const roReg = path.join(ro, 'tools', 'tools.register.json');
  const lock = (on) => (process.platform === 'win32'
    ? spawnSync('attrib', [on ? '+R' : '-R', roReg], { windowsHide: true })
    : fs.chmodSync(path.join(ro, 'tools'), on ? 0o555 : 0o755));
  const roBefore = fs.readFileSync(roReg, 'utf8');
  lock(true);
  let r6;
  let thrown = null;
  try { r6 = ensureConfigHome(ro); } catch (e) { thrown = e; } finally { lock(false); }
  check('a register that cannot be rewritten starts without the new tool instead of failing', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root writes through 0o555
    assert.strictEqual(thrown, null, thrown && thrown.message);
    assert.deepStrictEqual(r6.added, []);
    assert.strictEqual(fs.readFileSync(roReg, 'utf8'), roBefore);
  });

  const ledgerInRepo = path.join(REPO_ROOT, 'tools', 'tools.seeded.json');
  try {
    check('the package root (a git clone) is never given a ledger, however its path is spelled', () => {
      for (const spelling of [REPO_ROOT, REPO_ROOT.toLowerCase(), REPO_ROOT.toUpperCase()]) {
        if (spelling !== REPO_ROOT && process.platform !== 'win32') continue; // case-sensitive paths elsewhere
        const r = ensureConfigHome(spelling);
        assert.deepStrictEqual(r.added || [], [], spelling);
        assert.ok(!fs.existsSync(ledgerInRepo), 'ledger written into the package via ' + spelling);
      }
    });
  } finally {
    try { fs.unlinkSync(ledgerInRepo); } catch (_e) { /* not created */ }
  }
} finally {
  for (const h of homes) { try { fs.rmSync(h, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
}

const EXPECTED = 9;
for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
const passed = results.filter((r) => r.ok).length;
if (passed === results.length && results.length === EXPECTED) {
  console.log(`\nPASS: config-home-new-tools test - ${passed}/${EXPECTED} assertions passed (new tools arrive once, deletions stick)`);
  process.exit(0);
}
console.log(`\nFAIL: config-home-new-tools test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
process.exit(1);
