'use strict';

/**
 * run-all.js — the zero-dependency test runner wired to `npm test`.
 *
 * Runs each sibling test file as its OWN child process (`node <file>`), exactly as a human would
 * run them one at a time, and judges each purely by its EXIT CODE: 0 = pass, anything else = fail.
 *
 * IMPORTANT — run the suite with `node test/run-all.js` (or `npm test`), NEVER `node --test`. The
 * tests snapshot + mutate + restore the SHARED on-disk config (tools.register.json / tools.state.json
 * / expose.json / hooks.manifest.json); they are isolated only because this runner executes them
 * SEQUENTIALLY. `node --test` runs files concurrently and would race those files (corrupting the
 * register mid-run). Tests defend against a *leaked* fixture from a killed run (matrix.test.js strips
 * its baseline; mode.test.js tolerates a stray reference tool), but concurrent execution is unsupported.
 * That keeps the runner decoupled from how any individual test reports — a test owns its own
 * format and timeouts; this file only cares whether the process succeeded.
 *
 * Suite (run sequentially, in this order):
 *   - smoke.js        in-process smoke of buildProtocol()/handleMessage()
 *   - stdio.test.js   real spawned-child stdio transport
 *   - http.test.js    real HTTP/SSE host on an ephemeral port
 *   - gate.test.js    the hook gate (PreToolUse block / PostToolUse advisory)
 *   - management.test.js  the management register functions, gated + snapshot/restore
 *   - mode.test.js    the per-tool execution mode (reference vs gateway resolution)
 *   - reference-gate.test.js  the reference-mode HANDOFF gate (PreToolUse deny gates instructions)
 *   - logging.test.js the toggleable JSONL activity log (enable/deny/disable + tf_log toggle)
 *   - proxy.test.js   attach + FORWARD a bundled upstream MCP; forwarded call passes the fail-closed gate
 *
 * Each child's stdout/stderr is streamed straight through (stdio: 'inherit') so you see live
 * output, then a compact summary table is printed at the end. A MISSING sibling file is reported
 * as a FAIL (with a clear "file not found" note) — it does NOT crash the runner. A wedged child is
 * bounded by a per-test timeout and reported as a (timeout) fail.
 *
 * Exit code: 0 iff every test passed; non-zero if ANY test failed or was missing.
 *
 * Node built-ins only (node:child_process, node:fs, node:path) — no npm deps, no SDK.
 *
 * Run:  node test/run-all.js     (a.k.a.  npm test)
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The suite, in run order. Resolved relative to this directory so cwd never matters.
const TEST_FILES = ['smoke.js', 'stdio.test.js', 'http.test.js', 'gate.test.js', 'management.test.js', 'mode.test.js', 'reference-gate.test.js', 'logging.test.js', 'proxy.test.js', 'reload.test.js', 'http-reload.test.js', 'lean-forward.test.js', 'reconnect.test.js', 'matrix.test.js', 'ui-matrix.test.js', 'hidden.test.js', 'auth.test.js', 'audit-log.test.js', 'tool-editor.test.js', 'install.test.js', 'spawn-shim.test.js', 'server-config.test.js', 'config-home.test.js', 'pack.test.js', 'integration-real-mcp.test.js', 'integration-http-client.test.js', 'release.test.js'];

// Per-test safety ceiling. Each test sets its own internal timeouts (the stdio test, e.g., caps the
// whole exchange at ~24s); this is the outer guard so a stuck child can never hang the whole run.
const PER_TEST_TIMEOUT_MS = 60000;

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Run one test file as `node <file>` and classify the outcome by exit code.
 * @param {string} file  bare filename (sibling of this script)
 * @returns {{file:string, ok:boolean, note:string}}
 */
function runOne(file) {
  const abs = path.join(__dirname, file);

  // A missing sibling is a FAIL, not a crash — report it and move on.
  if (!fs.existsSync(abs)) {
    return { file, ok: false, note: 'file not found' };
  }

  console.log('\n' + '─'.repeat(70));
  console.log('▶ running ' + file);
  console.log('─'.repeat(70));

  const result = spawnSync(process.execPath, [abs], {
    cwd: REPO_ROOT,
    stdio: 'inherit', // stream the child's output live
    timeout: PER_TEST_TIMEOUT_MS,
    windowsHide: true,
  });

  // spawnSync surfaces failure-to-launch and timeout via `error`; a clean exit gives `status`.
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      return { file, ok: false, note: 'timeout after ' + PER_TEST_TIMEOUT_MS + 'ms' };
    }
    return { file, ok: false, note: 'spawn error: ' + (result.error.message || String(result.error)) };
  }

  if (result.status === 0) {
    return { file, ok: true, note: 'exit 0' };
  }

  if (result.status === null) {
    // No status and no error → killed by a signal (e.g. the timeout SIGTERM).
    return { file, ok: false, note: 'killed by signal ' + (result.signal || 'unknown') };
  }

  return { file, ok: false, note: 'exit ' + result.status };
}

function main() {
  console.log('toolfunnel test suite — ' + TEST_FILES.length + ' tests, node ' + process.version);

  const results = TEST_FILES.map(runOne);

  // ── Summary ───────────────────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));

  const width = Math.max.apply(null, TEST_FILES.map((f) => f.length));
  for (const r of results) {
    const tag = r.ok ? 'PASS' : 'FAIL';
    console.log('  ' + tag + '  ' + r.file.padEnd(width) + '   (' + r.note + ')');
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;

  console.log('='.repeat(70));
  console.log(passed + '/' + results.length + ' passed' + (failed ? ', ' + failed + ' FAILED' : ''));

  process.exit(failed ? 1 : 0);
}

main();
