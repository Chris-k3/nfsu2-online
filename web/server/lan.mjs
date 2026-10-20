// The virtual LAN switch.  Every browser that joins gets a virtual IPv4
// address (10.77.0.x).  Binary frames carry the game's network traffic; the
// switch only routes them and never looks inside:
//   [0]     u8  kind (opaque to the switch: datagram, stream open/data/close, ...)
//   [1..3]  reserved
//   [4..7]  u32 source vip      (rewritten here to the sender's own address)
//   [8..11] u32 destination vip (0xFFFFFFFF = broadcast to everyone else)
//   [12..]  payload (ports and data, defined by the runtime's socket layer)
// Numbers are big-endian.  Kinds in use (runtime/web/net_proto.h, web/src/net):
//   1  UDP datagram: [12..13] source port, [14..15] destination port, [16..] data
//   2  UDP datagram on the test harness's emulated loopback (same layout,
//      always to the broadcast address; only test-mode instances take it)
//   3, 4, 5  LAN play (the Winsock HLE, runtime/web/net_lan.c): UDP, TCP
//      segments and ICMP with ports at [12..15] and an 8-byte LAN header
//      (op, ttl, connection id) before the data; broadcasts as kind 1
// Text frames are JSON control messages: {"t":"hello","name":...,"deltas":1} and
// {"t":"ping","id":n} from a client; {"t":"welcome","vip":...,"token":...},
// {"t":"peers",...}, {"t":"delta",...} and {"t":"pong","id":n} from the switch.
//
// The peer list.  A connection's first hello names its player (later ones
// change nothing: the page sends one a connection) and gets it the whole list,
// {"t":"peers","peers":[{vip,name},...]}.  After that a client whose hello
// said "deltas":1 (the page) hears only what changed, at most every peersMs:
// {"t":"delta","peers":[{vip,name} that joined or got their name],"gone":[vip
// that left (and may be back: the client takes gone first)]}.  One that did
// not (a page of before), or sent no hello, gets the whole list again, at most
// every fullPeersMs.
// (The security review: each rename, 20 a second per connection, sent the
// whole list to everyone: 11,700 times what came in, at 100 players.)
//
// Addresses belong to the connection that holds them.  The welcome carries a
// random token (128 bits) that only that client sees.  A client that lost its
// connection opens /lan?resume and sends, as its first message, a hello with
// its old address and that token ({"t":"hello","name":...,"vip":"10.77.0.x",
// "token":...}); it gets the address back.  Nobody else can: when a holder
// leaves, its address stays reserved for its token for reserveMs, and an
// address is never handed out on request without the token (the audit's F1:
// /lan?vip= gave a dropped player's address, and the frames other players
// sent to it, to whoever asked first).  A reservation is never given to
// another client either, not even when every address is held or reserved: a
// newcomer then gets "LAN full" until one frees (the review of F1: handing
// out the oldest reservation let a client that opened and closed connections
// fast enough take a dropped player's address within 60 ms).  So that one
// client cannot reserve them all, a client (group) keeps at most groupReserve
// reservations and a site siteReserve; past that its own oldest one goes.
// A resume with the token also replaces a connection of the same client that
// the switch still holds (one that died without a close).  Without ?resume
// the welcome comes at once, as before.
// With a store (the server's state folder), the addresses held and reserved
// (by a hash of their tokens) outlive a restart of the server: each is
// reserved for its token again for reserveMs after the start, so the players
// come back to the same addresses, as they did before tokens.
//
// What a peer learns about the others: their virtual address and the display
// name they chose (control and format characters removed, at most 32
// characters), nothing else.  The switch is never told who a peer really is
// (no address, no headers): the server counts connections per client address
// itself (server.mjs) and hands the switch only opaque ids for the limits
// shared by one client's connections: a group (one client address) and a site
// (an IPv6 /48, which holds 256 client addresses).  Close reasons are fixed
// texts.
//
// Limits (sized to the game: free roam sends 20 snapshots a second of about
// 95 bytes to each friend, 1.9 KB/s per friend; the host of a 3-player LAN
// race sent at most 100 frames and 7.7 KB a second (the audit's measurement on
// the switch); LAN play's frames are at most an Ethernet MTU,
// runtime/web/net_proto.h NET_SLOT_BYTES 1536):
//   maxPeers     players on the switch at once (one more: closed with 1013)
//   maxFrame     bytes in one binary frame (larger ones are dropped)
//   frameRate    binary frames per second per connection (token bucket, burst = 2 s worth)
//   byteRate     binary bytes per second per connection (the same)
//   groupFrameRate, groupByteRate  the same for all connections of one client
//                address together (the group id the server passes)
//   siteFrameRate, siteByteRate    and for all of one site (the site id)
//                A broadcast costs its size times the players it reaches, so
//                the switch never sends more for a client than these allow
//                (the audit's F2: one 4 MB/s sender made it send 15 x that).
//   textRate     control messages per second; maxText bytes each
//   peersMs      what changed on the peer list goes out at most this often, as one
//                message to each player (a join and its name in one)
//   fullPeersMs  the whole list to a client that does not take changes, at most this often
//   ctlRate      WebSocket control frames per second (token bucket, burst = 2 s
//                worth): pings, which the switch answers itself, and pongs it
//                did not ask for.  No browser sends either (the WebSocket API
//                has no ping), so a client over the rate is disconnected.
//   shedQueue    datagrams (kinds 1, 2, 3, 5 and unknown kinds) to a receiver
//                with more than this queued are dropped, as a full link drops
//                UDP: a flood never gets a slower player disconnected
//   roamQueue    the same for kind 1 (free roam's snapshots, and LAN play's
//                broadcasts), at a much shorter queue: about a second of free
//                roam (a SNAP of 94 bytes, 20 a second from each of up to 7
//                friends).  A car's position is of no use once it is that old
//                (the game draws friends' cars 100 ms in the past and throws
//                late ones away), so a receiver whose link falls behind gets
//                the newest ones as soon as it catches up, not seconds of old
//                ones first.  The queue is the switch's own: the kernel's
//                buffer to the receiver (or to the tunnel) comes before it
//   streamQueue, streamShare  LAN play's TCP segments (kind 4) are never
//                dropped (the virtual LAN's streams have no retransmission).
//                A receiver may have streamQueue of them queued, streamShare
//                of those from one client (group).  Past that, whose fault it
//                is decides who goes: a receiver that has stopped reading
//                (nothing it was sent got out for stallMs while segments
//                waited) is disconnected; otherwise the senders outrun it and
//                the client with the most queued there is disconnected, all of
//                its connections (the review of the audit's F2: streams from 9
//                addresses got a reading victim cut, and a receiver that
//                stopped reading got its sender cut).  A LAN race's host sends
//                about 11 KB of stream data a race.
//   sendBuffer   bytes queued towards one receiver: a receiver that falls this
//                far behind anyway (it stopped reading) is disconnected (it
//                reconnects and gets its address back).  Checked before
//                everything the switch sends and on every keepalive tick.
//   onlineQueue  bytes queued towards one receiver past which the online host
//                sends it nothing more (the host closes that stream instead)
//   keepaliveMs  a WebSocket ping this often, well under a proxy's idle cut
//                (Cloudflare closes a WebSocket that stays quiet for about
//                100 s); no pong to that ping (its payload is random: only a
//                client that reads can answer) by the next ping = the
//                connection is gone
//   idleMs       no message at all from the client for this long: closed (the
//                page pings the switch every 2 s while it is connected)
//   reserveMs    how long a departed player's address waits for its token
//   groupReserve, siteReserve  departed players' addresses kept for one
//                client (group), and for one site, at most
//   resumeWaitMs how long a ?resume connection may take to send its hello
//
// The WebSocketServer the switch's connections come from must be made with
// LAN_WSS_OPTIONS: the ws library's own automatic pong answers every ping
// without a limit and queues the pongs for a client that never reads (the
// phase-2 deploy review's finding 1: gigabytes in seconds).
//
// online (server.mjs, online/index.mjs): the server's own host on the switch,
// 10.77.0.1 (an address the switch never hands out).  It is on every peer list
// as { vip, name, server: true } (so a page lets the game connect to it; the
// page shows it to nobody), frames addressed to it go to online.frame(from,
// frame, { group, site }) instead of to a browser (broadcasts never do; group
// and site are the sender's opaque ids, for the host's own per-client limits),
// it answers through sendTo(), and online.peerGone(vip) hears of every browser
// that left.  What the host sends while it handles a frame (its answer, and
// what it tells other players because of it: a lobby's chat, a game's
// players) is charged to the sender's budgets, as a broadcast is; a sender
// that overspends them has the stream that frame came on closed
// (online.overrun(from, frame)) and pays the debt off before its next frame
// gets through.  The host's frames are never dropped on the way (its streams
// have no retransmission): a receiver with more than onlineQueue queued is not
// sent more, and the host closes the stream it was for, instead of the whole
// connection being cut (the Online audit's ONL-2).
//
// roam (server.mjs, roam-hub.mjs): the server's free-roam hub, 10.77.0.253, the same way: frames to it go to
// roam.frame(from, frame), it sends through sendTo() (its own lists, every second: charged to nobody), and
// roam.peerGone(vip) hears of every browser that left.  It is on no peer list.
//
// tap (a test aid, server option --online-trace): sees every frame the switch
// takes from a browser or sends for the online host (online/trace.mjs).
//
// impair (a test aid, server option --lan-impair): LAN play's frames (kinds
// 3-5) between browsers get tools/vlanhub.py's impairments: UDP and ICMP are
// delayed by delay +- jitter ms, lost with loss %, reordered with reorder %
// (2 x delay + 5 ms more); TCP (kind 4) is only delayed, in order.  Free
// roam's frames are never touched (roam has its own knob in the runtime).
import crypto from 'node:crypto';

const BASE = (10 << 24) | (77 << 16);
const BROADCAST = 0xFFFFFFFF;
const KIND_UDP = 1;             // free roam's datagrams (and LAN play's broadcasts): dropped first (roamQueue)
const KIND_STREAM = 4;          // LAN play's TCP segments: never dropped
const STREAM_LOW = 64 << 10;    // a receiver with less than this queued gets stream segments at once

/** options for the WebSocketServer whose connections the switch takes (see above) */
export const LAN_WSS_OPTIONS = Object.freeze({ autoPong: false });

export const LAN_DEFAULTS = Object.freeze({
  maxPeers: 128, maxFrame: 8192, frameRate: 1000, byteRate: 256 << 10, groupFrameRate: 2000, groupByteRate: 512 << 10,
  siteFrameRate: 4000, siteByteRate: 1 << 20,
  textRate: 20, maxText: 1024, ctlRate: 10, shedQueue: 256 << 10, roamQueue: 16 << 10, streamQueue: 2 << 20, streamShare: 1 << 20, stallMs: 1000,
  sendBuffer: 8 << 20, keepaliveMs: 25_000, idleMs: 10 * 60_000, reserveMs: 60_000, groupReserve: 8, siteReserve: 16,
  resumeWaitMs: 5_000, onlineQueue: 1 << 20, peersMs: 250, fullPeersMs: 1000,
});

class Bucket {
  constructor(rate) { this.rate = rate; this.cap = rate * 2; this.v = this.cap; this.t = performance.now(); }
  /** refilled, and n is there */
  has(n = 1) {
    const t = performance.now();
    this.v = Math.min(this.cap, this.v + (t - this.t) / 1000 * this.rate); this.t = t;
    return this.v >= n;
  }
  take(n = 1) { if (!this.has(n)) return false; this.v -= n; return true; }
  /** n spent whether it is there or not (a debt of at most one burst); false once it was not */
  spend(n) { this.has(0); this.v = Math.max(-this.cap, this.v - n); return this.v >= 0; }
}

/** a display name: printable, no bidi or zero-width tricks, at most 32 characters */
export function cleanName(s) {
  const t = String(s).normalize('NFC').replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/ +/g, ' ').trim();
  return [...t].slice(0, 32).join('').trim() || 'player';
}

const newToken = () => crypto.randomBytes(16).toString('base64url');
const tokenHash = t => crypto.createHash('sha256').update(String(t)).digest();
/** token (from a client) matches hash (of the token the switch gave) */
function tokenFits(token, hash) {
  if (typeof token !== 'string' || token.length > 64 || !Buffer.isBuffer(hash) || hash.length !== 32) return false;
  return crypto.timingSafeEqual(tokenHash(token), hash);
}

export class LanSwitch {
  /** opts: any of LAN_DEFAULTS; others are ignored; opts.store: { load() -> [{ v, h }], save([{ v, h }]) } */
  constructor(opts = {}) {
    this.o = { ...LAN_DEFAULTS };
    for (const k of Object.keys(LAN_DEFAULTS)) if (Number.isFinite(opts[k]) && opts[k] > 0) this.o[k] = opts[k];
    this.peers = new Map(); this.next = 2; this.frames = 0; this.bytes = 0; this.dropped = 0; this.limited = 0; this.refused = 0;
    this.shed = 0;                       // datagrams dropped for a receiver's full queue
    this.resumed = 0;                    // addresses given back to their token
    // a departed holder's address -> { hash, until, group, site }: kept for that token only
    this.reserved = new Map();
    // limits shared by the connections of one client address (group id) and of one site (site id): -> { frames, bytes, n }
    this.groups = new Map(); this.sites = new Map(); this.anon = 0;
    // connections the switch closed, by why: control-frame flood, a queue over sendBuffer (when sending,
    // on the keepalive tick), no pong to its ping, idle, a client that flooded a receiver with stream
    // segments, a receiver that stopped reading the stream segments it was sent
    this.cuts = { flood: 0, slow: 0, queue: 0, dead: 0, idle: 0, hog: 0, stall: 0 };
    this.evicted = 0;                    // reservations a client gave up for its newer ones (groupReserve, siteReserve)
    // the peer list: addresses that joined, got their name or left since the last change went out (and the ones
    // that left), and when the whole list last went to the clients that take no changes
    this.changed = new Set(); this.left = new Set(); this.deltaTimer = null; this.fullTimer = null; this.fullAt = -Infinity;
    // --lan-impair (test aid, only with the server's --dev)
    this.impair = parseImpair(opts.impair); this.lost = 0; this.tcpLast = new Map();
    let x = (this.impair?.seed ?? 1) >>> 0 || 1;
    this.rand = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
    this.timer = setInterval(() => this.keepalive(), this.o.keepaliveMs);
    this.timer.unref?.();
    // the addresses of before a restart: reserved for their tokens again
    this.store = opts.store ?? null; this.saveTimer = null;
    if (this.store) {
      let list = [];
      try { list = this.store.load() ?? []; } catch { /* none */ }
      const until = Date.now() + this.o.reserveMs;
      for (const e of Array.isArray(list) ? list : []) {
        const v = vipNum(String(e?.v ?? '')), h = typeof e?.h === 'string' ? Buffer.from(e.h, 'base64url') : null;
        if (v && h?.length === 32) this.reserved.set(v, { hash: h, until });
      }
    }
    this.tap = typeof opts.tap === 'function' ? opts.tap : null;
    this.online = opts.online ?? null;
    // while the online host handles a frame: the sender's buckets (what it sends then is charged to them), and
    // whether they ran dry
    this.cause = null; this.causeOver = false;
    this.online?.attachSwitch?.((vip, data) => this.sendTo(vip, data));
    this.roam = opts.roam ?? null;
    this.roam?.attachSwitch?.((vip, data) => this.sendTo(vip, data));
  }
  /** the store gets the addresses held and reserved, shortly after a change */
  persist() {
    if (!this.store || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 500);
    this.saveTimer.unref?.();
  }
  flush() {
    clearTimeout(this.saveTimer); this.saveTimer = null;
    if (!this.store) return;
    const now = Date.now(), list = [];
    for (const p of this.peers.values()) list.push({ v: vipStr(p.vip), h: p.tokenHash.toString('base64url') });
    for (const [v, r] of this.reserved) if (r.until > now && !this.peers.has(v)) list.push({ v: vipStr(v), h: r.hash.toString('base64url') });
    try { this.store.save(list); } catch { /* the next change tries again */ }
  }
  /** the online host's frames to one browser (never through the impairment); not sent: false (the receiver is
   *  too far behind) or null (it is not on the switch), and the host closes the stream it was for */
  sendTo(vip, data) {
    const p = this.peers.get(vip >>> 0);
    if (!p || p.ws.readyState !== 1) { this.dropped++; return null; }
    if (p.ws.bufferedAmount > this.o.onlineQueue) { this.shed++; return false; }
    if (this.cause) for (const b of this.cause) if (!b.frames.spend(1) | !b.bytes.spend(data.length)) this.causeOver = true;
    if (!this.send(p, data)) return false;
    p.framesOut++;
    return true;
  }
  /** for the tests: names and virtual addresses only, never a real address */
  info() {
    return { peers: [...this.peers.values()].map(p => ({ vip: vipStr(p.vip), name: p.name, framesIn: p.framesIn, framesOut: p.framesOut })),
      frames: this.frames, bytes: this.bytes, dropped: this.dropped, limited: this.limited, refused: this.refused, shed: this.shed,
      resumed: this.resumed, reserved: this.reserved.size, evicted: this.evicted, cuts: { ...this.cuts },
      ...(this.impair ? { impair: this.impair, lost: this.lost } : {}),
      ...(this.online ? { online: this.online.info() } : {}), ...(this.roam ? { roam: this.roam.info() } : {}) };
  }
  /** one frame to one peer: through the impairment when it is on, always through send() (the queue rules) */
  deliver(from, p, data) {
    const out = () => { if (p.ws.readyState === 1 && this.sendFrame(from, p, data)) p.framesOut++; };
    const im = this.impair, kind = data[0];
    if (!im || kind < 3 || kind > 5) return out();
    let d = im.delay;
    if (kind === 4) {
      const key = `${from.vip}>${p.vip}`, now = Date.now();
      const t = Math.max(now + d, this.tcpLast.get(key) ?? 0);
      this.tcpLast.set(key, t); d = t - now;
    } else {
      if (im.loss && this.rand() * 100 < im.loss) { this.lost++; return; }
      if (im.jitter) d += (this.rand() * 2 - 1) * im.jitter;
      if (im.reorder && this.rand() * 100 < im.reorder) d += 2 * im.delay + 5;
    }
    setTimeout(out, Math.max(0, d));
  }
  /** a binary frame to a receiver: a datagram is dropped while the receiver's queue is long, a stream
   *  segment never is (see streamQueue: the receiver or the client flooding it goes instead) */
  sendFrame(from, p, data) {
    if (data[0] !== KIND_STREAM) {
      if (p.ws.bufferedAmount > (data[0] === KIND_UDP ? this.o.roamQueue : this.o.shedQueue)) { this.shed++; return false; }
      return this.send(p, data);
    }
    const g = from.group.id, len = data.length;
    let mine = p.streamQueued.get(g);
    if ((mine?.n ?? 0) + len > this.o.streamShare || p.streamTotal + len > this.o.streamQueue) {
      if (this.stalled(p)) { this.cuts.stall++; p.ws.terminate(); return false; }
      // the receiver reads, and more comes than it takes: the client with the most queued there goes
      let top = g, most = mine?.n ?? 0;
      for (const [k, v] of p.streamQueued) if (v.n > most) { most = v.n; top = k; }
      this.cutGroup(top, 'hog');
      if (top === g) return false;
      mine = p.streamQueued.get(g);
    }
    if (!this.room(p)) { this.dropped++; return false; }
    // straight to the connection while it has little queued; behind the switch's own queue otherwise, so that
    // what the receiver takes is seen segment by segment (the socket reports a long queue only once all of it
    // is written)
    if (!p.sq.length && p.ws.bufferedAmount <= STREAM_LOW) { p.ws.send(data); return true; }
    if (!p.sq.length) { p.streamSince = performance.now(); p.streamOut = p.streamSince; }
    if (!mine) p.streamQueued.set(g, mine = { n: 0 });
    mine.n += len; p.streamTotal += len;
    p.sq.push({ data, mine, g });
    this.pump(p);
    return true;
  }
  /** p's queued stream segments into its connection, as far as it has taken the ones before */
  pump(p) {
    if (p.ws.readyState !== 1) { p.sq.length = 0; return; }
    while (p.sq.length && p.ws.bufferedAmount <= STREAM_LOW) {
      const { data, mine, g } = p.sq.shift();
      mine.n -= data.length; p.streamTotal -= data.length; p.streamOut = performance.now();
      if (mine.n <= 0 && p.streamQueued.get(g) === mine) p.streamQueued.delete(g);
      p.ws.send(data);
    }
    if (p.sq.length && !p.pumpTimer) p.pumpTimer = setTimeout(() => { p.pumpTimer = null; this.pump(p); }, 10);
  }
  /** p has stream segments waiting and none of them got out for stallMs: it stopped reading */
  stalled(p) {
    const now = performance.now(), ms = this.o.stallMs;
    return p.sq.length > 0 && now - p.streamSince > ms && now - p.streamOut > ms;
  }
  /** every connection of one client (group id) goes, and the stream segments of it still waiting at the others */
  cutGroup(id, why) {
    for (const q of this.peers.values()) {
      if (q.group.id === id && q.ws.readyState === 1) { this.cuts[why]++; q.ws.terminate(); }
      const e = q.streamQueued.get(id);
      if (!e) continue;
      q.streamQueued.delete(id); q.streamTotal -= e.n;
      q.sq = q.sq.filter(x => x.mine !== e);
    }
  }
  /**
   * A new connection.  The second argument is ignored on purpose: it used to
   * be the client's address, and the switch keeps none.
   * opts.resume: the client asked for /lan?resume (its first message says which address, with the token)
   * opts.group: an opaque id shared by the connections of one client address (their shared limits)
   * opts.site: the same for one site (an IPv6 /48), or none
   * opts.onJoin(vip, resumed) and opts.onLeave(vip, name): for the server's console
   * (A string here, the old ?vip= request, is ignored: an address goes only to its token.)
   */
  attach(ws, _unused = null, opts = {}) {
    ws.on('error', () => {});
    if (opts === null || typeof opts !== 'object') opts = {};
    const group = this.group(this.groups, opts.group, this.o.groupFrameRate, this.o.groupByteRate);
    const site = opts.site == null ? null : this.group(this.sites, opts.site, this.o.siteFrameRate, this.o.siteByteRate);
    ws.once('close', () => { this.release(this.groups, group); if (site) this.release(this.sites, site); });
    if (!opts.resume) return this.admit(ws, group, site, opts, null);
    // a resume: the hello first (the welcome follows it), within resumeWaitMs
    const wait = setTimeout(() => { ws.off('message', first); this.admit(ws, group, site, opts, null); }, this.o.resumeWaitMs);
    const first = (data, isBinary) => {
      clearTimeout(wait);
      let m = null;
      if (!isBinary && (data.length ?? 0) <= this.o.maxText) { try { m = JSON.parse(String(data)); } catch { /* not JSON */ } }
      this.admit(ws, group, site, opts, m && typeof m === 'object' && m.t === 'hello' ? m : null);
    };
    ws.once('message', first);
    ws.once('close', () => clearTimeout(wait));
  }
  group(map, id, frameRate, byteRate) {
    const key = id == null ? `#${++this.anon}` : String(id);
    let g = map.get(key);
    if (!g) map.set(key, g = { id: key, n: 0, frames: new Bucket(frameRate), bytes: new Bucket(byteRate) });
    g.n++;
    return g;
  }
  release(map, g) { if (--g.n <= 0 && map.get(g.id) === g) map.delete(g.id); }
  /** a free address that is nobody's reservation, or 0: a reservation is never given to anyone but its token */
  allocate() {
    const now = Date.now();
    for (const [v, r] of this.reserved) if (r.until <= now) this.reserved.delete(v);
    for (let i = 0; i < 250; i++) {
      const c = (BASE | (((this.next - 2 + i) % 250) + 2)) >>> 0;
      if (!this.peers.has(c) && !this.reserved.has(c)) { this.next = (c & 0xff) + 1; return c; }
    }
    return 0;
  }
  /** a newcomer would get "LAN full" now: every place taken, or every address in use or kept for its player */
  get full() {
    if (this.peers.size >= this.o.maxPeers) return true;
    const now = Date.now();
    for (let h = 2; h <= 251; h++) {
      const c = (BASE | h) >>> 0;
      if (!this.peers.has(c) && !(this.reserved.get(c)?.until > now)) return false;
    }
    return true;
  }
  /** vip is kept for its token; past its client's (and site's) share of reservations, that client's own oldest go */
  reserve(vip, peer) {
    const now = Date.now(), group = peer.group.id, site = peer.site?.id ?? null;
    this.reserved.set(vip, { hash: peer.tokenHash, until: now + this.o.reserveMs, group, site });
    const trim = (match, max) => {
      const mine = [...this.reserved].filter(([, r]) => r.until > now && match(r)).sort((a, b) => a[1].until - b[1].until);
      for (const [v] of mine.slice(0, Math.max(0, mine.length - max))) { this.reserved.delete(v); this.evicted++; }
    };
    trim(r => r.group === group, this.o.groupReserve);
    if (site) trim(r => r.site === site, this.o.siteReserve);
  }
  admit(ws, group, site, opts, hello) {
    if (ws.readyState !== 1) return;
    const o = this.o;
    // the address: given back only to the token that held it
    let vip = 0, old = null;
    if (hello && typeof hello.token === 'string') {
      const w = vipNum(String(hello.vip ?? ''));
      const r = this.reserved.get(w), holder = this.peers.get(w);
      if (!holder && r && r.until > Date.now() && tokenFits(hello.token, r.hash)) vip = w;
      else if (holder && tokenFits(hello.token, holder.tokenHash)) { vip = w; old = holder; }
    }
    // a connection that replaces its own older one takes no new place
    if (!old && this.peers.size >= o.maxPeers) { this.refused++; return ws.close(1013, 'LAN full'); }
    const resumed = !!vip;
    if (resumed) { this.reserved.delete(vip); this.resumed++; }
    else if (!(vip = this.allocate())) { this.refused++; return ws.close(1013, 'LAN full'); }
    const token = newToken();
    // hello: its first hello came (the name, and deltas: it takes the changes to the peer list)
    const peer = { ws, vip, name: 'player', hello: false, deltas: false, tokenHash: tokenHash(token), group, site, framesIn: 0, framesOut: 0, alive: true, lastIn: Date.now(), pingData: null,
      // stream segments waiting for this receiver (sq: { data, mine, g }), their bytes by sending group ({ n }) and
      // in all, since when the queue is not empty, and when one last went out
      sq: [], pumpTimer: null, streamQueued: new Map(), streamTotal: 0, streamSince: 0, streamOut: 0,
      frames: new Bucket(o.frameRate), bytes: new Bucket(o.byteRate), texts: new Bucket(o.textRate), ctl: new Bucket(o.ctlRate) };
    if (hello) { peer.texts.take(1); greet(peer, hello); }
    this.peers.set(vip, peer);
    // the same client's older connection (it died without a close): it goes, and its late close changes nothing
    if (old) old.ws.terminate();
    ws.binaryType = 'nodebuffer';
    // control frames: a ping is answered here (LAN_WSS_OPTIONS turns the library's own answer off), under the
    // rate and while the queue has room; only a pong carrying the payload of the switch's last ping says the
    // client is there
    const flood = () => { if (peer.ctl.take(1)) return false; this.cuts.flood++; ws.terminate(); return true; };
    ws.on('ping', data => {
      if (ws.readyState !== 1 || flood() || !this.room(peer)) return;
      ws.pong(data, false, () => {});
    });
    ws.on('pong', data => {
      if (peer.pingData && data.equals(peer.pingData)) { peer.alive = true; peer.pingData = null; return; }
      flood();
    });
    ws.send(JSON.stringify({ t: 'welcome', vip, vipStr: vipStr(vip), mask: '255.255.255.0', token }));
    if (peer.hello) this.send(peer, this.peerList());
    this.peersChanged(vip);
    this.persist();
    opts.onJoin?.(vip, resumed);
    ws.on('message', (data, isBinary) => {
      if (ws.readyState !== 1) return;              // cut: what it sent last goes nowhere
      peer.alive = true; peer.lastIn = Date.now();
      const n = data.length ?? 0;
      if (!isBinary) {
        if (n > o.maxText || !peer.texts.take(1)) { this.limited++; return; }
        let m; try { m = JSON.parse(String(data)); } catch { return; }
        if (!m || typeof m !== 'object') return;
        if (m.t === 'hello') {
          if (peer.hello) return;
          const was = peer.name;
          greet(peer, m);
          this.send(peer, this.peerList());
          if (peer.name !== was) this.peersChanged(vip);
        } else if (m.t === 'ping' && Number.isSafeInteger(m.id)) this.send(peer, JSON.stringify({ t: 'pong', id: m.id }));
        return;
      }
      if (n < 12) return;
      if (n > o.maxFrame) { this.limited++; return; }
      const dst = data.readUInt32BE(8);
      const to = [];
      if (dst === BROADCAST) { for (const p of this.peers.values()) if (p !== peer && p.ws.readyState === 1) to.push(p); }
      else { const p = this.peers.get(dst); if (p && p.ws.readyState === 1) to.push(p); }
      // what the switch sends for it: a broadcast costs its size for every player it reaches
      const k = Math.max(1, to.length);
      const buckets = site ? [peer, group, site] : [peer, group];
      if (!buckets.every(b => b.frames.has(k) && b.bytes.has(n * k))) { this.limited++; return; }
      for (const b of buckets) { b.frames.take(k); b.bytes.take(n * k); }
      data.writeUInt32BE(vip, 4);
      this.frames++; this.bytes += n; peer.framesIn++;
      this.tap?.(data);
      if (this.roam && dst === this.roam.vip) { this.roam.frame(vip, data); return; }
      if (this.online && dst === this.online.vip) {
        this.cause = buckets; this.causeOver = false;
        try { this.online.frame(vip, data, { group: group.id, site: site?.id ?? null }); } finally { this.cause = null; }
        if (this.causeOver) { this.limited++; this.online.overrun?.(vip, data); }
        return;
      }
      if (!to.length) { this.dropped++; return; }
      for (const p of to) this.deliver(peer, p, data);
    });
    // an old connection's late close must not take the address from a new holder
    ws.on('close', () => {
      clearTimeout(peer.pumpTimer); peer.sq.length = 0;
      if (this.peers.get(vip) !== peer) return;
      this.peers.delete(vip);
      this.reserve(vip, peer);
      this.persist();
      for (const k of this.tcpLast.keys()) if (k.startsWith(`${vip}>`) || k.endsWith(`>${vip}`)) this.tcpLast.delete(k);
      this.online?.peerGone(vip);
      this.roam?.peerGone(vip);
      this.peersChanged(vip, true);
      opts.onLeave?.(vip, peer.name);
    });
  }
  /** room in p's queue; a peer that cannot keep up is disconnected instead of buffered without end */
  room(p, why = 'slow') {
    if (p.ws.bufferedAmount <= this.o.sendBuffer) return true;
    this.cuts[why]++; p.ws.terminate();
    return false;
  }
  /** to one peer, when there is room */
  send(p, data) {
    if (!this.room(p)) { this.dropped++; return false; }
    p.ws.send(data);
    return true;
  }
  /** the whole peer list, as a message */
  peerList() {
    const list = [...this.peers.values()].map(p => ({ vip: p.vip, name: p.name }));
    if (this.online) list.push({ vip: this.online.vip, name: this.online.name, server: true });
    return JSON.stringify({ t: 'peers', peers: list });
  }
  /** vip joined, got its name or left: everyone hears of it peersMs later, with whatever else changed by then */
  peersChanged(vip, left = false) {
    this.changed.add(vip); if (left) this.left.add(vip);
    if (!this.deltaTimer) { this.deltaTimer = setTimeout(() => this.sendDelta(), this.o.peersMs); this.deltaTimer.unref?.(); }
    if (!this.fullTimer) {
      this.fullTimer = setTimeout(() => this.sendFull(), Math.max(this.o.peersMs, this.fullAt + this.o.fullPeersMs - performance.now()));
      this.fullTimer.unref?.();
    }
  }
  sendDelta() {
    this.deltaTimer = null;
    const peers = [...this.changed].filter(v => this.peers.has(v)).map(v => ({ vip: v, name: this.peers.get(v).name }));
    const msg = JSON.stringify({ t: 'delta', peers, gone: [...this.left] });
    this.changed.clear(); this.left.clear();
    for (const p of this.peers.values()) if (p.deltas && p.ws.readyState === 1) this.send(p, msg);
  }
  sendFull() {
    this.fullTimer = null; this.fullAt = performance.now();
    const to = [...this.peers.values()].filter(p => !p.deltas && p.ws.readyState === 1);
    if (!to.length) return;
    const msg = this.peerList();
    for (const p of to) this.send(p, msg);
  }
  // WebSocket pings keep proxies from cutting a quiet connection and find dead ones
  keepalive() {
    const now = Date.now();
    for (const [v, r] of this.reserved) if (r.until <= now) { this.reserved.delete(v); this.persist(); }
    for (const p of this.peers.values()) {
      if (p.ws.readyState !== 1 || !this.room(p, 'queue')) continue;
      if (!p.alive || now - p.lastIn > this.o.idleMs) { this.cuts[p.alive ? 'idle' : 'dead']++; p.ws.terminate(); continue; }
      p.alive = false;
      p.pingData = crypto.randomBytes(8);
      try { p.ws.ping(p.pingData); } catch { /* closing */ }
    }
  }
  stop() { clearInterval(this.timer); clearTimeout(this.deltaTimer); clearTimeout(this.fullTimer); this.flush(); this.online?.stop?.(); this.roam?.stop?.(); }
}
/** a connection's first hello: its player's name, and whether it takes the changes to the peer list */
function greet(peer, m) {
  peer.hello = true; peer.deltas = m.deltas === 1;
  if (typeof m.name === 'string') peer.name = cleanName(m.name);
}
function parseImpair(spec) {
  if (!spec) return null;
  const o = { delay: 0, jitter: 0, loss: 0, reorder: 0, seed: 1 };
  for (const kv of String(spec).split(',')) {
    const [k, v] = kv.split('=');
    if (k in o && Number.isFinite(+v)) o[k] = +v;
  }
  return o;
}
export function vipStr(v) { return [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.'); }
function vipNum(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m || m.slice(1).some(x => +x > 255)) return 0;
  const v = ((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0;
  return ((v & 0xffffff00) >>> 0) === BASE && (v & 255) >= 2 && (v & 255) <= 251 ? v : 0;
}
