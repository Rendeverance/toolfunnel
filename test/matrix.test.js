'use strict';

/**
 * matrix.test.js — proves the VISIBILITY MATRIX (slice 3): the per-tool `hot` axis that promotes a
 * tool to the TOP-LEVEL tools/list (the every-turn surface) across local + upstream + internal
 * (meta) tools, independently of the lean register (toolfunnel_list_tools) and runnable directly.
 *
 * Spawns the REAL gateway (`node bin/toolfunnel.js`, stdio) ONCE with the bundled mock upstream
 * attached LEAN (no expose[] entry). tools.state.json is read FRESH on every tools/list & tools/call,
 * so the test mutates it BETWEEN assertions and re-requests — proving a hot/enabled toggle is LIVE
 * with no restart. Asserts:
 *
 *   A — DEFAULT:    empty state → tools/list is EXACTLY the 4 meta-tools; the lean upstream tool
 *                   mock_ping is in toolfunnel_list_tools but NOT top-level (lean, not hot).
 *   B — LOCAL HOT:  state {uuid:{hot:true}} → "uuid" appears top-level with an inputSchema; meta intact.
 *   C — DIRECT RUN: tools/call{uuid} runs THROUGH the gate (empty manifest = allowed) and returns a v4 UUID.
 *   D — DISABLED:   state {uuid:{hot:true,enabled:false}} → "uuid" is NOT top-level (disabled overrides hot).
 *   E — HIDE META:  state {toolfunnel_howto:{hot:false}} → toolfunnel_howto drops; the other 3 meta remain.
 *   F — UPSTREAM HOT: state {mock_ping:{hot:true}} → "mock_ping" appears top-level; tools/call{mock_ping}→"pong".
 *   G — NOT PROMOTED: empty state → tools/call{echo} (a real local tool, not hot) → isError (unknown tool):
 *                   the advertised surface == the callable surface (no silent run of a non-promoted tool).
 *
 * NON-DESTRUCTIVE: mcp/expose.json, hooks/hooks.manifest.json and tools/tools.state.json are
 * snapshotted and restored (or re-absent). Node built-ins only.
 *
 * Run:  node test/matrix.test.js     (exit 0 = pass, non-zero = fail)
 */

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const EXPOSE_PATH = path.join(REPO_ROOT, 'mcp', 'expose.json');
const MANIFEST_PATH = path.join(REPO_ROOT, 'hooks', 'hooks.manifest.json');
const STATE_PATH = path.join(REPO_ROOT, 'tools', 'tools.state.json');
const REGISTER_PATH = path.join(REPO_ROOT, 'tools', 'tools.register.json');
const MOCK_SERVER = path.join(REPO_ROOT, 'mcp', 'servers', 'mock-upstream', 'server.js');

// A sacrificial REFERENCE-mode tool injected into the register for phase H (a reference tool executes
// nothing server-side; toolfunnel_run_tool / a direct hot call hands back its instructions).
const REF_ID = 'matrix_ref_demo';
const REF_INSTRUCTIONS = 'Perform this in your own environment: matrix reference demo instructions.';

const REQUEST_TIMEOUT_MS = 12000;
const META = ['toolfunnel_list_tools', 'toolfunnel_tool_instructions', 'toolfunnel_run_tool', 'toolfunnel_howto'];
const UUID_V4 = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

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
function writeState(obj) { fs.writeFileSync(STATE_PATH, JSON.stringify(obj, null, 2) + '\n'); }

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

/** top-level tools/list → array of tool defs [{name, description, inputSchema}]. */
function topLevel(resp) {
  const t = resp && resp.result && resp.result.tools;
  return Array.isArray(t) ? t : [];
}
function topLevelNames(resp) { return topLevel(resp).map((t) => t && t.name); }
/** A tools/call result's first text block. */
function callText(resp) {
  const c = resp && resp.result && resp.result.content;
  return Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : '';
}
function isError(resp) { return !!(resp && resp.result && resp.result.isError === true); }
/** toolfunnel_list_tools (lean) → array of brief ids. */
function leanIds(resp) {
  try { const arr = JSON.parse(callText(resp)); return Array.isArray(arr) ? arr.map((b) => b && b.id) : []; }
  catch (_e) { return []; }
}

/** Strip any REF_ID entry from a raw register text → clean text. Used to sanitise the RESTORE
 *  baseline: a prior run killed before its finally could leave REF_ID on disk; without stripping, the
 *  snapshot would capture it and the restore would re-persist it (a self-perpetuating leak that
 *  silently breaks mode.test.js). NEVER throws — returns the input unchanged on a parse failure. */
function stripRefTool(rawRegister) {
  try {
    const data = JSON.parse(rawRegister);
    if (Array.isArray(data.tools)) data.tools = data.tools.filter((t) => !(t && t.id === REF_ID));
    return JSON.stringify(data, null, 2) + '\n';
  } catch (_e) {
    return rawRegister;
  }
}

/** Inject a reference-mode tool into the register on disk (a fresh boot reads it). The reference tool
 *  has NO invoke (nothing runs server-side). Idempotent. */
function injectReferenceTool(cleanRegister) {
  const data = JSON.parse(cleanRegister);
  data.tools = Array.isArray(data.tools) ? data.tools : [];
  if (!data.tools.some((t) => t && t.id === REF_ID)) {
    data.tools.push({ id: REF_ID, name: REF_ID, summary: 'matrix reference demo', category: 'demo', instructions: REF_INSTRUCTIONS, mode: 'reference' });
  }
  fs.writeFileSync(REGISTER_PATH, JSON.stringify(data, null, 2) + '\n');
}

(async () => {
  const exposeSnap = snapshot(EXPOSE_PATH);
  const manifestSnap = snapshot(MANIFEST_PATH);
  const stateSnap = snapshot(STATE_PATH);
  // The restore baseline is the register with any leaked REF_ID stripped — so a prior killed run can't
  // make this run re-persist the fixture (self-perpetuating leak that silently breaks mode.test.js).
  const registerSnapRaw = snapshot(REGISTER_PATH);
  const registerSnap = registerSnapRaw === null ? null : stripRefTool(registerSnapRaw);
  let child = null;
  let fatal = null;

  try {
    assert.ok(fs.existsSync(MOCK_SERVER), 'mock upstream missing at ' + MOCK_SERVER);
    assert.ok(registerSnap !== null, 'register missing at ' + REGISTER_PATH);

    // GUARD (unit, in-process): a hot UPSTREAM surfaced name that collides with a LOCAL tool's id OR
    // display name must NOT be an upstream-hot route — local-register wins, so the run path never
    // advertises the upstream yet executes the local tool (the display-name-collision wrong-executor bug).
    const srv = require(path.join(REPO_ROOT, 'src', 'mcp', 'server.js'));
    const aggStub = { leanToolDefinitions: () => [{ name: 'collide_name', description: '', inputSchema: {} }] };
    const regCollide = { list: () => [{ id: 'x', name: 'collide_name', summary: '', category: '' }] };
    const regNoCollide = { list: () => [{ id: 'x', name: 'y', summary: '', category: '' }] };
    const stHot = { collide_name: { hot: true } };
    check('GUARD: a hot upstream name colliding with a local id/display name is NOT upstream-promoted', () => {
      assert.strictEqual(srv.isPromotedUpstream(aggStub, regCollide, stHot, 'collide_name'), false, 'local collision must block the upstream-hot route');
      assert.strictEqual(srv.isPromotedUpstream(aggStub, regNoCollide, stHot, 'collide_name'), true, 'no collision should allow the upstream-hot route');
    });

    injectReferenceTool(registerSnap); // inject into the CLEAN baseline → boot reads the reference tool
    // Mock attached LEAN (no expose[] entry); empty manifest (no gate); empty state (defaults).
    fs.writeFileSync(EXPOSE_PATH, JSON.stringify({
      version: 1,
      upstreams: [{ id: 'mock', transport: 'stdio', command: process.execPath, args: [MOCK_SERVER], enabled: true, description: 'matrix.test.js fixture.' }],
      expose: [],
    }, null, 2) + '\n');
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ version: 1, hooks: [] }, null, 2) + '\n');
    writeState({});

    child = spawn(process.execPath, [ENTRY], { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const client = makeClient(child);
    child.on('error', (err) => client.rejectAll(new Error('child error: ' + ((err && err.message) || err))));
    await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'matrix.test.js', version: '0.0.0' } });

    // A — DEFAULT: empty state → exactly the 4 meta-tools top-level; mock_ping lean-only.
    const a = await client.request('tools/list', {});
    const lean = await client.request('tools/call', { name: 'toolfunnel_list_tools', arguments: {} });
    check('A: default top-level surface is EXACTLY the 4 meta-tools', () => {
      const names = topLevelNames(a).slice().sort();
      assert.deepStrictEqual(names, META.slice().sort(), 'expected only meta-tools; got ' + JSON.stringify(topLevelNames(a)));
    });
    check('A: an attached lean upstream tool (mock_ping) is NOT top-level by default', () => {
      assert.ok(!topLevelNames(a).includes('mock_ping'), 'mock_ping should not be top-level when only lean');
    });
    check('A: but mock_ping IS surfaced leanly in toolfunnel_list_tools', () => {
      assert.ok(leanIds(lean).includes('mock_ping'), 'mock_ping missing from lean list; got ' + JSON.stringify(leanIds(lean)));
    });

    // B — LOCAL HOT: promote a local tool by id.
    writeState({ uuid: { hot: true } });
    const b = await client.request('tools/list', {});
    check('B: a local tool promoted hot (uuid) appears top-level', () => {
      assert.ok(topLevelNames(b).includes('uuid'), 'uuid not top-level after hot; got ' + JSON.stringify(topLevelNames(b)));
    });
    check('B: the promoted local tool carries an inputSchema object, and meta-tools remain', () => {
      const def = topLevel(b).find((t) => t.name === 'uuid');
      assert.ok(def && def.inputSchema && typeof def.inputSchema === 'object', 'uuid has no inputSchema object');
      for (const m of META) assert.ok(topLevelNames(b).includes(m), 'meta-tool dropped: ' + m);
    });

    // C — DIRECT RUN: call the promoted tool directly (through the gate; empty manifest = allowed).
    const c = await client.request('tools/call', { name: 'uuid', arguments: { count: 1 } });
    check('C: the promoted local tool runs DIRECTLY (gated) and returns a v4 UUID', () => {
      assert.ok(!isError(c), 'uuid direct call errored: ' + callText(c));
      assert.ok(UUID_V4.test(callText(c)), 'no v4 UUID in output: ' + callText(c));
    });

    // D — DISABLED overrides HOT.
    writeState({ uuid: { hot: true, enabled: false } });
    const d = await client.request('tools/list', {});
    check('D: a disabled tool is NOT promoted even when hot (disabled overrides hot)', () => {
      assert.ok(!topLevelNames(d).includes('uuid'), 'uuid should be absent when disabled; got ' + JSON.stringify(topLevelNames(d)));
    });

    // E — HIDE a meta-tool from the top-level surface.
    writeState({ toolfunnel_howto: { hot: false } });
    const e = await client.request('tools/list', {});
    check('E: a meta-tool can be hidden from top-level (hot:false), the other 3 remain', () => {
      assert.ok(!topLevelNames(e).includes('toolfunnel_howto'), 'toolfunnel_howto should be hidden');
      for (const m of META.filter((x) => x !== 'toolfunnel_howto')) {
        assert.ok(topLevelNames(e).includes(m), 'meta-tool wrongly dropped: ' + m);
      }
    });
    // A hidden meta-tool must also be UN-callable (advertised surface == callable surface) — else the
    // "ordinary tools as an MCP" lockdown would be cosmetic (a client could still invoke it by name).
    const ehide = await client.request('tools/call', { name: 'toolfunnel_howto', arguments: { topic: 'create-tool' } });
    check('E: a HIDDEN meta-tool is NOT callable by name (the lockdown is real, not cosmetic)', () => {
      assert.ok(isError(ehide), 'a hidden meta-tool must not be callable; got ' + JSON.stringify(ehide && ehide.result));
    });

    // F — UPSTREAM HOT: promote an attached upstream tool by surfaced name; call it directly.
    writeState({ mock_ping: { hot: true } });
    const f = await client.request('tools/list', {});
    check('F: an upstream tool promoted hot (mock_ping) appears top-level', () => {
      assert.ok(topLevelNames(f).includes('mock_ping'), 'mock_ping not top-level after hot; got ' + JSON.stringify(topLevelNames(f)));
    });
    const fp = await client.request('tools/call', { name: 'mock_ping', arguments: {} });
    check('F: the promoted upstream tool runs DIRECTLY and returns "pong"', () => {
      assert.ok(!isError(fp), 'mock_ping direct call errored: ' + callText(fp));
      assert.strictEqual(callText(fp), 'pong', 'expected "pong", got ' + JSON.stringify(callText(fp)));
    });

    // G — a real local tool that is NOT promoted is NOT directly callable (surface honesty).
    writeState({});
    const g = await client.request('tools/call', { name: 'echo', arguments: { hello: 1 } });
    check('G: a non-promoted local tool called directly returns an error (not silently run)', () => {
      assert.ok(isError(g), 'echo should not be directly callable when not hot; got ' + JSON.stringify(g && g.result));
    });

    // H — a REFERENCE-mode tool promoted hot: appears top-level, and a direct call hands back its
    // INSTRUCTIONS as usable text (proves the reference handoff survives the direct-hot route + the
    // wrapProtocolResult reference payload — not an empty/undefined text block).
    writeState({ [REF_ID]: { hot: true } });
    const h = await client.request('tools/list', {});
    check('H: a reference-mode tool promoted hot appears top-level', () => {
      assert.ok(topLevelNames(h).includes(REF_ID), REF_ID + ' not top-level after hot; got ' + JSON.stringify(topLevelNames(h)));
    });
    const hr = await client.request('tools/call', { name: REF_ID, arguments: {} });
    check('H: a directly-called hot reference tool returns its instructions as text (not empty)', () => {
      assert.ok(!isError(hr), 'reference direct call errored: ' + callText(hr));
      assert.strictEqual(callText(hr), REF_INSTRUCTIONS, 'expected the reference instructions, got ' + JSON.stringify(callText(hr)));
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
    restore(STATE_PATH, stateSnap);
    restore(REGISTER_PATH, registerSnap);
  }

  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));

  const passed = results.filter((r) => r.ok).length;
  const expected = 15;
  const ok = !fatal && passed === results.length && results.length === expected;
  if (ok) {
    console.log(`\nPASS: matrix test — ${passed}/${expected} assertions passed (hot promotion across local/upstream/meta, live, directly runnable, gated)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: matrix test — ${passed}/${results.length} assertions passed`);
    process.exit(1);
  }
})().catch((e) => { console.log('MATRIX TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
