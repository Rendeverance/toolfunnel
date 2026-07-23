'use strict';

/**
 * wrap-wire.test.js - the passthrough wrap exercised at the REAL WIRE: a spawned gateway process,
 * newline-framed JSON-RPC over its actual stdio pipes, a live mock upstream underneath.
 *
 * Exists because the previous cancel test (R12) asserted behaviour the
 * wire could not produce - it hand-drove handleMessage concurrently, a concurrency the serialised
 * stdio loop forbade. Every assertion here rides the same transport a real client uses; nothing
 * is proven in-process.
 *
 * Covers:
 *   W1  cancel of an IN-FLIGHT forward reaches the upstream with the TRANSLATED id (F1 + N1)
 *   W2  cancel of a QUEUED request suppresses it: no reply, nothing forwarded upstream (F1)
 *   W3  tools/call _meta.progressToken forwarded; upstream progress relayed back w/ token (F5)
 *   W3b ...on a pipe whose initialize carried modern _meta - the era latch must not flip (F6)
 *   W4  serverInfo.title + tool title/annotations arrive VERBATIM through the wrap (wrap-lab)
 *   W5  direct resources/subscribe -> updated arrives; upstream CRASH -> auto-reconnect REPLAYS
 *       the subscribe (fresh process logs it) and updates resume (F3b)
 *   W6  upstream death under the wrap fires notifications/tools/list_changed (F2)
 *   W11 client identity mirroring: the wrapped upstream's clientInfo log shows the gateway's
 *       boot identity FIRST, then the real downstream client's - proving the provider chain
 *       AND the inline reconnect at initialize (two-way wrap invisibility, legacy/stdio clients)
 *
 * Exit code 0 on success; 1 with a FAIL line per failed assertion.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-wrapwire-'));
process.env.TOOLFUNNEL_HOME = HOME;
require('../src/core/config-home').initConfigHome({});

const REPO_ROOT = path.resolve(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const STATE_PATH = path.join(HOME, 'tools', 'tools.state.json');

// The bundled mock upstream, copied INSIDE the sandbox home (isolation guard).
const mockCopy = path.join(HOME, 'mcp', 'servers', 'mock-upstream', 'server.js');
fs.mkdirSync(path.dirname(mockCopy), { recursive: true });
fs.copyFileSync(path.join(REPO_ROOT, 'mcp', 'servers', 'mock-upstream', 'server.js'), mockCopy);
fs.writeFileSync(path.join(HOME, 'mcp', 'expose.json'), JSON.stringify({
  version: 1,
  upstreams: [{ id: 'oldmcp', transport: 'stdio', command: process.execPath, args: [mockCopy], enabled: true }],
  expose: [],
}, null, 2));

// Fixture logs - must be in the env BEFORE the gateway spawns (the mock child inherits it).
const CANCEL_LOG = path.join(HOME, 'cancel.log');
const SUB_LOG = path.join(HOME, 'sub.log');
const CLIENTINFO_LOG = path.join(HOME, 'clientinfo.log');

const { setPassthrough } = require('../src/tools/tool-state');
setPassthrough(STATE_PATH, 'oldmcp');

let fails = 0;
function check(label, cond, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond || detail === undefined ? '' : '  => ' + String(detail).slice(0, 300)));
  if (!cond) fails += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logLines = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch (_e) { return []; } };

(async () => {
  const env = Object.assign({}, process.env, {
    TOOLFUNNEL_HOME: HOME,
    TF_MOCK_CANCEL_LOG: CANCEL_LOG,
    TF_MOCK_SUB_LOG: SUB_LOG,
    TF_MOCK_CLIENTINFO_LOG: CLIENTINFO_LOG,
  });
  const child = spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
  let stderrBuf = '';
  child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

  // Minimal newline-framed client over the real pipes.
  let buf = '';
  const replies = new Map();   // id -> response message
  const notifications = [];
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch (_e) { continue; }
      if (m.id !== undefined && m.id !== null && m.method === undefined) replies.set(m.id, m);
      else if (m.method) notifications.push(m);
    }
  });
  const sendRaw = (s) => child.stdin.write(s);
  const send = (obj) => sendRaw(JSON.stringify(obj) + '\n');
  async function waitReply(id, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < (timeoutMs || 8000)) {
      if (replies.has(id)) return replies.get(id);
      await sleep(50);
    }
    return null;
  }

  try {
    // ── Handshake: DECORATED with the modern trio (the F6 latch fixture). initialize always
    //    selects legacy semantics; if the latch wrongly flipped, every raw notification below
    //    (progress, resources/updated, list_changed) would be silently dropped - so W3/W5/W6
    //    passing IS the F6 proof.
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wire-test', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
    } });
    const init = await waitReply(1, 15000);
    check('wire: wrapped initialize answers', !!(init && init.result), JSON.stringify(init));

    // ── W11: client identity mirroring - read the log NOW, before any further round-trip, so a
    //    regression to fire-and-forget mirroring cannot pass. Entry 1 is the gateway's BOOT
    //    connect (built-in identity - no toolfunnel.json in the sandbox); the initialize above
    //    carried clientInfo "wire-test", which differs -> the gateway must have reconnected the
    //    wrap INLINE, presenting the mirror, before answering.
    const ciEntries = logLines(CLIENTINFO_LOG).map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } });
    check('W11: boot connect presented the gateway\'s own identity',
      ciEntries.length >= 2 && !!ciEntries[0] && ciEntries[0].name === 'toolfunnel',
      'log=' + JSON.stringify(ciEntries));
    check('W11: initialize MIRRORED the real client upstream (inline reconnect)',
      ciEntries.length >= 2 && !!ciEntries[ciEntries.length - 1] &&
        ciEntries[ciEntries.length - 1].name === 'wire-test' &&
        ciEntries[ciEntries.length - 1].version === '1.0.0',
      'log=' + JSON.stringify(ciEntries));

    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // ── W4: identity + tool-def fidelity (the wrap-lab regressions, now fixture-pinned).
    check('W4: serverInfo.title VERBATIM through the wrap',
      !!(init && init.result && init.result.serverInfo && init.result.serverInfo.title === 'Mock Upstream Fixture'),
      JSON.stringify(init && init.result && init.result.serverInfo));
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const list = await waitReply(2);
    const add = list && list.result && list.result.tools && list.result.tools.find((t) => t.name === 'add');
    check('W4: tool title + annotations VERBATIM through the wrap',
      !!(add && add.title === 'Add Numbers' && add.annotations && add.annotations.readOnlyHint === true),
      JSON.stringify(add));

    // ── W1: cancel an IN-FLIGHT forward - the upstream must receive the TRANSLATED id.
    send({ jsonrpc: '2.0', id: 77, method: 'resources/read', params: { uri: 'mock://upstream/slow' } });
    await sleep(200); // the mock replies after 2s - the forward is genuinely outstanding
    send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 77 } });
    await sleep(700);
    const cancels = logLines(CANCEL_LOG);
    check('W1: cancel REACHED the upstream while the forward was in flight', cancels.length === 1, 'log=' + JSON.stringify(cancels));
    check('W1: ...with the TRANSLATED id, not the client\'s raw 77', cancels.length === 1 && cancels[0] !== '77', 'log=' + JSON.stringify(cancels));

    // ── W1b: cancel an IN-FLIGHT wrapped TOOLS/CALL - the dominant long-running-cancel case;
    //    the map hole: the tool path registered nothing, so
    //    every tools/call cancel was silently dropped while the tool ran on.
    //    Drain the chain first - W1's slow read still holds it, and a slowtool sent behind it
    //    would be QUEUED (pre-cancel territory), not in-flight (first run of this test proved
    //    exactly that: the pre-cancel suppressed it and the log stayed at one entry).
    await sleep(1600); // past the mock's 2s settle point - the chain is free, and absence is provable
    check('W1c: cancelled in-flight read gets NO response (spec)',
      !replies.has(77), JSON.stringify(replies.get(77)));
    send({ jsonrpc: '2.0', id: 95, method: 'tools/call', params: { name: 'slowtool', arguments: {} } });
    await sleep(300); // past the gate, into the 2s upstream execution
    send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 95 } });
    await sleep(700);
    const cancels2 = logLines(CANCEL_LOG);
    check('W1b: tools/call cancel REACHED the upstream, TRANSLATED (not raw 95)',
      cancels2.length === 2 && cancels2[1] !== '95' && /^[0-9]+$/.test(cancels2[1]),
      'log=' + JSON.stringify(cancels2));
    await sleep(1600); // past the slowtool's 2s settle so W2's timing is clean
    check('W1d: cancelled in-flight tools/call gets NO response (spec)',
      !replies.has(95), JSON.stringify(replies.get(95)));

    // ── W2: cancel a QUEUED request (same write, zero gap) - suppressed entirely.
    const before = logLines(CANCEL_LOG).length;
    sendRaw(JSON.stringify({ jsonrpc: '2.0', id: 88, method: 'resources/read', params: { uri: 'mock://upstream/slow' } }) + '\n' +
            JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 88 } }) + '\n');
    await sleep(2600); // past the mock's 2s reply point - absence is only proven beyond it
    check('W2: pre-cancelled request gets NO reply (spec: a cancelled request is never answered)',
      !replies.has(88), JSON.stringify(replies.get(88)));
    check('W2: nothing was forwarded upstream (no new cancel-log entry either - it was never sent)',
      logLines(CANCEL_LOG).length === before, 'log=' + JSON.stringify(logLines(CANCEL_LOG)));
    send({ jsonrpc: '2.0', id: 89, method: 'tools/call', params: { name: 'ping', arguments: {} } });
    const ping = await waitReply(89);
    check('W2: the pipe still serves normally afterwards', !!(ping && ping.result && !ping.result.isError), JSON.stringify(ping));

    // ── W3 (+W3b): progressToken forwarded on the wrapped tools/call; progress relayed back raw.
    const beforeNotes = notifications.length;
    send({ jsonrpc: '2.0', id: 90, method: 'tools/call', params: { name: 'prog', arguments: {}, _meta: { progressToken: 'tok-90' } } });
    const prog = await waitReply(90);
    check('W3: upstream SAW the progressToken (result says so)',
      !!(prog && prog.result && prog.result.content && /token seen/.test(prog.result.content[0].text)),
      JSON.stringify(prog && prog.result));
    await sleep(300);
    const progNotes = notifications.slice(beforeNotes).filter((n) =>
      n.method === 'notifications/progress' && n.params && n.params.progressToken === 'tok-90');
    check('W3: 2 progress notifications relayed back with the CLIENT\'s token', progNotes.length === 2,
      'saw ' + progNotes.length + ' of ' + notifications.slice(beforeNotes).map((n) => n.method).join(','));
    check('W3b: modern-decorated initialize did NOT flip the era latch (raw notifications still flow)',
      progNotes.length === 2);

    // ── W5: direct subscribe -> updated; crash -> reconnect REPLAYS the subscribe; updates resume.
    send({ jsonrpc: '2.0', id: 91, method: 'resources/subscribe', params: { uri: 'mock://upstream/readme' } });
    const subAck = await waitReply(91);
    check('W5: resources/subscribe acked through the wrap', !!(subAck && subAck.result && !subAck.error), JSON.stringify(subAck));
    await sleep(400);
    const updates1 = notifications.filter((n) => n.method === 'notifications/resources/updated');
    check('W5: resources/updated relayed back to the client', updates1.length >= 1,
      'methods=' + notifications.map((n) => n.method).join(','));
    check('W5: fresh mock logged the subscribe', logLines(SUB_LOG).length === 1, JSON.stringify(logLines(SUB_LOG)));

    // Crash the upstream. The call itself fails (neutral text - F9); the background reconnect
    // (1s backoff + spawn + handshake) must REPLAY the recorded subscription onto the fresh process.
    send({ jsonrpc: '2.0', id: 92, method: 'tools/call', params: { name: 'crash', arguments: {} } });
    const crash = await waitReply(92);
    check('W5: crash call fails NEUTRALLY (no internal strings, no surfaced name)',
      !!(crash && crash.result && crash.result.isError === true &&
         !/Aggregator|McpClient|ensureConnected|oldmcp/.test(JSON.stringify(crash.result))),
      JSON.stringify(crash && crash.result));
    let replayed = false;
    for (let i = 0; i < 40 && !replayed; i++) { await sleep(200); replayed = logLines(SUB_LOG).length >= 2; }
    check('W5: reconnect REPLAYED the subscribe (fresh process logged it)', replayed, JSON.stringify(logLines(SUB_LOG)));
    await sleep(400);
    const updates2 = notifications.filter((n) => n.method === 'notifications/resources/updated');
    check('W5: updates RESUME after the silent reconnect', updates2.length >= 2, 'total updated notes: ' + updates2.length);

    // ── W6: the death itself fired list_changed to the wrapped client (F2 - empty expose[]).
    const listChanged = notifications.filter((n) => n.method === 'notifications/tools/list_changed');
    check('W6: upstream death under the wrap fired notifications/tools/list_changed', listChanged.length >= 1,
      'methods seen: ' + Array.from(new Set(notifications.map((n) => n.method))).join(','));

    // ── W7: BRIDGE B - the full MRTR suspend/resume cycle at the wire. A MODERN tools/call hits
    //    the mock's eliciting tool; the upstream holds its call open and asks "Pick a colour";
    //    the gateway must SUSPEND (input_required + requestState), then the retry with the
    //    answer must resume the held call and deliver the final result built FROM the answer.
    //    (W5's crash killed the upstream; its reconnect already re-proved itself - wait for a
    //    live surface first.)
    let alive = null;
    for (let i = 0; i < 40 && !alive; i++) {
      await sleep(250);
      send({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name: 'ping', arguments: {} } });
      const r = await waitReply(100 + i, 3000);
      if (r && r.result && !r.result.isError) alive = r;
    }
    check('W7: upstream recovered for the bridge test', !!alive);
    const MODERN_META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
    send({ jsonrpc: '2.0', id: 200, method: 'tools/call', params: { name: 'elicit', arguments: {}, _meta: MODERN_META } });
    const suspended = await waitReply(200, 10000);
    const sr = (suspended && suspended.result) || {};
    const reqKey = sr.inputRequests ? Object.keys(sr.inputRequests)[0] : null;
    check('W7: modern call SUSPENDS - input_required + requestState + the question VERBATIM',
      sr.resultType === 'input_required' && typeof sr.requestState === 'string' && !!reqKey &&
      sr.inputRequests[reqKey].method === 'elicitation/create' &&
      sr.inputRequests[reqKey].params && sr.inputRequests[reqKey].params.message === 'Pick a colour' &&
      sr.inputRequests[reqKey].params.requestedSchema.required[0] === 'colour',
      JSON.stringify(sr).slice(0, 300));
    check('W7: bridge injected MRTR\'s required mode:"form" (the legacy upstream sent none)',
      sr.inputRequests && sr.inputRequests[reqKey] && sr.inputRequests[reqKey].params.mode === 'form',
      JSON.stringify(sr.inputRequests && sr.inputRequests[reqKey] && sr.inputRequests[reqKey].params).slice(0, 200));
    // The retry: same method, NEW id, inputResponses + the echoed requestState (top-level params).
    send({ jsonrpc: '2.0', id: 201, method: 'tools/call', params: {
      name: 'elicit', arguments: {}, _meta: MODERN_META,
      requestState: sr.requestState,
      inputResponses: { [reqKey]: { action: 'accept', content: { colour: 'blue' } } },
    } });
    const resumed = await waitReply(201, 10000);
    check('W7: retry RESUMES the held call - final result built from the answer',
      !!(resumed && resumed.result && resumed.result.content &&
         resumed.result.content[0].text === 'colour: blue' && resumed.result.isError !== true),
      JSON.stringify(resumed && resumed.result).slice(0, 200));
    check('W7: resumed result is modern-decorated complete (not input_required)',
      resumed && resumed.result && resumed.result.resultType === 'complete',
      JSON.stringify(resumed && resumed.result && resumed.result.resultType));

    // ── W8: a LEGACY caller cannot receive a backwards question - the bridge AUTO-DECLINES so
    //    the upstream's held call completes with its decline outcome (no hang, no protocol-alien
    //    result shape).
    send({ jsonrpc: '2.0', id: 210, method: 'tools/call', params: { name: 'elicit', arguments: {} } });
    const declined = await waitReply(210, 10000);
    check('W8: legacy caller gets the upstream\'s DECLINE outcome (auto-declined, no hang)',
      !!(declined && declined.result && declined.result.content &&
         declined.result.content[0].text === 'decline'),
      JSON.stringify(declined && declined.result).slice(0, 200));

    // ── W9: an unknown/expired requestState is a clean, neutral error - never a crash, never a
    //    zombie suspension.
    send({ jsonrpc: '2.0', id: 211, method: 'tools/call', params: {
      name: 'elicit', arguments: {}, _meta: MODERN_META,
      requestState: 'zz-not-a-real-token', inputResponses: { r0: { action: 'accept', content: { colour: 'red' } } },
    } });
    const badTok = await waitReply(211, 10000);
    check('W9: unknown requestState -> clean neutral error',
      !!(badTok && badTok.result && badTok.result.isError === true &&
         /unknown or expired requestState/.test(badTok.result.content[0].text)),
      JSON.stringify(badTok && badTok.result).slice(0, 200));

    // ── W10: tokens are SINGLE-USE - replaying W7's claimed token gets the same neutral error
    //    (delete-on-claim; a replay must never re-answer the upstream or return stale results).
    send({ jsonrpc: '2.0', id: 212, method: 'tools/call', params: {
      name: 'elicit', arguments: {}, _meta: MODERN_META,
      requestState: sr.requestState,
      inputResponses: { [reqKey]: { action: 'accept', content: { colour: 'green' } } },
    } });
    const replay = await waitReply(212, 10000);
    check('W10: replaying a claimed token -> unknown/expired (single-use, no double-answer)',
      !!(replay && replay.result && replay.result.isError === true &&
         /unknown or expired requestState/.test(replay.result.content[0].text)),
      JSON.stringify(replay && replay.result).slice(0, 200));
  } finally {
    try { child.stdin.end(); } catch (_e) {}
    await sleep(300);
    try { child.kill(); } catch (_e) {}
    if (process.platform === 'win32' && child.pid) {
      try { require('node:child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000 }); } catch (_e) {}
    }
    setPassthrough(STATE_PATH, null);
  }

  console.log(fails === 0 ? 'PASS: wrap-wire test - all assertions passed' : 'FAIL: ' + fails + ' wire assertion(s) failed');
  if (stderrBuf && fails > 0) console.log('--- gateway stderr ---\n' + stderrBuf.slice(-2000));
  process.exit(fails > 0 ? 1 : 0);
})().catch((err) => { console.error('CRASH:', err); process.exit(2); });
