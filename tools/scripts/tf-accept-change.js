#!/usr/bin/env node
/**
 * tf-accept-change.js - the tf_accept_change management tool (tool descriptor approval).
 *
 * When an upstream's tool changes its description or schema while the server version stays the
 * same, the gateway keeps serving the APPROVED descriptor and refuses calls to the tool, returning
 * which fields changed and this tool as the way to accept (the new text itself is shown only in
 * `toolfunnel changes` and the UI). The agent is meant to ASK THE USER
 * first; the call is gated by PreToolUse like every register tool, and so is the in-chat accept a
 * 2026-07-28 client gets (the gateway gates it as tf_accept_change).
 *
 * Contract (same as the other tf-* scripts):
 *   - Args arrive as JSON in env TOOLFUNNEL_TOOL_ARGS: { upstream, tool, hash }, all required:
 *       an agent accepts exactly the change the user was shown - one tool, at the hash from the
 *       refusal (a server that changed again is not approved sight unseen). Accepting several
 *       at once is for the user: `toolfunnel accept <upstream>` or the UI.
 *   - Output: ONE JSON line { ok, accepted, pending, error? }; exit 0 either way.
 *   - The logic lives in the engine (tool-approvals.js acceptInFile), shared with the CLI, the UI
 *     and the gateway; this script only adapts it. The running gateway applies the accept on the
 *     next call (it re-reads the file) and its file watcher refreshes the listings.
 */

const path = require('node:path');
// Shared HOME/engine resolution (see tf-env.js): config beside us, engine from the package.
const { HOME, srcRequire } = require('./tf-env');
const approvals = srcRequire('mcp/tool-approvals');

const APPROVALS_PATH = path.join(HOME, 'mcp', 'tool-approvals.json');

function parseArgs() {
  const raw = process.env.TOOLFUNNEL_TOOL_ARGS;
  if (raw === undefined || raw === null || raw === '') return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TOOLFUNNEL_TOOL_ARGS must be a JSON object');
  }
  return parsed;
}

function run() {
  const a = parseArgs();
  if (typeof a.upstream !== 'string' || a.upstream.length === 0) throw new Error('"upstream" (the upstream id) is required');
  if (typeof a.tool !== 'string' || a.tool.length === 0) throw new Error('"tool" (the changed tool\'s name, from the refusal) is required');
  if (typeof a.hash !== 'string' || a.hash.length === 0) throw new Error('"hash" (from the refusal) is required');
  const res = approvals.acceptInFile(APPROVALS_PATH, a.upstream, a.tool, a.hash);
  const why = approvals.acceptFailure(res, a.upstream, a.tool);
  if (why) {
    return {
      ok: false, accepted: [], pending: res.pending || [],
      error: why + (res.stale ? '. Call the tool once more to see the current change, and ask the user again.' : ''),
    };
  }
  return { ok: true, accepted: res.accepted, pending: res.pending, note: 'The running gateway applies this from the next call.' };
}

function main() {
  let payload;
  try {
    payload = run();
  } catch (err) {
    payload = { ok: false, accepted: [], pending: [], error: (err && err.message) || String(err) };
  }
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(0);
}

main();
