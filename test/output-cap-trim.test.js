/**
 * output-cap-trim.test.js - a tool's captured output stops exactly at its cap.
 *
 * The script and shell runners stop reading at a byte cap. The chunk that crosses the cap is cut at the cap,
 * as the hook runner does, so the captured text never exceeds the cap by a pipe chunk (64 KiB on Windows).
 *
 *   1. takeWithinCap keeps whole chunks under the cap, cuts the crossing chunk to the bytes left, and never
 *      splits a multi-byte character.
 *   2. A script tool that writes three times its cap in one write returns at most the cap, and is capped.
 *
 * Run: node test/output-cap-trim.test.js
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let passed = 0;
function ok(label, cond, detail) {
  assert.ok(cond, `${label}${detail ? ` - ${detail}` : ''}`);
  passed++;
  console.log(`ok   - ${label}`);
}

const { takeWithinCap } = require(path.join(__dirname, '..', 'src', 'core', 'output-cap.js'));

// 1. the helper
ok('a chunk under the cap is kept whole', takeWithinCap('abcde', 0, 10) === 'abcde');
ok('the crossing chunk is cut at the cap', takeWithinCap('abcdefghij', 6, 10) === 'abcd');
ok('nothing is kept once the cap is reached', takeWithinCap('abc', 10, 10) === '');
const euro = '€€€'; // 3 bytes each in UTF-8
const cut = takeWithinCap(euro, 0, 7);
ok('a multi-byte character is never split', cut === '€€' && Buffer.byteLength(cut, 'utf8') <= 7, JSON.stringify(cut));

// 2. a real script tool, cap set through the documented env seam (read at module load, hence a child)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-outcap-'));
try {
  const CAP = 50000;
  fs.writeFileSync(path.join(root, 'flood.js'), `process.stdout.write('x'.repeat(${CAP * 3}));\n`);
  const probe = `
    const { defaultRunScript } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'tools', 'registry.js'))});
    defaultRunScript(${JSON.stringify(root)}, { path: 'flood.js' }, null)
      .then((r) => console.log(JSON.stringify({ capped: !!r.outputCapped, bytes: Buffer.byteLength(r.stdout, 'utf8') })))
      .catch((e) => { console.log(JSON.stringify({ error: e.message })); });`;
  const res = spawnSync(process.execPath, ['-e', probe], {
    env: { ...process.env, TOOLFUNNEL_TOOL_OUTPUT_CAP: String(CAP) }, encoding: 'utf8', timeout: 60000,
  });
  const out = JSON.parse((res.stdout || '').trim().split('\n').pop() || '{}');
  ok('a flooding script tool is capped', out.capped === true, JSON.stringify(out));
  ok('its captured output stops exactly at the cap', out.bytes === CAP, `got ${out.bytes} bytes for a ${CAP}-byte cap`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`PASS: output-cap-trim test - ${passed}/${passed} assertions passed (captured output stops at the cap)`);
