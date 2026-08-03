'use strict';

/**
 * logging.test.js - proves the toggleable JSONL activity/audit log (src/core/logger.js)
 * actually records what runs through the gateway, honours its on/off toggle, and is
 * controllable as a first-party tool - all WITHOUT leaving any live state behind.
 *
 * The logger is DEFAULT OFF and self-gating: log() is a silent no-op until setConfig has
 * written logs/log.config.json with { enabled:true }. The gateway emits exactly two record
 * kinds on the run path:
 *   - { type:'gate', decision:'allow'|'deny', ... }  - written by src/mcp/gated-run.js for
 *     EVERY gated call, before the blocked-return, so both outcomes are captured.
 *   - { type:'tool', name, ok, blocked, ... }        - written by src/mcp/protocol.js after
 *     a run_tool dispatch resolves.
 *
 * Steps (the task contract):
 *   1. ENABLE  : setConfig({enabled:true, path:<temp .jsonl>}) -> dispatch toolfunnel_run_tool
 *                {name:'echo'} -> the log gains a {type:'tool'} line AND a
 *                {type:'gate',decision:'allow'} line.
 *   2. DENY    : a fixture PreToolUse deny hook matching 'echo' (mirrors gate.test.js's
 *                fixture approach - loadManifest + HookEngine + gatedRun against a fixture
 *                manifest, reusing test/fixtures/scripts/deny-hook.js) -> the gated echo run
 *                is BLOCKED (execute() never runs) AND a {type:'gate',decision:'deny'} line
 *                is written. The fixture is then removed.
 *   3. DISABLE : setConfig({enabled:false}) -> dispatch echo again -> NO new lines are appended
 *                (the raw line count is unchanged).
 *   4. TF_LOG  : the first-party tf_log tool through run_tool: enable -> status reports
 *                enabled:true; disable -> status reports enabled:false.
 *   5. CONTAIN : the log path is confined to the config home's logs/ dir (0.7.0). setConfig
 *                refuses an out-of-home path (absolute or relative) and persists nothing; the
 *                refusal reaches the tf_log tool surface as { ok:false } and the UI's
 *                POST /api/logs/config as a 400 (client input, not a server fault); a config
 *                file written directly with an out-of-home path resolves to the default, so
 *                log() and tail() stay in-home.
 *   6. RESTORE : logs/log.config.json and the default log file are restored from the up-front
 *                snapshots (or deleted if they did not exist), the temp log is deleted, and a
 *                logs/ dir created only for the config is removed - live state is left exactly
 *                as found.
 *
 * The temp log lives INSIDE the repo's logs/ dir (uniquely named, deleted on restore) - it has
 * to, because step 5's containment rule refuses everywhere else. Restore runs in a finally, so
 * a failure mid-flight still leaves real state untouched.
 *
 * Convention (matches the sibling tests): a standalone node script, exit 0 = pass, non-zero =
 * fail. Node built-ins only (node:assert, node:fs, node:os, node:path, node:crypto).
 *
 * Run:  node test/logging.test.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const logger = require('../src/core/logger');
const { createUiServer } = require('../src/ui/server');
const { buildProtocol } = require('../src/mcp/server');
const { loadManifest } = require('../src/core/hook-loader');
const { HookEngine } = require('../src/core/hook-engine');
const { gatedRun } = require('../src/mcp/gated-run');

const ROOT = path.resolve(__dirname, '..');

// The logger's config file (the toggle). setConfig is the ONLY thing that creates it.
const LOGS_DIR = path.join(ROOT, 'logs');
const CONFIG_PATH = path.join(LOGS_DIR, 'log.config.json');

// A fresh, unique log file INSIDE the config home's logs/ dir. It has to live in-home: the log
// path is confined to the config home (step 5), so the old OS-tmpdir location is now refused.
// Unique per run and deleted in restore, so the repo's logs/ dir is left exactly as found.
const TEMP_LOG = path.join(LOGS_DIR, `__tf_test_logging-${process.pid}-${crypto.randomUUID()}.jsonl`);

// The logger's own default relative path, and an out-of-home absolute path for the containment
// checks. OUT_OF_HOME_LOG is only ever asserted ABSENT (or pre-written by the rig, then removed);
// nothing is ever logged to it.
const DEFAULT_LOG_PATH = 'logs/toolfunnel.log.jsonl';
const DEFAULT_LOG_ABS = path.join(ROOT, DEFAULT_LOG_PATH);
const OUT_OF_HOME_LOG = path.join(os.tmpdir(), `toolfunnel-out-of-home-${process.pid}-${crypto.randomUUID()}.jsonl`);

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
// The DEFAULT log file is snapshotted too: step 5's fallback probe appends to it, and the rig
// must leave live state exactly as found.
function snapshotConfig() {
  const snapOf = (p) =>
    fs.existsSync(p)
      ? { existed: true, content: fs.readFileSync(p, 'utf8') }
      : { existed: false, content: null };
  // The `.1` sibling too: the logger rotates an at-cap default log DURING this test's own
  // appends, so a `.1` can appear mid-run that the byte-restore of the live file doesn't
  // know about. Snapshot its state up front and restore-or-remove it like the others -
  // one appeared exactly this way the night rotation landed.
  return {
    config: snapOf(CONFIG_PATH),
    defaultLog: snapOf(DEFAULT_LOG_ABS),
    defaultLogRotated: snapOf(DEFAULT_LOG_ABS + '.1'),
  };
}

// Whether logs/ pre-existed - if WE created it (only for the config file), remove it on restore.
const LOGS_DIR_EXISTED = fs.existsSync(LOGS_DIR);

function restoreConfig(snap) {
  // (1) Config + default log: exact original bytes back, or re-absent if they never existed.
  const restoreOf = (p, s) => {
    if (s.existed) {
      fs.writeFileSync(p, s.content); // preserves LF; no re-serialisation
    } else if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  };
  restoreOf(CONFIG_PATH, snap.config);
  try {
    restoreOf(DEFAULT_LOG_ABS, snap.defaultLog);
  } catch (_e) {
    /* best-effort */
  }
  try {
    restoreOf(DEFAULT_LOG_ABS + '.1', snap.defaultLogRotated);
  } catch (_e) {
    /* best-effort */
  }
  // (2) Temp log + the out-of-home marker (normally removed in step 5; this is the safety net).
  for (const p of [TEMP_LOG, OUT_OF_HOME_LOG]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (_e) {
      /* best-effort */
    }
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
/** Raw non-empty lines of the temp log (missing file -> []). */
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

// ── the gated meta-tool path (a fresh build per call -> always reads current on-disk config) ──
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
    // ── 1. ENABLE -> run echo -> a tool line AND a gate-allow line are written. ───────────────
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

      // Remove the fixture (mirrors gate.test.js - fixtures are transient).
      fs.unlinkSync(FIXTURE_MANIFEST);
    }

    // ── 3. DISABLE -> run echo -> NO new lines are appended. ───────────────────────────────────
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

    // ── 4. TF_LOG via run_tool: enable -> status enabled; disable -> status disabled. ──────────
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

    // ── 5. CONTAINMENT: the log path stays inside the config home's logs/ dir. ─────────────────
    // Every other file-writing path in the repo is confined to its root (hook-loader's scripts-dir
    // assert, registry.writeScript, sendStatic); the log path was the one that was not, and tf_log
    // forwards `path` straight through, so the rule has to hold at the tool surface too.
    // Two layers, matching the house pattern: the WRITER (setConfig) refuses loudly, the READER
    // (getConfig) treats an out-of-home path as unset - so a hand-edited config file resolves to
    // the default and both log() and tail() stay inside the home.
    {
      const restoreForContainment = () => { try { logger.setConfig({ enabled: false, path: DEFAULT_LOG_PATH }); } catch (_e) { /* best-effort */ } };

      // (a) WRITER refuses an absolute path outside the home - and persists nothing.
      const beforeCfg = JSON.stringify(logger.getConfig());
      let threw = null;
      try { logger.setConfig({ enabled: true, path: OUT_OF_HOME_LOG }); } catch (e) { threw = e; }
      check('CONTAIN: setConfig REFUSES an absolute path outside the config home', () => {
        assert.ok(threw, 'setConfig accepted ' + OUT_OF_HOME_LOG);
        assert.ok(/outside|logs|config home/i.test((threw && threw.message) || ''),
          'refusal message should name the containment rule, got: ' + ((threw && threw.message) || ''));
      });
      check('CONTAIN: the refused path was NOT persisted', () => {
        assert.strictEqual(JSON.stringify(logger.getConfig()), beforeCfg,
          'config changed to ' + JSON.stringify(logger.getConfig()));
      });

      // (b) WRITER refuses a relative path that resolves outside the home.
      let threwRel = null;
      try { logger.setConfig({ enabled: true, path: '../tf-out-of-home.jsonl' }); } catch (e) { threwRel = e; }
      check('CONTAIN: setConfig REFUSES a relative path that resolves outside the home', () => {
        assert.ok(threwRel, 'setConfig accepted ../tf-out-of-home.jsonl');
      });

      // (c) A normal relative path inside the home is still accepted (the guard must not over-reach).
      let threwOk = null;
      try { logger.setConfig({ enabled: false, path: DEFAULT_LOG_PATH }); } catch (e) { threwOk = e; }
      check('CONTAIN: a relative in-home path is still accepted', () => {
        assert.ok(!threwOk, 'setConfig refused the default path: ' + ((threwOk && threwOk.message) || ''));
      });

      // (d) TOOL SURFACE (the reachability that made this a defect): tf_log forwards `path`, so
      //     the refusal must surface as a clean { ok:false, error } - and no file may appear.
      const viaTool = payloadOf(await dispatchRun('tf_log', { action: 'enable', path: OUT_OF_HOME_LOG }));
      check('CONTAIN: tf_log enable with an out-of-home path reports ok:false', () => {
        assert.ok(viaTool && viaTool.ok === false, 'tf_log = ' + JSON.stringify(viaTool));
      });
      check('CONTAIN: no file was created outside the home by the tool surface', () => {
        assert.ok(!fs.existsSync(OUT_OF_HOME_LOG), 'file exists: ' + OUT_OF_HOME_LOG);
      });

      // (e) READER: a config file WRITTEN DIRECTLY (not via setConfig) with an out-of-home path
      //     resolves to the default - log() writes in-home, tail() reads in-home.
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ enabled: true, path: OUT_OF_HOME_LOG }, null, 2) + '\n');
      check('CONTAIN: getConfig treats a hand-edited out-of-home path as unset (default)', () => {
        assert.strictEqual(logger.getConfig().path, DEFAULT_LOG_PATH,
          'resolved path = ' + logger.getConfig().path);
      });
      logger.log({ type: 'containment-probe' });
      check('CONTAIN: log() wrote nothing outside the home for a hand-edited config', () => {
        assert.ok(!fs.existsSync(OUT_OF_HOME_LOG), 'file exists: ' + OUT_OF_HOME_LOG);
      });

      // tail() must stay in-home too: pre-write a marker record out-of-home and prove tail()
      // never returns it.
      fs.writeFileSync(OUT_OF_HOME_LOG, JSON.stringify({ type: 'out-of-home-marker' }) + '\n');
      check('CONTAIN: tail() does not read a file outside the home', () => {
        assert.ok(!logger.tail().some((r) => r && r.type === 'out-of-home-marker'),
          'tail returned the marker record from ' + OUT_OF_HOME_LOG);
      });
      fs.unlinkSync(OUT_OF_HOME_LOG);

      // (f) UI SURFACE: POST /api/logs/config forwards `path` to setConfig too, so the refusal
      //     surfaces here as well - and it is CLIENT input, so the answer is a 400 with the
      //     refusal message and nothing persisted. Only a genuine write failure (disk, perms)
      //     may answer 500; a refused path must not wear a server-fault status. (The UI server
      //     gets a throwaway temp root, but the logger acts on the process config home - the
      //     snapshot/restore rig around this test guards it.)
      {
        const uiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-logging-ui-'));
        for (const d of ['mcp', 'hooks', 'tools']) fs.mkdirSync(path.join(uiHome, d), { recursive: true });
        fs.writeFileSync(path.join(uiHome, 'mcp', 'expose.json'), JSON.stringify({ version: 1, upstreams: [], expose: [] }, null, 2) + '\n');
        fs.writeFileSync(path.join(uiHome, 'tools', 'tools.register.json'), JSON.stringify({ version: 1, tools: [] }, null, 2) + '\n');
        fs.writeFileSync(path.join(uiHome, 'tools', 'tools.state.json'), '{}\n');
        fs.writeFileSync(path.join(uiHome, 'hooks', 'hooks.manifest.json'), JSON.stringify({ version: 1, hooks: [] }, null, 2) + '\n');

        const postJson = (port, urlPath, body) => new Promise((resolve, reject) => {
          const data = JSON.stringify(body);
          const req = http.request({
            host: '127.0.0.1', port, method: 'POST', path: urlPath,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(data),
              Origin: 'http://127.0.0.1:' + port,
            },
          }, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { raw += d; });
            res.on('end', () => {
              let json = null;
              try { json = JSON.parse(raw); } catch (_e) { /* leave null */ }
              resolve({ status: res.statusCode, json, raw });
            });
          });
          req.on('error', reject);
          req.write(data);
          req.end();
        });

        const handle = createUiServer({ host: '127.0.0.1', port: 0, root: uiHome });
        const started = await handle.start();
        try {
          const beforeUi = JSON.stringify(logger.getConfig());
          const r = await postJson(started.port, '/api/logs/config', { enabled: true, path: OUT_OF_HOME_LOG });
          check('CONTAIN: UI POST /api/logs/config with an out-of-home path answers 400', () => {
            assert.strictEqual(r.status, 400, `status = ${r.status} body = ${r.raw}`);
          });
          check('CONTAIN: the UI refusal body carries ok:false and names the rule', () => {
            assert.ok(r.json && r.json.ok === false && /outside|logs|config home/i.test(r.json.error || ''),
              'body = ' + r.raw);
          });
          check('CONTAIN: the UI-refused path was NOT persisted', () => {
            assert.strictEqual(JSON.stringify(logger.getConfig()), beforeUi,
              'config changed to ' + JSON.stringify(logger.getConfig()));
          });
        } finally {
          await handle.stop();
          fs.rmSync(uiHome, { recursive: true, force: true });
        }
      }

      restoreForContainment();
    }
  } catch (err) {
    fatal = err;
  } finally {
    // ── 6. RESTORE - config, default log, temp log, fixture, any logs/ dir we created. ───────
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
      `\nPASS: logging test - ${passed}/${results.length} assertions passed ` +
        `(enable logs tool+gate-allow; deny logs gate-deny + blocks; disable is silent; tf_log toggles; config restored)`
    );
    process.exit(0);
  } else {
    console.log(`\nFAIL: logging test - ${passed}/${results.length} assertions passed, ${failed} failed`);
    process.exit(1);
  }
})().catch((e) => {
  console.log('LOGGING TEST CRASHED: ' + ((e && e.stack) || e));
  process.exit(1);
});
