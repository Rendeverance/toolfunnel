#!/usr/bin/env node
'use strict';

/**
 * A DUAL-ERA stdio MCP fixture: answers BOTH server/discover (a modern DiscoverResult listing
 * 2026-07-28) AND initialize (legacy). Which era a client lands on is therefore decided ENTIRELY
 * by the client's own negotiation - exactly what an era test needs to hold still.
 *
 * TF_DUAL_SLOW_FILE: while that FILE EXISTS, the server/discover reply is delayed past the
 * client's 3s probe clamp (the shape of a cold-start / loaded-box blip). Remove the file and
 * discover answers instantly again. File-gated (not env-gated) so a test can flip the behaviour
 * BETWEEN respawns of this same fixture without touching the upstream's configured env.
 *
 * TF_DUAL_METHOD_LOG: append every inbound method name, one per line - the wire is the witness
 * for WHICH negotiation a fresh connection actually ran.
 */

const fs = require('node:fs');

const MODERN = '2026-07-28';
const LEGACY = '2024-11-05';
const SLOW_MS = 6000; // > the client's Math.min(3000, ...) probe clamp

const TOOLS = [
  { name: 'ping', description: 'returns pong', inputSchema: { type: 'object', properties: {} } },
  { name: 'crash', description: 'exits the process', inputSchema: { type: 'object', properties: {} } },
];

function write(msg) {
  try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch (_e) { /* pipe gone */ }
}

function handle(msg) {
  const id = msg.id;
  const method = msg.method;

  if (typeof method === 'string' && process.env.TF_DUAL_METHOD_LOG) {
    try { fs.appendFileSync(process.env.TF_DUAL_METHOD_LOG, method + '\n'); } catch (_e) { /* fixture only */ }
  }
  if (id === undefined || id === null) return; // notification - never answered

  switch (method) {
    case 'server/discover': {
      const reply = {
        jsonrpc: '2.0', id,
        result: {
          supportedVersions: [MODERN, LEGACY],
          capabilities: { tools: {} },
          _meta: {
            'io.modelcontextprotocol/serverInfo': { name: 'dual-era-upstream', version: '1.0.0' },
          },
        },
      };
      const slow = process.env.TF_DUAL_SLOW_FILE && fs.existsSync(process.env.TF_DUAL_SLOW_FILE);
      if (slow) { setTimeout(() => write(reply), SLOW_MS); return; }
      return write(reply);
    }
    case 'initialize':
      return write({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: LEGACY,
          serverInfo: { name: 'dual-era-upstream', version: '1.0.0' },
          capabilities: { tools: {} },
        },
      });
    case 'tools/list':
      return write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    case 'tools/call': {
      const name = (msg.params && msg.params.name) || '';
      if (name === 'crash') { process.exit(1); return; }
      return write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'pong' }] } });
    }
    default:
      return write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg = null;
    try { msg = JSON.parse(line); } catch (_e) { continue; }
    try { handle(msg); } catch (_e) { /* never crash on a bad frame */ }
  }
});
process.stdin.on('end', () => process.exit(0));
