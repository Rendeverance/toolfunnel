'use strict';

/**
 * fixes-082.test.js - the smaller 0.8.2 fixes, each pinned.
 *
 *   A - a tool that exits 0 but answers {"ok": false} is a failure, with its own error text; other output is not.
 *   B - toolfunnel_run_tool given "arguments" instead of "args" refuses and runs nothing.
 *   C - a wrap names the expose entries it leaves unapplied (none -> no note).
 *   D - a top-level strictApproval: true holds every upstream, even one whose entry says false (0.8.1 wrote false on
 *       every entry); an entry can add it on its own; the top-level key is written back as found; a wrong type
 *       refuses to load.
 *   E - a top-level key that belongs on an upstream, or is misspelt, is warned about at load.
 *
 * Run:  node test/fixes-082.test.js     (exit 0 = pass)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const { toolSaidFailed } = require('../src/core/tool-args');
const { makeProtocol } = require('../src/mcp/protocol');
const { ExposeStore, loadExposeStore, wrapIgnoresNote } = require('../src/mcp/expose-store');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

const up = (id, extra) => Object.assign({ id, transport: 'stdio', command: 'node' }, extra || {});

(async () => {
  await check('A: {"ok": false} on stdout is a failure with the tool\'s own text', () => {
    assert.strictEqual(toolSaidFailed('{"ok":false,"error":"no such id"}\n'), 'no such id');
    assert.strictEqual(toolSaidFailed('{"ok":false}'), 'the tool reported ok: false');
    assert.strictEqual(toolSaidFailed('{"ok":true}'), null);
    assert.strictEqual(toolSaidFailed('done'), null);
    assert.strictEqual(toolSaidFailed('{"ok":false} and more'), null);
    assert.strictEqual(toolSaidFailed('[{"ok":false}]'), null);
  });

  await check('B: "arguments" instead of "args" refuses and runs nothing', async () => {
    let ran = false;
    const p = makeProtocol({
      registry: { resolveExecution: async () => { ran = true; return { run: async () => ({}) }; } },
      gatedRun: async () => { ran = true; return { ok: true, output: {} }; },
    });
    const r = await p.runTool({ name: 'echo', arguments: { text: 'hi' } });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /"args", not "arguments"/);
    assert.strictEqual(ran, false);
  });

  await check('C: a wrap names the expose entries it leaves unapplied', () => {
    const st = new ExposeStore({ filePath: 'x.json', data: { upstreams: [up('fs'), up('db')],
      expose: [{ upstream: 'fs', tool: 'read', as: 'fs_read', enabled: true }, { upstream: 'fs', tool: 'write', enabled: false }] } });
    assert.match(wrapIgnoresNote(st, 'fs'), /"fs" has 2 curated tool entries/);
    assert.strictEqual(wrapIgnoresNote(st, 'db'), null);
  });

  await check('D: a top-level strictApproval: true holds every upstream; an entry can add it, not remove it', () => {
    const st = new ExposeStore({ filePath: 'x.json', data: { strictApproval: true,
      upstreams: [up('a'), up('b', { strictApproval: false })], expose: [] } });
    assert.deepStrictEqual(st.listUpstreams().map((u) => u.strictApproval), [true, true]);
    assert.strictEqual(st.getUpstream('b').strictApproval, true, 'an 0.8.1-era false does not mask it');
    const out = st.toJSON();
    assert.strictEqual(out.strictApproval, true);
    assert.strictEqual(out.upstreams[0].strictApproval, false, 'the top-level value is not copied onto entries');
    const off = new ExposeStore({ filePath: 'x.json', data: { strictApproval: false, upstreams: [up('a'), up('c', { strictApproval: true })] } });
    assert.deepStrictEqual(off.listUpstreams().map((u) => u.strictApproval), [false, true]);
    assert.strictEqual(off.toJSON().strictApproval, false, 'an explicit top-level false survives a write');
    const none = new ExposeStore({ filePath: 'x.json', data: { upstreams: [up('a')] } });
    assert.strictEqual(none.getUpstream('a').strictApproval, false);
    assert.strictEqual('strictApproval' in none.toJSON(), false);
    assert.throws(() => new ExposeStore({ filePath: 'x.json', data: { strictApproval: 'yes' } }), /must be true or false/);
  });

  await check('E: a misplaced or misspelt top-level key is warned about', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-082-')), 'expose.json');
    fs.writeFileSync(f, JSON.stringify({ version: 1, legacyPin: true, strictAproval: true, upstreams: [up('a')], expose: [] }));
    const warnings = [];
    loadExposeStore(f, { warnUnknown: (m) => warnings.push(m) });
    assert.ok(warnings.some((m) => /"legacyPin" belongs on an upstream entry/.test(m)), warnings.join(' | '));
    assert.ok(warnings.some((m) => /"strictAproval".*did you mean "strictApproval"/.test(m)), warnings.join(' | '));
    assert.strictEqual(warnings.length, 2);
    // an unknown top-level key is kept on the next write, as the warning says
    const st = loadExposeStore(f, {});
    st.setUpstreamEnabled('a', false);
    const back = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.strictEqual(back.legacyPin, true);
    assert.strictEqual(back.strictAproval, true);
    fs.rmSync(path.dirname(f), { recursive: true, force: true });
  });

  const failed = results.filter((x) => !x.ok);
  for (const x of results) console.log(`${x.ok ? 'ok  ' : 'FAIL'} - ${x.name}${x.ok ? '' : ` (${x.detail})`}`);
  console.log(failed.length ? `FAIL: fixes-082 - ${failed.length} failed` : `fixes-082: ${results.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
