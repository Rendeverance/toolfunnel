'use strict';

/**
 * ui-partial-write.test.js - a UI authoring reply that reports failure must leave
 * NO partial state behind (0.7.0).
 *
 * Both authoring endpoints make TWO writes (a config row and a script body). When
 * the second write throws, the endpoint answers 400 - but the first write had
 * already landed, so the "failed" add half-exists:
 *
 *   - POST /api/hooks/add: addEntry persisted the manifest row, then writeScript
 *     refused the script slot. The natural retry then dies on its OWN first
 *     attempt - "a hook with id ... already exists".
 *   - POST /api/tools/add: writeScript authored the script body, then
 *     registry.add refused the entry (duplicate id, bad shape). The register is
 *     clean but the scripts dir keeps an orphan file no entry references.
 *
 * The contract this file pins: a 400 from either endpoint leaves the manifest,
 * the register, and the scripts dir byte-for-byte as they were before the call.
 *
 * All state is a temp home, removed in finally (harness mirrors
 * matcher-compile.test.js). Node built-ins only. CommonJS.
 * Run:  node test/ui-partial-write.test.js
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const { createUiServer } = require(path.join(REPO_ROOT, 'src', 'ui', 'server.js'));

let fails = 0;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

/** Minimal config home so createUiServer can start against a temp root. */
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-partial-ui-'));
  for (const d of ['mcp', 'hooks', 'tools']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.mkdirSync(path.join(home, 'hooks', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(home, 'tools', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(home, 'tools', 'tools.register.json'), JSON.stringify({
    version: 1,
    tools: [{ id: 'echo', name: 'echo', summary: 's', category: 'demo', instructions: 'i', invoke: { type: 'script', path: 'scripts/echo.js' } }],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(home, 'tools', 'scripts', 'echo.js'), 'console.log("{}");\n');
  fs.writeFileSync(path.join(home, 'mcp', 'expose.json'), JSON.stringify({ version: 1, upstreams: [], expose: [] }, null, 2) + '\n');
  fs.writeFileSync(path.join(home, 'tools', 'tools.state.json'), '{}\n');
  fs.writeFileSync(path.join(home, 'hooks', 'hooks.manifest.json'), JSON.stringify({ version: 1, hooks: [] }, null, 2) + '\n');
  return home;
}

function post(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: urlPath,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        Origin: 'http://127.0.0.1:' + port,
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_e) { /* leave null */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  const cleanups = [];
  try {
    // ── A. /api/hooks/add: a refused script slot must not keep the manifest row. ──────────
    {
      const home = makeHome();
      cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
      const manifestPath = path.join(home, 'hooks', 'hooks.manifest.json');
      const before = fs.readFileSync(manifestPath, 'utf8');

      const handle = createUiServer({ host: '127.0.0.1', port: 0, root: home });
      const started = await handle.start();
      try {
        // `script` resolves outside hooks/scripts, so addEntry accepts the row and
        // writeScript then refuses the slot - the second write fails after the first landed.
        const entry = {
          id: 'ui/slot-refused',
          event: 'PostToolUse',
          matcher: 'never-matches-anything',
          command: 'node -e ""',
          script: '../outside.js',
          scriptText: 'console.log("body");\n',
          enabled: false,
        };
        const r = await post(started.port, '/api/hooks/add', { entry });
        check('HOOKS-ADD: a refused script slot answers 400',
          r.status === 400, `status = ${r.status} body = ${r.raw}`);
        check('HOOKS-ADD: the manifest is byte-identical after the failure reply',
          fs.readFileSync(manifestPath, 'utf8') === before,
          'manifest now = ' + fs.readFileSync(manifestPath, 'utf8'));

        // The natural retry (same id, corrected script) must be judged on its own
        // merits - not refused as a duplicate of the half-written first attempt.
        const retry = await post(started.port, '/api/hooks/add', {
          entry: { ...entry, script: 'scripts/slot-ok.js', command: 'node "${HOOKS_DIR}/scripts/slot-ok.js"' },
        });
        check('HOOKS-ADD: the corrected retry succeeds (no duplicate-id residue)',
          retry.status === 200 && retry.json && retry.json.ok === true,
          `status = ${retry.status} body = ${retry.raw}`);
      } finally {
        try { await handle.stop(); } catch (_e) { /* ignore */ }
      }
    }
    // ── B. /api/tools/add: a refused register entry must not keep the script body. ────────
    {
      const home = makeHome();
      cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
      const registerPath = path.join(home, 'tools', 'tools.register.json');
      const registerBefore = fs.readFileSync(registerPath, 'utf8');
      const echoPath = path.join(home, 'tools', 'scripts', 'echo.js');
      const echoBefore = fs.readFileSync(echoPath, 'utf8');

      const handle = createUiServer({ host: '127.0.0.1', port: 0, root: home });
      const started = await handle.start();
      try {
        // Duplicate id: the script body lands first, then registry.add refuses the
        // entry - the second write fails after the first landed.
        const dupe = await post(started.port, '/api/tools/add', {
          entry: {
            id: 'echo', name: 'echo', summary: 's', category: 'demo', instructions: 'i',
            invoke: { type: 'script', path: 'scripts/dupe.js' },
            scriptText: 'console.log("orphan");\n',
          },
        });
        check('TOOLS-ADD: a duplicate id answers 400',
          dupe.status === 400, `status = ${dupe.status} body = ${dupe.raw}`);
        check('TOOLS-ADD: no script file is left behind after the failure reply',
          !fs.existsSync(path.join(home, 'tools', 'scripts', 'dupe.js')),
          'tools/scripts/dupe.js exists');
        check('TOOLS-ADD: the register is byte-identical after the failure reply',
          fs.readFileSync(registerPath, 'utf8') === registerBefore, 'register changed');

        // A refused entry aimed at an EXISTING slot must put the previous body back -
        // absent stays absent, an overwritten body returns.
        const clobber = await post(started.port, '/api/tools/add', {
          entry: {
            id: 'echo2', // new id, but the entry is invalid (no name), so add refuses it
            invoke: { type: 'script', path: 'scripts/echo.js' },
            scriptText: 'console.log("clobbered");\n',
          },
        });
        check('TOOLS-ADD: an invalid entry answers 400',
          clobber.status === 400, `status = ${clobber.status} body = ${clobber.raw}`);
        check('TOOLS-ADD: an overwritten script body is restored after the failure reply',
          fs.readFileSync(echoPath, 'utf8') === echoBefore,
          'echo.js now = ' + fs.readFileSync(echoPath, 'utf8'));
      } finally {
        try { await handle.stop(); } catch (_e) { /* ignore */ }
      }
    }
  } catch (e) {
    fails += 1;
    console.log('CRASHED: ' + ((e && e.stack) || e));
  } finally {
    for (const fn of cleanups.reverse()) { try { fn(); } catch (_e) { /* best-effort */ } }
  }

  console.log(fails ? `\n${fails} ui-partial-write failure(s).` : '\nui-partial-write contract holds.');
  process.exit(fails ? 1 : 0);
})();
