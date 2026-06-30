# Audit logging reference

ToolFunnel ships a small, optional **activity/audit log**: an append-only JSONL record of the
gateway's own decisions — which tools were run and how the gate ruled on them. It is
**off by default**, writes nothing until you turn it on, and is contracted never to interfere with a
tool call or the gate.

This document is derived from the code that actually implements it, not from intent:

- `src/core/logger.js` — the store: config read/write, the `log()` writer, and `tail()`.
- `src/mcp/protocol.js` and `src/mcp/gated-run.js` — the two emit points (tool runs and gate decisions).
- `tools/scripts/tf-log.js` — the `tf_log` management tool (the AI's control point).
- `src/ui/server.js` + `src/ui/public/app.js` — the admin UI Logs tab.

## Default OFF — privacy and lean by design

Nothing is logged, and **no files are created**, until logging is explicitly enabled.

- The toggle lives in `logs/log.config.json`. **A missing config file means disabled** — the safe
  default — so a fresh checkout logs nothing and creates nothing under `logs/`.
- `logger.log()` self-gates: on every call it re-reads the config and, if not enabled, returns
  immediately as a no-op (no file touched). Enabling is therefore the *only* thing that ever starts
  writing.
- The config is read **fresh on every event** (no caching). A toggle takes effect for the very next
  event — no reconnect, no restart.
- `log()` **never throws.** A bad config, an unwritable disk, a full filesystem — all are swallowed
  silently. A logging failure can never break a tool call or the gate. This is why the logger can be
  wired straight into the safety-critical run path without changing its behaviour.

## What gets logged

The gateway emits four kinds of record — two on the **run path** (tool runs, gate decisions) and two
**audit** records (config changes made through the admin UI, and auth denials at the transport gate).
Every record additionally carries a logger-stamped `ts` field (ISO-8601, prepended by `log()`) as its
first key.

### Tool runs — `type: 'tool'`

Emitted from the `toolfunnel_run_tool` path in `src/mcp/protocol.js`, once per invocation:

```json
{ "type": "tool", "name": "hash", "mode": "gateway-run", "ok": true, "blocked": false, "durationMs": 12 }
```

| Field | Meaning |
|---|---|
| `name` | The tool name the caller asked to run. |
| `mode` | The execution mode used — `gateway` / `gateway-run` for server-side runs, or `reference`. |
| `ok` | Whether the run succeeded (`normalized.ok === true`). |
| `blocked` | `true` when the PreToolUse gate denied the run. |
| `durationMs` | Wall-clock duration of the gated execution. |

> **Reference-mode tools log a lighter record.** A `reference` tool executes nothing on the
> server (the connected AI runs it in its own environment), so its record is
> `{ type:'tool', name, mode:'reference', ok:true, blocked:false }` with **no `durationMs`** —
> there was no server-side execution to time.

### Gate decisions — `type: 'gate'`

Emitted from `src/mcp/gated-run.js`, the single choke-point every server-side run and forwarded
upstream call passes through. The record is written for **both outcomes** (it sits before the
blocked-return), so every gated run produces one gate record:

```json
{ "type": "gate", "tool": "danger", "decision": "deny", "reason": "blocked by policy: rm -rf" }
```

| Field | Meaning |
|---|---|
| `tool` | The tool name the gate ruled on. |
| `decision` | `"allow"` or `"deny"` — `deny` is a PreToolUse block. |
| `reason` | The gate's reason string (e.g. a hook's deny message); `null` on an allow with no message. |

Because gate records come from the gated run path, **reference-mode tools produce no gate record** —
nothing is gated when nothing runs server-side.

### Config changes — `type: 'config'`, `via: 'ui'`

Emitted from `src/ui/server.js` (`logConfigChange`) after **every config-MUTATING admin-UI POST that
succeeds**. A management console changes the gateway's *security posture* — which tools are
visible/promoted/hidden, which upstreams attach, which hooks gate, whether OAuth is on — and auditing
those changes matters at least as much as logging individual tool runs. The record always carries
`type:'config'` and `via:'ui'`, an `event` naming the change, and only the fields that actually
changed (undefined fields are dropped):

```json
{ "type": "config", "via": "ui", "event": "tool_state", "id": "hash", "hot": true }
```

| `event` | Raised by | Notable fields |
|---|---|---|
| `tool_state` | toggle a tool's enabled/hidden/hot axis | `id`, plus whichever of `enabled` / `hidden` / `hot` changed |
| `tool_add` / `tool_remove` / `tool_update` / `tool_mode` | add / remove / edit / re-mode a tool | `id` (and `mode` for a mode change) |
| `tool_hook` | toggle a tool's Pre/Post gate | `id`, `hook`, `on` |
| `hook_add` / `hook_state` | add / enable-disable-remove a manifest hook | `id`, `action` |
| `mcp_add` / `mcp_state` | attach / enable-disable-remove an upstream | `id`, `action` |
| `auth_config` | change the OAuth config | `enabled`, `issuer` |
| `log_config` | toggle the activity log itself | `enabled` |
| `oauth_install` | install the optional `jose` dependency | — |

Read-only and test-only endpoints (e.g. `GET /api/tools`, `POST /api/mcp/discover`) are deliberately
**not** audited — they change nothing. Only a write that returns `ok:true` is logged. Like everything
here it is self-gating: silent until the log is enabled.

### Auth denials — `type: 'auth'`, `event: 'deny'`

Emitted from the OAuth gate in `src/mcp/http-transport.js` (`passesAuth`) when a request to a
protected route is **rejected**. This is the security-relevant event — and it was previously
invisible, because a denial happens at the transport gate *before* the protocol/logging layer ever
runs. A run of failed auth attempts now leaves a trace:

```json
{ "type": "auth", "event": "deny", "error": "invalid_token", "status": 401, "path": "/mcp" }
```

| Field | Meaning |
|---|---|
| `error` | The OAuth error code — `invalid_token` (bad/missing/expired) or `insufficient_scope`. |
| `status` | The HTTP status sent back — `401` (authenticate) or `403` (scope). |
| `path` | The request path (query string stripped). |

Only **denials** are logged — a successful auth proceeds to the normal run-path records above. Auth
records appear only on the HTTP transport (stdio is local-trust and ungated).

### Scope — honest about what this is *not*

This is an audit log of **the gateway's own activity**, not a request/response capture. A record
tells you *that* a tool ran (its name, mode, outcome, duration) and *how the gate ruled* (allow/deny
and why) — it does **not** contain the tool's input arguments or its output, unless a specific event
field happens to carry it (the gate's `reason` string is the only free-text field today). If you
need full tool I/O capture, that is a PostToolUse hook's job, not this log's.

## The JSONL format

The log is [JSON Lines](https://jsonlines.org/): **one JSON object per line**, newline-terminated,
strictly appended (`fs.appendFileSync`). Each line is an independent record — no enclosing array, no
commas between lines — so the file is safe to `tail -f`, grep, or stream, and a truncated final line
never corrupts the rest.

```jsonl
{"ts":"2026-06-29T13:02:11.004Z","type":"gate","tool":"hash","decision":"allow","reason":null}
{"ts":"2026-06-29T13:02:11.016Z","type":"tool","name":"hash","mode":"gateway-run","ok":true,"blocked":false,"durationMs":12}
{"ts":"2026-06-29T13:05:44.210Z","type":"gate","tool":"danger","decision":"deny","reason":"blocked by policy: rm -rf"}
```

Readers tolerate damage: `tail()` (used by the UI and by `tf_log status`) splits on newlines, drops
empty lines, and **skips any line that fails to parse** rather than failing the whole read.

## The three control points

All three converge on the same store (`src/core/logger.js`) and the same toggle file
(`logs/log.config.json`). Use whichever fits the context; they are interchangeable.

### 1. `tf_log` — the AI's control point

`tf_log` is a first-party **management** tool (category `management`), discovered via
`toolfunnel_list_tools` and executed via `toolfunnel_run_tool` through the PreToolUse gate. It is the
connected model's hands-on switch for the log.

Args: `{ action: 'enable' | 'disable' | 'status', path? }`

| Action | Effect | Output (one JSON line) |
|---|---|---|
| `enable` | Turns logging on; optional `path` overrides the log file. | `{ ok:true, action, enabled, path }` |
| `disable` | Turns logging off (the file is left in place). | `{ ok:true, action, enabled, path }` |
| `status` | Reports current config plus how many entries are on disk. | `{ ok:true, action, enabled, path, count }` |
| *(bad args)* | A logical failure is reported, never thrown. | `{ ok:false, error }` |

> **Disabling the `tf_log` tool revokes the AI's logging control.** `tf_log` is an ordinary register
> entry, so it can itself be turned off in `tools/tools.state.json` (or via the UI Tools tab). When
> it is disabled, the model can no longer discover or run it — logging can then only be changed via
> the UI Logs tab or by editing the config file directly. This is the intended way to take logging
> control out of the AI's hands.

### 2. The UI Logs tab — the human's control point

Launch the optional admin UI with `node bin/toolfunnel.js --ui` (binds `127.0.0.1:9777`) and open the
**Logs** tab. It is read-mostly:

- An **on/off switch** bound to the logger config (`POST /api/logs/config { enabled }`). A status
  word (`logging is on` / `logging is off`) and, when on, the resolved log **path** sit beside it.
- A **newest-first list** of the most recent **100** records (`GET /api/logs` → `tail(100)`,
  reversed for display). Each row shows a kind badge (`gate` / `tool` / `config` / `auth`), the
  subject (tool name, the config `event`, or the auth `path`), a status badge (`allow`/`deny` for
  gate rows; `ok`/`fail`/`blocked` for tool rows; the event name for config rows; `deny` for auth
  rows), and the timestamp; a second line shows the gate `reason`, the tool's `mode` and
  `durationMs`, the changed config fields, or the auth `error`/`status`.
- A **Refresh** button re-reads both the config and the recent entries.

When logging is off the list shows "Logging is off — flip the switch above to start recording."

### 3. `logs/log.config.json` — the file

The toggle is plain JSON at the repo root:

```json
{
  "enabled": false,
  "path": "logs/toolfunnel.log.jsonl"
}
```

- `enabled` — boolean; anything other than literal `true` reads as off.
- `path` — where the log is written; **relative paths resolve against the repo root**, absolute
  paths are honoured as-is. A missing/blank value falls back to the default below.

Both `tf_log` and the UI write this file through `logger.setConfig()`, which **atomically merges** a
partial patch (temp file + rename) so toggling `enabled` preserves your custom `path`, and vice
versa. `setConfig()` is also the *only* function that creates the file and the `logs/` directory —
consistent with default-off. You can hand-edit it, but prefer the tool or UI so the write stays
atomic.

## Where things live

| What | Path | Notes |
|---|---|---|
| Config (the toggle) | `<root>/logs/log.config.json` | Not created until logging is first enabled. Missing = disabled. |
| Log file | `<root>/logs/toolfunnel.log.jsonl` | Default; overridable via the config `path`. Created on first write. |

Both paths anchor on the repo root (`path.resolve(__dirname, '..', '..')` from `src/core/logger.js`),
matching the rest of ToolFunnel's "everything under the tree" convention. Neither file is needed for
the gateway to run — delete the log to clear history, delete the config to return to the default-off
state.
