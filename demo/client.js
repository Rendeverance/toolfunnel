#!/usr/bin/env node
'use strict';

/**
 * demo/client.js — a REAL MCP client for the demo recording (and for anyone who wants proof).
 *
 * What it does, visibly and honestly:
 *   1. copies demo/home to a TEMP config home (so a demo run never dirties the repo),
 *   2. spawns the real gateway (`node bin/toolfunnel.js --config-dir <tmp>`) over stdio,
 *   3. speaks actual MCP JSON-RPC: initialize → tools/list → tools/call,
 *   4. prints what any MCP client would see: THEIR server name, THEIR tools, a live result.
 *
 * `--denied` adds the gate beat: call the destructive tool, show the server-side deny.
 *
 * Node built-ins only. Run from the repo root:  node demo/client.js [--denied]
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEMO_HOME = path.join(__dirname, 'home');
const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else if (e.isFile()) fs.copyFileSync(from, to);
  }
}

(async () => {
  const wantDenied = process.argv.includes('--denied');

  // 1. A throwaway copy of the demo home — the repo stays pristine.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'toolfunnel-demo-'));
  copyDir(DEMO_HOME, home);

  // 2. The real gateway, exactly as a client config would launch it.
  const child = spawn(process.execPath, [ENTRY, '--config-dir', home], {
    cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });

  let buf = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_e) { continue; }
      if (obj && pending.has(obj.id)) { pending.get(obj.id)(obj); pending.delete(obj.id); }
    }
  });
  function rpc(method, params) {
    const id = nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout: ' + method)), 15000);
      pending.set(id, (o) => { clearTimeout(t); resolve(o); });
      child.stdin.write(body + '\n');
    });
  }
  const textOf = (r) => {
    const c = r && r.result && r.result.content;
    return Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : '';
  };

  try {
    // 3. The MCP conversation.
    const init = await rpc('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'demo-client', version: '1.0.0' },
    });
    const si = (init.result && init.result.serverInfo) || {};
    console.log(`${dim('initialize        →')} ${bold(si.name)} ${si.version}`);

    const list = await rpc('tools/list', {});
    const tools = (list.result && list.result.tools) || [];
    console.log(`${dim('tools/list        →')} ${tools.length} tools`);
    for (const t of tools) {
      console.log(`   ${cyan(String(t.name).padEnd(11))} ${dim(t.description || '')}`);
    }
    console.log(`   ${dim('(no toolfunnel_* meta-tools — hidden by config, not code)')}`);

    const call = await rpc('tools/call', {
      name: 'slugify', arguments: { text: 'Zero Code, Zero Dependencies!' },
    });
    const out = JSON.parse(textOf(call));
    const slug = out && typeof out.stdout === 'string' ? JSON.parse(out.stdout.trim()) : null;
    console.log(`${dim('tools/call slugify →')} ${green('"' + slug + '"')}`);

    if (wantDenied) {
      const denied = await rpc('tools/call', { name: 'cleanup', arguments: { path: 'build/' } });
      const msg = textOf(denied);
      const isErr = !!(denied.result && denied.result.isError);
      console.log(`${dim('tools/call cleanup →')} ${isErr ? red('DENIED') : 'allowed?!'} ${dim(msg.slice(0, 80))}`);
      console.log(`   ${dim('(a PreToolUse policy hook — enforced SERVER-side, travels with the pack)')}`);
    }

    console.log(green('✓') + bold(' a real MCP server — zero code written, zero dependencies installed'));
  } catch (err) {
    console.error('demo failed: ' + ((err && err.message) || err));
    process.exitCode = 1;
  } finally {
    try { child.stdin.end(); } catch (_e) { /* ignore */ }
    try { child.kill(); } catch (_e) { /* ignore */ }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
})();
