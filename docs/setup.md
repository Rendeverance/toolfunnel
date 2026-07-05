# ToolFunnel — Setup

How to install ToolFunnel and register it with any MCP-capable agent. ToolFunnel is one
small MCP gateway: it hosts first-party tools, forwards and curates tools from upstream MCP
servers, exposes them **leanly** (short briefs + schema-on-demand), and gates every
execution through your own policy hooks.

It speaks the same protocol two ways:

- **stdio** (default) — the client spawns ToolFunnel as a child process and talks JSON-RPC
  over stdin/stdout. Simplest; nothing to leave running.
- **HTTP/SSE** (`--http`) — a long-lived host process owns the server on `127.0.0.1:9998`
  and any number of clients connect over `http://127.0.0.1:9998/mcp`.

Both serve the identical tool surface and run every call through the same gate.

---

## 1. Requirements

- **Node.js >= 18.** That is the only requirement. (`node --version` to check.)
- **Zero runtime dependencies.** ToolFunnel uses Node built-ins only — no npm packages, no
  MCP SDK. There is nothing to `npm install` for it to run, and nothing transitive to audit.
- **Loopback only.** The HTTP host binds `127.0.0.1` and rejects non-loopback `Host` headers
  (DNS-rebinding guard). It is designed for a local agent on the same machine, not remote
  access.

---

## 2. Install

Clone (or copy) the repository somewhere stable. Because there are no dependencies, that is
the whole install:

```bash
git clone <repo-url> toolfunnel
cd toolfunnel
node bin/toolfunnel.js --help     # verify it runs
```

You should see the usage banner. That confirms Node can run the entry point.

> `npm install` is **optional and a no-op** here — `dependencies` is empty, so there is
> nothing to fetch. Running it just writes a lockfile; ToolFunnel runs straight from a clone.

### Optional: a global `toolfunnel` command

The package declares a `toolfunnel` bin, so you can put it on your `PATH` instead of typing
the full path every time:

```bash
# from inside the cloned repo
npm link            # symlinks a global `toolfunnel` to this checkout
# …or
npm install -g .    # installs it globally
```

After either, `toolfunnel` and `toolfunnel --http` work from anywhere. (`npx toolfunnel`
will also work once the package is published to a registry.)

Throughout this document, **pick one invocation form** and use it consistently in your
client config:

| Form | stdio command | HTTP launch |
|------|---------------|-------------|
| Direct (no install) | `node /abs/path/to/toolfunnel/bin/toolfunnel.js` | `node /abs/path/to/toolfunnel/bin/toolfunnel.js --http` |
| Global install / link | `toolfunnel` | `toolfunnel --http` |
| Published package | `npx toolfunnel` | `npx toolfunnel --http` |

> **Windows paths in JSON:** use forward slashes (`F:/dev/toolfunnel/bin/toolfunnel.js`) or
> escaped backslashes (`F:\\dev\\toolfunnel\\bin\\toolfunnel.js`). Node accepts forward
> slashes on Windows, so forward slashes are the simplest choice.

---

## 3. Running

### stdio (default)

```bash
node bin/toolfunnel.js
# or, if installed globally:
toolfunnel
```

It reads JSON-RPC from stdin and writes responses to stdout (diagnostics go to stderr, so
they never pollute the protocol channel). It accepts both `Content-Length`-framed messages
and newline-delimited JSON. You normally don't run this by hand — the MCP client launches it
for you (section 5). A quick smoke test:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node bin/toolfunnel.js
```

You should get one JSON line back with `"serverInfo":{"name":"toolfunnel","version":"<current version>"}`
and `"protocolVersion":"2024-11-05"`.

> **Working directory doesn't matter.** ToolFunnel resolves its config (`tools/`, `mcp/`,
> `hooks/`) relative to its own install location, not the directory it's launched from. So a
> client that spawns `node /abs/path/to/toolfunnel/bin/toolfunnel.js` from any `cwd` still
> finds the right register, expose store, and hook manifest. You never need to set a `cwd` in
> the client config.

### HTTP/SSE host

```bash
node bin/toolfunnel.js --http
# or:
toolfunnel --http
# npm script shortcut, from the repo:
npm run http
```

This starts a long-lived host and logs to stderr:

```
[toolfunnel] HTTP MCP host listening on http://127.0.0.1:9998
```

Endpoints:

| Method + path | Purpose |
|---------------|---------|
| `POST /mcp`   | One JSON-RPC request → one JSON-RPC response. This is the call channel. |
| `GET  /mcp`   | Server→client SSE stream (`Accept: text/event-stream`) — the Streamable-HTTP standard. |
| `GET  /mcp/sse` | Working alias for the SSE stream (older HTTP+SSE shape; still supported). |
| `GET  /health` | Synchronous JSON health snapshot. |

**The URL your client points at is `http://127.0.0.1:9998/mcp`** (note the `/mcp` path — the
bare origin is not the endpoint).

Bind options:

```bash
toolfunnel --http --port 9000      # bind a specific port
toolfunnel --http --port 0         # OS-assigned ephemeral port (read it from the stderr log)
toolfunnel --http --host 127.0.0.1 # explicit loopback host (default)
```

Stop it with Ctrl+C (SIGINT) — it shuts down cleanly.

Smoke-test a running host:

```bash
curl -s http://127.0.0.1:9998/health
curl -s -X POST http://127.0.0.1:9998/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

The `tools/list` response lists the lean meta-tools the agent uses to discover everything
else (see section 6).

---

## 4. stdio vs HTTP — which to register

- **stdio** is the default and the simplest: zero processes to manage, the client starts and
  stops ToolFunnel with its own lifecycle. Best when one client owns the gateway.
- **HTTP** is better when you want **one** gateway shared by several clients/sessions, want
  it to stay up across client restarts, or want to hit `/health` and the SSE
  `tools/list_changed` stream. You start the host yourself (or via a service manager) and
  point clients at the URL.

Both expose the same tools and enforce the same gate, so you can switch freely.

---

## 5. Registering with clients

### Claude Code

Claude Code reads MCP servers from a `.mcp.json` file (project root for project scope, or
your user config). The top-level key is `mcpServers`.

**stdio form** — Claude Code launches ToolFunnel itself:

```json
{
  "mcpServers": {
    "toolfunnel": {
      "command": "node",
      "args": ["F:/dev/toolfunnel/bin/toolfunnel.js"]
    }
  }
}
```

If you installed the global bin, you can use it directly instead:

```json
{
  "mcpServers": {
    "toolfunnel": {
      "command": "toolfunnel",
      "args": []
    }
  }
}
```

**HTTP form** — point at an already-running host (`toolfunnel --http`):

```json
{
  "mcpServers": {
    "toolfunnel": {
      "type": "http",
      "url": "http://127.0.0.1:9998/mcp"
    }
  }
}
```

You can also add either form from the CLI instead of hand-editing the file:

```bash
# stdio (everything after -- is the launch command)
claude mcp add toolfunnel -- node F:/dev/toolfunnel/bin/toolfunnel.js

# http (host must be running)
claude mcp add --transport http toolfunnel http://127.0.0.1:9998/mcp
```

### Generic MCP clients

Any MCP client follows one of the two shapes above. The vocabulary is near-universal:

**stdio** — give the client a command + args; it spawns the process and speaks JSON-RPC over
the pipes:

```json
{
  "command": "node",
  "args": ["F:/dev/toolfunnel/bin/toolfunnel.js"]
}
```

**HTTP / Streamable-HTTP** — give the client the endpoint URL; it POSTs JSON-RPC to it and
(optionally) opens the `GET /mcp` SSE stream:

```
http://127.0.0.1:9998/mcp
```

If a client distinguishes "HTTP" from the older "SSE" transport, ToolFunnel supports both on
the same host: use `http://127.0.0.1:9998/mcp` for Streamable-HTTP, or
`http://127.0.0.1:9998/mcp/sse` for the legacy SSE alias. Protocol version is `2024-11-05`.

### Cursor

Cursor reads `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project), also under a
`mcpServers` key.

**stdio:**

```json
{
  "mcpServers": {
    "toolfunnel": {
      "command": "node",
      "args": ["F:/dev/toolfunnel/bin/toolfunnel.js"]
    }
  }
}
```

**HTTP** (point at a running `toolfunnel --http`; Cursor uses a `url` field):

```json
{
  "mcpServers": {
    "toolfunnel": {
      "url": "http://127.0.0.1:9998/mcp"
    }
  }
}
```

### Windsurf

Windsurf reads `~/.codeium/windsurf/mcp_config.json`, again under `mcpServers`.

**stdio:**

```json
{
  "mcpServers": {
    "toolfunnel": {
      "command": "node",
      "args": ["F:/dev/toolfunnel/bin/toolfunnel.js"]
    }
  }
}
```

**HTTP** (Windsurf uses a `serverUrl` field for remote/HTTP servers):

```json
{
  "mcpServers": {
    "toolfunnel": {
      "serverUrl": "http://127.0.0.1:9998/mcp"
    }
  }
}
```

> Field names for the HTTP/SSE URL vary by client (`url`, `serverUrl`, or a `type:"http"`
> block). The URL itself is always `http://127.0.0.1:9998/mcp`. Check your client's MCP docs
> if neither field name is accepted.

---

## 6. What you'll see after connecting

ToolFunnel exposes a deliberately small surface so it costs almost no context. After
connecting, the agent sees these meta-tools instead of every upstream schema:

- **`toolfunnel_list_tools`** — list the available tools as short briefs (id, summary,
  category). This is the lean catalogue.
- **`toolfunnel_tool_instructions`** — fetch the full instructions/schema for one tool, on
  demand. The agent only pays for the schema of a tool it's actually about to use.
- **`toolfunnel_howto`** — self-extension guidance (adding tools, hooks, upstream MCPs).

That's the token saver: the long tail of tools lives behind `toolfunnel_list_tools` rather
than as hundreds of always-loaded `tools/list` entries.

Out of the box there are 9 demo first-party tools (echo, base64, hash, uuid, json,
text-stats, and a few inventory/diagnostic helpers) and **no** upstream MCPs connected
(`expose.json` is empty by default). Add upstreams and curate which of their tools to expose
via the configuration files — see the self-extension guides under `src/extend/`
(`add-mcp.md`, `create-tool.md`, `add-hook.md`) or call `toolfunnel_howto`.

---

## 7. Troubleshooting

- **Client shows no tools / connection fails (stdio):** run the exact `command` + `args`
  from your config in a terminal and pipe the initialize smoke-test from section 3. If that
  prints a `serverInfo` line, the launch command is correct; re-check the JSON path
  escaping in your config.
- **`EADDRINUSE` on `--http`:** port 9998 is taken. Start with `--port <n>` (or `--port 0`
  for an OS-assigned port, then read the actual port from the stderr log line) and update
  the client URL to match.
- **`403 forbidden: non-loopback Host`:** you reached the host with a non-loopback `Host`
  header (e.g. a real hostname or LAN IP). ToolFunnel is loopback-only by design — use
  `127.0.0.1` or `localhost`.
- **Is it alive?** `curl -s http://127.0.0.1:9998/health` returns `{"ok":true,...}` with the
  bound `url`, protocol version, and tool counts when the host is up.
- **Node too old:** `node --version` must be >= 18. Earlier versions lack APIs the transport
  relies on.
