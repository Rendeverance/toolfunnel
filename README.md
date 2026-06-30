# ToolFunnel

![ToolFunnel](assets/logo.png) <!-- logo asset (assets/logo.png) is added separately -->

> A zero-dependency* MCP gateway: host your own tools, forward and curate tools from other MCP servers, expose them **leanly** to cut agent token cost, and gate every call through your own policy hooks before it runs.


## The problem

The Model Context Protocol (MCP) lets an AI agent call tools from many servers. But every connected server dumps **all** of its tool schemas into the model's context on every turn. Connect a handful of rich MCP servers and you've spent thousands of tokens describing tools the agent won't use this turn - slower, costlier, noisier.

Similarly, working with AI I found myself generating many many tools, some of which I wanted to use with different AI workflows, some I didnt, and I didnt want to keep setting them up, I also didnt wish to keep many different setups for different workflows. Therefore ToolFunnel was born so that all of my multi-use tools and common MCP servers can be in one place, with any workflow, and I can easily select which I want to use with whatever workflow. You can also change or add tools during a session with simple toggles in the UI. I also wanted to wire up and test an MCP *live*, in the running session, without resetting the CLI or restarting anything - and have its tools show up in the tools list straight away; ToolFunnel does exactly that.

Often also, there's also no consistent way to **govern** what an agent may run: hooks and policies live in the *host* (a specific CLI or otherwise), so they don't travel when you switch clients - with ToolFunnel, this is easy because your hooks travel with the tools - it can become your one swiss-army knife for many different workflows.

Finally, I didnt want to audit huge numbers of dependencies - a personal choice, yes - so I wanted something that could be audited quickly and easily.

At the time of writing, I have 14 MCP tools and 93 local tools all accessed through toolfunnel, gated as required.

## What ToolFunnel does

ToolFunnel is one small MCP server that sits between your agent and everything else:

1. **Hosts your own tools** - define first-party tools in a JSON register and serve them directly. Seven demo tools ship in the box.
2. **Forwards other MCP servers - leanly.** Attach an upstream MCP and its tools appear in the same lean register as your own (briefs + instructions-on-demand), runnable through `toolfunnel_run_tool` and the gate. Curate which appear, promote a chosen few to top-level "every-turn" tools, or leave them lean by default. Every forwarded call still passes the gate.
3. **Lean register** - the agent sees short tool *briefs*; the full instructions for a tool are fetched **on demand**, so context stays small. *(This is the token saver.)*
4. **Server-side policy gate** - every server-side execution path fires your PreToolUse / PostToolUse hooks **inside the gateway**, so your policy works on *any* client, not just hosts that support hooks. The gate travels with the gateway, and **fails closed**.
5. **Configure by file, UI, or in-band** - plain JSON files, an optional loopback web UI (`node bin/toolfunnel.js --ui`), or eight in-band **management functions** all add / curate / toggle tools, upstreams, and hooks - live, no restart.
6. **Audit when you want it** - a toggleable JSONL log (**default off**) records tool runs, every gate allow/deny decision, and every upstream connect / disconnect / reconnect.
7. **Live & self-healing** - attach/curate/toggle tools, upstreams, and hooks on a *running* gateway with no restart; and if an attached MCP's process dies, the gateway detects it and reconnects in the background with backoff.

### The meta-tool surface

The model never sees the long tail of tools directly. It sees a tiny, fixed surface of **meta-tools**, and reaches the real tools through them:

| Meta-tool                      | Args                  | Returns                                              |
|--------------------------------|-----------------------|------------------------------------------------------|
| `toolfunnel_list_tools`        | `{ filter?, category? }` | Briefs only: `[{ id, name, summary, category }]`  |
| `toolfunnel_tool_instructions` | `{ name }`            | The full usage instructions for one tool, on demand  |
| `toolfunnel_howto`             | `{ topic }`           | A self-extension guide (`create-tool`, `add-mcp`, `add-hook`, `package`) |
| `toolfunnel_run_tool`          | `{ name, args }`      | Runs a register tool **through the gate**            |

All **four** meta-tools are advertised in `tools/list`. The flow is: list the briefs, read one tool's instructions on demand, then run it - either **yourself** in your own environment per the instructions (a *reference* tool), or via `toolfunnel_run_tool`, which executes the tool server-side **through the gate** (a *gateway* tool - see [Execution mode](#execution-mode-reference-vs-gateway)). Any **curated upstream** tools you expose are advertised alongside the meta-tools and run through the same gate.

### The visibility matrix

Every tool - your own, a forwarded upstream tool, **and** the four meta-tools - has three independent visibility dials, so you decide exactly what each workflow sees:

| Axis | Surface it controls | Default |
|------|---------------------|---------|
| **enabled** | **Lean-visible** - appears in `toolfunnel_list_tools` and is runnable. | on |
| **hot** | **Top-level / every-turn** - promoted into `tools/list`, so the agent sees its full schema on *every* turn and can call it **directly** (no `toolfunnel_run_tool` hop). | off (meta-tools: **on**) |
| **hidden** | Manager-list declutter only (the UI / `tf_list`) - doesn't change what the agent sees. Hidden tools are omitted from `tf_list` and the UI Tools list by default (a "show hidden" toggle / `includeHidden` reveals them). | off |

The dials live per tool in `tools/tools.state.json`, keyed by the tool's **surfaced name** (a local id, an upstream's `<upstream>_<tool>` or its `as`, or a meta-tool name), and are read **fresh per call** - so a toggle is live with no restart. A disabled tool is never hot.

This is what lets ToolFunnel be **a lean register and a conventional MCP at the same time**:

- **Default (lean).** The four meta-tools are top-level; everything else is lean - short briefs, schemas on demand. Token cost stays flat as you add tools.
- **Promote the few you call constantly.** Flip `hot` on a tool and it joins the every-turn surface, directly callable like any native MCP tool - while the long tail stays lean. A promoted call still passes the gate (a hot local tool through `toolfunnel_run_tool`'s gated path; a hot upstream tool forwarded through the same gate).
- **Turn ordinary tools into a plain MCP.** Promote a set of local/upstream tools **and** hide the four meta-tools (`hot:false`), and ToolFunnel presents exactly those tools as a normal top-level MCP server - no meta-tools, no `toolfunnel_run_tool` hop - assembled from scripts and *other* MCPs with no SDK and no Python.

Two footguns the UI warns about: hiding the meta-tools leaves the agent unable to *discover* tools by name (intended for the "ordinary MCP" pattern, a mistake otherwise), and promoting *many* tools re-introduces the context bloat the lean register exists to avoid. Promote/demote from the **Tools** tab (a per-tool **Hot** toggle plus the top-level **surface panel**), from the **MCPs** tab (per discovered upstream tool), or with `tf_tool_set { id, action: "hot" | "unhot" | "hide" | "unhide" }`. (A hidden meta-tool is also un-callable, not just unlisted - the lockdown is real.)

There's a secondary use, too: because the four ToolFunnel meta-tools are themselves switchable, you can set up your own tools and schemas, promote the ones you want hot, then switch the meta-tools off so only your tools are visible over MCP. That makes ToolFunnel a viable alternative to MCP-Anything for assembling a mixed toolset into a single server :)

### The demo tools

Seven first-party demo tools ship in `tools/scripts/`, declared in `tools/tools.register.json` (which also declares the eight [management functions](#management-functions) below):

| Tool              | Category    | What it does                                       |
|-------------------|-------------|----------------------------------------------------|
| `echo`            | demo        | Return the provided args back unchanged            |
| `base64`          | encoding    | Encode text to / decode text from Base64           |
| `hash`            | crypto      | Compute a digest (default sha256) of input text    |
| `uuid`            | generators  | Generate one or more RFC 4122 v4 UUIDs             |
| `json`            | data        | Validate and pretty-print a JSON string            |
| `text-stats`      | text        | Count characters, words, and lines                 |
| `danger`          | demo        | A deliberately "destructive" demo to prove the gate (its only side effect is appending a line to the file named by `TOOLFUNNEL_DANGER_LOG`) |

**Script contract.** Each tool is a standalone Node script that reads its structured args from the environment variable `TOOLFUNNEL_TOOL_ARGS` (a JSON string), prints **exactly one JSON line** to stdout, and exits `0`. The register resolves a tool's `invoke: { type: "script", path: "scripts/<file>" }` to a `node <script>` spawn, and that spawn only happens after the PreToolUse gate allows it.

They're just here to get you started - turn any of them off or delete them as you like :)

### Management functions

The gateway can manage **itself**. Eight first-party tools in the `management` category let an agent (or the web UI) add, curate, and toggle the gateway's own configuration. They are ordinary register tools - reached through `toolfunnel_run_tool`, so every call passes the same gate as any other gateway tool (a single PreToolUse matcher such as `tf_.*` locks the whole management surface down, since each is named `tf_*`).

| Function       | What it does                                                                 |
|----------------|------------------------------------------------------------------------------|
| `tf_tool_add`  | Register a new tool (optionally authoring its script body under `tools/scripts/`). Live, no reconnect. |
| `tf_tool_set`  | Enable, disable, **promote/demote on the every-turn surface (`hot`/`unhot`)**, **hide/unhide from the manager views (`hide`/`unhide`)**, or remove a register tool (the enable/disable overlay is default-ON; `hot`/`hidden` are default-OFF). |
| `tf_mcp_add`   | Register an upstream MCP and optionally curate some of its tools to expose.   |
| `tf_mcp_set`   | Enable, disable, or remove an upstream MCP (remove cascades its expose entries). |
| `tf_hook_add`  | Add a hook manifest entry (e.g. a PreToolUse gate), optionally authoring the script under `hooks/scripts/`. |
| `tf_hook_set`  | Enable, disable, or remove a hook (live toggles via the `hooks.state.json` overlay). |
| `tf_list`      | List register tools, upstream MCPs, or hooks with their live active state (read-only). Hidden tools are omitted by default - pass `{ includeHidden: true }` to show them. |
| `tf_log`       | Enable, disable, or check the [audit log](#activity--audit-log) (`{ action: enable\|disable\|status }`). |

Tool / hook register edits are **live** (re-read per call, no reconnect). Upstream attach/curate changes are picked up live too: the gateway watches its config and reloads - reconnecting upstreams and emitting `notifications/tools/list_changed` - with no restart.

### Execution mode: reference vs gateway

Each register tool resolves to one of two execution modes (set the optional `mode` field, or let it be **inferred backward-compatibly**):

- **`reference`** - ToolFunnel only **describes** the tool. `toolfunnel_run_tool` returns the tool's instructions and the connected AI performs the action in **its own environment**. Nothing runs server-side, so **the gate does not fire** (there is nothing to gate). A reference tool needs no `invoke`. This is the lean default for a tool that carries no executable body.
- **`gateway`** - ToolFunnel **executes** the tool server-side via the gated run path (`toolfunnel_run_tool` → PreToolUse gate → run → PostToolUse). This is the opt-in mode for tools the gateway should actually run.

When `mode` is omitted it is inferred so existing tools keep working unchanged: a `script` or `shell` invoke ⇒ `gateway`; anything else ⇒ `reference`. The seven demo tools and eight management functions all carry script invokes, so they resolve to `gateway`. The resolved mode is shown (and switchable) per tool in the web UI.

### The gate

Every server-side run-path - a `gateway` tool run via `toolfunnel_run_tool` (including the management functions) **and** every forwarded curated-upstream call - funnels through `src/mcp/gated-run.js`. (`reference` tools execute nothing here, so they short-circuit before the gate.)

```
gatedRun({ engine, ctx, toolName, args, execute })
  → fire PreToolUse   (may BLOCK - fails CLOSED if the engine errors)
  → execute()         (ONLY if allowed)
  → fire PostToolUse  (advisory - cannot un-run the tool)
```

Hooks live in `hooks/hooks.manifest.json` (empty manifest = allow-all). They're matched against the tool name (`src/core/matcher.js`) and run by `src/core/hook-runner.js`, which speaks the Claude-Code hook protocol: a hook command reads the event JSON on stdin and either exits `2` to block (with a reason on stderr), or exits `0` and optionally returns JSON (`{ "decision": "block", ... }` or `{ "hookSpecificOutput": { "permissionDecision": "deny" | "allow", ... } }`). The load-bearing invariant, proven by test: **a PreToolUse deny means `execute()` is never called.**

## Why it's different

Hosting tools and proxying other MCP servers is a crowded space - but for my own use case, which is why I rolled my own solution, I wanted something different.

A quick feature comparison as of June 2026:

| Capability | ToolFunnel | FastMCP | mcpproxy-go | MetaMCP | mcp-anything |
|---|:--:|:--:|:--:|:--:|:--:|
| Config-declared polyglot tools (no SDK) | ✓ | ✗ (decorators) | partial (proxy only) | ✗ | ✓ |
| Lean server-side exposure (briefs + schema on demand) | ✓ | partial | ✓ | ✗ | ✗ |
| Server-side fail-closed policy gate (Pre/Post) | ✓ | ✓ | ✓ | ✓ | ✗ |
| Live attach / hot-reload, no restart | ✓ | ✗ | partial | partial | ✓ |
| Non-Docker self-healing reconnect | ✓ | ✗ | partial (Docker) | partial (circuit-breaker) | ✗ |
| Visibility **matrix** - lean default + per-tool promote-to-every-turn + hide | ✓ | ✗ | filter only | cherry-pick only | ✗ |
| Zero runtime dependencies\* | ✓ (Node, no SDK) | ✗ (framework) | ✓ (Go) | ✗ (Docker) | ✓ (Go) |
| Runtime dependencies (installed / bundled) | **0\*** | many | 40+ (bundled) | many | bundled (Go) |
| Config web UI | ✓ | ✗ | ✓ | ✓ | ✗ |

**Beyond the dependency count, four capability choices set ToolFunnel apart from a pure proxy like mcpproxy-go:**

1. **It HOSTS, not just proxies.** A proxy/aggregator forwards tools from *existing* MCP servers. ToolFunnel also turns an arbitrary local command or script - any language - into a first-class **gated** MCP tool from one JSON entry, with no SDK and no pre-existing server.
2. **Reference mode.** A tool ToolFunnel only *describes*: `toolfunnel_run_tool` hands back the instructions and the connected AI performs the action in **its own** environment - and the **handoff itself is gated** (a PreToolUse deny withholds the instructions). Nothing executes server-side.
3. **A portable policy gate, not a content scanner.** The gate speaks the **Claude-Code hook protocol** (PreToolUse/PostToolUse, exit-2-to-block) *inside* the gateway, so an existing hook/policy travels to **any** client unchanged - an easily adaptable (to CODEX or whatever you are using) programmable policy that ports, rather than a built-in scanner.
4. **The visibility matrix.** Not on/off filtering - a lean default you can selectively **promote to the every-turn surface**, **hide** from the manager view, or collapse entirely (turn the meta-tools off and present your tools as a plain top-level MCP).

Underneath it all: a **lean** surface (briefs + instructions-on-demand) that keeps token cost flat as you add tools, a **fail-closed** gate on every server-side path, and **zero runtime dependencies\*** in a component that sits in a privileged position. The wedge is the whole package in one small, auditable server - not any single trick.

### State of development and honest limitations

ToolFunnel is a **focused solo build**. I've tested it thoroughly for my own use case, but it may still contain bugs outside of that - and there are features I've leaned on less than others. The OAuth 2.1 and Streamable-HTTP implementations in particular are recent, added in line with the latest MCP SDK capabilities, and haven't been tested as extensively, so your mileage may vary.

There are no Prometheus/OpenTelemetry metrics either - instead there's a toggleable JSONL audit log plus in-memory call counters on `/health`. I haven't needed full metrics for my own use; if it's something you'd want, let me know and I'll look at adding it.

If you find a bug - better still, a bug and a fix - or have an improvement, I'd genuinely like to hear from you. I'm keen to work with others on ToolFunnel :)

And because it's hand-rolled rather than built on the MCP SDK, I'll need to keep it in line with MCP itself as the spec evolves - the revisions land roughly quarterly, and I aim to track new capabilities as they're announced. Again: if you'd like to get involved, I'd love to hear from you :)

## Use cases

- **Tame context bloat.** Several rich MCP servers connected at once drown the agent's context in tool schemas it won't use this turn. Behind ToolFunnel the agent sees short briefs and loads a tool's full schema only when it actually reaches for it.
- **One toolbox, many workflows.** Keep all your multi-use tools and common MCP servers in one place and pick which to surface per workflow - instead of re-wiring a different setup for every client.
- **Govern what an agent may run - on any client.** Put a fail-closed PreToolUse policy *in the gateway* so it travels with your tools, even to clients that have no hook system of their own.
- **Turn a script into an MCP tool without building an MCP.** Have a useful CLI, a bash one-liner, or a script in any language? Declare it in a JSON entry and it's a gated MCP tool - no protocol code, no SDK (`toolfunnel_howto({ topic: "create-tool" })` shows the shapes).
- **Add a tool mid-session.** Need a tool while you're working? Drop it in and it's live on the next turn - no restart.
- **Survive an upstream crash.** If an attached MCP server dies mid-session, ToolFunnel notices, reconnects it in the background with backoff, and re-advertises its tools - no restart, no dropped session. Most reconnect logic elsewhere is Docker-scoped; this isn't.

## Zero dependencies, on purpose

ToolFunnel has **no runtime npm dependencies** (`"dependencies": {}`) and does **not** use an MCP SDK - the JSON-RPC 2.0 wire protocol is hand-rolled on top of Node built-ins (`node:http`, `node:child_process`, `node:fs`, …). Requires Node **>= 18**. `npm install toolfunnel` pulls **zero** packages.

> **\* The one asterisk: OAuth is opt-in.** Enabling OAuth 2.1 (off by default) adds exactly **one** dependency - [`jose`](https://www.npmjs.com/package/jose), which is itself **zero-dependency**, audited, and the same library the official MCP SDK uses. It is **not** a runtime dependency of the core: it appears only as a `devDependency` (for the OAuth test suite) and is **installed on demand** for users who turn auth on - `toolfunnel install-oauth` or the Install button in the UI's Auth tab. So the default footprint is genuinely zero, and the most security-sensitive code in the project - token validation - is delegated to an audited library rather than hand-rolled. See [Authentication](#authentication---optional-oauth-21).

This is a deliberate **security** decision, not minimalism for its own sake. ToolFunnel sits in a privileged position - it **gates tool execution** - which is exactly where you don't want an unaudited dependency tree. And `dependencies: {}` in npm is a stronger claim than a "single binary" elsewhere: a Go gateway that ships as one binary still *statically links* its dependency tree (mcpproxy-go's, for example, runs to 40+ direct deps - goja, esbuild, gRPC, an observability stack). That's dependency-**bundled**, not dependency-free. In a year when npm itself saw large packages compromised (Axios, the 140-package Mastra incident), a tool-execution gate with **nothing transitive to audit** is a defensible engineering stance - you audit *your* code, not forty supply chains. (It is not a silver bullet: a zero-dep posture shrinks the audit surface, it doesn't remove the burden of getting the hand-rolled wire + gate correct - which I have tried to do.)

The transport reads **both** LSP-style `Content-Length:` framing **and** newline-delimited JSON, and writes newline-delimited JSON, so it interoperates with simple and framed clients alike.

## Authentication - optional OAuth 2.1

By default the gateway is **loopback-only and unauthenticated** - the right posture for a single operator on `localhost`. For a networked or multi-user deployment, ToolFunnel can act as an **OAuth 2.1 resource server**: it validates the bearer token on every request before any tool runs.

- **Opt-in, one dependency.** Off until you enable it. Enabling installs `jose` on demand (`toolfunnel install-oauth` or the UI Auth tab) and the core stays zero-runtime-dependency for everyone else.
- **Delegated, not hand-rolled.** Token validation goes through `jose` with a **pinned algorithm allowlist** (which defeats the RS256↔HS256 confusion attack and `alg:none`), enforced **issuer**, and an enforced **audience** bound to this gateway's resource URI - the RFC 8707 confused-deputy defence. JWKS fetch, caching, and key rotation are the library's job.
- **Discovery.** With auth on, the gateway serves the RFC 9728 Protected Resource Metadata document at `GET /.well-known/oauth-protected-resource` (unauthenticated), and a `401` carries a `WWW-Authenticate: Bearer resource_metadata="…"` hint.
- **Safe exposure.** Auth is what unlocks a non-loopback bind: the HTTP host **refuses to bind off-localhost unless OAuth is enabled**, and refuses to start if auth is on but the dependency is missing or the config is incoherent (fail-fast).
- **Configure** in the UI Auth tab or `auth/auth.config.json` (`enabled`, `issuer`, `audience`, optional `jwksUri` - else derived from the issuer via OIDC discovery - `algorithms`, `requiredScopes`, `clockToleranceSec`). Requires Node **>= 18** (`jose` v5, the CommonJS build).

The OAuth **client** leg (Dynamic Client Registration, authorization-server-metadata discovery, step-up auth) and the 2026 spec hardening (RFC 9207 issuer validation, credential binding) are **planned, not yet shipped** - the resource-server slice is the shipped, tested MVP.

## Token efficiency

The mechanism is the lean register: a connected upstream normally injects every tool's full JSON schema into context on every turn. ToolFunnel replaces that with short briefs (`name`, `summary`, `category`) and serves the full instructions for a single tool only when the agent asks via `toolfunnel_tool_instructions`. The more tools you connect, the larger the saving.

## Quickstart

```bash
# 1. Get the code
git clone <your-fork-or-clone-url> toolfunnel
cd toolfunnel

# 2. "Install" - zero RUNTIME deps; a clone's npm install pulls only the dev/test
#    tooling (jose, for the OAuth test suite). Installed as a dependency it pulls nothing.
npm install          # runtime dependencies: none

# 3a. Run as a stdio MCP server (the default - what most clients spawn)
node bin/toolfunnel.js

# 3b. Or run as an HTTP/SSE host on 127.0.0.1:9998 (long-lived; many clients can connect)
node bin/toolfunnel.js --http
node bin/toolfunnel.js --http --port 0      # 0 = OS-assigned port
node bin/toolfunnel.js --http --host 127.0.0.1 --port 9998

# 3c. Or open the OPTIONAL config web UI on 127.0.0.1:9777 (loopback only)
node bin/toolfunnel.js --ui
node bin/toolfunnel.js --ui --port 0        # 0 = OS-assigned port

# Help
node bin/toolfunnel.js --help

# Smoke-test the wiring (build → initialize → tools/list → call a meta-tool)
node test/smoke.js
```

The HTTP host binds loopback only and exposes a single Streamable-HTTP endpoint at `POST/GET /mcp` (plus a deprecated `GET /mcp/sse` alias and a `GET /health` JSON snapshot). The npm scripts mirror the above: `npm start` (stdio) and `npm run http`.

### Registering with an MCP client

Point your client at ToolFunnel via `.mcp.json`. For a **stdio** server the client spawns the process:

```json
{ "mcpServers": { "toolfunnel": { "command": "node", "args": ["/path/to/toolfunnel/bin/toolfunnel.js"] } } }
```

For the **HTTP** host (start it first with `node bin/toolfunnel.js --http`), point the client at the `/mcp` endpoint:

```json
{ "mcpServers": { "toolfunnel": { "type": "http", "url": "http://127.0.0.1:9998/mcp" } } }
```

Once connected, call `toolfunnel_list_tools` to see the briefs, `toolfunnel_tool_instructions` with a tool `name` to get its full usage, and `toolfunnel_howto` to learn how to extend the gateway.

**Or skip the config entirely - just ask your AI.** Point any MCP-aware client at ToolFunnel and say *"attach this tool server, expose these tools, and block anything destructive."* The AI reads ToolFunnel's own built-in instructions and wires it all up for you - upstreams, exposed tools, and a PreToolUse safety gate - in plain language, no JSON editing. Prefer to click? The web UI below does the same. **No coding experience required :)**

## The config web UI

An **optional** local admin console lets a human view, search, and configure the gateway without hand-editing JSON:

```bash
node bin/toolfunnel.js --ui          # http://127.0.0.1:9777
node bin/toolfunnel.js --ui --port 0 # OS-assigned port
```

It binds **loopback only**, rejects a non-loopback `Host` header (DNS-rebind guard), and has zero front-end dependencies (vanilla HTML/CSS/JS, dark theme, offline - no CDN, no framework). Five tabs:

- **Tools** - every register tool with live search and a **show-hidden** filter; a top-level **surface panel** (the four meta-tools' every-turn toggles + a promotion count and footgun warnings); add a tool (script body, shell, or invoke-less reference); toggle **Enabled** (lean), **Hot** (every-turn promotion), and **Hidden** (declutter this manager list); flip per-tool **execution mode** (reference ↔ gateway); toggle per-tool **Pre/Post hook** gates; remove.
- **MCPs** - upstream MCP servers and their curated-direct expose selections; add an upstream with exposed tools; enable / disable / remove; **Discover** - a live connect-and-list of an upstream's tools, each with its own **lean** (enabled) and **Hot** toggle keyed by the surfaced name.
- **Hooks** - the hook manifest with live enabled state; add a lifecycle hook (optionally authoring its script body); enable / disable / remove.
- **Logs** - the on/off switch for the [audit log](#activity--audit-log) and a newest-first view of recent records.
- **Auth** - configure the optional OAuth 2.1 resource-server validation (off by default) and install its single dependency on demand.

Every UI write goes through the **same stores** the MCP server reads, so an edit is byte-identical to a hand edit (and a CLI edit) and is visible to the running server with no restart.

## Activity & audit log

ToolFunnel can keep a **JSONL** activity/audit log - **off by default** (a fresh checkout writes nothing and creates no log file). When enabled, it records tool runs and **every gate allow/deny decision**. Toggle it three ways, all equivalent:

- the `tf_log` management function - `{ action: "enable" | "disable" | "status" }`;
- the web UI **Logs** tab switch;
- editing `logs/log.config.json` directly (`{ "enabled": bool, "path": "logs/toolfunnel.log.jsonl" }`).

Config is read **fresh per event**, so a toggle takes effect immediately. Logging is wrapped so it can **never** throw into a tool call or the gate, and `tf_log` can itself be disabled to revoke logging control. (The `logs/` directory is git-ignored.)

## Project layout

ToolFunnel keeps a deliberate split between **the engine** (`src/`, which you never edit) and **what you manage** (`tools/`, `mcp/`, `hooks/` - plain config and scripts at the top level):

```
toolfunnel/
├─ bin/toolfunnel.js        # entry point - stdio by default, --http for the host, --ui for the console
├─ src/                     # ToolFunnel's own engine (you never edit this)
│  ├─ mcp/                  #   server, protocol, transports, mcp-client, aggregator, gated-run
│  ├─ core/                 #   hook-engine, hook-loader, hook-runner, matcher, events, logger
│  ├─ tools/                #   the tool SYSTEM (registry, tool-state, drift)
│  ├─ ui/                   #   the optional config web UI (loopback server + vanilla assets)
│  └─ extend/ · packages/
├─ tools/                   # YOUR tools
│  ├─ tools.register.json   #   first-party tool register (7 demos + 8 management functions)
│  ├─ tools.state.json      #   enable/disable overlay (default-ON)
│  └─ scripts/              #   the tool scripts
├─ mcp/                     # YOUR upstreams
│  ├─ expose.json           #   upstream servers + curated tools to expose (empty default)
│  └─ expose.example.json   #   annotated sample
├─ hooks/                   # YOUR policy gate
│  ├─ hooks.manifest.json   #   the gate (empty = allow-all)
│  ├─ hooks.state.json      #   live enable/disable overlay (optional; wins over the manifest seed)
│  └─ scripts/              #   hook command scripts
└─ logs/                    # audit log (git-ignored; created only when logging is enabled)
   ├─ log.config.json       #   { enabled, path } - default OFF
   └─ toolfunnel.log.jsonl  #   the JSONL records (default path)
```

Rule of thumb: `src/` is the gateway machinery; `tools/`, `mcp/`, and `hooks/` are where your configuration lives. The engine resolves these top-level paths relative to the repo root.

## Configuration

All config is plain JSON under the repo - edit it by hand, through the [config web UI](#the-config-web-ui), or via the [management functions](#management-functions):

| File                              | Purpose                                                                 |
|-----------------------------------|-------------------------------------------------------------------------|
| `tools/tools.register.json`   | The first-party tool register (`{ version, description, tools: [...] }`) - 7 demos + 8 management functions |
| `tools/tools.state.json`      | The visibility-matrix overlay, keyed by surfaced name → `{ enabled?, hidden?, hot? }`. Default-ON for `enabled` (empty `{}` enables everything), default-OFF for `hot`/`hidden` (meta-tools default `hot`-ON). Read fresh per call - no restart needed |
| `hooks/hooks.manifest.json`   | The policy gate (`{ version, hooks: [] }`). An empty `hooks` array = allow-all |
| `hooks/hooks.state.json`      | Optional live enable/disable overlay for hooks; an entry here wins over the manifest's seed `enabled` |
| `mcp/expose.json`             | Upstream MCP servers + the curated set of their tools to expose (`{ version, upstreams: [], expose: [] }`). **Empty by default**, so the gateway connects to nothing |
| `mcp/expose.example.json`     | An annotated sample showing how to wire an upstream and expose two of its tools |
| `logs/log.config.json`        | The audit-log toggle (`{ enabled, path }`). **Default OFF**; created only when logging is enabled |

## License

[MIT](LICENSE)
</content>
</invoke>
