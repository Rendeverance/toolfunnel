#!/usr/bin/env node
/**
 * respawn-buffer.test.js - an in-place respawn starts from a CLEAN read state.
 *
 * McpClient keeps three pieces of per-child read state: the stdout frame buffer (_buf), the
 * declared-bytes-still-to-discard counter for a refused over-cap message (_skipRemaining), and the
 * captured stderr (_stderr). All three are initialised in the constructor and then only ever
 * advanced by the reader. When a child dies mid-frame and the SAME instance respawns
 * (probeDiscover / connect on a nulled _child, the 0.7.0 in-place respawn path), whatever the
 * dead child left behind is prepended to the new child's first bytes:
 *
 *   - a half-arrived Content-Length header makes the drain hold ('wait') and then swallow the
 *     new child's first reply as the rest of the old body: the request times out;
 *   - a refused over-cap message's remaining count eats the new child's bytes outright;
 *   - the old child's stderr is reported as the new child's in every timeout / exit error.
 *
 * Unit-level: spawnImpl is injected with a fake child that answers server/discover, so no real
 * process is involved. The fake has NO numeric pid on purpose - _treeKill must never reach
 * taskkill/kill with a made-up pid.
 */
'use strict';

const path = require('node:path');
const assert = require('node:assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const { McpClient } = require(path.join(REPO_ROOT, 'src', 'mcp', 'mcp-client.js'));

// Above the client's read cap (4 MiB) so a declared body of this size is REFUSED and skipped.
const OVER_CAP_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 600; // short: a lost reply must fail the test quickly, not hang it

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

const { makeFakeChild } = require('./helpers/fake-stdio-child'); // the shared stdio child double

/** A client whose spawnImpl hands out fake children in order; each answers server/discover. */
function makeClient(label) {
  const spawned = [];
  const answerDiscover = (child, msg) => {
    if (msg && msg.method === 'server/discover' && msg.id !== undefined) {
      child.reply({ jsonrpc: '2.0', id: msg.id, result: { supportedVersions: ['2026-07-28'], serverInfo: { name: 'fake-' + child.label, version: '0' } } });
    }
  };
  const client = new McpClient({
    id: label,
    command: 'fake',
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    spawnImpl: () => {
      const c = makeFakeChild(label + '#' + (spawned.length + 1), answerDiscover);
      spawned.push(c);
      return c;
    },
  });
  return { client, spawned };
}

// The client's request timers are unref'd, so a swallowed reply must not let the process exit
// silently with code 0 before the checks run: hold the loop open until the last check.
const keepalive = setInterval(() => {}, 1000);

(async () => {
  // A - a half-arrived header frame from child #1 must not swallow child #2's first reply.
  {
    const { client, spawned } = makeClient('partial-frame');
    const first = await client.probeDiscover();
    check('A: child #1 answers the first probe (baseline)', () => {
      assert.strictEqual(first && first.serverInfo && first.serverInfo.name, 'fake-partial-frame#1');
    });
    spawned[0].raw('Content-Length: 5\r\n\r\nab'); // 2 of 5 declared body bytes, then death
    spawned[0].die();
    let second = null; let err = null;
    try { second = await client.probeDiscover(); } catch (e) { err = e; }
    check('A: after an in-place respawn, child #2\'s reply is parsed (stale partial frame discarded)', () => {
      assert.ok(!err, 'second probe failed: ' + (err && err.message));
      assert.strictEqual(second && second.serverInfo && second.serverInfo.name, 'fake-partial-frame#2');
      assert.strictEqual(spawned.length, 2, 'expected exactly two spawns, got ' + spawned.length);
    });
    client.close();
  }

  // B - a refused over-cap message's remaining skip count must not eat child #2's bytes.
  {
    const { client, spawned } = makeClient('skip-count');
    await client.probeDiscover();
    spawned[0].raw(`Content-Length: ${OVER_CAP_BYTES}\r\n\r\nxx`); // refused: skip armed, then death
    spawned[0].die();
    let second = null; let err = null;
    try { second = await client.probeDiscover(); } catch (e) { err = e; }
    check('B: after an in-place respawn, a pending over-cap skip does not consume child #2\'s reply', () => {
      assert.ok(!err, 'second probe failed: ' + (err && err.message));
      assert.strictEqual(second && second.serverInfo && second.serverInfo.name, 'fake-skip-count#2');
    });
    client.close();
  }

  // C - the dead child's stderr is not reported as the new child's.
  {
    const { client, spawned } = makeClient('stderr-carry');
    await client.probeDiscover();
    spawned[0].stderr.emit('data', Buffer.from('OLD-CHILD-STDERR-MARKER'));
    spawned[0].die();
    // Child #2 stays silent so the probe times out; the timeout error quotes "stderr so far".
    const silent = makeFakeChild('stderr-carry#2', () => {});
    client._spawn = () => { spawned.push(silent); return silent; };
    let err = null;
    try { await client.probeDiscover(); } catch (e) { err = e; }
    check('C: a timeout on child #2 does not quote child #1\'s stderr', () => {
      assert.ok(err, 'expected the silent child to time out');
      assert.ok(/timeout/.test(err.message), 'not a timeout error: ' + err.message);
      assert.ok(!err.message.includes('OLD-CHILD-STDERR-MARKER'), 'old stderr leaked into the new child\'s error: ' + err.message);
    });
    client.close();
  }

  // D - the dead child's stdio drains LATE (after the respawn): its bytes must be ignored, not
  //     appended to child #2's fresh state. Node fires 'exit' before stdio is done, so this is the
  //     ordinary shape, not an edge case. Child #2 answers after a short delay so the probe is
  //     still pending when the stale bytes arrive.
  {
    const { client, spawned } = makeClient('late-drain');
    await client.probeDiscover();
    const dead = spawned[0];
    dead.die();
    const origSpawn = client._spawn;
    client._spawn = (...a) => { const c = origSpawn(...a); const reply = c.reply; c.reply = (o) => setTimeout(() => reply(o), 30); return c; };
    const pending = client.probeDiscover(); // respawn happens here
    dead.stderr.emit('data', Buffer.from('LATE-OLD-STDERR'));
    dead.stdout.emit('data', Buffer.from('Content-Length: 5\r\n\r\nab'));
    let second = null; let err = null;
    try { second = await pending; } catch (e) { err = e; }
    check('D: stdout/stderr draining from the DEAD child after the respawn do not touch child #2', () => {
      assert.ok(!err, 'second probe failed: ' + (err && err.message));
      assert.strictEqual(second && second.serverInfo && second.serverInfo.name, 'fake-late-drain#2');
      assert.ok(!client._stderr.includes('LATE-OLD-STDERR'), 'stale stderr was appended: ' + client._stderr);
    });
    client.close();
  }

  // E - a LATE 'exit' from the dead child must not reject child #2's in-flight request.
  {
    const { client, spawned } = makeClient('late-exit');
    await client.probeDiscover();
    const dead = spawned[0];
    dead.die();
    const origSpawn = client._spawn;
    client._spawn = (...a) => { const c = origSpawn(...a); const reply = c.reply; c.reply = (o) => setTimeout(() => reply(o), 30); return c; };
    const pending = client.probeDiscover();
    dead.emit('exit', 0, null); // a second, late exit event from the same dead child
    let second = null; let err = null;
    try { second = await pending; } catch (e) { err = e; }
    check('E: a late exit event from the DEAD child does not reject child #2\'s pending request', () => {
      assert.ok(!err, 'second probe failed: ' + (err && err.message));
      assert.strictEqual(second && second.serverInfo && second.serverInfo.name, 'fake-late-exit#2');
    });
    client.close();
  }

  clearInterval(keepalive);
  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  const expected = 6;
  if (passed === results.length && results.length === expected) {
    console.log(`\nPASS: respawn-buffer test - ${passed}/${expected} assertions passed (clean read state across an in-place respawn)`);
    process.exit(0);
  }
  console.log(`\nFAIL: respawn-buffer test - ${passed}/${results.length} assertions passed`);
  process.exit(1);
})().catch((e) => { console.log('RESPAWN-BUFFER TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(1); });
