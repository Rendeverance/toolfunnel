# The demo - "Zero code, zero dependencies: your own MCP server in 60 seconds"

Demo-as-code: everything the recording shows is a real, runnable artifact in this folder.
No mockups - `client.js` speaks actual MCP JSON-RPC to the actual gateway.

## Try it (no recording tools needed)

From the repo root:

```bash
node demo/client.js            # initialize → tools/list → a live call
node demo/client.js --denied   # + the gate beat: a server-side DENIED call
```

The client copies `demo/home/` to a temp directory and launches the gateway with
`--config-dir` pointing there, so a demo run never dirties the repo.

## What `demo/home/` is

A complete ToolFunnel **config home** - the thing `tf_pack` ships:

| Piece | The story it tells |
|---|---|
| `tools/scripts/` | Three ordinary scripts in three languages (Python, Bash, Node) - no SDK, no framework |
| `tools/tools.register.json` | One JSON entry per tool: name, `inputSchema`, how to run it |
| `tools/tools.state.json` | The instant-MCP recipe: user tools promoted `hot`, all `toolfunnel_*` meta-tools hidden - the client sees ONLY the user's tools |
| `hooks/` | A PreToolUse policy hook that DENIES the destructive `cleanup` tool - server-side, travels with the pack, holds on any client |
| `toolfunnel.json` | The identity: the server introduces itself as `my-tools 1.0.0`, not "toolfunnel" |

## Rendering the recordings

**The canonical renderer is `demo/render_gif.py`** (Python 3 + Pillow - the recording machine's
tooling, never a ToolFunnel dependency). It runs the REAL client, the REAL `tf_pack`, screenshots
the REAL web UI (headless Edge on Windows), and draws the terminal frames itself - deterministic,
no browser-recording stack to fight:

```bash
python demo/render_gif.py     # → demo/toolfunnel-demo.gif (the README hero, ~60s)
```

The [vhs](https://github.com/charmbracelet/vhs) tapes are kept as an alternative for
machines where vhs works well (it can be temperamental on Windows - which is why the Python
renderer exists):

```bash
vhs demo/demo-hero.tape    # or:  docker run --rm -v "$PWD:/vhs" ghcr.io/charmbracelet/vhs demo/demo-hero.tape
vhs demo/demo-full.tape
```

Render from the **repo root** (repo-relative paths). Only `node` is needed for the demo itself -
the Python/Bash tools are listed (that's the point) but the live call uses the Node tool.
