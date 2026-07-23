#!/usr/bin/env node
'use strict';

/**
 * mcp/servers/mock-modern/server.js
 *
 * A tiny, ZERO-DEPENDENCY stdio MCP server that speaks the 2026-07-28 ("modern") protocol -
 * the companion to mock-upstream (which speaks the legacy 2024-11-05 protocol). It exists to
 * prove ToolFunnel's DUAL-ERA CLIENT: attach it as an upstream and ToolFunnel negotiates modern
 * (probes server/discover, skips the initialize handshake, and puts a per-request `_meta` on
 * every call). Over stdio the modern era needs only `_meta` - the Mcp-* headers are HTTP-only.
 *
 * Modern-only, deliberately STRICT so it proves the client is really speaking modern:
 *   - `initialize`      -> -32601 (removed in the modern era; a modern-only server has no handshake)
 *   - `server/discover` -> { resultType, supportedVersions:['2026-07-28'], capabilities, _meta
 *                           (serverInfo), instructions, ttlMs, cacheScope }
 *   - `tools/list`      -> REQUIRES per-request `_meta` (else -32602); returns resultType + tools
 *                           + ttlMs/cacheScope
 *   - `tools/call`      -> REQUIRES per-request `_meta` (else -32602); returns resultType + content
 *
 * Tools (real upstream names): ping -> "pong", add {a,b} -> a+b, echo {text} -> text.
 *
 * JSON-RPC 2.0 over stdio, newline-delimited (one compact JSON object per line). Node built-ins
 * only, CommonJS. Built to the RC spec (locked 2026-05-21); reconcile minor final deltas 28 July.
 */

const MODERN_VERSION = '2026-07-28';
const SERVER_INFO = { name: 'mock-modern', version: '2.0.0' };
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVERINFO = 'io.modelcontextprotocol/serverInfo';

const TOOLS = [
  { name: 'ping', description: 'Health check - returns "pong".', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'add', description: 'Add two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false } },
  { name: 'echo', description: 'Echo the given text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
];

function writeMessage(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (_e) { /* never crash on a write */ }
}

/** A modern result carries resultType + the server's serverInfo in _meta. */
function modernResult(extra) {
  return Object.assign({ resultType: 'complete', _meta: { [META_SERVERINFO]: SERVER_INFO } }, extra);
}

function textResult(text, isError) {
  return modernResult({ content: [{ type: 'text', text: String(text) }], isError: isError === true });
}

/** A modern request MUST carry params._meta with BOTH the EXACT protocol version AND a
 *  clientCapabilities object - the spec's two per-request MUSTs. Strict on purpose: this
 *  fixture's job is to catch a client regression in EITHER field (a lax check here would let
 *  "tools/call works with _meta" pass while the client sent the wrong version or no caps). */
function hasModernMeta(params) {
  const meta = params && params._meta;
  if (!meta || typeof meta !== 'object') return false;
  if (meta[META_VERSION] !== MODERN_VERSION) return false;
  const caps = meta['io.modelcontextprotocol/clientCapabilities'];
  return !!(caps && typeof caps === 'object' && !Array.isArray(caps));
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const id = msg.id;
  const method = msg.method;
  const params = msg.params || {};
  if (id === undefined || id === null) return; // notifications are never answered

  switch (method) {
    case 'server/discover':
      return writeMessage({
        jsonrpc: '2.0', id,
        result: modernResult({
          supportedVersions: [MODERN_VERSION],
          capabilities: { tools: {} },
          instructions: 'A modern (2026-07-28) mock MCP. Tools: ping, add, echo.',
          ttlMs: 3600000,
          cacheScope: 'private',
        }),
      });

    case 'initialize':
      // Modern-only: the initialize handshake was removed. Reject so a legacy client fails clearly.
      return writeMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: initialize (this is a modern 2026-07-28 server - use server/discover)' } });

    case 'tools/list':
      if (!hasModernMeta(params)) {
        return writeMessage({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params: modern requests require params._meta with a protocol version' } });
      }
      return writeMessage({ jsonrpc: '2.0', id, result: modernResult({ tools: TOOLS, ttlMs: 60000, cacheScope: 'private' }) });

    case 'resources/list':
      // A CacheableResult surface - proves non-tool forwarding under a wrap (and that the wrap adds
      // the required ttlMs/cacheScope when the upstream's own hints are absent).
      if (!hasModernMeta(params)) {
        return writeMessage({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params: modern requests require params._meta with a protocol version' } });
      }
      return writeMessage({ jsonrpc: '2.0', id, result: modernResult({ resources: [{ uri: 'mock://modern/example', name: 'example' }] }) });

    case 'tools/call': {
      if (!hasModernMeta(params)) {
        return writeMessage({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params: modern requests require params._meta with a protocol version' } });
      }
      const name = params.name;
      const args = params.arguments || {};
      if (name === 'ping') {
        // PLUMBING FIXTURE, not conformant behaviour: a real modern server emits notifications
        // only inside a subscriptions/listen stream, which ToolFunnel's client does not yet open
        // (28-July item). This unsolicited emission exists solely so BR-A2 can prove the
        // notification->hook plumbing; the ACK-level honesty (never counting a modern upstream as
        // able to honour resourceSubscriptions) is asserted by BR-A3.
        writeMessage({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'mock://modern/example' } });
        return writeMessage({ jsonrpc: '2.0', id, result: textResult('pong') });
      }
      if (name === 'add') {
        const a = Number(args.a), b = Number(args.b);
        if (!isFinite(a) || !isFinite(b)) return writeMessage({ jsonrpc: '2.0', id, result: textResult('add requires numeric a and b', true) });
        return writeMessage({ jsonrpc: '2.0', id, result: textResult(String(a + b)) });
      }
      if (name === 'echo') {
        const text = typeof args.text === 'string' ? args.text : JSON.stringify(args.text);
        return writeMessage({ jsonrpc: '2.0', id, result: textResult(text) });
      }
      return writeMessage({ jsonrpc: '2.0', id, result: textResult('unknown tool: ' + name, true) });
    }

    default:
      return writeMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).replace(/\r$/, '').trim();
    buffer = buffer.slice(nl + 1);
    if (line.length === 0) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_e) { continue; }
    try { handleMessage(msg); } catch (_e) { /* never take the server down */ }
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
