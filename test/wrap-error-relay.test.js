'use strict';

/**
 * wrap-error-relay.test.js - upstream ERROR fidelity (0.7.0: fix the relay, not the promise).
 *
 * The README promises a wrap delivers "identity, tools, results, errors, and notifications"
 * byte-for-byte. A wire audit measured `errors` as false: a raw JSON-RPC error from the wrapped
 * upstream (code + message + data) reached the caller as a fixed `tool "X" failed` text result.
 * McpClient already preserves the verbatim error as `err.rpcError` (mcp-client.js) - the server
 * side never read it. This test IS the contract for the fix:
 *
 *   A. wrap + LEGACY caller  -> the upstream's JSON-RPC error relays VERBATIM (code -32011,
 *      message, structured data - all byte-identical).
 *   B. wrap + MODERN caller  -> same fidelity, era-shaped: 2026-07-28 forbids emitting
 *      implementation-band codes it does not define (basic-index.mdx:122-127), so the code is
 *      re-minted -32603 with the original preserved as data.upstreamCode/upstreamData.
 *      (-32002 specifically maps to -32602, the replacement the spec itself names.)
 *   C. FUNNEL (curated-direct) + legacy caller -> stays an isError RESULT (funnel-honest tool
 *      failure), but message, code AND the structured data all survive in the text.
 *   D. regression guard: a successful wrapped call still returns the upstream envelope verbatim.
 *
 * Runs the REAL gateway over REAL stdio with scratch TOOLFUNNEL_HOMEs - the repo config is never
 * touched. Upstream: test/fixtures/servers/meta-upstream.js (tool `meta_error` answers a raw
 * JSON-RPC error: code -32011, rich message, data {detail, hint}).
 *
 * Exit 0 = relay contract holds. Exit 1 = fidelity failures (the shipped 0.6.0 state).
 * CommonJS only. Node built-ins only.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const META_FIXTURE = path.join(__dirname, 'fixtures', 'servers', 'meta-upstream.js');

const MODERN = '2026-07-28';
const META_V = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';

const FIXTURE_CODE = -32011;
const FIXTURE_MESSAGE = 'fixture upstream error: the upstream explains exactly what went wrong';
const FIXTURE_DATA = { detail: 'STRUCTURED_DETAIL_77aa', hint: 'this object must survive the relay' };

let fails = 0;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

function makeHome(tag, { passthrough }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `tf-relay-${tag}-`));
  for (const d of ['mcp', 'hooks', 'tools']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const fixtureCopy = path.join(home, 'mcp', 'meta-upstream.js');
  fs.copyFileSync(META_FIXTURE, fixtureCopy);
  fs.writeFileSync(path.join(home, 'mcp', 'expose.json'), JSON.stringify({
    version: 1,
    upstreams: [{ id: 'metaup', transport: 'stdio', command: process.execPath, args: [fixtureCopy], enabled: true }],
    expose: passthrough ? [] : [
      { upstream: 'metaup', tool: 'meta_error', as: 'metaup_meta_error', category: 'test', enabled: true },
      { upstream: 'metaup', tool: 'meta_plain', as: 'metaup_meta_plain', category: 'test', enabled: true },
    ],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(home, 'hooks', 'hooks.manifest.json'), JSON.stringify({ version: 1, hooks: [] }, null, 2) + '\n');
  fs.writeFileSync(path.join(home, 'tools', 'tools.state.json'),
    JSON.stringify(passthrough ? { passthrough: 'metaup' } : {}, null, 2) + '\n');
  return home;
}

function withGateway(home, fn) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { TOOLFUNNEL_HOME: home }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buf = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stderr.on('data', () => {});
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_e) { continue; }
      if (obj && obj.id !== undefined && pending.has(obj.id)) {
        const w = pending.get(obj.id);
        pending.delete(obj.id);
        clearTimeout(w.timer);
        w.resolve(obj);
      }
    }
  });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    const body = JSON.stringify(msg);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for "${method}"`));
    }, 12000);
    pending.set(id, { resolve, timer });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  });
  const done = (async () => fn(request))();
  return done.finally(() => {
    try { child.stdin.end(); } catch (_e) { /* ignore */ }
    setTimeout(() => { try { child.kill(); } catch (_e) { /* ignore */ } }, 300);
  });
}

const textOf = (resp) => {
  const c = resp && resp.result && resp.result.content;
  return Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : '';
};

(async () => {
  // ── A + B + D: under a WRAP ─────────────────────────────────────────────────────────────────
  const wrapHome = makeHome('wrap', { passthrough: true });
  await withGateway(wrapHome, async (request) => {
    await request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'relay-test', version: '0.0.0' },
    });

    // D first (sanity): a good call still relays the envelope verbatim.
    const ok = await request('tools/call', { name: 'meta_plain', arguments: {} });
    check('D: wrapped success envelope verbatim', textOf(ok) === 'plain answer', JSON.stringify(ok).slice(0, 200));

    // A: LEGACY caller - the upstream's raw JSON-RPC error relays byte-for-byte.
    const legacy = await request('tools/call', { name: 'meta_error', arguments: {} });
    const le = legacy && legacy.error;
    check('A1: legacy wrap relay is a JSON-RPC ERROR (not a result envelope)', !!le,
      JSON.stringify(legacy).slice(0, 200));
    check('A2: code relays verbatim (' + FIXTURE_CODE + ')', !!le && le.code === FIXTURE_CODE,
      JSON.stringify(le && le.code));
    check('A3: message relays verbatim', !!le && le.message === FIXTURE_MESSAGE,
      JSON.stringify(le && le.message));
    check('A4: structured data relays verbatim', !!le && JSON.stringify(le.data) === JSON.stringify(FIXTURE_DATA),
      JSON.stringify(le && le.data));

    // B: MODERN caller - same fidelity, era-shaped (implementation-band code re-minted -32603,
    // original preserved in data).
    const modern = await request('tools/call', {
      name: 'meta_error', arguments: {},
      _meta: { [META_V]: MODERN, [META_CAPS]: {} },
    });
    const me = modern && modern.error;
    check('B1: modern wrap relay is a JSON-RPC ERROR', !!me, JSON.stringify(modern).slice(0, 200));
    check('B2: modern code is spec-clean -32603 (band code not emitted)', !!me && me.code === -32603,
      JSON.stringify(me && me.code));
    check('B3: message relays verbatim', !!me && me.message === FIXTURE_MESSAGE,
      JSON.stringify(me && me.message));
    check('B4: original code preserved as data.upstreamCode', !!me && me.data && me.data.upstreamCode === FIXTURE_CODE,
      JSON.stringify(me && me.data));
    check('B5: original data preserved as data.upstreamData',
      !!me && me.data && me.data.upstreamData && me.data.upstreamData.detail === FIXTURE_DATA.detail,
      JSON.stringify(me && me.data));
  });

  // ── C: FUNNEL (curated-direct) ──────────────────────────────────────────────────────────────
  const funnelHome = makeHome('funnel', { passthrough: false });
  await withGateway(funnelHome, async (request) => {
    await request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'relay-test', version: '0.0.0' },
    });
    const r = await request('tools/call', { name: 'metaup_meta_error', arguments: {} });
    const isErr = !!(r && r.result && r.result.isError === true);
    const text = textOf(r);
    check('C1: funnel upstream error stays an isError RESULT', isErr, JSON.stringify(r).slice(0, 200));
    check('C2: message survives in the text', text.includes('the upstream explains exactly what went wrong'), text.slice(0, 220));
    check('C3: code survives in the text', text.includes(String(FIXTURE_CODE)), text.slice(0, 220));
    check('C4: structured data survives in the text', text.includes('STRUCTURED_DETAIL_77aa'), text.slice(0, 220));
  });

  console.log(fails ? `\n${fails} relay fidelity failure(s).` : '\nerror relay contract holds.');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
