'use strict';

/**
 * lean-forward.test.js - proves the LEAN upstream-forwarding path (slice 2): an attached upstream
 * MCP's tools are reachable through the 4 lean meta-tools (toolfunnel_list_tools / _tool_instructions
 * / _run_tool) BY DEFAULT, with no per-tool curation, executed through the same PreToolUse gate -
 * instead of being injected top-level every turn.
 *
 * Spawns the REAL gateway (`node bin/toolfunnel.js`, stdio) with the bundled mock upstream attached
 * via a snapshotted expose.json that defines the upstream but ZERO expose[] entries (so any tool that
 * shows up is the lean FULL-discovered-set behaviour, not curated-direct). Asserts:
 *
 *   A - LIST:        toolfunnel_list_tools surfaces mock_ping/_add/_echo (surfaced name <id>_<tool>)
 *                    with category "mcp:mock", with NO expose[] curation.
 *   B - INSTRUCTIONS:toolfunnel_tool_instructions{name:'mock_ping'} synthesises docs from the
 *                    discovered description + inputSchema (mentions the upstream + the schema).
 *   C - RUN:         toolfunnel_run_tool{name:'mock_ping'} returns the upstream's "pong" CLEAN (the
 *                    envelope is unwrapped, not double-stringified); {name:'mock_add',a,b} -> sum.
 *   D - GATE PARITY: a PreToolUse deny whose matcher is the LEAN name 'mock_ping' BLOCKS the lean run
 *                    (isError, no "pong") while 'mock_add' still runs - the gate fires on the lean
 *                    name via protocol.runTool -> gatedRun, fail-closed, per-tool.
 *   E - CURATABLE:   with tools.state.json disabling 'mock_add', the lean list drops mock_add but
 *                    keeps mock_ping - the lean list is curatable per-tool, exactly like local tools.
 *
 * NON-DESTRUCTIVE: mcp/expose.json, hooks/hooks.manifest.json and tools/tools.state.json are
 * snapshotted up front and restored (or re-absent) in `finally`. Paths derived from this file's
 * location. Node built-ins only.
 *
 * Run:  node test/lean-forward.test.js     (exit 0 = pass, non-zero = fail)
 */

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const EXPOSE_PATH = path.join(REPO_ROOT, 'mcp', 'expose.json');
const MANIFEST_PATH = path.join(REPO_ROOT, 'hooks', 'hooks.manifest.json');
const TOOL_STATE_PATH = path.join(REPO_ROOT, 'tools', 'tools.state.json');
const MOCK_SERVER = path.join(REPO_ROOT, 'mcp', 'servers', 'mock-upstream', 'server.js');
const DENY_HOOK = path.join(REPO_ROOT, 'test', 'fixtures', 'scripts', 'deny-hook.js');

const REQUEST_TIMEOUT_MS = 12000;

// ── results harness ─────────────────────────────────────────────────────────────────────────
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

// ── JSON-RPC-over-stdio client (Content-Length write, newline-delimited read) ─────────────────
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
        const w = pending.get(obj.id);
        pending.delete(obj.id);
        clearTimeout(w.timer);
        w.resolve(obj);
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
  return { request, rejectAll, getStderr: () => stderr };
}

async function withGateway(fn) {
  const child = spawn(process.execPath, [ENTRY], { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const client = makeClient(child);
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.on('error', (err) => client.rejectAll(new Error('child error: ' + ((err && err.message) || err))));
  try {
    await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'lean-forward.test.js', version: '0.0.0' } });
    return await fn(client);
  } finally {
    try { child.stdin.end(); } catch (_e) { /* ignore */ }
    if (!exited && child.exitCode === null && !child.killed) { try { child.kill(); } catch (_e) { /* ignore */ } }
  }
}

/** Parse the meta-tool tools/call envelope's content[0].text. */
function callText(resp) {
  const c = resp && resp.result && resp.result.content;
  return Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : '';
}
/** toolfunnel_list_tools returns its briefs array JSON-stringified into content[0].text. */
function briefsOf(resp) {
  try { const arr = JSON.parse(callText(resp)); return Array.isArray(arr) ? arr : []; } catch (_e) { return []; }
}

// expose.json: the mock upstream, NO expose[] (full-set lean default). command = process.execPath
// (derived node), script arg absolute-inside-root so the isolation guard passes.
function exposeConfig() {
  return JSON.stringify({
    version: 1,
    upstreams: [{ id: 'mock', transport: 'stdio', command: process.execPath, args: [MOCK_SERVER], enabled: true, description: 'lean-forward.test.js fixture.' }],
    expose: [],
  }, null, 2) + '\n';
}
const EMPTY_MANIFEST = JSON.stringify({ version: 1, hooks: [] }, null, 2) + '\n';
function denyManifest(matcher) {
  const hookPath = DENY_HOOK.split(path.sep).join('/');
  return JSON.stringify({
    version: 1,
    hooks: [{ id: 'pre-tool-use/lean-deny', event: 'PreToolUse', matcher, type: 'command', command: 'node "' + hookPath + '"', timeout: 10, enabled: true, description: 'lean-forward.test.js: deny the lean ' + matcher + '.' }],
  }, null, 2) + '\n';
}

(async () => {
  const exposeSnap = snapshot(EXPOSE_PATH);
  const manifestSnap = snapshot(MANIFEST_PATH);
  const stateSnap = snapshot(TOOL_STATE_PATH);
  let fatal = null;

  try {
    assert.ok(fs.existsSync(MOCK_SERVER), 'mock upstream missing at ' + MOCK_SERVER);
    assert.ok(fs.existsSync(DENY_HOOK), 'deny-hook fixture missing at ' + DENY_HOOK);

    // ── A/B/C - mock attached, no deny, no curation ────────────────────────────────────────────
    fs.writeFileSync(EXPOSE_PATH, exposeConfig());
    fs.writeFileSync(MANIFEST_PATH, EMPTY_MANIFEST);
    restore(TOOL_STATE_PATH, null); // ensure no leftover state

    await withGateway(async (client) => {
      const list = await client.request('tools/call', { name: 'toolfunnel_list_tools', arguments: {} });
      const briefs = briefsOf(list);
      const ids = briefs.map((b) => b && b.id);
      check('LIST: lean list surfaces mock_ping/_add/_echo with NO expose[] curation', () => {
        for (const n of ['mock_ping', 'mock_add', 'mock_echo']) {
          assert.ok(ids.includes(n), 'lean list missing "' + n + '"; got: ' + JSON.stringify(ids));
        }
      });
      check('LIST: a lean upstream brief carries category "mcp:mock"', () => {
        const b = briefs.find((x) => x && x.id === 'mock_ping');
        assert.ok(b && b.category === 'mcp:mock', 'mock_ping category was ' + JSON.stringify(b && b.category));
      });

      const instr = await client.request('tools/call', { name: 'toolfunnel_tool_instructions', arguments: { name: 'mock_ping' } });
      check('INSTRUCTIONS: synthesised for the lean tool (mentions upstream + schema)', () => {
        assert.notStrictEqual(instr.result && instr.result.isError, true, 'instructions reported isError: ' + JSON.stringify(instr.result));
        const txt = callText(instr);
        assert.ok(txt.includes('mock'), 'instructions did not mention the upstream "mock": ' + txt.slice(0, 160));
        assert.ok(/schema/i.test(txt), 'instructions did not mention the input schema');
      });

      const ping = await client.request('tools/call', { name: 'toolfunnel_run_tool', arguments: { name: 'mock_ping' } });
      check('RUN: lean mock_ping forwards and returns a CLEAN "pong" (envelope unwrapped)', () => {
        assert.notStrictEqual(ping.result && ping.result.isError, true, 'run reported isError: ' + JSON.stringify(ping.result));
        assert.strictEqual(callText(ping), 'pong', 'expected "pong", got ' + JSON.stringify(callText(ping)));
      });
      const add = await client.request('tools/call', { name: 'toolfunnel_run_tool', arguments: { name: 'mock_add', args: { a: 2, b: 3 } } });
      check('RUN: lean mock_add forwards args and returns 5', () => {
        assert.strictEqual(callText(add), '5', 'expected "5", got ' + JSON.stringify(callText(add)));
      });

      // A FAILED upstream call (the mock returns isError:true for non-numeric args) must surface as
      // isError - not a false success. (Regression guard for the unwrapEnvelope isError-drop bug.)
      const addErr = await client.request('tools/call', { name: 'toolfunnel_run_tool', arguments: { name: 'mock_add', args: { a: 'x', b: 3 } } });
      check('RUN: a failed upstream call surfaces isError (not reported as success)', () => {
        assert.strictEqual(addErr.result && addErr.result.isError, true, 'expected isError:true for a bad-arg upstream call, got ' + JSON.stringify(addErr.result));
      });
    });

    // ── D - gate parity: deny on the LEAN name blocks the lean run, per-tool ─────────────────────
    fs.writeFileSync(MANIFEST_PATH, denyManifest('mock_ping')); // expose.json still the mock
    await withGateway(async (client) => {
      const blocked = await client.request('tools/call', { name: 'toolfunnel_run_tool', arguments: { name: 'mock_ping' } });
      check('GATE: a PreToolUse deny on the LEAN name blocks the lean run (fail-closed)', () => {
        assert.strictEqual(blocked.result && blocked.result.isError, true, 'expected isError for a blocked lean run, got ' + JSON.stringify(blocked.result));
        assert.notStrictEqual(callText(blocked), 'pong', 'upstream answered "pong" - the gate FAILED OPEN on the lean path');
      });
      const stillRuns = await client.request('tools/call', { name: 'toolfunnel_run_tool', arguments: { name: 'mock_add', args: { a: 4, b: 1 } } });
      check('GATE: a NON-matched lean tool (mock_add) still runs (per-tool gate)', () => {
        assert.strictEqual(callText(stillRuns), '5', 'expected "5", got ' + JSON.stringify(callText(stillRuns)));
      });
    });

    // ── E - the lean list is CURATABLE: disabling mock_add drops it (mock_ping stays) ────────────
    fs.writeFileSync(MANIFEST_PATH, EMPTY_MANIFEST);
    fs.writeFileSync(TOOL_STATE_PATH, JSON.stringify({ mock_add: { enabled: false } }, null, 2) + '\n');
    await withGateway(async (client) => {
      const list = await client.request('tools/call', { name: 'toolfunnel_list_tools', arguments: {} });
      const ids = briefsOf(list).map((b) => b && b.id);
      check('CURATABLE: disabling mock_add drops it from the lean list (mock_ping remains)', () => {
        assert.ok(ids.includes('mock_ping'), 'mock_ping should still be listed; got: ' + JSON.stringify(ids));
        assert.ok(!ids.includes('mock_add'), 'mock_add should be curated OUT of the lean list; got: ' + JSON.stringify(ids));
      });
    });
  } catch (err) {
    fatal = err;
  } finally {
    restore(EXPOSE_PATH, exposeSnap);
    restore(MANIFEST_PATH, manifestSnap);
    restore(TOOL_STATE_PATH, stateSnap);
  }

  // ── Report ──────────────────────────────────────────────────────────────────────────────────
  for (const r of results) {
    console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  }
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));

  const passed = results.filter((r) => r.ok).length;
  const expected = 9;
  const exposeOk = snapshot(EXPOSE_PATH) === exposeSnap;
  const manifestOk = snapshot(MANIFEST_PATH) === manifestSnap;
  const stateOk = snapshot(TOOL_STATE_PATH) === stateSnap;
  console.log('restore: expose.json ' + (exposeOk ? 'OK' : 'MISMATCH') + ', hooks.manifest.json ' + (manifestOk ? 'OK' : 'MISMATCH') + ', tools.state.json ' + (stateOk ? 'OK' : 'MISMATCH'));

  const ok = !fatal && passed === results.length && results.length === expected && exposeOk && manifestOk && stateOk;
  if (ok) {
    console.log(`\nPASS: lean-forward test - ${passed}/${expected} assertions passed (lean list + instructions + forward/unwrap + gate parity on the lean name + curatable list; config restored)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: lean-forward test - ${passed}/${results.length} assertions passed${(exposeOk && manifestOk && stateOk) ? '' : ' (CONFIG RESTORE MISMATCH)'}`);
    process.exit(1);
  }
})().catch((e) => { console.log('LEAN-FORWARD TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
