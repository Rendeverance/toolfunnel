'use strict';

/**
 * framing-limits.test.js - the stream readers must be BOUNDED.
 *
 * Every other input in the repo is capped (the HTTP transport refuses an over-cap body with a
 * clean -32700), but the two stdio stream readers - McpClient reading an upstream's stdout, and
 * the stdio loop reading a downstream client's stdin - buffered without limit. A single giant
 * unframed line, or a huge declared Content-Length, grew the buffer until the process died,
 * taking the whole gateway (and every attached upstream and client) with it.
 *
 * The contract under test (4 MiB frame cap, matching http-transport's MAX_BODY_BYTES):
 *   - A message declaring a Content-Length OVER the cap is refused without being buffered; the
 *     declared bytes are discarded as they arrive so the pipe STAYS IN FRAME and later messages
 *     flow. (Reject the message, keep the connection - same philosophy as the HTTP transport.)
 *   - An unframeable flood (no complete frame, past the cap) has no resync point: the client
 *     DROPS the connection (unexpected-death path -> the owner's reconnect machinery), and the
 *     server ends the session with a clean -32700 instead of buffering toward OOM.
 *
 * Four phases:
 *   L1 client: oversized declared CL reply -> NOT delivered; connection survives; ping answers
 *   L2 client: unframeable flood           -> connection dropped (onClose fires)
 *   L3 server: oversized declared CL request -> -32700 "message too large"; no reply for that
 *              id; a follow-up request on the same pipe is answered
 *   L4 server: unframeable flood           -> -32700 then the session ends (process exits)
 *
 * Run:  node test/framing-limits.test.js     (exit 0 = pass, non-zero = fail)
 */

const path = require('node:path');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const { makeTempHome } = require('./helpers/temp-home');
// One scratch config home for every gateway this file spawns - never the repo's stores.
const HOME = makeTempHome({ prefix: 'tf-framing-limits-' });
process.on('exit', () => HOME.cleanup());
const FIXTURE = path.join(__dirname, 'fixtures', 'servers', 'framing-upstream.js');
const { McpClient } = require(path.join(REPO_ROOT, 'src', 'mcp', 'mcp-client.js'));

const OVERSIZE = 4718592; // matches the fixture: ~4.5 MiB, past the 4 MiB cap
const CAP = 4 * 1024 * 1024; // MAX_MESSAGE_BYTES on both sides: a body of exactly this size is LEGAL

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Spawn the gateway and return { child, lines, request, exited } - a line-parsing client. */
function spawnGateway() {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: REPO_ROOT,
    env: HOME.env(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdin.on('error', () => { /* EPIPE after the server ends the session is expected */ });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => { /* keep the pipe drained */ });

  let exitInfo = null;
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => { exitInfo = { code, signal }; resolve({ code, signal }); });
  });

  const lines = []; // every parsed JSON line the gateway writes
  const pending = new Map();
  let stdoutBuf = '';
  let nextId = 1;
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
      lines.push(obj);
      if (obj && Object.prototype.hasOwnProperty.call(obj, 'id') && pending.has(obj.id)) {
        const w = pending.get(obj.id);
        pending.delete(obj.id);
        clearTimeout(w.timer);
        w.resolve(obj);
      }
    }
  });

  function request(method, params, timeoutMs) {
    const id = nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for "${method}" (id ${id})`));
      }, timeoutMs || 4000);
      pending.set(id, { resolve, timer, id });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    });
  }

  return { child, lines, request, exited, getExitInfo: () => exitInfo };
}

(async () => {
  // ── L1: client - an oversized declared CL reply is refused, the connection survives ─────────
  {
    const client = new McpClient({
      id: 'limits-big',
      command: process.execPath,
      args: [FIXTURE],
      requestTimeoutMs: 1500,
      toolTimeoutMs: 2500,
    });
    try {
      await client.connect();
      let big = null, bigErr = null;
      try { big = await client.callTool('big', {}); } catch (e) { bigErr = e; }
      check('L1: an over-cap declared reply is NOT delivered', () => {
        assert.strictEqual(big, null,
          'the oversized reply was delivered (' +
          (big && big.content && big.content[0] && big.content[0].text
            ? big.content[0].text.length + ' chars' : 'shape unknown') + ')');
        assert.ok(bigErr, 'callTool("big") neither resolved nor rejected');
      });
      check('L1: the connection SURVIVES the refusal', () => {
        assert.strictEqual(client.connected, true, 'client dropped the connection');
      });
      let ping = null, pingErr = null;
      try { ping = await client.callTool('ping', {}); } catch (e) { pingErr = e; }
      check('L1: the pipe is still in frame afterwards (ping answers)', () => {
        assert.ok(ping, 'callTool("ping") rejected: ' + (pingErr && pingErr.message));
        assert.strictEqual(ping.content[0] && ping.content[0].text, 'pong');
      });
    } finally {
      client.close();
    }
  }

  // ── L2: client - an unframeable flood drops the connection (owner can reconnect) ────────────
  {
    let closeReason = null;
    const client = new McpClient({
      id: 'limits-flood',
      command: process.execPath,
      args: [FIXTURE],
      requestTimeoutMs: 1500,
      toolTimeoutMs: 2500,
      onClose: (reason) => { closeReason = String(reason); },
    });
    try {
      await client.connect();
      let floodErr = null;
      try { await client.callTool('flood', {}); } catch (e) { floodErr = e; }
      // Give the exit event a moment to land after the kill.
      const deadline = Date.now() + 4000;
      while (closeReason === null && Date.now() < deadline) await sleep(50);
      check('L2: the flooded connection is DROPPED (onClose fired -> reconnect machinery)', () => {
        assert.ok(closeReason !== null, 'onClose never fired - the flood was buffered, not refused');
      });
      check('L2: the in-flight call rejects rather than hanging', () => {
        assert.ok(floodErr, 'callTool("flood") resolved - it should have been rejected');
      });
    } finally {
      client.close();
    }
  }

  // ── L3: server - an oversized declared CL request is refused, the session survives ──────────
  {
    const gw = spawnGateway();
    try {
      const init = await gw.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'framing-limits.test.js', version: '0.0.0' },
      });
      assert.ok(init && init.result, 'baseline initialize failed');

      // Declared CL over the cap; the body is a VALID request (id 2) an uncapped server answers.
      const bigBody = JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: { pad: 'x'.repeat(OVERSIZE) },
      });
      gw.child.stdin.write(`Content-Length: ${Buffer.byteLength(bigBody, 'utf8')}\r\n\r\n`);
      gw.child.stdin.write(bigBody);
      await sleep(1200); // let the gateway read (and refuse or answer) the oversized message

      check('L3: the gateway refuses the over-cap message with a clean -32700', () => {
        const err = gw.lines.find((l) => l && l.error && l.error.code === -32700 &&
          /too large/i.test(String(l.error.message)));
        assert.ok(err, 'no -32700 "message too large" error was written; lines seen: ' +
          gw.lines.length);
      });
      check('L3: the oversized request id is NEVER answered', () => {
        const idTwo = gw.lines.find((l) => l && l.id === 2 && l.result);
        assert.strictEqual(idTwo, undefined, 'the gateway processed the over-cap message');
      });

      let after = null, afterErr = null;
      try { after = await gw.request('tools/list', {}); } catch (e) { afterErr = e; }
      check('L3: the session SURVIVES - a follow-up request is answered', () => {
        assert.ok(after, 'follow-up tools/list got no response: ' + (afterErr && afterErr.message));
        assert.ok(after.result && Array.isArray(after.result.tools), 'response had no tools[]');
      });
    } finally {
      try { gw.child.stdin.end(); } catch (_e) { /* ignore */ }
      setTimeout(() => {
        if (gw.getExitInfo() === null && gw.child.exitCode === null && !gw.child.killed) {
          try { gw.child.kill(); } catch (_e) { /* ignore */ }
        }
      }, 1500).unref();
    }
  }

  // ── L4: server - an unframeable flood ends the session instead of buffering toward OOM ──────
  {
    const gw = spawnGateway();
    try {
      const init = await gw.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'framing-limits.test.js', version: '0.0.0' },
      });
      assert.ok(init && init.result, 'baseline initialize failed');

      // Wait for the exit itself; the cap only bounds a real failure (a loaded CI box can take
      // several seconds to read 4 MiB and shut down).
      const floodAt = Date.now();
      gw.child.stdin.write('x'.repeat(OVERSIZE)); // no framing, no newline
      const outcome = await Promise.race([
        gw.exited,
        sleep(30000).then(() => null),
      ]);
      check('L4: the flooded session ENDS (process exits) instead of buffering toward OOM', () => {
        assert.ok(outcome, 'the gateway is still running ' + (Date.now() - floodAt) +
          ' ms after the flood, with the flood buffered');
      });
      check('L4: the refusal is announced with a clean -32700 before the session ends', () => {
        const err = gw.lines.find((l) => l && l.error && l.error.code === -32700 &&
          /too large/i.test(String(l.error.message)));
        assert.ok(err, 'no -32700 "message too large" error was written before exit');
      });
    } finally {
      if (gw.getExitInfo() === null && gw.child.exitCode === null && !gw.child.killed) {
        try { gw.child.kill(); } catch (_e) { /* ignore */ }
      }
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────────────────────────
  // ── L5: client - a reply whose body is EXACTLY the cap is delivered (boundary, not over) ──────
  // The buffer watchdog fired on `buf.length > cap` while a legal at-cap frame was still arriving
  // (header bytes + cap body > cap with no complete frame yet) and dropped the connection.
  {
    const client = new McpClient({ id: 'limits-at-cap', command: process.execPath, args: [FIXTURE], requestTimeoutMs: 1500, toolTimeoutMs: 8000 });
    try {
      await client.connect();
      let atCap = null, atCapErr = null;
      try { atCap = await client.callTool('sized', { bodyBytes: CAP }); } catch (e) { atCapErr = e; }
      check('L5: a reply whose body is EXACTLY the cap is delivered (the cap is inclusive)', () => {
        assert.ok(atCap, 'callTool("sized") rejected: ' + (atCapErr && atCapErr.message));
        const text = atCap.content && atCap.content[0] && atCap.content[0].text;
        assert.ok(typeof text === 'string' && text.length > CAP - 256, 'delivered text is ' + (text && text.length) + ' chars');
      });
      check('L5: the connection survives an at-cap reply', () => {
        assert.strictEqual(client.connected, true, 'client dropped the connection');
      });
    } finally {
      client.close();
    }
  }

  // ── L6: server - a request whose body is EXACTLY the cap is answered (boundary, not over) ─────
  {
    const gw = spawnGateway();
    try {
      const init = await gw.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'framing-limits.test.js', version: '0.0.0' } });
      assert.ok(init && init.result, 'baseline initialize failed');
      const mk = (pad) => JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: { pad } });
      const overhead = Buffer.byteLength(mk(''), 'utf8');
      const atCapBody = mk('x'.repeat(CAP - overhead));
      assert.strictEqual(Buffer.byteLength(atCapBody, 'utf8'), CAP, 'test bug: body is not exactly the cap');
      gw.child.stdin.write(`Content-Length: ${CAP}\r\n\r\n`);
      gw.child.stdin.write(atCapBody);
      const deadline = Date.now() + 8000;
      let answered = null;
      while (!answered && Date.now() < deadline && gw.getExitInfo() === null) {
        answered = gw.lines.find((l) => l && l.id === 7 && (l.result || l.error));
        if (!answered) await sleep(50);
      }
      check('L6: a request whose body is EXACTLY the cap is answered (session not ended)', () => {
        assert.strictEqual(gw.getExitInfo(), null, 'the gateway ENDED the session on a legal at-cap frame: ' + JSON.stringify(gw.getExitInfo()));
        assert.ok(answered && answered.result && Array.isArray(answered.result.tools), 'no result for id 7; last lines: ' + JSON.stringify(gw.lines.slice(-2)).slice(0, 300));
      });
    } finally {
      try { gw.child.stdin.end(); } catch (_e) { /* ignore */ }
      setTimeout(() => { if (gw.getExitInfo() === null && gw.child.exitCode === null && !gw.child.killed) { try { gw.child.kill(); } catch (_e) { /* ignore */ } } }, 500);
    }
  }

  for (const r of results) {
    console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  }
  const failed = results.filter((r) => !r.ok);
  const total = results.length;
  if (failed.length === 0 && total === 13) {
    console.log(`\nPASS: framing-limits - ${total}/13 assertions (4 MiB frame cap holds on both sides, inclusive; sessions survive refusals, floods are dropped)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: framing-limits - ${total - failed.length}/${total} assertions passed`);
    process.exit(1);
  }
})().catch((e) => {
  console.log('FRAMING-LIMITS TEST CRASHED: ' + ((e && e.stack) || e));
  process.exit(1);
});
