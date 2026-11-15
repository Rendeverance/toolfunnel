#!/usr/bin/env node
/**
 * tool-schema-validate.test.js - one broken upstream tool is dropped, loudly; the rest keep working.
 *
 * Validate every tool's schema BEFORE advertising it; on a
 * defect drop that ONE tool and log it, instead of letting one bad descriptor take the set down -
 * degraded, not dead. Checked at the listing chokepoint (_listAndCache), before descriptor approval,
 * so a pathological schema is dropped as one tool instead of breaking the approval hash for the
 * whole upstream. Structural checks (zero-dep, not a full JSON Schema meta-validator):
 *   - inputSchema / outputSchema, when present: a plain object, `type` (if given) "object",
 *     `properties` (if given) a plain object, `required` (if given) an array of strings,
 *     nesting no deeper than MAX_SCHEMA_DEPTH
 *   - description / title, when present: strings; annotations, when present: a plain object
 * A MISSING inputSchema stays tolerated (served as { type: "object" }, as before): the spec requires
 * it, but real servers omit it and nothing about that is dangerous. Present-but-wrong is dropped.
 *
 * Run:  node test/tool-schema-validate.test.js     (exit 0 = pass, non-zero = fail)
 */
'use strict';

const path = require('node:path');
const assert = require('node:assert');
const { useTempHome, REPO_ROOT } = require('./helpers/temp-home');

const HOME = useTempHome({ prefix: 'tf-schema-validate-' }); // claimed before any src/ require
const { Aggregator } = require(path.join(REPO_ROOT, 'src', 'mcp', 'aggregator.js'));

const results = [];
async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); } catch (err) { results.push({ name, ok: false, detail: (err && err.message) || String(err) }); }
}

function deepSchema(levels) {
  let s = { type: 'string' };
  for (let i = 0; i < levels; i++) s = { type: 'object', properties: { x: s } };
  return s;
}
const OK_SCHEMA = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
const TOOLS = [
  { name: 'good', description: 'Fine.', inputSchema: OK_SCHEMA },
  { name: 'noschema', description: 'No inputSchema at all (tolerated).' },
  { name: 'wrongtype', description: 'x', inputSchema: { type: 'string' } },
  { name: 'notobject', description: 'x', inputSchema: 'object' },
  { name: 'badrequired', description: 'x', inputSchema: { type: 'object', required: 'a' } },
  { name: 'badprops', description: 'x', inputSchema: { type: 'object', properties: ['a'] } },
  { name: 'baddesc', description: 42, inputSchema: OK_SCHEMA },
  { name: 'badout', description: 'x', inputSchema: OK_SCHEMA, outputSchema: { type: 'array' } },
  { name: 'deep', description: 'x', inputSchema: deepSchema(5000) },
];
const BAD = ['wrongtype', 'notobject', 'badrequired', 'badprops', 'baddesc', 'badout', 'deep'];

(async () => {
  const calls = [];
  const store = {
    listUpstreams: () => [{ id: 'up', command: 'x', args: [], env: {}, enabled: true }],
    getUpstream: (id) => (id === 'up' ? { id: 'up', command: 'x', args: [], env: {}, enabled: true } : undefined),
    listExposed: () => [],
    exposedName: (e) => `${e.upstream}_${e.tool}`,
  };
  const factory = (upstream) => ({
    id: upstream.id,
    _connected: false,
    get connected() { return this._connected; },
    initializeResult: { protocolVersion: '2024-11-05', serverInfo: { name: 'mixed', version: '1.0.0' } },
    era: 'legacy', eraDefinitive: true, clientInfo: { name: 'toolfunnel', version: 'x' }, onNotification: null, onServerRequest: null,
    async connect() { this._connected = true; return this.initializeResult; },
    async listTools() { return TOOLS.map((x) => ({ ...x })); }, // shallow: a JSON round-trip of the deep schema would overflow HERE
    async callTool(name) { calls.push(name); return { content: [{ type: 'text', text: 'ran ' + name }] }; },
    close() { this._connected = false; },
    respondToServerError() {},
  });
  const agg = new Aggregator({ store, gatewayRoot: HOME.home, clientFactory: factory, onToolsChanged: () => {} });

  const real = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (c, ...r) => { lines.push(String(c)); return real(c, ...r); };
  let res;
  try { res = await agg.connectAll(); } finally { process.stderr.write = real; }

  await check('the upstream still connects (one bad tool does not take it down)', () => {
    assert.deepStrictEqual(res.connected, ['up'], JSON.stringify(res));
  });
  const served = (agg.toolsByUpstream().up || []).map((t) => t.name).sort();
  await check('only the well-formed tools are served; a missing inputSchema is tolerated', () => {
    assert.deepStrictEqual(served, ['good', 'noschema'], 'served: ' + JSON.stringify(served));
    assert.deepStrictEqual(agg.leanToolDefinitions().map((d) => d.tool).sort(), ['good', 'noschema']);
  });
  await check('each dropped tool is named on stderr with its defect, once', () => {
    for (const n of BAD) {
      const hit = lines.filter((l) => l.includes(`"${n}"`) && /dropped/.test(l));
      assert.strictEqual(hit.length, 1, `${n}: ${hit.length} lines: ${JSON.stringify(lines.filter((l) => /dropped/.test(l)).map((l) => l.slice(0, 120)))}`);
    }
    assert.ok(lines.some((l) => l.includes('"wrongtype"') && l.includes('"type"')), 'the defect is not named');
  });
  await check('invalidTools() lists every dropped tool with its problem (the /health source)', () => {
    const inv = agg.invalidTools();
    assert.deepStrictEqual(inv.map((x) => x.tool).sort(), BAD.slice().sort(), JSON.stringify(inv));
    assert.ok(inv.every((x) => x.upstream === 'up' && typeof x.problem === 'string' && x.problem.length));
  });
  await check('a dropped tool is not callable; a good one still runs', async () => {
    assert.strictEqual(agg.resolveLeanExecution('up_wrongtype', {}), null);
    await agg.resolveLeanExecution('up_good', {}).execute();
    assert.deepStrictEqual(calls, ['good']);
  });
  await check('a re-list with the same defects does not repeat the stderr lines', async () => {
    const again = [];
    process.stderr.write = (c, ...r) => { again.push(String(c)); return real(c, ...r); };
    try { await agg.discover('up'); } finally { process.stderr.write = real; }
    assert.strictEqual(again.filter((l) => /dropped/.test(l)).length, 0, JSON.stringify(again));
  });
  await agg.closeAll();

  // /health carries them (live).
  {
    const http = require('node:http');
    const { createHttpMcpServer } = require(path.join(REPO_ROOT, 'src', 'mcp', 'http-transport.js'));
    const realInv = Aggregator.prototype.invalidTools;
    const fake = [{ upstream: 'up', tool: 'wrongtype', problem: 'inputSchema "type" must be "object"' }];
    Aggregator.prototype.invalidTools = () => JSON.parse(JSON.stringify(fake));
    const server = createHttpMcpServer({ host: '127.0.0.1', port: 0 });
    try {
      const { port } = await server.start();
      const body = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/health' }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => resolve(d)); }).on('error', reject);
      });
      await check('/health.invalidTools lists the dropped tools', () => {
        assert.deepStrictEqual(JSON.parse(body).invalidTools, fake, body.slice(0, 300));
      });
    } finally {
      Aggregator.prototype.invalidTools = realInv;
      try { await server.stop(); } catch (_e) { /* ignore */ }
    }
  }

  const EXPECTED = 7;
  for (const r of results) console.log((r.ok ? 'ok   - ' : 'NOT OK - ') + r.name + (r.ok ? '' : '  :: ' + r.detail));
  const passed = results.filter((r) => r.ok).length;
  if (passed === results.length && results.length === EXPECTED) {
    console.log(`\nPASS: tool-schema-validate test - ${passed}/${EXPECTED} assertions passed (bad tools dropped one by one, loudly; the rest served)`);
    process.exit(0);
  }
  console.log(`\nFAIL: tool-schema-validate test - ${passed}/${results.length} assertions passed (expected ${EXPECTED})`);
  process.exit(1);
})().catch((e) => { console.log('TOOL-SCHEMA-VALIDATE TEST CRASHED: ' + ((e && e.stack) || e)); process.exit(2); });
