'use strict';

/**
 * xmcp-header.test.js - x-mcp-header parameter mirroring: server validation + ingest hygiene
 * (0.7.0; streamable-http.mdx:355-430 + 580-608).
 *
 *   - Server Validation MUST: a PRESENT `Mcp-Param-{name}` header (named by the advertised
 *     def's x-mcp-header annotation) must match the body argument at the annotated path -
 *     mismatch -> 400 + -32020. Values decode through the 4.2 sentinel first. Absent headers
 *     pass (mirroring is the CLIENT's obligation; the server MUST is about present-but-wrong -
 *     the split-source-of-truth failure). Unknown Mcp-Param-* headers are ignored (lenient).
 *   - The numeric note (42.0 == 42) is a SHOULD - scoped OUT (v5 rider); primitives compare
 *     via canonical String().
 *   - INGEST: an upstream def whose annotation violates the constraints (on a `number` param;
 *     off a pure `properties` chain) would make every conforming client DROP the whole tool -
 *     the gateway strips the INVALID annotations on the way in and keeps the tool usable.
 *
 * Spawned gateway (--http) over a scratch home; upstream = meta-upstream.js TF_META_XMCP=1.
 * Exit 0 = validation + hygiene hold; 1 = the shipped ignore-everything; 2 = sanity broke.
 * CommonJS. Node built-ins only.
 */

const fs = require('node:fs');
const http = require('node:http');
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

const b64 = (s) => '=?base64?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'xmcp-test', version: '0.0.0' },
};

function request(port, headers, body, method, urlPath) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers || {});
    if (body != null) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(body, 'utf8');
    }
    const req = http.request({ host: '127.0.0.1', port, method: method || 'POST', path: urlPath || '/mcp', headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_e) { /* non-JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-xmcp-'));
  for (const d of ['mcp', 'hooks', 'tools']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const fixtureCopy = path.join(home, 'mcp', 'meta-upstream.js');
  fs.copyFileSync(META_FIXTURE, fixtureCopy);
  fs.writeFileSync(path.join(home, 'mcp', 'expose.json'), JSON.stringify({
    version: 1,
    upstreams: [{ id: 'metaup', transport: 'stdio', command: process.execPath, args: [fixtureCopy], env: { TF_META_XMCP: '1' }, enabled: true }],
    expose: [
      { upstream: 'metaup', tool: 'hdr_tool', as: 'hdr_direct', enabled: true },
      { upstream: 'metaup', tool: 'hdr_bad', as: 'hdr_bad_direct', enabled: true },
    ],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(home, 'hooks', 'hooks.manifest.json'), JSON.stringify({ version: 1, hooks: [] }) + '\n');
  fs.writeFileSync(path.join(home, 'tools', 'tools.state.json'), '{}\n');

  const child = spawn(process.execPath, [ENTRY, '--http', '--port', '0'], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { TOOLFUNNEL_HOME: home }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let errBuf = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { errBuf += d; });
  child.stdout.on('data', () => {});

  try {
    const port = await new Promise((resolve) => {
      const t0 = Date.now();
      (function poll() {
        const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(errBuf);
        if (m) return resolve(Number(m[1]));
        if (Date.now() - t0 > 15000) return resolve(null);
        setTimeout(poll, 150);
      })();
    });
    check('host bound a port', Number.isInteger(port), errBuf.slice(0, 200));
    if (!Number.isInteger(port)) { sanityBroke = true; throw new Error('no port'); }

    const callBody = (name, args, id) => JSON.stringify({
      jsonrpc: '2.0', id: id || 1, method: 'tools/call', params: { name, arguments: args, _meta: META },
    });
    const baseHdr = (name) => ({ 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': name });

    // Wait for the upstream connect to settle (curated call answers).
    {
      const t0 = Date.now();
      for (;;) {
        const r = await request(port, baseHdr('hdr_direct'), callBody('hdr_direct', { region: 'us-w' }));
        if (r.json && r.json.result && JSON.stringify(r.json.result).includes('hdr-args')) break;
        if (Date.now() - t0 > 20000) { sanityBroke = true; break; }
        await new Promise((res) => setTimeout(res, 500));
      }
    }

    // 1. SANITY: matching Mcp-Param header -> served.
    const r1 = await request(port,
      Object.assign(baseHdr('hdr_direct'), { 'Mcp-Param-Region': 'us-west1' }),
      callBody('hdr_direct', { region: 'us-west1' }));
    const r1ok = r1.status === 200 && r1.json && r1.json.result && JSON.stringify(r1.json.result).includes('us-west1');
    check('sanity: matching Mcp-Param-Region passes and the tool runs', r1ok, `status=${r1.status} body=${r1.text.slice(0, 160)}`);
    if (!r1ok) sanityBroke = true;

    // 2. RED: PRESENT-but-mismatching Mcp-Param header -> 400 + -32020 (the MUST).
    const r2 = await request(port,
      Object.assign(baseHdr('hdr_direct'), { 'Mcp-Param-Region': 'eu-north1' }),
      callBody('hdr_direct', { region: 'us-west1' }));
    check('mismatching Mcp-Param-Region -> 400 HeaderMismatch (split-source-of-truth guard)',
      r2.status === 400 && r2.json && r2.json.error && r2.json.error.code === -32020,
      `status=${r2.status} body=${r2.text.slice(0, 180)} (0.6.0 ignores Mcp-Param entirely)`);

    // 3. Sentinel-encoded Mcp-Param decodes before comparison (4.2 composition).
    const r3 = await request(port,
      Object.assign(baseHdr('hdr_direct'), { 'Mcp-Param-Region': b64('us-west1') }),
      callBody('hdr_direct', { region: 'us-west1' }));
    check('sentinel-encoded Mcp-Param decodes then matches',
      r3.status === 200 && r3.json && r3.json.result, `status=${r3.status} body=${r3.text.slice(0, 160)}`);

    // 4. Integer param: canonical String comparison ("42" vs 42). (42.0==42 is the scoped-out SHOULD.)
    const r4 = await request(port,
      Object.assign(baseHdr('hdr_direct'), { 'Mcp-Param-Count': '42' }),
      callBody('hdr_direct', { region: 'x', count: 42 }));
    check('integer Mcp-Param-Count "42" matches body 42',
      r4.status === 200 && r4.json && r4.json.result, `status=${r4.status} body=${r4.text.slice(0, 160)}`);
    const r4b = await request(port,
      Object.assign(baseHdr('hdr_direct'), { 'Mcp-Param-Count': '43' }),
      callBody('hdr_direct', { region: 'x', count: 42 }));
    check('integer Mcp-Param-Count "43" vs body 42 -> 400',
      r4b.status === 400 && r4b.json && r4b.json.error && r4b.json.error.code === -32020,
      `status=${r4b.status} body=${r4b.text.slice(0, 160)}`);

    // 5. Absent Mcp-Param headers pass (mirroring is the client's MUST, not presence-enforced here).
    const r5 = await request(port, baseHdr('hdr_direct'), callBody('hdr_direct', { region: 'anywhere' }));
    check('absent Mcp-Param headers pass', r5.status === 200 && r5.json && r5.json.result, `status=${r5.status}`);

    // 6. Unknown Mcp-Param-* header ignored (lenient).
    const r6 = await request(port,
      Object.assign(baseHdr('hdr_direct'), { 'Mcp-Param-Nonsense': 'zzz' }),
      callBody('hdr_direct', { region: 'q' }));
    check('unknown Mcp-Param header ignored', r6.status === 200 && r6.json && r6.json.result, `status=${r6.status}`);

    // 7. RED (ingest hygiene): the INVALID annotations are STRIPPED from the advertised def -
    //    the tool survives (clients would otherwise drop it whole).
    const tl = await request(port,
      { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' },
      JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: { _meta: META } }));
    const defs = (tl.json && tl.json.result && tl.json.result.tools) || [];
    const bad = defs.find((t) => t.name === 'hdr_bad_direct');
    const badStr = JSON.stringify(bad || {});
    check('invalid annotations stripped at ingest (number param + off-chain items)',
      bad && !badStr.includes('x-mcp-header'),
      'def=' + badStr.slice(0, 240));
    const good = defs.find((t) => t.name === 'hdr_direct');
    check('valid annotations SURVIVE ingest (clients need them to mirror)',
      good && JSON.stringify(good).includes('"x-mcp-header":"Region"'),
      'def=' + JSON.stringify(good || {}).slice(0, 240));
  } finally {
    try { child.stdin.end(); } catch (_e) { /* ignore */ }
    setTimeout(() => { try { child.kill(); } catch (_e) { /* ignore */ } }, 300);
  }

  console.log(fails ? `\n${fails} x-mcp-header failure(s).` : '\nx-mcp-header validation + hygiene hold.');
  process.exit(sanityBroke ? 2 : (fails ? 1 : 0));
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
