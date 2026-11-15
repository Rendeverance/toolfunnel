'use strict';
/**
 * temp-home.js - scratch config homes for tests.
 *
 * A test that boots the gateway or loads a store must do so against a home of its OWN, never the
 * repository's: a crash mid-run would otherwise rewrite the developer's real config, and a populated
 * dev-clone mcp/expose.json makes every such test connect REAL upstreams on every run.
 *
 * Two shapes:
 *   makeTempHome(opts) - for SPAWNED gateways. Returns the home, its store paths, env() for the
 *                        spawn call, and cleanup().
 *   useTempHome(opts)  - for IN-PROCESS tests. Also exports TOOLFUNNEL_HOME and seeds the home via
 *                        initConfigHome. Call it BEFORE the first require of anything under src/:
 *                        server.js, logger.js, auth/config.js and aggregator.js capture the home when
 *                        first loaded, so a later export changes nothing.
 *
 * The gateway seeds the register, the shipped scripts, the hooks tree and mcp/servers (the mock
 * upstreams) into the home itself at startup (ensureConfigHome), so a home only needs the
 * user-state files - expose.json, hooks.manifest.json, tools.state.json - which this writes
 * empty unless told otherwise. A test-only fixture an upstream entry points at must live INSIDE
 * the home (isolation guard): copyIntoMcp() does that.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EMPTY_EXPOSE = Object.freeze({ version: 1, upstreams: [], expose: [] });
const EMPTY_MANIFEST = Object.freeze({ version: 1, hooks: [] });

function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }

/**
 * @param {object} [opts]
 * @param {string} [opts.prefix]        mkdtemp prefix (default 'tf-home-')
 * @param {object} [opts.expose]        mcp/expose.json content (default empty store)
 * @param {object|'shipped'} [opts.manifest]  hooks/hooks.manifest.json content (default no hooks);
 *                                      'shipped' leaves it absent so the seed supplies the package's
 *                                      own manifest (the disabled example hooks) instead
 * @param {object} [opts.state]         tools/tools.state.json content (default {})
 * @param {object} [opts.serverConfig]  toolfunnel.json content (default absent)
 * @param {object} [opts.logConfig]     logs/log.config.json content (default absent)
 * @param {boolean} [opts.seed]         seed the shipped defaults NOW (register, scripts, hooks tree,
 *                                      mcp/servers mocks) instead of at gateway start - for a test
 *                                      whose expose.json must point at <home>/mcp/servers/... before
 *                                      the gateway runs, or that checks the fixture exists up front
 */
function makeTempHome(opts) {
  const o = opts || {};
  const home = fs.mkdtempSync(path.join(os.tmpdir(), o.prefix || 'tf-home-'));
  for (const d of ['mcp', 'hooks', 'tools', 'logs']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const t = {
    home,
    mcpDir: path.join(home, 'mcp'),
    expose: path.join(home, 'mcp', 'expose.json'),
    manifest: path.join(home, 'hooks', 'hooks.manifest.json'),
    hookState: path.join(home, 'hooks', 'hooks.state.json'),
    state: path.join(home, 'tools', 'tools.state.json'),
    register: path.join(home, 'tools', 'tools.register.json'),
    scriptsDir: path.join(home, 'tools', 'scripts'),
    logsDir: path.join(home, 'logs'),
    logConfig: path.join(home, 'logs', 'log.config.json'),
    serverConfig: path.join(home, 'toolfunnel.json'),
    /** Where the gateway seeds the shipped mock upstreams (mcp/servers/<name>/...) at startup. */
    mockDir: path.join(home, 'mcp', 'servers'),
  };
  writeJson(t.expose, o.expose || EMPTY_EXPOSE);
  if (o.manifest !== 'shipped') writeJson(t.manifest, o.manifest || EMPTY_MANIFEST);
  writeJson(t.state, o.state || {});
  if (o.serverConfig) writeJson(t.serverConfig, o.serverConfig);
  if (o.logConfig) writeJson(t.logConfig, o.logConfig);
  // ensureConfigHome copies only what is ABSENT, so the user-state files written above survive it.
  if (o.seed) require(path.join(REPO_ROOT, 'src', 'core', 'config-home.js')).ensureConfigHome(home);

  /** Copy a fixture into <home>/mcp/<name> (default: the fixture's basename). Returns the copy's path. */
  t.copyIntoMcp = (src, name) => {
    const to = path.join(t.mcpDir, name || path.basename(src));
    fs.copyFileSync(src, to);
    return to;
  };
  /** Write a JSON store in the home (any of the paths above, or an absolute path). */
  t.writeJson = writeJson;
  /** spawn() env: the parent's env plus the process-tree contract the gateway exports to its own
   *  children (TOOLFUNNEL_HOME = this home, TOOLFUNNEL_PKG = the package root, which a seeded tf-*
   *  script needs to find the engine), plus any extras. */
  t.env = (extra) => Object.assign({}, process.env, { TOOLFUNNEL_HOME: home, TOOLFUNNEL_PKG: REPO_ROOT }, extra || {});
  /** Best-effort removal of the home. */
  t.cleanup = () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_e) { /* best-effort */ } };
  return t;
}

/** makeTempHome + export TOOLFUNNEL_HOME for THIS process + seed via initConfigHome. See header. */
function useTempHome(opts) {
  const t = makeTempHome(opts);
  process.env.TOOLFUNNEL_HOME = t.home;
  require(path.join(REPO_ROOT, 'src', 'core', 'config-home.js')).initConfigHome({});
  process.on('exit', () => t.cleanup()); // best-effort; a file a src/ module still holds open just waits for the OS
  return t;
}

module.exports = { makeTempHome, useTempHome, writeJson, EMPTY_EXPOSE, EMPTY_MANIFEST, REPO_ROOT };
