'use strict';

/**
 * gated-run.js - the SAFETY CRUX of the gateway.
 *
 * Contract: the architecture contract §2 (the `toolfunnel_run_tool` path) and §9 (the tested invariant).
 * Hook contract: HOOK_ENGINE.md §1 (PreToolUse can block, PostToolUse cannot un-run) and §6
 * (HookEngine.fire returns { injected, blocked, reason, stopLoop, results }; the engine has
 * ALREADY normalised exit-2 / hookSpecificOutput.permissionDecision:"deny" into { blocked, reason }).
 *
 * This is the single place where "run a tool" becomes "fire PreToolUse -> maybe execute ->
 * fire PostToolUse". Every powerful run-path (toolfunnel_run_tool, registry.run) funnels through here so
 * the gate is impossible to bypass. The LOAD-BEARING INVARIANT, proven by test:
 *
 *     A PreToolUse deny MUST prevent execute() from ever being called.
 *
 * Design rules:
 *   - PURE: `engine` and `execute` are INJECTED. No transport, no SDK, no host, no fs.
 *     Unit-testable under `node --test` with a fake engine + a spy execute().
 *   - NEVER throws out of gatedRun. A thrown execute() is captured as { ok:false, error }.
 *     A misbehaving engine.fire() (rejection or junk return) is treated conservatively.
 *   - PostToolUse is advisory (HOOK_ENGINE.md §1: a PostToolUse block cannot un-run the tool),
 *     so we fire it for feedback but never let it flip ok->false or throw the path.
 *
 * Return shape (always one of these, never an exception):
 *   blocked by PreToolUse : { ok:false, blocked:true,  reason, output:null }
 *   execute threw         : { ok:false, blocked:false, error, output:null }
 *   success               : { ok:true,  blocked:false, output }
 *
 * CommonJS only. Node built-ins only. No new dependencies.
 */

// Activity log. Self-gating (no-op unless explicitly enabled) and contracted never to
// throw, so wiring it here cannot alter gate behaviour or break the run path.
const logger = require('../core/logger');

const EVENTS = {
  PRE: 'PreToolUse',
  POST: 'PostToolUse',
};

/**
 * Fire one lifecycle event through the injected engine, defensively.
 *
 * The HookEngine contract (HOOK_ENGINE.md §6) says fire() never rejects, but gatedRun is the
 * safety crux: we must not assume a perfectly-behaved engine. If fire() rejects or returns a
 * non-object, we fail CLOSED on the gate (PreToolUse) - an engine we cannot trust to answer
 * "allowed?" must not be read as "allowed". PostToolUse is advisory, so a failure there is benign.
 *
 * @param {object} engine an object exposing async fire(event, ctx, extra)
 * @param {string} event one of EVENTS
 * @param {object} ctx common hook context (session_id, transcript_path, cwd, ...)
 * @param {object} extra event-specific fields (per HOOK_ENGINE.md §2 table)
 * @returns {Promise<{ injected:string, blocked:boolean, reason:(string|null),
 *                     stopLoop:boolean, results:object[] }>}
 */
async function fireSafely(engine, event, ctx, extra) {
  try {
    const res = await engine.fire(event, ctx, extra);
    // The engine already normalises blocking to { blocked, reason }. Defensively coerce a
    // junk/undefined return into a well-shaped result so callers can read fields safely.
    if (res && typeof res === 'object') {
      return {
        injected: typeof res.injected === 'string' ? res.injected : '',
        blocked: res.blocked === true,
        reason: res.reason != null ? res.reason : null,
        stopLoop: res.stopLoop === true,
        results: Array.isArray(res.results) ? res.results : [],
      };
    }
    // Non-object return from fire(): per-event. PreToolUse fails CLOSED - a gate that
    // returns junk cannot be read as "allowed". PostToolUse is advisory -> benign.
    if (event === EVENTS.PRE) {
      return {
        injected: '',
        blocked: true,
        reason: 'hook engine returned a non-object for ' + event + ' - failing closed',
        internal: true, // wiring failure, NOT operator policy - wrap paths must neutralise it
        stopLoop: false,
        results: [],
      };
    }
    return { injected: '', blocked: false, reason: null, stopLoop: false, results: [] };
  } catch (err) {
    // fire() should never reject; if it does, fail closed on the GATE and benign on POST.
    const reason =
      'hook engine error during ' + event + ': ' + ((err && err.message) || String(err));
    if (event === EVENTS.PRE) {
      // Fail CLOSED: an engine that cannot answer the gate denies the run.
      return { injected: '', blocked: true, reason, internal: true, stopLoop: false, results: [] };
    }
    // PostToolUse is advisory and cannot un-run the tool - a failure here is benign.
    return { injected: '', blocked: false, reason: null, stopLoop: false, results: [] };
  }
}

/**
 * gatedRun - route a single tool invocation through the host's hook engine.
 *
 * Sequence (the architecture contract §2):
 *   1. fire PreToolUse with { tool_name, tool_input: args }.
 *   2. if blocked -> return { ok:false, blocked:true, reason, output:null } and DO NOT call execute.
 *   3. else await execute(); on throw, capture as error (output stays null).
 *   4. fire PostToolUse with { tool_name, tool_input: args, tool_response: output }.
 *      (PostToolUse is advisory - fired for feedback even on the error path so PostToolUse hooks
 *       observe what happened; it never flips ok or throws.)
 *   5. return { ok:true, blocked:false, output } | { ok:false, blocked:false, error, output:null }.
 *
 * @param {object}   params
 * @param {object}   params.engine   the host's HookEngine - async fire(event, ctx, extra). INJECTED.
 * @param {object}   [params.ctx]    common hook context (session_id, transcript_path, cwd, ...).
 * @param {string}   params.toolName the tool name (becomes tool_name in the payload).
 * @param {*}        [params.args]   the tool input (becomes tool_input in the payload).
 * @param {Function} params.execute  thunk that performs the actual call (from
 *                                   registry.resolveExecution). `() => any | Promise<any>`. INJECTED.
 * @returns {Promise<{ ok:boolean, blocked:boolean, reason?:(string|null),
 *                     output:(*|null), error?:Error }>}
 */
async function gatedRun(params) {
  const p = params || {};
  const { engine, ctx, toolName, args, execute } = p;

  // ---- Validate injected dependencies, failing CLOSED (never execute on a bad wiring). ----
  if (!engine || typeof engine.fire !== 'function') {
    return {
      ok: false,
      blocked: true,
      reason: 'gatedRun: engine with async fire() is required',
      internal: true, // wiring failure, NOT operator policy - wrap paths must neutralise it
      output: null,
    };
  }
  if (typeof execute !== 'function') {
    return {
      ok: false,
      blocked: true,
      reason: 'gatedRun: execute thunk (function) is required',
      internal: true,
      output: null,
    };
  }

  const context = ctx || {};

  // ---- 1. PreToolUse gate. -------------------------------------------------------------
  // tool_input carries the args verbatim (per HOOK_ENGINE.md §2 PreToolUse row).
  const pre = await fireSafely(engine, EVENTS.PRE, context, {
    tool_name: toolName,
    tool_input: args,
  });

  // ---- Activity log: record the gate decision (allow|deny). Self-gates on enabled;
  //      never throws. Placed before the blocked-return so BOTH outcomes are logged. ---
  logger.log({
    type: 'gate',
    tool: toolName,
    decision: pre.blocked ? 'deny' : 'allow',
    reason: pre.reason,
  });

  // ---- 2. Blocked -> STOP. The load-bearing invariant: execute() is NOT called. ---------
  if (pre.blocked) {
    return {
      ok: false,
      blocked: true,
      reason: pre.reason,
      // Distinguish a genuine hook DENY (operator policy - its reason may be shown to a wrapped
      // client) from an internal fail-closed (engine wiring/crash - its reason is a gateway tell
      // that must be neutralised on the wrap path).
      internal: pre.internal === true,
      output: null,
    };
  }

  // ---- 3. Allowed -> execute the real call. Capture a throw as `error`. -----------------
  let output = null;
  let error = null;
  try {
    output = await execute();
  } catch (err) {
    // Normalise any thrown value into an Error so the caller always gets an Error instance.
    error = err instanceof Error ? err : new Error(String(err));
  }

  // ---- 4. PostToolUse (advisory). Fired even on the error path so hooks see the outcome. -
  // tool_response is the output (null when execute threw). PostToolUse cannot un-run the tool
  // (HOOK_ENGINE.md §1), so its result never flips ok and never throws this path.
  await fireSafely(engine, EVENTS.POST, context, {
    tool_name: toolName,
    tool_input: args,
    tool_response: output,
  });

  // ---- 5. Final result. ----------------------------------------------------------------
  if (error) {
    return { ok: false, blocked: false, error, output: null };
  }
  return { ok: true, blocked: false, output };
}

module.exports = { gatedRun, EVENTS };
