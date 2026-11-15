#!/usr/bin/env node
/**
 * tool-approval-mrtr.test.js - a modern caller is ASKED to accept a held tool change (MRTR).
 *
 * A 2026-07-28 caller that declared elicitation gets `resultType: "input_required"` for a changed
 * tool instead of the isError refusal: one form question naming the tool and the changed fields
 * (never the new text), and a requestState. The retry with the user's yes accepts that exact
 * change (hash-guarded) and runs the call; a no, or an unknown token, leaves it held. A caller
 * that cannot answer (legacy, or no elicitation declared) still gets the isError refusal. The
 * accept itself passes the PreToolUse gate as tf_accept_change, and an accept the approvals file
 * cannot record says so instead of asking again.
 * Covers the curated route (called by name) and the lean route (via toolfunnel_run_tool).
 *
 * A real gateway over stdio with a fixture upstream whose tool texts the test controls.
 *
 * Run:  node test/tool-approval-mrtr.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const { makeTempHome, writeJson, REPO_ROOT } = require('./helpers/temp-home');

const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

const FIXTURE = `'use strict';
const fs = require('fs'); const path = require('path');
const state = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'mrtr-fixture-state.json'), 'utf8'));
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.id === undefined) continue;
    const s = state();
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mrtr-fixture', version: '1.0.0' } } });
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [
      { name: 'read', description: s.read, inputSchema: { type: 'object', properties: {} } },
      { name: 'write', description: s.write, inputSchema: { type: 'object', properties: {} } } ] } });
    else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ran ' + m.params.name }] } });
    else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
  }
});
`;

const modernMeta = (caps) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': caps,
  'io.modelcontextprotocol/clientInfo': { name: 'mrtr-test', version: '0' },
});
const ASKS = modernMeta({ elicitation: {} });

function boot(T) {
  const child = spawn(process.execPath, [ENTRY], { cwd: T.home, env: T.env(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.on('data', () => {});
  let buf = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      let obj;
      try { obj = JSON.parse(line); } catch (_e) { continue; }
      const w = obj && pending.get(obj.id);
      if (w) { pending.delete(obj.id); clearTimeout(w.timer); w.resolve(obj.result || obj); }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve, timer });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  });
  const stop = () => new Promise((resolve) => {
    child.once('exit', () => resolve());
    try { child.stdin.end(); } catch (_e) { /* ignore */ }
    setTimeout(() => { try { child.kill(); } catch (_e) { /* ignore */ } }, 3000);
  });
  return { request, stop };
}

const textOf = (r) => (r && Array.isArray(r.content) && r.content[0] && typeof r.content[0].text === 'string' ? r.content[0].text : '');
const answer = (action, accept) => ({ r0: action === 'accept' ? { action, content: { accept } } : { action } });

const NEW_READ = 'Read a file. (text changed by the server)';
const INIT = { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } };

/** A home whose fixture upstream was approved on first use, then changed both tools; `hooks` are PreToolUse entries. */
async function setup(prefix, hooks) {
  const T = makeTempHome({ prefix, seed: true, manifest: { version: 1, hooks: hooks || [] } });
  const stateFile = path.join(T.mcpDir, 'mrtr-fixture-state.json');
  const APPROVALS = path.join(T.mcpDir, 'tool-approvals.json');
  fs.writeFileSync(path.join(T.mcpDir, 'mrtr-fixture.js'), FIXTURE);
  writeJson(stateFile, { read: 'Read a file.', write: 'Write a file.' });
  writeJson(T.expose, {
    version: 1,
    upstreams: [{ id: 'fx', transport: 'stdio', command: process.execPath, args: [path.join(T.mcpDir, 'mrtr-fixture.js')], enabled: true }],
    expose: [{ upstream: 'fx', tool: 'read' }],
  });
  const first = boot(T);
  await first.request('initialize', INIT);
  await first.request('tools/call', { name: 'fx_read', arguments: {} });
  await first.stop();
  writeJson(stateFile, { read: NEW_READ, write: 'Write a file. (changed)' });
  const pendingIn = () => Object.keys(JSON.parse(fs.readFileSync(APPROVALS, 'utf8')).upstreams.fx.pending || {}).sort();
  const start = async () => { const g = boot(T); await g.request('initialize', INIT); return g; };
  return { T, APPROVALS, pendingIn, start };
}

(async () => {
  // ── the main flow ─────────────────────────────────────────────────────────────────────────
  {
    const { T, pendingIn, start } = await setup('tf-approval-mrtr-');
    const g = await start();
    try {
      const asked = await g.request('tools/call', { name: 'fx_read', arguments: {}, _meta: ASKS });
      await check('a modern caller that declared elicitation is ASKED: one form question, a requestState', () => {
        assert.strictEqual(asked.resultType, 'input_required', JSON.stringify(asked).slice(0, 300));
        const q = asked.inputRequests && asked.inputRequests.r0;
        assert.ok(q && q.method === 'elicitation/create' && q.params.mode === 'form', JSON.stringify(asked.inputRequests));
        assert.ok(q.params.requestedSchema && q.params.requestedSchema.properties.accept.type === 'boolean', JSON.stringify(q.params));
        assert.ok(q.params.message.includes('"read"') && q.params.message.includes('description'), q.params.message);
        assert.ok(!JSON.stringify(asked).includes(NEW_READ), 'the unapproved text reached the caller');
        assert.strictEqual(typeof asked.requestState, 'string');
      });

      const noCaps = await g.request('tools/call', { name: 'fx_read', arguments: {}, _meta: modernMeta({}) });
      const legacy = await g.request('tools/call', { name: 'fx_read', arguments: {} });
      await check('a caller that cannot answer (no elicitation declared, or legacy) gets the isError refusal', () => {
        for (const r of [noCaps, legacy]) {
          assert.strictEqual(r.isError, true, JSON.stringify(r).slice(0, 200));
          assert.strictEqual(r.structuredContent && r.structuredContent.toolfunnel, 'tool-change-withheld');
        }
      });

      const declined = await g.request('tools/call', { name: 'fx_read', arguments: {}, _meta: ASKS, requestState: asked.requestState, inputResponses: answer('decline') });
      await check('a decline leaves the change held and says so', () => {
        assert.strictEqual(declined.isError, true, JSON.stringify(declined));
        assert.ok(/not accepted/.test(textOf(declined)), textOf(declined));
        assert.deepStrictEqual(pendingIn(), ['read', 'write']);
      });

      const reused = await g.request('tools/call', { name: 'fx_read', arguments: {}, _meta: ASKS, requestState: asked.requestState, inputResponses: answer('accept', true) });
      await check('a requestState is single-use: answering it twice accepts nothing', () => {
        assert.strictEqual(reused.isError, true, JSON.stringify(reused));
        assert.deepStrictEqual(pendingIn(), ['read', 'write']);
      });

      const again = await g.request('tools/call', { name: 'fx_read', arguments: {}, _meta: ASKS });
      const other = await g.request('tools/call', { name: 'fx_read', arguments: {}, _meta: ASKS });
      const ran = await g.request('tools/call', { name: 'fx_read', arguments: {}, _meta: ASKS, requestState: again.requestState, inputResponses: answer('accept', true) });
      await check('the retry with a yes accepts the change and runs the call (curated route)', () => {
        assert.ok(!ran.isError && textOf(ran).includes('ran read'), JSON.stringify(ran).slice(0, 300));
        assert.deepStrictEqual(pendingIn(), ['write']);
      });
      const late = await g.request('tools/call', { name: 'fx_read', arguments: {}, _meta: ASKS, requestState: other.requestState, inputResponses: answer('decline') });
      await check('a no to a change someone else already accepted does not run the call, and says it was accepted', () => {
        assert.strictEqual(late.isError, true, JSON.stringify(late));
        assert.ok(/already been accepted/.test(textOf(late)), textOf(late));
      });

      const leanAsk = await g.request('tools/call', { name: 'toolfunnel_run_tool', arguments: { name: 'fx_write' }, _meta: ASKS });
      const leanRan = await g.request('tools/call', { name: 'toolfunnel_run_tool', arguments: { name: 'fx_write' }, _meta: ASKS, requestState: leanAsk.requestState, inputResponses: answer('accept', true) });
      await check('the lean route (toolfunnel_run_tool) asks and accepts the same way', () => {
        assert.strictEqual(leanAsk.resultType, 'input_required', JSON.stringify(leanAsk).slice(0, 300));
        assert.ok(!leanRan.isError && textOf(leanRan).includes('ran write'), JSON.stringify(leanRan).slice(0, 300));
        assert.deepStrictEqual(pendingIn(), []);
      });
    } finally {
      await g.stop();
      T.cleanup();
    }
  }

  // ── the accept passes the PreToolUse gate as tf_accept_change ─────────────────────────────
  {
    const deny = { id: 'pre-tool-use/deny-accept', event: 'PreToolUse', matcher: 'tf_accept_change', type: 'command',
      command: 'node "${HOOKS_DIR}/scripts/deny-accept.js"', script: 'scripts/deny-accept.js', timeout: 10, enabled: true };
    const S = await setup('tf-approval-mrtr-gate-', [deny]);
    fs.mkdirSync(path.join(S.T.home, 'hooks', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(S.T.home, 'hooks', 'scripts', 'deny-accept.js'), 'process.stderr.write("no agent-side accepts\\n"); process.exit(2);\n');
    const g = await S.start();
    try {
      const asked = await g.request('tools/call', { name: 'fx_read', arguments: {}, _meta: ASKS });
      const yes = await g.request('tools/call', { name: 'fx_read', arguments: {}, _meta: ASKS, requestState: asked.requestState, inputResponses: answer('accept', true) });
      await check('a hook that denies tf_accept_change denies the in-chat accept too: nothing accepted, nothing run', () => {
        assert.strictEqual(yes.isError, true, JSON.stringify(yes).slice(0, 300));
        assert.ok(/no agent-side accepts/.test(textOf(yes)) && !textOf(yes).includes('ran read'), textOf(yes));
        assert.deepStrictEqual(S.pendingIn(), ['read', 'write']);
      });
    } finally {
      await g.stop();
      S.T.cleanup();
    }
  }

  // ── an accept the approvals file cannot record ────────────────────────────────────────────
  {
    const S = await setup('tf-approval-mrtr-ro-');
    const lock = (on) => (process.platform === 'win32'
      ? spawnSync('attrib', [on ? '+R' : '-R', S.APPROVALS], { windowsHide: true })
      : fs.chmodSync(S.T.mcpDir, on ? 0o555 : 0o755));
    const asRoot = typeof process.getuid === 'function' && process.getuid() === 0; // root writes through 0o555
    lock(true);
    const g = await S.start();
    try {
      const asked = await g.request('tools/call', { name: 'fx_read', arguments: {}, _meta: ASKS });
      const yes = await g.request('tools/call', { name: 'fx_read', arguments: {}, _meta: ASKS, requestState: asked.requestState, inputResponses: answer('accept', true) });
      await check('a yes the approvals file cannot record says so, instead of asking the same question again', () => {
        if (asRoot) return;
        assert.strictEqual(yes.isError, true, JSON.stringify(yes).slice(0, 300));
        assert.ok(/could not record/.test(textOf(yes)), textOf(yes));
      });
    } finally {
      await g.stop();
      lock(false);
      S.T.cleanup();
    }
  }

  const EXPECTED = 9;
  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  if (passed === results.length && results.length === EXPECTED) {
    console.log(`\nPASS: tool-approval-mrtr test - ${passed}/${EXPECTED} assertions passed (asked, declined, accepted, gated, both routes)`);
    process.exit(0);
  }
  console.log(`\nFAIL: tool-approval-mrtr test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
  process.exit(1);
})().catch((e) => { console.log('TOOL-APPROVAL-MRTR TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(2); });
