'use strict';
/**
 * tool-args.js - hand a tool its structured arguments.
 *
 * A tool gets its arguments as JSON in the environment variable TOOLFUNNEL_TOOL_ARGS. A script tool that says it reads
 * them from stdin (its file names TOOLFUNNEL_TOOL_ARGS_STDIN) gets the same JSON on stdin as well; any other tool,
 * and every shell tool, gets an empty stdin, as before 0.8.2, so a command that reads stdin as code never receives them. An environment variable has a size limit (128 KiB for one variable on Linux, about 1 MiB for all of them
 * together on macOS), and a spawn over it fails with E2BIG. So when a spawn with the variable fails that way, the
 * tool is started again without it and with TOOLFUNNEL_TOOL_ARGS_STDIN=1: the arguments are then on stdin only.
 * That happens only for a tool that says it reads them there (its script or command names TOOLFUNNEL_TOOL_ARGS_STDIN);
 * any other tool would run without its arguments, so for it the spawn fails, naming the fix.
 */

const ARGS_ENV = 'TOOLFUNNEL_TOOL_ARGS';
const STDIN_FLAG = 'TOOLFUNNEL_TOOL_ARGS_STDIN';

// the errors a spawn gives when its environment is too big; dropping the arguments' variable may cure them even
// when the rest of the environment is what filled it
const TOO_BIG = new Set(['E2BIG', 'ENAMETOOLONG']);
// EINVAL has other causes too, so it counts only with big arguments
const SMALL = 32 * 1024;

/** The arguments as the JSON a tool reads. */
function argsJson(args) {
  return JSON.stringify(args == null ? null : args);
}

/** The environment for a tool: the gateway's own, plus the arguments (or, on stdin only, the flag saying so). */
function argsEnv(json, onStdinOnly) {
  const env = { ...process.env };
  if (onStdinOnly) {
    delete env[ARGS_ENV];
    env[STDIN_FLAG] = '1';
  } else {
    env[ARGS_ENV] = json;
    delete env[STDIN_FLAG];
  }
  return env;
}

/** Whether a script's text says it reads its arguments from stdin. Never used for a shell command. */
function readsStdinArgs(text) {
  return typeof text === 'string' && text.includes(STDIN_FLAG);
}

/** Whether a spawn failure was the environment being too big for the arguments. */
function tooBig(err, json) {
  if (!err) return false;
  return TOO_BIG.has(err.code) || (err.code === 'EINVAL' && Buffer.byteLength(json, 'utf8') > SMALL);
}

/**
 * Spawn a tool with its arguments in the environment and on stdin; if the environment is too big for them, spawn
 * it again with them on stdin only. start(env) does the spawn and returns the child, with stdin as a pipe. Node
 * throws E2BIG from spawn() itself (only ENOENT-like failures arrive later as an 'error' event), so a retry here
 * never follows a child that has started. Throws what the last spawn threw.
 */
function spawnWithArgs(json, start, readsStdin) {
  let child;
  try {
    child = start(argsEnv(json, false));
  } catch (err) {
    if (!tooBig(err, json)) throw err;
    if (!readsStdin) {
      const e = new Error(`the arguments (${Buffer.byteLength(json, 'utf8')} bytes) are too big for the environment ` +
        `(${err.code}). A tool takes arguments of any size on stdin when it reads them there while ${ARGS_ENV} is ` +
        `absent and ${STDIN_FLAG}=1 (toolfunnel_howto create-tool).`);
      e.code = err.code;
      throw e;
    }
    child = start(argsEnv(json, true));
    child[STDIN_ONLY] = `[toolfunnel] the arguments (${Buffer.byteLength(json, 'utf8')} bytes) were too big for the ` +
      `environment (${err.code}), so they were sent on stdin only, with ${STDIN_FLAG}=1.`;
    process.stderr.write(child[STDIN_ONLY] + '\n');
  }
  if (child.stdin) {
    child.stdin.on('error', () => {}); // a tool that exits without reading stdin closes the pipe: not an error
    // only a tool that reads its arguments there gets them on stdin; any other gets it closed and empty
    if (readsStdin) child.stdin.end(json); else child.stdin.end();
  }
  return child;
}

/**
 * Whether a tool that exited 0 said it failed: its whole stdout is one JSON object with "ok": false (the shape the
 * bundled tools print). Returns the tool's own error text, or null. Anything else on stdout is not read as a verdict.
 */
function toolSaidFailed(stdout) {
  const text = typeof stdout === 'string' ? stdout.trim() : '';
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch (_e) { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.ok !== false) return null;
  return typeof parsed.error === 'string' && parsed.error ? parsed.error : 'the tool reported ok: false';
}

// set on a child whose arguments went on stdin only: the note its run record carries
const STDIN_ONLY = Symbol('toolfunnel.argsOnStdinOnly');

/** The note for a run whose arguments went on stdin only, or ''. */
function stdinOnlyNote(child) {
  return (child && child[STDIN_ONLY]) || '';
}

// set on the { ok, code, stdout, stderr } record a local script or shell run resolves with; JSON never carries it,
// so an upstream's answer that happens to have the same keys is never taken for one
const RUN_RECORD = Symbol('toolfunnel.runRecord');

/** Mark a local run record (returns it). */
function runRecord(r) {
  r[RUN_RECORD] = true;
  return r;
}

/** Whether a value is a local script or shell run that failed. */
function isFailedRun(out) {
  return !!out && typeof out === 'object' && out[RUN_RECORD] === true && out.ok === false;
}

module.exports = { ARGS_ENV, STDIN_FLAG, argsJson, argsEnv, tooBig, readsStdinArgs, spawnWithArgs, stdinOnlyNote, toolSaidFailed, runRecord, isFailedRun };
