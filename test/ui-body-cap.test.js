#!/usr/bin/env node
/**
 * ui-body-cap.test.js - an over-cap POST to the config UI gets its 400 JSON, not a reset socket.
 *
 * readJsonBody rejected 'request body too large' and destroyed the request in the same tick. A
 * destroy sends a TCP RST while request bytes are still in flight, and on RST Windows discards the
 * peer's receive queue - so the 400 the handler then wrote never reached the client, which saw
 * ECONNRESET. The MCP transport hit the identical defect on its own cap and fixed it (http-transport
 * readBody + sendJsonAndClose, pinned by http.test.js step 5): stop buffering, reply, then half-close
 * after the reply has flushed. The UI server now mirrors that.
 *
 * Shape (same as http.test.js step 5): stream past the 256 KiB cap in chunks WITHOUT ending the
 * request, then wait for the reply. The reply must be a clean HTTP 400 with the JSON error body.
 *
 * Run:  node test/ui-body-cap.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert');

const { useTempHome } = require('./helpers/temp-home');
const HOME = useTempHome({ prefix: 'tf-ui-body-cap-' }); // scratch config home, claimed BEFORE any src/ module captures the repo's
const REPO_ROOT = path.resolve(__dirname, '..');
const { createUiServer } = require(path.join(REPO_ROOT, 'src', 'ui', 'server.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

(async () => {
  let uiHost = null;
  let fatal = null;
  try {
    uiHost = createUiServer({ host: '127.0.0.1', port: 0, root: HOME.home });
    const { port } = await uiHost.start();

    const overCap = await new Promise((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('over-cap POST: no response within 15s')), 15000);
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/api/tools/update', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            clearTimeout(guard);
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = JSON.parse(text); } catch (_e) { /* leave null */ }
            req.on('error', () => {}); // a late EPIPE on our still-open request side is expected once the reply is in hand
            resolve({ status: res.statusCode, json, text });
          });
          res.on('error', (e) => { clearTimeout(guard); reject(e); });
        }
      );
      req.on('error', (e) => { clearTimeout(guard); reject(e); });
      // Stream past the 256 KiB cap (256 KiB + 64 KiB) in 32 KiB chunks, then WAIT - no end().
      const chunk = Buffer.alloc(32 * 1024, 0x61);
      const target = 256 * 1024 + 64 * 1024;
      let sent = 0;
      const pump = () => {
        while (sent < target) {
          sent += chunk.length;
          if (!req.write(chunk)) { req.once('drain', pump); return; }
        }
      };
      pump();
    }).then((r) => ({ ok: true, ...r }), (err) => ({ ok: false, error: (err && err.message) || String(err) }));

    check('an over-cap UI POST answers HTTP 400 on a healthy socket (no ECONNRESET)', () => {
      assert.ok(overCap.ok, 'client saw a socket error instead of a reply: ' + overCap.error);
      assert.strictEqual(overCap.status, 400, 'status = ' + overCap.status + ' body=' + String(overCap.text).slice(0, 120));
    });
    check('...and the body is the JSON error the handler wrote', () => {
      assert.ok(overCap.ok && overCap.json && overCap.json.ok === false && /too large/.test(overCap.json.error || ''), 'body = ' + String(overCap.text).slice(0, 200));
    });
  } catch (err) {
    fatal = err;
  } finally {
    try { if (uiHost) await uiHost.stop(); } catch (_e) { /* ignore */ }
  }

  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));
  const passed = results.filter((r) => r.ok).length;
  const expected = 2;
  if (!fatal && passed === results.length && results.length === expected) {
    console.log(`\nPASS: ui-body-cap test - ${passed}/${expected} assertions passed (over-cap POST gets its 400 cleanly)`);
    process.exit(0);
  }
  console.log(`\nFAIL: ui-body-cap test - ${passed}/${results.length} assertions passed`);
  process.exit(1);
})().catch((e) => { console.log('UI-BODY-CAP TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
