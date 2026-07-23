'use strict';

/**
 * server-config.js - OPTIONAL gateway-level configuration: identity + default ports.
 *
 * Reads `toolfunnel.json` at the gateway root (absent by default). This is what lets a
 * third party ship an MCP built on toolfunnel that introduces itself as ITSELF: the
 * `initialize` handshake and `/health` report THEIR serverName/serverVersion, and their
 * pack can carry its own default ports so `npx their-mcp` never collides with another
 * gateway on the user's machine. CLI flags still win: precedence is flag > config > default.
 *
 * Shape (every field optional - an empty/absent file IS the default identity):
 *   {
 *     "serverName":    "my-mcp",     // initialize serverInfo.name          (default "toolfunnel")
 *     "serverVersion": "1.0.0",      // initialize serverInfo.version       (default: package.json)
 *     "clientName":    "my-client",  // identity presented TO upstreams     (default "toolfunnel")
 *     "clientVersion": "1.0.0",      //   ...its version                      (default built-in)
 *     "httpPort":      9998,         // --http default port                 (default 9998)
 *     "uiPort":        9777          // --ui   default port                 (default 9777)
 *   }
 *
 * clientName/clientVersion are the OUTBOUND identity - what upstream MCP servers see in the
 * gateway's own initialize handshake. Under a WRAP on stdio the downstream client's REAL
 * clientInfo is mirrored upstream instead (two-way invisibility for legacy/stdio clients -
 * modern clients send no initialize); these settings are the funnel-mode / HTTP identity and
 * the pre-handshake boot identity.
 *
 * TOLERANT by design, field by field: a missing file, bad JSON, or an invalid FIELD falls
 * back to that field's default - a broken identity file must never stop the gateway from
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
    /* unreadable package.json -> a placeholder beats a crash */
  }
  // clientName/clientVersion default null = "use the built-in client identity" (McpClient's
  // CLIENT_INFO) - so absent config produces byte-identical wire behaviour to before.
  // serveLegacy default TRUE: every existing client today speaks the legacy era - refusing it is
  // an explicit hardening opt-in ("modern-only"), never a default.
  return { serverName: 'toolfunnel', serverVersion: version, clientName: null, clientVersion: null, httpPort: 9998, uiPort: 9777, serveLegacy: true };
}

/** A valid TCP port for a bind default: an integer 1..65535 (0 = OS-assigned stays flag-only -
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
    return out; // absent - the normal case
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (_e) {
    return out; // bad JSON - start as the default identity rather than not at all
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return out;
  if (typeof cfg.serverName === 'string' && cfg.serverName.trim().length > 0) {
    out.serverName = cfg.serverName.trim();
  }
  if (typeof cfg.serverVersion === 'string' && cfg.serverVersion.trim().length > 0) {
    out.serverVersion = cfg.serverVersion.trim();
  }
  if (typeof cfg.clientName === 'string' && cfg.clientName.trim().length > 0) {
    out.clientName = cfg.clientName.trim();
  }
  if (typeof cfg.clientVersion === 'string' && cfg.clientVersion.trim().length > 0) {
    out.clientVersion = cfg.clientVersion.trim();
  }
  if (isPort(cfg.httpPort)) out.httpPort = cfg.httpPort;
  if (isPort(cfg.uiPort)) out.uiPort = cfg.uiPort;
  // Only an EXPLICIT false flips modern-only on; any other value (absent, truthy, garbage)
  // keeps the serve-both default - misconfiguration must never lock real clients out.
  if (cfg.serveLegacy === false) out.serveLegacy = false;
  return out;
}

module.exports = { loadServerConfig };
