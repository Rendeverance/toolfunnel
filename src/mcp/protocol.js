'use strict';

/**
 * protocol.js - the lean meta-tool protocol.
 *
 * This is the PURE dispatch core for the gateway's MCP server. It knows nothing about the
 * transport (no stdio, no SDK, no host, no filesystem) - every capability it needs
 * is INJECTED as a dependency so the whole thing unit-tests under `node:test` with plain
 * stub objects. `server.js` (the thin JSON-RPC 2.0 / stdio wrapper) is the only thing that
 * binds this to a transport.
 *
 * The model's tool surface is kept to exactly FOUR meta-tools:
 *
 *   | Tool                         | Args                 | Returns                              |
 *   |------------------------------|----------------------|--------------------------------------|
 *   | toolfunnel_list_tools        | { filter?, category?}| [{ name, summary, category }]        |
 *   | toolfunnel_tool_instructions | { name }             | full usage/docs for one tool         |
 *   | toolfunnel_run_tool          | { name, args }       | tool result { ok, output, error? }   |
 *   | toolfunnel_howto             | { topic }            | self-extension instructions          |
 *
 * The load-bearing one is `toolfunnel_run_tool`: it does **NOT** execute directly. It resolves
 * the tool's executor from the register, then hands it to `gatedRun`, which fires the host's
 * PreToolUse hooks (the gate - may DENY), executes ONLY if allowed, then fires PostToolUse
 * (PreToolUse blocks via `hookSpecificOutput.permissionDecision`). This module therefore NEVER
 * calls a tool's `execute` itself - it always goes through the gate. That invariant is the whole
 * safety case.
 *
 * Defensive by construction: an unknown meta-tool, a malformed argument, or a thrown
 * dependency all resolve to a clear *error result*. `dispatch()` never throws.
 *
 * Injected dependencies (makeProtocol({ ... })):
 *   - registry : the dynamic tool register (src/tools/registry.js). Used:
 *       registry.list({ filter, category })      -> [{ name, summary, category }]
 *       registry.instructions(name)              -> full docs (string or structured)
 *       registry.resolveExecution(name, args)    -> { execute, toolName?, args?, ... }
 *                                                   where `execute` is a () => any|Promise<any>
 *                                                   bound to run the actual tool.
 *   - gatedRun : async ({ engine, ctx, toolName, args, execute }) -> { ok, output, error? }
 *       fires PreToolUse (gate), runs `execute` iff allowed, fires PostToolUse.
 *   - engine   : the HookEngine (passed straight through to gatedRun; not used directly here).
 *   - ctx      : the session context object (session_id, cwd, transcript_path, ...) passed to gatedRun.
 *   - howto    : (topic) -> self-extension instructions for create-tool|add-mcp|add-hook|package.
 *
 * CommonJS only. Node built-ins only. No transport. No SDK.
 */

// Activity log. Self-gating (no-op unless explicitly enabled) and contracted never to
// throw, so emit points cannot alter dispatch behaviour or break a tool run.
const logger = require('../core/logger');

/** The four meta-tool names - the entire exposed surface. */
const META_TOOLS = Object.freeze({
  LIST: 'toolfunnel_list_tools',
  INSTRUCTIONS: 'toolfunnel_tool_instructions',
  RUN: 'toolfunnel_run_tool',
  HOWTO: 'toolfunnel_howto',
});

/** Valid `toolfunnel_howto` topics. */
const HOWTO_TOPICS = Object.freeze(['create-tool', 'add-mcp', 'add-hook', 'package', 'wrap', 'configure']);

/**
 * Build a normalized error result. Meta-tool calls always resolve to a result object
 * (never throw), so the server can surface a clean message to the model instead of a
 * crashed JSON-RPC call.
 *
 * @param {string} message human/model-facing error text
 * @returns {{ ok: false, output: null, error: string }}
 */
function errorResult(message) {
  return { ok: false, output: null, error: String(message) };
}

/**
 * Build a normalized success result.
 *
 * @param {*} output the payload to return to the model
 * @returns {{ ok: true, output: * }}
 */
function okResult(output) {
  return { ok: true, output };
}

/**
 * Normalize whatever a dependency returns into the canonical { ok, output, error? } shape.
 * `gatedRun` is contracted to already return this shape - if it does, pass it through
 * untouched (preserving any extra fields like a block reason). Anything else is wrapped
 * as a success payload.
 *
 * @param {*} value
 * @returns {{ ok: boolean, output?: *, error?: string }}
 */
function normalizeResult(value) {
  if (value && typeof value === 'object' && typeof value.ok === 'boolean') {
    return value; // already in canonical form (e.g. straight from gatedRun)
  }
  return okResult(value);
}

/**
 * makeProtocol - construct the meta-tool dispatcher.
 *
 * @param {object} deps
 * @param {object} deps.registry  dynamic tool register (list/instructions/resolveExecution)
 * @param {(o: { engine: object, ctx: object, toolName: string, args: object,
 *            execute: () => (any|Promise<any>) }) => Promise<{ok:boolean, output?:any, error?:string}>}
 *            deps.gatedRun  the hook-gated executor (PreToolUse -> execute -> PostToolUse)
 * @param {object} [deps.engine]  the HookEngine, forwarded to gatedRun
 * @param {object} [deps.ctx]     session context, forwarded to gatedRun
 * @param {(topic: string) => (string|object)} deps.howto  self-extension instruction provider
 * @returns {{
 *   META_TOOLS: object,
 *   HOWTO_TOPICS: string[],
 *   toolDefinitions: () => Array<{name:string, description:string, inputSchema:object}>,
 *   dispatch: (toolName: string, args?: object) => Promise<{ok:boolean, output?:any, error?:string}>,
 *   listTools: (args?: object) => Promise<object>,
 *   toolInstructions: (args?: object) => Promise<object>,
 *   runTool: (args?: object) => Promise<object>,
 *   howtoTool: (args?: object) => Promise<object>
 * }}
 */
function makeProtocol(deps) {
  const d = deps || {};
  const registry = d.registry;
  const gatedRun = d.gatedRun;
  const engine = d.engine;
  const ctx = d.ctx;
  const howto = d.howto;

  // ---- toolfunnel_list_tools ----------------------------------------------
  // Return the register, briefs only. Filtering/categorisation is the register's job
  // (it owns the data); we just forward the optional filter/category through.
  async function listTools(args) {
    if (!registry || typeof registry.list !== 'function') {
      return errorResult('toolfunnel_list_tools: registry.list is unavailable');
    }
    const a = args || {};
    const opts = {};
    if (a.filter !== undefined) opts.filter = a.filter;
    if (a.category !== undefined) opts.category = a.category;
    try {
      const list = await registry.list(opts);
      return okResult(list);
    } catch (err) {
      return errorResult(`toolfunnel_list_tools failed: ${(err && err.message) || err}`);
    }
  }

  // ---- toolfunnel_tool_instructions ---------------------------------------
  // Full usage/docs for ONE register tool, on demand (long-tail friendly).
  async function toolInstructions(args) {
    if (!registry || typeof registry.instructions !== 'function') {
      return errorResult('toolfunnel_tool_instructions: registry.instructions is unavailable');
    }
    const a = args || {};
    const name = a.name;
    if (typeof name !== 'string' || name.length === 0) {
      return errorResult('toolfunnel_tool_instructions: "name" (non-empty string) is required');
    }
    try {
      const docs = await registry.instructions(name);
      if (docs === undefined || docs === null) {
        return errorResult(`toolfunnel_tool_instructions: no tool named "${name}"`);
      }
      return okResult(docs);
    } catch (err) {
      return errorResult(`toolfunnel_tool_instructions failed for "${name}": ${(err && err.message) || err}`);
    }
  }

  // ---- toolfunnel_run_tool ------------------------------------------------
  // THE load-bearing meta-tool. Resolve the executor from the register, then run it
  // ONLY through gatedRun (PreToolUse gate -> execute -> PostToolUse). This function
  // must NEVER call `execute` itself - that would bypass the gate and break the entire
  // safety case.
  async function runTool(args) {
    const a = args || {};
    const name = a.name;
    if (typeof name !== 'string' || name.length === 0) {
      return errorResult('toolfunnel_run_tool: "name" (non-empty string) is required');
    }
    if (!registry || typeof registry.resolveExecution !== 'function') {
      return errorResult('toolfunnel_run_tool: registry.resolveExecution is unavailable');
    }
    if (typeof gatedRun !== 'function') {
      return errorResult('toolfunnel_run_tool: gatedRun is unavailable - refusing to execute ungated');
    }

    // The tool's input args (the model's payload for the underlying tool).
    const toolArgs = a.args !== undefined && a.args !== null ? a.args : {};

    // 1) Resolve how to execute this tool. The register turns (name, args) into a bound
    //    executor. A null/undefined resolution means "no such tool" - a clean error, not a throw.
    let resolution;
    try {
      resolution = await registry.resolveExecution(name, toolArgs);
    } catch (err) {
      return errorResult(`toolfunnel_run_tool: could not resolve "${name}": ${(err && err.message) || err}`);
    }

    // 1a) REFERENCE mode. A reference tool executes NOTHING here - the connected AI performs the
    //     action in its OWN environment per the instructions, so we NEVER spawn and NEVER call
    //     gatedRun. The HANDOFF itself, however, is gated: reference fires PreToolUse ADVISORILY -
    //     a deny gates the instructions HANDOFF, not the AI's own-environment execution. A
    //     PreToolUse deny therefore REFUSES to hand over the instructions (a handoff-gate); allow /
    //     no-engine / no-ctx hands them over exactly as before. Nothing runs here in EITHER case.
    //     Gateway tools fall through to the gate below, byte-for-byte unchanged.
    if (resolution && resolution.mode === 'reference') {
      const refInstructions =
        typeof resolution.instructions === 'string' ? resolution.instructions : '';
      // The gate name is the SAME one the gateway path uses for this tool, so a PreToolUse matcher
      // sees a stable tool_name regardless of mode.
      const gateName = typeof resolution.toolName === 'string' ? resolution.toolName : name;

      // The unconditional handoff - also the SAFE fallback when there is no engine/ctx to gate with.
      const handoff = (additionalContext) => {
        logger.log({ type: 'tool', name, mode: 'reference', ok: true, blocked: false });
        const out = {
          ok: true,
          mode: 'reference',
          name,
          instructions: refInstructions,
          message: 'reference tool - perform this in your own environment per the instructions',
        };
        if (typeof additionalContext === 'string' && additionalContext.length > 0) {
          out.additionalContext = additionalContext;
        }
        return out;
      };

      // No engine / no ctx -> cannot gate; hand the instructions over exactly as before.
      if (!engine || typeof engine.fire !== 'function' || !ctx) {
        return handoff();
      }

      // Fire PreToolUse the same way gatedRun does: engine.fire('PreToolUse', ctx,
      // { tool_name, tool_input }). The engine has already normalised any deny into
      // { blocked, reason } and any injected additionalContext into { injected }.
      let pre = null;
      try {
        pre = await engine.fire('PreToolUse', ctx, { tool_name: gateName, tool_input: toolArgs });
      } catch (_err) {
        // A misbehaving engine must not break the advisory handoff - fall back to handing over.
        pre = null;
      }

      if (pre && pre.blocked === true) {
        // DENY -> refuse the HANDOFF. No instructions, no spawn.
        logger.log({ type: 'tool', name, mode: 'reference', ok: false, blocked: true });
        return {
          ok: false,
          blocked: true,
          mode: 'reference',
          name,
          reason: pre.reason != null ? pre.reason : 'blocked by PreToolUse',
        };
      }

      // Allowed -> hand over, carrying any hook-injected additionalContext.
      return handoff(pre && typeof pre.injected === 'string' ? pre.injected : '');
    }

    if (!resolution || typeof resolution.execute !== 'function') {
      return errorResult(
        `toolfunnel_run_tool: tool "${name}" is not runnable (no executable resolution from the register)`
      );
    }

    // Prefer the register's canonical toolName/args (it may normalize them); fall back to
    // what the caller gave. The toolName is what PreToolUse matchers see - it must be stable.
    const toolName = typeof resolution.toolName === 'string' ? resolution.toolName : name;
    const execArgs = resolution.args !== undefined ? resolution.args : toolArgs;

    // The execution mode for logging - the resolution's own mode if it set one, else
    // the default gateway path.
    const mode = typeof resolution.mode === 'string' ? resolution.mode : 'gateway';

    // 2) Execute ONLY through the gate. gatedRun fires PreToolUse (may deny), runs execute
    //    iff allowed, then fires PostToolUse, and returns the canonical { ok, output, error? }.
    const startedAt = Date.now();
    try {
      const result = await gatedRun({
        engine,
        ctx,
        toolName,
        args: execArgs,
        execute: resolution.execute,
      });
      const normalized = normalizeResult(result);
      // Activity log: record the run outcome. Self-gates on enabled; never throws.
      logger.log({
        type: 'tool',
        name,
        mode,
        ok: normalized.ok === true,
        blocked: normalized.blocked === true,
        durationMs: Date.now() - startedAt,
      });
      return normalized;
    } catch (err) {
      // gatedRun is contracted not to throw, but if it does we still return a clean result.
      logger.log({
        type: 'tool',
        name,
        mode,
        ok: false,
        blocked: false,
        durationMs: Date.now() - startedAt,
      });
      return errorResult(`toolfunnel_run_tool: gated execution of "${name}" failed: ${(err && err.message) || err}`);
    }
  }

  // ---- toolfunnel_howto ---------------------------------------------------
  // Self-extension instructions for a known topic (makes the system self-extending).
  async function howtoTool(args) {
    if (typeof howto !== 'function') {
      return errorResult('toolfunnel_howto: howto provider is unavailable');
    }
    const a = args || {};
    const topic = a.topic;
    if (typeof topic !== 'string' || topic.length === 0) {
      return errorResult(
        `toolfunnel_howto: "topic" is required (one of ${HOWTO_TOPICS.join(' | ')})`
      );
    }
    if (!HOWTO_TOPICS.includes(topic)) {
      return errorResult(
        `toolfunnel_howto: unknown topic "${topic}" (expected one of ${HOWTO_TOPICS.join(' | ')})`
      );
    }
    try {
      const content = await howto(topic);
      if (content === undefined || content === null) {
        return errorResult(`toolfunnel_howto: no instructions available for topic "${topic}"`);
      }
      return okResult(content);
    } catch (err) {
      return errorResult(`toolfunnel_howto failed for "${topic}": ${(err && err.message) || err}`);
    }
  }

  // ---- dispatch -----------------------------------------------------------
  // The server's single entry point. Pure routing; never throws - an unknown tool or any
  // internal failure becomes a clear error result (defensive by construction).
  async function dispatch(toolName, args) {
    try {
      switch (toolName) {
        case META_TOOLS.LIST:
          return await listTools(args);
        case META_TOOLS.INSTRUCTIONS:
          return await toolInstructions(args);
        case META_TOOLS.RUN:
          return await runTool(args);
        case META_TOOLS.HOWTO:
          return await howtoTool(args);
        default: {
          const known = Object.values(META_TOOLS).join(', ');
          return errorResult(
            `Unknown meta-tool "${toolName}". This MCP exposes only: ${known}.`
          );
        }
      }
    } catch (err) {
      // Last line of defence: dispatch itself must never throw.
      return errorResult(
        `dispatch("${toolName}") failed unexpectedly: ${(err && err.message) || err}`
      );
    }
  }

  // ---- toolDefinitions ----------------------------------------------------
  // The JSON-Schema input shapes for the ADVERTISED meta-tools, for `tools/list`.
  // All FOUR are advertised: list, instructions, run, howto. toolfunnel_run_tool executes
  // a register tool ONLY through gatedRun (PreToolUse gate -> execute -> PostToolUse), so a
  // connected agent can run tools while every call still passes through the gate - the gate,
  // not the absence of the meta-tool, is the safety boundary.
  function toolDefinitions() {
    return [
      {
        name: META_TOOLS.LIST,
        description:
          'List the available tools (briefs only). Optionally filter by a free-text ' +
          'string and/or a category. Returns [{ name, summary, category }]. ' +
          'Call toolfunnel_tool_instructions for a specific tool, then run it yourself per its instructions.',
        inputSchema: {
          type: 'object',
          properties: {
            filter: {
              type: 'string',
              description: 'Optional free-text filter matched against tool name/summary.',
            },
            category: {
              type: 'string',
              description: 'Optional category to restrict the listing to.',
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: META_TOOLS.INSTRUCTIONS,
        description:
          'Get the full usage instructions / documentation for one tool by name (venv, the ' +
          'reliable invoke command, safety notes). Read this before running the tool yourself.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The exact tool name (as returned by toolfunnel_list_tools).',
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      {
        name: META_TOOLS.RUN,
        description: 'Execute one register tool by its name through the gateway PreToolUse gate. Args: { name, args? }. Call toolfunnel_tool_instructions first to learn the tool\'s arg shape. Returns { ok, output, error? }. Every call is gated (a PreToolUse hook may deny it).',
        inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Exact tool name from toolfunnel_list_tools.' }, args: { type: 'object', description: 'Structured arguments forwarded to the tool. Optional.' } }, required: ['name'], additionalProperties: false },
      },
      {
        name: META_TOOLS.HOWTO,
        description:
          'Get self-extension instructions: how to author a new tool, register an upstream ' +
          'MCP, add a hook, build a shareable package, WRAP one MCP server as the entire ' +
          'surface (transparent passthrough), or configure the gateway with JSON files only. ' +
          'The system documents how to extend itself.',
        inputSchema: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              enum: HOWTO_TOPICS.slice(),
              description:
                'Which guide to return: create-tool | add-mcp | add-hook | package | wrap | configure.',
            },
          },
          required: ['topic'],
          additionalProperties: false,
        },
      },
    ];
  }

  return {
    META_TOOLS,
    HOWTO_TOPICS,
    toolDefinitions,
    dispatch,
    // Individual handlers exported for direct unit testing / reuse.
    listTools,
    toolInstructions,
    runTool,
    howtoTool,
  };
}

module.exports = {
  makeProtocol,
  META_TOOLS,
  HOWTO_TOPICS,
  // Exported for tests / reuse:
  errorResult,
  okResult,
  normalizeResult,
};
