#!/usr/bin/env node
/**
 * fail-loud-config.test.js - a present-but-wrong-typed field in expose.json REFUSES, naming it.
 *
 * The store normalised every known field with a `typeof x === ... ? x : default` ladder, so a
 * value of the wrong type was silently replaced by the default: `"enabled": "false"` loaded as
 * ENABLED, `"timeoutMs": "5000"` as the 120 s default, `"args": "a b"` as no args, and
 * `"allowOutsidePaths": 1` as false. The operator saw a config that looked right and a gateway
 * that did something else. Now: refuse to load, naming the file, the entry and the
 * field. Absent fields keep their defaults; `null` counts as absent (the JSON idiom for "unset").
 * The same check guards every write (addUpstream / updateUpstream / addExpose / updateExpose),
 * against the RAW value - normalising first would coerce the evidence away - and the tf_mcp_add
 * script passes its inputs through raw instead of coercing them itself.
 *
 * Also pinned: unknown fields on an expose entry ride along through a write (upstreams already
 * did), and the shipped example config still loads.
 *
 * Run:  node test/fail-loud-config.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { useTempHome, makeTempHome, REPO_ROOT } = require('./helpers/temp-home');

const HOME = useTempHome(); // claimed before any src/ require
const { loadExposeStore } = require(path.join(REPO_ROOT, 'src', 'mcp', 'expose-store.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

let caseNo = 0;
function writeCase(data) {
  caseNo += 1;
  const p = path.join(HOME.home, 'mcp', `case-${caseNo}.json`);
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return p;
}
const BASE = () => ({ id: 'u1', transport: 'stdio', command: 'node', args: ['server.js'] });
const withUpstream = (patch) => ({ version: 1, upstreams: [{ ...BASE(), ...patch }], expose: [] });

/** Assert fn throws and the message names every string in `names`. */
function throwsNaming(fn, names) {
  let msg = null;
  try { fn(); } catch (err) { msg = (err && err.message) || String(err); }
  assert.ok(msg !== null, 'did not throw (the wrong-typed value was silently accepted)');
  for (const n of names) assert.ok(msg.includes(n), `message does not name ${JSON.stringify(n)}: ${msg}`);
}
function loadRefuses(label, data, names) {
  const p = writeCase(data);
  check(`load refuses ${label}`, () => throwsNaming(() => loadExposeStore(p), [p, ...names]));
}

// ── load: upstream fields ─────────────────────────────────────────────────────────────────────
loadRefuses('enabled: "false" (a string)', withUpstream({ enabled: 'false' }), ['u1', '"enabled"']);
loadRefuses('timeoutMs: "5000" (quoted)', withUpstream({ timeoutMs: '5000' }), ['u1', '"timeoutMs"']);
loadRefuses('timeoutMs: 0 (not positive)', withUpstream({ timeoutMs: 0 }), ['u1', '"timeoutMs"']);
loadRefuses('requestTimeoutMs: -5', withUpstream({ requestTimeoutMs: -5 }), ['u1', '"requestTimeoutMs"']);
loadRefuses('args: "a b" (a string)', withUpstream({ args: 'a b' }), ['u1', '"args"']);
loadRefuses('args with a non-string element', withUpstream({ args: ['server.js', 5] }), ['u1', '"args"']);
loadRefuses('env as an array', withUpstream({ env: ['A=1'] }), ['u1', '"env"']);
loadRefuses('env with an object value', withUpstream({ env: { A: { nested: 1 } } }), ['u1', '"env"', 'A']);
loadRefuses('legacyPin: "true" (a string)', withUpstream({ legacyPin: 'true' }), ['u1', '"legacyPin"']);
loadRefuses('modernOnly: 1', withUpstream({ modernOnly: 1 }), ['u1', '"modernOnly"']);
loadRefuses('allowCodeLoadingEnv: "yes"', withUpstream({ allowCodeLoadingEnv: 'yes' }), ['u1', '"allowCodeLoadingEnv"']);
loadRefuses('allowOutsidePaths: 1', withUpstream({ allowOutsidePaths: 1 }), ['u1', '"allowOutsidePaths"']);
loadRefuses('strictApproval: "yes"', withUpstream({ strictApproval: 'yes' }), ['u1', '"strictApproval"']);
loadRefuses('cwd: 42', withUpstream({ cwd: 42 }), ['u1', '"cwd"']);
loadRefuses('description: 7', withUpstream({ description: 7 }), ['u1', '"description"']);
loadRefuses('command: 42', withUpstream({ command: 42 }), ['u1', '"command"']);
loadRefuses('an empty stdio command', withUpstream({ command: '' }), ['u1', '"command"']);
loadRefuses('transport: "http" (unsupported)', withUpstream({ transport: 'http' }), ['u1', '"transport"']);
loadRefuses('legacyPin AND modernOnly together', withUpstream({ legacyPin: true, modernOnly: true }), ['u1', 'legacyPin', 'modernOnly']);

// ── load: expose fields ───────────────────────────────────────────────────────────────────────
const withExpose = (e) => ({ version: 1, upstreams: [BASE()], expose: [{ upstream: 'u1', tool: 't1', ...e }] });
loadRefuses('expose enabled: "no"', withExpose({ enabled: 'no' }), ['u1', 't1', '"enabled"']);
loadRefuses('expose as: 5', withExpose({ as: 5 }), ['u1', 't1', '"as"']);
loadRefuses('expose category: []', withExpose({ category: [] }), ['u1', 't1', '"category"']);
loadRefuses('an expose entry with no tool', { version: 1, upstreams: [BASE()], expose: [{ upstream: 'u1' }] }, ['u1', '"tool"']);
loadRefuses('an expose entry with no upstream', { version: 1, upstreams: [BASE()], expose: [{ tool: 't1' }] }, ['t1', '"upstream"']);

// ── load: top level ───────────────────────────────────────────────────────────────────────────
loadRefuses('upstreams as an object', { version: 1, upstreams: { u1: BASE() }, expose: [] }, ['"upstreams"']);
loadRefuses('expose as a string', { version: 1, upstreams: [], expose: 'x' }, ['"expose"']);
loadRefuses('a top-level array', [], []);
loadRefuses('a top-level null', 'null', []);
loadRefuses('version: "1" (quoted)', { version: '1', upstreams: [], expose: [] }, ['"version"']);

// ── load: what must still load ────────────────────────────────────────────────────────────────
check('absent optional fields still default', () => {
  const s = loadExposeStore(writeCase({ version: 1, upstreams: [{ id: 'u1', command: 'node' }], expose: [{ upstream: 'u1', tool: 't1' }] }));
  const u = s.getUpstream('u1');
  assert.strictEqual(u.enabled, true);
  assert.deepStrictEqual(u.args, []);
  assert.strictEqual(u.transport, 'stdio');
  assert.strictEqual(u.timeoutMs, undefined);
  assert.strictEqual(s.getExposed('u1', 't1').enabled, true);
});
check('null optional fields count as absent', () => {
  const s = loadExposeStore(writeCase(withUpstream({ timeoutMs: null, cwd: null, description: null, enabled: null, env: null })));
  const u = s.getUpstream('u1');
  assert.strictEqual(u.enabled, true);
  assert.strictEqual(u.timeoutMs, undefined);
  assert.strictEqual(u.description, '');
});
check('strictApproval: true is kept; absent means false', () => {
  const s = loadExposeStore(writeCase({ version: 1, upstreams: [{ ...BASE(), strictApproval: true }, { id: 'u2', command: 'node' }], expose: [] }));
  assert.strictEqual(s.getUpstream('u1').strictApproval, true);
  assert.strictEqual(s.getUpstream('u2').strictApproval, false);
});
check('a wrong-typed string is described by its type, never echoed (it may hold a secret)', () => {
  const p = writeCase(withUpstream({ args: 'API_TOKEN=abc123value' }));
  throwsNaming(() => loadExposeStore(p), ['u1', '"args"']);
  let msg = '';
  try { loadExposeStore(p); } catch (err) { msg = err.message; }
  assert.ok(!msg.includes('abc123'), 'the value was echoed: ' + msg);
});
check('a disabled placeholder with an empty command still loads (it is never spawned)', () => {
  const s = loadExposeStore(writeCase({ version: 1, upstreams: [{ id: 'off', enabled: false, command: '' }, BASE()], expose: [] }));
  assert.strictEqual(s.getUpstream('off').enabled, false);
  assert.strictEqual(s.listUpstreams().length, 2);
  assert.throws(() => s.setUpstreamEnabled('off', true), /non-empty "command"/, 'enabling it without a command was allowed');
});
check('scalar env values are still coerced to strings (unchanged behaviour)', () => {
  const s = loadExposeStore(writeCase(withUpstream({ env: { PORT: 8080, DEBUG: true, SKIP: null } })));
  assert.deepStrictEqual({ ...s.getUpstream('u1').env }, { PORT: '8080', DEBUG: 'true' });
});
check('the shipped example config still loads', () => {
  const s = loadExposeStore(path.join(REPO_ROOT, 'mcp', 'expose.example.json'));
  assert.strictEqual(s.listUpstreams().length, 1);
  assert.strictEqual(s.listExposed().length, 2);
});
check('unknown fields on an expose entry ride along through a write', () => {
  const p = writeCase({ version: 1, upstreams: [BASE()], expose: [{ upstream: 'u1', tool: 't1', note: 'keep me' }] });
  const s = loadExposeStore(p);
  s.addUpstream({ id: 'u2', command: 'node' }); // any write rewrites the whole file
  const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(onDisk.expose[0].note, 'keep me', 'the unknown field was dropped on write');
});

// ── writes: the same check, against the RAW value ─────────────────────────────────────────────
function writeRefuses(label, act, names) {
  const p = writeCase({ version: 1, upstreams: [BASE()], expose: [{ upstream: 'u1', tool: 't1', as: 'u1_t1', enabled: true }] });
  const before = fs.readFileSync(p, 'utf8');
  const s = loadExposeStore(p);
  check(`write refuses ${label}, file untouched`, () => {
    throwsNaming(() => act(s), [p, ...names]);
    assert.strictEqual(fs.readFileSync(p, 'utf8'), before, 'the file changed on a refused write');
  });
}
writeRefuses('addUpstream enabled: "false"', (s) => s.addUpstream({ id: 'w1', command: 'node', enabled: 'false' }), ['w1', '"enabled"']);
writeRefuses('addUpstream args: "a b"', (s) => s.addUpstream({ id: 'w1', command: 'node', args: 'a b' }), ['w1', '"args"']);
writeRefuses('updateUpstream timeoutMs: "5000"', (s) => s.updateUpstream('u1', { timeoutMs: '5000' }), ['u1', '"timeoutMs"']);
writeRefuses('updateUpstream allowOutsidePaths: "true"', (s) => s.updateUpstream('u1', { allowOutsidePaths: 'true' }), ['u1', '"allowOutsidePaths"']);
writeRefuses('addExpose enabled: "yes"', (s) => s.addExpose({ upstream: 'u1', tool: 't2', enabled: 'yes' }), ['u1', 't2', '"enabled"']);
writeRefuses('updateExpose as: 5', (s) => s.updateExpose('u1', 't1', { as: 5 }), ['u1', 't1', '"as"']);
check('a well-typed write still succeeds', () => {
  const p = writeCase({ version: 1, upstreams: [BASE()], expose: [] });
  const s = loadExposeStore(p);
  s.updateUpstream('u1', { timeoutMs: 5000, enabled: false });
  s.addExpose({ upstream: 'u1', tool: 't1', enabled: true });
  const again = loadExposeStore(p);
  assert.strictEqual(again.getUpstream('u1').timeoutMs, 5000);
  assert.strictEqual(again.getUpstream('u1').enabled, false);
});

// ── the tf_mcp_add script passes its inputs through raw ───────────────────────────────────────
{
  const T = makeTempHome({ prefix: 'tf-failloud-add-', seed: true });
  const run = (toolArgs) => {
    const r = spawnSync(process.execPath, [path.join(T.scriptsDir, 'tf-mcp-add.js')], {
      env: { ...T.env(), TOOLFUNNEL_TOOL_ARGS: JSON.stringify(toolArgs) }, encoding: 'utf8', timeout: 20000,
    });
    try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch (_e) { return { raw: r.stdout, stderr: r.stderr }; }
  };
  const out = run({ id: 'agent1', command: 'node', enabled: 'false' });
  check('tf_mcp_add with enabled: "false" reports the field instead of adding an ENABLED upstream', () => {
    assert.strictEqual(out.ok, false, 'the add succeeded: ' + JSON.stringify(out));
    assert.ok(String(out.error).includes('"enabled"'), 'error does not name the field: ' + out.error);
    const onDisk = JSON.parse(fs.readFileSync(T.expose, 'utf8'));
    assert.ok(!onDisk.upstreams.some((u) => u.id === 'agent1'), 'the upstream was persisted anyway');
  });
  // A refused EXPOSE item comes after addUpstream has already persisted. Reporting ok:false while
  // keeping the upstream made the natural retry die as a duplicate id (the UI add had the same
  // bug): the script must unwind the whole add.
  const half = run({ id: 'agent2', command: 'node', expose: [{ tool: 't1', enabled: 'yes' }] });
  check('tf_mcp_add with a refused expose item unwinds the upstream it had added', () => {
    assert.strictEqual(half.ok, false, 'the add succeeded: ' + JSON.stringify(half));
    assert.ok(String(half.error).includes('"enabled"'), 'error does not name the field: ' + half.error);
    const onDisk = JSON.parse(fs.readFileSync(T.expose, 'utf8'));
    assert.ok(!onDisk.upstreams.some((u) => u.id === 'agent2'), 'the upstream stayed on disk after a reported failure');
  });
  const retry = run({ id: 'agent2', command: 'node', expose: [{ tool: 't1' }] });
  check('the corrected retry of that add succeeds', () => {
    assert.strictEqual(retry.ok, true, 'the retry failed: ' + JSON.stringify(retry));
  });
  T.cleanup();
}

const EXPECTED = 47;
for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
const passed = results.filter((r) => r.ok).length;
if (passed === results.length && results.length === EXPECTED) {
  console.log(`\nPASS: fail-loud-config test - ${passed}/${EXPECTED} assertions passed (wrong-typed fields refuse, naming file, entry and field)`);
  process.exit(0);
}
console.log(`\nFAIL: fail-loud-config test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
process.exit(1);
