# How to wrap an MCP server (transparent passthrough)

This is the instruction served by `toolfunnel_howto({ topic: "wrap" })`. It explains the
**passthrough wrap**: making ONE attached upstream MCP's tools the gateway's ENTIRE surface, under
their original names, with the upstream's own identity presented to the client - so the client
cannot tell ToolFunnel is in the middle. Use it to keep a legacy server working with modern
clients (or vice versa - all four era combinations work), or to put a policy gate in front of a
server you didn't write.

**What the client sees:** the wrapped server's own `serverInfo`, capabilities, instructions,
tools, results, errors and notifications - verbatim. **What the wrapped server sees** (stdio,
legacy clients): the real downstream client's identity, mirrored automatically. Mid-call prompts
(elicitation), resource subscriptions, progress tokens and cancellations are all bridged across
protocol eras. Wrapped tool calls wait up to 120 s by default, and a tool that reports progress
keeps its call alive indefinitely; for silent tools that run longer, set `"timeoutMs"` on the
upstream entry in `mcp/expose.json`.

**What changes for YOU (the agent):** while a wrap is active, ALL ToolFunnel tools - the four
meta-tools included - are hidden and uncallable. That includes `tf_wrap` itself. Read §3 before
setting a wrap in-band.

---

## 1. Setting a wrap - three equivalent paths

The wrap is one persisted field (`"passthrough"` in `tools/tools.state.json`); all three paths
write the same state and survive restarts.

**CLI (recommended for humans):**

```
toolfunnel wrap <upstreamId>          # wrap - probes the upstream's protocol era and reports it
toolfunnel wrap <upstreamId> --as <name>   # also present that name in the handshake (serverInfo)
toolfunnel wrap                       # status - current wrap + attached upstream ids
toolfunnel wrap --off                 # clear - restore the normal funnel surface
```

Global flags may sit anywhere: `toolfunnel --config-dir <dir> wrap <upstreamId>` and
`toolfunnel wrap <upstreamId> --config-dir <dir>` are equivalent.

The wrap persists as one field in `tools/tools.state.json` in the config home -
`{ "passthrough": "<upstreamId>" }` when set. Editing that file by hand is a valid last-resort
undo: clearing the `passthrough` key (e.g. writing `{}` if nothing else is in the file) is the
file-edit equivalent of `wrap --off`; a running host picks the change up live.

**UI:** the MCPs tab → the Wrap button on the upstream's row (Unwrap on the same button while
active). A banner shows the active wrap.

**In-band (`tf_wrap`, via `toolfunnel_run_tool`):**

```
{ }                                     → status: { ok, wrapping, upstreams }
{ "off": true }                         → clear
{ "upstream": "<id>", "confirm": true } → set (confirm REQUIRED - see §3)
```

The upstream must already be attached and enabled (`toolfunnel_howto({ topic: "add-mcp" })` covers
attaching one).

## 2. Verifying a wrap

- `toolfunnel wrap` (or `tf_wrap {}` before wrapping) shows the current state.
- After wrapping, a client's `initialize`/`server/discover` handshake presents the WRAPPED
  server's identity, and `tools/list` shows its tools under their original names.
- The CLI wrap command prints an era report: whether the upstream speaks the modern
  (2026-07-28) protocol, the legacy family, or both.

## 3. The lockout - why `confirm: true` is required in-band

Setting a wrap HIDES every ToolFunnel tool, including `tf_wrap`. An agent that sets a wrap
in-band therefore loses the in-band path to undo it. Recovery is always available OUT-of-band:

- `toolfunnel wrap --off` on the CLI, or
- the UI's Unwrap button.

`tf_wrap` refuses to set a wrap without `confirm: true` precisely so this is a deliberate,
informed action. Do not set a wrap unless the operator asked for it or you can reach one of the
two recovery paths.

## 4. Security - what wrapping changes

Wrapping SUSPENDS the path-isolation guard for the wrapped upstream only (a wrap is an explicit
"this server is my whole surface" declaration - e.g. a filesystem server serving a documents
folder MUST reach outside the gateway root). The CLI and UI both print a security notice naming
the outside paths when this applies. Two things stay true regardless:

- **Every call still passes the PreToolUse gate.** Wrapping never bypasses policy.
- **Funnel-mode upstreams keep the guard** - the suspension is wrap-scoped, nothing else.

To restrict a wrapped server after wrapping: add a PreToolUse hook that blocks by tool/args
(`toolfunnel_howto({ topic: "add-hook" })`), or disable individual tools (keyed by the surfaced
name). The manual's "Wrapping & security" section covers the patterns.

## 5. Related settings

- `legacyPin: true` on an upstream (in `mcp/expose.json`, or the UI's "Legacy pin" toggle) pins
  that upstream to the legacy protocol forever - the era probe is skipped. Opt-in, warns loudly.
- The gateway's own presented identities (funnel mode / HTTP) are configured in
  `toolfunnel.json` - see `toolfunnel_howto({ topic: "configure" })`.
