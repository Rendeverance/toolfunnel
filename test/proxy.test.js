'use strict';

/**
 * proxy.test.js - proves ToolFunnel ATTACHES and FORWARDS (proxies) an upstream MCP, and that a
 * forwarded call passes through the fail-closed policy gate.
 *
 * It spawns the REAL gateway as a child (`node bin/toolfunnel.js`, stdio) with the bundled mock
 * upstream (mcp/servers/mock-upstream/server.js) attached via a snapshotted expose.json, and asserts:
 *
 *   PART A - FORWARD:  tools/list advertises the forwarded tools (mockproxy_ping / _add / _echo),
 *                      and calling them returns the UPSTREAM's real answers ("pong", "5", echoed text).
 *   PART B - GATE:     with a PreToolUse deny hook matching the forwarded tool name, the forwarded
 *                      call is BLOCKED (isError, no "pong"), while a NON-matched forwarded tool
 *                      (mockproxy_add) still runs - proving the gate is per-tool and fails closed.
 *
 * NON-DESTRUCTIVE: mcp/expose.json and hooks/hooks.manifest.json are snapshotted up front and
 * restored byte-for-byte (or re-absent) in `finally` - the live config is left exactly as found.
 * Paths are DERIVED from this file's location (no hardcoded drive/root). Node built-ins only.
 *
 * Run:  node test/proxy.test.js     (exit 0 = pass, non-zero = fail)
 */

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const EXPOSE_PATH = path.join(REPO_ROOT, 'mcp', 'expose.json');
const MANIFEST_PATH = path.join(REPO_ROOT, 'hooks', 'hooks.manifest.json');
const MOCK_SERVER = path.join(REPO_ROOT, 'mcp', 'servers', 'mock-upstream', 'server.js');
const DENY_HOOK = path.join(REPO_ROOT, 'test', 'fixtures', 'scripts', 'deny-hook.js');

const REQUEST_TIMEOUT_MS = 12000;
const OVERALL_TIMEOUT_MS = 25000;

// ── results harness ───────────────────────────────────────────────────────────────────────────
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

// ── snapshot / restore (byte-for-byte; re-absent if it didn't exist) ────────────────────────────
function snapshot(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_e) { return null; }
}
function restore(p, snap) {
  try {
    if (snap === null) { if (fs.existsSync(p)) fs.unlinkSync(p); }
    else { fs.writeFileSync(p, snap); }
  } catch (_e) { /* best-effort */ }
}

// ── a tiny JSON-RPC-over-stdio client bound to a spawned child ──────────────────────────────────
// WRITE: LSP-style Content-Length framing. READ: the gateway writes newline-delimited JSON.
function makeClient(child) {
  let nextId = 1;
  let buf = '';
  let stderr = '';
  const pending = new Map();

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_e) { continue; }
      if (obj && Object.prototype.hasOwnProperty.call(obj, 'id') && pending.has(obj.id)) {
        const w = pending.get(obj.id);
        pending.delete(obj.id);
        clearTimeout(w.timer);
        w.resolve(obj);
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  function request(method, params) {
    const id = nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    const byteLen = Buffer.byteLength(body, 'utf8');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for "${method}" (id ${id})`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`Content-Length: ${byteLen}\r\n\r\n${body}`);
    });
  }
  function rejectAll(err) {
    for (const [, w] of pending) { clearTimeout(w.timer); w.reject(err); }
    pending.clear();
  }
  return { request, rejectAll, getStderr: () => stderr };
}

// Spawn the gateway, run an async fn(client), then always tear the child down.
async function withGateway(fn) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const client = makeClient(child);
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.on('error', (err) => client.rejectAll(new Error('child error: ' + ((err && err.message) || err))));

  // initialize handshake (the gateway connects upstreams eagerly at startup, before this returns).
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'proxy.test.js', version: '0.0.0' },
    });
    return await fn(client);
  } finally {
    try { child.stdin.end(); } catch (_e) { /* ignore */ }
    if (!exited && child.exitCode === null && !child.killed) {
      try { child.kill(); } catch (_e) { /* ignore */ }
    }
  }
}

// Pull the plain text out of a tools/call response envelope.
function textOf(resp) {
  // Forwarded results are passed through TRANSPARENTLY - the upstream's content array IS the
  // tools/call content - so the upstream's text is content[0].text directly, no unwrapping. (If
  // this ever needs to JSON.parse content[0].text again, the transparent pass-through regressed.)
  const c = resp && resp.result && resp.result.content;
  return Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : '';
}

// expose.json wiring the mock upstream. command = process.execPath (DERIVED node binary, not
// hardcoded); the script arg is absolute-inside-root so the aggregator's isolation guard passes.
function exposeConfig() {
  return JSON.stringify({
    version: 1,
    upstreams: [{
      id: 'mockproxy',
      transport: 'stdio',
      command: process.execPath,
      args: [MOCK_SERVER],
      enabled: true,
      description: 'proxy.test.js fixture - the bundled mock upstream.',
    }],
    expose: [
      { upstream: 'mockproxy', tool: 'ping', as: 'mockproxy_ping', category: 'test', enabled: true },
      { upstream: 'mockproxy', tool: 'add', as: 'mockproxy_add', category: 'test', enabled: true },
      { upstream: 'mockproxy', tool: 'echo', as: 'mockproxy_echo', category: 'test', enabled: true },
      { upstream: 'mockproxy', tool: 'blocks', as: 'mockproxy_blocks', category: 'test', enabled: true },
    ],
  }, null, 2) + '\n';
}

// hooks manifest with a PreToolUse deny hook matching ONLY mockproxy_ping (reuses the shipped
// test deny-hook fixture by absolute path; forward slashes for a clean Windows command string).
function denyManifest() {
  const hookPath = DENY_HOOK.split(path.sep).join('/');
  return JSON.stringify({
    version: 1,
    hooks: [{
      id: 'pre-tool-use/proxy-deny',
      event: 'PreToolUse',
      matcher: 'mockproxy_ping',
      type: 'command',
      command: 'node "' + hookPath + '"',
      timeout: 10,
      enabled: true,
      description: 'proxy.test.js fixture: deny the forwarded mockproxy_ping to prove the gate fails closed on a forwarded call.',
    }],
  }, null, 2) + '\n';
}

(async () => {
  const exposeSnap = snapshot(EXPOSE_PATH);
  const manifestSnap = snapshot(MANIFEST_PATH);
  let fatal = null;

  const overall = setTimeout(() => { /* watchdog; the per-request timeouts do the real work */ }, OVERALL_TIMEOUT_MS);
  overall.unref();

  try {
    // Pre-flight: the bundled mock + deny fixture must exist.
    assert.ok(fs.existsSync(MOCK_SERVER), 'mock upstream missing at ' + MOCK_SERVER);
    assert.ok(fs.existsSync(DENY_HOOK), 'deny-hook fixture missing at ' + DENY_HOOK);

    // ── PART A - FORWARD (allow-all manifest) ──────────────────────────────────────────────────
    fs.writeFileSync(EXPOSE_PATH, exposeConfig());
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ version: 1, hooks: [] }, null, 2) + '\n');

    await withGateway(async (client) => {
      const list = await client.request('tools/list', {});
      const names = ((list.result && list.result.tools) || []).map((t) => t && t.name);
      check('FORWARD: tools/list advertises the forwarded mockproxy_ping/_add/_echo', () => {
        for (const n of ['mockproxy_ping', 'mockproxy_add', 'mockproxy_echo']) {
          assert.ok(names.includes(n), 'forwarded tool "' + n + '" missing; got: ' + JSON.stringify(names));
        }
      });

      const ping = await client.request('tools/call', { name: 'mockproxy_ping', arguments: {} });
      check('FORWARD: mockproxy_ping returns the upstream\'s "pong"', () => {
        assert.notStrictEqual(ping.result && ping.result.isError, true, 'ping reported isError: ' + JSON.stringify(ping.result));
        assert.strictEqual(textOf(ping), 'pong', 'expected "pong", got ' + JSON.stringify(textOf(ping)));
      });

      const add = await client.request('tools/call', { name: 'mockproxy_add', arguments: { a: 2, b: 3 } });
      check('FORWARD: mockproxy_add forwards args and returns 5', () => {
        assert.strictEqual(textOf(add), '5', 'expected "5", got ' + JSON.stringify(textOf(add)));
      });

      const echo = await client.request('tools/call', { name: 'mockproxy_echo', arguments: { text: 'hello toolfunnel' } });
      check('FORWARD: mockproxy_echo round-trips text through the upstream', () => {
        assert.strictEqual(textOf(echo), 'hello toolfunnel', 'expected echoed text, got ' + JSON.stringify(textOf(echo)));
      });

      // Envelope fidelity on the CURATED-DIRECT path: multi-block content AND structuredContent
      // must arrive verbatim - the wrap path always kept them, but the curated shaping used to
      // drop structuredContent.
      const blocks = await client.request('tools/call', { name: 'mockproxy_blocks', arguments: {} });
      check('FORWARD: curated-direct keeps multi-block content + structuredContent', () => {
        const r = blocks.result || {};
        assert.ok(Array.isArray(r.content) && r.content.length >= 2, 'expected multi-block content, got ' + JSON.stringify(r.content));
        assert.ok(r.structuredContent && typeof r.structuredContent === 'object',
          'structuredContent DROPPED on the curated-direct path: ' + JSON.stringify(r));
      });
    });

    // ── PART B - GATE (PreToolUse deny on the forwarded tool, fails closed) ─────────────────────
    fs.writeFileSync(MANIFEST_PATH, denyManifest()); // expose.json unchanged (still the mock)

    await withGateway(async (client) => {
      const blocked = await client.request('tools/call', { name: 'mockproxy_ping', arguments: {} });
      check('GATE: forwarded mockproxy_ping is BLOCKED (isError, upstream never answers)', () => {
        assert.strictEqual(blocked.result && blocked.result.isError, true,
          'expected isError:true for a blocked forward, got ' + JSON.stringify(blocked.result));
        assert.notStrictEqual(textOf(blocked), 'pong', 'the upstream answered "pong" - the gate FAILED OPEN');
      });

      const stillRuns = await client.request('tools/call', { name: 'mockproxy_add', arguments: { a: 10, b: 7 } });
      check('GATE: a NON-matched forwarded tool (mockproxy_add) still runs (per-tool gate)', () => {
        assert.strictEqual(textOf(stillRuns), '17', 'expected "17", got ' + JSON.stringify(textOf(stillRuns)));
      });
    });
  } catch (err) {
    fatal = err;
  } finally {
    clearTimeout(overall);
    // Restore the live config exactly as found.
    restore(EXPOSE_PATH, exposeSnap);
    restore(MANIFEST_PATH, manifestSnap);
  }

  // ── Report ──────────────────────────────────────────────────────────────────────────────────
  for (const r of results) {
    console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  }
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const ok = !fatal && failed === 0 && results.length === 7;

  // Confirm we left the config as we found it.
  const exposeOk = snapshot(EXPOSE_PATH) === exposeSnap;
  const manifestOk = snapshot(MANIFEST_PATH) === manifestSnap;
  console.log('restore: expose.json ' + (exposeOk ? 'OK' : 'MISMATCH') + ', hooks.manifest.json ' + (manifestOk ? 'OK' : 'MISMATCH'));

  if (ok && exposeOk && manifestOk) {
    console.log(`\nPASS: proxy test - ${passed}/7 assertions passed (forwarded tools list + real answers incl. structuredContent; PreToolUse deny hard-blocks a forwarded call; per-tool; config restored)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: proxy test - ${passed}/${results.length} assertions passed${(!exposeOk || !manifestOk) ? ' (CONFIG RESTORE MISMATCH)' : ''}`);
    process.exit(1);
  }
})().catch((e) => {
  console.log('PROXY TEST CRASHED: ' + ((e && e.stack) || e));
  process.exit(1);
});
