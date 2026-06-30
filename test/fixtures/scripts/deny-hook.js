#!/usr/bin/env node
'use strict';

/**
 * deny-hook.js — TEST FIXTURE PreToolUse hook that ALWAYS denies.
 *
 * Used by test/gate.test.js to prove the gate (src/mcp/gated-run.js) blocks: when this
 * hook fires for a tool, gatedRun must return { blocked:true } and NEVER call execute().
 *
 * Contract (HOOK_ENGINE.md §3-B / src/core/hook-runner.js): the runner pipes the
 * PreToolUse event JSON to stdin, then reads the result. The JSON protocol is honoured
 * ONLY on exit 0, when stdout is a JSON object carrying a known key (here
 * `hookSpecificOutput`). `permissionDecision: "deny"` blocks; the reason is
 * `permissionDecisionReason`.
 *
 * It is UNCONDITIONAL by design (it denies regardless of args) — the fixture's whole job
 * is to make the gate bite so the test can assert the side effect never happened. It also
 * fails CLOSED: an unreadable/empty payload still denies. Node built-ins only; no deps.
 */

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  // We don't actually need to read the payload to deny, but parse it defensively so a
  // malformed payload is handled as a (still-denying) closed gate rather than a crash.
  try {
    JSON.parse(raw || '{}');
  } catch (_err) {
    // Fall through — we deny either way.
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'blocked by test',
      },
    }) + '\n'
  );
  process.exit(0); // JSON protocol is honoured ONLY on exit 0
});
