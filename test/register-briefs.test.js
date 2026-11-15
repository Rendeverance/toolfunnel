#!/usr/bin/env node
/**
 * register-briefs.test.js - a shipped tool can be found by any of its modes.
 *
 * toolfunnel_list_tools returns briefs (name + summary) and its filter searches only those, so an
 * operation that lives only in the instructions or the schema never turns up in a search. Every
 * quoted alternation in a shipped tool's instructions (`'enable'|'disable'`, `"sha256"|"md5"`) must
 * therefore be findable in its name or summary; an `un`-prefixed mode is findable by its base word.
 *
 * Run:  node test/register-briefs.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const register = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tools', 'tools.register.json'), 'utf8'));
const tools = Array.isArray(register) ? register : register.tools;

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

/** The mode words of every quoted alternation in `text`: 'a'|'b'|'c' -> ['a', 'b', 'c']. */
function modes(text) {
  const runs = String(text || '').match(/(['"])[\w-]+\1(?:\s*\|\s*(['"])[\w-]+\2)+/g) || [];
  return runs.flatMap((run) => run.split('|').map((m) => m.trim().slice(1, -1)));
}

check('the shipped register has tools with modes to check', () => {
  assert.ok(tools.filter((t) => modes(t.instructions).length).length >= 5, 'the mode scan found almost nothing');
});

check('every mode in a shipped tool\'s instructions is findable in its name or summary', () => {
  const missing = [];
  for (const t of tools) {
    const brief = `${t.id || ''} ${t.name || ''} ${t.summary || ''}`.toLowerCase();
    for (const m of modes(t.instructions)) {
      const word = m.toLowerCase().replace(/^un(?=[a-z]{3})/, '');
      if (!brief.includes(word)) missing.push(`${t.name}: "${m}"`);
    }
  }
  assert.deepStrictEqual(missing, [], 'modes a search cannot find:\n  ' + missing.join('\n  '));
});

const EXPECTED = 2;
for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
const passed = results.filter((r) => r.ok).length;
if (passed === results.length && results.length === EXPECTED) {
  console.log(`\nPASS: register-briefs test - ${passed}/${EXPECTED} assertions passed (every mode findable from the brief)`);
  process.exit(0);
}
console.log(`\nFAIL: register-briefs test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
process.exit(1);
