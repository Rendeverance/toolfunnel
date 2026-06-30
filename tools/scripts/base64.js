#!/usr/bin/env node
'use strict';

/**
 * base64-tool.js — a safe, dependency-free local Base64 codec tool.
 *
 * Purpose
 * -------
 * Encode UTF-8 text to standard Base64, or decode Base64 back to UTF-8 text.
 * A genuinely useful utility for the Tool Manager: inspecting / producing
 * Base64 blobs is a frequent chore and this gives a gated, no-side-effect way
 * to do it. Uses ONLY Node built-ins (Buffer) — no network, no filesystem.
 *
 * Contract with the register (the register's `defaultRunScript`)
 * ----------------------------------------------------------
 *   - Structured args arrive as JSON in env TOOLFUNNEL_TOOL_ARGS.
 *   - Args: { op: "encode" | "decode", text: <string> }.
 *   - Prints a SINGLE JSON object to stdout and exits 0 — ALWAYS exit 0, even
 *     on bad input. Bad input is reported as { ok:false, error } rather than a
 *     thrown exception, because the gated run-path treats exit-0-with-parseable
 *     stdout as a completed run.
 *
 * Output (stdout), exactly one JSON object:
 *   success: { ok:true,  op, result }
 *   failure: { ok:false, error }
 *
 * Notes on tolerance
 * ------------------
 *   - encode: any string is encodable. A non-string `text` is rejected.
 *   - decode: Node's Buffer.from(x,'base64') is itself lenient (it skips
 *     non-base64 chars), so to give callers a MEANINGFUL "bad base64" signal we
 *     validate the input shape first and round-trip-check the result. If the
 *     re-encoded form does not match a normalised version of the input, we
 *     report ok:false rather than silently returning garbage.
 *
 * Safety invariants (mirror the isolation rule):
 *   - NO filesystem, NO network, NO process mutation. Pure CPU on the args.
 *   - NEVER throws for ordinary bad input — only well-shaped JSON on stdout.
 */

/**
 * Parse the structured args handed in via env TOOLFUNNEL_TOOL_ARGS.
 * Returns the parsed value, or a sentinel describing a parse failure so the
 * caller can surface a clean { ok:false, error } instead of crashing.
 *
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
 * Decode tolerantly: validate that the input looks like Base64, decode it, and
 * round-trip-check so genuinely malformed input is reported rather than mangled.
 *
 * @param {string} text the candidate Base64 string
 * @returns {{ ok:true, result:string } | { ok:false, error:string }}
 */
function decodeTolerant(text) {
  // Strip surrounding whitespace; Base64 may legitimately contain internal
  // newlines (MIME wrapping), so remove all ASCII whitespace before validating.
  const stripped = String(text).replace(/\s+/g, '');
  if (stripped.length === 0) {
    // Empty input decodes to empty string — a valid, unambiguous result.
    return { ok: true, result: '' };
  }
  // Standard Base64 alphabet (with optional '=' padding). Reject anything else
  // up front so the caller gets a clear "bad base64" rather than silent garbage.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(stripped)) {
    return { ok: false, error: 'input is not valid Base64' };
  }
  // Length of a Base64 string (sans padding-trimming nuance) must be a multiple
  // of 4 once padding is included; reject obviously truncated input.
  if (stripped.length % 4 !== 0) {
    return { ok: false, error: 'input is not valid Base64 (bad length)' };
  }
  const buf = Buffer.from(stripped, 'base64');
  // Round-trip: re-encode and compare to the normalised input. Buffer's decoder
  // is lenient, so this catches inputs that "decode" but were never valid.
  const reencoded = buf.toString('base64');
  if (reencoded !== stripped) {
    return { ok: false, error: 'input is not valid Base64' };
  }
  return { ok: true, result: buf.toString('utf8') };
}

/**
 * Pure core: given the parsed args, produce the result object. Never throws.
 *
 * @param {any} args
 * @returns {object} the JSON-serialisable result
 */
function run(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'args must be an object { op, text }' };
  }
  const { op, text } = args;
  if (op !== 'encode' && op !== 'decode') {
    return { ok: false, error: 'op must be "encode" or "decode"' };
  }
  if (typeof text !== 'string') {
    return { ok: false, error: 'text must be a string' };
  }
  if (op === 'encode') {
    return { ok: true, op: 'encode', result: Buffer.from(text, 'utf8').toString('base64') };
  }
  // op === 'decode'
  const decoded = decodeTolerant(text);
  if (!decoded.ok) return { ok: false, error: decoded.error };
  return { ok: true, op: 'decode', result: decoded.result };
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
      // Defensive: run() is written not to throw, but never let an unexpected
      // error escape as a non-zero exit / unparseable stdout.
      payload = { ok: false, error: `unexpected error: ${(err && err.message) || String(err)}` };
    }
  }
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(0);
}

main();
