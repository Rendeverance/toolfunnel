# Contributing to ToolFunnel

Thanks for the interest — contributions are welcome, and small focused ones are the
most welcome of all.

## Ground rules

- **Zero runtime dependencies is a design pillar, not an accident.** PRs that add a
  runtime dependency will be declined unless there is a truly exceptional case (the
  only current exception pattern: optional, on-demand installs like the OAuth `jose`
  helper). Dev-dependencies are viewed almost as sceptically.
- **One PR, one concern.** A bug fix, a feature, or a refactor — not all three.
- **Tests come with the change.** If it can regress, it needs a test.
- **No badge, SEO, or marketing PRs.** They will be closed without much ceremony.

## Getting set up

```bash
git clone https://github.com/Rendeverance/toolfunnel
cd toolfunnel
# Node >= 18, no npm install needed for the core (zero deps)
npm test                 # unit suite (test/run-all.js)
npm run test:integration # real-MCP + HTTP client integration tests
```

## Before you open the PR

1. `npm test` passes clean.
2. If you touched the transports, auth, or the gate: run the integration tests too.
3. Update the README/docs if behaviour changed.
4. Keep the diff readable — match the style of the code around you.

## Bugs and ideas

Use the issue templates. For anything security-relevant, **don't open a public
issue** — see [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree your contribution is licensed under the project's
[MIT licence](../LICENSE).
