// One scripted session on a switch, as its clients saw it: every control message (exact text, tokens replaced by
// their order of appearance), every datagram (bundles taken apart), every close, and the switch's info() at the end.
// tests/crosscheck.rs runs it against web/server/lan.mjs (in this process: --js) and against the Rust switch (a
// port) and compares the two.
//   node transcript.mjs --js | <port>
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ipStr = (v) => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');

// lan.test.mjs's startSwitch
async function startSwitch(opts) {
  const { LanSwitch, LAN_WSS_OPTIONS } = await import(path.join(HERE, '../../../../server/lan.mjs'));
  const lan = new LanSwitch(opts);
  const srv = http.createServer((q, s) => { s.writeHead(404); s.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20, ...LAN_WSS_OPTIONS });
  srv.on('upgrade', (q, sock, head) => {
    const u = new URL(q.url, 'http://x');
    if (u.pathname !== '/lan') return sock.destroy();
    wss.handleUpgrade(q, sock, head, ws => lan.attach(ws, null, { resume: u.searchParams.has('resume'), group: u.searchParams.get('g'), site: u.searchParams.get('s') }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { info: async () => lan.info(), port: srv.address().port, close: () => new Promise(r => { lan.stop(); for (const c of wss.clients) c.terminate(); srv.close(r); }) };
}

const tokens = new Map();
const tok = t => { if (!tokens.has(t)) tokens.set(t, `<token ${tokens.size}>`); return tokens.get(t); };

class Client {
  constructor(port, name, query = '', resume = null, extra = {}) {
    this.name = name; this.texts = []; this.dgrams = []; this.resume = resume; this.extra = extra; this.waiters = [];
    const q = resume ? (query ? query + '&resume' : '?resume') : query;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/lan${q}`);
    this.ws.binaryType = 'nodebuffer';
    if (resume) this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name, vip: ipStr(resume.vip), token: resume.token, ...extra })));
    this.ws.on('message', (d, bin) => {
      if (bin) {
        const one = b => this.dgrams.push(b.toString('hex'));
        if (d[0] !== 32) one(d);
        else for (let at = 4; at + 4 <= d.length;) { const f = at + 4 + 4 * d[at], end = f + d.readUInt16BE(at + 2); one(d.subarray(f, end)); at = end; }
      } else {
        const s = String(d), m = JSON.parse(s);
        if (m.t === 'welcome') { this.vip = m.vip >>> 0; this.token = m.token; }
        this.texts.push(m.t === 'welcome' ? s.replace(m.token, tok(m.token)) : s);
      }
      for (const w of this.waiters.splice(0)) w();
    });
    this.closed = new Promise(r => this.ws.on('close', (code, why) => { this.close = `${code} ${why}`; r(); }));
  }
  welcome() {
    return new Promise(res => {
      const check = () => { if (this.vip) { if (!this.resume) this.ws.send(JSON.stringify({ t: 'hello', name: this.name, ...this.extra })); res(); } else this.waiters.push(check); };
      check();
    });
  }
  udp(dst, data, kind = 1) {
    const f = Buffer.alloc(16 + data.length);
    f[0] = kind; f.writeUInt32BE(0x01020304, 4); f.writeUInt32BE(dst >>> 0, 8); f.writeUInt16BE(1000 + kind, 12); f.writeUInt16BE(2000, 14);
    Buffer.from(data).copy(f, 16);
    this.ws.send(f);
    return f;
  }
  record() { return { texts: this.texts, dgrams: this.dgrams, close: this.close ?? null }; }
}
function bundleOf(entries) {
  const parts = [Buffer.from([32, 0, 0, 0])];
  for (const { f, to = [] } of entries) {
    const h = Buffer.alloc(4 + 4 * to.length);
    h[0] = to.length; h.writeUInt16BE(f.length, 2); to.forEach((v, j) => h.writeUInt32BE(v >>> 0, 4 + 4 * j));
    parts.push(h, f);
  }
  return Buffer.concat(parts);
}
const frameOf = (dst, data, kind = 1) => {
  const f = Buffer.alloc(16 + data.length);
  f[0] = kind; f.writeUInt32BE(dst >>> 0, 8); f.writeUInt16BE(7, 12); f.writeUInt16BE(8, 14); Buffer.from(data).copy(f, 16);
  return f;
};

const arg = process.argv[2];
const sw = arg === '--js' ? await startSwitch({}) : { port: +arg, info: async () => (await (await fetch(`http://127.0.0.1:${arg}/state`)).json()).info, close: async () => {} };
const { port } = sw;
// every step waits past the peer list's timers (peersMs 250, fullPeersMs 1000), so that each change goes out alone
const settle = () => sleep(1300);
const all = [];
const add = c => { all.push(c); return c; };

const a = add(new Client(port, 'Alice', '', null, { deltas: 1 }));
await a.welcome(); await settle();
const b = add(new Client(port, ' Bob\u200b  \t x\u0007', '?g=bob', null, { lan: 1, bundle: 1, deltas: 1 }));
await b.welcome(); await settle();
const c = add(new Client(port, 'Carol', '?g=carol&s=site'));
await c.welcome(); await settle();
// pings: an id, one that is not a safe integer, one that is not a number; a hello again (it changes nothing)
for (const id of [5, 1.5, '"x"', 9007199254740991, 1e21, -0]) a.ws.send(`{"t":"ping","id":${id}}`);
b.ws.send(JSON.stringify({ t: 'hello', name: 'Mallory', deltas: 0 }));
a.ws.send('not json'); a.ws.send('[1,2]'); a.ws.send('{"t":"lan"}');
await sleep(200);
// unicast, a LAN broadcast (C said nothing: it gets it; A's {"t":"lan"} without on: off), free roam's broadcast
a.udp(b.vip, 'a-to-b'); a.udp(0xFFFFFFFF, 'lan-bc', 3); a.udp(0xFFFFFFFF, 'roam-bc', 1); a.udp(c.vip, 'tcp', 4);
await sleep(200);
// a bundle from B: a snapshot to A and C, a frame to its own destination, a LAN broadcast (kind 5), one to nobody
b.ws.send(bundleOf([{ f: frameOf(0, 'snap'), to: [a.vip, c.vip] }, { f: frameOf(c.vip, 'only-c') }, { f: frameOf(0xFFFFFFFF, 'icmp', 5) },
  { f: frameOf(0x0A4D0505, 'nobody') }]));
await sleep(200);
// C shuts LAN play: the next LAN broadcast skips it
c.ws.send('{"t":"lan","on":0}'); await sleep(100);
b.udp(0xFFFFFFFF, 'lan-again', 3);
await sleep(200);
// Alice's page comes back with its token while its old connection still holds the address: it replaces it
const a2 = add(new Client(port, 'Alice', '', { vip: a.vip, token: a.token }, { deltas: 1 }));
await a2.welcome(); await a.closed; await settle();
// C lets go (1000 "idle": its address is free at once), B drops (its address kept for its token)
// (apart: the switch's 'close' of each comes a moment after the client's, and the delta lists them in that order)
c.ws.close(1000, 'idle'); await c.closed; await sleep(100);
b.ws.terminate(); await b.closed;
await settle();
// a wrong token for B's address: a fresh one; then B's own token: its address back
const e = add(new Client(port, 'Eve', '', { vip: b.vip, token: 'x'.repeat(22) }));
await e.welcome(); await settle();
const b2 = add(new Client(port, 'Bob', '?g=bob', { vip: b.vip, token: b.token }, { bundle: 1 }));
await b2.welcome(); await settle();
a2.udp(b2.vip, 'to-b2'); a2.udp(e.vip, 'to-e', 2);
await sleep(200);
const info = await sw.info();
for (const x of [a2, e, b2]) { x.ws.close(); await x.closed; }
await sleep(100);
const after = await sw.info();
await sw.close();
process.stdout.write(JSON.stringify({ clients: Object.fromEntries(all.map((x, i) => [`${i} ${x.name}`, x.record()])), info, after }));
process.exit(0);
