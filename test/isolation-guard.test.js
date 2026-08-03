'use strict';

/**
 * isolation-guard.test.js - the path-isolation guard must cover EVERY field that decides what
 * code the spawned upstream runs, not just `args` (0.7.0 defect #2).
 *
 * Shipped 0.7.0 looped over `args` only, then handed `upstream.cwd` and `upstream.env` straight to
 * the spawn. Two independent escapes from a boundary the docs call the trust boundary:
 *
 *   1. `cwd` OUTSIDE THE ROOT. A bare arg like 'server.js' has no separator, so looksLikePath() is
 *      false and it is never checked; the guard's own relative branch would resolve it against the
 *      root, while the child resolves it against `cwd`. The 0.7.0 comment asserting "guard-base and
 *      spawn-base agree by construction" is false the moment cwd is set.
 *   2. `env` INJECTION. NODE_OPTIONS=--require /outside/outside-module.js loads outside code regardless of
 *      args, and so do NODE_PATH / LD_PRELOAD / DYLD_INSERT_LIBRARIES. Reachable in-band: the
 *      tf_mcp_add script forwards args.env verbatim.
 *
 * Cross-platform: asserts the guard's DECISION (throw / no-throw) rather than spawning anything,
 * so it behaves identically on Windows, macOS and Linux. The Linux-only and macOS-only preload
 * vars are asserted as refusals everywhere, because a config authored on one platform gets run on
 * another - that is the whole point of a portable pack.
 *
 * Exit 0 = every escape is closed and legitimate configs still pass; 1 = a hole. CommonJS.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { defaultClientFactory } = require('../src/mcp/aggregator');

let fails = 0;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-iso-root-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-iso-outside-'));
fs.mkdirSync(path.join(root, 'mcp'), { recursive: true });
fs.writeFileSync(path.join(root, 'mcp', 'inside-server.js'), 'process.exit(0);\n');
fs.writeFileSync(path.join(outside, 'outside-module.js'), 'process.exit(0);\n');

/**
 * Run ONLY the guard. defaultClientFactory enforces it and then CONSTRUCTS a McpClient - which
 * does not spawn anything (that happens on connect) - so this exercises the real decision with no
 * child process and identical behaviour on every platform.
 */
function guard(upstream, allowOutsidePaths) {
  const entry = Object.assign(
    { id: 'probe', transport: 'stdio', command: process.execPath, enabled: true },
    upstream
  );
  try {
    const client = defaultClientFactory(entry, root, () => {}, allowOutsidePaths === true, undefined);
    try { if (client && typeof client.close === 'function') client.close(); } catch (_e) { /* ignore */ }
    return { refused: false, error: null };
  } catch (err) {
    const msg = (err && err.message) || String(err);
    return { refused: /isolation/i.test(msg), error: msg };
  }
}

(async () => {
  // ── SANITY: the shipped args guard still works, both directions ─────────────────────────────
  {
    const ok = guard({ args: [path.join(root, 'mcp', 'inside-server.js')] });
    check('sanity: an INSIDE args path is permitted', ok.refused === false, JSON.stringify(ok));
    const bad = guard({ args: [path.join(outside, 'outside-module.js')] });
    check('sanity: an OUTSIDE args path is refused', bad.refused === true, JSON.stringify(bad));
  }

  // ── ESCAPE 1b: the --flag=path arg form ──────────────────────────────────────────────────────
  // A runtime option in `--flag=value` form (node's --require=, --import=, --experimental-loader=)
  // reads only the part AFTER the '=' as a path. The whole token '--require=../x.js' holds no '..'
  // segment of its own, so a check of the whole token judges it inside; the child resolves the
  // value and leaves the root. The separate-token form ('--require', '../x.js') is already caught,
  // because the second token IS a bare path - only the '=' form slipped.
  {
    const outsideAbs = path.join(outside, 'outside-module.js');
    for (const flag of ['--require', '--import', '--experimental-loader']) {
      const abs = guard({ args: [`${flag}=${outsideAbs}`] });
      check(`an OUTSIDE path in ${flag}=<path> is REFUSED`, abs.refused === true, JSON.stringify(abs));
      const rel = guard({ args: [`${flag}=../escapes-root.js`] });
      check(`a ".." escape in ${flag}=<path> is REFUSED`, rel.refused === true, JSON.stringify(rel));
    }
    const drv = guard({ args: ['--require=C:evil.js'] });
    check('a drive-relative path in --require=<path> is REFUSED (matches the bare-arg rule)',
      drv.refused === true, JSON.stringify(drv));

    // The boundary the fix must not cross: a value that is not a path, and an inside path, both pass.
    const inside = path.join(root, 'mcp', 'inside-server.js');
    const insideEq = guard({ args: [`--require=${inside}`] });
    check('an INSIDE path in --require=<path> is still permitted', insideEq.refused === false, JSON.stringify(insideEq));
    const nonPath = guard({ args: ['--max-old-space-size=4096', '--port=8080'] });
    check('a non-path --flag=value is still permitted (no false refusal)', nonPath.refused === false, JSON.stringify(nonPath));
  }

  // ── ESCAPE 1: cwd ───────────────────────────────────────────────────────────────────────────
  {
    const r = guard({ args: ['outside-module.js'], cwd: outside });
    check('an OUTSIDE cwd is REFUSED (bare arg + cwd was the guard-blind escape)',
      r.refused === true,
      JSON.stringify(r) + ' (0.7.0: looksLikePath("outside-module.js") is false, so nothing was checked, and the child resolved it against cwd)');

    const rIn = guard({ args: ['inside-server.js'], cwd: path.join(root, 'mcp') });
    check('an INSIDE cwd is still permitted (vendored upstreams keep working)',
      rIn.refused === false, JSON.stringify(rIn));

    const rUp = guard({ args: ['inside-server.js'], cwd: path.join(root, 'mcp', '..', '..') });
    check('a cwd escaping via ".." is REFUSED', rUp.refused === true, JSON.stringify(rUp));
  }

  // ── ESCAPE 2: env code injection ─────────────────────────────────────────────────────────────
  {
    const cases = [
      ['NODE_OPTIONS', { NODE_OPTIONS: '--require ' + path.join(outside, 'outside-module.js') }],
      ['NODE_PATH', { NODE_PATH: outside }],
      ['LD_PRELOAD', { LD_PRELOAD: path.join(outside, 'outside-lib.so') }],
      ['DYLD_INSERT_LIBRARIES', { DYLD_INSERT_LIBRARIES: path.join(outside, 'outside-lib.dylib') }],
    ];
    for (const [name, env] of cases) {
      const r = guard({ args: [path.join(root, 'mcp', 'inside-server.js')], env });
      check(`env ${name} is REFUSED (loads outside code whatever the args say)`,
        r.refused === true, JSON.stringify(r));
    }

    const ok = guard({
      args: [path.join(root, 'mcp', 'inside-server.js')],
      env: { API_KEY: 'secret', TF_MODE: 'x', PATH: process.env.PATH },
    });
    check('ordinary env vars are still permitted (API keys, flags, PATH)',
      ok.refused === false, JSON.stringify(ok));
  }

  // ── ESCAPE 2b: the split-logic blind spots ─────────────────────
  {
    // A win32 drive path in a list var must be judged WHOLE. Splitting 'C:relative\denied' on ':'
    // yields 'C' and 'relative\denied' - both resolve inside the root, so the drive-relative escape
    // (same class looksLikePath() already catches in args) sailed through. Asserted on every
    // platform: the guard's rule is that all platforms' shapes are checked everywhere.
    const dr = guard({
      args: [path.join(root, 'mcp', 'inside-server.js')],
      env: { PYTHONPATH: 'C:relative\\denied' },
    });
    check('a drive-relative win32 path in PYTHONPATH is REFUSED (not shredded on ":")',
      dr.refused === true, JSON.stringify(dr));
  }

  // ── option-string vars are NOT path-checkable - refused outright ───────────────
  {
    const inside = path.join(root, 'mcp', 'inside-server.js');
    // Every known defeat of a path tokeniser, plus the plain forms. The rule that closes
    // them all: NODE_OPTIONS (and its Java/Perl/Ruby siblings) is a mini command line in the
    // runtime's OWN grammar - quoting, = forms, file:/data: URLs, inspector flags. A path-shaped
    // guard cannot verify it, and a guard that cannot verify must refuse, not guess.
    const optCases = [
      ['space form', { NODE_OPTIONS: '--require ' + path.join(outside, 'outside-module.js') }],
      ['= form', { NODE_OPTIONS: '--require=' + path.join(outside, 'outside-module.js') }],
      ['quoted value', { NODE_OPTIONS: '--require "' + path.join(outside, 'outside-module.js') + '"' }],
      ['file: URL', { NODE_OPTIONS: '--import file:///C:/denied/x.mjs' }],
      ['data: URL', { NODE_OPTIONS: '--import=data:text/javascript,globalThis.x=1' }],
      ['bare --inspect', { NODE_OPTIONS: '--inspect' }],
      ['inside-pointing value', { NODE_OPTIONS: '--require=' + inside }],
      ['JAVA_TOOL_OPTIONS agent', { JAVA_TOOL_OPTIONS: '-javaagent:' + path.join(outside, 'a.jar') }],
      ['_JAVA_OPTIONS agent', { _JAVA_OPTIONS: '-javaagent:' + path.join(outside, 'a.jar') }],
      ['PERL5OPT module', { PERL5OPT: '-M' + path.join(outside, 'M.pm') }],
      ['RUBYOPT require', { RUBYOPT: '-r' + path.join(outside, 'x.rb') }],
    ];
    for (const [label, env] of optCases) {
      const r = guard({ args: [inside], env });
      check(`opt-string env is REFUSED outright (${label})`, r.refused === true, JSON.stringify(r));
    }

    // The operator's deliberate, visible opt-out: allowCodeLoadingEnv on the upstream entry.
    const optedIn = guard({
      args: [inside],
      env: { NODE_OPTIONS: '--max-old-space-size=4096' },
      allowCodeLoadingEnv: true,
    });
    check('allowCodeLoadingEnv: true PERMITS the opt-string var (explicit operator opt-out)',
      optedIn.refused === false, JSON.stringify(optedIn));
  }

  // ── env keys are case-insensitive on Windows - so they are everywhere here ─────
  {
    const inside = path.join(root, 'mcp', 'inside-server.js');
    for (const key of ['node_options', 'Node_Options', 'nOdE_oPtIoNs']) {
      const env = {}; env[key] = '--require ' + path.join(outside, 'outside-module.js');
      const r = guard({ args: [inside], env });
      check(`env key "${key}" is REFUSED (win32 env is case-insensitive; checked everywhere)`,
        r.refused === true, JSON.stringify(r));
    }
    const lowerPath = guard({ args: [inside], env: { pythonpath: outside } });
    check('env key "pythonpath" is REFUSED (case-insensitive path var)',
      lowerPath.refused === true, JSON.stringify(lowerPath));
    const ordinary = guard({ args: [inside], env: { api_key: 'secret', my_flag: 'on' } });
    check('ordinary lowercase env vars are still permitted', ordinary.refused === false,
      JSON.stringify(ordinary));
  }

  // ── SHAPE, not just spelling: the guard must read env exactly as the spawn does ──────────────
  // Two bypasses of the same root cause - the guard inspected one representation of the env while
  // child_process consumed a different one:
  //   1. NON-STRING VALUES. The value-shape check ran before the key was classified, so any
  //      non-string skipped both lists. node builds each pair as `${key}=${value}`, and a
  //      one-element array stringifies to its element: {NODE_OPTIONS:['--require=/outside-module.js']}
  //      reached the child verbatim (measured: the child attempted the preload).
  //   2. INHERITED KEYS. JSON.parse gives `__proto__` as an OWN data property, spread preserves
  //      it, but Object.assign (the client's env merge) uses [[Set]] - which invokes the
  //      Object.prototype.__proto__ setter and installs the payload as the merged env's
  //      PROTOTYPE. node enumerates env with for..in ("prototype values are intentionally
  //      included"), so the child got NODE_OPTIONS while Object.keys showed the guard nothing.
  // Both are reachable in-band: tf_mcp_add forwards `env` verbatim from model-supplied JSON.
  {
    const inside = path.join(root, 'mcp', 'inside-server.js');
    const denied = path.join(outside, 'outside-module.js');

    const arr = guard({ args: [inside], env: { NODE_OPTIONS: ['--require=' + denied] } });
    check('a non-string (array) value in an opt-string var is REFUSED',
      arr.refused === true, JSON.stringify(arr) + ' (node stringifies a 1-element array to its element)');

    const arrPath = guard({ args: [inside], env: { PYTHONPATH: [outside] } });
    check('a non-string (array) value in a path var is REFUSED',
      arrPath.refused === true, JSON.stringify(arrPath));

    const num = guard({ args: [inside], env: { NODE_OPTIONS: 12345 } });
    check('a non-string (number) value in a code-loading var is REFUSED',
      num.refused === true, JSON.stringify(num));

    const nested = guard({ args: [inside], env: { NODE_OPTIONS: { toString: 'x' } } });
    check('a non-string (object) value in a code-loading var is REFUSED',
      nested.refused === true, JSON.stringify(nested));

    // The prototype carrier, built exactly as it arrives over the wire.
    const carrier = JSON.parse('{"__proto__":{"NODE_OPTIONS":"--require=' + denied.replace(/\\/g, '\\\\') + '"}}');
    const proto = guard({ args: [inside], env: carrier });
    check('an INHERITED code-loading key (__proto__ carrier) is REFUSED',
      proto.refused === true,
      JSON.stringify(proto) + ' (Object.keys sees only "__proto__"; the child sees NODE_OPTIONS via for..in)');

    // An ordinary env object must still sail through, values coerced sanely.
    const okShapes = guard({ args: [inside], env: { API_KEY: 'secret', PORT: '8080' } });
    check('ordinary string env still permitted after the shape hardening',
      okShapes.refused === false, JSON.stringify(okShapes));
  }

  // ── the analogue floor + cwd drive-relative ───────────────────────────────
  {
    const inside = path.join(root, 'mcp', 'inside-server.js');
    const floorCases = [
      ['BASH_ENV', { BASH_ENV: path.join(outside, 'rc.sh') }],
      ['ENV', { ENV: path.join(outside, 'rc.sh') }],
      ['LD_AUDIT', { LD_AUDIT: path.join(outside, 'a.so') }],
      ['DYLD_FRAMEWORK_PATH', { DYLD_FRAMEWORK_PATH: outside }],
      ['PYTHONHOME', { PYTHONHOME: outside }],
      ['PYTHONEXECUTABLE', { PYTHONEXECUTABLE: path.join(outside, 'python.exe') }],
      ['CLASSPATH', { CLASSPATH: path.join(outside, 'x.jar') }],
      ['GEM_PATH', { GEM_PATH: outside }],
      ['DOTNET_STARTUP_HOOKS', { DOTNET_STARTUP_HOOKS: path.join(outside, 'hook.dll') }],
      ['CORECLR_PROFILER_PATH', { CORECLR_PROFILER_PATH: path.join(outside, 'p.dll') }],
      ['NODE_REPL_EXTERNAL_MODULE', { NODE_REPL_EXTERNAL_MODULE: path.join(outside, 'r.js') }],
    ];
    for (const [label, env] of floorCases) {
      const r = guard({ args: [inside], env });
      check(`analogue floor: ${label} outside the root is REFUSED`, r.refused === true, JSON.stringify(r));
    }
    const floorInside = guard({ args: [inside], env: { BASH_ENV: path.join(root, 'mcp', 'rc.sh') } });
    check('analogue floor: a path var pointing INSIDE is still permitted',
      floorInside.refused === false, JSON.stringify(floorInside));

    // cwd was the one guarded field without the drive-relative refusal the doc claims applies
    // "wherever paths are guarded" - and the one where it matters most (it re-bases bare args).
    const drCwd = guard({ args: ['server.js'], cwd: 'C:denied' });
    check('a DRIVE-RELATIVE cwd is REFUSED (its resolution base is the child\'s per-drive cwd)',
      drCwd.refused === true, JSON.stringify(drCwd));
  }

  // ── allowOutsidePaths: a PER-UPSTREAM opt-out that must not leak to its neighbours ──────
  // SECURITY.md documented this as a per-upstream config field for a release in which it was only
  // an internal function parameter: an operator could write it into expose.json, watch it persist
  // through every store rewrite, and believe an exemption was in force while the guard refused
  // exactly as before. Making the document true means making the field real - and the property
  // that makes it SAFE to be real is that it is scoped to the one upstream carrying it.
  {
    const outsideArg = path.join(outside, 'outside-module.js');
    const permitted = guard({ id: 'permitted', args: [outsideArg], allowOutsidePaths: true });
    check('allowOutsidePaths:true PERMITS an outside path for the upstream that sets it',
      permitted.refused === false,
      JSON.stringify(permitted) + ' (the flag was documented in SECURITY.md but read by nothing)');

    // THE CONTAINMENT PROPERTY. One upstream relaxing its own guard must never relax anybody
    // else's. Checked immediately after the permitted spawn above, so a flag latched into shared
    // state rather than read per-upstream would show up here as a neighbour going unguarded.
    const neighbour = guard({ id: 'neighbour', args: [outsideArg] });
    check('a SIBLING upstream without the flag is STILL REFUSED (the opt-out does not leak)',
      neighbour.refused === true,
      JSON.stringify(neighbour) + ' (one upstream opting out must not disarm the guard globally)');

    const falsey = guard({ id: 'falsey', args: [outsideArg], allowOutsidePaths: 'yes' });
    check('a non-true allowOutsidePaths value does NOT opt out (strict === true)',
      falsey.refused === true, JSON.stringify(falsey));
  }

  // ── A3: one notice PER CLASS, and the path flag does not excuse the option-string class ──────
  {
    const inside = path.join(root, 'mcp', 'inside-server.js');
    const outsideArg = path.join(outside, 'outside-module.js');
    const preload = '--require ' + path.join(outside, 'outside-module.js');

    // Capture the guard's stderr notices without letting them hit the test output.
    const capture = (fn) => {
      const real = process.stderr.write.bind(process.stderr);
      const lines = [];
      process.stderr.write = (s) => { lines.push(String(s)); return true; };
      let result;
      try { result = fn(); } finally { process.stderr.write = real; }
      return { result, notices: lines.filter((l) => /\[toolfunnel\] isolation:/.test(l)) };
    };

    // A3-b, the scope leak. allowOutsidePaths is the PATH guard's opt-out - args, cwd, and the
    // path-list env vars, its own documentation's words. The option-string class (NODE_OPTIONS et
    // al.) has its OWN separately-audited flag, allowCodeLoadingEnv. The path flag alone must NOT
    // excuse it: an operator who set allowOutsidePaths to run a git server against a repo outside
    // the home also - invisibly - disarmed the code-loading tripwire for that upstream.
    const leak = capture(() => guard({ id: 'leak', args: [inside],
      env: { NODE_OPTIONS: preload }, allowOutsidePaths: true }));
    check('A3-b: allowOutsidePaths alone does NOT excuse an option-string env var',
      leak.result.refused === true,
      JSON.stringify(leak.result)
      + ' (the path flag silently granted the exemption the docs say needs allowCodeLoadingEnv)');

    // Path-list env IS within the path flag's documented scope - still permitted, and NOTICED.
    const pathList = capture(() => guard({ id: 'pathlist', args: [inside],
      env: { NODE_PATH: outside }, allowOutsidePaths: true }));
    check('A3-b: a path-list env var stays excused by allowOutsidePaths, with its own notice',
      pathList.result.refused === false && pathList.notices.length === 1
        && /code-loading env/.test(pathList.notices.join('')),
      JSON.stringify({ r: pathList.result, notices: pathList.notices }));

    // A3-a, one notice per CLASS. An upstream with BOTH opt-outs and BOTH finding kinds must
    // record BOTH excusals. The shared `warned` flag let the first (path) notice consume the only
    // slot, so the env excusal - the class that loads code - went entirely unrecorded, even for
    // the operator who explicitly opted in and most needs the audit trail.
    const both = capture(() => guard({ id: 'both', args: [outsideArg],
      env: { NODE_OPTIONS: preload }, allowOutsidePaths: true, allowCodeLoadingEnv: true }));
    const bothPath = both.notices.filter((l) => /outside the gateway root/.test(l)).length;
    const bothEnv = both.notices.filter((l) => /code-loading env/.test(l)).length;
    check('A3-a: BOTH classes are noticed under config opt-outs (path notice + env notice)',
      both.result.refused === false && bothPath === 1 && bothEnv === 1,
      JSON.stringify({ r: both.result, notices: both.notices })
      + ' (one shared warned flag: the arg notice silenced the env notice)');

    // Same per-class rule under the WRAP - the transparent wrapper excuses everything, but it
    // must SAY so for each class it excuses.
    const wrap = capture(() => guard({ id: 'wrapboth', args: [outsideArg],
      env: { NODE_OPTIONS: preload } }, true));
    const wrapPath = wrap.notices.filter((l) => /outside the gateway root/.test(l)).length;
    const wrapEnv = wrap.notices.filter((l) => /code-loading env/.test(l)).length;
    check('A3-a: BOTH classes are noticed under a WRAP too',
      wrap.result.refused === false && wrapPath === 1 && wrapEnv === 1,
      JSON.stringify({ r: wrap.result, notices: wrap.notices }));
  }

  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  try { fs.rmSync(outside, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }

  console.log(fails ? `\n${fails} isolation-guard failure(s).` : '\nthe isolation guard covers args, cwd and env.');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(1); });
