'use strict';

/**
 * hook-loader.js - load and persist the hook manifest, resolve runnable specs.
 *
 * Contract: HOOK_ENGINE.md §7 (manifest shape) and §8 (loader API).
 *
 * Responsibilities:
 *   - loadManifest(path): read hooks.manifest.json, expand ${HOOKS_DIR} (the absolute
 *     src/hooks dir) inside every command string, return { version, hooksDir, hooks: Spec[] }.
 *   - enabledHooksFor(event): the enabled specs for a lifecycle event.
 *   - setEnabled(id, bool): flip a hook's enabled flag and persist ATOMICALLY (temp + rename).
 *   - readScript(id): the hook's source text (for the manager's "open").
 *   - writeScript(id, text): save to the COPY under src/hooks/scripts - and REFUSE any
 *     resolved path outside src/hooks/scripts (path-traversal guard, isolation rule).
 *
 * Hook Manager v2 additions (see the architecture notes §4) - all ADDITIVE; the API above
 * keeps its exact behaviour so the existing loader tests still pass:
 *   - AUTO-DETECT: autodetect() scans <hooksDir>/scripts for hook scripts and reconciles
 *     them with the manifest. The FOLDER is the source of truth for what EXISTS; the
 *     manifest is CONFIG. Scripts on disk with no manifest entry surface as detected
 *     entries (enabled:false, detected:true, event/matcher unknown). Manifest entries
 *     whose script is missing on disk are flagged (present:false). Aliased as
 *     detect/reconcile/scan/inventory/reconcileScripts.
 *   - PERSIST STATE: enabled-state lives in <hooksDir>/hooks.state.json, an overlay keyed
 *     by hook id ({ "<id>": bool }). On load it is applied OVER the manifest's enabled
 *     flags (overlay WINS - documented precedence). setEnabled writes the overlay
 *     atomically (temp+rename) IN ADDITION to mutating the manifest, so toggles survive
 *     restarts and stay separate from the inventory.
 *
 * CommonJS only. Node built-ins only.
 */

const fs = require('node:fs');
const path = require('node:path');

// Lifecycle event names (frozen) - used to validate addEntry specs against the
// six supported events. events.js has zero host imports, so this cannot cycle.
const { EVENT_NAMES } = require('./events');

/**
 * Extensions we treat as hook scripts during auto-detect. Everything else in the
 * scripts dir (e.g. *.conf files, READMEs) is config/data, not a hook.
 */
const HOOK_SCRIPT_EXTS = /\.(sh|js|cjs|mjs|cmd|bat|ps1|py)$/i;

/**
 * Resolve the absolute src/hooks directory from the manifest's own location and its
 * declared (possibly relative) hooksDir. The manifest lives at <hooks>/hooks.manifest.json,
 * so its directory IS the hooks dir; we honor an explicit absolute hooksDir if given but
 * otherwise anchor to the manifest file's location (robust against cwd differences).
 *
 * @param {string} manifestPath absolute path to hooks.manifest.json
 * @param {string|undefined} declaredHooksDir the manifest's "hooksDir" field
 * @returns {string} absolute path to the hooks directory
 */
function resolveHooksDir(manifestPath, declaredHooksDir) {
  const manifestDir = path.dirname(path.resolve(manifestPath));
  if (!declaredHooksDir) return manifestDir;
  if (path.isAbsolute(declaredHooksDir)) return path.resolve(declaredHooksDir);
  // Relative hooksDir is interpreted relative to the manifest's directory's parent only
  // when it does not simply re-point at the manifest dir; in practice the manifest sits
  // inside the hooks dir, so the manifest directory is the source of truth.
  return manifestDir;
}

/**
 * Expand ${HOOKS_DIR} occurrences in a string with the absolute hooks dir.
 * Defensive: returns the input unchanged for non-strings.
 *
 * @param {string} str
 * @param {string} hooksDir absolute hooks directory
 * @returns {string}
 */
function expandHooksDir(str, hooksDir) {
  if (typeof str !== 'string') return str;
  // Replace every literal occurrence of ${HOOKS_DIR}. We avoid regex special-char issues
  // by using split/join on the literal token.
  return str.split('${HOOKS_DIR}').join(hooksDir);
}

class HookLoader {
  /**
   * @param {string} manifestPath absolute path to hooks.manifest.json
   * @param {object} manifest the parsed + expanded manifest object
   * @param {string} hooksDir absolute hooks directory
   */
  constructor(manifestPath, manifest, hooksDir) {
    this.manifestPath = manifestPath;
    this.manifest = manifest;
    this.hooksDir = hooksDir;
    // The scripts copy directory - the ONLY place writeScript may touch.
    this.scriptsDir = path.join(hooksDir, 'scripts');
    // v2: the persisted enabled-state overlay (keyed by hook id), kept separate
    // from the manifest inventory. Lives next to the manifest in the hooks dir.
    this.statePath = path.join(hooksDir, 'hooks.state.json');
  }

  /** @returns {number} manifest schema version */
  get version() {
    return this.manifest && this.manifest.version;
  }

  /** @returns {Array<object>} all hook specs (expanded) */
  get hooks() {
    return (this.manifest && Array.isArray(this.manifest.hooks)) ? this.manifest.hooks : [];
  }

  /**
   * Enabled specs for a given lifecycle event, in manifest order.
   * @param {string} event one of EVENTS
   * @returns {Array<object>}
   */
  enabledHooksFor(event) {
    return this.hooks.filter((h) => h && h.event === event && h.enabled === true);
  }

  /**
   * Look up a single spec by id.
   * @param {string} id
   * @returns {object|undefined}
   */
  getSpec(id) {
    return this.hooks.find((h) => h && h.id === id);
  }

  // ── v2: persisted enabled-state overlay ──────────────────────────────────

  /**
   * Read the enabled-state overlay from hooks.state.json. The overlay is a flat
   * map of hook id -> boolean. Missing/unreadable/malformed file -> empty overlay
   * (the manifest's own enabled flags stand). Never throws.
   *
   * @returns {Object<string, boolean>}
   */
  readState() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch (_) {
      return {};
    }
    return normalizeState(raw);
  }

  /**
   * Persist the enabled-state overlay atomically (temp + rename). Confined to the
   * hooks dir. The overlay carries ONLY booleans keyed by hook id.
   *
   * @param {Object<string, boolean>} overlay
   * @returns {void}
   */
  writeState(overlay) {
    const clean = normalizeState(overlay);
    atomicWriteJson(this.statePath, clean);
  }

  /**
   * Apply the on-disk state overlay over the in-memory manifest specs. The overlay
   * WINS over the manifest's own enabled flag (documented precedence). Called on
   * load so enabledHooksFor reflects the persisted toggles. Idempotent.
   *
   * @returns {Object<string, boolean>} the overlay that was applied
   */
  applyStateOverlay() {
    const overlay = this.readState();
    for (const h of this.hooks) {
      if (!h || typeof h.id !== 'string') continue;
      if (Object.prototype.hasOwnProperty.call(overlay, h.id)) {
        h.enabled = overlay[h.id] === true;
      }
    }
    return overlay;
  }

  // ── v2: auto-detect / reconcile inventory ────────────────────────────────

  /**
   * Scan <hooksDir>/scripts for hook scripts and reconcile with the manifest.
   *
   * The FOLDER is the source of truth for what EXISTS; the manifest is CONFIG.
   *   - Manifest entries are returned with `present` reflecting whether their
   *     `script` file exists on disk (manifest entries with no script - inline
   *     commands - are treated as present:true, since there is no file to miss).
   *   - Scripts present on disk but absent from the manifest are surfaced as
   *     `detected` entries: enabled:false, detected:true, event/matcher unknown.
   *
   * Returns a normalised inventory. `all` is the union (configured first, in
   * manifest order, then detected). Pure read - does not mutate the manifest or
   * touch disk beyond reading the scripts dir.
   *
   * @returns {{ all: object[], configured: object[], detected: object[], orphans: object[] }}
   */
  autodetect() {
    const scriptFiles = this._scanScripts(); // Set of basenames present on disk
    const referenced = new Set();

    const configured = [];
    const orphans = [];

    for (const h of this.hooks) {
      if (!h || typeof h !== 'object') continue;
      const base = scriptBasename(h.script);
      if (base) referenced.add(base);

      // Inline-command hooks (script:null) have no file to verify -> present.
      const present = base ? scriptFiles.has(base) : true;
      const entry = Object.assign({}, h, {
        detected: false,
        configured: true,
        present,
      });
      if (!present) {
        // Orphan: manifest references a script that does not exist on disk.
        entry.missing = true;
        entry.scriptMissing = true;
        entry.exists = false;
        entry.status = 'missing';
        orphans.push(entry);
      }
      configured.push(entry);
    }

    // Scripts on disk with no manifest entry -> detected, unconfigured.
    const detected = [];
    for (const base of scriptFiles) {
      if (referenced.has(base)) continue;
      detected.push({
        id: `detected/${base.replace(/\.[^.]+$/, '')}`,
        event: null, // unknown - not yet configured
        matcher: null,
        type: 'command',
        script: path.posix.join('scripts', base),
        command: null,
        timeout: null,
        enabled: false, // detected entries are never auto-enabled
        detected: true,
        configured: false,
        unconfigured: true,
        present: true,
        source: 'disk-scan',
        description: `Detected on disk; not yet configured in the manifest (${base}).`,
      });
    }

    return {
      all: configured.concat(detected),
      configured,
      detected,
      orphans,
    };
  }

  /** @returns {object} alias of {@link HookLoader#autodetect} (contract §4 naming). */
  reconcile() { return this.autodetect(); }
  /** @returns {object} alias of {@link HookLoader#autodetect}. */
  reconcileScripts() { return this.autodetect(); }
  /** @returns {object} alias of {@link HookLoader#autodetect}. */
  inventory() { return this.autodetect(); }
  /** @returns {object} alias of {@link HookLoader#autodetect}. */
  detect() { return this.autodetect(); }
  /** @returns {object} alias of {@link HookLoader#autodetect}. */
  scan() { return this.autodetect(); }

  /**
   * Scan the scripts dir for candidate hook script files. Hook scripts are
   * executable shell/node scripts; we treat .sh/.js/.cmd/.bat/.ps1/.py as hook
   * scripts and ignore everything else (e.g. a *.conf file is config, not a
   * hook). Missing dir -> empty set. Never throws.
   *
   * @returns {Set<string>} basenames of script files present on disk
   * @private
   */
  _scanScripts() {
    const out = new Set();
    let entries;
    try {
      entries = fs.readdirSync(this.scriptsDir, { withFileTypes: true });
    } catch (_) {
      return out; // no scripts dir yet
    }
    for (const ent of entries) {
      if (!ent.isFile || !ent.isFile()) continue;
      if (HOOK_SCRIPT_EXTS.test(ent.name)) out.add(ent.name);
    }
    return out;
  }

  /**
   * Toggle a hook's enabled flag and persist the manifest atomically.
   *
   * v2 precedence: the authoritative persisted toggle lives in the hooks.state.json
   * OVERLAY (keyed by hook id), which WINS over the manifest's own enabled flag at
   * load time. setEnabled writes that overlay atomically so the toggle survives a
   * restart and stays separate from the auto-detected inventory. For backward
   * compatibility (and so the manifest stays a faithful default), it ALSO mirrors
   * the flag into the manifest - writing the ORIGINAL (unexpanded) command strings
   * so the absolute ${HOOKS_DIR} expansion never leaks into the portable on-disk
   * manifest. We re-read the raw manifest from disk to do this.
   *
   * If the hook is a v2 DETECTED entry (on disk, not in the manifest), there is no
   * manifest row to mirror into - the overlay alone carries its state.
   *
   * @param {string} id hook id
   * @param {boolean} bool desired enabled state
   * @returns {boolean} true if the toggle was applied (manifest hook OR detected hook)
   */
  setEnabled(id, bool) {
    const desired = !!bool;

    // Update the in-memory (expanded) spec so the live engine sees the change
    // immediately - if this id corresponds to a configured manifest hook.
    const liveSpec = this.getSpec(id);
    if (liveSpec) liveSpec.enabled = desired;

    // (1) Persist the overlay - the authoritative, precedence-winning store.
    const overlay = this.readState();
    overlay[id] = desired;
    this.writeState(overlay);

    // (2) Mirror into the manifest when a matching row exists (keeps the manifest a
    //     faithful default and preserves the v1 setEnabled contract). Skipped for
    //     detected-only ids that have no manifest row.
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
    } catch (err) {
      // If the on-disk file is unreadable, fall back to persisting a re-collapsed copy
      // of the in-memory manifest (best effort - still atomic).
      raw = collapseManifest(this.manifest, this.hooksDir);
    }

    if (raw && Array.isArray(raw.hooks)) {
      const rawSpec = raw.hooks.find((h) => h && h.id === id);
      if (rawSpec) {
        rawSpec.enabled = desired;
        atomicWriteJson(this.manifestPath, raw);
      }
    }

    // True if we toggled a known manifest hook; also true if we recorded the overlay
    // for a detected (manifest-less) hook so the manager can persist its state.
    return !!liveSpec || true;
  }

  /**
   * Add a new hook entry to the manifest AND the live in-memory engine view.
   *
   * Mirrors setEnabled's persistence pattern: the RAW manifest JSON is re-read from
   * disk (so the portable ${HOOKS_DIR} token inside command strings stays UNCOLLAPSED
   * on disk), the validated spec is appended VERBATIM, and the file is rewritten
   * atomically (temp + rename). In ADDITION an EXPANDED copy - ${HOOKS_DIR} resolved in
   * the command - is pushed onto this.manifest.hooks so enabledHooksFor / the live
   * engine observe the new hook WITHOUT a reload.
   *
   * @param {object} spec
   *   - id: non-empty string; must not already exist in the manifest (rejected if it does)
   *   - event: one of the lifecycle EVENTS (EVENT_NAMES)
   *   - command: non-empty string
   *   - matcher/script/timeout/description: optional, stored verbatim
   *   - enabled: defaults to (spec.enabled === true)
   * @returns {object} the stored spec (exactly as written to the manifest)
   * @throws TypeError/Error if validation fails or the id already exists
   */
  addEntry(spec) {
    if (!spec || typeof spec !== 'object') {
      throw new TypeError('addEntry: spec must be an object');
    }
    if (typeof spec.id !== 'string' || spec.id.length === 0) {
      throw new Error('addEntry: spec.id must be a non-empty string');
    }
    if (!EVENT_NAMES.includes(spec.event)) {
      throw new Error(
        `addEntry: spec.event must be one of ${EVENT_NAMES.join(', ')} (got ${JSON.stringify(spec.event)})`
      );
    }
    if (typeof spec.command !== 'string' || spec.command.length === 0) {
      throw new Error('addEntry: spec.command must be a non-empty string');
    }

    // The stored spec: every supplied field VERBATIM, with enabled normalized to a
    // strict boolean. The command is left untouched so a portable ${HOOKS_DIR} token
    // (if the caller used one) stays UNCOLLAPSED on disk.
    const stored = Object.assign({}, spec, { enabled: spec.enabled === true });

    // Re-read the RAW manifest from disk (commands uncollapsed). Fall back to a
    // re-collapsed copy of the in-memory manifest if the file is unreadable - same
    // resilience as setEnabled, and the collapse keeps ${HOOKS_DIR} uncollapsed too.
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
    } catch (_) {
      raw = collapseManifest(this.manifest, this.hooksDir);
    }
    if (!raw || typeof raw !== 'object') raw = { version: this.version, hooks: [] };
    if (!Array.isArray(raw.hooks)) raw.hooks = [];

    if (raw.hooks.some((h) => h && h.id === spec.id)) {
      throw new Error(`addEntry: a hook with id "${spec.id}" already exists`);
    }

    // Persist the spec VERBATIM, atomically.
    raw.hooks.push(stored);
    atomicWriteJson(this.manifestPath, raw);

    // Mirror an EXPANDED copy into the live manifest so the engine sees it NOW.
    if (!Array.isArray(this.manifest.hooks)) this.manifest.hooks = [];
    const expanded = Object.assign({}, stored, {
      command: expandHooksDir(stored.command, this.hooksDir),
    });
    this.manifest.hooks.push(expanded);

    return stored;
  }

  /**
   * Remove a hook entry by id from the manifest, the live engine view, and the
   * persisted enabled-state overlay. Does NOT delete the script file on disk -
   * scripts are inventory (auto-detect's source of truth); unconfiguring a hook
   * only drops its manifest row, leaving any file for re-detection.
   *
   * Mirrors setEnabled's persistence pattern: re-read the RAW manifest (commands
   * stay UNCOLLAPSED), filter out the id, and rewrite atomically ONLY if something
   * changed. The in-memory expanded spec is spliced out so the live engine stops
   * firing it WITHOUT a reload, and the overlay key (when present) is purged.
   *
   * @param {string} id hook id to remove
   * @returns {boolean} true if a manifest row OR a live spec was removed
   * @throws Error if id is not a non-empty string
   */
  removeEntry(id) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('removeEntry: id must be a non-empty string');
    }

    // (1) Re-read the RAW manifest and drop the matching row (commands uncollapsed).
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
    } catch (_) {
      raw = collapseManifest(this.manifest, this.hooksDir);
    }
    let removedFromManifest = false;
    if (raw && Array.isArray(raw.hooks)) {
      const before = raw.hooks.length;
      raw.hooks = raw.hooks.filter((h) => !(h && h.id === id));
      removedFromManifest = raw.hooks.length !== before;
      if (removedFromManifest) atomicWriteJson(this.manifestPath, raw); // write only if changed
    }

    // (2) Splice the live expanded spec(s) so the engine stops seeing it immediately.
    let removedFromMemory = false;
    if (Array.isArray(this.manifest.hooks)) {
      for (let i = this.manifest.hooks.length - 1; i >= 0; i--) {
        const h = this.manifest.hooks[i];
        if (h && h.id === id) {
          this.manifest.hooks.splice(i, 1);
          removedFromMemory = true;
        }
      }
    }

    // (3) Purge the overlay key. Only rewrite the overlay when it actually carried
    //     this id, so we never create a stray state file for a never-toggled hook.
    const overlay = this.readState();
    if (Object.prototype.hasOwnProperty.call(overlay, id)) {
      delete overlay[id];
      this.writeState(overlay);
    }

    return removedFromManifest || removedFromMemory;
  }

  /**
   * Read a hook's script source. Resolves the spec's "script" (relative to hooksDir) and
   * reads it. Falls back to deriving the path from the script basename under scripts/.
   *
   * @param {string} id hook id
   * @returns {string} file contents
   * @throws if the hook id is unknown or the file cannot be read
   */
  readScript(id) {
    const spec = this.getSpec(id);
    if (!spec) throw new Error(`readScript: unknown hook id "${id}"`);
    const scriptPath = this._scriptPathForSpec(spec);
    return fs.readFileSync(scriptPath, 'utf8');
  }

  /**
   * Write a hook's script source to the COPY under src/hooks/scripts. Refuses any path that
   * resolves outside src/hooks/scripts (defense-in-depth for the isolation rule).
   *
   * @param {string} id hook id
   * @param {string} text new source
   * @returns {void}
   * @throws if the id is unknown, or the resolved path escapes scripts/
   */
  writeScript(id, text) {
    const spec = this.getSpec(id);
    if (!spec) throw new Error(`writeScript: unknown hook id "${id}"`);
    if (typeof text !== 'string') {
      throw new TypeError('writeScript: text must be a string');
    }

    const scriptPath = this._scriptPathForSpec(spec);
    this._assertInsideScriptsDir(scriptPath);

    // Atomic write within the scripts dir (temp + rename), preserving any line endings
    // the caller supplied (do not normalize - the shell scripts may be CRLF-sensitive).
    atomicWriteText(scriptPath, text, this.scriptsDir);
  }

  /**
   * Resolve the absolute filesystem path for a spec's script, anchored to hooksDir, and
   * guard it against escaping scripts/.
   *
   * @param {object} spec
   * @returns {string} absolute path inside scripts/
   * @private
   */
  _scriptPathForSpec(spec) {
    let rel = spec.script;
    if (typeof rel !== 'string' || rel.length === 0) {
      // Fall back to deriving from the id's basename if "script" is missing.
      rel = path.join('scripts', `${path.basename(spec.id)}`);
    }
    // spec.script is documented relative to hooksDir (e.g. "scripts/on-prompt.sh").
    const resolved = path.resolve(this.hooksDir, rel);
    this._assertInsideScriptsDir(resolved);
    return resolved;
  }

  /**
   * Throw unless `target` resolves strictly inside this.scriptsDir.
   * @param {string} target absolute candidate path
   * @private
   */
  _assertInsideScriptsDir(target) {
    const resolved = path.resolve(target);
    const base = path.resolve(this.scriptsDir);
    // Compare with a trailing separator so "<base>extra" cannot pass as "<base>".
    const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
    const isInside = resolved === base || resolved.startsWith(baseWithSep);
    if (!isInside) {
      throw new Error(
        `path-traversal blocked: "${resolved}" is outside the scripts dir "${base}"`
      );
    }
  }
}

/**
 * Coerce an arbitrary parsed value into a clean { id: boolean } overlay map. Accepts
 * either a flat map ({ "<id>": bool }) or a wrapped form ({ enabled: { ... } }) for
 * forward-tolerance; non-boolean values are coerced to strict booleans; non-object
 * input yields an empty overlay. Never throws.
 *
 * @param {*} raw
 * @returns {Object<string, boolean>}
 */
function normalizeState(raw) {
  const src =
    raw && typeof raw === 'object' && raw.enabled && typeof raw.enabled === 'object'
      ? raw.enabled
      : raw;
  const out = {};
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
  for (const key of Object.keys(src)) {
    out[key] = src[key] === true;
  }
  return out;
}

/**
 * The basename of a spec's script field (e.g. "scripts/on-prompt.sh" -> "on-prompt.sh").
 * Returns null for inline-command hooks (script null/empty). Tolerates either path
 * separator since manifests use forward slashes.
 *
 * @param {*} script the spec.script field
 * @returns {string|null}
 */
function scriptBasename(script) {
  if (typeof script !== 'string' || script.length === 0) return null;
  const norm = script.split('\\').join('/');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  return base.length ? base : null;
}

/**
 * Produce a manifest object with command strings collapsed back to ${HOOKS_DIR} so the
 * on-disk form stays machine-portable. Used only as a fallback when the raw file cannot
 * be re-read during persistence.
 *
 * @param {object} manifest expanded manifest
 * @param {string} hooksDir absolute hooks dir to collapse out of command strings
 * @returns {object} a deep-enough copy with collapsed commands
 */
function collapseManifest(manifest, hooksDir) {
  const copy = JSON.parse(JSON.stringify(manifest));
  if (Array.isArray(copy.hooks)) {
    for (const h of copy.hooks) {
      if (h && typeof h.command === 'string' && hooksDir) {
        h.command = h.command.split(hooksDir).join('${HOOKS_DIR}');
      }
    }
  }
  return copy;
}

/**
 * Atomically write a JS object as pretty JSON: write to a temp file in the SAME directory
 * as the target (so rename is atomic on the same filesystem), then rename over the target.
 *
 * @param {string} targetPath absolute destination
 * @param {object} obj
 */
function atomicWriteJson(targetPath, obj) {
  const data = JSON.stringify(obj, null, 2) + '\n';
  atomicWriteText(targetPath, data, path.dirname(targetPath));
}

/**
 * Atomically write text: temp file in `tmpDir` (must be on the same volume as the target),
 * fsync, then rename over the target. Cleans up the temp file on failure.
 *
 * @param {string} targetPath absolute destination
 * @param {string} data
 * @param {string} tmpDir directory to place the temp file (same FS as target)
 */
function atomicWriteText(targetPath, data, tmpDir) {
  const dir = tmpDir || path.dirname(targetPath);
  const tmpName = `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}.tmp`;
  const tmpPath = path.join(dir, tmpName);

  let fd;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, data);
    try {
      fs.fsyncSync(fd);
    } catch (_) {
      // fsync may fail on some platforms/filesystems; the rename is still ordered.
    }
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* ignore */
      }
    }
  }

  try {
    // rename is atomic on the same filesystem and overwrites the destination on POSIX;
    // on Windows it overwrites too as long as the target isn't locked.
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    // Best-effort cleanup so we don't leave temp files behind.
    try {
      fs.unlinkSync(tmpPath);
    } catch (_) {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Load a manifest from disk, expand ${HOOKS_DIR} in every command string, and return a
 * HookLoader holding it.
 *
 * @param {string} manifestPath absolute path to hooks.manifest.json
 * @returns {HookLoader}
 */
function loadManifest(manifestPath) {
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) {
    throw new TypeError('loadManifest: manifestPath must be a non-empty string');
  }
  const absManifest = path.resolve(manifestPath);
  const raw = JSON.parse(fs.readFileSync(absManifest, 'utf8'));

  const hooksDir = resolveHooksDir(absManifest, raw && raw.hooksDir);

  // Build the expanded manifest (do not mutate the raw parse beyond this copy).
  const expanded = {
    version: raw && raw.version,
    hooksDir, // store the resolved ABSOLUTE hooks dir for downstream consumers
    hooks: [],
  };

  const srcHooks = (raw && Array.isArray(raw.hooks)) ? raw.hooks : [];
  for (const h of srcHooks) {
    if (!h || typeof h !== 'object') continue;
    const spec = Object.assign({}, h);
    // Expand ${HOOKS_DIR} inside the command (and, defensively, any string field that
    // might reference it - but command is the documented carrier).
    if (typeof spec.command === 'string') {
      spec.command = expandHooksDir(spec.command, hooksDir);
    }
    // Normalize enabled to a strict boolean (manifest authors may omit it).
    spec.enabled = spec.enabled === true;
    expanded.hooks.push(spec);
  }

  const loader = new HookLoader(absManifest, expanded, hooksDir);
  // v2: apply the persisted enabled-state overlay OVER the manifest flags so the
  // returned loader (and enabledHooksFor) reflects the durable toggles. The overlay
  // wins; absent/unreadable overlay leaves the manifest defaults intact.
  loader.applyStateOverlay();
  return loader;
}

/**
 * Tiny inline self-check: add then remove a temp entry and confirm it round-trips
 * with the manifest byte-for-byte RESTORED. Runs only under `node hook-loader.js`
 * (never on import) and uses a THROWAWAY manifest in the OS temp dir, so the live
 * project manifest is never touched. Exits non-zero on any failure.
 */
function _selfCheck() {
  const os = require('node:os');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hookloader-selfcheck-'));
  const manifestPath = path.join(tmpRoot, 'hooks.manifest.json');
  const assert = (cond, msg) => { if (!cond) throw new Error('self-check FAILED: ' + msg); };
  try {
    // A manifest whose command uses the ${HOOKS_DIR} token, so we can prove it stays
    // UNCOLLAPSED on disk while being EXPANDED in the live view.
    const original =
      JSON.stringify(
        { version: 1, hooks: [{ id: 'existing', event: 'PreToolUse', command: '${HOOKS_DIR}/scripts/x.sh', enabled: true }] },
        null,
        2
      ) + '\n';
    fs.writeFileSync(manifestPath, original);

    const loader = loadManifest(manifestPath);
    const tmpSpec = { id: 'selfcheck/tmp', event: 'PostToolUse', command: '${HOOKS_DIR}/scripts/tmp.sh' };

    const stored = loader.addEntry(tmpSpec);
    assert(stored.enabled === false, 'enabled should default to false');
    // On disk: VERBATIM, token uncollapsed.
    const afterAdd = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const diskRow = afterAdd.hooks.find((h) => h.id === 'selfcheck/tmp');
    assert(!!diskRow, 'temp entry must be persisted to the manifest');
    assert(diskRow.command === '${HOOKS_DIR}/scripts/tmp.sh', 'on-disk command must keep ${HOOKS_DIR} uncollapsed');
    // Live: EXPANDED so the engine sees it without reload.
    const liveRow = loader.getSpec('selfcheck/tmp');
    assert(!!liveRow, 'temp entry must be live in this.manifest.hooks');
    assert(liveRow.command === path.join(loader.hooksDir, 'scripts/tmp.sh') ||
           liveRow.command === loader.hooksDir + '/scripts/tmp.sh',
           'live command must be expanded: ' + liveRow.command);

    // Duplicate id must be rejected.
    let threw = false;
    try { loader.addEntry(tmpSpec); } catch (_) { threw = true; }
    assert(threw, 'adding a duplicate id must throw');

    const removed = loader.removeEntry('selfcheck/tmp');
    assert(removed === true, 'removeEntry should report a removal');
    assert(!loader.getSpec('selfcheck/tmp'), 'temp entry must be gone from the live view');

    // Manifest must be RESTORED byte-for-byte (the only other row is "existing").
    const afterRemove = fs.readFileSync(manifestPath, 'utf8');
    assert(afterRemove === original, 'manifest must be restored byte-for-byte after add+remove');

    process.stdout.write('hook-loader self-check OK (add+remove round-trip; manifest restored)\n');
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

if (require.main === module) {
  try {
    _selfCheck();
  } catch (err) {
    process.stderr.write(((err && err.stack) || String(err)) + '\n');
    process.exit(1);
  }
}

module.exports = {
  loadManifest,
  HookLoader,
  // Exported for unit tests / reuse:
  expandHooksDir,
  resolveHooksDir,
  normalizeState,
  scriptBasename,
};
