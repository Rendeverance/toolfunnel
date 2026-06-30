# Management & execution modes

ToolFunnel can manage *itself* through the same lean meta-tool surface it uses for everything
else. Eight first-party **management functions** — all in the register `category: "management"` —
let an agent (or a human, via the admin UI) add and toggle tools, register and curate upstream
MCPs, configure the hook gate, list everything that is configured, and switch the activity log on
or off. There is no separate admin API and no extra advertised tool: management runs through
`toolfunnel_run_tool`, behind the **same `PreToolUse` gate** as any other tool. That is deliberate —
the functions that *configure* the gateway are themselves gateable, which is the recursive-safety
story this document ends on.

This document is derived from the scripts that implement the functions
(`tools/scripts/tf-*.js`), their register entries (`tools/tools.register.json`), and the register
engine (`src/tools/registry.js`) — not from intent. For the hook gate itself see
[`hooks-and-gating.md`](hooks-and-gating.md); for the register/upstream model see
[`tools-and-upstreams.md`](tools-and-upstreams.md); for the manifest/overlay field reference see
[`configuration.md`](configuration.md).

---

## The management surface at a glance

| Function | What it changes | Read/Write | Liveness |
|---|---|---|---|
| `tf_tool_add` | Adds a register entry (optionally writes its backing script). | write | live — meta-tools re-read the register every call |
| `tf_tool_set` | Enables / disables / removes a register tool. | write | live |
| `tf_mcp_add` | Registers an upstream MCP (optionally curates some of its tools). | write | curated-direct surface needs an aggregator reconnect |
| `tf_mcp_set` | Enables / disables / removes an upstream MCP. | write | reconnect for the curated-direct surface |
| `tf_hook_add` | Adds a hook manifest entry (e.g. a `PreToolUse` gate). | write | live for the gate (loaded per gated run) |
| `tf_hook_set` | Enables / disables / removes a hook. | write | live |
| `tf_list` | Lists tools, MCPs, or hooks with their live state. | read-only | n/a |
| `tf_log` | Enables / disables / checks the JSONL audit log. | write | live |

All eight are ordinary register entries whose `invoke` is `{ type:"script", path:"scripts/tf-*.js" }`,
so they resolve to **gateway-run** mode (they execute server-side, on the host where ToolFunnel
lives — see *Execution modes*, below) and they touch **only** files inside the ToolFunnel root
(each script resolves its paths from its own `__dirname`, never from a caller-supplied path).

---

## How an AI invokes a management function

There is no special calling convention. A management function is reached exactly like every other
register tool — through the run meta-tool:

```jsonc
toolfunnel_run_tool({ name: "tf_list", args: { kind: "tools" } })
```

- **`name`** is the exact tool name as returned by `toolfunnel_list_tools` (e.g. `"tf_tool_add"`).
  For management functions the register `id` and display `name` are identical, so the distinction
  never matters here.
- **`args`** is the structured argument object for that function (the tables below). Omitted/empty
  args arrive at the script as `null`/`{}`; each script reports bad input as a clean
  `{ ok:false, error }` rather than crashing.
- Discover them first with `toolfunnel_list_tools({ category: "management" })`; pull a single
  function's argument doc with `toolfunnel_tool_instructions({ name: "tf_hook_add" })`.

### The result envelope

`toolfunnel_run_tool` returns the canonical gateway result, **not** the script's JSON directly.
For a successful gateway-run call:

```jsonc
{
  "ok": true,
  "blocked": false,
  "output": {
    "ok": true,            // ← from the script (defaultRunScript: ok = exit code 0)
    "code": 0,
    "stdout": "{\"ok\":true,\"id\":\"echo-upper\",\"name\":\"Echo Upper\", ...}\n",
    "stderr": ""
  }
}
```

The management function's own JSON payload (e.g. `{ ok:true, id, action, enabled, state }`) is the
**single JSON line in `output.stdout`** — parse that to read what the function reported. A logical
failure inside the script is still `output.stdout` with `{ ok:false, error }` and exit 0 (the script
contract); the run itself succeeded.

If a `PreToolUse` hook **denies** the call, you instead get the block envelope and the script never
runs:

```jsonc
{ "ok": false, "blocked": true, "reason": "<hook's deny reason>", "output": null }
```

---

## The eight management functions

Every script follows the same contract (`src/tools/registry.js::defaultRunScript`): args arrive as
JSON in `TOOLFUNNEL_TOOL_ARGS`, the script prints **exactly one JSON object** to stdout and exits 0.
Writes are atomic (temp file + fsync + rename). The shapes below are exactly what each script reads.

### `tf_tool_add` — register a new tool

Adds a register entry, and (optionally) writes the backing script in the same call so the entry
never references a missing file. Change is **live** — the meta-tools re-read the register on the
next call, no reconnect.

| Arg | Type | Meaning |
|---|---|---|
| `id` | string (required) | Stable, unique key. Fails if it already exists. |
| `name` | string (required) | Display name. |
| `summary` | string | The one line `toolfunnel_list_tools` shows — keep it tight. |
| `category` | string | Grouping label (`text`, `crypto`, …). |
| `instructions` | string | Full usage doc returned by `toolfunnel_tool_instructions`. |
| `invoke` | object (required) | `{ type:"script", path:"scripts/<file>" }` or `{ type:"shell", command:"…" }`. |
| `scriptText` | string | If given **and** `invoke.type === "script"`, the body is written to `tools/scripts/<basename>` first (path-guarded), then the entry is added. |

Output: `{ ok:true, ...<the added entry>, scriptPath?: "<abs path>" }` (the `scriptPath` only when
`scriptText` was written), or `{ ok:false, error }`.

> **Mode note:** `tf_tool_add` does **not** accept a `mode` field — it always carries an `invoke`,
> so the new tool resolves to **gateway-run** (the mode is inferred from the invoke). To make a tool
> **reference**-mode, set its `mode` via the admin UI's per-tool mode control or by editing the
> register entry directly (see *Execution modes*).

```jsonc
// Add a script tool AND author its script in one call:
toolfunnel_run_tool({
  name: "tf_tool_add",
  args: {
    id: "echo-upper",
    name: "Echo Upper",
    summary: "Uppercase the supplied text and echo it back.",
    category: "text",
    instructions: "Args: { text: string }. Returns { ok:true, upper }.",
    invoke: { type: "script", path: "scripts/echo-upper.js" },
    scriptText: "#!/usr/bin/env node\n'use strict';\nconst a=JSON.parse(process.env.TOOLFUNNEL_TOOL_ARGS||'null');\nprocess.stdout.write(JSON.stringify({ok:true,upper:String(a&&a.text||'').toUpperCase()})+'\\n');\n"
  }
})
```

### `tf_tool_set` — enable / disable / remove a tool

Flips the active overlay or removes a tool entirely.

| Arg | Type | Meaning |
|---|---|---|
| `id` | string (required) | The register id. |
| `action` | `"enable"` \| `"disable"` \| `"remove"` (required) | `enable`/`disable` flip the `tools/tools.state.json` active overlay (default ON); `remove` deletes the register entry **and** purges its state key. |

Disabled tools are hidden from `toolfunnel_list_tools` (the entry stays in the register).
Output: `{ ok:true, id, action, enabled, state }` for enable/disable, or
`{ ok:true, id, action, removed:true, state }` for remove (`state` is the resulting overlay map).

```jsonc
toolfunnel_run_tool({ name: "tf_tool_set", args: { id: "echo-upper", action: "disable" } })
```

### `tf_mcp_add` — register an upstream MCP (and optionally curate it)

Adds an `upstreams[]` entry to `mcp/expose.json` and, for each `expose[]` item, a curated-direct
selection. The curated-direct surface is advertised at connect time, so **a new expose needs an
aggregator reconnect to appear**; the upstream record itself is persisted immediately.

| Arg | Type | Meaning |
|---|---|---|
| `id` | string (required) | Unique upstream key referenced by exposes. |
| `command` | string (required) | The interpreter/executable to spawn (`node`, `npx`, …). |
| `args` | string[] | argv. Any **path-shaped** token must resolve inside the ToolFunnel root (isolation guard). |
| `env` | object | Extra environment for the spawned process. |
| `transport` | string (default `"stdio"`) | Connection transport. |
| `enabled` | boolean (default `true`) | Whether the aggregator connects to it. |
| `description` | string | Human-facing note for the UI. |
| `expose` | array | `[{ tool, as?, category?, enabled? }]` — each item curates one upstream tool. `tool` is the upstream's real tool name; `as` is the downstream name (defaults to `<id>_<tool>`). |

Output: `{ ok:true, upstream:{…}, exposed:[{…}] }`, or `{ ok:false, error }`. There is **no
cross-step transaction**: if the upstream is added but a later `expose[]` item fails validation, the
upstream and earlier exposes remain persisted and the failure is reported.

```jsonc
toolfunnel_run_tool({
  name: "tf_mcp_add",
  args: {
    id: "mock",
    command: "node",
    args: ["mcp/servers/mock-upstream/server.js"],
    description: "Bundled demo upstream (ping, add, echo).",
    expose: [
      { tool: "ping", as: "mock_ping", category: "demo" }
    ]
  }
})
```

### `tf_mcp_set` — enable / disable / remove an upstream MCP

| Arg | Type | Meaning |
|---|---|---|
| `id` | string (required) | The upstream id. |
| `action` | `"enable"` \| `"disable"` \| `"remove"` (required) | `enable`/`disable` toggle the upstream; `remove` deletes it and **cascade-removes** its `expose[]` entries. |

A reconnect is needed for the curated-direct surface to reflect the change. All three actions throw
on an unknown id (surfaced as `{ ok:false, error }`). Output: `{ ok:true, action, id, upstream:{…} }`
for enable/disable, or `{ ok:true, action, id, removed:true }` for remove.

```jsonc
toolfunnel_run_tool({ name: "tf_mcp_set", args: { id: "example", action: "disable" } })
```

### `tf_hook_add` — add a hook (e.g. a `PreToolUse` gate)

Registers a hook in `hooks/hooks.manifest.json` and, optionally, writes its inline script under
`hooks/scripts/` (path-guarded). The manifest row is registered first; if the inline write fails the
row is **rolled back** so a failed add leaves no orphan entry.

| Arg | Type | Meaning |
|---|---|---|
| `id` | string (required) | Format `"<kebab-event>/<name>"`, e.g. `"pre-tool-use/gate-danger"`. |
| `event` | string (required) | One of the six lifecycle events; `PreToolUse` is the enforcement gate. |
| `matcher` | string | Regex (full-match, anchored) against `tool_name`. `""`/`"*"` = always fire. |
| `command` | string (required) | What the runner spawns. Use the portable `${HOOKS_DIR}` token, e.g. `node "${HOOKS_DIR}/scripts/gate.js"`. |
| `script` | string | Path (relative to `hooks/`) used by the manager's open/edit. |
| `timeout` | number | Seconds (default 60). |
| `enabled` | boolean (default **`true`**) | The manifest seed; live toggles live in `hooks.state.json`. |
| `description` | string | Human-facing note. |
| `scriptText` | string | If given, the script body is authored under `hooks/scripts/`. |

Output: `{ ok:true, id, hook:{…}, scriptWritten:bool }`, or `{ ok:false, error }`.

> **Match the display name.** The `tool_name` a `PreToolUse` matcher sees for a first-party tool is
> the register **display name** (it equals the id for management functions). Spaces are literal:
> gate the `danger` demo (name `"Danger Demo"`) with `matcher: "Danger Demo"`, not `"danger"`.

```jsonc
// Gate the danger demo unless { confirm: true } is passed:
toolfunnel_run_tool({
  name: "tf_hook_add",
  args: {
    id: "pre-tool-use/gate-danger",
    event: "PreToolUse",
    matcher: "Danger Demo",
    command: "node \"${HOOKS_DIR}/scripts/gate-danger.js\"",
    script: "scripts/gate-danger.js",
    timeout: 5,
    description: "Deny Danger Demo unless args.confirm === true.",
    scriptText: "#!/usr/bin/env node\nlet r='';process.stdin.on('data',c=>r+=c);process.stdin.on('end',()=>{let e={};try{e=JSON.parse(r||'{}')}catch(_){process.exit(2)}if(e.tool_input&&e.tool_input.confirm===true)process.exit(0);process.stderr.write('confirm required');process.exit(2)});\n"
  }
})
```

### `tf_hook_set` — enable / disable / remove a hook

| Arg | Type | Meaning |
|---|---|---|
| `id` | string (required) | The hook id. |
| `action` | `"enable"` \| `"disable"` \| `"remove"` (required) | `enable`/`disable` write the `hooks.state.json` overlay (which **wins** over the manifest seed) and mirror the manifest; `remove` deletes the manifest entry and purges the overlay key (the script file is left in place). |

Output: `{ ok:true, id, action, enabled }` for enable/disable, or `{ ok:true, id, action, removed }`
for remove (`removed` is `false` if the id was already absent — information, not a fault).

```jsonc
toolfunnel_run_tool({ name: "tf_hook_set", args: { id: "pre-tool-use/gate-danger", action: "disable" } })
```

### `tf_list` — inventory (read-only)

The one read function: "what is configured, and what is its live state?" across the three stores.

| Arg | Type | Meaning |
|---|---|---|
| `kind` | `"tools"` \| `"mcps"` \| `"hooks"` (required) | Which store to enumerate. |

- `tools` → register briefs `{ id, name, summary, category }` annotated with `{ enabled, hidden }`.
- `mcps` → one item per upstream (its full config incl. `enabled`) with its curated-direct
  `exposed` entries nested (each carrying its resolved downstream `name` and `enabled`).
- `hooks` → one item per manifest hook (full spec) with `enabled` resolved from the live overlay.

Output: `{ ok:true, kind, items:[…] }`. No writes, no network, no process mutation.

```jsonc
toolfunnel_run_tool({ name: "tf_list", args: { kind: "hooks" } })
```

### `tf_log` — the activity / audit log

Toggles ToolFunnel's JSONL audit log (tool runs + gate allow/deny decisions). **Default OFF.**

| Arg | Type | Meaning |
|---|---|---|
| `action` | `"enable"` \| `"disable"` \| `"status"` (required) | Turn logging on/off, or report current state. |
| `path` | string | Optional log path, honoured only on `enable`. |

Output: `{ ok:true, action, enabled, path }` for enable/disable, or
`{ ok:true, action, enabled, path, count }` for status (`count` = recent log entries). The same
log is controllable from the UI **Logs** tab and via `logs/log.config.json`.

```jsonc
toolfunnel_run_tool({ name: "tf_log", args: { action: "enable" } })
toolfunnel_run_tool({ name: "tf_log", args: { action: "status" } })
```

---

## Management runs gated — the recursive-safety story

The management functions are not privileged. They are gateway-run tools, so every call funnels
through the **same `gatedRun` `PreToolUse` gate** as `danger` or any curated upstream tool
(`src/mcp/gated-run.js`). That means **a `PreToolUse` hook can restrict or deny a management call**,
and the gateway can govern the tools that govern *it*.

**Default is allow.** The shipped `hooks/hooks.manifest.json` has an empty `hooks` array, which is
allow-all — no hook fires, so management functions run unrestricted out of the box. Safety here is
**opt-in**: you add an enabled `PreToolUse` hook whose matcher matches the management tool name(s).
Because the `tool_name` the gate sees is the register name (which equals the id for these
functions), the matcher is the bare id or an alternation of ids — for example `tf_.*` to cover the
whole family, or `tf_hook_set|tf_log` to guard just the two that could blind the gateway:

```jsonc
// Add a gate over the riskiest management functions: require { confirm: true }.
toolfunnel_run_tool({
  name: "tf_hook_add",
  args: {
    id: "pre-tool-use/gate-management",
    event: "PreToolUse",
    matcher: "tf_hook_set|tf_hook_add|tf_log|tf_tool_set",
    command: "node \"${HOOKS_DIR}/scripts/gate-management.js\"",
    script: "scripts/gate-management.js",
    description: "Require confirm:true before changing hooks/logging/tools.",
    scriptText: "#!/usr/bin/env node\nlet r='';process.stdin.on('data',c=>r+=c);process.stdin.on('end',()=>{let e={};try{e=JSON.parse(r||'{}')}catch(_){process.exit(2)}const a=e.tool_input&&e.tool_input.args;if(a&&a.confirm===true)process.exit(0);process.stderr.write('management change requires args.confirm:true');process.exit(2)});\n"
  }
})
```

Why this matters:

- **The gate is uniform and unbypassable.** There is no back door that runs a management function
  outside `gatedRun`, so a deny on `tf_*` is as enforced as a deny on any other tool.
- **`tf_log` and the hook functions can themselves be gated.** As the `tf_log` instructions note,
  "like any tool, `tf_log` can itself be disabled to revoke logging control." Gating `tf_hook_set`
  / `tf_hook_add` likewise prevents an agent from quietly disabling the very gate that constrains
  it. This is the recursive-safety property: the controls *and* the controls-on-the-controls live
  in the same gated surface.
- **Fail closed still holds.** If the gating hook errors or returns junk, the `PreToolUse` is
  treated as a deny — a gate you can't trust to answer "allowed?" is never read as "allowed". A
  management change can never slip through on a broken hook.

One bootstrapping caveat to keep in mind: if you gate `tf_hook_set` behind a confirmation you can no
longer toggle hooks *without* satisfying that confirmation — including the gate you just added. Keep
the admin UI (`node bin/toolfunnel.js --ui`) or a direct manifest edit as your out-of-band escape
hatch when you lock the hook functions down.

---

## Execution modes: reference vs gateway-run

Every register entry resolves to one of two **execution modes** (`src/tools/registry.js`,
`resolveMode`). The mode decides *where the work happens* when `toolfunnel_run_tool` is called.

### `gateway-run` — ToolFunnel executes it, server-side, behind the gate

`mode: "gateway"`. ToolFunnel runs the tool's `invoke` itself: a `script` invoke spawns `node` on
the host-local script; a `shell` invoke is handed to the gated runner which spawns the shell **only
after `PreToolUse` allows**. The result comes back in the run envelope's `output`. This is the
original behaviour and the mode of **every shipped tool**, including all eight management functions.

Use gateway-run when:

- the action must run **on the host where ToolFunnel lives** (its filesystem, its config, its
  credentials) — the management functions are the canonical case;
- you want the call **centrally gated, logged, and audited** through `gatedRun`;
- the work is a deterministic host-local script or one-line command.

### `reference` — ToolFunnel only *describes* it; the AI runs it

`mode: "reference"`. ToolFunnel executes **nothing**. `toolfunnel_run_tool` short-circuits **before**
the gate and returns the tool's instructions so the **connected AI performs the action in its own
environment**:

```jsonc
{
  "ok": true,
  "mode": "reference",
  "name": "deploy-notes",
  "instructions": "<the entry's instructions string>",
  "message": "reference tool — perform this in your own environment per the instructions"
}
```

Because nothing runs server-side, **no `PreToolUse` hook fires for a reference tool** — there is no
host-side side effect to gate; governance of the action is the AI's own environment's responsibility.
A reference entry needs no `invoke` (there is nothing to execute), so it may omit it.

Use reference when:

- the AI is better placed to act — it has the right filesystem, tokens, or working directory;
- you only want to hand the model **authoritative instructions** rather than run code centrally;
- you explicitly do **not** want ToolFunnel to execute the action on the host.

### The backward-compatible default (how the mode is inferred)

An explicit, valid `mode` field always wins. When `mode` is **absent**, it is inferred so that every
pre-existing tool keeps its original behaviour:

| Entry | Inferred mode |
|---|---|
| `invoke.type === "script"` | `gateway` |
| `invoke.type === "shell"` | `gateway` |
| no executable invoke (and `mode` absent) | `reference` |

Validation backs this up: with `mode` **absent** an `invoke` is still **required** (so an existing
tool without a mode can never silently become a do-nothing reference). Only an **explicit**
`mode: "reference"` relaxes the invoke requirement. An invalid `mode` value is rejected at load.

### Setting a tool's mode

- **New tools via `tf_tool_add`** always supply an `invoke`, so they come out **gateway-run** (the
  inferred default). `tf_tool_add` does not take a `mode` argument.
- **To switch a tool to `reference` (or back)**, use the admin UI's per-tool mode control
  (`POST /api/tools/mode {id, mode}` → `registry.update(id,{mode})`), or edit the register entry's
  `mode` field directly. Switching a tool that *has* an `invoke` to `reference` simply stops
  ToolFunnel from executing it — the `invoke` is ignored while the mode is `reference`.

---

## Quick reference

```text
Discover:   toolfunnel_list_tools({ category: "management" })
Learn args: toolfunnel_tool_instructions({ name: "tf_hook_add" })
Invoke:     toolfunnel_run_tool({ name: "<tf_*>", args: { … } })
Read back:  parse output.stdout (the script's own { ok, … } JSON)
Gate them:  a PreToolUse hook matching "tf_.*" (default = allow-all)
Modes:      gateway-run = ToolFunnel executes (gated) · reference = AI executes (no gate)
```
