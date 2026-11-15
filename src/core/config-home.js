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
 * existing file, so a home survives package updates by construction; the one addition is a tool
 * new in a release, appended to the register once (offerNewShippedTools).
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
const { atomicWriteJson } = require('./atomic-write');

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
  // A home the user has made read-only still starts: what cannot be written is not seeded, and the
  // gateway runs with the files the home already has. Any other failure is real and is thrown.
  if (!writeOrSkip(() => fs.mkdirSync(destDir, { recursive: true }))) return;
  for (const e of entries) {
    const from = path.join(srcDir, e.name);
    const to = path.join(destDir, e.name);
    if (e.isDirectory()) {
      copyTreeIfAbsent(from, to, seeded);
    } else if (e.isFile() && !fs.existsSync(to)) {
      if (writeOrSkip(() => fs.copyFileSync(from, to))) seeded.push(to);
    }
  }
}

/** Runs a write; false when the file system refuses it for permission (the caller skips that file). */
function writeOrSkip(write) {
  try {
    write();
    return true;
  } catch (e) {
    if (e && (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS')) return false;
    throw e;
  }
}

// The shipped register ids of 0.7.x, the releases before tools/tools.seeded.json existed: a home
// upgraded from one of them has already been offered these, so only tools shipped since are added.
const SHIPPED_BEFORE_LEDGER = ['echo', 'base64', 'hash', 'uuid', 'json', 'text-stats', 'danger',
  'tf_tool_add', 'tf_tool_set', 'tf_mcp_add', 'tf_mcp_set', 'tf_wrap', 'tf_hook_add', 'tf_hook_set',
  'tf_list', 'tf_log', 'tf_pack'];

// Windows paths are case-insensitive: g:\dev\toolfunnel IS the package root.
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_e) { return null; } };

/**
 * Add the shipped register entries this home has never been offered, once each. The ledger
 * (tools/tools.seeded.json) records every id offered, so a shipped tool the user deleted is never
 * added back; existing entries are never touched, and an unreadable register or ledger is left
 * alone. Seeding alone cannot do this: it never overwrites a file, and the register is one file.
 * @param {string}  home
 * @param {boolean} registerSeeded  the register was copied in on this call (a fresh home)
 * @returns {string[]} the ids added to the register
 */
function offerNewShippedTools(home, registerSeeded) {
  const regPath = path.join(home, 'tools', 'tools.register.json');
  const ledgerPath = path.join(home, 'tools', 'tools.seeded.json');
  const shipped = readJson(path.join(PKG_ROOT, 'tools', 'tools.register.json'));
  const reg = readJson(regPath);
  if (!shipped || !Array.isArray(shipped.tools) || !reg || !Array.isArray(reg.tools)) return [];
  const shippedIds = shipped.tools.map((t) => t && t.id).filter((id) => typeof id === 'string');
  const hadLedger = fs.existsSync(ledgerPath);
  let offered;
  if (hadLedger) {
    const ledger = readJson(ledgerPath);
    if (!ledger || !Array.isArray(ledger.ids)) return [];
    offered = new Set(ledger.ids);
  } else {
    offered = new Set(registerSeeded ? shippedIds : SHIPPED_BEFORE_LEDGER);
  }
  const offeredBefore = offered.size;
  const present = new Set(reg.tools.map((t) => t && t.id));
  const added = [];
  for (const t of shipped.tools) {
    if (!t || offered.has(t.id)) continue;
    if (!present.has(t.id)) { reg.tools.push(t); added.push(t.id); }
    offered.add(t.id);
  }
  try {
    if (added.length) atomicWriteJson(regPath, reg);
    if (!hadLedger || offered.size !== offeredBefore) atomicWriteJson(ledgerPath, { version: 1, ids: [...offered] });
  } catch (err) {
    // A home that cannot be rewritten (read-only file or mount) ran fine before: keep it running,
    // without the new tools, and try again next start.
    process.stderr.write(`[toolfunnel] could not add new shipped tools to ${regPath}: ${(err && err.message) || err}\n`);
    return [];
  }
  return added;
}

/**
 * Make `home` a working config home, seeding whatever is ABSENT from the shipped defaults.
 * Idempotent and never destructive: an existing file is NEVER overwritten (a home must survive
 * package updates - that is the whole point), bar the register gaining a new shipped tool once. home === package root -> a no-op (the git-clone
 * layout is already complete). Throws only if the home cannot be created at all.
 *
 * Deliberately NOT seeded: tools.state.json (absent = default visibility), auth/ (absent = auth
 * off), logs/ (absent = logging off), toolfunnel.json (absent = the default identity - an
 * npm-wrap ships its OWN copy inside its bundled home).
 *
 * @param {string} home  absolute config-home path (from resolveConfigHome)
 * @returns {{home: string, seeded: string[], added: string[]}} the files seeded on THIS call (empty =
 *   was complete) and the shipped tool ids newly added to an existing register
 */
function ensureConfigHome(home) {
  const seeded = [];
  if (samePath(path.resolve(home), PKG_ROOT)) return { home: PKG_ROOT, seeded, added: [] };
  fs.mkdirSync(home, { recursive: true });

  // The register + every shipped script (management tf_* + demo tools). The management scripts
  // are config-tree citizens (the register's invoke paths point at them), so they travel.
  copyTreeIfAbsent(path.join(PKG_ROOT, 'tools'), path.join(home, 'tools'), seeded);
  const added = offerNewShippedTools(home, seeded.includes(path.join(home, 'tools', 'tools.register.json')));
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
  // That tarball fact does not hold for a git clone: the package tree then carries the LIVE
  // store (mcp/expose.json) and any operator backups of it, both user-state, and the copy above
  // brought them across - so the "synthesise EMPTY when absent" guard below was dead and a fresh
  // home started attached to the developer's real upstreams. Same class as the tools.state.json
  // case above, same remedy: at this level the package ships ONLY expose.example.json (see
  // package.json "files"), so drop anything else the copy seeded here.
  const mcpHome = path.join(home, 'mcp');
  for (const copied of seeded.slice()) {
    if (path.dirname(copied) === mcpHome && path.basename(copied) !== 'expose.example.json') {
      try { fs.unlinkSync(copied); } catch (_e) { /* best-effort */ }
      seeded.splice(seeded.indexOf(copied), 1);
    }
  }
  const exposePath = path.join(home, 'mcp', 'expose.json');
  if (!fs.existsSync(exposePath)) {
    fs.mkdirSync(path.dirname(exposePath), { recursive: true });
    fs.writeFileSync(exposePath, JSON.stringify({ version: 1, upstreams: [], expose: [] }, null, 2) + '\n');
    seeded.push(exposePath);
  }
  copyTreeIfAbsent(path.join(PKG_ROOT, 'hooks'), path.join(home, 'hooks'), seeded);
  // hooks.state.json is user state too - the live hook toggles - same class as tools.state.json above:
  // a git clone's copy must not travel into a fresh home, which starts from the shipped manifest's own
  // enabled flags (config-home-hookstate.test.js).
  const strayHookState = path.join(home, 'hooks', 'hooks.state.json');
  if (seeded.includes(strayHookState)) {
    try { fs.unlinkSync(strayHookState); } catch (_e) { /* best-effort */ }
    seeded.splice(seeded.indexOf(strayHookState), 1);
  }
  return { home, seeded, added };
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
