'use strict';

/**
 * metadata-forwarding.test.js - upstream tool metadata reaches the ADVERTISED funnel defs
 * (0.7.0; every legacy golden movement it causes is signed in the ledger item by item).
 *
 * 0.6.0 projects funnel defs to {name, description, inputSchema} at three non-peer sites - a
 * curated-direct or hot-promoted tool advertises BARE while a direct connection (and the wrap,
 * fixed 2026-07-17) shows title/annotations/outputSchema/_meta. The pass:
 *
 *   - SELECTIVE-ADD of title / annotations / outputSchema / _meta / execution - never a spread
 *     (lean defs carry internal upstream/tool routing ids that must not reach the wire).
 *   - ICONS WITHHELD (a conservative, reversible call - the decision is documented open): both
 *     2025-11-25 and 2026-07-28 require icon consumers to verify icon URIs are SAME-ORIGIN
 *     with the server - icons forwarded by a gateway are third-party URLs every conforming
 *     client must reject, or worse trust as ours. Adding them later is non-breaking.
 *   - 3.8 coupling: advertising outputSchema makes conforming structuredContent a live MUST -
 *     both advertised paths (curated-direct + hot) must return it un-flattened.
 *   - meta_plain is the control: selective-add must never INVENT fields on a bare def.
 *
 * Two gateway spawns over scratch homes (curated-direct home; hot-promotion home), fixture =
 * test/fixtures/servers/meta-upstream.js (default mode - the goldens' own fixture).
 *
 * Exit 0 = metadata forwarded + coupled; 1 = the bare 0.6.0 projection; 2 = sanity broke.
 * CommonJS. Node built-ins only.
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

function makeGateway(o) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-metafwd-'));
  for (const d of ['mcp', 'hooks', 'tools']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const fixtureCopy = path.join(home, 'mcp', 'meta-upstream.js');
  fs.copyFileSync(META_FIXTURE, fixtureCopy);
  fs.writeFileSync(path.join(home, 'mcp', 'expose.json'), JSON.stringify({
    version: 1,
    upstreams: [{ id: 'metaup', transport: 'stdio', command: process.execPath, args: [fixtureCopy], env: o.env || {}, enabled: true }],
    expose: o.expose || [],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(home, 'hooks', 'hooks.manifest.json'), JSON.stringify({ version: 1, hooks: [] }) + '\n');
  fs.writeFileSync(path.join(home, 'tools', 'tools.state.json'), JSON.stringify(o.state || {}) + '\n');
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
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 12000);
    pending.set(id, { resolve, timer });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  });
  const close = () => {
    try { child.stdin.end(); } catch (_e) { /* ignore */ }
    setTimeout(() => { try { child.kill(); } catch (_e) { /* ignore */ } }, 300);
  };
  return { request, close };
}

const defOf = (resp, name) => ((resp.result && resp.result.tools) || []).find((t) => t && t.name === name);
const hasRichMeta = (d) => !!(d && d.title === 'Meta Rich Tool' && d.annotations &&
  d.annotations.readOnlyHint === true && d.outputSchema && d.outputSchema.properties &&
  d.outputSchema.properties.answer && d._meta &&
  d._meta['fixture.meta-upstream/marker'] === 'RICH_TOOL_META_d41c' &&
  d.execution && d.execution.taskSupport === 'optional');
const noLeaks = (d) => !!(d && d.icons === undefined && d.upstream === undefined && d.tool === undefined);

(async () => {
  // ── Home A: CURATED-DIRECT (expose entries advertise top-level) ─────────────────────────────
  const gwA = makeGateway({
    expose: [
      { upstream: 'metaup', tool: 'meta_rich', as: 'rich_direct', enabled: true },
      { upstream: 'metaup', tool: 'meta_plain', as: 'plain_direct', enabled: true },
    ],
  });
  try {
    await gwA.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'metafwd', version: '0' } });
    const list = await gwA.request('tools/list', {});
    const rich = defOf(list, 'rich_direct');
    const plain = defOf(list, 'plain_direct');
    const sane = !!(rich && plain);
    check('sanity: both curated-direct tools advertised', sane,
      'names=' + JSON.stringify(((list.result || {}).tools || []).map((t) => t.name)));
    if (!sane) sanityBroke = true;

    // RED on 0.6.0 (bare {name,description,inputSchema} projection):
    check('curated-direct def carries title/annotations/outputSchema/_meta', hasRichMeta(rich),
      'def=' + JSON.stringify(rich));
    check('curated-direct def withholds icons and leaks no internal ids', noLeaks(rich),
      'def=' + JSON.stringify(rich));
    check('control: bare upstream def gains NO invented metadata',
      plain && plain.title === undefined && plain.annotations === undefined &&
        plain.outputSchema === undefined && plain._meta === undefined && noLeaks(plain),
      'def=' + JSON.stringify(plain));

    // 3.8 coupling: the advertised outputSchema binds - structuredContent must survive.
    const call = await gwA.request('tools/call', { name: 'rich_direct', arguments: { q: 'coupling' } });
    const sc = call.result && call.result.structuredContent;
    check('3.8: curated-direct call returns conforming structuredContent (not flattened)',
      sc && sc.answer === 'rich answer for coupling' && typeof sc.count === 'number',
      'result=' + JSON.stringify(call.result).slice(0, 200));
  } finally { gwA.close(); }

  // ── Home B: HOT-PROMOTED lean tool (state hot:true, no expose entry) ────────────────────────
  const gwB = makeGateway({ state: { metaup_meta_rich: { hot: true } } });
  try {
    await gwB.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'metafwd', version: '0' } });
    const list = await gwB.request('tools/list', {});
    const rich = defOf(list, 'metaup_meta_rich');
    const sane = !!rich;
    check('sanity: hot-promoted tool advertised', sane,
      'names=' + JSON.stringify(((list.result || {}).tools || []).map((t) => t.name)));
    if (!sane) sanityBroke = true;

    check('hot-promoted def carries title/annotations/outputSchema/_meta', hasRichMeta(rich),
      'def=' + JSON.stringify(rich));
    check('hot-promoted def withholds icons and leaks no internal ids', noLeaks(rich),
      'def=' + JSON.stringify(rich));

    const call = await gwB.request('tools/call', { name: 'metaup_meta_rich', arguments: { q: 'hot' } });
    const sc = call.result && call.result.structuredContent;
    check('3.8: hot call returns conforming structuredContent',
      sc && sc.answer === 'rich answer for hot' && typeof sc.count === 'number',
      'result=' + JSON.stringify(call.result).slice(0, 200));
  } finally { gwB.close(); }

  // ── Home C: RESULT-side _meta (3.10, funnel half) - app keys forward, identity keys strip ───
  const gwC = makeGateway({
    expose: [{ upstream: 'metaup', tool: 'meta_rich', as: 'rich_direct', enabled: true }],
    env: { TF_META_RESULTMETA: '1' },
  });
  try {
    await gwC.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'metafwd', version: '0' } });
    const call = await gwC.request('tools/call', { name: 'rich_direct', arguments: { q: 'rm' } });
    const meta = call.result && call.result._meta;
    check('3.10: upstream result _meta APP key survives the funnel',
      meta && meta['fixture.meta-upstream/result-marker'] === 'RESULT_META_e55b',
      'result=' + JSON.stringify(call.result).slice(0, 220));
    check('3.10: upstream protocol-identity _meta key is STRIPPED (the funnel owns its identity)',
      !meta || meta['io.modelcontextprotocol/serverInfo'] === undefined ||
        (meta['io.modelcontextprotocol/serverInfo'].name !== 'meta-upstream-imposter'),
      '_meta=' + JSON.stringify(meta));
  } finally { gwC.close(); }

  console.log(fails ? `\n${fails} metadata-forwarding failure(s).` : '\nmetadata forwarding holds.');
  process.exit(sanityBroke ? 2 : (fails ? 1 : 0));
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
