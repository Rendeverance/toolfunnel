#!/usr/bin/env node
/**
 * hook-engine-requires.test.js - the hook engine refuses to load without what it needs.
 *
 * The engine used to look up each dependency through a "defensive fallback": no matcher -> fire
 * EVERY hook; no matcherError -> treat every matcher as readable (so an unreadable gate stopped
 * blocking); no buildPayload -> a minimal home-made payload; no runHook -> a throw, but only when an
 * engine was constructed. None of those states can happen with the shipped modules, and the one
 * that could (a broken or mismatched install) is exactly when a gate must not quietly change
 * meaning. Ruling 6: delete all four; bind the real functions and refuse to LOAD when one is missing,
 * naming it.
 *
 * Each check stubs one sibling module in the require cache with a single export removed, reloads
 * the engine, and expects the load itself to throw. The real modules must still load.
 *
 * Run:  node test/hook-engine-requires.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const path = require('node:path');
const assert = require('node:assert');
const { useTempHome, REPO_ROOT } = require('./helpers/temp-home');

useTempHome({ prefix: 'tf-hook-engine-requires-' }); // claimed before any src/ require

const CORE = path.join(REPO_ROOT, 'src', 'core');
const ENGINE = path.join(CORE, 'hook-engine.js');
const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

/** Load the engine with module `file` replaced by a copy that lacks `exportName`. */
function loadWithout(file, exportName) {
  const modPath = require.resolve(path.join(CORE, file));
  const real = require(modPath);
  const stub = Object.assign({}, real);
  delete stub[exportName];
  const saved = require.cache[modPath];
  delete require.cache[ENGINE];
  require.cache[modPath] = Object.assign(Object.create(Object.getPrototypeOf(saved)), saved, { exports: stub });
  try {
    const eng = require(ENGINE);
    // A load that did not throw: also try constructing, so a constructor-time throw is reported as such.
    try { new eng.HookEngine({ enabledHooksFor: () => [] }); } catch (e) { return { threw: 'at construction', message: e.message }; }
    return { threw: false };
  } catch (e) {
    return { threw: 'at load', message: e.message };
  } finally {
    require.cache[modPath] = saved;
    delete require.cache[ENGINE];
  }
}

for (const [file, name] of [['matcher.js', 'matches'], ['matcher.js', 'matcherError'], ['events.js', 'buildPayload'], ['hook-runner.js', 'runHook']]) {
  check(`without ${file.replace('.js', '')}.${name} the engine refuses to LOAD, naming it`, () => {
    const r = loadWithout(file, name);
    assert.strictEqual(r.threw, 'at load', r.threw ? `threw ${r.threw}: ${r.message}` : 'loaded silently (a fallback took over)');
    assert.ok(r.message.includes(name), 'the error does not name the missing export: ' + r.message);
  });
}

check('with the real modules the engine loads and constructs', () => {
  delete require.cache[ENGINE];
  const { HookEngine } = require(ENGINE);
  assert.strictEqual(typeof HookEngine, 'function');
});

const EXPECTED = 5;
for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
const passed = results.filter((r) => r.ok).length;
if (passed === results.length && results.length === EXPECTED) {
  console.log(`\nPASS: hook-engine-requires test - ${passed}/${EXPECTED} assertions passed (no silent fallbacks; a missing dependency refuses at load)`);
  process.exit(0);
}
console.log(`\nFAIL: hook-engine-requires test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
process.exit(1);
