'use strict';

/**
 * events.js — lifecycle event names + per-event stdin payload builder.
 *
 * This is the contract surface from HOOK_ENGINE.md §1 (the six events) and §2
 * (the exact stdin JSON shape). Field names are FROZEN by §2's table — they must
 * match Claude Code's documented hook input byte-for-byte so the real hook
 * scripts run unchanged. Do not rename or add fields.
 *
 * CommonJS only. Zero host imports (core/ must run headless under node --test).
 */

/**
 * The six lifecycle events v3 supports (HOOK_ENGINE.md §1).
 * Values equal the `hook_event_name` written into the stdin payload.
 * Frozen so callers can rely on identity comparison and can't mutate the set.
 */
const EVENTS = Object.freeze({
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  Stop: 'Stop',
  PreCompact: 'PreCompact',
});

// Set of valid event names for fast membership checks / validation.
const EVENT_NAMES = Object.freeze(Object.values(EVENTS));

/**
 * Build the stdin JSON object the runner pipes to a hook command.
 *
 * Every event carries the four common fields (HOOK_ENGINE.md §2):
 *   session_id, transcript_path, cwd, hook_event_name
 * supplied by `ctx`. Each event then adds its own fields from `extra`:
 *
 *   SessionStart      → source            : "startup" | "resume" | "compact"
 *   UserPromptSubmit  → prompt            : "<user text>"
 *   PreToolUse        → tool_name, tool_input
 *   PostToolUse       → tool_name, tool_input, tool_response
 *   Stop              → stop_hook_active   : true | false
 *   PreCompact        → trigger ("manual"|"auto"), custom_instructions
 *
 * @param {string} event  one of EVENTS (the hook_event_name).
 * @param {object} ctx    common fields: { session_id, transcript_path, cwd }.
 * @param {object} [extra] event-specific fields (see table above).
 * @returns {object} the stdin payload, with frozen field names per §2.
 * @throws {Error} if `event` is not one of the six known events.
 */
function buildPayload(event, ctx, extra) {
  if (!EVENT_NAMES.includes(event)) {
    throw new Error(`buildPayload: unknown event "${event}"`);
  }

  const c = ctx || {};
  const e = extra || {};

  // Common fields — present on EVERY event, in the order §2 lists them.
  // hook_event_name is always the canonical event string (not whatever ctx held).
  const payload = {
    session_id: c.session_id,
    transcript_path: c.transcript_path,
    cwd: c.cwd,
    hook_event_name: event,
  };

  // Event-specific additions. Each branch sets EXACTLY the fields §2 names —
  // no more, no fewer — so the payload matches Claude Code's shape precisely.
  switch (event) {
    case EVENTS.SessionStart:
      payload.source = e.source;
      break;

    case EVENTS.UserPromptSubmit:
      payload.prompt = e.prompt;
      break;

    case EVENTS.PreToolUse:
      payload.tool_name = e.tool_name;
      payload.tool_input = e.tool_input;
      break;

    case EVENTS.PostToolUse:
      payload.tool_name = e.tool_name;
      payload.tool_input = e.tool_input;
      payload.tool_response = e.tool_response;
      break;

    case EVENTS.Stop:
      payload.stop_hook_active = e.stop_hook_active;
      break;

    case EVENTS.PreCompact:
      payload.trigger = e.trigger;
      payload.custom_instructions = e.custom_instructions;
      break;

    // No default: the membership check above already rejected unknown events.
  }

  return payload;
}

module.exports = { EVENTS, EVENT_NAMES, buildPayload };
