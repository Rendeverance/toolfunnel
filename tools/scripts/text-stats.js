#!/usr/bin/env node
'use strict';

/**
 * text-stats.js - a safe, dependency-free local text-statistics tool.
 *
 * Purpose
 * -------
 * Count characters, words, lines, and UTF-8 bytes for a string. A handy
 * Tool-Manager utility for sizing prompts, snippets, and payloads. Pure
 * string work - no network, no filesystem, no new deps.
 *
 * Contract with the register (the register's `defaultRunScript`)
 * ----------------------------------------------------------
 *   - Structured args arrive as JSON in env TOOLFUNNEL_TOOL_ARGS.
 *   - Args: { text: <string> }.
 *   - Prints a SINGLE JSON object to stdout and exits 0 - ALWAYS exit 0, even
 *     on bad input (reported as { ok:false, error }), never a thrown exception.
 *
 * Output (stdout), exactly one JSON object:
 *   success: { ok:true, chars, words, lines, bytes }
 *   failure: { ok:false, error }
 *
 * Counting conventions (documented so callers know exactly what they get):
 *   - chars : JS string length (UTF-16 code units - the same number `"".length`
 *             reports). Documented as such; for ASCII text it equals the visible
 *             character count.
 *   - words : maximal runs of non-whitespace separated by whitespace. The empty
 *             / all-whitespace string has 0 words.
 *   - lines : number of lines. The empty string is 0 lines; otherwise it is the
 *             count of newline-separated segments (a trailing newline does NOT
 *             add a phantom empty final line - `"a\n"` is 1 line, `"a\nb"` is 2).
 *   - bytes : UTF-8 byte length (Buffer.byteLength), the on-the-wire size.
 *
 * Safety invariants (mirror the isolation rule):
 *   - NO filesystem, NO network, NO process mutation. Pure CPU on the args.
 *   - NEVER throws for ordinary bad input - only well-shaped JSON on stdout.
 */

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
 * Count lines per the documented convention: 0 for the empty string, else the
 * number of newline-separated segments WITHOUT counting a phantom trailing
 * empty line. We normalise CRLF/CR to LF first so line counts match what a user
 * sees regardless of the platform that produced the text.
 *
 * @param {string} text
 * @returns {number}
 */
function countLines(text) {
  if (text.length === 0) return 0;
  const normalised = text.replace(/\r\n?/g, '\n');
  // Trailing newline should not add an empty line: trim a single trailing '\n'
  // before splitting, then add 1 for the final (now-unterminated) line.
  const trimmed = normalised.endsWith('\n') ? normalised.slice(0, -1) : normalised;
  // Each '\n' in `trimmed` separates two lines -> lines = (#newlines) + 1.
  let newlines = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed.charCodeAt(i) === 10) newlines += 1;
  }
  return newlines + 1;
}

/**
 * Count words: maximal non-whitespace runs. Empty / whitespace-only -> 0.
 *
 * @param {string} text
 * @returns {number}
 */
function countWords(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  // Split on any whitespace run; the trim above guarantees no empty edge tokens.
  return trimmed.split(/\s+/).length;
}

/**
 * Pure core: given the parsed args, produce the result object. Never throws.
 *
 * @param {any} args
 * @returns {object} the JSON-serialisable result
 */
function run(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'args must be an object { text }' };
  }
  const { text } = args;
  if (typeof text !== 'string') {
    return { ok: false, error: 'text must be a string' };
  }
  return {
    ok: true,
    chars: text.length,
    words: countWords(text),
    lines: countLines(text),
    bytes: Buffer.byteLength(text, 'utf8'),
  };
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
