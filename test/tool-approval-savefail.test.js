#!/usr/bin/env node
/**
 * tool-approval-savefail.test.js - an approvals file that cannot be written never turns every
 * re-list into a first use.
 *
 * The file is the only memory of what was approved. When the first-use save failed (EPERM/EBUSY on
 * the rename - Windows scanners do that - a full disk, a missing mcp/ folder), each later listing
 * found no record and approved whatever the server said NOW, so a later same-version change was
 * served and ran. Now the unsaved record is kept in memory and evaluated against until a save
 * succeeds (then the file is the record again), and a missing mcp/ folder is created on save.
 * Deleting the file while saves work still resets approvals (the documented route).
 *
 * Fake clients (no processes); the save failure is injected.
 *
 * Run:  node test/tool-approval-savefail.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { useTempHome, REPO_ROOT } = require('./helpers/temp-home');
const fake = require('./helpers/fake-approval-gateway');

const HOME = useTempHome({ prefix: 'tf-approval-savefail-' }); // claimed before any src/ require
const ta = require(path.join(REPO_ROOT, 'src', 'mcp', 'tool-approvals.js'));

const APPROVALS = path.join(HOME.home, 'mcp', 'tool-approvals.json');
const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

const { tool } = fake;
const CHANGED = 'Read a file. (text changed by the server)';

const makeGateway = (root) => fake.makeGateway({ root });

const quiet = async (fn) => {
  const real = process.stderr.write;
  process.stderr.write = () => true;
  try { return await fn(); } finally { process.stderr.write = real; }
};
const leanDesc = (agg, name) => { const d = agg.leanToolDefinitions().find((x) => x.tool === name); return d && d.description; };
const pendingTools = (agg) => agg.toolChanges().pending.map((p) => p.tool);
async function runLean(agg, name) {
  const r = agg.resolveLeanExecution(name, {});
  if (!r) return 'unresolved';
  try { const out = await r.execute(); return out && out.isError ? 'refused' : 'ran'; } catch (_e) { return 'refused'; }
}

(async () => {
  // ── the save fails (EPERM on the rename) from the very first use ──────────────────────────
  const realSave = ta.saveApprovals;
  ta.saveApprovals = () => { const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e; };
  const G = makeGateway(HOME.home);
  await quiet(() => G.agg.connectAll());
  G.state.tools = [tool('read', CHANGED), tool('write', 'Write a file.')];
  await quiet(() => G.agg.discover('fs'));
  await check('save failing: a later same-version change is still PENDING (not a fresh first use)', () => {
    assert.deepStrictEqual(pendingTools(G.agg), ['read']);
    assert.strictEqual(leanDesc(G.agg, 'read'), 'Read a file.', 'the changed text was served');
  });
  await check('save failing: a call to the changed tool refuses and never reaches the upstream', async () => {
    assert.strictEqual(await runLean(G.agg, 'fs_read'), 'refused');
    assert.ok(!G.state.calls.includes('read'), 'the upstream received the call');
  });

  // ── saves work again: the next fresh listing writes the record it kept ─────────────────────
  ta.saveApprovals = realSave;
  await quiet(() => G.agg.discover('fs'));
  await check('once a save succeeds, the kept record reaches the file (approved + pending)', () => {
    const r = ta.getRecord(ta.loadApprovals(APPROVALS), 'fs');
    assert.ok(r && r.approved.read.descriptor.description === 'Read a file.', JSON.stringify(r));
    assert.ok(r.pending.read, 'the pending change was not written');
  });

  // ── a home whose mcp/ folder is missing ─────────────────────────────────────────────────
  const bare = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tf-approval-nodir-'));
  try {
    const N = makeGateway(bare);
    await quiet(() => N.agg.connectAll());
    await check('a missing mcp/ folder is created on save, so first use is recorded', () => {
      const r = ta.getRecord(ta.loadApprovals(path.join(bare, 'mcp', 'tool-approvals.json')), 'fs');
      assert.ok(r && r.approved.read, 'no record was written');
    });
  } finally {
    try { fs.rmSync(bare, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }

  const EXPECTED = 4;
  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  if (passed === results.length && results.length === EXPECTED) {
    console.log(`\nPASS: tool-approval-savefail test - ${passed}/${EXPECTED} assertions passed (an unsaved record is kept, never re-approved)`);
    process.exit(0);
  }
  console.log(`\nFAIL: tool-approval-savefail test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
  process.exit(1);
})().catch((e) => { console.log('TOOL-APPROVAL-SAVEFAIL TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(2); });
