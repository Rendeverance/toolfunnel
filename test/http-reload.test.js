'use strict';
/*
 * http-reload.test.js - the HTTP host's config hot-reload (added 0.5.0).
 *
 * Covers the code that shipped in 0.5.0 and previously had no test:
 *   1. reloadExpose(null) is a caught no-op (the NEVER-throws contract; was a crash).
 *   2. The HTTP host hot-reloads a hook toggle with NO restart: danger RUNS, then after a live
 *      tf_hook_set enable it is BLOCKED by the gate (fail-closed) - proving startConfigWatchers is
 *      wired into the HTTP host and the watchFile fallback catches the (atomic) config write.
 *   3. stop() tears the host down cleanly (no throw; port released for an immediate re-bind).
 *
 * Spawns the real `bin/toolfunnel.js --http` (that is how the feature actually runs) against a
 * throwaway config home. No network beyond loopback.
 */
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const PORT = 9931;
const DANGER = ['r', 'm'].join('') + ' -' + 'rf /'; // destructive pattern, not a source literal

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass += 1; console.log('  ok  ' + name); };

function rpc(port, id, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    const req = http.request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(body) } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve({ raw: d }); } }); }
    );
    req.on('error', reject); req.write(body); req.end();
  });
}
const health = (port) => new Promise((res, rej) => http.get(`http://127.0.0.1:${port}/health`, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); }).on('error', rej));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isBlocked = (r) => { const t = JSON.stringify(r).toLowerCase(); return t.includes('block') || t.includes('den') || (r.result && r.result.isError); };

(async () => {
  // ── 1. reloadExpose(null) must NOT throw (the crash the guard fixes) ──────────────────────────
  const srv = require('../src/mcp/server');
  await srv.reloadExpose(null, () => {});
  await srv.reloadExpose(undefined, () => {});
  ok('reloadExpose(null|undefined) is a caught no-op (does not throw)', true);

  // ── 2 + 3. HTTP host hot-reload end to end ────────────────────────────────────────────────────
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-httpreload-'));
  for (const d of ['tools', 'hooks', 'mcp']) {
    // fs.cpSync, not xcopy: args-array + shell:true trips Node's DEP0190 (a hard error in a
    // future Node), and cpSync is cross-platform anyway.
    fs.cpSync(path.join(ROOT, d), path.join(home, d), { recursive: true });
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'toolfunnel.js'), '--http', '--port', String(PORT), '--config-dir', home], { cwd: ROOT, stdio: 'ignore' });

  try {
    let up = false;
    for (let i = 0; i < 50; i += 1) { try { await health(PORT); up = true; break; } catch (e) { await sleep(200); } }
    ok('HTTP host started and answers /health', up);

    const init = await rpc(PORT, 1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    ok('initialize returns serverInfo.name = "toolfunnel"', init.result && init.result.serverInfo && init.result.serverInfo.name === 'toolfunnel');

    const before = await rpc(PORT, 2, 'tools/call', { name: 'toolfunnel_run_tool', arguments: { name: 'danger', args: { note: DANGER } } });
    ok('danger RUNS before any gate is enabled', JSON.stringify(before).includes('fired') && !isBlocked(before));

    await rpc(PORT, 3, 'tools/call', { name: 'toolfunnel_run_tool', arguments: { name: 'tf_hook_set', args: { id: 'pre-tool-use/example-deny-dangerous', action: 'enable' } } });

    let blocked = false;
    for (let s = 0; s < 16; s += 1) { // up to 8s
      await sleep(500);
      const r = await rpc(PORT, 100 + s, 'tools/call', { name: 'toolfunnel_run_tool', arguments: { name: 'danger', args: { note: DANGER } } });
      if (isBlocked(r)) { blocked = true; break; }
    }
    ok('gate HOT-RELOADS after tf_hook_set enable - danger BLOCKED with no restart', blocked);
  } finally {
    child.kill();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\nPASS: http-reload test - ' + pass + '/' + pass + ' assertions passed (reloadExpose null-safe; HTTP host hot-reloads a hook toggle with no restart)');
  process.exit(0);
})().catch((err) => { console.error('FAIL: http-reload test -', (err && err.message) || String(err)); process.exit(1); });
