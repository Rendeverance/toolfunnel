# The demo — "Zero code, zero dependencies: your own MCP server in 60 seconds"

Demo-as-code: everything the recording shows is a real, runnable artifact in this folder.
No mockups — `client.js` speaks actual MCP JSON-RPC to the actual gateway.

## Try it (no recording tools needed)

From the repo root:

```bash
node demo/client.js            # initialize → tools/list → a live call
node demo/client.js --denied   # + the gate beat: a server-side DENIED call
```

The client copies `demo/home/` to a temp directory and launches the gateway with
`--config-dir` pointing there, so a demo run never dirties the repo.

## What `demo/home/` is

A complete ToolFunnel **config home** — the thing `tf_pack` ships:

| Piece | The story it tells |
|---|---|
| `tools/scripts/` | Three ordinary scripts in three languages (Python, Bash, Node) — no SDK, no framework |
| `tools/tools.register.json` | One JSON entry per tool: name, `inputSchema`, how to run it |
| `tools/tools.state.json` | The instant-MCP recipe: user tools promoted `hot`, all `toolfunnel_*` meta-tools hidden — the client sees ONLY the user's tools |
| `hooks/` | A PreToolUse policy hook that DENIES the destructive `cleanup` tool — server-side, travels with the pack, holds on any client |
| `toolfunnel.json` | The identity: the server introduces itself as `my-tools 1.0.0`, not "toolfunnel" |

## Rendering the recordings

The tapes are [vhs](https://github.com/charmbracelet/vhs) scripts — deterministic,
re-renderable, reviewable in a diff:

```bash
vhs demo/demo-hero.tape    # → demo/toolfunnel-demo.gif  (the README hero, ~20s)
vhs demo/demo-full.tape    # → demo/toolfunnel-demo.mp4  (the full cut with the gate beat)
```

No local vhs? Docker renders both:

```bash
docker run --rm -v "$PWD:/vhs" ghcr.io/charmbracelet/vhs demo/demo-hero.tape
docker run --rm -v "$PWD:/vhs" ghcr.io/charmbracelet/vhs demo/demo-full.tape
```

Render from the **repo root** (the tapes use repo-relative paths). Only `node` is needed at
record time — the Python/Bash tools are listed (that's the point) but the live call uses the
Node tool, so the recording machine needs no extra runtimes.
