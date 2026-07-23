'use strict';

/**
 * ui-matrix.test.js - exercises the config UI server's MATRIX surface over REAL loopback HTTP:
 * the per-tool hot/hidden axes on /api/tools + /api/tools/state, the top-level /api/surface summary
 * (meta-tool hot states, promotion counts, footgun warnings), and the live /api/mcp/discover button
 * (connect an upstream, list its tools, return their surfaced names + lean/hot state). Starts the
 * real createUiServer() on an ephemeral port and talks to it with node:http - no mocks of the wire.
 *
 *   A - /api/tools carries enabled/hidden/hot per tool (defaults: enabled on, hidden off, hot off).
 *   B - POST /api/tools/state {hot:true} promotes a tool; the GET reflects it.
 *   C - the axes are INDEPENDENT: setting enabled:false leaves hot:true intact (merge, not replace).
 *   D - POST /api/tools/state with NO axis -> 400 (must name at least one of enabled/hidden/hot).
 *   E - /api/surface lists the 4 meta-tools (default hot) and counts promotions (a hot+DISABLED tool
 *       is NOT counted - it isn't actually on the surface).
 *   F - promoting an enabled tool bumps promotedTotal; hiding toolfunnel_list_tools/run warns.
 *   G - promoting > 10 tools raises the context-bloat warning.
 *   H - POST /api/mcp/discover connects the bundled mock upstream and returns mock_ping (surfaced),
 *       with its lean/hot state; an unknown upstream is a clean 404.
 *   J - the bind guard: the UI has NO auth path, so start() on a non-loopback host (0.0.0.0, a LAN
 *       address) is hard-refused; loopback hosts still bind.
 *   K - isLoopbackBindHost is STRICT (empty/whitespace ≠ loopback) where the Host-HEADER check is
 *       deliberately lenient (a missing header defers to the bind address).
 *
 * NON-DESTRUCTIVE: tools/tools.state.json + mcp/expose.json are snapshotted and restored. Node built-ins only.
 *
 * Run:  node test/ui-matrix.test.js     (exit 0 = pass, non-zero = fail)
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');
const http = require('node:http');

const REPO_ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(REPO_ROOT, 'tools', 'tools.state.json');
const EXPOSE_PATH = path.join(REPO_ROOT, 'mcp', 'expose.json');
// Normally ABSENT at the repo root - snapshotted and RE-ABSENTED in finally (a leftover file
// would flip the gateway's identity and break server-config.test.js's absent-file assumptions).
const TOOLFUNNEL_JSON = path.join(REPO_ROOT, 'toolfunnel.json');
const MOCK_SERVER = path.join(REPO_ROOT, 'mcp', 'servers', 'mock-upstream', 'server.js');

const { createUiServer, isLoopbackHost, isLoopbackBindHost } = require('../src/ui/server');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
function snapshot(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_e) { return null; } }
function restore(p, snap) {
  try {
    if (snap === null) { if (fs.existsSync(p)) fs.unlinkSync(p); }
    else { fs.writeFileSync(p, snap); }
  } catch (_e) { /* best-effort */ }
}
function writeState(obj) { fs.writeFileSync(STATE_PATH, JSON.stringify(obj, null, 2) + '\n'); }

/** Minimal loopback JSON client. Resolves { status, json }. `extraHeaders` for the CSRF tests. */
function req(base, method, p, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url = new URL(p, base);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: Object.assign({ Accept: 'application/json' }, extraHeaders || {}),
    };
    if (payload) { opts.headers['Content-Type'] = 'application/json'; opts.headers['Content-Length'] = payload.length; }
    const r = http.request(opts, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_e) { /* leave null */ }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

(async () => {
  const stateSnap = snapshot(STATE_PATH);
  const exposeSnap = snapshot(EXPOSE_PATH);
  const tfJsonSnap = snapshot(TOOLFUNNEL_JSON);
  let server = null;
  let fatal = null;

  try {
    assert.ok(fs.existsSync(MOCK_SERVER), 'mock upstream missing at ' + MOCK_SERVER);
    // Mock upstream attached (for the discover test); empty state (defaults).
    fs.writeFileSync(EXPOSE_PATH, JSON.stringify({
      version: 1,
      upstreams: [{ id: 'mock', transport: 'stdio', command: process.execPath, args: [MOCK_SERVER], enabled: true, description: 'ui-matrix.test.js fixture.' }],
      expose: [],
    }, null, 2) + '\n');
    writeState({});

    server = createUiServer({ host: '127.0.0.1', port: 0, root: REPO_ROOT });
    const { url } = await server.start();
    const get = (p) => req(url, 'GET', p);
    const post = (p, b) => req(url, 'POST', p, b);

    // A - /api/tools carries the matrix axes with the right defaults.
    const toolsA = (await get('/api/tools')).json;
    check('A: /api/tools returns the matrix axes (enabled/hidden/hot) per tool, with sane defaults', () => {
      assert.ok(Array.isArray(toolsA), '/api/tools is not an array');
      const uuid = toolsA.find((t) => t.id === 'uuid');
      assert.ok(uuid, 'uuid tool missing');
      assert.strictEqual(uuid.enabled, true, 'enabled should default true');
      assert.strictEqual(uuid.hidden, false, 'hidden should default false');
      assert.strictEqual(uuid.hot, false, 'hot should default false');
    });

    // B - promote via the API.
    const setB = await post('/api/tools/state', { id: 'uuid', hot: true });
    const toolsB = (await get('/api/tools')).json;
    check('B: POST /api/tools/state {hot:true} promotes the tool', () => {
      assert.strictEqual(setB.status, 200, 'set hot status ' + setB.status);
      const uuid = toolsB.find((t) => t.id === 'uuid');
      assert.strictEqual(uuid && uuid.hot, true, 'uuid.hot not true after promote');
    });

    // C - axes are independent (merge, not replace).
    await post('/api/tools/state', { id: 'uuid', enabled: false });
    const toolsC = (await get('/api/tools')).json;
    check('C: axes are independent - enabled:false leaves hot:true intact', () => {
      const uuid = toolsC.find((t) => t.id === 'uuid');
      assert.strictEqual(uuid && uuid.enabled, false, 'uuid.enabled should be false');
      assert.strictEqual(uuid && uuid.hot, true, 'uuid.hot should still be true (independent)');
    });

    // C2 - the hidden axis writes + reports via the UI server, independent of enabled/hot (3 axes).
    await post('/api/tools/state', { id: 'uuid', hidden: true });
    const toolsC2 = (await get('/api/tools')).json;
    check('C: the hidden axis is settable via the UI and independent (enabled/hot preserved)', () => {
      const uuid = toolsC2.find((t) => t.id === 'uuid');
      assert.strictEqual(uuid && uuid.hidden, true, 'uuid.hidden should be true');
      assert.strictEqual(uuid && uuid.enabled, false, 'enabled clobbered by hidden write');
      assert.strictEqual(uuid && uuid.hot, true, 'hot clobbered by hidden write');
    });

    // D - no axis -> 400.
    const setD = await post('/api/tools/state', { id: 'uuid' });
    check('D: POST /api/tools/state with no axis is a 400', () => {
      assert.strictEqual(setD.status, 400, 'expected 400, got ' + setD.status);
      assert.ok(setD.json && setD.json.ok === false, 'expected ok:false');
    });

    // E - /api/surface: 4 meta-tools (default hot); a hot+disabled tool is NOT counted.
    const surfE = (await get('/api/surface')).json;
    check('E: /api/surface lists 4 meta-tools (default hot) and excludes a hot-but-disabled tool', () => {
      assert.ok(Array.isArray(surfE.meta) && surfE.meta.length === 4, 'expected 4 meta-tools; got ' + JSON.stringify(surfE.meta));
      assert.ok(surfE.meta.every((m) => m.hot === true), 'all meta-tools should default hot');
      assert.strictEqual(surfE.promotedTotal, 0, 'uuid is hot but DISABLED -> must not be counted; got ' + surfE.promotedTotal);
    });

    // F - promote an enabled tool; bump the count. Then hide list+run -> warning.
    writeState({});
    await post('/api/tools/state', { id: 'echo', hot: true });
    const surfF1 = (await get('/api/surface')).json;
    check('F: promoting an enabled local tool bumps promotedTotal', () => {
      assert.strictEqual(surfF1.promotedTotal, 1, 'expected 1 promotion (echo); got ' + surfF1.promotedTotal);
      assert.strictEqual(surfF1.promotedLocal, 1, 'echo should count as a local promotion');
    });
    await post('/api/tools/state', { id: 'toolfunnel_list_tools', hot: false });
    await post('/api/tools/state', { id: 'toolfunnel_run_tool', hot: false });
    const surfF2 = (await get('/api/surface')).json;
    check('F: hiding toolfunnel_list_tools/run raises a warning', () => {
      assert.ok(Array.isArray(surfF2.warnings) && surfF2.warnings.length >= 1, 'expected a warning when list/run are hidden');
      assert.ok(surfF2.meta.find((m) => m.name === 'toolfunnel_list_tools').hot === false, 'list should read hot:false');
    });

    // G - bloat warning when > 10 tools are promoted (write the overlay directly: 11 hot keys).
    const bloat = {};
    for (let i = 0; i < 11; i += 1) bloat['promoted_' + i] = { hot: true };
    writeState(bloat);
    const surfG = (await get('/api/surface')).json;
    check('G: promoting > 10 tools raises the context-bloat warning', () => {
      assert.ok(surfG.promotedTotal >= 11, 'expected >=11 promoted; got ' + surfG.promotedTotal);
      assert.ok((surfG.warnings || []).some((w) => /every turn/i.test(w)), 'expected a bloat warning; got ' + JSON.stringify(surfG.warnings));
    });

    // H - live discover: connect the mock upstream, list its tools (surfaced names + lean/hot state).
    writeState({});
    const discH = (await post('/api/mcp/discover', { id: 'mock' })).json;
    check('H: POST /api/mcp/discover connects the upstream and returns mock_ping (surfaced) with lean/hot state', () => {
      assert.ok(discH && discH.ok === true, 'discover failed: ' + JSON.stringify(discH));
      assert.ok(Array.isArray(discH.tools), 'tools is not an array');
      const ping = discH.tools.find((t) => t.tool === 'ping');
      assert.ok(ping, 'ping not discovered; got ' + JSON.stringify(discH.tools.map((t) => t.tool)));
      assert.strictEqual(ping.name, 'mock_ping', 'surfaced name should be mock_ping; got ' + ping.name);
      assert.strictEqual(typeof ping.enabled, 'boolean', 'ping.enabled should be a boolean');
      assert.strictEqual(typeof ping.hot, 'boolean', 'ping.hot should be a boolean');
    });
    const discBad = await post('/api/mcp/discover', { id: 'no-such-upstream' });
    check('H: discover of an unknown upstream is a clean 404', () => {
      assert.strictEqual(discBad.status, 404, 'expected 404, got ' + discBad.status);
    });

    // I - enabled curated-direct (expose[]) entries are on the every-turn surface too, so /api/surface
    // must COUNT them (else the bloat warning gives a false all-clear). Rewrite expose with 2 enabled
    // entries, empty state -> curatedDirect:2 and promotedTotal includes them.
    writeState({});
    fs.writeFileSync(EXPOSE_PATH, JSON.stringify({
      version: 1,
      upstreams: [{ id: 'mock', transport: 'stdio', command: process.execPath, args: [MOCK_SERVER], enabled: true, description: 'ui-matrix.test.js fixture.' }],
      expose: [
        { upstream: 'mock', tool: 'ping', as: 'mock_ping', enabled: true },
        { upstream: 'mock', tool: 'add', as: 'mock_add', enabled: true },
      ],
    }, null, 2) + '\n');
    const surfI = (await get('/api/surface')).json;
    check('I: enabled curated-direct expose entries count toward the every-turn surface total', () => {
      assert.strictEqual(surfI.curatedDirect, 2, 'expected curatedDirect 2; got ' + surfI.curatedDirect);
      assert.strictEqual(surfI.promotedTotal, 2, 'promotedTotal must include curated-direct; got ' + surfI.promotedTotal);
    });

    // M - identity settings (0.6.0): GET/POST /api/identity round-trips toolfunnel.json, blank
    // removes a field, unknown fields in the file are preserved, and validation rejects bad ports.
    fs.writeFileSync(TOOLFUNNEL_JSON, JSON.stringify({ serverName: 'pre-existing', keepMe: 'yes' }, null, 2) + '\n');
    const idGet = (await get('/api/identity')).json;
    check('M: GET /api/identity returns the raw file + the resolved effective config', () => {
      assert.strictEqual(idGet.file.serverName, 'pre-existing', 'file.serverName; got ' + JSON.stringify(idGet.file));
      assert.ok(idGet.effective && typeof idGet.effective.serverName === 'string', 'effective missing');
      assert.strictEqual(idGet.restartRequired, true, 'restartRequired flag missing');
    });
    const idSet = (await post('/api/identity', { serverName: 'my-mcp', clientName: 'my-client', clientVersion: '2.0.0', serverVersion: '' })).json;
    check('M: POST /api/identity merges fields, blank removes, unknown fields preserved', () => {
      assert.ok(idSet && idSet.ok === true, 'save failed: ' + JSON.stringify(idSet));
      const onDisk = JSON.parse(fs.readFileSync(TOOLFUNNEL_JSON, 'utf8'));
      assert.strictEqual(onDisk.serverName, 'my-mcp');
      assert.strictEqual(onDisk.clientName, 'my-client');
      assert.strictEqual(onDisk.clientVersion, '2.0.0');
      assert.ok(!('serverVersion' in onDisk), 'blank field should be removed');
      assert.strictEqual(onDisk.keepMe, 'yes', 'unknown field must be preserved');
      assert.strictEqual(idSet.effective.clientName, 'my-client', 'effective must reflect the save');
    });
    const idBad = await post('/api/identity', { httpPort: 70000 });
    check('M: an out-of-range port is a clean 400 (file untouched)', () => {
      assert.strictEqual(idBad.status, 400, 'expected 400, got ' + idBad.status);
      const onDisk = JSON.parse(fs.readFileSync(TOOLFUNNEL_JSON, 'utf8'));
      assert.ok(!('httpPort' in onDisk), 'bad port must not be written');
    });

    // N - legacyPin (0.6.0): pin/unpin actions on /api/mcp/state persist to expose.json and
    // surface on /api/upstreams.
    const pinRes = (await post('/api/mcp/state', { id: 'mock', action: 'pin' })).json;
    const pinnedList = (await get('/api/upstreams')).json;
    const unpinRes = (await post('/api/mcp/state', { id: 'mock', action: 'unpin' })).json;
    const unpinnedList = (await get('/api/upstreams')).json;
    check('N: pin/unpin toggles legacyPin and /api/upstreams reflects it', () => {
      assert.ok(pinRes && pinRes.ok === true && pinRes.legacyPin === true, 'pin failed: ' + JSON.stringify(pinRes));
      assert.strictEqual(pinnedList.upstreams.find((u) => u.id === 'mock').legacyPin, true, 'pinned state not visible');
      assert.ok(unpinRes && unpinRes.ok === true && unpinRes.legacyPin === false, 'unpin failed');
      assert.strictEqual(unpinnedList.upstreams.find((u) => u.id === 'mock').legacyPin, false, 'unpin not visible');
    });

    // P - wrap security notice (0.6.0): wrapping an upstream whose args carry a path OUTSIDE the
    // gateway root returns the same informed-consent warning the CLI prints; an inside-path wrap
    // returns none. Wrap state is cleared after.
    const outsidePath = path.join(os.tmpdir(), 'ui-matrix-outside.txt');
    fs.writeFileSync(EXPOSE_PATH, JSON.stringify({
      version: 1,
      upstreams: [
        { id: 'mock', transport: 'stdio', command: process.execPath, args: [MOCK_SERVER], enabled: true },
        { id: 'outsider', transport: 'stdio', command: process.execPath, args: [outsidePath], enabled: true },
      ],
      expose: [],
    }, null, 2) + '\n');
    const wrapOut = (await post('/api/wrap', { upstream: 'outsider' })).json;
    const wrapIn = (await post('/api/wrap', { upstream: 'mock' })).json;
    const wrapClear = (await post('/api/wrap', { upstream: null })).json;
    check('P: wrapping an outside-path upstream carries the security warning; inside-path does not', () => {
      assert.ok(wrapOut && wrapOut.ok === true, 'outsider wrap failed: ' + JSON.stringify(wrapOut));
      assert.ok(typeof wrapOut.warning === 'string' && /isolation guard is suspended/.test(wrapOut.warning),
        'expected the security notice; got ' + JSON.stringify(wrapOut.warning));
      assert.ok(wrapIn && wrapIn.ok === true && !('warning' in wrapIn), 'inside-path wrap must carry no warning');
      assert.ok(wrapClear && wrapClear.ok === true && wrapClear.wrapping === null, 'wrap clear failed');
    });

    // J - the bind guard. The UI can spawn processes and write scripts with no auth whatsoever,
    // so a non-loopback bind must be REFUSED at start(), mirroring the HTTP transport's guard.
    let rejectedAny = null;
    try { await createUiServer({ host: '0.0.0.0', port: 0, root: REPO_ROOT }).start(); }
    catch (err) { rejectedAny = err; }
    check('J: start() on 0.0.0.0 is hard-refused (unauthenticated UI is loopback-only)', () => {
      assert.ok(rejectedAny, 'start() resolved on 0.0.0.0 - the bind guard is missing');
      assert.ok(/non-loopback/i.test(rejectedAny.message), 'unexpected refusal message: ' + rejectedAny.message);
    });
    let rejectedLan = null;
    try { await createUiServer({ host: '192.168.1.20', port: 0, root: REPO_ROOT }).start(); }
    catch (err) { rejectedLan = err; }
    check('J: start() on a LAN address is hard-refused too', () => {
      assert.ok(rejectedLan, 'start() resolved on a LAN address - the bind guard is missing');
    });
    const lhServer = createUiServer({ host: 'localhost', port: 0, root: REPO_ROOT });
    const lhInfo = await lhServer.start();
    await lhServer.stop();
    check('J: a localhost bind still resolves (127.0.0.1 is proven by the main fixture server)', () => {
      assert.ok(lhInfo && typeof lhInfo.url === 'string' && lhInfo.port > 0, 'localhost bind failed: ' + JSON.stringify(lhInfo));
    });

    // L - the CSRF guard: the bind address stops the network, not the browser. A cross-origin
    // Origin on a mutating request is rejected; the UI's own origin and non-browser clients
    // (no Origin - every other POST in this file) pass. GETs stay open.
    const csrfEvil = await req(url, 'POST', '/api/tools/state',
      { id: 'uuid', hot: false }, { Origin: 'https://evil.example' });
    check('L: a cross-origin POST is refused (CSRF guard)', () => {
      assert.strictEqual(csrfEvil.status, 403, 'expected 403, got ' + csrfEvil.status);
      assert.ok(/cross-origin/i.test((csrfEvil.json && csrfEvil.json.error) || ''), 'error names the guard: ' + JSON.stringify(csrfEvil.json));
    });
    const csrfSelf = await req(url, 'POST', '/api/tools/state',
      { id: 'uuid', hot: false }, { Origin: url });
    check('L: the UI\'s own loopback Origin passes', () => {
      assert.strictEqual(csrfSelf.status, 200, 'expected 200, got ' + csrfSelf.status + ' ' + JSON.stringify(csrfSelf.json));
    });
    const csrfNull = await req(url, 'POST', '/api/tools/state',
      { id: 'uuid', hot: false }, { Origin: 'null' });
    check('L: a "null" (sandboxed/file) Origin is refused', () => {
      assert.strictEqual(csrfNull.status, 403, 'expected 403, got ' + csrfNull.status);
    });
    const csrfGet = await req(url, 'GET', '/api/tools', null, { Origin: 'https://evil.example' });
    check('L: GETs stay open regardless of Origin (read-only)', () => {
      assert.strictEqual(csrfGet.status, 200, 'expected 200, got ' + csrfGet.status);
    });

    // K - the two seams diverge exactly where they should.
    check('K: isLoopbackBindHost is strict (empty ≠ loopback) where the header check stays lenient', () => {
      assert.strictEqual(isLoopbackBindHost('127.0.0.1'), true, '127.0.0.1 should pass');
      assert.strictEqual(isLoopbackBindHost('::1'), true, '::1 should pass');
      assert.strictEqual(isLoopbackBindHost('0:0:0:0:0:0:0:1'), true, 'long-form IPv6 loopback should pass');
      assert.strictEqual(isLoopbackBindHost(''), false, 'an empty BIND host must not be loopback');
      assert.strictEqual(isLoopbackBindHost('   '), false, 'a whitespace BIND host must not be loopback');
      assert.strictEqual(isLoopbackBindHost(undefined), false, 'a missing BIND host must not be loopback');
      assert.strictEqual(isLoopbackBindHost('0.0.0.0'), false, '0.0.0.0 must not be loopback');
      assert.strictEqual(isLoopbackHost(''), true, 'HEADER semantics must stay lenient (bind addr is the boundary)');
    });
  } catch (err) {
    fatal = err;
  } finally {
    if (server) { try { await server.stop(); } catch (_e) { /* idempotent */ } }
    restore(STATE_PATH, stateSnap);
    restore(EXPOSE_PATH, exposeSnap);
    restore(TOOLFUNNEL_JSON, tfJsonSnap);
  }

  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));

  const passed = results.filter((r) => r.ok).length;
  const expected = 25;
  const ok = !fatal && passed === results.length && results.length === expected;
  if (ok) {
    console.log(`\nPASS: ui-matrix test - ${passed}/${expected} assertions passed (hot/hidden axes, surface summary + warnings, live discover, identity settings, legacyPin, wrap notice, loopback bind guard, CSRF guard)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: ui-matrix test - ${passed}/${results.length} assertions passed`);
    process.exit(1);
  }
})().catch((e) => { console.log('UI-MATRIX TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
