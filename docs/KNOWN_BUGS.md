# Known issues & roadmap

ToolFunnel has no known correctness bugs at this release. This file tracks the upcoming
compatibility work and any limitations worth knowing about.

## Coming in 0.6.0 — the 2026-07-28 MCP specification

The 2026-07-28 MCP revision is a **breaking** change to the protocol: it removes the `initialize`
handshake, protocol-level sessions, and the standalone GET/SSE endpoint, and adds new required
behaviours — per-request protocol metadata, `Mcp-Method` / `Mcp-Name` request headers, a
`server/discover` endpoint, a `subscriptions/listen` change-notification stream, and
`resultType` / `ttlMs` / `cacheScope` result fields.

ToolFunnel 0.5.0 speaks the current `2024-11-05` protocol and works with every MCP client shipping
today. **0.6.0** will add **dual-era** support — answering both the current handshake-based clients
*and* the 2026-07-28 modern clients — built against the finalised spec after 28 July.

Planned for 0.6.0:

- **Dual-era transport** (current + 2026-07-28) so old and new clients both keep working.
- `server/discover`, the new request-header validation, and the `subscriptions/listen` stream.
- An **opt-in, per-upstream legacy-protocol shim**: keep an ageing MCP server working past the
  cutover by pinning the protocol version ToolFunnel speaks *to that upstream* — off by default,
  it names the exact version it drops to and warns at startup and on every call.

## Current limitations

- The OAuth 2.1 resource-server and Streamable-HTTP support are recent and less battle-tested than
  the core — test your setup before relying on them in a networked deployment.
- No Prometheus / OpenTelemetry metrics — a toggleable JSONL audit log and in-memory `/health`
  call counters only.

Found a bug, or want to help with the 0.6.0 work? Issues and PRs are welcome.
