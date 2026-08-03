'use strict';

/**
 * pagination.test.js - inbound tools/list pagination (0.7.0).
 *
 * 0.6.0's McpClient.listTools() is single-shot: a paginating upstream is silently truncated to
 * page 1 - its page-2 tools are undiscoverable in the lean list AND unrunnable ("not runnable"),
 * proven by execution 2026-07-30 (dev/round4/repro-forward-0.6.0.js, claim 4). This test is the
 * acceptance contract for the cursor loop:
 *
 *   1. sanity: a page-1 tool is discovered and runs (must hold before AND after the fix).
 *   2. the lean list surfaces the page-2 tools.
 *   3. a page-2 tool actually runs through toolfunnel_run_tool.
 *
 * Upstream: test/fixtures/servers/meta-upstream.js in TF_META_PAGINATE=1 mode (page 1 =
 * [meta_rich] + nextCursor, page 2 = [meta_plain, meta_error]). Runs the REAL gateway over stdio
 * with a scratch TOOLFUNNEL_HOME - repo config untouched.
 *
 * Exit 0 = pagination contract holds; 1 = truncation (the shipped 0.6.0 state); 2 = sanity broke.
 * CommonJS only. Node built-ins only.
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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-paginate-'));
for (const d of ['mcp', 'hooks', 'tools']) fs.mkdirSync(path.join(home, d), { recursive: true });
const fixtureCopy = path.join(home, 'mcp', 'meta-upstream.js');
fs.copyFileSync(META_FIXTURE, fixtureCopy);
fs.writeFileSync(path.join(home, 'mcp', 'expose.json'), JSON.stringify({
  version: 1,
  upstreams: [{
    id: 'metaup', transport: 'stdio', command: process.execPath, args: [fixtureCopy],
    env: { TF_META_PAGINATE: '1' }, enabled: true,
  }],
  expose: [],
}, null, 2) + '\n');
fs.writeFileSync(path.join(home, 'hooks', 'hooks.manifest.json'), JSON.stringify({ version: 1, hooks: [] }, null, 2) + '\n');
fs.writeFileSync(path.join(home, 'tools', 'tools.state.json'), '{}\n');

(async () => {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { TOOLFUNNEL_HOME: home, TF_META_PAGINATE: '1' }),
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
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for "${method}"`));
    }, 12000);
    pending.set(id, { resolve, timer });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
  });
  const textOf = (resp) => {
    const c = resp && resp.result && resp.result.content;
    return Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : '';
  };

  try {
    await request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'paginate-test', version: '0.0.0' },
    });

    // 1. sanity: page-1 tool discovered + runs (holds on 0.6.0 too - proves the fixture works).
    const lean = await request('tools/call', { name: 'toolfunnel_list_tools', arguments: {} });
    const leanText = textOf(lean);
    const p1run = await request('tools/call', {
      name: 'toolfunnel_run_tool', arguments: { name: 'metaup_meta_rich', args: { q: 'page1' } },
    });
    const p1ok = leanText.includes('metaup_meta_rich') && textOf(p1run).includes('rich answer for page1');
    check('sanity: page-1 tool is discovered and runs', p1ok,
      `lean has rich=${leanText.includes('metaup_meta_rich')}; run got: [${textOf(p1run).slice(0, 120)}]`);
    if (!p1ok) sanityBroke = true;

    // 2. the lean list surfaces the PAGE-2 tools.
    check('lean list surfaces page-2 tools', leanText.includes('metaup_meta_plain') && leanText.includes('metaup_meta_error'),
      `lean plain=${leanText.includes('metaup_meta_plain')} error=${leanText.includes('metaup_meta_error')} | ${leanText.slice(0, 200)}`);

    // 3. a page-2 tool RUNS.
    const p2run = await request('tools/call', {
      name: 'toolfunnel_run_tool', arguments: { name: 'metaup_meta_plain', args: {} },
    });
    check('page-2 tool runs through toolfunnel_run_tool', textOf(p2run).includes('plain answer'),
      `run got: [${textOf(p2run).slice(0, 160)}]`);
  } finally {
    try { child.stdin.end(); } catch (_e) { /* ignore */ }
    setTimeout(() => { try { child.kill(); } catch (_e) { /* ignore */ } }, 300);
  }

  console.log(fails ? `\n${fails} pagination failure(s).` : '\npagination contract holds.');
  process.exit(sanityBroke ? 2 : (fails ? 1 : 0));
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
