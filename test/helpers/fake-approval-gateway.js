'use strict';

/**
 * fake-approval-gateway.js - an Aggregator over one fake legacy upstream "fs" (no processes) whose
 * listing, reported server version and call log the test controls. Shared by the tool-approval
 * tests. Change `state.tools` / `state.version`, then `agg.discover('fs')`.
 *
 * The aggregator is required on first use, so a test can claim its temp home before any src/
 * module loads.
 */

const path = require('node:path');
const { REPO_ROOT } = require('./temp-home');

const tool = (name, description) => ({ name, description, inputSchema: { type: 'object', properties: {} } });
const BASE = () => [tool('read', 'Read a file.'), tool('write', 'Write a file.')];

/**
 * @param {object}   o
 * @param {string}   o.root       the gateway's config home
 * @param {string}   [o.version]  the server version reported at connect (default '1.0.0')
 * @param {object[]} [o.tools]    the listing (default read + write)
 * @param {boolean}  [o.strict]   strictApproval on the upstream
 * @returns {{ state: { version: string, tools: object[], calls: string[] }, agg: object }}
 */
function makeGateway(o) {
  const { Aggregator } = require(path.join(REPO_ROOT, 'src', 'mcp', 'aggregator.js'));
  const state = { version: o.version || '1.0.0', tools: o.tools || BASE(), calls: [] };
  const upstreams = [{ id: 'fs', command: 'x', args: [], env: {}, enabled: true, strictApproval: !!o.strict }];
  const store = {
    listUpstreams: () => upstreams.map((u) => ({ ...u })),
    getUpstream: (id) => { const u = upstreams.find((x) => x.id === id); return u ? { ...u } : undefined; },
    listExposed: () => [{ upstream: 'fs', tool: 'read', as: 'fs_read', enabled: true }, { upstream: 'fs', tool: 'write', as: 'fs_write', enabled: true }],
    exposedName: (e) => e.as || `${e.upstream}_${e.tool}`,
  };
  const factory = (upstream) => ({
    id: upstream.id,
    _connected: false,
    get connected() { return this._connected; },
    get initializeResult() { return { protocolVersion: '2024-11-05', serverInfo: { name: 'fs-server', version: state.version } }; },
    era: 'legacy',
    eraDefinitive: true,
    clientInfo: { name: 'toolfunnel', version: 'x' },
    onNotification: null,
    onServerRequest: null,
    async connect() { this._connected = true; return this.initializeResult; },
    async listTools() { return state.tools.map((t) => ({ ...t })); },
    async callTool(name) { state.calls.push(name); return { content: [{ type: 'text', text: `ran ${name}` }] }; },
    async request(method, params) { state.calls.push(params && params.name); return { content: [{ type: 'text', text: `ran ${params && params.name}` }] }; },
    close() { this._connected = false; },
    respondToServerError() {},
  });
  const agg = new Aggregator({ store, gatewayRoot: o.root, clientFactory: factory, onToolsChanged: () => {} });
  return { state, agg };
}

module.exports = { makeGateway, tool, BASE };
