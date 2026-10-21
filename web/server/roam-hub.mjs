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
//                   `degree` (32: roam_core's group of 33 with itself), or 7 for a player whose HELLO says core
//                   version 1 (its group was 8, and it drops a longer list); an empty one says the hub is there.
//
// The links, in each room: the pairs of players with a position younger than staleMs (60 s: one in a shop or a
// race keeps its links for a while), nearest first, each player at most its degree of them.  Both ends of a link
// list each other (roam_core takes a player only when both hear each other).  A link stays at least holdMs (5 s),
// and after that counts as `keep` (half) its distance: a new link costs a handshake, the car's record and maybe a
// car swapped on the screen, so it has to be much nearer to take the place of one (62 simulated players circling
// within 240 m changed links 28 times a second with 20 % instead).  The game shows a car for each of a player's
// links (runtime/roam_game.c).
//
// A busy server gives every player fewer links.  Each link is two players' snapshots to each other, 20 a second each
// way (fewer for far ones), so a crowd costs its players times their links, all on the server's one thread, which the
// switch, Online mode and the page's files share; a thread that cannot keep up delays every snapshot, and the cars
// stutter for everyone (nfsu2.xyz at 855 players, 2026-10-20: 180-600 ms for a /players answer).  While the thread
// worked more than busyHigh of the last tick (performance.eventLoopUtilization) the cap on the links goes down by a
// quarter, at most every capDownMs, to minDegree at the least; once it has room again (under busyLow) the cap goes
// back up by 2 every capUpMs.  The nearest links stay.  While the cap is under askCap (24) free roam counts as busy
// (server.mjs /players roamBusy): the start page does not ask its question (Free roam with others?) at a Play then,
// so fewer new players join a crowd that already gets fewer cars; it asks at a later Play once the cap is back.
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
const DEGREE_V1 = 7;                            // roam_core.h RC_PEERS_V1: what a core of version 1 reads

// exactRoom: a room of at most this many players sorts every pair of them; a larger one takes the pairs in the same
// order but only as far as it needs them: each player's nearest one after another (a grid) until it has its links
// (every pair of 2000 players in one room took the hub 1.5-4.5 s a tick, 1000 players 0.5 s)
export const ROAM_HUB_DEFAULTS = Object.freeze({ degree: 32, tickMs: 1000, staleMs: 60_000, goneMs: 6_000, keep: 0.5, holdMs: 5_000,
  maxPerVip: 2, maxPlayers: 2048, exactRoom: 256, minDegree: 8, busyHigh: 0.85, busyLow: 0.65, capDownMs: 5_000, capUpMs: 15_000, askCap: 24 });
const PER_CELL = 8, MIN_CELL = 5;               // the grid: cells (x and y) for about 8 players each, 5 m at least

/** one free-roam datagram, or null: the fields the hub needs (HELLO, SNAP, BYE), checked as roam_core.c's decoder does */
export function decodeRoam(d) {
  if (d.length < HDR + CRC || d.length > 1200 || d[0] !== 0x4E || d[1] !== 0x32 || d[2] !== 0x46 || d[3] !== 0x52 || d[4] !== 1) return null;
  if (d.readUInt16LE(6) !== d.length || crc32(d.subarray(0, d.length - CRC)) !== d.readUInt32LE(d.length - CRC)) return null;
  const type = d[5], sender = d.readUInt32LE(8), end = d.length - CRC;
  if (!sender) return null;
  if (type === MSG.HELLO) {
    if (end < 29) return null;
    const core = d.readUInt16LE(16), status = d[19], room = d.readUInt32LE(24), nl = d[28];
    if (nl > 24 || end < 29 + nl + 1 || status > 5) return null;
    const name = d.subarray(29, 29 + nl).toString('latin1');
    if (!/^[\x20-\x7e]*$/.test(name)) return null;
    return { type, sender, core, status, room, name };
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

/** a PEERS datagram: list = [{ vip, port, id }] (at most 32: roam_core's RC_MAX_PEERS; 7 for a core of version 1) */
export function encodePeers(sender, seq, list) {
  const len = HDR + 1 + 10 * list.length + CRC, b = Buffer.alloc(len);
  b.write('N2FR', 0, 'latin1'); b[4] = 1; b[5] = MSG.PEERS; b.writeUInt16LE(len, 6);
  b.writeUInt32LE(sender >>> 0, 8); b.writeUInt16LE(seq & 0xffff, 12); b.writeUInt16LE(0, 14);
  b[16] = list.length;
  list.forEach((e, i) => { const o = 17 + 10 * i; b.writeUInt32BE(e.vip >>> 0, o); b.writeUInt16LE(e.port, o + 4); b.writeUInt32LE(e.id >>> 0, o + 6); });
  b.writeUInt32LE(crc32(b.subarray(0, len - CRC)), len - CRC);
  return b;
}

/** pairs in their order into the links: both ends with room */
function link(pairs, links) {
  pairs.sort((x, y) => x.d - y.d);
  for (const { a, b, da, db, since } of pairs) {
    const la = links.get(a), lb = links.get(b);
    if (la.size < da && lb.size < db) { la.set(b, since); lb.set(a, since); }
  }
}
/** the players members (indices into list) by their cell in x and y (sized for PER_CELL players over the area they
 *  span), and the cells they span (positions are within 20 km: at most 8000 cells a side) */
const cellKey = (x, y) => (x + 8192) * 16384 + (y + 8192);
function grid(list, members) {
  let w1 = Infinity, w2 = -Infinity, h1 = Infinity, h2 = -Infinity;
  for (const i of members) { const p = list[i].p; w1 = Math.min(w1, p[0]); w2 = Math.max(w2, p[0]); h1 = Math.min(h1, p[1]); h2 = Math.max(h2, p[1]); }
  const cell = Math.max(MIN_CELL, Math.sqrt(Math.max(1, w2 - w1) * Math.max(1, h2 - h1) * PER_CELL / members.length));
  const cells = new Map(), g = { cell, cells, x1: Math.floor(w1 / cell), x2: Math.floor(w2 / cell), y1: Math.floor(h1 / cell), y2: Math.floor(h2 / cell) };
  for (const i of members) {
    const k = cellKey(Math.floor(list[i].p[0] / cell), Math.floor(list[i].p[1] / cell));
    let c = cells.get(k); if (!c) cells.set(k, c = []);
    c.push(i);
  }
  return g;
}
/** list[i]'s others in grid g, nearest first (next() gives [distance, j], or null after the last; at one distance
 *  the lowest j first): ring after ring of cells around its own; one found is the nearest left once the next ring is
 *  farther (a cell r rings away is at least r - 1 cells off) */
class Near {
  constructor(g, list, i) {
    const a = list[i].p;
    this.g = g; this.list = list; this.i = i; this.a = a; this.x0 = Math.floor(a[0] / g.cell); this.y0 = Math.floor(a[1] / g.cell);
    this.last = Math.max(this.x0 - g.x1, g.x2 - this.x0, this.y0 - g.y1, g.y2 - this.y0); this.r = 0;
    this.found = [];                            // found and not given yet, the nearest last
  }
  next() {
    const f = this.found;
    while (this.r <= this.last && (!f.length || f[f.length - 1][0] > (this.r - 1) * this.g.cell)) {
      const n = f.length;
      this.ring(this.r++);
      if (f.length > n) f.sort((x, y) => y[0] - x[0] || y[1] - x[1]);
    }
    return f.pop() ?? null;
  }
  ring(r) {
    const { x0, y0 } = this;
    if (r === 0) return this.cell(x0, y0);
    for (let x = x0 - r; x <= x0 + r; x++) { this.cell(x, y0 - r); this.cell(x, y0 + r); }
    for (let y = y0 - r + 1; y <= y0 + r - 1; y++) { this.cell(x0 - r, y); this.cell(x0 + r, y); }
  }
  cell(x, y) {
    const c = this.g.cells.get(cellKey(x, y)), a = this.a;
    if (c) for (const j of c) if (j !== this.i) { const b = this.list[j].p; this.found.push([Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), j]); }
  }
}
/** a binary heap of arrays, the least by [0], then [1], then [2] on top */
const before = (x, y) => x[0] < y[0] || (x[0] === y[0] && (x[1] < y[1] || (x[1] === y[1] && x[2] < y[2])));
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(e) {
    const a = this.a;
    let k = a.push(e) - 1;
    while (k > 0) { const up = (k - 1) >> 1; if (!before(e, a[up])) break; a[k] = a[up]; k = up; }
    a[k] = e;
  }
  pop() {
    const a = this.a, top = a[0], e = a.pop();
    if (a.length) {
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && before(a[c + 1], a[c])) c++;
        if (!before(a[c], e)) break;
        a[k] = a[c]; k = c;
      }
      a[k] = e;
    }
    return top;
  }
}

export class RoamHub {
  /** opts: any of ROAM_HUB_DEFAULTS; now() (ms, for the tests); log(line); timer: false for no tick timer (the tests
   *  call tick()); busy() (0 to 1, for the tests): how busy the server's thread was since the last tick */
  constructor(opts = {}) {
    this.o = { ...ROAM_HUB_DEFAULTS };
    for (const k of Object.keys(ROAM_HUB_DEFAULTS)) if (Number.isFinite(opts[k]) && opts[k] > 0) this.o[k] = opts[k];
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
    this.send = () => null;
    this.players = new Map();                   // `${vip}:${port}` -> player
    this.id = (Math.random() * 0xfffffffe + 1) >>> 0;
    this.seq = 0;
    // the cap on every player's links (its degree at most), and when it last changed
    this.cap = this.o.degree; this.capAt = -Infinity;
    let elu = performance.eventLoopUtilization();
    this.busy = opts.busy ?? (() => { const e = performance.eventLoopUtilization(), d = performance.eventLoopUtilization(e, elu); elu = e; return d.utilization; });
    this.st = { frames: 0, bad: 0, refused: 0, lists: 0, ticks: 0, tickMsMax: 0, busy: 0, capCuts: 0 };
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
        degree: 0, p: null, posAt: 0, seen: 0, links: new Map() };   // links: key -> since when
      this.players.set(key, p);
    }
    p.seen = this.now(); p.hubPort = dport;
    if (m.type === MSG.HELLO) {
      if (p.id !== m.sender) p.links = new Map();         // another start of the game on the same endpoint
      p.id = m.sender; p.room = m.room; p.status = m.status; p.name = m.name;
      p.degree = m.core >= 2 ? this.o.degree : Math.min(this.o.degree, DEGREE_V1);
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
    this.adjust(now);
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
      if (list.length > o.exactRoom) { this.linkMany(list, links, now); continue; }
      const pairs = [];
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) pairs.push(this.pair(list[i], list[j], now));
      link(pairs, links);
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
  /** the cap on the links: a quarter down while the server's thread is busy, 2 up once it has room again */
  adjust(now) {
    const o = this.o, busy = this.busy(), was = this.cap;
    this.st.busy = Math.round(busy * 100);
    if (busy > o.busyHigh && now - this.capAt >= o.capDownMs) this.cap = Math.max(Math.min(o.minDegree, o.degree), Math.floor(this.cap * 3 / 4));
    else if (busy < o.busyLow && now - this.capAt >= o.capUpMs) this.cap = Math.min(o.degree, this.cap + 2);
    if (this.cap === was) return;
    this.capAt = now;
    if (this.cap < was) this.st.capCuts++;
    this.log(`[roam] the server's thread was ${this.st.busy} % busy: at most ${this.cap} links a player (was ${was})`);
  }
  /** free roam is busy: the cap is under askCap (the start page does not ask new players then) */
  crowded() { return this.cap < this.o.askCap; }
  /** a player's links at most: its degree, under the cap */
  degreeOf(p) { return Math.min(p.degree, this.cap); }
  /** a pair of players and its place in the order: a link younger than holdMs first, an older one at keep its distance */
  pair(a, b, now) {
    const since = a.links.get(b.key);
    const d = since === undefined ? Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2])
      : now - since < this.o.holdMs ? -1 : Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) * this.o.keep;
    return { d, a: a.key, b: b.key, da: this.degreeOf(a), db: this.degreeOf(b), since: since ?? now };
  }
  /** the links of a room larger than exactRoom, as link() makes them from every pair sorted (at one place in the
   *  order the pair of the lower index first), without sorting them all: the last tick's links at their own place,
   *  and each player's nearest one after another (Near) while it has room, merged in that order (a Heap) */
  linkMany(list, links, now) {
    const at = new Map(list.map((p, i) => [p.key, i])), mine = list.map(p => links.get(p.key));
    const deg = list.map(p => this.degreeOf(p));
    const room = i => mine[i].size < deg[i], old = (i, j) => list[i].links.has(list[j].key) || list[j].links.has(list[i].key);
    const g = grid(list, list.map((_, i) => i)), heap = new Heap(), near = [];
    const put = (d, i, j, since, nearest) => heap.push([d, Math.min(i, j), Math.max(i, j), i, j, since, nearest]);
    const ahead = i => { const c = near[i].next(); if (c) put(c[0], i, c[1], now, true); };
    for (let i = 0; i < list.length; i++) {
      for (const k of list[i].links.keys()) {
        const j = at.get(k);
        if (j !== undefined && (i < j || !list[j].links.has(list[i].key))) { const q = this.pair(list[i], list[j], now); put(q.d, i, j, q.since, false); }
      }
      near.push(new Near(g, list, i));
      ahead(i);
    }
    while (heap.size) {
      const [, , , i, j, since, nearest] = heap.pop();
      if (nearest) {
        if (room(i)) ahead(i);
        if (old(i, j)) continue;                    // a link of the last tick: in the heap at its own place
      }
      if (room(i) && room(j) && !mine[i].has(list[j].key)) { mine[i].set(list[j].key, since); mine[j].set(list[i].key, since); }
    }
  }
  /** for the tests and the server's console: counts only, never a position */
  /** the browsers in free roam now (a HELLO within goneMs) */
  vips() { return new Set([...this.players.values()].map(p => p.vip)); }
  info() {
    let linked = 0, links = 0;
    for (const p of this.players.values()) { if (p.links.size) linked++; links += p.links.size; }
    return { players: this.players.size, linked, links: links / 2, cap: this.cap, ...this.st };
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}
