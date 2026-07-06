'use strict';

/**
 * server-config.test.js — the OPTIONAL toolfunnel.json identity/port config (item 6 of the 0.4.0
 * board): a wrapped MCP built on toolfunnel must be able to introduce itself as ITSELF.
 *
 *   A — UNIT loadServerConfig: absent file → the compiled-in defaults (name "toolfunnel",
 *       version from package.json, ports 9998/9777).
 *   B — UNIT: a full valid file overrides every field; a PARTIAL file overrides only its fields.
 *   C — UNIT tolerance, field by field: bad JSON → all defaults; an invalid FIELD (empty name,
 *       port 0 / out-of-range / non-integer) falls back to that field's default without
 *       poisoning the valid fields next to it.
 *   D — E2E: with a toolfunnel.json at the repo root, a REAL spawned gateway (stdio) reports the
 *       custom serverInfo in the initialize handshake — the wrapped-MCP identity story, proven at
 *       the wire. Without it (restored), serverInfo is "toolfunnel" @ package.json version.
 *
 * NON-DESTRUCTIVE: the repo root's toolfunnel.json is snapshotted (normally ABSENT) and re-absented
 * in `finally`. Unit parts use a scratch dir under the OS tmpdir. Node built-ins only.
 *
 * Run:  node test/server-config.test.js     (exit 0 = pass, non-zero = fail)
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const ROOT_CONFIG = path.join(REPO_ROOT, 'toolfunnel.json');
const PKG_VERSION = require(path.join(REPO_ROOT, 'package.json')).version;

const { loadServerConfig } = require(path.join(REPO_ROOT, 'src', 'core', 'server-config.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

/** A scratch dir holding one toolfunnel.json with the given content (string written verbatim). */
function scratchWith(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-servercfg-'));
  if (content !== null) fs.writeFileSync(path.join(dir, 'toolfunnel.json'), content);
  return dir;
}

/** Spawn the real gateway, run initialize, resolve serverInfo. Kills the child either way. */
function initializeServerInfo() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch (_e) {} reject(new Error('initialize timed out')); }, 15000);
    let buf = '';
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
        if (obj && obj.id === 1) {
          clearTimeout(timer);
          try { child.stdin.end(); } catch (_e) {}
          try { child.kill(); } catch (_e) {}
          return resolve(obj.result && obj.result.serverInfo);
        }
      }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'server-config.test', version: '0' } },
    });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  });
}

(async () => {
  const rootCfgSnap = fs.existsSync(ROOT_CONFIG) ? fs.readFileSync(ROOT_CONFIG, 'utf8') : null;
  const scratchDirs = [];
  let fatal = null;

  try {
    // A — absent file → defaults.
    const dirA = scratchWith(null); scratchDirs.push(dirA);
    const a = loadServerConfig(dirA);
    check('A: absent toolfunnel.json → default identity + ports', () => {
      assert.deepStrictEqual(a, { serverName: 'toolfunnel', serverVersion: PKG_VERSION, httpPort: 9998, uiPort: 9777 });
    });

    // B — full override + partial override.
    const dirB = scratchWith(JSON.stringify({ serverName: 'my-mcp', serverVersion: '2.5.0', httpPort: 7001, uiPort: 7002 }));
    scratchDirs.push(dirB);
    const b = loadServerConfig(dirB);
    check('B: a full valid file overrides every field', () => {
      assert.deepStrictEqual(b, { serverName: 'my-mcp', serverVersion: '2.5.0', httpPort: 7001, uiPort: 7002 });
    });
    const dirB2 = scratchWith(JSON.stringify({ serverName: 'partial-mcp' })); scratchDirs.push(dirB2);
    const b2 = loadServerConfig(dirB2);
    check('B: a partial file overrides only its own fields', () => {
      assert.strictEqual(b2.serverName, 'partial-mcp');
      assert.strictEqual(b2.serverVersion, PKG_VERSION, 'version should stay the package default');
      assert.strictEqual(b2.httpPort, 9998);
      assert.strictEqual(b2.uiPort, 9777);
    });

    // C — tolerance: bad JSON → defaults; invalid fields fall back individually.
    const dirC = scratchWith('{ this is not json'); scratchDirs.push(dirC);
    check('C: bad JSON → all defaults (the gateway must still start)', () => {
      assert.deepStrictEqual(loadServerConfig(dirC), a);
    });
    const dirC2 = scratchWith(JSON.stringify({ serverName: '   ', serverVersion: 7, httpPort: 0, uiPort: 70000 }));
    scratchDirs.push(dirC2);
    const c2 = loadServerConfig(dirC2);
    check('C: invalid fields (blank name, numeric version, port 0, port 70000) fall back per-field', () => {
      assert.deepStrictEqual(c2, a);
    });
    const dirC3 = scratchWith(JSON.stringify({ serverName: 'good-name', httpPort: 'not-a-port' }));
    scratchDirs.push(dirC3);
    const c3 = loadServerConfig(dirC3);
    check('C: one bad field does not poison the valid field next to it', () => {
      assert.strictEqual(c3.serverName, 'good-name');
      assert.strictEqual(c3.httpPort, 9998);
    });

    // D — E2E at the wire: the spawned gateway introduces itself per the root config.
    fs.writeFileSync(ROOT_CONFIG, JSON.stringify({ serverName: 'wrapped-mcp-e2e', serverVersion: '9.9.9' }, null, 2) + '\n');
    const custom = await initializeServerInfo();
    check('D: initialize reports the configured identity (wrapped-MCP handshake)', () => {
      assert.ok(custom, 'no serverInfo in the initialize result');
      assert.strictEqual(custom.name, 'wrapped-mcp-e2e', 'got ' + JSON.stringify(custom));
      assert.strictEqual(custom.version, '9.9.9', 'got ' + JSON.stringify(custom));
    });
    // Remove the config and confirm the default identity is back (no sticky state).
    fs.unlinkSync(ROOT_CONFIG);
    const plain = await initializeServerInfo();
    check('D: without the file the gateway is plain "toolfunnel" @ the package version', () => {
      assert.ok(plain, 'no serverInfo in the initialize result');
      assert.strictEqual(plain.name, 'toolfunnel', 'got ' + JSON.stringify(plain));
      assert.strictEqual(plain.version, PKG_VERSION, 'got ' + JSON.stringify(plain));
    });
  } catch (err) {
    fatal = err;
  } finally {
    try {
      if (rootCfgSnap === null) { if (fs.existsSync(ROOT_CONFIG)) fs.unlinkSync(ROOT_CONFIG); }
      else fs.writeFileSync(ROOT_CONFIG, rootCfgSnap);
    } catch (_e) { /* best-effort */ }
    for (const d of scratchDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
    }
  }

  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));

  const passed = results.filter((r) => r.ok).length;
  const expected = 8;
  const ok = !fatal && passed === results.length && results.length === expected;
  if (ok) {
    console.log(`\nPASS: server-config test — ${passed}/${expected} assertions passed (defaults, overrides, per-field tolerance, e2e identity at the wire)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: server-config test — ${passed}/${results.length} assertions passed`);
    process.exit(1);
  }
})().catch((e) => { console.log('SERVER-CONFIG TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
