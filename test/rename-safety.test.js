'use strict';

/**
 * rename-safety.test.js - the naming-safety acceptance tests (0.7.0, two
 * bundled changes). RED BY DESIGN against 0.6.0: every scenario below was proven to fail against the
 * shipped release by execution on 2026-07-30.
 * The naming feature is DONE when this file goes green - not
 * when renaming works.
 *
 * The scenarios assert SAFETY INVARIANTS, not a fix mechanism, so they hold whichever migration
 * strategy ships (migrate-matchers-on-rename, refuse-while-gated, or re-key):
 *
 *   S1  a gated upstream tool NEVER runs ungated because its `as` alias changed.
 *   S2  a disabled upstream tool NEVER comes back because its `as` alias changed.
 *   S3  a gated LOCAL tool NEVER runs ungated because its register display name changed.
 *   S4  `enabled:false` actually prevents execution (tool-state.js's own contract:
 *       enabled = "LEAN-VISIBLE - surfaced by toolfunnel_list_tools AND runnable").
 *   S5  a disabled LOCAL tool NEVER comes back because its register display name changed
 *       (the local sibling of S2; added 2026-08-01, red against 8fbfe19 before the fix).
 *
 * Renames are performed through the STORE layer (ExposeStore.updateExpose / Registry.update) -
 * the layer every API caller funnels through and where the migration must live. Direct hand-edits
 * of the JSON files bypass any conceivable API-level fix and are out of scope (documented
 * at-your-own-risk, the same class as hand-editing .git internals).
 *
 * Exit codes: 0 = all invariants hold; 1 = invariant violated (EXPECTED on 0.6.0);
 *             2 = a BASELINE broke (the harness is wrong, not the code - fix the test).
 *
 * NON-DESTRUCTIVE: expose.json, hooks.manifest.json, tools.state.json, tools.register.json are
 * snapshotted up front and restored byte-for-byte (or re-absent) in `finally`, with the restore
 * ASSERTED. Modelled on test/proxy.test.js via dev/round4/repro-naming-0.6.0.js.
 * CommonJS only. Node built-ins only.
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'bin', 'toolfunnel.js');
const EXPOSE_PATH = path.join(REPO_ROOT, 'mcp', 'expose.json');
const MANIFEST_PATH = path.join(REPO_ROOT, 'hooks', 'hooks.manifest.json');
const STATE_PATH = path.join(REPO_ROOT, 'tools', 'tools.state.json');
const REGISTER_PATH = path.join(REPO_ROOT, 'tools', 'tools.register.json');
const MOCK_SERVER = path.join(REPO_ROOT, 'mcp', 'servers', 'mock-upstream', 'server.js');
const DENY_HOOK = path.join(REPO_ROOT, 'test', 'fixtures', 'scripts', 'deny-hook.js');

const { loadExposeStore } = require(path.join(REPO_ROOT, 'src', 'mcp', 'expose-store.js'));
const { loadRegistry } = require(path.join(REPO_ROOT, 'src', 'tools', 'registry.js'));

const REQUEST_TIMEOUT_MS = 45000; // a CEILING, not a wait - generous so a loaded CI box cannot flake it

// ── snapshot / restore ─────────────────────────────────────────────────────────────────────────
function snapshot(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_e) { return null; } }
function restore(p, snap) {
  try {
    if (snap === null) { if (fs.existsSync(p)) fs.unlinkSync(p); }
    else { fs.writeFileSync(p, snap); }
  } catch (_e) { /* best-effort */ }
}

// ── JSON-RPC-over-stdio client (write: Content-Length framing; read: newline-delimited) ────────
function makeClient(child) {
  let nextId = 1;
  let buf = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
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
      if (obj && Object.prototype.hasOwnProperty.call(obj, 'id') && pending.has(obj.id)) {
        const w = pending.get(obj.id);
        pending.delete(obj.id);
        clearTimeout(w.timer);
        w.resolve(obj);
      }
    }
  });
  function request(method, params) {
    const id = nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
    const byteLen = Buffer.byteLength(body, 'utf8');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for "${method}" (id ${id})`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`Content-Length: ${byteLen}\r\n\r\n${body}`);
    });
  }
  return { request };
}

async function withGateway(fn) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const client = makeClient(child);
  let exited = false;
  child.on('exit', () => { exited = true; });
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'rename-safety-test', version: '0.0.0' },
    });
    return await fn(client);
  } finally {
    try { child.stdin.end(); } catch (_e) { /* ignore */ }
    if (!exited && child.exitCode === null && !child.killed) {
      try { child.kill(); } catch (_e) { /* ignore */ }
    }
  }
}

function textOf(resp) {
  const c = resp && resp.result && resp.result.content;
  return Array.isArray(c) && c[0] && typeof c[0].text === 'string' ? c[0].text : '';
}
function isError(resp) { return !!(resp && resp.result && resp.result.isError === true); }
function listedNames(resp) {
  return ((resp.result && resp.result.tools) || []).map((t) => t && t.name);
}

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────
const OLD_AS = 'rt_ping';
const NEW_AS = 'rt_ping2';

function exposeConfig(asName) {
  return JSON.stringify({
    version: 1,
    upstreams: [{
      id: 'mockrepro', transport: 'stdio', command: process.execPath,
      args: [MOCK_SERVER], enabled: true, description: 'rename-safety fixture - bundled mock upstream.',
    }],
    expose: [
      { upstream: 'mockrepro', tool: 'ping', as: asName, category: 'test', enabled: true },
    ],
  }, null, 2) + '\n';
}
function denyManifest(matcher) {
  const hookPath = DENY_HOOK.split(path.sep).join('/');
  return JSON.stringify({
    version: 1,
    hooks: [{
      id: 'pre-tool-use/rename-safety-deny', event: 'PreToolUse', matcher,
      type: 'command', command: 'node "' + hookPath + '"', timeout: 10, enabled: true,
      description: 'rename-safety fixture: deny ' + matcher,
    }],
  }, null, 2) + '\n';
}
const EMPTY_MANIFEST = JSON.stringify({ version: 1, hooks: [] }, null, 2) + '\n';
const EMPTY_EXPOSE = JSON.stringify({ version: 1, upstreams: [], expose: [] }, null, 2) + '\n';

/** Rename the (mockrepro, ping) alias through the store layer - the migratable path. */
function renameUpstreamAs(newAs) {
  try {
    loadExposeStore(EXPOSE_PATH).updateExpose('mockrepro', 'ping', { as: newAs });
    return { refused: false, error: null };
  } catch (err) {
    // A refusal (0.7.0 may refuse renames while a non-literal gate matches) is a LEGITIMATE
    // safe outcome - the invariant assertions below handle both.
    return { refused: true, error: (err && err.message) || String(err) };
  }
}
/** Rename a register entry's display name through the store layer. */
function renameLocalName(id, newName) {
  try {
    loadRegistry(REGISTER_PATH).update(id, { name: newName });
    return { refused: false, error: null };
  } catch (err) {
    return { refused: true, error: (err && err.message) || String(err) };
  }
}

// ── report ────────────────────────────────────────────────────────────────────────────────────
const failures = [];   // invariant violations (expected on 0.6.0)
const broken = [];     // baseline breakage (the test itself is wrong)
function invariant(name, ok, evidence) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        ${evidence}`);
  if (!ok) failures.push({ name, evidence });
}
function baseline(name, ok, evidence) {
  console.log(`  ${ok ? 'ok' : 'BROKEN'}  [baseline] ${name}\n        ${evidence}`);
  if (!ok) broken.push({ name, evidence });
}

(async () => {
  const snaps = {
    expose: snapshot(EXPOSE_PATH),
    manifest: snapshot(MANIFEST_PATH),
    state: snapshot(STATE_PATH),
    register: snapshot(REGISTER_PATH),
  };
  let fatal = null;

  try {
    if (!fs.existsSync(MOCK_SERVER)) throw new Error('mock upstream missing: ' + MOCK_SERVER);
    if (!fs.existsSync(DENY_HOOK)) throw new Error('deny-hook fixture missing: ' + DENY_HOOK);

    // ════ S1 - a gated upstream tool NEVER runs ungated because its alias changed ═══════════
    console.log('\nS1: upstream rename must not orphan the PreToolUse gate');
    fs.writeFileSync(EXPOSE_PATH, exposeConfig(OLD_AS));
    fs.writeFileSync(MANIFEST_PATH, denyManifest(OLD_AS));
    fs.writeFileSync(STATE_PATH, JSON.stringify({}, null, 2) + '\n');

    const s1base = await withGateway(async (client) => {
      const r = await client.request('tools/call', { name: OLD_AS, arguments: {} });
      return { blocked: isError(r) && textOf(r) !== 'pong', raw: textOf(r).slice(0, 120) };
    });
    baseline('gate on current alias blocks the call', s1base.blocked, `got: [${s1base.raw}]`);

    const s1rename = renameUpstreamAs(NEW_AS);
    const s1 = await withGateway(async (client) => {
      const names = listedNames(await client.request('tools/list', {}));
      const surfaced = names.includes(NEW_AS) ? NEW_AS : (names.includes(OLD_AS) ? OLD_AS : null);
      if (!surfaced) return { surfaced: null };
      const r = await client.request('tools/call', { name: surfaced, arguments: {} });
      const other = surfaced === NEW_AS ? OLD_AS : NEW_AS;
      const ro = await client.request('tools/call', { name: other, arguments: {} });
      return {
        surfaced,
        surfacedBlocked: isError(r) && textOf(r) !== 'pong',
        surfacedRaw: textOf(r).slice(0, 120),
        otherReachedUpstream: textOf(ro) === 'pong',
      };
    });
    if (s1base.blocked) {
      invariant(
        'after a rename attempt, the surfaced tool is still gate-blocked',
        s1.surfaced !== null && s1.surfacedBlocked,
        `rename refused=${s1rename.refused}; surfaced=${s1.surfaced}; call got: [${s1.surfacedRaw}]`
      );
      invariant(
        'the non-surfaced alias cannot reach the upstream either',
        s1.surfaced !== null && !s1.otherReachedUpstream,
        `pong via retired alias=${s1.otherReachedUpstream}`
      );
    }

    // ════ S2 - a DISABLED upstream tool NEVER comes back because its alias changed ══════════
    console.log('\nS2: upstream rename must not resurrect a disabled tool');
    fs.writeFileSync(EXPOSE_PATH, exposeConfig(OLD_AS));
    fs.writeFileSync(MANIFEST_PATH, EMPTY_MANIFEST);
    fs.writeFileSync(STATE_PATH, JSON.stringify({ [OLD_AS]: { enabled: false } }, null, 2) + '\n');

    const s2base = await withGateway(async (client) => {
      const lean = await client.request('tools/call', { name: 'toolfunnel_list_tools', arguments: {} });
      return { hidden: !textOf(lean).includes(OLD_AS), raw: textOf(lean).slice(0, 80) };
    });
    baseline('disabled tool is lean-hidden pre-rename', s2base.hidden, `lean mentions ${OLD_AS}: ${!s2base.hidden}`);

    const s2rename = renameUpstreamAs(NEW_AS);
    const s2 = await withGateway(async (client) => {
      const lean = await client.request('tools/call', { name: 'toolfunnel_list_tools', arguments: {} });
      const leanText = textOf(lean);
      const names = listedNames(await client.request('tools/list', {}));
      const surfaced = names.includes(NEW_AS) ? NEW_AS : (names.includes(OLD_AS) ? OLD_AS : null);
      let executed = false;
      let execRaw = '(tool not advertised - not callable by name)';
      if (surfaced) {
        const r = await client.request('tools/call', { name: surfaced, arguments: {} });
        executed = textOf(r) === 'pong';
        execRaw = textOf(r).slice(0, 120);
      }
      return {
        leanMentionsEither: leanText.includes(OLD_AS) || leanText.includes(NEW_AS),
        surfaced, executed, execRaw,
      };
    });
    if (s2base.hidden) {
      invariant(
        'after a rename attempt, the disabled tool stays lean-hidden',
        !s2.leanMentionsEither,
        `rename refused=${s2rename.refused}; lean mentions an alias=${s2.leanMentionsEither}`
      );
      invariant(
        'after a rename attempt, the disabled tool still does not execute',
        !s2.executed,
        `surfaced=${s2.surfaced}; call got: [${s2.execRaw}]`
      );
    }

    // ════ S3 - a gated LOCAL tool NEVER runs ungated because its display name changed ═══════
    console.log('\nS3: local display-name rename must not orphan the gate (ships broken in 0.6.0)');
    fs.writeFileSync(EXPOSE_PATH, EMPTY_EXPOSE);
    fs.writeFileSync(MANIFEST_PATH, denyManifest('Echo'));
    fs.writeFileSync(STATE_PATH, JSON.stringify({}, null, 2) + '\n');

    const MARKER = 'GATE_CHECK_9c41';
    const runEcho = (client) => client.request('tools/call', {
      name: 'toolfunnel_run_tool', arguments: { name: 'echo', args: { marker: MARKER } },
    });

    const s3base = await withGateway(async (client) => {
      const r = await runEcho(client);
      return { blocked: !textOf(r).includes(MARKER), raw: textOf(r).slice(0, 160) };
    });
    baseline('gate on the display name blocks the local run', s3base.blocked, `got: [${s3base.raw}]`);

    const s3rename = renameLocalName('echo', 'Echo Renamed');
    const s3 = await withGateway(async (client) => {
      const r = await runEcho(client);
      return { blocked: !textOf(r).includes(MARKER), raw: textOf(r).slice(0, 160) };
    });
    if (s3base.blocked) {
      invariant(
        'after a local display-name rename attempt, the run is still gate-blocked',
        s3.blocked,
        `rename refused=${s3rename.refused}; run got: [${s3.raw}]`
      );
    }

    // ════ S4 - enabled:false must actually prevent execution (curated-direct) ═════
    console.log('\nS4: enabled:false must block the curated-direct call (tool-state contract: "AND runnable")');
    fs.writeFileSync(EXPOSE_PATH, exposeConfig(OLD_AS));
    fs.writeFileSync(MANIFEST_PATH, EMPTY_MANIFEST);
    fs.writeFileSync(STATE_PATH, JSON.stringify({}, null, 2) + '\n');

    const s4sanity = await withGateway(async (client) => {
      const r = await client.request('tools/call', { name: OLD_AS, arguments: {} });
      return { works: textOf(r) === 'pong', raw: textOf(r).slice(0, 120) };
    });
    baseline('enabled fixture tool executes (sanity)', s4sanity.works, `got: [${s4sanity.raw}]`);

    fs.writeFileSync(STATE_PATH, JSON.stringify({ [OLD_AS]: { enabled: false } }, null, 2) + '\n');
    const s4 = await withGateway(async (client) => {
      const lean = await client.request('tools/call', { name: 'toolfunnel_list_tools', arguments: {} });
      const r = await client.request('tools/call', { name: OLD_AS, arguments: {} });
      return {
        leanHidden: !textOf(lean).includes(OLD_AS),
        executed: textOf(r) === 'pong',
        raw: textOf(r).slice(0, 120),
      };
    });
    if (s4sanity.works) {
      invariant('disabled tool is lean-hidden', s4.leanHidden, `lean mentions ${OLD_AS}: ${!s4.leanHidden}`);
      invariant(
        'disabled tool does NOT execute',
        !s4.executed,
        `call got: [${s4.raw}]`
      );
    }
    // ════ S5 - a DISABLED LOCAL tool NEVER comes back because its display name changed ══════
    // The local sibling of S2. Per-tool state lives in TWO key namespaces: an upstream tool's
    // entry is keyed by its SURFACED name (server.js:638,733), a LOCAL tool's by its register ID
    // (server.js:290,337,814 / ui:326 / tf-tool-set) - and an id does NOT change when the display
    // name does. tf_list is used because it ships with name === id (10 of the 17 bundled tools do,
    // every tf_* management tool), which is exactly the shape where the two namespaces collide.
    console.log('\nS5: local display-name rename must not resurrect a disabled tool');
    restore(REGISTER_PATH, snaps.register); // undo S3's rename - S5 needs the shipped display name
    fs.writeFileSync(EXPOSE_PATH, EMPTY_EXPOSE);
    fs.writeFileSync(MANIFEST_PATH, EMPTY_MANIFEST);
    fs.writeFileSync(STATE_PATH, JSON.stringify({ tf_list: { enabled: false } }, null, 2) + '\n');

    // A real tf_list run lists the register; 'tf_wrap' appears in that output and in no refusal.
    const RAN = 'tf_wrap';
    const runTfList = (client, name) => client.request('tools/call', {
      name: 'toolfunnel_run_tool', arguments: { name, args: { kind: 'tools' } },
    });

    const s5base = await withGateway(async (client) => {
      const lean = await client.request('tools/call', { name: 'toolfunnel_list_tools', arguments: {} });
      const r = await runTfList(client, 'tf_list');
      return {
        leanHidden: !textOf(lean).includes('tf_list'),
        executed: textOf(r).includes(RAN),
        raw: textOf(r).slice(0, 160),
      };
    });
    baseline('disabled local tool is lean-hidden pre-rename', s5base.leanHidden,
      `lean mentions tf_list: ${!s5base.leanHidden}`);
    baseline('disabled local tool does not run pre-rename', !s5base.executed, `got: [${s5base.raw}]`);

    const NEW_LOCAL_NAME = 'Tool Inventory';
    const s5rename = renameLocalName('tf_list', NEW_LOCAL_NAME);
    const s5 = await withGateway(async (client) => {
      const lean = await client.request('tools/call', { name: 'toolfunnel_list_tools', arguments: {} });
      const leanText = textOf(lean);
      const byId = await runTfList(client, 'tf_list');
      const byName = await runTfList(client, NEW_LOCAL_NAME);
      return {
        leanMentionsEither: leanText.includes('tf_list') || leanText.includes(NEW_LOCAL_NAME),
        ranById: textOf(byId).includes(RAN),
        ranByName: textOf(byName).includes(RAN),
        idRaw: textOf(byId).slice(0, 160),
        nameRaw: textOf(byName).slice(0, 160),
      };
    });
    if (s5base.leanHidden && !s5base.executed) {
      invariant(
        'after a local display-name rename, the disabled tool stays lean-hidden',
        !s5.leanMentionsEither,
        `rename refused=${s5rename.refused}; lean mentions a name=${s5.leanMentionsEither}`
      );
      invariant(
        'after a local display-name rename, the disabled tool still does not run by id',
        !s5.ranById,
        `run got: [${s5.idRaw}]`
      );
      invariant(
        'after a local display-name rename, the disabled tool still does not run by its new name',
        !s5.ranByName,
        `run got: [${s5.nameRaw}]`
      );
    }
  } catch (err) {
    fatal = err;
  } finally {
    restore(EXPOSE_PATH, snaps.expose);
    restore(MANIFEST_PATH, snaps.manifest);
    restore(STATE_PATH, snaps.state);
    restore(REGISTER_PATH, snaps.register);
  }

  // ── verdict ─────────────────────────────────────────────────────────────────────────────────
  const restoredOk =
    snapshot(EXPOSE_PATH) === snaps.expose &&
    snapshot(MANIFEST_PATH) === snaps.manifest &&
    snapshot(STATE_PATH) === snaps.state &&
    snapshot(REGISTER_PATH) === snaps.register;

  console.log('\n══ rename-safety verdict ═════════════════════════════════════════════════');
  console.log(`config restore: ${restoredOk ? 'OK (byte-for-byte)' : 'MISMATCH - CHECK CONFIG FILES'}`);
  if (fatal) {
    console.log('FATAL (harness): ' + (fatal.stack || fatal));
    process.exit(2);
  }
  if (broken.length || !restoredOk) {
    console.log(`BASELINE BROKEN (${broken.length}) - the test is wrong, not the code.`);
    process.exit(2);
  }
  if (failures.length) {
    console.log(`${failures.length} invariant violation(s) - EXPECTED on 0.6.0; the 0.7.0 naming work makes this green.`);
    process.exit(1);
  }
  console.log('all rename-safety invariants hold.');
  process.exit(0);
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
