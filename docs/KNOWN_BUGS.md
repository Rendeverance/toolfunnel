# Known bugs

The **Open** list is what remains open as of 0.7.0. **Fixed in 0.7.0** marks the items from
0.6.0's file that this release closed - kept and marked rather than silently deleted, so a
0.6.0 reader can see their fate. The full change list is in the
[release notes](https://github.com/Rendeverance/toolfunnel/releases).

## Open

- **OPEN - Modern-upstream subscriptions are not received.** The client does not yet open a
  `subscriptions/listen` stream to modern upstreams, so their change-notifications never arrive;
  the listen ack honestly refuses `resourceSubscriptions` when no legacy subscribe-capable
  upstream is in scope.
- **OPEN - The elicitation bridge does not cover legacy clients.** A wrapped upstream's mid-call
  `elicitation/create` bridges to MODERN clients as MRTR (`input_required` + retry), form and url
  mode, gated on the caller's declared capability (0.7.0). A LEGACY client gets an automatic
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

## Fixed in 0.7.0

- ***FIXED*** - **Legacy version negotiation.** 0.6.0 answered every `initialize` with
  2024-11-05 whatever the client asked for, and supported exactly one legacy revision. The
  gateway now echoes the requested version when it supports it (else answers its latest legacy),
  and the legacy set spans 2024-11-05 / 2025-03-26 / 2025-06-18 / 2025-11-25. Pinned by
  `test/negotiation.test.js`. One direction remains conservative: the client still offers
  2024-11-05 to legacy upstreams (field fidelity is unaffected; only the advertised version
  string is older than either end requires).
- ***FIXED*** - **Header validation used a generic error code for an unsupported version.** An
  unsupported `MCP-Protocol-Version` header answered the generic `-32600`; it now answers
  `-32022` with `data.supported` and `data.requested` - the same code and shape the `_meta`
  path already used for the same condition, so a client can renegotiate without parsing prose.
  Pinned by `test/header-enforcement.test.js`.
- ***FIXED*** - **The wrap's identity-mirror reconnect re-ran the full era negotiation** (worst
  case roughly 3 s per respawn against an upstream that ignores `server/discover`). The
  negotiated era is now remembered per upstream, and a death-driven reconnect goes straight to
  the era it knows. A failed hinted connect or an explicit reconnect re-negotiates in full, so
  an upstream upgraded across a restart is never pinned down an era. Pinned by
  `test/reconnect-era-memo.test.js`.
- ***FIXED*** - **`io.modelcontextprotocol/logLevel` was stripped on wrapped forwards.** Now
  era-keyed at the client boundary: a modern upstream gets the caller's level verbatim in
  `_meta`; a legacy upstream that declared the `logging` capability gets `logging/setLevel`
  issued before the call (and the key never leaks into legacy `_meta`). Pinned by
  `test/loglevel.test.js`.

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

Found a bug, or want to help with the open work? Issues and PRs are welcome.
