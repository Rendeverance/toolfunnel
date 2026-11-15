#!/usr/bin/env node
/**
 * recovery-hints.test.js - agent-facing errors say what to do next.
 *
 * "No element matched, call ui_tree and adjust the matcher" gets recovered from; "not found" gets
 * retried identically until the agent gives up. So the errors an agent actually meets carry the next
 * step: an unknown tool points at the listing, an unresolvable run points at the listing and says
 * the upstream may be down, a disconnected upstream says to retry shortly. The hint only names a
 * tool this client can SEE: under a wrap, or with the meta-tools hidden (lockdown), it points at
 * tools/list alone and never names ToolFunnel's tools (this also stops the old fallback message
 * from listing hidden meta-tools).
 *
 * Real gateway over stdio (funnel mode) for the wire texts; the wrap wording via the exported helper.
 *
 * Run:  node test/recovery-hints.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const path = require('node:path');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { makeTempHome, useTempHome, REPO_ROOT } = require('./helpers/temp-home');

useTempHome({ prefix: 'tf-recovery-hints-inproc-' }); // for the in-process require below
const server = require(path.join(REPO_ROOT, 'src', 'mcp', 'server.js'));

const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

function makeClient(child) {
  let nextId = 1;
  let buf = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_e) { continue; }
      if (obj && obj.id !== undefined && pending.has(obj.id)) { const w = pending.get(obj.id); pending.delete(obj.id); clearTimeout(w.timer); w.resolve(obj); }
    }
  });
  function request(method, params) {
    const id = nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + method)); }, 20000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    });
  }
  return { request };
}
const textOf = (r) => { const c = r && r.result && r.result.content; return Array.isArray(c) && c[0] ? String(c[0].text) : JSON.stringify(r); };

(async () => {
  check('the unknown-tool text names the funnel listing only when this client can see it', () => {
    assert.strictEqual(typeof server.unknownToolText, 'function', 'server.unknownToolText is not exported');
    const hidden = server.unknownToolText('nope', false);
    assert.ok(/Unknown tool "nope"/.test(hidden) && /tools\/list/.test(hidden), hidden);
    assert.ok(!/toolfunnel/i.test(hidden), 'names ToolFunnel although its tools are not visible: ' + hidden);
    const visible = server.unknownToolText('nope', true);
    assert.ok(/toolfunnel_list_tools/.test(visible) && /toolfunnel_run_tool/.test(visible), visible);
  });

  const T = makeTempHome({ prefix: 'tf-recovery-hints-' });
  const child = spawn(process.execPath, [ENTRY], { cwd: T.home, env: T.env(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const c = makeClient(child);
  try {
    await c.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hints', version: '0' } });
    const unknown = await c.request('tools/call', { name: 'no_such_tool', arguments: {} });
    check('calling an unknown tool points at the listing', () => {
      assert.ok(/Unknown tool "no_such_tool"/.test(textOf(unknown)) && /toolfunnel_list_tools/.test(textOf(unknown)), textOf(unknown));
    });
    const instr = await c.request('tools/call', { name: 'toolfunnel_tool_instructions', arguments: { name: 'no_such_tool' } });
    check('instructions for an unknown name point at the listing', () => {
      assert.ok(/no tool named "no_such_tool"/.test(textOf(instr)) && /toolfunnel_list_tools/.test(textOf(instr)), textOf(instr));
    });
    const run = await c.request('tools/call', { name: 'toolfunnel_run_tool', arguments: { name: 'no_such_tool', args: {} } });
    check('running an unresolvable name points at the listing and says an upstream may be down', () => {
      const t = textOf(run);
      assert.ok(/not runnable/.test(t) && /toolfunnel_list_tools/.test(t) && /disconnected|disabled/.test(t), t);
    });
  } catch (e) {
    results.push({ name: 'the run completed', ok: false, detail: (e && e.stack) || String(e) });
  } finally {
    try { child.stdin.end(); } catch (_e) { /* ignore */ }
    await new Promise((r) => { child.once('exit', r); setTimeout(() => { try { child.kill(); } catch (_e) { /* ignore */ } r(); }, 3000); });
    T.cleanup();
  }

  // LOCKDOWN: list + run hidden. An unknown name must not reveal them (the old fallback listed all four).
  const L = makeTempHome({ prefix: 'tf-recovery-hints-lock-', state: { toolfunnel_list_tools: { hot: false }, toolfunnel_run_tool: { hot: false } } });
  const lchild = spawn(process.execPath, [ENTRY], { cwd: L.home, env: L.env(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lc = makeClient(lchild);
  try {
    await lc.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hints-lock', version: '0' } });
    const u = await lc.request('tools/call', { name: 'no_such_tool', arguments: {} });
    check('in LOCKDOWN an unknown tool points at tools/list and names no hidden tool', () => {
      assert.ok(/Unknown tool "no_such_tool"/.test(textOf(u)) && /tools\/list/.test(textOf(u)), textOf(u));
      assert.ok(!/toolfunnel_list_tools|toolfunnel_run_tool/.test(textOf(u)), 'hidden meta-tools named: ' + textOf(u));
    });
  } catch (e) {
    results.push({ name: 'the lockdown run completed', ok: false, detail: (e && e.stack) || String(e) });
  } finally {
    try { lchild.stdin.end(); } catch (_e) { /* ignore */ }
    await new Promise((r) => { lchild.once('exit', r); setTimeout(() => { try { lchild.kill(); } catch (_e) { /* ignore */ } r(); }, 3000); });
    L.cleanup();
  }

  const src = require('node:fs').readFileSync(path.join(REPO_ROOT, 'src', 'mcp', 'aggregator.js'), 'utf8');
  check('a not-connected upstream error says to retry shortly', () => {
    const lines = src.split('\n').filter((l) => /reconnecting in background\)/.test(l));
    assert.ok(lines.length >= 2, 'expected the reconnecting messages');
    for (const l of lines) assert.ok(/retry in a few seconds/.test(l), 'no retry hint: ' + l.trim());
  });

  const EXPECTED = 6;
  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  if (passed === results.length && results.length === EXPECTED) {
    console.log(`\nPASS: recovery-hints test - ${passed}/${EXPECTED} assertions passed (errors carry the next step)`);
    process.exit(0);
  }
  console.log(`\nFAIL: recovery-hints test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
  process.exit(1);
})().catch((e) => { console.log('RECOVERY-HINTS TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(2); });
