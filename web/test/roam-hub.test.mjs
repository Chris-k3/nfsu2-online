// Free roam's hub (web/server/roam-hub.mjs): which players it links, what it reads and sends, on the switch.
//   node --test web/test/roam-hub.test.mjs        (the wire test needs wasi-sdk in deps/)
// 1. the wire: what runtime/roam_core.c sends the hub (HELLO, SNAP, BYE, encoded by the C core built for wasm,
//    web/test/roam_hubwire.c) is what the hub reads, and the hub's PEERS lists decode in the C core;
// 2. the links: nearest first, both ends of a link list each other, at most 7 per player, rooms apart, stale
//    positions out, links kept at the edge, BYE and departures forgotten, the limits per address;
// 3. on the switch (lan.mjs): frames to 10.77.0.253 reach the hub and its lists come back to the browsers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { RoamHub, ROAM_HUB_VIP, decodeRoam, encodePeers } from '../server/roam-hub.mjs';
import { LanSwitch, LAN_WSS_OPTIONS } from '../server/lan.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WASI = fs.existsSync(path.join(REPO, 'deps')) &&
  fs.readdirSync(path.join(REPO, 'deps')).filter(d => d.startsWith('wasi-sdk-')).map(d => path.join(REPO, 'deps', d)).pop();
const CC = WASI && path.join(WASI, 'bin/clang');
const OUT = path.join(REPO, 'out/web/test');
const ip = s => s.split('.').reduce((a, b) => ((a << 8) | +b) >>> 0, 0);
const fnv1a = s => { if (!s) return 0; let h = 0x811C9DC5; for (const c of Buffer.from(s, 'latin1')) { h ^= c; h = Math.imul(h, 0x01000193) >>> 0; } return h || 1; };

// a player's datagrams, as roam_core.c lays them out (checked against the C core below)
function dgram(type, sender, payload) {
  const len = 16 + payload.length + 4, b = Buffer.alloc(len);
  b.write('N2FR', 0, 'latin1'); b[4] = 1; b[5] = type; b.writeUInt16LE(len, 6); b.writeUInt32LE(sender >>> 0, 8);
  b.writeUInt16LE(7, 12); payload.copy(b, 16);
  b.writeUInt32LE(crc32(b.subarray(0, len - 4)), len - 4);
  return b;
}
function hello(sender, { room = 0, status = 2, name = 'p', seen = [], cfgRev = 3 } = {}) {
  const nm = Buffer.from(name, 'latin1'), p = Buffer.alloc(13 + nm.length + 1 + 4 * seen.length);
  p.writeUInt16LE(1, 0); p[2] = 1; p[3] = status; p.writeUInt16LE(47210, 4); p.writeUInt16LE(cfgRev, 6); p.writeUInt32LE(room >>> 0, 8);
  p[12] = nm.length; nm.copy(p, 13); p[13 + nm.length] = seen.length;
  seen.forEach((s, i) => p.writeUInt32LE(s, 14 + nm.length + 4 * i));
  return dgram(1, sender, p);
}
function snap(sender, pos, status = 2) {
  const p = Buffer.alloc(6 + 52);
  p[0] = status; p[4] = 1;
  p.writeFloatLE(pos[0], 10); p.writeFloatLE(pos[1], 14); p.writeFloatLE(pos[2] ?? 0, 18);
  p.writeInt16LE(32767, 6 + 34);                                  // q.w (a valid quaternion)
  return dgram(3, sender, p);
}
const bye = sender => dgram(8, sender, Buffer.from([0]));
// the switch's frame around a datagram (kind 1: [12..13] source port, [14..15] destination port)
function frame(from, d, sport = 47210, dport = 47210) {
  const f = Buffer.alloc(16 + d.length);
  f[0] = 1; f.writeUInt32BE(from >>> 0, 4); f.writeUInt32BE(ROAM_HUB_VIP, 8); f.writeUInt16BE(sport, 12); f.writeUInt16BE(dport, 14);
  d.copy(f, 16);
  return f;
}
// a PEERS list out of the hub's frame to a browser
function lists(sent) {
  const by = new Map();
  for (const { vip, f } of sent) {
    const d = f.subarray(16), n = d[16], l = [];
    for (let i = 0; i < n; i++) { const o = 17 + 10 * i; l.push({ vip: d.readUInt32BE(o), port: d.readUInt16LE(o + 4), id: d.readUInt32LE(o + 6) }); }
    by.set(`${vip}:${f.readUInt16BE(14)}`, l);
  }
  return by;
}
function hubFor(opts = {}) {
  let t = 1_000_000;
  const hub = new RoamHub({ timer: false, now: () => t, ...opts }), sent = [];
  hub.attachSwitch((vip, f) => { sent.push({ vip, f }); return true; });
  return { hub, sent, at: ms => { t = ms; }, now: () => t, step: ms => { t += ms; } };
}
const V = i => ip(`10.77.0.${10 + i}`);

test('the hub\'s address is net_proto.h\'s and proto.ts\'s NET_ROAM_HUB', () => {
  const h = fs.readFileSync(path.join(REPO, 'runtime/web/net_proto.h'), 'utf8'), ts = fs.readFileSync(path.join(REPO, 'web/src/net/proto.ts'), 'utf8');
  assert.equal(parseInt(/#define NET_ROAM_HUB\s+0x([0-9A-Fa-f]+)u/.exec(h)[1], 16), ROAM_HUB_VIP);
  assert.equal(parseInt(/NET_ROAM_HUB = 0x([0-9a-f]+)/.exec(ts)[1], 16), ROAM_HUB_VIP);
});

test('the wire: what roam_core sends the hub reads, and its PEERS lists decode in roam_core', { skip: !CC && 'no wasi-sdk in deps/' }, () => {
  fs.mkdirSync(OUT, { recursive: true });
  const w = path.join(OUT, 'roam_hubwire.wasm');
  execFileSync(CC, ['--target=wasm32-wasip1-threads', '-pthread', '-O2', '-ffp-contract=off', '-Iruntime', '-o', w,
    'web/test/roam_hubwire.c', 'runtime/roam_core.c',
    '-Wl,--import-memory,--export-memory,--shared-memory,--initial-memory=67108864,--max-memory=268435456'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = (...a) => execFileSync(process.execPath, [path.join(REPO, 'web/test/wasi-run.mjs'), w, ...a], { encoding: 'utf8' }).trim();
  const h = Buffer.from(run('hello'), 'hex'), s = Buffer.from(run('snap'), 'hex'), b = Buffer.from(run('bye'), 'hex');
  const mh = decodeRoam(h), ms = decodeRoam(s), mb = decodeRoam(b);
  assert.deepEqual(mh, { type: 1, sender: 0x1234ABCD, status: 2, room: fnv1a('blue'), name: 'Ann K.' });
  assert.ok(hello(0x1234ABCD, { room: fnv1a('blue'), name: 'Ann K.', seen: [0x11, 0x22] }).equals(h), 'this test\'s HELLO = the C core\'s, byte for byte');
  assert.equal(ms.type, 3); assert.equal(ms.sender, 0x1234ABCD); assert.equal(ms.status, 2);
  assert.deepEqual(ms.p, [1695.25, -883.5, 24.125], 'the newest state\'s position');
  assert.deepEqual(mb, { type: 8, sender: 0x1234ABCD });
  const bad = Buffer.from(h); bad[20] ^= 1;
  assert.equal(decodeRoam(bad), null, 'a wrong CRC is no datagram');
  const peers = encodePeers(0xB0B, 9, [{ vip: ip('10.77.0.5'), port: 47210, id: 3 }, { vip: ip('10.77.0.6'), port: 47300, id: 0xDEADBEEF }]);
  assert.equal(run('peers', peers.toString('hex')), `ok 2 10.77.0.5:47210:3 10.77.0.6:47300:${0xDEADBEEF}`);
  assert.equal(run('peers', encodePeers(0xB0B, 10, []).toString('hex')), 'ok 0', 'an empty list (the hub is there)');
});

test('links: the nearest, both ends, at most 7 a player, only in free roam lately, rooms apart', () => {
  const { hub, sent, step } = hubFor();
  // 20 players on a line 10 m apart, one far away, two in another room, one with no position yet
  for (let i = 0; i < 20; i++) { hub.frame(V(i), frame(V(i), hello(100 + i))); hub.frame(V(i), frame(V(i), snap(100 + i, [i * 10, 0, 0]))); }
  hub.frame(V(20), frame(V(20), hello(120))); hub.frame(V(20), frame(V(20), snap(120, [5000, 0, 0])));
  for (const i of [21, 22]) { hub.frame(V(i), frame(V(i), hello(100 + i, { room: fnv1a('red') }))); hub.frame(V(i), frame(V(i), snap(100 + i, [i, 0, 0]))); }
  hub.frame(V(23), frame(V(23), hello(123)));
  hub.tick();
  const L = lists(sent);
  assert.equal(L.size, 24, 'every player gets a list, an empty one too');
  const of = i => L.get(`${V(i)}:47210`), has = (i, j) => of(i).some(e => e.vip === V(j));
  for (let i = 0; i < 24; i++) {
    assert.ok(of(i).length <= 7, `player ${i}: at most 7 (${of(i).length})`);
    for (const e of of(i)) assert.ok(L.get(`${e.vip}:47210`).some(x => x.vip === V(i)), `player ${i}: its links list it too`);
  }
  assert.ok(has(0, 1) && has(10, 9) && has(10, 11), 'neighbours on the line are linked');
  for (let i = 5; i < 15; i++) for (const e of of(i)) assert.ok(Math.abs(e.vip - V(i)) <= 4, `player ${i}: its links are the nearest (${e.vip - V(i)} places away)`);
  assert.ok(has(19, 20) || of(20).length > 0, 'the far one is linked to somebody');
  assert.ok(has(21, 22) && of(21).length === 1, 'another room: only each other');
  assert.equal(of(23).length, 0, 'no position yet: no links');
  for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++)
    if (i !== j && of(i).length < 7 && of(j).length < 7) assert.ok(has(i, j), `${i} and ${j} both have room, so they are linked`);
  // a position older than 60 s: no links (one in a shop keeps them until then)
  sent.length = 0; step(30_000);
  for (let i = 1; i < 23; i++) { hub.frame(V(i), frame(V(i), hello(100 + i))); hub.frame(V(i), frame(V(i), snap(100 + i, i === 1 ? [10, 0, 0] : [i * 10, 0, 0]))); }
  hub.frame(V(0), frame(V(0), hello(100)));
  hub.tick();
  assert.ok(lists(sent).get(`${V(0)}:47210`).length > 0, '30 s without a SNAP: still linked');
  sent.length = 0; step(31_000);
  for (let i = 0; i < 23; i++) hub.frame(V(i), frame(V(i), hello(100 + i)));
  for (let i = 1; i < 23; i++) hub.frame(V(i), frame(V(i), snap(100 + i, [i * 10, 0, 0])));
  hub.tick();
  assert.equal(lists(sent).get(`${V(0)}:47210`).length, 0, '61 s without a SNAP: no links');
});

test('links stay put at the edge, players come and go', () => {
  const { hub, sent, step } = hubFor({ degree: 1 });
  // A at 0, B at 100: linked; C comes 10 m from A: a link stays its first 5 s
  const at = (i, x) => { hub.frame(V(i), frame(V(i), hello(200 + i))); hub.frame(V(i), frame(V(i), snap(200 + i, [x, 0, 0]))); };
  at(0, 0); at(1, 100); hub.tick();
  assert.equal(lists(sent).get(`${V(0)}:47210`)[0].vip, V(1));
  sent.length = 0; step(1000); at(0, 0); at(1, 100); at(2, -10); hub.tick();
  assert.equal(lists(sent).get(`${V(0)}:47210`)[0].vip, V(1), 'a link stays at least 5 s');
  // after that it counts as half its distance: 60 m does not beat a linked 100 m, 40 m does
  sent.length = 0; step(5000); at(0, 0); at(1, 100); at(2, -60); hub.tick();
  assert.equal(lists(sent).get(`${V(0)}:47210`)[0].vip, V(1), '60 m does not beat a linked 100 m');
  sent.length = 0; step(1000); at(0, 0); at(1, 100); at(2, -40); hub.tick();
  assert.equal(lists(sent).get(`${V(0)}:47210`)[0].vip, V(2), 'under half the distance: the link moves');
  // BYE, silence, a departure from the switch
  hub.frame(V(2), frame(V(2), bye(202)));
  assert.equal(hub.info().players, 2, 'BYE: forgotten at once');
  step(7000); at(0, 0); hub.tick();
  assert.equal(hub.info().players, 1, '6 s without a word: forgotten');
  hub.peerGone(V(0));
  assert.equal(hub.info().players, 0, 'left the switch: forgotten');
});

test('limits: two endpoints a browser, a player starts with its HELLO, bad datagrams counted', () => {
  const { hub } = hubFor();
  for (const port of [47210, 47211, 47212]) hub.frame(V(0), frame(V(0), hello(300 + port), port));
  assert.equal(hub.info().players, 2); assert.equal(hub.info().refused, 1);
  hub.frame(V(1), frame(V(1), snap(301, [0, 0, 0])));
  assert.equal(hub.info().players, 2, 'a SNAP before any HELLO: nobody new');
  hub.frame(V(1), Buffer.from('nonsense, not a frame at all'));
  const f = frame(V(1), hello(301)); f[30] ^= 0xff;
  hub.frame(V(1), f);
  assert.equal(hub.info().bad, 2);
  const far = frame(V(1), snap(301, [1e6, 0, 0]));
  hub.frame(V(1), frame(V(1), hello(301))); hub.frame(V(1), far);
  assert.equal(hub.info().bad, 3, 'a position out of the map: refused');
});

test('64 players in one place: each list at most 7, the tick stays cheap', () => {
  const { hub, sent } = hubFor();
  for (let i = 0; i < 64; i++) {
    const v = ip(`10.77.0.${2 + i}`);
    hub.frame(v, frame(v, hello(400 + i))); hub.frame(v, frame(v, snap(400 + i, [Math.cos(i) * 30, Math.sin(i) * 30, 0])));
  }
  for (let k = 0; k < 20; k++) hub.tick();
  const L = lists(sent.slice(-64)), n = [...L.values()].map(l => l.length);
  assert.ok(n.every(x => x <= 7) && n.filter(x => x === 7).length >= 60, `lists of 7 (${n.join(' ')})`);
  console.log(`64 players: ${hub.info().links} links, tick at most ${hub.info().tickMsMax.toFixed(2)} ms`);
  assert.ok(hub.info().tickMsMax < 50);
});

// ---- on the switch ---------------------------------------------------------------------------------------------
async function startSwitch(opts) {
  const lan = new LanSwitch(opts);
  const srv = http.createServer((q, s) => { s.writeHead(404); s.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20, ...LAN_WSS_OPTIONS });
  srv.on('upgrade', (q, sock, head) => wss.handleUpgrade(q, sock, head, ws => lan.attach(ws, null, {})));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { lan, port: srv.address().port, close: () => new Promise(r => { lan.stop(); for (const c of wss.clients) c.terminate(); srv.close(r); }) };
}
function browser(port, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/lan`); ws.binaryType = 'nodebuffer';
  const b = { ws, frames: [], vip: 0 };
  b.ready = new Promise(res => ws.on('message', (d, bin) => {
    if (bin) { b.frames.push(Buffer.from(d)); return; }
    const m = JSON.parse(String(d));
    if (m.t === 'welcome') { b.vip = m.vip >>> 0; ws.send(JSON.stringify({ t: 'hello', name })); res(); }
  }));
  b.send = d => { const f = frame(0, d); f.writeUInt32BE(ROAM_HUB_VIP, 8); ws.send(f); };
  return b;
}
test('on the switch: frames to 10.77.0.253 reach the hub, its lists come back, a departure is forgotten', async () => {
  const hub = new RoamHub({ timer: false });
  const sw = await startSwitch({ roam: hub });
  try {
    const a = browser(sw.port, 'Ann'), b = browser(sw.port, 'Bob');
    await Promise.all([a.ready, b.ready]);
    a.send(hello(501)); a.send(snap(501, [0, 0, 0])); b.send(hello(502)); b.send(snap(502, [20, 0, 0]));
    await new Promise(r => setTimeout(r, 100));
    assert.equal(hub.info().players, 2, 'both reached the hub');
    hub.tick();
    await new Promise(r => setTimeout(r, 100));
    const got = a.frames.find(f => f[0] === 1 && f.readUInt32BE(4) === ROAM_HUB_VIP);
    assert.ok(got, 'Ann got a list from 10.77.0.253');
    assert.equal(got.readUInt32BE(8), a.vip); assert.equal(got.readUInt16BE(12), 47210); assert.equal(got.readUInt16BE(14), 47210);
    const d = got.subarray(16);
    assert.equal(d[16], 1); assert.equal(d.readUInt32BE(17), b.vip); assert.equal(d.readUInt32LE(23), 502);
    assert.ok(!sw.lan.info().peers.some(p => p.vip === '10.77.0.253'), 'the hub is on nobody\'s peer list');
    b.ws.close();
    await new Promise(r => setTimeout(r, 200));
    assert.equal(hub.info().players, 1, 'Bob left the switch: the hub forgot him');
    assert.equal(sw.lan.info().roam.players, 1);
    a.ws.close();
  } finally { await sw.close(); }
});
