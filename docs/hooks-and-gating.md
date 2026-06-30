# Hooks and gating

Every tool execution in ToolFunnel funnels through one chokepoint: the **hook engine**. Before a
tool runs, a `PreToolUse` hook can **block** it; after it runs, a `PostToolUse` hook can **observe**
the result. Hooks are small command-line programs you drop into `hooks/scripts/` and register in
`hooks/hooks.manifest.json`. This is the gateway's safety layer — the reason a tool call can be
denied, audited, or annotated without touching the tool itself.

This document is derived from the modules that actually implement the gate — `src/mcp/gated-run.js`,
`src/core/hook-engine.js`, `src/core/hook-runner.js`, `src/core/matcher.js`, and
`src/core/events.js` — not from intent. The protocol mirrors Claude Code's hook system so hook
scripts written for Claude Code run here unchanged.

For the manifest field-by-field reference and the activation overlay, see
[`configuration.md`](configuration.md). For the tool register and upstreams, see
[`tools-and-upstreams.md`](tools-and-upstreams.md).

---

## The gate at a glance

Every powerful run-path — `toolfunnel_run_tool` and the curated-direct path — routes a single tool
invocation through `gatedRun({ engine, ctx, toolName, args, execute })` (`src/mcp/gated-run.js`).
The sequence is fixed:

1. **Fire `PreToolUse`** with `{ tool_name, tool_input: args }`.
2. **If any hook blocks → STOP.** Return `{ ok:false, blocked:true, reason, output:null }` and
   **`execute()` is never called.** This is the load-bearing invariant, proven by test:
   *a `PreToolUse` deny MUST prevent execution.*
3. **Otherwise `await execute()`** — the real tool call. A throw is captured as `error` (output
   stays `null`); `gatedRun` itself never throws.
4. **Fire `PostToolUse`** with `{ tool_name, tool_input: args, tool_response: output }` — fired even
   on the error path so observers see the outcome.
5. **Return** `{ ok:true, blocked:false, output }`, or `{ ok:false, blocked:false, error, output:null }`.

```
toolfunnel_run_tool(name, args)
        │
        ▼
   ┌─────────────┐   blocked   ┌──────────────────────────────┐
   │ PreToolUse  │────────────▶│ { ok:false, blocked:true,    │   execute() NEVER runs
   │  (the GATE) │             │   reason, output:null }      │
   └─────────────┘             └──────────────────────────────┘
        │ allowed
        ▼
   ┌─────────────┐
   │  execute()  │  ← the actual tool side effect happens HERE, and only here
   └─────────────┘
        │ output (or captured error)
        ▼
   ┌─────────────┐
   │ PostToolUse │  ← advisory: observes tool_response; CANNOT un-run the tool
   └─────────────┘
        │
        ▼
   { ok, blocked, output | error }
```

### Fail closed

The gate is the safety crux, so it treats an *untrustworthy* engine as a *denying* engine.
`fireSafely` (in `gated-run.js`) wraps every `engine.fire`:

- A `PreToolUse` fire that **rejects**, or returns a **non-object**, is normalised to
  `blocked: true` — a gate that cannot answer "allowed?" is never read as "allowed".
- A bad wiring (missing `engine.fire`, missing `execute` thunk) returns `blocked: true` without
  ever calling `execute`.
- `PostToolUse` is advisory, so a failure there is benign — it never flips `ok` and never throws.

The result is a hard guarantee: **the only way `execute()` runs is a clean `PreToolUse` allow.**

---

## The six lifecycle events

The engine supports exactly six events (`src/core/events.js`, frozen). The value is written into
the stdin payload as `hook_event_name`. Every event carries four common fields —
`session_id`, `transcript_path`, `cwd`, `hook_event_name` — plus its own:

| Event | Added payload fields | Can block? | Matcher applies? |
|---|---|---|---|
| `SessionStart` | `source` (`"startup"` \| `"resume"` \| `"compact"`) | no | no (tool-less) |
| `UserPromptSubmit` | `prompt` (user text) | yes (`decision:"block"`) | no (tool-less) |
| **`PreToolUse`** | `tool_name`, `tool_input` | **yes — ENFORCEMENT** | **yes** |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response` | no (advisory) | yes |
| `Stop` | `stop_hook_active` (bool) | yes (`decision:"block"`) | no (tool-less) |
| `PreCompact` | `trigger` (`"manual"` \| `"auto"`), `custom_instructions` | no | no (tool-less) |

`SessionStart` and `UserPromptSubmit` are special: on a clean `exit 0`, their stdout becomes
**injected context** (see *Injection*, below). The other events' stdout is advisory unless it uses
the JSON protocol.

Only the tool-bearing events (`PreToolUse`, `PostToolUse`) consult the matcher. For the four
tool-less events there is no `tool_name`, so the matcher is ignored and the hook always fires.

> **The gated-run path uses only `PreToolUse` and `PostToolUse`.** The other four events are fired
> by the host directly around the session/prompt lifecycle (where their injection and block
> decisions are consumed); `gatedRun` itself fires nothing else.

---

## PreToolUse = enforcement · PostToolUse = observe / shape

These two events look symmetric but are not. The asymmetry is the whole design.

### PreToolUse — the enforcement point

`PreToolUse` runs **before** the tool. It is the only event in the run-path that can stop a tool
from happening. A `PreToolUse` block means `execute()` is never invoked — no side effect, no
output, just `{ ok:false, blocked:true, reason }`. Use it to:

- **Deny** a dangerous call outright (destructive args, disallowed target, missing confirmation).
- **Require a precondition** (a confirm flag, a dry-run first, a rate check).
- **Inject context** for the model via `additionalContext` (see below) while still allowing.

Because it gates real side effects, `PreToolUse` **fails closed**: a hook that errors or returns
junk is treated as a denial by the engine wrapper.

### PostToolUse — observe and shape, never block

`PostToolUse` runs **after** the tool, with the tool's output in `tool_response`. It **cannot
un-run the tool** — the side effect has already happened. It is the place for:

- **Audit** — append the call + result to a log, emit metrics.
- **Alerting / triggers** — fire a webhook or kick off follow-on work when a result matches.
- **Redaction / transform of *downstream* state** — scrub a secret from a log you control, rewrite
  an artifact the tool produced. (It shapes side effects, not the already-returned value.)

In the gated-run path `gatedRun` fires `PostToolUse` purely for observation and **discards its
result** — a `PostToolUse` `decision:"block"` or `additionalContext` does not flow back through
`gatedRun`, because there is nothing left to block. (For the host-fired lifecycle events the engine
*does* surface `blocked`/`injected`; that is a different path.) Treat `PostToolUse` as
fire-and-observe: anything it needs to *do*, it does as its own side effect.

---

## Writing a hook

A hook is a command. The runner (`src/core/hook-runner.js`) spawns it with `shell: true`, writes
the **event JSON to its stdin**, captures stdout/stderr, and interprets the result. Your script:

1. **Reads the event JSON from stdin** (the payload for its event — see the table above).
2. **Decides**, then signals the decision with **one of two output protocols**.
3. **Exits.**

The runner **never rejects**: a spawn failure, a timeout, or a malformed spec always resolves to a
well-formed result (`exitCode:-1`, `blocked:false`). Timeout is the manifest `timeout` in
**seconds** (default 60); past it the whole child tree is killed.

### Output protocol A — exit code (simplest)

| Exit code | Meaning |
|---|---|
| `0` | **Success / allow.** For `SessionStart` & `UserPromptSubmit`, stdout becomes injected context; for other events stdout is advisory (captured, not acted on). |
| `2` | **Block.** `stderr` is the block reason. This is the simplest way to deny a `PreToolUse` call. |
| any other non-zero | **Non-blocking error.** stderr is captured; the call is **not** blocked. |

`exit 2` always blocks, on any event, and stdout/JSON is ignored on any non-zero exit.

### Output protocol B — JSON on stdout (honoured only on `exit 0`)

If the script exits `0` and stdout is a JSON object carrying a known protocol key
(`continue`, `decision`, `reason`, or `hookSpecificOutput`), the runner reads it as structured
output. An arbitrary JSON blob with none of those keys falls through to protocol A.

| Field | Effect |
|---|---|
| `hookSpecificOutput.permissionDecision` | **`PreToolUse` gate.** `"deny"` blocks (reason from `hookSpecificOutput.permissionDecisionReason`); `"allow"` passes; `"ask"` is non-blocking in this autonomous host (no interactive prompt) — its reason is captured for context. |
| `decision: "block"` | Block for the other blockable events (`UserPromptSubmit`, `Stop`, `PostToolUse`, `PreCompact`); reason from top-level `reason`. (There is no `"approve"`.) |
| `continue: false` | Stop the whole hook loop (`stopLoop`). |
| `hookSpecificOutput.additionalContext` | Text **injected** into context (any event). |

> The real Claude Code mechanism for a `PreToolUse` deny is `hookSpecificOutput.permissionDecision`,
> **not** a top-level `decision`. This gateway follows that exactly.

### Injection

Injected text — `additionalContext` (protocol B, any event), or the raw stdout of a `SessionStart`/
`UserPromptSubmit` hook on `exit 0` (protocol A) — is collected by the engine and returned as the
joined `injected` string. The host consumes that for the session/prompt lifecycle events. Note that
`gatedRun` does not surface injection back to the tool caller, so `additionalContext` from a
`PreToolUse` hook is collected by the engine but not propagated through the tool-run result.

### Aggregation (when several hooks match one event)

Matching hooks run **concurrently** (capped, default 8) but results are aggregated in **manifest
order** (`src/core/hook-engine.js`):

- **`blocked` / `reason`** — the **first** blocking hook in manifest order owns the reason.
- **`injected`** — every non-null inject fragment, joined by `"\n"`, in order.
- **`stopLoop`** — true if **any** hook returned `continue:false`.

---

## The `CLAUDE_PROJECT_DIR` / `HOOKS_DIR` environment (Claude-Code-compatible)

Two mechanisms let a hook resolve its own files. They are intentionally Claude-Code-compatible so a
hook authored for Claude Code resolves itself the same way here.

1. **`${HOOKS_DIR}` token in the manifest `command`** — expanded **at load time** by
   `src/core/hook-loader.js` to the absolute hooks directory, resolved from the manifest's own
   location (the manifest sits in `hooks/`, so `${HOOKS_DIR}` → `<repo>/hooks`). **This is the
   reliable way to point at your script**, e.g. `node "${HOOKS_DIR}/scripts/gate-danger.js"`. It is
   a literal string substitution done before the command ever runs.

2. **Child-process environment variables** set by the runner on every hook spawn:
   - **`CLAUDE_PROJECT_DIR`** — the repository root (`<repo>`). Reliable; derive any path from it.
   - **`HOOKS_DIR`** — the hooks directory the runner resolved (precedence: an explicit
     `opts.hooksDir`, then an `env.HOOKS_DIR`, then the runner's built-in default).

Prefer the `${HOOKS_DIR}` **manifest token** (load-time expansion, always the directory containing
the manifest) or `CLAUDE_PROJECT_DIR` (the repo root) to locate files. See the *Caveats* note at the
end about reading the `HOOKS_DIR` **env var** directly.

---

## Matcher semantics

The matcher (`src/core/matcher.js`) decides whether a hook fires for a given tool. It mirrors Claude
Code:

- `""`, `undefined`, or `"*"` → **always fire** (wildcard).
- Tool-less events (`tool_name` is `null`/`undefined`) → the matcher is **ignored**; the hook always
  fires.
- Otherwise the matcher is a **regex, anchored as a FULL match** against `tool_name`. It is wrapped
  as `^(?:<matcher>)$`, so `"Bash|Write|Edit"` means *the whole tool name is one of these*, not
  *contains one of these*.
- A **malformed regex fails closed** — it matches nothing and never throws.

### What `tool_name` actually is — read this before writing a matcher

For a first-party tool run via `toolfunnel_run_tool`, the `tool_name` the matcher sees is the
register entry's **display `name`** (falling back to its `id`), **not** the lowercase id. The server
adapter resolves the call and passes `toolName: entry.name || id` into the gate.

So to gate the `danger` demo (id `danger`, **name `"Danger Demo"`**) the matcher must be
`"Danger Demo"`, not `"danger"`. Spaces are literal in the regex; `^(?:Danger Demo)$` matches the
exact name. To gate several tools, use an alternation: `"Danger Demo|Bash"`.

---

## Where hooks live

```
hooks/
├── hooks.manifest.json     # the gate — the ordered list of hooks (config)
├── hooks.state.json        # per-hook enabled overlay (created on first toggle; overlay WINS)
└── scripts/                # your hook programs (the source of truth for what EXISTS)
    └── gate-danger.js
```

The default `hooks.manifest.json` is `{ "version": 1, "hooks": [] }` — **an empty `hooks` array is
allow-all**: no hook fires, every tool runs. The gate only bites once you add an enabled hook.

A manifest entry:

```json
{
  "id": "pre-tool-use/gate-danger",
  "event": "PreToolUse",
  "matcher": "Danger Demo",
  "type": "command",
  "command": "node \"${HOOKS_DIR}/scripts/gate-danger.js\"",
  "script": "scripts/gate-danger.js",
  "timeout": 5,
  "enabled": true,
  "description": "Deny the Danger Demo tool unless args.confirm === true."
}
```

- `command` is what the runner spawns (`${HOOKS_DIR}` expands at load). The event payload arrives on
  its **stdin**.
- `script` is the path relative to `hooks/` used by the manager's open/edit; writes are path-guarded
  to stay inside `hooks/scripts/`.
- `timeout` is in **seconds** (default 60).
- `enabled` here is the manifest **seed**; the live value is the `hooks.state.json` overlay, which
  **wins** at load. See [`configuration.md`](configuration.md#activation-overlay--srchookshooksstatejson)
  for the overlay rules.

> Tool scripts live under `tools/scripts/`; **hook** scripts live under `hooks/scripts/`. They are
> separate trees with separate path guards — don't cross them.

---

## Worked example — gating the `danger` tool

The `danger` demo tool exists to prove the gate. Its only side effect is appending one line to the
file named by the env var `TOOLFUNNEL_DANGER_LOG` (`tools/scripts/danger.js`). If the gate denies
the call, `execute()` never runs, so **that line never appears** — the observable proof that the
gate held. A runnable version of this example ships under
[`examples/gate-danger/`](../examples/gate-danger).

### 1. The hook script — `hooks/scripts/gate-danger.js`

Reads the `PreToolUse` event JSON from stdin and denies unless `tool_input.confirm === true`. It
fails closed: an unparsable payload is a denial.

```js
#!/usr/bin/env node
'use strict';

// PreToolUse gate for the "Danger Demo" tool.
// Contract: read the event JSON from stdin; deny by exiting 2 (stderr = reason),
// allow by exiting 0. Fails closed — anything unexpected denies.

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let event;
  try {
    event = JSON.parse(raw || '{}');
  } catch (_err) {
    process.stderr.write('gate-danger: unparsable event payload — denying.\n');
    process.exit(2); // block (exit-code protocol)
  }

  const args = (event && event.tool_input) || {};
  if (args.confirm === true) {
    process.exit(0); // allow — execute() will run
  }

  process.stderr.write('Danger Demo is gated: pass { "confirm": true } to proceed.\n');
  process.exit(2); // deny — execute() is NEVER called
});
```

The same deny using the **JSON protocol** (protocol B) instead of `exit 2` — useful when you also
want to surface a structured reason:

```js
// ...inside the 'end' handler, the deny branch:
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'Danger Demo requires { confirm: true }.'
  }
}) + '\n');
process.exit(0); // JSON protocol is honoured ONLY on exit 0
```

### 2. Register it — `hooks/hooks.manifest.json`

```json
{
  "version": 1,
  "hooks": [
    {
      "id": "pre-tool-use/gate-danger",
      "event": "PreToolUse",
      "matcher": "Danger Demo",
      "type": "command",
      "command": "node \"${HOOKS_DIR}/scripts/gate-danger.js\"",
      "script": "scripts/gate-danger.js",
      "timeout": 5,
      "enabled": true,
      "description": "Deny the Danger Demo tool unless args.confirm === true."
    }
  ]
}
```

`matcher` is `"Danger Demo"` — the register **display name** of the `danger` tool, which is what the
gate sees as `tool_name` (not the id `danger`).

### 3. What happens

| Call | `PreToolUse` result | `danger.js` side effect |
|---|---|---|
| `toolfunnel_run_tool({ name: "danger" })` | **blocked**, reason from stderr | **none** — `execute()` never runs; no line in `TOOLFUNNEL_DANGER_LOG` |
| `toolfunnel_run_tool({ name: "danger", args: { confirm: true } })` | allowed | the tool runs; one line appended to the log |

The denied call returns `{ ok:false, blocked:true, reason:"Danger Demo is gated: ..." }`. Because
the gate sits *before* `execute()`, the proof is the absence of the log line — exactly the invariant
the gateway guarantees.

To exercise it: enable the hook, set `TOOLFUNNEL_DANGER_LOG` to a scratch file in the host
environment, and run `danger` with and without `{ confirm: true }`. The file gains a line only on
the allowed call.

---

## Gating the management functions (recursive safety)

The eight `tf_*` management functions — `tf_tool_add`, `tf_tool_set`, `tf_mcp_add`, `tf_mcp_set`,
`tf_hook_add`, `tf_hook_set`, `tf_list`, `tf_log` (category `management` in the register; full
reference in [`management.md`](management.md)) — are **ordinary register tools** reached through
`toolfunnel_run_tool`. So every management call funnels through the **same `gatedRun`
PreToolUse gate** as any other tool — the gate is uniform, with no privileged side door.

Because `tool_name` for a first-party tool is the register **display name** (here each `name`
equals its `id`: `tf_tool_add`, …), a single `PreToolUse` hook with matcher `tf_.*` (anchored as a
full match → `^(?:tf_.*)$`) gates **every** management call at once. Use it to require a confirm
flag, deny mutation of the register/upstreams/hooks, or block self-extension entirely.

This is **recursive safety**: even the gate-management tools are themselves gated. A `tf_hook_set`
that would disable your deny hook, or a `tf_tool_set` that would remove a tool, still hits
`PreToolUse` first — so one `tf_.*` hook can hold the whole management surface closed, and `tf_log`
can itself be disabled to revoke logging control.

---

## Safety summary

- **One chokepoint.** Every powerful run-path goes through `gatedRun` — the gate cannot be bypassed.
- **`PreToolUse` enforces, fails closed.** A block, an engine error, or a junk return all prevent
  `execute()` from running.
- **`PostToolUse` observes.** It sees the result and can act on side effects, but it cannot un-run
  the tool, and in the gated-run path its result is discarded.
- **Empty manifest = allow-all.** Safety is opt-in: add an enabled `PreToolUse` hook to bite.
- **Match the display name.** `tool_name` for first-party tools is the register `name`, not the id.
- **Management is gated too.** The `tf_*` self-extension functions run through the same gate; a
  single `PreToolUse` hook matching `tf_.*` restricts the whole management surface (recursive safety).

---

## Caveats

- **Read files via `${HOOKS_DIR}` (manifest token) or `CLAUDE_PROJECT_DIR` (env), not the
  `HOOKS_DIR` env var.** The `${HOOKS_DIR}` token is expanded at load to the manifest's directory
  (`<repo>/hooks`) and is always correct; `CLAUDE_PROJECT_DIR` is the repo root. The `HOOKS_DIR`
  *environment variable* the runner exports falls back to its built-in default, which currently
  tracks the legacy `src/hooks` location rather than the top-level `hooks/` — so prefer the token or
  `CLAUDE_PROJECT_DIR` for resolving paths inside a hook script.
- **`timeout` is seconds, not milliseconds.** A `timeout: 5` is a 5-second budget.
- **Exit code `2` is the only blocking exit code.** Any other non-zero exit is a *non-blocking*
  error — your deny will silently pass through if you exit `1`.
