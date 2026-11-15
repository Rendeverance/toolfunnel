'use strict';

/**
 * metrics.js - in-memory, per-process tool-call counters (lightweight observability).
 *
 * A privileged gateway should be able to answer "what has run through me, and how often did it
 * fail?" without standing up a metrics stack. This is the zero-dependency MVP of that: process-
 * lifetime counters incremented at the single tools/call chokepoint and surfaced via the HTTP
 * `/health` endpoint and the admin UI. It is NOT persistent (counts reset when the host restarts)
 * and NOT a substitute for the JSONL audit log (src/core/logger.js, which records individual events
 * to disk when enabled) - the two are complementary: the log is the durable per-event record, this
 * is the cheap live aggregate.
 *
 * Design rules (same discipline as logger.js):
 *   - Zero dependencies. Plain objects + integers.
 *   - record() / snapshot() NEVER throw - instrumentation must never break a tool call.
 *   - In-memory only; no files, no timers, no network.
 *
 * CommonJS only.
 */

// Distinct byTool entries are CAPPED: the key is the tools/call name exactly as the client sent it,
// including names that never existed, so an unbounded map let a client spraying fresh names grow
// the gateway's memory for the life of the process. Names seen before the cap keep their own
// counters; everything after lands in one overflow bucket. Totals stay exact either way.
const MAX_DISTINCT_TOOLS = 1000;
const OVERFLOW_KEY = '(other)';

const state = {
  startedAt: new Date().toISOString(),
  calls: 0,
  errors: 0,
  byTool: Object.create(null), // name -> { calls, errors }
  distinct: 0, // entries in byTool (the overflow bucket counts as one)
};

/**
 * record - count one tools/call outcome. `ok:false` (an isError result - a tool failure OR a
 * PreToolUse denial, which both surface as an error envelope) increments the error counters.
 * @param {{ tool?:string, ok?:boolean }} ev
 */
function record(ev) {
  try {
    const tool = ev && typeof ev.tool === 'string' && ev.tool.length > 0 ? ev.tool : 'unknown';
    const ok = !(ev && ev.ok === false);
    state.calls += 1;
    if (!ok) state.errors += 1;
    let t = state.byTool[tool];
    if (!t && state.distinct >= MAX_DISTINCT_TOOLS && tool !== OVERFLOW_KEY) {
      t = state.byTool[OVERFLOW_KEY]; // at the cap: an unseen name counts under the overflow bucket
      if (!t) { t = { calls: 0, errors: 0 }; state.byTool[OVERFLOW_KEY] = t; state.distinct += 1; }
    } else if (!t) {
      t = { calls: 0, errors: 0 };
      state.byTool[tool] = t;
      state.distinct += 1;
    }
    t.calls += 1;
    if (!ok) t.errors += 1;
  } catch (_e) {
    /* instrumentation must never break the caller */
  }
}

/**
 * snapshot - a fresh, mutation-safe copy of the counters for /health + the UI. NEVER throws.
 * @returns {{ startedAt:string, calls:number, errors:number, byTool:Object<string,{calls:number,errors:number}> }}
 */
function snapshot() {
  try {
    // Null-prototype like the source: into a plain {} a key of "__proto__" sets the PROTOTYPE
    // instead of a property, so that tool's counter silently vanished from /health and the UI.
    const byTool = Object.create(null);
    for (const k of Object.keys(state.byTool)) {
      byTool[k] = { calls: state.byTool[k].calls, errors: state.byTool[k].errors };
    }
    return { startedAt: state.startedAt, calls: state.calls, errors: state.errors, byTool };
  } catch (_e) {
    return { startedAt: state.startedAt, calls: 0, errors: 0, byTool: {} };
  }
}

/** reset - zero the counters (tests). The startedAt stamp is left as the process start. */
function reset() {
  state.calls = 0;
  state.errors = 0;
  state.byTool = Object.create(null);
  state.distinct = 0;
}

module.exports = { record, snapshot, reset };
