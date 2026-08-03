'use strict';

/**
 * elicit-caps.test.js - elicitation capability gating + mode completion (0.7.0, three pieces).
 *
 *   5.1 The caller's declared clientCapabilities threads EXPLICITLY to every suspension
 *       decision (no silent default).
 *   5.2 A modern caller that did NOT declare the matching elicitation capability takes the
 *       EXISTING auto-decline branch (no new error channel): the upstream's held call completes
 *       with the declined outcome instead of an input_required suspension. Form mode needs bare
 *       `elicitation` presence (the schema's implicit-form example); URL mode needs the
 *       explicit `elicitation.url`.
 *   5.3 The mode injection is url-aware: a bare pre-MRTR question keeps `mode:"form"`; a
 *       url-carrying question with no mode is completed with the REQUIRED `mode:"url"` -
 *       never stamped `form` onto a contradiction (the old comment claiming form's mode was
 *       REQUIRED was false - schema: `mode?: "form"`).
 *
 * Two wrapped gateways over scratch homes (meta-upstream TF_META_ELICIT=form|url). Legacy
 * decline stays covered by wrap-wire. Exit 0 = gating holds; 1 = suspend-for-anyone (shipped);
 * 2 = sanity broke. CommonJS. Node built-ins only.
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
  'io.modelcontextprotocol/clientInfo': { name: 'elicit-caps-test', version: '0.0.0' },
});

function makeGateway(elicitMode) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-elcaps-'));
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
  // ── FORM-mode fixture ───────────────────────────────────────────────────────────────────────
  const gwF = makeGateway('form');
  try {
    await gwF.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '0' } });

    // 1. SANITY: declared `elicitation: {}` -> SUSPENDS with mode:"form" kept.
    const s1 = await gwF.request('tools/call', { name: 'ask', arguments: {}, _meta: meta({ elicitation: {} }) });
    const sr = s1.result || {};
    const key = sr.inputRequests ? Object.keys(sr.inputRequests)[0] : null;
    const s1ok = sr.resultType === 'input_required' && key && sr.inputRequests[key].params.mode === 'form';
    check('sanity: declared-elicitation caller SUSPENDS (form, mode injected)', s1ok, JSON.stringify(sr).slice(0, 220));
    if (!s1ok) sanityBroke = true;

    // 2. RED: capability-LESS modern caller -> NO suspension; the auto-declined outcome returns.
    const s2 = await gwF.request('tools/call', { name: 'ask', arguments: {}, _meta: meta({}) });
    const t2 = textOf(s2);
    check('capability-less modern caller: auto-declined, held call completes (no input_required)',
      (s2.result && s2.result.resultType !== 'input_required') && /elicit-outcome:.*decline/.test(t2),
      JSON.stringify(s2.result).slice(0, 240) + ' (0.6.0 suspends for ANY modern caller)');
  } finally { gwF.close(); }

  // ── URL-mode fixture ────────────────────────────────────────────────────────────────────────
  const gwU = makeGateway('url');
  try {
    await gwU.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '0' } });

    // 3. RED: form-only caller (bare elicitation:{}) facing a URL question -> declined.
    const s3 = await gwU.request('tools/call', { name: 'ask', arguments: {}, _meta: meta({ elicitation: {} }) });
    check('form-only caller facing a URL-mode question: auto-declined',
      (s3.result && s3.result.resultType !== 'input_required') && /elicit-outcome:.*decline/.test(textOf(s3)),
      JSON.stringify(s3.result).slice(0, 240));

    // 4. RED: url-capable caller -> SUSPENDS, and the relayed params are completed with the
    //    REQUIRED mode:"url" (never form stamped onto a url question).
    const s4 = await gwU.request('tools/call', { name: 'ask', arguments: {}, _meta: meta({ elicitation: { form: {}, url: {} } }) });
    const sr4 = s4.result || {};
    const k4 = sr4.inputRequests ? Object.keys(sr4.inputRequests)[0] : null;
    const p4 = k4 ? sr4.inputRequests[k4].params : null;
    check('url-capable caller SUSPENDS; params completed with mode:"url" + url verbatim',
      sr4.resultType === 'input_required' && p4 && p4.mode === 'url' && p4.url === 'https://example.invalid/auth',
      JSON.stringify(sr4).slice(0, 260));
  } finally { gwU.close(); }

  console.log(fails ? `\n${fails} elicit-caps failure(s).` : '\nelicitation capability gating holds.');
  process.exit(sanityBroke ? 2 : (fails ? 1 : 0));
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
