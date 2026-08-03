'use strict';

/**
 * http-status-map.test.js - the modern-error HTTP status map, era-scoped cursor rejection, and
 * modern-only 405s (three 0.7.0 changes, one cycle: 6.1 is 4.1's observable proof).
 *
 *   4.1 Modern in-handler errors carry their spec-mandated HTTP status: -32602 -> 400 (MUST,
 *       basic-index.mdx:381-382), -32020/-32021/-32022 -> 400, -32601 -> 404 (existing).
 *       The transport maps by CODE for modern bodies - in-handler mints (6.1) inherit.
 *   6.1 An unrecognised tools/list cursor answers -32602 on every cursor-AWARE revision:
 *       modern everywhere; legacy on STDIO sessions negotiated >= 2025-03-26 (the negotiated
 *       version is a true session fact only there - HTTP is sessionless and keeps the frozen
 *       ignore, a documented approximation). 2024-11-05 is EXEMPT (frozen: cursor ignored,
 *       full list) - the funnel's own list is single-page, so ANY present cursor is unknown.
 *   4.5 Modern-only mode (serveLegacy:false): GET and DELETE on the MCP endpoint answer
 *       405 Method Not Allowed + Allow: POST (the spec's own compatibility answer,
 *       streamable-http.mdx:684 - replaces the LAST -32020 misuse; DELETE was a generic 404).
 *       Dual-era GET keeps the legacy SSE channel (pinned).
 *
 * In-process host for the map + dual-era guards; one spawned modern-only gateway for the 405s.
 * Exit 0 = contract holds; 1 = the shipped 0.6.0 shape; 2 = sanity broke. CommonJS.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const s = require(path.join(REPO_ROOT, 'src', 'mcp', 'server.js'));
const { createHttpMcpServer } = require(path.join(REPO_ROOT, 'src', 'mcp', 'http-transport.js'));
const authConfig = require(path.join(REPO_ROOT, 'src', 'auth', 'config.js'));

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'status-map-test', version: '0.0.0' },
};

let fails = 0;
let sanityBroke = false;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

function request(port, o) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, o.headers || {});
    if (o.body != null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(o.body, 'utf8');
    }
    const req = http.request({ host: '127.0.0.1', port, method: o.method || 'POST', path: o.path || '/mcp', headers }, (res) => {
      const chunks = [];
      let done = false;
      const finish = () => {
        if (done) return; done = true; clearTimeout(t);
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_e) { /* non-JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      };
      const t = setTimeout(() => { finish(); try { res.destroy(); } catch (_e) { /* ignore */ } }, 2500);
      res.on('data', (c) => chunks.push(c));
      res.on('end', finish);
      res.on('error', finish);
    });
    req.on('error', reject);
    if (o.body != null) req.write(o.body);
    req.end();
  });
}

(async () => {
  // Heal WITHOUT creating (mirrors run-all's backstop): an absent config already means
  // disabled - an unconditional setConfig would CREATE the file on every clean run.
  try {
    if (authConfig.getConfig().enabled === true) authConfig.setConfig({ enabled: false });
  } catch (_e) { /* best-effort; default is off anyway */ }

  // ── stdio-side 6.1 (in-process handleMessage, 'stdio' connKey = a true session) ─────────────
  {
    const build = s.buildProtocol();
    await s.handleMessage(build, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
    }, 'stdio');
    const r = await s.handleMessage(build, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { cursor: 'bogus' } }, 'stdio');
    check('6.1: stdio session at 2025-03-26 - unknown cursor -> -32602',
      r && r.error && r.error.code === -32602 && /cursor/i.test(r.error.message || ''),
      JSON.stringify(r).slice(0, 180));

    const build2 = s.buildProtocol();
    await s.handleMessage(build2, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '0' } },
    }, 'stdio');
    const r2 = await s.handleMessage(build2, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { cursor: 'bogus' } }, 'stdio');
    const r2ok = r2 && r2.result && Array.isArray(r2.result.tools);
    check('6.1: 2024-11-05 session EXEMPT - cursor ignored, full list (frozen)', r2ok, JSON.stringify(r2).slice(0, 160));
    if (!r2ok) sanityBroke = true;
  }

  // ── HTTP: the 4.1 map + guards (in-process, default dual-era config) ────────────────────────
  {
    const server = createHttpMcpServer({ host: '127.0.0.1', port: 0 });
    const { port } = await server.start();
    try {
      // 4.1 via 6.1: modern tools/list with an unknown cursor -> -32602 at HTTP 400.
      const h1 = await request(port, {
        headers: { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { cursor: 'bogus', _meta: MODERN_META } }),
      });
      check('4.1+6.1: modern unknown cursor -> -32602 at HTTP 400',
        h1.status === 400 && h1.json && h1.json.error && h1.json.error.code === -32602,
        `status=${h1.status} body=${h1.text.slice(0, 160)}`);

      // Frozen guard: HTTP LEGACY with a cursor (sessionless, no header) keeps the ignore.
      const h2 = await request(port, { body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { cursor: 'bogus' } }) });
      const h2ok = h2.status === 200 && h2.json && h2.json.result && Array.isArray(h2.json.result.tools);
      check('frozen: HTTP legacy cursor still ignored (sessionless - documented approximation)', h2ok,
        `status=${h2.status} body=${h2.text.slice(0, 140)}`);
      if (!h2ok) sanityBroke = true;

      // Frozen guard: dual-era GET /mcp still opens the legacy SSE channel.
      const h3 = await request(port, { method: 'GET', path: '/mcp', headers: { Accept: 'text/event-stream' } });
      const h3ok = h3.status === 200 && /event-stream/.test(h3.headers['content-type'] || '');
      check('frozen: dual-era GET /mcp still opens the SSE stream', h3ok,
        `status=${h3.status} ct=${h3.headers['content-type']}`);
      if (!h3ok) sanityBroke = true;

      // Sanity: modern valid tools/list -> 200.
      const h4 = await request(port, {
        headers: { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: MODERN_META } }),
      });
      const h4ok = h4.status === 200 && h4.json && h4.json.result;
      check('sanity: modern cursorless tools/list -> 200', h4ok, `status=${h4.status}`);
      if (!h4ok) sanityBroke = true;
    } finally {
      try { await server.stop(); } catch (_e) { /* ignore */ }
    }
  }

  // ── 4.5: modern-only mode GET/DELETE -> 405 (spawned - SERVER_CONFIG binds at require) ──────
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-405-'));
    for (const d of ['mcp', 'hooks', 'tools']) fs.mkdirSync(path.join(home, d), { recursive: true });
    fs.writeFileSync(path.join(home, 'toolfunnel.json'), JSON.stringify({ serveLegacy: false }));
    fs.writeFileSync(path.join(home, 'mcp', 'expose.json'), JSON.stringify({ version: 1, upstreams: [], expose: [] }));
    fs.writeFileSync(path.join(home, 'hooks', 'hooks.manifest.json'), JSON.stringify({ version: 1, hooks: [] }));
    fs.writeFileSync(path.join(home, 'tools', 'tools.state.json'), '{}');
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'bin', 'toolfunnel.js'), '--http', '--port', '0'], {
      cwd: REPO_ROOT,
      env: Object.assign({}, process.env, { TOOLFUNNEL_HOME: home }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let errBuf = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { errBuf += d; });
    child.stdout.on('data', () => {});
    try {
      const port = await new Promise((resolve) => {
        const t0 = Date.now();
        (function poll() {
          const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(errBuf);
          if (m) return resolve(Number(m[1]));
          if (Date.now() - t0 > 15000) return resolve(null);
          setTimeout(poll, 150);
        })();
      });
      check('modern-only host bound a port', Number.isInteger(port), 'stderr=' + errBuf.slice(0, 200));
      if (Number.isInteger(port)) {
        const g = await request(port, { method: 'GET', path: '/mcp', headers: { Accept: 'text/event-stream' } });
        check('4.5: modern-only GET /mcp -> 405 + Allow: POST',
          g.status === 405 && /post/i.test(g.headers.allow || ''),
          `status=${g.status} allow=${g.headers.allow} body=${g.text.slice(0, 140)}`);

        const del = await request(port, { method: 'DELETE', path: '/mcp' });
        check('4.5: modern-only DELETE /mcp -> 405', del.status === 405, `status=${del.status} body=${del.text.slice(0, 120)}`);

        const p = await request(port, {
          headers: { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: { _meta: MODERN_META } }),
        });
        const pok = p.status === 200 && p.json && p.json.result;
        check('sanity: modern-only POST still served', pok, `status=${p.status}`);
        if (!pok) sanityBroke = true;
      }
    } finally {
      try { child.stdin.end(); } catch (_e) { /* ignore */ }
      setTimeout(() => { try { child.kill(); } catch (_e) { /* ignore */ } }, 300);
    }
  }

  console.log(fails ? `\n${fails} status-map failure(s).` : '\nstatus map + 405s + era-scoped cursor hold.');
  process.exit(sanityBroke ? 2 : (fails ? 1 : 0));
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
