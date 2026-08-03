'use strict';

/**
 * disconnect-cancel.test.js - disconnect-as-cancellation for modern HTTP tools/call (0.7.0,
 * a decided trade).
 *
 * The modern spec's rule ("closing the SSE response stream MUST be treated as cancellation",
 * streamable-http.mdx:235-240) is written for per-request SSE streams; this gateway answers
 * plain JSON, so the only close signal is the bare POST socket - ambiguous (proxy timeout,
 * keep-alive reset, real abort). The decided trade treats a PREMATURE close as cancellation
 * anyway - gated on modern tools/call - and honours the agreed riders: the cancellation is
 * AUDIT-LOGGED and COUNTED on /health so a client that comes back can discover it. The
 * accepted consequence (documented at the code): a proxy-killed socket spuriously cancels the
 * response of a live gated call; upstream work stops only where a cancel path exists.
 *
 * Spawned gateway (--http) over a scratch home; upstream = meta-upstream TF_META_SLOW=1
 * (a 3s tool - long enough to disconnect mid-call). Audit log pre-enabled via
 * logs/log.config.json. Exit 0 = trade implemented; 1 = the shipped nothing; 2 = sanity broke.
 * CommonJS. Node built-ins only.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const META_FIXTURE = path.join(__dirname, 'fixtures', 'servers', 'meta-upstream.js');

let fails = 0;
let sanityBroke = false;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'disc-test', version: '0.0.0' },
};

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_e) { /* */ }
        resolve({ status: res.statusCode, json });
      });
    }).on('error', reject);
  });
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-disc-'));
  for (const d of ['mcp', 'hooks', 'tools', 'logs']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const fixtureCopy = path.join(home, 'mcp', 'meta-upstream.js');
  fs.copyFileSync(META_FIXTURE, fixtureCopy);
  fs.writeFileSync(path.join(home, 'mcp', 'expose.json'), JSON.stringify({
    version: 1,
    upstreams: [{ id: 'metaup', transport: 'stdio', command: process.execPath, args: [fixtureCopy], env: { TF_META_SLOW: '1' }, enabled: true }],
    expose: [{ upstream: 'metaup', tool: 'slow', as: 'slow_direct', enabled: true }],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(home, 'hooks', 'hooks.manifest.json'), JSON.stringify({ version: 1, hooks: [] }) + '\n');
  fs.writeFileSync(path.join(home, 'tools', 'tools.state.json'), '{}\n');
  fs.writeFileSync(path.join(home, 'logs', 'log.config.json'), JSON.stringify({ enabled: true, path: 'logs/toolfunnel.log.jsonl' }) + '\n');

  const child = spawn(process.execPath, [ENTRY, '--http', '--port', '0'], {
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
    check('host bound a port', Number.isInteger(port), errBuf.slice(0, 200));
    if (!Number.isInteger(port)) { sanityBroke = true; throw new Error('no port'); }

    // Wait for the upstream connect (health reports it).
    {
      const t0 = Date.now();
      for (;;) {
        const h = await getJson(port, '/health');
        if (h.json && h.json.upstreamsConnected >= 1) break;
        if (Date.now() - t0 > 20000) { sanityBroke = true; break; }
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    // 0. RED marker: /health exposes the counter at all (absent on 0.6.0).
    const h0 = await getJson(port, '/health');
    check('/health exposes disconnectCancels (0 on a fresh host)',
      h0.json && h0.json.disconnectCancels === 0,
      'health=' + JSON.stringify(h0.json).slice(0, 200));

    // 1. Fire a modern slow call and DESTROY the socket mid-flight.
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 41, method: 'tools/call',
      params: { name: 'slow_direct', arguments: {}, _meta: META },
    });
    await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/mcp',
        headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body, 'utf8'),
          'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'slow_direct',
        },
      });
      req.on('error', () => {}); // the destroy surfaces as an error locally - expected
      req.write(body);
      req.end();
      setTimeout(() => { try { req.destroy(); } catch (_e) { /* ignore */ } resolve(); }, 500);
    });

    // 2. RED: the counter increments (poll - the close event races the destroy).
    let counted = false;
    {
      const t0 = Date.now();
      for (;;) {
        const h = await getJson(port, '/health');
        if (h.json && h.json.disconnectCancels === 1) { counted = true; break; }
        if (Date.now() - t0 > 8000) break;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    check('premature modern tools/call close is COUNTED as a cancellation', counted, 'disconnectCancels never reached 1');

    // 3. RED: the cancellation is in the AUDIT LOG (the agreed rider).
    await new Promise((r) => setTimeout(r, 3500)); // let the slow call settle server-side first
    const logPath = path.join(home, 'logs', 'toolfunnel.log.jsonl');
    let logText = '';
    try { logText = fs.readFileSync(logPath, 'utf8'); } catch (_e) { /* absent = fail below */ }
    check('the cancellation is audit-logged (event: disconnect-cancel, naming the tool)',
      /"event":"disconnect-cancel"/.test(logText) && /slow_direct/.test(logText),
      'log tail: ' + logText.slice(-300));

    // 4. Guard: a COMPLETED modern call does not count.
    const okBody = JSON.stringify({
      jsonrpc: '2.0', id: 42, method: 'tools/call',
      params: { name: 'toolfunnel_list_tools', arguments: {}, _meta: META },
    });
    await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/mcp',
        headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(okBody, 'utf8'),
          'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'toolfunnel_list_tools',
        },
      }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
      req.on('error', reject);
      req.write(okBody);
      req.end();
    });
    const h4 = await getJson(port, '/health');
    check('a completed modern call never counts as a cancellation',
      h4.json && h4.json.disconnectCancels === 1,
      'disconnectCancels=' + (h4.json && h4.json.disconnectCancels));
  } finally {
    try { child.stdin.end(); } catch (_e) { /* ignore */ }
    setTimeout(() => { try { child.kill(); } catch (_e) { /* ignore */ } }, 300);
  }

  console.log(fails ? `\n${fails} disconnect-cancel failure(s).` : '\ndisconnect-as-cancellation trade holds.');
  process.exit(sanityBroke ? 2 : (fails ? 1 : 0));
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
