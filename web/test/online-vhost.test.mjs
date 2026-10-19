// The server's own host on the virtual LAN, 10.77.0.1 (web/server/online/vhost.mjs),
// and how the switch carries it (web/server/lan.mjs with an online host):
//   node --test web/test/online-vhost.test.mjs
// TCP as runtime/web/net_lan.c speaks it (SYN -> SYNACK or RST, DATA in
// frames of at most 1464 bytes, FIN both ways, RST, a browser that leaves),
// the per-browser connection limit, ICMP echo answered with a correct
// checksum, UDP answered with "port unreachable"; on the switch: the online
// host is on every peer list as server: true, frames to it never reach a
// browser, its answers do, and broadcasts never reach it.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { VirtualHost, VHOST_VIP, lanFrame, TCP_CHUNK } from '../server/online/vhost.mjs';
import { LanSwitch, LAN_WSS_OPTIONS } from '../server/lan.mjs';

const ip = (s) => s.split('.').reduce((a, b) => ((a << 8) | +b) >>> 0, 0);
const A = ip('10.77.0.2'), B = ip('10.77.0.3');
const SYN = 1, SYNACK = 2, RST = 3, DATA = 4, FIN = 5;
const parse = f => ({ kind: f[0], src: f.readUInt32BE(4), dst: f.readUInt32BE(8), sport: f.readUInt16BE(12), dport: f.readUInt16BE(14),
  op: f[16], cid: f.readUInt32LE(20), data: f.subarray(24) });

function host(opts) {
  const out = [];
  const h = new VirtualHost({ out: (vip, f) => out.push({ vip, ...parse(f) }), opts });
  return { h, out };
}

test('TCP: refused, accepted, data both ways, FIN, RST, a browser that leaves', () => {
  const { h, out } = host();
  h.frame(A, lanFrame(4, A, VHOST_VIP, 50000, 20920, SYN, 7));
  assert.deepEqual([out[0].op, out[0].dport, out[0].sport, out[0].cid], [RST, 50000, 20920, 7], 'no listener: RST');
  const got = []; let ended = 0, closed = [];
  let conn;
  h.listen(20920, c => { conn = c; c.ondata = b => got.push(b.toString()); c.onend = () => { ended++; c.end(); }; c.onclose = w => closed.push(w); });
  out.length = 0;
  h.frame(A, lanFrame(4, A, VHOST_VIP, 50001, 20920, SYN, 9));
  assert.equal(out[0].op, SYNACK); assert.equal(conn.peer, '10.77.0.2');
  h.frame(A, lanFrame(4, A, VHOST_VIP, 50001, 20920, SYN, 9));
  assert.equal(out.length, 1, 'a duplicate SYN is ignored');
  h.frame(A, lanFrame(4, A, VHOST_VIP, 50001, 20920, DATA, 9, Buffer.from('hello')));
  assert.deepEqual(got, ['hello']);
  conn.write(Buffer.alloc(TCP_CHUNK * 2 + 10, 0x41));
  const data = out.filter(f => f.op === DATA);
  assert.deepEqual(data.map(f => f.data.length), [TCP_CHUNK, TCP_CHUNK, 10]);
  assert.ok(data.every(f => f.src === VHOST_VIP && f.dst === A && f.sport === 20920 && f.dport === 50001 && f.cid === 9));
  h.frame(A, lanFrame(4, A, VHOST_VIP, 50001, 20920, FIN, 9));
  assert.equal(ended, 1); assert.equal(out.at(-1).op, FIN); assert.deepEqual(closed, ['closed']);
  assert.equal(h.info().conns, 0);
  out.length = 0;
  h.frame(A, lanFrame(4, A, VHOST_VIP, 50001, 20920, DATA, 9, Buffer.from('late')));
  assert.equal(out[0].op, RST, 'data for an unknown connection: RST');
  // the browser resets; another one leaves the switch
  h.frame(A, lanFrame(4, A, VHOST_VIP, 50002, 20920, SYN, 10));
  h.frame(A, lanFrame(4, A, VHOST_VIP, 50002, 20920, RST, 10));
  assert.equal(closed.at(-1), 'reset by the game');
  h.frame(B, lanFrame(4, B, VHOST_VIP, 50003, 20920, SYN, 11));
  h.peerGone(B);
  assert.equal(closed.at(-1), 'the browser left'); assert.equal(h.info().conns, 0);
});

test('TCP: at most perVip connections per browser', () => {
  const { h, out } = host({ perVip: 2 });
  h.listen(20922, () => {});
  for (let i = 0; i < 3; i++) h.frame(A, lanFrame(4, A, VHOST_VIP, 50010 + i, 20922, SYN, 100 + i));
  assert.deepEqual(out.map(f => f.op), [SYNACK, SYNACK, RST]);
  h.frame(B, lanFrame(4, B, VHOST_VIP, 50020, 20922, SYN, 200));
  assert.equal(out.at(-1).op, SYNACK, 'another browser has its own budget');
});

test('ICMP echo and UDP', () => {
  const { h, out } = host();
  const req = Buffer.from([8, 0, 0, 0, 0x12, 0x34, 0, 1, 1, 2, 3, 4, 5]);
  h.frame(A, lanFrame(5, A, VHOST_VIP, 0, 0, 0, 0, req));
  const r = out[0];
  assert.equal(r.kind, 5); assert.equal(r.data[0], 0); assert.deepEqual([...r.data.subarray(4)], [...req.subarray(4)]);
  let sum = 0; for (let i = 0; i + 1 < r.data.length; i += 2) sum += (r.data[i] << 8) | r.data[i + 1];
  sum += r.data[r.data.length - 1] << 8; while (sum >> 16) sum = (sum & 0xffff) + (sum >>> 16);
  assert.equal(sum, 0xffff, 'the reply checksum is right');
  h.frame(A, lanFrame(5, A, VHOST_VIP, 0, 0, 0, 0, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0])));
  assert.equal(out.length, 1, 'only echo requests are answered');
  h.frame(A, lanFrame(3, A, VHOST_VIP, 3658, 3658, 0, 0, Buffer.from('x')));
  assert.deepEqual([out[1].kind, out[1].op, out[1].sport, out[1].dport], [3, 1, 3658, 3658]);
});

// the switch with the online host, and two fake browsers
async function startSwitch(online) {
  const lan = new LanSwitch({ online });
  const srv = http.createServer((q, s) => { s.writeHead(404); s.end(); });
  const wss = new WebSocketServer({ noServer: true, ...LAN_WSS_OPTIONS });
  srv.on('upgrade', (q, sock, head) => wss.handleUpgrade(q, sock, head, ws => lan.attach(ws)));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { lan, port: srv.address().port, close: () => new Promise(r => { lan.stop(); for (const c of wss.clients) c.terminate(); srv.close(r); }) };
}
function client(port) {
  const c = { frames: [], ctl: [], waiters: [] };
  c.ws = new WebSocket(`ws://127.0.0.1:${port}/lan`); c.ws.binaryType = 'nodebuffer';
  c.ws.on('message', (d, bin) => { (bin ? c.frames : c.ctl).push(bin ? Buffer.from(d) : JSON.parse(String(d))); for (const w of c.waiters.splice(0)) w(); });
  c.until = (f, ms = 2000) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timed out')), ms);
    const check = () => { const v = f(); if (v) { clearTimeout(t); res(v); } else c.waiters.push(check); };
    check();
  });
  return c;
}

test('switch: the online host on the peer list, frames to it and back, no broadcasts', async () => {
  const seen = [], gone = [];
  let send;
  const online = { vip: VHOST_VIP, name: 'NFSU2 Online', attachSwitch: s => (send = s), frame: (from, f) => seen.push({ from, f: Buffer.from(f) }),
    peerGone: v => gone.push(v), info: () => ({}) };
  const s = await startSwitch(online);
  const a = client(s.port), b = client(s.port);
  const wa = await a.until(() => a.ctl.find(m => m.t === 'welcome')), wb = await b.until(() => b.ctl.find(m => m.t === 'welcome'));
  const peers = await a.until(() => { const l = a.ctl.filter(m => m.t === 'peers').at(-1); return l && l.peers.length === 3 && l.peers; });
  assert.deepEqual(peers.filter(p => p.server).map(p => [p.vip, p.name]), [[VHOST_VIP, 'NFSU2 Online']]);
  assert.ok(peers.filter(p => !p.server).every(p => p.vip !== VHOST_VIP));
  // a frame to 10.77.0.1, with a forged source: the online host gets it with the sender's own address
  a.ws.send(lanFrame(4, 0x0a4d00fe, VHOST_VIP, 50000, 20920, SYN, 5));
  await new Promise(r => setTimeout(r, 100));
  assert.equal(seen.length, 1); assert.equal(seen[0].from, wa.vip >>> 0); assert.equal(seen[0].f.readUInt32BE(4), wa.vip >>> 0);
  assert.equal(b.frames.length, 0, 'no browser sees it');
  // a broadcast never reaches the online host
  a.ws.send(lanFrame(3, 0, 0xffffffff, 9999, 9999, 0, 0, Buffer.from('advert')));
  await b.until(() => b.frames.length === 1);
  assert.equal(seen.length, 1);
  // its answer reaches the browser
  assert.equal(send(wa.vip >>> 0, lanFrame(4, VHOST_VIP, wa.vip, 20920, 50000, SYNACK, 5)), true);
  const f = await a.until(() => a.frames.find(x => x[16] === SYNACK));
  assert.equal(f.readUInt32BE(4), VHOST_VIP);
  assert.equal(send(ip('10.77.0.200'), lanFrame(4, VHOST_VIP, 0, 1, 1, RST, 0)), null, 'nobody there (null: not on the switch)');
  // a browser that leaves is reported
  b.ws.close();
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(gone, [wb.vip >>> 0]);
  a.ws.close();
  await s.close();
});
