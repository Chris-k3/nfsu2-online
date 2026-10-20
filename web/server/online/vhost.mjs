// The server's own host on the virtual LAN: 10.77.0.1, the address the
// switch never hands to a browser (web/server/lan.mjs).  The game's online
// mode connects here (the runtime resolves pcnfs05.ea.com to it, winsock.c),
// so this is the one place where the server itself speaks the browsers'
// virtual-LAN frames instead of routing them:
//   kind 4 (TCP)   a stream endpoint: SYN to a port something listens on ->
//                  SYNACK, else RST; DATA in order; FIN; RST.  The WebSocket
//                  and the switch are reliable and ordered (no retransmission,
//                  as between browsers: runtime/web/net_lan.c)
//   kind 5 (ICMP)  echo requests answered (the game's ProtoPing shows the
//                  server's round trip)
//   kind 3 (UDP)   nothing listens: "port unreachable", as a host would answer
// Frame layout (big-endian, net_proto.h): [0] kind, [4..7] source vip (the
// switch wrote the sender's own), [8..11] destination vip, [12..13] source
// port, [14..15] destination port, then the 8-byte LAN header ([16] op,
// [17] ttl, [20..23] connection id little-endian) and the data.
//
// A connection is named by the browser's address, its port and its random
// connection id.  The address is the one the switch wrote, so a browser can
// only ever speak for itself.  Limits: maxConns streams at once in all,
// perVip per browser (more SYNs are refused with RST).  A connection also
// knows the opaque group and site ids of the client that opened it (the
// switch's, lan.mjs: one client address, one IPv6 /48), for the services'
// per-client limits.  What the switch will not take (its receiver is too far
// behind, lan.mjs onlineQueue) ends the connection: a stream with a hole in
// it is no use to the game.

export const VHOST_VIP = ((10 << 24) | (77 << 16) | 1) >>> 0;
export const VHOST_NAME = 'NFSU2 Online';

const K_UDP = 3, K_TCP = 4, K_ICMP = 5;
const SYN = 1, SYNACK = 2, RST = 3, DATA = 4, FIN = 5;
const UDP_UNREACH = 1;
const LAN_HDR = 8, F_DATA = 16;
/** the most data one TCP frame carries (net_proto.h NET_MAX_PAYLOAD - NET_LAN_HDR) */
export const TCP_CHUNK = 1472 - LAN_HDR;

// maxConns: a player in the lobby holds two (the lobby and EA Messenger), so 1000 lobby sessions take 2000
export const VHOST_DEFAULTS = Object.freeze({ maxConns: 4000, perVip: 8 });

export function vipStr(v) { return [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.'); }

/** one switch frame of a LAN kind */
export function lanFrame(kind, src, dst, sport, dport, op, cid, data = null) {
  const n = data ? data.length : 0;
  const f = Buffer.alloc(F_DATA + LAN_HDR + n);
  f[0] = kind; f.writeUInt32BE(src >>> 0, 4); f.writeUInt32BE(dst >>> 0, 8);
  f.writeUInt16BE(sport, 12); f.writeUInt16BE(dport, 14);
  f[F_DATA] = op; f[F_DATA + 1] = 64; f.writeUInt32LE(cid >>> 0, F_DATA + 4);
  if (n) data.copy(f, F_DATA + LAN_HDR);
  return f;
}

function icmpChecksum(m) {
  m[2] = m[3] = 0;
  let sum = 0;
  for (let i = 0; i + 1 < m.length; i += 2) sum += (m[i] << 8) | m[i + 1];
  if (m.length & 1) sum += m[m.length - 1] << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >>> 16);
  sum = ~sum & 0xffff; m[2] = sum >> 8; m[3] = sum & 255;
}

/** one stream between a browser and a port of the virtual host */
export class VConn {
  constructor(host, vip, rport, lport, cid, ctx = {}) {
    this.host = host; this.vip = vip; this.rport = rport; this.lport = lport; this.cid = cid;
    this.key = `${vip}:${rport}:${cid}`;
    // the client's ids (a test without a switch: the browser's own address stands for its client)
    this.group = ctx.group ?? `vip ${vip}`; this.site = ctx.site ?? null;
    this.open = true; this.rxFin = false; this.txFin = false;
    this.bytesIn = 0; this.bytesOut = 0;
    /** set by the service: data(buf), end() (the browser closed its side), close(why) (gone: reset, left, ended) */
    this.ondata = null; this.onend = null; this.onclose = null;
  }
  get peer() { return vipStr(this.vip); }
  /** bytes to the browser, in frames of at most TCP_CHUNK; one the switch does not take ends the connection
   *  (false: the browser is too far behind; null: it left the switch) */
  write(buf) {
    if (!this.open || this.txFin) return false;
    for (let off = 0; off < buf.length; off += TCP_CHUNK) {
      const part = buf.subarray(off, Math.min(buf.length, off + TCP_CHUNK));
      const sent = this.host.out(this.vip, lanFrame(K_TCP, VHOST_VIP, this.vip, this.lport, this.rport, DATA, this.cid, part));
      if (sent === false || sent === null) {
        if (sent === false) this.host.stats.slow++;
        this.destroy(sent === false ? 'the browser does not keep up' : 'the browser left');
        return false;
      }
    }
    this.bytesOut += buf.length;
    return true;
  }
  /** graceful close of our side (FIN); the connection goes once both sides closed */
  end() {
    if (!this.open || this.txFin) return;
    this.txFin = true;
    this.host.out(this.vip, lanFrame(K_TCP, VHOST_VIP, this.vip, this.lport, this.rport, FIN, this.cid));
    if (this.rxFin) this.host.drop(this, 'closed');
  }
  /** abortive close (RST) */
  destroy(why = 'reset by the server') {
    if (!this.open) return;
    this.host.out(this.vip, lanFrame(K_TCP, VHOST_VIP, this.vip, this.lport, this.rport, RST, this.cid));
    this.host.drop(this, why);
  }
}

export class VirtualHost {
  /** out(vip, frame): to one browser through the switch; opts: VHOST_DEFAULTS; tap(frame): sees every frame this
   *  host sends (the dev trace; the switch's own tap sees what browsers send) */
  constructor({ out, opts = {}, tap = null } = {}) {
    this.o = { ...VHOST_DEFAULTS };
    for (const k of Object.keys(VHOST_DEFAULTS)) if (Number.isFinite(opts[k]) && opts[k] > 0) this.o[k] = opts[k];
    this.outFn = out ?? (() => {});
    this.tap = tap;
    this.listeners = new Map();          // port -> onConnect(conn)
    this.conns = new Map();              // key -> VConn
    this.perVip = new Map();             // vip -> open streams
    this.stats = { synIn: 0, refused: 0, limited: 0, rstIn: 0, framesIn: 0, framesOut: 0, echoes: 0, udpUnreach: 0, bad: 0, slow: 0, overrun: 0 };
  }
  get vip() { return VHOST_VIP; }
  listen(port, onConnect) { this.listeners.set(port, onConnect); }
  /** false or null: the switch did not take it (lan.mjs sendTo) */
  out(vip, frame) { this.stats.framesOut++; this.tap?.(frame); return this.outFn(vip, frame); }
  drop(conn, why) {
    if (!conn.open) return;
    conn.open = false;
    this.conns.delete(conn.key);
    const n = (this.perVip.get(conn.vip) ?? 1) - 1;
    if (n > 0) this.perVip.set(conn.vip, n); else this.perVip.delete(conn.vip);
    try { conn.onclose?.(why); } catch (e) { console.error(`[online] a connection's close handler failed: ${e?.stack || e}`); }
  }
  /** a frame from a browser to 10.77.0.1 (data: the switch frame, source already the sender's own; ctx: the
   *  sender's { group, site } ids) */
  frame(from, data, ctx = {}) {
    this.stats.framesIn++;
    if (data.length < F_DATA + LAN_HDR) { this.stats.bad++; return; }
    const kind = data[0], sport = data.readUInt16BE(12), dport = data.readUInt16BE(14), op = data[F_DATA];
    const cid = data.readUInt32LE(F_DATA + 4), payload = data.subarray(F_DATA + LAN_HDR);
    if (kind === K_ICMP) {
      if (payload.length < 8 || payload[0] !== 8) return;        // only echo requests get an answer
      const rep = Buffer.from(payload); rep[0] = 0; rep[1] = 0; icmpChecksum(rep);
      this.stats.echoes++;
      return this.out(from, lanFrame(K_ICMP, VHOST_VIP, from, 0, 0, 0, 0, rep));
    }
    if (kind === K_UDP) {
      if (op === UDP_UNREACH) return;
      this.stats.udpUnreach++;
      return this.out(from, lanFrame(K_UDP, VHOST_VIP, from, dport, sport, UDP_UNREACH, 0));
    }
    if (kind !== K_TCP) { this.stats.bad++; return; }
    const key = `${from}:${sport}:${cid}`, c = this.conns.get(key);
    const rst = () => this.out(from, lanFrame(K_TCP, VHOST_VIP, from, dport, sport, RST, cid));
    switch (op) {
      case SYN: {
        if (c) return;                                            // a duplicate
        this.stats.synIn++;
        const l = this.listeners.get(dport);
        if (!l) { this.stats.refused++; return rst(); }
        if (this.conns.size >= this.o.maxConns || (this.perVip.get(from) ?? 0) >= this.o.perVip) { this.stats.limited++; return rst(); }
        const k = new VConn(this, from, sport, dport, cid, ctx);
        this.conns.set(key, k); this.perVip.set(from, (this.perVip.get(from) ?? 0) + 1);
        this.out(from, lanFrame(K_TCP, VHOST_VIP, from, dport, sport, SYNACK, cid));
        try { l(k); } catch (e) { console.error(`[online] a service failed to take a connection: ${e?.stack || e}`); k.destroy('service error'); }
        return;
      }
      case DATA:
        if (!c) return rst();
        if (c.rxFin) return;
        c.bytesIn += payload.length;
        if (payload.length) try { c.ondata?.(Buffer.from(payload)); } catch (e) {
          console.error(`[online] a service failed on its data: ${e?.stack || e}`); c.destroy('service error'); }
        return;
      case FIN:
        if (!c || c.rxFin) return;
        c.rxFin = true;
        try { c.onend?.(); } catch (e) { console.error(`[online] a service failed on a close: ${e?.stack || e}`); }
        if (c.open && c.txFin) this.drop(c, 'closed');
        return;
      case RST:
        if (c) { this.stats.rstIn++; this.drop(c, 'reset by the game'); }
        return;
      case SYNACK:
        if (!c) rst();                                           // we never connect anywhere
        return;
      default: this.stats.bad++;
    }
  }
  /** what this host sent because of frame `data` from `from` was more than that client's budgets: the stream it
   *  came on goes (lan.mjs) */
  overrun(from, data) {
    if (data.length < F_DATA + LAN_HDR || data[0] !== K_TCP) return;
    const c = this.conns.get(`${from}:${data.readUInt16BE(12)}:${data.readUInt32LE(F_DATA + 4)}`);
    if (c) { this.stats.overrun++; c.destroy('it made the server send others more than its share'); }
  }
  /** a browser left the switch: its streams are gone */
  peerGone(vip) {
    for (const c of [...this.conns.values()]) if (c.vip === vip) this.drop(c, 'the browser left');
  }
  info() { return { conns: this.conns.size, ...this.stats }; }
}
