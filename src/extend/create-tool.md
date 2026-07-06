# How to add a tool (self-extension)

This is the instruction served by `toolfunnel_howto({ topic: "create-tool" })`. It tells you — the
model — how to add a new tool to the register so it becomes callable through `toolfunnel_run_tool`
(and listable via `toolfunnel_list_tools` / `toolfunnel_tool_instructions`). No restart is needed: a
running gateway watches `tools.register.json` and hot-reloads its register on change (debounced
~150 ms), the same way `mcp/expose.json` and the hook files reload.

A tool is exactly two things:
1. **A register entry** in `tools/tools.register.json` (structured metadata + how to invoke it).
2. **A script** under `tools/scripts/` that the entry's `invoke` points at (only for
   `invoke.type === "script"`; a `shell` tool needs no file).

---

## 1. The register entry shape

`tools.register.json` is a JSON file with one top-level array of entries. Each entry:

```json
{
  "id": "echo-upper",
  "name": "Echo Upper",
  "summary": "Uppercases the supplied text and echoes it back.",
  "category": "demo",
  "instructions": "Pass { text: string }. Returns the text uppercased. Use this only as a sanity check of the run path.",
  "inputSchema": {
    "type": "object",
    "properties": { "text": { "type": "string", "description": "The text to uppercase." } },
    "required": ["text"],
    "additionalProperties": false
  },
  "invoke": { "type": "script", "path": "scripts/echo-upper.sh" }
}
```

Field-by-field — these names are fixed (registry.js reads exactly these):

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable unique key, kebab-case. `toolfunnel_run_tool({ name })` and `registry.run(id, args)` look up by this. Never reuse an existing `id`. |
| `name` | string | Human/model-facing display name. Shown in the manager UI. |
| `summary` | string | One line. This is ALL that `toolfunnel_list_tools` returns for the tool — keep it tight and discriminating so the model can pick the right tool from the brief alone. |
| `category` | string | Grouping label (e.g. `demo`, `memory`, `messaging`, `media`). Used by `toolfunnel_list_tools({ category })` to filter. |
| `instructions` | string | Full usage doc returned by `toolfunnel_tool_instructions({ name })`. Describe the args object, what comes back, and any safety caveats. This is the long-tail payload — be complete here, terse in `summary`. |
| `inputSchema` | object (optional) | A JSON Schema for the tool's args. **This is what makes the tool a first-class MCP citizen when promoted hot:** the top-level `tools/list` advertises it VERBATIM, so a connected client knows the exact arg shape without reading `instructions`. Omit it and a hot-promoted tool falls back to a free-form `{ "type": "object" }` (callable, but the client gets no arg hints). Must be an object — the register rejects any other shape at authoring time. |
| `invoke` | object | How `run` executes the tool. See below. |

### The `invoke` object — two forms

```json
{ "type": "script", "path": "scripts/echo-upper.sh" }
```
- `type: "script"` — run a file under `tools/scripts/`. `path` is **relative to `tools/`**
  and MUST stay inside `tools/scripts/` (registry.js path-guards it, same defense-in-depth as the
  hook loader's `writeScript`). The args object is delivered to the script (e.g. as a JSON blob on
  stdin or argv per the registry's convention) and the script's stdout is the tool output.

```json
{ "type": "shell", "command": "node \"${TOOLS_DIR}/scripts/echo-upper.js\"" }
```
- `type: "shell"` — run a command line. `${TOOLS_DIR}` expands to the absolute `tools` path at run
  time (mirrors `${HOOKS_DIR}` in the hook manifest). Prefer `script` for anything reusable; reserve
  `shell` for thin one-liners.

> Isolation rule: an `invoke` must only reference scripts/commands that live **inside the gateway's
> own tree**. Never point `invoke` at a live tool that lives outside it (e.g. in a host's external
> tool directory). If you want an external tool's behaviour, clone its script into
> `tools/scripts/` first, then point at the clone.

---

## 2. Where the script goes

```
tools/
  tools.register.json    # the entries (above)
  scripts/               # your tool scripts live HERE and nowhere else
    echo-upper.sh
```

(`registry.js` — the engine that loads/persists the register and runs list/instructions/run — is
NOT user content. It lives in `src/tools/registry.js` and is not part of this tree.)

The script reads its arguments (the `args` object passed to `run`) and writes its result to stdout.
Exit non-zero with a message on stderr to signal failure — the registry surfaces that as the tool's
error. Keep scripts pure and side-effect-honest: anything destructive is exactly what the PreToolUse
gate exists to catch (next section).

---

## 3. How `run` works — and why it is gated

`toolfunnel_run_tool({ name, args })` does **not** execute the script directly. It calls
`registry.run(id, args)`, which routes the call through the gateway's **hook engine** before — and after —
the tool actually runs:

```
toolfunnel_run_tool(name, args)
        │
        ▼
  registry.run(id, args)
        │
        ├─► hookEngine.fire("PreToolUse", ctx, { tool_name, tool_input: args })
        │        └─ if result.blocked  → STOP. Return { ok:false, error: <reason> }. Script never runs.
        │
        ├─► execute the invoke (script/shell) only if NOT blocked
        │
        └─► hookEngine.fire("PostToolUse", ctx, { tool_name, tool_input: args, tool_response })
                 └─ feedback only; the tool already ran (cannot un-run it)
```

- **The PreToolUse gate is the whole safety case.** A hook denies a call by returning, on exit 0,
  `{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny",
  "permissionDecisionReason": "…" } }` — OR by `exit 2` with the reason on stderr. (PreToolUse uses
  `permissionDecision`, NOT a top-level `decision` — see HOOK_ENGINE.md §3.) When that fires,
  `run` returns an error result and the script is never spawned.
- `permissionDecision: "allow"` passes; `"ask"` is non-blocking in the autonomous host (no
  interactive prompt) — the reason is captured but the tool proceeds.
- The result shape `run` returns matches the meta-tool contract: `{ ok, output, error? }`.

So adding a tool grants real power, but every invocation is mediated by the same gate that protects
every other tool. If your new tool is dangerous, the correct control is a PreToolUse hook that
matches its `tool_name` (see `toolfunnel_howto({ topic: "add-hook" })`), not omitting the tool.

---

## 4. Steps to add a tool

1. Pick a unique `id` (check `toolfunnel_list_tools` first so you don't collide).
2. If `invoke.type === "script"`, write the script into `tools/scripts/<id>.sh` (or `.js`).
3. Add the entry to the `tools.register.json` array (via `registry.js`'s add/edit path so the write
   is atomic — never hand-edit and risk a torn file).
4. Confirm with `toolfunnel_list_tools` (your `summary` appears) and `toolfunnel_tool_instructions({ name })`
   (your `instructions` appear).
5. Test with `toolfunnel_run_tool({ name, args })`. Verify the gate behaves: a benign call returns
   `{ ok:true, output }`; if a matching PreToolUse hook should deny it, confirm it does.

No reconnect is needed — the register is dynamic: the running gateway hot-reloads
`tools.register.json` on change and emits `notifications/tools/list_changed`, exactly like an
`expose.json` or hook edit.

---

## 5. Promoting your tool to the top-level surface (the "instant MCP" recipe)

By default your tool lives behind the lean meta-tools (discovered via `toolfunnel_list_tools`).
Set `hot: true` for its id in `tools/tools.state.json` (or via the UI / `tf_tool_set`) and it is
advertised DIRECTLY in the MCP `tools/list` — under its own `id`, with your `summary` as the
description and your `inputSchema` as the advertised schema. Author a real `inputSchema` before
promoting: that schema is the difference between a client calling your tool correctly first time
and it guessing at a free-form object.
