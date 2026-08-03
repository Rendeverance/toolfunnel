'use strict';

/**
 * framing-upstream.js - fixture for the stdout-framing edge tests (framing-split.test.js).
 *
 * A LEGACY line-framed stdio MCP server whose tools exercise how the gateway's McpClient reads a
 * Content-Length-framed reply that arrives in more than one chunk:
 *
 *   - tools/call "split"       -> a CL-framed reply written as TWO chunks: the full header block
 *                                 first, then the body ~40 ms later. A reader that lets line
 *                                 framing consume the header while the body is in flight loses
 *                                 the frame - the caller sees only a timeout.
 *   - tools/call "splitheader" -> the same reply split INSIDE the header block: the header line
 *                                 (with its \r\n) first, then the blank line + body ~40 ms later.
 *   - tools/call "ping"        -> a small normal line-framed reply - the after-the-fact liveness
 *                                 probe proving the pipe is still in frame.
 *
 * And the read-buffer limit tools (framing-limits.test.js):
 *
 *   - tools/call "big"         -> a CL-framed reply declaring a ~4.5 MiB body (over the 4 MiB
 *                                 frame cap). The body is a VALID JSON-RPC response, so an
 *                                 uncapped reader buffers and delivers it; a capped reader must
 *                                 refuse it and stay in frame for "ping".
 *   - tools/call "flood"       -> ~4.5 MiB of raw 'x' bytes - no framing, no newline, no reply.
 *                                 An unframeable stream a reader can only answer by dropping
 *                                 the connection.
 *
 * Every other request carrying an id (the server/discover era probe) is answered -32601 so the
 * client's legacy fallback is fast and definitive. Notifications are ignored.
 */

const OVERSIZE = 4718592; // 4.5 MiB - comfortably past the 4 MiB frame cap

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_e) { continue; }
    handle(msg);
  }
});

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function handle(msg) {
  const hasId = msg && msg.id !== undefined && msg.id !== null;
  if (!hasId) return; // notifications: ignore
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'framing-upstream', version: '1.0.0' },
        capabilities: { tools: {} },
      },
    });
    return;
  }
  if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        tools: [
          { name: 'split', inputSchema: { type: 'object' } },
          { name: 'splitheader', inputSchema: { type: 'object' } },
          { name: 'big', inputSchema: { type: 'object' } },
          { name: 'flood', inputSchema: { type: 'object' } },
          { name: 'ping', inputSchema: { type: 'object' } },
        ],
      },
    });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    if (name === 'split') {
      // Full header block in chunk 1, body in chunk 2. No trailing newline after the body -
      // pure Content-Length framing, exactly what an LSP-style SDK server writes.
      const body = JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: 'split-ok' }] },
      });
      process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\r\n\r\n');
      setTimeout(() => process.stdout.write(body), 40);
      return;
    }
    if (name === 'splitheader') {
      // Chunk boundary INSIDE the header block: the header line arrives complete (with its
      // \r\n) but the blank-line terminator and body follow later.
      const body = JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: 'splitheader-ok' }] },
      });
      process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\r\n');
      setTimeout(() => process.stdout.write('\r\n' + body), 40);
      return;
    }
    if (name === 'big') {
      // One valid CL-framed reply whose declared body is over the frame cap.
      const body = JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: 'x'.repeat(OVERSIZE) }] },
      });
      process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\r\n\r\n' + body);
      return;
    }
    if (name === 'flood') {
      // Raw unframeable bytes; the call is never answered.
      process.stdout.write('x'.repeat(OVERSIZE));
      return;
    }
    send({
      jsonrpc: '2.0', id: msg.id,
      result: { content: [{ type: 'text', text: 'pong' }] },
    });
    return;
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
}
