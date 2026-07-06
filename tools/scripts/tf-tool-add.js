#!/usr/bin/env node
'use strict';

/**
 * tf-tool-add.js — a first-party MANAGEMENT tool that ADDS a register entry.
 *
 * Purpose
 * -------
 * The write-side counterpart to the read-only status / inventory tools: it lets
 * the manager surface a NEW tool in the register at runtime (no reconnect — the
 * running gateway watches tools.register.json and hot-reloads its register on
 * change). Optionally it also writes the host-local script the new entry invokes,
 * so a single call can create both the register entry AND its backing script
 * atomically.
 *
 * This is a "gateway-run" tool: it mutates ToolFunnel's OWN config (the register
 * and, optionally, a script under the scripts root). It runs through the same
 * register -> resolveExecution -> gated run path as any other script tool, so
 * the PreToolUse gate still applies to invoking it.
 *
 * Contract with the register (registry.js `defaultRunScript`)
 * ----------------------------------------------------------
 *   - Structured args arrive as JSON in env TOOLFUNNEL_TOOL_ARGS ({} / absent => null).
 *   - Args: { id, name, summary?, category?, instructions?, inputSchema?,
 *             invoke: { type:'script'|'shell', path?|command? },
 *             scriptText? }
 *       inputSchema (a JSON Schema object) is what a HOT-promoted tool advertises verbatim in
 *       the top-level tools/list — dropping it here was the gap between "your own tools" and
 *       "your own tools AND schemas".
 *       When scriptText is a string AND invoke.type === 'script', the script is
 *       written first (registry.writeScript), THEN the entry is added.
 *   - Prints a SINGLE JSON object to stdout and exits 0 — ALWAYS exit 0, even on
 *     a logical error (reported as { ok:false, error }), never a thrown exception.
 *
 * Output (stdout), exactly one JSON object:
 *   success: { ok:true, ...<the added register entry>, scriptPath?: "<abs path>" }
 *   failure: { ok:false, error }
 *
 * Safety invariants:
 *   - Touches ONLY files inside the toolfunnel root, resolved from THIS script's
 *     own location (__dirname) — never a caller-supplied absolute path. The
 *     register's writeScript guards path-escape (basename + inside-root check).
 *   - NO network. Writes are atomic (temp + fsync + rename) via the register module.
 *   - NEVER throws for ordinary bad input — only well-shaped JSON on stdout.
 */

const path = require('node:path');
// Shared HOME/engine resolution (see tf-env.js): config beside us, engine from the package.
const { HOME, srcRequire } = require('./tf-env');
const { loadRegistry } = srcRequire('tools/registry');

const ROOT = HOME;
const REGISTER_PATH = path.join(ROOT, 'tools', 'tools.register.json');
const SCRIPTS_ROOT = path.join(ROOT, 'tools', 'scripts');

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
 * Pure core: given the parsed args, add the register entry (and optionally write
 * its backing script first). Throws are caught by main() and surfaced as
 * { ok:false, error }; loadRegistry / writeScript / add all throw on bad shape.
 *
 * @param {any} args
 * @returns {object} the JSON-serialisable result
 */
function run(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {
      ok: false,
      error: 'args must be an object { id, name, summary?, category?, instructions?, inputSchema?, invoke, scriptText? }',
    };
  }
  const { id, name, summary, category, instructions, inputSchema, invoke, scriptText } = args;

  // Build a clean register entry (only carry through the optional fields when
  // present so the persisted entry stays tidy). registry.add validates shape.
  const entry = { id, name, invoke };
  if (summary !== undefined) entry.summary = summary;
  if (category !== undefined) entry.category = category;
  if (instructions !== undefined) entry.instructions = instructions;
  if (inputSchema !== undefined) entry.inputSchema = inputSchema; // validated by registry.add


  const registry = loadRegistry(REGISTER_PATH, { scriptsRoot: SCRIPTS_ROOT });

  // When a script body is supplied for a script invoke, write it FIRST so the
  // entry never references a missing file once add() succeeds.
  let scriptPath;
  if (typeof scriptText === 'string' && invoke && invoke.type === 'script') {
    scriptPath = registry.writeScript(invoke.path, scriptText);
  }

  const added = registry.add(entry);
  const result = { ok: true, ...added };
  if (scriptPath) result.scriptPath = scriptPath;
  return result;
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
      payload = { ok: false, error: (err && err.message) || String(err) };
    }
  }
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(0);
}

main();
