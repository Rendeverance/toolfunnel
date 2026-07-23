# Security Policy

ToolFunnel sits between MCP clients and MCP servers - it gates, filters, and forwards
tool calls. That makes its security surface worth taking seriously, and reports are
genuinely welcome.

## Reporting a vulnerability

**Please use GitHub's private vulnerability reporting:** go to the
[Security tab](https://github.com/Rendeverance/toolfunnel/security) → **Report a
vulnerability**. That opens a private thread with the maintainer - nothing is public
until a fix is out.

Please **do not** open a public issue for anything exploitable. If you're unsure
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
