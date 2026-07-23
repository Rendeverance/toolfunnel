#!/usr/bin/env node
'use strict';
// release.js - one-command release for toolfunnel.
//
//   npm run release                      -> patch bump, full pipeline
//   npm run release -- minor             -> minor bump
//   npm run release -- --notes "..."     -> headline paragraph for the release body
//   npm run release -- --no-npm          -> skip npm publish (GitHub-only release)
//   npm run release -- --dry-run         -> print the plan, mutate nothing
//
// Pipeline: preflight (clean tree, on main, not behind origin) -> npm test ->
// bump package.json -> commit -> tag vX.Y.Z -> push branch + tag -> create GitHub
// Release (token from `git credential fill`, never stored) -> npm publish.
//
// Releases only ever ADD: existing tags, releases and published npm versions
// are never touched (project policy: previous versions are never deleted).
//
// Zero-dependency by design, like everything else in this repo: Node built-ins
// only. serverInfo.version already follows package.json automatically, so the
// entire release surface is this one command.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const NO_NPM = argv.includes('--no-npm');
const notesIdx = argv.indexOf('--notes');
const NOTES = notesIdx !== -1 ? (argv[notesIdx + 1] || '') : '';
const LEVEL = argv.find((a) => ['patch', 'minor', 'major'].includes(a)) || 'patch';

function log(msg) {
  process.stdout.write(msg + '\n');
}
function fail(msg) {
  process.stderr.write('release: ' + msg + '\n');
  process.exit(1);
}
function git(args, opts) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts }).trim();
}

// ── version maths ─────────────────────────────────────────────────────────────
function bump(version, level) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) fail(`package.json version "${version}" is not plain semver`);
  const [maj, min, pat] = m.slice(1).map(Number);
  if (level === 'major') return `${maj + 1}.0.0`;
  if (level === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

// ── GitHub token: per-use from the git credential helper, never written out ───
function githubToken() {
  const r = spawnSync('git', ['credential', 'fill'], {
    cwd: ROOT,
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('password='));
  if (!line) fail('could not obtain a GitHub token from `git credential fill`');
  return line.slice('password='.length);
}

function githubRelease(repoPath, tag, name, body, token) {
  const payload = JSON.stringify({ tag_name: tag, name, body, draft: false, prerelease: false });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: `/repos/${repoPath}/releases`,
        method: 'POST',
        headers: {
          'User-Agent': 'toolfunnel-release-script',
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode === 201) {
            resolve(JSON.parse(data).html_url);
          } else {
            reject(new Error(`GitHub API ${res.statusCode}: ${data.slice(0, 300)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

// ── npm invocation that survives Windows (npm.cmd shim is not spawnable) ──────
function npmRun(args) {
  const cli = process.env.npm_execpath; // set when invoked via `npm run release`
  if (cli && /npm-cli\.js$/.test(cli)) {
    return spawnSync(process.execPath, [cli, ...args], { cwd: ROOT, stdio: 'inherit' });
  }
  return spawnSync('npm', args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
}

// ── main ──────────────────────────────────────────────────────────────────────
(async function main() {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const next = bump(pkg.version, LEVEL);
  const tag = `v${next}`;

  const repoUrl = (pkg.repository && pkg.repository.url) || '';
  const repoMatch = /github\.com[/:]([^/]+\/[^/.]+)/.exec(repoUrl);
  if (!repoMatch) fail('could not derive owner/repo from package.json repository.url');
  const repoPath = repoMatch[1];

  // Preflight - every check is reported in dry-run, enforced for real runs.
  const dirty = git(['status', '--porcelain']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  let behind = 'unknown';
  try {
    // A DRY RUN touches the network not at all - "nothing executed" includes the fetch. This is
    // load-bearing beyond principle: on CI's fresh checkout, a preflight fetch pulled in the tag
    // the release had just pushed, MID-TEST, so release.test.js's "dry-run created no tags"
    // before/after comparison false-positived on every lane. Dry-run compares against the local
    // (possibly stale) origin ref instead; the real run still fetches first.
    if (!DRY) git(['fetch', '--quiet']);
    behind = git(['rev-list', '--count', `HEAD..origin/${branch}`]);
  } catch (_e) {
    /* offline (or no origin ref yet): leave 'unknown'; the push will surface it */
  }

  let prevTag = '';
  try {
    prevTag = git(['describe', '--tags', '--abbrev=0']);
  } catch (_e) {
    /* first release: no previous tag */
  }
  const commitRange = prevTag ? `${prevTag}..HEAD` : 'HEAD';
  const commitList = git(['log', commitRange, '--pretty=format:- %s']);
  const body = (NOTES ? NOTES + '\n\n' : '') + '**Commits:**\n' + (commitList || '- (none)');

  log(`plan: ${pkg.version} -> ${next} (${LEVEL}) on ${branch}, repo ${repoPath}`);
  log(`  tree clean: ${dirty ? 'NO' : 'yes'}   behind origin: ${behind === '0' ? 'no' : behind}`);
  log(`  steps: test -> bump -> commit -> tag ${tag} -> push -> GitHub Release${NO_NPM ? '' : ' -> npm publish'}`);
  log(`  release body:\n${body.split('\n').map((l) => '    ' + l).join('\n')}`);

  if (DRY) {
    log('DRY RUN - nothing executed.');
    return;
  }

  if (dirty) fail('working tree is not clean - commit or stash first');
  if (branch !== 'main') fail(`on branch "${branch}" - releases cut from main only`);
  if (behind !== '0' && behind !== 'unknown') fail(`branch is ${behind} commit(s) behind origin - pull first`);

  log('running tests...');
  const test = npmRun(['test']);
  if (test.status !== 0) fail('test suite failed - release aborted');

  pkg.version = next;
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
  git(['add', 'package.json']);
  git(['commit', '-m', `${tag}: ${NOTES ? NOTES.split('\n')[0] : 'release'}`]);
  git(['tag', tag]);
  git(['push']);
  git(['push', 'origin', tag]);
  log(`pushed ${tag}`);

  const url = await githubRelease(repoPath, tag, tag, body, githubToken());
  log(`GitHub Release: ${url}`);

  if (!NO_NPM) {
    log('publishing to npm (you may be prompted for an OTP)...');
    const pub = npmRun(['publish']);
    if (pub.status !== 0) {
      fail('npm publish failed - the GitHub side is complete; re-run publish manually when ready');
    }
    log(`npm publish: toolfunnel@${next} live`);
  }

  log(`release ${tag} complete.`);
})().catch((e) => fail(e.message));
