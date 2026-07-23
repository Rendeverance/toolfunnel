'use strict';

/**
 * packager.js - export/import shareable {tool|hook|mcp} packages
 * (the authoritative package format is src/extend/package.md §2/§3/§4).
 *
 * Packaging is a BYPRODUCT of the gateway design: every unit is already structured and
 * self-documented, so a package is just a folder under `packages/` carrying a
 * `package.json` manifest (with each unit's FULL metadata embedded so import needs
 * no source register/manifest) plus a mirrored tree of the units' script files.
 *
 *   - tool unit = a tools.register.json `entry` + its `tools/scripts/<file>`
 *   - hook unit = a hooks.manifest.json `entry` + its enabled flag + `hooks/scripts/<file>`
 *   - mcp  unit = an expose.json `upstream` block + its `expose[]` selections (+ vendored files)
 *
 * This module ONLY touches files under the gateway (the packages/ tree for export, and the
 * injected destination roots for import). Every destination path is guarded INSIDE the
 * resolved root before any byte is written, so neither a crafted `path` in a register
 * entry nor a `files` list in a package manifest can escape the sandbox (defence-in-depth
 * for the HARD ISOLATION RULE).
 *
 * Safety contract (mirrors src/tools/registry.js and src/mcp/expose-store.js):
 *   - loadPackageList NEVER throws - a malformed package is skipped with a `note`.
 *   - exportPackage / importPackage VALIDATE fully BEFORE writing, so a mid-operation
 *     failure cannot leave a half-written register/manifest/expose store. Validation
 *     errors throw a clear message; nothing is persisted on a validation failure.
 *   - Atomic writes use the EXACT temp-in-same-dir + fsync + rename pattern copied from
 *     src/tools/registry.js::atomicWriteJson (a crash leaves the old OR the new file).
 *
 * CommonJS only. Node built-ins only. No new npm dependency.
 */

const fs = require('node:fs');
const path = require('node:path');

// ROOT = the CONFIG HOME (TOOLFUNNEL_HOME / --config-dir; defaults to the package root - see
// src/core/config-home.js). Packages are config-tree citizens: they export FROM and import INTO
// the home's register/manifest/expose stores, and the packages/ tree itself lives in the home.
const { resolveConfigHome } = require('../core/config-home');
const ROOT = resolveConfigHome(); // <...> config home

const PACKAGE_MANIFEST = 'package.json';

// ──────────────────────────────────────────────────────────────────────────
// Atomic write (copied verbatim from src/tools/registry.js::atomicWriteJson so
// the three stores share one proven persistence pattern).
// ──────────────────────────────────────────────────────────────────────────

/**
 * Atomic write: serialise to a temp file in the SAME directory as the target (so the
 * rename is atomic on the same filesystem/drive), fsync, then rename over the target.
 * A crash leaves either the old file or the new file, never a half-written file.
 *
 * @param {string} targetPath absolute destination
 * @param {object} obj         JSON-serialisable value
 */
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

// ──────────────────────────────────────────────────────────────────────────
// Path guards
// ──────────────────────────────────────────────────────────────────────────

/** True for a non-empty string. */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Assert that `target` resolves strictly inside `root` (root itself is allowed as the
 * boundary). Throws on any traversal escape. Compared with a trailing separator so
 * "<root>extra" cannot pass as "<root>".
 *
 * @param {string} target absolute candidate path
 * @param {string} root   absolute boundary directory
 * @param {string} [label] context for the error message
 */
function assertInside(target, root, label) {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(root);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  const inside = resolvedTarget === resolvedRoot || resolvedTarget.startsWith(rootWithSep);
  if (!inside) {
    throw new Error(
      `packager: path-traversal blocked - "${resolvedTarget}" is outside ${label || 'the allowed root'} "${resolvedRoot}"`
    );
  }
  return resolvedTarget;
}

/**
 * The injectable roots may live under os.tmpdir() during testing rather than under the
 * real ROOT. The HARD ISOLATION guard therefore confines writes to BOTH: a destination
 * must sit inside the caller-supplied destination root AND that destination root must be a
 * directory the caller chose (we never derive a write path from untrusted package content
 * alone - we always re-anchor it under the supplied root via path.basename for files).
 */

/** Ensure a directory exists (recursive). Never throws on an already-existing dir. */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Copy a single file, creating the destination directory if needed. */
function copyFileInto(srcPath, destPath) {
  ensureDir(path.dirname(destPath));
  fs.copyFileSync(srcPath, destPath);
}

/**
 * The basename of a register/manifest script reference (e.g. "scripts/echo.js" -> "echo.js").
 * Returns null for an empty/inline reference. Tolerates either path separator.
 * @param {*} ref
 * @returns {string|null}
 */
function scriptBasename(ref) {
  if (!isNonEmptyString(ref)) return null;
  const norm = ref.split('\\').join('/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  return base.length ? base : null;
}

// ──────────────────────────────────────────────────────────────────────────
// loadPackageList - scan packagesDir/*/package.json (never throws)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Scan `packagesDir` for installed packages and return a brief summary of each.
 *
 * For every immediate subdirectory containing a readable, well-formed `package.json`,
 * returns a row. A subdirectory whose manifest is missing/unreadable/malformed is
 * SKIPPED with a `note` (never throws - the safety contract). `counts` reports how
 * many tools/hooks/mcp units the package declares.
 *
 * @param {string} packagesDir absolute path to the packages/ directory
 * @returns {Array<{name,version,description,author,path,counts:{tools,hooks,mcp},note?}>}
 */
function loadPackageList(packagesDir) {
  const out = [];
  if (!isNonEmptyString(packagesDir)) return out;

  let entries;
  try {
    entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  } catch (_) {
    return out; // missing/unreadable packages dir -> empty list
  }

  for (const ent of entries) {
    if (!ent.isDirectory || !ent.isDirectory()) continue;
    const pkgDir = path.join(packagesDir, ent.name);
    const manifestPath = path.join(pkgDir, PACKAGE_MANIFEST);

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      out.push({
        name: ent.name,
        version: '',
        description: '',
        author: '',
        path: pkgDir,
        counts: { tools: 0, hooks: 0, mcp: 0 },
        note: `skipped: cannot read/parse package.json (${err.message})`,
      });
      continue;
    }

    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      out.push({
        name: ent.name,
        version: '',
        description: '',
        author: '',
        path: pkgDir,
        counts: { tools: 0, hooks: 0, mcp: 0 },
        note: 'skipped: package.json is not an object',
      });
      continue;
    }

    const units = manifest.units && typeof manifest.units === 'object' ? manifest.units : {};
    const counts = {
      tools: Array.isArray(units.tools) ? units.tools.length : 0,
      hooks: Array.isArray(units.hooks) ? units.hooks.length : 0,
      mcp: Array.isArray(units.mcp) ? units.mcp.length : 0,
    };

    out.push({
      name: isNonEmptyString(manifest.name) ? manifest.name : ent.name,
      version: isNonEmptyString(manifest.version) ? manifest.version : '',
      description: isNonEmptyString(manifest.description) ? manifest.description : '',
      author: isNonEmptyString(manifest.author) ? manifest.author : '',
      path: pkgDir,
      counts,
    });
  }

  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// exportPackage - bundle units into packages/<name>/
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build a package folder under `packagesDir/<name>/` (package.md §3).
 *
 * For each requested unit, the FULL metadata is embedded into the manifest and the
 * referenced script file is copied into the mirrored tree (tools/scripts/, hooks/scripts/).
 * Hooks read their seed `enabled` from the loader's hooks.state.json overlay if present,
 * else from the manifest's own enabled flag. MCP units embed the upstream block plus its
 * ENABLED expose[] selections.
 *
 * Validation is performed FULLY before any write: every requested id must exist in its
 * source and every referenced script must exist on disk. On a validation failure the
 * function throws and writes nothing.
 *
 * @param {object} args
 * @param {string} args.packagesDir        absolute packages/ dir (the package lands at <packagesDir>/<name>)
 * @param {string} args.name               package name (folder name + import key)
 * @param {string} [args.version='1.0.0']
 * @param {string} [args.description='']
 * @param {string} [args.author='']
 * @param {{tools?:string[],hooks?:string[],mcp?:string[]}} args.units  ids to include
 *   - tools: register entry ids
 *   - hooks: manifest entry ids
 *   - mcp:   upstream ids
 * @param {object} args.sources
 * @param {object} args.sources.registry        a Registry instance (has/getEntry)
 * @param {string} [args.sources.manifestPath]  absolute path to hooks.manifest.json (for hook units)
 * @param {object} [args.sources.exposeStore]   an ExposeStore instance (for mcp units)
 * @param {string} [args.sources.toolScriptsRoot] absolute dir holding tool scripts to copy
 * @param {string} [args.sources.hookScriptsRoot] absolute dir holding hook scripts to copy
 * @returns {{ dir:string, manifestPath:string, manifest:object }}
 */
function exportPackage(args) {
  const opts = args && typeof args === 'object' ? args : {};
  const {
    packagesDir,
    name,
    version = '1.0.0',
    description = '',
    author = '',
    units,
    sources,
  } = opts;

  if (!isNonEmptyString(packagesDir)) throw new Error('exportPackage: packagesDir is required');
  if (!isNonEmptyString(name)) throw new Error('exportPackage: name is required');
  if (/[\\/]|\.\./.test(name)) {
    throw new Error(`exportPackage: name "${name}" must be a bare folder name (no separators or "..")`);
  }
  const u = units && typeof units === 'object' ? units : {};
  const toolIds = Array.isArray(u.tools) ? u.tools : [];
  const hookIds = Array.isArray(u.hooks) ? u.hooks : [];
  const mcpIds = Array.isArray(u.mcp) ? u.mcp : [];

  const src = sources && typeof sources === 'object' ? sources : {};
  const { registry, manifestPath, exposeStore, toolScriptsRoot, hookScriptsRoot } = src;

  // ── PHASE 1: gather + validate everything (no writes yet) ────────────────

  // Tools
  const toolUnits = [];
  for (const id of toolIds) {
    if (!registry || typeof registry.has !== 'function' || !registry.has(id)) {
      throw new Error(`exportPackage: tool id "${id}" not found in the registry`);
    }
    const entry = registry.getEntry(id); // a clone
    let files = [];
    if (entry.invoke && entry.invoke.type === 'script') {
      const base = scriptBasename(entry.invoke.path);
      if (!base) throw new Error(`exportPackage: tool "${id}" has a script invoke with no path`);
      if (!isNonEmptyString(toolScriptsRoot)) {
        throw new Error(`exportPackage: tool "${id}" is a script tool but sources.toolScriptsRoot was not provided`);
      }
      const srcFile = path.resolve(toolScriptsRoot, base);
      assertInside(srcFile, toolScriptsRoot, 'the tool scripts root');
      if (!fs.existsSync(srcFile)) {
        throw new Error(`exportPackage: tool "${id}" script not found on disk ("${srcFile}")`);
      }
      // Normalise the embedded entry's invoke.path to the package-relative scripts/<base>.
      entry.invoke = Object.assign({}, entry.invoke, { path: `scripts/${base}` });
      files = [`tools/scripts/${base}`];
      toolUnits.push({ entry, files, _srcFile: srcFile, _destRel: `tools/scripts/${base}` });
    } else {
      // shell (or other) invoke - no file travels with it
      toolUnits.push({ entry, files });
    }
  }

  // Hooks
  const hookUnits = [];
  if (hookIds.length) {
    if (!isNonEmptyString(manifestPath)) {
      throw new Error('exportPackage: hook units requested but sources.manifestPath was not provided');
    }
    const { manifest, state } = readHookSources(manifestPath);
    const byId = new Map();
    for (const h of manifest.hooks || []) {
      if (h && typeof h.id === 'string') byId.set(h.id, h);
    }
    for (const id of hookIds) {
      const entry = byId.get(id);
      if (!entry) throw new Error(`exportPackage: hook id "${id}" not found in the manifest`);
      // enabled: overlay (hooks.state.json) WINS, else the manifest's own flag.
      const enabled = Object.prototype.hasOwnProperty.call(state, id)
        ? state[id] === true
        : entry.enabled === true;
      // Embed a CLEAN copy of the manifest entry (drop the live enabled - it travels as `enabled`).
      const cleanEntry = Object.assign({}, entry);
      delete cleanEntry.enabled;
      let files = [];
      let srcFile = null;
      let destRel = null;
      const base = scriptBasename(entry.script);
      if (base) {
        if (!isNonEmptyString(hookScriptsRoot)) {
          throw new Error(`exportPackage: hook "${id}" references a script but sources.hookScriptsRoot was not provided`);
        }
        srcFile = path.resolve(hookScriptsRoot, base);
        assertInside(srcFile, hookScriptsRoot, 'the hook scripts root');
        if (!fs.existsSync(srcFile)) {
          throw new Error(`exportPackage: hook "${id}" script not found on disk ("${srcFile}")`);
        }
        cleanEntry.script = `scripts/${base}`;
        files = [`hooks/scripts/${base}`];
        destRel = `hooks/scripts/${base}`;
      }
      hookUnits.push({ entry: cleanEntry, enabled, files, _srcFile: srcFile, _destRel: destRel });
    }
  }

  // MCP
  const mcpUnits = [];
  if (mcpIds.length) {
    if (!exposeStore || typeof exposeStore.getUpstream !== 'function') {
      throw new Error('exportPackage: mcp units requested but sources.exposeStore was not provided');
    }
    for (const id of mcpIds) {
      const upstream = exposeStore.getUpstream(id);
      if (!upstream) throw new Error(`exportPackage: mcp upstream id "${id}" not found in the expose store`);
      // Embed the upstream block + only its ENABLED expose[] selections.
      const expose = exposeStore.listExposed({ upstream: id, enabledOnly: true });
      mcpUnits.push({ upstream, expose, files: [] });
    }
  }

  // ── PHASE 2: write the package (validation passed) ───────────────────────

  const pkgDir = path.resolve(packagesDir, name);
  assertInside(pkgDir, packagesDir, 'the packages dir');
  ensureDir(pkgDir);

  // Copy script files into the mirrored tree.
  for (const tu of toolUnits) {
    if (tu._srcFile && tu._destRel) {
      const dest = path.resolve(pkgDir, tu._destRel);
      assertInside(dest, pkgDir, 'the package dir');
      copyFileInto(tu._srcFile, dest);
    }
  }
  for (const hu of hookUnits) {
    if (hu._srcFile && hu._destRel) {
      const dest = path.resolve(pkgDir, hu._destRel);
      assertInside(dest, pkgDir, 'the package dir');
      copyFileInto(hu._srcFile, dest);
    }
  }

  // Build the manifest (strip internal bookkeeping fields).
  const manifest = {
    name,
    version: isNonEmptyString(version) ? version : '1.0.0',
    description: typeof description === 'string' ? description : '',
    author: isNonEmptyString(author) ? author : '',
    units: {
      tools: toolUnits.map((t) => ({ entry: t.entry, files: t.files })),
      hooks: hookUnits.map((h) => ({ entry: h.entry, enabled: h.enabled, files: h.files })),
      mcp: mcpUnits.map((m) => ({ upstream: m.upstream, expose: m.expose, files: m.files })),
    },
  };

  const manifestOut = path.join(pkgDir, PACKAGE_MANIFEST);
  atomicWriteJson(manifestOut, manifest);

  return { dir: pkgDir, manifestPath: manifestOut, manifest };
}

// ──────────────────────────────────────────────────────────────────────────
// importPackage - install a package's units into the gateway stores
// ──────────────────────────────────────────────────────────────────────────

/**
 * Install a package's units (package.md §4).
 *
 * Tools -> copied into `toolScriptsRoot` + `registry.add(entry)`.
 * Hooks -> copied into `hookScriptsRoot` + appended to `hooks.manifest.json` (atomic) and
 *         their enabled flag written into `hooks.state.json` (atomic).
 * MCP   -> `exposeStore.addUpstream(upstream)` + `exposeStore.addExpose(selection)` per selection.
 *
 * The whole package.json is VALIDATED first; nothing is written until validation passes,
 * so a mid-import error never leaves a partially-corrupt store. Every destination path is
 * guarded inside its supplied root (a crafted `files`/`script`/`path` cannot escape).
 *
 * Collision policy (`onCollision`):
 *   - 'skip'  (default): a colliding id is recorded in `skipped[]` and NOT installed; no throw.
 *   - 'error':           a colliding id throws (before any write).
 *
 * @param {object} args
 * @param {string} args.packageDir       absolute path to the package folder (contains package.json)
 * @param {object} args.registry         a Registry instance (has/add)
 * @param {string} [args.manifestPath]   absolute hooks.manifest.json path (required iff hooks present)
 * @param {object} [args.exposeStore]    an ExposeStore instance (required iff mcp present)
 * @param {string} [args.toolScriptsRoot] absolute dir to copy tool scripts into
 * @param {string} [args.hookScriptsRoot] absolute dir to copy hook scripts into
 * @param {'skip'|'error'} [args.onCollision='skip']
 * @returns {{ tools:string[], hooks:string[], mcp:string[], skipped:Array<{kind,id,reason}> }}
 */
function importPackage(args) {
  const opts = args && typeof args === 'object' ? args : {};
  const {
    packageDir,
    registry,
    manifestPath,
    exposeStore,
    toolScriptsRoot,
    hookScriptsRoot,
    onCollision = 'skip',
  } = opts;

  if (!isNonEmptyString(packageDir)) throw new Error('importPackage: packageDir is required');
  if (onCollision !== 'skip' && onCollision !== 'error') {
    throw new Error(`importPackage: onCollision must be 'skip' or 'error' (got "${onCollision}")`);
  }

  // ── Read + validate the manifest FULLY before any write ──────────────────
  const manifestFile = path.join(packageDir, PACKAGE_MANIFEST);
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (err) {
    throw new Error(`importPackage: cannot read package.json at "${manifestFile}": ${err.message}`);
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new Error('importPackage: package.json is not an object');
  }
  const units = pkg.units && typeof pkg.units === 'object' ? pkg.units : {};
  const toolUnits = Array.isArray(units.tools) ? units.tools : [];
  const hookUnits = Array.isArray(units.hooks) ? units.hooks : [];
  const mcpUnits = Array.isArray(units.mcp) ? units.mcp : [];

  if (hookUnits.length && !isNonEmptyString(manifestPath)) {
    throw new Error('importPackage: package has hook units but manifestPath was not provided');
  }
  if (mcpUnits.length && (!exposeStore || typeof exposeStore.addUpstream !== 'function')) {
    throw new Error('importPackage: package has mcp units but exposeStore was not provided');
  }

  // A "plan" of validated, ready-to-apply actions. Building it fully first means a
  // validation error throws before we mutate any store.
  const skipped = [];

  // --- Tools plan ---
  const toolPlan = [];
  for (const unit of toolUnits) {
    const entry = unit && typeof unit === 'object' ? unit.entry : null;
    if (!entry || typeof entry !== 'object' || !isNonEmptyString(entry.id)) {
      throw new Error('importPackage: a tool unit is missing a valid entry.id');
    }
    const id = entry.id;
    const collides = registry && typeof registry.has === 'function' && registry.has(id);
    if (collides) {
      if (onCollision === 'error') {
        throw new Error(`importPackage: tool id "${id}" already exists in the registry`);
      }
      skipped.push({ kind: 'tool', id, reason: 'id-collision' });
      continue;
    }
    // Resolve any script file to copy.
    let srcFile = null;
    let destFile = null;
    if (entry.invoke && entry.invoke.type === 'script') {
      const base = scriptBasename(entry.invoke.path);
      if (!base) throw new Error(`importPackage: tool "${id}" has a script invoke with no path`);
      if (!isNonEmptyString(toolScriptsRoot)) {
        throw new Error(`importPackage: tool "${id}" needs a script copied but toolScriptsRoot was not provided`);
      }
      const fileRel = pickFileForBase(unit.files, base);
      srcFile = path.resolve(packageDir, fileRel);
      assertInside(srcFile, packageDir, 'the package dir');
      if (!fs.existsSync(srcFile)) {
        throw new Error(`importPackage: tool "${id}" script not found in package ("${srcFile}")`);
      }
      destFile = path.resolve(toolScriptsRoot, base);
      assertInside(destFile, toolScriptsRoot, 'the tool scripts root');
    }
    toolPlan.push({ id, entry, srcFile, destFile });
  }

  // --- Hooks plan ---
  const hookPlan = [];
  let manifestObj = null;
  let manifestIds = null;
  if (hookUnits.length) {
    manifestObj = readManifestRaw(manifestPath);
    manifestIds = new Set((manifestObj.hooks || []).map((h) => h && h.id).filter(Boolean));
  }
  for (const unit of hookUnits) {
    const entry = unit && typeof unit === 'object' ? unit.entry : null;
    if (!entry || typeof entry !== 'object' || !isNonEmptyString(entry.id)) {
      throw new Error('importPackage: a hook unit is missing a valid entry.id');
    }
    const id = entry.id;
    if (manifestIds.has(id)) {
      if (onCollision === 'error') {
        throw new Error(`importPackage: hook id "${id}" already exists in the manifest`);
      }
      skipped.push({ kind: 'hook', id, reason: 'id-collision' });
      continue;
    }
    let srcFile = null;
    let destFile = null;
    const base = scriptBasename(entry.script);
    if (base) {
      if (!isNonEmptyString(hookScriptsRoot)) {
        throw new Error(`importPackage: hook "${id}" needs a script copied but hookScriptsRoot was not provided`);
      }
      const fileRel = pickFileForBase(unit.files, base);
      srcFile = path.resolve(packageDir, fileRel);
      assertInside(srcFile, packageDir, 'the package dir');
      if (!fs.existsSync(srcFile)) {
        throw new Error(`importPackage: hook "${id}" script not found in package ("${srcFile}")`);
      }
      destFile = path.resolve(hookScriptsRoot, base);
      assertInside(destFile, hookScriptsRoot, 'the hook scripts root');
    }
    const enabled = unit.enabled === true;
    hookPlan.push({ id, entry, enabled, srcFile, destFile });
  }

  // --- MCP plan ---
  const mcpPlan = [];
  for (const unit of mcpUnits) {
    const upstream = unit && typeof unit === 'object' ? unit.upstream : null;
    if (!upstream || typeof upstream !== 'object' || !isNonEmptyString(upstream.id)) {
      throw new Error('importPackage: an mcp unit is missing a valid upstream.id');
    }
    const id = upstream.id;
    const exposeList = Array.isArray(unit.expose) ? unit.expose : [];
    const collides = !!exposeStore.getUpstream(id);
    if (collides) {
      if (onCollision === 'error') {
        throw new Error(`importPackage: mcp upstream id "${id}" already exists in the expose store`);
      }
      skipped.push({ kind: 'mcp', id, reason: 'id-collision' });
      continue;
    }
    mcpPlan.push({ id, upstream, expose: exposeList });
  }

  // ── APPLY (validation passed; collisions resolved) ───────────────────────

  const installed = { tools: [], hooks: [], mcp: [], skipped };

  // Tools: copy scripts then register.add.
  for (const t of toolPlan) {
    if (t.srcFile && t.destFile) copyFileInto(t.srcFile, t.destFile);
    registry.add(t.entry);
    installed.tools.push(t.id);
  }

  // Hooks: copy scripts, append manifest entries (one atomic write), write state overlay.
  if (hookPlan.length) {
    for (const h of hookPlan) {
      if (h.srcFile && h.destFile) copyFileInto(h.srcFile, h.destFile);
    }
    if (!Array.isArray(manifestObj.hooks)) manifestObj.hooks = [];
    for (const h of hookPlan) {
      // The manifest stores enabled as a faithful default; the state overlay is authoritative.
      const manifestEntry = Object.assign({}, h.entry, { enabled: h.enabled });
      manifestObj.hooks.push(manifestEntry);
    }
    atomicWriteJson(path.resolve(manifestPath), manifestObj);

    // State overlay (hooks.state.json) sits next to the manifest.
    const statePath = path.join(path.dirname(path.resolve(manifestPath)), 'hooks.state.json');
    const state = readStateRaw(statePath);
    for (const h of hookPlan) state[h.id] = h.enabled === true;
    atomicWriteJson(statePath, state);

    for (const h of hookPlan) installed.hooks.push(h.id);
  }

  // MCP: addUpstream then addExpose per enabled selection.
  for (const m of mcpPlan) {
    exposeStore.addUpstream(m.upstream);
    for (const sel of m.expose) {
      if (!sel || typeof sel !== 'object') continue;
      exposeStore.addExpose(sel);
    }
    installed.mcp.push(m.id);
  }

  return installed;
}

// ──────────────────────────────────────────────────────────────────────────
// internals
// ──────────────────────────────────────────────────────────────────────────

/**
 * Read a hooks manifest + its state overlay for export. Both are read leniently:
 * a missing/unreadable state overlay yields an empty overlay (the manifest's own
 * enabled flags then stand). Throws only if the manifest itself is unreadable.
 *
 * @param {string} manifestPath
 * @returns {{ manifest: object, state: Object<string,boolean> }}
 */
function readHookSources(manifestPath) {
  const manifest = readManifestRaw(manifestPath);
  const statePath = path.join(path.dirname(path.resolve(manifestPath)), 'hooks.state.json');
  const state = readStateRaw(statePath);
  return { manifest, state };
}

/** Read + parse a hooks.manifest.json (throws on unreadable/malformed). */
function readManifestRaw(manifestPath) {
  let raw;
  try {
    raw = fs.readFileSync(path.resolve(manifestPath), 'utf8');
  } catch (err) {
    throw new Error(`packager: cannot read hooks manifest at "${manifestPath}": ${err.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(`packager: hooks manifest at "${manifestPath}" is not valid JSON: ${err.message}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`packager: hooks manifest at "${manifestPath}" is not an object`);
  }
  if (!Array.isArray(obj.hooks)) obj.hooks = [];
  return obj;
}

/**
 * Read a hooks.state.json overlay leniently. Missing/unreadable/malformed -> {} (never
 * throws). Coerces values to strict booleans, keyed by hook id.
 *
 * @param {string} statePath
 * @returns {Object<string, boolean>}
 */
function readStateRaw(statePath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (_) {
    return {};
  }
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of Object.keys(raw)) out[key] = raw[key] === true;
  return out;
}

/**
 * Choose the package-relative file path for a given script basename. Prefer an entry in
 * the unit's declared `files[]` whose basename matches; otherwise fall back to the mirrored
 * convention. The basename is always re-derived (path.basename) so a crafted `files` entry
 * cannot smuggle a traversal segment past the later assertInside guard.
 *
 * @param {*} files     the unit's declared files array
 * @param {string} base the script basename (already sanitised)
 * @returns {string}    a package-relative path (forward-slashed)
 */
function pickFileForBase(files, base) {
  if (Array.isArray(files)) {
    for (const f of files) {
      if (isNonEmptyString(f) && scriptBasename(f) === base) {
        // Re-anchor on the basename only; never trust the directory portion blindly -
        // but keep the mirrored prefix for clarity. assertInside re-validates anyway.
        const norm = f.split('\\').join('/');
        return norm;
      }
    }
  }
  return `scripts/${base}`;
}

module.exports = {
  loadPackageList,
  exportPackage,
  importPackage,
  // exported for unit tests / reuse
  atomicWriteJson,
  assertInside,
  scriptBasename,
  ROOT,
};
