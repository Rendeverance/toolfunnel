# Extending ToolFunnel: tools and upstreams

How to grow the gateway's tool surface — by adding **first-party tools** you host
yourself, or by **curating tools from upstream MCP servers** — without adding a single
npm dependency and without losing the lean-register / execution-gate guarantees.

This is the long-form companion to the per-topic instructions the model can pull at
runtime via `toolfunnel_howto({ topic })`:

| Topic | Served file | Covers |
|---|---|---|
| `create-tool` | `src/extend/create-tool.md` | adding a first-party tool |
| `add-mcp` | `src/extend/add-mcp.md` | registering + curating an upstream MCP |
| `add-hook` | `src/extend/add-hook.md` | the PreToolUse / PostToolUse gate |
| `package` | `src/extend/package.md` | packaging a tool for distribution |

**Clean structure — engine vs. your data.** ToolFunnel keeps its OWN engine code under
`src/` (you never edit it) and your configuration/data at the top level (you edit it freely):

| You edit (top-level) | Engine code (under `src/`, read-only) |
|---|---|
| `tools/tools.register.json` — the tool register | `src/tools/registry.js` — loads/persists the register |
| `tools/tools.state.json` — enable/disable overlay | `src/tools/tool-state.js` — the overlay logic |
| `tools/scripts/*.js` — your first-party tool scripts | — |
| `mcp/expose.json` — upstream + curation config | `src/mcp/expose-store.js` — the config store |
| `hooks/hooks.manifest.json` — the gate | `src/mcp/aggregator.js` — live upstream + curated-expose |

The engine resolves all of these relative to the gateway root (`src/mcp/server.js` anchors
`ROOT = …/toolfunnel` and reads `tools/tools.register.json`, `tools/tools.state.json`,
`tools/scripts`, `mcp/expose.json`, `hooks/hooks.manifest.json`). Everything below was read
from the source — the field names, defaults, and guards are exactly what the code enforces.

---

## 1. Adding a first-party tool

A first-party tool is exactly **two things**:

1. **A script** under `tools/scripts/` that does the work.
2. **A register entry** in `tools/tools.register.json` that names it and points
   `invoke` at the script.

No MCP reconnect is needed (§1.6). Put the file in `tools/scripts/`, add the entry, and the
tool is reachable through the meta-tools — the advertised MCP surface never changes.

### 1.1 The script contract

The default executor (`src/tools/registry.js::defaultRunScript`) spawns `node`
(`process.execPath`) on your script with the structured args serialised into one
environment variable. It captures stdout/stderr and resolves
`{ ok: code === 0, code, stdout, stderr }`. It **never rejects on a non-zero exit** — only on
a genuine spawn failure (the child `error` event). Your script's job:

> **Read the structured args from `process.env.TOOLFUNNEL_TOOL_ARGS` (a JSON string),
> print exactly ONE JSON line to stdout, and `process.exit(0)`.**

Three rules make a well-behaved tool, all visible in the demo scripts in `tools/scripts/`:

1. **Args arrive as JSON in `TOOLFUNNEL_TOOL_ARGS`.** The runner sets it to
   `JSON.stringify(args ?? null)`. Parse it defensively — if it's absent treat it as
   `null`; if it won't parse, report that as an error result rather than throwing.
2. **Output is a single JSON object on stdout, newline-terminated.** The runner captures
   stdout verbatim; one clean JSON line is the whole result. By convention success is
   `{ ok: true, ... }` and a handled failure is `{ ok: false, error: "..." }`.
3. **Always `exit(0)`, even on bad input.** Surface bad input as `{ ok:false, error }` —
   do **not** throw and do **not** exit non-zero for ordinary user error. A non-zero exit
   / spawn failure is reserved for genuine crashes, which the runner reports back as
   `{ ok:false, code, stderr }`.

Other invariants the demos hold to (worth copying): node **built-ins only** (no npm), and
be **side-effect-honest** — `hash.js` and `text-stats.js` touch nothing but the CPU; the
one demo with a side effect, `danger.js`, writes only to the file named by its own env var
(`TOOLFUNNEL_DANGER_LOG`) and exists specifically to prove the gate can stop it.

Concrete skeleton, lifted from the structure of `hash.js` / `text-stats.js`:

```js
#!/usr/bin/env node
'use strict';

/** Parse the structured args handed in via env TOOLFUNNEL_TOOL_ARGS. */
function parseStructuredArgs() {
  const raw = process.env.TOOLFUNNEL_TOOL_ARGS;
  if (raw === undefined || raw === null || raw === '') return { value: null };
  try {
    return { value: JSON.parse(raw) };
  } catch (_err) {
    return { parseError: `TOOLFUNNEL_TOOL_ARGS was not valid JSON: ${String(raw)}` };
  }
}

/** Pure core: parsed args -> JSON-serialisable result. Never throws. */
function run(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'args must be an object { text }' };
  }
  const { text } = args;
  if (typeof text !== 'string') return { ok: false, error: 'text must be a string' };
  return { ok: true, upper: text.toUpperCase() };
}

function main() {
  const parsed = parseStructuredArgs();
  let payload;
  if (parsed.parseError) {
    payload = { ok: false, error: parsed.parseError };
  } else {
    try {
      payload = run(parsed.value);
    } catch (err) {
      payload = { ok: false, error: `unexpected error: ${(err && err.message) || String(err)}` };
    }
  }
  process.stdout.write(JSON.stringify(payload) + '\n'); // exactly one JSON line
  process.exit(0);
}

main();
```

### 1.2 Where the script goes

The engine code and your data live in different trees. The script goes with your data:

```
src/tools/
  registry.js            # ENGINE — loads/persists the register; list / instructions / resolveExecution
  tool-state.js          # ENGINE — the enable/disable overlay logic
tools/                   # YOUR data — edit freely
  tools.register.json    # the entries (§1.3)
  tools.state.json       # enable/disable overlay (§1.4)
  scripts/               # your tool scripts live HERE and NOWHERE else
    echo.js  hash.js  text-stats.js  …  echo-upper.js   <- new one
```

The scripts directory is a hard boundary. `defaultRunScript` resolves the target with
`path.resolve(scriptsRoot, path.basename(invoke.path))` (where `scriptsRoot` is
`tools/scripts`) and then re-checks that the result is still inside `scriptsRoot` — a
register entry **cannot** point `invoke.path` at a file outside `tools/scripts/`.
`path.basename` strips any directory traversal, and the relative-path check rejects anything
that still escapes. (This is the same defense-in-depth as the upstream isolation guard in
§2.3.) Practically: put the file in `tools/scripts/`, name `invoke.path` `"scripts/<file>"`,
done.

### 1.3 The register entry

Add one object to the `tools` array in `tools/tools.register.json` (whose top-level shape is
`{ version, description, tools: [] }`):

```json
{
  "id": "echo-upper",
  "name": "Echo Upper",
  "summary": "Uppercase the supplied text and echo it back.",
  "category": "text",
  "instructions": "Args: { text: string }. Returns { ok:true, upper } with the text uppercased, or { ok:false, error } on bad input. No side effects.",
  "invoke": { "type": "script", "path": "scripts/echo-upper.js" }
}
```

Fields are fixed — `registry.js` reads exactly these (`validateEntry` enforces the
required ones):

| Field | Type | Meaning |
|---|---|---|
| `id` | string (required, unique) | Stable kebab-case key. Loading rejects a duplicate `id`. This is what `toolfunnel_run_tool` and `toolfunnel_tool_instructions` look up by (the MCP adapter also accepts the display `name`). |
| `name` | string (required) | Display name shown in the manager UI. |
| `summary` | string | **The only thing `toolfunnel_list_tools` returns for this tool.** One tight, discriminating line — see §3 on why brevity here is the token win. |
| `category` | string | Grouping label (`demo`, `text`, `crypto`, `data`, …). `toolfunnel_list_tools({ category })` filters on it. |
| `instructions` | string | The full usage doc returned by `toolfunnel_tool_instructions({ id })`. Describe the args object, the result shape, and any caveats. This is the long-tail payload — be complete here, terse in `summary`. |
| `mode` | string (optional) | `gateway` (ToolFunnel runs the `invoke` server-side through the gate — the default for a `script`/`shell` invoke) or `reference` (ToolFunnel runs nothing; `toolfunnel_run_tool` returns the `instructions` for the connected AI to act on). Absent ⇒ inferred from `invoke`. See §1.7. |
| `invoke` | object (required unless `mode:"reference"`) | How the tool runs. `{ type:"script", path:"scripts/<file>" }` or `{ type:"shell", command:"…" }`. |

**Two `invoke` forms:**

- `{ "type": "script", "path": "scripts/x.js" }` — the common case. Runs the host-local
  script (§1.1/§1.2). The script is always run with `node`, so use `.js`.
- `{ "type": "shell", "command": "…" }` — a thin command line. Note that
  `registry.resolveExecution` does **not** spawn a shell itself; it returns a deferred
  descriptor `{ deferred:true, type:'shell', command, args }`. The server's execute thunk
  performs the actual shell spawn (`spawnSync` with `shell:true`, `cwd` = gateway root,
  `TOOLFUNNEL_TOOL_ARGS` in env) — and `gatedRun` only calls that thunk **after** the
  PreToolUse gate allows, so the broadest power (arbitrary shell) only ever executes behind
  the gate. Prefer `script` for anything reusable; reserve `shell` for one-liners.

**Write it atomically, don't hand-tear the file.** `registry.js` exposes
`add(entry)` / `update(id, patch)` / `remove(id)`, each of which validates and then
persists via `atomicWriteJson` (temp file in the same dir → fsync → rename). A crash leaves
either the old or the new register, never a half-written one. If you must edit the JSON by
hand, keep it valid — a malformed register throws at load time (by design: misconfig is
caught at startup, not at model-call time).

### 1.4 Enable/disable overlay

`tools/tools.state.json` is a **default-ON** enable/disable overlay (logic in
`src/tools/tool-state.js`). Its shape is `{ "<toolId>": { "enabled": false }, … }` — a tool
absent from the overlay is ACTIVE, and only an explicit `{ "enabled": false }` disables it,
so newly-added tools are live until you untick them and the file only lists the tools you've
toggled. `toolfunnel_list_tools` drops DISABLED tools from the briefs, so toggling a tool off
hides it from the model without deleting its register entry. (There is also an independent
`hidden` flag that declutters the manager UI only — it never affects what the client sees.)
Use the overlay to retire a tool temporarily; remove the register entry to retire it
permanently.

### 1.5 The tool runs gated — always

`toolfunnel_run_tool({ id, args })` never spawns your script directly. The call funnels
through `src/mcp/gated-run.js::gatedRun`, which:

1. fires **PreToolUse** with `{ tool_name, tool_input: args }` — if a hook **blocks**, the
   script is **never executed** (`execute()` is not called — the load-bearing, tested
   invariant) and the call returns `{ ok:false, blocked:true, reason, output:null }`.
   The gate **fails closed**: if the hook engine rejects or returns a non-object, PreToolUse
   is treated as a block.
2. runs your script only if allowed (a thrown execute is captured as
   `{ ok:false, blocked:false, error, output:null }`);
3. fires **PostToolUse** (advisory — it observes the outcome, even on the error path, but
   cannot un-run the tool or flip `ok`).

So adding a tool grants real power, but every invocation is mediated by the same gate as
every other tool. If your tool is dangerous, the correct control is a PreToolUse hook that
matches its name (`toolfunnel_howto({ topic: "add-hook" })`) — not omitting the tool.

### 1.6 Liveness — when changes take effect

- **No MCP reconnect for register changes.** The four meta-tools are a *fixed* advertised
  surface, so adding or removing a register entry never alters the tool list the client
  negotiated at connect — the new tool is reached through the same `toolfunnel_list_tools` /
  `toolfunnel_run_tool` meta-tools. (Contrast curated-direct upstream tools in §2.5, which
  ARE advertised individually and DO need a reconnect.)
- **Enable/disable toggles are instant.** The overlay (`tools/tools.state.json`) is re-read
  fresh on every `toolfunnel_list_tools` call, so ticking a tool on or off takes effect with
  no restart.
- **Register entries are loaded once per server start** and mutated atomically through the
  Registry `add`/`update`/`remove` API (the MCP Manager UI persists edits the same way). A
  brand-new entry written by hand to the JSON while the server is already running is picked
  up on the next start.

### 1.7 Execution mode — gateway vs reference

A first-party entry carries an optional `mode` (`src/tools/registry.js::resolveMode`) that decides
**who actually runs the tool**:

- **`gateway`** — ToolFunnel runs the `invoke` **itself**, server-side, through the gate (§1.5).
  This is the default for any `script`/`shell` invoke, and everything above describes a gateway
  tool.
- **`reference`** — ToolFunnel runs **nothing**. `toolfunnel_run_tool` returns the tool's
  `instructions` and the connected AI performs the action in **its own** environment. A reference
  tool needs no `invoke` — it is a gate-visible, documented pointer to something the model runs
  itself.

When `mode` is omitted it is **inferred backward-compatibly**: a `script`/`shell` invoke ⇒
`gateway`, anything else ⇒ `reference` — so every existing entry keeps its original behaviour.
Reach for `reference` to advertise a capability the model already has (or a host-side action you'd
rather it perform) without ToolFunnel executing it; keep the default `gateway` when ToolFunnel
should run and gate the work. See [`management.md`](management.md) for the full execution-mode
treatment.

### 1.8 Managing tools, MCPs, and hooks at runtime

You don't have to hand-edit JSON. Tools, upstream MCPs, and hooks can all be managed **at runtime**
two ways:

- **The `tf_*` management functions** — eight register tools (category `management`; full reference
  in [`management.md`](management.md)) reached through `toolfunnel_run_tool`: `tf_tool_add` /
  `tf_tool_set` (register, then enable / disable / remove a tool), `tf_mcp_add` / `tf_mcp_set` (add,
  toggle, or remove an upstream and its curated-direct exposures), `tf_hook_add` / `tf_hook_set`
  (add, toggle, or remove a gate hook), `tf_list` (read-only inventory of tools / mcps / hooks), and
  `tf_log` (toggle the JSONL audit log — see [`logging.md`](logging.md)). They write the same config
  files through the same atomic API as everything above, and — being ordinary tools — run through
  the **same PreToolUse gate**, so the management surface can itself be restricted (see
  [`hooks-and-gating.md`](hooks-and-gating.md#gating-the-management-functions-recursive-safety)).
- **The optional admin UI** ([`admin-ui.md`](admin-ui.md)) — `node bin/toolfunnel.js --ui` serves a
  local config web UI (`127.0.0.1:9777`) with Tools / MCPs / Hooks / Logs / Auth tabs for the same
  add / activate / deactivate / remove operations, plus the per-tool execution mode, per-tool
  Pre/Post hook toggles, and a per-tool Details / edit panel.

The liveness rules are unchanged: register and tool-state edits take effect with no reconnect
(§1.6), while curated-direct (`expose[]`) changes need a reconnect (§2.5).

---

## 2. Curating an upstream MCP

The second way to grow the surface is to **connect another MCP server** and selectively
re-expose some of its tools. The persisted config lives in one file, `mcp/expose.json`,
managed by `src/mcp/expose-store.js`; the live connections + curation are driven by
`src/mcp/aggregator.js`. A fully annotated working sample is in `mcp/expose.example.json`.
The default `mcp/expose.json` is **empty** (`{ "version":1, "upstreams":[], "expose":[] }`),
so the aggregator connects to nothing and the curated-direct surface is empty until you add
entries.

### 2.1 `expose.json` — two blocks

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
    { "upstream": "mock", "tool": "ping", "as": "mock_ping", "category": "demo", "enabled": true },
    { "upstream": "mock", "tool": "add",  "as": "mock_add",  "category": "demo", "enabled": true }
  ]
}
```

**`upstreams[]` — one entry per upstream MCP server:**

| Field | Type | Meaning |
|---|---|---|
| `id` | string (required, unique) | Stable key referenced by `expose[].upstream`. |
| `transport` | string | How to connect. `"stdio"` (spawn `command`+`args`) is the only baseline transport today. |
| `command` | string (required for stdio) | The interpreter/executable to spawn — `node`, `npx`, or an absolute path to a node binary. **Not** subject to the isolation guard (§2.3). |
| `args` | string[] | The argv. Any **path-shaped** token here (the server script, a db file, …) **must** resolve inside the gateway root — that's the isolation guard. |
| `env` | object | Extra environment for the spawned process. |
| `enabled` | boolean (default `true`) | Whether the aggregator connects to this upstream. |
| `description` | string | Human-facing note for the MCP Manager UI. |

**`expose[]` — which of the upstream's tools become curated-direct:**

| Field | Type | Meaning |
|---|---|---|
| `upstream` | string (required) | Must match an existing `upstreams[].id`. `addExpose` rejects an unknown upstream — add the upstream first. |
| `tool` | string (required) | The tool's **real** name as the upstream's `tools/list` reports it. `(upstream, tool)` is the natural key — unique. |
| `as` | string | The **downstream** name the agent + the gate see. Optional; defaults to `<upstream>_<tool>` (`exposedName()`), which namespaces it so two upstreams can't collide. `addExpose` stores the resolved name so the entry is self-describing. |
| `category` | string | Grouping label, same convention as register entries. |
| `enabled` | boolean (default `true`) | Whether this tool is actually surfaced right now. |

Like the register, the store validates on write and persists atomically; reads always
return clones and never throw (a missing `expose.json` is simply an empty store — the file
isn't created until the first write). Removing an upstream **cascade-removes** any `expose[]`
entries that referenced it, so you can never be left with a dangling exposure.

### 2.2 What the aggregator actually surfaces — and the `as` rename

`exposedToolDefinitions()` computes the curated-direct tool list the agent sees. An expose
entry surfaces **only if all three hold**:

1. the entry is `enabled: true`;
2. its upstream is **connected** (an enabled upstream, connected via `connectAll`); and
3. the connected upstream **actually advertises** a tool with that real `tool` name.

Anything that fails those is silently skipped — you can't expose a tool that isn't there.
For each surfaced entry the downstream definition is:

- **name** = the `as` name (e.g. `mock_ping`) — the renamed, namespaced name;
- **description** = `"[" + upstream + "] " + (upstream tool's description || "tool")`;
- **inputSchema** = the upstream tool's own `inputSchema` (or `{ type:"object" }`).

The rename is load-bearing in both directions. **Downstream** the agent calls the `as`
name; **upstream** the aggregator calls the tool's **real** name.
`resolveExposedExecution(name, args)` carries both: it returns an `execute()` thunk that
invokes the real upstream tool, plus `toolName` set to the **downstream `as` name** — so the
**PreToolUse gate matches on the downstream name** the agent used while execution hits the
real upstream tool. Curated-direct calls run through the **same `gatedRun`** path as
first-party tools (`server.js` threads the engine + ctx in) — the gate is uniform across
every execution path, by design and by test.

### 2.3 The isolation guard

This is the safety boundary that stops a curated upstream from reaching outside the gateway.
The default client factory (`aggregator.js::defaultClientFactory`) enforces it before
spawning anything:

> **Every `args` token that *looks like a path* must resolve inside the gateway root.**

- "Looks like a path" (`looksLikePath`) = an absolute path, **or** any token containing a
  path separator (`/` or `\`). A bare token like `npx`, `server`, or a flag like `--port`
  is **not** a path and is always allowed.
- "Inside the gateway root" (`isInside`) = resolves within the gateway root
  (`path.resolve(__dirname, '..', '..')` from `src/mcp/`, i.e. `…/toolfunnel`). A
  **relative** arg like `mcp/servers/mock-upstream/server.js` is resolved *against* the
  root, so it's judged at its in-sandbox location and passes. An absolute path elsewhere, or
  anything escaping via `..`, **fails**.
- The **`command` slot is deliberately NOT guarded.** It names the interpreter (`node`,
  `npx`, an absolute path to a system node binary) which by definition lives outside the
  project. Isolation is about **what code the spawned process runs** — that's the args (the
  server script + any data files it loads) — not which binary launches it. Guarding the
  command too would wrongly reject every vendored upstream the moment the system node ran it.

A violating arg throws an `isolation: …` error. `connectAll` never lets that sink the
server: the failure is collected into the returned `failed[]` (a dead or mis-scoped upstream
cannot crash startup, and never sinks the *other* upstreams). `discover()` — a direct user
action from the MCP Manager — does surface the error so the UI can show it, but still cleans
up so no zombie child is left.

**The practical rule:** vendor an upstream's server **inside the gateway tree** and point
`args` at the in-sandbox path. Never point `args` at a server configured elsewhere on the
host. If you want an external server's behaviour, clone it in first.

### 2.4 Steps to curate an upstream

1. Vendor the upstream server inside the gateway tree (so its script path stays in-sandbox).
2. Add an `upstreams[]` entry — unique `id`, `transport:"stdio"`, the `command`/`args`,
   `enabled:true`. (`addUpstream` validates and persists.)
3. Let the aggregator connect (`connectAll`) or hit **Discover** in the MCP Manager
   (`discover(id)` runs the upstream's `tools/list`) to see its real tool names + schemas.
4. For each tool you want hot, add an `expose[]` entry
   `{ upstream, tool, as?, category, enabled:true }`. Give it an `as` name if the default
   `<upstream>_<tool>` isn't what you want.
5. Leave the long tail **unexposed** — it stays connected but hidden, and is reachable later
   simply by adding another `expose` entry.

### 2.5 Update cost — curated-direct vs. the register

The two layers refresh differently, and this drives the curation decision:

- **Curated-direct tools** (what `expose[]` produces) are negotiated with the client **at
  connect time**, so changing the exposed set needs a **reconnect** (or a
  `notifications/tools/list_changed` if the client honours it — the server advertises
  `tools: { listChanged: true }`, but verify per host; restart is the safe baseline).
- **Register tools** (the `toolfunnel_list_tools` / `toolfunnel_run_tool` path) need **no
  reconnect** — they ride the fixed meta-tool surface (§1.6), so the advertised tool list
  never changes when you add or remove one.

Rule of thumb: expose a **handful of HOT, high-reliability tools** curated-direct; leave
everything else in the register, reached through the meta-tools.

---

## 3. Why lean? Briefs + schema-on-demand

The token-efficiency rationale is the whole reason both layers above are shaped the way they
are.

**The problem.** Vanilla MCP dumps **every** connected server's **full** tool schemas into
the model's context on **every** turn. Connect a few rich servers and you've burned
thousands of tokens describing tools the agent won't touch this turn — slower, costlier,
noisier, and it crowds out the context you actually want the model thinking about.

**The fix — a two-stage surface.** ToolFunnel advertises only a tiny fixed set of
**meta-tools** and keeps the real catalogue behind them:

1. `toolfunnel_list_tools({ filter?, category? })` returns **briefs only** —
   `{ id, name, summary, category }` per tool. That's the entire per-tool cost the model
   pays to *know a tool exists*. No `inputSchema`, no `instructions`. This is why §1.3 says
   keep `summary` tight and discriminating: it's the one line the model reads to decide
   whether to look closer. (`filter` is a case-insensitive substring over id/name/summary;
   `category` is an exact match.)
2. `toolfunnel_tool_instructions({ id })` fetches the **full** instructions for **one** tool,
   **on demand** — paid only when the model has decided it wants that specific tool.
3. `toolfunnel_run_tool({ id, args })` executes it (through the gate, §1.5).
4. `toolfunnel_howto({ topic })` serves the self-extension docs (the table at the top),
   loaded only when the model is actually extending the gateway.

So the cost model flips from *"N tools × full schema, every turn"* to *"N tools × one-line
brief, plus the full schema for the one or two tools actually used."* For a catalogue of any
real size that's an order-of-magnitude reduction in resident tool tokens.

**Curated-direct is the deliberate exception.** A small number of HOT tools (§2) *are*
surfaced with full schemas at connect time, so the model can call them in one hop with no
`list`/`instructions` round-trip. That's the dial: directly-exposed = the hot path you pay
full schema for; the register meta-tools = the long tail you pay one line for until needed.
Curate sparingly and the resident surface stays small while the full catalogue stays one
call away.

**And it all stays gated.** Lean exposure changes *what the model sees*, never *what's
allowed to run* — both the register run-path and the curated-direct path funnel through the
same `gatedRun` PreToolUse gate (§1.5, §2.2), which fails closed. Token savings never come
at the cost of the safety invariant.
