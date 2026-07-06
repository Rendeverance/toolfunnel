#!/usr/bin/env node
'use strict';

/**
 * tf-list.js — a READ-ONLY management inventory tool (category "management").
 *
 * Purpose
 * -------
 * One first-party register function that answers "what is configured, and what is
 * its live state?" across the three stores the gateway owns:
 *   - tools → the persisted Tool Register + the ACTIVE/DISABLED + hidden overlay.
 *   - mcps  → the expose store: upstream MCPs and their curated-direct exposes.
 *   - hooks → the hook manifest + the per-hook enabled-state overlay.
 *
 * It is discovered via list_tools and executed via run_tool through the PreToolUse
 * gate. It does NOT add new MCP-protocol commands; it is a "gateway-run" script
 * that reads the gateway's own config files. READ-ONLY: no writes, no network,
 * no process mutation.
 *
 * Contract with the register (registry.js `defaultRunScript`)
 * -----------------------------------------------------------
 *   - Structured args arrive as a JSON string in env TOOLFUNNEL_TOOL_ARGS ({} if
 *     absent). The only arg is { kind: "tools" | "mcps" | "hooks" }.
 *   - Prints EXACTLY ONE JSON line to stdout and exits 0 — ALWAYS exit 0. A bad
 *     kind, a missing/malformed config, or any other logical error is reported as
 *     { ok:false, error } (still exit 0), never a crash.
 *
 * Output (stdout), exactly one JSON object:
 *   success: { ok:true, kind, items:[ ... ] }
 *   failure: { ok:false, error }
 *
 * Per-kind item shapes:
 *   tools  → register brief { id, name, summary, category } annotated with the
 *            overlay-derived { enabled, hidden }.
 *   mcps   → one item per upstream MCP (its full config incl. `enabled`) with its
 *            curated-direct `exposed` entries nested (each carrying its resolved
 *            downstream `name` and `enabled` flag). Uses listUpstreams() +
 *            listExposed() and groups exposes under their owning upstream.
 *   hooks  → one item per manifest hook (full spec) with `enabled` resolved from
 *            the persisted overlay (readState) when present, else the manifest flag.
 *
 * Safety invariants (defense-in-depth; mirror the isolation rule):
 *   - READ-ONLY: only reads config files INSIDE the toolfunnel root, resolved from
 *     THIS script's own location (__dirname) — never a caller-supplied path.
 *   - NO network, NO writes, NO process mutation.
 *   - NEVER throws for ordinary conditions — only well-shaped JSON on stdout.
 */

const path = require('node:path');

// HOME/engine resolution shared by every tf-* script (see tf-env.js): the config lives beside
// this script (the git-clone root OR a seeded external config home); the engine code is required
// from the package that spawned us when it is not local.
const { HOME, srcRequire } = require('./tf-env');
const { loadRegistry } = srcRequire('tools/registry');
const { loadToolState, isToolEnabled, isToolHidden } = srcRequire('tools/tool-state');
const { loadExposeStore } = srcRequire('mcp/expose-store');
const { loadManifest } = srcRequire('core/hook-loader');

const ROOT = HOME;

// Canonical store paths (see the script contract).
const REGISTER_PATH = path.join(ROOT, 'tools', 'tools.register.json');
const STATE_PATH = path.join(ROOT, 'tools', 'tools.state.json');
const EXPOSE_PATH = path.join(ROOT, 'mcp', 'expose.json');
const MANIFEST_PATH = path.join(ROOT, 'hooks', 'hooks.manifest.json');
const SCRIPTS_ROOT = path.join(ROOT, 'tools', 'scripts');

/**
 * Parse the structured args from env. Never throws: a missing/blank/malformed
 * TOOLFUNNEL_TOOL_ARGS yields {} so the kind check below produces a clean
 * { ok:false, error } rather than a crash.
 * @returns {object}
 */
function readArgs() {
  const raw = process.env.TOOLFUNNEL_TOOL_ARGS;
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_err) {
    return {};
  }
}

/**
 * tools → register briefs annotated with the overlay's enabled + hidden state. HIDDEN tools are a
 * manager-view declutter: they are OMITTED by default and only included when args.includeHidden is
 * true. (This is the manager surface only — `hidden` never affects the lean list / top-level surface
 * the connected AI sees.)
 * @param {object} [args]  { includeHidden?: boolean }
 * @returns {Array<{id,name,summary,category,enabled,hidden}>}
 */
function listTools(args) {
  const includeHidden = !!(args && args.includeHidden === true);
  const registry = loadRegistry(REGISTER_PATH, { scriptsRoot: SCRIPTS_ROOT });
  const state = loadToolState(STATE_PATH);
  return registry.list()
    .map((brief) => ({
      ...brief,
      enabled: isToolEnabled(state, brief.id),
      hidden: isToolHidden(state, brief.id),
    }))
    .filter((t) => includeHidden || !t.hidden); // declutter: omit hidden unless explicitly asked
}

/**
 * mcps → one item per upstream MCP, with its curated-direct exposes nested.
 * Uses listUpstreams() for the connection config (incl. `enabled`) and
 * listExposed() for the surfaced tools, grouping each expose under its owning
 * upstream and resolving the downstream name via exposedName().
 * @returns {Array<object>}
 */
function listMcps() {
  const store = loadExposeStore(EXPOSE_PATH);
  const upstreams = store.listUpstreams();
  const exposed = store.listExposed();

  // Group exposes by their upstream id (every expose references an existing
  // upstream — addExpose requires it and removeUpstream cascades — but default
  // to an empty list so an unmatched entry never throws).
  const byUpstream = new Map();
  for (const e of exposed) {
    const annotated = { ...e, name: store.exposedName(e) };
    const bucket = byUpstream.get(e.upstream);
    if (bucket) bucket.push(annotated);
    else byUpstream.set(e.upstream, [annotated]);
  }

  return upstreams.map((u) => ({
    ...u,
    exposed: byUpstream.get(u.id) || [],
  }));
}

/**
 * hooks → one item per manifest hook with `enabled` resolved from the persisted
 * overlay (readState) when it carries the hook id, else the manifest's own flag.
 * loadManifest already applies the overlay over the in-memory specs, but we read
 * the overlay explicitly so the resolved `enabled` is correct regardless of that.
 * @returns {Array<object>}
 */
function listHooks() {
  const loader = loadManifest(MANIFEST_PATH);
  const overlay = loader.readState();
  return loader.hooks.map((h) => {
    const hasOverride = h && typeof h.id === 'string' &&
      Object.prototype.hasOwnProperty.call(overlay, h.id);
    const enabled = hasOverride ? overlay[h.id] === true : h.enabled === true;
    return { ...h, enabled };
  });
}

/**
 * Build the inventory for the requested kind. Throws on an unknown kind so main()
 * can surface it as { ok:false, error }.
 * @param {object} args
 * @returns {{ ok:true, kind:string, items:Array<object> }}
 */
function build(args) {
  const kind = args && args.kind;
  let items;
  switch (kind) {
    case 'tools':
      items = listTools(args); // honours args.includeHidden (hidden tools omitted by default)
      break;
    case 'mcps':
      items = listMcps();
      break;
    case 'hooks':
      items = listHooks();
      break;
    default:
      throw new Error(`tf-list: kind must be one of "tools"|"mcps"|"hooks" (got ${JSON.stringify(kind)})`);
  }
  return { ok: true, kind, items };
}

function main() {
  let payload;
  try {
    payload = build(readArgs());
  } catch (err) {
    // Any logical error (bad kind, missing/malformed store) becomes a well-shaped
    // failure line. Still exit 0 — the gated runner treats parseable stdout as ok.
    payload = { ok: false, error: (err && err.message) || String(err) };
  }
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(0);
}

main();
