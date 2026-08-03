'use strict';

/**
 * matcher-compile.test.js - a hook matcher that does NOT compile must be refused at authoring
 * time and treated as an unreadable gate at fire time (0.7.0).
 *
 * Shipped behaviour: matcher.js catches the RegExp compile error and returns false - "does not
 * match". For a PreToolUse hook authored to DENY, "does not match" means the hook is never
 * selected and the call PROCEEDS: a typo in the pattern (`Bash(`) silently turns the gate off
 * while POST /api/hooks/add answers 200 and the UI lists the hook as enabled. That inverts the
 * runner's own rule (gate-semantics.test.js): a decision that cannot be READ is denied, and a
 * matcher that cannot be COMPILED cannot be read.
 *
 * The contract this file pins:
 *   1. matcher.matcherError(m) -> null for wildcard/unset/compilable, else the compile message.
 *      `mcp__*` COMPILES (the glob habit makes a valid regex that matches almost nothing) - the
 *      rule refuses only what does not compile; suspicious-but-valid stays the author's call.
 *   2. ENGINE: on a TOOL-BEARING event, an enabled hook whose matcher does not compile DENIES
 *      the call (blocked, reason names the hook), and its command never runs.
 *   3. ENGINE: on a TOOL-LESS event the matcher is ignored (existing contract) - the hook still
 *      fires even with an uncompilable matcher.
 *   4. ENGINE: a compilable non-matching matcher still simply does not fire (no over-reach).
 *   5. LOADER: addEntry refuses an uncompilable matcher and persists nothing - which the UI's
 *      POST /api/hooks/add and the tf_hook_add tool inherit (both wrap addEntry's throw).
 *   6. UI: POST /api/hooks/add with an uncompilable matcher answers 400, manifest unchanged.
 *
 * All state is a temp home / temp fixtures, removed in finally. Node built-ins only. CommonJS.
 * Run:  node test/matcher-compile.test.js
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const { matches, matcherError } = require(path.join(REPO_ROOT, 'src', 'core', 'matcher.js'));
const { loadManifest } = require(path.join(REPO_ROOT, 'src', 'core', 'hook-loader.js'));
const { HookEngine } = require(path.join(REPO_ROOT, 'src', 'core', 'hook-engine.js'));
const { createUiServer } = require(path.join(REPO_ROOT, 'src', 'ui', 'server.js'));

let fails = 0;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

const NODE = JSON.stringify(process.execPath);
const BAD_MATCHER = 'Bash('; // the docket's shape: an unclosed group, RegExp throws
const CTX = { session_id: 't', transcript_path: '', cwd: REPO_ROOT };

/** A sentinel file the hook command creates - proves whether the command ran. */
function sentinel(tag) {
  return path.join(os.tmpdir(), `toolfunnel-matcher-${tag}-${process.pid}-${crypto.randomUUID()}.sentinel`);
}
function writeSentinelCommand(file) {
  const code = `require('node:fs').writeFileSync(${JSON.stringify(file)}, 'ran')`;
  return `${NODE} -e ${JSON.stringify(code)}`;
}

/** Author a fixture manifest under a temp dir and load it. */
function makeEngine(hooks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-matcher-'));
  const manifestPath = path.join(dir, 'hooks.manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, hooks }, null, 2) + '\n');
  return { dir, manifestPath, engine: new HookEngine(loadManifest(manifestPath), { cwd: REPO_ROOT }) };
}

/** Minimal config home so createUiServer can start against a temp root. */
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-matcher-ui-'));
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
    // ── 1. The unit contract: matcherError. ─────────────────────────────────────────────────────
    check('matcherError reports the uncompilable pattern', typeof matcherError(BAD_MATCHER) === 'string',
      `matcherError(${JSON.stringify(BAD_MATCHER)}) = ${JSON.stringify(matcherError(BAD_MATCHER))}`);
    for (const ok of ['Bash|Write', '*', '', undefined, null, 'mcp__*']) {
      check(`matcherError is null for ${JSON.stringify(ok)}`, matcherError(ok) === null,
        `got ${JSON.stringify(matcherError(ok))}`);
    }
    check('matches still refuses to FIRE an uncompilable matcher (it cannot know)',
      matches(BAD_MATCHER, 'Bash') === false, 'matches returned true');

    // ── 2. ENGINE, tool-bearing event: an uncompilable matcher DENIES; the command never runs. ──
    {
      const ran = sentinel('deny');
      const rig = makeEngine([{
        id: 'pre-tool-use/typo-gate', event: 'PreToolUse', matcher: BAD_MATCHER,
        command: writeSentinelCommand(ran), timeout: 10, enabled: true,
      }]);
      cleanups.push(() => fs.rmSync(rig.dir, { recursive: true, force: true }));
      cleanups.push(() => { try { fs.unlinkSync(ran); } catch (_e) { /* absent is the pass */ } });

      const out = await rig.engine.fire('PreToolUse', CTX, { tool_name: 'Bash', tool_input: {} });
      check('ENGINE: a tool-bearing event with an uncompilable matcher is BLOCKED',
        out && out.blocked === true, JSON.stringify(out));
      check('ENGINE: the block reason names the hook and the matcher problem',
        !!(out && typeof out.reason === 'string' && out.reason.includes('typo-gate') && /matcher/i.test(out.reason)),
        'reason = ' + JSON.stringify(out && out.reason));
      check('ENGINE: the hook command never ran (it was never selected)',
        !fs.existsSync(ran), 'sentinel exists - the command executed');
    }

    // ── 3. ENGINE, tool-less event: matcher ignored (existing contract), hook still fires. ─────
    {
      const ran = sentinel('toolless');
      const rig = makeEngine([{
        id: 'session-start/typo-matcher', event: 'SessionStart', matcher: BAD_MATCHER,
        command: writeSentinelCommand(ran), timeout: 10, enabled: true,
      }]);
      cleanups.push(() => fs.rmSync(rig.dir, { recursive: true, force: true }));
      cleanups.push(() => { try { fs.unlinkSync(ran); } catch (_e) { /* ignore */ } });

      const out = await rig.engine.fire('SessionStart', CTX, {});
      check('ENGINE: a tool-less event ignores the matcher (not blocked)',
        out && out.blocked === false, JSON.stringify(out));
      check('ENGINE: the tool-less hook still fired', fs.existsSync(ran),
        'sentinel missing - the hook did not run');
    }

    // ── 4. ENGINE: a compilable non-matching matcher still simply does not fire. ────────────────
    {
      const ran = sentinel('nomatch');
      const rig = makeEngine([{
        id: 'pre-tool-use/other-tool', event: 'PreToolUse', matcher: 'echo',
        command: writeSentinelCommand(ran), timeout: 10, enabled: true,
      }]);
      cleanups.push(() => fs.rmSync(rig.dir, { recursive: true, force: true }));
      cleanups.push(() => { try { fs.unlinkSync(ran); } catch (_e) { /* ignore */ } });

      const out = await rig.engine.fire('PreToolUse', CTX, { tool_name: 'Bash', tool_input: {} });
      check('ENGINE: a valid non-matching matcher is NOT blocked (no over-reach)',
        out && out.blocked === false, JSON.stringify(out));
      check('ENGINE: the non-matching hook did not run', !fs.existsSync(ran),
        'sentinel exists - the command executed');
    }

    // ── 5. LOADER: addEntry refuses; nothing persisted. ─────────────────────────────────────────
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-matcher-add-'));
      cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
      const manifestPath = path.join(dir, 'hooks.manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, hooks: [] }, null, 2) + '\n');
      const before = fs.readFileSync(manifestPath, 'utf8');

      let err = null;
      try {
        loadManifest(manifestPath).addEntry({ id: 'x/typo', event: 'PreToolUse', matcher: BAD_MATCHER, command: 'node -e ""', enabled: true });
      } catch (e) { err = e; }
      check('LOADER: addEntry REFUSES an uncompilable matcher', !!err, 'addEntry accepted it');
      check('LOADER: the refusal names the matcher', !!(err && /matcher/i.test(err.message)),
        'message = ' + JSON.stringify(err && err.message));
      check('LOADER: nothing was persisted by the refused add',
        fs.readFileSync(manifestPath, 'utf8') === before, 'manifest changed');

      let errOk = null;
      try {
        loadManifest(manifestPath).addEntry({ id: 'x/globish', event: 'PreToolUse', matcher: 'mcp__*', command: 'node -e ""', enabled: true });
      } catch (e) { errOk = e; }
      check('LOADER: a compilable glob-habit matcher is still ACCEPTED (rule refuses only uncompilable)',
        errOk === null, 'refused: ' + (errOk && errOk.message));
    }

    // ── 6. UI: POST /api/hooks/add answers 400 for an uncompilable matcher; manifest unchanged. ─
    {
      const home = makeHome();
      cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
      const manifestPath = path.join(home, 'hooks', 'hooks.manifest.json');
      const before = fs.readFileSync(manifestPath, 'utf8');

      const handle = createUiServer({ host: '127.0.0.1', port: 0, root: home });
      const started = await handle.start();
      try {
        const r = await post(started.port, '/api/hooks/add', {
          entry: { id: 'ui/typo', event: 'PreToolUse', matcher: BAD_MATCHER, command: 'node -e ""', enabled: true },
        });
        check('UI: POST /api/hooks/add with an uncompilable matcher answers 400',
          r.status === 400, `status = ${r.status} body = ${r.raw}`);
        check('UI: the 400 body names the matcher',
          !!(r.json && r.json.error && /matcher/i.test(r.json.error)), 'body = ' + r.raw);
        check('UI: the manifest is unchanged after the refusal',
          fs.readFileSync(manifestPath, 'utf8') === before, 'manifest changed');
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

  console.log(fails ? `\n${fails} matcher-compile failure(s).` : '\nmatcher-compile contract holds.');
  process.exit(fails ? 1 : 0);
})();
