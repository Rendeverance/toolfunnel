'use strict';

/**
 * drift.js — tool register drift detector.
 *
 * The register can go stale when entries are not maintained alongside the files
 * they describe (a config file left unmaintained over time, tools missing). A
 * behavioural "update it immediately" rule is fragile. This is the STRUCTURAL
 * guard (fix-the-tool, not the discipline): scan the real scripts directory
 * against the register and surface drift so it can never silently rot again.
 *
 * Mirrors the host's auto-detect (the folder is the source of truth for what
 * EXISTS; the register carries config). Read-only — it never edits anything,
 * inside or outside the gateway (honours the isolation rule: MAY READ the live
 * scripts directory, MUST NOT write it).
 *
 * detectDrift({ registerPath, toolsDir }) -> {
 *   ok, registerPath, toolsDir,
 *   registeredCount,            // distinct .js basenames referenced by the register
 *   onDiskCount,                // tool files found under toolsDir
 *   missingFromRegister: [str], // on disk under toolsDir but NOT referenced by any entry
 *   deadEntries: [{id, path}],  // entries whose referenced script no longer exists
 *   note,
 * }
 *
 * Matching is by FILENAME (basename), case-insensitive: an entry "covers" a file
 * if the file's basename appears anywhere in the entry's `path` or invoke.command
 * (so grouped family entries that list their variants in `path` cover them).
 *
 * CommonJS, Node built-ins only.
 */

const fs = require('node:fs');
const path = require('node:path');

// dirs/files that are not tools — never count as drift
const SKIP_DIRS = new Set(['.archive', 'node_modules', 'scripts', 'docs', 'setup']);
const TOOL_EXTS = new Set(['.js']);
// obvious non-tool scripts (probes/tests) — surfaced separately, not as "missing"
const NONTOOL_RE = /^(test_|_)/i;

/** Every .js basename (lowercased) referenced by the register's path + invoke fields. */
function registeredBasenames(data) {
  const set = new Set();
  const tools = Array.isArray(data && data.tools) ? data.tools : [];
  const grab = (s) => {
    if (typeof s !== 'string') return;
    // filename run ending in .js — NO spaces in the class (so "wraps helper.js"
    // yields "helper.js", not the whole phrase). path/dir prefixes are excluded too.
    const m = s.match(/[A-Za-z0-9_.\-]+\.js/g);
    if (m) for (const f of m) set.add(path.basename(f).toLowerCase());
  };
  for (const t of tools) {
    grab(t.path);
    if (t.invoke && typeof t.invoke.command === 'string') grab(t.invoke.command);
    // a family entry may explicitly name the member files it covers
    if (Array.isArray(t.covers)) for (const f of t.covers) {
      if (typeof f === 'string') set.add(path.basename(f).toLowerCase());
    }
  }
  return set;
}

/** Recursively collect .js files under dir, skipping SKIP_DIRS and dotdirs. */
function scanTools(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      out.push(...scanTools(path.join(dir, e.name)));
    } else if (e.isFile() && TOOL_EXTS.has(path.extname(e.name).toLowerCase())) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function detectDrift({ registerPath, toolsDir } = {}) {
  if (!registerPath || !toolsDir) {
    return { ok: false, error: 'detectDrift: registerPath and toolsDir are required' };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(registerPath, 'utf8'));
  } catch (err) {
    return { ok: false, error: `cannot read/parse register: ${err.message}` };
  }

  const registered = registeredBasenames(data);
  const onDiskFiles = scanTools(toolsDir);
  const onDiskBasenames = new Set(onDiskFiles.map((f) => path.basename(f).toLowerCase()));

  // on disk but not referenced by any register entry (skip obvious probes/tests)
  const missingFromRegister = [];
  const nonToolScripts = [];
  for (const f of onDiskFiles) {
    const base = path.basename(f);
    const lower = base.toLowerCase();
    if (registered.has(lower)) continue;
    if (NONTOOL_RE.test(base)) { nonToolScripts.push(base); continue; }
    missingFromRegister.push(base);
  }

  // entries whose script-invoke path references a file no longer present under scriptsRoot
  const deadEntries = [];
  const tools = Array.isArray(data.tools) ? data.tools : [];
  for (const t of tools) {
    const p = typeof t.path === 'string' ? t.path : '';
    const cmd = t.invoke && typeof t.invoke.command === 'string' ? t.invoke.command : '';
    const m = p.match(/[A-Za-z0-9_\-]+\.js/) || cmd.match(/[A-Za-z0-9_\-]+\.js/);
    if (m && !onDiskBasenames.has(m[0].toLowerCase())) {
      deadEntries.push({ id: t.id, path: p });
    }
  }

  missingFromRegister.sort();
  nonToolScripts.sort();

  return {
    ok: true,
    registerPath,
    toolsDir,
    registeredCount: registered.size,
    onDiskCount: onDiskFiles.length,
    missingFromRegister,
    deadEntries,
    nonToolScripts,
    note:
      'Scope: scans toolsDir (the scripts root) only. Scripts that live outside it ' +
      'may be referenced by the register but are not drift-checked here. Matching is ' +
      'by filename. nonToolScripts (test_*/_*) are listed separately, not counted as ' +
      'missing.',
  };
}

module.exports = { detectDrift, registeredBasenames, scanTools };
