'use strict';

/**
 * expose-store.js - the persisted MCP config store (the extension guide defines the
 * authoritative shape).
 *
 * This is a PURE, config-only module: no process spawning, no network, no MCP
 * client. It is the on-disk source of truth that the aggregator reads
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

// THE atomic writer (temp + fsync + rename, failure-path unlink, stale sweep) - shared by every store.
const { atomicWriteJson } = require('../core/atomic-write');

/** True for a non-empty string. */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

const { migrateForStoreFile, snapshotForStoreFile, restoreSnapshot } = require('../core/rename-migration');

/** The name an expose entry surfaces its tool under RIGHT NOW: an ENABLED entry's `as`
 *  (self-describing since addExpose defaults it); a disabled entry does not alias - the tool
 *  surfaces under the namespaced default. Mirrors Aggregator._surfacedName / the UI's
 *  surfacedNameFor. */
function surfacedOf(e) {
  return (e && e.enabled && isNonEmptyString(e.as)) ? e.as : `${e.upstream}_${e.tool}`;
}

/**
 * Normalise an env map to a NULL-PROTOTYPE object of string -> string.
 *
 * Not cosmetic - it closes two proven isolation-guard bypasses at the boundary, by making the
 * stored, guarded and spawned representations identical:
 *   - `JSON.parse('{"__proto__":{...}}')` yields an OWN `__proto__` data property. Spread keeps it,
 *     and the client's `Object.assign` env merge then uses [[Set]], firing the
 *     Object.prototype.__proto__ setter so the payload becomes the merged env's PROTOTYPE.
 *     child_process enumerates env with for..in ("prototype values are intentionally included"),
 *     so the child receives those keys while an own-key walk sees nothing. Copying own keys into
 *     a null-prototype object makes that carrier inert.
 *   - Non-string values reach the child regardless: node builds each pair as `${key}=${value}`, so
 *     `['--require=/outside-module.js']` stringifies to its element. Coerce here, once.
 *
 * @param {*} raw
 * @returns {Object<string,string>} null-prototype, string-valued
 */
function normaliseEnv(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (key === '__proto__') continue; // never re-establish the carrier
    const v = raw[key];
    if (v === undefined || v === null) continue;
    out[key] = typeof v === 'string' ? v : String(v);
  }
  return out;
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
    ...(u && typeof u === 'object' ? JSON.parse(JSON.stringify(u)) : {}),
    id: typeof u.id === 'string' ? u.id : '',
    transport: typeof u.transport === 'string' ? u.transport : 'stdio',
    command: typeof u.command === 'string' ? u.command : '',
    args: Array.isArray(u.args) ? u.args.slice() : [],
    env: normaliseEnv(u.env),
    enabled: typeof u.enabled === 'boolean' ? u.enabled : true,
    // 0.6.0 legacy shim: OPT-IN commitment flag. A pinned upstream is knowingly legacy-era -
    // the gateway keeps speaking MCP 2024-11-05 to it forever (never auto-upgrades), warns at
    // startup and on every forwarded call naming the pinned version, and tells modern clients
    // via result _meta. Off by default, always.
    legacyPin: u.legacyPin === true,
    // modernOnly: legacyPin's MIRROR - this upstream must speak the modern era; the client
    // refuses the legacy fallback at connect instead of negotiating down. Off by default
    // (default = speak whichever era the server understands).
    modernOnly: u.modernOnly === true,
    // allowCodeLoadingEnv: OPT-OUT of the isolation guard's code-loading env refusal for THIS
    // upstream (NODE_OPTIONS and friends). Same pattern as legacyPin: off by default, explicit
    // in config where an auditor can see it, warned on connect when it excuses something.
    allowCodeLoadingEnv: u.allowCodeLoadingEnv === true,
    // allowOutsidePaths: *** USE WITH EXTREME CAUTION ***
    //
    // This is the big one. allowCodeLoadingEnv excuses ONE class of environment variable; this
    // excuses the ENTIRE path guard for this upstream - args, the cwd they resolve against, and
    // the path-list env vars - so the server can reach anywhere on disk the account can.
    //
    // It exists because refusing outright was wrong. A filesystem server pointed at a documents
    // folder, a git server pointed at a repo, a database tool holding a socket somewhere else:
    // these live outside the config home BY NATURE, and without this flag funnel mode could not
    // run them at all. The honest answer is a switch the operator sets deliberately, not a wall
    // with no door.
    //
    // What it costs: the guard is a TRIPWIRE for configs that quietly reach outside an auditable
    // home. Setting this says "I know this one reaches out, and I meant it". You are then trusting
    // that server the way you trust anything you installed - because that is what you have done.
    // It buys you nothing to set it on an upstream that does not need it.
    //
    // What it does NOT excuse: the OPTION-STRING env class (NODE_OPTIONS, JAVA_TOOL_OPTIONS,
    // PERL5OPT, RUBYOPT...). Those are mini command lines in the runtime's own grammar - they
    // load code with no path to check - and they have their own flag, directly above. Setting
    // this one to point a git server at a repo must not silently disarm that one too: two
    // exemptions mean two deliberate decisions, each visible on its own line to an auditor.
    //
    // Scope is the safety property: it is read per upstream, from THIS entry, at every connect.
    // One upstream opting out NEVER relaxes another's guard, and the gateway warns on every
    // connect, ONCE PER CLASS, about everything it excused. Same pattern as legacyPin - off by
    // default, explicit in config where an auditor can see it, loud when it applies.
    allowOutsidePaths: u.allowOutsidePaths === true,
    // strictApproval (tool descriptor approval): a server VERSION change does not approve changed
    // tool descriptors by itself - they wait for acceptance like a same-version change.
    // Off by default (a version bump is the ordinary upgrade signal); on where the upstream's
    // maintainer is not trusted to bump honestly. See src/mcp/tool-approvals.js.
    strictApproval: u.strictApproval === true,
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
    // Unknown fields ride along, as on upstreams (normaliseUpstream): every write rewrites the
    // whole file, so dropping them erased hand-authored extras on the next unrelated edit.
    ...JSON.parse(JSON.stringify(e)),
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
 * @param {string} [filePath]   named in the message when given (load and store writes)
 */
function validateUpstream(entry, byId, ignoreId, filePath) {
  const at = filePath ? `ExposeStore: ${filePath}:` : 'ExposeStore:';
  if (!isNonEmptyString(entry.id)) {
    throw new Error(`${at} upstream "id" must be a non-empty string`);
  }
  if (byId.has(entry.id) && entry.id !== ignoreId) {
    throw new Error(`${at} upstream id "${entry.id}" already exists`);
  }
  if (!VALID_TRANSPORTS.has(entry.transport)) {
    throw new Error(
      `${at} upstream "${entry.id}": "transport" must be one of ${[...VALID_TRANSPORTS].join('|')}, got ${describeValue(entry.transport)}`
    );
  }
  // A disabled entry is never spawned, so a placeholder without a command still loads.
  if (entry.transport === 'stdio' && entry.enabled !== false && !isNonEmptyString(entry.command)) {
    throw new Error(`${at} upstream "${entry.id}": a stdio upstream needs a non-empty "command"`);
  }
  if (entry.legacyPin === true && entry.modernOnly === true) {
    throw new Error(
      `${at} upstream "${entry.id}" sets BOTH legacyPin and modernOnly - they contradict (force legacy vs refuse legacy); pick one`
    );
  }
  return entry;
}

// ── fail-loud config ────────────────────────────────────────────────────────────────────────
//
// The normalisers above replace a wrong-typed value with the default, silently: `"enabled":
// "false"` became ENABLED, `"timeoutMs": "5000"` the 120 s default, `"args": "a b"` no args,
// `"allowOutsidePaths": 1` false. The checks below run on the RAW object - at load, and on every
// write before normalising (which would coerce the evidence away) - and name the first bad field.
// Absent (undefined) and null both mean "unset" and keep the default. Unknown fields are not
// checked: they ride along untouched.

const UPSTREAM_BOOLEAN_FIELDS = ['enabled', 'legacyPin', 'modernOnly', 'allowCodeLoadingEnv', 'allowOutsidePaths', 'strictApproval'];
const UPSTREAM_STRING_FIELDS = ['transport', 'command', 'cwd', 'description'];
const UPSTREAM_MS_FIELDS = ['timeoutMs', 'requestTimeoutMs'];
const EXPOSE_STRING_FIELDS = ['upstream', 'tool', 'as', 'category'];

function isSet(v) {
  return v !== undefined && v !== null;
}

// Unknown fields still ride along (see normaliseUpstream), but a misspelt known one did nothing
// and said nothing: `"strictAproval": true` loaded and left strictApproval off. Loading with a
// warnUnknown callback names each unknown field, with the nearest known one when it is close.
// Fields starting with "_" or "$" are comments or schema references, so they are not reported.
const UPSTREAM_KNOWN_FIELDS = ['id', 'args', 'env', ...UPSTREAM_BOOLEAN_FIELDS, ...UPSTREAM_STRING_FIELDS, ...UPSTREAM_MS_FIELDS];
const EXPOSE_KNOWN_FIELDS = [...EXPOSE_STRING_FIELDS, 'enabled'];

/** Edit distance between two short strings (case-insensitive); swapping two neighbours counts as one edit. */
function editDistance(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** @returns {string[]} one message per unknown field of a RAW entry. */
const TOP_KNOWN_FIELDS = ['version', 'upstreams', 'expose', 'strictApproval'];

function unknownFieldMessages(raw, known, at) {
  const out = [];
  for (const key of Object.keys(raw)) {
    if (known.includes(key) || key.startsWith('_') || key.startsWith('$')) continue;
    let best = null;
    let bestD = Infinity;
    for (const k of known) {
      const d = editDistance(key, k);
      if (d < bestD) { best = k; bestD = d; }
    }
    const guess = bestD <= Math.max(1, Math.floor(best.length / 4)) ? ` (did you mean "${best}"?)` : '';
    out.push(`${at}: unknown field ${JSON.stringify(key)}${guess}. It is kept but has no effect.`);
  }
  return out;
}

/** A short, safe description of a value for an error message. */
function describeValue(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'string') return 'a string'; // never the value: args and env strings can hold secrets
  if (typeof v === 'object') return 'an object';
  return `${typeof v} ${String(v)}`;
}

/** @returns {string|null} the first wrong-typed known field of a RAW upstream, or null. */
function upstreamFieldProblem(raw) {
  for (const f of UPSTREAM_BOOLEAN_FIELDS) {
    if (isSet(raw[f]) && typeof raw[f] !== 'boolean') return `"${f}" must be true or false, got ${describeValue(raw[f])}`;
  }
  for (const f of UPSTREAM_STRING_FIELDS) {
    if (isSet(raw[f]) && typeof raw[f] !== 'string') return `"${f}" must be a string, got ${describeValue(raw[f])}`;
  }
  for (const f of UPSTREAM_MS_FIELDS) {
    const v = raw[f];
    if (isSet(v) && !(typeof v === 'number' && Number.isFinite(v) && v > 0)) {
      return `"${f}" must be a positive number of milliseconds, got ${describeValue(v)}`;
    }
  }
  if (isSet(raw.args)) {
    if (!Array.isArray(raw.args)) return `"args" must be an array of strings, got ${describeValue(raw.args)}`;
    const i = raw.args.findIndex((a) => typeof a !== 'string');
    if (i !== -1) return `"args" must be an array of strings, element ${i} is ${describeValue(raw.args[i])}`;
  }
  if (isSet(raw.env)) {
    if (typeof raw.env !== 'object' || Array.isArray(raw.env)) {
      return `"env" must be an object of NAME: value pairs, got ${describeValue(raw.env)}`;
    }
    // Scalars are coerced to strings by normaliseEnv (unchanged); an object or array value has
    // no meaning as an environment variable - including the "__proto__" carrier, now refused
    // loudly instead of dropped.
    for (const key of Object.getOwnPropertyNames(raw.env)) {
      const v = raw.env[key];
      if (isSet(v) && typeof v === 'object') {
        return `"env" value for ${JSON.stringify(key)} must be a string, number or boolean, got ${describeValue(v)}`;
      }
    }
  }
  return null;
}

/** @returns {string|null} the first wrong-typed known field of a RAW expose entry, or null. */
function exposeFieldProblem(raw) {
  for (const f of EXPOSE_STRING_FIELDS) {
    if (isSet(raw[f]) && typeof raw[f] !== 'string') return `"${f}" must be a string, got ${describeValue(raw[f])}`;
  }
  if (isSet(raw.enabled) && typeof raw.enabled !== 'boolean') {
    return `"enabled" must be true or false, got ${describeValue(raw.enabled)}`;
  }
  return null;
}

/** `upstream "u1"` - the id when it is a usable string, else the array position. */
function upstreamLabel(raw, index) {
  const id = raw && typeof raw.id === 'string' && raw.id ? `upstream "${raw.id}"` : 'upstream';
  return index === undefined ? id : `${id} (upstreams[${index}])`;
}

/** `expose entry (upstream="u1", tool="t1")`, with the array position at load. */
function exposeLabel(raw, index) {
  const q = (v) => (typeof v === 'string' ? JSON.stringify(v) : '(missing)');
  const where = index === undefined ? '' : ` (expose[${index}])`;
  return `expose entry (upstream=${q(raw && raw.upstream)}, tool=${q(raw && raw.tool)})${where}`;
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
    // Fail-loud config: a present top-level field of the wrong type refuses, never reads as empty.
    for (const f of ['upstreams', 'expose']) {
      if (isSet(d[f]) && !Array.isArray(d[f])) {
        throw new Error(`ExposeStore: ${filePath}: "${f}" must be an array, got ${describeValue(d[f])}`);
      }
    }
    if (isSet(d.version) && typeof d.version !== 'number') {
      throw new Error(`ExposeStore: ${filePath}: "version" must be a number, got ${describeValue(d.version)}`);
    }
    this._version = typeof d.version === 'number' ? d.version : 1;
    // A top-level strictApproval: true holds every upstream's changes for acceptance. An upstream can add it, not
    // remove it: 0.8.1 wrote "strictApproval": false on every entry, so an entry's false cannot mean opting out.
    if (isSet(d.strictApproval) && typeof d.strictApproval !== 'boolean') {
      throw new Error(`ExposeStore: ${filePath}: "strictApproval" must be true or false, got ${describeValue(d.strictApproval)}`);
    }
    this._strictTop = typeof d.strictApproval === 'boolean' ? d.strictApproval : undefined; // written back as found
    // other top-level keys (a _README, a key meant for an upstream) are kept and written back unchanged
    // (__proto__, constructor and prototype are never carried: they could retarget the written object)
    this._extraTop = Object.fromEntries(Object.entries(d)
      .filter(([k]) => !TOP_KNOWN_FIELDS.includes(k) && !['__proto__', 'constructor', 'prototype'].includes(k))
      .map(([k, v]) => [k, clone(v)]));

    // Index upstreams by id; reject duplicate ids at load (a duplicate id makes
    // getUpstream / cascade-remove ambiguous). Keep insertion order via the Map.
    this._upstreams = new Map();
    const rawUpstreams = Array.isArray(d.upstreams) ? d.upstreams : [];
    rawUpstreams.forEach((raw, i) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`ExposeStore: ${filePath}: upstreams[${i}] must be an object, got ${describeValue(raw)}`);
      }
      const u = normaliseUpstream(raw);
      if (!isNonEmptyString(u.id)) {
        throw new Error(`ExposeStore: an upstream is missing its id in ${filePath} (upstreams[${i}])`);
      }
      if (this._upstreams.has(u.id)) {
        throw new Error(`ExposeStore: duplicate upstream id "${u.id}" in ${filePath}`);
      }
      const problem = upstreamFieldProblem(raw);
      if (problem) throw new Error(`ExposeStore: ${filePath}: ${upstreamLabel(raw, i)}: ${problem}`);
      // The write-time shape rules (transport, a stdio command, the era-flag contradiction) hold
      // at load too: a file that no write could have produced is refused, not half-run.
      validateUpstream(u, this._upstreams, undefined, filePath);
      this._upstreams.set(u.id, u);
    });

    // expose[] is kept as an ordered array; the natural key is (upstream,tool).
    // Reject duplicate (upstream,tool) pairs at load.
    this._expose = [];
    const seenExpose = new Set();
    const rawExpose = Array.isArray(d.expose) ? d.expose : [];
    rawExpose.forEach((raw, i) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`ExposeStore: ${filePath}: expose[${i}] must be an object, got ${describeValue(raw)}`);
      }
      const problem = exposeFieldProblem(raw);
      if (problem) throw new Error(`ExposeStore: ${filePath}: ${exposeLabel(raw, i)}: ${problem}`);
      for (const f of ['upstream', 'tool']) {
        if (!isNonEmptyString(raw[f])) {
          throw new Error(`ExposeStore: ${filePath}: ${exposeLabel(raw, i)}: "${f}" must be a non-empty string`);
        }
      }
      const e = normaliseExpose(raw);
      const key = `${e.upstream} ${e.tool}`;
      if (seenExpose.has(key)) {
        throw new Error(
          `ExposeStore: duplicate expose entry (upstream="${e.upstream}", tool="${e.tool}") in ${filePath}`
        );
      }
      seenExpose.add(key);
      this._expose.push(e);
    });
  }

  // ── upstreams: read API (clones, never throw) ─────────────────────────────

  /** @returns {Array<{id,transport,command,args,env,enabled,description}>} cloned, in order. */
  listUpstreams() {
    return [...this._upstreams.values()].map((u) => this._withDefaults(clone(u)));
  }

  /** @returns {object|undefined} cloned upstream entry, or undefined if unknown. */
  getUpstream(id) {
    const u = this._upstreams.get(id);
    return u ? this._withDefaults(clone(u)) : undefined;
  }

  // ── upstreams: write API (validate + atomic persist) ──────────────────────

  /**
   * Add an upstream. Validates: unique non-empty id; transport === 'stdio';
   * stdio requires a non-empty command. Persists atomically. Returns the clone.
   */
  addUpstream(entry) {
    this._refuseWrongTypes(entry, upstreamFieldProblem, upstreamLabel);
    const u = normaliseUpstream(entry);
    validateUpstream(u, this._upstreams, undefined, this._filePath);
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
    this._refuseWrongTypes({ ...existing, ...patch, id }, upstreamFieldProblem, upstreamLabel);
    const merged = normaliseUpstream({ ...existing, ...patch, id });
    validateUpstream(merged, this._upstreams, id, this._filePath);
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
    this._refuseWrongTypes(entry, exposeFieldProblem, exposeLabel);
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
    // A new ENABLED alias renames the surface from the namespaced default it had while merely
    // lean-discovered - migrate-or-refuse, exactly like updateExpose (no-op when as == default).
    const snap = e.enabled && e.as !== `${e.upstream}_${e.tool}` ? snapshotForStoreFile(this._filePath) : null;
    if (e.enabled) this._migrateSurfaced(`${e.upstream}_${e.tool}`, e.as);
    this._expose.push(e);
    try {
      this._persist();
    } catch (err) {
      this._expose.pop();
      if (snap) restoreSnapshot(snap); // a failed persist puts the migrated files back byte-for-byte
      throw err;
    }
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
    const prior = this._expose[idx];
    this._refuseWrongTypes({ ...prior, ...patch, upstream, tool }, exposeFieldProblem, exposeLabel);
    const merged = normaliseExpose({ ...prior, ...patch, upstream, tool });
    // Rename-safety: a change to the SURFACED name - an `as` edit OR an enabled flip
    // (only an ENABLED entry's `as` surfaces; a disabled entry's tool falls back to the
    // namespaced default) - must carry the gate matchers and tools.state.json keys with it, or
    // the rename is REFUSED. Runs BEFORE persist so a refusal leaves this file untouched.
    const snap = surfacedOf(prior) !== surfacedOf(merged) ? snapshotForStoreFile(this._filePath) : null;
    this._migrateSurfaced(surfacedOf(prior), surfacedOf(merged));
    this._expose[idx] = merged;
    try {
      this._persist();
    } catch (err) {
      this._expose[idx] = prior;
      if (snap) restoreSnapshot(snap);
      throw err;
    }
    return clone(merged);
  }

  /** Remove an expose entry. Persists. Throws on an unknown (upstream,tool). @returns {true} */
  removeExpose(upstream, tool) {
    const idx = this._indexOfExpose(upstream, tool);
    if (idx === -1) {
      throw new Error(`ExposeStore.removeExpose: unknown expose entry (upstream="${upstream}", tool="${tool}")`);
    }
    // Removing an ENABLED aliased entry renames the surface back to the namespaced default -
    // same migrate-or-refuse contract as updateExpose (rename-safety).
    const prior = this._expose[idx];
    const snap = surfacedOf(prior) !== `${prior.upstream}_${prior.tool}` ? snapshotForStoreFile(this._filePath) : null;
    this._migrateSurfaced(surfacedOf(prior), `${prior.upstream}_${prior.tool}`);
    this._expose.splice(idx, 1);
    try {
      this._persist();
    } catch (err) {
      this._expose.splice(idx, 0, prior);
      if (snap) restoreSnapshot(snap);
      throw err;
    }
    return true;
  }

  /** Gate matchers + state keys follow the surfaced name (or the rename refuses; see rename-migration.js). */
  _migrateSurfaced(oldName, newName) {
    if (oldName === newName) return;
    migrateForStoreFile(this._filePath, oldName, newName);
  }

  /**
   * The other half of "migrate BEFORE persist": that ordering makes a REFUSED migration leave this
   * file untouched; a migration that succeeded followed by a failed persist would leave the
   * manifest naming the NEW surface while the file still named the OLD one - the gate firing on a
   * name nothing surfaced. Each mutating site snapshots the migration's files (snapshotForStoreFile)
   * before migrating and restores the bytes on a failed persist. A reverse MIGRATION is not an
   * unwind - it re-validates and a pattern hook matching the new name refuses it. rename-rollback.test.js.
   */

  /** Toggle an expose entry's `enabled` flag; persists. Throws on unknown (upstream,tool). */
  setExposeEnabled(upstream, tool, enabled) {
    return this.updateExpose(upstream, tool, { enabled: !!enabled });
  }

  // ── serialisation ─────────────────────────────────────────────────────────

  /** @returns {{version, upstreams, expose}} a clone of the full config (safe to mutate). */
  toJSON() {
    const out = {
      version: this._version,
      upstreams: [...this._upstreams.values()].map(clone),
      expose: this._expose.map(clone),
    };
    if (this._strictTop !== undefined) out.strictApproval = this._strictTop;
    for (const [k, v] of Object.entries(this._extraTop)) out[k] = clone(v);
    return out;
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** An upstream as read: the file's top-level strictApproval: true holds it too. */
  _withDefaults(u) {
    if (this._strictTop === true) u.strictApproval = true;
    return u;
  }

  /** @returns {object|undefined} the LIVE expose entry (not a clone) for (upstream,tool). */
  _findExpose(upstream, tool) {
    return this._expose.find((e) => e.upstream === upstream && e.tool === tool);
  }

  /** @returns {number} index of the expose entry for (upstream,tool), or -1. */
  _indexOfExpose(upstream, tool) {
    return this._expose.findIndex((e) => e.upstream === upstream && e.tool === tool);
  }

  /** Fail-loud config on a WRITE: throw, naming the file, entry and field, before anything changes. */
  _refuseWrongTypes(raw, problemOf, labelOf) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return; // the callers' own shape checks own this
    const problem = problemOf(raw);
    if (problem) throw new Error(`ExposeStore: ${this._filePath}: ${labelOf(raw)}: ${problem}`);
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
 *  - A PRESENT-BUT-WRONG-TYPED known field (`"enabled": "false"`, `"timeoutMs": "5000"`,
 *    `"args": "a b"`...) -> throw naming the file, the entry and the field (fail-loud config).
 *    Absent fields keep their defaults; `null` counts as absent.
 *
 *  - With opts.warnUnknown, each unknown field on an upstream or expose entry is reported through
 *    it (gateway start and reload pass one; the web UI, which loads on every request, does not).
 *
 * @param {string} filePath
 * @param {{ warnUnknown?: (message: string) => void }} [opts]
 * @returns {ExposeStore}
 */
function loadExposeStore(filePath, opts = {}) {
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
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`loadExposeStore: config at "${filePath}" must be a JSON object, got ${describeValue(data)}`);
  }
  const store = new ExposeStore({ filePath, data });
  if (typeof opts.warnUnknown === 'function') {
    // a key at the top that belongs on an upstream (legacyPin, timeoutMs...) or is misspelt says so
    for (const key of Object.keys(data)) {
      if (!TOP_KNOWN_FIELDS.includes(key) && UPSTREAM_KNOWN_FIELDS.includes(key)) {
        opts.warnUnknown(`${filePath}: "${key}" belongs on an upstream entry, not at the top of the file. It has no effect there.`);
      }
    }
    const misplaced = Object.keys(data).filter((k) => UPSTREAM_KNOWN_FIELDS.includes(k) && !TOP_KNOWN_FIELDS.includes(k));
    const rest = Object.fromEntries(Object.entries(data).filter(([k]) => !misplaced.includes(k)));
    for (const m of unknownFieldMessages(rest, TOP_KNOWN_FIELDS, filePath)) opts.warnUnknown(m);

    (data.upstreams || []).forEach((raw, i) => {
      for (const m of unknownFieldMessages(raw, UPSTREAM_KNOWN_FIELDS, `${filePath}: ${upstreamLabel(raw, i)}`)) opts.warnUnknown(m);
    });
    (data.expose || []).forEach((raw, i) => {
      for (const m of unknownFieldMessages(raw, EXPOSE_KNOWN_FIELDS, `${filePath}: ${exposeLabel(raw, i)}`)) opts.warnUnknown(m);
    });
  }
  return store;
}

/**
 * What a wrap of one upstream leaves unapplied: its entries in expose[] (which tools, their names and categories,
 * on or off). A wrap shows every tool of that server under its own name, so these entries do nothing while it
 * is wrapped. Returns a one-line note, or null when the upstream has none.
 */
function wrapIgnoresNote(store, id) {
  const n = store.listExposed({ upstream: id }).length;
  if (!n) return null;
  return `"${id}" has ${n} curated tool entr${n === 1 ? 'y' : 'ies'} in mcp/expose.json (which tools, their names, on or off). ` +
    'A wrap shows every tool of the server under its own name, so they do not apply while it is wrapped.';
}

module.exports = {
  ExposeStore,
  wrapIgnoresNote,
  loadExposeStore,
  // exported for unit tests / the aggregator
  atomicWriteJson,
  normaliseUpstream,
  normaliseExpose,
  validateUpstream,
  VALID_TRANSPORTS,
};
