#!/usr/bin/env node
'use strict';

/**
 * EXAMPLE PostToolUse observer - DISABLED by default.
 *
 * PostToolUse is ADVISORY: it runs AFTER a tool has executed and CANNOT un-run it - it observes the
 * outcome. The lifecycle event (including the tool result) arrives as JSON on stdin. This stub just
 * exits 0 (a clean pass). Replace the body to forward results to your own audit sink, metrics, an
 * external SIEM, etc. Exit 0 = observed; a non-zero exit on PostToolUse is a non-blocking error.
 *
 * Zero dependencies - Node built-ins only.
 */

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  // let ev = JSON.parse(raw || '{}');  // { tool_name, tool_input, tool_response, ... }
  // ... forward ev to your audit sink here ...
  process.exit(0);
});
