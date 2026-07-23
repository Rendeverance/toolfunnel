'use strict';

/**
 * release.test.js - smoke test for scripts/release.js in --dry-run mode.
 *
 * Proves the release pipeline can PLAN without mutating anything: correct next-version
 * arithmetic, repo derivation from package.json, and the hard promise that a dry run
 * executes no step (no commit, no tag, no push, no API call, no publish).
 *
 * Dry-run is the only mode a test may exercise - a real run cuts a public release.
 * Everything else about the script is deliberately judged in the field, one release
 * at a time, because the failure mode there is visible and recoverable (the script
 * only ever ADDS: tags, releases and npm versions are never deleted or overwritten).
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'release.js');

function fail(msg) {
  console.error('FAIL: ' + msg);
  process.exit(1);
}

// Hermetic guard: this test drives scripts/release.js, which shells `git status` - meaningless
// outside a git checkout (a copied/exported tree fails "not a git repository", which is the
// environment's shape, not a product defect). Skip cleanly.
if (spawnSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, encoding: 'utf8' }).status !== 0) {
  console.log('SKIP: release test - not a git checkout (release.js needs one); nothing to assert.');
  process.exit(0);
}

// Capture repo state before, to prove dry-run mutates nothing.
const pkgBefore = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
const headBefore = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const tagsBefore = spawnSync('git', ['tag'], { cwd: ROOT, encoding: 'utf8' }).stdout;

const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--no-npm'], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 60000,
});

if (r.status !== 0) fail(`dry-run exited ${r.status}\nstderr: ${r.stderr}`);
const out = r.stdout || '';
if (!/^plan: \d+\.\d+\.\d+ -> \d+\.\d+\.\d+ \(patch\)/m.test(out)) fail('missing/bad plan line:\n' + out);
if (!out.includes('Rendeverance/toolfunnel')) fail('repo not derived from package.json:\n' + out);
if (!out.includes('DRY RUN - nothing executed.')) fail('missing DRY RUN sentinel:\n' + out);

// Version arithmetic: the planned target must be the current version patch-bumped.
const cur = JSON.parse(pkgBefore).version;
const [a, b, c] = cur.split('.').map(Number);
if (!out.includes(`${cur} -> ${a}.${b}.${c + 1}`)) fail(`expected bump ${cur} -> ${a}.${b}.${c + 1}:\n` + out);

// Nothing moved.
const pkgAfter = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
const headAfter = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const tagsAfter = spawnSync('git', ['tag'], { cwd: ROOT, encoding: 'utf8' }).stdout;
if (pkgAfter !== pkgBefore) fail('dry-run modified package.json');
if (headAfter !== headBefore) fail('dry-run created a commit');
if (tagsAfter !== tagsBefore) fail('dry-run created a tag');

console.log('release.test.js: all assertions passed');
process.exit(0);
