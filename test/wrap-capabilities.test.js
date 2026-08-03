'use strict';

/**
 * wrap-capabilities.test.js - the wrap honours what it advertises (0.7.0, the
 * verify-before-shipping item made executable).
 *
 * Under a wrap the upstream's capabilities are presented VERBATIM and ToolFunnel answers for
 * them: every namespace the upstream declares (resources / prompts / completions / tasks) must
 * behave as it would on a direct connection. The raw relay (forwardWrapped) covers the request
 * side by construction - these checks are the RECEIPTS. The verification FOUND one hole:
 * `notifications/tasks/status` (2025-11-25 schema.ts:1495-1497) was dropped by the notification
 * bridge - a client that started a task through the wrap never saw its status change, while the
 * wrap advertised `tasks` verbatim. The fix relays it like the other wrap-chatter methods
 * (wrapped upstream only).
 *
 * Upstream: test/fixtures/servers/meta-upstream.js in TF_META_CAPS=1 mode. Real gateway over
 * stdio, scratch TOOLFUNNEL_HOME, wrap armed. Under a wrap the handshake echoes the UPSTREAM's
 * version (2024-11-05 here) whatever the client requested - the wrap branch is deliberately
 * untouched this release (v5 2.1); the capability spread is what the item verifies.
 *
 * Exit 0 = wrap honours its advertisement; 1 = a namespace is broken (tasks/status drop =
 * the shipped 0.6.0 state); 2 = sanity broke. CommonJS. Node built-ins only.
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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-wrapcaps-'));
for (const d of ['mcp', 'hooks', 'tools']) fs.mkdirSync(path.join(home, d), { recursive: true });
const fixtureCopy = path.join(home, 'mcp', 'meta-upstream.js');
fs.copyFileSync(META_FIXTURE, fixtureCopy);
fs.writeFileSync(path.join(home, 'mcp', 'expose.json'), JSON.stringify({
  version: 1,
  upstreams: [{
    id: 'metaup', transport: 'stdio', command: process.execPath, args: [fixtureCopy],
    env: { TF_META_CAPS: '1' }, enabled: true,
  }],
  expose: [],
}, null, 2) + '\n');
fs.writeFileSync(path.join(home, 'hooks', 'hooks.manifest.json'), JSON.stringify({ version: 1, hooks: [] }, null, 2) + '\n');
fs.writeFileSync(path.join(home, 'tools', 'tools.state.json'), JSON.stringify({ passthrough: 'metaup' }) + '\n');

(async () => {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { TOOLFUNNEL_HOME: home }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buf = '';
  const pending = new Map();
  const notifications = [];
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
      } else if (obj && obj.method && obj.id === undefined) {
        notifications.push(obj);
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
  const waitForNotification = (method, ms) => new Promise((resolve) => {
    const t0 = Date.now();
    const poll = () => {
      const hit = notifications.find((n) => n.method === method);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) return resolve(null);
      setTimeout(poll, 100);
    };
    poll();
  });

  try {
    // 1. SANITY + capability honesty: the handshake presents the upstream's capabilities
    //    VERBATIM (tasks included). The wrap branch echoes the UPSTREAM's version (2024-11-05
    //    from the fixture) regardless of the request - v5 2.1 explicitly leaves that branch
    //    alone this release ("upstream-controlled today"), so that IS the expected answer.
    const init = await request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'wrapcaps-test', version: '0.0.0' },
    });
    const caps = init && init.result && init.result.capabilities;
    const initOk = init && init.result && init.result.serverInfo &&
      init.result.serverInfo.name === 'meta-upstream' && init.result.protocolVersion === '2024-11-05';
    check('sanity: wrap handshake presents the upstream identity at the UPSTREAM version (wrap branch untouched)', initOk,
      JSON.stringify(init && init.result).slice(0, 200));
    if (!initOk) sanityBroke = true;
    check('capabilities presented VERBATIM: resources+prompts+completions+tasks all advertised',
      caps && caps.resources && caps.resources.subscribe === true && caps.prompts &&
        caps.completions && caps.tasks && caps.tools,
      'capabilities = ' + JSON.stringify(caps));

    // 2. The RECEIPTS: each advertised namespace's representative method forwards verbatim.
    const res = await request('resources/list', {});
    check('resources/list forwards to the upstream (advertised -> honoured)',
      res && res.result && Array.isArray(res.result.resources) &&
        res.result.resources[0] && /CAP_RES_5f1/.test(res.result.resources[0].name || ''),
      JSON.stringify(res).slice(0, 200));

    const pr = await request('prompts/list', {});
    check('prompts/list forwards to the upstream',
      pr && pr.result && Array.isArray(pr.result.prompts) &&
        pr.result.prompts[0] && /CAP_PROMPT_5f2/.test(pr.result.prompts[0].description || ''),
      JSON.stringify(pr).slice(0, 200));

    const co = await request('completion/complete', {
      ref: { type: 'ref/prompt', name: 'fixture_prompt' }, argument: { name: 'a', value: 'x' },
    });
    check('completion/complete forwards to the upstream',
      co && co.result && co.result.completion && Array.isArray(co.result.completion.values) &&
        co.result.completion.values[0] === 'CAP_COMPLETION_5f3',
      JSON.stringify(co).slice(0, 200));

    const tl = await request('tasks/list', {});
    check('tasks/list forwards to the upstream',
      tl && tl.result && Array.isArray(tl.result.tasks) && tl.result.tasks[0] &&
        tl.result.tasks[0].taskId === 'task-77',
      JSON.stringify(tl).slice(0, 200));

    // 3. RED on 0.6.0: the upstream's notifications/tasks/status reaches the client through the
    //    wrap. A direct connection would deliver it; the wrap advertised `tasks` - it owes this.
    const trig = await request('x/emit-task-status', {});
    check('trigger method answered (fixture emitted the status notification)',
      trig && trig.result && trig.result.emitted === true, JSON.stringify(trig).slice(0, 160));
    const statusNote = await waitForNotification('notifications/tasks/status', 6000);
    check('notifications/tasks/status relayed through the wrap',
      statusNote && statusNote.params && statusNote.params.taskId === 'task-77' &&
        statusNote.params.status === 'completed',
      'received: ' + JSON.stringify(statusNote) + ' (0.6.0 notification bridge drops it - not in BRIDGED_NOTIFICATIONS, not wrap-chatter)');
  } finally {
    try { child.stdin.end(); } catch (_e) { /* ignore */ }
    setTimeout(() => { try { child.kill(); } catch (_e) { /* ignore */ } }, 300);
  }

  console.log(fails ? `\n${fails} wrap-capability failure(s).` : '\nthe wrap honours its advertisement.');
  process.exit(sanityBroke ? 2 : (fails ? 1 : 0));
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
