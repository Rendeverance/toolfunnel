# Releasing

The entire release surface is one command:

```bash
npm run release                          # patch bump: test → commit → tag → push → GitHub Release → npm publish
npm run release -- minor                 # minor bump (or: major)
npm run release -- --notes "headline"    # headline paragraph for the release notes
npm run release -- --no-npm              # GitHub-only release (skip npm publish)
npm run release -- --dry-run             # print the full plan, execute nothing
```

What it does, in order:

1. **Preflight** — refuses to run on a dirty tree, off `main`, or behind `origin/main`.
2. **Tests** — the full suite must pass or the release aborts before anything mutates.
3. **Bump** — rewrites `package.json` (the server's `serverInfo.version` follows it automatically).
4. **Commit + tag** — one commit (`vX.Y.Z: <headline>`), one annotated tag, both pushed.
5. **GitHub Release** — created via the API. Auth comes per-use from `git credential fill`;
   the token is never written to disk or printed. Release body = your `--notes` headline
   plus the commit subjects since the previous tag.
6. **npm publish** — interactive (you may be prompted for an OTP). If it fails, the GitHub
   side is already complete; re-run `npm publish` by hand when ready.

Policy: releases only ever **add**. Existing tags, GitHub Releases and published npm
versions are never deleted, overwritten, or re-pointed. If a release is bad, ship a fixed
version on top.

Directory listings (Glama, awesome-mcp-servers and similar) crawl the GitHub side on
their own schedules — publishing a GitHub Release is the strongest signal they consume.
Nothing extra to do per release.
