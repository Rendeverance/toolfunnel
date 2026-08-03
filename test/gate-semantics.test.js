'use strict';

/**
 * gate-semantics.test.js - PINS what the PreToolUse gate actually does with a hook that DENIES,
 * ALLOWS, CRASHES, IS MISSING, or HANGS. Not a bug report: an executable statement of the contract
 * the documentation makes.
 *
 * Why this file exists. The semantics below are 0.6.0 behaviour and match Claude Code's hook
 * protocol - exit 2 denies, exit 0 allows, and any OTHER failure is a non-blocking error that
 * leaves the call allowed. That is a deliberate design position (a broken gate script must not
 * take the whole gateway offline), but NOTHING asserted it, so the docs drifted away from it:
 * hooks.manifest.json and the shipped example both claimed "a non-zero exit fails closed", which
 * exit 1 does not do. Documentation that nothing executes is a comment, and comments rot.
 *
 * The distinction the runner DOES draw, and which this file also pins: a hook whose decision
 * cannot be READ (output past the cap, unparseable JSON) is denied, because an unreadable
 * decision must never read as permission. "Cannot read the answer" and "the script itself fell
 * over" are different events and get different answers - deny the first, allow the second.
 *
 * If a future change makes crash/missing/timeout DENY, this test fails - and the failure is the
 * reminder that README.md, SECURITY.md, docs/design.md, hooks/hooks.manifest.json and
 * hooks/scripts/example-deny-dangerous.js all describe this contract and must move with it.
 *
 * Cross-platform by construction: every hook is `node -e`, every assertion is about the runner's
 * own result object. Exit 0 = the contract holds. Node built-ins only. CommonJS.
 */

const path = require('node:path');

const { runHook } = require(path.join(__dirname, '..', 'src', 'core', 'hook-runner'));

let fails = 0;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

const NODE = JSON.stringify(process.execPath);
const spec = (code, extra) => Object.assign({
  id: 'test/gate',
  event: 'PreToolUse',
  matcher: '*',
  type: 'command',
  command: `${NODE} -e ${JSON.stringify(code)}`,
  timeout: 10,
  enabled: true,
}, extra || {});

const EVENT = { tool_name: 'demo', tool_input: { x: 1 } };

(async () => {
  try {
    // ── The two halves of the documented protocol ────────────────────────────────────────────
    const deny = await runHook(spec('process.stderr.write("no"); process.exit(2);'), EVENT);
    check('exit 2 DENIES (the deny protocol; this is what a policy gate uses)',
      deny.blocked === true, JSON.stringify(deny));

    const allow = await runHook(spec('process.exit(0);'), EVENT);
    check('exit 0 ALLOWS', allow.blocked === false, JSON.stringify(allow));

    // ── The non-blocking-error class. Each of these ALLOWS - deliberately, and documented. ────
    const crash = await runHook(spec('process.exit(1);'), EVENT);
    check('exit 1 ALLOWS (a non-2 failure is a non-blocking error, NOT a deny)',
      crash.blocked === false,
      JSON.stringify(crash) + ' (the manifest+example called this "fails closed"; it does not)');

    const threw = await runHook(spec('throw new Error("boom");'), EVENT);
    check('a hook that THROWS allows (uncaught error exits 1 - same class)',
      threw.blocked === false, JSON.stringify(threw));

    const missing = await runHook(Object.assign(spec('process.exit(0);'), {
      command: JSON.stringify(path.join(__dirname, 'no-such-hook-script-exists.js')),
    }), EVENT);
    check('a MISSING hook script allows (spawn failure is a wiring error, not a decision)',
      missing.blocked === false, JSON.stringify(missing));

    const hang = await runHook(spec('setTimeout(() => {}, 60000);', { timeout: 1 }), EVENT);
    check('a hook that HANGS past its timeout allows (the timeout contract)',
      hang.blocked === false && hang.timedOut === true, JSON.stringify(hang));

    // ── The counterweight: an UNREADABLE decision is denied. ──────────────────────────────────
    // This is the line the runner draws, and it is why "fails closed" is not simply false: when
    // the gate produced an answer it could not read, it refuses. Only when the script never
    // produced one does the call proceed.
    // Drain-aware endless flood, no process.exit - POSIX async pipes discard buffered writes
    // on exit, so the old fixture self-truncated below the cap on unix (see hook-runner-bounds).
    const flood = await runHook(spec(
      'const s="x".repeat(1024*64); (function w(){ if(process.stdout.write(s)) setImmediate(w); else process.stdout.once("drain", w); })();'
    ), EVENT);
    check('a hook flooding past the OUTPUT CAP is DENIED (an unreadable decision is not permission)',
      flood.blocked === true, JSON.stringify({ blocked: flood.blocked, reason: flood.reason }));

    // The other half of "unreadable": a hook that emits a protocol object (stdout starts with `{`)
    // that does NOT parse - truncated output, a missing brace, a stray character. A decision that
    // loses a character on its way out must not be read as permission; the runner denies it, the
    // same way it denies output past the cap. A gate that assembles its JSON by hand is the common
    // way a message ends up malformed, so the safe reading is the one that matters here.
    const truncated = await runHook(spec(
      'process.stdout.write(\'{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"no"\'); process.exit(0);'
    ), EVENT);
    check('a `{`-led decision that FAILS TO PARSE is DENIED (an unreadable answer is not a yes)',
      truncated.blocked === true, JSON.stringify({ blocked: truncated.blocked, reason: truncated.reason }));

    const brace = await runHook(spec(
      'process.stdout.write(\'{"decision":"block","reason":"nope"\'); process.exit(0);'
    ), EVENT);
    check('a decision JSON missing its trailing brace is DENIED, not silently allowed',
      brace.blocked === true, JSON.stringify({ blocked: brace.blocked, reason: brace.reason }));

    // The boundary the fix must NOT cross: stdout that does not start with `{` is not a protocol
    // attempt at all, so exit 0 still ALLOWS (arbitrary text a hook prints is not a decision).
    const chatter = await runHook(spec('process.stdout.write("just some log line\\n"); process.exit(0);'), EVENT);
    check('plain non-`{` stdout on exit 0 still ALLOWS (not every print is a decision)',
      chatter.blocked === false, JSON.stringify({ blocked: chatter.blocked }));

    // And valid JSON that is not a protocol object still falls through to exit-code (readable,
    // just not a decision) - the corrupt-deny is about UNREADABLE, not about "not a decision".
    const blob = await runHook(spec('process.stdout.write(\'{"unrelated":true}\'); process.exit(0);'), EVENT);
    check('valid non-protocol JSON on exit 0 still ALLOWS (readable, simply not a decision)',
      blob.blocked === false, JSON.stringify({ blocked: blob.blocked }));

    // ── The decision VOCABULARY is exact (0.7.0). A decision slot carrying a value outside the
    // protocol's words - miscased "DENY", a synonym like "denied", the right word in the wrong
    // slot - is an ATTEMPTED decision the runner cannot read, and an unreadable decision is
    // never permission (the same rule as the cap and the parse failure above). Before 0.7.0
    // every one of these read as ALLOW.
    const miscased = await runHook(spec(
      'process.stdout.write(\'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"DENY","permissionDecisionReason":"no"}}\'); process.exit(0);'
    ), EVENT);
    check('permissionDecision "DENY" (miscased) is DENIED, not read as allow',
      miscased.blocked === true, JSON.stringify({ blocked: miscased.blocked, reason: miscased.reason }));
    check('the miscased-decision deny NAMES the unreadable value',
      typeof miscased.reason === 'string' && miscased.reason.includes('DENY'),
      'reason = ' + JSON.stringify(miscased.reason));

    const synonym = await runHook(spec(
      'process.stdout.write(\'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"denied"}}\'); process.exit(0);'
    ), EVENT);
    check('permissionDecision "denied" (synonym) is DENIED, not read as allow',
      synonym.blocked === true, JSON.stringify({ blocked: synonym.blocked, reason: synonym.reason }));

    const wrongSlot = await runHook(spec(
      'process.stdout.write(\'{"decision":"deny","reason":"no"}\'); process.exit(0);'
    ), EVENT);
    check('decision "deny" (right word, wrong slot - only "block" lives here) is DENIED',
      wrongSlot.blocked === true, JSON.stringify({ blocked: wrongSlot.blocked, reason: wrongSlot.reason }));

    const miscasedBlock = await runHook(spec(
      'process.stdout.write(\'{"decision":"Block"}\'); process.exit(0);'
    ), EVENT);
    check('decision "Block" (miscased) is DENIED, not read as allow',
      miscasedBlock.blocked === true, JSON.stringify({ blocked: miscasedBlock.blocked, reason: miscasedBlock.reason }));

    // The boundary the fix must NOT cross: the documented vocabulary keeps its meanings.
    const vAllow = await runHook(spec(
      'process.stdout.write(\'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\'); process.exit(0);'
    ), EVENT);
    check('permissionDecision "allow" still ALLOWS', vAllow.blocked === false, JSON.stringify(vAllow));
    const vAsk = await runHook(spec(
      'process.stdout.write(\'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"sure?"}}\'); process.exit(0);'
    ), EVENT);
    check('permissionDecision "ask" is still non-blocking (no interactive host)',
      vAsk.blocked === false, JSON.stringify(vAsk));
    const vDeny = await runHook(spec(
      'process.stdout.write(\'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"policy"}}\'); process.exit(0);'
    ), EVENT);
    check('permissionDecision "deny" still DENIES with its reason',
      vDeny.blocked === true && vDeny.reason === 'policy', JSON.stringify(vDeny));
    const vBlock = await runHook(spec(
      'process.stdout.write(\'{"decision":"block","reason":"stop"}\'); process.exit(0);'
    ), EVENT);
    check('decision "block" still BLOCKS with its reason',
      vBlock.blocked === true && vBlock.reason === 'stop', JSON.stringify(vBlock));

    // ── The same rule for the OTHER protocol slots (the class sweep of the vocabulary fix). ───
    // `continue` is boolean; `hookSpecificOutput` is an object. A present key with an unreadable
    // value is an attempted instruction the runner cannot read - denied, same as a bad decision.
    const contString = await runHook(spec(
      'process.stdout.write(\'{"continue":"false"}\'); process.exit(0);'
    ), EVENT);
    check('continue "false" (string, not boolean) is DENIED, not silently ignored',
      contString.blocked === true, JSON.stringify({ blocked: contString.blocked, reason: contString.reason }));

    const hsoString = await runHook(spec(
      'process.stdout.write(\'{"hookSpecificOutput":"deny"}\'); process.exit(0);'
    ), EVENT);
    check('hookSpecificOutput as a bare string is DENIED (structured output that cannot be read)',
      hsoString.blocked === true, JSON.stringify({ blocked: hsoString.blocked, reason: hsoString.reason }));

    const contFalse = await runHook(spec(
      'process.stdout.write(\'{"continue":false,"reason":"done"}\'); process.exit(0);'
    ), EVENT);
    check('continue false (boolean) still sets stopLoop without blocking',
      contFalse.blocked === false && contFalse.stopLoop === true, JSON.stringify(contFalse));

    const hsoEmpty = await runHook(spec(
      'process.stdout.write(\'{"hookSpecificOutput":{"hookEventName":"PreToolUse"}}\'); process.exit(0);'
    ), EVENT);
    check('an object hookSpecificOutput with NO decision still ALLOWS (readable, no decision)',
      hsoEmpty.blocked === false, JSON.stringify(hsoEmpty));

    // ── `null` in a protocol slot reads as "no value" - the READABLE spelling of an absent key
    // (0.7.0). Typed-struct and dataclass serialisers emit null for an unset optional field, so a
    // hook that makes NO decision may still ship the key. That is not an attempted decision the
    // runner failed to read - it is the absence of one, spelled out - and it falls through exactly
    // as the absent key does. Every other out-of-vocabulary value above still denies.
    const permNull = await runHook(spec(
      'process.stdout.write(\'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":null}}\'); process.exit(0);'
    ), EVENT);
    check('permissionDecision null ALLOWS (null = no decision, same as an absent key)',
      permNull.blocked === false, JSON.stringify(permNull));

    const decNull = await runHook(spec(
      'process.stdout.write(\'{"decision":null}\'); process.exit(0);'
    ), EVENT);
    check('decision null ALLOWS (same rule)',
      decNull.blocked === false, JSON.stringify(decNull));

    const contNull = await runHook(spec(
      'process.stdout.write(\'{"continue":null}\'); process.exit(0);'
    ), EVENT);
    check('continue null neither blocks nor stops the loop',
      contNull.blocked === false && contNull.stopLoop === false, JSON.stringify(contNull));

    const hsoNull = await runHook(spec(
      'process.stdout.write(\'{"hookSpecificOutput":null}\'); process.exit(0);'
    ), EVENT);
    check('hookSpecificOutput null ALLOWS (null = none present; a bare string above still denies)',
      hsoNull.blocked === false, JSON.stringify(hsoNull));

    // ── The deny carries WHY, so a broken gate is never mistaken for an approving one. ────────
    check('a wiring-failure deny is distinguishable from a policy deny',
      typeof flood.reason === 'string' && flood.reason.length > 0
        && flood.reason !== (deny.reason || ''),
      JSON.stringify({ flood: flood.reason, policy: deny.reason }));
  } catch (err) {
    console.log('CRASHED: ' + ((err && err.stack) || err));
    fails += 1;
  }

  console.log(fails ? `\n${fails} gate-semantics failure(s).` : '\nthe gate contract is what the docs say it is.');
  process.exit(fails ? 1 : 0);
})();
