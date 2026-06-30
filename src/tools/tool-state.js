'use strict';

/**
 * tool-state.js — per-tool ACTIVE/DISABLED overlay for the register.
 *
 * Mirrors a sibling state overlay (see a config file): a small
 * overlay keyed by tool id, written atomically, loaded on startup → survives
 * close/detach (persistent session-to-session). The register (tools.register.json)
 * holds ALL tools; this overlay decides which are surfaced to toolfunnel_list_tools.
 *
 * DEFAULT ON: a tool absent from the overlay is ACTIVE. Only an explicit
 * { enabled: false } disables it. So newly-added tools are active until you
 * untick them — and the file only ever lists the tools you've toggled.
 *
 * THREE independent axes (the visibility MATRIX), all keyed by the surfaced name
 * (a local tool id, OR an upstream's surfaced name `<upstream>_<tool>` / its `as`,
 * OR a meta-tool name like `toolfunnel_list_tools`):
 *   - enabled : LEAN-VISIBLE — surfaced by toolfunnel_list_tools AND runnable. Default ON.
 *   - hidden  : manager-list declutter only (UI/tf_list). Default OFF. INDEPENDENT of enabled.
 *   - hot     : promoted to the TOP-LEVEL tools/list (injected EVERY turn). Default depends on
 *               the tool KIND, supplied by the caller via isToolHot(state,id,defaultHot):
 *               meta-tools default hot:true (the management surface), local/upstream default
 *               hot:false (opt-in promotion). A disabled tool is never hot.
 *
 * Shape of tools.state.json:  { "<id>": { "enabled": false, "hidden": true, "hot": true }, ... }
 *
 * CommonJS, Node built-ins only. Reuses registry.js's atomicWriteJson (temp+rename).
 */

const fs = require('node:fs');
const { atomicWriteJson } = require('./registry');

/** Load the overlay ({} if missing/malformed — never throws). */
function loadToolState(statePath) {
  try {
    const d = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  } catch (_e) {
    return {};
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

/** Default OFF for local/upstream, ON for meta — the caller supplies the kind-appropriate
 * `defaultHot`. An explicit boolean in the overlay always wins; absence falls back to the
 * default. `hot` is the TOP-LEVEL (every-turn) promotion axis — INDEPENDENT of enabled/hidden,
 * though a disabled tool is filtered out of the top-level surface by the assembler, not here. */
function isToolHot(state, id, defaultHot) {
  const e = state && state[id];
  if (e && typeof e.hot === 'boolean') return e.hot;
  return !!defaultHot;
}

/** Set a tool's enabled flag, MERGING (so `hidden`/`hot` are preserved). Persists atomically. */
function setToolEnabled(statePath, id, enabled) {
  if (typeof id !== 'string' || !id) throw new Error('setToolEnabled: id required');
  const s = loadToolState(statePath);
  s[id] = { ...(s[id] || {}), enabled: !!enabled };
  atomicWriteJson(statePath, s);
  return s;
}

/** Set a tool's hot flag, MERGING (so `enabled`/`hidden` are preserved). Persists atomically. */
function setToolHot(statePath, id, hot) {
  if (typeof id !== 'string' || !id) throw new Error('setToolHot: id required');
  const s = loadToolState(statePath);
  s[id] = { ...(s[id] || {}), hot: !!hot };
  atomicWriteJson(statePath, s);
  return s;
}

/** Set a tool's hidden flag, MERGING (so `enabled` is preserved). Persists atomically. */
function setToolHidden(statePath, id, hidden) {
  if (typeof id !== 'string' || !id) throw new Error('setToolHidden: id required');
  const s = loadToolState(statePath);
  s[id] = { ...(s[id] || {}), hidden: !!hidden };
  atomicWriteJson(statePath, s);
  return s;
}

/** Drop a tool's overlay entry entirely (revert to defaults: active + not hidden).
 * No-op if the id was never toggled. Persists atomically. */
function clearToolState(statePath, id) {
  if (typeof id !== 'string' || !id) throw new Error('clearToolState: id required');
  const s = loadToolState(statePath);
  delete s[id];
  atomicWriteJson(statePath, s);
  return s;
}

module.exports = { loadToolState, isToolEnabled, isToolHidden, isToolHot, setToolEnabled, setToolHidden, setToolHot, clearToolState };
