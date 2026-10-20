// Free roam's hub (web/server/roam-hub.mjs): which players it links, what it reads and sends, on the switch.
//   node --test web/test/roam-hub.test.mjs        (the wire test needs wasi-sdk in deps/)
// 1. the wire: what runtime/roam_core.c sends the hub (HELLO, SNAP, BYE, encoded by the C core built for wasm,
//    web/test/roam_hubwire.c) is what the hub reads, and the hub's PEERS lists decode in the C core;
// 2. the links: nearest first, both ends of a link list each other, at most 32 per player (7 for a core of
//    version 1), rooms apart, stale positions out, links kept at the edge, BYE and departures forgotten, the
//    limits per address;
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
function hello(sender, { room = 0, status = 2, name = 'p', seen = [], cfgRev = 3, core = 1 } = {}) {
  const nm = Buffer.from(name, 'latin1'), p = Buffer.alloc(13 + nm.length + 1 + 4 * seen.length);
  p.writeUInt16LE(core, 0); p[2] = 1; p[3] = status; p.writeUInt16LE(47210, 4); p.writeUInt16LE(cfgRev, 6); p.writeUInt32LE(room >>> 0, 8);
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
// the links of a room: every pair weighed (a room of at most exactRoom players), or the grid's nearest (a larger one)
const WAYS = [['every pair', {}], ['the grid', { exactRoom: 1 }]];

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
  assert.deepEqual(mh, { type: 1, sender: 0x1234ABCD, core: 4, status: 2, room: fnv1a('blue'), name: 'Ann K.' });
  assert.ok(hello(0x1234ABCD, { room: fnv1a('blue'), name: 'Ann K.', seen: [0x11, 0x22], core: 4 }).equals(h), 'this test\'s HELLO = the C core\'s, byte for byte');
  assert.equal(ms.type, 3); assert.equal(ms.sender, 0x1234ABCD); assert.equal(ms.status, 2);
  assert.deepEqual(ms.p, [1695.25, -883.5, 24.125], 'the newest state\'s position');
  assert.deepEqual(mb, { type: 8, sender: 0x1234ABCD });
  const bad = Buffer.from(h); bad[20] ^= 1;
  assert.equal(decodeRoam(bad), null, 'a wrong CRC is no datagram');
  const peers = encodePeers(0xB0B, 9, [{ vip: ip('10.77.0.5'), port: 47210, id: 3 }, { vip: ip('10.77.0.6'), port: 47300, id: 0xDEADBEEF }]);
  assert.equal(run('peers', peers.toString('hex')), `ok 2 10.77.0.5:47210:3 10.77.0.6:47300:${0xDEADBEEF}`);
  assert.equal(run('peers', encodePeers(0xB0B, 10, []).toString('hex')), 'ok 0', 'an empty list (the hub is there)');
});

for (const [how, opts] of WAYS) test(`links of players of core version 1 (${how}): the nearest, both ends, at most 7 a player, only in free roam lately, rooms apart`, () => {
  const { hub, sent, step } = hubFor(opts);
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

for (const [how, opts] of WAYS) test(`links of players of core version 2 (${how}): at most 32 a player, 7 for one of version 1 among them`, () => {
  const { hub, sent } = hubFor(opts);
  // 50 players on a line 10 m apart, player 15 of core version 1
  for (let i = 0; i < 50; i++) {
    hub.frame(V(i), frame(V(i), hello(100 + i, { core: i === 15 ? 1 : 2 })));
    hub.frame(V(i), frame(V(i), snap(100 + i, [i * 10, 0, 0])));
  }
  hub.tick();
  const L = lists(sent), of = i => L.get(`${V(i)}:47210`);
  for (let i = 0; i < 50; i++) {
    assert.ok(of(i).length <= (i === 15 ? 7 : 32), `player ${i}: at most ${i === 15 ? 7 : 32} (${of(i).length})`);
    for (const e of of(i)) assert.ok(L.get(`${e.vip}:47210`).some(x => x.vip === V(i)), `player ${i}: its links list it too`);
  }
  assert.equal(of(15).length, 7, 'the version 1 player: 7, as its group of 8 holds');
  const deg = i => (i === 15 ? 7 : 32), has = (i, j) => of(i).some(e => e.vip === V(j));
  for (let i = 0; i < 50; i++) for (let j = 0; j < 50; j++)
    if (i !== j && of(i).length < deg(i) && of(j).length < deg(j)) assert.ok(has(i, j), `${i} and ${j} both have room, so they are linked`);
  assert.ok(of(25).length > 16, `more than 16 for a player of version 2 (${of(25).length})`);
});

for (const [how, opts] of WAYS) test(`links stay put at the edge, players come and go (${how})`, () => {
  const { hub, sent, step } = hubFor({ degree: 1, ...opts });
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
  assert.deepEqual([...hub.vips()].sort(), [V(0), V(1), V(2)].sort(), 'the browsers in free roam (the server\'s console)');
  hub.frame(V(2), frame(V(2), bye(202)));
  assert.equal(hub.info().players, 2, 'BYE: forgotten at once');
  step(7000); at(0, 0); hub.tick();
  assert.equal(hub.info().players, 1, '6 s without a word: forgotten');
  assert.deepEqual([...hub.vips()], [V(0)]);
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

for (const core of [1, 2]) test(`64 players of core version ${core} in one place: each list at most ${core === 1 ? 7 : 32}, the tick stays cheap`, () => {
  const { hub, sent } = hubFor(), most = core === 1 ? 7 : 32;
  for (let i = 0; i < 64; i++) {
    const v = ip(`10.77.0.${2 + i}`);
    hub.frame(v, frame(v, hello(400 + i, { core }))); hub.frame(v, frame(v, snap(400 + i, [Math.cos(i) * 30, Math.sin(i) * 30, 0])));
  }
  for (let k = 0; k < 20; k++) hub.tick();
  const L = lists(sent.slice(-64)), n = [...L.values()].map(l => l.length);
  assert.ok(n.every(x => x <= most) && n.filter(x => x === most).length >= 60, `lists of ${most} (${n.join(' ')})`);
  console.log(`64 players of core version ${core}: ${hub.info().links} links, tick at most ${hub.info().tickMsMax.toFixed(2)} ms`);
  assert.ok(hub.info().tickMsMax < 50);
});

// a room larger than exactRoom: the grid's links against every pair's, for the same players (a city, a district and
// a crowd; some of core version 1; two rooms; a few far out): the same rules (at most the degree, both ends, no two
// with room left unlinked) and about the same distances
for (const [where, w] of [['a city', 8000], ['a district', 1500], ['a crowd', 100]]) test(`600 players in ${w} m: the grid links as every pair does`, () => {
  let seed = 12345;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const players = Array.from({ length: 600 }, (_, i) => ({ v: ip(`10.77.${i & 7}.${2 + (i >> 3)}`), id: 700 + i, core: i % 50 === 7 ? 1 : 2,
    room: i % 10 === 3 ? fnv1a('red') : 0, p: i % 97 === 5 ? [15000 - i, -15000, 0] : [rnd() * w - w / 2, rnd() * w - w / 2, rnd() * 20] }));
  const run = opts => {
    const { hub, sent, step } = hubFor(opts);
    for (let k = 0; k < 3; k++) {
      sent.length = 0;
      for (const q of players) { hub.frame(q.v, frame(q.v, hello(q.id, { core: q.core, room: q.room }))); hub.frame(q.v, frame(q.v, snap(q.id, q.p))); }
      hub.tick(); step(1000);
    }
    return { L: lists(sent), ms: hub.info().tickMsMax };
  };
  const all = run({ exactRoom: 1000 }), grid = run({});
  const at = new Map(players.map(q => [q.v, q])), d = (a, b) => Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]);
  const sum = ({ L }) => {
    let n = 0, m = 0;
    for (const q of players) {
      const l = L.get(`${q.v}:47210`), most = q.core === 1 ? 7 : 32;
      assert.ok(l.length <= most, `at most ${most} (${l.length})`);
      for (const e of l) { assert.ok(L.get(`${e.vip}:47210`).some(x => x.vip === q.v), 'both ends'); assert.equal(at.get(e.vip).room, q.room, 'one room'); n++; m += d(q, at.get(e.vip)); }
    }
    const open = players.filter(q => L.get(`${q.v}:47210`).length < (q.core === 1 ? 7 : 32));
    for (const a of open) for (const b of open)
      if (a !== b && a.room === b.room) assert.ok(L.get(`${a.v}:47210`).some(e => e.vip === b.v), 'two with room are linked');
    return { links: n / 2, mean: m / n };
  };
  const A = sum(all), G = sum(grid);
  console.log(`600 players in ${w} m: every pair ${A.links} links of ${A.mean.toFixed(1)} m (${all.ms.toFixed(0)} ms), the grid ${G.links} of ${G.mean.toFixed(1)} m (${grid.ms.toFixed(0)} ms)`);
  assert.ok(Math.abs(G.links - A.links) <= A.links * 0.01, 'as many links');
  assert.ok(G.mean <= A.mean * 1.03, 'as near');
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
