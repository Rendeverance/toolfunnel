'use strict';

/**
 * era-policy.test.js - the era-policy switches (2026-07-18, built for 0.6.0):
 *
 *   SERVER (serveLegacy:false in toolfunnel.json - modern-only, explicit opt-in):
 *     A1 legacy tools/list  -> -32020 naming the policy
 *     A2 legacy initialize  -> -32020 with the handshake-specific message
 *     A3 modern tools/list  -> served normally (resultType:'complete')
 *     A4 meta-less server/discover -> still answered (the negotiation endpoint is exempt)
 *     A5 legacy NOTIFICATION -> dropped silently (null - a notification never gets a response)
 *
 *   CLIENT (modernOnly per-upstream - legacyPin's mirror):
 *     B1 modernOnly against a LEGACY-only server -> connect REJECTS naming the policy
 *        (never a silent downgrade)
 *
 *   STORE:
 *     C1 legacyPin + modernOnly on one upstream -> validateUpstream throws (contradiction)
 *
 * Sandboxed config home (TOOLFUNNEL_HOME) - no shared on-disk state touched.
 * Run:  node test/era-policy.test.js     (exit 0 = pass, non-zero = fail)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Sandbox home with the modern-only policy WRITTEN BEFORE any src/ module loads.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-erapolicy-'));
fs.writeFileSync(path.join(HOME, 'toolfunnel.json'), JSON.stringify({ serveLegacy: false }));
process.env.TOOLFUNNEL_HOME = HOME;
require('../src/core/config-home').initConfigHome({});

const s = require('../src/mcp/server.js');
const { McpClient } = require('../src/mcp/mcp-client.js');
const { validateUpstream } = require('../src/mcp/expose-store.js');

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'era-policy-test', version: '0' },
};

let fails = 0;
function check(label, cond, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '  :: ' + (detail || '')));
  if (!cond) fails += 1;
}

// A legacy-only mock server for B1 (answers initialize, rejects everything unknown).
const LEGACY_MOCK = `'use strict';
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch (_e) { continue; }
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: '2024-11-05', serverInfo: { name: 'legacy-only', version: '1.0' },
        capabilities: { tools: {} } } }) + '\\n');
    } else if (msg.id !== undefined && msg.id !== null) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        error: { code: -32601, message: 'Method not found' } }) + '\\n');
    }
  }
});
`;

(async () => {
  const build = s.buildProtocol();

  // A1 - legacy request refused with the policy named.
  const a1 = await s.handleMessage(build, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  check('A1: legacy tools/list -> -32020 naming the policy',
    a1 && a1.error && a1.error.code === -32020 && /serveLegacy:false/.test(a1.error.message),
    JSON.stringify(a1));

  // A2 - legacy initialize gets the handshake-specific message.
  const a2 = await s.handleMessage(build, {
    jsonrpc: '2.0', id: 2, method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'x', version: '0' }, capabilities: {} },
  });
  check('A2: legacy initialize -> -32020 with the handshake message',
    a2 && a2.error && a2.error.code === -32020 && /initialize handshake is disabled/.test(a2.error.message),
    JSON.stringify(a2));

  // A3 - modern requests are served normally.
  const a3 = await s.handleMessage(build, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: META } });
  check('A3: modern tools/list served (resultType complete)',
    a3 && a3.result && a3.result.resultType === 'complete', JSON.stringify(a3 && (a3.error || Object.keys(a3.result || {}))));

  // A4 - the negotiation endpoint stays answerable meta-less.
  const a4 = await s.handleMessage(build, { jsonrpc: '2.0', id: 4, method: 'server/discover', params: {} });
  check('A4: meta-less server/discover still answered',
    a4 && a4.result && Array.isArray(a4.result.supportedVersions), JSON.stringify(a4));

  // A5 - a legacy notification is dropped silently.
  const a5 = await s.handleMessage(build, { jsonrpc: '2.0', method: 'notifications/initialized' });
  check('A5: legacy notification dropped (no response fabricated)', a5 === null || a5 === undefined, JSON.stringify(a5));

  // B1 - modernOnly refuses the legacy fallback.
  const mockPath = path.join(HOME, 'legacy-only.js');
  fs.writeFileSync(mockPath, LEGACY_MOCK);
  const client = new McpClient({ id: 'legacy-only', command: process.execPath, args: [mockPath], modernOnly: true });
  let b1err = null;
  try { await client.connect(); } catch (e) { b1err = e; }
  client.close();
  check('B1: modernOnly vs a legacy-only server -> connect rejects naming the policy',
    !!(b1err && /modernOnly/.test(b1err.message) && /refusing the legacy fallback/.test(b1err.message)),
    b1err ? b1err.message : 'connect unexpectedly succeeded');

  // C1 - the contradiction is refused at the store.
  let c1err = null;
  try {
    validateUpstream({ id: 'both', transport: 'stdio', command: 'node', legacyPin: true, modernOnly: true }, new Map());
  } catch (e) { c1err = e; }
  check('C1: legacyPin + modernOnly on one upstream -> validation throws',
    !!(c1err && /contradict/.test(c1err.message)), c1err ? c1err.message : 'no throw');

  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  console.log(fails === 0 ? 'PASS: era-policy test - all assertions passed'
    : 'FAIL: era-policy test - ' + fails + ' assertion(s) failed');
  process.exit(fails === 0 ? 0 : 1);
})().catch((err) => { console.error('era-policy test crashed:', err); process.exit(1); });
