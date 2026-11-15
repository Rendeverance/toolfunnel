#!/usr/bin/env node
/**
 * rename-rollback.test.js - a rename whose PERSIST fails leaves no half-migrated config behind.
 *
 * Both stores run the rename migration BEFORE persisting, deliberately: a refused migration (a
 * matcher that cannot be rewritten, a state collision) must leave the store file untouched. That
 * ordering has a second half nobody wrote: when the migration SUCCEEDS and the persist then fails
 * (a refused rename of the temp over the store - win32 scanners hold targets briefly - a full disk),
 * the hooks manifest already names the NEW surface while the store still names the OLD one. The
 * gate now fires on a name nothing surfaces, and the tool it guarded runs unguarded.
 *
 * The fix is the mirror image: on a persist failure, migrate BACK (new -> old) before rethrowing,
 * so a failed rename is a no-op on disk and in memory. Pinned here for both stores by refusing the
 * SECOND rename in the sequence (the first is the migration's own manifest write).
 *
 * Run:  node test/rename-rollback.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const { loadExposeStore } = require(path.join(REPO_ROOT, 'src', 'mcp', 'expose-store.js'));
const { loadRegistry } = require(path.join(REPO_ROOT, 'src', 'tools', 'registry.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function makeHome(o) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-rename-rollback-'));
  for (const d of ['mcp', 'hooks', 'tools', path.join('tools', 'scripts')]) fs.mkdirSync(path.join(home, d), { recursive: true });
  const p = {
    home,
    expose: path.join(home, 'mcp', 'expose.json'),
    hooks: path.join(home, 'hooks', 'hooks.manifest.json'),
    state: path.join(home, 'tools', 'tools.state.json'),
    register: path.join(home, 'tools', 'tools.register.json'),
    scriptsRoot: path.join(home, 'tools', 'scripts'),
  };
  if (o.expose) fs.writeFileSync(p.expose, JSON.stringify(o.expose, null, 2) + '\n');
  if (o.hooks) fs.writeFileSync(p.hooks, JSON.stringify(o.hooks, null, 2) + '\n');
  if (o.register) fs.writeFileSync(p.register, JSON.stringify(o.register, null, 2) + '\n');
  process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_e) { /* best-effort */ } });
  return p;
}
const EXPOSE = (asName) => ({
  version: 1,
  upstreams: [{ id: 'up', transport: 'stdio', command: 'node', args: ['x.js'], enabled: true }],
  expose: [{ upstream: 'up', tool: 'my.tool', as: asName, category: '', enabled: true }],
});
const HOOKS = (matcher) => ({ version: 1, hooks: [{ id: 'lit', event: 'PreToolUse', matcher, type: 'command', command: 'node x.js', timeout: 5, enabled: true }] });
const REGISTER = (name) => ({ version: 1, tools: [{ id: 't1', name, summary: 's', category: 'c', invoke: { type: 'script', path: 'scripts/t1.js' } }] });

/** Run fn with fs.renameSync refusing the Nth call (1-based), then restored. Returns fn's throw. */
function withRefusedNthRename(n, fn) {
  const real = fs.renameSync;
  let calls = 0;
  fs.renameSync = function (...a) { calls += 1; if (calls === n) throw new Error('simulated persist refusal'); return real.apply(fs, a); };
  try { fn(); return null; } catch (err) { return err; } finally { fs.renameSync = real; }
}

// ── A: expose store - the migration wrote the manifest (rename #1), the persist is refused (#2) ──
{
  const p = makeHome({ expose: EXPOSE('alpha'), hooks: HOOKS('alpha') });
  const err = withRefusedNthRename(2, () => loadExposeStore(p.expose).updateExpose('up', 'my.tool', { as: 'beta' }));
  check('A: the failed persist surfaces as the error (nothing is swallowed)', () => {
    assert.ok(err && /simulated persist refusal/.test(err.message), 'got ' + (err && err.message));
  });
  check('A: the hooks manifest is ROLLED BACK to the old surface (no half-migrated config)', () => {
    assert.strictEqual(readJson(p.hooks).hooks[0].matcher, 'alpha', 'manifest still names the new surface: ' + JSON.stringify(readJson(p.hooks).hooks));
  });
  check('A: the store file is untouched', () => {
    assert.strictEqual(readJson(p.expose).expose[0].as, 'alpha');
  });
  check('A: sanity - without the refusal the same rename completes (manifest follows)', () => {
    loadExposeStore(p.expose).updateExpose('up', 'my.tool', { as: 'beta' });
    assert.strictEqual(readJson(p.hooks).hooks[0].matcher, 'beta');
    assert.strictEqual(readJson(p.expose).expose[0].as, 'beta');
  });
}

// ── A2: a PATTERN hook that matches the NEW name. A reverse MIGRATION refuses here (the pattern is
// not an exact literal for `beta`), so a rollback built on re-migrating left the manifest half-moved.
{
  const p = makeHome({ expose: EXPOSE('alpha'), hooks: { version: 1, hooks: [
    { id: 'lit', event: 'PreToolUse', matcher: 'alpha', type: 'command', command: 'node x.js', timeout: 5, enabled: true },
    { id: 'pat', event: 'PreToolUse', matcher: 'beta.*', type: 'command', command: 'node y.js', timeout: 5, enabled: true },
  ] } });
  const err = withRefusedNthRename(2, () => loadExposeStore(p.expose).updateExpose('up', 'my.tool', { as: 'beta' }));
  check('A2: with a pattern hook matching the NEW name, the failed persist still surfaces', () => {
    assert.ok(err && /simulated persist refusal/.test(err.message), 'got ' + (err && err.message));
  });
  check('A2: ...and the manifest is back to the old literal (byte snapshot, not a reverse migration)', () => {
    const hooks = readJson(p.hooks).hooks;
    assert.strictEqual(hooks.find((h) => h.id === 'lit').matcher, 'alpha', 'manifest: ' + JSON.stringify(hooks));
    assert.strictEqual(hooks.find((h) => h.id === 'pat').matcher, 'beta.*');
  });
}

// ── B: registry - same sequence on a display-name rename ──────────────────────────────────────
{
  const p = makeHome({ register: REGISTER('alpha'), hooks: HOOKS('alpha') });
  const reg = loadRegistry(p.register, { scriptsRoot: p.scriptsRoot });
  const err = withRefusedNthRename(2, () => reg.update('t1', { name: 'beta' }));
  check('B: the failed persist surfaces as the error', () => {
    assert.ok(err && /simulated persist refusal/.test(err.message), 'got ' + (err && err.message));
  });
  check('B: the hooks manifest is ROLLED BACK to the old display name', () => {
    assert.strictEqual(readJson(p.hooks).hooks[0].matcher, 'alpha', 'manifest: ' + JSON.stringify(readJson(p.hooks).hooks));
  });
  check('B: the register file AND the in-memory entry are untouched', () => {
    assert.strictEqual(readJson(p.register).tools[0].name, 'alpha');
    assert.strictEqual(reg.getEntry('t1').name, 'alpha', 'in-memory entry moved to the new name despite the failed persist');
  });
}

for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
const passed = results.filter((r) => r.ok).length;
const expected = 9;
if (passed === results.length && results.length === expected) {
  console.log(`\nPASS: rename-rollback test - ${passed}/${expected} assertions passed (a failed persist unwinds the migration)`);
  process.exit(0);
}
console.log(`\nFAIL: rename-rollback test - ${passed}/${results.length} assertions passed`);
process.exit(1);
