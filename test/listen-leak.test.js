'use strict';

/**
 * listen-leak.test.js - listen cancellation + the refcounted per-URI subscription release
 * (0.7.0).
 *
 * 0.6.0 forwards resources/subscribe for every listen-agreed URI but NEVER releases: the
 * re-listen replaces the registration in place (old URIs leak), the stdio teardown closes
 * wholesale (releases nothing), the HTTP stream close releases nothing, and a
 * notifications/cancelled naming a listen id is explicitly excluded. The upstream keeps
 * emitting updates nobody can receive, forever. The fix: listen-owned refcounts in the
 * aggregator (subscribe on 0->1, resources/unsubscribe on 1->0) released at all three sites +
 * the cancel honoured (silently, per the no-further-messages rule).
 *
 * Upstream: meta-upstream TF_META_RES=1 - subscribe-capable, RECORDS every subscribe/
 * unsubscribe into TF_SUBS_LOG (observable across teardown). Wrap mode (the chatter scope the
 * subscription machinery serves). One stdio gateway + one HTTP gateway.
 *
 * Exit 0 = released everywhere; 1 = the shipped leak; 2 = sanity broke. CommonJS.
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

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'listen-leak-test', version: '0.0.0' },
};

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-listenleak-'));
  for (const d of ['mcp', 'hooks', 'tools']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const fixtureCopy = path.join(home, 'mcp', 'meta-upstream.js');
  fs.copyFileSync(META_FIXTURE, fixtureCopy);
  const subsLog = path.join(home, 'subs.log');
  fs.writeFileSync(path.join(home, 'mcp', 'expose.json'), JSON.stringify({
    version: 1,
    upstreams: [{
      id: 'metaup', transport: 'stdio', command: process.execPath, args: [fixtureCopy],
      env: { TF_META_RES: '1', TF_SUBS_LOG: subsLog }, enabled: true,
    }],
    expose: [],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(home, 'hooks', 'hooks.manifest.json'), JSON.stringify({ version: 1, hooks: [] }) + '\n');
  fs.writeFileSync(path.join(home, 'tools', 'tools.state.json'), JSON.stringify({ passthrough: 'metaup' }) + '\n');
  return { home, subsLog };
}
const logOf = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (_e) { return ''; } };
const waitLog = (p, pred, ms) => new Promise((resolve) => {
  const t0 = Date.now();
  (function poll() {
    const t = logOf(p);
    if (pred(t)) return resolve(t);
    if (Date.now() - t0 > ms) return resolve(t);
    setTimeout(poll, 200);
  })();
});

(async () => {
  // ── stdio: subscribe -> re-listen release -> cancel release ─────────────────────────────────
  const A = makeHome();
  {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: REPO_ROOT,
      env: Object.assign({}, process.env, { TOOLFUNNEL_HOME: A.home }),
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
    const send = (o) => {
      const body = JSON.stringify(o);
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
    };
    const request = (o, ms) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(o.id); reject(new Error('timeout id ' + o.id)); }, ms || 20000);
      pending.set(o.id, { resolve, timer });
      send(o);
    });

    try {
      await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '0' } } });

      // 1. SANITY: listen agreeing uri A -> upstream subscribe recorded. NOTE the listen ack is
      // a NOTIFICATION (notifications/subscriptions/acknowledged, subscriptionId in _meta), not
      // a JSON-RPC response - measured 2026-07-30 and pinned in the goldens. So we fire and
      // observe the upstream side, never await a reply to the listen id.
      send({ jsonrpc: '2.0', id: 500, method: 'subscriptions/listen', params: {
        notifications: { resourceSubscriptions: ['meta://res/a'] }, _meta: META,
      } });
      const t1 = await waitLog(A.subsLog, (t) => t.includes('subscribe meta://res/a'), 12000);
      const s1ok = t1.includes('subscribe meta://res/a');
      check('sanity: listen-agreed uri subscribed upstream', s1ok, 'log=[' + t1.trim() + ']');
      if (!s1ok) sanityBroke = true;

      // 2. RED: re-listen on the SAME id with a different uri -> the OLD uri is RELEASED.
      send({ jsonrpc: '2.0', id: 500, method: 'subscriptions/listen', params: {
        notifications: { resourceSubscriptions: ['meta://res/b'] }, _meta: META,
      } });
      const t2 = await waitLog(A.subsLog, (t) => t.includes('unsubscribe meta://res/a'), 8000);
      check('re-listen releases the replaced registration\'s uri (leak site #3)',
        t2.includes('unsubscribe meta://res/a') && t2.includes('subscribe meta://res/b'),
        'log=[' + t2.trim() + '] (0.6.0 replaces in place, never unsubscribes)');

      // 3. RED: notifications/cancelled naming the LISTEN id -> honoured, uri B released.
      send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 500 } });
      const t3 = await waitLog(A.subsLog, (t) => t.includes('unsubscribe meta://res/b'), 8000);
      check('cancel on a listen id is HONOURED - the subscription releases (was excluded)',
        t3.includes('unsubscribe meta://res/b'), 'log=[' + t3.trim() + ']');
    } finally {
      try { child.stdin.end(); } catch (_e) { /* ignore */ }
      setTimeout(() => { try { child.kill(); } catch (_e) { /* ignore */ } }, 400);
    }
  }

  // ── HTTP: closing the listen stream releases (leak site #2) ─────────────────────────────────
  const B = makeHome();
  {
    const child = spawn(process.execPath, [ENTRY, '--http', '--port', '0'], {
      cwd: REPO_ROOT,
      env: Object.assign({}, process.env, { TOOLFUNNEL_HOME: B.home }),
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
      check('HTTP host bound a port', Number.isInteger(port), errBuf.slice(0, 200));
      if (Number.isInteger(port)) {
        // Wait for the wrapped upstream (the listen agreement needs canHonourResourceSubscriptions).
        await waitLog(B.subsLog, () => false, 3000); // grace for connect
        const body = JSON.stringify({ jsonrpc: '2.0', id: 700, method: 'subscriptions/listen', params: {
          notifications: { resourceSubscriptions: ['meta://res/c'] }, _meta: META,
        } });
        await new Promise((resolve) => {
          const req = http.request({
            host: '127.0.0.1', port, method: 'POST', path: '/mcp',
            headers: {
              'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body, 'utf8'),
              Accept: 'text/event-stream',
              'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'subscriptions/listen',
            },
          }, (res) => {
            res.setEncoding('utf8');
            res.on('data', () => {});
            // Destroy the stream shortly after the ack starts flowing - the disconnect IS the release signal.
            setTimeout(() => { try { res.destroy(); } catch (_e) { /* ignore */ } resolve(); }, 1200);
          });
          req.on('error', () => resolve());
          req.write(body);
          req.end();
        });
        const tC = await waitLog(B.subsLog, (t) => t.includes('unsubscribe meta://res/c'), 10000);
        check('closing the HTTP listen stream releases its uris (leak site #2)',
          tC.includes('subscribe meta://res/c') && tC.includes('unsubscribe meta://res/c'),
          'log=[' + tC.trim() + '] (0.6.0 cleanup released nothing)');
      }
    } finally {
      try { child.stdin.end(); } catch (_e) { /* ignore */ }
      setTimeout(() => { try { child.kill(); } catch (_e) { /* ignore */ } }, 400);
    }
  }

  console.log(fails ? `\n${fails} listen-leak failure(s).` : '\nsubscription lifecycle holds (refcounted release).');
  process.exit(sanityBroke ? 2 : (fails ? 1 : 0));
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
