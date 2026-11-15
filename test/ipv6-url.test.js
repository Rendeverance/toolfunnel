#!/usr/bin/env node
/**
 * ipv6-url.test.js - the advertised URLs bracket an IPv6 bind host.
 *
 * Both hosts built their advertised base URL as `http://${host}:${port}`. For an IPv6 host that
 * yields `http://::1:9998`, which no URL parser reads as host "::1" port 9998 - and the same string
 * fed the OAuth resource-metadata URL, the startup log line and the UI's "listening on" report.
 * The MCP host and the config UI now bracket a literal IPv6 host: `http://[::1]:9998`.
 *
 * Binds to the IPv6 loopback. If the machine has no ::1 (rare; every CI runner does) the bind
 * error is reported and the file passes with a note - a skipped environment is not a regression.
 *
 * Run:  node test/ipv6-url.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const path = require('node:path');
const assert = require('node:assert');

const { useTempHome } = require('./helpers/temp-home');
const HOME = useTempHome({ prefix: 'tf-ipv6-url-' }); // scratch config home, claimed BEFORE any src/ module captures the repo's
const REPO_ROOT = path.resolve(__dirname, '..');
const { createHttpMcpServer } = require(path.join(REPO_ROOT, 'src', 'mcp', 'http-transport.js'));
const { createUiServer } = require(path.join(REPO_ROOT, 'src', 'ui', 'server.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}
const isNoIpv6 = (err) => /EADDRNOTAVAIL|EAFNOSUPPORT|EINVAL/.test(String(err && (err.code || err.message)));

(async () => {
  // MCP host
  {
    const server = createHttpMcpServer({ host: '::1', port: 0 });
    let info = null; let err = null;
    try { info = await server.start(); } catch (e) { err = e; }
    if (err && isNoIpv6(err)) {
      console.log('note: IPv6 loopback unavailable here (' + err.code + ') - MCP host check skipped');
      results.push({ name: 'MCP host: (skipped - no IPv6 loopback on this machine)', ok: true });
    } else {
      check('MCP host: start() on "::1" advertises a BRACKETED IPv6 url', () => {
        assert.ok(!err, 'start failed: ' + (err && err.message));
        assert.strictEqual(info.url, `http://[::1]:${info.port}`, 'url = ' + info.url);
      });
      try { await server.stop(); } catch (_e) { /* ignore */ }
    }
  }
  // config UI
  {
    const ui = createUiServer({ host: '::1', port: 0, root: HOME.home });
    let info = null; let err = null;
    try { info = await ui.start(); } catch (e) { err = e; }
    if (err && isNoIpv6(err)) {
      console.log('note: IPv6 loopback unavailable here (' + err.code + ') - UI check skipped');
      results.push({ name: 'config UI: (skipped - no IPv6 loopback on this machine)', ok: true });
    } else {
      check('config UI: start() on "::1" advertises a BRACKETED IPv6 url', () => {
        assert.ok(!err, 'start failed: ' + (err && err.message));
        assert.strictEqual(info.url, `http://[::1]:${info.port}`, 'url = ' + info.url);
      });
      try { await ui.stop(); } catch (_e) { /* ignore */ }
    }
  }

  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  const expected = 2;
  if (passed === results.length && results.length === expected) {
    console.log(`\nPASS: ipv6-url test - ${passed}/${expected} assertions passed (IPv6 hosts are bracketed in advertised urls)`);
    process.exit(0);
  }
  console.log(`\nFAIL: ipv6-url test - ${passed}/${results.length} assertions passed`);
  process.exit(1);
})().catch((e) => { console.log('IPV6-URL TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
