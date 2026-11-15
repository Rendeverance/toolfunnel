#!/usr/bin/env node
/**
 * progress-relay-stdio.test.js - upstream progress reaches a stdio client on every funnel route.
 *
 * Before: the lean route (toolfunnel_run_tool) did not forward the caller's _meta at all, and the
 * curated-direct / hot routes forwarded the token only as the upstream's keep-alive - the beats
 * never came back ("not fanned out to funnel clients"). Now the stdio transport hands each request
 * a progress sink; the aggregator scopes the token per call and routes the beats back with the
 * caller's own token, before the result. A call WITHOUT a token gets no progress, as before.
 *
 * Real gateway over stdio, the bundled mock upstream's `prog` tool (two beats against the request's
 * progressToken, then a result that says whether it saw a token).
 *
 * Run:  node test/progress-relay-stdio.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const path = require('node:path');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { makeTempHome, writeJson, REPO_ROOT } = require('./helpers/temp-home');

const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

function makeClient(child) {
  let nextId = 1;
  let buf = '';
  const pending = new Map();
  const notes = [];
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
      if (obj && obj.id !== undefined && pending.has(obj.id)) {
        const w = pending.get(obj.id);
        pending.delete(obj.id);
        clearTimeout(w.timer);
        w.resolve({ resp: obj, notesBefore: notes.slice() });
      } else if (obj && obj.method) {
        notes.push(obj);
      }
    }
  });
  function send(obj) {
    const body = JSON.stringify(obj);
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  }
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for "${method}"`)); }, 20000);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id, method, params: params || {} });
    });
  }
  return { request, send, notes };
}
const progressFor = (notes, token) => notes.filter((n) => n.method === 'notifications/progress' && n.params && n.params.progressToken === token);
const textOf = (resp) => { const c = resp && resp.result && resp.result.content; return Array.isArray(c) && c[0] ? String(c[0].text) : ''; };

(async () => {
  const T = makeTempHome({ prefix: 'tf-progress-stdio-', seed: true });
  writeJson(T.expose, {
    version: 1,
    upstreams: [{ id: 'mock', transport: 'stdio', command: process.execPath, args: [path.join(T.mcpDir, 'servers', 'mock-upstream', 'server.js')], enabled: true }],
    expose: [{ upstream: 'mock', tool: 'prog', as: 'mock_prog', enabled: true }],
  });
  const child = spawn(process.execPath, [ENTRY], { cwd: T.home, env: T.env(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const c = makeClient(child);
  try {
    await c.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'progress-e2e', version: '0' } });
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const lean = await c.request('tools/call', { name: 'toolfunnel_run_tool', arguments: { name: 'mock_prog', args: {} }, _meta: { progressToken: 'lean-1' } });
    check('LEAN (toolfunnel_run_tool): the token reaches the upstream and both beats come back with MY token, before the result', () => {
      assert.ok(textOf(lean.resp).includes('token seen'), 'the upstream saw no token: ' + textOf(lean.resp));
      const beats = progressFor(lean.notesBefore, 'lean-1');
      assert.deepStrictEqual(beats.map((b) => b.params.progress), [1, 2], 'beats before the result: ' + JSON.stringify(lean.notesBefore));
    });

    const cur = await c.request('tools/call', { name: 'mock_prog', arguments: {}, _meta: { progressToken: 42 } });
    check('CURATED-DIRECT: both beats come back with MY (integer) token, before the result', () => {
      const beats = progressFor(cur.notesBefore, 42);
      assert.deepStrictEqual(beats.map((b) => b.params.progress), [1, 2], JSON.stringify(cur.notesBefore.slice(-4)));
      assert.strictEqual(beats[0].params.total, 2);
    });

    const before = c.notes.length;
    const none = await c.request('tools/call', { name: 'mock_prog', arguments: {} });
    check('a call WITHOUT a token gets no progress (as before)', () => {
      assert.ok(textOf(none.resp).includes('NO token'), textOf(none.resp));
      assert.strictEqual(c.notes.slice(before).filter((n) => n.method === 'notifications/progress').length, 0);
    });
    check('no gateway-internal token ever reaches the client', () => {
      assert.ok(!c.notes.some((n) => n.method === 'notifications/progress' && typeof n.params.progressToken === 'string' && n.params.progressToken.startsWith('tfp-')),
        JSON.stringify(c.notes.filter((n) => n.method === 'notifications/progress')));
    });
  } catch (e) {
    results.push({ name: 'the run completed', ok: false, detail: ((e && e.message) || String(e)) + '\n' + stderr.slice(-600) });
  } finally {
    try { child.stdin.end(); } catch (_e) { /* ignore */ }
    await new Promise((r) => { child.once('exit', r); setTimeout(() => { try { child.kill(); } catch (_e) { /* ignore */ } r(); }, 3000); });
    T.cleanup();
  }

  const EXPECTED = 4;
  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  if (passed === results.length && results.length === EXPECTED) {
    console.log(`\nPASS: progress-relay-stdio test - ${passed}/${EXPECTED} assertions passed (lean + curated progress reach the stdio client with its own token)`);
    process.exit(0);
  }
  console.log(`\nFAIL: progress-relay-stdio test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
  process.exit(1);
})().catch((e) => { console.log('PROGRESS-RELAY-STDIO TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(2); });
