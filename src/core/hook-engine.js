'use strict';

/**
 * hook-engine.js - fire a lifecycle event through its matching, enabled hooks.
 *
 * Contract: fire() never rejects - see the class doc below.
 *
 *   class HookEngine {
 *     constructor(loader)                       // loader provides enabled hook specs
 *     async fire(event, ctx, extra) -> {
 *       injected:  string,        // all non-null inject fragments joined by "\n"
 *       blocked:   boolean,       // any hook blocked
 *       reason:    string|null,   // first block reason (in manifest order)
 *       stopLoop:  boolean,       // any hook said continue:false
 *       results:   HookResult[]   // runner-result shapes, in stable (manifest) order
 *     }
 *   }
 *
 * Behaviour:
 *   - Select hooks where spec.event === event AND spec.enabled AND matches(spec.matcher, toolName).
 *     Tool-less events (SessionStart, UserPromptSubmit, Stop, PreCompact) ignore the matcher -
 *     matcher.js handles that, but we also derive toolName only from the built payload so the
 *     matcher gets exactly what the contract says it should see.
 *   - A matcher that does not COMPILE is an unreadable gate: on a tool-bearing event the hook
 *     contributes a synthetic BLOCKING result (its command never runs) - an unreadable gate is
 *     never permission, mirroring the runner's unreadable-decision rule. Authoring surfaces
 *     refuse such a matcher up front (hook-loader.addEntry), so this only fires for a
 *     hand-edited manifest. (0.7.0; matcher-compile.test.js is the acceptance.)
 *   - Build the stdin payload once via events.buildPayload(event, ctx, extra).
 *   - Run selected hooks CONCURRENTLY (they are independent) with a global concurrency cap
 *     (default 8) so a big event cannot fork-bomb, but return results in MANIFEST ORDER.
 *   - injected = every non-null inject joined by "\n", in order.
 *   - blocked/reason = the FIRST blocker in order.
 *   - stopLoop = true if ANY hook returned continue:false.
 *
 * The runner never throws (its hard guarantee), and this engine defends against a misbehaving runner too:
 * any rejection is converted into a synthetic error result so fire() never rejects.
 *
 * CommonJS only. Zero host imports (must run headless under `node --test`).
 */

const path = require('node:path');

// Sibling core modules (authored to the same contract in this build pass).
const matcher = require('./matcher');
const events = require('./events');
const hookRunner = require('./hook-runner');

const DEFAULT_CONCURRENCY = 8;

/**
 * Resolve the matcher function from matcher.js regardless of whether it is the default or
 * a named export, so we interlock with the contract's `matches(matcher, toolName)`.
 * @returns {(m: string|undefined, toolName: string) => boolean}
 */
function getMatchesFn() {
  if (typeof matcher === 'function') return matcher;
  if (matcher && typeof matcher.matches === 'function') return matcher.matches;
  // Defensive fallback: if matcher.js is unavailable, fire everything (never crash).
  return () => true;
}

/**
 * Resolve matcherError from matcher.js (named export). Falls back to "no problem" so an older
 * matcher module degrades to the previous behaviour rather than crashing the engine.
 * @returns {(m: string|undefined) => (string|null)}
 */
function getMatcherErrorFn() {
  if (matcher && typeof matcher.matcherError === 'function') return matcher.matcherError;
  return () => null;
}

/**
 * Resolve buildPayload from events.js (named export per contract).
 * @returns {(event: string, ctx: object, extra: object) => object}
 */
function getBuildPayloadFn() {
  if (events && typeof events.buildPayload === 'function') return events.buildPayload;
  // Defensive fallback: assemble a minimal common payload.
  return (event, ctx, extra) =>
    Object.assign(
      {
        session_id: (ctx && ctx.session_id) || '',
        transcript_path: (ctx && ctx.transcript_path) || '',
        cwd: (ctx && ctx.cwd) || process.cwd(),
        hook_event_name: event,
      },
      extra || {}
    );
}

/**
 * Resolve runHook from hook-runner.js (named export per contract).
 * @returns {(spec: object, payload: object, opts: object) => Promise<object>}
 */
function getRunHookFn() {
  if (hookRunner && typeof hookRunner.runHook === 'function') return hookRunner.runHook;
  if (typeof hookRunner === 'function') return hookRunner;
  throw new Error('hook-engine: hook-runner.runHook is unavailable');
}

/**
 * Build a synthetic "failed" result matching the runner's result shape, used when the runner rejects
 * unexpectedly (it is contractually not supposed to, but we never let the loop throw).
 * @param {object} spec
 * @param {string} event
 * @param {Error} err
 * @param {number} durationMs
 * @returns {object}
 */
function syntheticFailure(spec, event, err, durationMs) {
  return {
    id: spec && spec.id,
    event,
    exitCode: -1,
    timedOut: false,
    stdout: '',
    stderr: (err && err.message) || String(err),
    blocked: false,
    stopLoop: false,
    reason: null,
    inject: null,
    durationMs: durationMs || 0,
  };
}

/**
 * Run an array of async task factories with a concurrency cap, preserving input order in
 * the returned results array. Each task is a `() => Promise<T>`; the returned slot holds
 * the resolved value (tasks here are written to never reject).
 *
 * @template T
 * @param {Array<() => Promise<T>>} taskFactories
 * @param {number} cap maximum simultaneous tasks
 * @returns {Promise<T[]>} results in the same order as taskFactories
 */
async function runWithConcurrency(taskFactories, cap) {
  const total = taskFactories.length;
  const results = new Array(total);
  if (total === 0) return results;

  const limit = Math.max(1, Math.min(cap || DEFAULT_CONCURRENCY, total));
  let nextIndex = 0;

  // Each worker pulls the next index until the queue drains.
  async function worker() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const i = nextIndex++;
      if (i >= total) return;
      results[i] = await taskFactories[i]();
    }
  }

  const workers = [];
  for (let w = 0; w < limit; w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

class HookEngine {
  /**
   * @param {object} loader a HookLoader (or any object exposing enabledHooksFor(event)).
   * @param {object} [options]
   * @param {number} [options.concurrency=8] global concurrency cap per fire().
   * @param {string} [options.cwd] working dir passed to the runner.
   * @param {object} [options.env] base env merged into the runner's child env.
   */
  constructor(loader, options) {
    if (!loader || typeof loader.enabledHooksFor !== 'function') {
      throw new TypeError('HookEngine: loader must expose enabledHooksFor(event)');
    }
    this.loader = loader;
    const opts = options || {};
    this.concurrency =
      Number.isInteger(opts.concurrency) && opts.concurrency > 0
        ? opts.concurrency
        : DEFAULT_CONCURRENCY;
    this.cwd = opts.cwd || (loader.hooksDir ? path.dirname(loader.hooksDir) : process.cwd());
    this.env = opts.env || null;

    // Resolve contract functions once.
    this._matches = getMatchesFn();
    this._matcherError = getMatcherErrorFn();
    this._buildPayload = getBuildPayloadFn();
    this._runHook = getRunHookFn();
  }

  /**
   * Fire a lifecycle event through its matching, enabled hooks.
   *
   * @param {string} event one of EVENTS (e.g. "PreToolUse")
   * @param {object} [ctx] common context: { session_id, transcript_path, cwd, ... }
   * @param {object} [extra] event-specific fields (tool_name, tool_input, prompt, source, ...)
   * @returns {Promise<{injected:string, blocked:boolean, reason:(string|null),
   *                     stopLoop:boolean, results:object[]}>}
   */
  async fire(event, ctx, extra) {
    const context = ctx || {};
    const extraFields = extra || {};

    // Build the stdin payload once (the contract's frozen field names).
    let payload;
    try {
      payload = this._buildPayload(event, context, extraFields);
    } catch (err) {
      // If payload assembly fails, fall back to a minimal valid payload so hooks still run.
      payload = Object.assign(
        {
          session_id: context.session_id || '',
          transcript_path: context.transcript_path || '',
          cwd: context.cwd || this.cwd,
          hook_event_name: event,
        },
        extraFields
      );
    }

    // The toolName for matcher scoping comes from the payload (tool-bearing events only).
    // For tool-less events this is undefined and matcher.js treats it as always-fire.
    const toolName = payload && payload.tool_name;

    // Resolve the child cwd/env once for the runner.
    const runCwd = (payload && payload.cwd) || this.cwd;
    const runOpts = { cwd: runCwd };
    if (this.env) runOpts.env = this.env;

    // Select enabled hooks for this event and build task factories, in MANIFEST ORDER.
    //
    // A matcher that does not COMPILE cannot be evaluated, and an unreadable gate is never
    // permission - the same rule the runner applies to an unreadable decision (gate-semantics /
    // matcher-compile tests). On a TOOL-BEARING event such a hook contributes a synthetic
    // BLOCKING result in its manifest position (its command is never run); authoring surfaces
    // refuse the pattern up front (hook-loader.addEntry), so this branch only fires for a
    // hand-edited manifest. Tool-less events ignore the matcher entirely (existing contract).
    const candidates = this.loader.enabledHooksFor(event) || [];
    const factories = [];
    for (const spec of candidates) {
      if (toolName !== undefined && toolName !== null) {
        let compileProblem = null;
        try {
          compileProblem = this._matcherError(spec && spec.matcher);
        } catch (_) {
          compileProblem = null; // discriminator itself failing must not take the engine down
        }
        if (compileProblem) {
          const unreadable = {
            id: spec && spec.id,
            event,
            exitCode: -1,
            timedOut: false,
            stdout: '',
            stderr: '',
            blocked: true,
            stopLoop: false,
            reason:
              `hook-engine: hook "${(spec && spec.id) || '(unnamed)'}" has a matcher that does ` +
              `not compile (${compileProblem}); its gate could not be read, so the call is ` +
              'denied (fail closed). Fix or disable the hook.',
            inject: null,
            durationMs: 0,
          };
          factories.push(async () => unreadable);
          continue;
        }
      }

      let fires = false;
      try {
        fires = this._matches(spec && spec.matcher, toolName);
      } catch (_) {
        // A matcher evaluation crash should not crash the engine; skip that hook.
        fires = false;
      }
      if (!fires) continue;

      factories.push(async () => {
        const started = Date.now();
        try {
          const res = await this._runHook(spec, payload, runOpts);
          // Defensive: ensure the result carries id/event even if the runner omitted them.
          if (res && typeof res === 'object') {
            if (res.id === undefined) res.id = spec.id;
            if (res.event === undefined) res.event = event;
            return res;
          }
          return syntheticFailure(spec, event, new Error('runner returned no result'), Date.now() - started);
        } catch (err) {
          return syntheticFailure(spec, event, err, Date.now() - started);
        }
      });
    }

    // Run concurrently with the cap; results come back in manifest order.
    const results = await runWithConcurrency(factories, this.concurrency);

    // Aggregate the per-hook results into the engine outcome.
    const injectFragments = [];
    let blocked = false;
    let reason = null;
    let stopLoop = false;

    for (const r of results) {
      if (!r) continue;
      if (r.inject != null) injectFragments.push(r.inject);
      if (r.blocked && !blocked) {
        // First blocker in order owns the reason.
        blocked = true;
        reason = r.reason != null ? r.reason : null;
      }
      if (r.stopLoop) stopLoop = true;
    }

    return {
      injected: injectFragments.join('\n'),
      blocked,
      reason,
      stopLoop,
      results,
    };
  }
}

module.exports = {
  HookEngine,
  DEFAULT_CONCURRENCY,
  // Exported for unit tests / reuse:
  runWithConcurrency,
};
