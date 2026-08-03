'use strict';

/**
 * batching.test.js - JSON-RPC batching, gated to the ONE revision that defines it (0.7.0).
 *
 * Batching exists ONLY in 2025-03-26 (added there, removed again in 2025-06-18) - accepting a
 * batch on any other negotiated revision is itself non-conformant, so the gate IS the feature:
 *
 *   - stdio: arrays are accepted iff THIS session negotiated 2025-03-26 (the stored
 *     negotiated version). Any other session keeps the frozen single-message -32600 rejection.
 *   - HTTP (sessionless): header discipline - an ABSENT MCP-Protocol-Version header passes
 *     (2025-03-26 predates the header, which 2025-06-18 introduced) and an explicit 2025-03-26
 *     passes; anything else keeps the frozen rejection.
 *   - Mechanics per 2025-03-26/transports.mdx:90-119 + JSON-RPC 2.0: members processed in
 *     arrival order, one response per request, notifications answer nothing; solely-
 *     notifications -> HTTP 202 no body; empty batch -> single -32600 (HTTP 400); a malformed
 *     member gets its own error entry.
 *
 * stdio: two REAL gateway spawns (scratch homes, no upstreams) - one negotiates 2025-03-26,
 * one 2024-11-05 (the gate's control). HTTP: in-process host, default config.
 *
 * Exit 0 = batching gated + working; 1 = the shipped reject-all state; 2 = sanity broke.
 * CommonJS. Node built-ins only.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');

let fails = 0;
let sanityBroke = false;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

/** Spawn a bare gateway (no upstreams) over a scratch home; exchange RAW payloads on stdio. */
function makeGateway() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-batch-'));
  for (const d of ['mcp', 'hooks', 'tools']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, 'mcp', 'expose.json'), JSON.stringify({ version: 1, upstreams: [], expose: [] }) + '\n');
  fs.writeFileSync(path.join(home, 'hooks', 'hooks.manifest.json'), JSON.stringify({ version: 1, hooks: [] }) + '\n');
  fs.writeFileSync(path.join(home, 'tools', 'tools.state.json'), '{}\n');
  const child = spawn(process.execPath, [ENTRY], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { TOOLFUNNEL_HOME: home }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buf = '';
  const frames = []; // every parsed JSON value written by the server, in order
  const waiters = [];
  child.stdout.setEncoding('utf8');
  child.stderr.on('data', () => {});
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || (line[0] !== '{' && line[0] !== '[')) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_e) { continue; }
      frames.push(obj);
      for (const w of waiters.splice(0)) w();
    }
  });
  /** Send one raw JSON value (object OR array) Content-Length framed. */
  const sendRaw = (value) => {
    const body = JSON.stringify(value);
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  };
  /** Wait until pred(frames) returns a truthy value (or time out -> null). */
  const waitFor = (pred, ms) => new Promise((resolve) => {
    const t0 = Date.now();
    const poll = () => {
      const hit = pred(frames);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > (ms || 8000)) return resolve(null);
      setTimeout(poll, 50);
    };
    poll();
  });
  const close = () => {
    try { child.stdin.end(); } catch (_e) { /* ignore */ }
    setTimeout(() => { try { child.kill(); } catch (_e) { /* ignore */ } }, 300);
  };
  return { sendRaw, waitFor, frames, close };
}

const initMsg = (version) => ({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'batch-test', version: '0' } },
});
const findById = (frames, id) => frames.find((f) => !Array.isArray(f) && f && f.id === id && (f.result !== undefined || f.error !== undefined));

function httpRequest(port, body, headers) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body, 'utf8') }, headers || {});
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_e) { /* non-JSON / empty */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  // ── stdio, negotiated 2025-03-26: batching LIVE ──────────────────────────────────────────────
  const gwA = makeGateway();
  try {
    gwA.sendRaw(initMsg('2025-03-26'));
    const init = await gwA.waitFor((fr) => findById(fr, 1));
    const initOk = init && init.result && init.result.protocolVersion === '2025-03-26';
    check('sanity: stdio session negotiates 2025-03-26', initOk, JSON.stringify(init).slice(0, 160));
    if (!initOk) sanityBroke = true;

    // RED: a batch of two pings + one notification -> ONE array of exactly the two responses.
    gwA.sendRaw([
      { jsonrpc: '2.0', id: 10, method: 'ping', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 11, method: 'ping', params: {} },
    ]);
    const batchResp = await gwA.waitFor((fr) => fr.find((f) => Array.isArray(f)));
    check('negotiated 2025-03-26: batch answered with a response ARRAY (2 entries, notification silent)',
      Array.isArray(batchResp) && batchResp.length === 2 &&
        batchResp.some((r) => r.id === 10 && r.result !== undefined) &&
        batchResp.some((r) => r.id === 11 && r.result !== undefined),
      'got ' + JSON.stringify(batchResp || gwA.frames.slice(-1)).slice(0, 220) + ' (0.6.0 rejects arrays outright)');

    // RED: a malformed MEMBER gets its own error entry; the healthy member still runs.
    gwA.sendRaw([
      { jsonrpc: '2.0', id: 12, method: 'ping', params: {} },
      'garbage-member',
    ]);
    const mixed = await gwA.waitFor((fr) => fr.find((f) => Array.isArray(f) && f.some((r) => r && r.id === 12)));
    check('a malformed member errors individually; the healthy member still answers',
      Array.isArray(mixed) && mixed.length === 2 &&
        mixed.some((r) => r.id === 12 && r.result !== undefined) &&
        mixed.some((r) => r.error && r.error.code === -32600),
      'got ' + JSON.stringify(mixed).slice(0, 220));

    // RED: an EMPTY batch answers the single JSON-RPC 2.0 -32600 object (not an array).
    gwA.sendRaw([]);
    const empty = await gwA.waitFor((fr) => fr.find((f) => !Array.isArray(f) && f && f.id === null && f.error));
    check('empty batch -> single -32600 error object',
      empty && empty.error && empty.error.code === -32600, 'got ' + JSON.stringify(empty).slice(0, 160));
  } finally { gwA.close(); }

  // ── stdio, negotiated 2024-11-05: the GATE - arrays keep the frozen rejection ───────────────
  const gwB = makeGateway();
  try {
    gwB.sendRaw(initMsg('2024-11-05'));
    const init = await gwB.waitFor((fr) => findById(fr, 1));
    check('sanity: control session negotiates 2024-11-05', !!(init && init.result), JSON.stringify(init).slice(0, 140));
    gwB.sendRaw([{ jsonrpc: '2.0', id: 20, method: 'ping', params: {} }]);
    const rej = await gwB.waitFor((fr) => fr.find((f) => !Array.isArray(f) && f && f.error && f.error.code === -32600));
    check('non-2025-03-26 session: a batch keeps the FROZEN single -32600 rejection',
      rej && rej.error && rej.error.code === -32600 && !gwB.frames.some((f) => Array.isArray(f)),
      'got ' + JSON.stringify(rej).slice(0, 160));
  } finally { gwB.close(); }

  // ── HTTP (sessionless): header discipline ────────────────────────────────────────────────────
  const { createHttpMcpServer } = require('../src/mcp/http-transport.js');
  const authConfig = require('../src/auth/config.js');
  // Heal WITHOUT creating (mirrors run-all's backstop): an absent config already means
  // disabled - an unconditional setConfig would CREATE the file on every clean run.
  try {
    if (authConfig.getConfig().enabled === true) authConfig.setConfig({ enabled: false });
  } catch (_e) { /* best-effort; default is off anyway */ }
  const server = createHttpMcpServer({ host: '127.0.0.1', port: 0 });
  const { port } = await server.start();
  try {
    const batchBody = JSON.stringify([
      { jsonrpc: '2.0', id: 30, method: 'ping', params: {} },
      { jsonrpc: '2.0', id: 31, method: 'ping', params: {} },
    ]);

    // RED: ABSENT header -> accepted (2025-03-26 clients predate the header).
    const noHdr = await httpRequest(port, batchBody);
    check('HTTP absent header: batch -> 200 response array',
      noHdr.status === 200 && Array.isArray(noHdr.json) && noHdr.json.length === 2 &&
        noHdr.json.every((r) => r.result !== undefined),
      `status=${noHdr.status} body=${noHdr.text.slice(0, 180)}`);

    // RED: explicit 2025-03-26 header -> accepted.
    const okHdr = await httpRequest(port, batchBody, { 'MCP-Protocol-Version': '2025-03-26' });
    check('HTTP 2025-03-26 header: batch -> 200 response array',
      okHdr.status === 200 && Array.isArray(okHdr.json) && okHdr.json.length === 2,
      `status=${okHdr.status} body=${okHdr.text.slice(0, 180)}`);

    // The GATE: a SUPPORTED non-batching header keeps the frozen rejection.
    const badHdr = await httpRequest(port, batchBody, { 'MCP-Protocol-Version': '2025-06-18' });
    check('HTTP 2025-06-18 header: batch keeps the FROZEN -32600 rejection (not an array)',
      badHdr.status === 200 && badHdr.json && !Array.isArray(badHdr.json) &&
        badHdr.json.error && badHdr.json.error.code === -32600,
      `status=${badHdr.status} body=${badHdr.text.slice(0, 180)}`);

    // The OTHER gate: an UNKNOWN header never reaches batch handling at all - header enforcement
    // (2.4) refuses it 400/-32022 first, whatever the body shape. 2025-06-18 above is a SUPPORTED
    // era that merely lacks batching (frozen -32600); this is no era of ours at all.
    const unkHdr = await httpRequest(port, batchBody, { 'MCP-Protocol-Version': '2020-01-01' });
    check('HTTP unknown header: batch refused 400/-32022 by header enforcement (not -32600)',
      unkHdr.status === 400 && unkHdr.json && !Array.isArray(unkHdr.json) &&
        unkHdr.json.error && unkHdr.json.error.code === -32022,
      `status=${unkHdr.status} body=${unkHdr.text.slice(0, 180)}`);

    // RED: solely notifications -> 202 Accepted, no body (transports.mdx:96-99).
    const notesOnly = await httpRequest(port, JSON.stringify([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ]));
    check('HTTP solely-notifications batch -> 202 no body',
      notesOnly.status === 202 && notesOnly.text === '',
      `status=${notesOnly.status} body=[${notesOnly.text.slice(0, 120)}]`);

    // RED: empty batch -> 400 + the id-less -32600 (transports.mdx:100-102 "cannot accept").
    const empty = await httpRequest(port, '[]');
    check('HTTP empty batch -> 400 + -32600',
      empty.status === 400 && empty.json && empty.json.error && empty.json.error.code === -32600,
      `status=${empty.status} body=${empty.text.slice(0, 160)}`);

    // SANITY: a single (non-batch) message is untouched.
    const single = await httpRequest(port, JSON.stringify({ jsonrpc: '2.0', id: 40, method: 'ping', params: {} }));
    const singleOk = single.status === 200 && single.json && !Array.isArray(single.json) && single.json.result !== undefined;
    check('sanity: single message untouched', singleOk, `status=${single.status} body=${single.text.slice(0, 140)}`);
    if (!singleOk) sanityBroke = true;
  } finally {
    try { await server.stop(); } catch (_e) { /* ignore */ }
  }

  console.log(fails ? `\n${fails} batching failure(s).` : '\nbatching contract holds (gated to 2025-03-26).');
  process.exit(sanityBroke ? 2 : (fails ? 1 : 0));
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
