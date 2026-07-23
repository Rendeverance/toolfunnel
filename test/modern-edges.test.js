'use strict';

/**
 * modern-edges.test.js - modern-era (2026-07-28 RC) conformance EDGES.
 * dual-era.test.js proves the mainline; this file pins the corners where a
 * misreading of the RC would hide - no real modern clients exist in the wild yet, so the
 * harness is the only thing standing between us and the 28-July reconciliation.
 *
 *   1. A stray `_meta` WITHOUT the protocolVersion key is NOT a modern request - served
 *      legacy, byte-clean of modern fields (era detection must not trigger on random _meta).
 *   2. String request ids survive the modern path verbatim (id-type preservation).
 *   3. Trio strictness is EXACTLY the spec's: clientCapabilities is MUST (-32602 when absent,
 *      pinned in dual-era) but clientInfo is only SHOULD - a request without it is tolerated
 *      and served modern. This pin guards against future over-strictness as much as laxity.
 *   4. An ARRAY payload (JSON-RPC batch - removed from MCP) neither crashes handleMessage
 *      nor produces a fabricated success.
 *   5. Modern tools/call results are decorated (resultType) while the legacy same-call stays
 *      byte-clean - the per-request rule on the EXECUTION path, not just listings.
 *
 * Run:  node test/modern-edges.test.js     (exit 0 = pass, non-zero = fail)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Sandbox home FIRST - before any src/ module resolves its config-home anchors.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-modedges-'));
process.env.TOOLFUNNEL_HOME = HOME;
require('../src/core/config-home').initConfigHome({});

const s = require('../src/mcp/server.js');

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'modern-edges-test', version: '0' },
};

let fails = 0;
function check(label, cond, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '  :: ' + (detail || '')));
  if (!cond) fails += 1;
}

(async () => {
  const build = s.buildProtocol();

  // 1. Stray _meta without protocolVersion -> LEGACY, byte-clean.
  const r1 = await s.handleMessage(build, {
    jsonrpc: '2.0', id: 1, method: 'tools/list',
    params: { _meta: { 'x-trace-id': 'abc', 'io.modelcontextprotocol/clientInfo': { name: 'x', version: '0' } } },
  });
  check('1: _meta without protocolVersion is served LEGACY (byte-clean)',
    r1 && r1.result && r1.result.resultType === undefined && r1.result.ttlMs === undefined &&
    r1.result._meta === undefined && Array.isArray(r1.result.tools),
    JSON.stringify(r1 && r1.result ? Object.keys(r1.result) : r1));

  // 2. String id survives the modern path verbatim.
  const r2 = await s.handleMessage(build, {
    jsonrpc: '2.0', id: 'req-abc-123', method: 'tools/list', params: { _meta: META },
  });
  check('2: string id preserved through the modern path',
    r2 && r2.id === 'req-abc-123' && r2.result && r2.result.resultType === 'complete',
    JSON.stringify(r2 && { id: r2.id, keys: Object.keys(r2.result || {}) }));

  // 3. clientInfo is SHOULD, not MUST (spec extract line 20): absence is tolerated, request
  //    served modern. Guards against future over-strictness; the MUST leg (capabilities) is
  //    pinned in dual-era.test.js.
  const partial = Object.assign({}, META);
  delete partial['io.modelcontextprotocol/clientInfo'];
  const r3 = await s.handleMessage(build, {
    jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: partial },
  });
  check('3: missing clientInfo (SHOULD) is tolerated - served modern',
    r3 && r3.result && r3.result.resultType === 'complete',
    JSON.stringify(r3 && (r3.error || (r3.result && Object.keys(r3.result)))));

  // 4. Array payload (batch): no crash, no fabricated success.
  let r4 = null, threw = null;
  try {
    r4 = await s.handleMessage(build, [
      { jsonrpc: '2.0', id: 41, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 42, method: 'ping', params: {} },
    ]);
  } catch (e) { threw = e; }
  check('4: array payload neither crashes nor fabricates a success',
    threw === null && !(r4 && r4.result),
    threw ? 'THREW: ' + threw.message : JSON.stringify(r4));

  // 5. Decoration on the EXECUTION path: modern tools/call decorated, legacy byte-clean.
  const callParams = { name: 'toolfunnel_list_tools', arguments: {} };
  const r5m = await s.handleMessage(build, {
    jsonrpc: '2.0', id: 5, method: 'tools/call', params: Object.assign({ _meta: META }, callParams),
  });
  const r5l = await s.handleMessage(build, {
    jsonrpc: '2.0', id: 6, method: 'tools/call', params: Object.assign({}, callParams),
  });
  check('5a: modern tools/call result is decorated (resultType)',
    r5m && r5m.result && r5m.result.resultType === 'complete' && Array.isArray(r5m.result.content),
    JSON.stringify(r5m && r5m.result ? Object.keys(r5m.result) : r5m));
  check('5b: legacy tools/call result stays byte-clean',
    r5l && r5l.result && r5l.result.resultType === undefined && r5l.result.ttlMs === undefined &&
    Array.isArray(r5l.result.content),
    JSON.stringify(r5l && r5l.result ? Object.keys(r5l.result) : r5l));

  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  console.log(fails === 0 ? 'PASS: modern-edges test - all assertions passed'
    : 'FAIL: modern-edges test - ' + fails + ' assertion(s) failed');
  process.exit(fails === 0 ? 0 : 1);
})().catch((err) => { console.error('modern-edges test crashed:', err); process.exit(1); });
