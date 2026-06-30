#!/usr/bin/env node
'use strict';

/**
 * danger-tool.js — a demo "dangerous" tool used to PROVE the gate works.
 *
 * The safety case is: `toolfunnel_run_tool` must route through the hook
 * engine's PreToolUse gate, and a DENY there must mean the tool's side effect
 * never happens.
 *
 * This tool's observable side effect is: it APPENDS one line to the file named
 * by the env var TOOLFUNNEL_DANGER_LOG. A test arranges a PreToolUse hook that
 * DENIES this tool, runs the gated path, and then asserts the log file was NOT
 * written (or did not gain a line). If the gate had failed open, the line would
 * appear.
 *
 * When it DOES run (gate allows, or run-direct), it:
 *   1. appends `<ISO timestamp> danger-tool fired <args>\n` to TOOLFUNNEL_DANGER_LOG
 *   2. prints a JSON confirmation to stdout
 *   3. exits 0
 *
 * If TOOLFUNNEL_DANGER_LOG is unset, it still "fires" (prints, exits 0) but
 * writes nothing — so it is never destructive on its own; the log is the only
 * effect and the caller chooses the path.
 */

const fs = require('node:fs');

function structuredArgs() {
  const raw = process.env.TOOLFUNNEL_TOOL_ARGS;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return { _parseError: raw };
  }
}

function main() {
  const logPath = process.env.TOOLFUNNEL_DANGER_LOG;
  const args = structuredArgs();
  const argv = process.argv.slice(2);
  let wrote = false;

  if (logPath) {
    const line =
      new Date().toISOString() +
      ' danger-tool fired ' +
      JSON.stringify({ args, argv }) +
      '\n';
    fs.appendFileSync(logPath, line, 'utf8');
    wrote = true;
  }

  process.stdout.write(
    JSON.stringify({ ok: true, fired: true, wrote, logPath: logPath || null }) + '\n'
  );
  process.exit(0);
}

main();
