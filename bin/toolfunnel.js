#!/usr/bin/env node
'use strict';

/**
 * toolfunnel - CLI entry point.
 *
 *   toolfunnel                      Start the stdio MCP server (default)
 *   toolfunnel --http               Start the HTTP/SSE MCP host on 127.0.0.1:9998
 *   toolfunnel --http --port <n>    Bind a specific port (0 = OS-assigned)
 *   toolfunnel --http --host <h>    Bind a specific loopback host
 *   toolfunnel --ui                 Start the OPTIONAL config web UI on 127.0.0.1:9777
 *   toolfunnel --ui --port <n>      Bind a specific UI port (0 = OS-assigned)
 *   toolfunnel install-oauth        Install the OPTIONAL OAuth 2.1 dependency (jose) on demand
 *   toolfunnel --help               Show this help
 *
 * Zero runtime dependencies. The stdio path runs the server's main(); the HTTP
 * path constructs the HTTP/SSE host, which builds the same protocol internally.
 * OAuth is opt-in: it adds exactly one audited, itself-zero-dependency library
 * (jose), installed only when you run `install-oauth` or click Install in the UI.
 */

const args = process.argv.slice(2);

function flagValue(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : fallback;
}

// POSITIONAL arguments - the subcommand and its target - recognised regardless of where global
// flags sit. `toolfunnel --config-dir X wrap Y` used to silently start a normal server: args[0]
// was the flag, the wrap branch never matched, and the user got a running gateway instead of a
// wrap with zero feedback (cold-start field test, 2026-07-18). Value-taking flags are skipped
// WITH their value; any other -/-- token is skipped alone.
const VALUE_FLAGS = new Set(['--config-dir', '--port', '--host', '--as']);
const positionals = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUE_FLAGS.has(a)) { i++; continue; }
  if (typeof a === 'string' && a.length && a[0] === '-') continue;
  positionals.push(a);
}

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    [
      'toolfunnel - a zero-dependency MCP gateway',
      '',
      'Usage:',
      '  toolfunnel                    Start the stdio MCP server (default)',
      '  toolfunnel --http             Start the HTTP/SSE MCP host (127.0.0.1:9998)',
      '  toolfunnel --http --port <n>  Bind a specific port (0 = OS-assigned)',
      '  toolfunnel --http --host <h>  Bind a specific loopback host',
      '  toolfunnel --ui               Start the config web UI (127.0.0.1:9777)',
      '  toolfunnel --ui --port <n>    Bind a specific UI port (0 = OS-assigned)',
      '  toolfunnel wrap <upstreamId>  Wrap ONE attached upstream MCP: its tools become the whole',
      '                                surface (meta-tools hidden), every call still gated. The',
      '                                gateway answers both MCP eras, so a legacy-only MCP keeps',
      '                                working with modern clients. `wrap --off` restores normal.',
      '  toolfunnel install-oauth      Install the optional OAuth 2.1 dependency (jose)',
      '  toolfunnel --config-dir <dir> Use <dir> as the CONFIG HOME (see below)',
      '  toolfunnel --help             Show this help',
      '',
      'CONFIG HOME: the mutable config (tools/ mcp/ hooks/ auth/ logs/ toolfunnel.json) lives in',
      'the config home - by default the package root (a git clone works as before), or the value',
      'of --config-dir / the TOOLFUNNEL_HOME env var. An empty home is seeded from the shipped',
      'defaults on first use and is NEVER overwritten after - so an npm update cannot eat your',
      'tools. This is also how a wrapped MCP ships its own bundled setup.',
      '',
      'Identity + port defaults can be set in an OPTIONAL toolfunnel.json in the config home:',
      '  { "serverName": "my-mcp", "serverVersion": "1.0.0", "httpPort": 9998, "uiPort": 9777 }',
      'A --port flag always wins over the config value.',
      '',
    ].join('\n')
  );
  process.exit(0);
}

// Resolve + seed the config home FIRST - before any src/ module is required - so every
// module-load-time anchor (register/expose/hooks paths, auth + log config, identity) reads the
// same resolved home. Precedence: --config-dir > TOOLFUNNEL_HOME env > the package root.
const { initConfigHome } = require('../src/core/config-home');
const configHome = initConfigHome({ dir: flagValue('--config-dir', '') }).home;

// One honest stderr line so nobody discovers the config home by accident - before this, a bare
// `git status` after running from a clone was the discovery mechanism. Defaulted homes get
// the relocation hint.
process.stderr.write('[toolfunnel] config home: ' + configHome +
  ((flagValue('--config-dir', '') || process.env.TOOLFUNNEL_HOME)
    ? '\n'
    : ' (default: the package root - use --config-dir <dir> or TOOLFUNNEL_HOME to relocate)\n'));

// Advisory runtime preflight: the home's toolfunnel.json may declare `requires` (python, git, ...)
// for the tools it ships. A missing/old runtime breaks only the tools that need it, so each
// problem is one loud stderr line and the gateway starts anyway. Never fatal, never throws.
try {
  const { checkRequires } = require('../src/core/requires');
  for (const p of checkRequires(configHome)) {
    process.stderr.write('[toolfunnel] REQUIRES: ' + p.problem + '\n');
  }
} catch (_e) { /* preflight must never stop the gateway */ }

if (positionals[0] === 'wrap') {
  // PASSTHROUGH: one command turns the gateway into a transparent wrapper for ONE attached
  // upstream MCP - its tools are the whole advertised surface, the meta-tools are hidden and
  // uncallable, and every call still fires the PreToolUse gate. Because the gateway speaks both
  // MCP eras, this is how a legacy-only (or unmaintained) MCP keeps working with modern clients.
  const path = require('node:path');
  const { resolveConfigHome } = require('../src/core/config-home');
  const { loadExposeStore } = require('../src/mcp/expose-store');
  const { loadToolState, getPassthrough, setPassthrough } = require('../src/tools/tool-state');
  const home = resolveConfigHome();
  const statePath = path.join(home, 'tools', 'tools.state.json');
  const target = positionals[1]; // flag-position-independent, same as the subcommand itself
  const wantsOff = args.includes('--off');

  (async () => {
    if (wantsOff) {
      const before = getPassthrough(loadToolState(statePath));
      setPassthrough(statePath, null);
      process.stderr.write('[toolfunnel] wrap cleared' + (before ? ' (was "' + before + '")' : '') +
        ' - the normal funnel surface (meta-tools + matrix) is back. A running host picks this up live.\n');
      process.exit(0);
    }

    const store = loadExposeStore(path.join(home, 'mcp', 'expose.json'));
    const upstreams = store.listUpstreams();

    if (!target) {
      // Pure status query - always exit 0 (an empty setup is a state, not a failure).
      const current = getPassthrough(loadToolState(statePath));
      process.stderr.write('[toolfunnel] wrap: ' + (current ? 'wrapping "' + current + '"' : 'not active') + '\n');
      process.stderr.write('Usage: toolfunnel wrap <upstreamId> [--as <serverName>] | toolfunnel wrap --off\n');
      process.stderr.write(upstreams.length
        ? 'Attached upstreams: ' + upstreams.map((u) => u.id + (u.enabled === false ? ' (disabled)' : '')).join(', ') + '\n'
        : 'No upstreams attached yet - attach one first (toolfunnel_howto add-mcp, tf_mcp_add, or the UI).\n');
      process.exit(0);
    }

    const upstream = store.getUpstream(target);
    if (!upstream) {
      process.stderr.write('[toolfunnel] wrap: no upstream with id "' + target + '".\n');
      process.stderr.write(upstreams.length
        ? 'Attached upstreams: ' + upstreams.map((u) => u.id).join(', ') + '\n'
        : 'No upstreams attached yet - attach one first (toolfunnel_howto add-mcp, tf_mcp_add, or the UI).\n');
      process.exit(1);
    }
    if (upstream.enabled === false) {
      process.stderr.write('[toolfunnel] wrap: upstream "' + target + '" is DISABLED in mcp/expose.json - enable it first.\n');
      process.exit(1);
    }

    // Isolation notice - wrapping SUSPENDS the path-isolation guard for THIS upstream (and only
    // this upstream, and only while wrapped). A wrap is an explicit "this server is my entire
    // surface" declaration, so ToolFunnel acts as a transparent wrapper: outside paths (a
    // documents folder for a filesystem server, a database file, an absolute install path) are
    // permitted BY DESIGN. Funnel-mode upstreams keep the guard. The operator gets this warning
    // up front - informed consent, not a silent default (the old behaviour was worse: the guard
    // still applied, and `wrap` reported success while the gateway refused to connect).
    {
      const { looksLikePath, isInside } = require('../src/mcp/aggregator');
      const outsideArgs = (Array.isArray(upstream.args) ? upstream.args : [])
        .filter((a) => looksLikePath(a) && !isInside(home, a));
      if (outsideArgs.length) {
        process.stderr.write('[toolfunnel] ⚠ WRAP SECURITY NOTICE - upstream "' + target + '" uses paths outside the gateway root:\n' +
          outsideArgs.map((a) => '    ' + a).join('\n') + '\n' +
          '  While WRAPPED, the path-isolation guard is suspended for this upstream: ToolFunnel is a\n' +
          '  transparent wrapper here, and the wrapped server can reach whatever those paths reach.\n' +
          '  Every call still passes the PreToolUse gate. To restrict it AFTER wrapping: add a\n' +
          '  PreToolUse hook (block by tool/args), or disable individual tools (enabled:false, keyed\n' +
          '  by the surfaced name) - see the manual, "Wrapping & security". `wrap --off` restores the\n' +
          '  guard for this upstream.\n');
      }
    }

    setPassthrough(statePath, target);
    process.stderr.write('[toolfunnel] wrapping "' + target + '": its tools are now the ENTIRE surface, under ' +
      'their ORIGINAL names - meta-tools hidden and uncallable, every call still passes the PreToolUse gate.\n');

    // ── Era probe ──────────────────────────────────────────────────────────────────────────────
    // The 2026-07-28 spec's dual-era client rule, in probe order: try MODERN first
    // (server/discover), and only on failure fall back to the legacy initialize - otherwise a
    // dual-era upstream would be misreported as legacy just because the legacy handshake works.
    // Separate child per stage: a badly behaved legacy server may react badly to an unknown
    // method, and the fallback must not inherit a poisoned child.
    if (upstream.transport === 'stdio') {
      const { McpClient } = require('../src/mcp/mcp-client');
      const clientOpts = {
        id: target,
        command: upstream.command,
        args: Array.isArray(upstream.args) ? upstream.args : [],
        env: upstream.env || {},
        // Default the probe's cwd to the CONFIG HOME, same as the aggregator's spawn: relative
        // arg paths are guarded against the home, so they must spawn against it too.
        cwd: upstream.cwd || home,
        // Honour a configured slow-boot window; the probe default stays tight.
        requestTimeoutMs: Number.isFinite(upstream.requestTimeoutMs) && upstream.requestTimeoutMs > 0
          ? upstream.requestTimeoutMs : 6000,
      };

      let reported = false;
      // Stage 1: modern probe (server/discover).
      try {
        const probe = new McpClient(clientOpts);
        try {
          const disc = await probe.probeDiscover();
          const versions = disc && Array.isArray(disc.supportedVersions) ? disc.supportedVersions : [];
          const who = (disc && disc._meta && disc._meta['io.modelcontextprotocol/serverInfo'] &&
            disc._meta['io.modelcontextprotocol/serverInfo'].name) || target;
          const legacyCapable = versions.some((v) => typeof v === 'string' && v < '2026-07-28');
          if (legacyCapable) {
            process.stderr.write('[toolfunnel] era probe: "' + who + '" is DUAL-ERA (speaks ' + versions.join(', ') +
              ') - it already survives the 2026-07-28 cutover on its own; the wrap still curates + gates it.\n');
          } else {
            process.stderr.write('[toolfunnel] era probe: "' + who + '" is MODERN-ONLY (speaks ' + versions.join(', ') +
              '). ToolFunnel speaks the modern era to it (server/discover, per-request _meta) and re-presents ' +
              'it to legacy AND modern clients alike.\n');
          }
          reported = true;
        } finally {
          await probe.close();
        }
      } catch (_err) {
        /* no modern answer - fall through to the legacy handshake on a FRESH child */
      }

      // Stage 2: legacy fallback (initialize) - the era every current MCP speaks.
      if (!reported) {
        try {
          const legacy = new McpClient(clientOpts);
          try {
            const init = await legacy.connect();
            const v = init && typeof init.protocolVersion === 'string' ? init.protocolVersion : 'unknown';
            const who = init && init.serverInfo && init.serverInfo.name ? init.serverInfo.name : target;
            process.stderr.write('[toolfunnel] era probe: "' + who + '" speaks MCP ' + v + ' - a LEGACY-era MCP ' +
              '(no server/discover). Modern (2026-07-28) clients reach it through this gateway; on its own it ' +
              'cannot talk to them.\n');
          } finally {
            await legacy.close();
          }
        } catch (err) {
          const m = (err && err.message) || String(err);
          process.stderr.write('[toolfunnel] era probe: could not connect to "' + target + '" (' + m + ') - ' +
            'the wrap is set anyway; the surface appears when the upstream connects.\n');
        }
      }
    }

    // Dependency honesty: the wrap itself changes nothing about dependencies.
    process.stderr.write('[toolfunnel] dependencies: local use (stdio / loopback --http) stays ZERO-dependency. ' +
      'Serving this wrapped MCP over the network needs OAuth enabled first (`toolfunnel install-oauth` - ' +
      'adds the single audited dependency, jose).\n');

    // --as <name>: present AS the wrapped MCP in the handshake/discover (serverInfo). Identity is
    // read once at host start (deliberately not hot-swapped - a mid-session identity change would
    // lie to connected clients), so this takes effect on the NEXT start.
    const asName = flagValue('--as', '');
    if (asName) {
      const nodeFs = require('node:fs');
      const cfgPath = path.join(home, 'toolfunnel.json');
      let cfg = {};
      let existing = null;
      try { existing = nodeFs.readFileSync(cfgPath, 'utf8'); } catch (_e) { existing = null; } // missing = fine
      if (existing !== null) {
        // The file exists: parse it. On a parse error, ABORT rather than overwrite - blindly
        // rewriting would WIPE the operator's other fields (httpPort, serverVersion, requires...) to
        // recover only serverName. The wrap itself is already set;
        // only the identity rename is skipped.
        try {
          const parsed = JSON.parse(existing);
          cfg = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (_e) {
          process.stderr.write('[toolfunnel] WARNING: toolfunnel.json is not valid JSON - NOT writing serverName ' +
            '(refusing to overwrite and lose your other settings). Fix the file, then re-run `wrap ' + target + ' --as ' + asName + '`.\n');
          cfg = null; // signal: skip the write
        }
      }
      if (cfg !== null) {
        cfg.serverName = asName;
        // Atomic (temp + rename) like every other config write - a crash mid-writeFileSync
        // would leave a truncated toolfunnel.json.
        require('../src/tools/registry').atomicWriteJson(cfgPath, cfg);
        process.stderr.write('[toolfunnel] serverName set to "' + asName + '" (toolfunnel.json) - the gateway ' +
          'introduces itself as that in initialize/server-discover from the NEXT start.\n');
      }
    } else {
      process.stderr.write('[toolfunnel] tip: `wrap ' + target + ' --as <name>` also presents the gateway AS ' +
        'that MCP in the handshake (serverInfo), from the next start.\n');
    }
    process.stderr.write('[toolfunnel] undo with: toolfunnel wrap --off   (a running host picks the surface up live)\n');
    process.exit(0);
  })().catch((err) => {
    process.stderr.write('[toolfunnel] wrap failed: ' + ((err && err.message) || err) + '\n');
    process.exit(1);
  });
} else if (positionals[0] === 'install-oauth') {
  // Opt-in OAuth: pull the single audited dependency (jose) on demand. Keeps the default install
  // at zero runtime dependencies - you only ever fetch jose if you decide you need OAuth.
  const { installJose } = require('../src/auth/install');
  const { JOSE_PIN } = require('../src/auth/resource-server');
  process.stderr.write('[toolfunnel] installing the optional OAuth dependency jose@' + JOSE_PIN + ' ...\n');
  installJose()
    .then((res) => {
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      process.stderr.write('[toolfunnel] ' + res.message + '\n');
      if (res.ok) {
        process.stderr.write('[toolfunnel] OAuth is ready to enable - turn it on in the UI (Auth panel) or auth/auth.config.json.\n');
      }
      process.exit(res.ok ? 0 : 1);
    })
    .catch((err) => {
      process.stderr.write('[toolfunnel] install-oauth failed: ' + ((err && err.message) || err) + '\n');
      process.exit(1);
    });
} else if (positionals.length) {
  // An unrecognised COMMAND word must refuse loudly - starting the default server instead left
  // a mistyped/misplaced subcommand running a gateway the user never asked for, with zero
  // feedback (cold-start field test, 2026-07-18).
  process.stderr.write('[toolfunnel] unknown command "' + positionals[0] + '" - nothing started. See toolfunnel --help.\n');
  process.exit(1);
} else if (args.includes('--ui')) {
  const { createUiServer } = require('../src/ui/server');
  const { loadServerConfig } = require('../src/core/server-config');
  const { resolveConfigHome } = require('../src/core/config-home');
  const cfg = loadServerConfig(resolveConfigHome());
  const host = flagValue('--host', '127.0.0.1');
  // Precedence: --port flag > toolfunnel.json uiPort > 9777 (loadServerConfig folds in the default).
  const parsedPort = parseInt(flagValue('--port', String(cfg.uiPort)), 10);
  const port = Number.isInteger(parsedPort) ? parsedPort : cfg.uiPort;
  const server = createUiServer({ host, port });
  server
    .start()
    .then((info) => {
      process.stderr.write('[toolfunnel] config UI listening on ' + info.url + '\n');
    })
    .catch((err) => {
      process.stderr.write('[toolfunnel] failed to start config UI: ' + ((err && err.message) || err) + '\n');
      process.exit(1);
    });
  const shutdown = () => {
    server.stop().then(() => process.exit(0)).catch(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else if (args.includes('--http')) {
  const { createHttpMcpServer } = require('../src/mcp/http-transport');
  const { loadServerConfig } = require('../src/core/server-config');
  const { resolveConfigHome } = require('../src/core/config-home');
  const cfg = loadServerConfig(resolveConfigHome());
  const host = flagValue('--host', '127.0.0.1');
  // Precedence: --port flag > toolfunnel.json httpPort > 9998 (loadServerConfig folds in the default).
  const parsedPort = parseInt(flagValue('--port', String(cfg.httpPort)), 10);
  const port = Number.isInteger(parsedPort) ? parsedPort : cfg.httpPort;
  const server = createHttpMcpServer({ host, port });
  server
    .start()
    .then((info) => {
      process.stderr.write('[toolfunnel] HTTP MCP host listening on ' + info.url + '\n');
    })
    .catch((err) => {
      process.stderr.write('[toolfunnel] failed to start HTTP host: ' + ((err && err.message) || err) + '\n');
      process.exit(1);
    });
  const shutdown = () => {
    server.stop().then(() => process.exit(0)).catch(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else {
  // Default: stdio MCP server. main() builds the protocol, connects upstreams, runs the loop.
  require('../src/mcp/server').main();
}
