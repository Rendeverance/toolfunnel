#!/usr/bin/env node
'use strict';

/**
 * tf-hook-set.js — management tool: enable, disable, or remove a hook entry.
 *
 * A first-party "gateway-run" management function: it configures ToolFunnel's
 * OWN hook manifest / enabled-state overlay. Discovered via list_tools and
 * executed via run_tool through the PreToolUse gate — it is NOT a new
 * MCP-protocol command.
 *
 * Contract with the register (`defaultRunScript`)
 * ----------------------------------------------------------
 *   - Structured args arrive as JSON in env TOOLFUNNEL_TOOL_ARGS ({} if absent).
 *   - Args: { id, action: "enable" | "disable" | "remove" }.
 *   - Prints EXACTLY ONE JSON object to stdout and exits 0 — ALWAYS exit 0, even
 *     on a logical error, which is reported as { ok:false, error }.
 *
 * Output (stdout), exactly one JSON object:
 *   enable/disable: { ok:true, id, action, enabled }
 *   remove:         { ok:true, id, action, removed }
 *   failure:        { ok:false, error }
 *
 * Mapping (verified against src/core/hook-loader.js):
 *   - enable  → loader.setEnabled(id, true)   (persists the state overlay + manifest)
 *   - disable → loader.setEnabled(id, false)
 *   - remove  → loader.removeEntry(id)        (returns false if the id was absent;
 *               that is information, not a fault, so ok stays true)
 *
 * Safety invariants:
 *   - Touches only ToolFunnel's own manifest / state (resolved from __dirname).
 *   - NO network. NEVER throws for ordinary conditions — only JSON on stdout.
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
 * Pure-ish core: validate args and apply the requested action. Never throws for
 * ordinary conditions (any loader throw is caught in main).
 *
 * @param {any} args
 * @returns {object} the JSON-serialisable result
 */
function run(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'args must be an object { id, action }' };
  }

  const { id, action } = args;
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, error: 'id must be a non-empty string' };
  }
  if (action !== 'enable' && action !== 'disable' && action !== 'remove') {
    return { ok: false, error: 'action must be one of "enable", "disable", "remove"' };
  }

  const loader = loadManifest(MANIFEST);

  if (action === 'remove') {
    const removed = loader.removeEntry(id);
    return { ok: true, id, action, removed };
  }

  const desired = action === 'enable';
  loader.setEnabled(id, desired);
  return { ok: true, id, action, enabled: desired };
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
