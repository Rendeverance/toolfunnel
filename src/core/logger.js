'use strict';

/**
 * logger.js — a toggleable JSONL activity/audit log for the gateway.
 *
 * DEFAULT OFF (privacy + lean). Nothing is written, and no files are created, unless
 * logging has been explicitly enabled via setConfig(). A MISSING config file means
 * disabled — the safe default — so a fresh checkout logs nothing.
 *
 * Design rules:
 *   - Zero dependencies. Node built-ins only (fs, path). No transport, no SDK.
 *   - Config is read FRESH on every call (no caching), so a toggle takes effect for the
 *     very next event without a reconnect or restart.
 *   - log() must NEVER throw. A logging failure (bad config, unwritable disk, full FS)
 *     must never break a tool call or the gate. Everything is wrapped; failures are
 *     swallowed silently.
 *
 * Paths are resolved against the repo root (two dirs up from src/core/). The configured
 * log `path` may be relative (resolved against root) or absolute.
 *
 * Config file: <root>/logs/log.config.json
 *   { "enabled": false, "path": "logs/toolfunnel.log.jsonl" }
 *
 * CommonJS only.
 */

const fs = require('node:fs');
const path = require('node:path');

/** The CONFIG HOME (TOOLFUNNEL_HOME / --config-dir; defaults to the package root — see
 *  config-home.js). Logs + their toggle are user-state, so they live with the home. */
const { resolveConfigHome } = require('./config-home');
const ROOT = resolveConfigHome();

/** The toggle/config file. NOT created until setConfig() writes it. */
const CONFIG_PATH = path.join(ROOT, 'logs', 'log.config.json');

/** Safe defaults — used whenever the config file is absent or unreadable. */
const DEFAULT_ENABLED = false;
const DEFAULT_PATH = 'logs/toolfunnel.log.jsonl';

/**
 * Resolve a (possibly relative) log path against the repo root.
 * @param {string} p
 * @returns {string}
 */
function resolveLogPath(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

/**
 * getConfig — the resolved { enabled, path }.
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
      path:
        typeof parsed.path === 'string' && parsed.path.length > 0
          ? parsed.path
          : DEFAULT_PATH,
    };
  } catch (_err) {
    // Missing file = disabled (the safe default); also covers unreadable/malformed.
    return { enabled: DEFAULT_ENABLED, path: DEFAULT_PATH };
  }
}

/**
 * log — append one JSONL record IF logging is enabled, else a silent no-op.
 *
 * The record is the event fields plus a logger-stamped ISO-8601 "ts" timestamp.
 * Resolves the configured path against root, mkdir -p its directory, and appends one
 * line with fs.appendFileSync. NEVER throws — any failure is swallowed.
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
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
  } catch (_err) {
    // Logging must NEVER break the caller. Swallow everything.
  }
}

/**
 * setConfig — atomically merge a patch into logs/log.config.json (temp + rename).
 *
 * Merges with the current resolved config so a partial patch (e.g. { enabled: true })
 * preserves the existing path. Creates the logs/ dir and the config file if absent —
 * this is the ONLY function that creates the config file.
 *
 * @param {{ enabled?: boolean, path?: string }} patch
 * @returns {{ enabled: boolean, path: string }} the merged, written config.
 */
function setConfig(patch) {
  const current = getConfig();
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};

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
 * tail — return the last n parsed JSON lines from the configured log.
 *
 * Returns [] if the log is missing or unreadable. Unparseable lines are skipped. When
 * n is not a positive finite number, all lines are returned. Never throws.
 *
 * @param {number} [n] how many trailing lines to parse and return.
 * @returns {object[]}
 */
function tail(n) {
  try {
    const cfg = getConfig();
    const logPath = resolveLogPath(cfg.path);
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.split('\n').filter(function (l) {
      return l.length > 0;
    });

    const wanted =
      typeof n === 'number' && isFinite(n) && n > 0 ? Math.floor(n) : lines.length;
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
