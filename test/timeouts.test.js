'use strict';

/**
 * timeouts.test.js - regression pins for the request-window split:
 * the fixed 10 s request window hard-killed every wrapped/forwarded tool call slower than
 * that, silently dropping the upstream's eventual result. The fix splits the windows:
 *
 *   A - PAYLOAD vs CONTROL: tools/call waits the LONG window (default 120 s) even when the
 *       control-plane window is tight - a 1.2 s tool succeeds through a client whose
 *       requestTimeoutMs is 500 ms (pre-fix: hard fail at 500 ms).
 *   B - CONFIG BOUND: toolTimeoutMs is enforced - a 1.5 s tool against a 400 ms payload
 *       window fails at ~400 ms with the honest timeout message.
 *   C - PROGRESS RE-ARM: a token-matched progress beat re-arms the window - a 1.8 s tool
 *       with a 600 ms window survives because it reports progress every 150 ms.
 *   D - PER-UPSTREAM PLUMB: `timeoutMs` in the store reaches the client via
 *       defaultClientFactory as its payload window.
 *   F - SLOW-BOOT PLUMB: `requestTimeoutMs` in the store reaches the client as its CONTROL
 *       window - without it a server that boots slower than 10 s can never be attached.
 *   G - FUNNEL META FORWARD: the caller's progressToken reaches the upstream through the
 *       curated-direct path (the fixture only emits progress when a token arrives), so a
 *       long funnel tool can keep its own call alive. Beats are still not fanned out to
 *       funnel clients - the token's job here is the upstream-side keep-alive.
 *   H - PROBE HONOURS THE RAISED WINDOW: an explicit requestTimeoutMs also governs the
 *       era probe in connect() - a modern-only server that answers server/discover after
 *       3.6 s attaches MODERN. The probe's own 3 s clamp (still the default) would have
 *       misfiled it as legacy and the attach would have failed outright.
 *
 * Real child process, real pipes - the windows are timed against a live stdio server.
 * Run:  node test/timeouts.test.js     (exit 0 = pass, non-zero = fail)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const { McpClient } = require(path.join(REPO_ROOT, 'src', 'mcp', 'mcp-client.js'));
const { Aggregator } = require(path.join(REPO_ROOT, 'src', 'mcp', 'aggregator.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

// Minimal legacy stdio MCP server (line-framed): slowtool sleeps args.ms then answers;
// progtool does the same but emits notifications/progress every args.interval ms using the
// caller's _meta.progressToken.
const MOCK_SERVER = `'use strict';
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch (_e) { continue; }
    handle(msg);
  }
});
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05',
      serverInfo: { name: 'slowmock', version: '1.0.0' }, capabilities: { tools: {} } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'slowtool', inputSchema: { type: 'object' } },
      { name: 'progtool', inputSchema: { type: 'object' } } ] } });
  } else if (msg.method === 'tools/call') {
    const args = (msg.params && msg.params.arguments) || {};
    const ms = Number(args.ms) || 0;
    if (msg.params && msg.params.name === 'progtool') {
      const token = msg.params._meta && msg.params._meta.progressToken;
      const iv = setInterval(() => {
        if (token !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress',
          params: { progressToken: token, progress: 1 } });
      }, Number(args.interval) || 100);
      setTimeout(() => { clearInterval(iv); send({ jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: 'prog done' }], isError: false } }); }, ms);
    } else {
      setTimeout(() => { send({ jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: 'done after ' + ms }], isError: false } }); }, ms);
    }
  } else if (msg.id !== undefined && msg.id !== null) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
}
`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-timeouts-'));
  const serverPath = path.join(tmp, 'slow-server.js');
  fs.writeFileSync(serverPath, MOCK_SERVER);

  // A - payload window is independent of the control-plane window.
  {
    const client = new McpClient({ id: 'a', command: process.execPath, args: [serverPath], requestTimeoutMs: 500 });
    await client.connect();
    const t0 = Date.now();
    let out = null, err = null;
    try { out = await client.callTool('slowtool', { ms: 1200 }); } catch (e) { err = e; }
    const took = Date.now() - t0;
    check('A: a 1.2s tool SUCCEEDS through a 500ms control window (payload window applies)', () => {
      assert.ok(!err, 'call failed: ' + (err && err.message));
      assert.strictEqual(out.content[0].text, 'done after 1200');
      assert.ok(took >= 1100, 'answered implausibly fast (' + took + 'ms)');
    });
    client.close();
  }

  // B - the configured payload bound is enforced, with the honest message.
  {
    const client = new McpClient({ id: 'b', command: process.execPath, args: [serverPath], toolTimeoutMs: 400 });
    await client.connect();
    const t0 = Date.now();
    let err = null;
    try { await client.callTool('slowtool', { ms: 1500 }); } catch (e) { err = e; }
    const took = Date.now() - t0;
    check('B: toolTimeoutMs=400 kills a 1.5s tool at ~400ms', () => {
      assert.ok(err, 'call unexpectedly succeeded');
      assert.match(err.message, /timeout after 400ms/, 'unexpected error: ' + err.message);
      assert.ok(took < 1300, 'timeout fired far too late (' + took + 'ms)');
    });
    client.close();
  }

  // C - a token-matched progress beat re-arms the window.
  {
    const client = new McpClient({ id: 'c', command: process.execPath, args: [serverPath], toolTimeoutMs: 600 });
    await client.connect();
    let out = null, err = null;
    try {
      out = await client.request('tools/call', {
        name: 'progtool', arguments: { ms: 1800, interval: 150 }, _meta: { progressToken: 'tk1' },
      });
    } catch (e) { err = e; }
    check('C: a 1.8s tool with a 600ms window SURVIVES via progress re-arm', () => {
      assert.ok(!err, 'call failed: ' + (err && err.message));
      assert.strictEqual(out.content[0].text, 'prog done');
    });
    client.close();
  }

  // D - per-upstream `timeoutMs` config reaches the client through defaultClientFactory.
  {
    const upstreams = [{ id: 'u1', transport: 'stdio', command: process.execPath,
      args: [serverPath], env: {}, enabled: true, timeoutMs: 777 }];
    const store = {
      listUpstreams: () => upstreams.map((u) => ({ ...u })),
      getUpstream: (id) => { const u = upstreams.find((x) => x.id === id); return u ? { ...u } : undefined; },
      listExposed: () => [],
      exposedName: (e) => `${e.upstream}_${e.tool}`,
    };
    const agg = new Aggregator({ store, v3Root: tmp });
    await agg.discover('u1');
    const client = agg._clients.get('u1');
    check('D: store timeoutMs=777 lands as the client payload window', () => {
      assert.ok(client, 'upstream never connected');
      assert.strictEqual(client._toolTimeoutMs, 777);
    });
    await agg.closeAll();
  }

  // F - per-upstream `requestTimeoutMs` config reaches the client as the CONTROL window
  //     (slow-boot servers: Baileys-class session restores need >10 s to answer initialize).
  {
    const upstreams = [{ id: 'u1', transport: 'stdio', command: process.execPath,
      args: [serverPath], env: {}, enabled: true, requestTimeoutMs: 45000 }];
    const store = {
      listUpstreams: () => upstreams.map((u) => ({ ...u })),
      getUpstream: (id) => { const u = upstreams.find((x) => x.id === id); return u ? { ...u } : undefined; },
      listExposed: () => [],
      exposedName: (e) => `${e.upstream}_${e.tool}`,
    };
    const agg = new Aggregator({ store, v3Root: tmp });
    await agg.discover('u1');
    const client = agg._clients.get('u1');
    check('F: store requestTimeoutMs=45000 lands as the client control window', () => {
      assert.ok(client, 'upstream never connected');
      assert.strictEqual(client._requestTimeoutMs, 45000);
    });
    await agg.closeAll();
  }

  // G - the caller's _meta (progressToken) reaches the upstream through the curated-direct
  //     funnel path. The fixture's progtool beats ONLY when a token arrives, so observed
  //     beats prove the token travelled.
  {
    const upstreams = [{ id: 'u1', transport: 'stdio', command: process.execPath,
      args: [serverPath], env: {}, enabled: true }];
    const store = {
      listUpstreams: () => upstreams.map((u) => ({ ...u })),
      getUpstream: (id) => { const u = upstreams.find((x) => x.id === id); return u ? { ...u } : undefined; },
      listExposed: () => [{ upstream: 'u1', tool: 'progtool', as: 'u1_prog', enabled: true }],
      exposedName: (e) => e.as || `${e.upstream}_${e.tool}`,
    };
    const agg = new Aggregator({ store, v3Root: tmp });
    await agg.discover('u1');
    const client = agg._clients.get('u1');
    let beats = 0;
    client.onNotification = (n) => {
      if (n && n.method === 'notifications/progress' && n.params && n.params.progressToken === 'tok-G') beats += 1;
    };
    const res = agg.resolveExposedExecution('u1_prog', { ms: 700, interval: 120 }, { progressToken: 'tok-G' });
    const r = await res.execute();
    check('G: funnel curated-direct forwards progressToken upstream (beats observed: ' + beats + ')', () => {
      assert.ok(res, 'exposed tool never resolved');
      assert.strictEqual(r.isError, false);
      assert.ok(beats >= 2, 'expected >=2 token-matched beats, saw ' + beats);
    });
    await agg.closeAll();
  }

  // E - a Bridge-B suspension extension SURVIVES progress beats: extendRequestTimeout updates
  //     the waiter's window, so a beat re-arms to the HOLD, not back to the short payload
  // window.
  {
    const client = new McpClient({ id: 'e', command: process.execPath, args: [serverPath], toolTimeoutMs: 400 });
    await client.connect();
    const out = {};
    let err = null, res = null;
    const pending = client.request('tools/call', {
      name: 'progtool', arguments: { ms: 1500, interval: 150 }, _meta: { progressToken: 'tk2' },
    }, out).then((r) => { res = r; }).catch((e) => { err = e; });
    const extended = client.extendRequestTimeout(out.rpcId, 5000); // the "suspension hold"
    await pending;
    check('E: an extended (suspended) call survives progress beats - beat re-arms to the hold', () => {
      assert.strictEqual(extended, true, 'extendRequestTimeout found no waiter');
      assert.ok(!err, 'call failed: ' + (err && err.message));
      assert.strictEqual(res.content[0].text, 'prog done');
    });
    client.close();
  }

  // H - an explicit requestTimeoutMs raises the era-probe window too. The mock is a
  //     slow-boot MODERN-ONLY server: server/discover answers after 3.6 s, initialize is
  //     refused (-32601), so only a probe that outlives the default 3 s clamp can attach it.
  {
    const SLOW_MODERN_SERVER = `'use strict';
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch (_e) { continue; }
    if (msg.method === 'server/discover') {
      setTimeout(() => { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        result: { supportedVersions: ['2026-07-28'],
          serverInfo: { name: 'slowmodern', version: '1.0.0' }, capabilities: { tools: {} } } }) + '\\n');
      }, 3600);
    } else if (msg.id !== undefined && msg.id !== null) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        error: { code: -32601, message: 'Method not found' } }) + '\\n');
    }
  }
});
`;
    const slowModernPath = path.join(tmp, 'slow-modern-server.js');
    fs.writeFileSync(slowModernPath, SLOW_MODERN_SERVER);
    const client = new McpClient({ id: 'h', command: process.execPath, args: [slowModernPath],
      requestTimeoutMs: 8000, modernOnly: true });
    let err = null;
    try { await client.connect(); } catch (e) { err = e; }
    check('H: requestTimeoutMs=8000 lets a 3.6s-boot modern-only server attach MODERN', () => {
      assert.ok(!err, 'connect failed: ' + (err && err.message));
      assert.strictEqual(client._modern, true, 'attached but not as modern');
    });
    client.close();
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }

  let failed = 0;
  for (const r of results) {
    console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
    if (!r.ok) failed++;
  }
  console.log(failed === 0
    ? `PASS: timeouts test - ${results.length}/${results.length} assertions passed`
    : `FAIL: timeouts test - ${results.length - failed}/${results.length} assertions passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => { console.error('timeouts test crashed:', err); process.exit(1); });
