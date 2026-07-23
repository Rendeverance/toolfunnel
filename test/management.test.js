'use strict';

/**
 * management.test.js - proves the first-party MANAGEMENT register functions
 * round-trip through the GATED path and leave real config byte-for-byte untouched.
 *
 * The management capabilities (category "management") are NOT new MCP-protocol
 * commands - they are first-party register entries discovered via
 * toolfunnel_list_tools and executed via toolfunnel_run_tool through the PreToolUse
 * gate. This test drives EXACTLY that path:
 *
 *     const build = buildProtocol();                       // real wiring
 *     build.protocol.dispatch('toolfunnel_run_tool', { name, args })   // the gate
 *
 * A fresh buildProtocol() is used for every dispatch so each read reflects the
 * CURRENT on-disk config (the register/manifest/expose stores the management
 * scripts mutate from a child process), and so the gate proof's freshly-added
 * PreToolUse hook is actually loaded into the engine that runs the blocked call.
 *
 * Assertions (the task contract):
 *   1. tools/list (protocol.toolDefinitions) includes toolfunnel_run_tool;
 *      toolfunnel_list_tools({category:'management'}) returns all 10 management tools.
 *   2. TOOLS  : tf_tool_add -> list shows it -> disable hides it -> enable shows it -> remove drops it.
 *   3. MCP    : tf_mcp_add -> list shows it -> disable -> enable -> remove (config only; nothing spawned).
 *   4. HOOKS  : tf_hook_add (PostToolUse) -> list shows it -> disable -> enable -> remove.
 *   5. GATE   : a PreToolUse deny hook matching tf_tool_add ⇒ a gated tf_tool_add is
 *               BLOCKED (ok:false) AND the register file is UNCHANGED. (Load-bearing.)
 *   6. RESTORE: every config file is restored from the pre-test snapshot and the
 *               tf_list inventory (all kinds) matches the captured baseline.
 *
 * Sacrificial ids are all prefixed "__tf_test_". The four config files
 * (tools.register.json, tools.state.json, mcp/expose.json, hooks.manifest.json) plus
 * hooks.state.json are SNAPSHOTTED up front and RESTORED in a finally, so a failure
 * mid-flight still leaves the real config exactly as it was found.
 *
 * Convention (matches the sibling tests): a standalone node script, exit 0 = pass,
 * non-zero = fail. Node built-ins only (node:assert, node:fs, node:path).
 *
 * Run:  node test/management.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildProtocol } = require(path.join(__dirname, '..', 'src', 'mcp', 'server.js'));

const ROOT = path.resolve(__dirname, '..');

// The config stores the management functions own. hooks.state.json may not exist
// up front - it is created the first time a hook is toggled - so it is snapshotted
// as "absent" and DELETED again on restore.
const CONFIG_FILES = [
  path.join(ROOT, 'tools', 'tools.register.json'),
  path.join(ROOT, 'tools', 'tools.state.json'),
  path.join(ROOT, 'mcp', 'expose.json'),
  path.join(ROOT, 'hooks', 'hooks.manifest.json'),
  path.join(ROOT, 'hooks', 'hooks.state.json'),
];

// Any sacrificial hook script the gate proof authors under hooks/scripts - cleaned
// up alongside the config restore (snapshot/restore covers JSON, not script files).
const DENY_SCRIPT = path.join(ROOT, 'hooks', 'scripts', '__tf_test_deny.js');

// The nine management register ids (category "management").
const MGMT_IDS = ['tf_tool_add', 'tf_tool_set', 'tf_mcp_add', 'tf_mcp_set', 'tf_hook_add', 'tf_hook_set', 'tf_list', 'tf_log', 'tf_pack', 'tf_wrap'];

// A self-denying PreToolUse hook body (mirrors test/fixtures/scripts/deny-hook.js):
// reads stdin, prints the JSON protocol permissionDecision:"deny" on exit 0.
const DENY_BODY = [
  "'use strict';",
  'let raw = "";',
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (c) => { raw += c; });",
  "process.stdin.on('end', () => {",
  '  try { JSON.parse(raw || "{}"); } catch (_e) {}',
  '  process.stdout.write(JSON.stringify({',
  '    hookSpecificOutput: {',
  "      hookEventName: 'PreToolUse',",
  "      permissionDecision: 'deny',",
  "      permissionDecisionReason: 'blocked by __tf_test_ gate'",
  '    }',
  '  }) + "\\n");',
  '  process.exit(0);',
  '});',
  '',
].join('\n');

// ── tiny harness (matches gate.test.js): named checks, tap-ish lines, exit by outcome ──
const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}

// ── snapshot / restore ──────────────────────────────────────────────────────────────
function snapshot() {
  const snap = {};
  for (const f of CONFIG_FILES) {
    snap[f] = fs.existsSync(f)
      ? { existed: true, content: fs.readFileSync(f, 'utf8') }
      : { existed: false, content: null };
  }
  return snap;
}

function restore(snap) {
  for (const f of CONFIG_FILES) {
    const s = snap[f];
    if (s.existed) {
      // Write the exact original bytes back (preserves LF; no re-serialisation).
      fs.writeFileSync(f, s.content);
    } else if (fs.existsSync(f)) {
      fs.unlinkSync(f);
    }
  }
  // The gate proof may have authored a sacrificial hook script - drop it too.
  try {
    if (fs.existsSync(DENY_SCRIPT)) fs.unlinkSync(DENY_SCRIPT);
  } catch (_e) {
    /* best-effort */
  }
}

// ── the gated path (a fresh build per call -> always reads current on-disk config) ─────
async function runTool(name, args) {
  const { protocol } = buildProtocol();
  return protocol.dispatch('toolfunnel_run_tool', { name, args: args || {} });
}

// Extract the management script's JSON payload from a successful gated run. On a gate
// BLOCK (res.ok===false) there is no script output -> returns null.
function payloadOf(res) {
  if (!res || res.ok !== true || !res.output || typeof res.output.stdout !== 'string') return null;
  try {
    return JSON.parse(res.output.stdout.trim());
  } catch (_e) {
    return null;
  }
}

// toolfunnel_list_tools through the protocol (the model-facing surface; filters DISABLED).
async function listMeta(args) {
  const { protocol } = buildProtocol();
  const res = await protocol.dispatch('toolfunnel_list_tools', args || {});
  return res && res.ok ? res.output : null;
}

// tf_list (a management tool) through the gated path -> its `items` array, or null.
async function tfList(kind) {
  const p = payloadOf(await runTool('tf_list', { kind }));
  return p && p.ok && Array.isArray(p.items) ? p.items : null;
}

const ids = (arr) => (Array.isArray(arr) ? arr.map((x) => x && x.id) : []);

(async () => {
  let fatal = null;
  const snap = snapshot();

  // Baseline inventory (read-only) BEFORE any mutation - for the restore comparison.
  const baseline = {
    tools: await tfList('tools'),
    mcps: await tfList('mcps'),
    hooks: await tfList('hooks'),
  };

  try {
    // ── 1. The meta surface advertises run_tool; all 8 management tools are listed. ─────
    {
      const { protocol } = buildProtocol();
      const defNames = protocol.toolDefinitions().map((d) => d && d.name);
      check('META: tools/list (toolDefinitions) includes toolfunnel_run_tool', () => {
        assert.ok(defNames.includes('toolfunnel_run_tool'),
          'toolDefinitions names = ' + JSON.stringify(defNames));
      });

      const mgmt = await listMeta({ category: 'management' });
      const mgmtIds = ids(mgmt).sort();
      check('META: toolfunnel_list_tools({category:"management"}) returns all 10', () => {
        assert.deepStrictEqual(mgmtIds, MGMT_IDS.slice().sort(),
          'management ids = ' + JSON.stringify(mgmtIds));
      });
    }

    // ── 2. TOOLS round-trip: add -> list -> disable -> enable -> remove. ───────────────────
    {
      const TOOL_ID = '__tf_test_tool';
      const TOOL_SCHEMA = {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      };
      const add = payloadOf(await runTool('tf_tool_add', {
        id: TOOL_ID,
        name: TOOL_ID,
        summary: 'sacrificial test tool',
        category: 'testing',
        instructions: 'temp',
        inputSchema: TOOL_SCHEMA,
        invoke: { type: 'script', path: 'scripts/echo.js' },
      }));
      check('TOOLS: tf_tool_add succeeded', () => {
        assert.ok(add && add.ok === true && add.id === TOOL_ID, 'add payload = ' + JSON.stringify(add));
      });
      check('TOOLS: tf_tool_add persisted the authored inputSchema (round-trip)', () => {
        assert.deepStrictEqual(add && add.inputSchema, TOOL_SCHEMA,
          'inputSchema did not round-trip; add payload = ' + JSON.stringify(add));
      });

      const listAfterAdd = await tfList('tools');
      check('TOOLS: tf_list{tools} shows the added tool', () => {
        assert.ok(ids(listAfterAdd).includes(TOOL_ID), 'tools = ' + JSON.stringify(ids(listAfterAdd)));
      });

      const metaAfterAdd = await listMeta({});
      check('TOOLS: toolfunnel_list_tools surfaces the added (enabled) tool', () => {
        assert.ok(ids(metaAfterAdd).includes(TOOL_ID), 'meta = ' + JSON.stringify(ids(metaAfterAdd)));
      });

      const dis = payloadOf(await runTool('tf_tool_set', { id: TOOL_ID, action: 'disable' }));
      check('TOOLS: tf_tool_set disable succeeded', () => {
        assert.ok(dis && dis.ok === true && dis.enabled === false, 'disable = ' + JSON.stringify(dis));
      });
      const metaDisabled = await listMeta({});
      check('TOOLS: toolfunnel_list_tools NO LONGER surfaces the disabled tool', () => {
        assert.ok(!ids(metaDisabled).includes(TOOL_ID), 'meta = ' + JSON.stringify(ids(metaDisabled)));
      });

      const en = payloadOf(await runTool('tf_tool_set', { id: TOOL_ID, action: 'enable' }));
      check('TOOLS: tf_tool_set enable succeeded', () => {
        assert.ok(en && en.ok === true && en.enabled === true, 'enable = ' + JSON.stringify(en));
      });
      const metaEnabled = await listMeta({});
      check('TOOLS: toolfunnel_list_tools surfaces the re-enabled tool', () => {
        assert.ok(ids(metaEnabled).includes(TOOL_ID), 'meta = ' + JSON.stringify(ids(metaEnabled)));
      });

      const rm = payloadOf(await runTool('tf_tool_set', { id: TOOL_ID, action: 'remove' }));
      check('TOOLS: tf_tool_set remove succeeded', () => {
        assert.ok(rm && rm.ok === true && rm.removed === true, 'remove = ' + JSON.stringify(rm));
      });
      const listAfterRm = await tfList('tools');
      check('TOOLS: the tool is gone from tf_list{tools} after remove', () => {
        assert.ok(!ids(listAfterRm).includes(TOOL_ID), 'tools = ' + JSON.stringify(ids(listAfterRm)));
      });
    }

    // ── 2b. REFERENCE-MODE round-trip via the AGENT path - tf_tool_add used to drop `mode`,
    //        so a reference tool (no invoke; the instructions ARE the deliverable) failed with
    //        "entry.invoke is required" from this path while the UI path accepted it
    //Pin: add -> run -> remove. ─────────────────────
    {
      const REF_ID = 'mgmt-test-ref-tool';
      const add = payloadOf(await runTool('tf_tool_add', {
        id: REF_ID, name: REF_ID, summary: 'sacrificial reference tool',
        category: 'testing', mode: 'reference',
        instructions: 'Step 1: run the thing yourself. Step 2: report back.',
      }));
      check('TOOLS: tf_tool_add accepts a reference-mode entry (no invoke)', () => {
        assert.ok(add && add.ok === true && add.id === REF_ID, 'add payload = ' + JSON.stringify(add));
      });
      const run = await runTool(REF_ID, {});
      check('TOOLS: running the reference tool hands back its instructions', () => {
        assert.ok(JSON.stringify(run).includes('Step 1: run the thing yourself'),
          'run = ' + JSON.stringify(run).slice(0, 300));
      });
      const rm = payloadOf(await runTool('tf_tool_set', { id: REF_ID, action: 'remove' }));
      check('TOOLS: reference tool removed cleanly', () => {
        assert.ok(rm && rm.ok === true && rm.removed === true, 'remove = ' + JSON.stringify(rm));
      });
    }

    // ── 3. MCP round-trip: add -> list -> disable -> enable -> remove (config only). ───────
    {
      const UP_ID = '__tf_test_up';
      const add = payloadOf(await runTool('tf_mcp_add', { id: UP_ID, command: 'node', args: ['-e', '0'] }));
      check('MCP: tf_mcp_add succeeded', () => {
        assert.ok(add && add.ok === true && add.upstream && add.upstream.id === UP_ID,
          'add = ' + JSON.stringify(add));
      });
      const mcpsAfterAdd = await tfList('mcps');
      check('MCP: tf_list{mcps} shows the added upstream', () => {
        assert.ok(ids(mcpsAfterAdd).includes(UP_ID), 'mcps = ' + JSON.stringify(ids(mcpsAfterAdd)));
      });

      const dis = payloadOf(await runTool('tf_mcp_set', { id: UP_ID, action: 'disable' }));
      check('MCP: tf_mcp_set disable succeeded', () => {
        assert.ok(dis && dis.ok === true, 'disable = ' + JSON.stringify(dis));
      });
      const mcpsDisabled = await tfList('mcps');
      check('MCP: the upstream is present but enabled:false after disable', () => {
        const u = (mcpsDisabled || []).find((x) => x && x.id === UP_ID);
        assert.ok(u && u.enabled === false, 'upstream = ' + JSON.stringify(u));
      });

      const en = payloadOf(await runTool('tf_mcp_set', { id: UP_ID, action: 'enable' }));
      check('MCP: tf_mcp_set enable succeeded', () => {
        assert.ok(en && en.ok === true, 'enable = ' + JSON.stringify(en));
      });
      const mcpsEnabled = await tfList('mcps');
      check('MCP: the upstream is enabled:true again after enable', () => {
        const u = (mcpsEnabled || []).find((x) => x && x.id === UP_ID);
        assert.ok(u && u.enabled === true, 'upstream = ' + JSON.stringify(u));
      });

      const rm = payloadOf(await runTool('tf_mcp_set', { id: UP_ID, action: 'remove' }));
      check('MCP: tf_mcp_set remove succeeded', () => {
        assert.ok(rm && rm.ok === true && rm.removed === true, 'remove = ' + JSON.stringify(rm));
      });
      const mcpsAfterRm = await tfList('mcps');
      check('MCP: the upstream is gone from tf_list{mcps} after remove', () => {
        assert.ok(!ids(mcpsAfterRm).includes(UP_ID), 'mcps = ' + JSON.stringify(ids(mcpsAfterRm)));
      });
    }

    // ── 4. HOOKS round-trip: add (PostToolUse) -> list -> disable -> enable -> remove. ─────
    {
      const HOOK_ID = '__tf_test_post_probe';
      const add = payloadOf(await runTool('tf_hook_add', {
        id: HOOK_ID,
        event: 'PostToolUse',
        matcher: '__tf_test_never_matches', // never fires against a real tool
        command: 'node -e "0"',
        description: 'sacrificial PostToolUse probe',
      }));
      check('HOOKS: tf_hook_add succeeded', () => {
        assert.ok(add && add.ok === true && add.id === HOOK_ID, 'add = ' + JSON.stringify(add));
      });
      const hooksAfterAdd = await tfList('hooks');
      check('HOOKS: tf_list{hooks} shows the added hook', () => {
        assert.ok(ids(hooksAfterAdd).includes(HOOK_ID), 'hooks = ' + JSON.stringify(ids(hooksAfterAdd)));
      });

      const dis = payloadOf(await runTool('tf_hook_set', { id: HOOK_ID, action: 'disable' }));
      check('HOOKS: tf_hook_set disable succeeded', () => {
        assert.ok(dis && dis.ok === true && dis.enabled === false, 'disable = ' + JSON.stringify(dis));
      });
      const hooksDisabled = await tfList('hooks');
      check('HOOKS: the hook reads enabled:false after disable', () => {
        const h = (hooksDisabled || []).find((x) => x && x.id === HOOK_ID);
        assert.ok(h && h.enabled === false, 'hook = ' + JSON.stringify(h));
      });

      const en = payloadOf(await runTool('tf_hook_set', { id: HOOK_ID, action: 'enable' }));
      check('HOOKS: tf_hook_set enable succeeded', () => {
        assert.ok(en && en.ok === true && en.enabled === true, 'enable = ' + JSON.stringify(en));
      });
      const hooksEnabled = await tfList('hooks');
      check('HOOKS: the hook reads enabled:true after enable', () => {
        const h = (hooksEnabled || []).find((x) => x && x.id === HOOK_ID);
        assert.ok(h && h.enabled === true, 'hook = ' + JSON.stringify(h));
      });

      const rm = payloadOf(await runTool('tf_hook_set', { id: HOOK_ID, action: 'remove' }));
      check('HOOKS: tf_hook_set remove succeeded', () => {
        assert.ok(rm && rm.ok === true && rm.removed === true, 'remove = ' + JSON.stringify(rm));
      });
      const hooksAfterRm = await tfList('hooks');
      check('HOOKS: the hook is gone from tf_list{hooks} after remove', () => {
        assert.ok(!ids(hooksAfterRm).includes(HOOK_ID), 'hooks = ' + JSON.stringify(ids(hooksAfterRm)));
      });
    }

    // ── 5. GATE PROOF (load-bearing): a deny hook blocks tf_tool_add via the gate. ─────
    {
      const GATE_ID = '__tf_test_gate';
      const VICTIM_ID = '__tf_test_gate_tool';
      const REGISTER = path.join(ROOT, 'tools', 'tools.register.json');

      // Add a PreToolUse deny hook that matches the management tool tf_tool_add. Its
      // script is authored under hooks/scripts via scriptText; command uses ${HOOKS_DIR}.
      const addHook = payloadOf(await runTool('tf_hook_add', {
        id: GATE_ID,
        event: 'PreToolUse',
        matcher: 'tf_tool_add',
        command: 'node "${HOOKS_DIR}/scripts/__tf_test_deny.js"',
        script: 'scripts/__tf_test_deny.js',
        scriptText: DENY_BODY,
        description: 'sacrificial PreToolUse gate denying tf_tool_add',
      }));
      check('GATE: tf_hook_add (PreToolUse deny) succeeded + wrote its script', () => {
        assert.ok(addHook && addHook.ok === true && addHook.scriptWritten === true,
          'addHook = ' + JSON.stringify(addHook));
      });

      const enHook = payloadOf(await runTool('tf_hook_set', { id: GATE_ID, action: 'enable' }));
      check('GATE: tf_hook_set enable (the gate) succeeded', () => {
        assert.ok(enHook && enHook.ok === true && enHook.enabled === true, 'enable = ' + JSON.stringify(enHook));
      });

      // Capture the register exactly as it stands BEFORE the blocked attempt.
      const registerBefore = fs.readFileSync(REGISTER, 'utf8');

      // Attempt a gated tf_tool_add. The fresh build loads the (now-enabled) gate hook,
      // PreToolUse fires for tool_name "tf_tool_add", denies, and execute() never runs.
      const blocked = await runTool('tf_tool_add', {
        id: VICTIM_ID,
        name: VICTIM_ID,
        invoke: { type: 'script', path: 'scripts/echo.js' },
      });
      check('GATE: the gated tf_tool_add was BLOCKED (ok:false)', () => {
        assert.strictEqual(blocked && blocked.ok, false, 'result = ' + JSON.stringify(blocked));
      });
      check('GATE: result.blocked === true (PreToolUse deny)', () => {
        assert.strictEqual(blocked && blocked.blocked, true, 'result = ' + JSON.stringify(blocked));
      });
      check('GATE: the register file did NOT change (execute never ran)', () => {
        const after = fs.readFileSync(REGISTER, 'utf8');
        assert.strictEqual(after, registerBefore, 'register mutated despite the gate block');
      });
      check('GATE: the blocked tool id was never added to the register', () => {
        assert.ok(!fs.readFileSync(REGISTER, 'utf8').includes(VICTIM_ID),
          'register contains the blocked id ' + VICTIM_ID);
      });

      // Remove the gate hook (its own tool_name is tf_hook_set -> the gate does not match it).
      const rmHook = payloadOf(await runTool('tf_hook_set', { id: GATE_ID, action: 'remove' }));
      check('GATE: tf_hook_set remove (the gate) succeeded', () => {
        assert.ok(rmHook && rmHook.ok === true && rmHook.removed === true, 'remove = ' + JSON.stringify(rmHook));
      });
      const hooksAfterGate = await tfList('hooks');
      check('GATE: the gate hook is gone from tf_list{hooks}', () => {
        assert.ok(!ids(hooksAfterGate).includes(GATE_ID), 'hooks = ' + JSON.stringify(ids(hooksAfterGate)));
      });
    }

    // ── 6. RESTORE from the snapshot, then prove the inventory matches the baseline. ───
    restore(snap);

    const after = {
      tools: await tfList('tools'),
      mcps: await tfList('mcps'),
      hooks: await tfList('hooks'),
    };
    check('RESTORE: tf_list{tools} matches the pre-test baseline', () => {
      assert.deepStrictEqual(after.tools, baseline.tools);
    });
    check('RESTORE: tf_list{mcps} matches the pre-test baseline', () => {
      assert.deepStrictEqual(after.mcps, baseline.mcps);
    });
    check('RESTORE: tf_list{hooks} matches the pre-test baseline', () => {
      assert.deepStrictEqual(after.hooks, baseline.hooks);
    });
    check('RESTORE: every config file is byte-for-byte the snapshot (or re-absent)', () => {
      for (const f of CONFIG_FILES) {
        const s = snap[f];
        if (s.existed) {
          assert.strictEqual(fs.readFileSync(f, 'utf8'), s.content, 'file changed: ' + f);
        } else {
          assert.ok(!fs.existsSync(f), 'file should not exist after restore: ' + f);
        }
      }
      assert.ok(!fs.existsSync(DENY_SCRIPT), 'sacrificial hook script was not cleaned up');
    });
  } catch (err) {
    fatal = err;
  } finally {
    // Safety net: restore again no matter what happened above. Idempotent.
    try {
      restore(snap);
    } catch (_e) {
      /* best-effort */
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────────────────
  for (const r of results) {
    console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  }
  if (fatal) {
    console.log('FATAL: ' + ((fatal && fatal.stack) || fatal));
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const ok = !fatal && failed === 0 && results.length > 0;

  if (ok) {
    console.log(`\nPASS: management test - ${passed}/${results.length} assertions passed ` +
      `(8 management tools round-trip through the gate; deny hook blocks tf_tool_add; config restored)`);
    process.exit(0);
  } else {
    console.log(`\nFAIL: management test - ${passed}/${results.length} assertions passed, ${failed} failed`);
    process.exit(1);
  }
})().catch((e) => {
  console.log('MANAGEMENT TEST CRASHED: ' + ((e && e.stack) || e));
  process.exit(1);
});
