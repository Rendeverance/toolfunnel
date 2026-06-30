#!/usr/bin/env node
'use strict';

/**
 * hash-tool.js — a safe, dependency-free local cryptographic-digest tool.
 *
 * Purpose
 * -------
 * Hash UTF-8 text with a chosen algorithm (sha256 default; sha1 / md5 also
 * offered) and return the lowercase hex digest. Useful from the Tool Manager
 * for checksums, fingerprinting, and quick integrity checks. Uses ONLY the
 * Node built-in `node:crypto` — no network, no filesystem, no new deps.
 *
 * Contract with the register (the register's `defaultRunScript`)
 * ----------------------------------------------------------
 *   - Structured args arrive as JSON in env TOOLFUNNEL_TOOL_ARGS.
 *   - Args: { algo?: "sha256" | "sha1" | "md5", text: <string> }.
 *     `algo` defaults to "sha256" when omitted.
 *   - Prints a SINGLE JSON object to stdout and exits 0 — ALWAYS exit 0, even
 *     on bad input (reported as { ok:false, error }), never a thrown exception.
 *
 * Output (stdout), exactly one JSON object:
 *   success: { ok:true,  algo, hexdigest }
 *   failure: { ok:false, error }
 *
 * Safety invariants (mirror the isolation rule):
 *   - NO filesystem, NO network, NO process mutation. Pure CPU on the args.
 *   - Only an explicit allow-list of algorithms is accepted, so the tool can
 *     never be coaxed into an unexpected / unavailable OpenSSL algorithm name.
 *   - NEVER throws for ordinary bad input — only well-shaped JSON on stdout.
 */

const crypto = require('node:crypto');

/** Algorithms this tool will accept (the names the task specifies). */
const ALLOWED_ALGOS = new Set(['sha256', 'sha1', 'md5']);
const DEFAULT_ALGO = 'sha256';

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
 * @param {any} args
 * @returns {object} the JSON-serialisable result
 */
function run(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'args must be an object { algo?, text }' };
  }
  const { text } = args;
  const algo = args.algo === undefined || args.algo === null ? DEFAULT_ALGO : args.algo;
  if (typeof algo !== 'string' || !ALLOWED_ALGOS.has(algo)) {
    return { ok: false, error: `algo must be one of ${[...ALLOWED_ALGOS].join(', ')}` };
  }
  if (typeof text !== 'string') {
    return { ok: false, error: 'text must be a string' };
  }
  // createHash can throw only for an unavailable algorithm; the allow-list above
  // covers the universally-available ones, but wrap defensively just in case a
  // hardened OpenSSL build (e.g. FIPS) disables md5/sha1.
  let hexdigest;
  try {
    hexdigest = crypto.createHash(algo).update(text, 'utf8').digest('hex');
  } catch (err) {
    return { ok: false, error: `hash failed for algo "${algo}": ${(err && err.message) || String(err)}` };
  }
  return { ok: true, algo, hexdigest };
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
