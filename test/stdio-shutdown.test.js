#!/usr/bin/env node
/**
 * stdio-shutdown.test.js - an interrupted stdio gateway closes its upstreams before it exits.
 *
 * The first SIGINT / SIGTERM closes every upstream (tree-kill), then exits 130 or 143; a second
 * exits at once; a close that hangs is bounded. Without the handler, child-reaper's own handler
 * exits first and an upstream that ignores stdin EOF outlives the gateway (on POSIX).
 *
 * A child node process builds a real Aggregator over a real McpClient to a fixture server that
 * IGNORES stdin EOF, installs the handler as main() does, tracks a dummy child with child-reaper,
 * then EMITS the signal in-process (so the handlers run on Windows too, where an outside signal is
 * an unconditional terminate). The parent checks the exit code, that the aggregator was closed
 * BEFORE exit (recorded by an exit hook - the contract, observable on every platform), and that
 * the fixture's process is gone.
 *
 * Run:  node test/stdio-shutdown.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { makeTempHome, REPO_ROOT } = require('./helpers/temp-home');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

// An upstream that answers the legacy handshake and then refuses to die on stdin EOF.
const FIXTURE = `'use strict';
const fs = require('fs');
fs.writeFileSync(process.argv[2], String(process.pid));
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue; let m; try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.id === undefined) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    if (m.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stubborn', version: '1.0.0' } });
    else if (m.method === 'tools/list') reply({ tools: [{ name: 'noop', description: 'x', inputSchema: { type: 'object' } }] });
    else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } }) + '\\n');
  }
});
process.stdin.on('end', () => { /* deliberately NOT exiting */ });
setInterval(() => {}, 1000);
`;

// The child: build the real pieces, install the shutdown exactly as main() does, then emit.
const DRIVER = (repo, fixture, pidFile, sig, markFile) => `'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Aggregator } = require(${JSON.stringify(path.join(repo, 'src', 'mcp', 'aggregator.js'))});
const server = require(${JSON.stringify(path.join(repo, 'src', 'mcp', 'server.js'))});
const reaper = require(${JSON.stringify(path.join(repo, 'src', 'core', 'child-reaper.js'))});
const store = {
  listUpstreams: () => [{ id: 'stubborn', transport: 'stdio', command: process.execPath, args: [${JSON.stringify(fixture)}, ${JSON.stringify(pidFile)}], env: {}, enabled: true }],
  getUpstream(id) { return this.listUpstreams().find((u) => u.id === id); },
  listExposed: () => [], exposedName: (e) => e.upstream + '_' + e.tool,
};
(async () => {
  const build = { aggregator: new Aggregator({ store, gatewayRoot: process.env.TOOLFUNNEL_HOME }) };
  // Written synchronously at exit: was every upstream closed before the process went?
  process.on('exit', () => { try { fs.writeFileSync(${JSON.stringify(markFile)}, String(build.aggregator._closed === true)); } catch (e) {} });
  const res = await build.aggregator.connectAll();
  if (!res.connected.includes('stubborn')) { console.log('CONNECT FAILED ' + JSON.stringify(res)); process.exit(3); }
  // A hook/tool child tracked by the reaper: before the fix its handler exited 130 first.
  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  reaper.track(dummy);
  // Pre-fix there is no installer: emitting still reproduces the bug (the reaper exits, the upstream stays).
  if (typeof server.installStdioShutdown === 'function') server.installStdioShutdown(() => build);
  else console.log('NO installStdioShutdown (pre-fix behaviour)');
  console.log('READY');
  process.emit(${JSON.stringify(sig)}, ${JSON.stringify(sig)});
})();
`;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCase(T, sig) {
  const fixture = path.join(T.mcpDir, 'stubborn-fixture.js');
  const pidFile = path.join(T.mcpDir, `stubborn-${sig}.pid`);
  const driver = path.join(T.mcpDir, `driver-${sig}.js`);
  const markFile = path.join(T.mcpDir, `closed-${sig}.txt`);
  fs.writeFileSync(fixture, FIXTURE);
  fs.writeFileSync(driver, DRIVER(REPO_ROOT, fixture, pidFile, sig, markFile));
  const child = spawn(process.execPath, [driver], { env: T.env(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => { try { child.kill(); } catch (_e) { /* ignore */ } resolve('timeout'); }, 30000);
    child.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  let pid = null;
  try { pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10); } catch (_e) { /* the fixture never started */ }
  let gone = false;
  for (let i = 0; i < 25 && pid; i++) { if (!alive(pid)) { gone = true; break; } await sleep(200); }
  if (pid && !gone) { try { process.kill(pid); } catch (_e) { /* ignore */ } } // never leave it behind
  let closed = null;
  try { closed = fs.readFileSync(markFile, 'utf8'); } catch (_e) { /* no exit hook ran */ }
  return { code, pid, gone, out, closed };
}

(async () => {
  const T = makeTempHome({ prefix: 'tf-stdio-shutdown-' });
  try {
    const i = await runCase(T, 'SIGINT');
    check('SIGINT: the gateway exits 130 after closing its upstreams', () => {
      assert.ok(/READY/.test(i.out), 'the driver never got ready: ' + i.out.slice(-400));
      assert.strictEqual(i.code, 130, `exit ${i.code}; output: ${i.out.slice(-400)}`);
    });
    check('SIGINT: every upstream was CLOSED before the process exited', () => {
      assert.strictEqual(i.closed, 'true', 'aggregator closed at exit: ' + i.closed + ' (the process exited without closing its upstreams)');
    });
    check('SIGINT: the upstream server that ignores stdin EOF is gone', () => {
      assert.ok(i.pid, 'no fixture pid');
      assert.ok(i.gone, `upstream pid ${i.pid} is still running after the gateway exited`);
    });
    const t = await runCase(T, 'SIGTERM');
    check('SIGTERM: exits 143, upstreams closed first, the upstream is gone', () => {
      assert.strictEqual(t.code, 143, `exit ${t.code}; output: ${t.out.slice(-400)}`);
      assert.strictEqual(t.closed, 'true', 'aggregator closed at exit: ' + t.closed);
      assert.ok(t.pid && t.gone, `upstream pid ${t.pid} still running`);
    });
  } finally {
    T.cleanup();
  }
  const EXPECTED = 4;
  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  if (passed === results.length && results.length === EXPECTED) {
    console.log(`\nPASS: stdio-shutdown test - ${passed}/${EXPECTED} assertions passed (interrupt closes upstreams, then exits 130/143)`);
    process.exit(0);
  }
  console.log(`\nFAIL: stdio-shutdown test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
  process.exit(1);
})().catch((e) => { console.log('STDIO-SHUTDOWN TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(2); });
