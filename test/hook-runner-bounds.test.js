'use strict';

/**
 * hook-runner-bounds.test.js - the hook runner's two hardening invariants (0.7.0).
 *
 *   1. OUTPUT IS BOUNDED, AND A CAPPED HOOK FAILS CLOSED. Shipped 0.7.0 did `stdout += chunk`
 *      with no cap and then JSON.parse'd the result, so a runaway hook OOM-killed the gateway -
 *      a worse failure than any hook outcome, in the module that runs untrusted processes. Worse
 *      for safety: a truncated decision that fails to parse fell through to the exit-code
 *      protocol, and exit 0 means ALLOW. So an unreadable decision read as permission.
 *   2. THE TREE KILL WORKS ON POSIX TOO. The 0.7.0 comment correctly diagnosed that killing the
 *      shell orphans its grandchildren (they hold the stdio pipes open forever), then fixed it
 *      for Windows only via taskkill /T. POSIX sent SIGKILL to the shell alone. The fix spawns
 *      detached there so the shell leads a process group and kill(-pid) reaches the whole tree.
 *
 * NOTE the timeout is hookSpec.timeout in SECONDS (not an opts field) - an earlier draft passed
 * opts.timeoutMs, which is ignored, so the grandchild case silently used the 60 s default and
 * looked like a tree-kill failure. The code was right and the test was wrong.
 *
 * Cross-platform by construction (a hard project rule): every hook script here is `node -e`,
 * every assertion is about the runner's own result, and the grandchild-reaping check is asserted
 * via the runner returning promptly rather than by inspecting OS process tables.
 *
 * Exit 0 = bounded + fails closed + reaps; 1 = a shipped hole. Node built-ins only. CommonJS.
 */

const path = require('node:path');
const { runHook } = require('../src/core/hook-runner');

let fails = 0;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

const q = (js) => `node -e "${js.replace(/"/g, '\\"')}"`;

(async () => {
  // 1. A hook that floods stdout: bounded, blocked, and the reason names the cap.
  {
    // Endless drain-aware writer - no process.exit. Piped stdout is ASYNC on POSIX and
    // process.exit() discards the buffered writes: the old for-loop fixture delivered ~64KB,
    // exited 0, and the runner (correctly) saw no flood - red on every unix CI lane while
    // Windows, whose pipe writes are synchronous, delivered all 4MB and passed. The flood
    // must keep writing until the cap kills the tree - the honest shape of a runaway hook.
    const flood = q('const b="x".repeat(65536); (function w(){ if(process.stdout.write(b)) setImmediate(w); else process.stdout.once("drain", w); })();');
    const t0 = Date.now();
    const r = await runHook({ id: 'flood-stdout', event: 'PreToolUse', command: flood, timeout: 20 }, {});
    const took = Date.now() - t0;
    check('stdout is CAPPED (never unbounded)', r.stdout.length <= 1024 * 1024 + 1,
      'stdout length ' + r.stdout.length);
    check('a capped hook FAILS CLOSED (blocked, not allowed on exit 0)', r.blocked === true,
      JSON.stringify({ blocked: r.blocked, exitCode: r.exitCode, reason: r.reason }).slice(0, 260)
      + ' (0.7.0: truncation -> unparseable JSON -> exit-code protocol -> exit 0 -> ALLOW)');
    check('the deny reason names the cap so an operator can diagnose it',
      typeof r.reason === 'string' && /output cap/i.test(r.reason), String(r.reason).slice(0, 200));
    check('it settles promptly rather than reading forever', took < 20000, 'took ' + took + 'ms');
  }

  // 2. A flooding stderr hook is bounded too, and marked truncated.
  {
    const flood = q('const b="e".repeat(65536); (function w(){ if(process.stderr.write(b)) setImmediate(w); else process.stderr.once("drain", w); })();');
    const r = await runHook({ id: 'flood-stderr', event: 'PreToolUse', command: flood, timeout: 20 }, {});
    check('stderr is CAPPED', r.stderr.length <= 256 * 1024 + 64, 'stderr length ' + r.stderr.length);
    check('a stderr-capped hook also fails closed', r.blocked === true,
      JSON.stringify({ blocked: r.blocked, reason: String(r.reason).slice(0, 120) }));
  }

  // 3. REGRESSION GUARD: a normal, well-behaved hook is untouched by the caps.
  {
    const allow = q('process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:\'PreToolUse\',permissionDecision:\'allow\'}})); process.exit(0);');
    const r = await runHook({ id: 'normal-allow', event: 'PreToolUse', command: allow, timeout: 15 }, {});
    check('a normal allow hook still ALLOWS (caps did not change the happy path)',
      r.blocked === false && r.exitCode === 0, JSON.stringify({ blocked: r.blocked, exitCode: r.exitCode }));
    const deny = q('console.error(\'nope\'); process.exit(2);');
    const r2 = await runHook({ id: 'normal-deny', event: 'PreToolUse', command: deny, timeout: 15 }, {});
    check('a normal exit-2 deny still BLOCKS with its stderr reason',
      r2.blocked === true && /nope/.test(String(r2.reason)), JSON.stringify({ blocked: r2.blocked, reason: r2.reason }));
  }

  // 4. TREE KILL: a hook that spawns a long-lived GRANDCHILD and exits the shell must still
  //    resolve at the timeout, and the grandchild must actually be DEAD. The prompt-resolve
  //    assertion alone cannot catch a reaping regression - the timer answers on schedule whether
  //    or not the kill worked - so the grandchild heartbeats a file every 150 ms
  //    and the file must stop advancing shortly after the timeout fires.
  {
    const os = require('node:os');
    const fsx = require('node:fs');
    const beatDir = fsx.mkdtempSync(path.join(os.tmpdir(), 'tf-beat-'));
    const beatFile = path.join(beatDir, 'beat.txt').replace(/\\/g, '\\\\');
    const spawner = q(
      'const {spawn}=require(\'child_process\');'
      + `spawn(process.execPath,['-e','setInterval(()=>require("fs").appendFileSync("${beatFile}","b"),150);setTimeout(()=>{},60000)'],{stdio:'inherit'});`
      + 'setTimeout(()=>{},60000);'
    );
    const t0 = Date.now();
    const r = await runHook({ id: 'grandchild', event: 'PreToolUse', command: spawner, timeout: 3 }, {});
    const took = Date.now() - t0;
    check('a hook with a live GRANDCHILD still resolves at the timeout',
      r.timedOut === true && took < 12000,
      JSON.stringify({ timedOut: r.timedOut, took }) + ' (POSIX 0.7.0 killed the shell only; the grandchild held the pipes)');
    check('the timeout result is well-formed and non-blocking per the contract',
      r.blocked === false && r.exitCode === -1, JSON.stringify({ blocked: r.blocked, exitCode: r.exitCode }));
    // Give any surviving grandchild a full second to betray itself, then sample the heartbeat
    // twice a comfortable gap apart. Same size twice = dead; growth = the tree kill regressed.
    await new Promise((res) => setTimeout(res, 1000));
    const size1 = (() => { try { return fsx.statSync(path.join(beatDir, 'beat.txt')).size; } catch (_e) { return 0; } })();
    await new Promise((res) => setTimeout(res, 700));
    const size2 = (() => { try { return fsx.statSync(path.join(beatDir, 'beat.txt')).size; } catch (_e) { return 0; } })();
    check('the GRANDCHILD is actually dead (its heartbeat file stopped growing)',
      size2 === size1,
      JSON.stringify({ size1, size2 }) + ' (a growing heartbeat = the kill resolved the promise but left the tree alive)');
    try { fsx.rmSync(beatDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }

  void path;
  console.log(fails ? `\n${fails} hook-runner-bounds failure(s).` : '\nhook output is bounded, capped hooks fail closed, the tree dies.');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(1); });
