'use strict';

/**
 * orphan-tmp.test.js - the atomic writers clean up after themselves. The atomic pattern
 * (temp file + fsync + rename) can strand its temp file forever when the final rename is
 * refused (win32: the target briefly held by a scanner/reader) or the process dies mid-
 * write - two real strandings were found in tools/. The writers now:
 *
 *   - unlink their OWN temp on ANY failure before rethrowing (the error still surfaces;
 *     the droppings don't), and
 *   - sweep STALE sibling temps (same `.<base>.<pid>.<ts>.tmp` shape, >1 h old) on the
 *     next successful write of the same target - catching strandings from crashes where
 *     no failure path ever ran - while a FRESH sibling (a concurrent writer's in-flight
 *     temp) is left alone.
 *
 * Covers all three sites that share the pattern: registry.js::atomicWriteJson (the shared
 * writer behind tools/hooks state, manifests, toolfunnel.json), expose-store.js's exact
 * copy, and Registry.writeScript's inline mirror.
 *
 * In-process, plain temp dirs, no config touched.
 *
 * Run:  node test/orphan-tmp.test.js     (exit 0 = pass, non-zero = fail)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const registry = require(path.join(REPO_ROOT, 'src', 'tools', 'registry.js'));
const exposeStore = require(path.join(REPO_ROOT, 'src', 'mcp', 'expose-store.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `tf-orphan-${tag}-`)); }
function tmpsIn(dir) { return fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')); }
function plantTmp(dir, base, ageMs) {
  const p = path.join(dir, `.${base}.99999.1234567890.tmp`);
  fs.writeFileSync(p, 'stranded');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
  return p;
}

/** Run fn with fs.renameSync patched to refuse once (then restored). */
function withRefusedRename(fn) {
  const real = fs.renameSync;
  fs.renameSync = function () { throw new Error('simulated rename refusal'); };
  try { return fn(); } finally { fs.renameSync = real; }
}

const HOUR = 60 * 60 * 1000;

// ── A: registry.js::atomicWriteJson ────────────────────────────────────────────────────
check('A1: a refused rename leaves NO temp behind (error still thrown)', () => {
  const dir = tmpDir('reg-refuse');
  const target = path.join(dir, 'tools.state.json');
  assert.throws(() => withRefusedRename(() => registry.atomicWriteJson(target, { a: 1 })),
    /simulated rename refusal/);
  assert.deepStrictEqual(tmpsIn(dir), [], 'temp must be unlinked on the failure path');
});

check('A2: a STALE stranded sibling temp is swept by the next successful write', () => {
  const dir = tmpDir('reg-sweep');
  const target = path.join(dir, 'tools.state.json');
  const stranded = plantTmp(dir, 'tools.state.json', 2 * HOUR);
  registry.atomicWriteJson(target, { b: 2 });
  assert.ok(!fs.existsSync(stranded), 'the stale stranding must be swept');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { b: 2 });
  assert.deepStrictEqual(tmpsIn(dir), [], 'no temps after a clean write');
});

check('A3: a FRESH sibling temp (a concurrent writer) is left alone', () => {
  const dir = tmpDir('reg-fresh');
  const target = path.join(dir, 'tools.state.json');
  const fresh = plantTmp(dir, 'tools.state.json', 0);
  registry.atomicWriteJson(target, { c: 3 });
  assert.ok(fs.existsSync(fresh), 'a fresh in-flight temp must NOT be swept');
});

check('A4: an unrelated .tmp with a different base is never touched', () => {
  const dir = tmpDir('reg-other');
  const target = path.join(dir, 'tools.state.json');
  const other = path.join(dir, '.something-else.json.1.2.tmp');
  fs.writeFileSync(other, 'not ours');
  const t = new Date(Date.now() - 2 * HOUR);
  fs.utimesSync(other, t, t);
  registry.atomicWriteJson(target, { d: 4 });
  assert.ok(fs.existsSync(other), 'the sweep is scoped to the target\'s own temp shape');
});

// ── B: expose-store.js's copy ──────────────────────────────────────────────────────────
check('B1: expose-store writer - refused rename leaves no temp; error surfaces', () => {
  const dir = tmpDir('store-refuse');
  const target = path.join(dir, 'expose.json');
  assert.throws(() => withRefusedRename(() => exposeStore.atomicWriteJson(target, { e: 5 })),
    /simulated rename refusal/);
  assert.deepStrictEqual(tmpsIn(dir), [], 'temp must be unlinked on the failure path');
});

check('B2: expose-store writer - stale sibling swept, fresh sibling kept', () => {
  const dir = tmpDir('store-sweep');
  const target = path.join(dir, 'expose.json');
  const stranded = plantTmp(dir, 'expose.json', 2 * HOUR);
  const fresh = path.join(dir, `.expose.json.88888.${Date.now()}.tmp`);
  fs.writeFileSync(fresh, 'in flight');
  exposeStore.atomicWriteJson(target, { f: 6 });
  assert.ok(!fs.existsSync(stranded), 'stale stranding swept');
  assert.ok(fs.existsSync(fresh), 'fresh in-flight temp kept');
});

// ── C: Registry.writeScript's inline mirror ────────────────────────────────────────────
check('C1: writeScript - refused rename leaves no temp; stale sibling swept on success', () => {
  const dir = tmpDir('script');
  const reg = new registry.Registry({ filePath: path.join(dir, 'tools.register.json'), scriptsRoot: path.join(dir, 'scripts') });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  assert.throws(() => withRefusedRename(() => reg.writeScript('probe.js', 'x')), /simulated rename refusal/);
  assert.deepStrictEqual(tmpsIn(path.join(dir, 'scripts')), [], 'no temp after the refusal');
  const stranded = plantTmp(path.join(dir, 'scripts'), 'probe.js', 2 * HOUR);
  reg.writeScript('probe.js', 'clean body');
  assert.ok(!fs.existsSync(stranded), 'stale stranding swept by the next write');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'scripts', 'probe.js'), 'utf8'), 'clean body');
});

// ── Report ─────────────────────────────────────────────────────────────────────────────
for (const r of results) {
  console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
}
const passed = results.filter((r) => r.ok).length;
const expected = 7;
if (passed === results.length && results.length === expected) {
  console.log(`\nPASS: orphan-tmp test - ${passed}/${expected} assertions passed (failure paths unlink their temp; stale strandings swept; fresh/unrelated temps untouched)`);
  process.exit(0);
} else {
  console.log(`\nFAIL: orphan-tmp test - ${passed}/${results.length} assertions passed`);
  process.exit(1);
}
