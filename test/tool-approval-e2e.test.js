#!/usr/bin/env node
/**
 * tool-approval-e2e.test.js - tool descriptor approval through a REAL gateway over stdio.
 *
 * The unit tests pin the rules and the aggregator. This runs the shipped path end to end: a real
 * `bin/toolfunnel.js` against a scratch home, with a tiny fixture upstream whose version and "read"
 * description the test controls through a state file.
 *   1. First boot: the tool runs (approved on first use).
 *   2. The fixture changes "read" at the SAME version; second boot: toolfunnel_list_tools still shows
 *      the approved text, and running it is refused, naming what changed (never the new text),
 *      with the accept route.
 *   3. The agent route from the refusal - toolfunnel_run_tool with tf_accept_change and the hash -
 *      accepts it; in the SAME session the tool now runs and the listing shows the new text.
 *   4. A wrong hash is refused by tf_accept_change and approves nothing.
 *
 * Run:  node test/tool-approval-e2e.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { makeTempHome, writeJson, REPO_ROOT } = require('./helpers/temp-home');

const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const REQUEST_TIMEOUT_MS = 20000;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

const FIXTURE = `'use strict';
const fs = require('fs'); const path = require('path');
const state = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'approval-fixture-state.json'), 'utf8'));
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
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'approval-fixture', version: s.version } } });
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [
      { name: 'read', description: s.readText, inputSchema: { type: 'object', properties: {} } },
      { name: 'write', description: 'Write a file.', inputSchema: { type: 'object', properties: {} } } ] } });
    else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ran ' + m.params.name }] } });
    else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
  }
});
`;

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
      if (obj && Object.prototype.hasOwnProperty.call(obj, 'id') && pending.has(obj.id)) {
        const w = pending.get(obj.id);
        pending.delete(obj.id);
        clearTimeout(w.timer);
        w.resolve(obj);
      }
    }
  });
  function request(method, params) {
    const id = nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for "${method}"`)); }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    });
  }
  return { request };
}
const textOf = (resp) => {
  const c = resp && resp.result && resp.result.content;
  return Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : '';
};

async function boot(T) {
  const child = spawn(process.execPath, [ENTRY], { cwd: T.home, env: T.env(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const client = makeClient(child);
  await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  child.stdin.write(`Content-Length: ${Buffer.byteLength('{"jsonrpc":"2.0","method":"notifications/initialized"}')}\r\n\r\n{"jsonrpc":"2.0","method":"notifications/initialized"}`);
  const run = async (name, args) => {
    const resp = await client.request('tools/call', { name: 'toolfunnel_run_tool', arguments: { name, args: args || {} } });
    const text = textOf(resp);
    let payload = null; // a register tool's own stdout JSON (run_tool wraps it as {ok, code, stdout, stderr})
    try { const out = JSON.parse(text); if (out && typeof out.stdout === 'string') payload = JSON.parse(out.stdout.trim()); } catch (_e) { /* not a script result */ }
    return { isError: !!(resp.result && resp.result.isError), text, payload };
  };
  const list = async (filter) => {
    const resp = await client.request('tools/call', { name: 'toolfunnel_list_tools', arguments: filter ? { filter } : {} });
    return textOf(resp);
  };
  const stop = () => new Promise((resolve) => {
    child.once('exit', () => resolve());
    try { child.stdin.end(); } catch (_e) { /* ignore */ }
    setTimeout(() => { try { child.kill(); } catch (_e) { /* ignore */ } }, 3000);
  });
  return { run, list, stop, stderr: () => stderr };
}

(async () => {
  const T = makeTempHome({ prefix: 'tf-approval-e2e-', seed: true });
  const stateFile = path.join(T.mcpDir, 'approval-fixture-state.json');
  fs.writeFileSync(path.join(T.mcpDir, 'approval-fixture.js'), FIXTURE);
  writeJson(stateFile, { version: '1.0.0', readText: 'Read a file.' });
  writeJson(T.expose, {
    version: 1,
    upstreams: [{ id: 'fx', transport: 'stdio', command: process.execPath, args: [path.join(T.mcpDir, 'approval-fixture.js')], enabled: true }],
    expose: [],
  });
  try {
    // 1. first boot: approved on first use, runs.
    {
      const g = await boot(T);
      const r = await g.run('fx_read');
      await check('first boot: the tool runs (approved on first use)', () => {
        assert.strictEqual(r.isError, false, r.text);
        assert.ok(r.text.includes('ran read'), r.text);
        assert.ok(fs.existsSync(path.join(T.mcpDir, 'tool-approvals.json')), 'no approvals file in the home');
      });
      await g.stop();
    }

    // 2. same-version change: listing keeps approved text; the call is refused with the route.
    const CHANGED = 'Read a file. (text changed by the server)';
    writeJson(stateFile, { version: '1.0.0', readText: CHANGED });
    const g = await boot(T);
    try {
      const listing = await g.list('fx_read');
      const refused = await g.run('fx_read');
      await check('second boot: the listing still shows the APPROVED text', () => {
        assert.ok(listing.includes('Read a file.'), listing);
        assert.ok(!listing.includes('text changed by the server'), 'the new text reached the listing: ' + listing);
      });
      await check('second boot: the call is refused naming what changed, without the new text, with the tf_accept_change route', () => {
        assert.strictEqual(refused.isError, true, refused.text);
        for (const s of ['Changed: description', 'tf_accept_change', 'toolfunnel accept fx read']) assert.ok(refused.text.includes(s), `missing ${s}: ${refused.text}`);
        assert.ok(!refused.text.includes(CHANGED), 'the unapproved text reached the model: ' + refused.text);
      });
      await check('second boot: the gateway log says what is withheld', () => {
        assert.ok(/changed while the server version stayed 1\.0\.0/.test(g.stderr()) && g.stderr().includes('read (changed)'), g.stderr().slice(-600));
      });

      // 4 (before 3): a wrong hash accepts nothing.
      const wrong = await g.run('tf_accept_change', { upstream: 'fx', tool: 'read', hash: 'sha256:' + '0'.repeat(64) });
      await check('tf_accept_change with a WRONG hash approves nothing', async () => {
        assert.ok(wrong.payload && wrong.payload.ok === false && /no longer the one pending/.test(wrong.payload.error), wrong.text);
        const again = await g.run('fx_read');
        assert.strictEqual(again.isError, true, 'the tool ran after a wrong-hash accept');
      });

      // The agent route names exactly what the user saw: no blanket accept, no accept without the hash.
      const blanket = await g.run('tf_accept_change', { upstream: 'fx' });
      const noHash = await g.run('tf_accept_change', { upstream: 'fx', tool: 'read' });
      await check('tf_accept_change without a tool, or without the hash, approves nothing', async () => {
        for (const r of [blanket, noHash]) assert.ok(r.payload && r.payload.ok === false && /required/.test(r.payload.error), r.text);
        const again = await g.run('fx_read');
        assert.strictEqual(again.isError, true, 'the tool ran after a blanket accept');
      });

      // 3. the agent route from the refusal.
      const m = refused.text.match(/"hash":"(sha256:[0-9a-f]{64})"/);
      const acc = await g.run('tf_accept_change', { upstream: 'fx', tool: 'read', hash: m && m[1] });
      await check('tf_accept_change with the refusal\'s hash accepts it', () => {
        assert.ok(m, 'no hash in the refusal: ' + refused.text);
        assert.ok(acc.payload && acc.payload.ok === true, acc.text);
        assert.deepStrictEqual(acc.payload.accepted, ['read']);
      });
      const after = await g.run('fx_read');
      const listingAfter = await g.list('fx_read');
      await check('same session: the tool now runs and the listing shows the new text', () => {
        assert.strictEqual(after.isError, false, after.text);
        assert.ok(after.text.includes('ran read'), after.text);
        assert.ok(listingAfter.includes('text changed by the server'), listingAfter);
      });
    } finally {
      await g.stop();
    }
  } catch (e) {
    results.push({ name: 'the e2e run completed', ok: false, detail: (e && e.stack) || String(e) });
  } finally {
    T.cleanup();
  }

  const EXPECTED = 8;
  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  if (passed === results.length && results.length === EXPECTED) {
    console.log(`\nPASS: tool-approval-e2e test - ${passed}/${EXPECTED} assertions passed (refused over stdio, accepted via tf_accept_change, runs in-session)`);
    process.exit(0);
  }
  console.log(`\nFAIL: tool-approval-e2e test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
  process.exit(1);
})().catch((e) => { console.log('TOOL-APPROVAL-E2E TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(2); });
