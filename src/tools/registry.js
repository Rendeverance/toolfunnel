'use strict';

/**
 * registry.js — the dynamic, persisted Tool Register (see the architecture doc §5).
 *
 * This is distinct from src/core/tool-registry.js: that one is the in-memory
 * catalogue of tools handed to a backend at connect time. THIS one is the
 * structured, on-disk register the lean meta-tools (toolfunnel_list_tools /
 * toolfunnel_tool_instructions / toolfunnel_run_tool) read every call — so register edits
 * are visible with no reconnect (§1, "no restart for register changes").
 *
 * Register entry shape (tools.register.json -> { version, description, tools:[] }):
 *   { id, name, summary, category, instructions, invoke, mode? }
 *   invoke is one of:
 *     { type: "script", path: "scripts/<file>" }   // run a host-local script
 *     { type: "shell",  command: "..." }            // run a shell command
 *   mode (optional) is one of:
 *     "gateway"   — execute the invoke server-side via the gated run path (default for
 *                   a script/shell invoke; the original behaviour).
 *     "reference" — do NOT execute; toolfunnel_run_tool returns the instructions so the
 *                   connected AI runs the action itself. invoke may be omitted.
 *   When mode is absent it is inferred: script/shell invoke -> "gateway", else "reference".
 *
 * Responsibilities:
 *   list({filter?, category?})  -> briefs only [{id,name,summary,category}]
 *   instructions(id)            -> the full instructions string (throws on unknown)
 *   getEntry(id)                -> the full entry (clone; throws on unknown)
 *   add(entry) / update(id,patch) / remove(id)  -> mutate + ATOMIC persist
 *   resolveExecution(id, args)  -> { type, run: () => Promise<result> }
 *                                  describes HOW to run the invoke. It does NOT
 *                                  gate — gating is gated-run.js's job (§9).
 *
 * Pure-ish: the registry only touches its own JSON file + (for script invokes)
 * spawns node on a path resolved under this src/tools dir. Dependencies that a
 * test may want to stub (the executor) are injectable.
 *
 * CommonJS, Node built-ins only, atomic writes (temp + rename).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const VALID_INVOKE_TYPES = new Set(['script', 'shell']);

/**
 * Execution modes (optional per-entry "mode" field):
 *   "gateway"   — ToolFunnel EXECUTES the invoke server-side through the gated run path
 *                 (the original behaviour for every script/shell tool).
 *   "reference" — ToolFunnel does NOT execute. toolfunnel_run_tool returns the tool's
 *                 instructions so the connected AI performs the action in ITS OWN
 *                 environment. A reference tool needs no invoke (nothing runs here).
 */
const VALID_MODES = new Set(['reference', 'gateway']);

/**
 * Resolve an entry's execution mode. An explicit, valid `mode` wins. When absent it is
 * INFERRED backward-compatibly: a script/shell invoke means "gateway" (run it here, as
 * every existing tool does); anything else means "reference" (there is nothing to run).
 * @param {object} entry a register entry
 * @returns {"gateway"|"reference"}
 */
function resolveMode(entry) {
  if (entry && (entry.mode === 'reference' || entry.mode === 'gateway')) return entry.mode;
  const t = entry && entry.invoke && entry.invoke.type;
  return t === 'script' || t === 'shell' ? 'gateway' : 'reference';
}

/** Deep-ish clone for plain JSON entries (structuredClone may be absent on old node). */
function cloneEntry(entry) {
  return JSON.parse(JSON.stringify(entry));
}

/**
 * Atomic write: serialise to a temp file in the SAME directory as the target
 * (so rename is atomic on the same filesystem/drive), fsync, then rename over
 * the target. A crash leaves either the old file or the new file, never a
 * half-written register.
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

/** Validate a register entry shape; throws with a clear message on a bad shape. */
function validateEntry(entry, { requireId = true } = {}) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('Registry: entry must be an object');
  }
  if (requireId && (typeof entry.id !== 'string' || entry.id.length === 0)) {
    throw new Error('Registry: entry.id must be a non-empty string');
  }
  if (typeof entry.name !== 'string' || entry.name.length === 0) {
    throw new Error(`Registry: entry.name must be a non-empty string (id=${entry.id})`);
  }
  // Optional execution mode. When present it must be one of the valid modes.
  if (entry.mode !== undefined && !VALID_MODES.has(entry.mode)) {
    throw new Error(
      `Registry: entry.mode must be one of ${[...VALID_MODES].join('|')} (id=${entry.id})`
    );
  }
  // A reference tool executes nothing server-side, so its invoke may be omitted. Only an
  // EXPLICIT mode:"reference" relaxes this — with mode absent the invoke is still required
  // (backward-compatible: every existing tool keeps its mandatory invoke).
  if (entry.mode === 'reference' && entry.invoke === undefined) {
    return entry;
  }
  const inv = entry.invoke;
  if (!inv || typeof inv !== 'object') {
    throw new Error(`Registry: entry.invoke is required (id=${entry.id})`);
  }
  if (!VALID_INVOKE_TYPES.has(inv.type)) {
    throw new Error(
      `Registry: entry.invoke.type must be one of ${[...VALID_INVOKE_TYPES].join('|')} (id=${entry.id})`
    );
  }
  if (inv.type === 'script' && (typeof inv.path !== 'string' || inv.path.length === 0)) {
    throw new Error(`Registry: script invoke needs a non-empty "path" (id=${entry.id})`);
  }
  if (inv.type === 'shell' && (typeof inv.command !== 'string' || inv.command.length === 0)) {
    throw new Error(`Registry: shell invoke needs a non-empty "command" (id=${entry.id})`);
  }
  // Optional MCP input schema. When present it must be a plain object — a hot-promoted tool
  // advertises it VERBATIM to MCP clients (tools/list), so a typo'd shape must fail loudly at
  // authoring time rather than silently degrade to the free-form fallback at surface time.
  if (
    entry.inputSchema !== undefined &&
    (typeof entry.inputSchema !== 'object' || entry.inputSchema === null || Array.isArray(entry.inputSchema))
  ) {
    throw new Error(`Registry: entry.inputSchema must be an object when present (id=${entry.id})`);
  }
  return entry;
}

/**
 * Default script executor: spawn `node <resolved script>` with the structured
 * args passed in env TOOLFUNNEL_TOOL_ARGS. Resolves with { ok, code, stdout, stderr }.
 * Never rejects on a non-zero exit — the caller (the gated runner / meta-tool)
 * decides how to surface a tool failure. It DOES reject only on spawn failure.
 *
 * Path safety: the script path must resolve INSIDE scriptsRoot (defense-in-depth
 * for the isolation rule — a register entry must not become a path-escape).
 */
function defaultRunScript(scriptsRoot, invoke, args) {
  return new Promise((resolve, reject) => {
    const resolved = path.resolve(scriptsRoot, path.basename(invoke.path));
    // path.basename strips any directory traversal; confirm anyway.
    const rel = path.relative(scriptsRoot, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      reject(new Error(`Registry: script path escapes scripts root ("${invoke.path}")`));
      return;
    }
    if (!fs.existsSync(resolved)) {
      reject(new Error(`Registry: script not found ("${resolved}")`));
      return;
    }
    const child = spawn(process.execPath, [resolved], {
      env: { ...process.env, TOOLFUNNEL_TOOL_ARGS: JSON.stringify(args ?? null) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

class Registry {
  /**
   * @param {object} opts
   * @param {string} opts.filePath          path to tools.register.json (source of truth on disk)
   * @param {object} opts.data              parsed register data { version, description, tools }
   * @param {string} [opts.scriptsRoot]     dir holding script-invoke targets (default: <fileDir>/scripts)
   * @param {Function} [opts.runScript]     injectable (scriptsRoot, invoke, args) => Promise<result>
   */
  constructor({ filePath, data, scriptsRoot, runScript } = {}) {
    if (!filePath) throw new Error('Registry: filePath is required');
    this._filePath = filePath;
    this._scriptsRoot = scriptsRoot || path.join(path.dirname(filePath), 'scripts');
    this._runScript = runScript || defaultRunScript;

    const d = data && typeof data === 'object' ? data : {};
    this._version = typeof d.version === 'number' ? d.version : 1;
    this._description = typeof d.description === 'string' ? d.description : '';
    const tools = Array.isArray(d.tools) ? d.tools : [];

    // Index by id; reject duplicate ids at load (a duplicate id makes
    // instructions(id)/run(id) ambiguous).
    this._byId = new Map();
    for (const t of tools) {
      validateEntry(t);
      if (this._byId.has(t.id)) {
        throw new Error(`Registry: duplicate tool id "${t.id}" in ${filePath}`);
      }
      this._byId.set(t.id, cloneEntry(t));
    }
  }

  // ---- read API -----------------------------------------------------------

  /**
   * Briefs only — the surface toolfunnel_list_tools returns. Optional case-insensitive
   * substring `filter` (matched against id/name/summary) and exact `category`.
   * @returns {Array<{id,name,summary,category}>} in insertion order.
   */
  list({ filter, category } = {}) {
    const needle = typeof filter === 'string' && filter.length ? filter.toLowerCase() : null;
    const out = [];
    for (const t of this._byId.values()) {
      if (category && t.category !== category) continue;
      if (needle) {
        const hay = `${t.id} ${t.name} ${t.summary || ''}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      out.push({
        id: t.id,
        name: t.name,
        summary: t.summary || '',
        category: t.category || '',
      });
    }
    return out;
  }

  /** Full instructions string for one tool. Throws on unknown id (per §5 contract). */
  instructions(id) {
    const t = this._byId.get(id);
    if (!t) throw new Error(`Registry.instructions: unknown tool id "${id}"`);
    return typeof t.instructions === 'string' ? t.instructions : '';
  }

  /** Full entry (cloned so callers can't mutate internal state). Throws on unknown id. */
  getEntry(id) {
    const t = this._byId.get(id);
    if (!t) throw new Error(`Registry.getEntry: unknown tool id "${id}"`);
    return cloneEntry(t);
  }

  /** @returns {boolean} */
  has(id) {
    return this._byId.has(id);
  }

  // ---- write API (atomic persist) ----------------------------------------

  /** Add a new entry. Throws if id missing/duplicate or shape invalid. Persists. */
  add(entry) {
    validateEntry(entry);
    if (this._byId.has(entry.id)) {
      throw new Error(`Registry.add: tool id "${entry.id}" already exists`);
    }
    this._byId.set(entry.id, cloneEntry(entry));
    this._persist();
    return this.getEntry(entry.id);
  }

  /**
   * Patch an existing entry. `id` cannot be changed via patch (it's the key).
   * Merges shallow over the existing entry, re-validates, persists.
   */
  update(id, patch) {
    const existing = this._byId.get(id);
    if (!existing) throw new Error(`Registry.update: unknown tool id "${id}"`);
    if (!patch || typeof patch !== 'object') {
      throw new Error('Registry.update: patch must be an object');
    }
    const merged = { ...existing, ...patch, id };
    validateEntry(merged);
    this._byId.set(id, cloneEntry(merged));
    this._persist();
    return this.getEntry(id);
  }

  /** Remove an entry. Throws on unknown id. Persists. */
  remove(id) {
    if (!this._byId.has(id)) throw new Error(`Registry.remove: unknown tool id "${id}"`);
    this._byId.delete(id);
    this._persist();
    return true;
  }

  /**
   * Re-read the register FILE and swap the in-memory index — the hot-reload seam. A running
   * gateway holds ONE Registry instance (captured by the protocol adapter at build time), while
   * tf_tool_add / the UI / a hand edit mutate the FILE from another process — without this, those
   * edits are invisible until restart. LAST-GOOD semantics: the replacement index is built and
   * fully validated FIRST; any read/parse/validation failure (including a mid-write partial file)
   * leaves the current index untouched and returns false. NEVER throws.
   * @returns {boolean} true when the on-disk register replaced the in-memory index
   */
  reload() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this._filePath, 'utf8'));
    } catch (_e) {
      return false; // unreadable / mid-write / bad JSON → keep last-good
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    const tools = Array.isArray(data.tools) ? data.tools : [];
    const next = new Map();
    try {
      for (const t of tools) {
        validateEntry(t);
        if (next.has(t.id)) throw new Error(`duplicate tool id "${t.id}"`);
        next.set(t.id, cloneEntry(t));
      }
    } catch (_e) {
      return false; // an invalid entry → keep last-good
    }
    if (typeof data.version === 'number') this._version = data.version;
    if (typeof data.description === 'string') this._description = data.description;
    this._byId = next;
    return true;
  }

  /**
   * Write a host-local script's text under this scriptsRoot, atomically.
   *
   * Resolves path.basename(invokePath) under scriptsRoot (basename strips any
   * directory traversal) and GUARDS that the resolved path stays inside
   * scriptsRoot — the same path-escape defence as defaultRunScript, so a
   * tf_tool_add(scriptText) can never write outside the isolation root. Writes
   * `text` via a temp file in the same dir + fsync + rename (mirror of
   * atomicWriteJson): a crash leaves either no file or the complete file.
   *
   * @param {string} invokePath  e.g. "scripts/foo.js" — only the basename is honoured
   * @param {string} text        full file contents to write
   * @returns {string} the resolved absolute path that was written
   */
  writeScript(invokePath, text) {
    if (typeof invokePath !== 'string' || invokePath.length === 0) {
      throw new Error('Registry.writeScript: invokePath (non-empty string) is required');
    }
    if (typeof text !== 'string') {
      throw new Error('Registry.writeScript: text must be a string');
    }
    const scriptsRoot = this._scriptsRoot;
    const resolved = path.resolve(scriptsRoot, path.basename(invokePath));
    // path.basename strips any directory traversal; confirm anyway.
    const rel = path.relative(scriptsRoot, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Registry.writeScript: script path escapes scripts root ("${invokePath}")`);
    }
    fs.mkdirSync(scriptsRoot, { recursive: true });
    const dir = path.dirname(resolved);
    const base = path.basename(resolved);
    const tmp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, text, 0, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, resolved);
    return resolved;
  }

  // ---- execution description (does NOT gate) ------------------------------

  /**
   * Describe HOW to run a tool's invoke. Returns { type, run } where `run` is a
   * zero-arg function returning a Promise of the tool result. resolveExecution
   * performs NO gating — toolfunnel_run_tool / gated-run.js fires the PreToolUse hook
   * and only then calls `run()` (the architecture doc §2/§9). Keeping the gate
   * out of here keeps the safety case in one auditable place.
   *
   * - script invoke: run() spawns node on the host-local script (via the injected
   *   runScript), passing args in TOOLFUNNEL_TOOL_ARGS.
   * - shell invoke: run() does NOT execute here. It returns a descriptor
   *   { type:'shell', command, args } so the gated runner owns the actual shell
   *   spawn (the broadest power) behind the gate. This keeps arbitrary shell
   *   execution out of the un-gated register module by design.
   *
   * @param {string} id
   * @param {any} args  structured args forwarded to the tool
   * @returns {{ type: string, run: () => Promise<any> }}
   */
  resolveExecution(id, args) {
    const entry = this._byId.get(id);
    if (!entry) throw new Error(`Registry.resolveExecution: unknown tool id "${id}"`);
    const mode = resolveMode(entry);

    // ---- reference mode: nothing runs here. ----------------------------------
    // The connected AI performs the action in its own environment. We hand back the
    // tool's instructions (no `run`) so the run-path can short-circuit BEFORE the gate
    // — a reference tool never spawns and never needs gating (nothing executes).
    if (mode === 'reference') {
      return {
        type: 'reference',
        mode: 'reference',
        instructions: typeof entry.instructions === 'string' ? entry.instructions : '',
      };
    }

    const invoke = entry.invoke;

    if (invoke.type === 'script') {
      const scriptsRoot = this._scriptsRoot;
      const runScript = this._runScript;
      return {
        type: 'script',
        mode: 'gateway',
        run: () => runScript(scriptsRoot, invoke, args),
      };
    }

    if (invoke.type === 'shell') {
      // Deliberately do NOT spawn a shell here. Hand the descriptor to the
      // gated runner, which executes shell only after PreToolUse allows it.
      return {
        type: 'shell',
        mode: 'gateway',
        run: async () => ({
          deferred: true,
          type: 'shell',
          command: invoke.command,
          args: args ?? null,
        }),
      };
    }

    // validateEntry guards the load path, but guard here too for late mutation.
    throw new Error(`Registry.resolveExecution: unsupported invoke.type for "${id}"`);
  }

  /**
   * The resolved execution mode for a tool ("gateway" | "reference"). Exposed so callers
   * (UI, tests) can ask without resolving a full executor. Throws on unknown id.
   * @param {string} id
   * @returns {"gateway"|"reference"}
   */
  mode(id) {
    const entry = this._byId.get(id);
    if (!entry) throw new Error(`Registry.mode: unknown tool id "${id}"`);
    return resolveMode(entry);
  }

  // ---- internals ----------------------------------------------------------

  /** Serialise current state back to the register file atomically. */
  _persist() {
    const obj = {
      version: this._version,
      description: this._description,
      tools: [...this._byId.values()],
    };
    atomicWriteJson(this._filePath, obj);
  }

  /** @returns {number} */
  get size() {
    return this._byId.size;
  }
}

/**
 * loadRegistry(path) -> Registry
 *
 * Reads + parses the register JSON at `filePath` and returns a Registry bound to
 * it. Throws a clear error on a missing/malformed file or a bad entry shape so
 * misconfiguration is caught at load time, not at model-call time.
 *
 * @param {string} filePath
 * @param {object} [opts]  forwarded to the Registry ctor (scriptsRoot, runScript)
 * @returns {Registry}
 */
function loadRegistry(filePath, opts = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('loadRegistry: filePath (non-empty string) is required');
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`loadRegistry: cannot read register at "${filePath}": ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`loadRegistry: register at "${filePath}" is not valid JSON: ${err.message}`);
  }
  return new Registry({ filePath, data, ...opts });
}

module.exports = {
  Registry,
  loadRegistry,
  // exported for unit tests / the gated runner
  atomicWriteJson,
  validateEntry,
  defaultRunScript,
  resolveMode,
  VALID_INVOKE_TYPES,
  VALID_MODES,
};
