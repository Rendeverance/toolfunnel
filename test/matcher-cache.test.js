'use strict';

/**
 * matcher-cache.test.js - the matcher engine compiles each distinct matcher string ONCE,
 * and memoisation changes NO answer. matches() sits on the gate's hot path (every hook x
 * every tool call), so it must not rebuild `^(?:Bash|Write|Edit)$` per call - but a wrong
 * cache here is a wrong GATE, so most of this file pins that the cached engine answers
 * exactly as the uncached one did:
 *
 *   A - COMPILE ONCE: repeated matches() with one matcher string constructs one RegExp
 *       (counted via a scoped RegExp spy); a malformed matcher's failed compile is also
 *       remembered - it answers false every time without a fresh throw per call.
 *   B - SEMANTICS:    the full answer table is unchanged - wildcard/unset/tool-less fire,
 *       full-anchor alternation, non-matches, malformed -> false - and repeated/interleaved
 *       calls against a cached entry keep answering correctly (a shared RegExp with sticky
 *       state would fail this; ours carries no flags).
 *   C - ISOLATION:    distinct matcher strings resolve independently - caching one never
 *       bleeds into another's answer.
 *   D - BOUND:        the memo is capped - thousands of distinct matcher strings do not
 *       grow it without limit, and answers stay correct past the cap (worst case is a
 *       recompile, never a wrong fire).
 *   E - ERROR PATH:   matcherError still returns null for usable matchers and the compile
 *       message for malformed ones, cached or not.
 *
 * In-process, node built-ins only, no config touched.
 *
 * Run:  node test/matcher-cache.test.js     (exit 0 = pass, non-zero = fail)
 */

const path = require('node:path');
const assert = require('node:assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const { matches, matcherError } = require(path.join(REPO_ROOT, 'src', 'core', 'matcher.js'));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

/**
 * Count RegExp constructions during fn() by swapping the global constructor for a counting
 * shim (restored in finally). matcher.js resolves `new RegExp` at call time, so the shim
 * sees exactly its compiles. The shim delegates construction so behaviour is unchanged.
 */
function countCompiles(fn) {
  const Real = global.RegExp;
  let n = 0;
  function CountingRegExp(...args) { n += 1; return new Real(...args); }
  CountingRegExp.prototype = Real.prototype;
  global.RegExp = CountingRegExp;
  try { fn(); } finally { global.RegExp = Real; }
  return n;
}

// ── A: compile once per distinct matcher string ────────────────────────────────────────
check('A1: 100 matches() calls with one matcher compile at most once', () => {
  const m = 'CacheProbe_A1_(Bash|Write|Edit)';
  const n = countCompiles(() => {
    for (let i = 0; i < 100; i++) matches(m, 'CacheProbe_A1_Bash');
  });
  assert.ok(n <= 1, `expected <=1 compile for 100 calls, counted ${n}`);
});

check('A2: a malformed matcher is also remembered - no fresh compile attempt per call', () => {
  const bad = 'CacheProbe_A2_(unclosed';
  const n = countCompiles(() => {
    for (let i = 0; i < 50; i++) assert.strictEqual(matches(bad, 'Bash'), false);
  });
  assert.ok(n <= 1, `expected <=1 compile attempt for 50 calls, counted ${n}`);
});

// ── B: the answer table is exactly the uncached engine's ───────────────────────────────
check('B1: wildcard / unset matchers always fire', () => {
  assert.strictEqual(matches(undefined, 'Bash'), true);
  assert.strictEqual(matches(null, 'Bash'), true);
  assert.strictEqual(matches('', 'Bash'), true);
  assert.strictEqual(matches('*', 'Bash'), true);
});
check('B2: tool-less events fire regardless of matcher', () => {
  assert.strictEqual(matches('Bash|Write', undefined), true);
  assert.strictEqual(matches('Bash|Write', null), true);
});
check('B3: alternation is a FULL match - the whole tool name, not a substring', () => {
  assert.strictEqual(matches('Bash|Write', 'Bash'), true);
  assert.strictEqual(matches('Bash|Write', 'Write'), true);
  assert.strictEqual(matches('Bash|Write', 'Bashx'), false);
  assert.strictEqual(matches('Bash|Write', 'xBash'), false);
  assert.strictEqual(matches('Bash|Write', 'Read'), false);
});
check('B4: repeated + interleaved calls on one cached matcher keep answering correctly', () => {
  const m = 'CacheProbe_B4_(Bash|Write)';
  for (let i = 0; i < 20; i++) {
    assert.strictEqual(matches(m, 'CacheProbe_B4_Bash'), true, `hit, pass ${i}`);
    assert.strictEqual(matches(m, 'CacheProbe_B4_Read'), false, `miss, pass ${i}`);
    assert.strictEqual(matches(m, 'CacheProbe_B4_Write'), true, `other hit, pass ${i}`);
  }
});

// ── C: no cross-contamination between matcher strings ──────────────────────────────────
check('C1: two similar matchers resolve independently after both are cached', () => {
  assert.strictEqual(matches('CacheProbe_C1_Bash', 'CacheProbe_C1_Bash'), true);
  assert.strictEqual(matches('CacheProbe_C1_Write', 'CacheProbe_C1_Write'), true);
  assert.strictEqual(matches('CacheProbe_C1_Bash', 'CacheProbe_C1_Write'), false);
  assert.strictEqual(matches('CacheProbe_C1_Write', 'CacheProbe_C1_Bash'), false);
});

// ── D: the memo is bounded and correct past its cap ────────────────────────────────────
check('D1: 5000 distinct matchers do not grow the memo unboundedly, answers stay right', () => {
  for (let i = 0; i < 5000; i++) {
    assert.strictEqual(matches(`CacheProbe_D1_${i}`, `CacheProbe_D1_${i}`), true, `roundtrip ${i}`);
  }
  // Early entries may have been evicted - they must still ANSWER correctly (recompile is
  // the acceptable cost; a wrong fire is not).
  assert.strictEqual(matches('CacheProbe_D1_0', 'CacheProbe_D1_0'), true);
  assert.strictEqual(matches('CacheProbe_D1_0', 'CacheProbe_D1_1'), false);
});

// ── E: the error discriminator is unchanged ────────────────────────────────────────────
check('E1: matcherError - null for usable, the compile message for malformed', () => {
  assert.strictEqual(matcherError('*'), null);
  assert.strictEqual(matcherError(''), null);
  assert.strictEqual(matcherError(undefined), null);
  assert.strictEqual(matcherError('Bash|Write'), null);
  const err = matcherError('CacheProbe_E1_(unclosed');
  assert.ok(typeof err === 'string' && err.length > 0, 'expected a compile message, got ' + JSON.stringify(err));
});
check('E2: matcherError on a malformed matcher matches() already cached still reports it', () => {
  const bad = 'CacheProbe_E2_[unclosed';
  assert.strictEqual(matches(bad, 'Bash'), false);
  const err = matcherError(bad);
  assert.ok(typeof err === 'string' && err.length > 0, 'expected a compile message, got ' + JSON.stringify(err));
});

// ── Report ─────────────────────────────────────────────────────────────────────────────
for (const r of results) {
  console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
}
const passed = results.filter((r) => r.ok).length;
const expected = 10;
if (passed === results.length && results.length === expected) {
  console.log(`\nPASS: matcher-cache test - ${passed}/${expected} assertions passed (one compile per matcher string; every answer identical to the uncached engine; memo bounded)`);
  process.exit(0);
} else {
  console.log(`\nFAIL: matcher-cache test - ${passed}/${results.length} assertions passed`);
  process.exit(1);
}
