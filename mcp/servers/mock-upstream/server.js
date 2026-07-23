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
 * Protocol: JSON-RPC 2.0 over stdio with NEWLINE-DELIMITED framing - one compact JSON object per
 *   line, "\n"-terminated, the MCP stdio transport every real SDK-based server speaks. We read lines
 *   on stdin and answer in kind on stdout. (This fixture used to parse LSP Content-Length framing,
 *   matching an old client bug; both were corrected together so the mock represents a REAL server.)
 *
 * Tools exposed (real upstream names):
 *   - ping              -> "pong"
 *   - add  { a, b }     -> a + b
 *   - echo { text }     -> text
 *   - blocks            -> a MULTI-BLOCK result with structuredContent (envelope-fidelity fixture)
 *
 * Replies to `initialize`, ignores `notifications/initialized`, answers `tools/list`,
 * `tools/call` and `resources/list` (one fixed resource - forward-fidelity fixture),
 * never crashes on a bad frame, and exits cleanly on stdin EOF.
 *
 * Node built-ins only. CommonJS.
 */

const PROTOCOL_VERSION = '2024-11-05';
// `title` is a fidelity fixture: the 2025-06-18 spec added serverInfo.title, and the wrap must
// deliver it VERBATIM (a whitelist in wrappedIdentity used to eat it - wrap-lab, 2026-07-17).
const SERVER_INFO = { name: 'mock-upstream', version: '1.0.0', title: 'Mock Upstream Fixture' };

const TOOLS = [
  {
    name: 'ping',
    description: 'Health check - returns the string "pong".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    // title + annotations are fidelity fixtures: real servers ship them (and newer fields), and a
    // transparent wrap must advertise the def BYTE-IDENTICAL (a projection used to drop both).
    name: 'add',
    title: 'Add Numbers',
    description: 'Add two numbers and return the sum.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
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
    name: 'blocks',
    description: 'Return a multi-block result with structuredContent (envelope-fidelity fixture).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'crash',
    description: 'Exit the process immediately (simulates an upstream crash - for reconnect testing).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'prog',
    description: 'Progress fixture: emits two notifications/progress against the request _meta progressToken, then returns.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'slowtool',
    description: 'In-flight tools/call fixture: replies after 2s - the cancel-translation window for the TOOL path.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'elicit',
    description: 'Elicitation fixture (Bridge B): sends a server-initiated elicitation/create mid-call, holds the call open, completes from the answer.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// Outstanding SERVER->CLIENT requests this mock has issued (Bridge B fixture): id -> callback fed
// with the client's response ({ result } or { error }).
const outstandingServerRequests = new Map();
let nextServerRequestId = 9001;

/** Write one JSON-RPC message as a newline-delimited line - the MCP stdio framing. */
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

  // Notifications carry no id and must never be answered. Cancel-fidelity fixture: when
  // TF_MOCK_CANCEL_LOG is set, RECORD each received notifications/cancelled requestId - a
  // gateway test can then prove which id (translated or raw) actually reached this server.
  if (id === undefined || id === null) {
    if (method === 'notifications/cancelled' && process.env.TF_MOCK_CANCEL_LOG) {
      try {
        require('node:fs').appendFileSync(process.env.TF_MOCK_CANCEL_LOG, String(params.requestId) + '\n');
      } catch (_e) { /* fixture logging must never crash the mock */ }
    }
    return;
  }

  // A message with an id and NO method is a client RESPONSE - route it to the outstanding
  // server-initiated request it answers (Bridge B fixture). Unknown ids are dropped.
  if (method === undefined) {
    const cb = outstandingServerRequests.get(id);
    if (cb) {
      outstandingServerRequests.delete(id);
      try { cb(msg); } catch (_e) { /* fixture callback must never crash the mock */ }
    }
    return;
  }

  switch (method) {
    case 'initialize':
      // Identity-mirroring fixture: RECORD the clientInfo each connect presents when
      // TF_MOCK_CLIENTINFO_LOG is set. A wire test reads the log across a reconnect - first
      // entry = the gateway's boot identity, last entry = the mirrored downstream client.
      if (process.env.TF_MOCK_CLIENTINFO_LOG) {
        try {
          require('node:fs').appendFileSync(process.env.TF_MOCK_CLIENTINFO_LOG,
            JSON.stringify((params && params.clientInfo) || null) + '\n');
        } catch (_e) { /* fixture logging must never crash the mock */ }
      }
      return writeMessage({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: SERVER_INFO,
          // resources.subscribe: the per-URI update fixture - a legacy server only emits
          // resources/updated AFTER a resources/subscribe, which is exactly the channel the
          // gateway must forward, replay on reconnect, and bridge back.
          capabilities: { tools: {}, resources: { subscribe: true } },
        },
      });

    case 'tools/list':
      return writeMessage({ jsonrpc: '2.0', id, result: { tools: TOOLS } });

    case 'server/discover':
      // Era-probe fixture: TF_MOCK_DISCOVER_EMPTY=1 makes this server ACK unknown methods with `{}`
      // - the "permissive legacy server" shape. A strict dual-era client probe must treat that as
      // LEGACY (no supportedVersions listing the modern version). Default: honest -32601.
      if (process.env.TF_MOCK_DISCOVER_EMPTY === '1') {
        return writeMessage({ jsonrpc: '2.0', id, result: {} });
      }
      return writeMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });

    case 'resources/list':
      // Forward-fidelity fixture: a distinctive verbatim result so a gateway test can PROVE a
      // forwarded non-tool method really reached this server (and came back untouched).
      return writeMessage({
        jsonrpc: '2.0', id,
        result: { resources: [{ uri: 'mock://upstream/readme', name: 'readme', mimeType: 'text/plain' }] },
      });

    case 'resources/subscribe': {
      // Per-URI update fixture. Ack, RECORD the subscribe when TF_MOCK_SUB_LOG is set (a replay
      // test counts subscribes across a process swap - a fresh process logging a fresh subscribe
      // PROVES the gateway replayed it), then emit one resources/updated shortly after.
      const uri = typeof params.uri === 'string' ? params.uri : '';
      if (process.env.TF_MOCK_SUB_LOG) {
        try {
          require('node:fs').appendFileSync(process.env.TF_MOCK_SUB_LOG, uri + '\n');
        } catch (_e) { /* fixture logging must never crash the mock */ }
      }
      writeMessage({ jsonrpc: '2.0', id, result: {} });
      setTimeout(() => writeMessage({
        jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri },
      }), 150);
      return;
    }

    case 'resources/read': {
      const uri = params.uri;
      if (uri === 'mock://upstream/slow') {
        // In-flight fixture: reply after 2s so a gateway test has a WIDE window to fire a
        // cancel at a genuinely outstanding forwarded request (400ms made W1 a flake candidate
        // on a loaded runner).
        setTimeout(() => writeMessage({
          jsonrpc: '2.0', id,
          result: { contents: [{ uri, mimeType: 'text/plain', text: 'slow done' }] },
        }), 2000);
        return;
      }
      if (uri === 'mock://upstream/readme') {
        return writeMessage({
          jsonrpc: '2.0', id,
          result: { contents: [{ uri, mimeType: 'text/plain', text: 'mock upstream readme' }] },
        });
      }
      return writeMessage({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown resource: ' + uri } });
    }

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
        if (name === 'blocks') {
          // Envelope-fidelity fixture: two content blocks AND structuredContent. A transparent
          // forward must deliver this envelope VERBATIM - any re-shaping collapses it.
          return writeMessage({
            jsonrpc: '2.0', id,
            result: {
              content: [
                { type: 'text', text: 'first block' },
                { type: 'text', text: 'second block' },
              ],
              structuredContent: { first: 'first block', second: 'second block' },
              isError: false,
            },
          });
        }
        if (name === 'crash') {
          // Simulate an upstream crash: exit WITHOUT replying. The gateway's in-flight request
          // rejects and its McpClient.onClose fires -> the aggregator schedules a background
          // reconnect. Exercised by reconnect.test.js.
          process.exit(1);
        }
        if (name === 'slowtool') {
          // The tool-path twin of mock://upstream/slow: a genuinely outstanding tools/call for
          // cancel-translation tests.
          setTimeout(() => writeMessage({ jsonrpc: '2.0', id, result: textResult('slowtool done') }), 2000);
          return;
        }
        if (name === 'elicit') {
          // Bridge B fixture: ask the CLIENT a question mid-call, hold the tools/call open, and
          // complete it from the answer - exactly what a real eliciting legacy server does.
          const reqId = nextServerRequestId++;
          outstandingServerRequests.set(reqId, (resp) => {
            const res = resp && resp.result;
            if (resp && resp.error) {
              return writeMessage({ jsonrpc: '2.0', id, result: textResult('elicit error: ' + resp.error.message, true) });
            }
            const action = res && res.action;
            if (action === 'accept') {
              const colour = res.content && res.content.colour;
              return writeMessage({ jsonrpc: '2.0', id, result: textResult('colour: ' + colour) });
            }
            return writeMessage({ jsonrpc: '2.0', id, result: textResult(String(action || 'no action')) });
          });
          // NO `mode` field - deliberately. Real pre-MRTR legacy upstreams send only
          // {message, requestedSchema}; the BRIDGE must inject mode:"form" for the modern shape,
          // and a fixture that includes it would mask that translation.
          writeMessage({
            jsonrpc: '2.0', id: reqId, method: 'elicitation/create',
            params: {
              message: 'Pick a colour',
              requestedSchema: { type: 'object', properties: { colour: { type: 'string' } }, required: ['colour'] },
            },
          });
          return; // the tools/call reply comes from the callback above
        }
        if (name === 'prog') {
          // Progress fixture: a real server correlates progress via the REQUEST's _meta
          // progressToken. If the gateway stripped _meta on the forward, token is
          // undefined and no progress is emitted - the test's zero-count is the failure signal.
          const token = params._meta && params._meta.progressToken;
          if (token !== undefined) {
            writeMessage({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 2 } });
            writeMessage({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: 2, total: 2 } });
          }
          return writeMessage({ jsonrpc: '2.0', id, result: textResult(token !== undefined ? 'prog done (token seen)' : 'prog done (NO token)') });
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
    if (line.length === 0) continue; // blank separator line - ignore
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
