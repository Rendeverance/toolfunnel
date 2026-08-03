'use strict';

/**
 * batch-bounds.test.js - the two batch-admission holes (0.7.0 defects #5 and #6), plus the local
 * executors' new clock (#4) at the unit seam.
 *
 *   #5 ERA MIXING. The HTTP batch branch runs BEFORE `bodyIsModern` is computed, so a modern-shaped
 *      body wrapped in a one-element array skipped validateModernHeaders, the Mcp-Param cross-check
 *      and the disconnect-cancel accounting - while handleMessage still re-detected the era from
 *      the body and served full modern semantics. Measured on 0.7.0: the SAME object returned 400
 *      -32020 ("MCP-Protocol-Version header is required") alone, and HTTP 200 with a modern
 *      `resultType` inside an array. Batching exists only in 2025-03-26, which predates the modern
 *      era, so a modern member is simply illegal.
 *   #6 NO MEMBER CAP. Members execute sequentially and any member may be a gated tools/call, so one
 *      4 MiB POST bought tens of thousands of gated invocations (each spawning hook + tool
 *      children). Measured: 5000 members answered in 406 ms.
 *   #4 LOCAL CLOCK. Both local executors settled only on child close, with no timer - so one
 *      hanging local tool wedged the serialised stdio chain (a 40 s tool left a later `ping`
 *      unanswered 12 s+).
 *
 * Enforcement lives in server.handleBatch so BOTH transports inherit one rule; asserted here
 * directly at that seam (no sockets, no spawns) which keeps it identical on Windows, macOS and
 * Linux. Exit 0 = bounded and era-clean; 1 = a shipped hole. CommonJS, Node built-ins only.
 */

const path = require('node:path');

const serverModule = require('../src/mcp/server.js');
const { handleBatch } = serverModule;
const registryModule = require('../src/tools/registry.js');

let fails = 0;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

// The smallest build handleBatch will accept: it only needs to reach the admission checks, which
// run before any member is dispatched.
const build = { protocol: { handle: async () => null } };

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'batch-bounds', version: '0' },
};

(async () => {
  // ── #5: a modern member is refused, and the refusal is a JSON-RPC error not a served result ──
  {
    const modernMember = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: MODERN_META } };
    const r = await handleBatch(build, [modernMember], 'test');
    const isErr = r && !Array.isArray(r) && r.error && r.error.code === -32600;
    check('a MODERN-shaped batch member is REFUSED (-32600), never served header-less',
      !!isErr && /modern/i.test(String(r.error.message)),
      JSON.stringify(r).slice(0, 240) + ' (0.7.0 served it with full modern semantics, skipping every header MUST)');
  }

  // ── #5b: a mixed batch is refused too - one modern member invalidates the array ──────────────────
  {
    const legacy = { jsonrpc: '2.0', id: 1, method: 'ping', params: {} };
    const modernMember = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: MODERN_META } };
    const r = await handleBatch(build, [legacy, modernMember], 'test');
    check('a MIXED batch (legacy + modern member) is refused',
      !!(r && !Array.isArray(r) && r.error && r.error.code === -32600), JSON.stringify(r).slice(0, 200));
  }

  // ── #6: the member cap ──────────────────────────────────────────────────────────────────────
  {
    const many = Array.from({ length: 65 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'ping', params: {} }));
    const r = await handleBatch(build, many, 'test');
    check('a batch over the 64-member cap is REFUSED (-32600) before any member runs',
      !!(r && !Array.isArray(r) && r.error && r.error.code === -32600 && /too large/i.test(String(r.error.message))),
      JSON.stringify(r).slice(0, 220) + ' (0.7.0: 5000 members executed sequentially, one POST)');

    const huge = Array.from({ length: 5000 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'ping', params: {} }));
    const r2 = await handleBatch(build, huge, 'test');
    check('the extreme 5000-member case is refused',
      !!(r2 && !Array.isArray(r2) && r2.error && r2.error.code === -32600), JSON.stringify(r2).slice(0, 160));
  }

  // ── REGRESSION: a legal batch AT the cap still works, and an empty batch keeps its shape ─────
  {
    const atCap = Array.from({ length: 64 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'ping', params: {} }));
    const r = await handleBatch(build, atCap, 'test');
    check('a legal 64-member batch is still ADMITTED (the cap is inclusive)',
      Array.isArray(r) || r === null, JSON.stringify(r).slice(0, 140));

    const empty = await handleBatch(build, [], 'test');
    check('an EMPTY batch keeps its frozen -32600 shape',
      !!(empty && empty.error && empty.error.code === -32600 && /empty/i.test(String(empty.error.message))),
      JSON.stringify(empty).slice(0, 160));

    const notif = await handleBatch(build, [{ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }], 'test');
    check('a notification-only batch still answers nothing (202 path)', notif === null, JSON.stringify(notif));
  }

  // ── #4: the local executors carry a clock and an output ceiling - proven by BEHAVIOUR ────────
  // The first version of these checks grepped the source for identifier names, which passes with
  // an empty timer callback or an unused constant. The executors read their windows
  // from env at module load (a documented test seam), so each probe runs defaultRunScript in a
  // FRESH child process with a tiny window and asserts what actually happened. The shell executor
  // in mcp/server.js is the same pattern with the same seam (TOOLFUNNEL_SHELL_TIMEOUT_MS); it is
  // exercised end-to-end by the register/matrix tests, and its clock is byte-for-byte the twin
  // asserted here.
  {
    const os = require('node:os');
    const fsx = require('node:fs');
    const { execFileSync } = require('node:child_process');
    const probeRoot = fsx.mkdtempSync(path.join(os.tmpdir(), 'tf-exec-probe-'));
    fsx.writeFileSync(path.join(probeRoot, 'sleeper.js'),
      'setTimeout(() => {}, 5000);\n'); // outlives a 400 ms window by design
    fsx.writeFileSync(path.join(probeRoot, 'flooder.js'),
      'const s = "x".repeat(8192);\nfor (let i = 0; i < 100; i++) process.stdout.write(s);\n');
    const probe = (script, env) => JSON.parse(execFileSync(process.execPath, ['-e', `
      const { defaultRunScript } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'tools', 'registry.js'))});
      defaultRunScript(${JSON.stringify(probeRoot)}, { path: ${JSON.stringify(script)} }, null)
        .then((r) => { console.log(JSON.stringify({ timedOut: !!r.timedOut, outputCapped: !!r.outputCapped, stdoutLen: r.stdout.length })); })
        .catch((e) => { console.log(JSON.stringify({ crashed: String(e) })); });
    `], { env: { ...process.env, ...env }, timeout: 30000, encoding: 'utf8' }).trim());

    const started = Date.now();
    const slow = probe('sleeper.js', { TOOLFUNNEL_TOOL_TIMEOUT_MS: '400' });
    const took = Date.now() - started;
    check('the SCRIPT executor really times out (400ms window, 5s tool, resolved early)',
      slow.timedOut === true && took < 4500, JSON.stringify({ slow, took }));

    const flooded = probe('flooder.js', { TOOLFUNNEL_TOOL_OUTPUT_CAP: '50000' });
    check('the SCRIPT executor really caps its output (800KB tool, 50KB cap)',
      flooded.outputCapped === true && flooded.stdoutLen < 200000, JSON.stringify(flooded));

    try { fsx.rmSync(probeRoot, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }

  void registryModule;
  console.log(fails ? `\n${fails} batch-bounds failure(s).` : '\nbatches are era-clean and capped; local executors are timed.');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(1); });
