#!/usr/bin/env node
'use strict';
// deny-cleanup.js - a PreToolUse policy hook: DENY the destructive tool, with a reason.
// Reads the hook payload from stdin (unused here - this policy is unconditional) and
// answers with the JSON hook protocol on exit 0.
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'policy: destructive cleanup is not allowed from this pack',
    },
  }) + '\n');
  process.exit(0);
});
