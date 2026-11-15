#!/usr/bin/env node
/**
 * hook-env.test.js - a hook the engine spawns sees the CONFIG HOME it was loaded from.
 *
 * The runner sets two env vars for every hook child so a script can resolve itself and its
 * project: HOOKS_DIR and CLAUDE_PROJECT_DIR. The engine knows the home (loader.hooksDir - it uses
 * it for the child cwd) but never handed it to the runner, so the runner fell back to the PACKAGE
 * hooks dir and derived CLAUDE_PROJECT_DIR from that. A hook seeded into a relocated home
 * (--config-dir / TOOLFUNNEL_HOME) therefore ran with both vars pointing into the npm package:
 * anything it resolved from them (a sibling script, a policy file beside the manifest, the
 * project's own files) came from the wrong tree.
 *
 * The probe hook lives in <home>/hooks/scripts and is reached through ${HOOKS_DIR} in its command
 * (the loader substitutes that from ITS hooksDir, which was already right); it writes the two env
 * vars it received to a file and the test asserts both name the home.
 *
 * Run:  node test/hook-env.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');

const { makeTempHome } = require('./helpers/temp-home');
const REPO_ROOT = path.resolve(__dirname, '..');
const { loadManifest } = require(path.join(REPO_ROOT, 'src', 'core', 'hook-loader.js'));
const { HookEngine } = require(path.join(REPO_ROOT, 'src', 'core', 'hook-engine.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

const home = makeTempHome({ prefix: 'tf-hook-env-' });
process.on('exit', () => home.cleanup());

const scriptsDir = path.join(home.home, 'hooks', 'scripts');
fs.mkdirSync(scriptsDir, { recursive: true });
const OUT = path.join(home.home, 'env-seen.json');
fs.writeFileSync(path.join(scriptsDir, 'env-probe.js'), [
  "'use strict';",
  "require('node:fs').writeFileSync(process.env.TF_ENV_OUT, JSON.stringify({",
  '  hooksDir: process.env.HOOKS_DIR || null,',
  '  projectDir: process.env.CLAUDE_PROJECT_DIR || null,',
  "}) + '\\n');",
  'process.exit(0);',
  '',
].join('\n'));
fs.writeFileSync(home.manifest, JSON.stringify({
  version: 1,
  hooks: [{
    id: 'pre-tool-use/env-probe',
    event: 'PreToolUse',
    matcher: '*',
    type: 'command',
    command: JSON.stringify(process.execPath) + ' "${HOOKS_DIR}/scripts/env-probe.js"',
    timeout: 10,
    enabled: true,
  }],
}, null, 2) + '\n');

(async () => {
  const loader = loadManifest(home.manifest);
  const homeHooksDir = path.join(home.home, 'hooks');
  check('sanity: the loader resolves its hooksDir to the home (not the package)', () => {
    assert.strictEqual(path.resolve(loader.hooksDir), path.resolve(homeHooksDir), 'loader.hooksDir = ' + loader.hooksDir);
  });

  // The home is the FALLBACK for CLAUDE_PROJECT_DIR: make sure nothing inherited (this test may itself
  // run under a host that sets it) masks the derivation under test.
  const inherited = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  const engine = new HookEngine(loader, { env: { TF_ENV_OUT: OUT } });
  const res = await engine.fire('PreToolUse', { session_id: 'hook-env-test', transcript_path: '', cwd: home.home }, { tool_name: 'echo', tool_input: {} });
  check('sanity: the probe hook ran and allowed', () => {
    assert.strictEqual(res.blocked, false, 'blocked: ' + res.reason);
    assert.ok(fs.existsSync(OUT), 'probe wrote nothing; results: ' + JSON.stringify(res.results));
  });
  const seen = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  check('HOOKS_DIR seen by the hook is the HOME hooks dir it was loaded from', () => {
    assert.strictEqual(seen.hooksDir && path.resolve(seen.hooksDir), path.resolve(homeHooksDir), 'HOOKS_DIR = ' + seen.hooksDir);
  });
  check('CLAUDE_PROJECT_DIR seen by the hook is the HOME (the tree the hooks dir sits in)', () => {
    assert.strictEqual(seen.projectDir && path.resolve(seen.projectDir), path.resolve(home.home), 'CLAUDE_PROJECT_DIR = ' + seen.projectDir);
  });

  // An INHERITED CLAUDE_PROJECT_DIR (a host's project) wins over the derived home - hooks ported from
  // Claude Code read it as the user's project, and the engine must not silently repoint it.
  const MARKER = path.join(home.home, 'host-project-marker');
  process.env.CLAUDE_PROJECT_DIR = MARKER;
  try { fs.unlinkSync(OUT); } catch (_e) { /* ignore */ }
  await new HookEngine(loader, { env: { TF_ENV_OUT: OUT } }).fire('PreToolUse', { session_id: 'hook-env-test', transcript_path: '', cwd: home.home }, { tool_name: 'echo', tool_input: {} });
  const seen2 = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  check('an INHERITED CLAUDE_PROJECT_DIR wins over the derived home', () => {
    assert.strictEqual(seen2.projectDir && path.resolve(seen2.projectDir), path.resolve(MARKER), 'CLAUDE_PROJECT_DIR = ' + seen2.projectDir);
  });
  check('...while HOOKS_DIR still names the home', () => {
    assert.strictEqual(seen2.hooksDir && path.resolve(seen2.hooksDir), path.resolve(homeHooksDir), 'HOOKS_DIR = ' + seen2.hooksDir);
  });
  delete process.env.CLAUDE_PROJECT_DIR;

  // The runner's OWN default (a direct runHook with no options): the package's shipped hooks tree
  // and the package root - it named a <pkg>/src/hooks that never existed, and derived the project
  // as <pkg>/src once the derivation became dirname(hooksDir).
  const { runHook } = require(path.join(REPO_ROOT, 'src', 'core', 'hook-runner.js'));
  try { fs.unlinkSync(OUT); } catch (_e) { /* ignore */ }
  await runHook({ id: 'direct/env-probe', event: 'PreToolUse', command: JSON.stringify(process.execPath) + ' ' + JSON.stringify(path.join(scriptsDir, 'env-probe.js')), timeout: 10 },
    { session_id: 'hook-env-test', transcript_path: '', cwd: home.home, hook_event_name: 'PreToolUse', tool_name: 'echo', tool_input: {} }, { env: { TF_ENV_OUT: OUT } });
  const seen3 = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  check('a direct runHook with no options defaults HOOKS_DIR to <pkg>/hooks and CLAUDE_PROJECT_DIR to <pkg>', () => {
    assert.strictEqual(seen3.hooksDir && path.resolve(seen3.hooksDir), path.join(REPO_ROOT, 'hooks'), 'HOOKS_DIR = ' + seen3.hooksDir);
    assert.strictEqual(seen3.projectDir && path.resolve(seen3.projectDir), REPO_ROOT, 'CLAUDE_PROJECT_DIR = ' + seen3.projectDir);
  });
  if (inherited !== undefined) process.env.CLAUDE_PROJECT_DIR = inherited;

  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  const expected = 7;
  if (passed === results.length && results.length === expected) {
    console.log(`\nPASS: hook-env test - ${passed}/${expected} assertions passed (hook children see the config home)`);
    process.exit(0);
  }
  console.log(`\nFAIL: hook-env test - ${passed}/${results.length} assertions passed`);
  process.exit(1);
})().catch((e) => { console.log('HOOK-ENV TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
