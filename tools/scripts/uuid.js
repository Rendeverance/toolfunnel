#!/usr/bin/env node
'use strict';

/**
 * uuid-tool.js - a safe, dependency-free local UUID generator.
 *
 * Purpose
 * -------
 * Generate one or more RFC 4122 v4 UUIDs via the Node built-in
 * `node:crypto.randomUUID()`. Useful from the Tool Manager whenever a fresh
 * identifier is needed. No network, no filesystem, no new deps.
 *
 * Contract with the register (the register's `defaultRunScript`)
 * ----------------------------------------------------------
 *   - Structured args arrive as JSON in env TOOLFUNNEL_TOOL_ARGS.
 *   - Args: { count?: <integer> } - how many UUIDs to mint. Defaults to 1.
 *     count is clamped to the range [1, 100] so a runaway request cannot ask
 *     for an unbounded number.
 *   - Prints a SINGLE JSON object to stdout and exits 0 - ALWAYS exit 0, even
 *     on bad input (reported as { ok:false, error }), never a thrown exception.
 *
 * Output (stdout), exactly one JSON object:
 *   success: { ok:true,  uuids: [ "...", ... ] }
 *   failure: { ok:false, error }
 *
 * Safety invariants (mirror the isolation rule):
 *   - NO filesystem, NO network, NO process mutation. Pure CPU on the args.
 *   - count is hard-capped at 100; a non-integer / out-of-range count is an
 *     error rather than a silent surprise.
 *   - NEVER throws for ordinary bad input - only well-shaped JSON on stdout.
 */

const crypto = require('node:crypto');

const MAX_COUNT = 100;

/**
 * Parse the structured args handed in via env TOOLFUNNEL_TOOL_ARGS.
 * @returns {{ value: any } | { parseError: string }}
 */
function parseStructuredArgs() {
  const raw = process.env.TOOLFUNNEL_TOOL_ARGS;
  if (raw === undefined || raw === null || raw === '') {
    return { value: null };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch (_err) {
    return { parseError: `TOOLFUNNEL_TOOL_ARGS was not valid JSON: ${String(raw)}` };
  }
}

/**
 * Pure core: given the parsed args, produce the result object. Never throws.
 *
 * @param {any} args  may be null (treated as { count: 1 })
 * @returns {object} the JSON-serialisable result
 */
function run(args) {
  // No args (or null) is valid - default to a single UUID.
  let count = 1;
  if (args !== null && args !== undefined) {
    if (typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, error: 'args must be an object { count? }' };
    }
    if (args.count !== undefined && args.count !== null) {
      if (typeof args.count !== 'number' || !Number.isInteger(args.count)) {
        return { ok: false, error: 'count must be an integer' };
      }
      if (args.count < 1) {
        return { ok: false, error: 'count must be >= 1' };
      }
      if (args.count > MAX_COUNT) {
        return { ok: false, error: `count must be <= ${MAX_COUNT}` };
      }
      count = args.count;
    }
  }
  const uuids = [];
  for (let i = 0; i < count; i += 1) {
    uuids.push(crypto.randomUUID());
  }
  return { ok: true, uuids };
}

function main() {
  const parsed = parseStructuredArgs();
  let payload;
  if (parsed.parseError) {
    payload = { ok: false, error: parsed.parseError };
  } else {
    try {
      payload = run(parsed.value);
    } catch (err) {
      payload = { ok: false, error: `unexpected error: ${(err && err.message) || String(err)}` };
    }
  }
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(0);
}

main();
