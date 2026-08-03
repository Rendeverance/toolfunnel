'use strict';

/**
 * meta-upstream.js - fixture upstream whose tools carry EVERY metadata field the 0.7.0 plan
 * proposes to forward: title, annotations, outputSchema, icons, _meta, execution.
 *
 * Without this fixture, the metadata-forwarding diff is invisible: the bundled mock-upstream's tools are
 * metadata-bare, so "strip everything" and "forward everything" capture identically.
 *
 * Legacy-era (2024-11-05 handshake), newline-delimited JSON over stdio, accepts BOTH newline and
 * Content-Length framed input (reads line-wise like the bundled mock). Node built-ins only.
 *
 * Tools:
 *   meta_rich  - carries title/annotations/outputSchema/icons/_meta/execution; call returns
 *                text + structuredContent conforming to the outputSchema.
 *   meta_plain - deliberately bare (the control: proves selective-add never invents fields).
 *
 * Env-gated modes (defaults byte-identical - the goldens depend on that):
 *   TF_META_PAGINATE=1  - tools/list serves two pages.
 *   TF_META_LOGLEVEL    - '1'|'nocap': meta_echo tool + logging/setLevel recorder + x/echo-meta
 *                         raw probe; '1' also declares the logging capability.
 *   TF_META_MODERN=1    - speak the MODERN era: server/discover answered, per-request _meta
 *                         accepted (the modern-upstream half).
 */

const readline = require('node:readline');

// ── Env-gated modes. Default behaviour is BYTE-IDENTICAL without them (goldens). ──
// TF_META_LOGLEVEL: '1' = declare the `logging` capability + serve meta_echo + record
//                   logging/setLevel; 'nocap' = same tool + recorder but NO capability declared
//                   (proves the client never sends setLevel to an upstream that didn't offer it).
// TF_META_MODERN:   '1' = speak the MODERN era (server/discover, no initialize handshake).
const LOGLEVEL_MODE = process.env.TF_META_LOGLEVEL || '';
const MODERN_MODE = process.env.TF_META_MODERN === '1';
// TF_META_CAPS=1: declare the full capability spread (resources/prompts/completions/
// tasks) and answer each namespace's representative method - the wrap-honesty receipts.
const CAPS_MODE = process.env.TF_META_CAPS === '1';
const setLevels = []; // every logging/setLevel level received, in arrival order

const TOOLS = [
  {
    name: 'meta_rich',
    title: 'Meta Rich Tool',
    description: 'fixture tool carrying every forwardable metadata field',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    outputSchema: {
      type: 'object',
      properties: { answer: { type: 'string' }, count: { type: 'number' } },
      required: ['answer'],
    },
    annotations: { title: 'Meta Rich (annotation title)', readOnlyHint: true, openWorldHint: false },
    icons: [{ src: 'https://meta-upstream.invalid/icon-32.png', sizes: ['32x32'], mimeType: 'image/png' }],
    _meta: { 'fixture.meta-upstream/marker': 'RICH_TOOL_META_d41c' },
    execution: { taskSupport: 'optional' },
  },
  {
    name: 'meta_plain',
    description: 'fixture tool with no optional metadata at all',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'meta_error',
    description: 'fixture tool that always answers with a raw JSON-RPC error carrying rich data',
    inputSchema: { type: 'object', properties: {} },
  },
];

if (LOGLEVEL_MODE) {
  TOOLS.push({
    name: 'meta_echo',
    description: 'fixture tool that echoes the _meta it received plus every setLevel seen so far',
    inputSchema: { type: 'object', properties: {} },
  });
}

// TF_META_XMCP=1: tools carrying x-mcp-header annotations - one valid pair, one
// INVALID (annotation on a `number` param - forbidden) and one OFF-CHAIN (inside items).
// The gateway must validate mirrored Mcp-Param-* headers for the valid ones and STRIP the
// invalid annotations at ingest (a malformed annotation makes conforming clients drop the
// whole tool). Env-gated: default bytes are golden-pinned.
if (process.env.TF_META_XMCP === '1') {
  TOOLS.push({
    name: 'hdr_tool',
    description: 'valid x-mcp-header annotations (string + integer)',
    inputSchema: {
      type: 'object',
      properties: {
        region: { type: 'string', 'x-mcp-header': 'Region' },
        count: { type: 'integer', 'x-mcp-header': 'Count' },
        plain: { type: 'string' },
      },
    },
  });
  TOOLS.push({
    name: 'hdr_bad',
    description: 'INVALID annotations: on a number param, and off-chain inside items',
    inputSchema: {
      type: 'object',
      properties: {
        ratio: { type: 'number', 'x-mcp-header': 'Ratio' },
        list: { type: 'array', items: { type: 'string', 'x-mcp-header': 'Deep' } },
        ok: { type: 'string' },
      },
    },
  });
}

// TF_META_SLOW=1: a tool that answers after ~3s - long enough for a client to
// disconnect mid-call. Env-gated: default bytes are golden-pinned.
if (process.env.TF_META_SLOW === '1') {
  TOOLS.push({ name: 'slow', description: 'answers after 3 seconds', inputSchema: { type: 'object', properties: {} } });
}

// TF_META_ELICIT='form'|'url' (items 5.1-5.3): tool `ask` holds its call open and sends a
// server-initiated elicitation/create - form-shaped (no mode: pre-MRTR legacy) or url-shaped
// (no mode: the url IS the mode signal). The held call completes when the answer arrives,
// echoing the outcome. Env-gated: default bytes are golden-pinned.
const ELICIT_MODE = process.env.TF_META_ELICIT || '';
// TF_META_RES=1: declare resources with subscribe support and RECORD every
// resources/subscribe|unsubscribe into the file named by TF_SUBS_LOG (observable across
// gateway teardowns). Env-gated: default bytes are golden-pinned.
const RES_MODE = process.env.TF_META_RES === '1';
const SUBS_LOG = process.env.TF_SUBS_LOG || '';
function logSub(line) {
  if (!SUBS_LOG) return;
  try { require('node:fs').appendFileSync(SUBS_LOG, line + '\n'); } catch (_e) { /* best-effort */ }
}
let elicitPending = null; // { callId, eid }
let elicitSeq = 9000;
if (ELICIT_MODE) {
  TOOLS.push({ name: 'ask', description: 'holds the call and elicits', inputSchema: { type: 'object', properties: {} } });
}
if (ELICIT_MODE === 'url') {
  // A rider on the url-mode work: URL mode's SECOND delivery path - the tool answers with a raw
  // URLElicitationRequiredError (-32042) whose data carries the elicitations list. A client on a
  // direct connection completes the URL flow from that error; the gateway must not destroy it.
  TOOLS.push({ name: 'url_required', description: 'returns URLElicitationRequiredError', inputSchema: { type: 'object', properties: {} } });
}

// Conformance: real 2025-11-25 servers obey "Servers MUST NOT send elicitation
// requests with modes that are not supported by the client" - form is supported by the BARE
// presence of `elicitation` (empty object = implicit form-only), url ONLY by the explicit
// `elicitation.url`. The gate reads the initialize-declared capability (legacy) or the call's
// per-request _meta declaration (modern). Without this gate the url relay test passes
// VACUOUSLY - the exact trap the audit named.
let initElicitCaps; // undefined until initialize declares (or not)
function elicitModeAllowed(callParams) {
  let el = initElicitCaps;
  if (el === undefined) {
    const m = callParams && callParams._meta && callParams._meta['io.modelcontextprotocol/clientCapabilities'];
    el = m && m.elicitation;
  }
  if (!el || typeof el !== 'object') return false; // no declaration -> no elicitation of any mode
  return ELICIT_MODE === 'url' ? !!el.url : true;
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function handle(msg) {
  if (!msg || typeof msg !== 'object' || msg.id === undefined) return; // notification - ignore
  const { id, method, params } = msg;
  switch (method) {
    case 'server/discover':
      // Modern mode only: a real DiscoverResult (supportedVersions is what the client's
      // misdetection guard checks). Legacy mode answers -32601 via the default arm below.
      if (MODERN_MODE) {
        return respond(id, {
          resultType: 'complete',
          supportedVersions: ['2026-07-28'],
          capabilities: LOGLEVEL_MODE === '1' ? { tools: {}, logging: {} } : { tools: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'meta-upstream', version: '1.0.0' } },
        });
      }
      return respondError(id, -32601, 'method not supported by meta-upstream: ' + String(method));
    case 'initialize': {
      initElicitCaps = params && params.capabilities ? params.capabilities.elicitation : null;
      let capabilities = { tools: {} };
      if (LOGLEVEL_MODE === '1') capabilities = { tools: {}, logging: {} };
      if (RES_MODE) capabilities = { tools: {}, resources: { subscribe: true, listChanged: true } };
      if (CAPS_MODE) {
        capabilities = {
          tools: {},
          resources: { subscribe: true, listChanged: true },
          prompts: { listChanged: true },
          completions: {},
          tasks: {},
        };
      }
      return respond(id, {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'meta-upstream', version: '1.0.0', title: 'Metadata Fixture Upstream' },
        capabilities,
      });
    }
    case 'prompts/list':
      if (CAPS_MODE) return respond(id, { prompts: [{ name: 'fixture_prompt', description: 'CAP_PROMPT_5f2' }] });
      return respondError(id, -32601, 'method not supported by meta-upstream: ' + String(method));
    case 'completion/complete':
      if (CAPS_MODE) return respond(id, { completion: { values: ['CAP_COMPLETION_5f3'], total: 1, hasMore: false } });
      return respondError(id, -32601, 'method not supported by meta-upstream: ' + String(method));
    case 'tasks/list':
      if (CAPS_MODE) return respond(id, { tasks: [{ taskId: 'task-77', status: 'working' }] });
      return respondError(id, -32601, 'method not supported by meta-upstream: ' + String(method));
    case 'x/emit-task-status':
      // Answer, then EMIT the 2025-11-25 task-status notification - the wrap must relay it
      // (a tasks-capable server's client would see it on a direct connection).
      if (CAPS_MODE) {
        respond(id, { emitted: true });
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', method: 'notifications/tasks/status',
          params: { taskId: 'task-77', status: 'completed', ttl: null, createdAt: '2026-01-01T00:00:00Z' },
        }) + '\n');
        return;
      }
      return respondError(id, -32601, 'method not supported by meta-upstream: ' + String(method));
    case 'resources/subscribe':
      if (RES_MODE) { logSub('subscribe ' + (params && params.uri)); return respond(id, {}); }
      return respondError(id, -32601, 'method not supported by meta-upstream: ' + String(method));
    case 'resources/unsubscribe':
      if (RES_MODE) { logSub('unsubscribe ' + (params && params.uri)); return respond(id, {}); }
      return respondError(id, -32601, 'method not supported by meta-upstream: ' + String(method));
    case 'resources/list':
      if (RES_MODE) return respond(id, { resources: [{ uri: 'meta://res/live', name: 'live fixture resource' }] });
      // CAPS_MODE arm lives below (both modes answering keeps them independent).
      if (CAPS_MODE) return respond(id, { resources: [{ uri: 'meta://res/1', name: 'fixture resource CAP_RES_5f1' }] });
      return respondError(id, -32601, 'method not supported by meta-upstream: ' + String(method));
    case 'logging/setLevel':
      // Recorder for BOTH loglevel modes - in 'nocap' a recorded call proves the client sent
      // setLevel to an upstream that never declared the logging capability (a violation).
      if (LOGLEVEL_MODE) {
        setLevels.push(params && params.level);
        return respond(id, {});
      }
      return respondError(id, -32601, 'method not supported by meta-upstream: ' + String(method));
    case 'x/echo-meta':
      // Raw-forward probe (forwardWrapped path): reflect the _meta this process actually received.
      if (LOGLEVEL_MODE) {
        return respond(id, { receivedMeta: (params && params._meta) !== undefined ? params._meta : null, setLevels: setLevels.slice() });
      }
      return respondError(id, -32601, 'method not supported by meta-upstream: ' + String(method));
    case 'tools/list': {
      // Pagination mode (TF_META_PAGINATE=1): serve page 1 = [meta_rich] + nextCursor, page 2 =
      // the rest. A single-shot lister sees ONE tool and cannot reach the others (0.7.0).
      // Without the env var the behaviour is byte-identical to before (goldens depend on that).
      if (process.env.TF_META_PAGINATE === '1') {
        const cursor = params && params.cursor;
        if (cursor === 'meta-page-2') return respond(id, { tools: TOOLS.slice(1) });
        if (cursor !== undefined) return respondError(id, -32602, 'unknown cursor: ' + String(cursor));
        return respond(id, { tools: TOOLS.slice(0, 1), nextCursor: 'meta-page-2' });
      }
      return respond(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = params && params.name;
      if (name === 'meta_rich') {
        const structured = { answer: 'rich answer for ' + ((params.arguments || {}).q || ''), count: 1 };
        const result = {
          content: [{ type: 'text', text: JSON.stringify(structured) }],
          structuredContent: structured,
          isError: false,
        };
        // TF_META_RESULTMETA=1 (result side): the call result carries _meta with an
        // app key AND a protocol-identity key - the funnel must forward the former and strip
        // the latter (it owns its own identity). Env-gated: default bytes are golden-pinned.
        if (process.env.TF_META_RESULTMETA === '1') {
          result._meta = {
            'fixture.meta-upstream/result-marker': 'RESULT_META_e55b',
            'io.modelcontextprotocol/serverInfo': { name: 'meta-upstream-imposter', version: '9.9.9' },
          };
        }
        return respond(id, result);
      }
      if (name === 'meta_plain') {
        return respond(id, { content: [{ type: 'text', text: 'plain answer' }], isError: false });
      }
      if (name === 'meta_echo' && LOGLEVEL_MODE) {
        // Snapshot of setLevels AT CALL TIME - stdio is ordered, so a setLevel issued BEFORE this
        // call is visible in the snapshot and one issued after is not. That IS the ordering proof.
        const snapshot = { receivedMeta: params._meta !== undefined ? params._meta : null, setLevels: setLevels.slice() };
        return respond(id, { content: [{ type: 'text', text: JSON.stringify(snapshot) }], isError: false });
      }
      if ((name === 'hdr_tool' || name === 'hdr_bad') && process.env.TF_META_XMCP === '1') {
        return respond(id, { content: [{ type: 'text', text: 'hdr-args:' + JSON.stringify(params.arguments || {}) }], isError: false });
      }
      if (name === 'ask' && ELICIT_MODE) {
        // Conformance gate (2.7): a mode the client did not declare is NEVER sent - the call
        // completes immediately with a distinguishable refusal instead.
        if (!elicitModeAllowed(params)) {
          return respond(id, {
            content: [{ type: 'text', text: 'elicit-refused:mode-not-declared clientElicitation:' + JSON.stringify(initElicitCaps === undefined ? null : initElicitCaps) }],
            isError: false,
          });
        }
        const eid = ++elicitSeq;
        elicitPending = { callId: id, eid };
        const eparams = ELICIT_MODE === 'url'
          ? { message: 'Visit to authorise', url: 'https://example.invalid/auth' }
          : { message: 'Pick a colour', requestedSchema: { type: 'object', properties: { colour: { type: 'string' } }, required: ['colour'] } };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: eid, method: 'elicitation/create', params: eparams }) + '\n');
        return; // the call is HELD until the elicit answer arrives
      }
      if (name === 'url_required' && ELICIT_MODE === 'url') {
        // The -32042 second delivery path (2.7 rider) - raw error, elicitations in data.
        return process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id,
          error: {
            code: -32042,
            message: 'URL elicitation required',
            data: { elicitations: [{ message: 'Visit to authorise', url: 'https://example.invalid/auth', mode: 'url' }] },
          },
        }) + '\n');
      }
      if (name === 'slow' && process.env.TF_META_SLOW === '1') {
        setTimeout(() => respond(id, { content: [{ type: 'text', text: 'slow-done' }], isError: false }), 3000);
        return;
      }
      if (name === 'meta_error') {
        // A RAW JSON-RPC error with code + message + structured data - the wrap's byte-for-byte
        // relay promise is measured against exactly this (0.7.0).
        return process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id,
          error: {
            code: -32011,
            message: 'fixture upstream error: the upstream explains exactly what went wrong',
            data: { detail: 'STRUCTURED_DETAIL_77aa', hint: 'this object must survive the relay' },
          },
        }) + '\n');
      }
      return respondError(id, -32602, 'unknown tool: ' + String(name));
    }
    case 'ping':
      return respond(id, {});
    default:
      return respondError(id, -32601, 'method not supported by meta-upstream: ' + String(method));
  }
}

// Line-wise reader: tolerates Content-Length framed input by ignoring non-JSON lines.
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t || t[0] !== '{') return;
  let msg;
  try { msg = JSON.parse(t); } catch (_e) { return; }
  // A RESPONSE to our own elicitation (id matches, no method): complete the held call, echoing
  // the outcome the client (or the gateway's auto-decline) gave us.
  if (elicitPending && msg && msg.id === elicitPending.eid && msg.method === undefined) {
    const held = elicitPending.callId;
    elicitPending = null;
    respond(held, {
      content: [{ type: 'text', text: 'elicit-outcome:' + JSON.stringify(msg.result !== undefined ? msg.result : msg.error) }],
      isError: false,
    });
    return;
  }
  try { handle(msg); } catch (_e) { /* a fixture must never crash mid-capture */ }
});
process.stdin.on('end', () => process.exit(0));
