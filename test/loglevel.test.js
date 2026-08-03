'use strict';

/**
 * loglevel.test.js - era-aware logLevel restore across the wrap (0.7.0).
 *
 * 0.6.0 strips EVERY `io.modelcontextprotocol/*` key from forwarded `_meta` and re-injects only
 * the protocol trio - `logLevel` is dropped. The modern severity clause (2026-07-28
 * schema.ts:100-104) obliges an upstream to WITHHOLD notifications/message when the field is
 * absent, so a modern client through a wrap gets no log notifications where a direct connection
 * would. The fix is era-keyed, owned by the McpClient (the era boundary):
 *
 *   - MODERN upstream -> the caller's logLevel rides the forwarded `_meta` verbatim.
 *   - LEGACY upstream -> the key NEVER leaks (no legacy schema defines it); if the upstream
 *     declared the `logging` capability, it is translated to `logging/setLevel` issued BEFORE
 *     the main request (stdio ordering is the proof), deduped per distinct level.
 *   - LEGACY upstream WITHOUT the logging capability -> no setLevel, no leak (over-reach guard).
 *
 * Upstream: test/fixtures/servers/meta-upstream.js in TF_META_LOGLEVEL / TF_META_MODERN modes.
 * Three gateway spawns (real stdio, scratch TOOLFUNNEL_HOME, wrap armed via tools.state.json):
 *   A. legacy upstream + logging capability   B. legacy upstream, no capability   C. modern upstream
 *
 * Exit 0 = restore works era-keyed; 1 = the shipped 0.6.0 strip; 2 = sanity broke.
 * CommonJS. Node built-ins only.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const META_FIXTURE = path.join(__dirname, 'fixtures', 'servers', 'meta-upstream.js');
const LOG_LEVEL_KEY = 'io.modelcontextprotocol/logLevel';

let fails = 0;
let sanityBroke = false;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

/** The per-request _meta a modern caller sends (stdio: no headers). */
function modernMeta(extra) {
  return Object.assign({
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'loglevel-test', version: '0.0.0' },
  }, extra || {});
}

/** Spawn one gateway over a scratch home wrapping the fixture with the given env. */
function makeGateway(fixtureEnv) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-loglevel-'));
  for (const d of ['mcp', 'hooks', 'tools']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const fixtureCopy = path.join(home, 'mcp', 'meta-upstream.js');
  fs.copyFileSync(META_FIXTURE, fixtureCopy);
  fs.writeFileSync(path.join(home, 'mcp', 'expose.json'), JSON.stringify({
    version: 1,
    upstreams: [{
      id: 'metaup', transport: 'stdio', command: process.execPath, args: [fixtureCopy],
      env: fixtureEnv, enabled: true,
    }],
    expose: [],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(home, 'hooks', 'hooks.manifest.json'), JSON.stringify({ version: 1, hooks: [] }, null, 2) + '\n');
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
  const close = () => {
    try { child.stdin.end(); } catch (_e) { /* ignore */ }
    setTimeout(() => { try { child.kill(); } catch (_e) { /* ignore */ } }, 300);
  };
  return { request, close };
}

/** Parse meta_echo's text payload -> { receivedMeta, setLevels } (null on any shape surprise). */
function echoOf(resp) {
  const c = resp && resp.result && resp.result.content;
  const text = Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : '';
  try { return JSON.parse(text); } catch (_e) { return null; }
}

const protocolKeys = (meta) => Object.keys(meta || {}).filter((k) => k.startsWith('io.modelcontextprotocol/'));

/** Call the wrapped meta_echo as a MODERN caller, with optional logLevel. */
async function callEcho(gw, logLevel) {
  const extra = logLevel === undefined ? {} : { [LOG_LEVEL_KEY]: logLevel };
  return echoOf(await gw.request('tools/call', {
    name: 'meta_echo', arguments: {}, _meta: modernMeta(extra),
  }));
}

(async () => {
  // ── A. LEGACY upstream WITH the logging capability ──────────────────────────────────────────
  const gwA = makeGateway({ TF_META_LOGLEVEL: '1' });
  try {
    // A1. SANITY: no logLevel -> no setLevel, no protocol-key leak. Must hold before AND after.
    const a1 = await callEcho(gwA);
    const a1ok = a1 && a1.receivedMeta !== undefined && protocolKeys(a1.receivedMeta).length === 0 &&
      Array.isArray(a1.setLevels) && a1.setLevels.length === 0;
    check('A1 sanity: no logLevel -> no setLevel, no io.modelcontextprotocol/* leak', a1ok,
      'echo=' + JSON.stringify(a1));
    if (!a1ok) sanityBroke = true;

    // A2. RED: logLevel "debug" -> logging/setLevel("debug") issued BEFORE the call; key never leaks.
    const a2 = await callEcho(gwA, 'debug');
    check('A2 legacy+cap: logLevel translates to logging/setLevel BEFORE the call',
      a2 && Array.isArray(a2.setLevels) && a2.setLevels.length === 1 && a2.setLevels[0] === 'debug',
      'setLevels=' + JSON.stringify(a2 && a2.setLevels) + ' (0.6.0 strips logLevel and sends nothing)');
    check('A2 legacy+cap: the modern key never leaks to the legacy upstream',
      a2 && protocolKeys(a2.receivedMeta).length === 0,
      'receivedMeta=' + JSON.stringify(a2 && a2.receivedMeta));

    // A3. Dedup: the SAME level again -> no second setLevel.
    const a3 = await callEcho(gwA, 'debug');
    check('A3 legacy+cap: repeated level is deduped (one setLevel total)',
      a3 && Array.isArray(a3.setLevels) && a3.setLevels.length === 1,
      'setLevels=' + JSON.stringify(a3 && a3.setLevels));

    // A4. A DIFFERENT level -> a second setLevel.
    const a4 = await callEcho(gwA, 'error');
    check('A4 legacy+cap: a changed level issues a fresh setLevel',
      a4 && JSON.stringify(a4.setLevels) === '["debug","error"]',
      'setLevels=' + JSON.stringify(a4 && a4.setLevels));

    // A5. RAW forward (forwardWrapped path): x/echo-meta with logLevel "critical" + an app key.
    const a5resp = await gwA.request('x/echo-meta', {
      probe: 1, _meta: modernMeta({ [LOG_LEVEL_KEY]: 'critical', 'myapp/trace': 'T1' }),
    });
    const a5 = a5resp && a5resp.result;
    check('A5 raw forward: setLevel issued for the raw method too',
      a5 && JSON.stringify(a5.setLevels) === '["debug","error","critical"]',
      'setLevels=' + JSON.stringify(a5 && a5.setLevels));
    check('A5 raw forward: app _meta keys survive, protocol keys do not',
      a5 && a5.receivedMeta && a5.receivedMeta['myapp/trace'] === 'T1' && protocolKeys(a5.receivedMeta).length === 0,
      'receivedMeta=' + JSON.stringify(a5 && a5.receivedMeta));
  } finally { gwA.close(); }

  // ── B. LEGACY upstream WITHOUT the logging capability (over-reach guard) ────────────────────
  const gwB = makeGateway({ TF_META_LOGLEVEL: 'nocap' });
  try {
    const b1 = await callEcho(gwB, 'debug');
    check('B1 legacy no-cap: logLevel present -> NO setLevel attempted, no leak',
      b1 && Array.isArray(b1.setLevels) && b1.setLevels.length === 0 && protocolKeys(b1.receivedMeta).length === 0,
      'echo=' + JSON.stringify(b1));
  } finally { gwB.close(); }

  // ── C. MODERN upstream: logLevel rides the forwarded _meta verbatim ─────────────────────────
  const gwC = makeGateway({ TF_META_LOGLEVEL: '1', TF_META_MODERN: '1' });
  try {
    const c1 = await callEcho(gwC, 'warning');
    check('C1 modern upstream: logLevel is restored into the forwarded _meta',
      c1 && c1.receivedMeta && c1.receivedMeta[LOG_LEVEL_KEY] === 'warning',
      'receivedMeta=' + JSON.stringify(c1 && c1.receivedMeta) + ' (0.6.0 strips it; the trio re-injection does not include logLevel)');
    check('C1 modern upstream: no logging/setLevel (not modern vocabulary)',
      c1 && Array.isArray(c1.setLevels) && c1.setLevels.length === 0,
      'setLevels=' + JSON.stringify(c1 && c1.setLevels));

    const c2resp = await gwC.request('x/echo-meta', { probe: 1, _meta: modernMeta({ [LOG_LEVEL_KEY]: 'info' }) });
    const c2 = c2resp && c2resp.result;
    check('C2 modern raw forward: logLevel present in the forwarded _meta',
      c2 && c2.receivedMeta && c2.receivedMeta[LOG_LEVEL_KEY] === 'info',
      'receivedMeta=' + JSON.stringify(c2 && c2.receivedMeta));
  } finally { gwC.close(); }

  console.log(fails ? `\n${fails} logLevel failure(s).` : '\nlogLevel restore holds, era-keyed.');
  process.exit(sanityBroke ? 2 : (fails ? 1 : 0));
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
