'use strict';
/**
 * output-cap.js - keep a captured stream within a byte cap.
 *
 * A child's output arrives in chunks (64 KiB pipe reads on Windows). Appending a whole chunk and checking the cap
 * afterwards lets the captured text run past the cap by up to one chunk. takeWithinCap returns the part of a chunk
 * that still fits, ending on a whole character so a multi-byte UTF-8 character is never split.
 */

/**
 * @param {string} text  the decoded chunk
 * @param {number} used  bytes already captured
 * @param {number} max   the cap in bytes
 * @returns {string} the leading part of text whose UTF-8 size fits in max - used
 */
function takeWithinCap(text, used, max) {
  const room = max - used;
  if (room <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= room) return text;
  let bytes = 0;
  let end = 0;
  for (const ch of text) { // by code point, so a surrogate pair is never split either
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > room) break;
    bytes += n;
    end += ch.length;
  }
  return text.slice(0, end);
}

module.exports = { takeWithinCap };
