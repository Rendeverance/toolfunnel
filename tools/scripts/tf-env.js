'use strict';

/**
 * tf-env.js - shared HOME/ENGINE resolution for the tf-* management scripts.
 *
 * A management script runs in one of two layouts:
 *   1. The git-clone original: it lives at <pkg>/tools/scripts/, and TWO dirs up is a root that
 *      holds BOTH the config (tools/ mcp/ hooks/) and the engine code (src/).
 *   2. A copy SEEDED into an external CONFIG HOME (TOOLFUNNEL_HOME / --config-dir - see
 *      src/core/config-home.js): the config sits beside it, but the engine code does NOT.
 *      The gateway that spawned it wrote the process-tree contract into the env:
 *      TOOLFUNNEL_HOME (the resolved absolute home) + TOOLFUNNEL_PKG (the package root).
 *
 * Resolution rules:
 *   - ENGINE: prefer the LOCAL __dirname-derived root whenever it actually contains the engine
 *     (layout 1) so a stale inherited TOOLFUNNEL_PKG can never shadow a real install; else the
 *     env; else the local root anyway (the require failure is then the clearest error).
 *   - HOME:   TOOLFUNNEL_HOME when set (the gateway always sets it), else the local root.
 *
 * Same-dir require ('./tf-env') keeps this working in BOTH layouts - the seeder copies the whole
 * scripts directory, so this file always travels with its callers. Node built-ins only.
 */

const fs = require('node:fs');
const path = require('node:path');

const LOCAL_ROOT = path.resolve(__dirname, '..', '..');
const HAS_LOCAL_ENGINE = fs.existsSync(path.join(LOCAL_ROOT, 'src', 'tools', 'registry.js'));

/** The package root holding the engine code (src/...). */
const PKG = HAS_LOCAL_ENGINE ? LOCAL_ROOT : (process.env.TOOLFUNNEL_PKG || LOCAL_ROOT);

/** The config home holding tools/ mcp/ hooks/ (the mutable state this script edits). */
const HOME = typeof process.env.TOOLFUNNEL_HOME === 'string' && process.env.TOOLFUNNEL_HOME.trim().length > 0
  ? path.resolve(process.env.TOOLFUNNEL_HOME.trim())
  : LOCAL_ROOT;

/** Require an engine module by its src-relative path, e.g. srcRequire('tools/registry'). */
function srcRequire(rel) {
  return require(path.join(PKG, 'src', rel));
}

module.exports = { PKG, HOME, srcRequire };
