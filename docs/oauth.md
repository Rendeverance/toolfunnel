# OAuth 2.1 — optional resource-server validation

ToolFunnel is **loopback-only and unauthenticated by default** — the right posture for a single
operator on `localhost`. For a networked or multi-user deployment it can act as an **OAuth 2.1
resource server**: it validates the bearer token on every HTTP request *before any tool runs*.

This is **opt-in** and the only feature that adds a dependency.

## The one dependency

The core gateway has `"dependencies": {}`. Enabling OAuth adds exactly one library —
[`jose`](https://www.npmjs.com/package/jose) — which is **itself zero-dependency**, audited, and the
same library the official MCP SDK uses. It is **not** a runtime dependency of the package: it lives
in `devDependencies` (for the test suite) and is **installed on demand**:

```bash
toolfunnel install-oauth        # runs: npm install jose@<pinned>
```

…or click **Install** in the UI's **Auth** tab. Everyone who does not enable OAuth pulls nothing.

> **Why a library, not hand-rolled `node:crypto`?** Verifying a JWT securely is not the signature
> math (`node:crypto` has that) — it is the protocol discipline around it: pinning the algorithm so
> an attacker can't downgrade RS256→HS256, rejecting `alg:none`, ignoring attacker-controlled header
> params, validating `iss`/`aud`/`exp`/`nbf`, and JWKS caching + rotation. Each is a known CVE class.
> For the most security-sensitive code in the project, delegating to an audited library is the
> deliberate, defensible call — and `jose` is itself zero-dependency, so the audit surface barely
> moves. `jose` v5 (the CommonJS build, Node ≥ 18) is the pinned major.

### Installing on demand — and the guaranteed manual fallback

`toolfunnel install-oauth` and the UI **Install** button both call the same installer
(`src/auth/install.js`). It is built to work where a naïve `npm install` breaks:

- **It runs npm's own JS entry directly with `node`** — `node <…>/npm/bin/npm-cli.js install jose@<pin>
  --no-save` with `shell:false`. It does **not** spawn `npm.cmd`. Since the CVE-2024-27980 mitigation,
  spawning a `.cmd` without a shell throws `EINVAL`, and spawning it *through* a shell misresolves the
  shim's own path on portable/Windows Node. Running `npm-cli.js` with the current node binary sidesteps
  all of it — no shell, no PATH lookup, no cwd sensitivity. (`npm-cli.js` is located beside the running
  `node`; if it genuinely can't be found, the installer falls back to a shell-spawned `npm`, with the
  version spec validated against a strict allowlist so the fallback can never be injected.)
- **It installs into the gateway's own `node_modules`** (resolved from the engine's location, not your
  cwd) with `--no-save`, so `require('jose')` resolves wherever ToolFunnel is installed and the
  package's `"dependencies": {}` stays untouched.
- **It never dead-ends.** Auto-install can't be universal — `npm-cli.js` sits in different places across
  Homebrew / Volta / Docker / odd nvm layouts. So on *any* failure the result carries a copyable
  `manualCommand` (`npm install jose@<pin>`) and the directory to run it in, and the CLI/UI surface that
  message. You always have a one-line command that works in your own shell. You can also just run that
  command yourself up front — the gateway only needs `require('jose')` to resolve.

## What it does

When enabled, the HTTP transport:

- **Validates** the `Authorization: Bearer <token>` on every request to `/mcp` (POST and the SSE GET)
  and `/health`, via `jose.jwtVerify` with a **pinned algorithm allowlist**, an **enforced issuer**,
  and an **enforced audience** bound to this gateway's resource URI (the RFC 8707 confused-deputy
  defence). A failure returns `401` (or `403` for insufficient scope) with a
  `WWW-Authenticate: Bearer resource_metadata="…"` challenge.
- **Serves discovery** (unauthenticated) at `GET /.well-known/oauth-protected-resource` — the
  RFC 9728 Protected Resource Metadata document naming the authorization server(s).
- **Unlocks a safe non-loopback bind.** With auth **off**, the host refuses to bind a non-loopback
  address (it would expose an unauthenticated gateway). With auth **on**, the token is the boundary,
  so off-localhost binds are allowed. The host also **refuses to start** if auth is on but `jose` is
  missing or the config is incoherent (fail-fast, with an actionable message).

## Configuration — `auth/auth.config.json`

Edit it in the UI's **Auth** tab, or directly. **Default OFF.** Read fresh per request (a toggle is
live; no restart).

| Field | Type | Meaning |
|---|---|---|
| `enabled` | boolean | Master switch. Default `false`. |
| `issuer` | string | The OAuth 2.1 / OIDC authorization server (the `iss` tokens must carry). **Required when enabled.** |
| `audience` | string | **This gateway's** resource URI. Tokens must be issued for it (`aud`). **Required when enabled** — without it tokens are unbound (the confused-deputy hole). |
| `jwksUri` | string | Explicit JWKS endpoint. Optional — if blank it is discovered from the issuer via OIDC / RFC 8414 discovery. |
| `algorithms` | string[] | The **pinned** signature-algorithm allowlist. Default `["RS256","ES256"]`. Pinning is the algorithm-confusion / `alg:none` defence. |
| `requiredScopes` | string[] | Optional. Every listed scope must be present (`scope` or `scp` claim), else `403 insufficient_scope`. |
| `clockToleranceSec` | number | `exp`/`nbf` skew tolerance, seconds. Default `30`, clamped to `[0, 300]`. |

### Example (enabled)

```json
{
  "enabled": true,
  "issuer": "https://auth.example.com",
  "audience": "https://gateway.example.com",
  "jwksUri": "",
  "algorithms": ["RS256", "ES256"],
  "requiredScopes": [],
  "clockToleranceSec": 30
}
```

## Roles, and what is *not* yet implemented

ToolFunnel implements the **resource-server** role (validating inbound tokens). The OAuth **client**
leg — Dynamic Client Registration (RFC 7591), authorization-server-metadata discovery for *outbound*
calls, step-up authorization — and the 2026 spec hardening (RFC 9207 issuer validation, credential
binding) are **roadmap**, not shipped. So today ToolFunnel authenticates clients *to it*; it does not
yet perform the full client-side flow *to upstreams that require OAuth*. See the
[roadmap](../README.md#roadmap).
