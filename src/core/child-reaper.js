'use strict';

/**
 * child-reaper.js - last-resort cleanup for spawned hook/tool children.
 *
 * The hook runner and both local executors spawn their children `detached` on POSIX so the
 * process GROUP can be killed as a tree. setsid() has a consequence: the children leave the
 * gateway's session, so a terminal Ctrl-C no longer reaches them, and a gateway that dies
 * without executing its per-child kill path leaves them reparented to init running to their
 * natural end - with their supervising timeout timers dead alongside the gateway.
 *
 * This module is the counterpart: every spawn site registers its child here and unregisters on
 * settle; process exit / SIGINT / SIGTERM sweeps whatever is still tracked. Synchronous kills
 * only - an 'exit' handler cannot await. Windows gets child.kill() (the shell only; taskkill is
 * async and cannot run here) - best effort, matching the platform's weaker group semantics.
 * A SIGKILLed gateway sweeps nothing; that limit is inherent to SIGKILL.
 */

const live = new Set();
let installed = false;

function sweep() {
  for (const child of live) {
    try {
      if (child.pid != null && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_eg) { child.kill('SIGKILL'); }
      } else {
        child.kill();
      }
    } catch (_e) { /* already gone */ }
  }
  live.clear();
}

function install() {
  if (installed) return;
  installed = true;
  process.on('exit', sweep);
  // On a signal, sweep and re-raise the default behaviour by exiting: only do so if nobody
  // else handles the signal (respect an embedding host's own handlers).
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      sweep();
      if (process.listenerCount(sig) === 1) process.exit(sig === 'SIGINT' ? 130 : 143);
    });
  }
}

/** Register a spawned child for the last-resort sweep. Call untrack() when it settles. */
function track(child) {
  if (!child || typeof child.kill !== 'function') return;
  install();
  live.add(child);
}

/** Remove a settled child from the sweep set. Safe to call twice. */
function untrack(child) {
  live.delete(child);
}

module.exports = { track, untrack };
