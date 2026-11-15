#!/usr/bin/env node
/**
 * unknown-config-keys.test.js - a misspelt field in expose.json is named when the gateway loads it.
 *
 * Unknown fields ride along untouched, so that hand-written extras survive every write. The cost
 * was silence: `"strictAproval": true` loaded, did nothing, and left strictApproval off. Loading with
 * a warn callback now reports each unknown field on an upstream or expose entry, with the closest
 * known field when one is near. A warning, never a refusal: unknown fields stay legal, and fields
 * starting with "_" or "$" (comments, $schema) are not reported.
 *
 * Run:  node test/unknown-config-keys.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { useTempHome, REPO_ROOT } = require('./helpers/temp-home');

const HOME = useTempHome(); // claimed before any src/ require
const { loadExposeStore } = require(path.join(REPO_ROOT, 'src', 'mcp', 'expose-store.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

let caseNo = 0;
function load(data) {
  caseNo += 1;
  const p = path.join(HOME.home, 'mcp', `unknown-${caseNo}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  const warnings = [];
  const store = loadExposeStore(p, { warnUnknown: (m) => warnings.push(m) });
  return { store, warnings, p };
}
const BASE = () => ({ id: 'u1', transport: 'stdio', command: 'node', args: ['server.js'] });

check('a misspelt upstream flag is named, with the field it was probably meant to be', () => {
  const { store, warnings, p } = load({ version: 1, upstreams: [{ ...BASE(), strictAproval: true }], expose: [] });
  assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /strictAproval/);
  assert.match(warnings[0], /did you mean "strictApproval"/);
  assert.ok(warnings[0].includes(p), 'names the file');
  assert.match(warnings[0], /upstream "u1"/);
  assert.strictEqual(store.getUpstream('u1').strictApproval, false, 'the typo still does nothing');
});

check('a misspelt expose field is named too', () => {
  const { warnings } = load({ version: 1, upstreams: [BASE()], expose: [{ upstream: 'u1', tool: 't', catgory: 'x' }] });
  assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /catgory/);
  assert.match(warnings[0], /did you mean "category"/);
});

check('two swapped letters still get a suggestion ("enbaled")', () => {
  const { warnings } = load({ version: 1, upstreams: [{ ...BASE(), enbaled: false }], expose: [] });
  assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /did you mean "enabled"/);
});

check('a field name with a line break cannot start a line of its own', () => {
  const { warnings } = load({ version: 1, upstreams: [{ ...BASE(), 'x\n[toolfunnel] forged': 1 }], expose: [] });
  assert.strictEqual(warnings.length, 1);
  assert.ok(!warnings[0].includes('\n'), JSON.stringify(warnings[0]));
});

check('an unknown field with no near match is named without a guess', () => {
  const { warnings } = load({ version: 1, upstreams: [{ ...BASE(), owner: 'me' }], expose: [] });
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /"owner"/);
  assert.doesNotMatch(warnings[0], /did you mean/);
});

check('comment and schema fields ("_" or "$" first) are not reported', () => {
  const { warnings } = load({ version: 1, upstreams: [{ ...BASE(), _note: 'mine', $comment: 'x' }], expose: [] });
  assert.deepStrictEqual(warnings, []);
});

check('a clean config gives no warnings, and every known field is known', () => {
  const full = {
    ...BASE(), env: { A: '1' }, enabled: true, legacyPin: false, modernOnly: false, allowCodeLoadingEnv: false,
    allowOutsidePaths: false, strictApproval: true, cwd: '.', timeoutMs: 1000, requestTimeoutMs: 1000, description: 'd',
  };
  const { warnings } = load({ version: 1, upstreams: [full], expose: [{ upstream: 'u1', tool: 't', as: 'a', category: 'c', enabled: true }] });
  assert.deepStrictEqual(warnings, []);
});

check('without a warn callback, loading stays silent (the web UI loads on every request)', () => {
  const p = path.join(HOME.home, 'mcp', 'silent.json');
  fs.writeFileSync(p, JSON.stringify({ version: 1, upstreams: [{ ...BASE(), strictAproval: true }], expose: [] }));
  const orig = process.stderr.write;
  let wrote = '';
  process.stderr.write = (s) => { wrote += s; return true; };
  try { loadExposeStore(p); } finally { process.stderr.write = orig; }
  assert.strictEqual(wrote, '');
});

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  ok   ${r.name}`);
  else { failed += 1; console.log(`  FAIL ${r.name}\n       ${r.detail}`); }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
