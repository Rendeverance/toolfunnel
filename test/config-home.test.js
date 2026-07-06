'use strict';

/**
 * config-home.test.js — the external CONFIG HOME (board item 9's enabler): a gateway pointed at
 * an empty directory via TOOLFUNNEL_HOME must seed it, run from it, and confine every mutation
 * to it — the package tree stays byte-identical (an `npm update` can then never eat user tools,
 * and a wrapped MCP can ship its own bundled home).
 *
 *   A — SEED:     first run against an empty home seeds the shipped register, the scripts
 *                 (including tf-env.js, the seeded-script engine shim), an EMPTY expose.json
 *                 (never the populated example), and the hooks manifest.
 *   B — IDENTITY: a toolfunnel.json placed in the home BEFORE first run drives the initialize
 *                 serverInfo — identity travels with the pack, not the package.
 *   C — LIVE:     tools/list serves the meta-tools; toolfunnel_run_tool(tf_tool_add) executes the
 *                 SEEDED management script (engine via TOOLFUNNEL_PKG), writes the new entry +
 *                 script INTO THE HOME, and the new tool then RUNS from the home.
 *   D — ISOLATION: after all of it, the package's own tools.register.json is byte-identical.
 *
 * NON-DESTRUCTIVE: the home is an OS tmpdir (removed in finally); the package tree is only read.
 * Node built-ins only. Run:  node test/config-home.test.js   (exit 0 = pass)
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const PKG_REGISTER = path.join(REPO_ROOT, 'tools', 'tools.register.json');

const REQUEST_TIMEOUT_MS = 15000;

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

// ── a JSON-RPC-over-stdio client (mirrors reload.test.js) ─────────────────────────────────────
function makeClient(child) {
  let nextId = 1;
  let buf = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
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
  function request(method, params) {
    const id = nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for "${method}"`)); }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    });
  }
  return { request };
}

function textOf(resp) {
  const c = resp && resp.result && resp.result.content;
  return Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : '';
}

/** tools/call toolfunnel_run_tool over the wire → { isError, output, payload, raw }. On success
 *  content[0].text IS the tool's output object {ok,code,stdout,stderr}; payload = the script's
 *  own stdout JSON (null when unavailable). */
async function runTool(client, name, args) {
  const resp = await client.request('tools/call', {
    name: 'toolfunnel_run_tool',
    arguments: { name, args: args || {} },
  });
  const raw = textOf(resp);
  const isError = !!(resp && resp.result && resp.result.isError);
  let output = null;
  try { output = JSON.parse(raw); } catch (_e) { /* an error result is plain text — leave null */ }
  let payload = null;
  if (output && output.ok === true && typeof output.stdout === 'string') {
    try { payload = JSON.parse(output.stdout.trim()); } catch (_e) { /* leave null */ }
  }
  return { isError, output, payload, raw };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const pkgRegisterSnap = fs.readFileSync(PKG_REGISTER, 'utf8');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-home-'));
  let child = null;
  let fatal = null;

  try {
    // B (setup): the pack's identity, in place BEFORE first run.
    fs.writeFileSync(path.join(home, 'toolfunnel.json'),
      JSON.stringify({ serverName: 'packed-mcp', serverVersion: '1.2.3' }, null, 2) + '\n');

    child = spawn(process.execPath, [ENTRY], {
      cwd: os.tmpdir(), // NOT the repo — nothing may resolve via cwd
      env: { ...process.env, TOOLFUNNEL_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });
    const client = makeClient(child);

    // B — identity travels with the home.
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'config-home.test', version: '0' },
    });
    check('B: initialize reports the HOME toolfunnel.json identity (packed-mcp@1.2.3)', () => {
      const si = init.result && init.result.serverInfo;
      assert.ok(si, 'no serverInfo; stderr: ' + stderr.slice(-500));
      assert.strictEqual(si.name, 'packed-mcp', 'got ' + JSON.stringify(si));
      assert.strictEqual(si.version, '1.2.3', 'got ' + JSON.stringify(si));
    });

    // A — the empty home was seeded from the shipped defaults.
    check('A: the home was seeded (register, scripts incl. tf-env.js, hooks manifest)', () => {
      assert.ok(fs.existsSync(path.join(home, 'tools', 'tools.register.json')), 'register not seeded');
      assert.ok(fs.existsSync(path.join(home, 'tools', 'scripts', 'tf-tool-add.js')), 'management script not seeded');
      assert.ok(fs.existsSync(path.join(home, 'tools', 'scripts', 'tf-env.js')), 'tf-env.js (engine shim) not seeded');
      assert.ok(fs.existsSync(path.join(home, 'hooks', 'hooks.manifest.json')), 'hooks manifest not seeded');
    });
    check('A: the seeded expose.json is the EMPTY default, never the populated example', () => {
      const exp = JSON.parse(fs.readFileSync(path.join(home, 'mcp', 'expose.json'), 'utf8'));
      assert.deepStrictEqual(exp, { version: 1, upstreams: [], expose: [] }, 'got ' + JSON.stringify(exp));
    });
    check('A: no state overlay is seeded (a fresh home starts at default visibility)', () => {
      assert.ok(!fs.existsSync(path.join(home, 'tools', 'tools.state.json')), 'tools.state.json should be absent');
    });

    // C — the surface is alive, and a management mutation lands IN THE HOME.
    const list = await client.request('tools/list', {});
    check('C: tools/list serves the meta-tools from the seeded home', () => {
      const names = ((list.result && list.result.tools) || []).map((t) => t && t.name);
      assert.ok(names.includes('toolfunnel_run_tool'), 'meta-tools missing; got ' + JSON.stringify(names));
    });

    const add = await runTool(client, 'tf_tool_add', {
      id: 'homeprobe',
      name: 'homeprobe',
      summary: 'config-home.test.js fixture',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      invoke: { type: 'script', path: 'scripts/home-probe.js' },
      scriptText: "process.stdout.write(JSON.stringify({ ok: true, probe: 'ran-from-home' }));\n",
    });
    check('C: tf_tool_add (a SEEDED script, engine via TOOLFUNNEL_PKG) succeeds in the home', () => {
      assert.ok(!add.isError && add.output && add.output.ok === true, 'output: ' + add.raw + ' stderr: ' + stderr.slice(-500));
      assert.ok(add.payload && add.payload.ok === true && add.payload.id === 'homeprobe', 'payload: ' + JSON.stringify(add.payload));
    });
    check('C: the new entry + its script were written INTO THE HOME', () => {
      const reg = JSON.parse(fs.readFileSync(path.join(home, 'tools', 'tools.register.json'), 'utf8'));
      assert.ok(reg.tools.some((t) => t && t.id === 'homeprobe'), 'homeprobe not in the home register');
      assert.ok(fs.existsSync(path.join(home, 'tools', 'scripts', 'home-probe.js')), 'script not written into the home');
    });

    // The running gateway picks the new entry up via the register WATCHER (fs.watch + 150 ms
    // debounce), so poll rather than race it — same pattern as reload.test.js.
    let probe = null;
    const probeDeadline = Date.now() + 8000;
    while (Date.now() < probeDeadline) {
      probe = await runTool(client, 'homeprobe', {});
      if (!probe.isError && probe.payload) break;
      await sleep(300);
    }
    check('C: the home-authored tool RUNS from the home (after the register watcher reload)', () => {
      assert.ok(probe && !probe.isError, 'last result: ' + (probe && probe.raw));
      assert.ok(probe.payload && probe.payload.probe === 'ran-from-home', 'payload: ' + JSON.stringify(probe && probe.payload));
    });

    // D — the package tree is untouched by ANY of it.
    check('D: the PACKAGE register is byte-identical (every mutation confined to the home)', () => {
      assert.strictEqual(fs.readFileSync(PKG_REGISTER, 'utf8'), pkgRegisterSnap, 'the package register CHANGED');
    });
  } catch (err) {
    fatal = err;
  } finally {
    if (child && !child.killed && child.exitCode === null) {
      try { child.stdin.end(); } catch (_e) { /* ignore */ }
      try { child.kill(); } catch (_e) { /* ignore */ }
    }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }

  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));

  const passed = results.filter((r) => r.ok).length;
  const expected = 9;
  const ok = !fatal && passed === results.length && results.length === expected;
  if (ok) {
    console.log(`\nPASS: config-home test — ${passed}/${expected} assertions passed (seeded home, pack identity, seeded-script engine shim, home-confined mutations, package untouched)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: config-home test — ${passed}/${results.length} assertions passed`);
    process.exit(1);
  }
})().catch((e) => { console.log('CONFIG-HOME TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
