#!/usr/bin/env node
/**
 * cli-flags.test.js - a value-taking flag never swallows the NEXT flag as its value.
 *
 * `toolfunnel --config-dir --port 0` read "--port" as the config directory (and then started a
 * gateway with its config home in a directory literally named "--port"), and a trailing bare
 * `--config-dir` silently fell back to the package root - the exact misconfiguration the parser's
 * own comment says it exists to prevent. Both now exit 2 with the same "requires a value" message
 * the empty `=` form already produces.
 *
 * Spawns the real CLI with its cwd in a scratch dir, so any stray directory it might create lands
 * there and nowhere near the repo.
 *
 * Run:  node test/cli-flags.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const { makeTempHome } = require('./helpers/temp-home');
const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const home = makeTempHome({ prefix: 'tf-cli-flags-' });
process.on('exit', () => home.cleanup());
const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cli-flags-cwd-'));
process.on('exit', () => { try { fs.rmSync(scratchCwd, { recursive: true, force: true }); } catch (_e) { /* best-effort */ } });

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
const run = (argv) => spawnSync(process.execPath, [ENTRY, ...argv], { cwd: scratchCwd, env: home.env(), encoding: 'utf8', timeout: 6000, windowsHide: true });

const sane = run(['--config-dir', home.home, '--version']);
check('sanity: --config-dir <dir> --version prints the version and exits 0', () => {
  assert.strictEqual(sane.status, 0, 'status ' + sane.status + ' stderr=' + String(sane.stderr).slice(0, 200));
  assert.match(String(sane.stdout).trim(), /^\d+\.\d+\.\d+/);
});

const swallowed = run(['--config-dir', '--port', '0']);
check('--config-dir followed by another flag exits 2 with "requires a value" (never swallows the flag)', () => {
  assert.strictEqual(swallowed.status, 2, 'status ' + swallowed.status + ' (null = hung until timeout) stderr=' + String(swallowed.stderr).slice(0, 200));
  assert.match(String(swallowed.stderr), /requires a value/);
  assert.ok(!fs.existsSync(path.join(scratchCwd, '--port')), 'a directory named "--port" was created as the config home');
});

const trailing = run(['--config-dir']);
check('a trailing bare --config-dir exits 2 with "requires a value" (never a silent fallback)', () => {
  assert.strictEqual(trailing.status, 2, 'status ' + trailing.status + ' (null = hung until timeout) stderr=' + String(trailing.stderr).slice(0, 200));
  assert.match(String(trailing.stderr), /requires a value/);
});

for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
const passed = results.filter((r) => r.ok).length;
const expected = 3;
if (passed === results.length && results.length === expected) {
  console.log(`\nPASS: cli-flags test - ${passed}/${expected} assertions passed (value flags never swallow a flag)`);
  process.exit(0);
}
console.log(`\nFAIL: cli-flags test - ${passed}/${results.length} assertions passed`);
process.exit(1);
