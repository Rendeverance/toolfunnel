#!/usr/bin/env node
/**
 * upstream-cwd.test.js - an upstream's RELATIVE cwd resolves against the config home, the same
 * base the isolation guard judged it against.
 *
 * The guard resolves a relative `cwd` (and relative args) against the config home before it
 * accepts the entry. The spawn then handed the raw string to the child, which the OS resolves
 * against the GATEWAY PROCESS's working directory. Whenever the gateway is launched from anywhere
 * other than its home (a host that starts it from the user's project, a relocated --config-dir),
 * a guard-passing `cwd: "sub"` fails to spawn or - worse - lands in an unrelated directory that
 * happens to have that name. The 0.7.0 comment claimed guard-base and spawn-base "agree by
 * construction"; this test makes that true.
 *
 * Shape: a scratch home with the shipped mock copied to <home>/sub/server.js; an upstream entry
 * { cwd: "sub", args: ["server.js"] }; the gateway spawned with its OWN cwd set to the OS temp
 * dir (no "sub" there). tools/call toolfunnel_run_tool sub_ping must answer "pong".
 *
 * Run:  node test/upstream-cwd.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const { makeTempHome } = require('./helpers/temp-home');
const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const REQUEST_TIMEOUT_MS = 45000; // a CEILING, not a wait - generous so a loaded CI box cannot flake it

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

// The home: mock copied into a SUBDIRECTORY, upstream entry relative to it.
const home = makeTempHome({ prefix: 'tf-upstream-cwd-', seed: true });
process.on('exit', () => home.cleanup());
const subDir = path.join(home.home, 'sub');
fs.mkdirSync(subDir, { recursive: true });
fs.copyFileSync(path.join(home.mockDir, 'mock-upstream', 'server.js'), path.join(subDir, 'server.js'));
fs.writeFileSync(home.expose, JSON.stringify({
  version: 1,
  upstreams: [{ id: 'sub', transport: 'stdio', command: process.execPath, args: ['server.js'], cwd: 'sub', env: {}, enabled: true }],
  expose: [],
}, null, 2) + '\n');

function makeClient(child) {
  let nextId = 1;
  let buf = '';
  let stderr = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_e) { continue; }
      if (obj && Object.prototype.hasOwnProperty.call(obj, 'id') && pending.has(obj.id)) {
        const w = pending.get(obj.id); pending.delete(obj.id); clearTimeout(w.timer); w.resolve(obj);
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  function request(method, params) {
    const id = nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for "${method}" (id ${id}); stderr: ${stderr.slice(-800)}`)); }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    });
  }
  return { request, getStderr: () => stderr };
}
function callText(resp) {
  const c = resp && resp.result && resp.result.content;
  return Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : '';
}

(async () => {
  // The gateway's OWN cwd is the OS temp dir: nothing named "sub" lives there.
  const child = spawn(process.execPath, [ENTRY], { cwd: os.tmpdir(), env: home.env(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const client = makeClient(child);
  let fatal = null;
  try {
    await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'upstream-cwd.test', version: '0' } });
    const list = await client.request('tools/call', { name: 'toolfunnel_list_tools', arguments: {} });
    let ids = [];
    try { ids = JSON.parse(callText(list)).map((b) => b && b.id); } catch (_e) { /* asserted below */ }
    check('the upstream declared with a RELATIVE cwd connected (its tools are listed)', () => {
      assert.ok(ids.includes('sub_ping'), 'sub_ping not listed; got ' + JSON.stringify(ids) + '; stderr: ' + client.getStderr().slice(-600));
    });
    const ping = await client.request('tools/call', { name: 'toolfunnel_run_tool', arguments: { name: 'sub_ping', args: {} } });
    check('a call through it runs: the child was spawned in <home>/sub, the base the guard used', () => {
      assert.strictEqual(callText(ping), 'pong', 'got ' + JSON.stringify(ping.result || ping.error));
    });
  } catch (err) {
    fatal = err;
  } finally {
    try { child.stdin.end(); } catch (_e) { /* ignore */ }
    if (child.exitCode === null && !child.killed) { try { child.kill(); } catch (_e) { /* ignore */ } }
  }

  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));
  const passed = results.filter((r) => r.ok).length;
  const expected = 2;
  if (!fatal && passed === results.length && results.length === expected) {
    console.log(`\nPASS: upstream-cwd test - ${passed}/${expected} assertions passed (relative cwd resolves against the home)`);
    process.exit(0);
  }
  console.log(`\nFAIL: upstream-cwd test - ${passed}/${results.length} assertions passed`);
  process.exit(1);
})().catch((e) => { console.log('UPSTREAM-CWD TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
