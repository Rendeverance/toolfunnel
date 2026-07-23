# How to add a hook (self-extension)

This is the instruction served by `toolfunnel_howto({ topic: "add-hook" })`. It explains how to add a hook
to the Hook Engine: the manifest entry shape, where the script goes, and how the enabled/disabled
state is persisted separately in `hooks.state.json`. The full contract is HOOK_ENGINE.md - this is
the authoring view.

A hook is exactly two things:
1. **A manifest entry** in `hooks/hooks.manifest.json` (its config: event, matcher, command, ...).
2. **A script** under `hooks/scripts/` that the entry's `command` runs.

Activation (on/off) is NOT in the manifest's source of truth at runtime - it lives in an overlay,
`hooks/hooks.state.json` (see §4).

---

## 1. The manifest entry shape

`hooks.manifest.json` has `version`, `hooksDir`, and a `hooks` array. Each entry:

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
  "description": "Denies any tool call whose args contain a destructive pattern (rm -rf, etc)."
}
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Unique key, format `"<kebab-event>/<script-basename-without-ext>"` (e.g. `pre-tool-use/deny-dangerous`). The loader and `hooks.state.json` key on this. |
| `event` | string | One of the six lifecycle events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `PreCompact`. |
| `matcher` | string | Regex anchored full-match against `tool_name`. `""`, `undefined`, or `"*"` = always fire. Tool-less events (SessionStart, UserPromptSubmit, Stop, PreCompact) ignore it. Example: `"Bash|Write|Edit"`. |
| `type` | string | `"command"` (the only type today). |
| `command` | string | The command line the runner spawns. `${HOOKS_DIR}` expands to the absolute `hooks` path at load time. |
| `script` | string | The script path relative to `hooksDir`, e.g. `scripts/deny-dangerous.sh`. Used by the manager's open/edit (`readScript`/`writeScript`). |
| `timeout` | number | **Seconds** (the runner multiplies by 1000). The runner kills the child past this. |
| `enabled` | boolean | The manifest's default/seed state. The live value is the overlay in `hooks.state.json` - see §4. |
| `description` | string | What the hook does, for the manager UI. |

One entry **per hook command** - a settings.json event with N hooks becomes N entries.

---

## 2. Where the script goes

```
hooks/
  hooks.manifest.json    # config entries (above)
  hooks.state.json       # enabled/disabled overlay, keyed by hook id
  scripts/               # your hook scripts live HERE
    deny-dangerous.sh
```

(The loader itself - `hook-loader.js` - is engine code and is NOT user content; it lives in
`src/core/`, not in `hooks/`.)

`writeScript` (the manager's save path) refuses any path that resolves outside
`hooks/scripts/` - defense-in-depth for the isolation rule. Author your script there only;
never point a hook at a script in a live host hooks directory. Clone the behaviour in if you need it.

---

## 3. What the script returns (the two protocols)

The runner spawns the command, writes the event payload as JSON on stdin, then reads the result.
The payload a tool event receives on stdin:

```json
{ "tool_name": "note_slow", "tool_input": { "arg": "value" } }
```

(`PreToolUse` → `tool_name` + `tool_input`; `PostToolUse` adds `tool_response`. Tool-less
events carry their own fields - `prompt`, `source` - instead.)

Two protocols (HOOK_ENGINE.md §3):

**A) Exit-code (simple):**
- `exit 0` → success. On `SessionStart`/`UserPromptSubmit`, stdout becomes **injected context**;
  on other events stdout is advisory.
- `exit 2` → **blocking**. stderr is the reason - on a blocked tool call the client receives it
  as the result text with `isError: true`.
- any other code → non-blocking error (stderr captured, loop continues; never throws).

**B) JSON (advanced)** - honored **only on exit 0**, when stdout parses as a JSON object:
```json
{
  "continue": true,
  "decision": "block",
  "reason": "...",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny" | "ask",
    "permissionDecisionReason": "...",
    "additionalContext": "..."
  }
}
```
- **PreToolUse blocks via `hookSpecificOutput.permissionDecision: "deny"`** - NOT the top-level
  `decision` field. `"allow"` passes; `"ask"` is non-blocking in the autonomous host.
- **Top-level `decision: "block"`** is for the other blockable events (UserPromptSubmit, PostToolUse,
  Stop, PreCompact). There is no `"approve"`.
- `continue: false` stops the whole loop. `hookSpecificOutput.additionalContext` → injected text.

This is the mechanism that makes a PreToolUse hook gate `toolfunnel_run_tool`: match its `tool_name`, and
return `permissionDecision: "deny"` to block the call before the tool runs.

---

## 4. Activation state lives in `hooks.state.json`

The Hook Manager design splits **what exists** from **what's on**:

- **The `scripts/` folder is the source of truth for what exists.** On startup the loader scans it
  and reconciles with the manifest: newly-found scripts are added as entries (event/matcher inferred
  or flagged "unconfigured"); manifest entries whose script is missing are flagged.
- **The manifest carries config** (event, matcher, command, timeout, description, seed `enabled`).
- **`hooks.state.json` is the activation overlay** - an object keyed by hook `id` recording the live
  enabled/disabled value:

```json
{
  "version": 1,
  "enabled": {
    "pre-tool-use/deny-dangerous": true,
    "user-prompt-submit/inject-context": false
  }
}
```

Toggling a hook writes `hooks.state.json` **atomically** (temp + rename). It survives restarts and is
kept separate from the auto-detected inventory, so re-scanning the folder never clobbers your toggles.
At load, the overlay wins over the manifest's seed `enabled` for any id it lists.

---

## 5. Steps to add a hook

1. Write the script into `hooks/scripts/<name>.sh` (or a node script). Read the stdin JSON
   payload; emit one of the two protocols above.
2. Add the manifest entry: `id` = `"<kebab-event>/<name>"`, set `event`, `matcher`, `command`
   (`bash "${HOOKS_DIR}/scripts/<name>.sh"`), `script`, `timeout` (seconds), `description`, and a
   seed `enabled`.
3. Set its live state in `hooks.state.json` via the loader's `setEnabled(id, bool)` (atomic write).
4. Verify: the manager lists it under its event; a run-once test fires it with a sample payload and
   shows the result. For a gate, confirm a matching `toolfunnel_run_tool` call is denied with your reason.
