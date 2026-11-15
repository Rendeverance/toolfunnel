#!/usr/bin/env node
/**
 * tool-approval-gate.test.js - the aggregator applies tool descriptor approval.
 *
 * tool-approvals.test.js pins the pure rules. This pins where they bite: at _listAndCache, the one
 * chokepoint every descriptor passes. Every listing (curated-direct, lean, the wrap list) must show
 * only APPROVED text, a same-version change must refuse on all three execution routes WITHOUT
 * reaching the upstream (other tools keep working), a new tool stays hidden, an upgrade serves the
 * new text, strictApproval holds it, an accept (in-process or written to the file by another
 * process) releases it, and an unreadable approvals file withholds the upstream's tools.
 *
 * Fake clients (no processes); the approvals file lives in the scratch home.
 *
 * Run:  node test/tool-approval-gate.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { useTempHome, REPO_ROOT } = require('./helpers/temp-home');
const fake = require('./helpers/fake-approval-gateway');

const HOME = useTempHome({ prefix: 'tf-approval-gate-' }); // claimed before any src/ require
const { Aggregator } = require(path.join(REPO_ROOT, 'src', 'mcp', 'aggregator.js'));
const ta = require(path.join(REPO_ROOT, 'src', 'mcp', 'tool-approvals.js'));

const APPROVALS = path.join(HOME.home, 'mcp', 'tool-approvals.json');
const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

const { tool } = fake;
const CHANGED = 'Read a file. (text changed by the server)';

const makeWorld = (o) => fake.makeGateway({ root: HOME.home, ...o });

async function captureStderr(fn) {
  const real = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return real(chunk, ...rest); };
  try { await fn(); } finally { process.stderr.write = real; }
  return lines;
}
const descOf = (defs, name) => { const d = defs.find((x) => x.name === name); return d && d.description; };
const leanDesc = (agg, name) => descOf(agg.leanToolDefinitions(), name);
const wrapDesc = (agg, tool) => { const t = (agg.toolsByUpstream().fs || []).find((x) => x.name === tool); return t && t.description; };
const reset = () => { try { fs.rmSync(APPROVALS, { force: true }); } catch (_e) { /* fine */ } };

(async () => {
  // ── first use ───────────────────────────────────────────────────────────────────────────────
  reset();
  {
    const { agg } = makeWorld();
    await agg.connectAll();
    await check('first connect approves the listing and writes the approvals file', () => {
      const doc = ta.loadApprovals(APPROVALS);
      const rec = ta.getRecord(doc, 'fs');
      assert.ok(rec, 'no record for fs');
      assert.deepStrictEqual(Object.keys(rec.approved).sort(), ['read', 'write']);
      assert.deepStrictEqual(rec.server, { name: 'fs-server', version: '1.0.0' });
    });
    await agg.closeAll();
  }

  // ── same version, changed + new ─────────────────────────────────────────────────────────────
  {
    const { state, agg } = makeWorld();
    await agg.connectAll();
    state.tools = [tool('read', CHANGED), tool('write', 'Write a file.'), tool('extra', 'A new tool.')];
    let lines = [];
    lines = await captureStderr(async () => { await agg.discover('fs'); });

    await check('every listing keeps the APPROVED text for a changed tool (curated, lean, wrap)', () => {
      assert.strictEqual(wrapDesc(agg, 'read'), 'Read a file.', 'wrap list');
      assert.ok(/Read a file\.$/.test(descOf(agg.exposedToolDefinitions(), 'fs_read') || ''), 'curated: ' + descOf(agg.exposedToolDefinitions(), 'fs_read'));
      assert.strictEqual(leanDesc(agg, 'fs_read'), 'Read a file.', 'lean');
    });
    await check('a NEW tool at the same version is absent from every listing', () => {
      assert.ok(!(agg.toolsByUpstream().fs || []).some((t) => t.name === 'extra'), 'wrap list');
      assert.ok(!agg.leanToolDefinitions().some((d) => d.name === 'fs_extra'), 'lean');
      assert.strictEqual(agg.resolveLeanExecution('fs_extra', {}), null);
    });
    await check('the change is reported once on stderr with the way to accept', () => {
      const hit = lines.filter((l) => /changed while the server version stayed/.test(l));
      assert.strictEqual(hit.length, 1, JSON.stringify(lines));
      assert.ok(hit[0].includes('"fs"') && hit[0].includes('read') && hit[0].includes('extra') && hit[0].includes('toolfunnel accept fs'), hit[0]);
    });
    await check('LEAN: the changed tool refuses without reaching the upstream, naming what changed but not the new text', async () => {
      state.calls.length = 0;
      const r = agg.resolveLeanExecution('fs_read', {});
      assert.ok(r, 'not resolvable');
      let err = null;
      try { await r.execute(); } catch (e) { err = e; }
      assert.ok(err, 'the call ran');
      assert.deepStrictEqual(state.calls, [], 'the upstream was called');
      for (const s of ['"read"', '"fs"', 'Changed: description', 'toolfunnel changes', 'tf_accept_change', 'toolfunnel_run_tool']) assert.ok(err.message.includes(s), `missing ${s}: ${err.message}`);
      assert.ok(!err.message.includes(CHANGED), 'the unapproved text reached the model: ' + err.message);
    });
    await check('CURATED: the changed tool returns an isError result without reaching the upstream', async () => {
      state.calls.length = 0;
      const r = agg.resolveExposedExecution('fs_read', {});
      assert.ok(r, 'not resolvable');
      const env = await r.execute();
      assert.strictEqual(env && env.isError, true, JSON.stringify(env));
      assert.ok(!JSON.stringify(env).includes(CHANGED), 'the unapproved text reached the model: ' + JSON.stringify(env));
      assert.strictEqual(env.structuredContent && env.structuredContent.tool, 'read');
      assert.deepStrictEqual(env.structuredContent.changed, ['description']);
      assert.strictEqual(env.structuredContent.accept && env.structuredContent.accept.tool, 'tf_accept_change');
      assert.ok(!env.content[0].text.includes('toolfunnel_accept_change'), 'names a meta-tool that does not exist');
      assert.deepStrictEqual(state.calls, []);
    });
    await check('RAW (wrap): the changed tool returns an isError result naming the UI and CLI routes', async () => {
      state.calls.length = 0;
      const r = agg.resolveRawExecution('fs_read', {});
      assert.ok(r, 'not resolvable');
      const env = await r.execute();
      assert.strictEqual(env && env.isError, true, JSON.stringify(env));
      assert.ok(env.content[0].text.includes('toolfunnel accept fs read --hash sha256:'), 'the CLI hint lacks --hash: ' + env.content[0].text);
      assert.deepStrictEqual(state.calls, []);
    });
    await check('the UNCHANGED tool still runs on every route', async () => {
      state.calls.length = 0;
      await agg.resolveLeanExecution('fs_write', {}).execute();
      await agg.resolveExposedExecution('fs_write', {}).execute();
      await agg.resolveRawExecution('fs_write', {}).execute();
      assert.deepStrictEqual(state.calls, ['write', 'write', 'write']);
    });
    await check('toolChanges() lists what is pending', () => {
      const c = agg.toolChanges();
      assert.deepStrictEqual(c.pending.map((p) => [p.upstream, p.tool, p.reason]).sort(), [['fs', 'extra', 'new'], ['fs', 'read', 'changed']]);
    });
    await check('an accept releases one tool: new text served, the call forwards', async () => {
      const res = ta.acceptInFile(APPROVALS, 'fs', 'read');
      agg.reloadApprovals();
      assert.deepStrictEqual(res.accepted, ['read']);
      assert.strictEqual(leanDesc(agg, 'fs_read'), CHANGED);
      state.calls.length = 0;
      await agg.resolveLeanExecution('fs_read', {}).execute();
      assert.deepStrictEqual(state.calls, ['read']);
      assert.ok(!agg.leanToolDefinitions().some((d) => d.name === 'fs_extra'), 'accepting read released extra');
      assert.strictEqual(ta.getRecord(ta.loadApprovals(APPROVALS), 'fs').approved.read.how, 'accepted');
    });
    await check('an accept written to the FILE by another process is picked up by reloadApprovals()', () => {
      const doc = ta.loadApprovals(APPROVALS);
      ta.setRecord(doc, 'fs', ta.accept(ta.getRecord(doc, 'fs'), 'extra').record);
      ta.saveApprovals(APPROVALS, doc);
      agg.reloadApprovals();
      assert.ok(agg.leanToolDefinitions().some((d) => d.name === 'fs_extra'), 'extra still hidden');
      assert.deepStrictEqual(agg.toolChanges().pending, []);
    });
    await check('an accept written to the file is honoured at the next CALL, before any watcher fires', async () => {
      state.tools = [tool('read', 'Read a file, v3.'), tool('write', 'Write a file.'), tool('extra', 'A new tool.')];
      await captureStderr(async () => { await agg.discover('fs'); });
      const doc = ta.loadApprovals(APPROVALS);
      ta.setRecord(doc, 'fs', ta.accept(ta.getRecord(doc, 'fs'), 'read').record);
      ta.saveApprovals(APPROVALS, doc);
      state.calls.length = 0;
      const env = await agg.resolveExposedExecution('fs_read', {}).execute(); // no reloadApprovals() call
      assert.ok(!(env && env.isError), 'still refused: ' + JSON.stringify(env).slice(0, 200));
      assert.deepStrictEqual(state.calls, ['read']);
    });
    await check('a changed tool whose approvals file turns unreadable before the call still REFUSES (no fail-open)', async () => {
      state.tools = [tool('read', 'Read a file, v4.'), tool('write', 'Write a file.'), tool('extra', 'A new tool.')];
      await captureStderr(async () => { await agg.discover('fs'); });
      const r = agg.resolveExposedExecution('fs_read', {});
      assert.ok(r, 'not resolvable');
      const good = fs.readFileSync(APPROVALS, 'utf8');
      fs.writeFileSync(APPROVALS, '{ broken');
      state.calls.length = 0;
      let env;
      await captureStderr(async () => { env = await r.execute(); });
      fs.writeFileSync(APPROVALS, good);
      assert.strictEqual(env && env.isError, true, 'the call ran: ' + JSON.stringify(env).slice(0, 200));
      assert.deepStrictEqual(state.calls, []);
    });
    await check('a call resolved while pending still REFUSES when the watcher withholds the upstream first', async () => {
      await captureStderr(async () => { await agg.discover('fs'); });
      const curated = agg.resolveExposedExecution('fs_read', {});
      const lean = agg.resolveLeanExecution('fs_read', {});
      assert.ok(curated && lean, 'not resolvable');
      const good = fs.readFileSync(APPROVALS, 'utf8');
      fs.writeFileSync(APPROVALS, '{ half-written');
      state.calls.length = 0;
      const outcomes = [];
      await captureStderr(async () => {
        agg.reloadApprovals(); // the file watcher fires before the calls run
        outcomes.push(await curated.execute());
        try { outcomes.push(await lean.execute()); } catch (_e) { outcomes.push({ isError: true }); }
      });
      fs.writeFileSync(APPROVALS, good);
      await captureStderr(async () => { agg.reloadApprovals(); });
      for (const env of outcomes) assert.strictEqual(env && env.isError, true, 'a call ran: ' + JSON.stringify(env).slice(0, 200));
      assert.deepStrictEqual(state.calls, [], 'the upstream received a call');
    });
    await agg.closeAll();
  }

  // ── a tool name carrying terminal controls ──────────────────────────────────────────────────
  reset();
  {
    const { state, agg } = makeWorld();
    await agg.connectAll();
    state.tools = [...state.tools, tool('ev\u001b[8mil\u202e', 'A new tool.')];
    const lines = await captureStderr(async () => { await agg.discover('fs'); });
    await check('the gateway log prints a tool name\'s control and bidi characters as escapes', () => {
      const hit = lines.find((l) => /withheld until accepted/.test(l));
      assert.ok(hit && hit.includes('ev\\u001b[8mil\\u202e'), JSON.stringify(lines));
      assert.ok(!lines.some((l) => /[\u001b\u202e]/.test(l)), JSON.stringify(lines));
    });
    await agg.closeAll();
  }

  // ── upgrade and strict ──────────────────────────────────────────────────────────────────────
  reset();
  {
    const { state, agg } = makeWorld();
    await agg.connectAll();
    state.version = '1.1.0';
    state.tools = [tool('read', CHANGED), tool('write', 'Write a file.')];
    const lines = await captureStderr(async () => { await agg.discover('fs'); });
    await check('a version bump serves the new text and reports the upgrade', async () => {
      assert.strictEqual(leanDesc(agg, 'fs_read'), CHANGED);
      state.calls.length = 0;
      await agg.resolveLeanExecution('fs_read', {}).execute();
      assert.deepStrictEqual(state.calls, ['read']);
      assert.ok(lines.some((l) => /upgraded from 1\.0\.0 to 1\.1\.0/.test(l) && l.includes('"fs"')), JSON.stringify(lines));
      assert.ok(agg.toolChanges().upgraded.some((u) => u.upstream === 'fs' && u.to === '1.1.0'));
    });
    await agg.closeAll();
  }
  reset();
  {
    const { state, agg } = makeWorld({ strict: true });
    await agg.connectAll();
    state.version = '1.1.0';
    state.tools = [tool('read', CHANGED), tool('write', 'Write a file.')];
    await captureStderr(async () => { await agg.discover('fs'); });
    await check('strictApproval holds a version-bump change as pending', async () => {
      assert.strictEqual(leanDesc(agg, 'fs_read'), 'Read a file.');
      let err = null;
      try { await agg.resolveLeanExecution('fs_read', {}).execute(); } catch (e) { err = e; }
      assert.ok(err, 'the call ran');
    });
    await agg.closeAll();
  }

  // ── an unreadable approvals file withholds the tools ───────────────────────────────────────
  {
    fs.writeFileSync(APPROVALS, '{ not json');
    const { agg } = makeWorld();
    const lines = await captureStderr(async () => { await agg.connectAll(); });
    await check('an unreadable approvals file withholds the upstream\'s tools, loudly, and is left alone', () => {
      assert.deepStrictEqual(agg.leanToolDefinitions().filter((d) => d.upstream === 'fs'), []);
      assert.ok(!lines.join('').includes('removing it approves'), 'the message suggests deleting the file (that approves everything listed)');
      assert.strictEqual(agg.resolveLeanExecution('fs_read', {}), null);
      assert.ok(lines.some((l) => l.includes('tool-approvals.json') && /withheld/.test(l)), JSON.stringify(lines));
      assert.strictEqual(fs.readFileSync(APPROVALS, 'utf8'), '{ not json', 'the unreadable file was overwritten');
    });
    await agg.closeAll();
  }

  // ── /health carries the changes (live, from the aggregator) ─────────────────────────────────
  {
    const { createHttpMcpServer } = require(path.join(REPO_ROOT, 'src', 'mcp', 'http-transport.js'));
    const http = require('node:http');
    const real = Aggregator.prototype.toolChanges;
    const fake = { pending: [{ upstream: 'fs', tool: 'read', reason: 'changed', changed: ['description'], hash: 'sha256:ab' }], upgraded: [] };
    Aggregator.prototype.toolChanges = () => JSON.parse(JSON.stringify(fake));
    const server = createHttpMcpServer({ host: '127.0.0.1', port: 0 });
    try {
      const { port } = await server.start();
      const body = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d)); }).on('error', reject);
      });
      await check('/health.toolChanges lists pending changes and upgrades', () => {
        const j = JSON.parse(body);
        assert.deepStrictEqual(j.toolChanges, fake, 'toolChanges: ' + JSON.stringify(j.toolChanges));
      });
    } finally {
      Aggregator.prototype.toolChanges = real;
      try { await server.stop(); } catch (_e) { /* ignore */ }
    }
  }

  const EXPECTED = 19;
  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  if (passed === results.length && results.length === EXPECTED) {
    console.log(`\nPASS: tool-approval-gate test - ${passed}/${EXPECTED} assertions passed (approved text only, changed tools refuse, accept releases)`);
    process.exit(0);
  }
  console.log(`\nFAIL: tool-approval-gate test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
  process.exit(1);
})().catch((e) => { console.log('TOOL-APPROVAL-GATE TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(2); });
