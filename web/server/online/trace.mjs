// A test aid (server option --online-trace <file>, only with --dev): the lobby
// protocol's messages, decoded, one line each, for the TCP streams on the
// lobby ports between browsers (LAN play: EA's server.dll in the hosting
// browser, port 9900 and its redirector 10901) and to the server's own online
// host (online/vhost.mjs).  The online mode's reference transcripts were
// recorded with it.
//
// Off unless asked for.  Every value that could be a secret (PASS..., REGKEY,
// PSES, and LKEY, the key of a persona's Messenger login) is written as
// <redacted>, without ever being decoded (aries.mjs redactBody); the addresses
// are virtual (10.77.0.x).  Raw frames are never written.  The file is the
// server user's alone (0600): it holds chat and private messages.  At most
// MAX_STREAMS streams are followed at once, the oldest going first.
import fs from 'node:fs';
import { FrameReader, redactBody } from './aries.mjs';

export const TRACE_PORTS = Object.freeze([9900, 10901, 20920, 20921, 20922, 13505]);
const MAX_STREAMS = 256;
const vs = v => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');

export class LobbyTrace {
  constructor(file, ports = TRACE_PORTS) {
    this.ports = new Set(ports);
    this.out = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* the stream reports it */ }
    this.streams = new Map();
    this.t0 = Date.now();
    this.line(`--- trace started ${new Date().toISOString()}`);
  }
  line(s) { this.out.write(`${((Date.now() - this.t0) / 1000).toFixed(3)} ${s}\n`); }
  /** one switch frame (any kind; only TCP on a traced port is looked at) */
  frame(data) {
    if (data.length < 24 || data[0] !== 4) return;
    const src = data.readUInt32BE(4), dst = data.readUInt32BE(8), sp = data.readUInt16BE(12), dp = data.readUInt16BE(14);
    if (!this.ports.has(sp) && !this.ports.has(dp)) return;
    const op = data[16], cid = data.readUInt32LE(20), key = `${src}:${sp}>${dst}:${dp}#${cid}`;
    const name = `${vs(src)}:${sp} > ${vs(dst)}:${dp}`;
    if (op === 1) return this.line(`${name} SYN`);
    if (op === 2) return this.line(`${name} SYNACK`);
    if (op === 3 || op === 5) {
      this.line(`${name} ${op === 3 ? 'RST' : 'FIN'}`);
      this.streams.delete(key);
      if (op === 3) this.streams.delete(`${dst}:${dp}>${src}:${sp}#${cid}`);
      return;
    }
    if (op !== 4) return;
    let r = this.streams.get(key);
    if (!r) {
      if (this.streams.size >= MAX_STREAMS) this.streams.delete(this.streams.keys().next().value);
      r = new FrameReader(1 << 16); this.streams.set(key, r);
    }
    for (const m of r.push(data.subarray(24))) {
      // the separator after the first field (the replies of server.dll and EA's servers differ: tabs or newlines)
      const eq = m.body.indexOf(0x3d), sep = eq < 0 ? -1 : m.body.findIndex((c, i) => i > eq && c <= 0x20);
      const sp = sep < 0 ? '' : ({ 9: ' [tab]', 10: ' [nl]', 32: ' [sp]', 0: '' })[m.body[sep]] ?? ` [${m.body[sep]}]`;
      this.line(`${name} ${m.kind}/${m.code || '0'} (${m.body.length + 12})${sp} ${redactBody(m.body)}`);
    }
    if (r.error) { this.line(`${name} not the lobby protocol: ${r.error}`); this.streams.delete(key); }
  }
  close() { this.out.end(); }
}
