'use strict';

/**
 * audit-log.test.js - proves the TWO audit event types added in the v0.3.0 hardening wave actually
 * reach the toggleable activity log (src/core/logger.js):
 *
 *   - { type:'config', via:'ui', event:'<change>', ... }  - written by the admin UI (src/ui/server.js
 *     logConfigChange) after EVERY successful config-MUTATING POST. A management console changes the
 *     gateway's security posture; auditing those changes matters more than logging individual runs.
 *   - { type:'auth', event:'deny', status, path }         - written at the TRANSPORT gate
 *     (src/mcp/http-transport.js passesAuth) when an OAuth-protected request is rejected. This is the
 *     security-relevant event; it was previously invisible (rejected before the protocol/log layer).
 *
 * Both are self-gating (logger.log is a no-op unless logging is enabled), so this enables the log to
 * an ABSOLUTE temp file (keeping the repo's logs/ dir clean) and reads it back.
 *
 * Steps:
 *   1. CONFIG : enable the log -> POST /api/tools/state {id:'echo', hot:true} on the live UI server ->
 *               a {type:'config', via:'ui', event:'tool_state', id:'echo', hot:true} line is written;
 *               a read-only GET /api/tools adds NO config line.
 *   2. AUTH   : enable OAuth on a live HTTP host -> POST /mcp with NO token -> 401 -> a
 *               {type:'auth', event:'deny', status:401, path:'/mcp'} line is written.
 *
 * Mutates SHARED on-disk state (logs/log.config.json, auth/auth.config.json, tools/tools.state.json);
 * all three are snapshotted up front and RESTORED in a finally (+ a SIGINT/SIGTERM guard restores the
 * auth + log config synchronously, so a killed run can't leave auth ON or the log enabled). Run
 * SEQUENTIALLY via run-all.js (never `node --test`).
 *
 * Convention: standalone node script, exit 0 = pass. Node built-ins only (assert, http, fs, os, path,
 * crypto). Run:  node test/audit-log.test.js
 */

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const logger = require(path.join(ROOT, 'src', 'core', 'logger.js'));
const authConfig = require(path.join(ROOT, 'src', 'auth', 'config.js'));
const { createHttpMcpServer } = require(path.join(ROOT, 'src', 'mcp', 'http-transport.js'));
const { createUiServer } = require(path.join(ROOT, 'src', 'ui', 'server.js'));

const LOGS_DIR = path.join(ROOT, 'logs');
const LOG_CONFIG_PATH = path.join(LOGS_DIR, 'log.config.json');
const AUTH_CONFIG_PATH = authConfig.CONFIG_PATH;
const STATE_PATH = path.join(ROOT, 'tools', 'tools.state.json');

// An ABSOLUTE temp log the logger uses verbatim - keeps the repo's logs/ dir untouched except for the
// config file we snapshot/restore. Guaranteed-absent at start.
const TEMP_LOG = path.join(os.tmpdir(), `toolfunnel-audit-${process.pid}-${crypto.randomUUID()}.jsonl`);

const ISSUER = 'https://issuer.test';
const AUDIENCE = 'https://gateway.test';

// ── tiny loopback HTTP client (mirrors auth.test.js / http.test.js) ───────────────────────────────
function request(o) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, o.headers || {});
    if (o.body != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(o.body, 'utf8');
    }
    const req = http.request({ host: o.host, port: o.port, method: o.method, path: o.path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_e) { /* non-JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (o.body != null) req.write(o.body);
    req.end();
  });
}

// ── tiny harness (matches gate.test.js / logging.test.js) ─────────────────────────────────────────
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

// ── snapshot helpers (exact bytes or absent) ──────────────────────────────────────────────────────
function snap(p) {
  return fs.existsSync(p) ? { existed: true, content: fs.readFileSync(p, 'utf8') } : { existed: false, content: null };
}
function restore(p, s) {
  try {
    if (s.existed) fs.writeFileSync(p, s.content);
    else if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_e) { /* best-effort */ }
}

const LOGS_DIR_EXISTED = fs.existsSync(LOGS_DIR);
const logSnap = snap(LOG_CONFIG_PATH);
const authSnap = snap(AUTH_CONFIG_PATH);
const stateSnap = snap(STATE_PATH);

// Restore the security-relevant config SYNCHRONOUSLY on a catchable interrupt - a killed run must not
// leave auth ENABLED (breaks the next http.test.js) or the activity log enabled.
function restoreSync() {
  restore(AUTH_CONFIG_PATH, authSnap);
  restore(LOG_CONFIG_PATH, logSnap);
}
process.on('SIGINT', () => { restoreSync(); process.exit(1); });
process.on('SIGTERM', () => { restoreSync(); process.exit(1); });

function readRecords() {
  try {
    return fs.readFileSync(TEMP_LOG, 'utf8').split('\n').filter((l) => l.length > 0)
      .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
      .filter(Boolean);
  } catch (_e) { return []; }
}
function rawLineCount() {
  try { return fs.readFileSync(TEMP_LOG, 'utf8').split('\n').filter((l) => l.length > 0).length; }
  catch (_e) { return 0; }
}

(async () => {
  let fatal = null;
  let uiHost = null;
  let mcpHost = null;

  try {
    // ── 1. CONFIG-CHANGE AUDIT (type:'config', via:'ui') ────────────────────────────────────────
    logger.setConfig({ enabled: true, path: TEMP_LOG });

    uiHost = createUiServer({ host: '127.0.0.1', port: 0, root: ROOT });
    const ui = await uiHost.start();
    const UH = '127.0.0.1';

    const set = await request({ host: UH, port: ui.port, method: 'POST', path: '/api/tools/state', body: JSON.stringify({ id: 'echo', hot: true }) });
    check('CONFIG: POST /api/tools/state succeeded (200, ok:true)', () => {
      assert.strictEqual(set.status, 200, 'status = ' + set.status + ' body=' + set.text);
      assert.ok(set.json && set.json.ok === true, 'body = ' + set.text);
    });

    const cfgRecs = readRecords();
    check('CONFIG: a {type:"config", via:"ui", event:"tool_state"} line was written', () => {
      const hit = cfgRecs.find((r) => r && r.type === 'config' && r.via === 'ui' && r.event === 'tool_state');
      assert.ok(hit, 'records = ' + JSON.stringify(cfgRecs));
      assert.strictEqual(hit.id, 'echo', 'config line should carry the changed id - ' + JSON.stringify(hit));
      assert.strictEqual(hit.hot, true, 'config line should carry the changed axis - ' + JSON.stringify(hit));
    });

    // A read-only GET must NOT add a config-change line (only mutating POSTs are audited).
    const beforeGet = rawLineCount();
    await request({ host: UH, port: ui.port, method: 'GET', path: '/api/tools' });
    check('CONFIG: a read-only GET /api/tools adds NO config line', () => {
      assert.strictEqual(rawLineCount(), beforeGet, 'a GET changed the log line count (it must not)');
    });

    await uiHost.stop();
    uiHost = null;

    // ── 2. AUTH-DENY AUDIT (type:'auth', event:'deny') ──────────────────────────────────────────
    // A coherent, enabled config (issuer+audience+algorithms). jwksUri points nowhere on purpose -
    // a no-token request is rejected at the bearer check BEFORE any JWKS fetch, so it is never hit.
    authConfig.setConfig({
      enabled: true, issuer: ISSUER, audience: AUDIENCE,
      jwksUri: 'http://127.0.0.1:1/jwks', algorithms: ['RS256'], requiredScopes: [], clockToleranceSec: 30,
    });

    mcpHost = createHttpMcpServer({ host: '127.0.0.1', port: 0 });
    const started = await mcpHost.start();
    const initBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'audit.test', version: '0' } } });

    const denied = await request({ host: '127.0.0.1', port: started.port, method: 'POST', path: '/mcp', body: initBody });
    check('AUTH: a no-token POST /mcp is rejected with 401', () => {
      assert.strictEqual(denied.status, 401, 'status = ' + denied.status);
    });

    const authRecs = readRecords();
    check('AUTH: a {type:"auth", event:"deny", status:401, path:"/mcp"} line was written', () => {
      const hit = authRecs.find((r) => r && r.type === 'auth' && r.event === 'deny');
      assert.ok(hit, 'records = ' + JSON.stringify(authRecs));
      assert.strictEqual(hit.status, 401, 'deny line status - ' + JSON.stringify(hit));
      assert.strictEqual(hit.path, '/mcp', 'deny line path - ' + JSON.stringify(hit));
    });

    await mcpHost.stop();
    mcpHost = null;
  } catch (err) {
    fatal = err;
  } finally {
    try { if (uiHost) await uiHost.stop(); } catch (_e) { /* ignore */ }
    try { if (mcpHost) await mcpHost.stop(); } catch (_e) { /* ignore */ }
    // Restore all shared state byte-for-byte (or re-absent), drop the temp log, and remove logs/ only
    // if WE created it (for the config file).
    restore(AUTH_CONFIG_PATH, authSnap);
    restore(LOG_CONFIG_PATH, logSnap);
    restore(STATE_PATH, stateSnap);
    try { if (fs.existsSync(TEMP_LOG)) fs.unlinkSync(TEMP_LOG); } catch (_e) { /* ignore */ }
    if (!LOGS_DIR_EXISTED) {
      try { if (fs.existsSync(LOGS_DIR) && fs.readdirSync(LOGS_DIR).length === 0) fs.rmdirSync(LOGS_DIR); } catch (_e) { /* ignore */ }
    }
  }

  // ── verify restore left shared state as found ─────────────────────────────────────────────────
  check('RESTORE: tools.state.json is byte-for-byte the snapshot', () => {
    const now = snap(STATE_PATH);
    assert.strictEqual(now.existed, stateSnap.existed, 'state existence changed');
    assert.strictEqual(now.content, stateSnap.content, 'tools.state.json not restored');
  });
  check('RESTORE: auth config is byte-for-byte the snapshot', () => {
    const now = snap(AUTH_CONFIG_PATH);
    assert.strictEqual(now.existed, authSnap.existed, 'auth config existence changed');
    assert.strictEqual(now.content, authSnap.content, 'auth config not restored');
  });

  for (const r of results) {
    console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  }
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const ok = !fatal && failed === 0 && results.length > 0;

  if (ok) {
    console.log(`\nPASS: audit-log test - ${passed}/${results.length} assertions passed ` +
      `(config-change audit via UI; auth-deny audit at the transport gate; shared state restored)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: audit-log test - ${passed}/${results.length} assertions passed, ${failed} failed`);
    process.exit(1);
  }
})().catch((e) => {
  console.log('AUDIT-LOG TEST CRASHED: ' + ((e && e.stack) || e));
  process.exit(1);
});
