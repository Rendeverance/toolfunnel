# Packaging: ship what you built

ToolFunnel's config is a folder. That single fact is the whole packaging story: everything you
build in a gateway — your tools and their scripts, which of them are promoted hot or hidden, the
upstream MCPs you attached and the tools you chose to expose from them, the policy hooks that gate
every call, and the identity the server introduces itself with — lives in one directory tree, the
**config home**. Ship the tree and you have shipped the product.

## The config home

By default the home is the package/clone root — a git clone works exactly as it always did. Point
the gateway elsewhere and the config lives there instead:

```
toolfunnel --config-dir D:\my-setup     # flag (wins)
TOOLFUNNEL_HOME=D:\my-setup toolfunnel  # env var
```

An empty home is **seeded** on first use from the shipped defaults (the register + management
scripts, an empty `mcp/expose.json`, the default hooks manifest) and is **never overwritten**
afterwards — which is the point: with the home outside the package, `npm update toolfunnel`
can never eat your tools.

```
<home>/
  toolfunnel.json         # identity (serverName/serverVersion), port defaults, `requires`
  tools/
    tools.register.json   # your tool entries (incl. their inputSchema)
    tools.state.json      # the hot/hidden/enabled curation — part of the product
    scripts/              # the tool scripts
  mcp/expose.json         # upstream references + curated exposure
  hooks/                  # the policy gate: manifest + hook scripts
```

## `tf_pack` — one call to a deployment artifact

The `tf_pack` management tool snapshots the LIVE setup into `<home>/dist/<name>/` — always a
separate location, never the live tree. `auth/` (environment-specific) and `logs/` never ship.

**`{ format: "home" }`** → a portable config home. Zip it, commit it to a repo, or run it as-is:

```
toolfunnel --config-dir path/to/the-pack
```

**`{ format: "npm", name: "my-mcp", version: "1.0.0" }`** → a publishable npm package:

```
dist/my-mcp/
  package.json      # name, bin, files, dependencies: { "toolfunnel": "^0.4.0" }
  bin/my-mcp.js     # 2 lines: pin --config-dir at ../home, delegate to toolfunnel
  home/             # the bundled config home (identity rewritten to my-mcp@1.0.0)
  README.md         # a stub to make your own
```

Review it, then `cd dist/my-mcp && npm publish`. Your users run `npx my-mcp` and get **your**
server: your name in the MCP `initialize` handshake, your tools with your schemas, your curation,
and — the part nobody else can say — **your gate**. The hooks travel inside the pack and enforce
your policy on the recipient's machine regardless of which MCP client calls it.

### Depend, never copy

The generated package **depends on** `toolfunnel` (caret range) rather than vendoring it. Your own
runtime dependencies go in **your** `package.json` exactly as with any npm package — npm installs
the whole tree on `npx my-mcp`; toolfunnel itself adds zero. Why depending matters:

- security and bug fixes reach every wrapped MCP through a normal `npm update` — no stale forks
  carrying old bugs;
- your package stays a few KB of config instead of a copied engine;
- (and honestly) every install of your MCP counts as a toolfunnel download, which keeps the thing
  you depend on alive.

Your users can move the bundled home out of `node_modules` (so *their* edits survive *your*
updates) via the `<NAME>_HOME` env var the generated launcher supports.

## Declaring runtimes: `requires`

Your tools may need runtimes the gateway doesn't (python, git, ffmpeg…). Declare them in the
home's `toolfunnel.json` and they travel with every pack:

```json
{
  "serverName": "my-mcp",
  "requires": [
    { "command": "python", "min": "3.10", "why": "the pdf-extract tools" },
    { "command": "git" }
  ]
}
```

The gateway probes them once at startup and prints one clear stderr line per problem — found
version vs needed, plus your `why`. Advisory by design: a missing runtime breaks only the tools
that need it, so the server still starts and everything else keeps working.

## Composite packs

A pack is not just your own scripts. Because `mcp/expose.json` lives in the home, a pack carries
**upstream references too**: "attach `@example/weather-mcp` (pin the version) and expose exactly
these four tools under these names." The upstream itself travels as a *reference* — `npx` fetches
it on the recipient's machine — while your **curation** and your **gate** travel as config. One
pack = your tools + other people's servers, curated, renamed, and policed, as a single artifact.

## Audit honesty

Packs spawn commands — that is what they are for. Before you run anyone's pack (including one of
ours), read its `mcp/expose.json` and `tools/tools.register.json`: every command it can spawn is
declared there in plain JSON. Ship your own packs expecting the same scrutiny, and say so in your
README (the `tf_pack` stub already does).
