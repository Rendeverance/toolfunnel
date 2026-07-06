'use strict';

/**
 * requires.js — runtime-requirement preflight (the packaging story's honesty layer).
 *
 * A shipped pack's tools may need runtimes the gateway itself does not (python for a PDF tool,
 * git for a repo tool). The pack DECLARES them in its toolfunnel.json — the identity file that
 * already travels with every config home — and the gateway probes them ONCE at startup:
 *
 *   "requires": [
 *     { "command": "python", "min": "3.10", "why": "the pdf-extract tools" },
 *     { "command": "git" }
 *   ]
 *
 * Probes are ADVISORY, never fatal: a missing runtime breaks only the tools that need it, so the
 * gateway starts and the operator gets a clear stderr line naming what is missing, the version
 * found vs needed, and the declared "why". Fields per entry (only `command` is required):
 *   command     the executable to probe (e.g. "python", "node", "git")
 *   versionArg  the flag that prints a version (default "--version")
 *   min         minimum version, dotted numerics (e.g. "3.10" / "18" / "3.10.2")
 *   why         shown in the warning so the operator knows which tools care
 *
 * Zero new dependencies: child_process probes + a hand-rolled dotted-numeric compare. NO semver
 * library — by the packaging hard constraint, and dotted numerics cover real runtime versions.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** Parse the FIRST dotted-numeric version out of a probe's output ("Python 3.12.1" → [3,12,1]).
 *  Returns null when no version-shaped token is present. */
function parseVersion(text) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text || ''));
  if (!m) {
    const single = /\b(\d+)\b/.exec(String(text || ''));
    return single ? [Number(single[1]), 0, 0] : null;
  }
  return [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
}

/** Hand-rolled dotted-numeric compare: -1 | 0 | 1 for a<b | a==b | a>b. */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * Probe one command for its version string. On Windows a PATHEXT shim (a .cmd like npx) cannot be
 * spawned shell:false (ENOENT/EINVAL — the CVE-2024-27980 mitigation), so a failed direct probe is
 * retried through cmd.exe, mirroring mcp-client's winLaunch.
 * @param {string} command
 * @param {string} versionArg
 * @returns {{found: boolean, version: (number[]|null), raw: string}}
 */
function probe(command, versionArg) {
  const runOnce = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  let res = runOnce(command, [versionArg]);
  if (res.error && process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe';
    res = runOnce(comspec, ['/c', command, versionArg]);
  }
  if (res.error || res.status == null) return { found: false, version: null, raw: '' };
  const raw = `${res.stdout || ''} ${res.stderr || ''}`.trim();
  const version = parseVersion(raw);
  // "Spawned" is not "exists": the cmd.exe fallback launches fine for a NONEXISTENT command and
  // exits non-zero ("is not recognized…"). Existence = a clean exit OR a version-shaped answer.
  const found = res.status === 0 || version !== null;
  return { found, version: found ? version : null, raw };
}

/**
 * Check the `requires` declared in `<home>/toolfunnel.json`. Returns the problem list — the
 * caller decides how to surface it (the gateway logs each to stderr and starts anyway). NEVER
 * throws; a malformed requires entry is itself reported as a problem rather than crashing.
 * @param {string} home  the resolved config home
 * @returns {Array<{command:string, problem:string}>}
 */
function checkRequires(home) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(home, 'toolfunnel.json'), 'utf8'));
  } catch (_e) {
    return []; // absent/bad identity file → nothing declared
  }
  const list = cfg && Array.isArray(cfg.requires) ? cfg.requires : [];
  const problems = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || typeof entry.command !== 'string' || entry.command.trim() === '') {
      problems.push({ command: String(entry && entry.command), problem: 'malformed requires entry (needs a "command" string)' });
      continue;
    }
    const command = entry.command.trim();
    // A requires command is a bare PROGRAM NAME, never a shell string. This is load-bearing on
    // Windows: the cmd.exe shim fallback below hands the token to cmd, where an unquoted
    // metacharacter ("x&evil") would CHAIN commands — a probe must never be able to run anything
    // beyond `<program> <versionArg>`. Reject anything shell-shaped up front (also catches paths:
    // declare tools by PATH name, which is the only portable claim a pack can make anyway).
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(command)) {
      problems.push({ command, problem: `requires.command "${command}" is not a bare program name (no paths, spaces, or shell characters)` });
      continue;
    }
    const why = typeof entry.why === 'string' && entry.why ? ` (needed for: ${entry.why})` : '';
    const versionArg = typeof entry.versionArg === 'string' && /^--?[A-Za-z][A-Za-z-]*$/.test(entry.versionArg)
      ? entry.versionArg
      : '--version'; // same rule: a version FLAG, never a shell fragment
    const p = probe(command, versionArg);
    if (!p.found) {
      problems.push({ command, problem: `"${command}" was not found on PATH${why}` });
      continue;
    }
    if (typeof entry.min === 'string' && entry.min.trim() !== '') {
      const min = parseVersion(entry.min);
      if (!min) {
        problems.push({ command, problem: `requires.min "${entry.min}" is not a dotted numeric version` });
        continue;
      }
      if (!p.version) {
        problems.push({ command, problem: `"${command}" answered but printed no recognisable version (wanted >= ${entry.min})${why}` });
        continue;
      }
      if (compareVersions(p.version, min) < 0) {
        problems.push({
          command,
          problem: `"${command}" is ${p.version.join('.')} but this setup declares >= ${entry.min}${why}`,
        });
      }
    }
  }
  return problems;
}

module.exports = { checkRequires, parseVersion, compareVersions, probe };
