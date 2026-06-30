# Configuration reference

ToolFunnel is driven entirely by plain JSON files on disk — no database, no environment-variable
configuration of the surface. Everything the gateway exposes, curates, and gates is read from a
handful of config files. This document is the authoritative, field-by-field reference; it is
derived from the loaders that actually read each file (`src/tools/registry.js`,
`src/tools/tool-state.js`, `src/mcp/expose-store.js`, `src/core/hook-loader.js`), not from intent.

## The clean split: `src/` is the engine, the top level is yours

ToolFunnel keeps a deliberate separation between **the engine** and **your configuration**:

- **`src/`** is ToolFunnel's own engine code. You never edit it. It holds the server, the protocol,
  the transports, the aggregator, the hook engine, and the tool *system* (`src/tools/registry.js`,
  `src/tools/tool-state.js`, `src/tools/drift.js`). These modules *read* your config — they are not
  your config.
- **`tools/`, `mcp/`, and `hooks/`** at the repo root are **your** stuff — plain JSON plus the
  scripts they reference. This is the only place you author anything:

| Directory | What you put there | Read by (engine) |
|---|---|---|
| `tools/` | `tools.register.json`, `tools.state.json`, `scripts/*.js` — your first-party tools | `src/tools/registry.js`, `src/tools/tool-state.js` |
| `mcp/`   | `expose.json` — your upstream MCP servers + the curated tools drawn from them | `src/mcp/expose-store.js` |
| `hooks/` | `hooks.manifest.json`, `hooks.state.json`, `scripts/*` — your policy gate | `src/core/hook-loader.js` |

Rule of thumb: if you are editing something under `src/`, stop — that is the machinery. Your
register, your upstreams, and your gate all live at the top level.

## The files at a glance

| File | Loader | Purpose |
|---|---|---|
| `tools/tools.register.json` | `src/tools/registry.js` | The tool register — every first-party tool's metadata + how to invoke it. |
| `tools/tools.state.json` | `src/tools/tool-state.js` | Per-tool enable/disable + hidden overlay over the register. |
| `mcp/expose.json` | `src/mcp/expose-store.js` | Upstream MCP connections + the curated-direct tools drawn from them. |
| `hooks/hooks.manifest.json` | `src/core/hook-loader.js` | The hook manifest — the gate. Each entry is one lifecycle hook. |
| `hooks/hooks.state.json` | `src/core/hook-loader.js` | Per-hook enabled overlay over the manifest (sibling of the manifest). |
| `logs/log.config.json` | `src/core/logger.js` | Toggle + path for the optional JSONL audit log (tool runs + gate allow/deny decisions). **Default OFF**; the file is not created until logging is enabled (via the `tf_log` management function or the admin UI Logs tab). Full reference: [`logging.md`](logging.md). |
| `auth/auth.config.json` | `src/auth/config.js` | Toggle + settings for the optional **OAuth 2.1 resource-server** validation. **Default OFF** (loopback-only, unauthenticated). When enabled, the HTTP transport validates a bearer token on every request. Full reference: [`oauth.md`](oauth.md). |

> **All paths resolve under the repo root.** The server (`src/mcp/server.js`) anchors
> `ROOT = <repo>` from its own location (`path.resolve(__dirname, '..', '..')`) and joins every
> config path off it: `tools/tools.register.json`, `tools/tools.state.json`,
> `hooks/hooks.manifest.json`, `mcp/expose.json`, and the tool scripts root `tools/scripts`.
> Nothing is read from outside the tree, and script/command targets are path-guarded to stay
> inside it (the isolation rule).

## Conventions shared by every file

- **JSON only**, parsed once at load. A malformed register, expose store, or manifest throws a
  clear error at load time — misconfiguration is caught at startup, not at model-call time. The
  two overlay files (`tools.state.json`, `hooks.state.json`) are the exception: a
  missing/unreadable/malformed overlay degrades to "no overrides" and never throws.
- **Atomic writes.** Every write goes to a temp file in the same directory, is fsync'd, then
  renamed over the target. A crash leaves either the old file or the new file, never a
  half-written config. Prefer the loader's write methods over hand-editing a live file.
- **No restart for register/state edits.** The server reads `tools.register.json` and
  `tools.state.json` fresh on every `toolfunnel_list_tools` call, so a tool added or toggled is
  visible with no reconnect. (Curated-direct tools from `expose.json` are the exception — see that
  section.)

---

## `tools/tools.register.json` — the tool register

Top-level shape:

```json
{
  "version": 1,
  "description": "Tool register for the gateway — built-in demo scripts.",
  "tools": [ /* entries */ ]
}
```

- `version` — number (defaults to `1` if absent). Schema version of the register.
- `description` — string (defaults to `""`). Free-text label, preserved across writes.
- `tools` — array of entries (defaults to `[]`).

### Entry shape

```json
{
  "id": "echo",
  "name": "Echo",
  "summary": "Return the provided arguments back unchanged.",
  "category": "demo",
  "instructions": "Echoes its structured args back in the result. Pass any JSON value as args and the same value is returned.",
  "invoke": { "type": "script", "path": "scripts/echo.js" }
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | **yes** | Stable unique key. `toolfunnel_run_tool({ name })` / `toolfunnel_tool_instructions({ name })` look up by this (id **or** display name). Duplicate ids are rejected **at load**. |
| `name` | string | **yes** | Display name shown in `toolfunnel_list_tools` briefs and the manager UI. |
| `summary` | string | no (→ `""`) | One line. This is *all* a brief carries for the tool — keep it tight so the model can pick from the brief alone. |
| `category` | string | no (→ `""`) | Grouping label (`demo`, `crypto`, `data`, …). `toolfunnel_list_tools({ category })` filters on an exact match. |
| `instructions` | string | no (→ `""`) | Full usage doc returned by `toolfunnel_tool_instructions`. The long-tail payload — be complete here, terse in `summary`. |
| `mode` | string | no (→ inferred) | Execution mode — `gateway` or `reference`. See below. |
| `invoke` | object | **yes** (unless `mode: "reference"`) | How the tool runs. Two forms below. |

Validation (from `registry.js::validateEntry`): `id` and `name` must be non-empty strings, and
`mode`, if present, must be `reference` or `gateway`. `invoke` must be present with `invoke.type`
one of `script` | `shell` — **except** an explicit `mode: "reference"` may omit `invoke` entirely
(a reference tool runs nothing server-side, so there is nothing to invoke). `summary`, `category`,
and `instructions` are optional and default to empty strings.

### `mode` — gateway vs reference execution

The optional `mode` field decides **who runs the tool** (from `registry.js::resolveMode` /
`VALID_MODES`):

- **`gateway`** — ToolFunnel executes the `invoke` **server-side**, through the gated run path
  (PreToolUse → execute → PostToolUse). This is the original behaviour of every `script`/`shell`
  tool.
- **`reference`** — ToolFunnel executes **nothing**. `toolfunnel_run_tool` returns the tool's
  `instructions` so the **connected AI performs the action in its own environment**. A reference
  tool needs no `invoke`.

When `mode` is absent it is **inferred backward-compatibly**: a `script`/`shell` invoke ⇒
`gateway` (so every existing register entry keeps running exactly as before), anything else ⇒
`reference`. An explicit, valid `mode` always wins over the inference.

### `invoke` — two forms

**Script invoke (the implemented, tested path):**

```json
{ "type": "script", "path": "scripts/echo.js" }
```

- `path` points at a file under **`tools/scripts/`**. The runner takes `path.basename(path)` and
  resolves it under the scripts root (`tools/scripts`), then refuses any result that escapes that
  directory (defense-in-depth path guard). A `script` invoke needs a non-empty `path` or load
  fails. In practice `path` is always written as `scripts/<id>.js`.
- At run, the gateway spawns `node <resolved script>` with the structured args delivered in the
  environment variable `TOOLFUNNEL_TOOL_ARGS` (JSON-encoded; `null` if no args). The script prints
  exactly **one JSON line** to stdout and exits `0`. A non-zero exit is surfaced as the tool's
  failure (the runner never rejects on exit code — only on a spawn failure).

**Shell invoke:**

```json
{ "type": "shell", "command": "node tools/scripts/echo-upper.js" }
```

- A `shell` invoke needs a non-empty `command` or load fails.
- `registry.js` deliberately does **not** spawn a shell. `resolveExecution` returns a deferred
  descriptor (`{ deferred:true, type:"shell", command, args }`) and hands it to the gated runner,
  which owns the actual shell spawn — so arbitrary shell execution stays behind the PreToolUse gate
  and out of the un-gated register module.
- When the gate allows it, the server runs the `command` **verbatim through the OS shell**
  (`spawnSync(command, { shell:true })`) with **`cwd` set to the repo root** and
  `TOOLFUNNEL_TOOL_ARGS` (the JSON args) injected into the environment. There is **no token
  substitution** — the string is passed to the shell as written, so a relative path such as
  `tools/scripts/echo-upper.js` resolves against the repo root. Prefer `script` for anything
  reusable; reach for `shell` only for thin one-liners.

> **Isolation rule.** An `invoke` must only reference scripts/commands that live **inside the
> gateway's own tree** (`tools/scripts/`). Never point `invoke` at a tool living outside it — copy
> the logic into `tools/scripts/` first, then point at the clone. The script path-guard enforces
> this for `script` invokes; for `shell` you are responsible for keeping the command inside the
> tree.

### Live example (the shipped register)

The default register ships **seven** demo `script` tools — `echo`, `base64`, `hash`, `uuid`,
`json`, `text-stats`, `danger` — each
`{ "type": "script", "path": "scripts/<id>.js" }`, with the matching file in `tools/scripts/`.

---

## `tools/tools.state.json` — the enable/disable + hidden overlay

A small overlay keyed by tool `id`. The register (`tools.register.json`) holds **all** tools; this
file decides which are surfaced to clients and which are decluttered from the manager list. The
shipped default is just `{}` (no overrides — everything on, nothing hidden).

```json
{
  "danger":     { "enabled": false },
  "text-stats": { "hidden": true }
}
```

| Per-id field | Default | Axis | Effect |
|---|---|---|---|
| `enabled` | **ON** | MCP visibility | A tool is active unless the overlay explicitly says `enabled: false`. Disabled tools are filtered out of `toolfunnel_list_tools` so the client never sees them. |
| `hidden` | not hidden | manager-list only | `hidden: true` declutters the tool from the **manager** listing only. It is **never** consulted by the MCP server and does not change the client's view. |

Key behaviours (from `tool-state.js`):

- **Default ON.** A tool absent from the overlay — or present without `enabled: false` — is active.
  Newly-added register tools are live until you untick them, and the file only ever lists the tools
  you have toggled.
- **The two axes are independent.** A tool can be active-but-hidden or disabled-but-visible.
  `enabled` controls what the client sees; `hidden` only declutters the manager view.
- **Toggles merge.** `setToolEnabled` / `setToolHidden` merge into the existing entry, so flipping
  one flag preserves the other, then persist atomically.
- **Tolerant load.** A missing or malformed file loads as `{}` (no overrides) and never throws.
- **Read fresh.** The server re-reads this overlay on every `toolfunnel_list_tools` call, so UI
  toggles take effect with no restart.

---

## `mcp/expose.json` — upstream MCPs + curated-direct selection

Two blocks: the upstream MCP servers to connect to, and which of their tools to surface downstream
as *curated-direct* tools. The shipped default is empty
(`{ "version": 1, "upstreams": [], "expose": [] }`), so the gateway connects to nothing and the
curated-direct surface is empty until you author entries. An annotated sample lives alongside it at
`mcp/expose.example.json`.

```json
{
  "version": 1,
  "upstreams": [
    {
      "id": "mock",
      "transport": "stdio",
      "command": "node",
      "args": ["mcp/servers/mock-upstream/server.js"],
      "env": {},
      "enabled": true,
      "description": "Bundled demo upstream MCP (zero-dependency stdio): ping, add, echo."
    }
  ],
  "expose": [
    {
      "upstream": "mock",
      "tool": "ping",
      "as": "mock_ping",
      "category": "demo",
      "enabled": true
    }
  ]
}
```

> The demo upstream that ships with ToolFunnel lives at `mcp/servers/mock-upstream/server.js` and
> offers `ping`, `add`, and `echo`. A ready-to-copy version of the sample above is at
> `mcp/expose.example.json`.

### `upstreams[]` — one entry per upstream MCP

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | — (required) | Stable unique key, referenced by `expose[].upstream`. Duplicate ids are rejected at load. |
| `transport` | string | `"stdio"` | How the aggregator connects. `"stdio"` (spawn `command` + `args`) is the only valid transport today. |
| `command` | string | `""` | The process to spawn for a `stdio` upstream. **Required and non-empty** for `stdio`. The interpreter slot (`node`, `python`, …) is not path-guarded; the `args` path is. |
| `args` | string[] | `[]` | Command arguments. A script path here must resolve **inside the gateway root** (the aggregator's isolation guard rejects an arg path that escapes the tree — a relative path like `mcp/servers/mock-upstream/server.js` is resolved against the repo root and stays inside it). |
| `env` | object | `{}` | Extra environment for the spawned upstream. |
| `enabled` | boolean | `true` | Whether the aggregator connects to this upstream at startup. |
| `description` | string | `""` | Human-facing note for the MCP Manager UI. |

### `expose[]` — which upstream tools become curated-direct

| Field | Type | Default | Meaning |
|---|---|---|---|
| `upstream` | string | — (required) | Must match an existing `upstreams[].id`. Referential integrity is enforced on write — you cannot expose a tool from an unknown upstream (`addExpose` throws). |
| `tool` | string | — (required) | The upstream tool's own name, as its `tools/list` reports it. |
| `as` | string | `<upstream>_<tool>` | The downstream name the client sees — the **rename**. Optional; defaults to the namespaced `<upstream>_<tool>` so two upstreams can't collide. On write the default is materialised into the stored entry, so the saved entry is self-describing. |
| `category` | string | `""` | Grouping label, same convention as register entries. |
| `enabled` | boolean | `true` | Whether the tool is actually exposed downstream right now. |

Key behaviours (from `expose-store.js`):

- **Natural key.** `(upstream, tool)` is the key; duplicate pairs are rejected at load.
- **Cascade delete.** Removing an upstream also removes every `expose[]` entry that references it,
  so no expose entry can dangle against a missing upstream.
- **Lenient missing file.** A missing `expose.json` loads as an empty store bound to the path; the
  file is **not created until the first write** (the server starts clean with no live upstreams). A
  malformed file, a duplicate upstream id, or a duplicate expose key throws at load.
- **Reconnect cost.** Unlike register tools, curated-direct tools are negotiated with the client at
  connect time — changing the exposed set needs a reconnect (or a `tools/list_changed`
  notification if the host honours it). Register tools reached via the meta-tools are always live.

---

## `hooks/hooks.manifest.json` — the hook manifest (the gate)

Every tool execution funnels through the hook engine: a `PreToolUse` hook can block a call before
it runs (fails closed), and a `PostToolUse` hook observes the result (advisory — it cannot un-run
the tool). The manifest is the list of those hooks. The shipped default is
`{ "version": 1, "hooks": [] }` — **an empty `hooks` array is allow-all** (no gate fires).

Top-level shape:

```json
{
  "version": 1,
  "hooksDir": "optional absolute override",
  "hooks": [ /* entries */ ]
}
```

- `version` — manifest schema version.
- `hooksDir` — optional. The absolute hooks directory. If omitted (the normal case) it is resolved
  from the manifest's own location — the manifest sits inside `hooks/`, so **that directory is the
  source of truth** and `${HOOKS_DIR}` expands to the absolute path of `hooks/`.
- `hooks` — array of hook entries.

### Hook entry shape

```json
{
  "id": "pre-tool-use/deny-dangerous",
  "event": "PreToolUse",
  "matcher": "Bash|toolfunnel_run_tool",
  "type": "command",
  "command": "bash \"${HOOKS_DIR}/scripts/deny-dangerous.sh\"",
  "script": "scripts/deny-dangerous.sh",
  "timeout": 5,
  "enabled": true,
  "description": "Denies any tool call whose args contain a destructive pattern."
}
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Unique key, convention `"<kebab-event>/<script-basename>"`. The loader and `hooks.state.json` key on this. |
| `event` | string | One of the six lifecycle events (see below). |
| `matcher` | string | Regex, anchored as a **full match** against `tool_name` (wrapped `^(?:…)$`). `""`, `undefined`, or `"*"` = always fire. Tool-less events ignore it. A malformed regex fails closed (never matches), never throws. Example: `"Bash\|Write\|Edit"`. |
| `type` | string | `"command"` — the only type today. |
| `command` | string | The command line the runner spawns (with `shell: true`). `${HOOKS_DIR}` expands to the absolute `hooks/` path **at load time**. The event payload is written to the command's **stdin** as JSON. |
| `script` | string | The script path relative to `hooksDir` (e.g. `scripts/deny-dangerous.sh`). Used by the manager's open/edit; `writeScript` refuses any path that resolves outside `hooks/scripts/`. Inline-command hooks (no `script`) are allowed — there is just no file to edit. |
| `timeout` | number | **Seconds** (the runner multiplies by 1000). Defaults to **60s** if absent or non-positive. The child is killed past this. |
| `enabled` | boolean | The manifest's **seed** state. The live value is the overlay in `hooks.state.json` — see below. Normalised to a strict boolean at load (an omitted `enabled` is `false`). |
| `description` | string | What the hook does, for the manager UI. |

One entry **per hook command** — a single settings-style event with N commands becomes N entries.

### The six lifecycle events

`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `PreCompact` (from
`src/core/events.js`). `PreToolUse` is the only event that can block a tool *before* it runs. The
matcher applies to the tool-bearing events (`PreToolUse` / `PostToolUse`) and is ignored for the
tool-less ones (`SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`), which always fire.

### How a hook blocks (the two protocols)

The runner (`src/core/hook-runner.js`) spawns the command, pipes the event JSON to stdin, then
reads the result:

- **Exit-code protocol:** `exit 2` blocks; **stderr is the reason**. `exit 0` succeeds (for
  `SessionStart` / `UserPromptSubmit`, stdout becomes injected context; otherwise advisory). Any
  other non-zero code is a non-blocking error.
- **JSON protocol** (honoured only on `exit 0`, when stdout parses as a JSON object): a `PreToolUse`
  hook blocks via `hookSpecificOutput.permissionDecision: "deny"` (`"allow"` passes; `"ask"` is
  non-blocking in the autonomous host). The other blockable events block via top-level
  `decision: "block"`. `continue: false` stops the whole loop;
  `hookSpecificOutput.additionalContext` is injected text.

### Activation overlay — `hooks/hooks.state.json`

What *exists* (the `hooks/scripts/` folder + manifest config) is split from what's *on*. The live
enabled/disabled value lives in a sibling overlay keyed by hook `id`, and **the overlay wins over
the manifest's seed `enabled`** at load.

`setEnabled(id, bool)` writes the overlay atomically as a flat map:

```json
{
  "pre-tool-use/deny-dangerous": true,
  "user-prompt-submit/inject-context": false
}
```

The loader also tolerates a wrapped form on read (forward-compatibility):

```json
{ "version": 1, "enabled": { "pre-tool-use/deny-dangerous": true } }
```

Both read the same way; the flat map is what `setEnabled` writes. The overlay is kept separate from
the auto-detected inventory, so re-scanning `hooks/scripts/` never clobbers your toggles, and
toggles survive restarts. (`setEnabled` also mirrors the flag back into the manifest — re-collapsing
`${HOOKS_DIR}` so the on-disk manifest stays portable — but the overlay is the authoritative,
precedence-winning store.)

---

## Path resolution summary

Every config and execution target resolves under the repo root. The server anchors the top-level
config paths; the hook loader anchors the hooks paths to the manifest's own directory.

| Anchor | Path |
|---|---|
| Tool register | `<repo>/tools/tools.register.json` |
| Tool state overlay | `<repo>/tools/tools.state.json` |
| Tool scripts root | `<repo>/tools/scripts/` |
| Expose store | `<repo>/mcp/expose.json` |
| Hook manifest | `<repo>/hooks/hooks.manifest.json` |
| Hook state overlay | `<repo>/hooks/hooks.state.json` |
| Hook scripts root | `<repo>/hooks/scripts/` |
| Log config | `<repo>/logs/log.config.json` |

Script and command targets are additionally path-guarded to stay inside their respective
`scripts/` directories — a config entry can never become a path-escape out of the tree. Engine code
under `src/` reads all of the above; you never edit `src/` to configure the gateway.
