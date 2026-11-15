'use strict';

/**
 * atomic-write.js - THE atomic file writer (temp in the same directory + fsync + rename).
 *
 * One implementation for every store the gateway persists: the tool register and its scripts,
 * the tool-state overlay, the expose store, the hooks manifest / state / scripts, toolfunnel.json
 * and the rename migration. Four copies of this pattern had drifted apart (one lacked the
 * failure-path unlink and the stale sweep; three wrote with a single writeSync where the loader's
 * looped) - the exact "hardening decision made in one place and never carried to its sibling"
 * fingerprint. orphan-tmp.test.js pins both the contract below and the fact that this is the
 * ONLY module under src/ that performs the rename.
 *
 * Contract:
 *   - A crash leaves either the old file or the complete new file, never a half-written one: the
 *     data goes to `.<base>.<pid>.<ts>.tmp` beside the target (same volume, so the rename is
 *     atomic), is fsync'd, then renamed over the target.
 *   - The temp NEVER outlives a failure: any throw (a refused rename - win32 scanners hold targets
 *     briefly - a full disk, a write error) unlinks it before rethrowing.
 *   - STALE strandings from writers that died mid-flight (same temp shape, older than
 *     STALE_TMP_MS) are swept on the next write of the same target; a FRESH sibling (a concurrent
 *     writer's in-flight temp) is left alone. Sweeping is best-effort and never fails a write.
 *   - writeFileSync(fd, ...) loops until every byte is written (a bare writeSync may return short).
 *   - Bytes are written exactly as given (no line-ending normalisation - shell scripts may be
 *     CRLF-sensitive).
 *
 * CommonJS, Node built-ins only.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * A sibling temp older than this is a STRANDING (a crashed/killed writer), not an in-flight
 * write - a live writer's temp exists for milliseconds. The generous age keeps a concurrent
 * writer safe.
 */
const STALE_TMP_MS = 60 * 60 * 1000;

/**
 * Remove STALE stranded temps for `base` in `dir` (the `.<base>.<pid>.<ts>.tmp` shape the
 * writer below produces). Scoped to the target's own temp shape - never another file's - and
 * entirely best-effort: sweeping must never fail a write.
 */
function sweepStaleTmp(dir, base) {
  let names;
  try { names = fs.readdirSync(dir); } catch (_e) { return; }
  const prefix = `.${base}.`;
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const p = path.join(dir, name);
    try {
      if (now - fs.statSync(p).mtimeMs > STALE_TMP_MS) fs.unlinkSync(p);
    } catch (_e) { /* a concurrent writer renamed/removed it - fine */ }
  }
}

/**
 * Atomically write text to `targetPath`. See the module contract.
 * @param {string} targetPath  absolute destination
 * @param {string|Buffer} data
 * @param {string} [tmpDir]    directory for the temp file (default: the target's own; must be the
 *                             same volume as the target for the rename to be atomic)
 */
function atomicWriteText(targetPath, data, tmpDir) {
  const dir = tmpDir || path.dirname(targetPath);
  const base = path.basename(targetPath);
  sweepStaleTmp(dir, base);
  const tmp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, data); // loops until every byte is written
      try { fs.fsyncSync(fd); } catch (_e) { /* fsync may be refused on some filesystems; the rename is still ordered */ }
    } finally {
      try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
    }
    // rename is atomic on the same filesystem and overwrites the destination on POSIX; on Windows
    // it overwrites too as long as the target isn't locked.
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_e) { /* best-effort - the error below is the story */ }
    throw err;
  }
}

/**
 * Atomically write a JS object as pretty JSON (2-space, trailing newline). See the module contract.
 * @param {string} targetPath absolute destination
 * @param {object} obj
 */
function atomicWriteJson(targetPath, obj) {
  atomicWriteText(targetPath, JSON.stringify(obj, null, 2) + '\n');
}

module.exports = { atomicWriteJson, atomicWriteText, sweepStaleTmp, STALE_TMP_MS };
