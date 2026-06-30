'use strict';

/**
 * reconnect.test.js — proves AUTO-RECONNECT: when an attached upstream MCP's child process dies
 * mid-session, ToolFunnel detects it (McpClient.onClose), drops it, and reconnects it in the
 * BACKGROUND with no restart and no user intervention — then the tool works again.
 *
 * Spawns the REAL gateway (`node bin/toolfunnel.js`, stdio) with the bundled mock upstream attached
 * (no expose[] — lean by default). Asserts:
 *
 *   A — BEFORE:    toolfunnel_list_tools lists mock_ping (upstream connected at boot).
 *   B — CRASH:     toolfunnel_run_tool{mock_crash} makes the mock child process.exit — the upstream dies.
 *   C — RECOVER:   within a backoff window, mock_ping REAPPEARS in the lean list and runs again
 *                  ("pong"), with NO restart — proving the background reconnect healed it.
 *   D — SIGNALLED: a notifications/tools/list_changed was emitted (so a client refreshes), and the
 *                  activity log records the full cycle: {type:mcp,event:disconnect,reason:died}
 *                  then {type:mcp,event:reconnect}.
 *
 * NON-DESTRUCTIVE: mcp/expose.json, hooks/hooks.manifest.json and logs/log.config.json are
 * snapshotted and restored (or re-absent); the dedicated test log is removed. Node built-ins only.
 *
 * Run:  node test/reconnect.test.js     (exit 0 = pass, non-zero = fail)
 */

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const EXPOSE_PATH = path.join(REPO_ROOT, 'mcp', 'expose.json');
const MANIFEST_PATH = path.join(REPO_ROOT, 'hooks', 'hooks.manifest.json');
const MOCK_SERVER = path.join(REPO_ROOT, 'mcp', 'servers', 'mock-upstream', 'server.js');
const LOG_CONFIG_PATH = path.join(REPO_ROOT, 'logs', 'log.config.json');
const TEST_LOG_REL = 'logs/test-reconnect.' + process.pid + '.jsonl';
const TEST_LOG_PATH = path.join(REPO_ROOT, TEST_LOG_REL);

const REQUEST_TIMEOUT_MS = 12000;
const RECOVER_BUDGET_MS = 15000; // first backoff is ~1s; allow for spawn+initialize+list + slack

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function snapshot(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_e) { return null; } }
function restore(p, snap) {
  try {
    if (snap === null) { if (fs.existsSync(p)) fs.unlinkSync(p); }
    else { fs.writeFileSync(p, snap); }
  } catch (_e) { /* best-effort */ }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeClient(child) {
  let nextId = 1;
  let buf = '';
  let stderr = '';
  const pending = new Map();
  const notifications = [];
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
      } else if (obj && typeof obj.method === 'string' && !Object.prototype.hasOwnProperty.call(obj, 'id')) {
        notifications.push(obj.method);
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  function request(method, params) {
    const id = nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    const byteLen = Buffer.byteLength(body, 'utf8');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for "${method}" (id ${id})`)); }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`Content-Length: ${byteLen}\r\n\r\n${body}`);
    });
  }
  function rejectAll(err) { for (const [, w] of pending) { clearTimeout(w.timer); w.reject(err); } pending.clear(); }
  return { request, rejectAll, getStderr: () => stderr, sawListChanged: () => notifications.includes('notifications/tools/list_changed') };
}

function callText(resp) {
  const c = resp && resp.result && resp.result.content;
  return Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : '';
}
function listIds(resp) {
  try { const arr = JSON.parse(callText(resp)); return Array.isArray(arr) ? arr.map((b) => b && b.id) : []; } catch (_e) { return []; }
}
function exposeConfig() {
  return JSON.stringify({
    version: 1,
    upstreams: [{ id: 'mock', transport: 'stdio', command: process.execPath, args: [MOCK_SERVER], enabled: true, description: 'reconnect.test.js fixture.' }],
    // Expose ping curated-direct so the upstream is on the TOP-LEVEL surface: its death/recovery then
    // legitimately changes tools/list and emits notifications/tools/list_changed (assertion D). A
    // lean-only upstream no longer over-fires that notification (review fix), so the fixture must put
    // the upstream on the top-level surface for the signal to be real.
    expose: [{ upstream: 'mock', tool: 'ping', as: 'mock_ping', category: 'demo', enabled: true }],
  }, null, 2) + '\n';
}

(async () => {
  const exposeSnap = snapshot(EXPOSE_PATH);
  const manifestSnap = snapshot(MANIFEST_PATH);
  const logCfgSnap = snapshot(LOG_CONFIG_PATH);
  let child = null;
  let fatal = null;

  try {
    assert.ok(fs.existsSync(MOCK_SERVER), 'mock upstream missing at ' + MOCK_SERVER);
    fs.mkdirSync(path.dirname(LOG_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(LOG_CONFIG_PATH, JSON.stringify({ enabled: true, path: TEST_LOG_REL }, null, 2) + '\n');
    fs.writeFileSync(EXPOSE_PATH, exposeConfig());
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ version: 1, hooks: [] }, null, 2) + '\n');

    child = spawn(process.execPath, [ENTRY], { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const client = makeClient(child);
    child.on('error', (err) => client.rejectAll(new Error('child error: ' + ((err && err.message) || err))));
    await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'reconnect.test.js', version: '0.0.0' } });

    // A — connected at boot
    const before = await client.request('tools/call', { name: 'toolfunnel_list_tools', arguments: {} });
    check('BEFORE: mock_ping is listed (upstream connected at boot)', () => {
      assert.ok(listIds(before).includes('mock_ping'), 'mock_ping not listed at boot; got: ' + JSON.stringify(listIds(before)));
    });

    // B — crash the upstream child (the mock process.exit's without replying; the run returns isError)
    await client.request('tools/call', { name: 'toolfunnel_run_tool', arguments: { name: 'mock_crash' } }).catch(() => null);

    // C — within a backoff window, the background reconnect brings mock_ping back, runnable.
    const deadline = Date.now() + RECOVER_BUDGET_MS;
    let recovered = false;
    while (Date.now() < deadline) {
      await sleep(500);
      const list = await client.request('tools/call', { name: 'toolfunnel_list_tools', arguments: {} }).catch(() => null);
      if (list && listIds(list).includes('mock_ping')) { recovered = true; break; }
    }
    check('RECOVER: mock_ping reappears after the crash (background auto-reconnect, no restart)', () => {
      assert.ok(recovered, 'mock_ping never came back within ' + RECOVER_BUDGET_MS + 'ms of the crash');
    });
    const ping = await client.request('tools/call', { name: 'toolfunnel_run_tool', arguments: { name: 'mock_ping' } });
    check('RECOVER: the reconnected mock_ping runs and returns "pong"', () => {
      assert.strictEqual(callText(ping), 'pong', 'expected "pong" after reconnect, got ' + JSON.stringify(callText(ping)));
    });

    // D — the recovery was signalled (list_changed) and the full cycle is logged.
    check('SIGNALLED: a notifications/tools/list_changed was emitted during the cycle', () => {
      assert.ok(client.sawListChanged(), 'no tools/list_changed notification was observed across the crash+recover cycle');
    });
    await sleep(150);
    let log = [];
    try { log = fs.readFileSync(TEST_LOG_PATH, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean); } catch (_e) { /* asserts below fail clearly */ }
    check('LOG: the death was logged ({type:mcp,event:disconnect,reason:died})', () => {
      assert.ok(log.some((r) => r && r.type === 'mcp' && r.event === 'disconnect' && r.reason === 'died' && r.upstream === 'mock'),
        'no died-disconnect log line; mcp lines: ' + JSON.stringify(log.filter((r) => r && r.type === 'mcp')));
    });
    check('LOG: the recovery was logged ({type:mcp,event:reconnect})', () => {
      assert.ok(log.some((r) => r && r.type === 'mcp' && r.event === 'reconnect' && r.upstream === 'mock'),
        'no reconnect log line; mcp lines: ' + JSON.stringify(log.filter((r) => r && r.type === 'mcp')));
    });
  } catch (err) {
    fatal = err;
  } finally {
    if (child && !child.killed && child.exitCode === null) {
      try { child.stdin.end(); } catch (_e) { /* ignore */ }
      try { child.kill(); } catch (_e) { /* ignore */ }
    }
    restore(EXPOSE_PATH, exposeSnap);
    restore(MANIFEST_PATH, manifestSnap);
    restore(LOG_CONFIG_PATH, logCfgSnap);
    try { if (fs.existsSync(TEST_LOG_PATH)) fs.unlinkSync(TEST_LOG_PATH); } catch (_e) { /* best-effort */ }
  }

  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));

  const passed = results.filter((r) => r.ok).length;
  const expected = 6;
  const ok = !fatal && passed === results.length && results.length === expected;
  if (ok) {
    console.log(`\nPASS: reconnect test — ${passed}/${expected} assertions passed (upstream crash detected, background auto-reconnect with no restart, list_changed + cycle logged)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: reconnect test — ${passed}/${results.length} assertions passed`);
    process.exit(1);
  }
})().catch((e) => { console.log('RECONNECT TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
