# Security Policy

ToolFunnel sits between MCP clients and MCP servers - it gates, filters, and forwards
tool calls. That makes its security surface worth taking seriously, and reports are
genuinely welcome.

## Reporting a vulnerability

**Please use GitHub's private vulnerability reporting:** go to the
[Security tab](https://github.com/Rendeverance/toolfunnel/security) → **Report a
vulnerability**. That opens a private thread with the maintainer - nothing is public
until a fix is out.

Please **do not** open a public issue for a security-sensitive report. If you're unsure
whether something is security-relevant, please err on the side of the private route.

## What counts

Anything that lets a client or upstream server do what the configuration says it
shouldn't. For example:

- Bypassing the tool gate / hidden-tool filtering (`tf_tool_set`, expose config)
- Auth bypass in the HTTP transport or OAuth resource-server validation
- Token or credential leakage (in logs, error messages, or forwarded traffic)
- Escaping the PreToolUse deny-hook
- Injection via tool names, schemas, or forwarded arguments

Bugs that crash ToolFunnel but don't cross a trust boundary are ordinary bugs -
public issues are fine for those.

## What to expect

This is a single-maintainer project. Reports get a response on a best-effort basis -
normally within a few days. Confirmed vulnerabilities are fixed as a priority, and
you'll be credited in the release notes unless you'd rather not be.

## Supported versions

Only the latest published release (`npm install toolfunnel`) is supported with
security fixes.

## Trust model

**The config home is the trust boundary.** Anyone who can write the config home
(`tools/`, `mcp/`, `hooks/`, `auth/`, `toolfunnel.json`) can define register tools, hooks,
and upstream commands that execute with the gateway process's privileges. Protect it with
filesystem permissions like you would a crontab or a shell profile.

Everything else follows from that line:

- **Upstream MCP servers are operator-chosen code.** Attaching or wrapping a server means
  trusting it with whatever its command can reach. In funnel mode the gateway *refuses*
  upstream arguments, working directories, and code-loading environment variables that
  reference paths outside the config home. The per-upstream opt-outs are explicit, and each
  is wider than a single check: `allowOutsidePaths` lifts the outside-path refusal for
  everything path-shaped that upstream carries - its arguments (including the value after
  `=` in a `--flag=value` form), the working directory its bare arguments resolve against,
  and its path-list environment variables; `allowCodeLoadingEnv` permits the code-loading
  environment class (`NODE_OPTIONS`, `NODE_PATH`, and their equivalents for other runtimes)
  on its own. Wrap mode permits outside paths with a security notice, because serving your
  real files is usually the point of a wrapped server. The guard is a tripwire for configs that quietly reach
  outside an auditable config home - not a sandbox against an untrusted pack author:
  installing a pack is installing software.
- **The network surface binds loopback by default** (HTTP, SSE, and the web UI), validates
  the `Origin` header against loopback origins, and enforces the protocol-version
  and parameter-mirroring header rules of the 2026-07-28 revision. Exposing the port beyond
  localhost is an operator decision; put OAuth 2.1 (opt-in) or your own reverse proxy in
  front of it if you do.
- **Zero runtime dependencies** - the supply-chain audit surface is this repository's own
  code (OAuth, if enabled, adds exactly one audited library: `jose`).
- **An unreadable gate decision is a deny.** A hook that floods its output past the cap, whose
  decision JSON cannot be parsed, or whose decision slot carries a value outside the exact
  protocol vocabulary (a miscased `"DENY"`, a synonym like `"denied"`, the right word in the
  wrong slot, a wrong type) blocks the call it was gating rather than waving it through. A hook
  matcher that does not compile is the same class: it is refused at authoring, and one already
  in the manifest denies every tool-bearing call of its event until fixed. A `null` in a
  protocol slot is NOT an attempt - it reads as "no value", exactly like an absent key, and
  falls through. The deliberate exception: a hook script that CRASHES, is MISSING, or HANGS
  past its timeout is a non-blocking error and the call proceeds - Claude Code hook parity, so
  a script-execution failure cannot take every tool offline. An authored-config defect (the
  matcher, the decision vocabulary) gets no such grace: the author wrote a gate the runner
  cannot read, and it denies until corrected. Denies are `exit 2`; a gate that cannot reach a
  decision should exit 2 explicitly rather than error out. Pinned by
  `test/gate-semantics.test.js` and `test/matcher-compile.test.js`.
