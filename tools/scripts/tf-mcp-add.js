#!/usr/bin/env node
'use strict';

/**
 * tf-mcp-add.js - gateway-run MANAGEMENT tool: register an upstream MCP in the
 * ExposeStore and (optionally) curate which of its tools are exposed downstream.
 *
 * This is a first-party "management" script-tool: it is discovered via list_tools
 * and executed via run_tool through the PreToolUse gate. It does not add new
 * MCP-protocol commands - it edits ToolFunnel's own MCP config (mcp/expose.json)
 * by way of the ExposeStore, the on-disk source of truth the aggregator consumes.
 *
 * Contract with the register (`defaultRunScript`)
 * ----------------------------------------------------------
 *   - Structured args arrive as a JSON string in env TOOLFUNNEL_TOOL_ARGS ({} if
 *     absent). Shape:
 *       {
 *         id, command,
 *         args?:[], env?:{}, transport?='stdio', enabled?=true, description?,
 *         expose?:[ { tool, as?, category?, enabled? } ]
 *       }
 *   - Prints EXACTLY ONE JSON line to stdout and exits 0 - ALWAYS. A logical
 *     failure (bad args, validation error from the store) is reported as
 *     { ok:false, error }, never a non-zero exit or a crash.
 *
 * Output (stdout), exactly one JSON object:
 *   success: { ok:true, upstream:{...}, exposed:[{...}, ...] }
 *   failure: { ok:false, error }
 *
 * Behaviour
 *   - addUpstream({ id, command, args, env, transport, enabled, description }) -
 *     the store validates (unique non-empty id, transport==='stdio', non-empty
 *     command) and persists atomically.
 *   - For each expose[] item: addExpose({ upstream:id, tool, as, category, enabled }).
 *     The store requires the upstream to exist (it does - we just added it), a
 *     non-empty tool, and a unique (upstream,tool) pair.
 *
 * Note: there is no cross-step transaction. If the upstream is added but a later
 * expose[] item fails validation, the upstream (and any earlier exposes) remain
 * persisted; the failure is reported as { ok:false, error }.
 */

const path = require('node:path');
// Shared HOME/engine resolution (see tf-env.js): config beside us, engine from the package.
const { HOME, srcRequire } = require('./tf-env');
const { loadExposeStore } = srcRequire('mcp/expose-store');
const { snapshotForStoreFile, restoreSnapshot } = srcRequire('core/rename-migration');

const ROOT = HOME;

/** The MCP config (upstreams + expose), per the host path contract. */
const EXPOSE_PATH = path.join(ROOT, 'mcp', 'expose.json');

/**
 * Parse TOOLFUNNEL_TOOL_ARGS (a JSON string; {} if absent). Throws on malformed
 * JSON or a non-object payload so the caller reports { ok:false, error }.
 * @returns {object}
 */
function parseArgs() {
  // the arguments: env TOOLFUNNEL_TOOL_ARGS, or stdin when they were too big for the env
  const raw = process.env.TOOLFUNNEL_TOOL_ARGS
    ?? (process.env.TOOLFUNNEL_TOOL_ARGS_STDIN === '1' ? require('node:fs').readFileSync(0, 'utf8') : undefined);
  if (raw === undefined || raw === null || raw === '') return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TOOLFUNNEL_TOOL_ARGS must be a JSON object');
  }
  return parsed;
}

/**
 * Perform the add. May throw - main() turns any throw into { ok:false, error }.
 * @returns {object} the success payload
 */
function run() {
  const args = parseArgs();
  const store = loadExposeStore(EXPOSE_PATH);

  // Values go to the store RAW: it defaults what is absent and REFUSES what is wrong-typed,
  // naming the field. Coercing here - `enabled: "false"` to true - would hide exactly the
  // mistake the store reports.
  const upstream = store.addUpstream({
    id: args.id,
    command: args.command,
    args: args.args,
    env: args.env,
    transport: args.transport,
    enabled: args.enabled,
    description: args.description,
  });

  // addUpstream has persisted; a later expose item can still be refused. A reply of ok:false must
  // not keep half the add - the natural retry would die as a duplicate id. Unwind the whole add, as
  // the UI's /api/mcp/add does: removeUpstream cascades this id's expose entries, and the snapshot
  // puts back the gate matchers / state keys an ENABLED aliased item migrated as it landed.
  const snap = snapshotForStoreFile(EXPOSE_PATH);
  const exposed = [];
  const exposeList = Array.isArray(args.expose) ? args.expose : [];
  try {
    for (const item of exposeList) {
      const e = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
      exposed.push(
        store.addExpose({
          upstream: upstream.id,
          tool: e.tool,
          as: e.as,
          category: e.category,
          enabled: e.enabled,
        })
      );
    }
  } catch (err) {
    try { store.removeUpstream(upstream.id); } catch (_e) { /* best-effort; the real error is reported below */ }
    restoreSnapshot(snap);
    throw err;
  }

  return { ok: true, upstream, exposed };
}

function main() {
  let payload;
  try {
    payload = run();
  } catch (err) {
    payload = { ok: false, error: (err && err.message) || String(err) };
  }
  // exit once stdout has drained: an exit straight after write cut answers over 64 KB short on Linux and macOS pipes
  process.stdout.write(JSON.stringify(payload) + '\n', () => process.exit(0));
}

main();
