'use strict';

/**
 * logger.js - a toggleable JSONL activity/audit log for the gateway.
 *
 * DEFAULT OFF (privacy + lean). Nothing is written, and no files are created, unless
 * logging has been explicitly enabled via setConfig(). A MISSING config file means
 * disabled - the safe default - so a fresh checkout logs nothing.
 *
 * Design rules:
 *   - Zero dependencies. Node built-ins only (fs, path). No transport, no SDK.
 *   - Config is read FRESH on every call (no caching), so a toggle takes effect for the
 *     very next event without a reconnect or restart.
 *   - log() must NEVER throw. A logging failure (bad config, unwritable disk, full FS)
 *     must never break a tool call or the gate. Everything is wrapped; failures are
 *     swallowed silently.
 *
 * Paths are resolved against the config home, and the resolved path MUST stay inside
 * <home>/logs/ (0.7.0; logging.test.js step 5 is the acceptance). The log path is
 * settable from the tf_log tool surface and the UI's POST /api/logs/config, and every
 * other file-writing path in the repo is confined to its root (hook-loader's scripts-dir
 * assert, registry.writeScript, sendStatic) - this one now matches. setConfig REFUSES an
 * out-of-home path loudly; getConfig treats one already in the file as unset (default),
 * so log() and tail() stay in-home even against a hand-edited config. An operator who
 * wants the log on another disk can make <home>/logs a symlink/junction - containment is
 * checked on the unfollowed path.
 *
 * Config file: <root>/logs/log.config.json
 *   { "enabled": false, "path": "logs/toolfunnel.log.jsonl" }
 *
 * Both paths are BOUNDED (0.7.0, log-rotation.test.js): the live file rotates to `<path>.1`
 * at MAX_LOG_BYTES (one older generation kept), and tail(n) reads a trailing slice rather
 * than the whole file - with a whole-file fallback so bounding never changes an answer.
 *
 * CommonJS only.
 */

const fs = require('node:fs');
const path = require('node:path');

/** The CONFIG HOME (TOOLFUNNEL_HOME / --config-dir; defaults to the package root - see
 *  config-home.js). Logs + their toggle are user-state, so they live with the home. */
const { resolveConfigHome } = require('./config-home');
const ROOT = resolveConfigHome();

/** The toggle/config file. NOT created until setConfig() writes it. */
const CONFIG_PATH = path.join(ROOT, 'logs', 'log.config.json');

/** Safe defaults - used whenever the config file is absent or unreadable. */
const DEFAULT_ENABLED = false;
const DEFAULT_PATH = 'logs/toolfunnel.log.jsonl';

/**
 * The live file's size cap. An append that finds the file at/over it first renames the
 * file to `<path>.1` (ONE older generation, overwritten by the next rotation), so disk
 * use is bounded at ~2x the cap and the no-argument tail() (the documented all-lines
 * mode, tf_log status's count) can never be asked to parse an unbounded file again.
 * Rotation is best-effort: if the rename is refused (e.g. a reader holds `.1` open on
 * win32) the append proceeds on the oversized live file and rotation retries next call -
 * a record is never dropped for the sake of the cap.
 */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** tail(n)'s bounded read: bytes budgeted per requested line (generous - records run
 *  ~100-200 bytes), with a floor so tiny n still reads one decent chunk. */
const TAIL_BYTES_PER_LINE = 1024;
const TAIL_READ_MIN_BYTES = 64 * 1024;

/** The directory every log path must resolve inside. */
const LOG_DIR = path.join(ROOT, 'logs');

/**
 * Resolve a (possibly relative) log path against the config home, REQUIRING the result
 * to stay inside <home>/logs/. Returns the resolved absolute path, or null when it
 * resolves outside (same refusal shape as registry.js defaultRunScript: '' would be the
 * dir itself, '..'-prefixed left it, absolute rel = another drive on win32).
 * @param {string} p
 * @returns {string|null}
 */
function resolveLogPath(p) {
  const resolved = path.resolve(ROOT, String(p));
  const rel = path.relative(LOG_DIR, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

/**
 * getConfig - the resolved { enabled, path }.
 *
 * Reads the config file fresh. A missing/unreadable/malformed file resolves to the
 * safe defaults (disabled). Never throws.
 *
 * @returns {{ enabled: boolean, path: string }}
 */
function getConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { enabled: DEFAULT_ENABLED, path: DEFAULT_PATH };
    }
    return {
      enabled: parsed.enabled === true,
      // A path that resolves outside <home>/logs/ is treated as UNSET, not honoured: the
      // config file can be edited directly, and the readers (log/tail) must stay in-home
      // regardless of how the value got there. setConfig additionally refuses one loudly.
      path:
        typeof parsed.path === 'string' && parsed.path.length > 0 && resolveLogPath(parsed.path) !== null
          ? parsed.path
          : DEFAULT_PATH,
    };
  } catch (_err) {
    // Missing file = disabled (the safe default); also covers unreadable/malformed.
    return { enabled: DEFAULT_ENABLED, path: DEFAULT_PATH };
  }
}

/**
 * log - append one JSONL record IF logging is enabled, else a silent no-op.
 *
 * The record is the event fields plus a logger-stamped ISO-8601 "ts" timestamp.
 * Resolves the configured path against root, mkdir -p its directory, and appends one
 * line with fs.appendFileSync. NEVER throws - any failure is swallowed.
 *
 * @param {object} event arbitrary serialisable fields (e.g. { type, tool, decision }).
 */
function log(event) {
  try {
    const cfg = getConfig();
    if (!cfg.enabled) return; // default-off: no-op, no file created.

    const record = Object.assign(
      { ts: new Date().toISOString() },
      event && typeof event === 'object' && !Array.isArray(event) ? event : {}
    );

    const logPath = resolveLogPath(cfg.path);
    if (logPath === null) return; // cannot happen via getConfig (it sanitises); belt-and-braces
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    // Rotate BEFORE the append when the live file has reached the cap. Its own try/catch:
    // a refused stat/rename must never cost the record below. `logPath + '.1'` inherits
    // logPath's containment, and rename replaces an existing `.1` (one older generation).
    try {
      if (fs.statSync(logPath).size >= MAX_LOG_BYTES) {
        fs.renameSync(logPath, logPath + '.1');
      }
    } catch (_e) {
      // Missing file (nothing to rotate) or a refused rename - append regardless.
    }

    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
  } catch (_err) {
    // Logging must NEVER break the caller. Swallow everything.
  }
}

/**
 * setConfig - atomically merge a patch into logs/log.config.json (temp + rename).
 *
 * Merges with the current resolved config so a partial patch (e.g. { enabled: true })
 * preserves the existing path. Creates the logs/ dir and the config file if absent -
 * this is the ONLY function that creates the config file.
 *
 * @param {{ enabled?: boolean, path?: string }} patch
 * @returns {{ enabled: boolean, path: string }} the merged, written config.
 */
function setConfig(patch) {
  const current = getConfig();
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};

  // Refuse an out-of-home path LOUDLY before anything is written. Reaches every setter
  // surface (tf_log's { ok:false }, the UI's error response) with nothing persisted.
  // `current.path` needs no re-check - getConfig only ever returns a contained path.
  // The code lets callers tell "you sent a bad path" (client input -> the UI's 400) apart
  // from a genuine write failure (disk, perms -> 500) without matching on message prose.
  if (typeof p.path === 'string' && p.path.length > 0 && resolveLogPath(p.path) === null) {
    const err = new Error(
      `log path refused: "${p.path}" resolves outside the config home's logs directory - ` +
      'the activity log lives inside <home>/logs'
    );
    err.code = 'TF_LOG_PATH_REFUSED';
    throw err;
  }

  const next = {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : current.enabled,
    path:
      typeof p.path === 'string' && p.path.length > 0 ? p.path : current.path,
  };

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  // Atomic write: write a unique temp file, then rename over the target.
  const tmp = CONFIG_PATH + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);

  return next;
}

/**
 * Read the trailing slice of a file that is expected to contain the last `wanted` lines:
 * the final min(size, max(64 KB, wanted KB)) bytes. When the read starts mid-file the
 * first segment may be a PARTIAL line, so it is dropped (mid-character utf8 starts land
 * in that dropped segment too). Returns the complete lines it can vouch for, plus whether
 * the whole file was covered - the caller falls back to a whole-file read on a shortfall
 * (e.g. one line longer than the window), so the bounded path can never change an answer,
 * only the bytes it took to produce it.
 * @param {string} logPath
 * @param {number} wanted
 * @returns {{ lines: string[], wholeFile: boolean }}
 */
function readTrailingLines(logPath, wanted) {
  const fd = fs.openSync(logPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const budget = Math.max(TAIL_READ_MIN_BYTES, wanted * TAIL_BYTES_PER_LINE);
    const readLen = Math.min(size, budget);
    const position = size - readLen;
    const buf = Buffer.alloc(readLen);
    let got = 0;
    while (got < readLen) {
      const r = fs.readSync(fd, buf, got, readLen - got, position + got);
      if (r <= 0) break; // shrank underneath us (rotation) - use what we have
      got += r;
    }
    let text = buf.toString('utf8', 0, got);
    if (position > 0) {
      const firstNl = text.indexOf('\n');
      text = firstNl === -1 ? '' : text.slice(firstNl + 1);
    }
    const lines = text.split('\n').filter(function (l) { return l.length > 0; });
    return { lines, wholeFile: position === 0 };
  } finally {
    try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
  }
}

/**
 * tail - return the last n parsed JSON lines from the configured log.
 *
 * Returns [] if the log is missing or unreadable. Unparseable lines are skipped. When
 * n is not a positive finite number, all lines are returned. Never throws.
 *
 * A finite n reads a BOUNDED trailing slice (~1 KB budgeted per requested line), not the
 * whole file - with a whole-file fallback when the slice holds fewer than n lines, so the
 * answer is byte-identical to the unbounded engine's in every case. The no-argument mode
 * still reads everything by design; rotation (MAX_LOG_BYTES) bounds that file for it.
 *
 * @param {number} [n] how many trailing lines to parse and return.
 * @returns {object[]}
 */
function tail(n) {
  try {
    const cfg = getConfig();
    const logPath = resolveLogPath(cfg.path);
    if (logPath === null) return []; // cannot happen via getConfig (it sanitises); belt-and-braces

    const bounded = typeof n === 'number' && isFinite(n) && n > 0;
    let lines;
    let wanted;
    if (bounded) {
      wanted = Math.floor(n);
      const sliceRead = readTrailingLines(logPath, wanted);
      if (sliceRead.lines.length >= wanted || sliceRead.wholeFile) {
        lines = sliceRead.lines;
      } else {
        // Shortfall on a partial window (unusually long lines): take the exact answer
        // over the byte bound.
        lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(function (l) {
          return l.length > 0;
        });
      }
    } else {
      lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(function (l) {
        return l.length > 0;
      });
      wanted = lines.length;
    }

    const slice = lines.slice(-wanted);

    const out = [];
    for (let i = 0; i < slice.length; i++) {
      try {
        out.push(JSON.parse(slice[i]));
      } catch (_e) {
        // Skip a corrupt/partial line rather than failing the whole tail.
      }
    }
    return out;
  } catch (_err) {
    return [];
  }
}

module.exports = { log, setConfig, getConfig, tail };
