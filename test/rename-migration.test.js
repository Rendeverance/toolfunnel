'use strict';

/**
 * rename-migration.test.js - the migration module's EDGES (0.7.0). The
 * rename-safety.test.js invariants are the acceptance; this file pins the mechanism's contract:
 *
 *   - exact-literal matchers (escapeRegex shape, including names WITH regex specials) migrate;
 *   - wildcard matchers ('', '*') are untouched (they already cover the new name);
 *   - matchers that fire for the old name but are NOT the literal shape REFUSE the rename,
 *     and the refusal leaves EVERY file untouched (expose/register included);
 *   - non-matching matchers are untouched;
 *   - tools.state.json keys move; a DIFFERING collision on the new key refuses;
 *   - an enabled-flip and removeExpose migrate too (the surfaced name falls back to the
 *     namespaced default);
 *   - Registry display-name renames share the same contract.
 *
 * In-process against a scratch config-home layout. Exit 0 = contract holds. CommonJS.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const { loadExposeStore } = require(path.join(REPO_ROOT, 'src', 'mcp', 'expose-store.js'));
const { loadRegistry } = require(path.join(REPO_ROOT, 'src', 'tools', 'registry.js'));

let fails = 0;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

/** Fresh scratch home with the standard layout and the given configs. */
function makeHome(o) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-renmig-'));
  for (const d of ['mcp', 'hooks', 'tools']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const paths = {
    home,
    expose: path.join(home, 'mcp', 'expose.json'),
    hooks: path.join(home, 'hooks', 'hooks.manifest.json'),
    state: path.join(home, 'tools', 'tools.state.json'),
    register: path.join(home, 'tools', 'tools.register.json'),
  };
  if (o.expose) fs.writeFileSync(paths.expose, JSON.stringify(o.expose, null, 2) + '\n');
  if (o.hooks) fs.writeFileSync(paths.hooks, JSON.stringify(o.hooks, null, 2) + '\n');
  if (o.state) fs.writeFileSync(paths.state, JSON.stringify(o.state, null, 2) + '\n');
  if (o.register) fs.writeFileSync(paths.register, JSON.stringify(o.register, null, 2) + '\n');
  return paths;
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const EXPOSE = (asName, enabled) => ({
  version: 1,
  upstreams: [{ id: 'up', transport: 'stdio', command: 'node', args: ['x.js'], enabled: true }],
  expose: [{ upstream: 'up', tool: 'my.tool', as: asName, category: '', enabled: enabled !== false }],
});
const HOOK = (id, matcher) => ({
  id, event: 'PreToolUse', matcher, type: 'command', command: 'node x.js', timeout: 5, enabled: true,
});

(async () => {
  // 1. Exact-literal matcher WITH regex specials migrates; wildcard + unrelated untouched.
  {
    const p = makeHome({
      expose: EXPOSE('alias.v1'),
      hooks: { version: 1, hooks: [HOOK('lit', 'alias\\.v1'), HOOK('wild', '*'), HOOK('other', 'some_other_tool')] },
      state: { 'alias.v1': { enabled: false, hot: true } },
    });
    loadExposeStore(p.expose).updateExpose('up', 'my.tool', { as: 'alias.v2' });
    const hooks = readJson(p.hooks).hooks;
    const state = readJson(p.state);
    check('exact-literal matcher (specials escaped) migrated to the new literal',
      hooks.find((h) => h.id === 'lit').matcher === 'alias\\.v2',
      'matcher = ' + hooks.find((h) => h.id === 'lit').matcher);
    check('wildcard matcher untouched', hooks.find((h) => h.id === 'wild').matcher === '*', JSON.stringify(hooks));
    check('unrelated matcher untouched', hooks.find((h) => h.id === 'other').matcher === 'some_other_tool', JSON.stringify(hooks));
    check('state entry moved to the new key, content intact',
      state['alias.v2'] && state['alias.v2'].enabled === false && state['alias.v2'].hot === true &&
        !Object.prototype.hasOwnProperty.call(state, 'alias.v1'),
      JSON.stringify(state));
  }

  // 2. A NON-literal matcher that fires for the old name refuses - and NOTHING was written.
  {
    const p = makeHome({
      expose: EXPOSE('rt_alias'),
      hooks: { version: 1, hooks: [HOOK('pattern', 'rt_.*')] },
      state: { rt_alias: { enabled: false } },
    });
    const exposeBefore = fs.readFileSync(p.expose, 'utf8');
    const hooksBefore = fs.readFileSync(p.hooks, 'utf8');
    const stateBefore = fs.readFileSync(p.state, 'utf8');
    let err = null;
    try { loadExposeStore(p.expose).updateExpose('up', 'my.tool', { as: 'other_name' }); } catch (e) { err = e; }
    check('non-literal matching matcher refuses the rename, naming the hook',
      err && /refused/.test(err.message) && /pattern/.test(err.message), String(err && err.message));
    check('refusal left expose.json untouched', fs.readFileSync(p.expose, 'utf8') === exposeBefore, 'expose changed');
    check('refusal left hooks + state untouched',
      fs.readFileSync(p.hooks, 'utf8') === hooksBefore && fs.readFileSync(p.state, 'utf8') === stateBefore,
      'a config file changed on a refused rename');
  }

  // 3. State-key collision with DIFFERENT content refuses; IDENTICAL content passes.
  {
    const p = makeHome({
      expose: EXPOSE('a1'),
      state: { a1: { enabled: false }, a2: { enabled: true } },
    });
    let err = null;
    try { loadExposeStore(p.expose).updateExpose('up', 'my.tool', { as: 'a2' }); } catch (e) { err = e; }
    check('differing state collision on the new key refuses', err && /collision/.test(err.message), String(err && err.message));

    const p2 = makeHome({ expose: EXPOSE('b1'), state: { b1: { enabled: false }, b2: { enabled: false } } });
    loadExposeStore(p2.expose).updateExpose('up', 'my.tool', { as: 'b2' });
    const st = readJson(p2.state);
    check('identical collision passes (old key folded in)',
      st.b2 && st.b2.enabled === false && !Object.prototype.hasOwnProperty.call(st, 'b1'), JSON.stringify(st));
  }

  // 4. An enabled FLIP renames the surface to the namespaced default - state follows.
  {
    const p = makeHome({ expose: EXPOSE('nice_name'), state: { nice_name: { enabled: false } } });
    loadExposeStore(p.expose).updateExpose('up', 'my.tool', { enabled: false });
    const st = readJson(p.state);
    check('disable-flip migrates the state key to the namespaced default',
      st['up_my.tool'] && st['up_my.tool'].enabled === false && !st.nice_name, JSON.stringify(st));
  }

  // 5. removeExpose migrates alias -> default too.
  {
    const p = makeHome({ expose: EXPOSE('going_away'), state: { going_away: { hot: true } } });
    loadExposeStore(p.expose).removeExpose('up', 'my.tool');
    const st = readJson(p.state);
    check('removeExpose migrates the state key back to the namespaced default',
      st['up_my.tool'] && st['up_my.tool'].hot === true && !st.going_away, JSON.stringify(st));
  }

  // 6. Registry display-name rename: literal matcher migrates, state key does NOT (a LOCAL
  //    tool's state is keyed by its register id, not its display name - migrating it orphans
  //    the entry and a disabled tool resurrects; rename-safety S5); non-literal refuses +
  //    register untouched.
  {
    const p = makeHome({
      register: { version: 1, tools: [{ id: 'echo', name: 'Echo', summary: 's', instructions: 'i', invoke: { type: 'shell', command: 'echo hi' } }] },
      hooks: { version: 1, hooks: [HOOK('lit', 'Echo')] },
      state: { Echo: { enabled: false } },
    });
    loadRegistry(p.register).update('echo', { name: 'Echo Renamed' });
    check('registry rename migrated the literal matcher',
      readJson(p.hooks).hooks[0].matcher === 'Echo Renamed', JSON.stringify(readJson(p.hooks).hooks));
    check('registry rename left the state key alone',
      !!readJson(p.state).Echo && !readJson(p.state)['Echo Renamed'], JSON.stringify(readJson(p.state)));

    const q = makeHome({
      register: { version: 1, tools: [{ id: 'echo', name: 'Echo', summary: 's', instructions: 'i', invoke: { type: 'shell', command: 'echo hi' } }] },
      hooks: { version: 1, hooks: [HOOK('pat', 'Ech.')] },
    });
    const regBefore = fs.readFileSync(q.register, 'utf8');
    let err = null;
    try { loadRegistry(q.register).update('echo', { name: 'Echo2' }); } catch (e) { err = e; }
    check('registry rename refused on a non-literal matching matcher',
      err && /refused/.test(err.message), String(err && err.message));
    check('refused registry rename left the register untouched',
      fs.readFileSync(q.register, 'utf8') === regBefore, 'register changed');
  }

  // 7. A hook matcher that does not COMPILE cannot be evaluated against the old name, so the
  //    migration cannot know whether it fires - it refuses, naming the hook, and leaves every
  //    file untouched (the same policy as a matching non-literal: never proceed past a matcher
  //    it cannot read). Class sweep of the matcher-compile fix (matcher-compile.test.js).
  {
    const p = makeHome({
      expose: EXPOSE('nice_name'),
      hooks: { version: 1, hooks: [HOOK('broken', 'nice_name(')] },
      state: { nice_name: { enabled: false } },
    });
    const before = { hooks: fs.readFileSync(p.hooks, 'utf8'), state: fs.readFileSync(p.state, 'utf8'), expose: fs.readFileSync(p.expose, 'utf8') };
    let err = null;
    try { loadExposeStore(p.expose).updateExpose('up', 'my.tool', { as: 'renamed' }); } catch (e) { err = e; }
    check('rename refused when a hook matcher does not compile',
      !!(err && /refused/.test(err.message) && /broken/.test(err.message)), String(err && err.message));
    check('refused rename (uncompilable matcher) left every file untouched',
      fs.readFileSync(p.hooks, 'utf8') === before.hooks
        && fs.readFileSync(p.state, 'utf8') === before.state
        && fs.readFileSync(p.expose, 'utf8') === before.expose,
      'a file changed');
  }

  console.log(fails ? `\n${fails} rename-migration failure(s).` : '\nrename-migration contract holds.');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('CRASHED: ' + (e.stack || e)); process.exit(2); });
