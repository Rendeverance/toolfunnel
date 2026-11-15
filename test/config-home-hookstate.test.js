#!/usr/bin/env node
/**
 * config-home-hookstate.test.js - a fresh config home never inherits the package's hook toggles.
 *
 * Seeding copies the package's hooks/ tree into a new home. In a git clone that tree can hold
 * hooks/hooks.state.json - the developer's own live hook toggles (user state, like
 * tools/tools.state.json, which seeding already drops). A fresh home must start from the shipped
 * manifest's enabled flags, not someone's local switches (the same rule as tools.state.json).
 *
 * The check never touches this checkout: it copies the package to a scratch folder, plants a
 * hooks.state.json in the COPY, and seeds a fresh home through the copy's own config-home module
 * (its package root is the copy).
 *
 * Run:  node test/config-home-hookstate.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-pkgcopy-hookstate-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-home-hookstate-'));
try {
  for (const d of ['bin', 'src', 'tools', 'hooks']) fs.cpSync(path.join(REPO_ROOT, d), path.join(pkg, d), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(pkg, 'package.json'));
  fs.mkdirSync(path.join(pkg, 'mcp'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'hooks', 'hooks.state.json'), JSON.stringify({ 'pre-tool-use/example-deny-dangerous': { enabled: false } }) + '\n');
  // a planted tools.state.json too: the existing rule must keep holding
  fs.writeFileSync(path.join(pkg, 'tools', 'tools.state.json'), JSON.stringify({ tf_list: { hidden: true } }) + '\n');

  const { ensureConfigHome } = require(path.join(pkg, 'src', 'core', 'config-home.js'));
  const res = ensureConfigHome(home);

  check('the fresh home gets the shipped hooks manifest', () => {
    assert.ok(fs.existsSync(path.join(home, 'hooks', 'hooks.manifest.json')));
  });
  check('the package\'s hooks.state.json (a developer\'s toggles) does NOT travel into the fresh home', () => {
    assert.ok(!fs.existsSync(path.join(home, 'hooks', 'hooks.state.json')), 'hooks.state.json was seeded into the fresh home');
    assert.ok(!res.seeded.includes(path.join(home, 'hooks', 'hooks.state.json')), 'reported as seeded');
  });
  check('the tools.state.json rule still holds', () => {
    assert.ok(!fs.existsSync(path.join(home, 'tools', 'tools.state.json')));
  });
} finally {
  try { fs.rmSync(pkg, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
}

const EXPECTED = 3;
for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
const passed = results.filter((r) => r.ok).length;
if (passed === results.length && results.length === EXPECTED) {
  console.log(`\nPASS: config-home-hookstate test - ${passed}/${EXPECTED} assertions passed (a fresh home never inherits hook toggles)`);
  process.exit(0);
}
console.log(`\nFAIL: config-home-hookstate test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
process.exit(1);
