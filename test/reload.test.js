'use strict';

/**
 * reload.test.js — proves LIVE config hot-reload: attach an upstream MCP to a RUNNING gateway by
 * writing expose.json, with NO restart and NO user intervention.
 *
 * It spawns the REAL gateway (`node bin/toolfunnel.js`, stdio) with an EMPTY expose.json, then
 * writes a new expose.json attaching the bundled mock upstream and asserts the gateway heals itself:
 *
 *   PART A — BEFORE:  tools/list does NOT advertise the forwarded tool (clean start).
 *   PART B — RELOAD:  after writing expose.json, the gateway (via its fs.watch config watcher)
 *                     reconnects, EMITS notifications/tools/list_changed, tools/list now advertises
 *                     the forwarded tool, and calling it returns the upstream's real answer — all
 *                     WITHOUT restarting the gateway.
 *   PART C — LOG:     with the activity log enabled, the reload's connect is recorded — a
 *                     {type:'mcp'} connect/reload line for the upstream AND a {type:'client'}
 *                     connect line from initialize (the connect-logging requirement).
 *   PART D — REGISTER: tools.register.json is hot-reloaded too. A new entry (WITH an authored
 *                     inputSchema) written by "another process" + a hot promotion in
 *                     tools.state.json appears in the top-level tools/list of the RUNNING gateway,
 *                     advertising the authored schema VERBATIM ("your own tools and schemas" —
 *                     the register was previously a startup snapshot: the one unwatched config).
 *
 * NON-DESTRUCTIVE: mcp/expose.json and logs/log.config.json are snapshotted up front and restored
 * (or re-absent) in `finally`; the dedicated test log file is removed. Paths are DERIVED from this
 * file's location (no hardcoded drive/root). Node built-ins only.
 *
 * Run:  node test/reload.test.js     (exit 0 = pass, non-zero = fail)
 */

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const EXPOSE_PATH = path.join(REPO_ROOT, 'mcp', 'expose.json');
const MOCK_SERVER = path.join(REPO_ROOT, 'mcp', 'servers', 'mock-upstream', 'server.js');
const REGISTER_PATH = path.join(REPO_ROOT, 'tools', 'tools.register.json');
const TOOL_STATE_PATH = path.join(REPO_ROOT, 'tools', 'tools.state.json');
const LOG_CONFIG_PATH = path.join(REPO_ROOT, 'logs', 'log.config.json');
const TEST_LOG_REL = 'logs/test-reload.' + process.pid + '.jsonl';
const TEST_LOG_PATH = path.join(REPO_ROOT, TEST_LOG_REL);

const REQUEST_TIMEOUT_MS = 12000;
const RELOAD_BUDGET_MS = 8000; // generous: fs.watch latency + 150ms debounce + connect + handshake

// ── results harness ─────────────────────────────────────────────────────────────────────────
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

// ── snapshot / restore (byte-for-byte; re-absent if it didn't exist) ──────────────────────────
function snapshot(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_e) { return null; } }
function restore(p, snap) {
  try {
    if (snap === null) { if (fs.existsSync(p)) fs.unlinkSync(p); }
    else { fs.writeFileSync(p, snap); }
  } catch (_e) { /* best-effort */ }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── a JSON-RPC-over-stdio client that ALSO captures notifications (no id) ─────────────────────
function makeClient(child) {
  let nextId = 1;
  let buf = '';
  let stderr = '';
  const pending = new Map();
  const notifications = []; // { method, params } for every no-id message the server pushes

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
        const w = pending.get(obj.id);
        pending.delete(obj.id);
        clearTimeout(w.timer);
        w.resolve(obj);
      } else if (obj && typeof obj.method === 'string' && !Object.prototype.hasOwnProperty.call(obj, 'id')) {
        notifications.push({ method: obj.method, params: obj.params });
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  function request(method, params) {
    const id = nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    const byteLen = Buffer.byteLength(body, 'utf8');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for "${method}" (id ${id})`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`Content-Length: ${byteLen}\r\n\r\n${body}`);
    });
  }
  function rejectAll(err) {
    for (const [, w] of pending) { clearTimeout(w.timer); w.reject(err); }
    pending.clear();
  }
  return {
    request,
    rejectAll,
    getStderr: () => stderr,
    sawListChanged: () => notifications.some((n) => n.method === 'notifications/tools/list_changed'),
  };
}

function textOf(resp) {
  const c = resp && resp.result && resp.result.content;
  return Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : '';
}

function listToolNames(resp) {
  const tools = (resp && resp.result && resp.result.tools) || [];
  return tools.map((t) => t && t.name);
}

// expose.json wiring the mock upstream. command = process.execPath (DERIVED node binary), the
// script arg is absolute-inside-root so the aggregator's isolation guard passes.
function exposeConfigWithMock() {
  return JSON.stringify({
    version: 1,
    upstreams: [{
      id: 'mockreload',
      transport: 'stdio',
      command: process.execPath,
      args: [MOCK_SERVER],
      enabled: true,
      description: 'reload.test.js fixture — the bundled mock upstream.',
    }],
    expose: [
      { upstream: 'mockreload', tool: 'ping', as: 'mockreload_ping', category: 'test', enabled: true },
      { upstream: 'mockreload', tool: 'add', as: 'mockreload_add', category: 'test', enabled: true },
    ],
  }, null, 2) + '\n';
}

const EMPTY_EXPOSE = JSON.stringify({ version: 1, upstreams: [], expose: [] }, null, 2) + '\n';

(async () => {
  const exposeSnap = snapshot(EXPOSE_PATH);
  const logCfgSnap = snapshot(LOG_CONFIG_PATH);
  const registerSnap = snapshot(REGISTER_PATH);
  const stateSnap = snapshot(TOOL_STATE_PATH);
  let child = null;
  let fatal = null;

  try {
    assert.ok(fs.existsSync(MOCK_SERVER), 'mock upstream missing at ' + MOCK_SERVER);

    // Enable the activity log to a DEDICATED test path so PART C can assert connect logging without
    // touching the default log. logger reads this config fresh on every call.
    fs.mkdirSync(path.dirname(LOG_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(LOG_CONFIG_PATH, JSON.stringify({ enabled: true, path: TEST_LOG_REL }, null, 2) + '\n');
    // Start the gateway with an EMPTY expose.json (no upstreams).
    fs.writeFileSync(EXPOSE_PATH, EMPTY_EXPOSE);

    child = spawn(process.execPath, [ENTRY], { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const client = makeClient(child);
    child.on('error', (err) => client.rejectAll(new Error('child error: ' + ((err && err.message) || err))));

    await client.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'reload.test.js', version: '0.0.0' },
    });

    // PART A — BEFORE: the forwarded tool is NOT advertised on a clean (empty) start.
    const before = await client.request('tools/list', {});
    check('BEFORE: tools/list does NOT advertise mockreload_ping (clean start)', () => {
      assert.ok(!listToolNames(before).includes('mockreload_ping'),
        'mockreload_ping present before attach; got: ' + JSON.stringify(listToolNames(before)));
    });

    // PART B — RELOAD: attach the mock by WRITING expose.json. The gateway's watcher reconnects.
    fs.writeFileSync(EXPOSE_PATH, exposeConfigWithMock());

    // Poll tools/list until the forwarded tool appears (robust to fs.watch + debounce latency).
    const deadline = Date.now() + RELOAD_BUDGET_MS;
    let appeared = false;
    while (Date.now() < deadline) {
      await sleep(300);
      const list = await client.request('tools/list', {});
      if (listToolNames(list).includes('mockreload_ping')) { appeared = true; break; }
    }
    check('RELOAD: tools/list advertises mockreload_ping after a live attach (NO restart)', () => {
      assert.ok(appeared, 'mockreload_ping never appeared within ' + RELOAD_BUDGET_MS + 'ms of writing expose.json');
    });
    check('RELOAD: gateway emitted notifications/tools/list_changed', () => {
      assert.ok(client.sawListChanged(), 'no tools/list_changed notification was observed');
    });

    // The forwarded call returns the UPSTREAM's real answers — proving it actually connected live.
    const ping = await client.request('tools/call', { name: 'mockreload_ping', arguments: {} });
    check('RELOAD: forwarded mockreload_ping returns the upstream\'s "pong"', () => {
      assert.notStrictEqual(ping.result && ping.result.isError, true, 'ping isError: ' + JSON.stringify(ping.result));
      assert.strictEqual(textOf(ping), 'pong', 'expected "pong", got ' + JSON.stringify(textOf(ping)));
    });
    const add = await client.request('tools/call', { name: 'mockreload_add', arguments: { a: 2, b: 3 } });
    check('RELOAD: forwarded mockreload_add returns 5', () => {
      assert.strictEqual(textOf(add), '5', 'expected "5", got ' + JSON.stringify(textOf(add)));
    });

    // PART C — LOG: the activity log recorded the connect (upstream) AND the client connect.
    // Give the JSONL append a beat to flush, then read the dedicated test log.
    await sleep(150);
    let logLines = [];
    try {
      logLines = fs.readFileSync(TEST_LOG_PATH, 'utf8').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch (_e) { return null; }
      }).filter(Boolean);
    } catch (_e) { /* assertions below will fail clearly */ }

    check('LOG: an upstream connect/reload was logged ({type:"mcp"})', () => {
      const mcp = logLines.filter((r) => r && r.type === 'mcp');
      assert.ok(mcp.some((r) => (r.event === 'connect' && r.upstream === 'mockreload') || r.event === 'reload'),
        'no {type:"mcp"} connect/reload line for "mockreload"; got: ' + JSON.stringify(mcp));
    });
    check('LOG: the client connect was logged ({type:"client", event:"connect"})', () => {
      assert.ok(logLines.some((r) => r && r.type === 'client' && r.event === 'connect'),
        'no {type:"client", event:"connect"} line; got: ' + JSON.stringify(logLines.filter((r) => r && r.type === 'client')));
    });

    // PART D — REGISTER hot-reload: add an entry to tools.register.json from "another process"
    // (this test), promote it hot, and the RUNNING gateway must advertise it — with the authored
    // inputSchema verbatim — in the top-level tools/list. No restart.
    const PROBE_SCHEMA = {
      type: 'object',
      properties: { text: { type: 'string', description: 'probe text' } },
      required: ['text'],
      additionalProperties: false,
    };
    const registerData = JSON.parse(fs.readFileSync(REGISTER_PATH, 'utf8'));
    registerData.tools.push({
      id: 'reloadprobe',
      name: 'Reload Probe',
      summary: 'reload.test.js PART D fixture — never invoked.',
      category: 'test',
      inputSchema: PROBE_SCHEMA,
      invoke: { type: 'script', path: 'scripts/reload-probe.js' }, // list-only; never called
    });
    fs.writeFileSync(REGISTER_PATH, JSON.stringify(registerData, null, 2) + '\n');
    fs.writeFileSync(TOOL_STATE_PATH, JSON.stringify({ reloadprobe: { hot: true } }, null, 2) + '\n');

    const regDeadline = Date.now() + RELOAD_BUDGET_MS;
    let probeDef = null;
    while (Date.now() < regDeadline) {
      await sleep(300);
      const list = await client.request('tools/list', {});
      const tools = (list && list.result && list.result.tools) || [];
      probeDef = tools.find((t) => t && t.name === 'reloadprobe') || null;
      if (probeDef) break;
    }
    check('REGISTER: a live-added + hot-promoted register tool appears in tools/list (NO restart)', () => {
      assert.ok(probeDef, 'reloadprobe never appeared within ' + RELOAD_BUDGET_MS + 'ms of writing the register');
    });
    check('REGISTER: the authored inputSchema is advertised VERBATIM (not the free-form fallback)', () => {
      assert.ok(probeDef, 'no def to inspect (previous check failed)');
      assert.deepStrictEqual(probeDef.inputSchema, PROBE_SCHEMA,
        'advertised schema differs from the authored one; got: ' + JSON.stringify(probeDef && probeDef.inputSchema));
    });
  } catch (err) {
    fatal = err;
  } finally {
    if (child && !child.killed && child.exitCode === null) {
      try { child.stdin.end(); } catch (_e) { /* ignore */ }
      try { child.kill(); } catch (_e) { /* ignore */ }
    }
    restore(EXPOSE_PATH, exposeSnap);
    restore(LOG_CONFIG_PATH, logCfgSnap);
    restore(REGISTER_PATH, registerSnap);
    restore(TOOL_STATE_PATH, stateSnap);
    try { if (fs.existsSync(TEST_LOG_PATH)) fs.unlinkSync(TEST_LOG_PATH); } catch (_e) { /* best-effort */ }
  }

  // ── Report ──────────────────────────────────────────────────────────────────────────────────
  for (const r of results) {
    console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  }
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));

  const passed = results.filter((r) => r.ok).length;
  const ok = !fatal && passed === results.length && results.length === 9;
  const exposeRestored = snapshot(EXPOSE_PATH) === exposeSnap;
  const registerRestored = snapshot(REGISTER_PATH) === registerSnap;
  console.log('restore: expose.json ' + (exposeRestored ? 'OK' : 'MISMATCH') + ', tools.register.json ' + (registerRestored ? 'OK' : 'MISMATCH'));

  if (ok && exposeRestored && registerRestored) {
    console.log(`\nPASS: reload test — ${passed}/9 assertions passed (live attach + live register add with no restart; list_changed emitted; forwarded call works; authored schema advertised; connect logged; config restored)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: reload test — ${passed}/${results.length} assertions passed${exposeRestored ? '' : ' (EXPOSE RESTORE MISMATCH)'}${registerRestored ? '' : ' (REGISTER RESTORE MISMATCH)'}`);
    process.exit(1);
  }
})().catch((e) => {
  console.log('RELOAD TEST CRASHED: ' + ((e && e.stack) || e));
  process.exit(1);
});
