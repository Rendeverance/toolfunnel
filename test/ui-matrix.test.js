'use strict';

/**
 * ui-matrix.test.js — exercises the config UI server's MATRIX surface over REAL loopback HTTP:
 * the per-tool hot/hidden axes on /api/tools + /api/tools/state, the top-level /api/surface summary
 * (meta-tool hot states, promotion counts, footgun warnings), and the live /api/mcp/discover button
 * (connect an upstream, list its tools, return their surfaced names + lean/hot state). Starts the
 * real createUiServer() on an ephemeral port and talks to it with node:http — no mocks of the wire.
 *
 *   A — /api/tools carries enabled/hidden/hot per tool (defaults: enabled on, hidden off, hot off).
 *   B — POST /api/tools/state {hot:true} promotes a tool; the GET reflects it.
 *   C — the axes are INDEPENDENT: setting enabled:false leaves hot:true intact (merge, not replace).
 *   D — POST /api/tools/state with NO axis → 400 (must name at least one of enabled/hidden/hot).
 *   E — /api/surface lists the 4 meta-tools (default hot) and counts promotions (a hot+DISABLED tool
 *       is NOT counted — it isn't actually on the surface).
 *   F — promoting an enabled tool bumps promotedTotal; hiding toolfunnel_list_tools/run warns.
 *   G — promoting > 10 tools raises the context-bloat warning.
 *   H — POST /api/mcp/discover connects the bundled mock upstream and returns mock_ping (surfaced),
 *       with its lean/hot state; an unknown upstream is a clean 404.
 *
 * NON-DESTRUCTIVE: tools/tools.state.json + mcp/expose.json are snapshotted and restored. Node built-ins only.
 *
 * Run:  node test/ui-matrix.test.js     (exit 0 = pass, non-zero = fail)
 */

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');
const http = require('node:http');

const REPO_ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.join(REPO_ROOT, 'tools', 'tools.state.json');
const EXPOSE_PATH = path.join(REPO_ROOT, 'mcp', 'expose.json');
const MOCK_SERVER = path.join(REPO_ROOT, 'mcp', 'servers', 'mock-upstream', 'server.js');

const { createUiServer } = require('../src/ui/server');

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

/** Minimal loopback JSON client. Resolves { status, json }. */
function req(base, method, p, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(p, base);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { Accept: 'application/json' },
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

    // A — /api/tools carries the matrix axes with the right defaults.
    const toolsA = (await get('/api/tools')).json;
    check('A: /api/tools returns the matrix axes (enabled/hidden/hot) per tool, with sane defaults', () => {
      assert.ok(Array.isArray(toolsA), '/api/tools is not an array');
      const uuid = toolsA.find((t) => t.id === 'uuid');
      assert.ok(uuid, 'uuid tool missing');
      assert.strictEqual(uuid.enabled, true, 'enabled should default true');
      assert.strictEqual(uuid.hidden, false, 'hidden should default false');
      assert.strictEqual(uuid.hot, false, 'hot should default false');
    });

    // B — promote via the API.
    const setB = await post('/api/tools/state', { id: 'uuid', hot: true });
    const toolsB = (await get('/api/tools')).json;
    check('B: POST /api/tools/state {hot:true} promotes the tool', () => {
      assert.strictEqual(setB.status, 200, 'set hot status ' + setB.status);
      const uuid = toolsB.find((t) => t.id === 'uuid');
      assert.strictEqual(uuid && uuid.hot, true, 'uuid.hot not true after promote');
    });

    // C — axes are independent (merge, not replace).
    await post('/api/tools/state', { id: 'uuid', enabled: false });
    const toolsC = (await get('/api/tools')).json;
    check('C: axes are independent — enabled:false leaves hot:true intact', () => {
      const uuid = toolsC.find((t) => t.id === 'uuid');
      assert.strictEqual(uuid && uuid.enabled, false, 'uuid.enabled should be false');
      assert.strictEqual(uuid && uuid.hot, true, 'uuid.hot should still be true (independent)');
    });

    // C2 — the hidden axis writes + reports via the UI server, independent of enabled/hot (3 axes).
    await post('/api/tools/state', { id: 'uuid', hidden: true });
    const toolsC2 = (await get('/api/tools')).json;
    check('C: the hidden axis is settable via the UI and independent (enabled/hot preserved)', () => {
      const uuid = toolsC2.find((t) => t.id === 'uuid');
      assert.strictEqual(uuid && uuid.hidden, true, 'uuid.hidden should be true');
      assert.strictEqual(uuid && uuid.enabled, false, 'enabled clobbered by hidden write');
      assert.strictEqual(uuid && uuid.hot, true, 'hot clobbered by hidden write');
    });

    // D — no axis → 400.
    const setD = await post('/api/tools/state', { id: 'uuid' });
    check('D: POST /api/tools/state with no axis is a 400', () => {
      assert.strictEqual(setD.status, 400, 'expected 400, got ' + setD.status);
      assert.ok(setD.json && setD.json.ok === false, 'expected ok:false');
    });

    // E — /api/surface: 4 meta-tools (default hot); a hot+disabled tool is NOT counted.
    const surfE = (await get('/api/surface')).json;
    check('E: /api/surface lists 4 meta-tools (default hot) and excludes a hot-but-disabled tool', () => {
      assert.ok(Array.isArray(surfE.meta) && surfE.meta.length === 4, 'expected 4 meta-tools; got ' + JSON.stringify(surfE.meta));
      assert.ok(surfE.meta.every((m) => m.hot === true), 'all meta-tools should default hot');
      assert.strictEqual(surfE.promotedTotal, 0, 'uuid is hot but DISABLED → must not be counted; got ' + surfE.promotedTotal);
    });

    // F — promote an enabled tool; bump the count. Then hide list+run → warning.
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

    // G — bloat warning when > 10 tools are promoted (write the overlay directly: 11 hot keys).
    const bloat = {};
    for (let i = 0; i < 11; i += 1) bloat['promoted_' + i] = { hot: true };
    writeState(bloat);
    const surfG = (await get('/api/surface')).json;
    check('G: promoting > 10 tools raises the context-bloat warning', () => {
      assert.ok(surfG.promotedTotal >= 11, 'expected >=11 promoted; got ' + surfG.promotedTotal);
      assert.ok((surfG.warnings || []).some((w) => /every turn/i.test(w)), 'expected a bloat warning; got ' + JSON.stringify(surfG.warnings));
    });

    // H — live discover: connect the mock upstream, list its tools (surfaced names + lean/hot state).
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

    // I — enabled curated-direct (expose[]) entries are on the every-turn surface too, so /api/surface
    // must COUNT them (else the bloat warning gives a false all-clear). Rewrite expose with 2 enabled
    // entries, empty state → curatedDirect:2 and promotedTotal includes them.
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
  } catch (err) {
    fatal = err;
  } finally {
    if (server) { try { await server.stop(); } catch (_e) { /* idempotent */ } }
    restore(STATE_PATH, stateSnap);
    restore(EXPOSE_PATH, exposeSnap);
  }

  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));

  const passed = results.filter((r) => r.ok).length;
  const expected = 12;
  const ok = !fatal && passed === results.length && results.length === expected;
  if (ok) {
    console.log(`\nPASS: ui-matrix test — ${passed}/${expected} assertions passed (hot/hidden axes, surface summary + warnings, live discover)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: ui-matrix test — ${passed}/${results.length} assertions passed`);
    process.exit(1);
  }
})().catch((e) => { console.log('UI-MATRIX TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
