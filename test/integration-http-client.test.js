'use strict';

/**
 * integration-http-client.test.js — drive ToolFunnel's Streamable-HTTP transport with the OFFICIAL
 * MCP SDK client (the canonical "real external client" we did NOT write). Proves interop with the
 * reference implementation end to end: connect (initialize) -> tools/list -> tools/call.
 *
 * Complements the stdio path, which is already proven against a real client (this very Claude Code
 * session reaches ToolFunnel over stdio). This closes the same gap for the HTTP transport.
 *
 * GATED: uses the @modelcontextprotocol/sdk devDependency. Set TF_INTEGRATION=1 to run; otherwise it
 * SKIPS and exits 0 so the offline suite stays self-contained.
 *
 * Run: TF_INTEGRATION=1 node test/integration-http-client.test.js
 */

if (process.env.TF_INTEGRATION !== '1') {
  console.log('SKIP: integration-http-client — set TF_INTEGRATION=1 to run (uses the MCP SDK devDep).');
  process.exit(0);
}

const fs = require('node:fs');
const path = require('node:path');
const authConfig = require(path.join(__dirname, '..', 'src', 'auth', 'config.js'));
const { createHttpMcpServer } = require(path.join(__dirname, '..', 'src', 'mcp', 'http-transport.js'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const results = [];
function check(name, cond, detail) { results.push({ name, ok: !!cond, detail }); }

(async () => {
  let fatal = null;

  // Force auth OFF so the loopback host needs no token (belt-and-braces, like http.test.js); snapshot
  // + restore the shared auth config so we leave it as found.
  const CFG = authConfig.CONFIG_PATH;
  const had = fs.existsSync(CFG);
  const orig = had ? fs.readFileSync(CFG, 'utf8') : null;
  authConfig.setConfig({ enabled: false });

  let host = null;
  let client = null;
  try {
    host = createHttpMcpServer({ host: '127.0.0.1', port: 0 });
    const started = await host.start();
    const url = new URL('http://127.0.0.1:' + started.port + '/mcp');

    client = new Client({ name: 'integration-http-client', version: '0.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport);
    check('connect: the official SDK client completed initialize over Streamable HTTP', true);

    const listed = await client.listTools();
    const names = ((listed && listed.tools) || []).map((t) => t && t.name);
    check('tools/list: SDK client received ToolFunnel tools', names.length > 0, 'names=' + JSON.stringify(names).slice(0, 200));
    check('tools/list: includes the meta-tool toolfunnel_list_tools', names.includes('toolfunnel_list_tools'),
      'names=' + JSON.stringify(names).slice(0, 200));

    const called = await client.callTool({ name: 'toolfunnel_list_tools', arguments: {} });
    check('tools/call: SDK client called a meta-tool and got content back', called && Array.isArray(called.content) && called.content.length > 0,
      'result=' + JSON.stringify(called).slice(0, 200));
  } catch (err) {
    fatal = err;
  } finally {
    try { if (client) await client.close(); } catch (_e) { /* ignore */ }
    try { if (host) await host.stop(); } catch (_e) { /* ignore */ }
    try { if (orig != null) fs.writeFileSync(CFG, orig); else if (fs.existsSync(CFG)) fs.unlinkSync(CFG); } catch (_e) { /* ignore */ }
  }

  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  if (fatal) console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));

  const failed = results.filter((r) => !r.ok).length;
  const ok = !fatal && failed === 0 && results.length > 0;
  console.log(ok
    ? `\nPASS: integration-http-client — ${results.length}/${results.length} (official MCP SDK client interop over Streamable HTTP)`
    : `\nFAIL: integration-http-client — ${failed}/${results.length} failed`);
  // Set the code and let the loop drain naturally rather than process.exit() — an abrupt exit while
  // the SDK's fetch/undici handles are still closing trips a libuv UV_HANDLE_CLOSING assert on Windows
  // (a teardown race, not a functional fault). A short unref'd backstop force-exits if anything lingers.
  process.exitCode = ok ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode || 0), 3000).unref();
})().catch((e) => {
  console.log('INTEGRATION-HTTP-CLIENT TEST CRASHED: ' + ((e && e.stack) || e));
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 3000).unref();
});
