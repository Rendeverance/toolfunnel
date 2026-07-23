'use strict';

/**
 * http-concurrency.test.js - multi-client HTTP under load.
 *
 * The sharpest concurrency question this gateway has: does ONE slow tool stall every other
 * client? The answer used to be yes - runShell used spawnSync, freezing the event loop
 * for the shell tool's whole duration, so N concurrent HTTP clients serialised behind it.
 *
 * A REAL host is spawned (bin/toolfunnel.js --http) over a temp config home whose register
 * carries one deliberately slow shell tool (~4 s) and one fast shell tool. Five independent
 * HTTP clients fire CONCURRENTLY: 1 × slow + 4 × fast.
 *
 *   A - every FAST call completes while the slow one is still running (< 2.5 s; the pre-fix
 *       behaviour was each fast call taking 4 s+ behind the frozen loop).
 *   B - the SLOW call still completes correctly (~4 s, its own stdout intact).
 *   C - responses land on the right requests (no cross-talk between concurrent clients).
 *   D - the host serves normally afterwards.
 *
 * Run:  node test/http-concurrency.test.js     (exit 0 = pass, non-zero = fail)
 */

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const PORT = 39640; // fixed high port, same convention as http-reload.test.js

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(body) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, method: 'POST', path: '/mcp',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_e) { /* null */ }
        resolve({ status: res.statusCode, json, ms: Date.now() - t0 });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function health() {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: '/health' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  // ── temp home: two shell tools, one slow, one fast ──────────────────────────────────────────
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-conc-'));
  fs.mkdirSync(path.join(home, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(home, 'slow.js'),
    "setTimeout(() => { console.log('slow done'); }, 4000);\n");
  fs.writeFileSync(path.join(home, 'fast.js'),
    "console.log('fast done ' + (process.env.TOOLFUNNEL_TOOL_ARGS || ''));\n");
  const nodeCmd = (f) => '"' + process.execPath + '" "' + path.join(home, f) + '"';
  fs.writeFileSync(path.join(home, 'tools', 'tools.register.json'), JSON.stringify({
    version: 1,
    description: 'concurrency-test register',
    tools: [
      { id: 'slowtool', name: 'Slow Tool', summary: 'sleeps 4s', category: 'test',
        instructions: 'no args', invoke: { type: 'shell', command: nodeCmd('slow.js') } },
      { id: 'fasttool', name: 'Fast Tool', summary: 'answers at once', category: 'test',
        instructions: 'no args', invoke: { type: 'shell', command: nodeCmd('fast.js') } },
    ],
  }, null, 2));

  const child = spawn(process.execPath, [BIN, '--http', '--port', String(PORT), '--config-dir', home],
    { cwd: REPO_ROOT, stdio: 'ignore' });

  try {
    let up = false;
    for (let i = 0; i < 50; i += 1) {
      try { if ((await health()) === 200) { up = true; break; } } catch (_e) { /* not yet */ }
      await sleep(200);
    }
    check('S: HTTP host is up', () => assert.ok(up, 'host never answered /health'));

    const run = (tool, tag) => post({
      jsonrpc: '2.0', id: tag, method: 'tools/call',
      params: { name: 'toolfunnel_run_tool', arguments: { name: tool, args: { tag } } },
    });

    // ── the hammer: 1 slow + 4 fast, all in flight together ───────────────────────────────────
    const wave = await Promise.all([
      run('slowtool', 'slow-1'),
      run('fasttool', 'fast-1'),
      run('fasttool', 'fast-2'),
      run('fasttool', 'fast-3'),
      run('fasttool', 'fast-4'),
    ]);
    const [slow, ...fasts] = wave;

    check('A: every fast call completed WHILE the slow call ran (no event-loop stall)', () => {
      for (const f of fasts) {
        assert.strictEqual(f.status, 200, 'fast call HTTP ' + f.status);
        assert.ok(f.ms < 2500, 'fast call took ' + f.ms + 'ms - serialised behind the slow tool');
      }
    });
    check('B: the slow call completed correctly on its own clock', () => {
      assert.strictEqual(slow.status, 200, 'slow call HTTP ' + slow.status);
      assert.ok(slow.ms >= 3500, 'slow call finished implausibly fast (' + slow.ms + 'ms)');
      const text = JSON.stringify(slow.json);
      assert.ok(text.includes('slow done'), 'slow stdout missing: ' + text.slice(0, 300));
    });
    check('C: no cross-talk - each response answers its own request id with its own payload', () => {
      assert.strictEqual(slow.json.id, 'slow-1');
      for (const f of fasts) {
        assert.ok(String(f.json.id).startsWith('fast-'), 'wrong id ' + f.json.id);
        const text = JSON.stringify(f.json);
        assert.ok(text.includes('fast done'), 'fast payload wrong: ' + text.slice(0, 300));
        assert.ok(!text.includes('slow done'), 'slow output leaked into a fast response');
      }
    });

    const after = await run('fasttool', 'after-1');
    check('D: the host serves normally after the wave', () => {
      assert.strictEqual(after.status, 200);
      assert.ok(JSON.stringify(after.json).includes('fast done'));
    });
  } finally {
    try { child.kill(); } catch (_e) { /* already gone */ }
  }
  await sleep(300);
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }

  let failed = 0;
  for (const r of results) {
    console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
    if (!r.ok) failed++;
  }
  console.log(failed === 0
    ? `PASS: http-concurrency test - ${results.length}/${results.length} assertions passed`
    : `FAIL: http-concurrency test - ${results.length - failed}/${results.length} assertions passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => { console.error('http-concurrency test crashed:', err); process.exit(1); });
