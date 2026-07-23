'use strict';

/**
 * tool-state.js - per-tool ACTIVE/DISABLED overlay for the register.
 *
 * Mirrors a sibling state overlay (see a config file): a small
 * overlay keyed by tool id, written atomically, loaded on startup -> survives
 * close/detach (persistent session-to-session). The register (tools.register.json)
 * holds ALL tools; this overlay decides which are surfaced to toolfunnel_list_tools.
 *
 * DEFAULT ON: a tool absent from the overlay is ACTIVE. Only an explicit
 * { enabled: false } disables it. So newly-added tools are active until you
 * untick them - and the file only ever lists the tools you've toggled.
 *
 * THREE independent axes (the visibility MATRIX), all keyed by the surfaced name
 * (a local tool id, OR an upstream's surfaced name `<upstream>_<tool>` / its `as`,
 * OR a meta-tool name like `toolfunnel_list_tools`):
 *   - enabled : LEAN-VISIBLE - surfaced by toolfunnel_list_tools AND runnable. Default ON.
 *   - hidden  : manager-list declutter only (UI/tf_list). Default OFF. INDEPENDENT of enabled.
 *   - hot     : promoted to the TOP-LEVEL tools/list (injected EVERY turn). Default depends on
 *               the tool KIND, supplied by the caller via isToolHot(state,id,defaultHot):
 *               meta-tools default hot:true (the management surface), local/upstream default
 *               hot:false (opt-in promotion). A disabled tool is never hot.
 *
 * Shape of tools.state.json:  { "<id>": { "enabled": false, "hidden": true, "hot": true }, ... }
 *
 * PASSTHROUGH (0.6.0): one RESERVED top-level key, `"passthrough": "<upstreamId>"` (a STRING,
 * unambiguous against the per-tool object entries). When set, the gateway becomes a transparent
 * wrapper for that one upstream: its tools ARE the advertised surface (real schemas, implicitly
 * hot), the meta-tools and everything else are hidden and uncallable, and every call still fires
 * the PreToolUse gate. An explicit `enabled:false` on an upstream tool is still honoured (the
 * safety off-switch survives the wrap). Set/cleared by `toolfunnel wrap <id>` / `wrap --off`.
 *
 * CommonJS, Node built-ins only. Reuses registry.js's atomicWriteJson (temp+rename).
 */

const fs = require('node:fs');
const { atomicWriteJson } = require('./registry');

/** Load the overlay ({} if missing/malformed - never throws). */
function loadToolState(statePath) {
  try {
    const d = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  } catch (_e) {
    return {};
  }
}

/**
 * Like loadToolState, but distinguishes "file MISSING" (defaults are correct) from "file PRESENT
 * but unparseable / not an object" (a corrupt overlay - the caller may want to fail closed or warn
 * rather than silently serve defaults). Returns { state, parseError }. `parseError` is true ONLY
 * when the file exists but could not be read as a JSON object. NEVER throws.
 * @param {string} statePath
 * @returns {{ state: object, parseError: boolean }}
 */
function loadToolStateResult(statePath) {
  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (_e) {
    return { state: {}, parseError: false }; // missing (or unreadable) -> defaults, not a corruption
  }
  try {
    const d = JSON.parse(raw);
    if (d && typeof d === 'object' && !Array.isArray(d)) return { state: d, parseError: false };
    return { state: {}, parseError: true }; // present but not a JSON object
  } catch (_e) {
    return { state: {}, parseError: true }; // present but not valid JSON
  }
}

/** Default ON: enabled unless the overlay explicitly says enabled:false. */
function isToolEnabled(state, id) {
  const e = state && state[id];
  return !(e && e.enabled === false);
}

/** Default NOT hidden: hidden only when the overlay explicitly says hidden:true.
 * `hidden` is a manager-list-only flag (declutter); it is INDEPENDENT of `enabled`
 * (MCP visibility). A tool can be active-but-hidden, or disabled-but-visible. */
function isToolHidden(state, id) {
  const e = state && state[id];
  return !!(e && e.hidden === true);
}

/** Default OFF for local/upstream, ON for meta - the caller supplies the kind-appropriate
 * `defaultHot`. An explicit boolean in the overlay always wins; absence falls back to the
 * default. `hot` is the TOP-LEVEL (every-turn) promotion axis - INDEPENDENT of enabled/hidden,
 * though a disabled tool is filtered out of the top-level surface by the assembler, not here. */
function isToolHot(state, id, defaultHot) {
  const e = state && state[id];
  if (e && typeof e.hot === 'boolean') return e.hot;
  return !!defaultHot;
}

/** The one top-level key reserved for the passthrough wrap (a STRING value). A per-tool overlay
 *  entry may NEVER use this key, else a per-tool toggle would clobber (or be clobbered by) the wrap
 * - they share the same flat object. The per-tool setters reject
 *  it; a tool whose surfaced name is literally "passthrough" simply cannot carry an overlay entry
 *  (it stays at defaults - enabled, not hot, not hidden), which is a fine, safe degradation. */
const RESERVED_PASSTHROUGH_KEY = 'passthrough';
function assertNotReserved(id, fn) {
  if (id === RESERVED_PASSTHROUGH_KEY) {
    throw new Error(`${fn}: "${RESERVED_PASSTHROUGH_KEY}" is a reserved state key (the passthrough wrap) and cannot be a per-tool id`);
  }
}

/** Set a tool's enabled flag, MERGING (so `hidden`/`hot` are preserved). Persists atomically. */
function setToolEnabled(statePath, id, enabled) {
  if (typeof id !== 'string' || !id) throw new Error('setToolEnabled: id required');
  assertNotReserved(id, 'setToolEnabled');
  const s = loadToolState(statePath);
  s[id] = { ...(s[id] || {}), enabled: !!enabled };
  atomicWriteJson(statePath, s);
  return s;
}

/** Set a tool's hot flag, MERGING (so `enabled`/`hidden` are preserved). Persists atomically. */
function setToolHot(statePath, id, hot) {
  if (typeof id !== 'string' || !id) throw new Error('setToolHot: id required');
  assertNotReserved(id, 'setToolHot');
  const s = loadToolState(statePath);
  s[id] = { ...(s[id] || {}), hot: !!hot };
  atomicWriteJson(statePath, s);
  return s;
}

/** Set a tool's hidden flag, MERGING (so `enabled` is preserved). Persists atomically. */
function setToolHidden(statePath, id, hidden) {
  if (typeof id !== 'string' || !id) throw new Error('setToolHidden: id required');
  assertNotReserved(id, 'setToolHidden');
  const s = loadToolState(statePath);
  s[id] = { ...(s[id] || {}), hidden: !!hidden };
  atomicWriteJson(statePath, s);
  return s;
}

/** Drop a tool's overlay entry entirely (revert to defaults: active + not hidden).
 * No-op if the id was never toggled. Persists atomically. */
function clearToolState(statePath, id) {
  if (typeof id !== 'string' || !id) throw new Error('clearToolState: id required');
  assertNotReserved(id, 'clearToolState'); // a register tool id'd "passthrough" must not clear a live wrap
  const s = loadToolState(statePath);
  delete s[id];
  atomicWriteJson(statePath, s);
  return s;
}

/** The active passthrough upstream id, or null. Only a non-empty STRING value counts - a
 * per-tool object entry that happens to be keyed "passthrough" is not a wrap. */
function getPassthrough(state) {
  const v = state && state.passthrough;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Set (a non-empty string) or clear (null/'') the passthrough wrap. Persists atomically. */
function setPassthrough(statePath, upstreamId) {
  const s = loadToolState(statePath);
  if (typeof upstreamId === 'string' && upstreamId.length > 0) {
    s.passthrough = upstreamId;
  } else {
    delete s.passthrough;
  }
  atomicWriteJson(statePath, s);
  return s;
}

module.exports = { loadToolState, loadToolStateResult, isToolEnabled, isToolHidden, isToolHot, setToolEnabled, setToolHidden, setToolHot, clearToolState, getPassthrough, setPassthrough };
