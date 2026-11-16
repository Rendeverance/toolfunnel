'use strict';

/**
 * tool-args-stdin.test.js - a tool gets arguments too big for the environment on stdin.
 *
 * A spawn whose environment is over the system's limit throws E2BIG (Linux: 128 KB for one variable; macOS: about
 * 1 MB for all of them). core/tool-args.js then spawns the tool again without TOOLFUNNEL_TOOL_ARGS and with
 * TOOLFUNNEL_TOOL_ARGS_STDIN=1, the arguments on stdin. The limit differs by system (Windows takes megabytes), so
 * the first spawn here throws E2BIG itself for a big environment, the way Linux does.
 *
 *   A - small arguments: env variable set, the same JSON on stdin, no retry.
 *   B - big arguments over a too-small environment: one retry, stdin only, the bundled echo tool reads them whole.
 *   C - a spawn failure that is not about size is not retried.
 *   D - a tool that never reads stdin still finishes (a closed pipe is not an error).
 *   E - a tool whose text does not name TOOLFUNNEL_TOOL_ARGS_STDIN is not run without its arguments: the spawn fails.
 *
 * Run:  node test/tool-args-stdin.test.js     (exit 0 = pass)
 */

const path = require('node:path');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { spawnWithArgs, argsJson, readsStdinArgs, ARGS_ENV, STDIN_FLAG } = require('../src/core/tool-args');

const ECHO = path.resolve(__dirname, '..', 'tools', 'scripts', 'echo.js');
const LIMIT = 128 * 1024; // what Linux allows one variable

// a spawn that behaves like Linux: an environment variable over the limit throws E2BIG
function linuxLike(script, seen) {
  return (env) => {
    seen.push({ hasEnv: ARGS_ENV in env, flag: env[STDIN_FLAG] });
    if (env[ARGS_ENV] && Buffer.byteLength(env[ARGS_ENV]) > LIMIT) {
      const err = new Error('spawn E2BIG');
      err.code = 'E2BIG';
      throw err;
    }
    return spawn(process.execPath, script, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  };
}

function output(child) {
  return new Promise((resolve) => {
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

(async () => {
  await check('A: small arguments go in the env, and on stdin for a tool that reads them there; no retry', async () => {
    const seen = [];
    const script = ['-e', "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({env:process.env.TOOLFUNNEL_TOOL_ARGS,stdin:s})))"];
    const json = argsJson({ text: 'hi' });
    const r = await output(spawnWithArgs(json, linuxLike(script, seen), true));
    assert.strictEqual(seen.length, 1);
    const got = JSON.parse(r.out);
    assert.strictEqual(got.env, json);
    assert.strictEqual(got.stdin, json);
    // a tool that does not say it reads stdin gets it empty: a command that reads stdin as code never sees them
    const r2 = await output(spawnWithArgs(json, linuxLike(script, []), false));
    const got2 = JSON.parse(r2.out);
    assert.strictEqual(got2.env, json);
    assert.strictEqual(got2.stdin, '');
  });

  await check('B: arguments over the env limit arrive on stdin and the bundled echo tool reads them', async () => {
    const seen = [];
    const big = 'x'.repeat(1536 * 1024); // the 1.5 MB that failed in the 0.8.1 report
    const r = await output(spawnWithArgs(argsJson({ text: big }), linuxLike([ECHO], seen), true));
    assert.strictEqual(seen.length, 2, 'one retry');
    assert.deepStrictEqual(seen[1], { hasEnv: false, flag: '1' });
    assert.strictEqual(r.code, 0);
    assert.ok(r.out.includes(big), 'echo saw the whole argument');
  });

  await check('C: a spawn failure that is not about size is thrown, not retried', async () => {
    let calls = 0;
    const start = () => { calls++; const e = new Error('spawn EACCES'); e.code = 'EACCES'; throw e; };
    assert.throws(() => spawnWithArgs(argsJson({ text: 'x'.repeat(200 * 1024) }), start), /EACCES/);
    assert.strictEqual(calls, 1);
  });

  await check('D: a tool that never reads stdin still finishes', async () => {
    const seen = [];
    const r = await output(spawnWithArgs(argsJson({ text: 'y'.repeat(512 * 1024) }), linuxLike(['-e', "process.stdout.write('done')"], seen), true));
    assert.strictEqual(r.out, 'done');
  });

  await check('E: a tool that does not read stdin is not run without its arguments: the spawn fails, naming the fix', async () => {
    const seen = [];
    assert.throws(() => spawnWithArgs(argsJson({ text: 'z'.repeat(200 * 1024) }), linuxLike([ECHO], seen), false),
      (e) => e.code === 'E2BIG' && /TOOLFUNNEL_TOOL_ARGS_STDIN=1/.test(e.message));
    assert.strictEqual(seen.length, 1, 'no second spawn');
    assert.strictEqual(readsStdinArgs(require('node:fs').readFileSync(ECHO, 'utf8')), true, 'the bundled echo says it reads stdin');
  });

  const failed = results.filter((x) => !x.ok);
  for (const x of results) console.log(`${x.ok ? 'ok  ' : 'FAIL'} - ${x.name}${x.ok ? '' : ` (${x.detail})`}`);
  console.log(failed.length ? `FAIL: tool-args-stdin - ${failed.length} failed` : `tool-args-stdin: ${results.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
