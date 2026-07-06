#!/usr/bin/env node
'use strict';

/**
 * tf-mcp-set.js — gateway-run MANAGEMENT tool: enable, disable, or remove an
 * upstream MCP in the ExposeStore.
 *
 * A first-party "management" script-tool (discovered via list_tools, executed via
 * run_tool through the PreToolUse gate). It edits ToolFunnel's own MCP config
 * (mcp/expose.json) via the ExposeStore — it does not add MCP-protocol commands.
 *
 * Contract with the register (`defaultRunScript`)
 * ----------------------------------------------------------
 *   - Structured args arrive as a JSON string in env TOOLFUNNEL_TOOL_ARGS ({} if
 *     absent). Shape: { id, action: 'enable'|'disable'|'remove' }.
 *   - Prints EXACTLY ONE JSON line to stdout and exits 0 — ALWAYS. A logical
 *     failure (bad args, unknown id) is reported as { ok:false, error }.
 *
 * Output (stdout), exactly one JSON object:
 *   enable/disable: { ok:true, action, id, upstream:{...} }   // the updated entry
 *   remove:         { ok:true, action, id, removed:true }     // cascades expose[]
 *   failure:        { ok:false, error }
 *
 * Behaviour
 *   - enable  -> setUpstreamEnabled(id, true)
 *   - disable -> setUpstreamEnabled(id, false)
 *   - remove  -> removeUpstream(id)  (the store cascade-removes its expose entries)
 * All three throw on an unknown id; the throw is reported as { ok:false, error }.
 */

const path = require('node:path');
// Shared HOME/engine resolution (see tf-env.js): config beside us, engine from the package.
const { HOME, srcRequire } = require('./tf-env');
const { loadExposeStore } = srcRequire('mcp/expose-store');

const ROOT = HOME;

/** The MCP config (upstreams + expose), per the host path contract. */
const EXPOSE_PATH = path.join(ROOT, 'mcp', 'expose.json');

/**
 * Parse TOOLFUNNEL_TOOL_ARGS (a JSON string; {} if absent). Throws on malformed
 * JSON or a non-object payload so the caller reports { ok:false, error }.
 * @returns {object}
 */
function parseArgs() {
  const raw = process.env.TOOLFUNNEL_TOOL_ARGS;
  if (raw === undefined || raw === null || raw === '') return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TOOLFUNNEL_TOOL_ARGS must be a JSON object');
  }
  return parsed;
}

/**
 * Perform the action. May throw — main() turns any throw into { ok:false, error }.
 * @returns {object} the success payload
 */
function run() {
  const args = parseArgs();
  const id = args.id;
  const action = args.action;

  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('args.id must be a non-empty string');
  }

  const store = loadExposeStore(EXPOSE_PATH);

  switch (action) {
    case 'enable': {
      const upstream = store.setUpstreamEnabled(id, true);
      return { ok: true, action, id, upstream };
    }
    case 'disable': {
      const upstream = store.setUpstreamEnabled(id, false);
      return { ok: true, action, id, upstream };
    }
    case 'remove': {
      store.removeUpstream(id);
      return { ok: true, action, id, removed: true };
    }
    default:
      throw new Error(
        `args.action must be one of enable|disable|remove (got ${JSON.stringify(action)})`
      );
  }
}

function main() {
  let payload;
  try {
    payload = run();
  } catch (err) {
    payload = { ok: false, error: (err && err.message) || String(err) };
  }
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(0);
}

main();
