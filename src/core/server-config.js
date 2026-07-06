'use strict';

/**
 * server-config.js — OPTIONAL gateway-level configuration: identity + default ports.
 *
 * Reads `toolfunnel.json` at the gateway root (absent by default). This is what lets a
 * third party ship an MCP built on toolfunnel that introduces itself as ITSELF: the
 * `initialize` handshake and `/health` report THEIR serverName/serverVersion, and their
 * pack can carry its own default ports so `npx their-mcp` never collides with another
 * gateway on the user's machine. CLI flags still win: precedence is flag > config > default.
 *
 * Shape (every field optional — an empty/absent file IS the default identity):
 *   {
 *     "serverName":    "my-mcp",     // initialize serverInfo.name          (default "toolfunnel")
 *     "serverVersion": "1.0.0",      // initialize serverInfo.version       (default: package.json)
 *     "httpPort":      9998,         // --http default port                 (default 9998)
 *     "uiPort":        9777          // --ui   default port                 (default 9777)
 *   }
 *
 * TOLERANT by design, field by field: a missing file, bad JSON, or an invalid FIELD falls
 * back to that field's default — a broken identity file must never stop the gateway from
 * starting as plain "toolfunnel" (the same fail-open-to-default posture as log.config.json;
 * contrast auth config, which fails CLOSED because it guards a boundary). No new deps.
 */

const fs = require('node:fs');
const path = require('node:path');

/** The compiled-in defaults. version comes from package.json (single source of truth). */
function defaults() {
  let version = '0.0.0';
  try {
    version = require('../../package.json').version || version;
  } catch (_e) {
    /* unreadable package.json → a placeholder beats a crash */
  }
  return { serverName: 'toolfunnel', serverVersion: version, httpPort: 9998, uiPort: 9777 };
}

/** A valid TCP port for a bind default: an integer 1..65535 (0 = OS-assigned stays flag-only —
 *  an ephemeral DEFAULT would make the gateway un-findable across restarts). */
function isPort(v) {
  return Number.isInteger(v) && v >= 1 && v <= 65535;
}

/**
 * Load the gateway config, merged over the defaults.
 * @param {string} rootDir  the gateway root (the directory that holds toolfunnel.json)
 * @returns {{serverName:string, serverVersion:string, httpPort:number, uiPort:number}}
 */
function loadServerConfig(rootDir) {
  const out = defaults();
  let raw;
  try {
    raw = fs.readFileSync(path.join(rootDir, 'toolfunnel.json'), 'utf8');
  } catch (_e) {
    return out; // absent — the normal case
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (_e) {
    return out; // bad JSON — start as the default identity rather than not at all
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return out;
  if (typeof cfg.serverName === 'string' && cfg.serverName.trim().length > 0) {
    out.serverName = cfg.serverName.trim();
  }
  if (typeof cfg.serverVersion === 'string' && cfg.serverVersion.trim().length > 0) {
    out.serverVersion = cfg.serverVersion.trim();
  }
  if (isPort(cfg.httpPort)) out.httpPort = cfg.httpPort;
  if (isPort(cfg.uiPort)) out.uiPort = cfg.uiPort;
  return out;
}

module.exports = { loadServerConfig };
