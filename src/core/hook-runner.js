'use strict';

/**
 * hook-runner.js - run ONE command hook and return a structured result.
 *
 * Contract: the two output protocols and the exact result shape are specified below and pinned by
 * test/gate.test.js + test/hook-runner-bounds.test.js. This module is backend-agnostic and has
 * ZERO host-framework imports so it runs headless under `node --test`.
 *
 * Hard guarantee: runHook NEVER rejects. A spawn failure or a timeout always
 * resolves with the full result object (exitCode:-1, timedOut set appropriately,
 * blocked:false).
 */

const { spawn, execFile } = require('node:child_process');
const reaper = require('./child-reaper');
const path = require('node:path');

// Default HOOKS_DIR: <root>/src/hooks. __dirname is <root>/src/core, so up one.
const DEFAULT_HOOKS_DIR = path.resolve(__dirname, '..', 'hooks');

// Events whose exit-0 stdout is treated as injected context (the exit-code protocol's injection half).
const INJECTABLE_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);

// Returned by tryParseJsonProtocol when stdout was clearly meant to be a protocol object (it opens
// with '{') but does not parse. This is DISTINCT from null: null means "no protocol was attempted,
// use the exit-code protocol", whereas this means "a decision was attempted but could not be read".
// The two must be handled differently - an unreadable decision fails closed, the same as output
// past the cap, so a decision that loses a character is never mistaken for "allow".
const CORRUPT_PROTOCOL = Symbol('corrupt-protocol');

// Output ceilings. A hook's decision is a small JSON object and its diagnostics are a few lines;
// anything approaching these is a runaway, and accumulating it unbounded would OOM the gateway
// itself. Hitting either cap is treated as a WIRING FAILURE and fails closed (see the accumulator
// and the close handler) - an unreadable decision must never pass for "allow".
const MAX_STDOUT_BYTES = 1024 * 1024; // 1 MiB
const MAX_STDERR_BYTES = 256 * 1024; //  256 KiB

/**
 * Decide whether a parsed stdout object should be treated as the JSON
 * protocol. We only switch to the JSON interpretation when the object actually
 * carries one of the protocol's known keys - otherwise an arbitrary JSON blob a
 * hook happens to print should fall through to the exit-code protocol ("the
 * exit-code protocol wins if stdout is not valid JSON").
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
 * Try to parse stdout as the JSON protocol. Returns the parsed object if it is
 * valid JSON AND carries known protocol keys; CORRUPT_PROTOCOL if stdout opened
 * with '{' (a protocol object was attempted) but did not parse; otherwise null
 * (no protocol attempt - use the exit-code protocol).
 *
 * @param {string} stdout
 * @returns {object|symbol|null}
 */
function tryParseJsonProtocol(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return null;
  // Cheap pre-check: protocol output is always a JSON object. Anything not opening with '{' made
  // no protocol attempt and belongs to the exit-code protocol (arbitrary text a hook prints).
  if (trimmed[0] !== '{') return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (_e) {
    // Opened with '{' but is not valid JSON: an attempted decision that could not be read. Signal
    // CORRUPT (fail closed) rather than null - falling through to exit-code here would let a
    // truncated or malformed deny be read as "allow".
    return CORRUPT_PROTOCOL;
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
 * @returns {Promise<object>}  the full result shape. Never rejects.
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

    // Guard: a malformed spec must not throw out of the runner (the never-reject guarantee).
    if (!hookSpec || typeof hookSpec.command !== 'string' || hookSpec.command.length === 0) {
      const r = baseResult();
      r.stderr = 'hook-runner: invalid hookSpec (missing command)';
      r.durationMs = Date.now() - started;
      resolve(r);
      return;
    }

    // timeout is stored in SECONDS in the manifest -> convert to ms.
    // Fall back to a sane default if absent or non-positive.
    const timeoutSec =
      typeof hookSpec.timeout === 'number' && hookSpec.timeout > 0 ? hookSpec.timeout : 60;
    const timeoutMs = timeoutSec * 1000;

    // Child env: inherit process.env, layer opts.env, then set the two paths the
    // hook scripts rely on to resolve themselves.
    const hooksDir = opts.hooksDir || (opts.env && opts.env.HOOKS_DIR) || DEFAULT_HOOKS_DIR;
    const projectDir =
      opts.projectDir ||
      (opts.env && opts.env.CLAUDE_PROJECT_DIR) ||
      process.env.CLAUDE_PROJECT_DIR ||
      // Project root is two levels above the hooks dir (<root>/src/hooks -> <root>).
      path.resolve(hooksDir, '..', '..');

    const childEnv = Object.assign({}, process.env, opts.env || {}, {
      CLAUDE_PROJECT_DIR: projectDir,
      HOOKS_DIR: hooksDir,
    });

    // Own AbortController so we can enforce the timeout via kill, and chain any
    // externally-supplied signal so the engine can cancel us too. The abort path RESOLVES
    // immediately, exactly like the timeout: it must not depend on 'close', which a surviving
    // grandchild holding inherited pipes can withhold forever (the same reasoning that moved
    // the timeout onto its timer).
    const onExternalAbort = () => {
      timedOut = true;
      killChildTree();
      const r = baseResult();
      r.stdout = stdout;
      r.stderr = stderr || 'hook-runner: aborted by caller signal';
      r.timedOut = true; // exitCode -1, blocked false - the caller cancelled, same class as a timeout
      finish(r);
    };
    const controller = new AbortController();
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
        // POSIX: give the shell its OWN PROCESS GROUP so killChildTree can tear down the
        // grandchildren too (see the comment there - killing the shell alone orphans them and
        // they hold the stdio pipes open forever). Windows has no process groups in this sense
        // and uses taskkill /T instead; `detached` there only suppresses a console window, which
        // windowsHide already covers, so it stays off to keep Windows behaviour byte-identical.
        detached: process.platform !== 'win32',
      });
      // Last-resort sweep: if the gateway dies without running killChildTree (crash, signal),
      // the reaper's exit handler kills whatever is still tracked - detached children have left
      // our session and would otherwise run to their natural end unsupervised.
      reaper.track(child);
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
    let outputCapped = null; // 'stdout' | 'stderr' once a cap was hit (fail-closed trigger)

    // Kill the WHOLE child tree. Killing the shell (cmd.exe / sh) does NOT kill its node/bash
    // grandchildren - they orphan and hold the stdio pipes open, which prevents the parent
    // process (and node:test) from ever exiting. Both platforms need a TREE kill, by their own
    // mechanism: Windows has taskkill /T; POSIX has process groups, which is why the spawn above
    // sets `detached` there - the shell is a group leader, so kill(-pid) reaches every descendant.
    // (Before 0.7.0 the POSIX branch sent SIGKILL to the shell alone: the bug was diagnosed in
    // this comment and fixed for Windows only.)
    function killChildTree() {
      try {
        if (child && child.pid != null && process.platform === 'win32') {
          execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
        } else if (child && child.pid != null) {
          // Negative pid = the whole process group. ESRCH simply means it is already gone.
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (_eg) {
            child.kill('SIGKILL'); // group gone or never formed - fall back to the direct child
          }
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

    // Hard timeout: kill the child tree AND resolve immediately - never wait for 'close'.
    //
    // 'close' fires only when every stdio pipe is closed, and a GRANDCHILD that inherited those
    // pipes keeps them open for its own lifetime even after the shell is dead. Waiting for 'close'
    // therefore made the timeout unenforceable in exactly the case it exists for: measured
    // 2026-07-30, a hook whose grandchild slept 60 s resolved at 60 s against a 2.5 s timeout, on
    // Windows, WITH taskkill /T. The tree kill still matters (it stops us leaking processes), but
    // the timeout contract must not depend on it succeeding on any platform.
    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree();
      const r = baseResult();
      r.stdout = stdout;
      r.stderr = stderr || `hook-runner: timed out after ${timeoutMs}ms`;
      r.timedOut = true; // exitCode -1, blocked false (the timeout contract)
      finish(r);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    function cleanupSignal() {
      if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort);
    }

    /** A capped hook resolves NOW (same reasoning as the timeout: 'close' may never come) and
     *  FAILS CLOSED - a decision we stopped reading is not a decision we may treat as allow. */
    function finishCapped() {
      const r = baseResult();
      r.stdout = stdout;
      r.stderr = stderr;
      r.blocked = true;
      r.reason = `hook-runner: ${event || 'hook'}${id ? ` "${id}"` : ''} exceeded the `
        + `${outputCapped} output cap (`
        + `${outputCapped === 'stdout' ? MAX_STDOUT_BYTES : MAX_STDERR_BYTES} bytes); `
        + 'its decision could not be read, so the call is denied (fail closed).';
      finish(r);
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupSignal();
      // Release our ends of the pipes AND unref the child handle. The pipes alone are not
      // enough: the ChildProcess handle itself keeps the event loop referenced until the child
      // exits, so a tree that survives killChildTree (measured: a 30 s grandchild) pinned the
      // process to its natural death even after we had answered. unref() lets the loop drain;
      // the 'close'/'error' handlers stay attached and no-op behind the settled guard.
      for (const s of [child && child.stdout, child && child.stderr, child && child.stdin]) {
        try { if (s && typeof s.destroy === 'function') s.destroy(); } catch (_e) { /* ignore */ }
      }
      try { if (child && typeof child.unref === 'function') child.unref(); } catch (_e) { /* ignore */ }
      reaper.untrack(child);
      result.durationMs = Date.now() - started;
      resolve(result);
    }

    // BOUNDED accumulation. An unbounded `stdout += chunk` turns a chatty or runaway hook into an
    // out-of-memory kill of the GATEWAY - a far worse failure than any hook outcome, and in the
    // one module whose job is running untrusted external processes. Past the cap we stop
    // accumulating, kill the tree, and (below) FAIL CLOSED: a decision we could not read in full
    // must never be interpreted as "allow" just because the exit code was 0.
    // Caps are measured in REAL bytes (Buffer.byteLength), not String.length - the latter counts
    // UTF-16 code units, which let non-ASCII output run ~3x past a nominal "byte" ceiling.
    let hrOutBytes = 0;
    let hrErrBytes = 0;
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (hrOutBytes >= MAX_STDOUT_BYTES) return;
        hrOutBytes += Buffer.byteLength(chunk, 'utf8');
        // Trim the final chunk to the byte budget - streams deliver whole chunks, so appending
        // before checking retained up to cap+chunkSize (seen: +64KB on win node 18/20, where
        // chunk boundaries do not align with the cap). Chars trimmed by a byte overshoot can
        // only under-retain (a char is >= 1 byte), which is the safe side of the ceiling.
        const outOver = hrOutBytes - MAX_STDOUT_BYTES;
        stdout += outOver > 0 ? chunk.slice(0, Math.max(0, chunk.length - outOver)) : chunk;
        if (hrOutBytes >= MAX_STDOUT_BYTES) {
          outputCapped = 'stdout';
          killChildTree();
          finishCapped();
        }
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        if (hrErrBytes >= MAX_STDERR_BYTES) return;
        hrErrBytes += Buffer.byteLength(chunk, 'utf8');
        const errOver = hrErrBytes - MAX_STDERR_BYTES;
        stderr += errOver > 0 ? chunk.slice(0, Math.max(0, chunk.length - errOver)) : chunk;
        if (hrErrBytes >= MAX_STDERR_BYTES) {
          stderr += '\n[hook-runner: stderr truncated at cap]';
          if (!outputCapped) outputCapped = 'stderr';
          killChildTree();
          finishCapped();
        }
      });
    }

    // Write the payload to the child's stdin, then close it. Guard against EPIPE
    // (child may exit before reading) - that must not throw the runner.
    if (child.stdin) {
      child.stdin.on('error', () => {
        /* swallow EPIPE / write-after-end; the exit code is what matters */
      });
      try {
        child.stdin.write(JSON.stringify(payload == null ? {} : payload));
        child.stdin.end();
      } catch (_e) {
        // ignore - stdin write race; child outcome still resolves below
      }
    }

    // Spawn / runtime error (ENOENT, abort, etc.). If it's the timeout abort we
    // report timedOut; otherwise a non-blocking error with exitCode -1.
    child.on('error', (err) => {
      const r = baseResult();
      r.stdout = stdout;
      r.stderr = stderr || (err && err.message ? err.message : String(err));
      if (outputCapped) {
        r.blocked = true;
        r.reason = `hook-runner: ${event || 'hook'}${id ? ` "${id}"` : ''} exceeded the `
          + `${outputCapped} output cap; its decision could not be read, so the call is denied (fail closed).`;
        finish(r);
        return;
      }
      if (timedOut) {
        r.timedOut = true;
        r.stderr = stderr || `hook-runner: timed out after ${timeoutMs}ms`;
      }
      // blocked stays false; exitCode stays -1 (the error contract).
      finish(r);
    });

    child.on('close', (code, sig) => {
      // Output cap hit: the decision is UNREADABLE (we stopped reading mid-stream), so the only
      // safe classification is a block flagged as a wiring failure. Checked BEFORE the timeout
      // branch because the cap also kills the tree, which can set timedOut on the way down.
      if (outputCapped) {
        const r = baseResult();
        r.stdout = stdout;
        r.stderr = stderr;
        r.blocked = true;
        r.reason = `hook-runner: ${event || 'hook'}${id ? ` "${id}"` : ''} exceeded the `
          + `${outputCapped} output cap (${outputCapped === 'stdout' ? MAX_STDOUT_BYTES : MAX_STDERR_BYTES} bytes); `
          + 'its decision could not be read, so the call is denied (fail closed).';
        finish(r);
        return;
      }

      // If we aborted for the timeout, classify as timeout regardless of code.
      if (timedOut) {
        const r = baseResult();
        r.stdout = stdout;
        r.stderr = stderr || `hook-runner: timed out after ${timeoutMs}ms`;
        r.timedOut = true; // exitCode -1, blocked false (the timeout contract)
        finish(r);
        return;
      }

      const r = baseResult();
      r.stdout = stdout;
      r.stderr = stderr;
      // On a clean close, code is a number; if killed by signal, code is null.
      r.exitCode = typeof code === 'number' ? code : -1;

      // --- Protocol interpretation ---
      // Exit 2 is ALWAYS stderr-blocking, and stdout/JSON is ignored on any
      // non-zero exit - this matches real Claude Code (the JSON protocol is
      // processed ONLY on a clean exit 0; on exit 2 the reason is stderr).
      if (r.exitCode === 2) {
        r.blocked = true;
        r.reason = stderr != null && stderr.trim().length > 0 ? stderr.trim() : '';
        finish(r);
        return;
      }

      // B) Advanced / JSON protocol - honored only on exit 0.
      const json = r.exitCode === 0 ? tryParseJsonProtocol(stdout) : null;

      // A protocol object that FAILED TO PARSE (stdout opened with '{' but is not valid JSON) is an
      // unreadable decision. It fails closed - denied - the same as output past the cap: the runner
      // saw an attempted answer it could not read, and an unreadable answer is never "allow". Only
      // stdout that made no protocol attempt (no leading '{', or valid JSON that is not a decision)
      // falls through to the exit-code protocol below.
      if (json === CORRUPT_PROTOCOL) {
        r.blocked = true;
        r.reason = `hook-runner: ${event || 'hook'}${id ? ` "${id}"` : ''} emitted a protocol `
          + 'message that could not be parsed; its decision could not be read, so the call is '
          + 'denied (fail closed).';
        finish(r);
        return;
      }

      if (json) {
        const hso =
          json.hookSpecificOutput && typeof json.hookSpecificOutput === 'object'
            ? json.hookSpecificOutput
            : null;

        // The decision VOCABULARY is exact and case-sensitive: permissionDecision is
        // allow|deny|ask, top-level decision is block. A decision SLOT carrying any other
        // value - miscased "DENY", a synonym like "denied", the right word in the wrong
        // slot, a non-string - is an ATTEMPTED decision the runner cannot read, and an
        // unreadable decision is never "allow" (the same rule as CORRUPT_PROTOCOL and the
        // output caps). A key marks an attempt ONLY when it carries a value: `null` is the
        // readable spelling of "no value" - what typed-struct and dataclass serialisers
        // emit for an unset optional field - so a null slot is no decision and falls
        // through exactly as the absent key does. (0.7.0; gate-semantics.test.js pins
        // both halves.)
        const permAttempted =
          hso !== null &&
          Object.prototype.hasOwnProperty.call(hso, 'permissionDecision') &&
          hso.permissionDecision !== null;
        const decisionAttempted =
          Object.prototype.hasOwnProperty.call(json, 'decision') && json.decision !== null;
        const permUnknown =
          permAttempted &&
          hso.permissionDecision !== 'allow' &&
          hso.permissionDecision !== 'deny' &&
          hso.permissionDecision !== 'ask';
        const decisionUnknown = decisionAttempted && json.decision !== 'block';
        // Same rule for the OTHER protocol slots: `continue` is boolean and
        // `hookSpecificOutput` is an object - a present NON-NULL key with any other type
        // is an attempted instruction that cannot be read. The hso check tests the RAW
        // value: `hso` coerces both null and a wrong type (a bare string, a number) to
        // null, and only the wrong types are unreadable attempts.
        const contUnknown =
          Object.prototype.hasOwnProperty.call(json, 'continue') &&
          json.continue !== null &&
          typeof json.continue !== 'boolean';
        const hsoUnknown =
          Object.prototype.hasOwnProperty.call(json, 'hookSpecificOutput') &&
          json.hookSpecificOutput !== null &&
          (hso === null || Array.isArray(hso));
        if (permUnknown || decisionUnknown || contUnknown || hsoUnknown) {
          const slot = permUnknown
            ? 'hookSpecificOutput.permissionDecision'
            : decisionUnknown
              ? 'decision'
              : contUnknown
                ? 'continue'
                : 'hookSpecificOutput';
          const got = JSON.stringify(
            permUnknown
              ? hso.permissionDecision
              : decisionUnknown
                ? json.decision
                : contUnknown
                  ? json.continue
                  : json.hookSpecificOutput
          );
          const known = permUnknown
            ? '"allow", "deny", "ask"'
            : decisionUnknown
              ? '"block"'
              : contUnknown
                ? 'true, false'
                : 'an object';
          r.blocked = true;
          r.reason = `hook-runner: ${event || 'hook'}${id ? ` "${id}"` : ''} emitted ${slot}: `
            + `${got}, which is not in the protocol vocabulary (${known}); its decision could `
            + 'not be read, so the call is denied (fail closed).';
          finish(r);
          return;
        }

        // PreToolUse blocks via hookSpecificOutput.permissionDecision
        // (allow|deny|ask), NOT top-level decision - this is the real Claude Code
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
          r.reason = jsonReason; // block reason from JSON.reason
        }
        if (cont === false) {
          r.stopLoop = true; // continue:false -> stop the whole loop
        }
        // additionalContext is the injected text when present.
        if (additional !== null) {
          r.inject = additional;
        }
        finish(r);
        return;
      }

      // A) Simple / exit-code protocol, exit 0.
      if (r.exitCode === 0) {
        // Success. For SessionStart / UserPromptSubmit, stdout IS the injection.
        // For other events stdout is advisory only (captured, not injected).
        if (INJECTABLE_EVENTS.has(event)) {
          const out = stdout != null ? stdout.trim() : '';
          r.inject = out.length > 0 ? out : null;
        }
      }
      // Any other non-zero (non-2) code -> non-blocking error: stderr captured,
      // blocked stays false, reason stays null.

      finish(r);
    });
  });
}

module.exports = { runHook };
