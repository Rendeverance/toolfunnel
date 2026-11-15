#!/usr/bin/env node
/**
 * version-literal.test.js - the modern protocol version has ONE definition.
 *
 * src/mcp/modern.js exports MODERN_PROTOCOL_VERSION. Two other sites had their own copy of the
 * string: mcp-client.js defined a private constant AND hard-coded the literal in its probe's _meta,
 * and bin/toolfunnel.js compared discover results against the literal. A version bump would have
 * had to find all of them by grep. This pins the single source of truth: no quoted copy of the
 * literal anywhere under src/ or bin/ except the definition in modern.js.
 *
 * Run:  node test/version-literal.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const { MODERN_PROTOCOL_VERSION } = require(path.join(REPO_ROOT, 'src', 'mcp', 'modern.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'public') walk(p, out); } // ui/public is the browser bundle, not the protocol
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(path.join(REPO_ROOT, 'src'), []).concat(walk(path.join(REPO_ROOT, 'bin'), []));
const quoted = new RegExp(`['"]${MODERN_PROTOCOL_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
const offenders = [];
for (const f of files) {
  const rel = path.relative(REPO_ROOT, f).replace(/\\/g, '/');
  if (rel === 'src/mcp/modern.js') continue; // the definition
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => { if (quoted.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`); });
}
check('sanity: the definition exists and looks like a date-versioned protocol id', () => {
  assert.match(MODERN_PROTOCOL_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(files.length > 10, 'walked only ' + files.length + ' files');
});
check('no quoted copy of the modern protocol version outside modern.js (single source of truth)', () => {
  assert.deepStrictEqual(offenders, [], 'quoted copies:\n  ' + offenders.join('\n  '));
});

for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
const passed = results.filter((r) => r.ok).length;
const expected = 2;
if (passed === results.length && results.length === expected) {
  console.log(`\nPASS: version-literal test - ${passed}/${expected} assertions passed (one definition of the modern version)`);
  process.exit(0);
}
console.log(`\nFAIL: version-literal test - ${passed}/${results.length} assertions passed`);
process.exit(1);
