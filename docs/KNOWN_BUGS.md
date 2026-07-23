# Known issues & roadmap

This file tracks the state of the 0.6.0 dual-era work, the deliberately-deferred items, and any
limitations worth knowing about.

## 0.6.0 - the 2026-07-28 MCP specification

The 2026-07-28 MCP revision is a **breaking** change to the protocol: it removes the `initialize`
handshake, protocol-level sessions, and the standalone GET/SSE endpoint, and adds new required
behaviours - per-request protocol metadata, `Mcp-Method` / `Mcp-Name` request headers, a
`server/discover` endpoint, a `subscriptions/listen` change-notification stream, and
`resultType` / `ttlMs` / `cacheScope` result fields.

Implemented in 0.6.0 (built against the RC spec; a reconciliation pass against the finalised
spec lands after 28 July):

- **Dual-era transport** (2024-11-05 + 2026-07-28) - old and new clients both work.
- `server/discover`, request-header validation, and the `subscriptions/listen` stream.
- A **dual-era client**: ToolFunnel speaks modern to modern upstream servers (stdio).
- An **opt-in, per-upstream legacy-protocol shim** (`legacyPin`) - off by default, names the exact
  version it drops to, warns at startup and on every call, and is enforced (skips the era probe).
- **Passthrough wrap** (`toolfunnel wrap <upstreamId>`): one command turns the gateway into a
  transparent, both-era wrapper for one upstream MCP - verbatim identity, tool definitions,
  results, errors, notifications, and per-URI resource subscriptions (forwarded, and replayed
  across silent upstream reconnects), with every call still passing the PreToolUse gate.
- **Elicitation bridging**: a wrapped legacy server's mid-call questions are translated into the
  modern `input_required` + retry pattern and back - multi-round, single-use tokens, TTL'd -
  tested end-to-end against real published elicitation servers.
- **Cancel translation** (stdio): a client's cancel reaches the upstream in the upstream's own
  request-id space, for forwarded methods and wrapped tool calls alike.
- **Identity settings + wrap mirroring**: `toolfunnel.json` gains `clientName`/`clientVersion`
  (the identity upstreams see); under a wrap on stdio the real downstream client's identity is
  mirrored upstream automatically.
- **UI**: a Settings tab (identity + ports), a per-upstream legacy-pin toggle, and the wrap
  security notice surfaced on the UI wrap path (parity with the CLI).
- **Agent-facing docs**: `toolfunnel_howto` gains `wrap` and `configure` topics, so a plain agent
  can learn the wrap and the whole no-code config map from inside the protocol.
- **Method-class timeouts**: tool calls (`tools/call`, `prompts/get`, `resources/read`) wait
  120 s by default - configurable per upstream via `"timeoutMs"` - and a progress report from
  the tool re-arms the window, so a slow-but-alive tool never dies to the clock. The 10 s
  handshake/list window stays fixed as the dead-upstream detector.
- **Async shell execution**: `shell`-invoke register tools no longer block the event loop
  (was `spawnSync` since 0.5.0) - concurrent HTTP clients keep being served during a long
  shell tool.
- **Config-home visibility**: every start prints the resolved config home to stderr, with a
  relocation hint when it defaulted to the package root - running from a git clone no longer
  writes config into the repo silently.
- **Bounded listen streams**: the HTTP transport caps concurrent `subscriptions/listen`
  streams (64) and refuses new ones past the cap with a clear error; existing streams are
  never evicted.

## Deliberately deferred (documented dispositions, target: the 28-July reconciliation pass)

- **Legacy version family**: ToolFunnel currently speaks the oldest legacy dialect (`2024-11-05`)
  to legacy upstreams and clamps a wrapped handshake to what the upstream negotiated. A client and
  upstream that both speak a newer legacy revision (e.g. `2025-06-18`) are negotiated down.
  Fidelity of the *fields* is unaffected (verified against real servers - nothing version-gated is
  dropped), but the advertised version string is older than either end requires. DECIDED
  (2026-07-17): best-version negotiation in BOTH directions - newest each peer speaks, modern
  first, legacy fallback. Lands with the reconciliation pass, sequenced after the elicitation
  bridge (a newer legacy offer invites server-initiated requests the client must handle first).
- **Modern-upstream subscriptions**: the client does not yet open a `subscriptions/listen` stream
  to modern upstreams, so their change-notifications are not received; the listen ack honestly
  refuses `resourceSubscriptions` when no legacy subscribe-capable upstream is in scope.
- **Elicitation bridge scope**: a wrapped upstream's mid-call `elicitation/create` bridges to
  modern clients as MRTR (`input_required` + retry - built and wire-tested). A LEGACY client
  gets an automatic decline instead (relaying backwards requests to legacy clients is future
  work), and `sampling/createMessage` / `roots/list` from upstreams are answered -32601 for now.
  An elicitation can only be bound to a call when exactly ONE wrapped call is in flight for that
  upstream (always true on stdio); ambiguous concurrent HTTP calls decline rather than guess.
- Header validation reports `-32020` where `-32022` would be more specific in one path.
- Two-store wrap state read (expose.json + tools.state.json) has a benign TOCTOU window.
- A meta-less `server/discover` is answered rather than refused (permissive-by-design).
- The wrap's identity-mirror reconnect re-runs the full era negotiation - worst case ~3 s extra
  on the first handshake against an upstream that ignores `server/discover`. Reusing the
  already-known era on reconnect is a deferred optimisation.
- HTTP cancel translation: the sessionless modern era gives a POST no connection identity, so a
  client `notifications/cancelled` over HTTP is dropped rather than risk cancelling another
  client's call. stdio (one client per pipe) translates and forwards cancels for both forwarded
  methods and wrapped tools/call; the remaining best-effort windows are sub-millisecond (a cancel
  racing the instant a forward is issued) plus the PreToolUse gate-evaluation phase of a tool
  call (registered at upstream-issue time, post-gate).
- `io.modelcontextprotocol/logLevel` (the modern per-request log level) is stripped with the rest
  of the protocol `_meta` keys on wrapped forwards and not re-injected for modern upstreams -
  part of the modern-upstream work above.
- Discover on a DISABLED upstream works (inspect its tools before enabling - an explicit
  allowance on the discover path only; the disabled upstream never reaches the tool surface).

## Current limitations

- The OAuth 2.1 resource-server and Streamable-HTTP support are recent and less battle-tested than
  the core - test your setup before relying on them in a networked deployment.
- No Prometheus / OpenTelemetry metrics - a toggleable JSONL audit log and in-memory `/health`
  call counters only.
- One gateway instance per process: the bridge/cancel state is process-global, so embedding two
  gateway instances in one Node process is not a supported configuration (running two processes
  is fine, and is the normal deployment).

Found a bug, or want to help with the 0.6.0 work? Issues and PRs are welcome.
