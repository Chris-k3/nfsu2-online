// The free-roam hub: the server's host on the switch at 10.77.0.253 (runtime/web/net_proto.h NET_ROAM_HUB, an
// address the switch never hands out) that tells each free-roam player which players are near it.  Without it
// every player talks to every other one, in groups of at most 8 (the first to meet); with it a server takes many
// more players: each player's peers are the hub's list of the players nearest to it (runtime/roam_core.c, hub
// mode), and the snapshots still go straight from player to player through the switch.
//
//   player -> hub   a HELLO every second (its id, room, status, name), a SNAP twice a second (where its car is),
//                   a BYE when it stops.  The free-roam wire format (runtime/roam_core.h): a 16-byte header
//                   ("N2FR", version 1, type, length, sender id, sequence, flags; little-endian), the payload,
//                   then the CRC-32 of everything before it.
//   hub -> player   every second a PEERS message: the players linked to it, { virtual address, port, id }, at most
//                   `degree` (7: roam_core's group of 8 with itself); an empty one says the hub is there.
//
// The links, in each room: the pairs of players with a position younger than staleMs (60 s: one in a shop or a
// race keeps its links for a while), nearest first, each player at most `degree` of them.  Both ends of a link
// list each other (roam_core takes a player only when both hear each other).  A link stays at least holdMs (5 s),
// and after that counts as `keep` (half) its distance: a new link costs a handshake, the car's record and maybe a
// car swapped on the screen, so it has to be much nearer to take the place of one (62 simulated players circling
// within 240 m changed links 28 times a second with 20 % instead).  The game shows the nearest 5 of a player's
// links (runtime/roam_game.c).
//
// What the hub keeps, in memory only: per player endpoint its virtual address, port, id, room hash, status, name
// (for info()) and last position; gone goneMs after its last message, when it says BYE, or when it leaves the
// switch.  Reading positions is what choosing by distance costs: the switch itself never looks inside a frame.
// At most maxPerVip endpoints per virtual address (a browser has one), and maxPlayers in all.
import { crc32 } from 'node:zlib';

export const ROAM_HUB_VIP = 0x0A4D00FD;        // 10.77.0.253, runtime/web/net_proto.h NET_ROAM_HUB
const KIND_UDP = 1;                             // the switch's frame kinds (lan.mjs): a UDP datagram
const F_DATA = 16;                              // [0] kind, [4..7] source vip, [8..11] destination vip, [12..15] ports
const MSG = { HELLO: 1, PEERS: 2, SNAP: 3, BYE: 8 };
const HDR = 16, CRC = 4;

export const ROAM_HUB_DEFAULTS = Object.freeze({ degree: 7, tickMs: 1000, staleMs: 60_000, goneMs: 6_000, keep: 0.5, holdMs: 5_000,
  maxPerVip: 2, maxPlayers: 1024 });

/** one free-roam datagram, or null: the fields the hub needs (HELLO, SNAP, BYE), checked as roam_core.c's decoder does */
export function decodeRoam(d) {
  if (d.length < HDR + CRC || d.length > 1200 || d[0] !== 0x4E || d[1] !== 0x32 || d[2] !== 0x46 || d[3] !== 0x52 || d[4] !== 1) return null;
  if (d.readUInt16LE(6) !== d.length || crc32(d.subarray(0, d.length - CRC)) !== d.readUInt32LE(d.length - CRC)) return null;
  const type = d[5], sender = d.readUInt32LE(8), end = d.length - CRC;
  if (!sender) return null;
  if (type === MSG.HELLO) {
    if (end < 29) return null;
    const status = d[19], room = d.readUInt32LE(24), nl = d[28];
    if (nl > 24 || end < 29 + nl + 1 || status > 5) return null;
    const name = d.subarray(29, 29 + nl).toString('latin1');
    if (!/^[\x20-\x7e]*$/.test(name)) return null;
    return { type, sender, status, room, name };
  }
  if (type === MSG.SNAP) {
    if (end < 22 + 52) return null;
    const status = d[16], n = d[20];
    if (n < 1 || n > 3 || status > 5 || end !== 22 + 52 * n) return null;
    const p = [d.readFloatLE(26), d.readFloatLE(30), d.readFloatLE(34)];      // the newest state's position
    if (!p.every(Number.isFinite) || Math.abs(p[0]) > 20000 || Math.abs(p[1]) > 20000 || Math.abs(p[2]) > 2000) return null;
    return { type, sender, status, p };
  }
  if (type === MSG.BYE) return { type, sender };
  return { type, sender };
}

/** a PEERS datagram: list = [{ vip, port, id }] (at most 7: roam_core's RC_MAX_PEERS) */
export function encodePeers(sender, seq, list) {
  const len = HDR + 1 + 10 * list.length + CRC, b = Buffer.alloc(len);
  b.write('N2FR', 0, 'latin1'); b[4] = 1; b[5] = MSG.PEERS; b.writeUInt16LE(len, 6);
  b.writeUInt32LE(sender >>> 0, 8); b.writeUInt16LE(seq & 0xffff, 12); b.writeUInt16LE(0, 14);
  b[16] = list.length;
  list.forEach((e, i) => { const o = 17 + 10 * i; b.writeUInt32BE(e.vip >>> 0, o); b.writeUInt16LE(e.port, o + 4); b.writeUInt32LE(e.id >>> 0, o + 6); });
  b.writeUInt32LE(crc32(b.subarray(0, len - CRC)), len - CRC);
  return b;
}

export class RoamHub {
  /** opts: any of ROAM_HUB_DEFAULTS; now() (ms, for the tests); log(line); timer: false for no tick timer (the tests
   *  call tick()) */
  constructor(opts = {}) {
    this.o = { ...ROAM_HUB_DEFAULTS };
    for (const k of Object.keys(ROAM_HUB_DEFAULTS)) if (Number.isFinite(opts[k]) && opts[k] > 0) this.o[k] = opts[k];
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
    this.send = () => null;
    this.players = new Map();                   // `${vip}:${port}` -> player
    this.id = (Math.random() * 0xfffffffe + 1) >>> 0;
    this.seq = 0;
    this.st = { frames: 0, bad: 0, refused: 0, lists: 0, ticks: 0, tickMsMax: 0 };
    this.timer = opts.timer === false ? null : setInterval(() => this.tick(), this.o.tickMs);
    this.timer?.unref?.();
  }
  get vip() { return ROAM_HUB_VIP; }
  get name() { return 'free-roam hub'; }
  /** the switch's way to its browsers: send(vip, frame) */
  attachSwitch(send) { this.send = send; }
  /** a frame from a browser to the hub's address (the switch has written the true source vip) */
  frame(from, data) {
    this.st.frames++;
    if (data.length < F_DATA + HDR + CRC || data[0] !== KIND_UDP) { this.st.bad++; return; }
    const sport = data.readUInt16BE(12), dport = data.readUInt16BE(14);
    const m = decodeRoam(data.subarray(F_DATA));
    if (!m || !sport) { this.st.bad++; return; }
    const key = `${from}:${sport}`;
    let p = this.players.get(key);
    if (m.type === MSG.BYE) { if (p) this.drop(key); return; }
    if (!p) {
      if (m.type !== MSG.HELLO) return;                  // a player starts with its HELLO (the room)
      let mine = 0;
      for (const q of this.players.values()) if (q.vip === from) mine++;
      if (mine >= this.o.maxPerVip || this.players.size >= this.o.maxPlayers) { this.st.refused++; return; }
      p = { key, vip: from, port: sport, hubPort: dport, id: m.sender, room: m.room, status: m.status, name: m.name,
        p: null, posAt: 0, seen: 0, links: new Map() };   // links: key -> since when
      this.players.set(key, p);
    }
    p.seen = this.now(); p.hubPort = dport;
    if (m.type === MSG.HELLO) {
      if (p.id !== m.sender) p.links = new Map();         // another start of the game on the same endpoint
      p.id = m.sender; p.room = m.room; p.status = m.status; p.name = m.name;
    } else if (m.type === MSG.SNAP && m.sender === p.id) { p.p = m.p; p.posAt = p.seen; p.status = m.status; }
  }
  drop(key) {
    const p = this.players.get(key);
    if (!p) return;
    this.players.delete(key);
    for (const q of this.players.values()) q.links.delete(key);
  }
  peerGone(vip) { for (const [k, p] of this.players) if (p.vip === vip) this.drop(k); }
  /** every tickMs: who is linked to whom, and every player's list */
  tick() {
    const t0 = performance.now(), now = this.now(), o = this.o;
    for (const [k, p] of this.players) if (now - p.seen > o.goneMs) this.drop(k);
    const rooms = new Map();
    for (const p of this.players.values()) {
      if (!p.p || now - p.posAt > o.staleMs) continue;
      let r = rooms.get(p.room); if (!r) rooms.set(p.room, r = []);
      r.push(p);
    }
    const links = new Map();                                // key -> Map of keys -> since when
    for (const p of this.players.values()) links.set(p.key, new Map());
    for (const list of rooms.values()) {
      const pairs = [];
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j], since = a.links.get(b.key);
        const d = since === undefined ? Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2])
          : now - since < o.holdMs ? -1 : Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) * o.keep;
        pairs.push({ d, a: a.key, b: b.key, since: since ?? now });
      }
      pairs.sort((x, y) => x.d - y.d);
      for (const { a, b, since } of pairs) {
        const la = links.get(a), lb = links.get(b);
        if (la.size < o.degree && lb.size < o.degree) { la.set(b, since); lb.set(a, since); }
      }
    }
    for (const p of this.players.values()) {
      p.links = links.get(p.key);
      const list = [...p.links.keys()].map(k => this.players.get(k)).map(q => ({ vip: q.vip, port: q.port, id: q.id }));
      const dgram = encodePeers(this.id, this.seq++, list);
      const f = Buffer.alloc(F_DATA + dgram.length);
      f[0] = KIND_UDP; f.writeUInt32BE(ROAM_HUB_VIP, 4); f.writeUInt32BE(p.vip >>> 0, 8);
      f.writeUInt16BE(p.hubPort, 12); f.writeUInt16BE(p.port, 14);
      dgram.copy(f, F_DATA);
      if (this.send(p.vip, f)) this.st.lists++;
    }
    const ms = performance.now() - t0;
    this.st.ticks++; if (ms > this.st.tickMsMax) this.st.tickMsMax = ms;
  }
  /** for the tests and the server's console: counts only, never a position */
  info() {
    let linked = 0, links = 0;
    for (const p of this.players.values()) { if (p.links.size) linked++; links += p.links.size; }
    return { players: this.players.size, linked, links: links / 2, ...this.st };
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}
