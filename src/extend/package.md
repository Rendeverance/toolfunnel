# How to package and share units (self-extension)

This is the instruction served by `toolfunnel_howto({ topic: "package" })`. It explains how to bundle
tools, hooks, and MCP configs into a **shareable package** and how import/export work. Packaging is a
**byproduct** of the gateway design: because every unit is already structured and
self-documented, a package is just a folder that lists its units and carries their files.

---

## 0. The WHOLE-SETUP path - `tf_pack` (start here)

Since 0.4.0 the fastest way to ship is not per-unit packaging but the **whole setup**: your entire
config home (tools + scripts, hot/hidden curation, upstream references, policy hooks, identity) is
already the product. One call packages it into a deployment-ready artifact under `<home>/dist/`:

- `tf_pack { format: "home" }` → a **portable config home**. Zip it, git-init it, or run it
  directly: `toolfunnel --config-dir <dir>`. The receiving gateway seeds nothing - the pack IS the
  config, including the hooks: **the gate travels**, enforcing your policy on the recipient's
  machine regardless of which MCP client they use.
- `tf_pack { format: "npm", name: "my-mcp" }` → a **publishable npm package**: a generated
  `package.json` that depends on `toolfunnel` (caret range - DEPEND, never copy the engine), a
  2-line bin launcher pointing `--config-dir` at the bundled home, and a README stub.
  `cd dist/my-mcp && npm publish` → your users run `npx my-mcp` and get YOUR server, under YOUR
  name (the bundled `toolfunnel.json` identity), with YOUR gate.

Declare the runtimes your tools need in the home's `toolfunnel.json` - they travel with the pack
and the receiving gateway warns at startup about anything missing:

```json
"requires": [ { "command": "python", "min": "3.10", "why": "the pdf tools" } ]
```

Audit honesty (both directions): packs spawn commands. Tell your users to read your pack's
`expose.json`, `tools.register.json`, AND `toolfunnel.json` (its `requires` probes execute at
gateway startup - bare program names only, the loader rejects anything shell-shaped) - and read
all three yourself in anything you install.

The per-UNIT packaging below remains the right shape for sharing a single tool/hook/MCP selection
rather than a whole gateway.

> Phase note: packages are Phase 2 (`packages/` directory). The structure below is what the importer
> and exporter target; defining it now means the units authored today are already package-ready.

---

## 1. What a unit is (and what travels with it)

Each unit is self-contained - this is the whole reason packaging is cheap:

| Unit | Its metadata | Its files |
|---|---|---|
| **tool** | one `tools.register.json` entry (`id/name/summary/category/instructions/invoke`) | the script under `tools/scripts/` (for `invoke.type === "script"`) |
| **hook** | one `hooks.manifest.json` entry (`id/event/matcher/command/script/timeout/description`) + its `hooks.state.json` enabled value | the script under `hooks/scripts/` |
| **mcp** | one `expose.json` `upstreams[]` entry + its `expose[]` selections | any vendored server files it spawns (must live inside the package) |

A package gathers one or more of these, plus the files they reference.

---

## 2. Package layout

A package is a folder under `packages/` containing a manifest and the units' files in a mirrored
tree so import is a structured copy, not guesswork:

```
packages/
  notify-pack/
    package.json          # the package manifest (below)
    tools/
      scripts/
        msg-digest.sh
    hooks/
      scripts/
        rate-limit.sh
    mcp/
      vendor/             # any vendored upstream server files
```

### `package.json` - the package manifest

A `package.json`-style manifest listing the package's identity and its units (the metadata blocks are
embedded so import is self-sufficient - it does not need the source register/manifest to reconstruct
entries):

```json
{
  "name": "notify-pack",
  "version": "1.0.0",
  "description": "Message digest tool + rate-limit gate + upstream MCP exposure.",
  "author": "unknown",
  "units": {
    "tools": [
      {
        "entry": {
          "id": "msg-digest",
          "name": "Message Digest",
          "summary": "Summarises unread chats.",
          "category": "messaging",
          "instructions": "Pass { since? }. Returns a per-chat unread digest.",
          "invoke": { "type": "script", "path": "scripts/msg-digest.sh" }
        },
        "files": ["tools/scripts/msg-digest.sh"]
      }
    ],
    "hooks": [
      {
        "entry": {
          "id": "pre-tool-use/rate-limit",
          "event": "PreToolUse",
          "matcher": "msg_send_message",
          "type": "command",
          "command": "bash \"${HOOKS_DIR}/scripts/rate-limit.sh\"",
          "script": "scripts/rate-limit.sh",
          "timeout": 5,
          "description": "Denies sends past a per-minute cap."
        },
        "enabled": true,
        "files": ["hooks/scripts/rate-limit.sh"]
      }
    ],
    "mcp": [
      {
        "upstream": {
          "id": "notify",
          "transport": "stdio",
          "command": "node",
          "args": ["${PACKAGE_DIR}/mcp/vendor/notify-mcp/server.js"],
          "enabled": true,
          "description": "Messaging bridge MCP."
        },
        "expose": [
          { "upstream": "notify", "tool": "list_chats", "as": "msg_list_chats", "category": "messaging", "enabled": true },
          { "upstream": "notify", "tool": "send_message", "as": "msg_send_message", "category": "messaging", "enabled": true }
        ],
        "files": ["mcp/vendor/notify-mcp/server.js"]
      }
    ]
  }
}
```

| Field | Meaning |
|---|---|
| `name` / `version` / `description` / `author` | Package identity. `name` is the folder name and the import key. |
| `units.tools[]` | Each has the full register `entry` plus `files` (paths inside the package). |
| `units.hooks[]` | Each has the full manifest `entry`, its seed `enabled` (for `hooks.state.json`), and `files`. |
| `units.mcp[]` | Each has an `upstream` block, its `expose[]` selections, and any vendored `files`. |

`${PACKAGE_DIR}` expands to the installed package's absolute path (mirrors `${HOOKS_DIR}` /
`${TOOLS_DIR}`), so a package's MCP/tool commands resolve wherever it lands.

---

## 3. Export - bundling a unit (or several)

To export, gather a unit's metadata and its files into a package folder:

1. Create `packages/<name>/` with a `package.json` manifest.
2. For each tool: copy its `tools.register.json` entry into `units.tools[].entry`, copy its
   `tools/scripts/<file>` into the package's `tools/scripts/`, and list it in `files`.
3. For each hook: copy its `hooks.manifest.json` entry into `units.hooks[].entry`, copy its enabled
   value from `hooks.state.json` into `enabled`, copy the script into `hooks/scripts/`, list it.
4. For each MCP: copy the `upstreams[]` block + matching `expose[]` selections, and vendor any server
   files into `mcp/vendor/`.

The package is then a single folder, self-describing and copy-portable. (Everything stays inside
`packages/` - the isolation rule still holds.)

---

## 4. Import - installing a package

Import is the reverse: **drop a package folder in `packages/` + register its units.**

1. Read `packages/<name>/package.json`.
2. **Tools:** copy each `units.tools[].files` into `tools/scripts/` and add each `entry` to
   `tools.register.json` (atomic write via `registry.js`). Reject id collisions or prompt to rename.
3. **Hooks:** copy each `units.hooks[].files` into `hooks/scripts/` and add each `entry` to
   `hooks.manifest.json`; write its `enabled` into `hooks.state.json`.
4. **MCP:** copy vendored `files` into the package's `mcp/vendor/`, add each `upstream` to
   `expose.json` `upstreams[]` and its `expose[]` selections (path-rewritten to `${PACKAGE_DIR}`).

After import: tools are live immediately (the register is read fresh on every `toolfunnel_list_tools`).
Hooks take effect once the loader re-scans (next startup, or a reload). Curated-direct MCP tools need
a reconnect to reach the CLI surface (register-routed tools do not). Verify with `toolfunnel_list_tools`
and a `run`/run-once test that the gate still fires on the imported units - the PreToolUse gate
applies to imported tools exactly as it does to local ones.
