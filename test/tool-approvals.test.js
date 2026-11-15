#!/usr/bin/env node
/**
 * tool-approvals.test.js - the pure rules behind tool descriptor approval ("hash-pinning").
 *
 * An upstream's tool descriptors are approved on first use; after that a change is classified by
 * the server's reported version: same version + changed or new tool = PENDING (the
 * listing keeps the approved text, a new tool stays hidden, calls refuse until accepted); version
 * changed = UPGRADE (auto-approved, reported); strictApproval turns an upgrade into pending too; a
 * different server NAME is classified like a version change (auto-approved and reported, or pending
 * under strictApproval - never a fresh first use, which would let a renamed server slip past
 * strict). Accepting moves a pending descriptor to approved. The approvals file is state:
 * missing = empty, unreadable = THROW (treating it as empty would silently re-approve everything).
 *
 * Run:  node test/tool-approvals.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { useTempHome, REPO_ROOT } = require('./helpers/temp-home');

const HOME = useTempHome({ prefix: 'tf-approvals-' }); // claimed before any src/ require
const ta = require(path.join(REPO_ROOT, 'src', 'mcp', 'tool-approvals.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

const T0 = '2026-09-24T12:00:00.000Z';
const T1 = '2026-09-24T13:00:00.000Z';
const T2 = '2026-09-24T14:00:00.000Z';
const tool = (name, description, extra) => ({
  name, description, inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'a path' } } }, ...(extra || {}),
});
const V1 = { name: 'fs-server', version: '1.0.0' };
const V2 = { name: 'fs-server', version: '1.1.0' };
const BASE = [tool('read', 'Read a file.'), tool('write', 'Write a file.')];
const CHANGED_TEXT = 'Read a file. (text changed by the server)';
const names = (tools) => tools.map((t) => t.name).sort();
const byName = (tools, n) => tools.find((t) => t.name === n);
const first = () => ta.evaluate({ record: undefined, serverInfo: V1, tools: BASE, strict: false, now: T0 });

// ── hashing ───────────────────────────────────────────────────────────────────────────────────
check('hash: key order does not matter; _meta and icons do not count', () => {
  const a = { name: 'x', description: 'd', inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } } };
  const b = { inputSchema: { properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object' }, description: 'd', name: 'x', _meta: { v: 1 }, icons: [{ src: 'i.png' }] };
  assert.strictEqual(ta.hashTool(a), ta.hashTool(b));
  assert.ok(/^sha256:[0-9a-f]{64}$/.test(ta.hashTool(a)), ta.hashTool(a));
});
check('hash: description, a parameter description, title, annotations and outputSchema all count', () => {
  const base = tool('x', 'd');
  const h = ta.hashTool(base);
  assert.notStrictEqual(ta.hashTool({ ...base, description: 'd!' }), h, 'description');
  assert.notStrictEqual(ta.hashTool({ ...base, inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'changed parameter text' } } } }), h, 'param description');
  assert.notStrictEqual(ta.hashTool({ ...base, title: 'X' }), h, 'title');
  assert.notStrictEqual(ta.hashTool({ ...base, annotations: { destructiveHint: false } }), h, 'annotations');
  assert.notStrictEqual(ta.hashTool({ ...base, outputSchema: { type: 'object' } }), h, 'outputSchema');
});

// ── the table ─────────────────────────────────────────────────────────────────────────────────
check('first use approves every tool and records the server', () => {
  const r = first();
  assert.deepStrictEqual(names(r.effective), ['read', 'write']);
  assert.deepStrictEqual(Object.keys(r.record.approved).sort(), ['read', 'write']);
  assert.deepStrictEqual(r.record.server, { name: 'fs-server', version: '1.0.0' });
  assert.strictEqual(r.record.approved.read.how, 'first-use');
  assert.deepStrictEqual(r.pending, []);
  assert.ok(r.events.some((e) => e.kind === 'first-use'), JSON.stringify(r.events));
  assert.strictEqual(r.changed, true);
});
check('an identical re-list changes nothing', () => {
  const r0 = first();
  const r = ta.evaluate({ record: r0.record, serverInfo: V1, tools: BASE, strict: false, now: T1 });
  assert.strictEqual(r.changed, false);
  assert.deepStrictEqual(r.pending, []);
  assert.deepStrictEqual(r.events, []);
});
check('same version + changed description = PENDING; the listing keeps the APPROVED text; others untouched', () => {
  const r0 = first();
  const changed = [tool('read', CHANGED_TEXT), tool('write', 'Write a file.')];
  const r = ta.evaluate({ record: r0.record, serverInfo: V1, tools: changed, strict: false, now: T1 });
  assert.deepStrictEqual(r.pending.map((p) => [p.tool, p.reason]), [['read', 'changed']]);
  assert.strictEqual(byName(r.effective, 'read').description, 'Read a file.', 'the new text reached the listing');
  assert.strictEqual(byName(r.effective, 'write').description, 'Write a file.');
  assert.strictEqual(r.record.pending.read.descriptor.description, CHANGED_TEXT);
  assert.strictEqual(r.record.approved.read.hash, r0.record.approved.read.hash, 'the approval moved without an accept');
});
check('same version + a changed PARAMETER description = pending', () => {
  const r0 = first();
  const t = [tool('read', 'Read a file.', { inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'changed parameter text' } } } }), tool('write', 'Write a file.')];
  const r = ta.evaluate({ record: r0.record, serverInfo: V1, tools: t, strict: false, now: T1 });
  assert.deepStrictEqual(r.pending.map((p) => p.tool), ['read']);
});
check('same version + a NEW tool = pending and ABSENT from the listing', () => {
  const r0 = first();
  const r = ta.evaluate({ record: r0.record, serverInfo: V1, tools: [...BASE, tool('extra', 'A new tool.')], strict: false, now: T1 });
  assert.deepStrictEqual(r.pending.map((p) => [p.tool, p.reason]), [['extra', 'new']]);
  assert.deepStrictEqual(names(r.effective), ['read', 'write']);
});
check('version changed = UPGRADE: auto-approved, reported, server version recorded', () => {
  const r0 = first();
  const t = [tool('read', 'Read a file, faster.'), tool('write', 'Write a file.'), tool('list', 'List a directory.')];
  const r = ta.evaluate({ record: r0.record, serverInfo: V2, tools: t, strict: false, now: T1 });
  assert.deepStrictEqual(r.pending, []);
  assert.deepStrictEqual(names(r.effective), ['list', 'read', 'write']);
  assert.strictEqual(byName(r.effective, 'read').description, 'Read a file, faster.');
  assert.strictEqual(r.record.approved.read.how, 'upgrade');
  assert.strictEqual(r.record.server.version, '1.1.0');
  const up = r.events.find((e) => e.kind === 'upgrade');
  assert.ok(up && up.from === '1.0.0' && up.to === '1.1.0', JSON.stringify(r.events));
  assert.deepStrictEqual(up.tools.map((x) => [x.tool, x.reason]).sort(), [['list', 'new'], ['read', 'changed']]);
});
check('strictApproval: a version change does NOT auto-approve', () => {
  const r0 = first();
  const t = [tool('read', 'Read a file, faster.'), tool('write', 'Write a file.')];
  const r = ta.evaluate({ record: r0.record, serverInfo: V2, tools: t, strict: true, now: T1 });
  assert.deepStrictEqual(r.pending.map((p) => p.tool), ['read']);
  assert.strictEqual(byName(r.effective, 'read').description, 'Read a file.');
  assert.strictEqual(r.record.server.version, '1.0.0', 'the approved version moved while tools are pending');
});
check('strictApproval + a version change with NO descriptor change records the new version', () => {
  const r0 = first();
  const r = ta.evaluate({ record: r0.record, serverInfo: V2, tools: BASE, strict: true, now: T1 });
  assert.deepStrictEqual(r.pending, []);
  assert.strictEqual(r.record.server.version, '1.1.0');
});
check('a different server NAME (not strict) approves the changed tools like an upgrade, reported', () => {
  const r0 = first();
  const r = ta.evaluate({ record: r0.record, serverInfo: { name: 'other-server', version: '1.0.0' }, tools: [tool('read', 'Something else.')], strict: false, now: T1 });
  assert.deepStrictEqual(r.pending, []);
  assert.strictEqual(r.record.server.name, 'other-server');
  assert.strictEqual(r.record.approved.read.descriptor.description, 'Something else.');
  assert.strictEqual(r.record.approved.read.how, 'upgrade');
  assert.ok(r.record.approved.write, 'the approval of a tool the renamed server no longer lists was dropped');
  const e = r.events.find((x) => x.kind === 'server-changed');
  assert.ok(e && e.from === 'fs-server' && e.to === 'other-server', JSON.stringify(r.events));
  assert.deepStrictEqual(e.tools, [{ tool: 'read', reason: 'changed' }]);
});
check('strictApproval + a different server NAME at the same version holds the changed tool as PENDING', () => {
  const r0 = first();
  const r = ta.evaluate({ record: r0.record, serverInfo: { name: 'fs-server-x', version: '1.0.0' }, tools: [tool('read', CHANGED_TEXT), tool('write', 'Write a file.')], strict: true, now: T1 });
  assert.deepStrictEqual(r.pending.map((p) => p.tool), ['read']);
  assert.strictEqual(byName(r.effective, 'read').description, 'Read a file.', 'the changed text was served');
  assert.strictEqual(r.record.server.name, 'fs-server', 'the approved identity moved while a tool is pending');
  assert.ok(!r.events.some((x) => x.kind === 'server-changed' || x.kind === 'first-use'), JSON.stringify(r.events));
});
check('strictApproval: flipping the server NAME does not release a pending change', () => {
  const r0 = ta.evaluate({ record: undefined, serverInfo: V1, tools: BASE, strict: true, now: T0 });
  const t = [tool('read', CHANGED_TEXT), tool('write', 'Write a file.')];
  const r1 = ta.evaluate({ record: r0.record, serverInfo: V1, tools: t, strict: true, now: T1 });
  const r2 = ta.evaluate({ record: r1.record, serverInfo: { name: 'renamed', version: '1.0.0' }, tools: t, strict: true, now: T2 });
  assert.deepStrictEqual(r2.pending.map((p) => p.tool), ['read']);
  assert.strictEqual(r2.record.approved.read.descriptor.description, 'Read a file.');
  assert.strictEqual(r2.record.pending.read.since, T1);
});
check('a server that reports NO version takes the stricter branch', () => {
  const r0 = ta.evaluate({ record: undefined, serverInfo: { name: 'nov' }, tools: BASE, strict: false, now: T0 });
  const r = ta.evaluate({ record: r0.record, serverInfo: { name: 'nov' }, tools: [tool('read', 'Changed.'), tool('write', 'Write a file.')], strict: false, now: T1 });
  assert.deepStrictEqual(r.pending.map((p) => p.tool), ['read']);
});
check('a removed tool keeps its approval and raises nothing', () => {
  const r0 = first();
  const r = ta.evaluate({ record: r0.record, serverInfo: V1, tools: [tool('read', 'Read a file.')], strict: false, now: T1 });
  assert.deepStrictEqual(r.pending, []);
  assert.ok(r.record.approved.write, 'the approval was dropped');
  assert.strictEqual(r.changed, false);
});
check('a pending entry keeps its first-seen time across re-lists', () => {
  const r0 = first();
  const t = [tool('read', 'Changed.'), tool('write', 'Write a file.')];
  const r1 = ta.evaluate({ record: r0.record, serverInfo: V1, tools: t, strict: false, now: T1 });
  const r2 = ta.evaluate({ record: r1.record, serverInfo: V1, tools: t, strict: false, now: T2 });
  assert.strictEqual(r2.record.pending.read.since, T1);
  assert.strictEqual(r2.changed, false);
});
check('a server that REVERTS to the approved descriptor clears the pending entry', () => {
  const r0 = first();
  const r1 = ta.evaluate({ record: r0.record, serverInfo: V1, tools: [tool('read', 'Changed.'), tool('write', 'Write a file.')], strict: false, now: T1 });
  const r2 = ta.evaluate({ record: r1.record, serverInfo: V1, tools: BASE, strict: false, now: T2 });
  assert.deepStrictEqual(r2.pending, []);
  assert.strictEqual(r2.record.pending.read, undefined);
});
check('a pending entry for a tool that disappeared is dropped', () => {
  const r0 = first();
  const r1 = ta.evaluate({ record: r0.record, serverInfo: V1, tools: [...BASE, tool('extra', 'x')], strict: false, now: T1 });
  const r2 = ta.evaluate({ record: r1.record, serverInfo: V1, tools: BASE, strict: false, now: T2 });
  assert.strictEqual(r2.record.pending.extra, undefined);
});
check('the pending list carries old and new descriptors and the changed fields', () => {
  const r0 = first();
  const r = ta.evaluate({ record: r0.record, serverInfo: V1, tools: [tool('read', 'Changed.'), tool('write', 'Write a file.')], strict: false, now: T1 });
  const p = r.pending[0];
  assert.strictEqual(p.approved.description, 'Read a file.');
  assert.strictEqual(p.current.description, 'Changed.');
  assert.deepStrictEqual(p.changed, ['description']);
});
check('changedFields names what differs: a schema change, a new tool, an added field', () => {
  const a = ta.descriptorOf(tool('read', 'Read a file.'));
  assert.deepStrictEqual(ta.changedFields(a, ta.descriptorOf(tool('read', 'Read a file.', { inputSchema: { type: 'object' } }))), ['inputSchema']);
  assert.deepStrictEqual(ta.changedFields(null, a), ['name', 'description', 'inputSchema']);
  assert.deepStrictEqual(ta.changedFields(a, { ...a, title: null }), ['title']);
  assert.deepStrictEqual(ta.changedFields(a, ta.descriptorOf(tool('read', 'Read a file.'))), []);
});

check('a tool named "__proto__" is an ordinary entry (approved, pending, accepted, saved)', () => {
  const odd = JSON.parse('[{"name":"__proto__","description":"odd name"},{"name":"read","description":"Read a file."}]');
  const r0 = ta.evaluate({ record: undefined, serverInfo: V1, tools: odd, strict: false, now: T0 });
  assert.ok(Object.prototype.hasOwnProperty.call(r0.record.approved, '__proto__'), 'not an own entry');
  assert.strictEqual(Object.getPrototypeOf(r0.record.approved), Object.prototype, 'the map prototype was replaced');
  const changed = JSON.parse('[{"name":"__proto__","description":"odd name, changed"},{"name":"read","description":"Read a file."}]');
  const r1 = ta.evaluate({ record: r0.record, serverInfo: V1, tools: changed, strict: false, now: T1 });
  assert.deepStrictEqual(r1.pending.map((p) => p.tool), ['__proto__']);
  const acc = ta.accept(r1.record, '__proto__', T2);
  assert.deepStrictEqual(acc.accepted, ['__proto__']);
  const back = JSON.parse(JSON.stringify(acc.record));
  assert.strictEqual(back.approved['__proto__'].descriptor.description, 'odd name, changed');
});

// ── accept ────────────────────────────────────────────────────────────────────────────────────
check('accepting ONE tool approves its pending descriptor; the next evaluation serves it', () => {
  const r0 = first();
  const t = [tool('read', 'Changed.'), tool('write', 'Write a file.'), tool('extra', 'New.')];
  const r1 = ta.evaluate({ record: r0.record, serverInfo: V1, tools: t, strict: false, now: T1 });
  const acc = ta.accept(r1.record, 'read', T2);
  assert.deepStrictEqual(acc.accepted, ['read']);
  assert.strictEqual(acc.record.approved.read.how, 'accepted');
  assert.strictEqual(acc.record.pending.read, undefined);
  assert.ok(acc.record.pending.extra, 'accepting one tool accepted another');
  const r2 = ta.evaluate({ record: acc.record, serverInfo: V1, tools: t, strict: false, now: T2 });
  assert.strictEqual(byName(r2.effective, 'read').description, 'Changed.');
  assert.deepStrictEqual(r2.pending.map((p) => p.tool), ['extra']);
});
check('accepting ALL clears pending and records the server identity seen', () => {
  const r0 = first();
  const t = [tool('read', 'Changed.'), tool('write', 'Write a file.')];
  const r1 = ta.evaluate({ record: r0.record, serverInfo: V2, tools: t, strict: true, now: T1 });
  const acc = ta.accept(r1.record, undefined, T2);
  assert.deepStrictEqual(acc.accepted, ['read']);
  assert.deepStrictEqual(acc.record.pending, {});
  assert.strictEqual(acc.record.server.version, '1.1.0');
});
check('accepting a tool that is not pending reports nothing accepted', () => {
  const acc = ta.accept(first().record, 'read', T1);
  assert.deepStrictEqual(acc.accepted, []);
});

// ── the file ──────────────────────────────────────────────────────────────────────────────────
check('file: missing = empty; save + load round-trips', () => {
  const p = path.join(HOME.home, 'mcp', 'tool-approvals.json');
  assert.deepStrictEqual(ta.loadApprovals(p), { version: 1, upstreams: {} });
  const doc = { version: 1, upstreams: { fs: first().record } };
  ta.saveApprovals(p, doc);
  assert.deepStrictEqual(ta.loadApprovals(p), JSON.parse(JSON.stringify(doc)));
});
check('file: an entry whose descriptor names a DIFFERENT tool is refused', () => {
  const doc = ta.emptyApprovals();
  doc.upstreams.fs = { server: { name: 'fs-server', version: '1.0.0' }, approved: {}, pending: {
    read: { hash: 'sha256:' + '0'.repeat(64), descriptor: { name: 'write', description: 'x' } },
  } };
  assert.throws(() => ta.validateApprovals(doc, 'f.json'), /"read"/);
});
check('file: unreadable = THROW naming the file (never silently empty)', () => {
  const p = path.join(HOME.home, 'mcp', 'bad-approvals.json');
  fs.writeFileSync(p, '{ not json');
  assert.throws(() => ta.loadApprovals(p), (e) => e.message.includes(p));
  fs.writeFileSync(p, JSON.stringify({ version: 1, upstreams: [] }));
  assert.throws(() => ta.loadApprovals(p), (e) => e.message.includes(p) && e.message.includes('"upstreams"'));
});

// ── acceptInFile: the one accept every route shares (tf_accept_change, the CLI, the UI, the gateway) ──
{
  const p = path.join(HOME.home, 'mcp', 'accept-file.json');
  const seed = () => {
    const r0 = first();
    const r1 = ta.evaluate({ record: r0.record, serverInfo: V1, tools: [tool('read', 'Changed.'), tool('write', 'Write a file.')], strict: false, now: T1 });
    ta.saveApprovals(p, { version: 1, upstreams: { fs: r1.record } });
    return r1.pending[0].hash;
  };
  check('acceptInFile: the right hash approves and writes the file', () => {
    const h = seed();
    const res = ta.acceptInFile(p, 'fs', 'read', h);
    assert.deepStrictEqual(res.accepted, ['read']);
    assert.strictEqual(ta.getRecord(ta.loadApprovals(p), 'fs').approved.read.how, 'accepted');
  });
  check('acceptInFile: a STALE hash approves nothing and leaves the file alone', () => {
    seed();
    const before = fs.readFileSync(p, 'utf8');
    const res = ta.acceptInFile(p, 'fs', 'read', 'sha256:' + '0'.repeat(64));
    assert.deepStrictEqual(res.accepted, []);
    assert.strictEqual(res.stale, true);
    assert.strictEqual(fs.readFileSync(p, 'utf8'), before);
  });
  check('acceptInFile: an unknown upstream says so; an unreadable file throws', () => {
    seed();
    const res = ta.acceptInFile(p, 'nope', undefined);
    assert.deepStrictEqual(res.accepted, []);
    assert.strictEqual(res.unknown, true);
    fs.writeFileSync(p, '{ broken');
    assert.throws(() => ta.acceptInFile(p, 'fs', 'read'), (e) => e.message.includes(p));
  });
}

check('listPending carries the approved and new value of every changed field besides the description', () => {
  const r0 = first();
  const t = [tool('read', 'Read a file.', { inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'changed parameter text' } } } }), tool('write', 'Write a file.')];
  const r = ta.evaluate({ record: r0.record, serverInfo: V1, tools: t, strict: false, now: T1 });
  const [p] = ta.listPending({ version: 1, upstreams: { fs: r.record } });
  assert.deepStrictEqual(p.changed, ['inputSchema']);
  assert.deepStrictEqual(Object.keys(p.fields), ['inputSchema']);
  assert.strictEqual(p.fields.inputSchema.new.properties.path.description, 'changed parameter text');
  assert.strictEqual(p.fields.inputSchema.approved.properties.path.description, 'a path');
});
check('printable escapes terminal controls and bidi overrides, and leaves other text alone', () => {
  assert.strictEqual(ta.printable('a\u001b[8mb\u009bc\u202ed\u2066e'), 'a\\u001b[8mb\\u009bc\\u202ed\\u2066e');
  assert.strictEqual(ta.printable('line one\nline two\ttab'), 'line one\\nline two\\ttab');
  assert.strictEqual(ta.printable('Lire un fichier: café, 读取 ✓'), 'Lire un fichier: café, 读取 ✓');
});

const EXPECTED = 32;
for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
const passed = results.filter((r) => r.ok).length;
if (passed === results.length && results.length === EXPECTED) {
  console.log(`\nPASS: tool-approvals test - ${passed}/${EXPECTED} assertions passed (first use, pending, upgrade, strict, accept, file)`);
  process.exit(0);
}
console.log(`\nFAIL: tool-approvals test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
process.exit(1);
