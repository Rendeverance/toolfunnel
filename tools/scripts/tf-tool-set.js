#!/usr/bin/env node
'use strict';

/**
 * tf-tool-set.js - a first-party MANAGEMENT tool that toggles or removes a tool.
 *
 * Purpose
 * -------
 * The state-side counterpart to tf-tool-add: it flips a tool's ACTIVE/DISABLED
 * overlay flag (enable / disable) or fully removes a tool (drops the register
 * entry AND clears its state overlay). Register/state edits are visible to the
 * meta-tools on the next call - no reconnect.
 *
 * This is a "gateway-run" tool: it mutates ToolFunnel's OWN config (the per-tool
 * state overlay, and for `remove`, the register too). It runs through the same
 * gated run path as any other script tool.
 *
 * Contract with the register (registry.js `defaultRunScript`)
 * ----------------------------------------------------------
 *   - Structured args arrive as JSON in env TOOLFUNNEL_TOOL_ARGS ({} / absent => null).
 *   - Args: { id, action: 'enable' | 'disable' | 'hot' | 'unhot' | 'hide' | 'unhide' | 'remove' }.
 *       enable/disable -> setToolEnabled(state, id, bool)  (overlay merge; preserves hidden/hot)
 *       hot/unhot      -> setToolHot(state, id, bool)      (overlay merge; preserves enabled/hidden)
 *                         - promote/demote the tool on the TOP-LEVEL every-turn surface (the matrix).
 *       hide/unhide    -> setToolHidden(state, id, bool)   (overlay merge; preserves enabled/hot)
 *                         - declutter the MANAGER views only (tf_list + the UI); does NOT change
 *                           what the connected AI sees (the lean list / top-level surface).
 *       remove         -> registry.remove(id) AND clearToolState(state, id)
 *   - Prints a SINGLE JSON object to stdout and exits 0 - ALWAYS exit 0, even on
 *     a logical error (reported as { ok:false, error }), never a thrown exception.
 *
 * Output (stdout), exactly one JSON object:
 *   enable/disable: { ok:true, id, action, enabled, state }
 *   hot/unhot:      { ok:true, id, action, hot, state }
 *   hide/unhide:    { ok:true, id, action, hidden, state }
 *   remove:         { ok:true, id, action, removed:true, state }
 *   failure:        { ok:false, error }
 *   (`state` is the resulting overlay map after the operation.)
 *
 * Safety invariants:
 *   - Touches ONLY config files inside the toolfunnel root, resolved from THIS
 *     script's own location (__dirname) - never a caller-supplied path.
 *   - NO network. Writes are atomic (temp + fsync + rename) via the store modules.
 *   - NEVER throws for ordinary bad input - only well-shaped JSON on stdout.
 */

const path = require('node:path');
// Shared HOME/engine resolution (see tf-env.js): config beside us, engine from the package.
const { HOME, srcRequire } = require('./tf-env');
const { loadRegistry } = srcRequire('tools/registry');
const { setToolEnabled, setToolHot, setToolHidden, clearToolState } = srcRequire('tools/tool-state');

const ROOT = HOME;
const REGISTER_PATH = path.join(ROOT, 'tools', 'tools.register.json');
const STATE_PATH = path.join(ROOT, 'tools', 'tools.state.json');
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
 * Pure core: given the parsed args, perform the requested state/register change.
 * Throws are caught by main() and surfaced as { ok:false, error }; registry.remove
 * throws on an unknown id, setToolEnabled/clearToolState throw on a bad id.
 *
 * @param {any} args
 * @returns {object} the JSON-serialisable result
 */
function run(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: "args must be an object { id, action: 'enable'|'disable'|'hot'|'unhot'|'hide'|'unhide'|'remove' }" };
  }
  const { id, action } = args;
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, error: 'id must be a non-empty string' };
  }

  if (action === 'enable' || action === 'disable') {
    const enabled = action === 'enable';
    const state = setToolEnabled(STATE_PATH, id, enabled);
    return { ok: true, id, action, enabled, state };
  }

  if (action === 'hot' || action === 'unhot') {
    // Promote (hot) / demote (unhot) the tool on the TOP-LEVEL every-turn surface. Keyed by the
    // surfaced name (a local id, an upstream surfaced name, or a meta-tool name) - the same key the
    // server's matrix assembler reads. The id is NOT verified against the register here: an upstream
    // surfaced name or a meta-tool name is a legitimate key with no register entry.
    const hot = action === 'hot';
    const state = setToolHot(STATE_PATH, id, hot);
    return { ok: true, id, action, hot, state };
  }

  if (action === 'hide' || action === 'unhide') {
    // Declutter the MANAGER views (tf_list + the UI) only - hide/unhide does NOT change the lean list
    // or the top-level surface the connected AI sees. Same id-not-verified policy as hot/unhot.
    const hidden = action === 'hide';
    const state = setToolHidden(STATE_PATH, id, hidden);
    return { ok: true, id, action, hidden, state };
  }

  if (action === 'remove') {
    // Drop the register entry first (throws on unknown id), then clear any overlay.
    const registry = loadRegistry(REGISTER_PATH, { scriptsRoot: SCRIPTS_ROOT });
    registry.remove(id);
    const state = clearToolState(STATE_PATH, id);
    return { ok: true, id, action, removed: true, state };
  }

  return { ok: false, error: "action must be one of 'enable'|'disable'|'hot'|'unhot'|'hide'|'unhide'|'remove'" };
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
