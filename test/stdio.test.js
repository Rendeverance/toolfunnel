'use strict';

/**
 * stdio.test.js - a REAL STDIO transport test for the gateway.
 *
 * Unlike smoke.js (which drives buildProtocol()/handleMessage() in-process), this test exercises
 * the actual wire: it SPAWNS the gateway as a child process exactly as a host would -
 *
 *     node <repo>/bin/toolfunnel.js          (no args = the stdio MCP server)
 *
 * - and talks to it over the child's stdin/stdout using the on-the-wire framing the server
 * documents:
 *   - WRITE: LSP-style `Content-Length: <n>\r\n\r\n<body>` framing (the server reads BOTH this and
 *     newline-delimited JSON; we use the header framing because that's the "real" MCP client wire).
 *   - READ : the server WRITES newline-delimited JSON, so we split stdout on '\n' and JSON.parse
 *     each complete line, matching responses back to requests by their JSON-RPC `id`.
 *
 * Sequence: (1) initialize, (2) tools/list, (3) tools/call { name:"toolfunnel_list_tools" }.
 *
 * Assertions:
 *   - initialize  -> result.serverInfo.name === "toolfunnel"
 *   - tools/list  -> includes toolfunnel_list_tools / _tool_instructions / _howto
 *   - list_tools  -> returns lean briefs that INCLUDE the 7 first-party demo tools (echo, base64,
 *                   hash, uuid, json, text-stats, danger). The register
 *                   also ships the management tools, so this is a presence/shape check, not an
 *                   exact-count check (the surface grows as tools are added).
 *
 * Teardown is windows-safe: the child is always killed on completion (success, failure, or
 * timeout), exactly once, and an exit listener confirms no zombie is left behind. Node built-ins
 * only (node:child_process, node:path, node:assert) - no npm deps, no SDK.
 *
 * Run:  node test/stdio.test.js     (exit 0 = pass, non-zero = fail)
 */

const path = require('node:path');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');

// The exact tool names tools/list must advertise (the lean meta-tools the model sees).
const REQUIRED_META_TOOLS = [
  'toolfunnel_list_tools',
  'toolfunnel_tool_instructions',
  'toolfunnel_howto',
];

// The 7 first-party demo tools the register ships (ids returned by toolfunnel_list_tools).
const EXPECTED_DEMO_IDS = [
  'echo',
  'base64',
  'hash',
  'uuid',
  'json',
  'text-stats',
  'danger',
];

const OVERALL_TIMEOUT_MS = 20000; // hard ceiling for the whole exchange
const REQUEST_TIMEOUT_MS = 10000; // per-request ceiling

// ── A tiny JSON-RPC-over-stdio client bound to a spawned child ────────────────────────────────
function makeClient(child) {
  let nextId = 1;
  let stdoutBuf = ''; // accumulates stdout; we split on '\n'
  let stderrBuf = ''; // captured for diagnostics on failure
  const pending = new Map(); // id -> { resolve, reject, timer }

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let nl;
    // Drain every COMPLETE newline-delimited JSON object currently buffered.
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line.length === 0) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_e) {
        // The server only writes JSON on stdout; a non-JSON line is unexpected - surface it.
        continue;
      }
      if (obj && Object.prototype.hasOwnProperty.call(obj, 'id') && pending.has(obj.id)) {
        const waiter = pending.get(obj.id);
        pending.delete(obj.id);
        clearTimeout(waiter.timer);
        waiter.resolve(obj);
      }
      // Anything without a matching pending id (e.g. a notification) is ignored.
    }
  });

  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk;
  });

  /** Send a JSON-RPC request with Content-Length framing; resolve with the matching response. */
  function request(method, params) {
    const id = nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    const byteLen = Buffer.byteLength(body, 'utf8');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for response to "${method}" (id ${id})`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      // LSP-style header + CRLFCRLF + body, written as one chunk.
      child.stdin.write(`Content-Length: ${byteLen}\r\n\r\n${body}`);
    });
  }

  function rejectAllPending(err) {
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    pending.clear();
  }

  return {
    request,
    rejectAllPending,
    getStderr: () => stderrBuf,
  };
}

(async () => {
  const results = []; // { name, ok, detail }
  const record = (name, fn) => {
    try {
      fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, detail: (err && err.message) || String(err) });
    }
  };

  // Spawn the gateway exactly as a host would: `node bin/toolfunnel.js` with NO args = stdio mode.
  const child = spawn(process.execPath, [ENTRY], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let killed = false;
  let exitInfo = null; // { code, signal } once the child exits

  // Idempotent, windows-safe teardown. child.kill() maps to TerminateProcess on Windows; we guard
  // so it's only attempted once and only while the child is still alive.
  function teardown() {
    if (killed) return;
    killed = true;
    try {
      child.stdin.end();
    } catch (_e) {
      /* ignore */
    }
    if (exitInfo === null && child.exitCode === null && !child.killed) {
      try {
        child.kill();
      } catch (_e) {
        /* ignore */
      }
    }
  }

  // Resolves once the child has fully exited - lets us confirm "no zombie left behind".
  const childExited = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      resolve(exitInfo);
    });
  });

  const client = makeClient(child);

  // A spawn-level failure (e.g. bad path) must fail loud, not hang.
  child.on('error', (err) => {
    client.rejectAllPending(new Error('child process error: ' + ((err && err.message) || String(err))));
  });

  // Global watchdog: if the whole exchange wedges, tear down and fail rather than hang forever.
  const overallTimer = setTimeout(() => {
    client.rejectAllPending(new Error('overall test timeout'));
    teardown();
  }, OVERALL_TIMEOUT_MS);
  overallTimer.unref(); // never let the watchdog itself keep the loop alive

  let fatal = null;
  try {
    // (1) initialize
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'stdio.test.js', version: '0.0.0' },
    });
    record('initialize -> result.serverInfo.name === "toolfunnel"', () => {
      assert.ok(init && init.result, 'initialize returned no result');
      assert.ok(init.result.serverInfo, 'initialize result missing serverInfo');
      assert.strictEqual(
        init.result.serverInfo.name,
        'toolfunnel',
        'serverInfo.name was ' + JSON.stringify(init.result.serverInfo.name)
      );
    });

    // (2) tools/list
    const listResp = await client.request('tools/list', {});
    const tools = (listResp && listResp.result && listResp.result.tools) || [];
    const toolNames = tools.map((t) => t && t.name);
    record('tools/list advertises the lean meta-tools', () => {
      for (const meta of REQUIRED_META_TOOLS) {
        assert.ok(
          toolNames.includes(meta),
          'tools/list missing "' + meta + '"; got: ' + JSON.stringify(toolNames)
        );
      }
    });

    // (3) tools/call { name: "toolfunnel_list_tools" }
    const callResp = await client.request('tools/call', {
      name: 'toolfunnel_list_tools',
      arguments: {},
    });
    record('toolfunnel_list_tools returns lean briefs including the 7 demo tools', () => {
      assert.ok(callResp && callResp.result, 'tools/call returned no result');
      assert.notStrictEqual(callResp.result.isError, true, 'tools/call reported isError');
      const content = callResp.result.content;
      assert.ok(Array.isArray(content) && content[0] && typeof content[0].text === 'string',
        'tools/call result missing content[0].text');
      let briefs;
      try {
        briefs = JSON.parse(content[0].text);
      } catch (e) {
        throw new Error('content[0].text was not JSON: ' + content[0].text.slice(0, 200));
      }
      assert.ok(Array.isArray(briefs), 'briefs payload was not an array');
      // Presence/shape check, not an exact count: the register ships the 7 demo tools PLUS the
      // management tools, and the surface grows as tools are added.
      assert.ok(briefs.length >= EXPECTED_DEMO_IDS.length,
        'expected at least ' + EXPECTED_DEMO_IDS.length + ' briefs, got ' + briefs.length);
      const ids = briefs.map((b) => b && b.id);
      for (const expected of EXPECTED_DEMO_IDS) {
        assert.ok(ids.includes(expected), 'briefs missing tool "' + expected + '"; got: ' + JSON.stringify(ids));
      }
      // Each brief is a lean { id, name, summary, category } shape.
      for (const b of briefs) {
        assert.ok(b && typeof b.id === 'string' && typeof b.name === 'string',
          'a brief was malformed: ' + JSON.stringify(b));
      }
    });
  } catch (err) {
    fatal = err;
  } finally {
    clearTimeout(overallTimer);
    teardown();
  }

  // Confirm clean child teardown - wait for the exit event (no zombie). Bounded so a stubborn
  // child can't hang the test; on Windows kill() should terminate promptly.
  await Promise.race([
    childExited,
    new Promise((resolve) => setTimeout(resolve, 4000).unref()),
  ]);

  // ── Report ──────────────────────────────────────────────────────────────────────────────────
  for (const r of results) {
    console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  }

  const passed = results.filter((r) => r.ok).length;
  const failedAssertions = results.filter((r) => !r.ok);
  const ok = !fatal && failedAssertions.length === 0 && results.length === 3;

  if (fatal) {
    console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));
  }
  if (!ok) {
    const stderr = client.getStderr().trim();
    if (stderr) console.log('\n--- child stderr ---\n' + stderr);
  }
  console.log(
    'child exit: ' +
      (exitInfo ? `code=${exitInfo.code} signal=${exitInfo.signal}` : 'still running (killed=' + killed + ')')
  );

  if (ok) {
    console.log(`\nPASS: stdio transport test - ${passed}/3 assertions passed (initialize, tools/list, list_tools over real spawned child)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: stdio transport test - ${passed}/${results.length || 3} assertions passed`);
    process.exit(1);
  }
})().catch((e) => {
  console.log('STDIO TEST CRASHED: ' + ((e && e.stack) || e));
  process.exit(1);
});
