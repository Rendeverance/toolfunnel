#!/usr/bin/env node
'use strict';

/**
 * mcp/servers/mock-upstream/server.js
 *
 * A tiny, ZERO-DEPENDENCY stdio MCP server bundled inside ToolFunnel's own `mcp/` tree so it
 * travels with the install (the "toolbox" stays self-contained and portable). It exists to
 * demonstrate ToolFunnel attaching and forwarding (proxying) an upstream MCP: attach it as an
 * upstream, expose its tools, and watch ToolFunnel forward calls to it through the policy gate.
 *
 * Attach it with a RELATIVE arg path (the aggregator resolves it against the gateway root and
 * the isolation guard requires it to stay inside the tree):
 *   upstream: { id: "mock", command: "node", args: ["mcp/servers/mock-upstream/server.js"] }
 *
 * Protocol: JSON-RPC 2.0 over stdio with NEWLINE-DELIMITED framing — one compact JSON object per
 *   line, "\n"-terminated, the MCP stdio transport every real SDK-based server speaks. We read lines
 *   on stdin and answer in kind on stdout. (This fixture used to parse LSP Content-Length framing,
 *   matching an old client bug; both were corrected together so the mock represents a REAL server.)
 *
 * Tools exposed (real upstream names):
 *   - ping              -> "pong"
 *   - add  { a, b }     -> a + b
 *   - echo { text }     -> text
 *
 * Replies to `initialize`, ignores `notifications/initialized`, answers `tools/list` and
 * `tools/call`, never crashes on a bad frame, and exits cleanly on stdin EOF.
 *
 * Node built-ins only. CommonJS.
 */

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'mock-upstream', version: '1.0.0' };

const TOOLS = [
  {
    name: 'ping',
    description: 'Health check — returns the string "pong".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'add',
    description: 'Add two numbers and return the sum.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
  {
    name: 'echo',
    description: 'Echo back the supplied text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'crash',
    description: 'Exit the process immediately (simulates an upstream crash — for reconnect testing).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/** Write one JSON-RPC message as a newline-delimited line — the MCP stdio framing. */
function writeMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/** Standard MCP tools/call result envelope. */
function textResult(text, isError) {
  return { content: [{ type: 'text', text: String(text) }], isError: isError === true };
}

/** Dispatch one parsed JSON-RPC message. Notifications (no id) get no reply. */
function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const id = msg.id;
  const method = msg.method;
  const params = msg.params || {};

  // Notifications carry no id and must never be answered.
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      return writeMessage({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: SERVER_INFO,
          capabilities: { tools: {} },
        },
      });

    case 'tools/list':
      return writeMessage({ jsonrpc: '2.0', id, result: { tools: TOOLS } });

    case 'tools/call': {
      const name = params.name;
      const args = params.arguments || {};
      try {
        if (name === 'ping') {
          return writeMessage({ jsonrpc: '2.0', id, result: textResult('pong') });
        }
        if (name === 'add') {
          const a = Number(args.a);
          const b = Number(args.b);
          if (!isFinite(a) || !isFinite(b)) {
            return writeMessage({ jsonrpc: '2.0', id, result: textResult('add requires numeric a and b', true) });
          }
          return writeMessage({ jsonrpc: '2.0', id, result: textResult(String(a + b)) });
        }
        if (name === 'echo') {
          const text = typeof args.text === 'string' ? args.text : JSON.stringify(args.text);
          return writeMessage({ jsonrpc: '2.0', id, result: textResult(text) });
        }
        if (name === 'crash') {
          // Simulate an upstream crash: exit WITHOUT replying. The gateway's in-flight request
          // rejects and its McpClient.onClose fires → the aggregator schedules a background
          // reconnect. Exercised by reconnect.test.js.
          process.exit(1);
        }
        return writeMessage({ jsonrpc: '2.0', id, result: textResult('unknown tool: ' + name, true) });
      } catch (err) {
        return writeMessage({ jsonrpc: '2.0', id, result: textResult('error: ' + ((err && err.message) || err), true) });
      }
    }

    default:
      // Unknown method -> a well-formed JSON-RPC method-not-found error.
      return writeMessage({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found: ' + method },
      });
  }
}

// ── Newline-delimited JSON reader over stdin (the MCP stdio framing) ─────────────────
let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  // Drain every complete line currently buffered (one JSON-RPC message per line).
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).replace(/\r$/, '').trim();
    buffer = buffer.slice(nl + 1);
    if (line.length === 0) continue; // blank separator line — ignore
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_e) {
      continue; // skip an unparseable line rather than crash
    }
    try {
      handleMessage(msg);
    } catch (_e) {
      /* a handler must never take the server down */
    }
  }
});

process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
