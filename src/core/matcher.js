'use strict';

/**
 * matcher.js - does a hook's matcher string fire for a given tool? (HOOK_ENGINE.md §5)
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
  // ignored and the hook always fires (§5). This is checked AFTER the wildcard
  // case so a "*" matcher is handled uniformly, and BEFORE we attempt a regex
  // (which would otherwise need a string to test).
  if (toolName === undefined || toolName === null) {
    return true;
  }

  // Anything else is a regex, anchored as a full match against toolName.
  // We wrap in ^(?:...)$ so alternations like "Bash|Write" mean "the whole tool
  // name is one of these", not "contains one of these".
  let re;
  try {
    re = new RegExp(`^(?:${matcher})$`);
  } catch (err) {
    // A malformed matcher must never throw out of the engine. Treat an
    // uncompilable pattern as "does not match" - fail closed, stay defensive.
    return false;
  }

  return re.test(toolName);
}

module.exports = { matches };
