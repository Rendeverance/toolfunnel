'use strict';

/**
 * hot-order.test.js - hot-upstream advertisement iterates in STORE order (0.7.0).
 *
 * 0.6.0's handleToolsList block 4 walks leanToolDefinitions() in CONNECTION-map order - a
 * death/recovery re-insertion re-orders the map, so the advertised top-level surface silently
 * shuffles between restarts (the exact class the first audit caught in v1's sort). The fix
 * ranks by the expose store's upstream sequence (the one order that never moves), original
 * order within an upstream, unknown upstreams last.
 *
 * In-process with a MOCK aggregator whose lean defs arrive in REVERSED store order - the
 * red-provable simulation of a recovery re-insertion. Exit 0 = stable order. CommonJS.
 */

const path = require('node:path');
const REPO_ROOT = path.resolve(__dirname, '..');
const s = require(path.join(REPO_ROOT, 'src', 'mcp', 'server.js'));

let fails = 0;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

(async () => {
  const build = s.buildProtocol();

  // Mock aggregator: store order says [alpha, beta]; the connection map recovered beta FIRST.
  const mkDef = (up, tool) => ({
    name: `${up}_${tool}`, description: 'd', inputSchema: { type: 'object' }, upstream: up, tool,
  });
  build.aggregator = {
    leanToolDefinitions: () => [mkDef('beta', 'b1'), mkDef('beta', 'b2'), mkDef('alpha', 'a1')],
    upstreamOrder: () => ['alpha', 'beta'],
    exposedToolDefinitions: () => [],
    isExposed: () => false,
  };

  // Hot-promote all three via a state overlay file? Simpler: monkey the state path away and use
  // the real overlay - write a scratch state file.
  const fs = require('node:fs');
  const os = require('node:os');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-hotorder-'));
  const statePath = path.join(stateDir, 'tools.state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    alpha_a1: { hot: true }, beta_b1: { hot: true }, beta_b2: { hot: true },
  }));
  build.toolStatePath = statePath;

  const list = s.handleToolsList(build.protocol, build.aggregator, {
    registry: build.registry, toolStatePath: statePath,
  });
  const names = (list.tools || []).map((t) => t.name).filter((n) => /^(alpha|beta)_/.test(n));
  check('hot upstream tools advertised in STORE order (alpha before beta) despite reversed lean order',
    JSON.stringify(names) === JSON.stringify(['alpha_a1', 'beta_b1', 'beta_b2']),
    'got ' + JSON.stringify(names));

  console.log(fails ? `\n${fails} hot-order failure(s).` : '\nhot-order contract holds.');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
