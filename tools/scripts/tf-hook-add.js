#!/usr/bin/env node
'use strict';

/**
 * tf-hook-add.js - management tool: add a hook entry to the hook manifest.
 *
 * A first-party "gateway-run" management function: it configures ToolFunnel's
 * OWN hook manifest (and, optionally, drops an inline hook script into the
 * scripts copy dir). Discovered via list_tools and executed via run_tool
 * through the PreToolUse gate - it is NOT a new MCP-protocol command.
 *
 * Contract with the register (`defaultRunScript`)
 * ----------------------------------------------------------
 *   - Structured args arrive as JSON in env TOOLFUNNEL_TOOL_ARGS ({} if absent).
 *   - Args: { id, event, matcher?, command, script?, timeout?, enabled?=true,
 *             description?, scriptText? }.
 *   - Prints EXACTLY ONE JSON object to stdout and exits 0 - ALWAYS exit 0, even
 *     on a logical error, which is reported as { ok:false, error }.
 *
 * Output (stdout), exactly one JSON object:
 *   success: { ok:true,  id, hook, scriptWritten }
 *   failure: { ok:false, error }
 *
 * Ordering note (verified against src/core/hook-loader.js)
 * -------------------------------------------------------
 *   HookLoader.writeScript(id, text) resolves the script path from the spec and
 *   THROWS for an unknown id (getSpec must find the row). Since addEntry rejects
 *   duplicate ids, this tool only ever creates NEW hooks - so the manifest row
 *   must be registered FIRST, then the inline script can be written. If the
 *   inline write fails, the just-added entry is rolled back so the add stays
 *   atomic (the intent behind a write-then-register ordering).
 *
 * Safety invariants:
 *   - Touches only ToolFunnel's own manifest + scripts dir (resolved from
 *     __dirname, never a caller-supplied absolute path).
 *   - NO network. NEVER throws for ordinary conditions - only JSON on stdout.
 */

const path = require('node:path');
// Shared HOME/engine resolution (see tf-env.js): config beside us, engine from the package.
const { HOME, srcRequire } = require('./tf-env');
const { loadManifest } = srcRequire('core/hook-loader');

const ROOT = HOME;

/** The hook manifest, relative to ROOT. */
const MANIFEST = path.join(ROOT, 'hooks', 'hooks.manifest.json');

/**
 * Parse the structured args handed in via env TOOLFUNNEL_TOOL_ARGS. Absent/empty
 * is treated as an empty object. Returns the parsed value or a parse-error
 * sentinel so the caller surfaces a clean { ok:false, error }.
 *
 * @returns {{ value: any } | { parseError: string }}
 */
function parseStructuredArgs() {
  const raw = process.env.TOOLFUNNEL_TOOL_ARGS;
  if (raw === undefined || raw === null || raw === '') {
    return { value: {} };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch (_err) {
    return { parseError: `TOOLFUNNEL_TOOL_ARGS was not valid JSON: ${String(raw)}` };
  }
}

/**
 * Pure-ish core: validate args, register the hook, optionally write the inline
 * script. Never throws for ordinary conditions (addEntry's own validation errors
 * are caught in main).
 *
 * @param {any} args
 * @returns {object} the JSON-serialisable result
 */
function run(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'args must be an object { id, event, command, ... }' };
  }

  const { id, event, matcher, command, script, timeout, description, scriptText } = args;

  // Clear up-front checks for fields addEntry does not (id/event/command are
  // re-validated by addEntry). scriptText is checked before any mutation so a
  // bad value never leaves a half-added entry behind.
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, error: 'id must be a non-empty string' };
  }
  if (scriptText !== undefined && typeof scriptText !== 'string') {
    return { ok: false, error: 'scriptText must be a string when provided' };
  }

  // enabled defaults to TRUE (opt-out) for this tool, unlike the loader's
  // addEntry default of false - so it is passed explicitly.
  const enabled = args.enabled === undefined ? true : args.enabled === true;

  // Build the spec from only the supplied optional fields (keeps the manifest
  // tidy); addEntry stores them verbatim.
  const spec = { id, event, command, enabled };
  if (matcher !== undefined) spec.matcher = matcher;
  if (script !== undefined) spec.script = script;
  if (timeout !== undefined) spec.timeout = timeout;
  if (description !== undefined) spec.description = description;

  const loader = loadManifest(MANIFEST);

  // Register first (see Ordering note in the header). addEntry validates
  // id/event/command and rejects duplicate ids by throwing - caught in main.
  const stored = loader.addEntry(spec);

  let scriptWritten = false;
  if (typeof scriptText === 'string') {
    try {
      loader.writeScript(id, scriptText);
      scriptWritten = true;
    } catch (err) {
      // Roll the entry back so a failed inline write leaves no orphan row.
      try {
        loader.removeEntry(id);
      } catch (_) {
        /* best-effort rollback */
      }
      return {
        ok: false,
        error: `script write failed (entry rolled back): ${(err && err.message) || String(err)}`,
      };
    }
  }

  return { ok: true, id, hook: stored, scriptWritten };
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
      // addEntry throws on validation / duplicate-id failures - report them as
      // a logical error, still exit 0.
      payload = { ok: false, error: (err && err.message) || String(err) };
    }
  }
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(0);
}

main();
