#!/usr/bin/env node
'use strict';

/**
 * gate-danger.js - a shippable PreToolUse gate for the "Danger Demo" tool.
 *
 * This is a worked example of how to gate a tool with ToolFunnel. Drop it into
 * `hooks/scripts/`, register the manifest entry from `manifest.snippet.json`, and the
 * gateway will route every `danger` call through it BEFORE the tool's side effect runs.
 *
 * Behaviour: deny unless the call passes `{ "confirm": true }` as its args. The denied
 * call never reaches the tool - `execute()` is not invoked, so `danger`'s only side effect
 * (appending a line to the file named by TOOLFUNNEL_DANGER_LOG) never happens. The proof
 * the gate held is the ABSENCE of that line.
 *
 * Contract (hook-runner.js, docs/hooks-and-gating.md): the runner pipes the PreToolUse
 * event JSON to this script's stdin, then reads the result. Two ways to deny - this example
 * uses the simplest:
 *
 *   - exit 2  -> BLOCK; stderr is the reason. (Used here.)
 *   - exit 0 + JSON on stdout with hookSpecificOutput.permissionDecision === "deny"
 *              -> BLOCK with a structured reason. (Shown commented below.)
 *
 * It FAILS CLOSED: an unparsable payload is treated as a denial. Node built-ins only.
 */

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  let event;
  try {
    event = JSON.parse(raw || '{}');
  } catch (_err) {
    process.stderr.write('gate-danger: unparsable event payload - denying.\n');
    process.exit(2); // fail closed
  }

  const args = (event && event.tool_input) || {};

  if (args.confirm === true) {
    process.exit(0); // ALLOW - execute() will run
  }

  // DENY - execute() is NEVER called.
  process.stderr.write('Danger Demo is gated: pass { "confirm": true } to proceed.\n');
  process.exit(2);

  // ── Alternative: the JSON protocol (protocol B), honoured ONLY on exit 0. Use this when
  // you want a structured reason instead of plain stderr. Replace the two lines above with:
  //
  //   process.stdout.write(JSON.stringify({
  //     hookSpecificOutput: {
  //       hookEventName: 'PreToolUse',
  //       permissionDecision: 'deny',
  //       permissionDecisionReason: 'Danger Demo requires { confirm: true }.'
  //     }
  //   }) + '\n');
  //   process.exit(0);
});
