#!/usr/bin/env node
/**
 * tool-approval-shared-home.test.js - two gateways sharing one config home do not fight over the
 * approvals file.
 *
 * Two Claude Code sessions each spawn a stdio gateway on the same home, each with its OWN child of
 * the upstream, so they can list different descriptors (a long-lived session and a newer one, or
 * an npx @latest upgrade). Each re-read of the file (the watcher, a refusal, an accept) used to end
 * in a WRITE of a record built from that process's cached listing: the older one erased the newer
 * one's pending entry or reversed its upgrade, each write fired the other's watcher, and the file
 * flipped for ever. Now only a FRESH tools/list writes (or a first use with no record yet); a
 * re-read only re-derives what this process serves; and a write keeps another process's pending
 * entries (while still clearing a pending entry this process wrote and no longer sees).
 *
 * Fake clients (no processes); the watcher is simulated by calling reloadApprovals() directly.
 *
 * Run:  node test/tool-approval-shared-home.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { useTempHome, REPO_ROOT } = require('./helpers/temp-home');
const fake = require('./helpers/fake-approval-gateway');

const HOME = useTempHome({ prefix: 'tf-approval-shared-' }); // claimed before any src/ require
const ta = require(path.join(REPO_ROOT, 'src', 'mcp', 'tool-approvals.js'));

const APPROVALS = path.join(HOME.home, 'mcp', 'tool-approvals.json');
const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

const { tool, BASE } = fake;
const CHANGED = 'Read a file. (text changed by the server)';

const makeGateway = (o) => fake.makeGateway({ root: HOME.home, ...o });

let saves = 0;
const realSave = ta.saveApprovals;
ta.saveApprovals = (...a) => { saves++; return realSave(...a); };
const quiet = async (fn) => {
  const real = process.stderr.write;
  process.stderr.write = () => true;
  try { return await fn(); } finally { process.stderr.write = real; }
};
const record = () => ta.getRecord(ta.loadApprovals(APPROVALS), 'fs');
const reset = () => { try { fs.rmSync(APPROVALS, { force: true }); } catch (_e) { /* fine */ } };
const pendingTools = (agg) => agg.toolChanges().pending.map((p) => p.tool);
const leanDesc = (agg, name) => { const d = agg.leanToolDefinitions().find((x) => x.tool === name); return d && d.description; };
/** What the file watchers of both processes would do after each write: re-read, a few rounds. */
const watcherRounds = (a, b) => quiet(async () => { for (let i = 0; i < 5; i++) { a.agg.reloadApprovals(); b.agg.reloadApprovals(); } });

(async () => {
  // ── same version: B's server changed a descriptor, A's has not ─────────────────────────────
  reset();
  const A = makeGateway();
  await quiet(() => A.agg.connectAll());
  const B = makeGateway({ tools: [tool('read', CHANGED), tool('write', 'Write a file.')] });
  await quiet(() => B.agg.connectAll());
  const bHash = (B.agg.toolChanges().pending[0] || {}).hash;
  saves = 0;
  await watcherRounds(A, B);
  await check('same version: re-reading the file (the watchers) writes NOTHING - no ping-pong', () => {
    assert.strictEqual(saves, 0, `${saves} write(s) from re-reads alone`);
  });
  await check('same version: B\'s pending entry survives in the file, and B still holds the change', () => {
    const r = record();
    assert.ok(r.pending && r.pending.read && r.pending.read.hash === bHash, JSON.stringify(r.pending));
    assert.deepStrictEqual(pendingTools(B.agg), ['read']);
    assert.strictEqual(leanDesc(B.agg, 'read'), 'Read a file.');
    assert.strictEqual(leanDesc(A.agg, 'read'), 'Read a file.');
  });
  await quiet(() => A.agg.discover('fs'));
  await check('a FRESH re-list in A (which sees no change) keeps B\'s pending entry, so a hash-guarded accept finds it', () => {
    const r = record();
    assert.ok(r.pending && r.pending.read && r.pending.read.hash === bHash, 'A\'s write erased B\'s pending entry: ' + JSON.stringify(r.pending));
    const res = ta.acceptInFile(APPROVALS, 'fs', 'read', bHash);
    assert.ok(!res.stale && res.accepted.includes('read'), JSON.stringify(res));
  });

  // ── upgrade: B runs 1.1.0 with a changed descriptor, A still runs 1.0.0 ───────────────────
  reset();
  const A2 = makeGateway();
  await quiet(() => A2.agg.connectAll());
  const B2 = makeGateway({ version: '1.1.0', tools: [tool('read', 'Read a file. v1.1'), tool('write', 'Write a file.')] });
  await quiet(() => B2.agg.connectAll());
  saves = 0;
  await watcherRounds(A2, B2);
  await check('upgrade: re-reads write nothing, the file keeps B\'s upgrade, and each gateway serves its own server\'s text', () => {
    assert.strictEqual(saves, 0, `${saves} write(s) from re-reads alone`);
    const r = record();
    assert.strictEqual(r.server.version, '1.1.0', 'the upgrade was reversed');
    assert.strictEqual(r.approved.read.descriptor.description, 'Read a file. v1.1');
    assert.strictEqual(leanDesc(B2.agg, 'read'), 'Read a file. v1.1');
    assert.strictEqual(leanDesc(A2.agg, 'read'), 'Read a file.');
  });

  // ── one process: a server that reverts still clears its own pending entry ──────────────────
  reset();
  const C = makeGateway();
  await quiet(() => C.agg.connectAll());
  C.state.tools = [tool('read', CHANGED), tool('write', 'Write a file.')];
  await quiet(() => C.agg.discover('fs'));
  C.state.tools = BASE();
  await quiet(() => C.agg.discover('fs'));
  await check('one process: a server that reverts clears the pending entry it wrote', () => {
    assert.deepStrictEqual(Object.keys(record().pending), []);
    assert.deepStrictEqual(pendingTools(C.agg), []);
  });

  // ── a restart does not orphan the pending entry the previous run wrote ─────────────────────
  reset();
  const D1 = makeGateway();
  await quiet(() => D1.agg.connectAll());
  await D1.agg.closeAll();
  const D2 = makeGateway({ tools: [tool('read', CHANGED), tool('write', 'Write a file.')] });
  await quiet(() => D2.agg.connectAll());
  await D2.agg.closeAll();
  const D3 = makeGateway({ tools: [tool('read', CHANGED), tool('write', 'Write a file.')] }); // the restart
  await quiet(() => D3.agg.connectAll());
  D3.state.tools = BASE();
  await quiet(() => D3.agg.discover('fs'));
  await check('after a restart, a server that reverts still clears the pending entry (no phantom to accept)', () => {
    assert.deepStrictEqual(Object.keys(record().pending), []);
    assert.deepStrictEqual(pendingTools(D3.agg), []);
  });

  // ── a pending entry whose writer has exited is not kept for it ─────────────────────────────
  const doc = ta.loadApprovals(APPROVALS);
  const rec = ta.getRecord(doc, 'fs');
  rec.pending.read = { hash: 'sha256:' + 'e'.repeat(64), descriptor: { name: 'read', description: CHANGED }, since: '2026-09-24T12:00:00.000Z', reason: 'changed', by: { pid: 2147483000, id: 'gone' } };
  ta.saveApprovals(APPROVALS, doc);
  await quiet(() => D3.agg.discover('fs'));
  await check('a fresh listing drops a pending entry whose writer is no longer running', () => {
    assert.deepStrictEqual(Object.keys(record().pending), []);
  });
  await D3.agg.closeAll();

  // ── a missing file is still written on a re-read (first use), so a later change pends ───────
  reset();
  await quiet(async () => { C.agg.reloadApprovals(); });
  await check('with NO record, a re-read records first use (a later same-version change still pends)', () => {
    const r = record();
    assert.ok(r && r.approved.read && r.approved.read.descriptor.description === 'Read a file.', JSON.stringify(r));
  });

  ta.saveApprovals = realSave;
  const EXPECTED = 8;
  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  if (passed === results.length && results.length === EXPECTED) {
    console.log(`\nPASS: tool-approval-shared-home test - ${passed}/${EXPECTED} assertions passed (two gateways, one approvals file, no fight)`);
    process.exit(0);
  }
  console.log(`\nFAIL: tool-approval-shared-home test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
  process.exit(1);
})().catch((e) => { console.log('TOOL-APPROVAL-SHARED-HOME TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(2); });
