#!/usr/bin/env node
/**
 * sse-cap.test.js - the legacy GET /mcp SSE channel is capped like the modern listen streams.
 *
 * subscriptions/listen streams are capped at MODERN_LISTENERS_MAX (64) with a clean refusal. The
 * legacy SSE stream (GET /mcp, the Streamable-HTTP server->client channel) had no cap at all: every
 * open stream is a registered response plus a keep-alive timer for the life of the socket, so a
 * client opening streams and never closing them grew the host without bound. The same ceiling now
 * applies; a GET past it answers 503 with a JSON body (a GET has no JSON-RPC id, so a plain error).
 *
 * Run:  node test/sse-cap.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert');

const { useTempHome } = require('./helpers/temp-home');
useTempHome({ prefix: 'tf-sse-cap-' }); // scratch config home, claimed BEFORE any src/ module captures the repo's
const REPO_ROOT = path.resolve(__dirname, '..');
const { createHttpMcpServer } = require(path.join(REPO_ROOT, 'src', 'mcp', 'http-transport.js'));

const CAP = 64; // MODERN_LISTENERS_MAX in http-transport.js
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

/** Open a GET /mcp SSE stream; resolve with { status, req, res } as soon as headers arrive (the stream stays open). */
function openStream(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/mcp', headers: { Accept: 'text/event-stream' } }, (res) => {
      res.on('data', () => {}); // keep the stream drained
      res.on('error', () => {});
      let body = '';
      if (res.statusCode !== 200) {
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body, req, res }));
        return;
      }
      resolve({ status: res.statusCode, body: '', req, res });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const server = createHttpMcpServer({ host: '127.0.0.1', port: 0 });
  const { port } = await server.start();
  const open = [];
  try {
    for (let i = 0; i < CAP; i += 1) open.push(await openStream(port));
    check(`sanity: ${CAP} SSE streams open (each answered 200 text/event-stream)`, () => {
      assert.ok(open.every((s) => s.status === 200), 'statuses: ' + open.map((s) => s.status).join(','));
    });
    const extra = await openStream(port);
    check(`the ${CAP + 1}th stream is REFUSED with 503 and a JSON body (bounded, no silent growth)`, () => {
      assert.strictEqual(extra.status, 503, 'status = ' + extra.status);
      let json = null;
      try { json = JSON.parse(extra.body); } catch (_e) { /* asserted below */ }
      assert.ok(json && typeof json.error === 'string' && /limit/i.test(json.error), 'body = ' + extra.body.slice(0, 120));
    });
    // Close one, and the ceiling frees a slot.
    const victim = open.pop();
    victim.req.destroy();
    await new Promise((r) => setTimeout(r, 150));
    const again = await openStream(port);
    open.push(again);
    check('closing a stream frees its slot (the cap is on LIVE streams, not a lifetime count)', () => {
      assert.strictEqual(again.status, 200, 'status = ' + again.status + ' body=' + again.body.slice(0, 120));
    });
  } finally {
    for (const s of open) { try { s.req.destroy(); } catch (_e) { /* ignore */ } }
    try { await server.stop(); } catch (_e) { /* ignore */ }
  }

  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  const expected = 3;
  if (passed === results.length && results.length === expected) {
    console.log(`\nPASS: sse-cap test - ${passed}/${expected} assertions passed (legacy SSE streams are capped)`);
    process.exit(0);
  }
  console.log(`\nFAIL: sse-cap test - ${passed}/${results.length} assertions passed`);
  process.exit(1);
})().catch((e) => { console.log('SSE-CAP TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
