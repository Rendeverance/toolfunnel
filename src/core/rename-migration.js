'use strict';

/**
 * rename-migration.js - keep gates and per-tool state attached across a SURFACED-NAME change
 * (0.7.0; the rename-safety.test.js invariants are the acceptance).
 *
 * A tool's SURFACED name is the string the PreToolUse gate matches and the tools.state.json
 * key is written against. 0.6.0 let that name change (an expose `as` edit, an enabled flip, a
 * local display-name edit) while the gate matcher and the state key silently kept the OLD
 * string - a deny gate stopped firing and a disabled tool resurrected. The policy here,
 * MATCHER-MIGRATE-ON-RENAME:
 *
 *   - A WILDCARD matcher ('', '*', unset) fires for every tool name - it already covers the
 *     new name; untouched.
 *   - An EXACT-LITERAL matcher - the `escapeRegex(oldName)` shape every ToolFunnel surface
 *     (tf_* tools, the UI) writes - is REWRITTEN to `escapeRegex(newName)`.
 *   - Any OTHER matcher that would fire for the old name (same anchored-regex semantics as
 *     core/matcher.js, the gate's own matching) is one WE DID NOT AUTHOR and cannot safely
 *     rewrite: the rename is REFUSED with the hook named. Update the hook first, then rename.
 *   - tools.state.json: the old key's entry (enabled/hidden/hot) MOVES to the new key. A
 *     collision (both keys present with different content) refuses - never clobber curation.
 *
 * Validation runs COMPLETELY before the first write, and the caller invokes this BEFORE
 * persisting its own rename - a refusal leaves every file untouched.
 *
 * CommonJS only. Node built-ins + core/matcher only (core/ stays headless).
 */

const fs = require('node:fs');
const path = require('node:path');
const { matches, matcherError } = require('./matcher');

/** Regex-escape a literal so a matcher built from it FULL-matches the string verbatim.
 *  (Same shape as ui/server.js escapeRegex - the shape ToolFunnel-authored matchers use.) */
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Copied exactly from registry.js::atomicWriteJson - crash leaves old file or new, never half. */
function atomicWriteJson(targetPath, obj) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  const data = JSON.stringify(obj, null, 2) + '\n';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data, 0, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, targetPath);
}

function readJsonIfPresent(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_e) {
    return null; // absent or unreadable -> nothing to migrate there
  }
}

/**
 * Migrate every gate matcher and state key from oldName to newName, or throw a refusal.
 * @param {object} o
 * @param {string} o.hooksPath  hooks.manifest.json path (may be absent on disk)
 * @param {string} o.statePath  tools.state.json path (may be absent on disk)
 * @param {string} o.oldName    the surfaced name being retired
 * @param {string} o.newName    the surfaced name taking over
 */
function migrateSurfacedName(o) {
  const { hooksPath, statePath, oldName, newName } = o || {};
  if (typeof oldName !== 'string' || typeof newName !== 'string' || oldName === newName) return;

  // ── Phase A: VALIDATE everything, write nothing ─────────────────────────────────────────────
  const manifest = hooksPath ? readJsonIfPresent(hooksPath) : null;
  const hooks = manifest && Array.isArray(manifest.hooks) ? manifest.hooks : [];
  const literal = escapeRegex(oldName);
  const rewrites = [];
  for (const h of hooks) {
    if (!h || typeof h !== 'object') continue;
    const m = h.matcher;
    if (m === undefined || m === null || m === '' || m === '*') continue; // wildcard covers both names
    if (m === literal || m === oldName) {
      // The exact-literal shape ToolFunnel authors (escaped, or the bare name when it contains
      // no regex specials - the two are identical then, but hand-written manifests may carry
      // the bare form for a name that DOES contain specials, e.g. "my.tool").
      rewrites.push(h);
      continue;
    }
    // A matcher that does not COMPILE cannot be evaluated against oldName at all - matches()
    // would answer false, silently carrying the rename past a hook this code cannot read.
    // Same policy as a matching non-literal: refuse, name the hook, touch nothing.
    // (addEntry refuses these at authoring, so only a hand-edited manifest reaches here.)
    const compileProblem = matcherError(m);
    if (compileProblem) {
      throw new Error(
        `rename refused: hook "${h.id || '(unnamed)'}" matcher ${JSON.stringify(m)} does not ` +
        `compile (${compileProblem}) - it cannot be checked against "${oldName}", so the rename ` +
        'cannot proceed safely. Fix the hook first, then rename'
      );
    }
    if (matches(m, oldName)) {
      throw new Error(
        `rename refused: hook "${h.id || '(unnamed)'}" matcher "${m}" matches "${oldName}" but is ` +
        'not an exact-literal matcher ToolFunnel can rewrite - update the hook to cover ' +
        `"${newName}" first, then rename`
      );
    }
  }

  const state = statePath ? readJsonIfPresent(statePath) : null;
  const hasOldState = !!(state && Object.prototype.hasOwnProperty.call(state, oldName));
  if (hasOldState && Object.prototype.hasOwnProperty.call(state, newName) &&
      JSON.stringify(state[oldName]) !== JSON.stringify(state[newName])) {
    throw new Error(
      `rename refused: tools.state.json already has an entry for "${newName}" that differs from ` +
      `"${oldName}"'s - resolve the curation collision first, then rename`
    );
  }

  // ── Phase B: WRITE (all validation passed) ──────────────────────────────────────────────────
  if (rewrites.length) {
    for (const h of rewrites) h.matcher = escapeRegex(newName);
    atomicWriteJson(hooksPath, manifest);
  }
  if (hasOldState) {
    state[newName] = state[oldName];
    delete state[oldName];
    atomicWriteJson(statePath, state);
  }
}

/**
 * Convenience for the two stores: derive the sibling config paths from the CONFIG-HOME layout
 * (<root>/mcp/expose.json, <root>/tools/tools.register.json, <root>/tools/tools.state.json,
 * <root>/hooks/hooks.manifest.json) and migrate. `storeFilePath` is the calling store's own
 * file; its grandparent is the home root.
 *
 * `opts.migrateState` (default TRUE) selects whether the tools.state.json key moves with the
 * name. The gate matcher ALWAYS moves - it genuinely fires on the surfaced name for both stores.
 * The state key does NOT, because the overlay has TWO key namespaces:
 *   - UPSTREAM tools are keyed by their SURFACED name (server.js:638,733,924; ui:1273) - an
 *     expose `as` edit changes that key, so ExposeStore migrates state (the default).
 *   - LOCAL register tools are keyed by their register ID (server.js:290,337,814-815,952;
 *     ui:326-328; tf-tool-set.js) - an id is immutable and a display-name edit does not touch
 *     it, so Registry passes migrateState:false. Moving the key there would ORPHAN the entry:
 *     the readers still look up the id, find nothing, and fall back to the defaults - which are
 *     enabled - so a tool deliberately switched off would come back on (rename-safety S5).
 *     Bites whenever name === id, i.e. every tf_* management tool.
 */
function migrateForStoreFile(storeFilePath, oldName, newName, opts) {
  const root = path.dirname(path.dirname(path.resolve(storeFilePath)));
  const migrateState = !(opts && opts.migrateState === false);
  migrateSurfacedName({
    hooksPath: path.join(root, 'hooks', 'hooks.manifest.json'),
    statePath: migrateState ? path.join(root, 'tools', 'tools.state.json') : null,
    oldName,
    newName,
  });
}

module.exports = { migrateSurfacedName, migrateForStoreFile, escapeRegex };
