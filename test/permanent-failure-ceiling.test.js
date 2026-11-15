#!/usr/bin/env node
/**
 * permanent-failure-ceiling.test.js - an upstream that can NEVER connect stops retrying, loudly.
 *
 * Since the concurrent connectAll, every startup failure arms the background reconnect: 1s..16s,
 * then a 30 s keepalive for the whole session. Right for a slow-booting server; wrong for one that
 * cannot start at all - a command that does not exist (ENOENT) or a config the isolation guard
 * refuses retried every 30 s forever, while a tool call reported "reconnecting in background".
 * Now a PERMANENT failure runs the same ladder plus a bounded number of keepalive
 * attempts (about five minutes, a documented constant), then stops with one clear stderr line and
 * shows as stopped on /health until the config changes (a reload builds a fresh aggregator) or an
 * operator reconnects it. Transient failures keep retrying as before.
 *
 * Classification is by error CODE stamped where the error is raised, never by message text: the
 * client keeps the spawn error's code (it used to re-wrap it and lose it), the isolation guard
 * stamps TF_ISOLATION_REFUSED.
 *
 * Deterministic: fake clients + a MANUAL timer queue (as reconnect-backoff.test.js), plus two real
 * paths (a real spawn of a missing command, the real guard) for the codes.
 *
 * Run:  node test/permanent-failure-ceiling.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert');
const { useTempHome, REPO_ROOT } = require('./helpers/temp-home');

const HOME = useTempHome({ prefix: 'tf-permfail-' }); // claimed before any src/ require
const aggMod = require(path.join(REPO_ROOT, 'src', 'mcp', 'aggregator.js'));
const { Aggregator, defaultClientFactory } = aggMod;
const { McpClient, commandMissing } = require(path.join(REPO_ROOT, 'src', 'mcp', 'mcp-client.js'));
const { createHttpMcpServer } = require(path.join(REPO_ROOT, 'src', 'mcp', 'http-transport.js'));

const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

function makeStore(upstreams) {
  return {
    listUpstreams: () => upstreams.map((u) => ({ ...u })),
    getUpstream: (id) => { const u = upstreams.find((x) => x.id === id); return u ? { ...u } : undefined; },
    listExposed: () => [],
    exposedName: (e) => `${e.upstream}_${e.tool}`,
  };
}

/** A fake client whose connect() behaves per the CURRENT mode: 'enoent' | 'isolation' | 'transient' | 'ok'. */
function makeFactory(state) {
  return (upstream) => {
    if (state.mode === 'isolation') {
      throw Object.assign(new Error(`isolation: upstream ${upstream.id} references a path outside the gateway root`), { code: 'TF_ISOLATION_REFUSED' });
    }
    return {
      _connected: false,
      get connected() { return this._connected; },
      initializeResult: { protocolVersion: '2024-11-05', serverInfo: { name: upstream.id, version: '1' } },
      era: 'legacy',
      eraDefinitive: true,
      clientInfo: { name: 'toolfunnel', version: 'x' },
      onNotification: null,
      onServerRequest: null,
      async connect() {
        if (state.mode === 'enoent') throw Object.assign(new Error(`McpClient: child process error: spawn ${upstream.command} ENOENT`), { code: 'ENOENT' });
        if (state.mode === 'transient') throw new Error('McpClient: request "initialize" timed out after 10000ms');
        this._connected = true;
        return this.initializeResult;
      },
      async listTools() { return [{ name: 'ping' }]; },
      close() { this._connected = false; },
      request: async () => ({}),
      respondToServerError() {},
    };
  };
}

/** Patch the global timers so every reconnect delay (>= 1s) is recorded and queued for manual draining. */
function manualTimers() {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const t = { recorded: [], queue: [] };
  global.setTimeout = (fn, delay, ...args) => {
    if (delay >= 1000) { t.recorded.push(delay); const h = { _fn: fn, unref() {} }; t.queue.push(h); return h; }
    return realSetTimeout(fn, delay, ...args);
  };
  global.clearTimeout = (h) => {
    if (h && typeof h._fn === 'function') { const i = t.queue.indexOf(h); if (i >= 0) t.queue.splice(i, 1); return; }
    return realClearTimeout(h);
  };
  t.drain = async (max, beforeEach) => {
    for (let i = 0; i < max && t.queue.length; i++) {
      if (beforeEach) beforeEach(i);
      const h = t.queue.shift();
      await h._fn();
      await Promise.resolve();
    }
  };
  t.restore = () => { global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; };
  return t;
}

/** Capture [toolfunnel] stderr lines written while fn runs. */
async function captureStderr(fn) {
  const real = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return real(chunk, ...rest); };
  try { await fn(); } finally { process.stderr.write = real; }
  return lines;
}

const U = { id: 'u1', command: 'no-such-server', args: [], env: {}, enabled: true };

(async () => {
  const LIMIT = aggMod.PERMANENT_RETRY_LIMIT;
  await check('the ceiling is an exported, documented constant', () => {
    assert.ok(Number.isInteger(LIMIT) && LIMIT > 0, 'PERMANENT_RETRY_LIMIT is not exported: ' + LIMIT);
  });

  // ── the codes, on the REAL paths ────────────────────────────────────────────────────────────
  await check('a real spawn of a missing command rejects with code ENOENT (the client keeps it)', async () => {
    const c = new McpClient({ id: 'nx', command: 'toolfunnel-no-such-command-4c1f', requestTimeoutMs: 5000 });
    let err = null;
    try { await c.connect(); } catch (e) { err = e; }
    try { c.close(); } catch (_e) { /* ignore */ }
    assert.ok(err, 'connect succeeded');
    assert.strictEqual(err.code, 'ENOENT', `code=${err.code} message=${err.message}`);
  });
  await check('a missing working directory is named as the cause, not the command or cmd.exe', async () => {
    const cwd = path.join(HOME.home, 'no-such-dir');
    const c = new McpClient({ id: 'nd', command: process.execPath, cwd, requestTimeoutMs: 5000 });
    let err = null;
    try { await c.connect(); } catch (e) { err = e; }
    try { c.close(); } catch (_e) { /* ignore */ }
    assert.ok(err, 'connect succeeded');
    assert.strictEqual(err.code, 'ENOENT', `code=${err.code} message=${err.message}`);
    assert.ok(err.message.includes(`working directory "${cwd}" does not exist`), err.message);
    assert.ok(!/cmd\.exe/i.test(err.message.split(' - ')[0]), err.message);
  });
  await check('commandMissing finds a command in a quoted PATH entry that contains a semicolon', () => {
    if (process.platform !== 'win32') return; // commandMissing answers false off Windows
    const dir = path.join(HOME.home, 'bin;tools');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tfprobe.cmd'), '@echo off\r\n');
    const env = { PATH: `"${dir}";${path.join(HOME.home, 'elsewhere')}`, PATHEXT: '.CMD' };
    assert.strictEqual(commandMissing('tfprobe', HOME.home, env), false);
    assert.strictEqual(commandMissing('tfprobe-absent', HOME.home, env), true);
  });
  await check('the real isolation guard stamps TF_ISOLATION_REFUSED (path and code-loading env)', () => {
    const outside = path.resolve(HOME.home, '..', 'outside-server.js');
    let e1 = null; let e2 = null;
    try { defaultClientFactory({ id: 'iso1', command: 'node', args: [outside], env: {} }, HOME.home, () => {}); } catch (e) { e1 = e; }
    try { defaultClientFactory({ id: 'iso2', command: 'node', args: [], env: { NODE_OPTIONS: '--require x' } }, HOME.home, () => {}); } catch (e) { e2 = e; }
    assert.ok(e1 && e1.code === 'TF_ISOLATION_REFUSED', 'path refusal: ' + (e1 ? `${e1.code} ${e1.message}` : 'no throw'));
    assert.ok(e2 && e2.code === 'TF_ISOLATION_REFUSED', 'env refusal: ' + (e2 ? `${e2.code} ${e2.message}` : 'no throw'));
  });

  // ── the ceiling: a permanent failure stops ──────────────────────────────────────────────────
  {
    const state = { mode: 'enoent' };
    const agg = new Aggregator({ store: makeStore([U]), clientFactory: makeFactory(state), onToolsChanged: () => {} });
    const t = manualTimers();
    let lines = [];
    try {
      lines = await captureStderr(async () => {
        const res = await agg.connectAll();
        assert.strictEqual(res.failed.length, 1);
        await t.drain(LIMIT + 20);
      });
    } finally { t.restore(); }

    await check('a permanent failure runs the ladder then STOPS (no timer left)', () => {
      assert.strictEqual(t.queue.length, 0, `still scheduling after ${t.recorded.length} retries`);
      assert.strictEqual(t.recorded.length, LIMIT, `retries: ${t.recorded.length}, expected ${LIMIT}: ${JSON.stringify(t.recorded)}`);
      assert.deepStrictEqual(t.recorded.slice(0, 6), [1000, 2000, 4000, 8000, 16000, 30000], 'ladder: ' + JSON.stringify(t.recorded));
    });
    await check('the retry window is about five minutes', () => {
      const total = t.recorded.reduce((a, b) => a + b, 0);
      assert.ok(total >= 240000 && total <= 330000, `total ${total} ms`);
    });
    await check('stopping writes ONE clear stderr line naming the upstream and the reason', () => {
      const stop = lines.filter((l) => /stopped retrying/.test(l));
      assert.strictEqual(stop.length, 1, 'stop lines: ' + JSON.stringify(stop));
      assert.ok(stop[0].includes('"u1"') && stop[0].includes('ENOENT'), stop[0]);
    });
    await check('stoppedUpstreams() reports it (the /health source)', () => {
      const s = agg.stoppedUpstreams();
      assert.strictEqual(s.length, 1, JSON.stringify(s));
      assert.strictEqual(s[0].id, 'u1');
      assert.ok(/ENOENT/.test(s[0].error), s[0].error);
      assert.strictEqual(s[0].attempts, LIMIT + 1);
    });
    await check('a tool call says it stopped, not "reconnecting in background"', async () => {
      let err = null;
      try { await agg.ensureConnected('u1', { allowConnect: false }); } catch (e) { err = e; }
      assert.ok(err, 'no throw');
      assert.ok(/stopped retrying/.test(err.message) && !/reconnecting in background/.test(err.message), err.message);
    });
    await check('an operator reconnect clears the stop and connects once the cause is fixed', async () => {
      state.mode = 'ok';
      await agg.reconnect('u1');
      assert.deepStrictEqual(agg.stoppedUpstreams(), []);
      const c = await agg.ensureConnected('u1', { allowConnect: false });
      assert.ok(c && c.connected, 'not connected after the reconnect');
    });
    await agg.closeAll();
  }

  // ── the stop line stays ONE bounded line, whatever the upstream wrote to stderr ─────────────
  {
    const noisy = 'McpClient: command "no-such-server" was not found (looked in the working directory and on PATH) - ' +
      'McpClient: initialize failed: McpClient: upstream exited (code=1, signal=null). stderr:\r\n' +
      ("'no-such-server' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n").repeat(60);
    const factory = (upstream) => ({
      connected: false,
      async connect() { throw Object.assign(new Error(noisy), { code: 'ENOENT' }); },
      close() {},
    });
    const agg = new Aggregator({ store: makeStore([U]), clientFactory: factory, onToolsChanged: () => {} });
    const t = manualTimers();
    let lines = [];
    try {
      lines = await captureStderr(async () => { await agg.connectAll(); await t.drain(LIMIT + 20); });
    } finally { t.restore(); }
    await check('a multi-line, long failure still stops with ONE bounded line that keeps the cause', () => {
      const stop = lines.filter((l) => /stopped retrying/.test(l));
      assert.strictEqual(stop.length, 1, 'stop writes: ' + stop.length);
      const body = stop[0].replace(/\n$/, '');
      assert.ok(!/[\r\n]/.test(body), 'the stop line spans several lines: ' + JSON.stringify(body.slice(0, 200)));
      assert.ok(body.length <= 700, `the stop line is ${body.length} chars`);
      assert.ok(body.includes('was not found'), 'the cause was cut off: ' + body.slice(0, 200));
      const s = agg.stoppedUpstreams()[0];
      assert.ok(s && !/[\r\n]/.test(s.error) && s.error.length <= 500, 'stoppedUpstreams error is not one bounded line: ' + (s && s.error.length));
    });
    await agg.closeAll();
  }

  // ── an isolation refusal is permanent too ───────────────────────────────────────────────────
  {
    const state = { mode: 'isolation' };
    const agg = new Aggregator({ store: makeStore([U]), clientFactory: makeFactory(state), onToolsChanged: () => {} });
    const t = manualTimers();
    try {
      await captureStderr(async () => { await agg.connectAll(); await t.drain(LIMIT + 20); });
    } finally { t.restore(); }
    await check('an isolation refusal stops after the same ceiling', () => {
      assert.strictEqual(t.queue.length, 0, 'still scheduling');
      assert.strictEqual(t.recorded.length, LIMIT);
      assert.strictEqual(agg.stoppedUpstreams().length, 1);
    });
    await agg.closeAll();
  }

  // ── controls: transient failures never stop; a transient failure resets the budget ──────────
  {
    const state = { mode: 'transient' };
    const agg = new Aggregator({ store: makeStore([U]), clientFactory: makeFactory(state), onToolsChanged: () => {} });
    const t = manualTimers();
    try { await agg.connectAll(); await t.drain(LIMIT + 6); } finally { t.restore(); }
    await check('a TRANSIENT failure keeps retrying past the ceiling (unchanged)', () => {
      assert.strictEqual(t.queue.length, 1, 'the keepalive stopped for a transient failure');
      assert.deepStrictEqual(agg.stoppedUpstreams(), []);
    });
    await agg.closeAll();
  }
  {
    const state = { mode: 'enoent' };
    const agg = new Aggregator({ store: makeStore([U]), clientFactory: makeFactory(state), onToolsChanged: () => {} });
    const t = manualTimers();
    try {
      await captureStderr(async () => {
        await agg.connectAll();
        // five permanent retries, then ONE transient, then permanent again until it stops
        await t.drain(LIMIT + 40, (i) => { state.mode = i === 5 ? 'transient' : 'enoent'; });
      });
    } finally { t.restore(); }
    await check('a transient failure in between resets the count (the budget restarts)', () => {
      assert.strictEqual(t.queue.length, 0, 'never stopped');
      assert.strictEqual(t.recorded.length, 5 + 1 + LIMIT + 1, `retries: ${t.recorded.length}`);
    });
    await agg.closeAll();
  }

  // ── /health carries it ──────────────────────────────────────────────────────────────────────
  {
    const realStopped = Aggregator.prototype.stoppedUpstreams;
    Aggregator.prototype.stoppedUpstreams = () => [{ id: 'u9', error: 'spawn x ENOENT', attempts: 15 }];
    const server = createHttpMcpServer({ host: '127.0.0.1', port: 0 });
    try {
      const info = await server.start();
      const port = (info && info.port) || server.port;
      const body = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
          let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d));
        }).on('error', reject);
      });
      await check('/health lists stopped upstreams', () => {
        const j = JSON.parse(body);
        assert.ok(Array.isArray(j.stopped), 'no stopped[] in /health: ' + body.slice(0, 300));
        assert.deepStrictEqual(j.stopped, [{ id: 'u9', error: 'spawn x ENOENT', attempts: 15 }]);
      });
    } finally {
      Aggregator.prototype.stoppedUpstreams = realStopped;
      try { await server.stop(); } catch (_e) { /* ignore */ }
    }
  }

  const EXPECTED = 16;
  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  if (passed === results.length && results.length === EXPECTED) {
    console.log(`\nPASS: permanent-failure-ceiling test - ${passed}/${EXPECTED} assertions passed (a permanent failure stops after the ceiling, loudly)`);
    process.exit(0);
  }
  console.log(`\nFAIL: permanent-failure-ceiling test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
  process.exit(1);
})().catch((e) => { console.log('PERMANENT-FAILURE-CEILING TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(2); });
