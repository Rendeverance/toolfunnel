'use strict';

/**
 * tool-approvals.js - tool descriptor approval ("hash-pinning").
 *
 * An upstream can change what its tools SAY after you attached it. The description (and every
 * parameter description inside the input schema) goes straight into the model's context, so a
 * changed descriptor is the attack whether or not the tool is ever called. This module holds the
 * PURE rules plus the state file; the aggregator applies them at its single listing chokepoint
 * (_listAndCache) so every listing shows only approved text and every execution path can refuse.
 *
 * Rules, per upstream (evaluate):
 *   - no record yet                      -> FIRST USE: approve every tool as listed.
 *   - same version, a tool changed/new   -> PENDING: the listing keeps the APPROVED descriptor (a new
 *                                           tool stays hidden) and calls refuse until accepted.
 *   - version changed                    -> UPGRADE: auto-approved and reported, unless `strict`
 *                                           (expose.json strictApproval) - then pending as above.
 *   - the server NAME changed            -> the same as a version change (reported as server-changed);
 *                                           never a fresh first use, or a rename would get past strict.
 *   - a server that reports no version   -> the stricter branch (treated as "same version").
 *   - a removed tool                     -> its approval stays (harmless); a pending entry for it goes.
 * Known limit, documented: a hostile maintainer can bump the version too - that is what strict is for.
 *
 * What is hashed: the model-facing fields, as canonical JSON (sorted keys): HASHED_FIELDS. `_meta`
 * and `icons` are presentation and excluded. sha256 from node:crypto (zero-dep).
 *
 * The state file (mcp/tool-approvals.json) is USER STATE, never seeded or shipped. It carries the
 * pending entries too, because the UI and CLI (separate processes) accept by moving pending ->
 * approved in the file. Missing = empty. Unreadable = THROW: treating it as empty would silently
 * approve everything as first use, which is exactly what corrupting it would be for.
 *
 * Tool names and upstream ids come from outside, so every map write goes through put() (an own
 * data property even for "__proto__") and every read through own().
 *
 * CommonJS, node built-ins only.
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const { atomicWriteJson } = require('../core/atomic-write');

const HASHED_FIELDS = ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations'];
const FILE_VERSION = 1;

const hasOwn = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const own = (o, k) => (hasOwn(o, k) ? o[k] : undefined);
function put(o, k, v) {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const str = (v) => (typeof v === 'string' ? v : '');

/** Stable JSON: object keys sorted at every level, undefined members dropped (as JSON does). */
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

/** The hashed, stored and served part of a tool: its HASHED_FIELDS that are present. */
function descriptorOf(tool) {
  const d = {};
  for (const f of HASHED_FIELDS) {
    if (tool && tool[f] !== undefined) put(d, f, clone(tool[f]));
  }
  return d;
}

/** 'sha256:<hex>' over the canonical descriptor. */
function hashTool(tool) {
  return 'sha256:' + crypto.createHash('sha256').update(canonical(descriptorOf(tool)), 'utf8').digest('hex');
}

// C0, DEL, C1 and the bidi controls: a server's text must not drive a terminal or reorder a line.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const NAMED_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** A server's text made safe to print: control and bidi characters shown as escapes. */
function printable(s) {
  return String(s).replace(UNPRINTABLE, (c) => NAMED_ESCAPES[c] || '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** The HASHED_FIELDS that differ between two descriptors (every present one when `approved` is null). */
function changedFields(approved, current) {
  return HASHED_FIELDS.filter((f) => hasOwn(approved, f) !== hasOwn(current, f) || canonical(own(approved, f)) !== canonical(own(current, f)));
}

/**
 * Apply the rules to one upstream's current listing.
 * @param {object}   o
 * @param {object}   [o.record]      this upstream's stored record, or undefined (never approved)
 * @param {object}   [o.serverInfo]  { name, version } the upstream reported this connect
 * @param {object[]} o.tools         the raw tools/list result
 * @param {boolean}  [o.strict]      strictApproval: a version change does not auto-approve
 * @param {string}   [o.now]         ISO time for new entries (tests pass a fixed one)
 * @param {object}   [o.writer]      { pid, id } of the gateway evaluating, stamped on each pending
 *                                   entry as `by` so another run can tell a live writer from a gone one
 * @returns {{ record: object, effective: object[], pending: object[], events: object[], changed: boolean }}
 *   record    the new record to store; effective the tools to SERVE (approved descriptors, in the
 *   upstream's order; unapproved new tools absent); pending [{tool, reason, approved, current,
 *   changed}] for the refusal; events [{kind:'first-use'|'server-changed'|'upgrade', ...}];
 *   changed = the record differs from the one passed in (save it).
 */
function evaluate({ record, serverInfo, tools, strict, now, writer } = {}) {
  const at = typeof now === 'string' && now ? now : new Date().toISOString();
  const seen = { name: str(serverInfo && serverInfo.name), version: str(serverInfo && serverInfo.version) };
  const current = new Map(); // name -> { tool, hash, descriptor }, first occurrence wins (listing order)
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t || typeof t.name !== 'string' || !t.name.length || current.has(t.name)) continue;
    current.set(t.name, { tool: t, hash: hashTool(t), descriptor: descriptorOf(t) });
  }
  const before = record ? canonical(record) : null;
  const events = [];

  if (!record) {
    const approved = {};
    for (const [n, c] of current) put(approved, n, { hash: c.hash, descriptor: c.descriptor, at, how: 'first-use' });
    const rec = { server: { ...seen }, seen: { ...seen }, approved, pending: {} };
    events.push({ kind: 'first-use', tools: [...current.keys()] });
    return { record: rec, effective: [...current.values()].map((c) => c.tool), pending: [], events, changed: true };
  }

  const rec = { server: { ...record.server }, seen: { ...seen }, approved: {}, pending: {} };
  for (const k of Object.keys(record.approved || {})) put(rec.approved, k, record.approved[k]);
  const versionChanged = !!seen.version && !!record.server.version && seen.version !== record.server.version;
  // A different server NAME is an identity change like a version change: approved (and reported)
  // when not strict, pending under strictApproval. It is never a fresh first use - that let a
  // server rename itself past strictApproval, or release a pending change by flipping its name.
  const nameChanged = !!seen.name && !!record.server.name && seen.name !== record.server.name;
  const autoApprove = (versionChanged || nameChanged) && !strict;
  const effective = [];
  const pending = [];
  const upgraded = [];
  for (const [n, c] of current) {
    const a = own(rec.approved, n);
    if (a && a.hash === c.hash) { effective.push(c.tool); continue; }
    const reason = a ? 'changed' : 'new';
    if (autoApprove) {
      put(rec.approved, n, { hash: c.hash, descriptor: c.descriptor, at, how: 'upgrade' });
      effective.push(c.tool);
      upgraded.push({ tool: n, reason });
      continue;
    }
    const prior = own(record.pending, n);
    put(rec.pending, n, {
      hash: c.hash,
      descriptor: c.descriptor,
      since: prior && prior.hash === c.hash && prior.since ? prior.since : at,
      reason,
      ...(writer ? { by: writer } : {}),
    });
    pending.push({
      tool: n,
      hash: c.hash, // what an accept must match: the descriptor the user was shown, not a later one
      reason,
      approved: a ? clone(a.descriptor) : null,
      current: clone(c.descriptor),
      changed: changedFields(a && a.descriptor, c.descriptor),
    });
    if (a) effective.push(clone(a.descriptor)); // serve the APPROVED text; the name is unchanged
  }
  // The approved identity follows the server only while nothing is waiting: a pending change was
  // seen at the new version, and accepting it (accept) is what moves the identity forward.
  if (Object.keys(rec.pending).length === 0) {
    if (seen.name) rec.server.name = seen.name;
    if (seen.version) rec.server.version = seen.version;
  }
  if (upgraded.length && nameChanged) events.push({ kind: 'server-changed', from: record.server.name, to: seen.name, tools: upgraded });
  else if (upgraded.length) events.push({ kind: 'upgrade', from: record.server.version, to: seen.version, tools: upgraded });
  return { record: rec, effective, pending, events, changed: canonical(rec) !== before };
}

/**
 * Several gateways can share one home, each with its own child of an upstream, so each can see a
 * different listing. Before this process writes its record, carry over the pending entries in the
 * STORED record that another process wrote: an entry this record neither holds as pending nor has
 * approved at that hash, and that this process did not write itself (`ownWritten(tool, hash)`; its
 * own entry that it no longer sees means its server reverted, so that one goes), and whose writer
 * is still running (`isAlive(by)`; an entry left by a gateway that has exited - this gateway's own
 * previous run, say - is no one's view any more, and kept it would never clear). One pending slot
 * per tool: this process's own pending entry for a tool wins.
 * @returns {object} a NEW record
 */
function keepForeignPending(stored, next, ownWritten, isAlive) {
  const rec = clone(next);
  if (!rec.pending || typeof rec.pending !== 'object') rec.pending = {};
  const sp = stored && stored.pending && typeof stored.pending === 'object' ? stored.pending : {};
  for (const n of Object.keys(sp)) {
    const e = sp[n];
    if (!e || typeof e.hash !== 'string' || hasOwn(rec.pending, n)) continue;
    const a = own(rec.approved, n);
    if (a && a.hash === e.hash) continue; // accepted since
    if (typeof ownWritten === 'function' && ownWritten(n, e.hash)) continue;
    if (e.by && typeof isAlive === 'function' && !isAlive(e.by)) continue;
    put(rec.pending, n, clone(e));
  }
  return rec;
}

/**
 * Accept pending descriptors: one tool, or every pending one when `toolName` is undefined.
 * @returns {{ record: object, accepted: string[] }} a NEW record (the input is not modified)
 */
function accept(record, toolName, now) {
  const at = typeof now === 'string' && now ? now : new Date().toISOString();
  const rec = clone(record || {});
  if (!rec.approved || typeof rec.approved !== 'object') rec.approved = {};
  if (!rec.pending || typeof rec.pending !== 'object') rec.pending = {};
  const names = toolName === undefined ? Object.keys(rec.pending) : (hasOwn(rec.pending, toolName) ? [toolName] : []);
  for (const n of names) {
    const p = rec.pending[n];
    put(rec.approved, n, { hash: p.hash, descriptor: p.descriptor, at, how: 'accepted' });
    delete rec.pending[n];
  }
  if (Object.keys(rec.pending).length === 0 && rec.seen && rec.server) {
    if (rec.seen.name) rec.server.name = rec.seen.name;
    if (rec.seen.version) rec.server.version = rec.seen.version;
  }
  return { record: rec, accepted: names };
}

// ── the state file ────────────────────────────────────────────────────────────────────────────

function emptyApprovals() {
  return { version: FILE_VERSION, upstreams: {} };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Throw, naming the file and the field, on anything that is not a well-formed approvals file. */
function validateApprovals(doc, filePath) {
  const fail = (what) => { throw new Error(`tool approvals: ${filePath}: ${what}`); };
  if (!isPlainObject(doc)) fail('must be a JSON object');
  if (typeof doc.version !== 'number') fail('"version" must be a number');
  if (!isPlainObject(doc.upstreams)) fail('"upstreams" must be an object keyed by upstream id');
  for (const id of Object.keys(doc.upstreams)) {
    const r = doc.upstreams[id];
    const where = `upstream ${JSON.stringify(id)}`;
    if (!isPlainObject(r)) fail(`${where} must be an object`);
    if (!isPlainObject(r.server) || typeof r.server.name !== 'string' || typeof r.server.version !== 'string') {
      fail(`${where}: "server" must be { name: string, version: string }`);
    }
    for (const part of ['approved', 'pending']) {
      if (!isPlainObject(r[part])) fail(`${where}: "${part}" must be an object keyed by tool name`);
      for (const n of Object.keys(r[part])) {
        const e = r[part][n];
        if (!isPlainObject(e) || typeof e.hash !== 'string' || !e.hash.startsWith('sha256:') || !isPlainObject(e.descriptor)) {
          fail(`${where}: "${part}" entry ${JSON.stringify(n)} must be { hash: "sha256:...", descriptor: {...} }`);
        }
        if (e.descriptor.name !== n) fail(`${where}: "${part}" entry ${JSON.stringify(n)} has a descriptor named ${JSON.stringify(e.descriptor.name)}`);
      }
    }
  }
}

/** Read the approvals file. Missing -> empty. Unreadable or malformed -> throw naming the file. */
function loadApprovals(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyApprovals();
    throw new Error(`tool approvals: cannot read ${filePath}: ${(err && err.message) || String(err)}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`tool approvals: ${filePath} is not valid JSON: ${(err && err.message) || String(err)}`);
  }
  validateApprovals(doc, filePath);
  return doc;
}

/** Write the approvals file atomically (the shared temp + fsync + rename writer). */
function saveApprovals(filePath, doc) {
  // A home without an mcp/ folder must still record first use (else nothing is ever remembered).
  fs.mkdirSync(require('node:path').dirname(filePath), { recursive: true });
  atomicWriteJson(filePath, doc);
}

/**
 * The ONE accept every route shares - the tf_accept_change management tool, the CLI, the UI server
 * and the gateway itself: read the CURRENT file, accept, write it back atomically. With
 * `expectHash`, only if the pending descriptor is still the one the user was shown (a server that
 * changed again is not approved sight unseen). Living in the engine, it reaches every install -
 * including an external config home, whose copied scripts and register never refresh.
 * Throws on an unreadable file.
 * @returns {{ accepted: string[], pending: string[], stale?: true, unknown?: true }}
 */
function acceptInFile(filePath, upstreamId, toolName, expectHash, now) {
  const doc = loadApprovals(filePath);
  const rec = getRecord(doc, upstreamId);
  if (!rec) return { accepted: [], pending: [], unknown: true };
  if (expectHash !== undefined && expectHash !== null) {
    const p = toolName !== undefined ? own(rec.pending, toolName) : undefined;
    if (!p || p.hash !== expectHash) return { accepted: [], pending: Object.keys(rec.pending || {}), stale: true };
  }
  const res = accept(rec, toolName, now);
  if (res.accepted.length) {
    setRecord(doc, upstreamId, res.record);
    saveApprovals(filePath, doc);
  }
  return { accepted: res.accepted, pending: Object.keys(res.record.pending || {}) };
}

/**
 * Every change waiting for acceptance in a loaded doc, flat - the one view the CLI (`changes`) and
 * the UI (/api/tool-changes) both render. Descriptions are the SERVER's text: render as text only.
 * `fields` holds { approved, new } for every other changed field (a schema's parameter descriptions
 * reach the model too, so the user must be able to read them before accepting).
 * @returns {Array<{upstream, tool, reason, since, hash, approvedDescription, newDescription, changed, fields}>}
 */
function listPending(doc) {
  const out = [];
  const ups = (doc && doc.upstreams) || {};
  for (const id of Object.keys(ups)) {
    const rec = ups[id] || {};
    const pend = rec.pending || {};
    for (const name of Object.keys(pend)) {
      const p = pend[name] || {};
      const a = own(rec.approved, name);
      const changed = changedFields(a && a.descriptor, p.descriptor);
      out.push({
        upstream: id,
        tool: name,
        reason: p.reason || (a ? 'changed' : 'new'),
        since: p.since || null,
        hash: p.hash,
        approvedDescription: a && a.descriptor && typeof a.descriptor.description === 'string' ? a.descriptor.description : null,
        newDescription: p.descriptor && typeof p.descriptor.description === 'string' ? p.descriptor.description : null,
        changed,
        fields: Object.fromEntries(changed.filter((f) => f !== 'name' && f !== 'description')
          .map((f) => [f, { approved: a ? own(a.descriptor, f) ?? null : null, new: own(p.descriptor, f) ?? null }])),
      });
    }
  }
  return out;
}

/** Tools approved automatically on a server version upgrade, latest first (at most `limit`). */
function listUpgrades(doc, limit) {
  const out = [];
  const ups = (doc && doc.upstreams) || {};
  for (const id of Object.keys(ups)) {
    const appr = (ups[id] && ups[id].approved) || {};
    for (const name of Object.keys(appr)) {
      if (appr[name] && appr[name].how === 'upgrade') out.push({ upstream: id, tool: name, at: appr[name].at || null });
    }
  }
  out.sort((x, y) => String(y.at).localeCompare(String(x.at)));
  return typeof limit === 'number' ? out.slice(0, limit) : out;
}

/** Why an acceptInFile result accepted nothing (the wording every route shares), or null when it did. */
function acceptFailure(res, upstreamId, toolName) {
  if (res && res.unknown) return `no tool approvals are recorded for upstream "${upstreamId}"`;
  if (res && res.stale) return 'that change is no longer the one pending - the server changed the tool again';
  if (!res || !res.accepted || res.accepted.length === 0) {
    return toolName ? `tool "${toolName}" has no change waiting on upstream "${upstreamId}"` : `upstream "${upstreamId}" has no changes waiting`;
  }
  return null;
}

/** One upstream's record from a loaded doc (own property only), or undefined. */
function getRecord(doc, upstreamId) {
  return own(doc && doc.upstreams, upstreamId);
}

/** Set one upstream's record on a loaded doc (an own property, whatever the id). */
function setRecord(doc, upstreamId, record) {
  put(doc.upstreams, upstreamId, record);
}

module.exports = {
  HASHED_FIELDS,
  canonical,
  descriptorOf,
  hashTool,
  changedFields,
  printable,
  evaluate,
  keepForeignPending,
  accept,
  emptyApprovals,
  validateApprovals,
  loadApprovals,
  saveApprovals,
  getRecord,
  setRecord,
  acceptInFile,
  listPending,
  listUpgrades,
  acceptFailure,
};
