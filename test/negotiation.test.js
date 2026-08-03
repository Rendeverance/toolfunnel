'use strict';

/**
 * negotiation.test.js - legacy version negotiation + the widened version set (three 0.7.0
 * changes, one bundle: 2.1's echo is unobservable until 2.2 widens the list, and
 * shipping 2.2 without 2.5's error-site filter would ship the measured retry loop mid-branch).
 *
 * 0.6.0 ignores initialize's requested protocolVersion entirely - every answer is 2024-11-05 -
 * and supports exactly one legacy revision. The contract after the bundle:
 *
 *   2.1 NON-WRAP initialize: echo the REQUESTED version when we support it, else answer our
 *       LATEST legacy (lifecycle SHOULD). Absent or non-string request keeps the frozen
 *       2024-11-05 answer (pinned frozen behaviour). The wrap branch is untouched (upstream-clamped).
 *       The negotiated answer is STORED on the build (2.3's stdio batching gate needs it).
 *   2.2 Legacy set = {2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25}; supportedVersions()
 *       advertises all of them (server/discover + /health legitimately span both eras).
 *   2.5 The -32022 error site answers data.supported = [modern] ONLY - the legacy versions are
 *       initialize-channel vocabulary, not _meta vocabulary. Advertising 2024-11-05 there
 *       re-armed a measured retry loop (a client offered it re-pins it in _meta and is
 *       rejected forever). Filtered AT THE ERROR SITE only, never in supportedVersions().
 *
 * In-process (http.test.js pattern - default config, shared repo home untouched).
 * Exit 0 = contract holds; 1 = the shipped 0.6.0 behaviour; 2 = sanity broke.
 * CommonJS. Node built-ins only.
 */

const s = require('../src/mcp/server.js');
const modern = require('../src/mcp/modern.js');

const MODERN_VERSION = '2026-07-28';
const LEGACY_ALL = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const META = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'negotiation-test', version: '0.0.0' },
};

let fails = 0;
let sanityBroke = false;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

const initMsg = (id, protocolVersion) => {
  const params = { capabilities: {}, clientInfo: { name: 'negotiation-test', version: '0' } };
  if (protocolVersion !== undefined) params.protocolVersion = protocolVersion;
  return { jsonrpc: '2.0', id, method: 'initialize', params };
};

(async () => {
  const build = s.buildProtocol();
  let id = 0;

  // 1. SANITY: requesting 2024-11-05 answers 2024-11-05 (identical before AND after).
  const r1 = await s.handleMessage(build, initMsg(++id, '2024-11-05'));
  const r1ok = r1 && r1.result && r1.result.protocolVersion === '2024-11-05';
  check('sanity: requested 2024-11-05 -> answered 2024-11-05', r1ok, JSON.stringify(r1 && r1.result).slice(0, 120));
  if (!r1ok) sanityBroke = true;

  // 2. RED: each supported legacy revision is ECHOED (0.6.0 answers 2024-11-05 to everything).
  for (const v of ['2025-03-26', '2025-06-18', '2025-11-25']) {
    const r = await s.handleMessage(build, initMsg(++id, v));
    check(`requested ${v} -> echoed ${v}`,
      r && r.result && r.result.protocolVersion === v,
      'answered ' + JSON.stringify(r && r.result && r.result.protocolVersion));
  }

  // 3. RED: an UNSUPPORTED string -> our LATEST legacy (lifecycle SHOULD), not the oldest.
  const r3 = await s.handleMessage(build, initMsg(++id, '2099-01-01'));
  check('unsupported string 2099-01-01 -> latest legacy 2025-11-25',
    r3 && r3.result && r3.result.protocolVersion === '2025-11-25',
    'answered ' + JSON.stringify(r3 && r3.result && r3.result.protocolVersion));

  // 4. The MODERN version on initialize is not a legacy version: clamp to latest legacy too
  //    (initialize IS the legacy path - header rules already pin that elsewhere).
  const r4 = await s.handleMessage(build, initMsg(++id, MODERN_VERSION));
  check('modern 2026-07-28 on initialize -> clamped to latest legacy 2025-11-25',
    r4 && r4.result && r4.result.protocolVersion === '2025-11-25',
    'answered ' + JSON.stringify(r4 && r4.result && r4.result.protocolVersion));

  // 5. FROZEN: absent + non-string requests keep today's 2024-11-05 answer (pinned frozen behaviour).
  const r5a = await s.handleMessage(build, initMsg(++id));
  const r5b = await s.handleMessage(build, initMsg(++id, 42));
  check('absent protocolVersion -> frozen 2024-11-05',
    r5a && r5a.result && r5a.result.protocolVersion === '2024-11-05',
    'answered ' + JSON.stringify(r5a && r5a.result && r5a.result.protocolVersion));
  check('non-string protocolVersion (42) -> frozen 2024-11-05',
    r5b && r5b.result && r5b.result.protocolVersion === '2024-11-05',
    'answered ' + JSON.stringify(r5b && r5b.result && r5b.result.protocolVersion));

  // 6. RED: the negotiated answer is STORED (2.3's stdio batching gate reads it).
  const r6 = await s.handleMessage(build, initMsg(++id, '2025-03-26'));
  check('negotiated version stored on the build (2.3 state)',
    r6 && r6.result && build.negotiatedLegacyVersion === '2025-03-26',
    'build.negotiatedLegacyVersion = ' + JSON.stringify(build.negotiatedLegacyVersion));

  // 7. RED: server/discover advertises the WIDENED set (both eras - the full truth).
  const r7 = await s.handleMessage(build, { jsonrpc: '2.0', id: ++id, method: 'server/discover', params: {} });
  const sv = r7 && r7.result && r7.result.supportedVersions;
  check('server/discover supportedVersions = modern + all four legacy',
    Array.isArray(sv) && sv.includes(MODERN_VERSION) && LEGACY_ALL.every((v) => sv.includes(v)) && sv.length === 5,
    'supportedVersions = ' + JSON.stringify(sv));

  // 8. RED: the -32022 error site advertises ONLY what _meta can carry - the modern version.
  //    (Listing 2024-11-05 there re-armed the measured retry loop.)
  const r8 = await s.handleMessage(build, {
    jsonrpc: '2.0', id: ++id, method: 'tools/list',
    params: { _meta: Object.assign({}, META, { 'io.modelcontextprotocol/protocolVersion': '2024-11-05' }) },
  });
  const d8 = r8 && r8.error && r8.error.data;
  check('-32022 data.supported = [modern] only (retry loop killed)',
    r8 && r8.error && r8.error.code === -32022 && d8 &&
      JSON.stringify(d8.supported) === JSON.stringify([MODERN_VERSION]) && d8.requested === '2024-11-05',
    'error = ' + JSON.stringify(r8 && r8.error).slice(0, 220));

  // 9. supportedVersions() itself stays WHOLE (2.5's filter is error-site only; narrowing the
  //    function breaks server/discover - v5's explicit warning).
  const whole = modern.supportedVersions();
  check('modern.supportedVersions() stays whole (5 versions)',
    Array.isArray(whole) && whole.length === 5 && whole[0] === MODERN_VERSION,
    'supportedVersions() = ' + JSON.stringify(whole));

  // 10. SANITY: a modern request with the CORRECT version is served (validator untouched).
  const r10 = await s.handleMessage(build, { jsonrpc: '2.0', id: ++id, method: 'tools/list', params: { _meta: META } });
  const r10ok = r10 && r10.result && Array.isArray(r10.result.tools);
  check('sanity: correct modern _meta version still served', r10ok, JSON.stringify(r10).slice(0, 140));
  if (!r10ok) sanityBroke = true;

  console.log(fails ? `\n${fails} negotiation failure(s).` : '\nnegotiation contract holds.');
  process.exit(sanityBroke ? 2 : (fails ? 1 : 0));
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
