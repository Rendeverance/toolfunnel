'use strict';

/**
 * hook-loader-state.test.js - setEnabled must not leave residue for ids it reports as misses.
 *
 * The first correction to setEnabled fixed only its RETURN VALUE (`!!liveSpec || true` was
 * constant-true). The overlay write above it stayed unconditional, so `setEnabled('typo', false)`
 * answered `false` and STILL wrote `{"typo": false}` into hooks.state.json - permanently. The
 * stray key is not inert: applyState() lays the overlay over the manifest at every load, so if a
 * hook with that id later appears (autodetect() picking up a script drop), it boots silently in
 * the stale recorded state. A pre-disabled gate is a security outcome, not a cosmetic one.
 *
 * Invariants:
 *   A  setEnabled on a known hook id returns true, applies, and persists its overlay key.
 *   B  setEnabled on an UNKNOWN id returns false and writes NO overlay key.
 *   C  a state file free of strays stays free across a miss (byte-identical round trip).
 *
 * Node built-ins only. CommonJS. Exit 0 = clean; 1 = residue.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { HookLoader } = require('../src/core/hook-loader');

let fails = 0;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-loaderstate-'));
fs.mkdirSync(path.join(hooksDir, 'scripts'), { recursive: true });
const manifestPath = path.join(hooksDir, 'hooks.manifest.json');
const manifest = {
  version: 1,
  hooks: [{
    id: 'real-hook',
    event: 'PreToolUse',
    matcher: '*',
    command: 'node "' + path.join(hooksDir, 'scripts', 'real.js') + '"',
    enabled: true,
  }],
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const readStateRaw = () => {
  try { return fs.readFileSync(path.join(hooksDir, 'hooks.state.json'), 'utf8'); } catch (_e) { return null; }
};
const readState = () => {
  const raw = readStateRaw();
  return raw == null ? {} : JSON.parse(raw);
};

try {
  const loader = new HookLoader(manifestPath, JSON.parse(JSON.stringify(manifest)), hooksDir);

  // A - the known id round trip.
  const hit = loader.setEnabled('real-hook', false);
  check('A: setEnabled on a known id returns true', hit === true, JSON.stringify(hit));
  check('A: the overlay records the known id', readState()['real-hook'] === false,
    JSON.stringify(readState()));

  // B - the miss must leave nothing behind.
  const before = readStateRaw();
  const miss = loader.setEnabled('typo-id', false);
  check('B: setEnabled on an unknown id returns false', miss === false, JSON.stringify(miss));
  check('B: the miss writes NO overlay key', !('typo-id' in readState()),
    readStateRaw() + ' (the stray key pre-disables any future hook that adopts this id)');

  // C - byte-identical state across the miss (no rewrite at all is also acceptable).
  check('C: the state file is unchanged by a miss', readStateRaw() === before,
    JSON.stringify({ before, after: readStateRaw() }));
} catch (err) {
  console.log('CRASHED: ' + ((err && err.stack) || err));
  fails += 1;
} finally {
  try { fs.rmSync(hooksDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
}

console.log(fails ? `\n${fails} hook-loader-state failure(s).` : '\nsetEnabled leaves no residue on a miss.');
process.exit(fails ? 1 : 0);
