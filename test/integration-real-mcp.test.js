'use strict';

/**
 * integration-real-mcp.test.js - attach a REAL, third-party MCP server we did NOT write
 * (@modelcontextprotocol/server-everything, launched via `npx`) and prove the full upstream
 * round-trip: connect -> tools/list -> tools/call returns the server's real answer.
 *
 * WHY THIS EXISTS: the offline suite proxies our own bundled mock. The two bugs fixed in this
 * release (the Windows `.cmd` spawn and the LSP-vs-newline framing) both hid because the mock was
 * built to match our own assumptions. The only durable guard against that class is a test against an
 * independent implementation. This is it.
 *
 * GATED: needs network (npx fetches the server) + a few seconds of cold-start, so it is OFF by
 * default - set TF_INTEGRATION=1 to run it (a dedicated CI lane does). Without the flag it SKIPS and
 * exits 0, so the offline suite stays deterministic.
 *
 * Node built-ins only (+ the gateway's own McpClient). Run: TF_INTEGRATION=1 node test/integration-real-mcp.test.js
 */

const path = require('node:path');
const { McpClient } = require(path.join(__dirname, '..', 'src', 'mcp', 'mcp-client.js'));

if (process.env.TF_INTEGRATION !== '1') {
  console.log('SKIP: integration-real-mcp - set TF_INTEGRATION=1 to run (needs network for npx).');
  process.exit(0);
}

const results = [];
function check(name, cond, detail) { results.push({ name, ok: !!cond, detail }); }

(async () => {
  let fatal = null;
  // npx cold-start (fetch + boot) can take a while on a fresh CI runner.
  const client = new McpClient({
    id: 'everything',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    requestTimeoutMs: 120000,
  });
  try {
    await client.connect();
    const tools = await client.listTools();
    const names = (tools || []).map((t) => t && t.name);
    check('connect + tools/list: a real third-party MCP advertised its tools', Array.isArray(tools) && tools.length > 0,
      'tools=' + JSON.stringify(names).slice(0, 200));
    check('tools/list: includes the expected "echo" tool', names.includes('echo'),
      'names=' + JSON.stringify(names).slice(0, 200));

    const res = await client.callTool('echo', { message: 'toolfunnel integration ping' });
    check('tools/call: echo returned the server\'s real answer', /toolfunnel integration ping/.test(JSON.stringify(res)),
      'echo=' + JSON.stringify(res).slice(0, 200));
  } catch (err) {
    fatal = err;
  } finally {
    try { client.close(); } catch (_e) { /* ignore */ }
  }

  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));

  const failed = results.filter((r) => !r.ok).length;
  const ok = !fatal && failed === 0 && results.length > 0;
  console.log(ok
    ? `\nPASS: integration-real-mcp - ${results.length}/${results.length} (real npx MCP attached + listed + called)`
    : `\nFAIL: integration-real-mcp - ${failed}/${results.length} failed`);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.log('INTEGRATION-REAL-MCP TEST CRASHED: ' + ((e && e.stack) || e));
  process.exit(1);
});
