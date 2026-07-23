#!/usr/bin/env node
'use strict';

/**
 * json-tool.js - a safe, dependency-free local JSON formatter / validator.
 *
 * Purpose
 * -------
 * Validate a JSON string and either pretty-print it (default) or minify it.
 * Useful from the Tool Manager for tidying up JSON blobs or confirming a string
 * is valid JSON. Pure JSON.parse / JSON.stringify - no network, no filesystem.
 *
 * Contract with the register (the register's `defaultRunScript`)
 * ----------------------------------------------------------
 *   - Structured args arrive as JSON in env TOOLFUNNEL_TOOL_ARGS.
 *   - Args: { text: <string>, indent?: <integer 0..10>, minify?: <boolean> }.
 *       indent defaults to 2 (used for the pretty form).
 *       minify true -> return the compact (no-whitespace) form instead.
 *   - Prints a SINGLE JSON object to stdout and exits 0 - ALWAYS exit 0, even
 *     for invalid JSON input (reported as { ok:false, error }).
 *
 * Output (stdout), exactly one JSON object:
 *   pretty:  { ok:true, pretty: "<indented json>" }      (minify falsey)
 *   minify:  { ok:true, minified: "<compact json>" }     (minify true)
 *   failure: { ok:false, error }                          (invalid JSON / bad args)
 *
 * Safety invariants (mirror the isolation rule):
 *   - NO filesystem, NO network, NO process mutation. Pure CPU on the args.
 *   - indent is clamped to a sane [0,10] range so a huge indent cannot blow up.
 *   - NEVER throws for ordinary bad input - only well-shaped JSON on stdout.
 */

const MAX_INDENT = 10;
const DEFAULT_INDENT = 2;

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
    return { ok: false, error: 'args must be an object { text, indent?, minify? }' };
  }
  const { text } = args;
  if (typeof text !== 'string') {
    return { ok: false, error: 'text must be a string' };
  }

  // Validate indent (only meaningful for the pretty path, but validate eagerly).
  let indent = DEFAULT_INDENT;
  if (args.indent !== undefined && args.indent !== null) {
    if (typeof args.indent !== 'number' || !Number.isInteger(args.indent)) {
      return { ok: false, error: 'indent must be an integer' };
    }
    if (args.indent < 0 || args.indent > MAX_INDENT) {
      return { ok: false, error: `indent must be between 0 and ${MAX_INDENT}` };
    }
    indent = args.indent;
  }

  // Parse the supplied JSON text - THIS is the validation step.
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err && err.message) || String(err)}` };
  }

  if (args.minify === true) {
    return { ok: true, minified: JSON.stringify(parsed) };
  }
  return { ok: true, pretty: JSON.stringify(parsed, null, indent) };
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
