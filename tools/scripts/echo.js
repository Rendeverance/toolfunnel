#!/usr/bin/env node
'use strict';

/**
 * echo-tool.js — a safe local demo tool.
 *
 * Prints a JSON object of the args it was invoked with, then exits 0.
 * It has NO side effects: it touches no filesystem, no network, no env-driven
 * writes. It exists so the register / run-path / gate tests have a benign tool
 * to exercise (the "allowed" counterpart to danger-tool.js).
 *
 * Args are read two ways so callers can use whichever is convenient:
 *   1. process.argv         — positional CLI args, e.g. `node echo-tool.js a b c`
 *   2. TOOLFUNNEL_TOOL_ARGS — a JSON-encoded object/array of structured args
 *      (this is how the register's "script" invoke passes `args` through).
 *
 * Output (stdout): a single JSON object { ok, args, argv }.
 */

function parseStructuredArgs() {
  const raw = process.env.TOOLFUNNEL_TOOL_ARGS;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_err) {
    // Malformed env — surface it rather than silently dropping.
    return { _parseError: `TOOLFUNNEL_TOOL_ARGS was not valid JSON: ${raw}` };
  }
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseStructuredArgs();
  const payload = { ok: true, args, argv };
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(0);
}

main();
