'use strict';

/**
 * aggregator.js - the upstream-MCP connection + curated-expose layer.
 *
 * The aggregator is the bridge between the persisted MCP config (src/mcp/expose-store.js)
 * and the live upstream MCP servers (src/mcp/mcp-client.js). It:
 *
 *   1. CONNECTS one McpClient per ENABLED upstream in the ExposeStore (connectAll),
 *      caching the connected client + its discovered tools. A failed upstream never
 *      sinks the others - failures are collected, not thrown.
 *   2. DISCOVERS an upstream's tool surface on demand (discover) - what the MCP
 *      Manager UI's 'discover' button calls.
 *   3. Computes the CURATED-DIRECT tool definitions to advertise downstream
 *      (exposedToolDefinitions) - only for ENABLED expose[] entries whose upstream
 *      is connected, enabled, AND actually advertises the named tool. Each definition is
 *      renamed to its downstream `as` name (what the CLI / PreToolUse matchers see).
 *   4. RESOLVES a downstream call back to its upstream client + real tool name
 *      (resolveExposedExecution) - the seam the MCP server's curated-direct call
 *      path uses to actually execute, AFTER the hook gate has run.
 *
 * Decoupling note: downstream the CLI sees the renamed `as` tool; upstream we call
 * the REAL tool name. resolveExposedExecution carries BOTH so the gate (PreToolUse)
 * matches on the downstream name while execution hits the real upstream.
 *
 * SAFETY CONTRACT (mirrors expose-store.js / mcp-client.js):
 *   - connectAll / discover / closeAll NEVER throw. connectAll collects per-upstream
 *     failures into failed[]; a dead/misconfigured upstream cannot crash the server
 *     start. closeAll is idempotent and tears down every cached client.
 *   - The DEFAULT clientFactory enforces the HARD ISOLATION rule: a vendored upstream
 *     may only reference CODE/FILES inside the gateway root. The
 *     guard is applied to the ARGS (the script path, db files, ... that the interpreter
 *     is pointed at): any arg that is an absolute path, or that looks like a file path
 *     (contains a path separator), MUST resolve inside gatewayRoot - otherwise the factory
 *     throws and connectAll records the upstream in failed[]. The COMMAND slot is the
 *     interpreter/executable (node, npx, or an absolute path to a node binary that by
 *     definition lives OUTSIDE the project, e.g. process.execPath / a system node.exe)
 *     and is therefore NOT subject to the in-sandbox requirement - bare commands AND an
 *     absolute interpreter path are both allowed. Isolation is about WHAT CODE runs in
 *     the spawned process, not which interpreter binary runs it; the args are that code.
 *     This is what stops a config from pointing at a live `.mcp.json` server's script
 *     outside the sandbox while still letting the system node interpreter spawn it.
 *
 * CommonJS only. Node built-ins only. No new npm dependency. No @modelcontextprotocol/sdk.
 */

const path = require('node:path');

const { McpClient, PROTOCOL_VERSION: LEGACY_UPSTREAM_VERSION } = require('./mcp-client');
const logger = require('../core/logger');

// The sandbox root = the CONFIG HOME (TOOLFUNNEL_HOME / --config-dir; defaults to the package
// root - see src/core/config-home.js). Used as the isolation boundary the default clientFactory
// enforces: a pack's path-shaped upstream args live under the home, so the home is the boundary.
// A caller may override via opts.gatewayRoot for tests.
const { resolveConfigHome } = require('../core/config-home');
const DEFAULT_ROOT = resolveConfigHome();

/** True for a non-empty string. */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Does this argv token LOOK like a file path? An absolute path (path.isAbsolute) or
 * any token containing a path separator ('/' or '\\') is treated as a path reference
 * and must be confined to gatewayRoot. A bare token like 'node', 'npx', 'server' or a flag
 * like '--port' is NOT a path and is always allowed.
 * @param {string} arg
 * @returns {boolean}
 */
function looksLikePath(arg) {
  if (!isNonEmptyString(arg)) return false;
  if (path.isAbsolute(arg)) return true;
  // win32 DRIVE-RELATIVE form ('C:foo.js') - path.win32.isAbsolute() is false for it and it holds
  // no separator, so without this it looked like a bare token and skipped the guard entirely.
  if (/^[A-Za-z]:/.test(arg)) return true;
  return arg.indexOf('/') !== -1 || arg.indexOf('\\') !== -1;
}

/**
 * The path-shaped candidates inside a single argv token. A runtime option in `--flag=value` form
 * (node's --require=, --import=, --experimental-loader=, and their Deno/Bun kin) interprets only
 * the part AFTER the first '=' as a path. The whole token '--require=../x.js' carries no '..'
 * segment of its own, so a check of the token alone judges it inside the root while the child
 * resolves the value and leaves it. So the value after the first '=' is returned as its own
 * candidate, checked alongside the whole token. A non-path value ('--port=8080') simply fails
 * looksLikePath() and is ignored; an inside value still resolves inside and passes.
 * @param {string} arg
 * @returns {string[]}
 */
function argPathCandidates(arg) {
  if (!isNonEmptyString(arg)) return [];
  const out = [arg];
  const eq = arg.indexOf('=');
  if (eq !== -1 && eq < arg.length - 1) out.push(arg.slice(eq + 1));
  return out;
}

/**
 * Is this a win32 DRIVE-RELATIVE reference ('C:foo', drive letter + colon + no separator)?
 * It resolves against the CHILD's per-drive current directory - a base the guard cannot pin -
 * so it can never be PROVEN inside the root: path.resolve(root, 'C:x') judges it optimistically
 * when root shares the drive. There is no legitimate in-sandbox use (an inside path can always
 * be written absolutely or plainly relative), so it is refused outright wherever paths are
 * guarded. Checked on every platform: a config is portable and gets run somewhere else.
 * @param {string} t
 * @returns {boolean}
 */
function isDriveRelative(t) {
  return /^[A-Za-z]:(?![\\/])/.test(t);
}

// Environment variables that make a child load code, whatever its args say (0.7.0). Two classes with two rules. All platforms' vars are checked on all platforms because
// a config is portable and gets run somewhere else, and keys are compared CASE-INSENSITIVELY
// everywhere because Windows env lookup is case-insensitive - `node_options` reaches the child
// exactly as `NODE_OPTIONS` does, so an exact-case allowlist was a one-character bypass there.
//
// OPTION-STRING vars are a mini command line in the runtime's OWN grammar: quoting, `=` forms,
// `file:`/`data:` URLs, inspector flags. A path-shaped guard cannot verify them (quoted
// values, URL specifiers and a bare `--inspect` all defeat any tokeniser written here),
// and a guard that cannot verify must refuse, not guess. Refused outright in funnel mode; the
// operator's deliberate opt-out is `allowCodeLoadingEnv: true` on the upstream entry (the
// legacyPin pattern - off by default, visible in config, warned when it excuses something).
const CODE_OPT_ENV = [
  'NODE_OPTIONS',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'PERL5OPT',
  'RUBYOPT',
];
// PATH / PATH-LIST vars name locations directly and ARE checkable: extract pieces, judge each
// against the root. This list is a FLOOR, not a boundary - runtimes keep minting code-loading
// vars, and the `command` slot is arbitrary by design (see SECURITY.md: the guard is a tripwire
// for out-of-root references in an auditable config home, not a sandbox against an untrusted
// pack author).
const CODE_PATH_ENV = [
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',
  'PYTHONEXECUTABLE',
  'PERL5LIB',
  'RUBYLIB',
  'GEM_PATH',
  'CLASSPATH',
  'BASH_ENV',
  'ENV',
  'DOTNET_STARTUP_HOOKS',
  'CORECLR_PROFILER_PATH',
];

/**
 * Is `target` inside `root` (or equal to it)? Compares fully-resolved, normalised
 * absolute paths. A relative `target` is resolved AGAINST root (so 'vendor/x/server.js'
 * checks the in-sandbox location). Returns false for anything that escapes root via
 * '..' or an absolute path elsewhere on disk.
 * @param {string} root    absolute sandbox root
 * @param {string} target  path token (absolute or relative)
 * @returns {boolean}
 */
function isInside(root, target) {
  const resolvedRoot = path.resolve(root);
  // An absolute target is checked as-is; a relative one is resolved within the root so
  // a vendored relative path ('vendor/foo/server.js') is judged at its in-sandbox spot.
  const resolvedTarget = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(resolvedRoot, target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  // Inside iff the relative path neither starts with '..' nor is itself absolute
  // (an absolute `rel` happens on win32 across drive letters). '' (equal) counts as inside.
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * The DEFAULT clientFactory. Constructs a McpClient for an upstream entry AFTER
 * enforcing the isolation guard on the ARGS: every arg that looks like a file path
 * (an absolute path, or any token containing a path separator) must resolve inside
 * `gatewayRoot`. Throws a clear 'isolation: ...' error otherwise - connectAll catches that
 * into failed[].
 *
 * The COMMAND slot is intentionally NOT guarded: it names the interpreter/executable
 * (e.g. 'node', 'npx', or an absolute path to a node binary such as process.execPath /
 * a system node.exe) which by definition lives OUTSIDE the project. Isolation is about
 * WHAT CODE the spawned process runs - that is the args (the server script + any data
 * files it loads) - not which interpreter binary launches it. Guarding the command too
 * would wrongly reject every vendored upstream the moment it is run by the system node.
 *
 * @param {object} upstream  a normalised ExposeStore upstream { id, command, args, env, ... }
 * @param {string} gatewayRoot    the sandbox root the upstream's path-shaped ARGS must stay inside
 * @returns {McpClient}
 */
function defaultClientFactory(upstream, gatewayRoot, onClose, allowOutsidePaths, clientInfo, eraHint) {
  const id = isNonEmptyString(upstream && upstream.id) ? upstream.id : '(unknown)';
  const args = Array.isArray(upstream && upstream.args) ? upstream.args : [];
  // The caller passes TRUE for the wrapped upstream; the upstream may also claim the exemption for
  // itself in config. Either way it is decided HERE, per upstream, from THIS upstream's own entry -
  // there is no shared or latched state, so one server's opt-out can never relax another's guard.
  const outsideAllowed = allowOutsidePaths === true || (upstream && upstream.allowOutsidePaths === true);
  const byConfig = allowOutsidePaths !== true && outsideAllowed;

  // Guard every field that decides WHAT CODE the spawned process runs: path-shaped args, the cwd
  // they resolve against, and the env vars that load code irrespective of args. The command
  // (interpreter) is NOT guarded - see the function doc: it is the executable, not the code.
  // allowOutsidePaths: TRUE only for the currently-WRAPPED upstream (transparent-wrapper mode -
  // the operator explicitly made this server the entire surface, e.g. server-filesystem serving
  // a documents folder). Warn instead of refuse; funnel-mode upstreams keep the hard guard.
  // ONE notice per CLASS, not per upstream: `warnedPath` covers the path class (args + cwd); the
  // env section below keeps its OWN flag. A single shared flag let the first path finding consume
  // the only slot, so an env finding - the class that loads code - was excused in total silence,
  // precisely for the operator who opted out and most needs the audit trail.
  let warnedPath = false;
  const refuse = (what) => {
    if (outsideAllowed === true) {
      if (!warnedPath) {
        warnedPath = true;
        // Name the REAL reason. Reporting a config opt-out as transparent-wrapper mode would put a
        // false explanation in the operator's log for the one event they most need to trace.
        process.stderr.write(byConfig
          ? `[toolfunnel] isolation: upstream "${id}" reaches outside the gateway root (${what}) - ` +
            `permitted because its config sets allowOutsidePaths:true. This upstream is NOT isolated ` +
            `to the config home; every tool it serves runs with that exemption. Remove the flag to ` +
            `restore the guard, or gate the tools with a PreToolUse hook.\n`
          : `[toolfunnel] isolation: WRAPPED upstream "${id}" reaches outside the gateway root ` +
            `(${what}) - permitted in transparent-wrapper mode. To restrict what it can do post-wrap, see the ` +
            `manual's "Wrapping & security" section (PreToolUse gate, per-tool enabled:false).\n`);
      }
      return false; // permitted under the wrap, or by this upstream's own opt-out
    }
    throw new Error(`isolation: upstream ${id} references a path outside the gateway root`);
  };

  for (const arg of args) {
    // Check the whole token AND the value after a '=' (the --flag=value form the child splits) -
    // either escaping the root refuses the arg. The notice still names the whole token.
    const escapes = argPathCandidates(arg).some(
      (cand) => looksLikePath(cand) && (isDriveRelative(cand) || !isInside(gatewayRoot, cand))
    );
    if (escapes) {
      if (refuse(`arg "${arg}"`) === false) break; // one notice covers the path class
    }
  }

  // cwd - the SPAWN BASE (0.7.0). Guarded because it decides where a bare, separator-free arg like
  // 'server.js' actually resolves: looksLikePath() is false for such a token so the loop above
  // never sees it, while the child resolves it against cwd. Until 0.7.0 the comment below claimed
  // guard-base and spawn-base "agree by construction" - true only while cwd was unset.
  // Drive-relative gets the same outright refusal as everywhere else: 'C:denied' resolves
  // against the child's per-drive current directory, and isInside() judging it against the root
  // is optimistic-and-wrong whenever the root shares the drive.
  if (isNonEmptyString(upstream && upstream.cwd)
    && (isDriveRelative(upstream.cwd) || !isInside(gatewayRoot, upstream.cwd))) {
    refuse(`cwd "${upstream.cwd}"`);
  }

  // env - CODE-LOADING variables (0.7.0). A value in any of these loads code
  // into the child however clean the args are (reachable in-band: tf_mcp_add forwards env
  // verbatim). Keys are matched CASE-INSENSITIVELY on every platform - Windows env lookup is
  // case-insensitive, so `node_options` is `NODE_OPTIONS` to the child - and every platform's
  // variable is checked on every platform: a pack authored on Linux gets run on Windows and back.
  //
  // `allowCodeLoadingEnv: true` on the upstream entry is the operator's explicit opt-out for the
  // whole class: the finding downgrades to a once-per-upstream stderr warning naming the flag.
  const envObj = upstream && typeof upstream.env === 'object' && upstream.env ? upstream.env : null;
  if (envObj) {
    const envAllowed = (upstream && upstream.allowCodeLoadingEnv === true);
    // The env class's OWN notice flag - deliberately independent of `warnedPath` (see above).
    let warnedEnv = false;
    const envNotice = (why) => {
      if (warnedEnv) return;
      warnedEnv = true;
      process.stderr.write(`[toolfunnel] isolation: upstream "${id}" sets code-loading env ${why}`);
    };
    // Which flag excuses an env finding depends on its KIND:
    //   'opt'  - option-string vars (NODE_OPTIONS et al.): not path-checkable, so ONLY the class's
    //            own flag (allowCodeLoadingEnv) or the WRAP excuses them. allowOutsidePaths does
    //            NOT: it is documented (expose-store) as args/cwd/path-list scope, and letting the
    //            path flag silently disarm this separately-audited class was a cross-flag grant
    //            the operator never made.
    //   'path' - path-list vars (NODE_PATH et al.): inside the path flag's documented scope, so
    //            wrap, allowCodeLoadingEnv or allowOutsidePaths excuses - each loudly, by name.
    const refuseEnv = (what, kind) => {
      if (envAllowed) {
        envNotice(`(${what}) - permitted by allowCodeLoadingEnv:true on this upstream. Remove the ` +
          'flag to restore the refusal.\n');
        return false;
      }
      if (allowOutsidePaths === true) {
        envNotice(`(${what}) - permitted in transparent-wrapper mode (this upstream IS the ` +
          'surface). To restrict it post-wrap, see the manual\'s "Wrapping & security" section.\n');
        return false;
      }
      if (kind === 'path' && outsideAllowed === true) {
        envNotice(`(${what}) - permitted because its config sets allowOutsidePaths:true ` +
          '(path-list env is within that flag\'s scope). Remove the flag to restore the guard.\n');
        return false;
      }
      throw new Error(`isolation: upstream ${id} sets code-loading env (${what})`);
    };
    // Enumerate EXACTLY as child_process does: `for...in`, which walks own AND INHERITED keys
    // (node's normalizeSpawnArguments: "Prototype values are intentionally included"). An
    // Object.keys() walk was blind to a `__proto__` carrier - JSON.parse makes `__proto__` an OWN
    // data property, spread preserves it, and the client's Object.assign merge then uses [[Set]],
    // firing the Object.prototype.__proto__ setter and installing the payload as the merged env's
    // PROTOTYPE: invisible to Object.keys, delivered to the child.
    for (const key in envObj) {
      const upper = String(key).toUpperCase();
      // A `__proto__` key is refused OUTRIGHT, whatever it carries. It is not an env var: it is
      // the carrier that turns into the merged env's PROTOTYPE at the client's Object.assign, and
      // from there into real variables for the child (for..in). Nothing legitimate needs it.
      if (key === '__proto__') {
        refuseEnv('env "__proto__" (a prototype carrier, not an environment variable)', 'opt');
        continue;
      }
      // Judge the value as the spawn will USE it, not as it was authored. node builds each pair as
      // `${key}=${value}`, so a one-element array becomes its element verbatim and a number becomes
      // its digits. Testing isNonEmptyString FIRST let every non-string value skip both lists -
      // again the guard reading a different representation than the consumer. A value that cannot
      // even be coerced is unverifiable in a code-loading slot, so it is refused rather than
      // skipped (the same rule the option-string class already follows).
      const rawValue = envObj[key];
      if (rawValue === undefined || rawValue === null) continue;
      let raw;
      try {
        raw = typeof rawValue === 'string' ? rawValue : String(rawValue);
      } catch (_e) {
        if (CODE_OPT_ENV.includes(upper) || CODE_PATH_ENV.includes(upper)) {
          refuseEnv(`env ${key} (value cannot be read as a string, so it cannot be verified)`,
            CODE_OPT_ENV.includes(upper) ? 'opt' : 'path');
        }
        continue;
      }
      if (raw.length === 0) continue;
      if (CODE_OPT_ENV.includes(upper)) {
        // Not path-checkable (see the class doc above the lists) - the VALUE is irrelevant.
        if (refuseEnv(`env ${key} (option-string vars are not path-checkable)`, 'opt') === false) continue;
        continue;
      }
      if (!CODE_PATH_ENV.includes(upper)) continue;
      // Path / path-list value: pieces are EXTRACTED (not split) so a drive-lettered piece
      // ('C:\x', 'C:x') survives whole on every platform - splitting 'C:relative\denied' on ':'
      // yields fragments that resolve inside the root while the child resolves the real path
      // outside it. Both ';' and ':' end a piece everywhere (a POSIX filename containing ';'
      // may be shredded and falsely refused - conservative, never a false allow).
      const parts = (raw.match(/[A-Za-z]:[^;:]*|[^;:]+/g) || []).filter((t) => t.length > 0);
      if (parts.length === 0) continue;
      if (parts.some((t) => isDriveRelative(t) || !isInside(gatewayRoot, t))) {
        refuseEnv(`env ${key}="${raw}"`, 'path');
      }
    }
  }

  return new McpClient({
    id: upstream.id,
    command: upstream.command,
    args: upstream.args,
    env: upstream.env,
    // Child cwd from config - the wrap era-probe reads it too; it never survived the store
    // before. Default = the CONFIG HOME (gatewayRoot), NOT the gateway's process cwd:
    // the isolation guard above resolves relative args against the home, so the spawn must
    // resolve them against the SAME base or a guard-passing relative path fails to spawn
    // whenever --config-dir differs from the launch directory (guard-base and spawn-base agree
    // by construction).
    cwd: isNonEmptyString(upstream && upstream.cwd) ? upstream.cwd : gatewayRoot,
    // Per-upstream `timeoutMs` config -> the client's PAYLOAD window (tools/call | prompts/get |
    // resources/read; default 120 s).
    toolTimeoutMs: Number.isFinite(upstream && upstream.timeoutMs) && upstream.timeoutMs > 0
      ? upstream.timeoutMs : undefined,
    // Per-upstream `requestTimeoutMs` config -> the CONTROL window (handshake/list/discover/
    // ping; default 10 s = the dead-upstream detector). Opt-in for slow-boot servers that
    // cannot answer initialize inside 10 s - without it they can never be attached at all.
    requestTimeoutMs: Number.isFinite(upstream && upstream.requestTimeoutMs) && upstream.requestTimeoutMs > 0
      ? upstream.requestTimeoutMs : undefined,
    // legacyPin FORCES the legacy era: skip the modern server/discover probe and go straight to
    // the initialize handshake, so a pinned upstream is genuinely spoken to as 2024-11-05 (the pin
    // is an ENFORCED policy, not just a warning). Off by default.
    forceLegacy: !!(upstream && upstream.legacyPin === true),
    // modernOnly (legacyPin's mirror): refuse the legacy fallback - a non-modern upstream fails
    // the connect with a clear error instead of negotiating down. Store validation refuses the
    // legacyPin+modernOnly contradiction before it ever reaches here.
    modernOnly: !!(upstream && upstream.modernOnly === true),
    // The aggregator's era memo (last successful connect): 'legacy' lets a reconnect skip the
    // server/discover probe. The client ignores it under modernOnly; the aggregator clears it on
    // a failed connect and on an explicit reconnect().
    eraHint: eraHint === 'legacy' ? 'legacy' : undefined,
    // clientInfo: the identity presented to this upstream (identity mirroring / configured
    // identity). null/undefined -> McpClient's built-in default, wire behaviour unchanged.
    clientInfo: clientInfo || undefined,
    onClose, // unexpected death -> the aggregator schedules a background reconnect
  });
}

/**
 * Aggregator - owns the live upstream connections and the curated-expose computation.
 *
 * Lifecycle: `new Aggregator({ store, gatewayRoot, clientFactory })`
 *            -> `await connectAll()` (or `await discover(id)` lazily)
 *            -> `exposedToolDefinitions()` / `resolveExposedExecution(name, args)`
 *            -> `await closeAll()` (idempotent).
 */
class Aggregator {
  /**
   * @param {object} opts
   * @param {object} opts.store            an ExposeStore (the on-disk MCP config).
   * @param {string} [opts.gatewayRoot]         sandbox root for the isolation guard (default: the gateway root).
   * @param {Function} [opts.clientFactory] (upstreamEntry, gatewayRoot) -> McpClient. Default enforces isolation.
   * @param {Function} [opts.wrapTargetProvider] () -> the currently-WRAPPED upstream id (or null).
   *        Read fresh at each connect: the wrapped upstream is EXEMPT from the path-isolation
   *        guard (by design - a wrap is an explicit "this server IS my whole
   *        surface" declaration, so ToolFunnel is a transparent wrapper in that incidence; the
   *        operator gets a strong warning + post-wrap restriction docs instead of a refusal).
   *        Funnel-mode upstreams keep the guard unchanged.
   * @param {Function} [opts.clientInfoProvider] (upstreamId) -> {name, version}|null. The identity
   *        to PRESENT to that upstream. Read fresh at each connect (same pattern as the wrap-target
   *        provider) so a mirror captured after boot is honoured by the next (re)connect. null ->
   *        McpClient's built-in default.
   */
  constructor({ store, gatewayRoot, clientFactory, onToolsChanged, wrapTargetProvider, clientInfoProvider } = {}) {
    if (!store || typeof store !== 'object') {
      throw new Error('Aggregator: a `store` (ExposeStore) is required');
    }
    this._store = store;
    this._gatewayRoot = isNonEmptyString(gatewayRoot) ? gatewayRoot : DEFAULT_ROOT;
    // Called when the LIVE tool set changes OUT OF BAND (a background reconnect recovers or finally
    // loses an upstream) so the transport can emit notifications/tools/list_changed. Default no-op;
    // the server wires it to emitToolsListChanged(send). Settable so reloadExpose can re-wire the
    // new instance.
    this.onToolsChanged = typeof onToolsChanged === 'function' ? onToolsChanged : () => {};
    // Called with (upstreamId, notification) for each server-initiated CHANGE notification from an
    // upstream (resources/updated, resources/list_changed, prompts/list_changed, tools/list_changed)
    // so the transport can bridge it to a modern client's subscriptions/listen stream. Default no-op;
    // the server/http host wires it. Settable so reloadExpose can re-wire the new instance.
    this.onUpstreamNotification = () => {};
    // Called with (upstreamId, requestMsg, client) for each SERVER-INITIATED REQUEST from an
    // upstream (elicitation/create, sampling/createMessage, roots/list - the elicitation bridge). The handler
    // owns answering via client.respondToServer(Error). Default: -32601, so an unwired build
    // never leaves an upstream holding an open request. Settable; reloadExpose carries it over.
    this.onUpstreamServerRequest = (uid, msg, client) => {
      try { client.respondToServerError(msg.id, -32601, 'Method not found: ' + msg.method); } catch (_e) { /* never throw */ }
    };
    // When a passthrough WRAP is active, the wrapped upstream's request-scoped chatter
    // (notifications/message, notifications/progress) also bridges - connected directly, the
    // client would receive it. The server keeps this current with the live wrap state.
    this.wrapChatterUpstream = null;
    this._wrapTargetProvider = typeof wrapTargetProvider === 'function' ? wrapTargetProvider : null;
    this._clientInfoProvider = typeof clientInfoProvider === 'function' ? clientInfoProvider : null;
    // The factory receives (upstream, gatewayRoot, onClose). A caller-supplied factory may ignore the
    // extra args; the default uses gatewayRoot for isolation and onClose for death-driven reconnect.
    // The wrap-target check runs PER CONNECT (fresh provider read), so a wrap set after boot is
    // honoured by the next connect attempt.
    this._clientFactory =
      typeof clientFactory === 'function'
        ? (upstream, onClose) => clientFactory(upstream, this._gatewayRoot, onClose)
        : (upstream, onClose) => defaultClientFactory(upstream, this._gatewayRoot, onClose,
            this._isWrapTarget(upstream && upstream.id),
            this._readClientInfo(upstream && upstream.id),
            this._eraMemo.get(upstream && upstream.id));

    /** @type {Map<string, object>} upstreamId -> connected McpClient */
    this._clients = new Map();
    /** @type {Map<string, Array>} upstreamId -> discovered tool defs [{name,description,inputSchema}] */
    this._tools = new Map();
    /** @type {Map<string, Promise>} upstreamId -> in-flight connect promise (race guard for ensureConnected) */
    this._connecting = new Map();
    /** @type {Set<string>} agreed resource-subscription URIs - replayed onto every (re)connect
     * of a subscribe-capable legacy upstream so the channel survives reconnects */
    this._subscribedUris = new Set();
    /** @type {Map<string, number>} uri -> LISTEN-owned refcount. subscribeResources
     * increments; releaseResources decrements and unsubscribes upstream at zero. The wrap-forward
     * recording (a client's own resources/subscribe) writes the Set directly and is NOT counted
     * here - the client manages that lifetime itself. */
    this._subscribedRefs = new Map();
    /** @type {Map<string, any>} upstreamId -> pending background-reconnect timer (one per upstream) */
    this._reconnectTimers = new Map();
    /** @type {Set<string>} upstreams whose reconnect ATTEMPT is currently executing (between the timer
     * firing - which deletes its own entry from _reconnectTimers - and the attempt settling). While an
     * id is in here, _handleUpstreamDown must NOT seed a fresh attempt-0: the in-flight attempt's own
     * catch owns the next backoff step. Without this, a death DURING an attempt's tools/list re-seeds
     * the 1s floor and the one-timer guard then swallows the escalation - a permanent 1s respawn loop. */
    this._reconnecting = new Set();
    /** @type {Map<string, 'modern'|'legacy'>} upstreamId -> era negotiated at the LAST successful
     * connect. A death-driven reconnect passes it to the client as eraHint so a legacy upstream
     * skips the server/discover probe (worst case ~3s against a server that silently drops unknown
     * methods) instead of re-paying it on every respawn. Lifecycle: SET on a successful connect,
     * CLEARED when a connect fails (the hinted attempt may be why - the next retry re-negotiates
     * in full, so an upstream upgraded across a restart self-heals) and by an explicit reconnect()
     * (a manual kick deliberately re-negotiates). A config reload swaps in a fresh Aggregator, so
     * a changed entry never inherits a stale memo. */
    this._eraMemo = new Map();
    /** Set true by closeAll(). A torn-down aggregator (e.g. swapped out by reloadExpose) must NEVER
     *  (re)connect - a captured execute thunk holding this instance would otherwise spawn an orphan
     *  upstream child on it that nothing ever closes. ensureConnected/connectAll check this. */
    this._closed = false;
  }

  /**
   * Connect every ENABLED upstream in the store, caching each connected client and its
   * discovered tools. NEVER throws - a per-upstream failure (isolation guard, spawn
   * failure, handshake timeout, listTools failure) is collected into failed[]. An
   * upstream already connected (cached) is treated as connected without reconnecting.
   *
   * @returns {Promise<{ connected: string[], failed: Array<{id:string, error:string}> }>}
   */
  async connectAll() {
    const connected = [];
    const failed = [];
    if (this._closed) return { connected, failed }; // a closed (torn-down) aggregator never connects

    let upstreams;
    try {
      upstreams = this._store.listUpstreams();
    } catch (err) {
      // listUpstreams() shouldn't throw (it clones), but never let it sink connectAll.
      return { connected, failed: [{ id: '(store)', error: errMsg(err) }] };
    }

    for (const upstream of upstreams) {
      if (!upstream || upstream.enabled !== true) continue; // only ENABLED upstreams

      const id = upstream.id;
      if (this._clients.has(id)) {
        // Already connected this session - keep it; don't double-spawn.
        connected.push(id);
        continue;
      }

      try {
        await this._connectOne(upstream);
        connected.push(id);
      } catch (err) {
        // Clean up any half-built client so a failure leaves no zombie/cache entry.
        this._discard(id);
        const error = errMsg(err);
        logger.log({ type: 'mcp', event: 'connect_failed', upstream: id, error });
        failed.push({ id, error });
      }
    }

    return { connected, failed };
  }

  /**
   * Discover one upstream's tool surface. Connects the upstream if it isn't already
   * (lazily, honouring the isolation guard), runs tools/list, caches and returns the
   * raw tool definitions [{name, description, inputSchema}]. This is what the MCP
   * Manager 'discover' button calls.
   *
   * Unlike connectAll this MAY reject (it is a direct user action, so the UI wants the
   * error) - but it cleans up a failed connection so no zombie child is left.
   *
   * @param {string} upstreamId
   * @returns {Promise<Array<{name:string, description?:string, inputSchema?:object}>>}
   */
  async discover(upstreamId) {
    if (!isNonEmptyString(upstreamId)) {
      throw new Error('Aggregator.discover: upstreamId (non-empty string) is required');
    }

    // Route through ensureConnected: it JOINS an in-flight connect via _connecting instead of
    // racing it - two concurrent discover() calls used to double-spawn the child and leak the
    // loser without closing it. ensureConnected also reaps its own failed connects.
    // allowDisabled: discover is the ONE caller permitted to connect a disabled upstream -
    // inspecting its tools pre-enable worked before the race fix and stays supported.
    try {
      await this.ensureConnected(upstreamId, { allowDisabled: true });
    } catch (err) {
      throw new Error(`Aggregator.discover: cannot connect "${upstreamId}": ${errMsg(err)}`);
    }
    // Re-list even when the fast path returned a cached client - the discover button must always
    // reflect live state (a fresh connect lists twice; cheap, and the semantics stay honest).
    return await this._listAndCache(upstreamId);
  }

  /**
   * @returns {Object<string, Array>} a clone map of upstreamId -> cached discovered tools.
   * Only includes upstreams that have been connected/discovered this session.
   */
  toolsByUpstream() {
    const out = {};
    for (const [id, tools] of this._tools) {
      out[id] = cloneTools(tools);
    }
    return out;
  }

  /**
   * The CURATED-DIRECT tool definitions to advertise downstream. For each ENABLED
   * expose[] entry whose upstream is CONNECTED, ENABLED and ACTUALLY advertises the named tool:
   *   - name        = store.exposedName(entry)  (the downstream `as` name)
   *   - description = '[' + upstream + '] ' + (upstream tool description || 'tool')
   *   - inputSchema = the upstream tool's inputSchema || { type:'object' }
   *
   * Entries whose upstream isn't connected, is explicitly disabled (the row's own flag
   * cannot override the upstream's - a discover-cached client doesn't re-admit it), or
   * whose named tool the upstream doesn't advertise, are silently skipped.
   *
   * @returns {Array<{name:string, description:string, inputSchema:object}>}
   */
  exposedToolDefinitions() {
    const defs = [];
    let exposed;
    try {
      exposed = this._store.listExposed({ enabledOnly: true });
    } catch (_err) {
      return defs; // never throw out of a definition build
    }

    for (const e of exposed) {
      if (!e || !this._clients.has(e.upstream)) continue; // upstream not connected
      const upstream = this._store.getUpstream(e.upstream);
      if (upstream && upstream.enabled === false) continue; // skip an explicitly-disabled upstream
      const upstreamTools = this._tools.get(e.upstream) || [];
      const upstreamTool = upstreamTools.find((t) => t && t.name === e.tool);
      if (!upstreamTool) continue; // upstream doesn't actually advertise this tool

      const name = this._store.exposedName(e);
      const desc =
        isNonEmptyString(upstreamTool.description) ? upstreamTool.description : 'tool';
      const inputSchema =
        upstreamTool.inputSchema && typeof upstreamTool.inputSchema === 'object'
          ? upstreamTool.inputSchema
          : { type: 'object' };

      defs.push(withForwardedToolMeta({
        name,
        description: `[${e.upstream}] ${desc}`,
        inputSchema: sanitiseXMcpHeaders(cloneJson(inputSchema)),
      }, upstreamTool));
    }
    return defs;
  }

  /**
   * The upstream ids in STORE order (expose.json's own sequence) - the stable advertisement
   * order handleToolsList's hot-upstream block iterates by. Connection-map order
   * shifts on death/recovery re-insertion; the store's order never does. NEVER throws.
   * @returns {string[]}
   */
  upstreamOrder() {
    try {
      return this._store.listUpstreams().map((u) => u && u.id).filter(Boolean);
    } catch (_e) {
      return [];
    }
  }

  /**
   * Is `name` a downstream `as` name currently exposed (enabled) AND backed by a
   * connected upstream that advertises the underlying tool? Mirrors the set
   * exposedToolDefinitions() advertises.
   * @param {string} name
   * @returns {boolean}
   */
  isExposed(name) {
    return this._findExposedExecution(name) !== null;
  }

  /**
   * Resolve a downstream `as` name + args into an executor. Returns
   *   { execute, toolName, upstream }  | null
   * where:
   *   - execute()  invokes the connected client's callTool(<real upstream tool name>, args)
   *   - toolName   = the downstream `as` (what PreToolUse matchers see - the gate matches
   *                  the downstream name, execution hits the real upstream tool)
   *   - upstream   = the upstream id
   * Returns null if `name` is not exposed/enabled or its upstream isn't connected.
   *
   * @param {string} name  downstream `as` name
   * @param {any}    args   structured arguments forwarded verbatim to callTool
   * @returns {{ execute: Function, toolName: string, upstream: string } | null}
   */
  resolveExposedExecution(name, args, meta) {
    const hit = this._findExposedExecution(name);
    if (!hit) return null;
    const { client, realTool, upstream, exposedName } = hit;
    return {
      // The execute thunk is the seam the server calls AFTER the PreToolUse gate allows it.
      execute: this._forwardExecutor(client, realTool, args, meta),
      toolName: exposedName, // downstream name - the gate's matcher target
      upstream,
    };
  }

  // ── lean register forwarding ──────────────────────────────────────
  // The LEAN path surfaces an attached upstream's tools through the 4 meta-tools (toolfunnel_list_tools
  // / _tool_instructions / _run_tool) instead of injecting them top-level every turn. The full
  // discovered set of every CONNECTED + enabled upstream is surfaced (attaching an MCP makes its
  // tools appear with no per-tool curation); expose[]/hot governs only the SEPARATE top-level
  // (curated-direct) promotion. A lean tool is surfaced under its enabled expose `as` if one exists,
  // else the namespaced default `<upstream>_<tool>` - so the lean name equals the curated-direct name
  // for an exposed tool and ONE PreToolUse rule gates both routes. All of this lives here in the
  // aggregator (it owns the connections, the _clients/_tools caches, and the connect log chokepoint).

  /**
   * The single forward seam: a thunk that calls the upstream's real tool. Shared by the
   * curated-direct path (resolveExposedExecution, transparent envelope passthrough) and the lean
   * path (resolveLeanExecution, which unwraps). Kept tiny so both routes execute identically.
   * @param {object} client   a connected McpClient
   * @param {string} realTool the upstream's own tool name
   * @param {any}    args
   * @returns {() => Promise<any>}
   */
  _forwardExecutor(client, realTool, args, meta) {
    return () => {
      this._warnIfPinned(client.id, realTool);
      return client.callTool(realTool, args, meta);
    };
  }

  /**
   * Legacy shim PER-CALL warning (the pin's contract: warn on every forwarded call, naming the
   * upstream + version). Called from BOTH forward paths - curated-direct (_forwardExecutor) and
   * lean (resolveLeanExecution's own closure; it cannot use _forwardExecutor because it needs
   * ensureConnected + envelope unwrapping). Checked at CALL time so a live expose.json edit takes
   * effect immediately; stderr + activity log, never the content. NEVER throws.
   * @param {string} upstreamId
   * @param {string} realTool  the upstream's own tool name
   */
  _warnIfPinned(upstreamId, realTool) {
    try {
      const upstream = this._store.getUpstream(upstreamId);
      if (upstream && upstream.legacyPin === true) {
        process.stderr.write(
          `[toolfunnel] legacy shim: forwarding "${realTool}" to pinned legacy upstream ` +
            `"${upstreamId}" (MCP ${LEGACY_UPSTREAM_VERSION})\n`
        );
        logger.log({ type: 'mcp', event: 'legacy_shim_call', upstream: upstreamId, tool: realTool, protocolVersion: LEGACY_UPSTREAM_VERSION });
      }
    } catch (_e) { /* the warning must never affect the call */ }
  }

  /**
   * Legacy-shim info for a surfaced OR original call name: { upstream, protocolVersion } when the
   * tool belongs to a PINNED (legacyPin) upstream, else null. Used by the modern era to tag
   * results with _meta["io.toolfunnel/legacyShim"] - metadata, never content. NEVER throws.
   * @param {string} name  the name a client called (surfaced `<upstream>_<tool>`/`as`, or the
   *                       ORIGINAL tool name under passthrough)
   * @returns {{ upstream: string, protocolVersion: string } | null}
   */
  legacyShimInfo(name) {
    if (typeof name !== 'string' || name.length === 0) return null;
    try {
      const d = this.leanToolDefinitions().find((x) => x && (x.name === name || x.tool === name));
      if (!d) return null;
      const upstream = this._store.getUpstream(d.upstream);
      if (!upstream || upstream.legacyPin !== true) return null;
      return { upstream: d.upstream, protocolVersion: LEGACY_UPSTREAM_VERSION };
    } catch (_e) {
      return null;
    }
  }

  /**
   * The wrapped upstream's OWN identity, extracted from its captured `initialize` result - so a
   * passthrough WRAP can present the wrapped server verbatim (indistinguishable from connecting to
   * it directly, save for the ToolFunnel process). Returns { protocolVersion, serverInfo,
   * capabilities, instructions } with best-effort extraction (some servers nest capabilities /
   * instructions inside serverInfo), or null if the upstream isn't connected. NEVER throws.
   * @param {string} upstreamId
   * @returns {{ protocolVersion?:string, serverInfo?:object, capabilities?:object, instructions?:string } | null}
   */
  wrappedIdentity(upstreamId) {
    try {
      const client = this._clients.get(upstreamId);
      if (!client || typeof client.initializeResult === 'undefined') return null;
      const init = client.initializeResult;
      if (!init || typeof init !== 'object') return null;
      const si = init.serverInfo && typeof init.serverInfo === 'object' ? init.serverInfo : {};
      // serverInfo passes VERBATIM minus the two fields some servers wrongly nest inside it
      // (capabilities/instructions - extracted separately below). A whitelist here ate the spec's
      // own serverInfo.title (2025-06-18) through the wrap - proven against the real
      // server-everything (found wire-testing the wrap, 2026-07-17). Blocklist, so future identity fields survive.
      const serverInfo = {};
      for (const k of Object.keys(si)) {
        if (k === 'capabilities' || k === 'instructions') continue;
        serverInfo[k] = cloneJson(si[k]);
      }
      return {
        protocolVersion: typeof init.protocolVersion === 'string' ? init.protocolVersion : undefined,
        serverInfo: Object.keys(serverInfo).length ? serverInfo : undefined,
        // capabilities / instructions: prefer top-level (standard), fall back to serverInfo-nested.
        capabilities: (init.capabilities && typeof init.capabilities === 'object') ? init.capabilities
          : (si.capabilities && typeof si.capabilities === 'object') ? si.capabilities : undefined,
        instructions: typeof init.instructions === 'string' ? init.instructions
          : typeof si.instructions === 'string' ? si.instructions : undefined,
      };
    } catch (_e) {
      return null;
    }
  }

  /**
   * Forward a RAW JSON-RPC method to a connected upstream and return its result - the passthrough
   * WRAP's relay for non-tool methods (resources/*, prompts/*, logging/*, ping...) so a wrapped
   * server behaves exactly as it would connected directly. Uses a LIVE client only (no synchronous
   * (re)connect - same rule as the lean run path). Throws if the upstream is not connected or the
   * call fails; the caller shapes that into a JSON-RPC error.
   * @param {string} upstreamId
   * @param {string} method
   * @param {any} params
   * @returns {Promise<any>}
   */
  async forwardRaw(upstreamId, method, params, out) {
    const client = await this.ensureConnected(upstreamId, { allowConnect: false });
    if (!client || typeof client.request !== 'function') {
      throw new Error(`upstream "${upstreamId}" is not connected`);
    }
    return await client.request(method, params, out);
  }

  /** The clientInfo to PRESENT to `upstreamId`, or null for the built-in. Fresh provider read per
   *  call (per-connect, same as the wrap-target check); NEVER throws. */
  _readClientInfo(upstreamId) {
    try {
      const info = this._clientInfoProvider ? this._clientInfoProvider(upstreamId) : null;
      return info && typeof info === 'object' &&
        typeof info.name === 'string' && info.name.length ? info : null;
    } catch (_e) {
      return null; // a broken provider degrades to the built-in identity
    }
  }

  /** Is `upstreamId` the currently-wrapped upstream? Fresh provider read per call; NEVER throws.
   *  Drives the per-connect isolation exemption (transparent-wrapper mode). */
  _isWrapTarget(upstreamId) {
    try {
      return !!(this._wrapTargetProvider && isNonEmptyString(upstreamId) &&
        this._wrapTargetProvider() === upstreamId);
    } catch (_e) {
      return false; // a broken provider must degrade to the SAFE default (guard applies)
    }
  }

  /** Set the wrap-chatter scope. When the passthrough TARGET CHANGES (A->B, A->null, null->A) the
   *  recorded resource subscriptions belong to the OLD context and must not replay onto the new
   * one - a client of wrap B never subscribed to wrap A's URIs. A
   *  same-value re-arm (every message does one) clears nothing. */
  setWrapChatterUpstream(v) {
    const next = v == null ? null : v;
    if (next !== this.wrapChatterUpstream && this._subscribedUris instanceof Set) {
      this._subscribedUris.clear();
      if (this._subscribedRefs instanceof Map) this._subscribedRefs.clear(); // 5.4: refs go with the context
    }
    this.wrapChatterUpstream = next;
  }

  /** Relay a client NOTIFICATION to an upstream (wrap passthrough: notifications/cancelled,
   *  notifications/progress ...). Fire-and-forget; never throws, never answers. */
  notifyRaw(upstreamId, method, params) {
    try {
      const client = this._clients.get(upstreamId);
      if (client && typeof client.notify === 'function') client.notify(method, params);
    } catch (_e) { /* fire-and-forget */ }
  }

  /** TRUE if a connected upstream can ACTUALLY deliver per-URI resource updates. That means a
   *  LEGACY upstream advertising resources.subscribe (we forward the subscribes; it emits
   *  resources/updated). A MODERN upstream does NOT count: its only notification channel is a
   *  subscriptions/listen stream this client does not yet open (28-July item), so counting it
   * agreed a channel nothing would ever feed. Under a wrap only the WRAPPED
   *  upstream counts - delivery is filtered to it, so another upstream honouring the channel
   * would be agreed-then-dropped. The ack must never promise a dead channel. */
  canHonourResourceSubscriptions() {
    for (const [id, client] of this._clients) {
      if (!client) continue;
      if (this.wrapChatterUpstream && id !== this.wrapChatterUpstream) continue;
      if (client.era === 'modern') continue;
      const caps = client.initializeResult && client.initializeResult.capabilities;
      if (caps && caps.resources && caps.resources.subscribe) return true;
    }
    return false;
  }

  /** Best-effort: forward resources/subscribe for each URI to every subscribe-capable legacy
   *  upstream in scope (the wrapped one only, under a wrap). The URIs are RECORDED
   *  so every later (re)connect replays them: a reconnected upstream is a fresh process that
   *  remembers no subscriptions, and without the replay the client's agreed channel went silently
   * dead forever. Fire-and-forget; never throws. */
  subscribeResources(uris) {
    try {
      const list = Array.isArray(uris) ? uris.filter((u) => typeof u === 'string' && u.length) : [];
      if (!list.length) return;
      // 5.4: refcount per LISTEN-owned uri; the upstream subscribe is sent on the 0->1 crossing
      // only (a re-listen agreeing the same uri must not spam idempotent subscribes).
      const fresh = [];
      for (const uri of list) {
        const n = this._subscribedRefs.get(uri) || 0;
        this._subscribedRefs.set(uri, n + 1);
        if (!this._subscribedUris.has(uri)) { this._subscribedUris.add(uri); fresh.push(uri); }
      }
      if (!fresh.length) return;
      for (const [id, client] of this._clients) {
        if (this.wrapChatterUpstream && id !== this.wrapChatterUpstream) continue;
        if (!client || client.era !== 'legacy' || typeof client.request !== 'function') continue;
        const caps = client.initializeResult && client.initializeResult.capabilities;
        if (!(caps && caps.resources && caps.resources.subscribe)) continue;
        for (const uri of fresh) client.request('resources/subscribe', { uri }).catch(() => {});
      }
    } catch (_e) { /* never throw */ }
  }

  /**
   * Release LISTEN-owned resource subscriptions (the refcount leak's fix). Decrements each
   * uri's refcount; on the 1->0 crossing the uri leaves the replay set and the upstream is told
   * resources/unsubscribe (same scope rules as subscribeResources). ACCEPTED EDGE, documented:
   * a uri subscribed BOTH by a listen agreement and a client's own wrap-forwarded
   * resources/subscribe shares one upstream channel - when the last listen releases, the
   * upstream unsubscribe fires and the recorded Set entry goes with it (the exotic overlap is
   * not disambiguated). NEVER throws.
   * @param {string[]} uris
   */
  releaseResources(uris) {
    try {
      const list = Array.isArray(uris) ? uris.filter((u) => typeof u === 'string' && u.length) : [];
      if (!list.length) return;
      const gone = [];
      for (const uri of list) {
        const n = this._subscribedRefs.get(uri) || 0;
        if (n <= 1) {
          if (n === 1) this._subscribedRefs.delete(uri);
          if (this._subscribedUris.has(uri)) { this._subscribedUris.delete(uri); gone.push(uri); }
        } else {
          this._subscribedRefs.set(uri, n - 1);
        }
      }
      if (!gone.length) return;
      for (const [id, client] of this._clients) {
        if (this.wrapChatterUpstream && id !== this.wrapChatterUpstream) continue;
        if (!client || client.era !== 'legacy' || typeof client.request !== 'function') continue;
        const caps = client.initializeResult && client.initializeResult.capabilities;
        if (!(caps && caps.resources && caps.resources.subscribe)) continue;
        for (const uri of gone) client.request('resources/unsubscribe', { uri }).catch(() => {});
      }
    } catch (_e) { /* never throw */ }
  }

  /** Replay the recorded resource subscriptions onto ONE freshly-connected upstream.
   *  Called from _connectOne so every connect path - startup, lazy, background reconnect, reload -
   *  re-arms the channel. Same scope rules as subscribeResources. Never throws. */
  _replaySubscriptions(upstreamId) {
    try {
      if (!this._subscribedUris || this._subscribedUris.size === 0) return;
      if (this.wrapChatterUpstream && upstreamId !== this.wrapChatterUpstream) return;
      const client = this._clients.get(upstreamId);
      if (!client || client.era !== 'legacy' || typeof client.request !== 'function') return;
      const caps = client.initializeResult && client.initializeResult.capabilities;
      if (!(caps && caps.resources && caps.resources.subscribe)) return;
      for (const uri of this._subscribedUris) client.request('resources/subscribe', { uri }).catch(() => {});
    } catch (_e) { /* never throw */ }
  }

  /** The change-notification methods an upstream may push that we bridge to modern clients. Anything
   *  else from the upstream is ignored (request-scoped notifications ride their own request stream). */
  static get BRIDGED_NOTIFICATIONS() {
    return new Set([
      'notifications/tools/list_changed',
      'notifications/prompts/list_changed',
      'notifications/resources/list_changed',
      'notifications/resources/updated',
    ]);
  }

  /**
   * Forward a server-initiated CHANGE notification from an upstream to the transport hook, which
   * fans it to modern subscriptions/listen streams. Only the known change methods pass; the
   * notification is handed on verbatim (the transport tags + filters per subscription). NEVER
   * throws (an onNotification handler must never break the client's read loop).
   * @param {string} upstreamId
   * @param {object} notification  a JSON-RPC notification { method, params? }
   */
  _forwardUpstreamNotification(upstreamId, notification) {
    try {
      if (this._closed) return; // a swapped-out/torn-down aggregator must never fan out (F9)
      if (!notification || typeof notification.method !== 'string') return;
      // tasks/status rides the wrap-chatter lane too: the wrap advertises the
      // upstream's `tasks` capability verbatim, so a task started through the wrap owes its
      // status notifications exactly as a direct connection would deliver them (2025-11-25
      // schema TaskStatusNotification). Wrapped upstream only - same scope as message/progress.
      const isWrapChatter = this.wrapChatterUpstream === upstreamId &&
        (notification.method === 'notifications/message' || notification.method === 'notifications/progress' ||
         notification.method === 'notifications/tasks/status');
      if (!Aggregator.BRIDGED_NOTIFICATIONS.has(notification.method) && !isWrapChatter) return;
      // Forward a CLEAN notification only - a misbehaving upstream's stray `id: null` field would
      // read as a response to downstream parsers (F7).
      const clean = { jsonrpc: '2.0', method: notification.method };
      if (notification.params !== undefined) clean.params = notification.params;
      const emit = () => {
        try {
          if (typeof this.onUpstreamNotification === 'function') {
            this.onUpstreamNotification(upstreamId, clean);
          }
        } catch (_e) { /* never let a bridged notification break the read loop */ }
      };
      if (notification.method === 'notifications/tools/list_changed') {
        // A relayed "tools changed" must not point the client at a STALE surface - refresh the
        // cache FIRST, then relay, so the re-fetch sees the new list (F2/B-M4). onToolsChanged
        // fires too so ToolFunnel's own funnel-mode signal stays coherent.
        this._listAndCache(upstreamId)
          .then(() => { try { if (typeof this.onToolsChanged === 'function') this.onToolsChanged(); } catch (_e) { /* ignore */ } })
          .catch(() => { /* refresh failed - still relay; the old cache is the best we have */ })
          .then(emit);
        return;
      }
      emit();
    } catch (_e) { /* never let a bridged notification break the read loop */ }
  }

  /**
   * The downstream name a discovered upstream tool is surfaced under: its ENABLED expose `as` if one
   * exists for (upstream, tool), else the namespaced default `<upstream>_<tool>` (matching
   * expose-store.exposedName). Keeps the lean list and the lean run path in agreement, and aligns an
   * exposed tool's lean name with its curated-direct top-level name. Never throws.
   * @param {string} upstreamId
   * @param {string} toolName
   * @returns {string}
   */
  _surfacedName(upstreamId, toolName) {
    try {
      const exposed = this._store.listExposed({ enabledOnly: true });
      for (const e of exposed) {
        if (e && e.upstream === upstreamId && e.tool === toolName) return this._store.exposedName(e);
      }
    } catch (_e) {
      /* fall through to the default */
    }
    return `${upstreamId}_${toolName}`;
  }

  /**
   * Connect an upstream ON DEMAND and return the ready McpClient. Idempotent + race-safe:
   *   - fast path: a cached client that is still `connected` is returned as-is; a cached-but-DEAD
   *     client (its child exited - McpClient flips `connected` but stays in the cache) is logged as a
   *     disconnect, discarded, and reconnected - a reconnect re-lists the upstream's tools.
   *   - concurrent callers JOIN the same in-flight connect promise (keyed in _connecting), which
   *     resolves only AFTER _listAndCache - so no caller ever sees the half-built client that
   *     _connectOne caches BEFORE the handshake completes (the double-spawn / mid-handshake race).
   * Throws on an unknown/disabled upstream or a connect/list failure (the caller surfaces it; for the
   * lean run path that means gatedRun returns { ok:false, error } cleanly).
   * @param {string} upstreamId
   * @returns {Promise<object>} the connected McpClient
   */
  async ensureConnected(upstreamId, opts) {
    if (!isNonEmptyString(upstreamId)) throw new Error('Aggregator.ensureConnected: upstreamId (non-empty string) is required');
    // allowConnect:false (the RUN path) must NEVER block on a connect - not a from-scratch connect
    // (connect()+tools/list, ~20s, would freeze the serialized stdio chain and starve pings) AND not
    // by JOINING an in-flight background reconnect (same latency). It returns a live client or fails
    // clean; the background reconnect owns recovery and the run retries next turn. allowConnect
    // defaults true (the background path connects / joins).
    const allowConnect = !(opts && opts.allowConnect === false);
    // allowDisabled: ONLY the discover path sets it - inspecting a disabled upstream's tools
    // ("what does this have, before I enable it?") is a deliberate operator action that worked
    // before discover was routed through here for the race fix. Every
    // other caller keeps the refusal; a disabled upstream's tools stay OFF the lean surface
    // regardless (leanToolDefinitions checks enabled itself).
    const allowDisabled = !!(opts && opts.allowDisabled === true);
    // A torn-down aggregator (swapped out by reloadExpose, then closeAll'd) must NEVER (re)connect:
    // a captured execute thunk holding this instance would otherwise spawn an ORPHAN child on it.
    if (this._closed) throw new Error('Aggregator.ensureConnected: aggregator is closed (config reloaded) - retry on the current one');

    // A connect already in flight: JOIN it - BEFORE inspecting the cache. _connectOne caches the
    // client pre-handshake, so a concurrent caller inspecting first sees `connected:false`, reads
    // it as stale, closes it (killing the in-flight child mid-handshake) and then joins the
    // connect it just doomed - both callers fail. The RUN path
    // (allowConnect:false) still never joins - joining would block the stdio chain.
    if (this._connecting.has(upstreamId)) {
      if (!(opts && opts.allowConnect === false)) return this._connecting.get(upstreamId);
      throw new Error(`Aggregator.ensureConnected: upstream "${upstreamId}" is not connected (reconnecting in background)`);
    }

    // Fast path: a live cached client serves BOTH modes immediately.
    const existing = this._clients.get(upstreamId);
    if (existing) {
      const alive = typeof existing.connected === 'boolean' ? existing.connected : true;
      if (alive) return existing;
      // Dead cached client. The RUN path fails clean (never (re)connects); the background path drops
      // it and reconnects below.
      if (!allowConnect) {
        throw new Error(`Aggregator.ensureConnected: upstream "${upstreamId}" disconnected (reconnecting in background)`);
      }
      logger.log({ type: 'mcp', event: 'disconnect', upstream: upstreamId, reason: 'stale' });
      this._discard(upstreamId);
    } else if (!allowConnect) {
      // Not connected. The RUN path neither connects NOR joins an in-flight connect - joining would
      // block the stdio chain for the connect+list latency (the head-of-line freeze this mode avoids).
      throw new Error(`Aggregator.ensureConnected: upstream "${upstreamId}" is not connected (reconnecting in background)`);
    }

    // Background path only (allowConnect): connect from scratch. In-flight connects were joined
    // at the top of the method (before cache inspection - the mid-connect discard race); nothing
    // between there and here awaits, so no new entry can have appeared.
    const upstream = this._store.getUpstream(upstreamId);
    if (!upstream) throw new Error(`Aggregator.ensureConnected: unknown upstream "${upstreamId}"`);
    if (upstream.enabled !== true && !allowDisabled) throw new Error(`Aggregator.ensureConnected: upstream "${upstreamId}" is disabled`);

    const promise = (async () => {
      await this._connectOne(upstream); // caches client + tools, logs the connect
      return this._clients.get(upstreamId);
    })();
    this._connecting.set(upstreamId, promise);
    try {
      return await promise;
    } catch (err) {
      this._discard(upstreamId); // reap the half-spawned child; leave no zombie/cache entry
      throw err;
    } finally {
      this._connecting.delete(upstreamId);
    }
  }

  /**
   * Force a fresh connect of `upstreamId` presenting the CURRENT provider-supplied identity -
   * the wrap identity-mirror's inline path. Settles any in-flight connect FIRST: discarding a
   * half-built client and then joining its doomed promise leaves the upstream wedged with no
   * background reconnect and no self-heal. Rejects
   * like ensureConnected on failure.
   */
  async reconnect(upstreamId) {
    if (!isNonEmptyString(upstreamId)) throw new Error('Aggregator.reconnect: upstreamId (non-empty string) is required');
    while (this._connecting.has(upstreamId)) {
      try { await this._connecting.get(upstreamId); } catch (_e) { /* settled is all we need */ }
    }
    this._discard(upstreamId);
    // A MANUAL kick deliberately re-runs the full era negotiation - the operator may have just
    // upgraded the server, and "reconnect" should observe reality, not replay a memo of it.
    this._eraMemo.delete(upstreamId);
    try {
      return await this.ensureConnected(upstreamId);
    } catch (err) {
      // This path DESTROYED a (possibly healthy) connection, and the deliberate close means
      // onClose never fires - without this, one transient connect failure leaves no client, no
      // in-flight connect AND no retry timer: the upstream is wedged until an external kick
      // while ensureConnected's "reconnecting in background" message lies. The destroyer owns the retry. A stale PENDING timer (a prior death's slow
      // 30s keepalive) must be cleared first - _scheduleReconnect's one-timer guard would
      // otherwise no-op and leave the upstream on the long window instead of the immediate
      // retry this path promises.
      const stale = this._reconnectTimers.get(upstreamId);
      if (stale) { clearTimeout(stale); this._reconnectTimers.delete(upstreamId); }
      this._scheduleReconnect(upstreamId, 0);
      throw err;
    }
  }

  /**
   * UNEXPECTED upstream death (fired by McpClient.onClose). Log it, drop the dead client so it
   * leaves the lean list, tell the client the tool set shrank, then schedule a BACKGROUND reconnect.
   * Keeping recovery off the serialized stdio chain is what closes the head-of-line regression: a run
   * during the down-window fails clean (ensureConnected allowConnect:false) instead of blocking.
   * @param {string} upstreamId
   */
  _handleUpstreamDown(upstreamId) {
    if (this._closed) return;
    logger.log({ type: 'mcp', event: 'disconnect', upstream: upstreamId, reason: 'died' });
    this._discard(upstreamId); // remove the dead client + its tools -> drops from the lean list
    this._signalToolsChanged(upstreamId); // list_changed only if the upstream is on the top-level surface
    // If a reconnect ATTEMPT is already executing, it owns the next backoff step (its catch escalates
    // attempt+1). Seeding attempt-0 here would reset the delay to 1s on every mid-attempt death, and
    // the one-timer guard would then swallow the attempt's escalation - a permanent 1s respawn loop.
    // Only start a fresh cycle when no attempt is in flight (the ordinary first death of a live upstream).
    if (this._reconnecting.has(upstreamId)) return;
    this._scheduleReconnect(upstreamId, 0);
  }

  /**
   * Does this upstream contribute to the TOP-LEVEL tools/list (i.e. has an ENABLED expose[] entry)?
   * Only then does its death/recovery change tools/list and warrant a notifications/tools/list_changed.
   * A lean-only upstream's tools live behind toolfunnel_list_tools (pulled per call), so notifying for
   * one is spurious (the client re-fetches and sees no diff). Never throws.
   * @param {string} upstreamId
   * @returns {boolean}
   */
  _affectsTopLevel(upstreamId) {
    try {
      // Under a WRAP the wrapped upstream IS the entire top-level surface - its death/recovery
      // changes tools/list even with an empty expose[] (a typical wrap has no expose
      // entries, so death/recovery was silent and clients held a stale surface forever).
      // wrapChatterUpstream mirrors the live wrap state (armed at boot, per message, on reload).
      if (this.wrapChatterUpstream && this.wrapChatterUpstream === upstreamId) return true;
      // Hot-promoted upstream tools sit on the funnel's top-level surface without an expose[]
      // entry; the host injects this predicate (armWrapChatter) because promotion lives in the
      // tool-state overlay the aggregator has no business reading directly.
      if (typeof this.topLevelUpstreamExtra === 'function' && this.topLevelUpstreamExtra(upstreamId)) return true;
      return this._store.listExposed({ enabledOnly: true }).some((e) => e && e.upstream === upstreamId);
    } catch (_e) {
      return false;
    }
  }

  /** Fire onToolsChanged ONLY when the upstream is actually on the top-level surface (else the
   *  notification is spurious - its lean tools refresh on the next toolfunnel_list_tools). Never throws. */
  _signalToolsChanged(upstreamId) {
    if (!this._affectsTopLevel(upstreamId)) return;
    try { this.onToolsChanged(); } catch (_e) { /* never throw out of an event handler */ }
  }

  /**
   * Schedule ONE background reconnect attempt with exponential backoff: 1s,2s,4s,8s,16s, then capped
   * at 30s. After the fast phase it does NOT give up - it falls back to a slow 30s keepalive so a long
   * transient outage still self-heals (a detached/disabled upstream stops it via getUpstream; closeAll
   * stops it via _closed). On success the tools are re-listed and a top-level change is signalled. One
   * timer per upstream (no pile-up); the timer is unref'd so it never keeps the process alive. NEVER throws.
   * @param {string} upstreamId
   * @param {number} attempt
   */
  _scheduleReconnect(upstreamId, attempt) {
    if (this._closed) return;
    if (this._reconnectTimers.has(upstreamId)) return; // a reconnect is already pending for this id
    const upstream = this._store.getUpstream(upstreamId);
    if (!upstream || upstream.enabled !== true) return; // detached/disabled - stop trying
    const MAX_FAST_ATTEMPTS = 6; // exponential phase; beyond it, a slow keepalive at the 30s cap
    const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
    const timer = setTimeout(async () => {
      this._reconnectTimers.delete(upstreamId);
      if (this._closed) return;
      const u = this._store.getUpstream(upstreamId);
      if (!u || u.enabled !== true) return;
      // Mark the attempt in flight so a death DURING ensureConnected's connect/list (onClose ->
      // _handleUpstreamDown) does not re-seed attempt-0: THIS attempt's catch owns the escalation.
      this._reconnecting.add(upstreamId);
      try {
        await this.ensureConnected(upstreamId); // allowConnect default - connects + re-lists, off-chain
        logger.log({ type: 'mcp', event: 'reconnect', upstream: upstreamId, attempt });
        this._signalToolsChanged(upstreamId);
      } catch (err) {
        logger.log({ type: 'mcp', event: 'reconnect_failed', upstream: upstreamId, attempt, error: errMsg(err) });
        // Log the fast->slow transition exactly ONCE - when the counter FIRST reaches the cap. The
        // old guard sat on the re-entry side, where the capped counter re-satisfied it every 30s
        // forever against a permanently-dead upstream (log spam, not information).
        if (attempt + 1 === MAX_FAST_ATTEMPTS) {
          logger.log({ type: 'mcp', event: 'reconnect_slow', upstream: upstreamId, attempts: MAX_FAST_ATTEMPTS });
        }
        // Keep escalating to the cap, then keep retrying slowly (cap the counter so the delay stays
        // at 30s) - never permanently give up while the upstream stays enabled. The escalation is
        // scheduled while still in flight (the guard below checks _reconnectTimers, which is empty
        // because a mid-attempt death was skipped) - the finally then releases the marker.
        this._scheduleReconnect(upstreamId, Math.min(attempt + 1, MAX_FAST_ATTEMPTS));
      } finally {
        this._reconnecting.delete(upstreamId);
      }
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    this._reconnectTimers.set(upstreamId, timer);
  }

  /**
   * The LEAN tool definitions: every discovered tool of every CONNECTED + enabled upstream, surfaced
   * for toolfunnel_list_tools. Each: { name, description, inputSchema, upstream, tool }. The FULL
   * discovered set (not just expose[]) - attaching an MCP makes its tools appear leanly with no
   * curation. Only connected upstreams contribute (we need their real schemas); a not-yet-connected
   * upstream's tools simply appear once it connects (the next list call reflects it - no
   * notification needed, the lean surface is delivered inside a per-call meta-tool). Never throws.
   * @returns {Array<{name:string, description:string, inputSchema:object, upstream:string, tool:string}>}
   */
  leanToolDefinitions() {
    const defs = [];
    const seen = new Set(); // surfaced-name collision guard - the list must agree with resolve (first wins)
    try {
      for (const [upstreamId, tools] of this._tools) {
        if (!this._clients.has(upstreamId)) continue; // connected only
        const upstream = this._store.getUpstream(upstreamId);
        if (upstream && upstream.enabled === false) continue; // skip an explicitly-disabled upstream
        if (!Array.isArray(tools)) continue;
        for (const t of tools) {
          if (!t || !isNonEmptyString(t.name)) continue;
          const name = this._surfacedName(upstreamId, t.name);
          if (seen.has(name)) {
            // Two tools collapse to one surfaced name (underscore ambiguity, or a duplicate `as`).
            // resolveLeanExecution returns the FIRST match, so advertise only the first - the list
            // must never show a name that resolves to a different tool. Log the shadowing.
            logger.log({ type: 'mcp', event: 'name_collision', upstream: upstreamId, tool: t.name, surfaced: name });
            continue;
          }
          seen.add(name);
          const schema = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object' };
          defs.push(withForwardedToolMeta({
            name,
            description: isNonEmptyString(t.description) ? t.description : '',
            inputSchema: sanitiseXMcpHeaders(cloneJson(schema)),
            upstream: upstreamId,
            tool: t.name,
          }, t));
        }
      }
    } catch (_e) {
      /* never throw out of a definition build - return what we have */
    }
    return defs;
  }

  /**
   * Resolve a lean downstream name + args into a forwarding executor for toolfunnel_run_tool. Matches
   * by ITERATION over discovered tools (computing each tool's surfaced name) - never by parsing the
   * name (underscore-ambiguous). The execute thunk lazy-(re)connects via ensureConnected and UNWRAPS
   * the upstream MCP envelope to a clean payload, so run_tool returns the upstream's content (e.g.
   * "pong"), not a stringified envelope. The connect is INSIDE the thunk -> a PreToolUse deny spawns
   * nothing. The gate matches `toolName` (the surfaced name). Returns null if no connected + enabled
   * upstream advertises a tool with this surfaced name (-> protocol's clean "not runnable" error) -
   * the same connected/enabled predicate leanToolDefinitions lists by, so hidden means not runnable.
   * @param {string} name surfaced downstream name
   * @param {any}    args
   * @returns {{ execute: () => Promise<any>, toolName: string, upstream: string } | null}
   */
  resolveLeanExecution(name, args) {
    if (!isNonEmptyString(name)) return null;
    for (const [upstreamId, tools] of this._tools) {
      if (!this._clients.has(upstreamId)) continue;
      const upstream = this._store.getUpstream(upstreamId);
      if (upstream && upstream.enabled === false) continue; // skip an explicitly-disabled upstream
      if (!Array.isArray(tools)) continue;
      for (const t of tools) {
        if (!t || !isNonEmptyString(t.name)) continue;
        if (this._surfacedName(upstreamId, t.name) !== name) continue;
        const realTool = t.name;
        const self = this;
        const execute = async () => {
          // allowConnect:false - the run path NEVER synchronously (re)connects (that would freeze the
          // stdio loop, starving pings). It uses a live client or joins an in-flight background
          // reconnect, else fails clean; the onClose-driven background reconnect owns recovery.
          const client = await self.ensureConnected(upstreamId, { allowConnect: false });
          self._warnIfPinned(upstreamId, realTool);
          const envelope = await client.callTool(realTool, args);
          // Preserve the upstream's failure signal. callTool RESOLVES even on isError:true, so a
          // failed upstream call must become a THROW -> gatedRun returns { ok:false } -> run_tool
          // surfaces isError:true. Otherwise a failed call would be reported as success - and the
          // lean path must agree with curated-direct's isError passthrough.
          const payload = unwrapEnvelope(envelope);
          if (envelope && typeof envelope === 'object' && envelope.isError === true) {
            const text = typeof payload === 'string' ? payload : safeStringify(payload);
            const err = new Error(text && text.length ? text : 'upstream tool reported an error');
            err.upstreamToolError = true;
            throw err;
          }
          return payload;
        };
        return { execute, toolName: name, upstream: upstreamId };
      }
    }
    return null;
  }

  /**
   * resolveRawExecution - the passthrough (WRAP) twin of resolveLeanExecution. Its execute returns
   * the upstream's tools/call result VERBATIM - multi-block content, isError, structuredContent
   * and any future fields untouched. A wrapped client must receive exactly what a direct client
   * would; the lean unwrap (single text block, throw-on-isError) destroys that. No unwrap, no
   * throw-on-isError: the envelope IS the product. Uses client.request() so a modern upstream
   * gets its per-request _meta trio.
   * @param {string} name surfaced downstream name
   * @param {any}    args
   * @returns {{ execute: () => Promise<any>, toolName: string, upstream: string } | null}
   */
  resolveRawExecution(name, args, meta, out) {
    if (!isNonEmptyString(name)) return null;
    for (const [upstreamId, tools] of this._tools) {
      if (!this._clients.has(upstreamId)) continue;
      const upstream = this._store.getUpstream(upstreamId);
      if (upstream && upstream.enabled === false) continue; // skip an explicitly-disabled upstream
      if (!Array.isArray(tools)) continue;
      for (const t of tools) {
        if (!t || !isNonEmptyString(t.name)) continue;
        if (this._surfacedName(upstreamId, t.name) !== name) continue;
        const realTool = t.name;
        const self = this;
        const execute = async () => {
          // allowConnect:false - same freeze-avoidance rule as the lean path.
          const client = await self.ensureConnected(upstreamId, { allowConnect: false });
          self._warnIfPinned(upstreamId, realTool);
          const params = { name: realTool, arguments: args == null ? {} : args };
          // The caller's request-scoped _meta (progressToken, trace keys - already stripped of
          // protocol keys) rides the forward: a direct server would receive it, so the wrapped
          // one must too - without it the upstream never emits progress for the call.
          if (meta && typeof meta === 'object' && Object.keys(meta).length) params._meta = meta;
          // `out.rpcId` is set synchronously at issue time - the caller's cancel-translation
          // hook (the same contract as forwardRaw's).
          return await client.request('tools/call', params, out);
        };
        return { execute, toolName: name, upstream: upstreamId };
      }
    }
    return null;
  }

  /**
   * Close every cached client and clear the caches. Idempotent - safe to call twice and
   * safe when nothing was ever connected. NEVER throws (close() on McpClient never throws).
   * @returns {Promise<void>}
   */
  async closeAll() {
    this._closed = true; // latch BEFORE teardown so any in-flight execute thunk refuses to re-spawn
    for (const [, timer] of this._reconnectTimers) {
      try { clearTimeout(timer); } catch (_e) { /* ignore */ }
    }
    this._reconnectTimers.clear();
    this._reconnecting.clear(); // no in-flight attempt survives teardown (its finally is a no-op then)
    for (const [id, client] of this._clients) {
      try {
        if (client && typeof client.close === 'function') client.close();
        // Activity log (self-gating): the disconnect half. A reload closes the old aggregator here,
        // so a reconnect reads as a disconnect line followed by a connect line for the same id.
        logger.log({ type: 'mcp', event: 'disconnect', upstream: id });
      } catch (_e) {
        /* McpClient.close never throws, but never let teardown sink the loop */
      }
    }
    this._clients.clear();
    this._tools.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Connect a single upstream entry and cache the client + its discovered tools.
   * Throws on factory (isolation), connect, or listTools failure - callers decide
   * whether to collect (connectAll) or surface (discover) the error. On throw, the
   * caller is responsible for _discard()-ing the id.
   * @param {object} upstream  a normalised ExposeStore upstream
   */
  async _connectOne(upstream) {
    // The factory may throw (isolation guard) - that propagates out as a connect failure. Pass an
    // onClose so an UNEXPECTED upstream death triggers a BACKGROUND reconnect (not a lazy one in the
    // run path, which would freeze the stdio chain).
    const client = this._clientFactory(upstream, () => this._handleUpstreamDown(upstream.id));
    if (!client || typeof client.connect !== 'function') {
      throw new Error(`clientFactory returned an invalid client for "${upstream.id}"`);
    }
    // Bridge this upstream's server-initiated change-notifications to the transport (which fans them
    // out to modern subscriptions/listen streams). Filtered to the known change methods so arbitrary
    // upstream chatter never reaches a client. NEVER throws.
    client.onNotification = (n) => this._forwardUpstreamNotification(upstream.id, n);
    // Elicitation bridge: surface server-initiated requests with the upstream id + the live client (the
    // handler answers on it). Guarded so a handler bug can never break the client's read loop.
    client.onServerRequest = (m) => {
      try {
        if (this._closed) { client.respondToServerError(m.id, -32603, 'shutting down'); return; }
        this.onUpstreamServerRequest(upstream.id, m, client);
      } catch (_e) {
        try { client.respondToServerError(m.id, -32603, 'request failed'); } catch (_e2) { /* ignore */ }
      }
    };
    // Cache the client BEFORE connect so a connect-failure path can still _discard() and
    // close any half-spawned child.
    this._clients.set(upstream.id, client);
    try {
      await client.connect();
      // The LIST is part of the connect contract: a handshake that cannot list its tools is a
      // FAILED connect to every caller, and the era observation must not outlive it either.
      await this._listAndCache(upstream.id);
    } catch (err) {
      // The failed attempt may have been era-HINTED (probe skipped on the memo). Whatever the
      // cause - handshake or the post-handshake list - a failure invalidates the observation:
      // clear it so the NEXT attempt re-runs the full negotiation. An upstream upgraded to
      // modern-only across a restart recovers on the following backoff retry instead of failing
      // hinted forever.
      this._eraMemo.delete(upstream.id);
      throw err;
    }
    // Remember the negotiated era so a death-driven reconnect can skip the probe (eraHint) - but
    // only a DEFINITIVE observation (the probe was ANSWERED). A probe that timed out proves
    // nothing about the upstream's eras, and memoising that fallback would pin a merely-SLOW
    // dual-era upstream to legacy on every future reconnect. A hinted connect (probe skipped)
    // leaves the existing memo in place.
    if (client.eraDefinitive !== false) this._eraMemo.set(upstream.id, client.era);
    // Re-arm any agreed resource subscriptions on the fresh process - every connect
    // path funnels through here, so reconnects and reloads replay uniformly.
    this._replaySubscriptions(upstream.id);
    // Activity log (self-gating; no-op unless logging is enabled): the upstream half of connect
    // logging. EVERY connect flows through here - startup connectAll, a live reload, a lazy
    // discover, and (later) a health-driven reconnect - so all of them are logged uniformly.
    logger.log({
      type: 'mcp',
      event: 'connect',
      upstream: upstream.id,
      command: upstream.command,
      tools: (this._tools.get(upstream.id) || []).length,
    });
    // Legacy shim STARTUP warning (the pin's contract: warn at startup AND per call, naming the
    // version). stderr, so the operator sees it without the client's content ever growing.
    if (upstream.legacyPin === true) {
      try {
        process.stderr.write(
          `[toolfunnel] legacy shim: upstream "${upstream.id}" is PINNED to MCP ${LEGACY_UPSTREAM_VERSION} ` +
            '(legacyPin) - this gateway keeps it working for modern clients; it cannot speak 2026-07-28 itself.\n'
        );
      } catch (_e) { /* never let a warning sink a connect */ }
      logger.log({ type: 'mcp', event: 'legacy_shim_connect', upstream: upstream.id, protocolVersion: LEGACY_UPSTREAM_VERSION });
    }
  }

  /** tools/list one connected upstream and cache the result; returns a clone. */
  async _listAndCache(upstreamId) {
    const client = this._clients.get(upstreamId);
    if (!client) throw new Error(`no connected client for "${upstreamId}"`);
    const tools = await client.listTools();
    const safe = Array.isArray(tools) ? tools.filter((t) => t && isNonEmptyString(t.name)) : [];
    this._tools.set(upstreamId, safe);
    return cloneTools(safe);
  }

  /** Tear down + forget a cached client (used on a failed connect). Never throws. */
  _discard(upstreamId) {
    const client = this._clients.get(upstreamId);
    if (client && typeof client.close === 'function') {
      try { client.close(); } catch (_e) { /* never throw */ }
    }
    this._clients.delete(upstreamId);
    this._tools.delete(upstreamId);
  }

  /**
   * Shared lookup behind isExposed / resolveExposedExecution: find the ENABLED expose
   * entry whose downstream name === `name`, whose upstream is connected AND enabled, and
   * whose real tool the upstream advertises. Returns the resolution context or null.
   * @param {string} name
   * @returns {{ client:object, realTool:string, upstream:string, exposedName:string } | null}
   */
  _findExposedExecution(name) {
    if (!isNonEmptyString(name)) return null;
    let exposed;
    try {
      exposed = this._store.listExposed({ enabledOnly: true });
    } catch (_err) {
      return null;
    }
    for (const e of exposed) {
      if (!e) continue;
      if (this._store.exposedName(e) !== name) continue;
      const client = this._clients.get(e.upstream);
      if (!client) continue; // upstream not connected
      const upstream = this._store.getUpstream(e.upstream);
      if (upstream && upstream.enabled === false) continue; // skip an explicitly-disabled upstream
      const upstreamTools = this._tools.get(e.upstream) || [];
      if (!upstreamTools.some((t) => t && t.name === e.tool)) continue; // tool not advertised
      return { client, realTool: e.tool, upstream: e.upstream, exposedName: name };
    }
    return null;
  }
}

// ── small helpers (no external deps) ───────────────────────────────────────────

/** Extract a clean message from any thrown value. */
function errMsg(err) {
  return (err && err.message) || String(err);
}

/** JSON.stringify that never throws (circular/oddball values fall back to String). */
function safeStringify(value) {
  try { return JSON.stringify(value); } catch (_e) { return String(value); }
}

/**
 * Turn an upstream MCP tools/call envelope { content:[...], isError? } into a clean payload for the
 * LEAN run path. A single text block -> its string (so toolfunnel_run_tool returns "pong", matching
 * what the curated-direct content passthrough surfaces); otherwise the content array; otherwise the
 * value as-is when it isn't an envelope. This is what avoids double-wrapping the envelope as JSON
 * inside wrapProtocolResult (the curated-direct path passes the envelope through transparently
 * instead; the lean path goes through protocol.runTool -> wrapProtocolResult, so it unwraps here).
 * NOTE: an upstream isError:true is surfaced as its text content with ok:true (homogeneous
 * with how local tools surface error text) - mapping isError -> ok:false is a later concern.
 * @param {*} envelope
 * @returns {*}
 */
function unwrapEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return envelope;
  const content = envelope.content;
  if (Array.isArray(content)) {
    if (content.length === 1 && content[0] && content[0].type === 'text' && typeof content[0].text === 'string') {
      return content[0].text;
    }
    return content;
  }
  return envelope;
}

/** Plain-JSON deep clone (schemas are JSON; structuredClone may be absent on old node). */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** The upstream tool-def metadata the funnel FORWARDS onto advertised defs.
 *  ICONS ARE WITHHELD by policy: 2025-11-25 and 2026-07-28 both require icon consumers to
 *  verify icon URIs are SAME-ORIGIN with the server, so gateway-forwarded icons are third-party
 *  URLs a conforming client must reject - or worse, trust as ours. Reversible (adding a field
 *  later is non-breaking); the decision is open - forwarding them later flips it here. */
const FORWARDED_TOOL_META = Object.freeze(['title', 'annotations', 'outputSchema', '_meta', 'execution']);

/** Selectively copy the forwardable metadata from a RAW discovered def onto an advertised def.
 *  NEVER a spread: lean defs carry internal routing ids (upstream/tool), and a spread would
 *  also inherit unknown future fields sight-unseen (the explicit selective-add rule). Mutates + returns def. */
function withForwardedToolMeta(def, raw) {
  if (!raw || typeof raw !== 'object') return def;
  for (const k of FORWARDED_TOOL_META) {
    if (raw[k] !== undefined && def[k] === undefined) def[k] = cloneJson(raw[k]);
  }
  return def;
}

/** HTTP field-name token syntax (RFC 9110 §5.1) - the constraint on x-mcp-header values. */
const XMCP_TCHAR = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Strip INVALID `x-mcp-header` annotations from an advertised inputSchema, in place (0.7.0
 * ingest hygiene). The spec makes a single malformed annotation invalidate the WHOLE tool -
 * conforming Streamable-HTTP clients MUST drop it from tools/list - so forwarding a broken
 * upstream annotation verbatim makes the tool vanish client-side. Valid = on a pure
 * `properties` chain from the root, a non-empty tchar token, on a string/integer/boolean
 * param, case-insensitively unique among the valid set. Everything else is deleted (the TOOL
 * survives; the annotation was the contaminant). The WRAP path stays raw-verbatim - a wrapped
 * server's brokenness is presented faithfully, exactly as a direct connection would.
 * @param {object} schema  the advertised (already-cloned) inputSchema - mutated
 * @returns {object} schema
 */
function sanitiseXMcpHeaders(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const valid = [];  // { node, name } - candidates that pass every per-node rule
  const strip = [];  // nodes whose annotation is deleted
  (function walk(node, onChain) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (Object.prototype.hasOwnProperty.call(node, 'x-mcp-header')) {
      const v = node['x-mcp-header'];
      const okType = node.type === 'string' || node.type === 'integer' || node.type === 'boolean';
      if (onChain && typeof v === 'string' && XMCP_TCHAR.test(v) && okType) valid.push({ node, name: v.toLowerCase() });
      else strip.push(node);
    }
    for (const k of Object.keys(node)) {
      const child = node[k];
      if (!child || typeof child !== 'object') continue;
      if (k === 'properties' && !Array.isArray(child)) {
        for (const sub of Object.values(child)) walk(sub, onChain); // the chain continues
      } else if (Array.isArray(child)) {
        for (const el of child) walk(el, false); // items/oneOf/... break the chain
      } else {
        walk(child, false);
      }
    }
  })(schema, true);
  const seen = new Map();
  for (const e of valid) seen.set(e.name, (seen.get(e.name) || 0) + 1);
  for (const e of valid) if (seen.get(e.name) > 1) strip.push(e.node); // ambiguous duplicates: all go
  for (const n of strip) delete n['x-mcp-header'];
  return schema;
}

/** Clone an array of tool defs so callers can't mutate the aggregator's cache. */
function cloneTools(tools) {
  return Array.isArray(tools) ? tools.map((t) => cloneJson(t)) : [];
}

module.exports = {
  Aggregator,
  // exported for unit tests / reuse
  defaultClientFactory,
  looksLikePath,
  isInside,
  unwrapEnvelope,
  DEFAULT_ROOT,
  // 3.7: the forwardable def metadata + the selective-add - server.js's hot-promotion
  // projection uses the same list so the two advertised paths can never drift apart again.
  FORWARDED_TOOL_META,
  withForwardedToolMeta,
  // 4.3: ingest hygiene for x-mcp-header annotations (exported for tests).
  sanitiseXMcpHeaders,
  // A3: the wrap-time SECURITY NOTICE (bin/toolfunnel.js) enumerates the same classes the guard
  // judges - shared lists, so the two surfaces can never classify differently.
  isDriveRelative,
  CODE_OPT_ENV,
  CODE_PATH_ENV,
};
