'use strict';

/**
 * auth/install.js — install the OPTIONAL OAuth dependency (`jose`) on demand.
 *
 * The whole point of ToolFunnel's zero-dependency stance is that a default install pulls NOTHING.
 * OAuth is opt-in, so its one library is installed only when a user decides they need it — via the
 * CLI (`toolfunnel install-oauth`) or the admin-UI button, both of which call installJose() here.
 *
 * It shells out to the user's own `npm` to install the PINNED jose version into the gateway
 * package's own node_modules (resolved from this file's location, NOT process.cwd(), so it lands
 * beside the engine wherever ToolFunnel is installed). It uses `--no-save` — the goal is simply to
 * make `require('jose')` resolvable; there is no manifest to update, and this keeps ToolFunnel's
 * own `dependencies: {}` untouched in every install shape.
 *
 * WINDOWS NOTE: do NOT spawn `npm.cmd`. Since the CVE-2024-27980 mitigation, spawning a `.cmd`
 * without a shell throws `EINVAL`; and spawning it WITH a shell is unreliable on portable Node
 * installs — the `npm.cmd` shim misresolves its own path under cmd.exe ("Cannot find module
 * …\node_modules\npm\bin\npm-cli.js"). The robust, cross-platform approach is to run npm's JS entry
 * (`npm-cli.js`, located beside the running node binary) with `process.execPath` directly —
 * `shell:false`, no shim, no PATH lookup, no cwd sensitivity. We fall back to a shell-spawned `npm`
 * only if `npm-cli.js` can't be located; the spec is allowlist-validated so that fallback can't inject.
 *
 * NEVER throws — it resolves to a structured { ok, code, stdout, stderr, message } so the CLI/UI can
 * report the outcome cleanly even when npm is missing or the network is down.
 *
 * CommonJS only; Node built-ins (child_process, path, fs) + the pin from resource-server.js.
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { JOSE_PIN, isJoseInstalled, _resetJoseCache } = require('./resource-server');

/** The gateway package root: <root>/src/auth/install.js -> two dirs up. npm runs here so jose lands
 *  in the engine's own node_modules regardless of the caller's cwd. */
const PKG_ROOT = path.resolve(__dirname, '..', '..');

/** npm is `npm.cmd` on Windows, `npm` elsewhere. We spawn it as a child rather than require()-ing. */
const IS_WIN = process.platform === 'win32';
const NPM_BIN = IS_WIN ? 'npm.cmd' : 'npm';

/** A strict allowlist for an npm version spec. Covers what a single-package install actually uses —
 *  `name@<exact|caret|tilde|x-range|dist-tag>` and scoped names — and NOTHING a shell could act on, so
 *  the fallback shell path can never inject. Comparator/whitespace ranges (`>=1 <2`, `1 || 2`) and the
 *  `*` wildcard are deliberately OUT: `> < = | *` and spaces are shell-meaningful. This is fine — the
 *  gateway only ever installs the caret-pinned `jose@^5.10.0`. Anything outside the set is refused
 *  before npm is ever invoked. */
const SPEC_RE = /^[A-Za-z0-9@._/^~+-]+$/;

/**
 * Locate npm's JS entry (`npm-cli.js`) so it can be run with `node` directly, bypassing the
 * `npm.cmd`/`npm` shim. Checks the layouts beside the running node binary (Windows/portable, then
 * POSIX), then the Windows per-user global. Returns the absolute path, or null if not found.
 * @returns {string|null}
 */
function findNpmCli() {
  const dir = path.dirname(process.execPath);
  const candidates = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),                    // Windows / portable
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),       // POSIX (/usr/bin -> /usr/lib)
  ];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_e) { /* ignore */ }
  }
  return null;
}

/**
 * installJose — run `npm install jose@<PIN>` in the gateway package root. Resolves a structured
 * result; never rejects. A 5-minute hard timeout guards against a hung registry.
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  default 300000 (5 min).
 * @param {string} [opts.spec]       override the install spec (tests). Default `jose@<JOSE_PIN>`.
 * @returns {Promise<{ ok:boolean, code:(number|null), stdout:string, stderr:string, message:string }>}
 */
function installJose(opts) {
  const o = opts || {};
  const spec = typeof o.spec === 'string' && o.spec.length > 0 ? o.spec : `jose@${JOSE_PIN}`;
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : 300000;

  if (isJoseInstalled()) {
    return Promise.resolve({ ok: true, code: 0, stdout: '', stderr: '', message: `jose already installed (${spec})` });
  }

  // Refuse a spec carrying anything outside the strict allowlist BEFORE any shell is involved.
  if (!SPEC_RE.test(spec)) {
    return Promise.resolve({ ok: false, code: null, stdout: '', stderr: '', message: `refusing to install: invalid package spec "${spec}"` });
  }

  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // On ANY failure, attach the guaranteed-correct manual fallback. Auto-install can't be made
      // universal — npm-cli.js sits in different places relative to `node` across install methods
      // (Homebrew/Volta/Docker/odd nvm). But the user definitely has a working npm (they used it to
      // install/run the gateway), so a copyable command they run in their OWN shell always works.
      // The UI + CLI surface result.message, so a failed auto-install becomes an actionable next
      // step rather than a dead end.
      if (result && result.ok !== true) {
        result.manualCommand = 'npm install jose@' + JOSE_PIN;
        result.cwd = PKG_ROOT;
        if (typeof result.message === 'string' && result.message.indexOf('manually') === -1) {
          result.message += ` — or install it manually: run \`${result.manualCommand}\` in ${PKG_ROOT}`;
        }
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      try { if (child) child.kill('SIGKILL'); } catch (_e) { /* ignore */ }
      done({ ok: false, code: null, stdout, stderr, message: `npm install timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      const npmCli = findNpmCli();
      if (npmCli) {
        // PREFERRED: run npm's JS entry with the current node binary — no shell, no .cmd shim, no
        // PATH/cwd sensitivity. This is what actually works on a portable/Windows Node install.
        child = spawn(process.execPath, [npmCli, 'install', spec, '--no-save'], {
          cwd: PKG_ROOT,
          env: process.env,
          windowsHide: true,
          shell: false,
        });
      } else if (IS_WIN) {
        // Fallback (npm-cli.js not found): shell out to npm.cmd. The spec is allowlist-validated
        // above and double-quoted so cmd.exe can't act on the `^` in a caret range or inject.
        child = spawn(`"${NPM_BIN}" install "${spec}" --no-save`, {
          cwd: PKG_ROOT,
          env: process.env,
          windowsHide: true,
          shell: true,
        });
      } else {
        child = spawn(NPM_BIN, ['install', spec, '--no-save'], {
          cwd: PKG_ROOT,
          env: process.env,
          windowsHide: true,
          shell: false,
        });
      }
    } catch (e) {
      return done({ ok: false, code: null, stdout, stderr, message: `failed to spawn npm: ${(e && e.message) || e}` });
    }

    if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      done({ ok: false, code: null, stdout, stderr, message: `npm not runnable: ${(e && e.message) || e}` });
    });
    child.on('close', (code) => {
      // Clear the lazy cache so a freshly-installed jose is picked up WITHOUT a process restart.
      try { _resetJoseCache(); } catch (_e) { /* ignore */ }
      const ok = code === 0 && isJoseInstalled();
      done({
        ok,
        code,
        stdout,
        stderr,
        message: ok
          ? `installed ${spec}`
          : `npm install exited ${code}${isJoseInstalled() ? '' : ' (jose still not loadable)'}`,
      });
    });
  });
}

module.exports = { installJose, findNpmCli, SPEC_RE, PKG_ROOT, NPM_BIN };
