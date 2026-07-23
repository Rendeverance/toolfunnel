'use strict';

/**
 * config-home.js - WHERE the gateway's mutable config lives (board item 9, the packaging enabler).
 *
 * The problem this solves: an npm/npx-installed gateway keeps its config INSIDE the package
 * directory, so `npm update toolfunnel` replaces the package tree and EATS the user's tools,
 * hooks, curation, and identity. Config must be able to live in a home of its own:
 *
 *   resolution precedence:  --config-dir flag  >  TOOLFUNNEL_HOME env  >  the package root
 *
 * The default is UNCHANGED: a git clone keeps everything in the repo root exactly as before
 * (home === package root, no seeding, byte-identical behaviour). Pointing TOOLFUNNEL_HOME at an
 * empty directory makes the gateway SEED it on first use - the shipped register + its scripts, an
 * empty expose.json, the default hooks manifest - and every mutable path (tools/ mcp/ hooks/
 * auth/ logs/ toolfunnel.json packages/) anchors there from then on. Seeding never overwrites an
 * existing file, so a home survives package updates by construction.
 *
 * Two env vars are the process-tree contract (children inherit them via defaultRunScript's
 * spawn env):
 *   TOOLFUNNEL_HOME - the resolved ABSOLUTE config home (normalised at init so a relative value
 *                     can't skew between processes with different cwds).
 *   TOOLFUNNEL_PKG  - the package root of the gateway that spawned the tool, so a management
 *                     script SEEDED INTO an external home can still require the engine code
 *                     (src/...) it was copied away from. A script always prefers its own
 *                     __dirname-derived root when that root contains the engine (the git-clone
 *                     layout), so a stale inherited value can never shadow a real local install.
 *
 * Zero new dependencies. Node built-ins only.
 */

const fs = require('node:fs');
const path = require('node:path');

/** The package root: this file lives at <pkg>/src/core/config-home.js. */
const PKG_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Resolve the config home. Pure - no filesystem writes, no env mutation.
 * @param {{dir?: string}} [opts]  dir = an explicit --config-dir value (wins over the env)
 * @returns {string} absolute config-home path
 */
function resolveConfigHome(opts) {
  const o = opts || {};
  const fromFlag = typeof o.dir === 'string' && o.dir.trim().length > 0 ? o.dir.trim() : null;
  const fromEnv = typeof process.env.TOOLFUNNEL_HOME === 'string' && process.env.TOOLFUNNEL_HOME.trim().length > 0
    ? process.env.TOOLFUNNEL_HOME.trim()
    : null;
  const chosen = fromFlag || fromEnv;
  return chosen ? path.resolve(chosen) : PKG_ROOT;
}

/** Recursively copy a directory, skipping any destination file that already exists. */
function copyTreeIfAbsent(srcDir, destDir, seeded) {
  let entries;
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch (_e) {
    return; // a missing source dir seeds nothing (defensive)
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const e of entries) {
    const from = path.join(srcDir, e.name);
    const to = path.join(destDir, e.name);
    if (e.isDirectory()) {
      copyTreeIfAbsent(from, to, seeded);
    } else if (e.isFile() && !fs.existsSync(to)) {
      fs.copyFileSync(from, to);
      seeded.push(to);
    }
  }
}

/**
 * Make `home` a working config home, seeding whatever is ABSENT from the shipped defaults.
 * Idempotent and never destructive: an existing file is NEVER overwritten (a home must survive
 * package updates - that is the whole point). home === package root -> a no-op (the git-clone
 * layout is already complete). Throws only if the home cannot be created at all.
 *
 * Deliberately NOT seeded: tools.state.json (absent = default visibility), auth/ (absent = auth
 * off), logs/ (absent = logging off), toolfunnel.json (absent = the default identity - an
 * npm-wrap ships its OWN copy inside its bundled home).
 *
 * @param {string} home  absolute config-home path (from resolveConfigHome)
 * @returns {{home: string, seeded: string[]}} the files seeded on THIS call (empty = was complete)
 */
function ensureConfigHome(home) {
  const seeded = [];
  if (path.resolve(home) === PKG_ROOT) return { home: PKG_ROOT, seeded };
  fs.mkdirSync(home, { recursive: true });

  // The register + every shipped script (management tf_* + demo tools). The management scripts
  // are config-tree citizens (the register's invoke paths point at them), so they travel.
  copyTreeIfAbsent(path.join(PKG_ROOT, 'tools'), path.join(home, 'tools'), seeded);
  // The state overlay is user-state, not a shipped default - drop a copied one if the package
  // tree happened to carry local toggles (dev clone); a FRESH home starts with default visibility.
  const strayState = path.join(home, 'tools', 'tools.state.json');
  if (seeded.includes(strayState)) {
    try { fs.unlinkSync(strayState); } catch (_e) { /* best-effort */ }
    seeded.splice(seeded.indexOf(strayState), 1);
  }

  // The upstream/curation store and the hooks tree. NOTE the npm tarball ships
  // mcp/expose.example.json but NOT mcp/expose.json (the live store is user-state), so after the
  // tree copy the live store is synthesised EMPTY when absent. Never seed it from the example -
  // the example is a POPULATED demo (it attaches the mock upstream), and a fresh home must start
  // connected to nothing, exactly like a fresh clone.
  copyTreeIfAbsent(path.join(PKG_ROOT, 'mcp'), path.join(home, 'mcp'), seeded);
  const exposePath = path.join(home, 'mcp', 'expose.json');
  if (!fs.existsSync(exposePath)) {
    fs.mkdirSync(path.dirname(exposePath), { recursive: true });
    fs.writeFileSync(exposePath, JSON.stringify({ version: 1, upstreams: [], expose: [] }, null, 2) + '\n');
    seeded.push(exposePath);
  }
  copyTreeIfAbsent(path.join(PKG_ROOT, 'hooks'), path.join(home, 'hooks'), seeded);
  return { home, seeded };
}

/**
 * The one-call init used by bin/toolfunnel.js for every mode: resolve, seed, and write the
 * process-tree contract back into the env (see the header) so every module loaded AFTER this -
 * and every child tool spawned later - reads the same resolved home.
 * @param {{dir?: string}} [opts]
 * @returns {{home: string, seeded: string[]}}
 */
function initConfigHome(opts) {
  const home = resolveConfigHome(opts);
  const res = ensureConfigHome(home);
  process.env.TOOLFUNNEL_HOME = res.home;
  process.env.TOOLFUNNEL_PKG = PKG_ROOT;
  return res;
}

module.exports = { PKG_ROOT, resolveConfigHome, ensureConfigHome, initConfigHome };
