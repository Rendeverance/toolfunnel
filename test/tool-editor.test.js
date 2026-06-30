'use strict';

/**
 * tool-editor.test.js — proves the admin-UI tool VIEW + EDIT round-trip (src/ui/server.js):
 *
 *   GET  /api/tools/detail?id=<id>  → the FULL entry (name, summary, category, instructions, invoke,
 *                                     mode) plus the script BODY for a script invoke, so a user can
 *                                     see everything about one tool; unknown id → 404.
 *   POST /api/tools/update {id, patch:{...}} → shallow-merge + re-validate + atomic persist, and the
 *                                     change is observable on the next detail read.
 *
 * Drives a LIVE UI server over loopback (mirrors auth.test.js Part E). It mutates the SHARED
 * tools/tools.register.json (registry.update rewrites it), so the register is snapshotted up front and
 * RESTORED byte-for-byte in a finally — a failure mid-flight still leaves the register as found. The
 * edit is a metadata patch (summary) only, so the on-disk echo.js script is never touched. Run
 * SEQUENTIALLY via run-all.js (never `node --test`).
 *
 * Convention: standalone node script, exit 0 = pass. Node built-ins only (assert, http, fs, path).
 * Run:  node test/tool-editor.test.js
 */

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { createUiServer } = require(path.join(ROOT, 'src', 'ui', 'server.js'));

const REGISTER_PATH = path.join(ROOT, 'tools', 'tools.register.json');
const NEW_SUMMARY = 'EDITED BY tool-editor.test (pid ' + process.pid + ')';

// ── tiny loopback HTTP client (mirrors auth.test.js) ──────────────────────────────────────────────
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

// ── tiny harness ──────────────────────────────────────────────────────────────────────────────────
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

(async () => {
  let fatal = null;
  let uiHost = null;
  const registerSnapshot = fs.readFileSync(REGISTER_PATH, 'utf8');

  try {
    uiHost = createUiServer({ host: '127.0.0.1', port: 0, root: ROOT });
    const ui = await uiHost.start();
    const H = '127.0.0.1';
    const P = ui.port;

    // ── 1. DETAIL: a known script tool returns its full entry + the script body. ─────────────────
    const detail = await request({ host: H, port: P, method: 'GET', path: '/api/tools/detail?id=echo' });
    check('DETAIL: GET /api/tools/detail?id=echo → 200 ok', () => {
      assert.strictEqual(detail.status, 200, 'status = ' + detail.status + ' body=' + detail.text);
      assert.ok(detail.json && detail.json.ok === true, 'body = ' + detail.text);
    });
    check('DETAIL: the full entry comes back (id, invoke)', () => {
      const e = detail.json && detail.json.entry;
      assert.ok(e && e.id === 'echo', 'entry = ' + JSON.stringify(e));
      assert.ok(e.invoke && e.invoke.type === 'script', 'echo should be a script invoke — ' + JSON.stringify(e.invoke));
    });
    check('DETAIL: the script BODY is returned for a script invoke', () => {
      assert.ok(typeof detail.json.scriptText === 'string' && detail.json.scriptText.length > 0,
        'scriptText should be the non-empty echo.js body — got ' + JSON.stringify(detail.json.scriptText));
    });

    // ── 2. DETAIL: an unknown id is a clean 404 (not a crash). ───────────────────────────────────
    const missing = await request({ host: H, port: P, method: 'GET', path: '/api/tools/detail?id=__tf_no_such_tool__' });
    check('DETAIL: an unknown id → 404 ok:false', () => {
      assert.strictEqual(missing.status, 404, 'status = ' + missing.status);
      assert.ok(missing.json && missing.json.ok === false, 'body = ' + missing.text);
    });

    // ── 3. UPDATE: patch the summary; the response carries the merged entry. ──────────────────────
    const upd = await request({ host: H, port: P, method: 'POST', path: '/api/tools/update', body: JSON.stringify({ id: 'echo', patch: { summary: NEW_SUMMARY } }) });
    check('UPDATE: POST /api/tools/update → 200 ok, merged entry returned', () => {
      assert.strictEqual(upd.status, 200, 'status = ' + upd.status + ' body=' + upd.text);
      assert.ok(upd.json && upd.json.ok === true, 'body = ' + upd.text);
      assert.strictEqual(upd.json.entry && upd.json.entry.summary, NEW_SUMMARY, 'entry.summary = ' + JSON.stringify(upd.json.entry && upd.json.entry.summary));
    });

    // ── 4. ROUND-TRIP: a fresh detail read reflects the persisted edit. ──────────────────────────
    const after = await request({ host: H, port: P, method: 'GET', path: '/api/tools/detail?id=echo' });
    check('ROUND-TRIP: the edited summary persisted (next detail read shows it)', () => {
      assert.strictEqual(after.json && after.json.entry && after.json.entry.summary, NEW_SUMMARY,
        'persisted summary = ' + JSON.stringify(after.json && after.json.entry && after.json.entry.summary));
    });

    // ── 5. UPDATE: an unknown id is a clean 404. ─────────────────────────────────────────────────
    const updMissing = await request({ host: H, port: P, method: 'POST', path: '/api/tools/update', body: JSON.stringify({ id: '__tf_no_such_tool__', patch: { summary: 'x' } }) });
    check('UPDATE: an unknown id → 404 ok:false', () => {
      assert.strictEqual(updMissing.status, 404, 'status = ' + updMissing.status);
      assert.ok(updMissing.json && updMissing.json.ok === false, 'body = ' + updMissing.text);
    });
  } catch (err) {
    fatal = err;
  } finally {
    try { if (uiHost) await uiHost.stop(); } catch (_e) { /* ignore */ }
    // Restore the register byte-for-byte (no re-serialisation; preserves LF).
    try { fs.writeFileSync(REGISTER_PATH, registerSnapshot); } catch (_e) { /* best-effort */ }
  }

  check('RESTORE: tools.register.json is byte-for-byte the snapshot', () => {
    assert.strictEqual(fs.readFileSync(REGISTER_PATH, 'utf8'), registerSnapshot, 'register not restored');
  });

  for (const r of results) {
    console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  }
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const ok = !fatal && failed === 0 && results.length > 0;

  if (ok) {
    console.log(`\nPASS: tool-editor test — ${passed}/${results.length} assertions passed ` +
      `(detail returns entry+script body; unknown id 404; update merges + persists + round-trips; register restored)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: tool-editor test — ${passed}/${results.length} assertions passed, ${failed} failed`);
    process.exit(1);
  }
})().catch((e) => {
  console.log('TOOL-EDITOR TEST CRASHED: ' + ((e && e.stack) || e));
  process.exit(1);
});
