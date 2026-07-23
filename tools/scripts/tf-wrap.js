#!/usr/bin/env node
'use strict';

/**
 * tf-wrap.js - gateway-run MANAGEMENT tool: set, clear, or report the PASSTHROUGH wrap.
 *
 * Wrapping turns the gateway into a transparent wrapper for ONE attached upstream MCP: its
 * tools become the ENTIRE advertised surface (under their ORIGINAL names), the meta-tools and
 * every other tool are hidden and uncallable, and every call still fires the PreToolUse gate.
 * Because the gateway answers both MCP eras, this is how a legacy-only (or unmaintained) MCP
 * keeps working with 2026-07-28-era clients.
 *
 * ⚠ SELF-LOCKOUT: the wrap hides ALL ToolFunnel tools - INCLUDING tf_wrap itself. The AI that
 * sets a wrap loses in-band access to undo it. That is why `confirm: true` is REQUIRED to set
 * one. Undo paths that survive the wrap: the config web UI (--ui), or `toolfunnel wrap --off`
 * on a terminal. A running host picks either up live.
 *
 * Contract with the register (`defaultRunScript`)
 * ----------------------------------------------------------
 *   - Structured args arrive as a JSON string in env TOOLFUNNEL_TOOL_ARGS ({} if absent).
 *     Shape: {} (status) | { off:true } (clear) | { upstream:'<id>', confirm:true } (set).
 *   - Prints EXACTLY ONE JSON line to stdout and exits 0 - ALWAYS. A logical failure is
 *     reported as { ok:false, error }.
 *
 * Output (stdout), exactly one JSON object:
 *   status: { ok:true, wrapping:(id|null), upstreams:[id...] }
 *   clear:  { ok:true, cleared:true, was:(id|null) }
 *   set:    { ok:true, wrapping:id, warning:'...' }
 *   failure:{ ok:false, error }
 */

const path = require('node:path');
const { HOME, srcRequire } = require('./tf-env');
const { loadExposeStore } = srcRequire('mcp/expose-store');
const { loadToolState, getPassthrough, setPassthrough } = srcRequire('tools/tool-state');

const STATE_PATH = path.join(HOME, 'tools', 'tools.state.json');
const EXPOSE_PATH = path.join(HOME, 'mcp', 'expose.json');

const LOCKOUT_WARNING =
  'The wrap hides ALL ToolFunnel tools - including tf_wrap itself. In-band undo is now ' +
  'impossible for you: recover via the config web UI (--ui) or `toolfunnel wrap --off` on a terminal.';

function parseArgs() {
  const raw = process.env.TOOLFUNNEL_TOOL_ARGS;
  if (raw === undefined || raw === null || raw === '') return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TOOLFUNNEL_TOOL_ARGS must be a JSON object');
  }
  return parsed;
}

function run() {
  const args = parseArgs();

  if (args.off === true) {
    const was = getPassthrough(loadToolState(STATE_PATH));
    setPassthrough(STATE_PATH, null);
    return { ok: true, cleared: true, was };
  }

  const store = loadExposeStore(EXPOSE_PATH);
  const ids = store.listUpstreams().map((u) => u.id);

  if (args.upstream === undefined) {
    return { ok: true, wrapping: getPassthrough(loadToolState(STATE_PATH)), upstreams: ids };
  }

  const id = args.upstream;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('args.upstream must be a non-empty string (an attached upstream id)');
  }
  const upstream = store.getUpstream(id);
  if (!upstream) {
    throw new Error(`no upstream with id "${id}" - attached: ${ids.join(', ') || '(none)'}`);
  }
  if (upstream.enabled === false) {
    throw new Error(`upstream "${id}" is disabled in mcp/expose.json - enable it first (tf_mcp_set)`);
  }
  if (args.confirm !== true) {
    throw new Error(
      'confirm:true is required. ' + LOCKOUT_WARNING +
      ' Call again with { "upstream": "' + id + '", "confirm": true } to proceed.'
    );
  }

  setPassthrough(STATE_PATH, id);
  return { ok: true, wrapping: id, warning: LOCKOUT_WARNING };
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
