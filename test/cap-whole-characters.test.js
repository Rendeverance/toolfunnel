/**
 * cap-whole-characters.test.js - capped output ends on a whole character, and cut stderr says it was cut.
 *
 *   1. The hook runner cut the crossing chunk by taking a byte overshoot off a UTF-16 index, so output of 4-byte
 *      characters could end in half a surrogate pair. It now cuts with takeWithinCap: never past the cap, never
 *      half a character. Checked on stdout (1 MiB cap) and stderr (256 KiB cap), with the characters set one byte
 *      off the cap so the cut falls inside one.
 *   2. A script tool whose stderr passes the cap kept the first part silently, ending mid-line. It now ends with
 *      "[stderr truncated at cap]".
 *
 * Run: node test/cap-whole-characters.test.js
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runHook } = require('../src/core/hook-runner');

let passed = 0;
function ok(label, cond, detail) {
  assert.ok(cond, `${label}${detail ? ` - ${detail}` : ''}`);
  passed++;
  console.log(`ok   - ${label}`);
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const q = (js) => `node -e "${js.replace(/"/g, '\\"')}"`;
// one ASCII byte first, then 4-byte characters: every cap that is a multiple of 4 falls inside a character
const flood = (stream) => q(`const s=process.${stream}; s.write('x'); const b='\\u{1F600}'.repeat(16384);`
  + ` (function w(){ if(s.write(b)) setImmediate(w); else s.once('drain', w); })();`);

(async () => {
  for (const [stream, cap] of [['stdout', 1024 * 1024], ['stderr', 256 * 1024]]) {
    const r = await runHook({ id: `emoji-${stream}`, event: 'PreToolUse', command: flood(stream), timeout: 20 }, {});
    const text = stream === 'stdout' ? r.stdout : r.stderr.replace(/\n\[hook-runner: stderr truncated at cap\]$/, '');
    ok(`hook ${stream}: capped output has no half character`, !LONE_SURROGATE.test(text),
      JSON.stringify(text.slice(-4)));
    ok(`hook ${stream}: capped output stays within its cap`, Buffer.byteLength(text, 'utf8') <= cap,
      `${Buffer.byteLength(text, 'utf8')} bytes`);
    ok(`hook ${stream}: still fails closed`, r.blocked === true);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-errcap-'));
  try {
    const CAP = 50000;
    fs.writeFileSync(path.join(root, 'noisy.js'), `process.stderr.write('warning\\n'.repeat(${CAP}));\n`);
    const probe = `
      const { defaultRunScript } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'tools', 'registry.js'))});
      defaultRunScript(${JSON.stringify(root)}, { path: 'noisy.js' }, null)
        .then((r) => console.log(JSON.stringify({ code: r.code, tail: r.stderr.slice(-40) })))
        .catch((e) => { console.log(JSON.stringify({ error: e.message })); });`;
    const res = spawnSync(process.execPath, ['-e', probe], {
      env: { ...process.env, TOOLFUNNEL_TOOL_OUTPUT_CAP: String(CAP) }, encoding: 'utf8', timeout: 60000,
    });
    const out = JSON.parse((res.stdout || '').trim().split('\n').pop() || '{}');
    ok('a script tool whose stderr passes the cap says so', /\[stderr truncated at cap\]$/.test(out.tail || ''),
      JSON.stringify(out));
    ok('cutting stderr does not change the exit code', out.code === 0, JSON.stringify(out));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`PASS: cap-whole-characters test - ${passed}/${passed} assertions passed`);
})().catch((e) => { console.error(e.message); process.exit(1); });
