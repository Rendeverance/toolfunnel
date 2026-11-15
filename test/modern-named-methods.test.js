#!/usr/bin/env node
/**
 * modern-named-methods.test.js - the Mcp-Name rule applies to the three named methods, never to a
 * method that merely shares a name with something on Object.prototype.
 *
 * NAMED_METHODS was a plain object literal, so `NAMED_METHODS['toString']` (or 'constructor',
 * 'valueOf', 'hasOwnProperty') resolved to an inherited FUNCTION - truthy - and the validator
 * demanded an Mcp-Name header for a method it does not name. The client got "Header mismatch:
 * Mcp-Name header is required for toString" instead of the method-not-found it should reach.
 * The table is now null-prototype, so only its three own keys are named methods.
 *
 * Run:  node test/modern-named-methods.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const path = require('node:path');
const assert = require('node:assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const modern = require(path.join(REPO_ROOT, 'src', 'mcp', 'modern.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
const V = '2026-07-28';
const msgFor = (method, params) => ({ jsonrpc: '2.0', id: 1, method, params: Object.assign({ _meta: { 'io.modelcontextprotocol/protocolVersion': V } }, params || {}) });
const headersFor = (method, extra) => Object.assign({ 'mcp-protocol-version': V, 'mcp-method': method }, extra || {});

// Sanity: a real named method without Mcp-Name is a mismatch (the rule itself still holds).
const named = modern.validateModernHeaders(headersFor('tools/call'), msgFor('tools/call', { name: 'echo' }));
check('sanity: tools/call without Mcp-Name is a header mismatch', () => {
  assert.ok(named && /Mcp-Name header is required/.test(named.message), 'got ' + JSON.stringify(named));
});
const namedOk = modern.validateModernHeaders(headersFor('tools/call', { 'mcp-name': 'echo' }), msgFor('tools/call', { name: 'echo' }));
check('sanity: tools/call with a matching Mcp-Name passes', () => {
  assert.strictEqual(namedOk, null, 'got ' + JSON.stringify(namedOk));
});

// The defect: methods that are Object.prototype property names are NOT named methods.
for (const m of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
  const r = modern.validateModernHeaders(headersFor(m), msgFor(m, {}));
  check(`a method named "${m}" is not treated as a named method (no Mcp-Name demanded)`, () => {
    assert.strictEqual(r, null, 'got ' + JSON.stringify(r));
  });
}

for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
const passed = results.filter((r) => r.ok).length;
const expected = 7;
if (passed === results.length && results.length === expected) {
  console.log(`\nPASS: modern-named-methods test - ${passed}/${expected} assertions passed (prototype names are not named methods)`);
  process.exit(0);
}
console.log(`\nFAIL: modern-named-methods test - ${passed}/${results.length} assertions passed`);
process.exit(1);
