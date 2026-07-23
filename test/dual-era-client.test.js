'use strict';

/**
 * dual-era-client.test.js - ToolFunnel as a DUAL-ERA CLIENT to its upstreams.
 *
 * The server side (dual-era.test.js) proves ToolFunnel serves both client eras. This proves the
 * other direction: ToolFunnel's own McpClient auto-negotiates the era of each UPSTREAM - it probes
 * `server/discover` first (modern), and only falls back to the legacy `initialize` handshake when
 * that is rejected. Over stdio the modern era needs only per-request `_meta` (the Mcp-* headers are
 * HTTP-only), which is exactly what the strict mock-modern fixture requires.
 *
 * Fixtures (bundled, zero-dep): mcp/servers/mock-modern (2026-07-28) + mock-upstream (legacy).
 *
 * Asserts:
 *   1. Modern upstream -> era negotiated 'modern'; identity from server/discover; tools/list +
 *      tools/call work (the client sends the required _meta - the mock rejects calls without it).
 *   2. Legacy upstream -> era negotiated 'legacy'; identity from initialize; tools work (unchanged).
 *   3. Through the Aggregator: a modern upstream connects, leanToolDefinitions surfaces its tools,
 *      and wrappedIdentity reports the modern server's identity (so a WRAP of a modern upstream
 *      presents AS that server too).
 *
 * Exit 0 on success; 1 with a FAIL line per failed assertion.
 */

const fs = require('node:fs');
const path = require('node:path');
const { McpClient } = require('../src/mcp/mcp-client.js');
const { Aggregator } = require('../src/mcp/aggregator.js');
const { ExposeStore } = require('../src/mcp/expose-store.js');
const s = require('../src/mcp/server.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const MODERN = path.join(REPO_ROOT, 'mcp', 'servers', 'mock-modern', 'server.js');
const LEGACY = path.join(REPO_ROOT, 'mcp', 'servers', 'mock-upstream', 'server.js');

let fails = 0;
function check(label, cond) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label);
  if (!cond) fails += 1;
}

(async () => {
  try {
    // 1. MODERN upstream - negotiate modern (server/discover, no initialize), _meta on every call.
    const m = new McpClient({ id: 'm', command: process.execPath, args: [MODERN] });
    const mInit = await m.connect();
    check('modern upstream: negotiated era = modern', m.era === 'modern');
    check('modern upstream: identity from server/discover (mock-modern)',
      mInit.serverInfo && mInit.serverInfo.name === 'mock-modern');
    check('modern upstream: supportedVersions = [2026-07-28]',
      JSON.stringify(mInit.supportedVersions) === '["2026-07-28"]');
    const mTools = await m.listTools();
    check('modern upstream: tools/list works with _meta (3 tools)', mTools.length === 3 && mTools.some((t) => t.name === 'add'));
    const mCall = await m.callTool('add', { a: 7, b: 8 });
    check('modern upstream: tools/call works (7+8=15)', !mCall.isError && /15/.test(JSON.stringify(mCall.content)));
    m.close();

    // 2. LEGACY upstream - server/discover rejected -> initialize; unchanged behaviour.
    const l = new McpClient({ id: 'l', command: process.execPath, args: [LEGACY] });
    const lInit = await l.connect();
    check('legacy upstream: negotiated era = legacy', l.era === 'legacy');
    check('legacy upstream: identity from initialize (mock-upstream)',
      lInit.serverInfo && lInit.serverInfo.name === 'mock-upstream');
    const lCall = await l.callTool('add', { a: 2, b: 2 });
    check('legacy upstream: tools/call works (2+2=4)', !lCall.isError && /4/.test(JSON.stringify(lCall.content)));
    l.close();

    // 3. Through the Aggregator - a modern upstream connects + surfaces tools + reports its identity.
    const store = new ExposeStore({
      filePath: path.join(REPO_ROOT, 'test', '.dual-era-client-expose.json'),
      data: { version: 1, upstreams: [{ id: 'modern', transport: 'stdio', command: process.execPath, args: [MODERN], enabled: true }], expose: [] },
    });
    const agg = new Aggregator({ store });
    const res = await agg.connectAll();
    check('aggregator: connected the modern upstream', res.connected.includes('modern'));
    const defs = agg.leanToolDefinitions().filter((d) => d.upstream === 'modern');
    check('aggregator: modern upstream tools surfaced', defs.length === 3 && defs.some((d) => d.tool === 'add'));
    const ident = agg.wrappedIdentity('modern');
    check('aggregator: wrappedIdentity reports the modern server (for a wrap)',
      ident && ident.serverInfo && ident.serverInfo.name === 'mock-modern' && typeof ident.instructions === 'string');
    await agg.closeAll();

    // ── Regression pins ─────────────────────────────────────────

    // RF1 (HIGH): legacyPin/forceLegacy FORCES the legacy path - it skips the modern discover probe,
    // so a MODERN-ONLY upstream (which has no initialize) FAILS to connect rather than being
    // negotiated modern. Without the flag it connects modern (proven above). The contrast proves the
    // pin is an enforced policy, not just a warning.
    let pinnedFailed = false;
    const pinned = new McpClient({ id: 'pinned', command: process.execPath, args: [MODERN], forceLegacy: true });
    try { await pinned.connect(); } catch (_e) { pinnedFailed = true; }
    check('RF1: forceLegacy skips discover -> modern-only upstream is NOT spoken to as modern', pinnedFailed && pinned.era === 'legacy');
    pinned.close();

    // RF3 (MEDIUM): the era probe only treats a reply as modern if it LISTS 2026-07-28. A permissive
    // legacy server that answers server/discover with {} must fall back to legacy, not be misdetected.
    // (mock-upstream returns -32601 for unknown methods -> already legacy; this asserts the negotiated
    // era for a real legacy server stays legacy through the stricter probe.)
    const l2 = new McpClient({ id: 'l2', command: process.execPath, args: [LEGACY] });
    await l2.connect();
    check('RF3: legacy server (no modern DiscoverResult) negotiates legacy', l2.era === 'legacy');
    l2.close();

    // RF5: the PLAUSIBLE-but-non-modern probe reply, exercised for real - a permissive legacy
    // server that ACKs server/discover with `{}` (fixture flag) must fall back to LEGACY on the
    // same child and work end-to-end. This is the misdetection the strict probe check guards.
    process.env.TF_MOCK_DISCOVER_EMPTY = '1';
    let permEra = null; let permOk = false;
    try {
      const perm = new McpClient({ id: 'perm', command: process.execPath, args: [LEGACY] });
      await perm.connect();
      permEra = perm.era;
      const permCall = await perm.callTool('add', { a: 3, b: 4 });
      permOk = !permCall.isError && /7/.test(JSON.stringify(permCall.content));
      perm.close();
    } finally {
      delete process.env.TF_MOCK_DISCOVER_EMPTY;
    }
    check('RF5: permissive {} discover reply -> legacy negotiation, calls work', permEra === 'legacy' && permOk);

    // RF2 (MEDIUM): a wrap forwarding a CacheableResult (resources/list) to a MODERN upstream returns
    // resultType + REQUIRED ttlMs/cacheScope + the UPSTREAM's serverInfo. Drive handleMessage under a
    // wrap with a minimal build.
    const stateFile = path.join(REPO_ROOT, 'test', '.dual-era-client-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ passthrough: 'modern' }));
    const store2 = new ExposeStore({
      filePath: path.join(REPO_ROOT, 'test', '.dual-era-client-expose2.json'),
      data: { version: 1, upstreams: [{ id: 'modern', transport: 'stdio', command: process.execPath, args: [MODERN], enabled: true }], expose: [] },
    });
    const agg2 = new Aggregator({ store: store2 });
    await agg2.connectAll();
    const build = { aggregator: agg2, toolStatePath: stateFile };
    const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
    const fwd = await s.handleMessage(build, { jsonrpc: '2.0', id: 40, method: 'resources/list', params: { _meta: META } });
    check('RF2: wrap-forwarded resources/list carries resultType + ttlMs + cacheScope + upstream serverInfo',
      fwd.result && fwd.result.resultType === 'complete' && typeof fwd.result.ttlMs === 'number' &&
      typeof fwd.result.cacheScope === 'string' &&
      fwd.result._meta['io.modelcontextprotocol/serverInfo'].name === 'mock-modern' &&
      Array.isArray(fwd.result.resources));

    // RF4: a LEGACY client's initialize under a MODERN-upstream wrap must receive a protocolVersion
    // it can speak - the wrapped identity carries 2026-07-28, and passing that through verbatim
    // makes a conforming legacy client disconnect (the exact corner the wrap exists to serve).
    // Identity fields stay verbatim.
    const init4 = await s.handleMessage(build, { jsonrpc: '2.0', id: 41, method: 'initialize',
      params: { protocolVersion: '2024-11-05', clientInfo: { name: 't', version: '0' } } });
    check('RF4: legacy initialize under a modern-upstream wrap clamps protocolVersion to legacy',
      init4.result && init4.result.protocolVersion === s.PROTOCOL_VERSION &&
      init4.result.serverInfo && init4.result.serverInfo.name === 'mock-modern');
    await agg2.closeAll();
    try { fs.unlinkSync(stateFile); } catch (_e) {}

    // ── Bridge A: resource/prompt change-subscriptions -> modern subscriptions/listen ─────────────
    const modern = require('../src/mcp/modern.js');

    // BR-A1: the filter - a notification is delivered only to a stream that AGREED to its channel.
    const agreedTools = modern.normaliseListenFilter({ notifications: { toolsListChanged: true } }).agreed;
    const agreedRes = modern.normaliseListenFilter({ notifications: { resourceSubscriptions: ['mock://modern/example'] } }).agreed;
    check('BR-A1: tools/list_changed matches a toolsListChanged sub',
      modern.notificationMatchesFilter({ method: 'notifications/tools/list_changed' }, agreedTools));
    check('BR-A1: tools/list_changed does NOT match a resource-only sub',
      !modern.notificationMatchesFilter({ method: 'notifications/tools/list_changed' }, agreedRes));
    check('BR-A1: resources/updated matches only the SUBSCRIBED uri',
      modern.notificationMatchesFilter({ method: 'notifications/resources/updated', params: { uri: 'mock://modern/example' } }, agreedRes) &&
      !modern.notificationMatchesFilter({ method: 'notifications/resources/updated', params: { uri: 'other://x' } }, agreedRes));
    check('BR-A1: an unknown notification method matches nothing',
      !modern.notificationMatchesFilter({ method: 'notifications/message' }, agreedTools));

    // BR-A2: end-to-end - an upstream's server-initiated resources/updated reaches the aggregator's
    // onUpstreamNotification hook (McpClient.onNotification -> _forwardUpstreamNotification), and a
    // non-bridged notification does NOT.
    let captured = null;
    const capturingFactory = (upstream, _v3Root, onClose) =>
      (captured = new McpClient({ id: upstream.id, command: process.execPath, args: upstream.args, onClose }));
    const store3 = new ExposeStore({
      filePath: path.join(REPO_ROOT, 'test', '.dual-era-client-expose3.json'),
      data: { version: 1, upstreams: [{ id: 'modern', transport: 'stdio', command: process.execPath, args: [MODERN], enabled: true }], expose: [] },
    });
    const agg3 = new Aggregator({ store: store3, clientFactory: capturingFactory });
    const bridged = [];
    agg3.onUpstreamNotification = (uid, n) => bridged.push({ uid, n });
    await agg3.connectAll();
    await captured.callTool('ping'); // the mock emits resources/updated, THEN replies pong
    await new Promise((r) => setImmediate(r)); // let the notification line flush through
    check('BR-A2: upstream resources/updated bridged to onUpstreamNotification',
      bridged.some((b) => b.n.method === 'notifications/resources/updated' && b.n.params.uri === 'mock://modern/example' && b.uid === 'modern'));
    const before = bridged.length;
    agg3._forwardUpstreamNotification('modern', { method: 'notifications/message', params: {} });
    check('BR-A2: a non-bridged notification is ignored (not forwarded)', bridged.length === before);
    // BR-A3: the fixture's emission above is PLUMBING-only - a conformant
    // modern upstream delivers notifications solely inside a subscriptions/listen stream, which
    // this client does not yet open. The listen ack must therefore NEVER count a modern upstream
    // as able to honour resourceSubscriptions - an agreed channel nothing will ever feed.
    check('BR-A3: a modern-only aggregator does NOT claim it can honour resource subscriptions',
      agg3.canHonourResourceSubscriptions() === false);
    await agg3.closeAll();

    // BR-A4: discover works on a DISABLED upstream - inspecting its
    // tools before enabling is a deliberate operator action (pre-race-fix behaviour, restored
    // via allowDisabled). The disabled upstream still never reaches the lean surface.
    const store4 = new ExposeStore({
      filePath: path.join(REPO_ROOT, 'test', '.dual-era-client-expose4.json'),
      data: { version: 1, upstreams: [{ id: 'offbox', transport: 'stdio', command: process.execPath, args: [MODERN], enabled: false }], expose: [] },
    });
    const agg4 = new Aggregator({ store: store4 });
    let discovered4 = null;
    try { discovered4 = await agg4.discover('offbox'); } catch (_e) { discovered4 = null; }
    check('BR-A4: discover connects + lists a DISABLED upstream',
      Array.isArray(discovered4) && discovered4.length > 0);
    check('BR-A4: the disabled upstream stays OFF the lean surface',
      !agg4.leanToolDefinitions().some((d) => d.upstream === 'offbox'));
    await agg4.closeAll();
  } catch (err) {
    console.error('dual-era-client.test.js CRASH:', (err && err.stack) || String(err));
    fails += 1;
  }

  if (fails === 0) console.log('dual-era-client.test.js: all assertions passed');
  process.exit(fails === 0 ? 0 : 1);
})();
