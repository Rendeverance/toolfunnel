'use strict';

/**
 * pack.test.js - tf_pack (package the live setup) + the `requires` runtime preflight: the two
 * user-facing halves of the 0.4.0 packaging story.
 *
 *   R - requires unit: parseVersion / compareVersions; checkRequires against a scratch home -
 *       a satisfiable requirement (node) passes, a nonsense command reports not-found, an
 *       impossible min reports the found-vs-needed versions. All ADVISORY (a list, no throw).
 *   P - tf_pack format "home": dispatched through the real gated run path, writes a portable
 *       config home under <repo>/dist/<name> - register + scripts + hooks + expose + a REWRITTEN
 *       toolfunnel.json identity - and never ships auth/ or logs/. A second run without force
 *       refuses; with force succeeds.
 *   N - tf_pack format "npm": generated package.json (bin entry, files whitelist, toolfunnel as
 *       a CARET DEPENDENCY - depend, never copy), a launcher pointing --config-dir at the
 *       bundled home/, a README stub, and the home snapshot under home/.
 *
 * NON-DESTRUCTIVE: writes only under <repo>/dist/ (gitignored), removed in finally. The live
 * register/config is read, never mutated. Node built-ins only.
 *
 * Run:  node test/pack.test.js     (exit 0 = pass, non-zero = fail)
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST = path.join(REPO_ROOT, 'dist');

const { buildProtocol } = require(path.join(REPO_ROOT, 'src', 'mcp', 'server.js'));
const { parseVersion, compareVersions, checkRequires } = require(path.join(REPO_ROOT, 'src', 'core', 'requires.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

async function runTool(name, args) {
  const { protocol } = buildProtocol();
  return protocol.dispatch('toolfunnel_run_tool', { name, args: args || {} });
}
function payloadOf(res) {
  if (!res || res.ok !== true || !res.output || typeof res.output.stdout !== 'string') return null;
  try { return JSON.parse(res.output.stdout.trim()); } catch (_e) { return null; }
}

(async () => {
  const PACK_HOME = 'tfpack-test-home';
  const PACK_NPM = 'tfpack-test-npm';
  let scratch = null;
  let fatal = null;

  try {
    // ── R - the requires preflight ────────────────────────────────────────────────────────────
    check('R: parseVersion pulls dotted numerics out of real version banners', () => {
      assert.deepStrictEqual(parseVersion('Python 3.12.1'), [3, 12, 1]);
      assert.deepStrictEqual(parseVersion('v18.20'), [18, 20, 0]);
      assert.strictEqual(parseVersion('no digits here'), null);
    });
    check('R: compareVersions orders correctly', () => {
      assert.strictEqual(compareVersions([3, 10, 0], [3, 9, 9]), 1);
      assert.strictEqual(compareVersions([3, 10, 0], [3, 10, 0]), 0);
      assert.strictEqual(compareVersions([2, 9, 9], [3, 0, 0]), -1);
    });

    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-req-'));
    fs.writeFileSync(path.join(scratch, 'toolfunnel.json'), JSON.stringify({
      serverName: 'req-test',
      requires: [
        { command: 'node', min: '10' },                                  // satisfiable everywhere this suite runs
        { command: 'definitely-not-a-real-command-xyz', why: 'testing' }, // not found
        { command: 'node', min: '999' },                                  // impossible min
        { command: 'x&calc' },                                            // shell-shaped: must be REJECTED, never probed
        { command: 'C:\\evil\\tool.exe' },                                // a path: same
      ],
    }, null, 2) + '\n');
    const problems = checkRequires(scratch);
    check('R: checkRequires - satisfied passes, missing + too-old are each ONE advisory problem', () => {
      assert.ok(problems.some((p) => /not found/i.test(p.problem) && /testing/.test(p.problem)), 'missing-command problem absent: ' + JSON.stringify(problems));
      assert.ok(problems.some((p) => /999/.test(p.problem)), 'too-old problem absent: ' + JSON.stringify(problems));
    });
    check('R: a shell-shaped or path-shaped requires.command is REJECTED before any probe runs', () => {
      assert.strictEqual(problems.length, 4, 'problems: ' + JSON.stringify(problems));
      const bareName = problems.filter((p) => /bare program name/.test(p.problem));
      assert.strictEqual(bareName.length, 2, 'expected 2 bare-name rejections; got ' + JSON.stringify(problems));
    });
    check('R: a home with no toolfunnel.json declares nothing (empty list, no throw)', () => {
      assert.deepStrictEqual(checkRequires(path.join(scratch, 'no-such-dir')), []);
    });

    // ── P - format "home" ─────────────────────────────────────────────────────────────────────
    const home1 = payloadOf(await runTool('tf_pack', { format: 'home', name: PACK_HOME }));
    check('P: tf_pack format "home" succeeds through the gated run path', () => {
      assert.ok(home1 && home1.ok === true, 'payload: ' + JSON.stringify(home1));
      assert.strictEqual(home1.format, 'home');
      assert.ok(Array.isArray(home1.next) && home1.next.length > 0, 'next-steps missing');
    });
    const outHome = path.join(DIST, PACK_HOME);
    check('P: the pack carries the four pillars + a REWRITTEN identity, and no auth/ or logs/', () => {
      assert.ok(fs.existsSync(path.join(outHome, 'tools', 'tools.register.json')), 'register missing');
      assert.ok(fs.existsSync(path.join(outHome, 'tools', 'scripts', 'tf-pack.js')), 'scripts missing');
      assert.ok(fs.existsSync(path.join(outHome, 'hooks', 'hooks.manifest.json')), 'hooks missing');
      assert.ok(fs.existsSync(path.join(outHome, 'mcp', 'expose.json')), 'expose missing');
      const id = JSON.parse(fs.readFileSync(path.join(outHome, 'toolfunnel.json'), 'utf8'));
      assert.strictEqual(id.serverName, PACK_HOME, 'identity not rewritten: ' + JSON.stringify(id));
      assert.ok(!fs.existsSync(path.join(outHome, 'auth')), 'auth/ must NEVER ship');
      assert.ok(!fs.existsSync(path.join(outHome, 'logs')), 'logs/ must NEVER ship');
      assert.ok(!fs.existsSync(path.join(outHome, 'dist')), 'dist/ recursion must be excluded');
    });
    const refuse = payloadOf(await runTool('tf_pack', { format: 'home', name: PACK_HOME }));
    check('P: a non-empty destination is refused without force (and force overwrites)', () => {
      assert.ok(refuse && refuse.ok === false && /force/.test(refuse.error), 'refusal payload: ' + JSON.stringify(refuse));
    });

    // ── N - format "npm" ──────────────────────────────────────────────────────────────────────
    const npm = payloadOf(await runTool('tf_pack', {
      format: 'npm', name: 'TFPack Test Npm', version: '1.0.0', out: PACK_NPM, description: 'pack.test.js fixture',
    }));
    const sanitized = 'tfpack-test-npm';
    const outNpm = path.join(DIST, PACK_NPM);
    check('N: tf_pack format "npm" succeeds and sanitizes the name for npm', () => {
      assert.ok(npm && npm.ok === true, 'payload: ' + JSON.stringify(npm));
      assert.ok(npm.next.some((n) => /npm publish/.test(n)), 'publish hint missing: ' + JSON.stringify(npm.next));
    });
    check('N: the generated package.json depends on toolfunnel (caret) and whitelists bin/ + home/', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(outNpm, 'package.json'), 'utf8'));
      assert.strictEqual(pkg.name, sanitized, 'name: ' + pkg.name);
      assert.strictEqual(pkg.version, '1.0.0');
      assert.ok(/^\^/.test(pkg.dependencies && pkg.dependencies.toolfunnel), 'toolfunnel caret dep missing: ' + JSON.stringify(pkg.dependencies));
      assert.deepStrictEqual(pkg.files, ['bin/', 'home/']);
      assert.strictEqual(pkg.bin[sanitized], `bin/${sanitized}.js`);
    });
    check('N: the launcher pins --config-dir at the bundled home (with an env override knob)', () => {
      const bin = fs.readFileSync(path.join(outNpm, 'bin', `${sanitized}.js`), 'utf8');
      assert.ok(bin.includes("'--config-dir'"), 'launcher does not pass --config-dir');
      assert.ok(bin.includes("require('toolfunnel/bin/toolfunnel.js')"), 'launcher does not delegate to toolfunnel');
      assert.ok(bin.includes('TFPACK_TEST_NPM_HOME'), 'env override knob missing');
    });
    check('N: the bundled home + README stub are present', () => {
      assert.ok(fs.existsSync(path.join(outNpm, 'home', 'tools', 'tools.register.json')), 'bundled home missing');
      const readme = fs.readFileSync(path.join(outNpm, 'README.md'), 'utf8');
      assert.ok(/expose\.json/.test(readme), 'audit-honesty line missing from README');
    });
  } catch (err) {
    fatal = err;
  } finally {
    for (const name of [PACK_HOME, PACK_NPM]) {
      try { fs.rmSync(path.join(DIST, name), { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
    }
    try { if (fs.existsSync(DIST) && fs.readdirSync(DIST).length === 0) fs.rmdirSync(DIST); } catch (_e) { /* best-effort */ }
    if (scratch) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_e) { /* best-effort */ } }
  }

  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));

  const passed = results.filter((r) => r.ok).length;
  const expected = 12;
  const ok = !fatal && passed === results.length && results.length === expected;
  if (ok) {
    console.log(`\nPASS: pack test - ${passed}/${expected} assertions passed (requires preflight; tf_pack home + npm formats; depend-not-copy; separate-location guarantee)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: pack test - ${passed}/${results.length} assertions passed`);
    process.exit(1);
  }
})().catch((e) => { console.log('PACK TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
