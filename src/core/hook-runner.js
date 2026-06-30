'use strict';

/**
 * hook-runner.js — run ONE command hook and return a structured result.
 *
 * Authoritative contract: docs/HOOK_ENGINE.md §3 (two output protocols) and §4
 * (the exact result shape). This module is backend-agnostic and has ZERO host-framework
 * imports so it runs headless under `node --test`.
 *
 * Hard guarantee (§4): runHook NEVER rejects. A spawn failure or a timeout always
 * resolves with the full result object (exitCode:-1, timedOut set appropriately,
 * blocked:false).
 */

const { spawn, execFile } = require('node:child_process');
const path = require('node:path');

// Default HOOKS_DIR: <root>/src/hooks. __dirname is <root>/src/core, so up one.
const DEFAULT_HOOKS_DIR = path.resolve(__dirname, '..', 'hooks');

// Events whose exit-0 stdout is treated as injected context (§3-A, §1 table).
const INJECTABLE_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);

/**
 * Decide whether a parsed stdout object should be treated as the §3-B JSON
 * protocol. We only switch to the JSON interpretation when the object actually
 * carries one of the protocol's known keys — otherwise an arbitrary JSON blob a
 * hook happens to print should fall through to the exit-code protocol (§3:
 * "Exit-code protocol wins if stdout is not valid JSON").
 *
 * @param {*} parsed
 * @returns {boolean}
 */
function isKnownJsonProtocol(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(parsed, 'continue') ||
    Object.prototype.hasOwnProperty.call(parsed, 'decision') ||
    Object.prototype.hasOwnProperty.call(parsed, 'reason') ||
    Object.prototype.hasOwnProperty.call(parsed, 'hookSpecificOutput')
  );
}

/**
 * Try to parse stdout as the JSON protocol. Returns the parsed object only if it
 * is valid JSON AND carries known protocol keys; otherwise null (use exit-code
 * protocol).
 *
 * @param {string} stdout
 * @returns {object|null}
 */
function tryParseJsonProtocol(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return null;
  // Cheap pre-check: protocol output is always a JSON object.
  if (trimmed[0] !== '{') return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (_e) {
    return null; // not valid JSON → exit-code protocol wins
  }
  return isKnownJsonProtocol(parsed) ? parsed : null;
}

/**
 * Run a single command hook.
 *
 * @param {object} hookSpec  Resolved spec: { id, event, command, timeout(seconds), ... }.
 * @param {object} payload   The stdin JSON object (built by events.js buildPayload).
 * @param {object} [opts]
 * @param {string} [opts.cwd]              child working directory.
 * @param {object} [opts.env]             extra env merged over process.env.
 * @param {string} [opts.projectDir]      value for CLAUDE_PROJECT_DIR.
 * @param {string} [opts.hooksDir]        value for HOOKS_DIR (default <root>/src/hooks).
 * @param {AbortSignal} [opts.signal]      external cancellation; aborts the child.
 * @returns {Promise<object>}  the §4 result shape. Never rejects.
 */
function runHook(hookSpec, payload, opts = {}) {
  return new Promise((resolve) => {
    const started = Date.now();

    const id = hookSpec && hookSpec.id != null ? hookSpec.id : null;
    const event = hookSpec && hookSpec.event != null ? hookSpec.event : null;

    // Build the immutable base of every result so any early exit is well-formed.
    const baseResult = () => ({
      id,
      event,
      exitCode: -1,
      timedOut: false,
      stdout: '',
      stderr: '',
      blocked: false,
      stopLoop: false,
      reason: null,
      inject: null,
      durationMs: 0,
    });

    // Guard: a malformed spec must not throw out of the runner (§4: never reject).
    if (!hookSpec || typeof hookSpec.command !== 'string' || hookSpec.command.length === 0) {
      const r = baseResult();
      r.stderr = 'hook-runner: invalid hookSpec (missing command)';
      r.durationMs = Date.now() - started;
      resolve(r);
      return;
    }

    // timeout is stored in SECONDS in the manifest → convert to ms (§4).
    // Fall back to a sane default if absent or non-positive.
    const timeoutSec =
      typeof hookSpec.timeout === 'number' && hookSpec.timeout > 0 ? hookSpec.timeout : 60;
    const timeoutMs = timeoutSec * 1000;

    // Child env: inherit process.env, layer opts.env, then set the two paths the
    // hook scripts rely on to resolve themselves (§4).
    const hooksDir = opts.hooksDir || (opts.env && opts.env.HOOKS_DIR) || DEFAULT_HOOKS_DIR;
    const projectDir =
      opts.projectDir ||
      (opts.env && opts.env.CLAUDE_PROJECT_DIR) ||
      process.env.CLAUDE_PROJECT_DIR ||
      // Project root is two levels above the hooks dir (<root>/src/hooks → <root>).
      path.resolve(hooksDir, '..', '..');

    const childEnv = Object.assign({}, process.env, opts.env || {}, {
      CLAUDE_PROJECT_DIR: projectDir,
      HOOKS_DIR: hooksDir,
    });

    // Own AbortController so we can enforce the timeout via kill, and chain any
    // externally-supplied signal so the engine can cancel us too.
    const controller = new AbortController();
    const onExternalAbort = () => killChildTree();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let child;
    try {
      child = spawn(hookSpec.command, {
        shell: true, // run as a shell command line (bash/PowerShell-launched scripts)
        cwd: opts.cwd || undefined,
        env: childEnv,
        signal: controller.signal,
        windowsHide: true,
      });
    } catch (err) {
      // Synchronous spawn failure (rare). Resolve, never throw.
      cleanupSignal();
      const r = baseResult();
      r.stderr = `hook-runner: spawn failed: ${err && err.message ? err.message : String(err)}`;
      r.durationMs = Date.now() - started;
      resolve(r);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    // Kill the WHOLE child tree. On Windows, killing the shell (cmd.exe) does NOT
    // kill its node/bash grandchildren — they orphan and hold the stdio pipes open,
    // which prevents the parent process (and node:test) from ever exiting. taskkill
    // /T tears down the tree so the pipes close and nothing lingers. (Real hooks
    // that hang would orphan the same way, so this matters beyond the test suite.)
    function killChildTree() {
      try {
        if (child && child.pid != null && process.platform === 'win32') {
          execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
        } else if (child) {
          child.kill('SIGKILL');
        }
      } catch (_e) {
        try {
          if (child) child.kill();
        } catch (_e2) {
          /* nothing more we can do */
        }
      }
      try {
        controller.abort();
      } catch (_e) {
        /* abort backstop */
      }
    }

    // Hard timeout: kill the child tree; the 'close'/'error' handler resolves.
    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    function cleanupSignal() {
      if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupSignal();
      result.durationMs = Date.now() - started;
      resolve(result);
    }

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }

    // Write the payload to the child's stdin, then close it. Guard against EPIPE
    // (child may exit before reading) — that must not throw the runner.
    if (child.stdin) {
      child.stdin.on('error', () => {
        /* swallow EPIPE / write-after-end; the exit code is what matters */
      });
      try {
        child.stdin.write(JSON.stringify(payload == null ? {} : payload));
        child.stdin.end();
      } catch (_e) {
        // ignore — stdin write race; child outcome still resolves below
      }
    }

    // Spawn / runtime error (ENOENT, abort, etc.). If it's the timeout abort we
    // report timedOut; otherwise a non-blocking error with exitCode -1.
    child.on('error', (err) => {
      const r = baseResult();
      r.stdout = stdout;
      r.stderr = stderr || (err && err.message ? err.message : String(err));
      if (timedOut) {
        r.timedOut = true;
        r.stderr = stderr || `hook-runner: timed out after ${timeoutMs}ms`;
      }
      // blocked stays false; exitCode stays -1 (§4).
      finish(r);
    });

    child.on('close', (code, sig) => {
      // If we aborted for the timeout, classify as timeout regardless of code.
      if (timedOut) {
        const r = baseResult();
        r.stdout = stdout;
        r.stderr = stderr || `hook-runner: timed out after ${timeoutMs}ms`;
        r.timedOut = true; // exitCode -1, blocked false (§4)
        finish(r);
        return;
      }

      const r = baseResult();
      r.stdout = stdout;
      r.stderr = stderr;
      // On a clean close, code is a number; if killed by signal, code is null.
      r.exitCode = typeof code === 'number' ? code : -1;

      // --- Protocol interpretation (§3) ---
      // Exit 2 is ALWAYS stderr-blocking, and stdout/JSON is ignored on any
      // non-zero exit — this matches real Claude Code (the JSON protocol is
      // processed ONLY on a clean exit 0; on exit 2 the reason is stderr).
      if (r.exitCode === 2) {
        r.blocked = true;
        r.reason = stderr != null && stderr.trim().length > 0 ? stderr.trim() : '';
        finish(r);
        return;
      }

      // B) Advanced / JSON protocol (§3-B) — honored only on exit 0.
      const json = r.exitCode === 0 ? tryParseJsonProtocol(stdout) : null;

      if (json) {
        const hso =
          json.hookSpecificOutput && typeof json.hookSpecificOutput === 'object'
            ? json.hookSpecificOutput
            : null;

        // PreToolUse blocks via hookSpecificOutput.permissionDecision
        // (allow|deny|ask), NOT top-level decision — this is the real Claude Code
        // mechanism. "deny" blocks (reason = permissionDecisionReason). "allow"
        // passes. "ask" has no interactive prompt in the autonomous host, so it
        // is treated as non-blocking with the reason captured for context.
        const permDecision =
          hso && typeof hso.permissionDecision === 'string' ? hso.permissionDecision : null;
        const permReason =
          hso && typeof hso.permissionDecisionReason === 'string'
            ? hso.permissionDecisionReason
            : null;

        // Top-level decision: real Claude Code defines only "block" here (for
        // UserPromptSubmit / PostToolUse / Stop / PreCompact). There is no "approve".
        const decision = json.decision;
        const cont = json.continue;
        const jsonReason = typeof json.reason === 'string' ? json.reason : null;
        const additional =
          hso && typeof hso.additionalContext === 'string' ? hso.additionalContext : null;

        if (permDecision === 'deny') {
          r.blocked = true;
          r.reason = permReason != null ? permReason : jsonReason;
          if (r.reason == null) r.reason = '';
        } else if (decision === 'block') {
          r.blocked = true;
          r.reason = jsonReason; // block reason from JSON.reason (§4)
        }
        if (cont === false) {
          r.stopLoop = true; // continue:false → stop the whole loop (§3-B, §4)
        }
        // additionalContext is the injected text when present (§3-B, §4).
        if (additional !== null) {
          r.inject = additional;
        }
        finish(r);
        return;
      }

      // A) Simple / exit-code protocol (§3-A), exit 0.
      if (r.exitCode === 0) {
        // Success. For SessionStart / UserPromptSubmit, stdout IS the injection.
        // For other events stdout is advisory only (captured, not injected).
        if (INJECTABLE_EVENTS.has(event)) {
          const out = stdout != null ? stdout.trim() : '';
          r.inject = out.length > 0 ? out : null;
        }
      }
      // Any other non-zero (non-2) code → non-blocking error: stderr captured,
      // blocked stays false, reason stays null (§3-A).

      finish(r);
    });
  });
}

module.exports = { runHook };
