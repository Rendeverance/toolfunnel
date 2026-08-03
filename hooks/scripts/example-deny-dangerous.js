#!/usr/bin/env node
'use strict';

/**
 * EXAMPLE PreToolUse gate - DISABLED by default (enable it in hooks/hooks.manifest.json, or via the
 * UI Hooks tab / the per-tool "Pre" toggle on the Tools tab).
 *
 * This is the shape of a real policy gate: it runs INSIDE the gateway, BEFORE a tool executes, and
 * `process.exit(2)` DENIES the call. The lifecycle event arrives as JSON on stdin; here we block any
 * call whose arguments contain an obviously-destructive shell pattern.
 *
 * Block protocol (the simple one): write the reason to stderr and `process.exit(2)`. (A richer JSON
 * protocol is also supported - see docs/MANUAL.pdf section 10.) Exit 0 = allow.
 *
 * EXIT 2, NOT "non-zero" - the difference matters when you write your own. Every OTHER exit (a
 * crash, a syntax error, a missing file, a timeout) is a NON-BLOCKING ERROR and the call proceeds,
 * so `exit(1)` on an error path allows the very call you meant to stop. If your policy cannot
 * reach a decision, exit 2 deliberately. (The gateway does refuse a decision it cannot READ -
 * output past the cap, unparseable JSON - because an unreadable answer is not permission. It
 * cannot do the same for a script that never answered: one broken hook file would take every tool
 * offline.) test/gate-semantics.test.js pins all of this.
 *
 * Zero dependencies - Node built-ins only.
 */

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let ev = {};
  try { ev = JSON.parse(raw || '{}'); } catch (_e) { /* malformed payload -> allow (don't block on a parse error) */ }
  const args = JSON.stringify((ev && ev.tool_input) || {});
  // A small illustrative denylist: recursive-force delete, mkfs, drive format, fork bomb.
  const DANGER = /\brm\s+-[a-z]*r[a-z]*f|\bmkfs\b|\bformat\s+[a-z]:|:\(\)\s*\{\s*:/i;
  if (DANGER.test(args)) {
    process.stderr.write('example-deny-dangerous: blocked - the arguments contain a destructive pattern.\n');
    process.exit(2); // DENY - the gateway refuses to run the tool
  }
  process.exit(0); // allow
});
