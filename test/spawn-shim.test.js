'use strict';

/**
 * spawn-shim.test.js — proves the CROSS-PLATFORM upstream spawn.
 *
 * Real-world MCP servers are almost always launched via a SHIM: `npx`, `npm`, `uvx`, `pnpm` — which
 * on Windows are `.cmd` files. child_process with shell:false CANNOT run a `.cmd` (a bare name
 * ENOENTs; an explicit `.cmd` throws EINVAL since the CVE-2024-27980 mitigation), so before the
 * winLaunch fix an `npx`-based MCP simply would not attach on Windows. POSIX is unaffected (the shim
 * is a real executable on PATH). The rest of the suite spawns the mock upstream via `node` directly,
 * so this is the ONLY test that exercises shim resolution — the exact blind spot that hid the bug.
 *
 * No network: the shim just launches the BUNDLED mock upstream (mcp/servers/mock-upstream/server.js)
 * via the current node binary. We attach it THROUGH the shim and assert the full MCP round-trip
 * (connect -> tools/list -> tools/call) works. Also unit-checks winLaunch()'s platform branch.
 *
 * Node built-ins only. Run:  node test/spawn-shim.test.js   (exit 0 = pass).
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { McpClient, winLaunch } = require('../src/mcp/mcp-client.js');

const ROOT = path.resolve(__dirname, '..');
const MOCK = path.join(ROOT, 'mcp', 'servers', 'mock-upstream', 'server.js');
const NODE = process.execPath;
const isWin = process.platform === 'win32';

// ── tiny harness (matches the sibling tests) ─────────────────────────────────────────────────────
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

/**
 * Write a shim that launches the mock upstream via the absolute node binary (so it never depends on
 * `node` being on PATH inside the shim — the test is about ToolFunnel resolving the SHIM, not the
 * shim's own internals). `@echo off` / `exec` keep the shim from polluting the JSON-RPC stdout stream.
 * @returns {{ shim: string, dir: string }}
 */
function writeShim() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-spawn-shim-'));
  if (isWin) {
    const p = path.join(dir, 'mock-upstream.cmd');
    fs.writeFileSync(p, '@echo off\r\n"' + NODE + '" "' + MOCK + '"\r\n');
    return { shim: p, dir };
  }
  const p = path.join(dir, 'mock-upstream.sh');
  fs.writeFileSync(p, '#!/bin/sh\nexec "' + NODE + '" "' + MOCK + '" "$@"\n');
  fs.chmodSync(p, 0o755);
  return { shim: p, dir };
}

(async () => {
  let fatal = null;

  // ── 1. winLaunch unit — the platform branch (deterministic, no spawn) ──────────────────────────
  check('winLaunch: a shim command is routed through cmd.exe on Windows, passed through on POSIX', () => {
    const r = winLaunch('npx', ['-y', '@scope/pkg']);
    if (isWin) {
      assert.ok(/cmd\.exe$/i.test(r.command), 'win: command should be cmd.exe, got ' + r.command);
      assert.deepStrictEqual(r.args, ['/c', 'npx', '-y', '@scope/pkg'], 'win: args should be /c + discrete argv (no shell concat)');
    } else {
      assert.strictEqual(r.command, 'npx', 'posix: command passes through');
      assert.deepStrictEqual(r.args, ['-y', '@scope/pkg'], 'posix: args pass through');
    }
  });
  check('winLaunch: a concrete .exe is spawned directly (no cmd wrap) on Windows', () => {
    if (!isWin) { assert.ok(true); return; }
    const r = winLaunch('C:\\Program Files\\thing\\thing.exe', ['--flag']);
    assert.strictEqual(r.command, 'C:\\Program Files\\thing\\thing.exe', 'an abs .exe spawns directly');
    assert.deepStrictEqual(r.args, ['--flag']);
  });

  // ── 2. real end-to-end: attach the mock upstream THROUGH a shim, full MCP round-trip ───────────
  const { shim, dir } = writeShim();
  const client = new McpClient({ id: 'shim-test', command: shim, args: [], requestTimeoutMs: 15000 });
  try {
    await checkAsync('connect: an MCP launched via a ' + (isWin ? '.cmd' : '.sh') + ' shim connects (the path shell:false could not run)', async () => {
      await client.connect();
    });

    let tools = [];
    await checkAsync('tools/list: the shim-launched upstream advertises its tools', async () => {
      tools = await client.listTools();
      assert.ok(Array.isArray(tools) && tools.some((t) => t && t.name === 'ping'),
        'expected a ping tool — got ' + JSON.stringify(tools.map((t) => t && t.name)));
    });

    await checkAsync('tools/call: a call through the shim-launched upstream returns its real answer ("pong")', async () => {
      const res = await client.callTool('ping', {});
      const text = JSON.stringify(res);
      assert.ok(/pong/i.test(text), 'ping result did not contain "pong": ' + text.slice(0, 200));
    });
  } catch (err) {
    fatal = err;
  } finally {
    try { client.close(); } catch (_e) { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }

  // ── Report ───────────────────────────────────────────────────────────────────────────────────
  for (const r of results) {
    console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  }
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const ok = !fatal && failed === 0 && results.length > 0;

  if (ok) {
    console.log(`\nPASS: spawn-shim test — ${passed}/${results.length} assertions passed ` +
      `(winLaunch platform branch; an MCP launched via a real ${isWin ? '.cmd' : '.sh'} shim attaches + lists + calls)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: spawn-shim test — ${passed}/${results.length} assertions passed, ${failed} failed`);
    process.exit(1);
  }
})().catch((e) => {
  console.log('SPAWN-SHIM TEST CRASHED: ' + ((e && e.stack) || e));
  process.exit(1);
});
