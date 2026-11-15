#!/usr/bin/env node
/**
 * stdio-orphan.test.js - a stdio gateway whose client has gone exits, and closes its upstreams first.
 *
 * A stdio client ends the session by closing stdin. The gateway answers what was already asked,
 * closes every upstream, and exits 0 - before 0.8.1 it stayed alive. And when the client's end of
 * stdout and stderr is gone (a client that crashed), the first failed write ends the gateway: before
 * 0.8.1 a broken stderr turned every log line into an uncaught exception that logged again, at a
 * full core, forever.
 *
 * Each case spawns the real gateway (bin/toolfunnel.js) in a temp home. The first attaches an
 * upstream that IGNORES stdin EOF, so its pid is gone only if the gateway closed it.
 *
 * Run:  node test/stdio-orphan.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { makeTempHome, REPO_ROOT } = require('./helpers/temp-home');

const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

// An upstream that answers the legacy handshake and then refuses to die on stdin EOF.
const FIXTURE = `'use strict';
const fs = require('fs');
fs.writeFileSync(process.argv[2], String(process.pid));
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue; let m; try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.id === undefined) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    if (m.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stubborn', version: '1.0.0' } });
    else if (m.method === 'tools/list') reply({ tools: [{ name: 'noop', description: 'x', inputSchema: { type: 'object' } }] });
    else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } }) + '\\n');
  }
});
process.stdin.on('end', () => { /* deliberately NOT exiting */ });
setInterval(() => {}, 1000);
`;

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'orphan-test', version: '1.0.0' } } };
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const line = (m) => JSON.stringify(m) + '\n';

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

/** Resolves with the exit code, or null when the child is still running after `ms` (then killed). */
function exitWithin(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(child.exitCode); return; }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_e) { /* ignore */ } resolve(null); }, ms);
    child.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function caseStdinEnd() {
  const T = makeTempHome({ prefix: 'tf-orphan-' });
  const pidFile = path.join(T.mcpDir, 'stubborn.pid'); // inside the home: the isolation guard refuses paths outside it
  const fixture = path.join(T.mcpDir, 'stubborn.js');
  fs.writeFileSync(fixture, FIXTURE);
  T.writeJson(T.expose, {
    version: 1,
    upstreams: [{ id: 'stub', transport: 'stdio', command: process.execPath, args: [fixture, pidFile], enabled: true }],
    expose: [],
  });
  let upPid = null;
  try {
    const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'], env: T.env() });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.write(line(INIT));
    child.stdin.write(line(LIST));
    child.stdin.end(); // the client is done: both questions asked, stdin closed at once
    const code = await exitWithin(child, 20000);
    try { upPid = Number(fs.readFileSync(pidFile, 'utf8')); } catch (_e) { upPid = null; }
    await sleep(300);
    const ids = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).id; } catch (_e) { return undefined; } });
    check('stdin closed: both requests were answered before the exit', () => {
      assert.ok(ids.includes(1) && ids.includes(2), `answered ids ${JSON.stringify(ids)}; stderr: ${err.slice(-300)}`);
    });
    check('stdin closed: the gateway exits 0 on its own', () => {
      assert.strictEqual(code, 0, code === null ? 'still running 20 s after stdin closed' : `exit ${code}; stderr: ${err.slice(-300)}`);
    });
    check('stdin closed: the upstream that ignores stdin EOF is gone', () => {
      assert.ok(upPid, 'the upstream never started (no pid file)');
      assert.ok(!alive(upPid), `upstream pid ${upPid} is still running after the gateway exited`);
    });
  } finally {
    if (upPid && alive(upPid)) { try { process.kill(upPid); } catch (_e) { /* ignore */ } } // never leave it behind
    try { fs.unlinkSync(pidFile); } catch (_e) { /* ignore */ }
    T.cleanup();
  }
}

async function caseBrokenPipes() {
  const T = makeTempHome({ prefix: 'tf-orphan-' });
  try {
    const child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'], env: T.env() });
    // Up and answering first, so the break comes in the middle of a session.
    const first = await new Promise((resolve) => {
      let out = '';
      const t = setTimeout(() => resolve(false), 15000);
      child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) { clearTimeout(t); resolve(true); } });
      child.stdin.write(line(INIT));
    });
    // The client crashes: its ends of stdout and stderr close, stdin stays open (nothing says "done").
    child.stdout.destroy();
    child.stderr.destroy();
    await sleep(200);
    child.stdin.write(line(LIST)); // the answer has nowhere to go
    child.stdin.write('this is not json\n');
    const code = await exitWithin(child, 15000);
    check('broken stdout/stderr: the gateway was answering before the break', () => {
      assert.ok(first, 'no answer to initialize within 15 s');
    });
    check('broken stdout/stderr: the gateway exits instead of running on (or spinning)', () => {
      assert.notStrictEqual(code, null, 'still running 15 s after its client\'s pipes closed');
    });
    try { child.stdin.destroy(); } catch (_e) { /* ignore */ }
  } finally {
    T.cleanup();
  }
}

(async () => {
  await caseStdinEnd();
  await caseBrokenPipes();
  const EXPECTED = 5;
  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  if (passed === results.length && results.length === EXPECTED) {
    console.log(`\nPASS: stdio-orphan test - ${passed}/${EXPECTED} assertions passed (a gateway whose client has gone exits, upstreams closed)`);
    process.exit(0);
  }
  console.log(`\nFAIL: stdio-orphan test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
  process.exit(1);
})().catch((e) => { console.log('STDIO-ORPHAN TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(2); });
