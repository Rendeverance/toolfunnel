#!/usr/bin/env node
'use strict';

/**
 * tf-log.js — gateway-run MANAGEMENT tool: enable, disable, or check the activity log.
 *
 * A first-party "management" script-tool (discovered via list_tools, executed via
 * run_tool through the PreToolUse gate). It toggles ToolFunnel's own JSONL audit log
 * (tool runs + gate allow/deny decisions) via src/core/logger. Logging is DEFAULT OFF.
 *
 * Contract with the register (`defaultRunScript`)
 * ----------------------------------------------------------
 *   - Structured args arrive as a JSON string in env TOOLFUNNEL_TOOL_ARGS ({} if
 *     absent). Shape: { action: 'enable'|'disable'|'status', path? }.
 *   - Prints EXACTLY ONE JSON line to stdout and exits 0 — ALWAYS. A logical failure
 *     (bad args) is reported as { ok:false, error }.
 *
 * Output (stdout), exactly one JSON object:
 *   enable/disable: { ok:true, action, enabled, path }
 *   status:         { ok:true, action, enabled, path, count }   // count = log entries
 *   failure:        { ok:false, error }
 */

const logger = require('../../src/core/logger');

/**
 * Parse TOOLFUNNEL_TOOL_ARGS (a JSON string; {} if absent). Throws on malformed JSON
 * or a non-object payload so the caller reports { ok:false, error }.
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
  const action = args.action;

  switch (action) {
    case 'enable': {
      const patch = { enabled: true };
      if (typeof args.path === 'string' && args.path.length > 0) patch.path = args.path;
      const cfg = logger.setConfig(patch);
      return { ok: true, action, enabled: cfg.enabled, path: cfg.path };
    }
    case 'disable': {
      const cfg = logger.setConfig({ enabled: false });
      return { ok: true, action, enabled: cfg.enabled, path: cfg.path };
    }
    case 'status': {
      const cfg = logger.getConfig();
      const entries = logger.tail();
      return { ok: true, action, enabled: cfg.enabled, path: cfg.path, count: entries.length };
    }
    default:
      throw new Error(
        `args.action must be one of enable|disable|status (got ${JSON.stringify(action)})`
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
