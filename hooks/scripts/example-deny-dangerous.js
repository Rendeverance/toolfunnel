#!/usr/bin/env node
'use strict';

/**
 * EXAMPLE PreToolUse gate - DISABLED by default (enable it in hooks/hooks.manifest.json, or via the
 * UI Hooks tab / the per-tool "Pre" toggle on the Tools tab).
 *
 * This is the shape of a real policy gate: it runs INSIDE the gateway, BEFORE a tool executes, and a
 * non-zero exit DENIES the call (the gate fails closed). The lifecycle event arrives as JSON on
 * stdin; here we block any call whose arguments contain an obviously-destructive shell pattern.
 *
 * Block protocol (the simple one): write the reason to stderr and `process.exit(2)`. (A richer JSON
 * protocol is also supported - see docs/hooks-and-gating.md.) Exit 0 = allow.
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
