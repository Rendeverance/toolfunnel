# How to register an upstream MCP (self-extension)

This is the instruction served by `toolfunnel_howto({ topic: "add-mcp" })`. It explains how to connect an
**upstream MCP server** (a browser-automation MCP, a chat bridge, ...) to the aggregator and choose **which of its
tools to expose downstream** to the CLI. All of this is configured in one persisted file:
`mcp/expose.json`.

The architecture (see the architecture overview, §1): many upstream MCPs each expose many tools; the
aggregator connects to them and the **MCP Manager picks which tools to surface** to the CLI as
*curated-direct* tools - alongside the four lean meta-tools (`toolfunnel_list_tools`,
`toolfunnel_tool_instructions`, `toolfunnel_run_tool`, `toolfunnel_howto`). The CLI sees a small surface; everything
else stays reachable through the register.

> Phase note: the live aggregator (`src/mcp/aggregator.js`) is Phase 2. This doc defines the
> `expose.json` shape so the config is authorable now and the aggregator reads exactly these fields
> when it lands.

---

## 1. `expose.json` - the two blocks

`expose.json` persists (a) the upstream MCP connections and (b) the curated-direct selection drawn
from them:

```json
{
  "version": 1,
  "upstreams": [
    {
      "id": "chat",
      "transport": "stdio",
      "command": "node",
      "args": ["vendor/chat-mcp/server.js"],
      "env": { "CHAT_DB": "..." },
      "enabled": true,
      "description": "Chat bridge MCP - chats, messages, send."
    },
    {
      "id": "browser",
      "transport": "stdio",
      "command": "npx",
      "args": ["@example/browser-mcp"],
      "enabled": false,
      "description": "Browser automation MCP."
    }
  ],
  "expose": [
    {
      "upstream": "chat",
      "tool": "list_chats",
      "as": "chat_list_chats",
      "category": "chat",
      "enabled": true
    },
    {
      "upstream": "chat",
      "tool": "send_message",
      "as": "chat_send_message",
      "category": "chat",
      "enabled": true
    }
  ]
}
```

### `upstreams[]` - one entry per upstream MCP

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable key for this upstream. Referenced by `expose[].upstream`. Unique. |
| `transport` | string | How the aggregator connects. `"stdio"` (spawn `command`+`args`) is the baseline. |
| `command` / `args` / `env` | string / string[] / object | The process the aggregator spawns for a `stdio` upstream. Path-shaped **args** must stay **inside the config home** - the isolation guard refuses to connect an upstream whose args escape it. (The `command` itself, an executable, is not guarded; the currently-WRAPPED upstream is exempt in transparent-wrapper mode, with a warning.) |
| `enabled` | boolean | Whether the aggregator connects to this upstream at startup. |
| `description` | string | Human-facing note for the MCP Manager UI. |

### `expose[]` - which upstream tools become curated-direct

| Field | Type | Meaning |
|---|---|---|
| `upstream` | string | Must match an `upstreams[].id`. |
| `tool` | string | The upstream tool's own name (as the upstream's `tools/list` reports it). |
| `as` | string | The downstream name the CLI sees (namespaced so two upstreams can't collide, e.g. `chat_send_message`). Optional - defaults to `<upstream>_<tool>`. |
| `category` | string | Grouping label, same convention as register entries. |
| `enabled` | boolean | Whether this tool is actually exposed downstream right now. |

Only the tools listed in `expose[]` with `enabled: true` are surfaced to the CLI as curated-direct
tools. Everything else on the upstream stays connected but hidden - reachable, if needed, by adding
an `expose` entry (no upstream reconnect required to *list*, though see §3 on the CLI surface).

---

## 2. Steps to register an upstream and expose a tool

1. Add an entry to `upstreams[]` with a unique `id`, the `stdio` `command`/`args`, and
   `enabled: true`. Keep the server's path-shaped args **inside the config home** (vendor the
   server in if it isn't already) - the isolation guard refuses args that escape it.
2. Let the aggregator connect and run the upstream's `tools/list` (the MCP Manager UI surfaces the
   discovered tools).
3. For each tool you want hot, add an `expose[]` entry: `{ upstream, tool, as, category, enabled:true }`.
4. Leave the long tail unexposed - the model can still reach those via the register/meta-tools if you
   later mirror them, but the *curated-direct* surface stays lean by design (the dial in §1 of the
   architecture: directly-exposed = the HOT tools; the register meta-tools = the long tail).

---

## 3. Curated-direct vs. the register (update cost)

This matters because the two layers refresh differently (see the architecture overview, §1):

- **Curated-direct tools** (what `expose[]` produces) are negotiated with the CLI **at connect time**.
  Changing the exposed set therefore needs a **reconnect**, or a `notifications/tools/list_changed`
  message *if the CLI honours it* (VERIFY per host; restart is the safe baseline).
- **Register tools** (the `toolfunnel_list_tools`/`run` path) are **always live** - the model re-reads the
  register on every `toolfunnel_list_tools` call, so no reconnect is needed.

Rule of thumb: expose a handful of HOT, high-reliability tools curated-direct; everything else lives
in the register and is reached through the meta-tools.

> Safety: a curated-direct upstream tool is still ultimately invoked by the model. When you wire
> upstream execution through the host, route it through the same PreToolUse gate the register's `run`
> uses (see `toolfunnel_howto({ topic: "add-hook" })`) so the safety invariant holds uniformly. The gate
> firing on every execution path is a tested invariant, not an assumption.
