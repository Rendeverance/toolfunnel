# Known bugs

The **Open** list is what remains open as of 0.8.2. **Fixed in 0.8.2**, **Fixed in 0.8.1** and
**Fixed in 0.8.0** mark the defects an earlier user could meet that those releases closed. The full
change list is in [CHANGELOG.md](../CHANGELOG.md) and the
[release notes](https://github.com/Rendeverance/toolfunnel/releases).

## Open

- **OPEN - Modern-upstream subscriptions are not received.** The client does not yet open a
  `subscriptions/listen` stream to modern upstreams, so their change-notifications never arrive;
  the listen ack honestly refuses `resourceSubscriptions` when no legacy subscribe-capable
  upstream is in scope.
- **OPEN - The elicitation bridge does not cover legacy clients.** A wrapped upstream's mid-call
  `elicitation/create` bridges to MODERN clients as MRTR (`input_required` + retry), form and url
  mode, gated on the caller's declared capability. A LEGACY client gets an automatic
  decline instead - relaying backwards requests to legacy clients is unbuilt - and
  `sampling/createMessage` / `roots/list` from upstreams are answered `-32601`. An elicitation can
  only be bound to a call when exactly ONE wrapped call is in flight for that upstream (always
  true on stdio); ambiguous concurrent HTTP calls decline rather than guess.
- **OPEN (deferred) - HTTP cancels are dropped rather than translated.** The sessionless modern
  era gives a POST no connection identity, so a client `notifications/cancelled` arriving over
  HTTP is dropped rather than risk cancelling another client's call. Fixing this needs design
  thought - identifying the caller without reintroducing sessions - so it is deferred rather than
  patched. stdio (one client per pipe) translates and forwards cancels for both forwarded methods
  and wrapped tool calls; the remaining best-effort windows there are sub-millisecond (a cancel
  racing the instant a forward is issued) plus the PreToolUse gate-evaluation phase of a tool
  call (registered at upstream-issue time, post-gate).
- **OPEN - A wrapped server's `instructions` are not covered by tool approval.** Tool descriptor
  approval pins each tool's model-facing fields (`name`, `title`, `description`, `inputSchema`,
  `outputSchema`, `annotations`). In wrap mode the wrapped server's `instructions` also reach the
  model, unpinned, and a tool's `_meta`, `execution` and `icons` are forwarded without being
  hashed. Pinning `instructions` is planned.
- **OPEN - A command on a drive mounted after startup stops being retried.** A missing command is a
  permanent failure: about five minutes of retries, then the upstream stops (named on stderr and
  in `/health.stopped`) until `expose.json` is saved, the gateway restarts, or the upstream is
  reconnected. A drive or share that appears later than that is not noticed on its own.
- **OPEN (minor) - A very large approvals file slows refused calls.** Each refused call re-reads
  `mcp/tool-approvals.json`; at 22 MB that costs about half a second per refused call. A home
  with two real upstreams holds about 250 KB.

## Fixed in 0.8.2

- ***FIXED*** - **Large tool arguments failed with `spawn E2BIG`.** Arguments came only in an
  environment variable, which has a size limit. A script tool that reads them from stdin (its file
  names `TOOLFUNNEL_TOOL_ARGS_STDIN`) now gets them there too, and on stdin only when too big for the
  environment; any other tool, and every shell tool, gets an empty stdin as before and still fails
  the call, naming the fix. Pinned by `test/tool-args-stdin.test.js`.
- ***FIXED*** - **A bundled tool's answer over 64 KB was cut short on Linux and macOS.** Each tool
  exited straight after writing, before the pipe had taken it all. They now exit once it is sent.
- ***FIXED*** - **A tool that answered `{"ok": false}` with exit 0 was reported as a success**, and
  so were a non-zero exit, a timeout, an over-cap output and an upstream tool's own error through
  `toolfunnel_run_tool`. All are error results now.
- ***FIXED*** - **`toolfunnel_run_tool` with `arguments` instead of `args` ran the tool with no
  arguments.** It now refuses and names the right key.
- ***FIXED*** - **A wrap ignored the server's `expose` entries without saying so.** `wrap` and
  `tf_wrap` now say when there are any.
- ***FIXED*** - **`strictApproval` at the top of `mcp/expose.json` did nothing and warned nobody.** It
  now holds every upstream; a misplaced or misspelt top-level key gets a warning.

## Fixed in 0.8.1

- ***FIXED*** - **A stdio gateway outlived a client that had gone, and could spin at a full core.** When
  the client closed stdin, the gateway answered and then stayed running, holding its upstreams open.
  When the client crashed, a broken stderr turned every log line into an error that logged again,
  round and round. The gateway now answers what was asked, closes its upstreams and exits when stdin
  closes or stdout breaks, and ignores a broken stderr. Pinned by `test/stdio-orphan.test.js`.

## Fixed in 0.8.0

- ***FIXED*** - **A hook's decision was ignored when the hook printed anything before its JSON.**
  The exit code decided instead, so a gate that logged a line and then denied, exiting 0, let the
  call through. The decision is now read wherever it sits, and two different decisions (a hook
  that echoes model-supplied text after its own answer) fail closed. Pinned by
  `test/gate-semantics.test.js`.
- ***FIXED*** - **The hook engine substituted stand-ins when one of its parts failed to load.** It
  now refuses to load and names the missing part. Pinned by `test/hook-engine-requires.test.js`.
- ***FIXED*** - **Child hooks saw the wrong `HOOKS_DIR` and `CLAUDE_PROJECT_DIR`.** Both now point
  at the config home. Pinned by `test/hook-env.test.js`.
- ***FIXED*** - **A relative upstream `cwd` was checked against one directory and spawned in
  another.** The isolation guard and the spawn now both resolve it against the config home.
  Pinned by `test/upstream-cwd.test.js`.
- ***FIXED*** - **Stopping a stdio gateway could leave its upstreams running (POSIX).** SIGINT or
  SIGTERM now closes every upstream, then exits 130 or 143. Pinned by
  `test/stdio-shutdown.test.js`.
- ***FIXED*** - **A permanent startup failure retried forever, and on Windows a missing command
  looked like a crashing server.** A missing command, a missing working directory or an isolation
  refusal now stops after about five minutes with one line naming the cause, and shows in
  `/health.stopped`. Pinned by `test/permanent-failure-ceiling.test.js`.
- ***FIXED*** - **A wrong-typed config field was coerced or dropped silently.** The config now
  refuses to load, naming the file, the entry and the field. Pinned by
  `test/fail-loud-config.test.js`.
- ***FIXED*** - **The legacy dispatcher answered notifications.** A notification now never gets a
  reply. Pinned by `test/legacy-notifications.test.js`.

## By design (not bugs)

These answer "why doesn't it do X". They are considered decisions, not defects.

- **The config home defaults to the package root.** A git clone keeps working unchanged, and
  seeding protects it from `npm update`, with an every-start relocation hint. Defaulting it to a
  per-user directory instead needs a migration story for existing installs, so it ships as its own
  release rather than as a rider. (`preuninstall` as a rescue mechanism is tested DEAD on npm
  11.9.0 - it will not be built.)
- **Funnel-mode curated descriptions carry an `[upstream]` title prefix** that lean passthrough
  does not. A toggle to reconcile the two is cosmetic.
- **The `command` slot is not path-guarded, and `PATH` is deliberately permitted.** The command
  names the interpreter (`node`, a system binary), which by definition lives outside the config
  home, and guarding `PATH` would break how commands resolve at all - so an upstream entry
  combining `command: "node"` with a caller-supplied `env.PATH` runs whatever that PATH resolves.
  This is a documented boundary, not an oversight: an upstream entry already specifies an
  arbitrary command to execute, so the isolation guard is a **tripwire** for configs that quietly
  reach outside an auditable config home - not a sandbox against an untrusted pack author.
  Installing a pack is installing software (see [SECURITY.md](../SECURITY.md)).
- **A meta-less `server/discover` is answered rather than refused** - permissive by design.
- **Discover works on a DISABLED upstream**, so its tools can be inspected before enabling. An
  explicit allowance on the discover path only; the disabled upstream never reaches the tool
  surface.
- **Upstreams connect all at once, with no concurrency cap.** Right for the handful to tens of
  upstreams a gateway holds.
- **The legacy SSE transport's dead-client prune branch never runs.** The stream's close and error
  handlers already clean up; the only effect is a counter that reads high. Cosmetic.
- **Tool approval trusts a version bump.** A change at the same server version waits for
  acceptance; a changed version is approved and reported, because that is what an update looks
  like. A maintainer can bump the version too: `strictApproval: true` on an upstream holds every
  change for acceptance.

Found a bug, or want to help with the open work? Issues and PRs are welcome.
