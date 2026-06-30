'use strict';

/**
 * smoke.js — fast, socket-free smoke test of the gateway core.
 *
 * Drives buildProtocol() + handleMessage() directly (no transport, no port) to prove the
 * whole Phase-1 stack wires and runs: register + manifest load, the meta-tools advertise, and
 * a meta-tool call returns the demo register. Run:  node test/smoke.js   (exit 0 = pass)
 */

const path = require('node:path');
const { buildProtocol, handleMessage } = require(path.join(__dirname, '..', 'src', 'mcp', 'server.js'));

let nextId = 1;
function rpc(build, method, params) {
  return handleMessage(build, { jsonrpc: '2.0', id: nextId++, method, params: params || {} });
}

(async () => {
  const pass = [];
  const fail = [];

  let build;
  try {
    build = buildProtocol();
    pass.push('buildProtocol() wired — register + manifest + engine loaded without throwing');
  } catch (e) {
    fail.push('buildProtocol() threw: ' + (e && e.message));
    console.log(JSON.stringify({ pass, fail }, null, 2));
    process.exit(1);
    return;
  }

  const init = await rpc(build, 'initialize');
  const name = init && init.result && init.result.serverInfo && init.result.serverInfo.name;
  if (name === 'toolfunnel') pass.push('initialize → serverInfo.name = "toolfunnel"');
  else fail.push('initialize serverInfo.name = ' + JSON.stringify(name));

  const list = await rpc(build, 'tools/list');
  const tools = (list && list.result && list.result.tools) || [];
  const toolNames = tools.map((t) => t && t.name);
  const metas = ['toolfunnel_list_tools', 'toolfunnel_tool_instructions', 'toolfunnel_howto'];
  const haveMetas = metas.every((m) => toolNames.includes(m));
  if (haveMetas) pass.push('tools/list advertises meta-tools: ' + metas.join(', '));
  else fail.push('tools/list missing meta-tools; got: ' + JSON.stringify(toolNames));

  const call = await rpc(build, 'tools/call', { name: 'toolfunnel_list_tools', arguments: {} });
  const text = call && call.result && call.result.content && call.result.content[0] && call.result.content[0].text;
  let briefs = null;
  try { briefs = JSON.parse(text); } catch (_e) { /* leave null */ }
  const ids = Array.isArray(briefs) ? briefs.map((b) => b && b.id) : [];
  if (ids.length > 0) pass.push('toolfunnel_list_tools → ' + ids.length + ' demo tools: ' + ids.join(', '));
  else fail.push('toolfunnel_list_tools returned no briefs; raw text = ' + String(text).slice(0, 200));

  console.log(JSON.stringify({ pass, fail }, null, 2));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => {
  console.log('SMOKE CRASHED: ' + (e && e.stack || e));
  process.exit(1);
});
