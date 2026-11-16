# Changelog

Every release's notes, word for word as published on [GitHub](https://github.com/Rendeverance/toolfunnel/releases).

## v0.8.2 - 2026-11-16

Fixes found testing 0.8.1.

- **Tool arguments of any size.** A tool's arguments came only in the environment variable `TOOLFUNNEL_TOOL_ARGS`, and an environment has a size limit, so a large argument (1.5 MB on macOS, over 128 KB on Linux) failed with `spawn E2BIG`. A script tool that reads its arguments from stdin (its file names `TOOLFUNNEL_TOOL_ARGS_STDIN`) now gets them there as well, and when they are too big for the environment it gets them on stdin only, with that variable set to 1. Every other tool, and every shell tool, keeps an empty stdin as before, and arguments too big for it fail the call with an error that names the fix. Every bundled tool reads both; `toolfunnel_howto create-tool` shows the three lines that do it.
- **Long answers from the bundled tools were cut at 64 KB on Linux and macOS.** Each tool wrote its answer and exited at once, before a pipe had taken it all. They now exit once the answer is sent.
- **A tool that says it failed is reported as failed.** A tool that exited 0 but answered `{"ok": false, "error": ...}` came back as a success, and so did a non-zero exit, a timeout, an over-cap output, or an upstream tool's own error through `toolfunnel_run_tool`. All are now error results, with the tool's own error text, and the activity log records them as failed.
- **`arguments` instead of `args`.** `toolfunnel_run_tool` takes the tool's arguments in `args`. Sent as `arguments` (the key a normal tool call uses), the tool used to run with no arguments at all. It now refuses and says which key to use; nothing runs.
- **A wrap says what it leaves out.** A wrapped server shows every tool under its own name, so its `expose` entries in `mcp/expose.json` (which tools, their names, on or off) do not apply. `toolfunnel wrap` and `tf_wrap` now say so when the server has any.
- **`strictApproval` at the top of `mcp/expose.json`** did nothing and said nothing. It now holds every upstream's changes for acceptance; an upstream entry can add it on its own but not opt out. A key at the top that belongs on an upstream entry, or one that is misspelt, gets a warning at start and reload, and unknown keys at the top are now kept when the gateway saves the file.
- **CHANGELOG.md**, in the repo and the npm package: every release's notes, as published here.

## v0.8.1 - 2026-11-15

ToolFunnel 0.8.1

A fix release: a stdio gateway now exits when its client has gone. The test suite grew from 111 to 112 tests.

**Fixed**

- **A stdio gateway outlived a client that had gone, and could spin at a full core.** The logging loop has been there since 0.3.0.
  - When the client closed stdin, the gateway answered and then stayed running, holding its upstream servers open.
  - When the client crashed, stderr was left broken. A failed write to it became an uncaught error, whose own log line failed the same way, over and over at a full core until the process was killed.
  - Now the gateway answers what it was already asked, closes every upstream and exits when stdin closes or stdout breaks. Errors on a broken stderr are ignored.
  - Pinned by `test/stdio-orphan.test.js`. The released 0.8.0 fails two of its five checks.

Nothing else changes. Configuration, the protocol surface and the HTTP host are as in 0.8.0.

**Upgrading**

`npm update toolfunnel`, or `git pull` on a clone. Nothing to migrate.

## v0.8.0 - 2026-11-15

ToolFunnel 0.8.0

Tool changes now wait for your approval, config mistakes fail loudly, and upstream progress reaches the right caller. This release also carries a second hardening pass. The test suite grew from 74 to 111 tests.

**Headline changes**

- **Tool changes wait for your approval.** A tool's description goes straight into your model's context, so a server that changes what its tools say after you attached it can steer your model. ToolFunnel now records every upstream tool's description and schema on first connect.
  - A change at the same server version is held. The approved text keeps being served, a new tool stays hidden, and calls to the changed tool are refused until you accept it.
  - A new server version is approved and reported, because that is what an update looks like. Set `"strictApproval": true` on an upstream to hold those too.
  - The refusal names the tool and which fields changed, never the new text.
  - Accept with `toolfunnel changes` and `toolfunnel accept`, the banner in the web UI's MCPs tab, the `tf_accept_change` tool, or, with a 2026-07-28 client that supports elicitation, by answering the question the gateway asks you in chat.
  - An accept is pinned to the exact version you were shown (on the CLI, pass `--hash`). A server that changes the tool again after you looked is not approved unseen, and an agent can only accept one named change at a time, never everything waiting.
- **Config mistakes fail loudly.** A known field with the wrong type (`"enabled": "false"`, `"timeoutMs": "5000"`, `"args": "a b"`) now refuses to load and names the file, the entry and the field. It is no longer quietly converted or dropped. The same check applies to every change made from the web UI and the management tools. A field the gateway does not know, such as a misspelt `"strictAproval"`, is named on stderr at start and on every reload, with the nearest known field, and kept as it is.
- **Progress reaches the right caller, on every route.** Upstream progress now reaches the caller through the lean register and curated tools as well as through wrap, over stdio and HTTP. Each call's progress token is scoped, so two callers using the same token never see each other's progress. Over HTTP, a request that accepts `text/event-stream` receives its own progress on its response, then the result.
- **A server that can never start stops retrying.** A missing command, a missing working directory or an isolation refusal is retried for about five minutes, then stopped with one line naming the cause, and listed in `/health.stopped`. On Windows a missing command is now detected and named.

**Suggestions from the community** (from the r/mcp thread "Cutting an MCP server from 85 tools to 9", thank you)

- **One broken tool no longer takes its server down** (u/Plastic-Risk-6309). Each upstream tool's schema is checked before it is advertised. A broken tool is dropped on its own, named once, and listed in `/health.invalidTools`.
- **Errors say what to do next** (u/Plastic-Risk-6309). The unknown tool, unresolvable run and reconnecting errors now give the next step, and only name tools the client can see.
- **Every mode can be found from the brief** (u/kydude). The listing's filter searches the name and summary, so every shipped tool's summary now names all its modes, and the create-tool guide tells you to do the same.

**Hardening**

- **Hooks:** a hook that printed anything before its JSON decision had that decision ignored, so a logged deny with exit code 0 let the call through. The decision is now read wherever it appears in the output. Two different decisions from one hook fail closed. The hook engine refuses to load if one of its parts is missing. Hooks see the config home in `HOOKS_DIR` and `CLAUDE_PROJECT_DIR`.
- **Tool output:** a script, shell tool or hook's captured output now stops exactly at its size limit, cut on a whole character, and says when its stderr was cut.
- **Stdio shutdown:** Ctrl-C and SIGTERM close every upstream before the gateway exits (codes 130 and 143). On POSIX, an upstream that ignored the end of stdin could outlive the gateway.
- **Starting upstreams:** a relative upstream `cwd` is checked and started in the same folder, the config home. A relative command path such as `../../tools/node.exe` now starts on Windows.
- **Protocol:** a legacy notification never gets a reply. Method names cannot reach built-in object properties. Metrics cap the number of distinct tool names. HTTP caps concurrent SSE streams. IPv6 hosts are bracketed in advertised URLs.
- **Saved state:** every store is written by one atomic writer. A failed save undoes a rename. Changing the wrap target unsubscribes from the previous server. A restarted upstream starts from a clean read buffer. A refused add in the web UI is undone completely. A new config home no longer inherits the package's hook settings or live stores. A config home made read-only still starts: what it cannot write is not seeded.
- **CLI:** a flag that takes a value never takes the next flag as its value, and a value flag with nothing after it is an error.
- **Tests:** every test runs against its own temporary config home, never the repository's.

**Upgrading**

- **Breaking (config):** a config with a wrong-typed known field, or with `legacyPin` and `modernOnly` together on one upstream, loaded in 0.7.x and now refuses to load. The error names the field. A disabled entry with no command still loads.
- **First start records your current tools as approved** in `mcp/tool-approvals.json` in the config home. Nothing is held until a server changes something.
- **New shipped tools now reach an existing config home.** From 0.8.0, each start adds any shipped tool this config home has never been offered (in this release, `tf_accept_change`) and says so on stderr. A shipped tool you deleted is never added back, and nothing you already have is changed.

Node 18 or later, zero runtime dependencies.

## v0.7.1 - 2026-09-21

Concurrent upstream connect. connectAll() now starts every enabled upstream together, so startup time is the slowest upstream rather than the sum of all of them. An upstream that fails at startup is now retried in the background on the same backoff a mid-session death gets, instead of being stranded for the session.

Contributed by @sacmii in #2.

## v0.7.0 - 2026-08-03

****** **MAJOR UPDATE** ******

Finalised MCP spec and hardening pass.

0.6.0 was built against the release-candidate cut of the 2026-07-28 MCP revision. The spec has since been finalised, so this is the promised reconciliation pass - all divergences between RC and final closed - plus I performed a defect-hunt hardening pass across the whole gateway and increased the CI test suite from 36 to 73 tests!

### Spec reconciliation

- **Best-version negotiation, both directions.** The gateway now speaks the newest revision each peer supports (four legacy revisions plus modern), replacing the oldest-dialect clamp. The `-32022` version-retry loop a client could get trapped in is gone.
- **JSON-RPC batching** for 2025-03-26 clients: 202 for notification-only batches, one JSON array for request batches, 400 for an empty batch. Era-gated by header, capped at 64 members.
- **Header enforcement.** An unknown `MCP-Protocol-Version` value is refused with a 400 (a 2025-06-18 spec MUST), and `Mcp-Param-*` mirroring is validated against the body.
- **Era-aware upstream error relay.** A legacy caller gets the upstream's JSON-RPC error verbatim - code, message and data. A modern caller gets spec-band codes with the original preserved under `data.upstreamCode` / `data.upstreamData`.
- **Metadata fidelity.** `title`, `annotations`, `outputSchema`, `_meta` and `execution` forward through every definition path, and result-side `_meta` relays (identity keys stripped in funnel mode, not in wrap mode, wrap mode is true to the wrapped server).
- **Elicitation, both modes.** URL-mode elicitations relay end-to-end in both eras, suspension requires the caller's declared elicitation capability, and the `-32042` path relays with its payload intact.
- **Subscription lifecycle.** Listen-agreed resource subscriptions are refcounted and released on re-listen, stream close, teardown and cancel. Previously they could leak forever.
- **Rename migration.** Renaming or aliasing a surfaced tool migrates exact-literal hook matchers and per-tool state atomically, and a rename that would silently detach a non-literal matcher is refused with the hook named. Gates can no longer be shed by renaming.
- Modern per-request `logLevel` restores era-correctly, a modern HTTP client closing mid-call now cancels the upstream work, a non-loopback `Origin` is refused 403, `--version` exists, and the config-home relocation hint actually prints.

### Hardening

- **The UI's per-tool gate switch now tells the truth.** It can no longer delete a broader hook, adopt a hand-authored entry and report a script nothing runs, or let two tools sharing a register name silently own each other's gate (that is now a 409).
- **The spawn isolation guard reads the environment exactly as the spawn does.** Values are judged as the coerced string the child receives, a `__proto__` key is refused outright as a carrier, and the store normalises configured environments to plain string-to-string maps. The guard covers args, cwd and env, with case-insensitive keys on every platform; option-string variables (`NODE_OPTIONS` and friends) are not path-checkable, so in funnel mode they are refused, with an explicit manually configurable per-upstream opt-out.
- **Every spawn path is guarded** - including the wrap-time era probe, which previously built its client directly and ran no checks at all.
- **A disabled upstream is now off everywhere.** It vanishes from the lean list, both run paths and the curated surface, and its tools can no longer be resolved or executed. Previously they still could.
- **A curated alias can no longer shadow a local tool.** When a curated alias collides with a local tool's name, it is no longer advertised with the upstream's schema while the call runs the local tool instead.
- **Optional auth fails closed on a blank issuer.** A blank configured issuer no longer silently disables issuer binding; it is refused at request time, matching the existing audience guard.
- **Reconnect backoff always escalates.** An upstream that dies during a reconnect attempt's own tool-listing no longer re-arms the one-second timer and pins the gateway to a permanent one-second respawn loop. The backoff climbs 1s, 2s, 4s and on to the 30s keepalive as intended.
- **Local tools have a clock and a ceiling.** Script and shell tools time out at 120 s, kill their whole process tree, and bound their output in real bytes. A hanging local tool no longer starves every later request.
- **Hooks fail closed.** Hook output is capped, and a hook that floods past the cap reads as a refusal, not an allow.
- **The panel stays responsive.** The optional `jose` install runs off the config-write chain on its own single-flight latch, config-mutating posts are serialised so concurrent writes cannot discard each other, and `--config-dir=/path` is accepted.
- **A refused panel add or update unwinds cleanly.** A rejected upstream add or tool update leaves no orphaned script and no half-written row, so the natural retry works.
- **The activity log is bounded.** It rotates at 5 MB with one older generation kept, and reading the tail reads a bounded slice rather than the whole file.
- **Config writes never strand a temp file.** The atomic writers remove their own temp on a failed write and sweep stale temps left by a killed process.
- Housekeeping: ~1,030 lines of unreferenced code removed. `SECURITY.md` sets out the trust model.

### Verification

73 test files, all green. Verified beyond the unit suite against real SDK-based servers - wrap, funnel, gate and HTTP - with identity, tool relay, structured errors, notifications, pagination and renames byte-checked against a direct connection.

Node >= 18, zero runtime dependencies, as always.

## v0.6.0 - 2026-07-23

******** MAJOR UPDATE ********

*ToolFunnel v0.6.0: both protocol eras, and the transparent wrap*

The 2026-07-28 MCP revision is a *breaking* change. It removes the initialize handshake and sessions that every existing MCP client and server is built on. This release makes ToolFunnel speak BOTH protocols, in BOTH directions. And on top of that sits the new headline feature...

*One command turns ToolFunnel into a transparent wrapper for a single MCP server*:

    toolfunnel wrap my-server

- All four combinations work: legacy client to modern server, modern client to legacy server, or matched pairs. No configuration.
- Invisible from both sides. The client sees the wrapped server's own identity, tools, results, errors and notifications, byte for byte. Verified against real published servers. The server sees your real client, not ToolFunnel.
- Mid-call user prompts (elicitation) from a legacy server are translated into the modern retry pattern and back, tested end to end against real elicitation servers. Resource subscriptions survive a crash and reconnect. Progress tokens flow through. Cancels are translated into the server's own request ids, so abandoned calls actually stop.
- The policy gate and per-tool switches still apply to every wrapped call.

Use it to keep an unmaintained server alive past the cutover, to hand a modern-only server to older tooling, or to put a policy gate in front of a server you didn't write.

*Dual-era everywhere*

- ToolFunnel answers legacy and modern clients on the same endpoint at the same time. Each request is served in the era it arrives in. server/discover, subscriptions/listen, per-request metadata, header validation and the new result fields are all in.
- As a client, ToolFunnel probes each attached server and speaks whichever era it understands.
- legacyPin pins any upstream to the old protocol, per server, with loud warnings. Off by default.
- Two optional hardening switches: "serveLegacy": false in toolfunnel.json makes the gateway refuse legacy-era clients once yours have moved to the new protocol (smaller attack surface; loud warning, off by default), and "modernOnly": true on an upstream refuses to speak legacy to that server instead of negotiating down. Defaults unchanged: both eras served, both directions.

Also in this release

- Identity settings: toolfunnel.json now sets the client identity ToolFunnel presents to upstream servers (clientName/clientVersion) alongside the existing server identity. A new Settings tab in the web UI edits it all. Under a wrap on stdio, your real client's identity is mirrored upstream automatically.
- toolfunnel_howto gains wrap and configure topics, so a plain agent with no special prompt can learn wrapping and the complete no-code configuration map from inside the protocol. legacyPin gets a UI toggle. The wrap security notice now shows in the UI as well as the CLI.
- Wrapped servers may use outside paths. Wrapping suspends the path-isolation guard for the wrapped server only, with a clear warning and a manual section on locking it back down. Funnel mode keeps the guard.
- Tool calls now wait up to 120 s, configurable per upstream with "timeoutMs", and a tool that reports progress keeps its call alive indefinitely. Slow tools (builds, searches, image generation) work through the gateway exactly as they do directly. The 10 s window now applies only to handshakes and listings, where a slow answer means a dead server - and that window is also configurable per upstream with "requestTimeoutMs", for servers that boot slowly. A session restore that needs 30 s to answer can now be attached at all.
- Shell tools no longer block. A long-running shell tool used to stall the whole process; it now runs asynchronously and concurrent clients keep being served.
- Every start prints the resolved config home, with a relocation hint when it defaulted to the package root. Running from a git clone can no longer write config into the repo without saying so.
- CLI flags work in any position: toolfunnel --config-dir X wrap Y and toolfunnel wrap Y --config-dir X are equivalent. A mistyped command now refuses loudly instead of silently starting a server.
- "Discover tools" works on a disabled upstream, so you can inspect before enabling.
- Server-initiated pings are answered. Upstream keepalives no longer die at the gateway.
- Hardening under the hood: cancel translation for in-flight calls (a cancelled call now correctly receives no response), subscription replay across reloads, identity continuity across reconnect windows, health-endpoint privacy while wrapped, a cap on concurrent listen streams. The test suite grew from 27 to 35 files, including wire-level tests over real spawned processes, a multi-client concurrency test, and interop tests against the official MCP SDK client.

Notes

- Built against the 28-July release candidate; final-specification reconciliation follows as a point release.
- The elicitation bridge currently serves modern clients. A legacy client behind a wrap has mid-call prompts declined automatically, never hung. Server-to-client sampling and roots requests are answered method-not-found for now.
- Upgrading from 0.5.0: no config changes required. Everything you have keeps working.

## v0.5.0 - 2026-07-16

### What is new in 0.5.0

#### Added
- Full illustrated user manual (`docs/MANUAL.pdf`) - install, the web UI, writing tools, attaching MCP servers, the policy gate, packaging, OAuth, troubleshooting.
- Build your own MCP server, no code and no SDK: assemble scripts and curated upstream tools into a gated MCP and ship it with `tf_pack`.

#### Fixed
- Config hot-reload now works over the HTTP host (`--http`): a live hook, tool, or upstream change takes effect with no restart, using the same in-place reloaders as stdio (no upstream bounce).
- Windows: an `fs.watchFile` polling fallback catches config writes that `fs.watch` misses.
- Corrected the reference-mode gating docs (the instruction handoff is gated; only server-side execution is absent).

#### Changed
- README slimmed: the how-tos moved into the manual.
- Roadmap: 2026-07-28 MCP spec conformance (dual-era) is the 0.6.0 milestone, see `docs/KNOWN_BUGS.md`.

Requires Node >= 18. Zero runtime dependencies.

## v0.4.0 - 2026-07-06

0.4.0 - the packaging release: external config home (TOOLFUNNEL_HOME/--config-dir - npm updates can never eat your tools), tf_pack (package your live setup as a portable home or a publishable npm package), configurable identity + ports (toolfunnel.json), requires runtime preflight, register hot-reload (the one unwatched config), first-class tool inputSchemas, UI loopback hard-pin + CSRF guard, OIDC discovery origin-pin, clean -32700 on all over-cap paths - and the 60-second zero-code demo (see the README). Suite 26/26.

**Commits:**
- Adversarial-review fixes + the demo GIF lands in the README
- Demo-as-code: the 60-second zero-code MCP story (task #39)
- KNOWN_BUGS board: mark items 6-9 DONE with their commits - the full 0.4.0 board is code-complete
- Packaging docs + README: the full ship-your-own-MCP story; fix a launch-week README artifact
- tf_pack + requires preflight: package the live setup, declare its runtimes
- External CONFIG HOME (TOOLFUNNEL_HOME / --config-dir): config survives the package
- Configurable identity + port defaults (toolfunnel.json) - the wrapped-MCP handshake
- Register hot-reload + first-class tool schemas: close the two 0.4.0 verify items
- 0.4.0 security batch: loopback-pin the config UI + fix the four 7/3 review findings
- One-command release automation: scripts/release.js

## v0.3.1 - 2026-07-05

Packaging-only release - no functional changes.

- Added a no-op `build` script to `package.json` so deployment pipelines that unconditionally run `pnpm run build` (e.g. MCP directory inspectors) no longer fail. ToolFunnel is zero-dependency and runs from source; there is nothing to build.
- `serverInfo.version` is now sourced from `package.json` (previously hardcoded, and had already drifted).
- Runtime behaviour is identical to v0.3.0. Full test suite: 22/22 passing.

## v0.3.0 - 2026-07-04

ToolFunnel 0.3.0, as published to npm (`npm install toolfunnel`) on 2026-06-30.

**Zero-dependency MCP gateway** - funnel multiple MCP servers through one endpoint.

- Live attach/detach of upstream MCP servers
- Tool filtering, gating and hide/expose per client (`tf_tool_set`, expose config)
- Hot config reload
- Upstream health tracking + auto-reconnect
- HTTP/SSE transport with optional OAuth 2.1 resource-server validation (`jose` installed on demand - the core stays zero-dependency)
- Observability metrics
- PreToolUse gate hooks (deny-hook, fail-closed)

Requires Node >= 18. MIT.
