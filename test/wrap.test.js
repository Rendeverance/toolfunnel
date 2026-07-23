'use strict';

/**
 * wrap.test.js - the PASSTHROUGH wrap (0.6.0) + the legacyPin shim, end to end.
 *
 * Runs against a SANDBOXED config home (temp dir + TOOLFUNNEL_HOME) with the bundled
 * mock-upstream COPIED INSIDE it (the aggregator's isolation guard refuses upstream script
 * paths outside the gateway root - correctly).
 *
 * Asserts:
 *   wrap engine:
 *     1. wrapped surface = the upstream's tools under their ORIGINAL names, real schemas,
 *        no meta-tools, on BOTH eras (legacy + modern view)
 *     2. a modern client's call to an ORIGINAL name executes through the wrap (the headline:
 *        modern client -> legacy upstream)
 *     3. meta-tools are UNCALLABLE under the wrap (callable == advertised)
 *     4. an explicit enabled:false still filters a wrapped tool out (the off-switch survives)
 *     5. clearing the wrap restores the funnel surface
 *   legacyPin shim:
 *     6. startup warning on connect names the pin + version
 *     7. per-call warning fires on a wrapped forward
 *     8. a modern result carries _meta["io.toolfunnel/legacyShim"]
 *   tf_wrap (the in-band management tool, via the REAL gated run path):
 *     9. status works; set REFUSES without confirm:true (and explains the recovery paths);
 *        confirm sets the wrap; tf_wrap is then LOCKED OUT in-band (by design)
 *   CLI:
 *    10. `toolfunnel wrap <unknown>` fails listing attached ids; `wrap --off` clears;
 *        the era probe reports the mock as LEGACY-era
 *
 * Exit code 0 on success; 1 with a FAIL line per failed assertion.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-wraptest-'));
process.env.TOOLFUNNEL_HOME = HOME;
require('../src/core/config-home').initConfigHome({});

const REPO_ROOT = path.resolve(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const STATE_PATH = path.join(HOME, 'tools', 'tools.state.json');

// The bundled mock upstream, copied INSIDE the sandbox home (isolation guard).
const mockCopy = path.join(HOME, 'mcp', 'servers', 'mock-upstream', 'server.js');
fs.mkdirSync(path.dirname(mockCopy), { recursive: true });
fs.copyFileSync(path.join(REPO_ROOT, 'mcp', 'servers', 'mock-upstream', 'server.js'), mockCopy);
fs.writeFileSync(path.join(HOME, 'mcp', 'expose.json'), JSON.stringify({
  version: 1,
  upstreams: [{ id: 'oldmcp', transport: 'stdio', command: process.execPath, args: [mockCopy], enabled: true, legacyPin: true }],
  expose: [],
}, null, 2));

const { setPassthrough, setToolEnabled } = require('../src/tools/tool-state');
const s = require('../src/mcp/server.js');

// Cancel-fidelity log - env must be set BEFORE the mock child spawns (it inherits the env).
const CANCEL_LOG = path.join(HOME, 'cancel.log');
process.env.TF_MOCK_CANCEL_LOG = CANCEL_LOG;

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

let fails = 0;
function check(label, cond) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label);
  if (!cond) fails += 1;
}

// Capture stderr so the shim warnings are assertable.
let errBuf = '';
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (str, ...rest) => {
  errBuf += str;
  return realWrite(str, ...rest);
};

(async () => {
  try {
    setPassthrough(STATE_PATH, 'oldmcp');

    const build = s.buildProtocol();
    await build.aggregator.connectAll();
    check('shim: startup warning names pin + version',
      /legacy shim: upstream "oldmcp" is PINNED to MCP 2024-11-05/.test(errBuf));

    // 1. The wrapped surface, both eras.
    const legacyList = await s.handleMessage(build, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const names = legacyList.result.tools.map((t) => t.name);
    check('wrap: ORIGINAL tool names, no metas, real schemas: ' + JSON.stringify(names),
      names.length > 0 && names.every((n) => !n.startsWith('toolfunnel_') && !n.startsWith('oldmcp_')) &&
      // "real schemas" must mean the UPSTREAM's actual schema, not the { type:'object' } fallback -
      // assert a property only the genuine mock-upstream add schema carries.
      legacyList.result.tools.some((t) => t.name === 'add' &&
        t.inputSchema && t.inputSchema.properties &&
        t.inputSchema.properties.a && t.inputSchema.properties.a.type === 'number'));
    const modernList = await s.handleMessage(build, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: META } });
    check('wrap: modern view decorated, same surface',
      modernList.result.resultType === 'complete' && modernList.result.tools.length === names.length);

    // 2 + 7 + 8. Modern client calls an ORIGINAL name through the wrap into the pinned upstream.
    errBuf = '';
    const call = await s.handleMessage(build, { jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'add', arguments: { a: 2, b: 3 }, _meta: META } });
    check('wrap: modern call -> legacy upstream works', call.result.isError === false && call.result.resultType === 'complete');
    // The per-call stderr warning is operator-side (a human running the wrap knows it's wrapped),
    // so it STILL fires - but the CLIENT-visible legacyShim _meta tell is SUPPRESSED under a wrap
    // (a wrap must be invisible; the shim tag is only for the non-wrapped funnel). R7/R8 + below.
    check('shim: per-call warning fires on the forward (operator-side, fine)',
      /legacy shim: forwarding "add" to pinned legacy upstream "oldmcp" \(MCP 2024-11-05\)/.test(errBuf));
    check('shim: legacyShim _meta tell SUPPRESSED under a wrap (invisible wrap)',
      !(call.result._meta && call.result._meta['io.toolfunnel/legacyShim']));

    // 3. Meta-tools uncallable under the wrap.
    const metaCall = await s.handleMessage(build, { jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'toolfunnel_list_tools', arguments: {} } });
    check('wrap: meta-tool uncallable', metaCall.result.isError === true && /Unknown tool/.test(metaCall.result.content[0].text));

    // 4. enabled:false (keyed by the SURFACED name) still filters a wrapped tool out.
    setToolEnabled(STATE_PATH, 'oldmcp_echo', false);
    const filtered = await s.handleMessage(build, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
    const filteredNames = filtered.result.tools.map((t) => t.name);
    check('wrap: enabled:false off-switch survives the wrap',
      !filteredNames.includes('echo') && filteredNames.includes('add'));
    const disabledCall = await s.handleMessage(build, { jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'x' } } });
    check('wrap: disabled wrapped tool uncallable', disabledCall.result.isError === true);
    setToolEnabled(STATE_PATH, 'oldmcp_echo', true);

    // 9. tf_wrap through the REAL gated run path. The wrap is ACTIVE, so tf_wrap must be locked
    //    out first (by design); clear the wrap out-of-band, then exercise the full flow.
    const runTfWrap = async (args) => {
      const r = await s.handleMessage(build, { jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: { name: 'toolfunnel_run_tool', arguments: { name: 'tf_wrap', args } } });
      if (r.result.isError) return { _uncallable: true, text: r.result.content[0].text };
      return JSON.parse(JSON.parse(r.result.content[0].text).stdout);
    };
    const locked = await runTfWrap({});
    check('tf_wrap: locked out while wrapped (by design)', locked._uncallable === true);
    setPassthrough(STATE_PATH, null); // out-of-band recovery (what the UI/CLI do)
    const status = await runTfWrap({});
    check('tf_wrap: status after recovery', status.ok === true && status.wrapping === null && status.upstreams.includes('oldmcp'));
    const refused = await runTfWrap({ upstream: 'oldmcp' });
    check('tf_wrap: refuses without confirm + explains recovery',
      refused.ok === false && /confirm/.test(refused.error) && /--off/.test(refused.error));
    const set = await runTfWrap({ upstream: 'oldmcp', confirm: true });
    check('tf_wrap: confirm sets the wrap + warns', set.ok === true && set.wrapping === 'oldmcp' && /hides ALL/.test(set.warning));
    setPassthrough(STATE_PATH, null);

    // 5. Funnel surface restored.
    const restored = await s.handleMessage(build, { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} });
    check('wrap: funnel surface restored after clear',
      restored.result.tools.some((t) => t.name === 'toolfunnel_list_tools'));

    await build.aggregator.closeAll();

    // 10. The CLI: unknown id fails listing ids; era probe reports LEGACY; --off clears.
    const env = Object.assign({}, process.env, { TOOLFUNNEL_HOME: HOME });
    const bad = spawnSync(process.execPath, [BIN, 'wrap', 'nope'], { env, encoding: 'utf8', timeout: 30000 });
    check('CLI: unknown id fails + lists attached', bad.status === 1 && /no upstream with id "nope"/.test(bad.stderr) && /oldmcp/.test(bad.stderr));
    const wrapRun = spawnSync(process.execPath, [BIN, 'wrap', 'oldmcp'], { env, encoding: 'utf8', timeout: 30000 });
    check('CLI: wrap sets + era probe reports LEGACY',
      wrapRun.status === 0 && /LEGACY-era/.test(wrapRun.stderr) && /speaks MCP 2024-11-05/.test(wrapRun.stderr));
    const offRun = spawnSync(process.execPath, [BIN, 'wrap', '--off'], { env, encoding: 'utf8', timeout: 30000 });
    const stateAfter = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    check('CLI: wrap --off clears', offRun.status === 0 && stateAfter.passthrough === undefined);

    // 10b. Transparent-wrapper isolation exemption (a deliberate design ruling): wrapping an
    // upstream whose path-args live OUTSIDE the gateway root is PERMITTED - a wrap is an explicit
    // "this server is my entire surface" declaration (e.g. server-filesystem on a documents
    // folder). The CLI warns LOUDLY up front; the running gateway honours the exemption for the
    // WRAPPED upstream only; funnel mode keeps the hard guard.
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-outside-'));
    const outsideCopy = path.join(outsideDir, 'server.js');
    fs.copyFileSync(path.join(REPO_ROOT, 'mcp', 'servers', 'mock-upstream', 'server.js'), outsideCopy);
    const exposeBackup = fs.readFileSync(path.join(HOME, 'mcp', 'expose.json'), 'utf8');
    fs.writeFileSync(path.join(HOME, 'mcp', 'expose.json'), JSON.stringify({
      version: 1,
      upstreams: [{ id: 'escapee', transport: 'stdio', command: process.execPath, args: [outsideCopy], enabled: true }],
      expose: [],
    }, null, 2));
    const escRun = spawnSync(process.execPath, [BIN, 'wrap', 'escapee'], { env, encoding: 'utf8', timeout: 30000 });
    const stateAfterEsc = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    check('CLI: wrapping an outside-root upstream WARNS loudly + sets the wrap',
      escRun.status === 0 && /WRAP SECURITY NOTICE/.test(escRun.stderr) &&
      /outside the gateway root/.test(escRun.stderr) && /PreToolUse/.test(escRun.stderr) &&
      stateAfterEsc.passthrough === 'escapee');
    // The RUNNING gateway honours the exemption: the wrapped escapee CONNECTS + serves its tools.
    const escBuild = s.buildProtocol();
    const escRes = await escBuild.aggregator.connectAll();
    const escList = await s.handleMessage(escBuild, { jsonrpc: '2.0', id: 30, method: 'tools/list', params: {} });
    check('gateway: WRAPPED outside-root upstream connects + serves (exemption live)',
      (!escRes || !escRes.failed || !escRes.failed.some((f) => f.id === 'escapee')) &&
      escList.result && escList.result.tools.some((t) => t.name === 'ping'));
    await escBuild.aggregator.closeAll();
    // Funnel mode (wrap OFF): the SAME upstream is refused - the guard is intact outside a wrap.
    setPassthrough(STATE_PATH, null);
    const funBuild = s.buildProtocol();
    const funRes = await funBuild.aggregator.connectAll();
    check('gateway: same upstream UNWRAPPED is refused (funnel guard intact)',
      !!(funRes && Array.isArray(funRes.failed) && funRes.failed.some((f) => f.id === 'escapee' && /isolation/.test(f.error))));
    await funBuild.aggregator.closeAll();
    fs.writeFileSync(path.join(HOME, 'mcp', 'expose.json'), exposeBackup); // restore for the tests below

    // ── Regression pins ─────────────────────────────────────────────

    // R1 (HIGH): a LOCAL register tool whose id collides with the wrapped upstream's surfaced name
    // must NOT shadow the upstream - the wrap runs the UPSTREAM tool, not the local one.
    const { loadRegistry } = require('../src/tools/registry');
    const reg = loadRegistry(path.join(HOME, 'tools', 'tools.register.json'), { scriptsRoot: path.join(HOME, 'tools', 'scripts') });
    // A local echo-shell tool whose id is exactly the surfaced name of the upstream's `add`.
    reg.add({ id: 'oldmcp_add', name: 'oldmcp_add', summary: 'local shadow', category: 'test',
      instructions: 'x', invoke: { type: 'shell', command: 'echo LOCAL_SHADOW_RAN' } });
    setPassthrough(STATE_PATH, 'oldmcp');
    const build2 = s.buildProtocol();
    await build2.aggregator.connectAll();
    const shadowCall = await s.handleMessage(build2, { jsonrpc: '2.0', id: 20, method: 'tools/call',
      params: { name: 'add', arguments: { a: 4, b: 5 } } });
    const shadowText = JSON.stringify(shadowCall.result);
    check('R1: wrapped call runs the UPSTREAM, not a colliding local tool',
      shadowCall.result.isError === false && !/LOCAL_SHADOW_RAN/.test(shadowText) && /9/.test(shadowText));
    await build2.aggregator.closeAll();
    setPassthrough(STATE_PATH, null);
    reg.remove('oldmcp_add');

    // R2 (MEDIUM): the reserved key - a per-tool setter must REFUSE id "passthrough" so it can never
    // clobber (or be clobbered by) the wrap.
    let reservedThrew = false;
    try { setToolEnabled(STATE_PATH, 'passthrough', false); } catch (_e) { reservedThrew = true; }
    check('R2: per-tool setter rejects the reserved "passthrough" id', reservedThrew);

    // R3 (MEDIUM): removing the WRAPPED upstream auto-clears the wrap (no bricked surface).
    setPassthrough(STATE_PATH, 'oldmcp');
    const rm = spawnSync(process.execPath, [BIN, 'wrap', '--off'], { env, encoding: 'utf8', timeout: 30000 }); // ensure clean
    void rm;
    setPassthrough(STATE_PATH, 'oldmcp');
    const { loadExposeStore } = require('../src/mcp/expose-store');
    const { getPassthrough, loadToolState } = require('../src/tools/tool-state');
    // The REAL remove path - spawn tf-mcp-set.js exactly as the engine does (TOOLFUNNEL_TOOL_ARGS
    // + TOOLFUNNEL_HOME). The old version SIMULATED the auto-clear against the stores and then
    // asserted its own write - a tautology that would let the real handler regress unnoticed
    //clearWrapIfTarget in the script is now what's actually under test.
    const rmReal = spawnSync(process.execPath, [path.join(REPO_ROOT, 'tools', 'scripts', 'tf-mcp-set.js')], {
      env: Object.assign({}, process.env, {
        TOOLFUNNEL_HOME: HOME,
        TOOLFUNNEL_TOOL_ARGS: JSON.stringify({ action: 'remove', id: 'oldmcp' }),
      }),
      encoding: 'utf8', timeout: 30000,
    });
    let rmPayload = null;
    try { rmPayload = JSON.parse(rmReal.stdout); } catch (_e) { /* asserted below */ }
    check('R3: the REAL tf-mcp-set remove clears the wrap (no lockout)',
      !!(rmPayload && rmPayload.ok === true && rmPayload.removed === true && rmPayload.wrapCleared === true) &&
      getPassthrough(loadToolState(STATE_PATH)) === null &&
      !loadExposeStore(path.join(HOME, 'mcp', 'expose.json')).getUpstream('oldmcp'),
      'payload=' + (rmReal.stdout || '').slice(0, 200));

    // R4 (MEDIUM): a corrupt tools.state.json does NOT crash and serves defaults (fail-open + the
    // surface builder warns) rather than throwing.
    fs.writeFileSync(STATE_PATH, '{ this is not json');
    const build3 = s.buildProtocol();
    const corruptList = await s.handleMessage(build3, { jsonrpc: '2.0', id: 21, method: 'tools/list', params: {} });
    check('R4: corrupt state file -> defaults (meta-tools present), no crash',
      corruptList.result.tools.some((t) => t.name === 'toolfunnel_list_tools'));
    if (build3.aggregator) await build3.aggregator.closeAll();

    // ── Handshake transparency (2026-07-16 - the whole point of the wrap) ────────────────────────
    // Re-add the upstream (R3 removed it), wrap it, and prove a client sees the WRAPPED server's
    // identity - not ToolFunnel's. The mock reports serverInfo {name:'mock-upstream'} + capabilities
    // {tools:{}}; that's what a wrapped client must see.
    fs.writeFileSync(path.join(HOME, 'mcp', 'expose.json'), JSON.stringify({
      version: 1,
      upstreams: [{ id: 'oldmcp', transport: 'stdio', command: process.execPath, args: [mockCopy], enabled: true, legacyPin: true }],
      expose: [],
    }, null, 2));
    setPassthrough(STATE_PATH, 'oldmcp');
    const build4 = s.buildProtocol();
    await build4.aggregator.connectAll();

    // R5: legacy initialize presents the WRAPPED server's serverInfo + capabilities, not ToolFunnel's.
    const init = await s.handleMessage(build4, { jsonrpc: '2.0', id: 30, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'c', version: '0' } } });
    check('R5: wrapped initialize -> upstream serverInfo (not toolfunnel)',
      init.result.serverInfo && init.result.serverInfo.name === 'mock-upstream' &&
      init.result.capabilities && init.result.capabilities.tools !== undefined);

    // R6: modern server/discover presents upstream identity BUT keeps our dual-era supportedVersions.
    const disc = await s.handleMessage(build4, { jsonrpc: '2.0', id: 31, method: 'server/discover', params: { _meta: META } });
    check('R6: wrapped discover -> upstream serverInfo + BOTH eras still advertised',
      disc.result._meta['io.modelcontextprotocol/serverInfo'].name === 'mock-upstream' &&
      disc.result.supportedVersions.includes('2026-07-28') && disc.result.supportedVersions.includes('2024-11-05') &&
      !/ToolFunnel/.test(disc.result.instructions || ''));

    // R7: modern tools/call under wrap carries the UPSTREAM serverInfo in _meta and NO legacyShim tell.
    const wcall = await s.handleMessage(build4, { jsonrpc: '2.0', id: 32, method: 'tools/call',
      params: { name: 'add', arguments: { a: 1, b: 1 }, _meta: META } });
    check('R7: wrapped modern result -> upstream serverInfo, NO legacyShim tell',
      wcall.result._meta['io.modelcontextprotocol/serverInfo'].name === 'mock-upstream' &&
      wcall.result._meta['io.toolfunnel/legacyShim'] === undefined);

    // R8: a non-tool method FORWARDS to the upstream under a wrap and its result returns VERBATIM
    // (the mock implements resources/list with a distinctive resource - proof the call left
    // ToolFunnel AND came back untouched). No "toolfunnel" string anywhere in the reply.
    const fwd = await s.handleMessage(build4, { jsonrpc: '2.0', id: 33, method: 'resources/list', params: { _meta: META } });
    check('R8: forwarded resources/list returns the upstream result verbatim',
      fwd.result && Array.isArray(fwd.result.resources) &&
      fwd.result.resources[0] && fwd.result.resources[0].uri === 'mock://upstream/readme' &&
      !/toolfunnel/i.test(JSON.stringify(fwd)));

    // R8c: a forwarded method the upstream does NOT implement returns the UPSTREAM's error
    // VERBATIM - its own -32601 code and message, with zero wrap tells (no upstream id, no
    // "wrapped upstream", no McpClient prefix). One probe of an unimplemented method must not
    // expose the funnel.
    const fwdErr = await s.handleMessage(build4, { jsonrpc: '2.0', id: 43, method: 'prompts/list', params: { _meta: META } });
    check('R8c: forwarded error is the upstream\'s verbatim -32601, zero wrap tells',
      fwdErr.error && fwdErr.error.code === -32601 &&
      fwdErr.error.message === 'Method not found: prompts/list' &&
      !/oldmcp|wrapped upstream|McpClient|toolfunnel/i.test(JSON.stringify(fwdErr)));

    // R10: wrapped tools/call envelope fidelity - a multi-block result with structuredContent
    // arrives VERBATIM (the old lean path collapsed everything to one
    // stringified text block).
    const blocks = await s.handleMessage(build4, { jsonrpc: '2.0', id: 44, method: 'tools/call',
      params: { name: 'blocks', arguments: {}, _meta: META } });
    check('R10: multi-block + structuredContent envelope passes verbatim under wrap',
      blocks.result && Array.isArray(blocks.result.content) && blocks.result.content.length === 2 &&
      blocks.result.content[1].text === 'second block' &&
      blocks.result.structuredContent && blocks.result.structuredContent.second === 'second block' &&
      blocks.result.isError === false);

    // R11: wrapped tools/call isError envelope fidelity - the upstream's OWN error envelope
    // (content + isError:true) arrives verbatim, not re-synthesised.
    const badAdd = await s.handleMessage(build4, { jsonrpc: '2.0', id: 45, method: 'tools/call',
      params: { name: 'add', arguments: { a: 'x', b: 1 }, _meta: META } });
    check('R11: upstream isError envelope passes verbatim under wrap',
      badAdd.result && badAdd.result.isError === true &&
      badAdd.result.content[0].text === 'add requires numeric a and b');

    setPassthrough(STATE_PATH, null);
    const fwdUnwrapped = await s.handleMessage(build4, { jsonrpc: '2.0', id: 34, method: 'resources/list', params: { _meta: META } });
    check('R8b: same method WITHOUT wrap -> ToolFunnel method-not-found (no forward)',
      fwdUnwrapped.error && fwdUnwrapped.error.code === -32601);

    // R9: the legacyShim _meta tag IS present in the NON-wrapped funnel (it's transparency FOR the
    // funnel; only a wrap suppresses it). The tag keys on the CALLED name, so the tool must be
    // directly callable - promote the pinned upstream's tool HOT, then call it by its surfaced name.
    const { setToolHot } = require('../src/tools/tool-state');
    setToolHot(STATE_PATH, 'oldmcp_add', true);
    const funnelCall = await s.handleMessage(build4, { jsonrpc: '2.0', id: 35, method: 'tools/call',
      params: { name: 'oldmcp_add', arguments: { a: 2, b: 2 }, _meta: META } });
    check('R9: non-wrapped funnel DOES carry the legacyShim _meta',
      funnelCall.result && funnelCall.result._meta && funnelCall.result._meta['io.toolfunnel/legacyShim'] &&
      funnelCall.result._meta['io.toolfunnel/legacyShim'].upstream === 'oldmcp');

    // ── Focused-review regressions (2026-07-17 night) ───────────────────────────────────────────
    setPassthrough(STATE_PATH, 'oldmcp');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // R12: a cancel from the SAME connection as an in-flight forwarded request reaches the
    // upstream with the TRANSLATED id (the McpClient's), never the client's raw id.
    // UNIT-LEVEL ONLY: this drives handleMessage concurrently by hand. The proof that the real
    // serialised stdio loop delivers this concurrency (out-of-band notifications + the pre-cancel
    // registry) lives at the wire in wrap-wire.test.js (W1/W2).
    const slowP = s.handleMessage(build4, { jsonrpc: '2.0', id: 77, method: 'resources/read',
      params: { uri: 'mock://upstream/slow', _meta: META } }, 'connA');
    await sleep(120); // let the forward reach the upstream + the in-flight map arm
    await s.handleMessage(build4, { jsonrpc: '2.0', method: 'notifications/cancelled',
      params: { requestId: 77 } }, 'connA');
    await sleep(120); // let the notification line flush to the child
    const slowRes = await slowP; // the mock still answers (it records, not aborts)
    const logged = fs.existsSync(CANCEL_LOG)
      ? fs.readFileSync(CANCEL_LOG, 'utf8').trim().split('\n').filter(Boolean) : [];
    check('R12: same-conn cancel reaches the upstream with a TRANSLATED id',
      logged.length === 1 && logged[0] !== '77' && /^[0-9]+$/.test(logged[0]) &&
      slowRes.result && Array.isArray(slowRes.result.contents));

    // R13: a cancel from a DIFFERENT connection - or with NO connection identity (HTTP-style) -
    // is DROPPED, never mistranslated onto someone else's call.
    const slowP2 = s.handleMessage(build4, { jsonrpc: '2.0', id: 78, method: 'resources/read',
      params: { uri: 'mock://upstream/slow', _meta: META } }, 'connA');
    await sleep(120);
    await s.handleMessage(build4, { jsonrpc: '2.0', method: 'notifications/cancelled',
      params: { requestId: 78 } }, 'connB');
    await s.handleMessage(build4, { jsonrpc: '2.0', method: 'notifications/cancelled',
      params: { requestId: 78 } });
    await sleep(120);
    await slowP2;
    const logged2 = fs.readFileSync(CANCEL_LOG, 'utf8').trim().split('\n').filter(Boolean);
    check('R13: foreign-conn and conn-less cancels are DROPPED', logged2.length === 1);

    // N3: armWrapChatter arms/disarms the cross-upstream filter straight from on-disk state -
    // boot, reload, and listen-first paths call it without waiting for a client message.
    build4.aggregator.wrapChatterUpstream = 'WRONG';
    s.armWrapChatter(build4);
    check('N3: armWrapChatter arms from state', build4.aggregator.wrapChatterUpstream === 'oldmcp');
    setPassthrough(STATE_PATH, null);
    s.armWrapChatter(build4);
    check('N3b: armWrapChatter disarms when unwrapped', build4.aggregator.wrapChatterUpstream === null);

    // N2: a wrap whose upstream NEVER connected must refuse modern requests neutrally - never
    // decorate a result with ToolFunnel's own serverInfo (the identity leak).
    const ghostHome = path.join(HOME, 'ghost');
    fs.mkdirSync(path.join(ghostHome, 'tools'), { recursive: true });
    const ghostState = path.join(ghostHome, 'tools', 'tools.state.json');
    fs.writeFileSync(ghostState, JSON.stringify({ passthrough: 'ghost' }));
    const { ExposeStore } = require('../src/mcp/expose-store.js');
    const { Aggregator } = require('../src/mcp/aggregator.js');
    const ghostStore = new ExposeStore({
      filePath: path.join(ghostHome, 'expose.json'),
      data: { version: 1, upstreams: [{ id: 'ghost', transport: 'stdio', command: process.execPath, args: ['-e', 'process.exit(1)'], enabled: true }], expose: [] },
    });
    const ghostAgg = new Aggregator({ store: ghostStore });
    await ghostAgg.connectAll(); // fails - that is the point
    const ghostBuild = { aggregator: ghostAgg, toolStatePath: ghostState };
    const ghostRes = await s.handleMessage(ghostBuild, { jsonrpc: '2.0', id: 90, method: 'tools/list', params: { _meta: META } });
    check('N2: never-connected wrap refuses modern requests with zero identity leak',
      ghostRes.error && ghostRes.error.code === -32603 && ghostRes.error.message === 'request failed' &&
      !/toolfunnel/i.test(JSON.stringify(ghostRes)));
    await ghostAgg.closeAll();

    if (build4.aggregator) await build4.aggregator.closeAll();
  } catch (err) {
    console.error('wrap.test.js CRASH:', (err && err.stack) || String(err));
    fails += 1;
  }

  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  if (fails === 0) console.log('wrap.test.js: all assertions passed');
  process.exit(fails === 0 ? 0 : 1);
})();
