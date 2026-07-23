# Example: how to gate a tool

This example gates the built-in **`danger`** demo tool (register display name **`Danger Demo`**)
so it only runs when the caller passes `{ "confirm": true }`. It is the runnable companion to
[`docs/hooks-and-gating.md`](../../docs/hooks-and-gating.md).

A **gate** is a `PreToolUse` hook. Before any tool runs, ToolFunnel fires `PreToolUse` through the
hook engine; if a hook **denies**, the tool's `execute()` is never called - no side effect, no
output. The `danger` tool's only side effect is appending one line to the file named by
`TOOLFUNNEL_DANGER_LOG` (`tools/scripts/danger.js`), so a held gate is observable as the **absence
of that line**.

## Files here

| File | What it is |
|---|---|
| `gate-danger.js` | The hook script. Reads the `PreToolUse` event JSON on stdin; denies (exit 2) unless `tool_input.confirm === true`. Fails closed. |
| `manifest.snippet.json` | The manifest entry that registers the hook and points its `matcher` at the tool. |

## Install it (3 steps)

1. **Copy the script** into your hooks tree:

   ```
   cp examples/gate-danger/gate-danger.js  hooks/scripts/gate-danger.js
   ```

   Hook scripts live under `hooks/scripts/` (tool scripts live under `tools/scripts/` - separate
   trees, separate path guards; don't cross them).

2. **Register the hook.** Add the entry from `manifest.snippet.json` to the `hooks` array in
   `hooks/hooks.manifest.json`. If that file is still the default `{ "version": 1, "hooks": [] }`,
   you can copy `manifest.snippet.json` over it wholesale.

3. **Confirm it's enabled.** The manifest `enabled: true` is the seed; the live value is the
   `hooks/hooks.state.json` overlay, which **wins** at load. Toggle it on via the loader's
   `setEnabled("pre-tool-use/gate-danger", true)` (atomic write), or leave the overlay absent so the
   manifest seed stands.

## Why the matcher is `"Danger Demo"`, not `"danger"`

The matcher is a **full-match regex against `tool_name`** (`^(?:Danger Demo)$`). For a first-party
tool run via `toolfunnel_run_tool`, the `tool_name` the gate sees is the register entry's **display
`name`** (`"Danger Demo"`), not its lowercase `id` (`danger`). Match the **name**. To gate several
tools, use an alternation: `"Danger Demo|Bash"`. `""`, `undefined`, or `"*"` match everything.

## What happens

| Call | `PreToolUse` result | `danger.js` side effect |
|---|---|---|
| `toolfunnel_run_tool({ name: "danger" })` | **blocked** - reason from stderr | **none**: `execute()` never runs; no line in `TOOLFUNNEL_DANGER_LOG` |
| `toolfunnel_run_tool({ name: "danger", args: { confirm: true } })` | allowed | the tool runs; one line appended to the log |

The denied call returns `{ ok: false, blocked: true, reason: "Danger Demo is gated: ..." }`. Because
the gate sits *before* `execute()`, the proof is the absence of the log line.

## Two ways to deny

`gate-danger.js` uses **exit 2** (stderr is the reason) - the simplest deny. The runner also honours
the **JSON protocol on exit 0**: print `{ "hookSpecificOutput": { "hookEventName": "PreToolUse",
"permissionDecision": "deny", "permissionDecisionReason": "..." } }` and exit `0`. Use that when you
want a structured reason. (Note: `exit 2` is the **only** blocking exit code - any other non-zero
exit is a *non-blocking* error and your deny would silently pass through.) The commented block at the
bottom of `gate-danger.js` shows the JSON form.

## Proof it works

`test/gate.test.js` proves the invariant headlessly - a `PreToolUse` deny prevents `execute()` from
ever running (a sentinel side-effect file is never written), while an empty/non-matching manifest
allows it. It uses its own fixtures under `test/fixtures/` and never mutates the shipped
`hooks/hooks.manifest.json`. Run the suite with `npm test`.
