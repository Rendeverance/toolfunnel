'use strict';

/**
 * matcher.js - does a hook's matcher string fire for a given tool?
 *
 * Mirrors Claude Code's matcher semantics:
 *   - ""  | undefined | "*"  -> always fire (wildcard).
 *   - otherwise the matcher is a regex, anchored as a FULL match against toolName
 *     (e.g. "Bash|Write|Edit").
 *   - tool-less events (SessionStart, UserPromptSubmit, Stop, PreCompact) pass
 *     toolName == null/undefined -> always fire (the matcher is ignored).
 *
 * CommonJS only. Zero host imports (core/ must run headless under node --test).
 */

// One compile per distinct matcher string. matches() sits on the gate's hot path (every
// hook x every tool call), and rebuilding `^(?:Bash|Write|Edit)$` per call was pure waste:
// RegExp construction is a deterministic function of the string and ours carries no flags
// (no g/y -> no lastIndex state), so memoising by the string can never change an answer.
// Invalidation is by construction, not by event: a reloaded manifest's new matcher is a
// NEW string -> a new key; the old entry just goes unused. Failed compiles memoise too
// (a malformed matcher answers false without a fresh throw per call). The cap is a
// backstop against degenerate dynamically-generated matchers: past it the memo resets -
// worst case is exactly the old per-call compile, never unbounded growth or a wrong fire.
const COMPILE_CACHE_MAX = 256;
const compileCache = new Map(); // String(matcher) -> { re: RegExp|null, err: string|null }

/**
 * The memoised compile shared by matches() / matcherError(). Keyed on String(matcher) so a
 * non-string matcher coerces exactly as the template literal always did.
 * @param {*} matcher
 * @returns {{ re: RegExp|null, err: string|null }}
 */
function compiled(matcher) {
  const key = String(matcher);
  let hit = compileCache.get(key);
  if (hit) return hit;
  try {
    hit = { re: new RegExp(`^(?:${key})$`), err: null };
  } catch (err) {
    hit = { re: null, err: (err && err.message) || String(err) };
  }
  if (compileCache.size >= COMPILE_CACHE_MAX) compileCache.clear();
  compileCache.set(key, hit);
  return hit;
}

/**
 * @param {string|undefined|null} matcher  the hook's matcher string.
 * @param {string|undefined|null} toolName the tool the model requested, or
 *        null/undefined for events without a tool.
 * @returns {boolean} true if the hook should fire for this tool.
 */
function matches(matcher, toolName) {
  // Wildcard / unset matcher -> always fire, regardless of tool.
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') {
    return true;
  }

  // Tool-less events: there is nothing to match against, so the matcher is
  // ignored and the hook always fires. This is checked AFTER the wildcard
  // case so a "*" matcher is handled uniformly, and BEFORE we attempt a regex
  // (which would otherwise need a string to test).
  if (toolName === undefined || toolName === null) {
    return true;
  }

  // Anything else is a regex, anchored as a full match against toolName.
  // We wrap in ^(?:...)$ so alternations like "Bash|Write" mean "the whole tool
  // name is one of these", not "contains one of these".
  const c = compiled(matcher);
  if (!c.re) {
    // A malformed matcher must never throw out of the engine, and matches() cannot
    // claim a fire it could not evaluate - so this answers false. That is NOT
    // permission to proceed: callers that gate on the answer must distinguish
    // "did not match" from "could not be read" via matcherError() (hook-engine
    // denies the call; hook-loader.addEntry refuses to store the matcher at all).
    return false;
  }

  return c.re.test(toolName);
}

/**
 * Why does this matcher NOT compile? Returns null for a wildcard/unset matcher or one that
 * compiles under the same ^(?:...)$ anchoring matches() applies; otherwise the compile error's
 * message. This is the discriminator between "did not match" and "could not be read":
 * authoring surfaces (hook-loader.addEntry, and through it the UI and tf_hook_add) use it to
 * REFUSE a pattern that can never be evaluated, and hook-engine.fire treats a non-null answer
 * on a tool-bearing event as an unreadable gate and denies the call (matcher-compile.test.js).
 *
 * @param {string|undefined|null} m the hook's matcher string.
 * @returns {string|null} the compile problem, or null when the matcher is usable.
 */
function matcherError(m) {
  if (m === undefined || m === null || m === '' || m === '*') return null;
  return compiled(m).err;
}

module.exports = { matches, matcherError };
