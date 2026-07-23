'use strict';

/**
 * expose-store.js - the persisted MCP config store (the architecture notes and
 * the extension guide define the authoritative shape).
 *
 * This is a PURE, config-only module: no process spawning, no network, no MCP
 * client. It is the on-disk source of truth that the (Phase 2) aggregator reads
 * to know WHICH upstream MCPs to connect to and WHICH of their tools to surface
 * downstream as curated-direct tools. Editing this store is how a human/model
 * authors the MCP surface; the aggregator just consumes the result.
 *
 * Persisted file shape (src/mcp/expose.json):
 *   {
 *     "version": 1,
 *     "upstreams": [
 *       { id, transport:"stdio", command, args:[], env:{}, enabled:bool, description }
 *     ],
 *     "expose": [
 *       { upstream, tool, as, category, enabled:bool }
 *     ]
 *   }
 *
 * Two blocks (per the extension guide):
 *   - upstreams[]  - one entry per upstream MCP. `id` is the stable key referenced
 *                    by expose[].upstream. `transport:"stdio"` spawns command+args.
 *   - expose[]     - which upstream tools become curated-direct. `(upstream,tool)`
 *                    is the natural key; `as` is the downstream name the CLI sees
 *                    (defaults to `<upstream>_<tool>` so two upstreams can't collide).
 *
 * Read/write discipline (mirrors src/tools/registry.js - the safety contract):
 *   - READS never throw and always return CLONES (callers cannot mutate internal
 *     state, and a missing file is simply an empty store).
 *   - WRITES validate and throw a clear error on a bad write; nothing is persisted
 *     when validation fails.
 *   - Persistence is ATOMIC: a temp file in the SAME directory, fsync, then rename
 *     over the target (copied exactly from registry.js::atomicWriteJson). A crash
 *     leaves either the old file or the new file, never a half-written config.
 *   - loadExposeStore on a MISSING file returns an empty store bound to the path;
 *     the file is NOT created until the first write (keeps the server starting
 *     clean with no live upstreams).
 *
 * CommonJS only. Node built-ins only. No new npm dependency.
 */

const fs = require('node:fs');
const path = require('node:path');

const VALID_TRANSPORTS = new Set(['stdio']);

/** Deep-ish clone for plain JSON values (structuredClone may be absent on old node). */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Atomic write: serialise to a temp file in the SAME directory as the target (so
 * the rename is atomic on the same filesystem/drive), fsync, then rename over the
 * target. Copied verbatim from src/tools/registry.js so the two stores share one
 * proven persistence pattern.
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

/** True for a non-empty string. */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Normalise a raw upstream object into the canonical shape, filling sane defaults
 * for the optional fields. Does NOT validate - used both on load (lenient) and as
 * the base for write-validation. Always returns a fresh object.
 */
function normaliseUpstream(raw) {
  const u = raw && typeof raw === 'object' ? raw : {};
  return {
    // Unknown fields ride along (the same deliberate choice as /api/identity): every store
    // WRITE rewrites the file, so dropping unrecognised fields meant a 0.6.0 pin/unpin toggle
    // silently erased hand-authored extras. Known fields are normalised below.
    ...u,
    id: typeof u.id === 'string' ? u.id : '',
    transport: typeof u.transport === 'string' ? u.transport : 'stdio',
    command: typeof u.command === 'string' ? u.command : '',
    args: Array.isArray(u.args) ? u.args.slice() : [],
    env: u.env && typeof u.env === 'object' && !Array.isArray(u.env) ? { ...u.env } : {},
    enabled: typeof u.enabled === 'boolean' ? u.enabled : true,
    // 0.6.0 legacy shim: OPT-IN commitment flag. A pinned upstream is knowingly legacy-era -
    // the gateway keeps speaking MCP 2024-11-05 to it forever (never auto-upgrades), warns at
    // startup and on every forwarded call naming the pinned version, and tells modern clients
    // via result _meta. Off by default, always.
    legacyPin: u.legacyPin === true,
    // modernOnly: legacyPin's MIRROR - this upstream must speak the modern era; the client
    // refuses the legacy fallback at connect instead of negotiating down. Off by default
    // (default = speak whichever era the server understands). Era-policy switches, 2026-07-18.
    modernOnly: u.modernOnly === true,
    // Child working directory - the wrap era-probe and the client spawn both read it; it was
    // dropped here, so a configured cwd never survived the store.
    cwd: typeof u.cwd === 'string' && u.cwd.length ? u.cwd : undefined,
    // Per-upstream PAYLOAD timeout (ms) for tools/call | prompts/get | resources/read -
    // overrides the client's 120 s default. The control-plane window is requestTimeoutMs below.
    timeoutMs: Number.isFinite(u.timeoutMs) && u.timeoutMs > 0 ? u.timeoutMs : undefined,
    // Per-upstream CONTROL-PLANE window (ms) - handshake/list/discover/ping; default 10 s.
    // Raise it for a server that genuinely needs longer than 10 s to boot before it can answer
    // its handshake (a browser, a DB, a heavy session restore). The default stays the
    // dead-upstream detector; this is a knowing opt-in per upstream.
    requestTimeoutMs: Number.isFinite(u.requestTimeoutMs) && u.requestTimeoutMs > 0
      ? u.requestTimeoutMs : undefined,
    description: typeof u.description === 'string' ? u.description : '',
  };
}

/**
 * Normalise a raw expose object into the canonical shape. `as` is left as-is (may
 * be empty); exposedName() / addExpose() apply the `<upstream>_<tool>` default so
 * the stored entry can carry an explicit override or fall back lazily.
 */
function normaliseExpose(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  return {
    upstream: typeof e.upstream === 'string' ? e.upstream : '',
    tool: typeof e.tool === 'string' ? e.tool : '',
    as: typeof e.as === 'string' ? e.as : '',
    category: typeof e.category === 'string' ? e.category : '',
    enabled: typeof e.enabled === 'boolean' ? e.enabled : true,
  };
}

/**
 * Validate an upstream entry for a WRITE. Throws a clear error on a bad shape.
 *  - id must be a non-empty string and unique among the OTHER upstreams.
 *  - transport must be 'stdio' (the only baseline transport).
 *  - a stdio upstream requires a non-empty command.
 * @param {object} entry        normalised upstream
 * @param {Map}    byId         existing upstreams keyed by id (for uniqueness)
 * @param {string} [ignoreId]   an id to skip in the uniqueness check (updates)
 */
function validateUpstream(entry, byId, ignoreId) {
  if (!isNonEmptyString(entry.id)) {
    throw new Error('ExposeStore: upstream.id must be a non-empty string');
  }
  if (byId.has(entry.id) && entry.id !== ignoreId) {
    throw new Error(`ExposeStore: upstream id "${entry.id}" already exists`);
  }
  if (!VALID_TRANSPORTS.has(entry.transport)) {
    throw new Error(
      `ExposeStore: upstream.transport must be one of ${[...VALID_TRANSPORTS].join('|')} (id=${entry.id})`
    );
  }
  if (entry.transport === 'stdio' && !isNonEmptyString(entry.command)) {
    throw new Error(`ExposeStore: stdio upstream needs a non-empty "command" (id=${entry.id})`);
  }
  if (entry.legacyPin === true && entry.modernOnly === true) {
    throw new Error(
      `ExposeStore: upstream "${entry.id}" sets BOTH legacyPin and modernOnly - they contradict (force legacy vs refuse legacy); pick one`
    );
  }
  return entry;
}

class ExposeStore {
  /**
   * @param {object} opts
   * @param {string} opts.filePath  path to expose.json (source of truth on disk)
   * @param {object} [opts.data]    parsed config { version, upstreams, expose }
   */
  constructor({ filePath, data } = {}) {
    if (!isNonEmptyString(filePath)) throw new Error('ExposeStore: filePath is required');
    this._filePath = filePath;

    const d = data && typeof data === 'object' ? data : {};
    this._version = typeof d.version === 'number' ? d.version : 1;

    // Index upstreams by id; reject duplicate ids at load (a duplicate id makes
    // getUpstream / cascade-remove ambiguous). Keep insertion order via the Map.
    this._upstreams = new Map();
    const rawUpstreams = Array.isArray(d.upstreams) ? d.upstreams : [];
    for (const raw of rawUpstreams) {
      const u = normaliseUpstream(raw);
      if (!isNonEmptyString(u.id)) {
        throw new Error(`ExposeStore: an upstream is missing its id in ${filePath}`);
      }
      if (this._upstreams.has(u.id)) {
        throw new Error(`ExposeStore: duplicate upstream id "${u.id}" in ${filePath}`);
      }
      this._upstreams.set(u.id, u);
    }

    // expose[] is kept as an ordered array; the natural key is (upstream,tool).
    // Reject duplicate (upstream,tool) pairs at load.
    this._expose = [];
    const seenExpose = new Set();
    const rawExpose = Array.isArray(d.expose) ? d.expose : [];
    for (const raw of rawExpose) {
      const e = normaliseExpose(raw);
      const key = `${e.upstream} ${e.tool}`;
      if (seenExpose.has(key)) {
        throw new Error(
          `ExposeStore: duplicate expose entry (upstream="${e.upstream}", tool="${e.tool}") in ${filePath}`
        );
      }
      seenExpose.add(key);
      this._expose.push(e);
    }
  }

  // ── upstreams: read API (clones, never throw) ─────────────────────────────

  /** @returns {Array<{id,transport,command,args,env,enabled,description}>} cloned, in order. */
  listUpstreams() {
    return [...this._upstreams.values()].map(clone);
  }

  /** @returns {object|undefined} cloned upstream entry, or undefined if unknown. */
  getUpstream(id) {
    const u = this._upstreams.get(id);
    return u ? clone(u) : undefined;
  }

  // ── upstreams: write API (validate + atomic persist) ──────────────────────

  /**
   * Add an upstream. Validates: unique non-empty id; transport === 'stdio';
   * stdio requires a non-empty command. Persists atomically. Returns the clone.
   */
  addUpstream(entry) {
    const u = normaliseUpstream(entry);
    validateUpstream(u, this._upstreams);
    this._upstreams.set(u.id, u);
    this._persist();
    return clone(u);
  }

  /**
   * Shallow-merge `patch` over an existing upstream. `id` is immutable (the key);
   * any `id` in the patch is ignored. Re-validates the merged result and persists.
   */
  updateUpstream(id, patch) {
    const existing = this._upstreams.get(id);
    if (!existing) throw new Error(`ExposeStore.updateUpstream: unknown upstream id "${id}"`);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('ExposeStore.updateUpstream: patch must be an object');
    }
    const merged = normaliseUpstream({ ...existing, ...patch, id });
    validateUpstream(merged, this._upstreams, id);
    this._upstreams.set(id, merged);
    this._persist();
    return clone(merged);
  }

  /**
   * Remove an upstream AND cascade-remove any expose[] entries whose `upstream`
   * matches this id (a dangling expose entry would reference a missing upstream).
   * Persists atomically. Throws on an unknown id.
   * @returns {true}
   */
  removeUpstream(id) {
    if (!this._upstreams.has(id)) {
      throw new Error(`ExposeStore.removeUpstream: unknown upstream id "${id}"`);
    }
    this._upstreams.delete(id);
    this._expose = this._expose.filter((e) => e.upstream !== id);
    this._persist();
    return true;
  }

  /** Toggle an upstream's `enabled` flag; persists. Throws on unknown id. */
  setUpstreamEnabled(id, enabled) {
    return this.updateUpstream(id, { enabled: !!enabled });
  }

  // ── expose: read API (clones, never throw) ────────────────────────────────

  /**
   * List exposed entries. Optional filters:
   *   - `upstream`    restrict to one upstream id.
   *   - `enabledOnly` only entries with enabled === true.
   * @returns {Array<{upstream,tool,as,category,enabled}>} cloned, in order.
   */
  listExposed({ upstream, enabledOnly } = {}) {
    const out = [];
    for (const e of this._expose) {
      if (upstream && e.upstream !== upstream) continue;
      if (enabledOnly && e.enabled !== true) continue;
      out.push(clone(e));
    }
    return out;
  }

  /** @returns {object|undefined} cloned expose entry for (upstream,tool), or undefined. */
  getExposed(upstream, tool) {
    const e = this._findExpose(upstream, tool);
    return e ? clone(e) : undefined;
  }

  /**
   * The downstream name the CLI sees for an expose entry: explicit `as` if set,
   * else the namespaced default `<upstream>_<tool>`.
   * @param {{upstream,tool,as?}} e
   * @returns {string}
   */
  exposedName(e) {
    const obj = e && typeof e === 'object' ? e : {};
    if (isNonEmptyString(obj.as)) return obj.as;
    return `${obj.upstream}_${obj.tool}`;
  }

  // ── expose: write API (validate + atomic persist) ─────────────────────────

  /**
   * Add an expose entry. Validates: the `upstream` must EXIST; `tool` must be a
   * non-empty string; `(upstream,tool)` must be unique. `as` defaults to the
   * namespaced `<upstream>_<tool>`. Persists atomically. Returns the clone.
   */
  addExpose(entry) {
    const e = normaliseExpose(entry);
    if (!isNonEmptyString(e.upstream)) {
      throw new Error('ExposeStore.addExpose: expose.upstream must be a non-empty string');
    }
    if (!this._upstreams.has(e.upstream)) {
      throw new Error(`ExposeStore.addExpose: unknown upstream "${e.upstream}" (add the upstream first)`);
    }
    if (!isNonEmptyString(e.tool)) {
      throw new Error(`ExposeStore.addExpose: expose.tool must be a non-empty string (upstream=${e.upstream})`);
    }
    if (this._findExpose(e.upstream, e.tool)) {
      throw new Error(
        `ExposeStore.addExpose: expose entry (upstream="${e.upstream}", tool="${e.tool}") already exists`
      );
    }
    // Persist an explicit `as` (default the namespaced name so the stored entry
    // is self-describing and the aggregator never has to recompute it).
    e.as = isNonEmptyString(e.as) ? e.as : `${e.upstream}_${e.tool}`;
    this._expose.push(e);
    this._persist();
    return clone(e);
  }

  /**
   * Shallow-merge `patch` over an existing expose entry. The natural key
   * `(upstream,tool)` is immutable - any `upstream`/`tool` in the patch is ignored.
   * Persists atomically. Throws on an unknown (upstream,tool).
   */
  updateExpose(upstream, tool, patch) {
    const idx = this._indexOfExpose(upstream, tool);
    if (idx === -1) {
      throw new Error(`ExposeStore.updateExpose: unknown expose entry (upstream="${upstream}", tool="${tool}")`);
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('ExposeStore.updateExpose: patch must be an object');
    }
    const merged = normaliseExpose({ ...this._expose[idx], ...patch, upstream, tool });
    this._expose[idx] = merged;
    this._persist();
    return clone(merged);
  }

  /** Remove an expose entry. Persists. Throws on an unknown (upstream,tool). @returns {true} */
  removeExpose(upstream, tool) {
    const idx = this._indexOfExpose(upstream, tool);
    if (idx === -1) {
      throw new Error(`ExposeStore.removeExpose: unknown expose entry (upstream="${upstream}", tool="${tool}")`);
    }
    this._expose.splice(idx, 1);
    this._persist();
    return true;
  }

  /** Toggle an expose entry's `enabled` flag; persists. Throws on unknown (upstream,tool). */
  setExposeEnabled(upstream, tool, enabled) {
    return this.updateExpose(upstream, tool, { enabled: !!enabled });
  }

  // ── serialisation ─────────────────────────────────────────────────────────

  /** @returns {{version, upstreams, expose}} a clone of the full config (safe to mutate). */
  toJSON() {
    return {
      version: this._version,
      upstreams: [...this._upstreams.values()].map(clone),
      expose: this._expose.map(clone),
    };
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** @returns {object|undefined} the LIVE expose entry (not a clone) for (upstream,tool). */
  _findExpose(upstream, tool) {
    return this._expose.find((e) => e.upstream === upstream && e.tool === tool);
  }

  /** @returns {number} index of the expose entry for (upstream,tool), or -1. */
  _indexOfExpose(upstream, tool) {
    return this._expose.findIndex((e) => e.upstream === upstream && e.tool === tool);
  }

  /** Serialise current state back to the config file atomically. */
  _persist() {
    atomicWriteJson(this._filePath, this.toJSON());
  }
}

/**
 * loadExposeStore(filePath) -> ExposeStore
 *
 * Reads + parses the config JSON at `filePath` and returns an ExposeStore bound to
 * it.
 *  - MISSING file -> return an empty store bound to filePath. The file is NOT
 *    created until the first write (keeps the server starting clean).
 *  - MALFORMED JSON (or a duplicate id / duplicate expose key) -> throw a clear
 *    error so misconfiguration is caught at load, not at run time.
 *
 * @param {string} filePath
 * @returns {ExposeStore}
 */
function loadExposeStore(filePath) {
  if (!isNonEmptyString(filePath)) {
    throw new Error('loadExposeStore: filePath (non-empty string) is required');
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // Missing file is not an error - bind an empty store; defer file creation.
      return new ExposeStore({ filePath, data: { version: 1, upstreams: [], expose: [] } });
    }
    throw new Error(`loadExposeStore: cannot read config at "${filePath}": ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`loadExposeStore: config at "${filePath}" is not valid JSON: ${err.message}`);
  }
  return new ExposeStore({ filePath, data });
}

module.exports = {
  ExposeStore,
  loadExposeStore,
  // exported for unit tests / the aggregator
  atomicWriteJson,
  normaliseUpstream,
  normaliseExpose,
  validateUpstream,
  VALID_TRANSPORTS,
};
