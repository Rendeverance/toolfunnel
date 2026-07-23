'use strict';

/**
 * tool-registry.js - backend-agnostic tool catalogue for the host loop.
 *
 * The host asks the registry for tool definitions to hand to a backend
 * (see ARCHITECTURE.md: `backend.send({ system, messages, tools })`). When the
 * model requests a tool by name, the host executes it here. The registry holds
 * NO host imports so it runs headless under `node --test`.
 *
 * A tool is registered as: register(name, { description, inputSchema, run })
 *   - description: human/model-facing string
 *   - inputSchema: a JSON-schema-ish object describing the input (handed to the backend)
 *   - run(input): the implementation; may be sync or async; its return value is the result
 */

const fs = require('node:fs');
const path = require('node:path');

class ToolRegistry {
  constructor() {
    // name -> { description, inputSchema, run }
    this._tools = new Map();
  }

  /**
   * Register a tool under a unique name.
   * Throws on a bad shape so misconfiguration is caught at wiring time, not at
   * model-call time (the loop must never receive a half-formed tool).
   *
   * @param {string} name
   * @param {{ description?: string, inputSchema?: object, run: (input:any)=>any }} def
   * @returns {ToolRegistry} this (for chaining)
   */
  register(name, def) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('ToolRegistry.register: name must be a non-empty string');
    }
    if (!def || typeof def !== 'object') {
      throw new Error(`ToolRegistry.register("${name}"): definition object is required`);
    }
    if (typeof def.run !== 'function') {
      throw new Error(`ToolRegistry.register("${name}"): "run" must be a function`);
    }
    if (this._tools.has(name)) {
      throw new Error(`ToolRegistry.register("${name}"): tool already registered`);
    }
    this._tools.set(name, {
      description: typeof def.description === 'string' ? def.description : '',
      // Default to an open object schema so a tool without a declared schema
      // still produces a valid definition for the backend.
      inputSchema:
        def.inputSchema && typeof def.inputSchema === 'object'
          ? def.inputSchema
          : { type: 'object', properties: {} },
      run: def.run,
    });
    return this;
  }

  /** @param {string} name @returns {boolean} */
  has(name) {
    return this._tools.has(name);
  }

  /**
   * Execute a registered tool by name. Always returns a Promise so the host
   * loop can `await` uniformly regardless of whether `run` was sync or async.
   * Throws a clear error if the tool is unknown (the host turns this into a
   * tool result / PostToolUse feedback rather than crashing the loop).
   *
   * @param {string} name
   * @param {any} input
   * @returns {Promise<any>} the tool's result
   */
  async execute(name, input) {
    const tool = this._tools.get(name);
    if (!tool) {
      const known = this.list().map((t) => t.name);
      throw new Error(
        `ToolRegistry.execute: unknown tool "${name}". ` +
          `Registered tools: ${known.length ? known.join(', ') : '(none)'}`
      );
    }
    // Await covers both sync return values and returned Promises.
    return await tool.run(input);
  }

  /**
   * Tool definitions array, shaped for handing to a backend:
   * `[{ name, description, inputSchema }]`. The `run` function is deliberately
   * omitted - the backend never needs (or should see) the implementation.
   *
   * @returns {Array<{ name: string, description: string, inputSchema: object }>}
   */
  list() {
    const out = [];
    for (const [name, tool] of this._tools) {
      out.push({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
    return out;
  }
}

/**
 * makeDemoRegistry - a ToolRegistry preloaded with two demo tools used by the
 * host tests (host.test.js drives the lifecycle through these).
 *
 *   echo               - returns its input unchanged (trivial, deterministic).
 *   readFileSandboxed  - reads a UTF-8 file, but ONLY within `sandboxRoot`,
 *                        rejecting any path that escapes the sandbox. This is
 *                        the same defense-in-depth posture the hook loader's
 *                        writeScript guard uses (HOOK_ENGINE.md §8) - a tool the
 *                        model can call must not become a filesystem escape.
 *
 * @param {object} [opts]
 * @param {string} [opts.sandboxRoot=process.cwd()] absolute root for readFileSandboxed
 * @returns {ToolRegistry}
 */
function makeDemoRegistry(opts) {
  const sandboxRoot = path.resolve((opts && opts.sandboxRoot) || process.cwd());
  const registry = new ToolRegistry();

  registry.register('echo', {
    description: 'Returns its input unchanged. Useful for testing the tool loop.',
    inputSchema: {
      type: 'object',
      description: 'Any JSON value passed through as-is.',
      properties: {},
      additionalProperties: true,
    },
    run: (input) => input,
  });

  registry.register('readFileSandboxed', {
    description:
      'Reads a UTF-8 text file located within the sandbox root. ' +
      'Rejects absolute paths and any relative path that escapes the sandbox.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to read, relative to the sandbox root.',
        },
      },
      required: ['path'],
    },
    run: (input) => {
      const requested = input && input.path;
      if (typeof requested !== 'string' || requested.length === 0) {
        throw new Error('readFileSandboxed: "path" (non-empty string) is required');
      }
      // Reject absolute paths outright; everything must be relative to the sandbox.
      if (path.isAbsolute(requested)) {
        throw new Error(
          `readFileSandboxed: absolute paths are not allowed ("${requested}")`
        );
      }
      // Resolve against the sandbox, then confirm the result is still inside it.
      const resolved = path.resolve(sandboxRoot, requested);
      const rel = path.relative(sandboxRoot, resolved);
      // rel starting with ".." (or an absolute path on a different drive) means escape.
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(
          `readFileSandboxed: path escapes sandbox root ("${requested}")`
        );
      }
      return fs.readFileSync(resolved, 'utf8');
    },
  });

  return registry;
}

module.exports = { ToolRegistry, makeDemoRegistry };
