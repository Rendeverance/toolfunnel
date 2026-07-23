# How to configure ToolFunnel - config files only, no code

This is the instruction served by `toolfunnel_howto({ topic: "configure" })`. It is the complete
no-code setup map: every behaviour of the gateway is driven by a small set of JSON files at the
**config home**. Editing these files (or driving the UI / the `tf_*` management tools, which write
the same files) is the entire configuration story - there is nothing to program.

## 1. The config home

All files live under one directory, resolved in this order:

1. `--config-dir <dir>` on the command line
2. the `TOOLFUNNEL_HOME` environment variable
3. the package/repo root (the default for a git clone)

On first start with a fresh `--config-dir`, the home is seeded with the standard layout. Every
file below is read FRESH per request - edits are live without a restart, except `toolfunnel.json`
(read at boot; restart to apply).

## 2. The files

| File | What it controls | Live? |
|---|---|---|
| `toolfunnel.json` | Identity + default ports (see §3) | restart |
| `mcp/expose.json` | Attached upstream MCPs + which of their tools are curated-direct | live |
| `tools/tools.register.json` | The local tool register (the gateway's own tools) | live |
| `tools/tools.state.json` | Per-tool overlays: enabled / hot / hidden, and the active wrap (`"passthrough"`). Wrapped example: `{ "passthrough": "acme-notes" }`; cleared: `{}` (the file-edit equivalent of `wrap --off`) | live |
| `hooks/hooks.manifest.json` | PreToolUse / PostToolUse policy hooks (the gate) | live |
| `hooks/hooks.state.json` | Per-hook enabled overlay | live |
| `logs/log.config.json` | Activity log on/off + path | live |
| `auth/auth.config.json` | OAuth 2.1 resource-server validation (opt-in; needs `toolfunnel install-oauth` once) | live |

Shapes: `expose.json` → `toolfunnel_howto({ topic: "add-mcp" })`; register entries →
`toolfunnel_howto({ topic: "create-tool" })`; hook entries → `toolfunnel_howto({ topic: "add-hook" })`;
the wrap field → `toolfunnel_howto({ topic: "wrap" })`.

## 3. `toolfunnel.json` - identity & ports

Every field optional; an absent or empty file IS the default identity. Blank/omitted fields fall
back per-field (a broken file never stops the gateway starting).

```json
{
  "serverName":    "my-mcp",     // what CLIENTS see in the initialize handshake   (default "toolfunnel")
  "serverVersion": "1.0.0",      // ...its version                                   (default: package version)
  "clientName":    "my-client",  // what UPSTREAM servers see from the gateway     (default "toolfunnel")
  "clientVersion": "1.0.0",      // ...its version
  "httpPort":      9998,         // --http default port                            (default 9998)
  "uiPort":        9777          // --ui   default port                            (default 9777)
}
```

Precedence: CLI flag > this file > built-in default. Under a WRAP on stdio, the wrapped upstream
is shown the real downstream client's identity automatically - `clientName`/`clientVersion` cover
funnel mode, HTTP, and the boot connection. The UI's **Settings** tab edits this file.

## 4. Worked example - a complete gateway from five files

A gateway that attaches one upstream, exposes two of its tools, gates everything, logs activity,
and introduces itself as `acme-tools`:

1. `toolfunnel.json` → `{ "serverName": "acme-tools", "clientName": "acme-tools" }`
2. `mcp/expose.json` → one `upstreams[]` entry (id, `"transport": "stdio"`, command, args,
   `"enabled": true`) + two `expose[]` entries (`{ "upstream", "tool", "enabled": true }`)
3. `hooks/hooks.manifest.json` → one PreToolUse entry matching the tools you want policy on
4. `logs/log.config.json` → `{ "enabled": true }`
5. Start it: `node bin/toolfunnel.js` (stdio) or `--http` / `--ui` as needed.

Optional per-upstream flags in `expose.json`: `"legacyPin": true` pins that upstream to the
legacy MCP protocol permanently (opt-in, warns loudly); `"env"` passes environment variables to
the spawned server; `"cwd"` sets its working directory; `"timeoutMs"` raises the payload
timeout for that upstream (default 120000 ms - applies to `tools/call`, `prompts/get` and
`resources/read`; under a wrap, a tool that reports progress keeps its call alive regardless.
The 10 s handshake/list window is fixed: it detects dead servers); `"modernOnly": true`
requires that upstream to speak the modern (2026-07-28) protocol - the connect fails with a
clear error instead of falling back to legacy (the mirror of `legacyPin`; setting both on one
upstream is refused). Server side, `"serveLegacy": false` in `toolfunnel.json` makes the
gateway itself modern-only: legacy clients are refused with a clear error (default: serve
both eras - only an explicit `false` flips it).

## 5. Where the AI-driven and human paths meet

The UI (all five tabs + Settings), the `tf_*` management tools, and hand-editing these files are
three views of the SAME state - every write goes through the same validated, atomic store code.
Pick whichever fits: config files for repeatable/scripted setups, the UI for humans, the
management tools for in-band agent-driven changes (each documented via
`toolfunnel_tool_instructions`).
