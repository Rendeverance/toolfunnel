#!/usr/bin/env node
/**
 * tool-approval-ui.test.js - the config UI's route for held tool changes (tool descriptor approval).
 *
 *   GET  /api/tool-changes          -> { ok, pending:[{upstream, tool, reason, since, hash,
 *                                        approvedDescription, newDescription, changed}], upgraded }
 *                                      ok:false + error on an unreadable approvals file (never empty-looking)
 *   POST /api/tool-changes/accept   { upstream, tool?, hash? } -> the shared engine accept (acceptInFile):
 *                                      200 { ok, accepted, pending } | 400 { ok:false, error } (stale hash,
 *                                      nothing waiting, unknown upstream, bad arguments)
 * The page (app.js) renders the list with an Accept button that posts the row's hash.
 *
 * Run:  node test/tool-approval-ui.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert');
const { useTempHome, REPO_ROOT } = require('./helpers/temp-home');

const HOME = useTempHome({ prefix: 'tf-approval-ui-' }); // claimed before any src/ require
const { createUiServer } = require(path.join(REPO_ROOT, 'src', 'ui', 'server.js'));
const ta = require(path.join(REPO_ROOT, 'src', 'mcp', 'tool-approvals.js'));

const APPROVALS = path.join(HOME.home, 'mcp', 'tool-approvals.json');
const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
const tool = (name, description) => ({ name, description, inputSchema: { type: 'object', properties: {} } });
function seed() {
  const V = { name: 'fs-server', version: '1.0.0' };
  const r0 = ta.evaluate({ record: undefined, serverInfo: V, tools: [tool('read', 'Read a file.'), tool('write', 'Write a file.')] });
  const r1 = ta.evaluate({ record: r0.record, serverInfo: V, tools: [tool('read', 'Read a file. (changed)'), tool('write', 'Write a file.'), tool('extra', 'A new tool.')] });
  ta.saveApprovals(APPROVALS, { version: 1, upstreams: { fs: r1.record } });
}

function call(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch (_e) { /* leave null */ } resolve({ status: res.statusCode, json, text: d }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const ui = createUiServer({ host: '127.0.0.1', port: 0, root: HOME.home });
  const { port } = await ui.start();
  try {
    seed();
    const list = await call(port, 'GET', '/api/tool-changes');
    let readHash = null;
    await check('GET /api/tool-changes lists each waiting change with both texts and its hash', () => {
      assert.strictEqual(list.status, 200, list.text);
      assert.strictEqual(list.json && list.json.ok, true, list.text);
      const read = list.json.pending.find((p) => p.upstream === 'fs' && p.tool === 'read');
      const extra = list.json.pending.find((p) => p.upstream === 'fs' && p.tool === 'extra');
      assert.ok(read && extra, JSON.stringify(list.json.pending));
      assert.strictEqual(read.approvedDescription, 'Read a file.');
      assert.strictEqual(read.newDescription, 'Read a file. (changed)');
      assert.deepStrictEqual(read.changed, ['description']);
      assert.strictEqual(read.reason, 'changed');
      assert.strictEqual(extra.reason, 'new');
      assert.strictEqual(extra.approvedDescription, null);
      assert.ok(/^sha256:/.test(read.hash));
      assert.deepStrictEqual(read.fields, {}, 'a description-only change carries no other fields');
      readHash = read.hash;
    });

    const stale = await call(port, 'POST', '/api/tool-changes/accept', { upstream: 'fs', tool: 'read', hash: 'sha256:' + '0'.repeat(64) });
    await check('POST accept with a stale hash is refused (400) and approves nothing', () => {
      assert.strictEqual(stale.status, 400, stale.text);
      assert.ok(/no longer the one pending/.test(stale.json && stale.json.error), stale.text);
      assert.ok(ta.getRecord(ta.loadApprovals(APPROVALS), 'fs').pending.read);
    });

    const ok = await call(port, 'POST', '/api/tool-changes/accept', { upstream: 'fs', tool: 'read', hash: readHash });
    await check('POST accept with the listed hash accepts it', () => {
      assert.strictEqual(ok.status, 200, ok.text);
      assert.deepStrictEqual(ok.json.accepted, ['read']);
      assert.deepStrictEqual(ok.json.pending, ['extra']);
      assert.strictEqual(ta.getRecord(ta.loadApprovals(APPROVALS), 'fs').approved.read.how, 'accepted');
    });

    const bad = await call(port, 'POST', '/api/tool-changes/accept', { tool: 'read' });
    const none = await call(port, 'POST', '/api/tool-changes/accept', { upstream: 'fs', tool: 'read' });
    await check('POST accept without an upstream, or with nothing waiting, is a 400 with a reason', () => {
      assert.strictEqual(bad.status, 400, bad.text);
      assert.ok(/upstream/.test(bad.json && bad.json.error), bad.text);
      assert.strictEqual(none.status, 400, none.text);
      assert.ok(/no change waiting/.test(none.json && none.json.error), none.text);
    });

    fs.writeFileSync(APPROVALS, '{ broken');
    const broken = await call(port, 'GET', '/api/tool-changes');
    await check('an unreadable approvals file is reported, not shown as "nothing waiting"', () => {
      assert.strictEqual(broken.json && broken.json.ok, false, broken.text);
      assert.ok(/tool-approvals\.json/.test(broken.json.error), broken.text);
    });

    const page = fs.readFileSync(path.join(REPO_ROOT, 'src', 'ui', 'public', 'app.js'), 'utf8');
    await check('the page renders the list and posts the accept with the row hash', () => {
      assert.ok(page.includes('/api/tool-changes'), 'app.js never reads /api/tool-changes');
      assert.ok(page.includes('/api/tool-changes/accept'), 'app.js never posts an accept');
      assert.ok(/hash:\s*\w+\.hash/.test(page), 'the accept does not send the listed hash');
      for (const f of ['p.tool', 'p.approvedDescription', 'p.newDescription']) assert.ok(page.includes(`printable(${f})`), `${f} is shown without escaping bidi controls`);
    });
  } finally {
    await ui.stop();
  }

  const EXPECTED = 6;
  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  if (passed === results.length && results.length === EXPECTED) {
    console.log(`\nPASS: tool-approval-ui test - ${passed}/${EXPECTED} assertions passed (list, hash-guarded accept, unreadable reported)`);
    process.exit(0);
  }
  console.log(`\nFAIL: tool-approval-ui test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
  process.exit(1);
})().catch((e) => { console.log('TOOL-APPROVAL-UI TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(2); });
