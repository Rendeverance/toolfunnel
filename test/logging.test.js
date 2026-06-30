'use strict';

/**
 * logging.test.js — proves the toggleable JSONL activity/audit log (src/core/logger.js)
 * actually records what runs through the gateway, honours its on/off toggle, and is
 * controllable as a first-party tool — all WITHOUT leaving any live state behind.
 *
 * The logger is DEFAULT OFF and self-gating: log() is a silent no-op until setConfig has
 * written logs/log.config.json with { enabled:true }. The gateway emits exactly two record
 * kinds on the run path:
 *   - { type:'gate', decision:'allow'|'deny', ... }  — written by src/mcp/gated-run.js for
 *     EVERY gated call, before the blocked-return, so both outcomes are captured.
 *   - { type:'tool', name, ok, blocked, ... }        — written by src/mcp/protocol.js after
 *     a run_tool dispatch resolves.
 *
 * Steps (the task contract):
 *   1. ENABLE  : setConfig({enabled:true, path:<temp .jsonl>}) → dispatch toolfunnel_run_tool
 *                {name:'echo'} → the log gains a {type:'tool'} line AND a
 *                {type:'gate',decision:'allow'} line.
 *   2. DENY    : a fixture PreToolUse deny hook matching 'echo' (mirrors gate.test.js's
 *                fixture approach — loadManifest + HookEngine + gatedRun against a fixture
 *                manifest, reusing test/fixtures/scripts/deny-hook.js) → the gated echo run
 *                is BLOCKED (execute() never runs) AND a {type:'gate',decision:'deny'} line
 *                is written. The fixture is then removed.
 *   3. DISABLE : setConfig({enabled:false}) → dispatch echo again → NO new lines are appended
 *                (the raw line count is unchanged).
 *   4. TF_LOG  : the first-party tf_log tool through run_tool: enable → status reports
 *                enabled:true; disable → status reports enabled:false.
 *   5. RESTORE : logs/log.config.json is restored from the up-front snapshot (or deleted if it
 *                did not exist), the temp log is deleted, and a logs/ dir created only for the
 *                config is removed — live state is left exactly as found.
 *
 * The temp log lives under the OS temp dir (an ABSOLUTE path the logger uses verbatim), so the
 * repo's logs/ dir only ever holds the config file we snapshot/restore. Restore runs in a
 * finally, so a failure mid-flight still leaves real state untouched.
 *
 * Convention (matches the sibling tests): a standalone node script, exit 0 = pass, non-zero =
 * fail. Node built-ins only (node:assert, node:fs, node:os, node:path, node:crypto).
 *
 * Run:  node test/logging.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const logger = require('../src/core/logger');
const { buildProtocol } = require('../src/mcp/server');
const { loadManifest } = require('../src/core/hook-loader');
const { HookEngine } = require('../src/core/hook-engine');
const { gatedRun } = require('../src/mcp/gated-run');

const ROOT = path.resolve(__dirname, '..');

// The logger's config file (the toggle). setConfig is the ONLY thing that creates it.
const LOGS_DIR = path.join(ROOT, 'logs');
const CONFIG_PATH = path.join(LOGS_DIR, 'log.config.json');

// A fresh, unique, ABSOLUTE temp log — the logger uses an absolute path verbatim, so this
// keeps the repo's logs/ dir clean (config file only). Guaranteed-absent at start.
const TEMP_LOG = path.join(os.tmpdir(), `toolfunnel-logging-${process.pid}-${crypto.randomUUID()}.jsonl`);

// Fixture (NEVER the shipped manifest): a PreToolUse deny hook matching 'echo'. Authored under
// test/fixtures so loadManifest expands ${HOOKS_DIR} to that dir and reuses the existing
// scripts/deny-hook.js. Removed after step 2 (and again in the finally as a safety net).
const FIXTURE_MANIFEST = path.join(__dirname, 'fixtures', `__tf_test_echo_deny.${process.pid}.manifest.json`);
const FIXTURE_MANIFEST_BODY =
  JSON.stringify(
    {
      version: 1,
      hooks: [
        {
          id: 'pre-tool-use/echo-deny',
          event: 'PreToolUse',
          matcher: 'echo',
          type: 'command',
          command: 'node "${HOOKS_DIR}/scripts/deny-hook.js"',
          script: 'scripts/deny-hook.js',
          timeout: 10,
          enabled: true,
          description: "TEST FIXTURE: unconditionally denies 'echo' so logging.test.js can prove a deny is logged.",
        },
      ],
    },
    null,
    2
  ) + '\n';

// The common hook context for the direct gatedRun (mirrors gate.test.js).
const CTX = { session_id: 't', transcript_path: '', cwd: ROOT };

// ── tiny harness (matches gate.test.js / management.test.js): named checks, tap-ish lines ──
const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
  }
}

// ── snapshot / restore of the live logger config (and temp-log cleanup) ─────────────────────
function snapshotConfig() {
  return fs.existsSync(CONFIG_PATH)
    ? { existed: true, content: fs.readFileSync(CONFIG_PATH, 'utf8') }
    : { existed: false, content: null };
}

// Whether logs/ pre-existed — if WE created it (only for the config file), remove it on restore.
const LOGS_DIR_EXISTED = fs.existsSync(LOGS_DIR);

function restoreConfig(snap) {
  // (1) Config: exact original bytes back, or re-absent if it never existed.
  if (snap.existed) {
    fs.writeFileSync(CONFIG_PATH, snap.content); // preserves LF; no re-serialisation
  } else if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH);
  }
  // (2) Temp log.
  try {
    if (fs.existsSync(TEMP_LOG)) fs.unlinkSync(TEMP_LOG);
  } catch (_e) {
    /* best-effort */
  }
  // (3) Fixture manifest (normally removed after step 2; this is the safety net).
  try {
    if (fs.existsSync(FIXTURE_MANIFEST)) fs.unlinkSync(FIXTURE_MANIFEST);
  } catch (_e) {
    /* best-effort */
  }
  // (4) If logs/ existed only because setConfig created it for the config, drop it when empty.
  if (!LOGS_DIR_EXISTED) {
    try {
      if (fs.existsSync(LOGS_DIR) && fs.readdirSync(LOGS_DIR).length === 0) fs.rmdirSync(LOGS_DIR);
    } catch (_e) {
      /* best-effort */
    }
  }
}

// ── temp-log readers ────────────────────────────────────────────────────────────────────────
/** Raw non-empty lines of the temp log (missing file → []). */
function readRawLines() {
  try {
    return fs
      .readFileSync(TEMP_LOG, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
  } catch (_e) {
    return [];
  }
}
/** Parsed JSON records of the temp log (unparseable lines dropped). */
function readRecords() {
  const out = [];
  for (const line of readRawLines()) {
    try {
      out.push(JSON.parse(line));
    } catch (_e) {
      /* skip a partial/corrupt line */
    }
  }
  return out;
}

// ── the gated meta-tool path (a fresh build per call → always reads current on-disk config) ──
async function dispatchRun(name, args) {
  const { protocol } = buildProtocol();
  return protocol.dispatch('toolfunnel_run_tool', { name, args: args || {} });
}

/** Extract a management script's JSON payload from a successful gated run (else null). */
function payloadOf(res) {
  if (!res || res.ok !== true || !res.output || typeof res.output.stdout !== 'string') return null;
  try {
    return JSON.parse(res.output.stdout.trim());
  } catch (_e) {
    return null;
  }
}

(async () => {
  let fatal = null;
  const snap = snapshotConfig();

  try {
    // ── 1. ENABLE → run echo → a tool line AND a gate-allow line are written. ───────────────
    {
      logger.setConfig({ enabled: true, path: TEMP_LOG });

      const res = await dispatchRun('echo', {});
      check('ENABLE: the gated echo run succeeded (ok:true)', () => {
        assert.ok(res && res.ok === true, 'echo run = ' + JSON.stringify(res));
      });

      const recs = readRecords();
      check('ENABLE: a {type:"tool"} line was logged', () => {
        assert.ok(
          recs.some((r) => r && r.type === 'tool'),
          'records = ' + JSON.stringify(recs)
        );
      });
      check('ENABLE: a {type:"gate", decision:"allow"} line was logged', () => {
        assert.ok(
          recs.some((r) => r && r.type === 'gate' && r.decision === 'allow'),
          'records = ' + JSON.stringify(recs)
        );
      });
    }

    // ── 2. DENY: fixture PreToolUse deny matching echo ⇒ blocked + a gate-deny line. ─────────
    {
      fs.writeFileSync(FIXTURE_MANIFEST, FIXTURE_MANIFEST_BODY);

      let ran = 0;
      const execute = () => {
        ran += 1;
        return { ok: true, ran: true };
      };
      const engine = new HookEngine(loadManifest(FIXTURE_MANIFEST), { cwd: ROOT });

      const res = await gatedRun({ engine, ctx: CTX, toolName: 'echo', args: {}, execute });

      check('DENY: the gated echo run was BLOCKED (blocked:true, ok:false)', () => {
        assert.strictEqual(res && res.blocked, true, 'result = ' + JSON.stringify(res));
        assert.strictEqual(res && res.ok, false, 'result = ' + JSON.stringify(res));
      });
      check('DENY: execute() NEVER ran (the gate bit)', () => {
        assert.strictEqual(ran, 0, 'execute() ran ' + ran + ' time(s)');
      });

      const recs = readRecords();
      check('DENY: a {type:"gate", decision:"deny"} line was logged', () => {
        assert.ok(
          recs.some((r) => r && r.type === 'gate' && r.decision === 'deny'),
          'records = ' + JSON.stringify(recs)
        );
      });

      // Remove the fixture (mirrors gate.test.js — fixtures are transient).
      fs.unlinkSync(FIXTURE_MANIFEST);
    }

    // ── 3. DISABLE → run echo → NO new lines are appended. ───────────────────────────────────
    {
      logger.setConfig({ enabled: false });

      const before = readRawLines().length;
      const res = await dispatchRun('echo', {});
      const after = readRawLines().length;

      check('DISABLE: echo still runs with logging off (ok:true)', () => {
        assert.ok(res && res.ok === true, 'echo run = ' + JSON.stringify(res));
      });
      check('DISABLE: NO new lines were appended while logging is disabled', () => {
        assert.strictEqual(after, before, `line count changed: ${before} -> ${after}`);
      });
    }

    // ── 4. TF_LOG via run_tool: enable → status enabled; disable → status disabled. ──────────
    {
      const en = payloadOf(await dispatchRun('tf_log', { action: 'enable' }));
      check('TF_LOG: enable succeeded (ok:true, enabled:true)', () => {
        assert.ok(en && en.ok === true && en.enabled === true, 'enable = ' + JSON.stringify(en));
      });
      const stOn = payloadOf(await dispatchRun('tf_log', { action: 'status' }));
      check('TF_LOG: status reports enabled:true after enable', () => {
        assert.ok(stOn && stOn.ok === true && stOn.enabled === true, 'status = ' + JSON.stringify(stOn));
      });

      const dis = payloadOf(await dispatchRun('tf_log', { action: 'disable' }));
      check('TF_LOG: disable succeeded (ok:true, enabled:false)', () => {
        assert.ok(dis && dis.ok === true && dis.enabled === false, 'disable = ' + JSON.stringify(dis));
      });
      const stOff = payloadOf(await dispatchRun('tf_log', { action: 'status' }));
      check('TF_LOG: status reports enabled:false after disable', () => {
        assert.ok(stOff && stOff.ok === true && stOff.enabled === false, 'status = ' + JSON.stringify(stOff));
      });
    }
  } catch (err) {
    fatal = err;
  } finally {
    // ── 5. RESTORE — config + temp log + fixture + any logs/ dir we created. Idempotent. ─────
    try {
      restoreConfig(snap);
    } catch (_e) {
      /* best-effort */
    }
  }

  // ── Report ───────────────────────────────────────────────────────────────────────────────
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
    console.log(
      `\nPASS: logging test — ${passed}/${results.length} assertions passed ` +
        `(enable logs tool+gate-allow; deny logs gate-deny + blocks; disable is silent; tf_log toggles; config restored)`
    );
    process.exit(0);
  } else {
    console.log(`\nFAIL: logging test — ${passed}/${results.length} assertions passed, ${failed} failed`);
    process.exit(1);
  }
})().catch((e) => {
  console.log('LOGGING TEST CRASHED: ' + ((e && e.stack) || e));
  process.exit(1);
});
