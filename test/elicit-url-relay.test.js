'use strict';

/**
 * elicit-url-relay.test.js - the 2025-11-25 URL-mode elicitation relay, end to end
 * (0.7.0 - built after the capability gating whose machinery it verifies).
 *
 * The audit's finding: mcp-client.js declares `capabilities: { elicitation: {} }` to legacy
 * upstreams - per the 2025-11-25 back-compat rule that is FORM MODE ONLY, and "Servers MUST
 * NOT send elicitation requests with modes that are not supported by the client". A conformant
 * URL-capable upstream is therefore FORBIDDEN from ever sending URL mode through the funnel:
 * 5.3's relay machinery is ready but structurally unreachable in the wild. The fixture now
 * enforces that MUST NOT (the conformance gate), so this test cannot pass vacuously:
 *
 *   1. url-capable modern caller -> ask: the CONFORMANT upstream elicits url mode and the call
 *      SUSPENDS with mode:"url" + url verbatim (RED on shipped declaration: the upstream
 *      refuses, the call completes with elicit-refused instead of suspending).
 *   2. MRTR resume with action:"accept": the InputResponse passes VERBATIM as the upstream's
 *      ElicitResult and the held call completes echoing it (the return leg of the relay).
 *   3. A19 rider: URL mode's SECOND delivery path - a raw -32042 URLElicitationRequiredError
 *      with data.elicitations - survives the wrap relay intact (code + elicitations list).
 *   4. Sanity pin: form mode still elicits under the gate (the gateway has ALWAYS declared
 *      bare `elicitation`, which IS the implicit form declaration) - distinguishes "url gap"
 *      from "gate broke everything".
 *
 * Wrapped gateways over scratch homes (meta-upstream TF_META_ELICIT=url|form, conformance-
 * gated). Exit 0 = the relay is live end to end; 1 = the wild-dead relay (shipped); 2 = sanity
 * broke. CommonJS. Node built-ins only.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const META_FIXTURE = path.join(__dirname, 'fixtures', 'servers', 'meta-upstream.js');

let fails = 0;
let sanityBroke = false;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

const meta = (caps) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': caps,
  'io.modelcontextprotocol/clientInfo': { name: 'elicit-url-relay-test', version: '0.0.0' },
});
const URL_CAPS = { elicitation: { form: {}, url: {} } };

function makeGateway(elicitMode) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-elurl-'));
  for (const d of ['mcp', 'hooks', 'tools']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const fixtureCopy = path.join(home, 'mcp', 'meta-upstream.js');
  fs.copyFileSync(META_FIXTURE, fixtureCopy);
  fs.writeFileSync(path.join(home, 'mcp', 'expose.json'), JSON.stringify({
    version: 1,
    upstreams: [{ id: 'metaup', transport: 'stdio', command: process.execPath, args: [fixtureCopy], env: { TF_META_ELICIT: elicitMode }, enabled: true }],
    expose: [],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(home, 'hooks', 'hooks.manifest.json'), JSON.stringify({ version: 1, hooks: [] }) + '\n');
  fs.writeFileSync(path.join(home, 'tools', 'tools.state.json'), JSON.stringify({ passthrough: 'metaup' }) + '\n');

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
      if (!line || line[0] !== '{') continue;
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
  const request = (method, params, ms) => new Promise((resolve, reject) => {
    const id = nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, ms || 20000);
    pending.set(id, { resolve, timer });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  });
  const close = () => {
    try { child.stdin.end(); } catch (_e) { /* ignore */ }
    setTimeout(() => { try { child.kill(); } catch (_e) { /* ignore */ } }, 300);
  };
  return { request, close };
}

const textOf = (r) => {
  const c = r && r.result && r.result.content;
  return Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : '';
};

(async () => {
  // ── URL-mode fixture, conformance-gated ─────────────────────────────────────────────────────
  const gwU = makeGateway('url');
  try {
    await gwU.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '0' } });

    // 1. THE ITEM: a CONFORMANT url upstream elicits through the funnel and the url-capable
    //    caller suspends. Red on shipped bytes: the gateway declared form-only at initialize,
    //    so the gated upstream refuses and the call completes without suspending.
    const s1 = await gwU.request('tools/call', { name: 'ask', arguments: {}, _meta: meta(URL_CAPS) });
    const sr1 = (s1 && s1.result) || {};
    const k1 = sr1.inputRequests ? Object.keys(sr1.inputRequests)[0] : null;
    const p1 = k1 ? sr1.inputRequests[k1].params : null;
    const suspended = sr1.resultType === 'input_required' && p1 && p1.mode === 'url' && p1.url === 'https://example.invalid/auth';
    check('conformant url upstream elicits + url-capable caller SUSPENDS (mode:"url", url verbatim)',
      suspended,
      JSON.stringify(sr1).slice(0, 280) + ' (shipped: gateway declares elicitation:{} = form-only, the upstream is FORBIDDEN from url mode)');

    // 2. The return leg: MRTR resume with accept -> the ElicitResult reaches the upstream
    //    VERBATIM and the held call completes echoing it.
    if (suspended) {
      const token = sr1.requestState;
      const s2 = await gwU.request('tools/call', {
        name: 'ask', arguments: {},
        requestState: token,
        inputResponses: { [k1]: { action: 'accept' } },
        _meta: meta(URL_CAPS),
      });
      const t2 = textOf(s2);
      check('MRTR accept relays VERBATIM to the upstream; held call completes with the echo',
        t2.includes('elicit-outcome:') && t2.includes('"action":"accept"'),
        JSON.stringify((s2 && s2.result) || s2).slice(0, 280));
    } else {
      check('MRTR accept relays VERBATIM to the upstream; held call completes with the echo',
        false, 'unreachable: no suspension to resume (check 1 red)');
    }

    // 3. A19 rider: the SECOND url delivery path (-32042 error, elicitations in data) survives
    //    the wrap relay - a direct-connection client completes the URL flow from exactly this.
    const s3 = await gwU.request('tools/call', { name: 'url_required', arguments: {}, _meta: meta(URL_CAPS) });
    const err3 = s3 && s3.error;
    const viaError = err3 && err3.code === -32042 && err3.data && Array.isArray(err3.data.elicitations)
      && err3.data.elicitations[0] && err3.data.elicitations[0].url === 'https://example.invalid/auth';
    // The relay may also surface as an isError result carrying the structured payload - accept
    // either envelope PROVIDED code + elicitations survive verbatim somewhere the caller can see.
    const raw3 = JSON.stringify(s3 || {});
    const viaResult = !viaError && raw3.includes('-32042') && raw3.includes('https://example.invalid/auth');
    check('-32042 URLElicitationRequiredError relays with data.elicitations intact (A19)',
      !!(viaError || viaResult), raw3.slice(0, 300));
    if (viaResult) console.log('  NOTE: modern caller sees the band translation (-32603 + data.upstreamCode:-32042, payload preserved) - open decision 4 shape: ' + raw3.slice(0, 200));
  } finally { gwU.close(); }

  // ── A19, legacy half: a 2025-11-25 caller gets the RAW -32042 verbatim (1.6 era-aware relay:
  //    for THIS caller's era the code is legal, and a direct-connection client completes the URL
  //    flow from exactly these bytes - any rewrap breaks it) ─────────────────────────────────────
  const gwL = makeGateway('url');
  try {
    await gwL.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '0' } });
    const s5 = await gwL.request('tools/call', { name: 'url_required', arguments: {} });
    const e5 = s5 && s5.error;
    check('legacy 2025-11-25 caller gets the RAW -32042 + data.elicitations VERBATIM',
      !!(e5 && e5.code === -32042 && e5.message === 'URL elicitation required'
        && e5.data && Array.isArray(e5.data.elicitations)
        && e5.data.elicitations[0] && e5.data.elicitations[0].url === 'https://example.invalid/auth'
        && e5.data.elicitations[0].mode === 'url'),
      JSON.stringify(s5 || {}).slice(0, 300));
  } finally { gwL.close(); }

  // ── FORM-mode fixture: the gate still lets the implicit-form declaration through ────────────
  const gwF = makeGateway('form');
  try {
    await gwF.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '0' } });
    const s4 = await gwF.request('tools/call', { name: 'ask', arguments: {}, _meta: meta({ elicitation: {} }) });
    const sr4 = (s4 && s4.result) || {};
    const k4 = sr4.inputRequests ? Object.keys(sr4.inputRequests)[0] : null;
    const s4ok = sr4.resultType === 'input_required' && k4 && sr4.inputRequests[k4].params.mode === 'form';
    check('sanity: form mode still elicits under the conformance gate (bare elicitation declared)',
      s4ok, JSON.stringify(sr4).slice(0, 240));
    if (!s4ok) sanityBroke = true;
  } finally { gwF.close(); }

  console.log(fails ? `\n${fails} url-relay failure(s).` : '\nURL-mode elicitation relays end to end.');
  process.exit(sanityBroke ? 2 : (fails ? 1 : 0));
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
