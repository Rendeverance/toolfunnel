#!/usr/bin/env node
'use strict';

/**
 * toolfunnel — CLI entry point.
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

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(
    [
      'toolfunnel — a zero-dependency MCP gateway',
      '',
      'Usage:',
      '  toolfunnel                    Start the stdio MCP server (default)',
      '  toolfunnel --http             Start the HTTP/SSE MCP host (127.0.0.1:9998)',
      '  toolfunnel --http --port <n>  Bind a specific port (0 = OS-assigned)',
      '  toolfunnel --http --host <h>  Bind a specific loopback host',
      '  toolfunnel --ui               Start the config web UI (127.0.0.1:9777)',
      '  toolfunnel --ui --port <n>    Bind a specific UI port (0 = OS-assigned)',
      '  toolfunnel install-oauth      Install the optional OAuth 2.1 dependency (jose)',
      '  toolfunnel --help             Show this help',
      '',
    ].join('\n')
  );
  process.exit(0);
}

if (args[0] === 'install-oauth') {
  // Opt-in OAuth: pull the single audited dependency (jose) on demand. Keeps the default install
  // at zero runtime dependencies — you only ever fetch jose if you decide you need OAuth.
  const { installJose } = require('../src/auth/install');
  const { JOSE_PIN } = require('../src/auth/resource-server');
  process.stderr.write('[toolfunnel] installing the optional OAuth dependency jose@' + JOSE_PIN + ' …\n');
  installJose()
    .then((res) => {
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      process.stderr.write('[toolfunnel] ' + res.message + '\n');
      if (res.ok) {
        process.stderr.write('[toolfunnel] OAuth is ready to enable — turn it on in the UI (Auth panel) or auth/auth.config.json.\n');
      }
      process.exit(res.ok ? 0 : 1);
    })
    .catch((err) => {
      process.stderr.write('[toolfunnel] install-oauth failed: ' + ((err && err.message) || err) + '\n');
      process.exit(1);
    });
} else if (args.includes('--ui')) {
  const { createUiServer } = require('../src/ui/server');
  const host = flagValue('--host', '127.0.0.1');
  const parsedPort = parseInt(flagValue('--port', '9777'), 10);
  const port = Number.isInteger(parsedPort) ? parsedPort : 9777;
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
  const host = flagValue('--host', '127.0.0.1');
  const parsedPort = parseInt(flagValue('--port', '9998'), 10);
  const port = Number.isInteger(parsedPort) ? parsedPort : 9998;
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
