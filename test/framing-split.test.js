'use strict';

/**
 * framing-split.test.js - a Content-Length frame that arrives in more than one chunk must be
 * DELIVERED, not lost.
 *
 * The dual-framing readers (McpClient._drain and the stdio loop's drain) try header framing
 * first, then newline framing. When a CL header has arrived but its body is still in flight,
 * header framing reports "not yet" - and line framing then eats the header line as a junk
 * "line". The frame is orphaned: the body (single-line JSON with no trailing newline) never
 * parses, the caller sees only a timeout, and every LATER message on the pipe is out of frame.
 * Chunk boundaries are the transport's choice, so any CL-framing peer can hit this under load.
 *
 * Four phases, both sides of the gateway:
 *   C1 client: CL reply split header-block / body        -> callTool must resolve
 *   C2 client: CL reply split INSIDE the header block    -> callTool must resolve
 *   C3 server: CL request split header-block / body      -> request must be answered
 *   C4 server: CL request split INSIDE the header block  -> request must be answered
 * Each phase also proves the pipe is still in frame afterwards with a whole-frame follow-up.
 *
 * Run:  node test/framing-split.test.js     (exit 0 = pass, non-zero = fail)
 */

const path = require('node:path');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'servers', 'framing-upstream.js');
const { McpClient } = require(path.join(REPO_ROOT, 'src', 'mcp', 'mcp-client.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

// ── C3/C4 helper: a tiny stdio client for the spawned gateway with controllable chunking ──────
function makeGatewayClient(child) {
  let nextId = 1;
  let stdoutBuf = '';
  const pending = new Map();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
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
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => { /* captured only to keep the pipe drained */ });

  /**
   * Send one CL-framed request. mode:
   *   'whole'        - header + body in a single write (the known-good baseline)
   *   'split-body'   - full header block first, body ~40 ms later
   *   'split-header' - header line (with \r\n) first, blank line + body ~40 ms later
   */
  function request(method, params, mode) {
    const id = nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    const len = Buffer.byteLength(body, 'utf8');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for "${method}" (${mode})`));
      }, 4000);
      pending.set(id, { resolve, timer });
      if (mode === 'split-body') {
        child.stdin.write(`Content-Length: ${len}\r\n\r\n`);
        setTimeout(() => child.stdin.write(body), 40);
      } else if (mode === 'split-header') {
        child.stdin.write(`Content-Length: ${len}\r\n`);
        setTimeout(() => child.stdin.write('\r\n' + body), 40);
      } else {
        child.stdin.write(`Content-Length: ${len}\r\n\r\n${body}`);
      }
    });
  }

  return { request };
}

(async () => {
  // ── C1 + C2: the CLIENT side (McpClient reading a CL-framing upstream) ──────────────────────
  const client = new McpClient({
    id: 'framing-split',
    command: process.execPath,
    args: [FIXTURE],
    requestTimeoutMs: 1500,
    toolTimeoutMs: 2500,
  });

  try {
    await client.connect();

    let split = null, splitErr = null;
    try { split = await client.callTool('split', {}); } catch (e) { splitErr = e; }
    check('C1: a CL reply split header/body is delivered, not lost to a timeout', () => {
      assert.ok(split, 'callTool("split") rejected: ' + (splitErr && splitErr.message));
      assert.strictEqual(split.content[0] && split.content[0].text, 'split-ok');
    });

    let sh = null, shErr = null;
    try { sh = await client.callTool('splitheader', {}); } catch (e) { shErr = e; }
    check('C2: a CL reply split inside the header block is delivered', () => {
      assert.ok(sh, 'callTool("splitheader") rejected: ' + (shErr && shErr.message));
      assert.strictEqual(sh.content[0] && sh.content[0].text, 'splitheader-ok');
    });

    let ping = null, pingErr = null;
    try { ping = await client.callTool('ping', {}); } catch (e) { pingErr = e; }
    check('C1/C2 aftermath: the pipe is still in frame (ping answers)', () => {
      assert.ok(ping, 'callTool("ping") rejected: ' + (pingErr && pingErr.message));
      assert.strictEqual(ping.content[0] && ping.content[0].text, 'pong');
    });
  } finally {
    client.close();
  }

  // ── C3 + C4: the SERVER side (the stdio loop reading a CL-framing downstream client) ────────
  const child = spawn(process.execPath, [ENTRY], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  const gw = makeGatewayClient(child);

  try {
    // Known-good whole-frame handshake first.
    const init = await gw.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'framing-split.test.js', version: '0.0.0' },
    }, 'whole');
    check('C3/C4 baseline: whole-frame initialize answers', () => {
      assert.ok(init && init.result && init.result.serverInfo, 'no initialize result');
    });

    let r3 = null, r3Err = null;
    try { r3 = await gw.request('tools/list', {}, 'split-body'); } catch (e) { r3Err = e; }
    check('C3: a CL request split header/body is answered by the gateway', () => {
      assert.ok(r3, 'split-body tools/list got no response: ' + (r3Err && r3Err.message));
      assert.ok(r3.result && Array.isArray(r3.result.tools), 'response had no tools[]');
    });

    let r4 = null, r4Err = null;
    try { r4 = await gw.request('tools/list', {}, 'split-header'); } catch (e) { r4Err = e; }
    check('C4: a CL request split inside the header block is answered', () => {
      assert.ok(r4, 'split-header tools/list got no response: ' + (r4Err && r4Err.message));
      assert.ok(r4.result && Array.isArray(r4.result.tools), 'response had no tools[]');
    });

    let after = null, afterErr = null;
    try { after = await gw.request('tools/list', {}, 'whole'); } catch (e) { afterErr = e; }
    check('C3/C4 aftermath: the pipe is still in frame (whole-frame follow-up answers)', () => {
      assert.ok(after, 'follow-up tools/list got no response: ' + (afterErr && afterErr.message));
      assert.ok(after.result && Array.isArray(after.result.tools), 'response had no tools[]');
    });
  } finally {
    try { child.stdin.end(); } catch (_e) { /* ignore */ }
    setTimeout(() => {
      if (exited === null && child.exitCode === null && !child.killed) {
        try { child.kill(); } catch (_e) { /* ignore */ }
      }
    }, 1500).unref();
  }

  // ── Report ──────────────────────────────────────────────────────────────────────────────────
  for (const r of results) {
    console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  }
  const failed = results.filter((r) => !r.ok);
  const total = results.length;
  if (failed.length === 0 && total === 7) {
    console.log(`\nPASS: framing-split - ${total}/7 assertions (split CL frames delivered on both sides, pipe stays in frame)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: framing-split - ${total - failed.length}/${total} assertions passed`);
    process.exit(1);
  }
})().catch((e) => {
  console.log('FRAMING-SPLIT TEST CRASHED: ' + ((e && e.stack) || e));
  process.exit(1);
});
