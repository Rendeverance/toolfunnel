'use strict';

/**
 * howto.js - the loader behind the `toolfunnel_howto` meta-tool (architecture notes §2 + §6).
 *
 * `toolfunnel_howto({ topic })` returns the self-extension instructions for one topic. This module
 * resolves a topic to its authored markdown file (the topic -> file map below) and reads it.
 *
 *   howto(topic) -> string   // the markdown content for that topic
 *
 * Topics: create-tool | add-mcp | add-hook | package | wrap | configure
 * (the original four from §2, plus the 0.6.0 pair - the transparent wrap and the no-code
 * config map - so a primer-less agent can learn the headline feature from inside).
 * Unknown topics THROW (the protocol layer turns that into a clean tool error, not a crash).
 *
 * Isolation: reads are confined to THIS directory (src/extend). The topic map is a fixed
 * allow-list of basenames - there is no path interpolation from the caller, so a malicious
 * `topic` cannot traverse out of src/extend. We additionally re-verify the resolved path is
 * inside this directory (defense-in-depth, mirroring the hook loader's writeScript guard).
 *
 * CommonJS only. Node built-ins only. No transport, pure file read - unit-testable directly.
 */

const fs = require('node:fs');
const path = require('node:path');

// The directory these instruction files live in (this module's own directory).
const EXTEND_DIR = __dirname;

/**
 * Fixed topic -> filename map. The set of keys IS the list of valid topics; the values are
 * plain basenames (no separators) so nothing the caller passes is ever joined into a path.
 * @type {Readonly<Record<string,string>>}
 */
const TOPIC_FILES = Object.freeze({
  'create-tool': 'create-tool.md',
  'add-mcp': 'add-mcp.md',
  'add-hook': 'add-hook.md',
  package: 'package.md',
  wrap: 'wrap.md',
  configure: 'configure.md',
});

/**
 * The valid topic names, for error messages and for callers that want to enumerate
 * (e.g. the protocol layer validating args, or a UI listing the howto topics).
 * @returns {string[]}
 */
function topics() {
  return Object.keys(TOPIC_FILES);
}

/**
 * Resolve a topic to the instruction markdown content.
 *
 * @param {string} topic one of: create-tool | add-mcp | add-hook | package | wrap | configure
 * @returns {string} the UTF-8 markdown content of the matching file
 * @throws {Error} if `topic` is not a string, is unknown, or (defensively) resolves outside
 *                 src/extend or the file is missing.
 */
function howto(topic) {
  if (typeof topic !== 'string' || topic.length === 0) {
    throw new Error(
      `howto: topic must be a non-empty string. Known topics: ${topics().join(', ')}`
    );
  }

  // Look up against the fixed allow-list - own property only (guards against "constructor",
  // "__proto__", etc. resolving via the prototype chain).
  if (!Object.prototype.hasOwnProperty.call(TOPIC_FILES, topic)) {
    throw new Error(
      `howto: unknown topic "${topic}". Known topics: ${topics().join(', ')}`
    );
  }

  const fileName = TOPIC_FILES[topic];
  const filePath = path.join(EXTEND_DIR, fileName);

  // Defense-in-depth: confirm the resolved path is still inside EXTEND_DIR. With a fixed
  // basename map this can never fail, but the guard documents and enforces the isolation rule.
  const rel = path.relative(EXTEND_DIR, filePath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`howto: refusing to read outside src/extend ("${fileName}")`);
  }

  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    // A known topic whose file is missing is a packaging error, not an unknown-topic error.
    throw new Error(
      `howto: instruction file for topic "${topic}" is missing or unreadable ` +
        `(${filePath}): ${(err && err.message) || String(err)}`
    );
  }
}

module.exports = {
  howto,
  topics,
  TOPIC_FILES,
  EXTEND_DIR,
};
