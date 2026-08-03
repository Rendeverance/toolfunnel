'use strict';

/**
 * ui-hook-toggle.test.js - the UI's per-tool gate switch must only ever remove the entry its
 * OWN "on" branch authored (0.7.0 defect #1, the critical one).
 *
 * Shipped 0.7.0 filtered the OFF branch with `matches(h.matcher, gateName)`, and
 * core/matcher.matches() returns TRUE for '*', '', null and undefined - so switching ONE tool's
 * Pre gate off deleted every broad hook for that event, INCLUDING the operator's global
 * wildcard gate, and (because the filter ignored `enabled`) disabled hooks too. The UI answered
 * {ok:true} and the config watcher hot-reloaded an ungated gateway. The ON branch used
 * `hookFires` (which requires enabled === true), so the two branches never agreed.
 *
 * Invariants pinned here:
 *   A  OFF removes the literal per-tool entry the ON branch created.
 *   B  OFF leaves a GLOBAL WILDCARD hook untouched (the shipped bug: it was deleted).
 *   C  OFF leaves a broad REGEX hook that also covers this tool untouched.
 *   D  OFF leaves another tool's literal entry, and other-event entries, untouched.
 *   E  OFF leaves a DISABLED literal entry for this very tool untouched-or-removed but never
 *      silently drops unrelated disabled hooks (the enabled-blind filter did).
 *   F  the response tells the operator when a broad hook still gates the tool, instead of
 *      reporting a clean removal that did not happen.
 *   G  a tool whose register NAME is '*' must not delete the operator's global
 *      wildcard gate: the raw-name comparison in the OFF filter was the 0.7.0 hole reopened
 *      through the name field (validateEntry accepts any non-empty string as a name).
 *   H  ON authors this tool's literal entry even when a broader hook already
 *      fires for the tool - "something fires" is not "this tool's gate exists". Until this,
 *      per-tool gating was unreachable behind any wildcard while the UI told the operator to
 *      author a script that nothing would ever run.
 *
 * Drives the real POST /api/tools/hook handler over the real HTTP UI against a scratch config
 * home; the package tree is never touched. Exit 0 = invariants hold; 1 = the shipped bug.
 * Node built-ins only. CommonJS.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

let fails = 0;
function check(label, cond, evidence) {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (cond ? '' : '\n      ' + evidence));
  if (!cond) fails += 1;
}

const GLOBAL_GATE = {
  id: 'pre-tool-use/global-deny',
  event: 'PreToolUse',
  matcher: '*',
  command: 'node "${HOOKS_DIR}/scripts/global-deny.js"',
  enabled: true,
};
const BROAD_REGEX = {
  id: 'pre-tool-use/broad-danger',
  event: 'PreToolUse',
  matcher: 'dang.*',
  command: 'node "${HOOKS_DIR}/scripts/broad.js"',
  enabled: true,
};
const OTHER_TOOL = {
  id: 'pre-tool-use/other-literal',
  event: 'PreToolUse',
  matcher: 'echo',
  command: 'node "${HOOKS_DIR}/scripts/other.js"',
  enabled: true,
};
const DISABLED_UNRELATED = {
  id: 'pre-tool-use/disabled-unrelated',
  event: 'PreToolUse',
  matcher: '*',
  command: 'node "${HOOKS_DIR}/scripts/disabled.js"',
  enabled: false,
};
const POST_EVENT = {
  id: 'post-tool-use/audit',
  event: 'PostToolUse',
  matcher: '*',
  command: 'node "${HOOKS_DIR}/scripts/audit.js"',
  enabled: true,
};

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-uihook-'));
  for (const d of ['mcp', 'hooks', 'tools']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.mkdirSync(path.join(home, 'hooks', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(home, 'tools', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(home, 'tools', 'tools.register.json'), JSON.stringify({
    version: 1,
    tools: [
      { id: 'danger', name: 'danger', summary: 's', category: 'demo', instructions: 'i', invoke: { type: 'script', path: 'scripts/danger.js' } },
      { id: 'echo', name: 'echo', summary: 's', category: 'demo', instructions: 'i', invoke: { type: 'script', path: 'scripts/echo.js' } },
      // The C1 shape: a filename-safe id carrying a register NAME string-equal to the
      // operator's global wildcard matcher. validateEntry accepts any non-empty string.
      { id: 'wild', name: '*', summary: 's', category: 'demo', instructions: 'i', invoke: { type: 'script', path: 'scripts/danger.js' } },
      // A register NAME collision: distinct id, same gate name as 'danger'.
      { id: 'twin', name: 'danger', summary: 's', category: 'demo', instructions: 'i', invoke: { type: 'script', path: 'scripts/danger.js' } },
    ],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(home, 'tools', 'scripts', 'danger.js'), 'console.log("{}");\n');
  fs.writeFileSync(path.join(home, 'tools', 'scripts', 'echo.js'), 'console.log("{}");\n');
  fs.writeFileSync(path.join(home, 'mcp', 'expose.json'), JSON.stringify({ version: 1, upstreams: [], expose: [] }, null, 2) + '\n');
  fs.writeFileSync(path.join(home, 'tools', 'tools.state.json'), '{}\n');
  return home;
}

const writeManifest = (home, hooks) =>
  fs.writeFileSync(path.join(home, 'hooks', 'hooks.manifest.json'), JSON.stringify({ version: 1, hooks }, null, 2) + '\n');
const readManifest = (home) =>
  JSON.parse(fs.readFileSync(path.join(home, 'hooks', 'hooks.manifest.json'), 'utf8')).hooks;

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'GET', path: urlPath,
      headers: { Origin: 'http://127.0.0.1:' + port },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_e) { /* leave null */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const writeOverlay = (home, o) =>
  fs.writeFileSync(path.join(home, 'hooks', 'hooks.state.json'), JSON.stringify(o, null, 2) + '\n');
const readOverlay = (home) => {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'hooks', 'hooks.state.json'), 'utf8')); } catch (_e) { return {}; }
};

function post(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: urlPath,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        Origin: 'http://127.0.0.1:' + port,
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_e) { /* leave null */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  const home = makeHome();
  const { createUiServer } = require(path.join(REPO_ROOT, 'src', 'ui', 'server.js'));
  let handle = null;
  try {
    handle = createUiServer({ host: '127.0.0.1', port: 0, root: home });
    const started = await handle.start();
    const port = started && started.port;
    check('UI bound a port', Number.isInteger(port), JSON.stringify(started));
    if (!Number.isInteger(port)) throw new Error('no port');

    // ── A: the round trip. ON authors a literal entry; OFF removes exactly that one. ──────────
    writeManifest(home, []);
    await post(port, '/api/tools/hook', { id: 'danger', event: 'PreToolUse', on: true });
    const afterOn = readManifest(home);
    check('A: ON authored exactly one literal entry for the tool',
      afterOn.length === 1 && afterOn[0].matcher === 'danger',
      JSON.stringify(afterOn));
    await post(port, '/api/tools/hook', { id: 'danger', event: 'PreToolUse', on: false });
    check('A: OFF removed the literal entry it authored', readManifest(home).length === 0,
      JSON.stringify(readManifest(home)));

    // ── B: THE CRITICAL ONE. A global wildcard gate must survive a per-tool OFF. ──────────────
    writeManifest(home, [JSON.parse(JSON.stringify(GLOBAL_GATE))]);
    const rB = await post(port, '/api/tools/hook', { id: 'danger', event: 'PreToolUse', on: false });
    const afterB = readManifest(home);
    check('B: a GLOBAL WILDCARD gate SURVIVES turning one tool\'s gate off',
      afterB.length === 1 && afterB[0].matcher === '*',
      JSON.stringify(afterB) + ' (0.7.0 deleted it: matches("*", name) is true, so the whole gateway went ungated)');

    // ── C: a broad regex that also covers this tool must survive. ─────────────────────────────
    writeManifest(home, [JSON.parse(JSON.stringify(BROAD_REGEX))]);
    await post(port, '/api/tools/hook', { id: 'danger', event: 'PreToolUse', on: false });
    const afterC = readManifest(home);
    check('C: a broad REGEX hook covering the tool SURVIVES',
      afterC.length === 1 && afterC[0].matcher === 'dang.*', JSON.stringify(afterC));

    // ── D: another tool's literal entry and another event's entry must survive. ───────────────
    writeManifest(home, [
      { event: 'PreToolUse', matcher: 'danger', command: 'node "${HOOKS_DIR}/scripts/danger-pretooluse.js"', enabled: true },
      JSON.parse(JSON.stringify(OTHER_TOOL)),
      JSON.parse(JSON.stringify(POST_EVENT)),
    ]);
    await post(port, '/api/tools/hook', { id: 'danger', event: 'PreToolUse', on: false });
    const afterD = readManifest(home);
    check('D: other tools\' and other events\' entries SURVIVE; only this tool\'s literal goes',
      afterD.length === 2 && afterD.some((h) => h.matcher === 'echo') && afterD.some((h) => h.event === 'PostToolUse'),
      JSON.stringify(afterD));

    // ── E: an unrelated DISABLED wildcard hook must survive (the filter ignored `enabled`). ───
    writeManifest(home, [JSON.parse(JSON.stringify(DISABLED_UNRELATED))]);
    await post(port, '/api/tools/hook', { id: 'danger', event: 'PreToolUse', on: false });
    const afterE = readManifest(home);
    check('E: an unrelated DISABLED hook SURVIVES', afterE.length === 1,
      JSON.stringify(afterE) + ' (0.7.0 destroyed disabled hooks too)');

    // ── F: the operator is TOLD when a broad hook still gates the tool. ───────────────────────
    writeManifest(home, [JSON.parse(JSON.stringify(GLOBAL_GATE))]);
    const rF = await post(port, '/api/tools/hook', { id: 'danger', event: 'PreToolUse', on: false });
    const noteF = (rF.json && (rF.json.note || rF.json.warning)) || '';
    check('F: the response WARNS that a broad hook still gates this tool',
      rF.status === 200 && /still|broad|wildcard|global/i.test(String(noteF)),
      JSON.stringify(rF.json) + ' (a bare {ok:true} reads as "gate removed" when it was not)');
    // ── G: (C1) a tool NAMED '*' must not be a deletion primitive for the global gate. ────────
    writeManifest(home, [JSON.parse(JSON.stringify(GLOBAL_GATE))]);
    const rG = await post(port, '/api/tools/hook', { id: 'wild', event: 'PreToolUse', on: false });
    const afterG = readManifest(home);
    check('G: a tool NAMED "*" cannot delete the operator\'s global wildcard gate',
      rG.status === 200 && afterG.length === 1 && afterG[0].matcher === '*',
      JSON.stringify({ response: rG.json, manifest: afterG })
      + ' (the raw-name comparison made any register name string-equal to a broader matcher a deletion primitive)');

    // ── H: (H6) ON must author the literal entry even when a wildcard already fires. ──────────
    writeManifest(home, [JSON.parse(JSON.stringify(GLOBAL_GATE))]);
    const rH = await post(port, '/api/tools/hook', { id: 'danger', event: 'PreToolUse', on: true });
    const afterH = readManifest(home);
    check('H: ON authors the per-tool literal entry even with a global wildcard present',
      rH.status === 200 && afterH.length === 2 && afterH.some((h) => h.matcher === 'danger' && h.enabled === true),
      JSON.stringify({ response: rH.json, manifest: afterH })
      + ' ("some enabled hook fires" was treated as "this tool\'s gate exists", so the authored script could never run)');

    // ── H2: ON with an own DISABLED literal re-enables it rather than duplicating. ────────────
    writeManifest(home, [
      { event: 'PreToolUse', matcher: 'danger', command: 'node "${HOOKS_DIR}/scripts/danger-pretooluse.js"', enabled: false },
    ]);
    await post(port, '/api/tools/hook', { id: 'danger', event: 'PreToolUse', on: true });
    const afterH2 = readManifest(home);
    check('H2: ON re-enables an existing disabled literal instead of duplicating it',
      afterH2.length === 1 && afterH2[0].enabled === true && afterH2[0].matcher === 'danger',
      JSON.stringify(afterH2));
    // ── I: ON must never claim a script path the wired command does not reference. ────────────
    // The switch adopts an entry matching (event, matcher). If that entry was authored by hand on
    // the Hooks tab - or by a SIBLING tool sharing this one's register `name` - its command runs a
    // DIFFERENT script, while the response hands back this tool's per-id path and tells the
    // operator to write their policy there. They write it; nothing ever runs it. Same
    // "dead gate presented as live" class as the matcher bug, reached through the command field.
    writeManifest(home, [{
      event: 'PreToolUse',
      matcher: 'danger',
      command: 'node "${HOOKS_DIR}/scripts/my-own-policy.js"',
      enabled: true,
    }]);
    const rI = await post(port, '/api/tools/hook', { id: 'danger', event: 'PreToolUse', on: true });
    check('I: ON reports the script the WIRED command actually runs, not an invented per-id path',
      rI.status === 200 && /my-own-policy\.js/.test(String((rI.json && rI.json.scriptPath) || ''))
        && !/danger-pretooluse\.js/.test(String((rI.json && rI.json.scriptPath) || '')),
      JSON.stringify(rI.json) + ' (the operator would author a script nothing references)');
    check('I: the response says the command was pre-existing, not authored here',
      /existing|already|hand|Hooks tab/i.test(String((rI.json && rI.json.note) || '')),
      JSON.stringify(rI.json && rI.json.note));

    // ── J: a register `name` collision must not silently merge two tools into one gate. ───────
    // gateNameFor is `name || id` and validateEntry never constrains `name`, so two tools can
    // collapse onto one matcher: turning the first OFF then leaves the second silently ungated.
    writeManifest(home, []);
    await post(port, '/api/tools/hook', { id: 'danger', event: 'PreToolUse', on: true });
    const rJ = await post(port, '/api/tools/hook', { id: 'twin', event: 'PreToolUse', on: true });
    check('J: a second tool sharing a register name is REFUSED a gate (ambiguous gate identity)',
      rJ.status === 409 || rJ.status === 400,
      JSON.stringify(rJ.json) + ' (both tools resolve to gate name "danger"; one switch would own the other\'s gate)');
    // ── K: (A1) OFF must work even when the gate NAME has since become ambiguous. ─────────────
    // An own literal can exist from before a rival appeared in the register (twin authored while
    // its name was unique; 'danger' arrived later). The collision 409 exists to stop ON from
    // minting a switch that owns somebody else's gate - OFF removes only this tool's own
    // (event, matcher, command) entry, which is unambiguous whatever the register says. Refusing
    // OFF leaves the operator with a live gate and no control that can disarm it.
    writeManifest(home, [
      { event: 'PreToolUse', matcher: 'danger', command: 'node "${HOOKS_DIR}/scripts/twin-pretooluse.js"', enabled: true },
      { event: 'PreToolUse', matcher: 'danger', command: 'node "${HOOKS_DIR}/scripts/danger-pretooluse.js"', enabled: true },
    ]);
    const rK = await post(port, '/api/tools/hook', { id: 'twin', event: 'PreToolUse', on: false });
    const afterK = readManifest(home);
    check('K: OFF succeeds for a tool whose gate name is now ambiguous (only ON needs the 409)',
      rK.status === 200 && afterK.length === 1 && /danger-pretooluse\.js/.test(String(afterK[0].command)),
      JSON.stringify({ response: rK.json, manifest: afterK })
      + ' (the collision 409 sat above the on-branch and refused OFF too: a live gate with no control to disarm it)');

    // ── L: (A2) ON must never ARM somebody else's deliberately DISABLED hook. ─────────────────
    // The foreign-adopt branch set enabled=true on a hand-authored disabled entry, then told the
    // operator it "was left as-is" - and OFF (own-literal only, by design) could never turn it
    // back off. A one-way arming device for a policy hook the operator deliberately switched off.
    writeManifest(home, [{
      event: 'PreToolUse',
      matcher: 'danger',
      command: 'node "${HOOKS_DIR}/scripts/my-own-policy.js"',
      enabled: false,
    }]);
    const rL = await post(port, '/api/tools/hook', { id: 'danger', event: 'PreToolUse', on: true });
    const afterL = readManifest(home);
    check('L: a DISABLED foreign hook at this gate is NOT armed by ON',
      afterL.length === 1 && afterL[0].enabled === false,
      JSON.stringify({ response: rL.json, manifest: afterL })
      + ' (ON armed a hand-authored disabled hook that OFF can never restore)');
    check('L: the operator is REFUSED with a pointer at the real entry, not told "left as-is"',
      rL.status === 409 && /Hooks tab/i.test(String((rL.json && rL.json.error) || '')),
      JSON.stringify(rL.json));
    // ── M: (N1) the Tools tab must report the state the GATEWAY will run, not the raw manifest. ──
    // Two writers, two stores: the Hooks tab (setEnabled) writes the hooks.state.json OVERLAY,
    // which WINS at load (hook-loader.js, documented precedence); the Tools tab wrote and read the
    // RAW manifest. An operator could disable a gate on the Hooks tab, re-enable it on the Tools
    // tab, and get a switch showing ON while the gateway ran no gate at all - silent, and failing
    // in the unsafe direction. The switch must read - and write - EFFECTIVE state.
    const OWN_DANGER = 'node "${HOOKS_DIR}/scripts/danger-pretooluse.js"';

    // M1: overlay OFF beats manifest ON - and the switch must say so.
    writeManifest(home, [{ id: 'op/gate', event: 'PreToolUse', matcher: 'danger', command: OWN_DANGER, enabled: true }]);
    writeOverlay(home, { 'op/gate': false });
    const rM1 = await get(port, '/api/tools');
    const tM1 = (Array.isArray(rM1.json) ? rM1.json : []).find((t) => t && t.id === 'danger') || {};
    check('M1: an overlay-DISABLED gate reads OFF on the Tools tab (the overlay is what the gateway loads)',
      tM1.preOwn === false && tM1.pre === false,
      JSON.stringify({ preOwn: tM1.preOwn, pre: tM1.pre })
      + ' (the switch read the raw manifest: UI shows ON while the gateway runs no gate)');

    // M2: the mirror direction - overlay ON beats manifest OFF.
    writeManifest(home, [{ id: 'op/gate', event: 'PreToolUse', matcher: 'danger', command: OWN_DANGER, enabled: false }]);
    writeOverlay(home, { 'op/gate': true });
    const rM2 = await get(port, '/api/tools');
    const tM2 = (Array.isArray(rM2.json) ? rM2.json : []).find((t) => t && t.id === 'danger') || {};
    check('M2: an overlay-ENABLED gate reads ON (the gateway WILL run it; the switch must not deny it)',
      tM2.preOwn === true, JSON.stringify({ preOwn: tM2.preOwn }));

    // M3: ON must reconcile the overlay, not flip the manifest underneath it. The seed is the
    // DISCRIMINATING state - manifest ON + overlay OFF: a raw-manifest read calls this "already
    // on" and writes nothing (N1 exactly), while the effective read sees the overlay's OFF and
    // reconciles it. Seeding manifest OFF here would let both reads reach the write branch and
    // pin nothing.
    writeManifest(home, [{ id: 'op/gate', event: 'PreToolUse', matcher: 'danger', command: OWN_DANGER, enabled: true }]);
    writeOverlay(home, { 'op/gate': false });
    const rM3 = await post(port, '/api/tools/hook', { id: 'danger', event: 'PreToolUse', on: true });
    const ovM3 = readOverlay(home);
    check('M3: Tools-tab ON leaves the EFFECTIVE state enabled (overlay reconciled, gateway will gate)',
      rM3.status === 200 && ovM3['op/gate'] === true,
      JSON.stringify({ response: rM3.json, overlay: ovM3 })
      + ' (manifest true + overlay false = switch shows ON, gateway ungated - N1 exactly)');

    // M4: a FOREIGN entry at this matcher is gating the tool, but it is not this tool's OWN switch.
    writeManifest(home, [{ event: 'PreToolUse', matcher: 'danger', command: 'node "${HOOKS_DIR}/scripts/my-own-policy.js"', enabled: true }]);
    writeOverlay(home, {});
    const rM4 = await get(port, '/api/tools');
    const tM4 = (Array.isArray(rM4.json) ? rM4.json : []).find((t) => t && t.id === 'danger') || {};
    check('M4: a foreign entry at the same matcher reads pre (gated) but NOT preOwn (own switch)',
      tM4.preOwn === false && tM4.pre === true,
      JSON.stringify({ preOwn: tM4.preOwn, pre: tM4.pre })
      + ' (preOwn ignored the command, so the switch claimed somebody else\'s hook as its own state)');

    // M5: OFF removes the row AND its overlay key. A stray key is not inert: applyState lays the
    // overlay over the manifest at every load, so a future hook adopting the id boots in the stale
    // recorded state.
    writeManifest(home, [{ id: 'op/gate', event: 'PreToolUse', matcher: 'danger', command: OWN_DANGER, enabled: true }]);
    writeOverlay(home, { 'op/gate': true });
    const rM5 = await post(port, '/api/tools/hook', { id: 'danger', event: 'PreToolUse', on: false });
    const ovM5 = readOverlay(home);
    check('M5: OFF drops the removed entry\'s overlay key (strays pre-arm a future adoptee)',
      rM5.status === 200 && !Object.prototype.hasOwnProperty.call(ovM5, 'op/gate'),
      JSON.stringify({ response: rM5.json, overlay: ovM5 }));

    // ── N: the UI must read the overlay the way the GATEWAY reads it. ─────────────────────────
    // hook-loader.normalizeState accepts a flat map OR the wrapped { enabled: {...} } form; the
    // gateway obeys whichever it finds. If the UI reads the raw parse instead, a wrapped file
    // splits the two: the switch reports the manifest while the gateway runs the wrapper - and a
    // POST merge-writes a flat key the gateway then ignores (the wrapper wins in normalizeState).
    // The judge for what the gateway would load is normalizeState itself.
    const { normalizeState } = require(path.join(REPO_ROOT, 'src', 'core', 'hook-loader.js'));

    // N1: a wrapped overlay disabling the gate must read OFF on the Tools tab.
    writeManifest(home, [{ id: 'op/gate', event: 'PreToolUse', matcher: 'danger', command: OWN_DANGER, enabled: true }]);
    writeOverlay(home, { enabled: { 'op/gate': false } });
    const rN1 = await get(port, '/api/tools');
    const tN1 = (Array.isArray(rN1.json) ? rN1.json : []).find((t) => t && t.id === 'danger') || {};
    check('N1: a WRAPPED overlay disabling the gate reads OFF (the gateway obeys the wrapper)',
      tN1.preOwn === false && tN1.pre === false,
      JSON.stringify({ preOwn: tN1.preOwn, pre: tN1.pre })
      + ' (the UI read the raw parse: switch shows ON while the gateway runs no gate)');

    // N2: ON against that state must produce a file the GATEWAY reads as enabled - not a flat
    // key appended beside a wrapper that keeps winning.
    const rN2 = await post(port, '/api/tools/hook', { id: 'danger', event: 'PreToolUse', on: true });
    const gwN2 = normalizeState(readOverlay(home));
    check('N2: after ON, the overlay AS THE GATEWAY LOADS IT says enabled (no wrapper shadowing)',
      rN2.status === 200 && gwN2['op/gate'] === true,
      JSON.stringify({ response: rN2.json, overlay: readOverlay(home), gatewayView: gwN2 })
      + ' (POST 200 but the gateway still loads the wrapper: an ungated gateway behind an ON switch)');

    // ── O: a toggle write must not strip unknown top-level manifest keys. ─────────────────────
    // readManifest() rebuilt {version, hooks} only, and all three toggle write-sites persist
    // that object - so any hand-added top-level key (an operator note, a fork's metadata)
    // vanished on the first toggle. The loader's own writers re-read the RAW file and mutate
    // it in place; the UI copy is the sibling that dropped everything else.
    fs.writeFileSync(path.join(home, 'hooks', 'hooks.manifest.json'), JSON.stringify({
      version: 1,
      'x-operator-note': 'keep-me',
      hooks: [],
    }, null, 2) + '\n');
    writeOverlay(home, {});
    const rO = await post(port, '/api/tools/hook', { id: 'danger', event: 'PreToolUse', on: true });
    const rawO = JSON.parse(fs.readFileSync(path.join(home, 'hooks', 'hooks.manifest.json'), 'utf8'));
    check('O: an unknown top-level manifest key SURVIVES a toggle write',
      rO.status === 200 && rawO['x-operator-note'] === 'keep-me',
      JSON.stringify({ response: rO.json, manifest: rawO }));

    void rI;
    void rB;
  } catch (err) {
    console.log('CRASHED: ' + ((err && err.stack) || err));
    fails += 1;
  } finally {
    try { if (handle && typeof handle.stop === 'function') await handle.stop(); } catch (_e) { /* ignore */ }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }

  console.log(fails ? `\n${fails} ui-hook-toggle failure(s).` : '\nthe per-tool gate switch only ever removes its own entry.');
  process.exit(fails ? 1 : 0);
})();
