# Admin UI — the management console

ToolFunnel ships an **optional** local web console for viewing, searching, and configuring
everything the gateway exposes — first-party tools, upstream MCP connections, lifecycle hooks,
and the activity log — without hand-editing JSON. It is a convenience layer, not a dependency:
the gateway runs perfectly with the UI never started.

The console is built from vanilla HTML/CSS/JS served by a zero-dependency `node:http` server
(`src/ui/server.js`). There is nothing to `npm install`, no framework, no external fonts or
CDN — it works fully offline. The theme is dark and the whole app is a single page with five
tabs.

The most important thing to understand up front: **the UI is a front end over the same config
files the CLI and the management functions write.** It does not keep its own state. Every read
goes through the gateway's own stores and every write is atomic (temp file + rename) into the
same JSON the running server reads:

| Tab        | Reads / writes                          | Same store the CLI uses               |
|------------|-----------------------------------------|---------------------------------------|
| Tools      | `tools/tools.register.json`, `tools/tools.state.json` | `tf_tool_add` / `tf_tool_set`         |
| MCPs       | `mcp/expose.json`                       | `tf_mcp_add` / `tf_mcp_set`           |
| Hooks      | `hooks/hooks.manifest.json`, `hooks/hooks.state.json` | `tf_hook_add` / `tf_hook_set`         |
| Logs       | `logs/log.config.json` + the JSONL log  | `tf_log`                              |
| Auth       | `auth/auth.config.json`                 | `toolfunnel install-oauth` (install)  |

Because the running MCP server re-reads the register, state, and manifest on every call, a change
you make in the UI is **live immediately — no restart**. A UI edit is byte-identical to the same
edit made through `tf_tool_add`, `tf_mcp_add`, `tf_hook_add`, or `tf_log`. The reverse is also
true: anything you change via the CLI/management functions shows the next time the UI reads
(reload the page, switch tabs, or hit a tab's refresh). Each request reads fresh from disk.

---

## 1. Launching

Start the console from the repo root:

```bash
node bin/toolfunnel.js --ui
```

It binds **`127.0.0.1:9777`** and prints the URL to stderr:

```
[toolfunnel] config UI listening on http://127.0.0.1:9777
```

Open that URL in a browser on the same machine.

**Options:**

```bash
node bin/toolfunnel.js --ui --port 9000   # bind a specific port (0 = OS-assigned ephemeral)
node bin/toolfunnel.js --ui --host 127.0.0.1   # bind a specific loopback host
```

**Loopback only — by design.** The server binds `127.0.0.1` by default and, as defence in depth,
rejects any request whose `Host` header is not a recognised loopback name (`127.0.0.1`,
`localhost`, `::1`) — a DNS-rebinding guard. The console is meant for the trusted human operator
on the same machine, not remote access. (`--host` exists for advanced local setups, but the
loopback boundary is the intended one; leave it at the default unless you have a reason.)

**It runs in-process, with full authority.** Because it is loopback-only and operator-driven, the
UI talks to the stores directly rather than through the gated MCP path. That means the console can
do everything the (gated) management functions can — add/remove tools, switch execution modes,
wire hooks — so treat access to the port as administrative access to the gateway's configuration.

**Stopping it:** `Ctrl+C` (or `SIGTERM`) shuts it down cleanly. If the port is already in use the
process prints `failed to start config UI: …` and exits — rerun with a different `--port`.

**The header.** Across the top sits the brand and three live counts — **tools**, **mcps**,
**hooks** — that refresh after every successful change so you can see the effect of an edit at a
glance. Below that are the five tabs: **Tools** (open by default), **MCPs**, **Hooks**, **Logs**,
**Auth**. The Tools list loads on boot; the other tabs load the first time you open them.

Every action gives feedback: a short-lived **toast** at the bottom of the screen (green on
success, red on error) reports what happened, and destructive actions (Remove) ask for an inline
confirm first.

---

## 2. Tools tab

This is where you manage the first-party tool register.

### Search

The search box filters the list live (case-insensitive substring) across **name, summary,
category, id, and mode**. When a filter is active the count beside the box shows `shown/total`.
Clear the box to see everything again.

### Each tool row

A row shows the tool's **name**, its **category** chip, its **id**, and a one-line **summary**,
followed by a strip of controls:

- **Mode toggle** (small switch, labelled with the current mode). Off = **reference**, on =
  **gateway**. This is the per-tool execution mode (see below).
- **Pre / Post** (two small switches) — wire a `PreToolUse` / `PostToolUse` gate to this tool.
- **Enabled** (the larger switch) — turn the tool on or off in the surface. A disabled tool's row
  dims.
- **Details / edit** — expand an inline panel to view *and edit* everything about the tool (see
  below).
- **Remove** — delete the tool from the register (with a confirm).

#### Details / edit — view and change one tool

Click **Details / edit** on any row to expand a lazy inline panel (loaded on first open from
`GET /api/tools/detail?id=<id>`). It shows the tool's **full** entry — name, summary, category,
instructions, the resolved invoke, and, for a **script** invoke, the **script body** read from
`tools/scripts/`. The fields are editable: change the name, summary, category, instructions,
execution mode, or the script source, then **Save** to write the change via
`POST /api/tools/update`. The update **shallow-merges** your patch into the entry, re-validates it,
and persists `tools/tools.register.json` atomically; a script edit is authored back under
`tools/scripts/` (path-guarded) before the entry is saved. Because the running server reads fresh,
the edit is live with no restart. An invalid edit (e.g. switching to `gateway` with no invoke)
comes back as a red error toast and nothing is written.

#### The execution-mode toggle (reference vs gateway)

Every tool runs in one of two modes, and the switch flips between them live:

- **reference** — the gateway only *describes* the tool. When the AI asks to run it, ToolFunnel
  hands back the instructions and the AI executes it in its own environment.
- **gateway** — ToolFunnel *executes* the tool server-side itself, through the gated run path
  (which fires the Pre/Post hooks).

Flipping the switch writes the new mode immediately. One thing to know: switching a **reference**
tool that has *no invoke defined* over to **gateway** will fail — there is nothing for the gateway
to run — and you'll get a red error toast explaining it. Give the tool a script or shell invoke
first (re-add it, or edit the register / use the management tools), then switch.

#### The Pre / Post hook toggles

These wire a per-tool gate without touching the Hooks tab. Turning **Pre** on appends a
`PreToolUse` hook to `hooks/hooks.manifest.json` whose matcher matches *this tool's gate name
exactly*; **Post** does the same for `PostToolUse`. When you enable one, the toast reports the
**script path** you now need to create — for example:

```
hooks/scripts/<tool-id>-pretooluse.js
```

The gate is wired, but **until that script file exists it has nothing to run.** Author the script
at the reported path to define the behaviour (a `PreToolUse` script can block the call; a
`PostToolUse` script observes the result). Turning the toggle off removes the matching gate entry
again. These gates are what fire on every gateway-run and forwarded call.

(These same gates also appear on the Hooks tab, shown read-only — see below.)

### Adding a tool

Click **+ Add tool** to open the form. Fields:

| Field          | Notes                                                                 |
|----------------|-----------------------------------------------------------------------|
| **id** *       | Required, unique. The register key (e.g. `my_tool`).                  |
| **name** *     | Required. Display name.                                               |
| **category**   | Optional grouping label (shown as a chip).                           |
| **mode**       | `gateway — run here` (default) or `reference — AI runs it`.          |
| **summary**    | One-line description shown in the list.                              |
| **invoke type**| `script` / `shell` / `none` — *gateway mode only*.                   |
| **script path**| e.g. `scripts/my-tool.js` — *gateway + script only*.                 |
| **shell command** | e.g. `echo hello` — *gateway + shell only*.                       |
| **instructions** | How the connected AI should call this tool.                        |
| **script body**| Optional inline source, authored under `tools/scripts/` — *gateway + script only*. |

The form is mode-aware. Choose **reference** and the invoke fields disappear — a reference tool
needs no invoke, just its metadata and instructions. Choose **gateway** and the invoke type
selector appears: pick **script** to reveal the *script path* and *script body* fields, **shell**
to reveal the *shell command* field, or **none** for a gateway entry with no invoke yet.

A practical script tool, end to end:

1. mode = **gateway**, invoke type = **script**
2. **script path** = `scripts/my-tool.js`
3. paste the source into **script body** (it is written to `tools/scripts/my-tool.js` for you,
   before the tool is registered — the path is guarded to stay inside `tools/scripts/`)
4. fill **id**, **name**, a **summary**, and **instructions**
5. **Add tool**

`id` and `name` are required (and a script invoke requires a path, a shell invoke a command) — the
form blocks submission and toasts if one is missing. A duplicate `id` is rejected by the register
with a clear error. New tools land in the register and appear in the list straight away.

### Enable / disable and remove

The **Enabled** switch flips the tool's entry in `tools/tools.state.json` — a disabled tool stays
in the register but drops out of the live surface. **Remove** deletes it from the register and
clears its state-overlay key (so a future re-add of the same id starts clean); the inline confirm
guards against a misclick.

---

## 3. MCPs tab

This tab manages upstream MCP servers and the tools curated from them, stored in `mcp/expose.json`.

### Search

Filters the upstream list by **id, command, args, and description**, with the same `shown/total`
counter.

### Each upstream row

A row shows the upstream **id** (monospace), a **transport** badge (`stdio`), an
**enabled/disabled** badge, the resolved **command line** (command + args), an optional
**description**, and an **Exposed tools** block. Each exposed entry reads `tool → as` with an
optional category chip and an on/off badge; an upstream with none shows *"No exposed tools."*
Controls: an **Enabled** switch and a **Remove** button.

### Adding an upstream

Click **+ Add MCP**. Fields:

| Field         | Notes                                                          |
|---------------|----------------------------------------------------------------|
| **id** *      | Required, unique upstream id.                                  |
| **transport** | `stdio` (the supported transport).                            |
| **command** * | Required executable, e.g. `node`.                             |
| **args**      | Space-separated, e.g. `path/to/server.js --flag`.            |
| **description** | What this upstream provides.                                |

Below the basics is the **Exposed tools** subsection — the curated-direct selections. Click
**+ expose** to add a row, and fill in:

- **tool** — the upstream tool's name (required for the row to count)
- **as** — optional rename for how it surfaces through the gateway (defaults to `<id>_<tool>`)
- **category** — optional grouping label

Add as many rows as you need (the **×** removes a row). On submit, ToolFunnel registers the
upstream first, then attaches each expose selection to it. Leave the expose rows empty to add the
upstream now and curate its tools later.

`id` and `command` are required; a duplicate or otherwise invalid upstream is rejected with an
error toast.

### Enable / disable and remove

The **Enabled** switch turns the whole upstream on or off. **Remove** deletes the upstream **and
cascades** — its exposed-tool entries go with it — behind a confirm. (Fine-grained editing of an
individual expose entry after creation isn't surfaced in the UI; use the management tools / CLI
for that. The badges on each expose row reflect its state read-only.)

---

## 4. Hooks tab

This tab manages lifecycle hooks in `hooks/hooks.manifest.json` (the enabled state is overlaid
from `hooks/hooks.state.json`).

### Search

Filters by **id, event, matcher, and description**.

### Each hook row

A row shows the hook **id** (monospace), its **event** chip, the **matcher** (or `* (all)` when
blank), and an optional description. There are two kinds of row:

- **Named hooks** (have an id) carry an **Enabled** switch and a **Remove** button.
- **Per-tool gates** (the Pre/Post gates created on the Tools tab) have no id, so they show as
  `(tool gate)` with an **auto** badge and an enabled/disabled badge, plus a *"managed on Tools
  tab"* note. They are **read-only here** — toggle them from the tool's Pre/Post switches.

### The two shipped example hooks

A fresh install ships **two example hooks, both disabled**, so this tab is never empty and you have
working policy to copy:

- `pre-tool-use/example-deny-dangerous` — a `PreToolUse` gate that **blocks** any call whose
  arguments contain an obviously-destructive shell pattern (`rm -rf`, `mkfs`, drive `format`, fork
  bomb). Script: `hooks/scripts/example-deny-dangerous.js`.
- `post-tool-use/example-audit` — a `PostToolUse` observer that runs *after* a tool executes
  (advisory — it cannot un-run it) and receives the result on stdin; the stub just exits 0. Script:
  `hooks/scripts/example-audit.js`.

They ship **disabled**, so the default install is still allow-all — nothing gates until you opt in.
**To enable one:** flip its **Enabled** switch here (or set `"enabled": true` in
`hooks/hooks.manifest.json`). Edit the script at the path above to encode your own policy. They are
deliberately illustrative, not a security baseline.

### Adding a hook

Click **+ Add hook**. Fields:

| Field        | Notes                                                                   |
|--------------|-------------------------------------------------------------------------|
| **id** *     | Required, unique (e.g. `pre-tool-use/my-gate`).                        |
| **event** *  | Dropdown of the six lifecycle events (see below).                      |
| **matcher**  | Regex to match tool/gate names; **blank = matches all**.               |
| **command** *| Required, e.g. `node "${HOOKS_DIR}/scripts/my-gate.js"`.               |
| **script body** | Optional inline source, authored under `hooks/scripts/`.            |

The **event** dropdown offers all six events, defaulting to `PreToolUse`:

`SessionStart` · `UserPromptSubmit` · `PreToolUse` · `PostToolUse` · `Stop` · `PreCompact`

Use the **matcher** to scope which tools a `PreToolUse`/`PostToolUse` gate fires for (e.g.
`Bash|Write`); leave it blank to fire for all. The **command** is what runs when the hook fires —
note the portable `${HOOKS_DIR}` token, which the loader expands to the real hooks directory at
load time, so the manifest stays machine-independent. If you paste a **script body** and the
command points at a `scripts/<file>`, that file is written under `hooks/scripts/` for you.

**Important:** a newly added hook is created **disabled** — the toast says so ("disabled — enable
it to fire"). Flip its **Enabled** switch when you're ready for it to run. This lets you stage a
hook (and write its script) before it goes live.

### Enable / disable and remove

The **Enabled** switch toggles the hook through the state overlay. **Remove** deletes the hook
entry from the manifest — note its **script file is left in place** on disk (so you can re-add or
reuse it). Both are guarded by the usual confirm on remove.

---

## 5. Logs tab

ToolFunnel can record an append-only JSONL activity log of tool runs and gate decisions. It is
**off by default**; this tab is the simplest place to turn it on and watch it.

### The on/off toggle

At the top of the tab is a switch bound to the logger config (`logs/log.config.json`):

- **Off** (default) — nothing is recorded. The status reads *"logging is off."*
- **On** — flip the switch and recording starts immediately; the status reads *"logging is on"*
  and the resolved log file **path** is shown beside it.

This is the same setting controlled by `tf_log {action: enable|disable|status}` and the
`logs/log.config.json` file — flipping the switch here is identical to those.

### Viewing entries

The list shows the **most recent ~100 records, newest first**. Hit **Refresh** to reload both the
config and the latest entries (the log doesn't stream — refresh to pull new activity). Each entry
has a **type badge** that tells you which kind of record it is:

- **gate** — a Pre/Post hook decision. The status badge reads **allow** or **deny** (deny shown in
  red), and the secondary line shows the **reason** when one was given.
- **tool** — a tool execution. The status badge reads **ok**, **fail**, or **blocked** (a blocked
  run is one a `PreToolUse` gate stopped; fail and blocked show in red), and the secondary line
  shows the execution **mode** and **duration in ms**.
- **config** — a configuration change made through this UI (e.g. a tool toggled, an upstream added,
  OAuth enabled). The badge names the change `event`, and the secondary line shows the changed
  fields. These let you audit *who changed the gateway's posture and when* — see
  [`docs/logging.md`](logging.md).
- **auth** — an OAuth denial at the HTTP transport gate (a rejected token). The status badge reads
  **deny**, and the secondary line shows the `error` and HTTP `status` (401/403).

All kinds also show the subject (tool/gate name, config event, or auth path) and a **timestamp**.
When the log is off and empty the tab prompts you to flip the switch; when it's on but nothing has
been recorded yet it says so.

---

## 6. Auth tab

This tab configures the **optional** OAuth 2.1 resource-server validation, stored in
`auth/auth.config.json`. ToolFunnel is loopback-only and unauthenticated by default; this tab is
where you turn on bearer-token validation for a networked or multi-user deployment. The full
reference — fields, security rationale, what is and isn't implemented — lives in
[`docs/oauth.md`](oauth.md); this is just the UI walk-through.

### Installing the one dependency

OAuth is the **only** feature that adds a dependency (`jose`, itself zero-dependency). The tab
reports whether it is present. If it isn't, an **Install OAuth dependency** button appears — click
it and the gateway installs the pinned `jose` on demand (`POST /api/oauth/install`). If the
auto-install can't complete (an unusual Node layout, no network), the toast surfaces a copyable
`npm install jose@<pin>` command to run yourself. Everyone who never enables OAuth pulls nothing.

### The config form

- **Enable OAuth 2.1 resource-server validation** — the master switch. Enabling it while the config
  is incoherent, or while `jose` is absent, is refused with an explanatory toast (fail-fast — the
  same guard the HTTP host applies at start).
- **issuer** — the authorization server tokens must come from (`iss`). Required when enabled.
- **audience** — *this gateway's* resource URI (`aud`). Required when enabled — without it tokens
  are unbound (the confused-deputy hole).
- **jwksUri** — explicit JWKS endpoint; blank = discover it from the issuer.
- **algorithms**, **requiredScopes**, **clockToleranceSec** — the pinned algorithm allowlist,
  optional required scopes, and clock-skew tolerance.

Saving writes `auth/auth.config.json` (`POST /api/auth/config`, atomic, read fresh per request — the
change is live, no restart). The config is **off by default**; a missing file reads as disabled.

---

## Summary

- The console is **optional** and **loopback-only**: `node bin/toolfunnel.js --ui` →
  `http://127.0.0.1:9777`.
- Five tabs — **Tools / MCPs / Hooks / Logs / Auth** — each with live search (where it applies), a
  collapsible add form, and per-row controls.
- Every edit writes the **same config files** the CLI and management functions use, atomically,
  and the running gateway picks it up **with no restart**.
- Per-tool **execution mode** (reference ↔ gateway) and **Pre/Post gates** are toggled on the Tools
  tab; those gates also appear (read-only) on the Hooks tab. **Details / edit** opens an inline
  panel to view and change a tool's full entry (including its script body).
- The **activity log** is off by default — turn it on from the Logs tab to watch gate decisions,
  tool runs, **config changes**, and **auth denials**.
- The **Auth** tab configures the optional OAuth 2.1 resource server (and installs its single
  dependency on demand). See [`docs/oauth.md`](oauth.md).
