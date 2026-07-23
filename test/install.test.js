'use strict';

/**
 * install.test.js - proves the ROBUST on-demand OAuth-dependency installer (src/auth/install.js).
 *
 * The hard-won fix this guards: on Windows / portable Node, spawning `npm.cmd` throws EINVAL since the
 * CVE-2024-27980 mitigation, and spawning it via a shell misresolves the shim's own npm-cli.js. The
 * robust path is to run npm's JS entry (`npm-cli.js`, located BESIDE the running node binary) with
 * `process.execPath` directly - no shell, no .cmd shim, no PATH/cwd sensitivity. A strict allowlist on
 * the version spec keeps the shell fallback non-injectable.
 *
 * Asserts (no network, no actual install - jose is already present as a devDependency, so installJose
 * short-circuits):
 *   1. findNpmCli() locates an EXISTING npm-cli.js (the node+cli path the fix relies on). The suite is
 *      run by a node that ships npm beside it (you need npm to install/run the package), so it resolves.
 *   2. SPEC_RE accepts real specs (name@range, caret/tilde, scopes, dist-tags) and REFUSES anything a
 *      shell could act on (`;`, `&&`, `$()`, spaces) - the injection guard for the fallback path.
 *   3. installJose() is idempotent: with jose already loadable it resolves { ok:true } reporting
 *      "already installed", WITHOUT shelling out.
 *
 * Convention: standalone node script, exit 0 = pass. Node built-ins only (assert, fs, path).
 * Run:  node test/install.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { installJose, findNpmCli, SPEC_RE } = require(path.join(ROOT, 'src', 'auth', 'install.js'));
const { isJoseInstalled, JOSE_PIN } = require(path.join(ROOT, 'src', 'auth', 'resource-server.js'));

// ── tiny harness ──────────────────────────────────────────────────────────────────────────────────
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

(async () => {
  // ── 1. findNpmCli locates npm's JS entry beside the running node binary. ───────────────────────
  const cli = findNpmCli();
  check('findNpmCli: returns a path (never throws)', () => {
    assert.ok(cli === null || typeof cli === 'string', 'findNpmCli must return string|null - got ' + typeof cli);
  });
  check('findNpmCli: the located npm-cli.js actually EXISTS and is named correctly', () => {
    // The suite runs under a node that ships npm (required to install/run the package), so the
    // node+cli path the install fix depends on must resolve here.
    assert.ok(cli, 'npm-cli.js was not located beside process.execPath - the node+cli install path would fall back');
    assert.strictEqual(path.basename(cli), 'npm-cli.js', 'located file is not npm-cli.js - ' + cli);
    assert.ok(fs.existsSync(cli), 'located npm-cli.js does not exist on disk - ' + cli);
  });

  // ── 2. SPEC_RE is a strict allowlist (the fallback-path injection guard). ──────────────────────
  check('SPEC_RE: accepts the spec shapes a single-package install uses', () => {
    // name@<exact|caret|tilde|x-range|dist-tag> + scoped names. (The gateway only ever installs the
    // caret-pinned jose@^5.10.0; the rest prove the allowlist isn't accidentally too tight.)
    for (const spec of ['jose', 'jose@^5.10.0', 'jose@5.10.0', 'jose@~5.10', 'jose@5.x', '@scope/pkg@~1.2.3', 'jose@latest', 'jose@1.2.3-rc.1']) {
      assert.ok(SPEC_RE.test(spec), 'should accept a legitimate spec: ' + spec);
    }
  });
  check('SPEC_RE: REFUSES shell metacharacters AND comparator/whitespace ranges', () => {
    // Anything a shell could act on, plus comparator/OR/wildcard ranges (`> < = | *` and spaces are
    // shell-meaningful) - deliberately out, since the only real spec is a caret range.
    for (const bad of ['jose; rm -rf /', 'jose && evil', 'jose | cat', '$(whoami)', '`id`', 'jose --no-save x', 'a b c', 'jose\nrm', 'jose@>=5.0.0', 'jose@>=5 <6', 'jose@1 || 2', 'jose@*']) {
      assert.ok(!SPEC_RE.test(bad), 'should refuse a shell-unsafe / non-exact spec: ' + JSON.stringify(bad));
    }
  });

  // ── 3. installJose is idempotent when jose is already present (no shell-out, no network). ──────
  check('precondition: jose is loadable (devDependency present)', () => {
    assert.strictEqual(isJoseInstalled(), true, 'jose must be installed for this suite (it is a devDependency)');
  });
  await checkAsync('installJose: idempotent - already-installed resolves ok:true without installing', async () => {
    const res = await installJose();
    assert.ok(res && res.ok === true, 'result = ' + JSON.stringify(res));
    assert.ok(/already installed/i.test(res.message || ''), 'message should report already-installed - ' + JSON.stringify(res.message));
  });
  check('JOSE_PIN: a non-empty pinned range is exported', () => {
    assert.ok(typeof JOSE_PIN === 'string' && JOSE_PIN.length > 0, 'JOSE_PIN = ' + JSON.stringify(JOSE_PIN));
  });

  for (const r of results) {
    console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const ok = failed === 0 && results.length > 0;

  if (ok) {
    console.log(`\nPASS: install test - ${passed}/${results.length} assertions passed ` +
      `(findNpmCli locates npm-cli.js; SPEC_RE allowlist; installJose idempotent)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: install test - ${passed}/${results.length} assertions passed, ${failed} failed`);
    process.exit(1);
  }
})().catch((e) => {
  console.log('INSTALL TEST CRASHED: ' + ((e && e.stack) || e));
  process.exit(1);
});
