'use strict';
/**
 * fake-stdio-child.js - a child-process double for McpClient's injectable spawnImpl.
 *
 * Newline-JSON requests in (what the client writes), Content-Length-framed replies out (what a real
 * SDK server writes), plus the process-shaped surface the client touches: pid, exitCode, signalCode,
 * killed, kill(), stdin.end(). The fake has NO numeric pid on purpose - _treeKill must never reach
 * taskkill/kill with a made-up pid.
 *
 * makeFakeChild(label, onRequest): onRequest(child, msg) is called for every parsed request line;
 * answer with child.reply(obj), inject raw bytes with child.raw(str), end the child with child.die().
 */
const { EventEmitter } = require('node:events');

function makeFakeChild(label, onRequest) {
  const child = new EventEmitter();
  child.label = label;
  child.pid = undefined; // NOT a number - keeps _treeKill on the harmless child.kill() path
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.requests = []; // every parsed request/notification the client wrote, in order
  let inbuf = '';
  child.stdin = {
    destroyed: false,
    write(chunk, cb) {
      inbuf += chunk.toString('utf8');
      let nl;
      while ((nl = inbuf.indexOf('\n')) !== -1) {
        const line = inbuf.slice(0, nl).trim();
        inbuf = inbuf.slice(nl + 1);
        if (line) {
          let msg = null;
          try { msg = JSON.parse(line); } catch (_e) { /* not JSON - ignore */ }
          if (msg) { child.requests.push(msg); try { onRequest(child, msg); } catch (_e) { /* a handler fault must not break the pipe */ } }
        }
      }
      if (typeof cb === 'function') cb();
      return true;
    },
    end() { this.destroyed = true; },
  };
  child.die = () => {
    if (child.exitCode !== null) return;
    child.exitCode = 0;
    child.emit('exit', 0, null);
  };
  child.kill = () => { child.killed = true; child.die(); return true; };
  /** Reply as a real Content-Length server would: exact byte count, NO trailing newline. */
  child.reply = (obj) => {
    const body = JSON.stringify(obj);
    child.stdout.emit('data', Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, 'utf8'));
  };
  child.raw = (s) => child.stdout.emit('data', Buffer.from(s, 'utf8'));
  return child;
}

module.exports = { makeFakeChild };
