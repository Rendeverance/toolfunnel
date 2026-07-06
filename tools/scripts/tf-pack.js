#!/usr/bin/env node
'use strict';

/**
 * tf-pack.js — a first-party MANAGEMENT tool that packages the LIVE setup for deployment.
 *
 * Purpose
 * -------
 * Everything you built in this gateway — your tools + scripts, your hot/hidden curation, your
 * upstream selections, your policy hooks, your identity — IS a config home. This tool snapshots
 * it into a deployment-ready artifact in a SEPARATE location (never the live tree), so "ship what
 * I made" is one call instead of a hand-rolled copy job:
 *
 *   format "home" (default): <home>/dist/<name>/ = a portable config home. Zip it, git-init it,
 *     or point any toolfunnel at it via --config-dir / TOOLFUNNEL_HOME.
 *   format "npm": <home>/dist/<name>/ = a PUBLISHABLE npm package: package.json (with toolfunnel
 *     as a caret DEPENDENCY — depend, never copy: your users' installs count as toolfunnel
 *     downloads and our fixes reach them via npm update), a 2-line bin launcher pointing
 *     --config-dir at the bundled home/, and a README stub. `cd dist/<name> && npm publish` is
 *     your own MCP server on npm.
 *
 * Args (env TOOLFUNNEL_TOOL_ARGS, mirrors the other tf-* scripts):
 *   { format?: 'home'|'npm' (default 'home'),
 *     name?: string,        // pack/package name (default: the home's serverName, else 'my-mcp')
 *     version?: string,     // default: the home's explicit serverVersion, else '0.1.0'
 *     description?: string, // npm format: package.json description
 *     out?: string,         // FOLDER NAME under <home>/dist/ (basename only; default: name)
 *     force?: boolean }     // overwrite files in an existing non-empty out dir
 *
 * What travels: tools/ (register + state overlay + scripts — the hot/hidden curation IS the
 * product), mcp/ (expose.json upstream references + any vendored servers), hooks/ (THE GATE
 * TRAVELS — the shipped pack enforces its policy on the recipient's machine regardless of
 * client), toolfunnel.json (identity + requires; rewritten with the pack's name/version).
 * What NEVER travels: auth/ (environment-specific OAuth config), logs/, dist/ (recursion),
 * packages/, node_modules, .git.
 *
 * Output (stdout), exactly one JSON object:
 *   success: { ok:true, format, out, files, next:[…] }
 *   failure: { ok:false, error }
 * Safety: writes ONLY under <home>/dist/<basename> (the live config is read, never touched);
 * refuses a non-empty destination without force:true; ALWAYS exits 0.
 */

const fs = require('node:fs');
const path = require('node:path');
// Shared HOME/engine resolution (see tf-env.js): config beside us, engine from the package.
const { HOME, PKG } = require('./tf-env');

const EXCLUDE_DIRS = new Set(['dist', 'logs', 'auth', 'packages', 'node_modules', '.git', '.idea', '.vscode']);

function parseStructuredArgs() {
  const raw = process.env.TOOLFUNNEL_TOOL_ARGS;
  if (raw === undefined || raw === null || raw === '') return { value: {} };
  try {
    return { value: JSON.parse(raw) };
  } catch (_err) {
    return { parseError: `TOOLFUNNEL_TOOL_ARGS was not valid JSON: ${String(raw)}` };
  }
}

/** The home's toolfunnel.json as raw JSON (or {}). Read directly — we want the EXPLICIT fields,
 *  not the loader's folded-in defaults (a pack must not inherit toolfunnel's own version). */
function homeIdentity() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(HOME, 'toolfunnel.json'), 'utf8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch (_e) {
    return {};
  }
}

/** npm-legal name: lowercase, spaces/illegals → '-', collapsed. */
function sanitizeName(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '');
  return s || 'my-mcp';
}

/** Recursively copy `srcDir` → `destDir`, skipping EXCLUDE_DIRS at the top level and dotfiles
 *  everywhere. Overwrites only when `force`. Returns the number of files written. */
function copyTree(srcDir, destDir, force, topLevel) {
  let count = 0;
  let entries;
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch (_e) {
    return count;
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const e of entries) {
    if (topLevel && EXCLUDE_DIRS.has(e.name)) continue;
    if (e.name.startsWith('.')) continue;
    const from = path.join(srcDir, e.name);
    const to = path.join(destDir, e.name);
    if (e.isDirectory()) {
      count += copyTree(from, to, force, false);
    } else if (e.isFile()) {
      if (!force && fs.existsSync(to)) continue;
      fs.copyFileSync(from, to);
      count += 1;
    }
  }
  return count;
}

/** The 4 config pillars → destHome. Identity is rewritten (name/version/description overlay). */
function snapshotHome(destHome, force, identity) {
  let files = 0;
  for (const dir of ['tools', 'mcp', 'hooks']) {
    files += copyTree(path.join(HOME, dir), path.join(destHome, dir), force, true);
  }
  fs.writeFileSync(path.join(destHome, 'toolfunnel.json'), JSON.stringify(identity, null, 2) + '\n');
  return files + 1;
}

function run(args) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const format = a.format === 'npm' ? 'npm' : a.format === 'home' || a.format === undefined ? 'home' : null;
  if (format === null) return { ok: false, error: 'format must be "home" or "npm"' };
  const force = a.force === true;

  const id = homeIdentity();
  const name = sanitizeName(a.name || id.serverName || 'my-mcp');
  const version = typeof a.version === 'string' && a.version.trim() ? a.version.trim()
    : (typeof id.serverVersion === 'string' && id.serverVersion.trim() ? id.serverVersion.trim() : '0.1.0');
  const description = typeof a.description === 'string' && a.description.trim()
    ? a.description.trim()
    : `${name} — an MCP server built on toolfunnel.`;

  // The destination: ALWAYS <home>/dist/<basename> — the separate-location guarantee. `out` is a
  // folder NAME (basename strips traversal), never a path, so the live tree can't be targeted.
  const outName = path.basename(String(a.out || name));
  const outDir = path.join(HOME, 'dist', outName);
  const rel = path.relative(path.join(HOME, 'dist'), outDir);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: `out "${a.out}" escapes <home>/dist` };
  }
  if (!force && fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    return { ok: false, error: `destination is not empty: ${outDir} — pass force:true to overwrite (files are replaced, extras are kept)` };
  }

  // The identity the pack CARRIES (preserves requires + any custom fields; stamps name/version).
  const identity = Object.assign({}, id, { serverName: name, serverVersion: version });

  let files = 0;
  const next = [];
  if (format === 'home') {
    files = snapshotHome(outDir, force, identity);
    next.push(`portable config home written — zip it, git-init it, or run: toolfunnel --config-dir "${outDir}"`);
  } else {
    // npm: bundled home + generated package.json + 2-line bin + README stub.
    files = snapshotHome(path.join(outDir, 'home'), force, identity);

    let tfVersion = '0.4.0';
    try { tfVersion = require(path.join(PKG, 'package.json')).version || tfVersion; } catch (_e) { /* keep fallback */ }
    const envOverride = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_HOME';

    const pkgJson = {
      name,
      version,
      description,
      license: 'MIT',
      type: 'commonjs',
      bin: { [name]: `bin/${name}.js` },
      files: ['bin/', 'home/'],
      // DEPEND, never copy: installs of this package count as toolfunnel downloads, and
      // toolfunnel's fixes reach it through a normal `npm update` instead of a stale fork.
      dependencies: { toolfunnel: `^${tfVersion}` },
      engines: { node: '>=18' },
    };
    fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n');

    const binDir = path.join(outDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, `${name}.js`), [
      '#!/usr/bin/env node',
      "'use strict';",
      `// ${name} — an MCP server built on toolfunnel, launched against its own bundled config home.`,
      `// Set ${envOverride} to run from an external copy of the home (survives npm updates).`,
      "const path = require('node:path');",
      `const home = process.env.${envOverride} || path.join(__dirname, '..', 'home');`,
      "process.argv.splice(2, 0, '--config-dir', home);",
      "require('toolfunnel/bin/toolfunnel.js');",
      '',
    ].join('\n'));

    const readmePath = path.join(outDir, 'README.md');
    if (force || !fs.existsSync(readmePath)) {
      fs.writeFileSync(readmePath, [
        `# ${name}`,
        '',
        description,
        '',
        'An MCP server packaged with [toolfunnel](https://github.com/Rendeverance/toolfunnel) —',
        'the bundled `home/` carries the tools, curation, upstream references, AND the policy',
        'hooks: the gate travels with the pack and enforces itself on any MCP client.',
        '',
        '## Run',
        '```bash',
        `npx ${name}`,
        '```',
        '',
        '## Use an external home (survives npm updates)',
        `Set \`${envOverride}\` to a directory holding a copy of \`home/\`.`,
        '',
        '## Audit honesty',
        'Packs spawn commands. Read `home/mcp/expose.json`, `home/tools/tools.register.json`,',
        'and `home/toolfunnel.json` (its `requires` probes run at startup) of anything you',
        'install — including this.',
        '',
      ].join('\n'));
      files += 1;
    }
    files += 2; // package.json + bin
    next.push(`publishable npm package written — review it, then: cd "${outDir}" && npm publish`);
    next.push(`try it locally first: node "${path.join(outDir, 'bin', `${name}.js`)}"`);
  }

  return { ok: true, format, out: outDir, files, next };
}

function main() {
  const parsed = parseStructuredArgs();
  let payload;
  if (parsed.parseError) {
    payload = { ok: false, error: parsed.parseError };
  } else {
    try {
      payload = run(parsed.value);
    } catch (err) {
      payload = { ok: false, error: (err && err.message) || String(err) };
    }
  }
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(0);
}

main();
