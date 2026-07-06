# ToolFunnel — Known Bugs & 0.4.0 Backlog

> Findings from a full source review on **2026-07-03** (v0.3.0, commit `1c5841c`).
> Each item is ranked, located, explained, and paired with a proposed fix.
> Ordered by severity: fix #1 before a public release; the rest are polish.
>
> **Context for future-me:** the core gate architecture reviewed as *sound* — see
> "What is already solid" at the bottom before re-auditing. Do not re-review the
> whole tree; start from this list.

---

## Severity ranking (fix order)

| # | Severity | Area | One-liner |
|---|----------|------|-----------|
| 1 | **High** | UI server | Config UI can bind off-loopback with NO auth and NO refusal — unauthenticated LAN RCE surface |
| 2 | Low | mcp-client (win) | `winLaunch` cmd.exe metacharacter interpretation — "no injection surface" comment is overstated |
| 3 | Low | aggregator | `_scheduleReconnect` logs `reconnect_slow` every 30s forever instead of once at the transition |
| 4 | Low | http-transport | Streaming (chunked) over-cap body doesn't get the clean `-32700` that declared-Content-Length does |
| 5 | Defensive | auth/resource-server | OIDC discovery follows redirects with no origin-check on the discovered `jwks_uri` |

---

## 1. [HIGH] UI server binds off-loopback with no auth and no refusal

**Files:** `src/ui/server.js` (`createUiServer().start()`, `isLoopbackHost`), `bin/toolfunnel.js` (`--ui --host`)

**The asymmetry.** `src/mcp/http-transport.js` `start()` refuses to bind a non-loopback host
unless OAuth is enabled:

> `refusing to bind non-loopback host "<host>" without OAuth enabled — enable auth (and install jose) before exposing the gateway off localhost.`

The **UI server has no equivalent guard.** `createUiServer().start()` binds whatever `host`
it is handed, and `bin/toolfunnel.js` passes `--ui --host <anything>` straight through to it.

**Why the existing check does not cover it.** `isLoopbackHost()` inside the UI's `onRequest`
tests only the **`Host` request header**, which is fully attacker-controlled. It defends against
*browser* DNS-rebinding (the browser sets the Host to the attacker's domain), but does **nothing**
against a direct, non-browser client that simply sends `Host: localhost` / `Host: 127.0.0.1`.

**Why it matters more than the transport.** The config UI is the one surface that can *spawn
processes and mutate the security posture*:
- `POST /api/mcp/add` + `POST /api/mcp/discover` construct an `Aggregator` and **connect the
  configured upstream — i.e. spawn the configured command** (`aggregator.discover` → `_connectOne`
  → `clientFactory` → `McpClient.connect`).
- `POST /api/tools/add` / `/api/tools/update` **write tool scripts** to `tools/scripts/`.
- `POST /api/tools/hook` / `/api/hooks/*` **toggle the gate hooks.**

So `toolfunnel --ui --host 0.0.0.0` (a plausible "let me reach the config UI from my other
machine" move) exposes an **unauthenticated, process-spawning, script-writing console to the
LAN**. The HTTP transport learned this exact lesson; the UI never got the same stitch.

**Fix.** The UI has no auth path at all, so the correct behaviour is a hard refusal, mirroring the
transport's guard. In `createUiServer().start()`, before `httpServer.listen(...)`:

```js
if (!isLoopbackHost(host)) {
  return Promise.reject(new Error(
    `refusing to bind the config UI to non-loopback host "${host}" — the UI is ` +
    `unauthenticated and can spawn processes / write scripts. It is loopback-only by design.`
  ));
}
```

(Note: `isLoopbackHost` currently returns `true` for an *empty/missing* value — fine for a Host
*header*, but for a *bind address* an empty host should not be treated as loopback. Use a stricter
check on the bind arg, or default-and-validate the bind host explicitly.)

**Test to add:** `createUiServer({ host: '0.0.0.0' }).start()` rejects; `'127.0.0.1'`, `'localhost'`,
`'::1'` resolve.

---

## 2. [LOW] `winLaunch` cmd.exe metacharacter interpretation — comment overstates safety

**File:** `src/mcp/mcp-client.js` (`winLaunch`)

On Windows, a non-`.exe` upstream command is routed through `cmd.exe /c <command> <args…>` with
`shell:false` (the CVE-2024-27980 `.cmd` workaround). The code comment claims:

> "The args stay DISCRETE (Node escapes each one under shell:false) so nothing is shell-concatenated
> — no injection surface on this privileged path."

**That guarantee is not quite real.** With `shell:false` and the command being `cmd.exe` (an
`.exe`), Node applies its *standard argv quoting*, **not** cmd.exe metacharacter (`^`) escaping —
that special-casing only fires when the *command itself* is the `.cmd`/`.bat`. So a config arg
containing `& | > < "` can be reinterpreted by cmd.exe.

**Real-world risk: near-zero.** These args come from `expose.json`, authored by the operator — the
"attacker" would be the person who owns the config. But the comment claims a property the code does
not provide.

**Fix (pick one):**
- Downgrade the comment to state the residual cmd.exe-parsing caveat honestly, **or**
- Defensively quote each arg for cmd.exe, **or**
- Prefer resolving the real interpreter path (`where npx` → the `node` + `npm-cli.js` shape, as
  `auth/install.js` already does for npm) and spawn that directly with `shell:false`, avoiding
  `cmd.exe` entirely.

---

## 3. [LOW] `_scheduleReconnect` spams `reconnect_slow` every 30s forever

**File:** `src/mcp/aggregator.js` (`_scheduleReconnect`)

Past `MAX_FAST_ATTEMPTS` (6) the method re-schedules with `Math.min(attempt + 1, MAX_FAST_ATTEMPTS)`
→ the attempt counter **sticks at 6**. The entry logs `if (attempt === MAX_FAST_ATTEMPTS)`, so a
permanently-dead-but-enabled upstream emits a `reconnect_slow` log line **every 30 seconds
indefinitely**, rather than once at the fast→slow transition.

**Fix.** Log the transition only. E.g. only log when entering the slow phase from the fast phase
(track the previous attempt, or log inside the `attempt + 1` escalation exactly when it crosses
`MAX_FAST_ATTEMPTS`, not on every subsequent capped re-entry).

---

## 4. [LOW] Streaming over-cap body misses the clean `-32700` the declared-CL path produces

**File:** `src/mcp/http-transport.js` (`readBody`, `handleMcpPost`)

The **declared-Content-Length** over-cap path is carefully engineered (`sendJsonAndClose`: announce
`Connection: close`, flush the `-32700` body, *then* destroy the request in the `res.end` callback)
so the client receives a clean parse-error before the close.

The **streaming/chunked** over-cap path is not held to the same standard: `readBody` rejects and
immediately `req.destroy()`s. Because `req` and `res` share the socket, the follow-up
`sendJson(res, 200, makeError(...))` in `handleMcpPost`'s catch writes to a torn-down socket → the
client sees `ECONNRESET` instead of the tidy `-32700`.

**Not a crash** — every path here is defensive and the server survives. It is an inconsistency: two
over-cap paths that should behave identically don't.

**Fix.** Route the streaming over-cap case through the same flush-then-close sequence as
`sendJsonAndClose` (don't `req.destroy()` before the response body has flushed).

---

## 5. [DEFENSIVE] OIDC discovery follows redirects with no origin-check on discovered `jwks_uri`

**File:** `src/auth/resource-server.js` (`resolveJwksUri`, `fetchJson`)

`fetchJson` uses `redirect: 'follow'`, and `resolveJwksUri` accepts whatever `jwks_uri` the issuer's
discovery document advertises with no check that it shares the issuer's origin. The issuer is
operator-configured (trusted), and audience binding is still enforced on the verified token, so this
is standard OIDC behaviour and low-risk — but a defensive origin-pin on the discovered `jwks_uri`
(and/or `redirect: 'error'` on discovery) would tighten the SSRF-adjacent surface.

**Fix (optional hardening):** assert the discovered `jwks_uri` origin matches the issuer origin, or
make it opt-out-able. Document the decision either way.

---

## What is already solid (do NOT re-audit from scratch)

The review found the **gate architecture sound**. Confirmed on 2026-07-03:

- **`gatedRun` fails CLOSED on every bad-wiring path** — no engine / junk engine return / engine
  throw all → `blocked:true`, `execute()` never called. The load-bearing invariant ("a PreToolUse
  deny prevents `execute()` from ever running") is real and centralised in one auditable place
  (`src/mcp/gated-run.js`).
- **The engine proxy reads `build.engine` live** (`src/mcp/server.js`), so a hot-reloaded hook gates
  BOTH the `toolfunnel_run_tool`/lean path AND the curated-direct path — no stale-engine gap.
- **OAuth validator does the things that matter** (`src/auth/resource-server.js`): pins the algorithm
  allowlist (blocks alg-confusion + `alg:none`), enforces `audience` (RFC 8707 confused-deputy
  defence) and `issuer`, requires `exp` present, never reads the token header to choose the alg.
- **Isolation guard on path-shaped upstream args** (`aggregator.defaultClientFactory` / `isInside` /
  `looksLikePath`) — a vendored upstream can't point outside the gateway root; the interpreter slot
  is correctly exempt.
- **Path-escape defences** in `registry.writeScript` and `defaultRunScript` (basename + in-root
  assertion), and **atomic temp+rename writes** across registry / tool-state / expose-store / auth
  config / logger.
- **The hook matcher is correctly full-anchored** (`^(?:…)$` in `src/core/matcher.js`), so a gate on
  `read` does NOT leak onto `read_file`; combined with the UI's `escapeRegex` on gate writes, that
  path is right.
- **`McpClient` framing was fixed** in v0.3.0 to newline-delimited JSON (was LSP `Content-Length`),
  with dual-drain read tolerance — proven against `server-everything` / `server-filesystem` + the
  official SDK client. Zombie-guard tree-kill on close.

The v0.3.0 adversarial pass (backlog task #49) did real work on the OAuth/transport surface. Finding
#1 above is the one gap that pass did not close (it hardened the *transport*, not the *UI*).
