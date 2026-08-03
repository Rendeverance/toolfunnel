'use strict';

/**
 * curated-collision.test.js - a curated-direct (expose[]) tool must NOT be advertised under a name
 * a LOCAL register tool already owns (0.7.0).
 *
 * handleToolsList block 3 (curated-direct) skipped only names already in byName (meta + local HOT)
 * and reserved meta names - it did NOT skip a name a local tool owns when that local tool is not
 * hot. Block 4 (upstream-hot) DOES skip via localNameTaken, for the stated reason: the advertised
 * name must resolve to what actually runs. So a curated `as:` colliding with a non-hot local tool's
 * id/name was advertised with the UPSTREAM's description + schema, while a call to that name
 * resolves to the local tool - advertise one thing, run another. This pins block 3 to the same
 * guard block 4 has.
 *
 * In-process with a MOCK aggregator + a fake registry that owns the colliding name (mirrors
 * hot-order.test.js). Exit 0 = guard holds. CommonJS.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const REPO_ROOT = path.resolve(__dirname, '..');
const s = require(path.join(REPO_ROOT, 'src', 'mcp', 'server.js'));

let fails = 0;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

(async () => {
  const build = s.buildProtocol();

  const COLLIDE = 'collide_me';   // a local tool owns this name (NOT hot)
  const CLEAN = 'clean_curated';  // no local owns this - the positive control

  // Fake registry: one entry whose id/name is COLLIDE. localNameTaken + localHotDefinitions both
  // only need list() (getEntry is reached only for a HOT tool, and COLLIDE stays non-hot).
  const fakeRegistry = {
    list: () => [{ id: COLLIDE, name: COLLIDE }],
    getEntry: (id) => ({ id }),
  };

  // Mock aggregator: two curated-direct defs, each carrying a DISTINCTIVE upstream description so a
  // mistaken advertisement is unambiguous. No lean/hot upstream tools in play.
  const aggregator = {
    exposedToolDefinitions: () => [
      { name: COLLIDE, description: 'UPSTREAM_DESC_MARKER', inputSchema: { type: 'object', properties: { up: { type: 'string' } } } },
      { name: CLEAN, description: 'CLEAN_UPSTREAM_DESC', inputSchema: { type: 'object' } },
    ],
    leanToolDefinitions: () => [],
    upstreamOrder: () => [],
    isExposed: () => false,
  };

  // Empty state: COLLIDE is not hot (so not advertised as a local), and every tool is enabled by
  // default (so the curated defs pass the block-3 enabled check - the red condition).
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-collision-'));
  const statePath = path.join(stateDir, 'tools.state.json');
  fs.writeFileSync(statePath, '{}\n');

  const list = s.handleToolsList(build.protocol, aggregator, { registry: fakeRegistry, toolStatePath: statePath });
  const tools = list.tools || [];
  const collideDef = tools.find((t) => t.name === COLLIDE);
  const cleanDef = tools.find((t) => t.name === CLEAN);

  // THE GUARD: a curated def must not be advertised under a name a local tool owns. (The non-hot
  // local tool is itself not advertised, so the correct outcome is: this name is absent top-level.)
  check('a curated tool is NOT advertised under a name a local register tool owns',
    !collideDef,
    'got ' + JSON.stringify(collideDef));

  // Belt-and-braces: if it ever IS advertised, it must at least never wear the upstream identity
  // while resolving to the local tool - the exact advertise-one/run-another hazard.
  check('the colliding name never carries the upstream description',
    !collideDef || collideDef.description !== 'UPSTREAM_DESC_MARKER',
    'got ' + JSON.stringify(collideDef));

  // POSITIVE CONTROL: a curated tool whose name no local owns is still advertised, unchanged - the
  // guard must skip ONLY the collision, not curated-direct in general.
  check('a non-colliding curated tool is still advertised with its upstream description',
    !!cleanDef && cleanDef.description === 'CLEAN_UPSTREAM_DESC',
    'got ' + JSON.stringify(cleanDef));

  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }

  console.log(fails ? `\n${fails} curated-collision failure(s).` : '\ncurated-collision guard holds.');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
