'use strict';

/**
 * log-rotation.test.js - the activity log is BOUNDED, on both paths, with semantics intact:
 *
 *   A - ROTATION (write path): an append that finds the live file at/over the size cap
 *       first renames it to `<path>.1` (one older generation, overwritten next time), so
 *       the live file never grows without limit - and a small file is NEVER rotated.
 *   B - BOUNDED TAIL (read path): tail(n) with a finite n reads a bounded slice from the
 *       end of the file, not the whole file (byte-counted via scoped fs spies) - and its
 *       ANSWERS are exactly the whole-file engine's: the precise last-n records, corrupt
 *       lines skipped, huge n = all lines, a line longer than the read window still
 *       resolved exactly (the shortfall fallback), missing file = [].
 *   C - NEVER THROWS: a rotation failure (rename refused mid-append) is swallowed and the
 *       append still lands - logging must never break the caller, cap or no cap.
 *
 * Runs in-process against src/core/logger.js under a TEMP TOOLFUNNEL_HOME (env set before
 * the module loads), so the checkout's own logs/ and config are never touched.
 *
 * Run:  node test/log-rotation.test.js     (exit 0 = pass, non-zero = fail)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

// The home must be pinned BEFORE logger.js loads (it resolves its root at require time).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-log-rotation-'));
process.env.TOOLFUNNEL_HOME = HOME;

const REPO_ROOT = path.resolve(__dirname, '..');
const logger = require(path.join(REPO_ROOT, 'src', 'core', 'logger.js'));

const LIVE = path.join(HOME, 'logs', 'toolfunnel.log.jsonl');
const ROTATED = LIVE + '.1';
const CAP_BYTES = 5 * 1024 * 1024; // mirrors logger.js MAX_LOG_BYTES

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

/** A valid JSONL body of `count` numbered records, each padded to ~`bytes` bytes. */
function seedLines(count, bytes) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const base = { seq: i, pad: '' };
    const pad = Math.max(0, bytes - JSON.stringify(base).length - 12);
    out.push(JSON.stringify({ seq: i, pad: 'x'.repeat(pad) }));
  }
  return out;
}
function writeSeed(lines) {
  fs.mkdirSync(path.dirname(LIVE), { recursive: true });
  fs.writeFileSync(LIVE, lines.join('\n') + '\n');
}
function reset() {
  try { fs.rmSync(LIVE, { force: true }); } catch (_e) { /* ignore */ }
  try { fs.rmSync(ROTATED, { force: true }); } catch (_e) { /* ignore */ }
}

/**
 * Count every byte fs hands back FROM the live log during fn(): readFileSync results for
 * its path plus readSync bytes on fds opened for it. Scoped - originals restored in finally.
 */
function countBytesRead(fn) {
  const realReadFile = fs.readFileSync;
  const realOpen = fs.openSync;
  const realRead = fs.readSync;
  let bytes = 0;
  const logFds = new Set();
  fs.readFileSync = function (p, ...rest) {
    const out = realReadFile.call(fs, p, ...rest);
    if (path.resolve(String(p)) === LIVE) bytes += Buffer.byteLength(out);
    return out;
  };
  fs.openSync = function (p, ...rest) {
    const fd = realOpen.call(fs, p, ...rest);
    if (path.resolve(String(p)) === LIVE) logFds.add(fd);
    return fd;
  };
  fs.readSync = function (fd, ...rest) {
    const n = realRead.call(fs, fd, ...rest);
    if (logFds.has(fd)) bytes += n;
    return n;
  };
  try { fn(); } finally {
    fs.readFileSync = realReadFile;
    fs.openSync = realOpen;
    fs.readSync = realRead;
  }
  return bytes;
}

logger.setConfig({ enabled: true }); // inside the temp home only

// ── A: rotation on the write path ──────────────────────────────────────────────────────
check('A1: an append finding the live file over the cap rotates it to .1 first', () => {
  reset();
  const seeded = seedLines(Math.ceil(CAP_BYTES / 90) + 500, 110); // safely past the cap (~98 B/line real)
  writeSeed(seeded);
  const seededSize = fs.statSync(LIVE).size;
  assert.ok(seededSize >= CAP_BYTES, `seed must reach the cap (got ${seededSize})`);

  logger.log({ probe: 'after-rotate' });

  assert.ok(fs.existsSync(ROTATED), 'expected the over-cap live file to be renamed to .1');
  assert.strictEqual(fs.statSync(ROTATED).size, seededSize, 'the .1 generation must be the old file, byte for byte');
  const live = fs.readFileSync(LIVE, 'utf8');
  assert.ok(fs.statSync(LIVE).size < 4096, `expected a fresh live file, got ${fs.statSync(LIVE).size} bytes`);
  assert.ok(live.includes('"probe":"after-rotate"'), 'the triggering record must land in the fresh live file');
});

check('A2: a small live file is never rotated - records accumulate as before', () => {
  reset();
  logger.log({ probe: 'first' });
  logger.log({ probe: 'second' });
  assert.ok(!fs.existsSync(ROTATED), 'no .1 generation for a small file');
  const t = logger.tail(10);
  assert.strictEqual(t.length, 2, 'both records present, got ' + JSON.stringify(t));
  assert.strictEqual(t[0].probe, 'first');
  assert.strictEqual(t[1].probe, 'second');
});

// ── B: bounded tail on the read path ───────────────────────────────────────────────────
check('B1: tail(50) on a ~6 MB log reads a bounded slice, and the answer is exact', () => {
  reset();
  const seeded = seedLines(60000, 110); // ~6.3 MB of numbered records
  writeSeed(seeded);
  let out;
  const bytes = countBytesRead(() => { out = logger.tail(50); });
  assert.strictEqual(out.length, 50, 'must return exactly 50 records');
  assert.strictEqual(out[0].seq, 59950, 'first of the last 50');
  assert.strictEqual(out[49].seq, 59999, 'the final record');
  assert.ok(bytes < 1024 * 1024, `expected a bounded read (<1 MB) for tail(50) of a ~6 MB file, read ${bytes} bytes`);
});

check('B2: tail() with no bound still returns every line (the documented all-lines mode)', () => {
  reset();
  writeSeed(seedLines(500, 110));
  assert.strictEqual(logger.tail().length, 500);
  assert.strictEqual(logger.tail(1e9).length, 500, 'a huge finite n also means all lines');
});

check('B3: a line longer than the read window is still resolved exactly (fallback)', () => {
  reset();
  const lines = seedLines(1000, 110);
  lines.push(JSON.stringify({ seq: 'big', pad: 'y'.repeat(200 * 1024) })); // ~200 KB line
  lines.push(JSON.stringify({ seq: 'last' }));
  writeSeed(lines);
  const t = logger.tail(2);
  assert.strictEqual(t.length, 2, 'exactly 2 records, got ' + t.length);
  assert.strictEqual(t[0].seq, 'big', 'the oversized record is intact');
  assert.strictEqual(t[0].pad.length, 200 * 1024, 'oversized payload byte-complete');
  assert.strictEqual(t[1].seq, 'last');
});

check('B4: corrupt lines are skipped and a missing file answers []', () => {
  reset();
  const lines = seedLines(20, 110);
  lines.splice(17, 0, '{not json');
  writeSeed(lines);
  const t = logger.tail(5);
  assert.strictEqual(t.length, 4, 'the corrupt line inside the window is dropped, got ' + t.length);
  assert.strictEqual(t[t.length - 1].seq, 19);
  reset();
  assert.deepStrictEqual(logger.tail(5), [], 'missing file = []');
});

// ── C: logging never breaks the caller ─────────────────────────────────────────────────
check('C1: a refused rotation rename is swallowed and the append still lands', () => {
  reset();
  writeSeed(seedLines(Math.ceil(CAP_BYTES / 90) + 500, 110));
  const realRename = fs.renameSync;
  fs.renameSync = function () { throw new Error('simulated rename refusal'); };
  try {
    logger.log({ probe: 'append-wins' });
  } finally {
    fs.renameSync = realRename;
  }
  assert.ok(!fs.existsSync(ROTATED), 'rotation was refused, no .1');
  const raw = fs.readFileSync(LIVE, 'utf8');
  assert.ok(raw.includes('"probe":"append-wins"'), 'the record must land even when rotation fails');
});

// ── Report ─────────────────────────────────────────────────────────────────────────────
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_e) { /* ignore */ }

for (const r of results) {
  console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
}
const passed = results.filter((r) => r.ok).length;
const expected = 7;
if (passed === results.length && results.length === expected) {
  console.log(`\nPASS: log-rotation test - ${passed}/${expected} assertions passed (write path rotates at the cap; tail(n) reads bounded with exact answers; failures swallowed)`);
  process.exit(0);
} else {
  console.log(`\nFAIL: log-rotation test - ${passed}/${results.length} assertions passed`);
  process.exit(1);
}
