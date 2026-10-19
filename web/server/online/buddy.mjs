// EA Messenger (the game's "buddy server", port 13505 of the online host):
// friends lists, who is online and what they do, messages, and game invites,
// between the personas logged in to this server's lobby.
//
// The game's buddy client (SPEED2.EXE BuddyApi, 0x74BC50-0x74F5F0) speaks the
// lobby's framing with upper-case commands.  It logs in with AUTH and the LKEY
// its lobby login was given (lobby.mjs selectPersona): that key, from the
// same browser, not anything typed, says which persona this connection is.
// What it sends and what it is answered here:
//   AUTH PROD VERS PRES USER LKEY  -> AUTH TITL="EA MESSENGER" (unknown key: code "pass"; a second AUTH on
//                                     a connection that is logged in: code "logn")
//   EPGT LRSC ID                   -> EPGT ID ENAB=N ADDR=
//   RGET LIST=B|I ID               -> RGET ID SIZE=n, then n x ROST ID USER (the friends, or the
//                                     blocked), then PGET for each friend online
//   RADD/RDEL LIST USER ID         -> RADD/RDEL ID; a friend added is told (RNOT USER) and the
//                                     adder gets the friend's presence (LIST I: blocking)
//   RADM USER PRES ID              -> RADM ID; to the persona: RNOT USER (the asker) CHNG=A ATTR=0x80000,
//                                     a friend request (the game's "pending" bits: which is which UNVERIFIED)
//   RRSP USER ANSW ID              -> the answer: both are friends (RNOT USER CHNG=A ATTR=0, PGET) unless
//                                     ANSW says no (its coding is UNVERIFIED); a request back from the asked
//                                     persona (RADM, "Send Friend Request" in its menu) counts as yes
//   PADD/PDEL USER                 -> ack, and that player's presence (the Messenger's "All" list:
//                                     players searched for or met; in memory only)
//   PSET SHOW STAT PROD            -> ack; when it changed, PGET USER SHOW STAT PROD TITL EXTR ATTR to every
//                                     online player who has this persona as a friend (at most once a second,
//                                     the latest)
//   SEND USER BODY SUBJ TYPE       -> SEND; RECV USER (the sender) BODY SUBJ TYPE TIME to the persona
//   GINV/GRSP/GRVK USER ...        -> ack; passed on to the persona (USER = the sender)
//   USCH USER MAXR ID              -> USCH ID SIZE=n, then n x USER ID USER (the Search: personas online
//                                     or known from their races whose names start with the text)
//   PING                           -> PING;  DISC -> closed
// Field names from the game's own code; the exact use the game makes of each
// (screens, invites) was checked only in part.
//
// Kept: each persona's friends list (names only) in <state>/online/buddies.json,
// so a friend is still one after a restart.  A persona belongs to whoever
// plays under its name (there are no accounts), so whoever takes a name that
// is not online sees and can change its friends list (docs/web/PLAYING.md).
// The blocked list is the session's own: kept while the persona is online,
// where it is the only place a block matters (messages, invites and requests
// go to personas online), and never stored (the Online audit's ONL-6: the
// next holder of the name could read and empty it).  Messages and invites are
// passed on and forgotten (to a persona online now).
// Limits: 50 friends, 50 blocked; MAX_LISTS friends lists, the least recently
// seen going first, new ones listRate an hour per client; messages
// msgRate a second (burst 3 x), the lists and the search heavyRate a second
// (burst 4), over that: closed (the Online audit's ONL-1, ONL-3); chat
// messages 2 a second (burst 5) and 500 characters; a blocked persona's
// messages and invites never arrive.
import fs from 'node:fs';
import path from 'node:path';
import { FrameReader, encodeFrame, fieldMap } from './aries.mjs';
import { Bucket, cleanText, validName } from './lobby.mjs';

const MAX_LIST = 50;
export const BUDDY_LIMITS = Object.freeze({ lists: 5000, listRate: 20, msgRate: 10, heavyRate: 1, presenceMs: 1000 });
const TITL = 'Need for Speed Underground 2 [PC]';
const monthOf = t => { const d = new Date(t); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

export class Buddies {
  constructor({ lobby, log = () => {}, now = () => Date.now(), dir = null, saveMs = 10_000, limits = {} }) {
    this.lobby = lobby; this.log = log; this.now = now; this.dir = dir; this.saveMs = saveMs;
    this.L = { ...BUDDY_LIMITS };
    for (const k of Object.keys(BUDDY_LIMITS)) if (Number.isFinite(limits?.[k]) && limits[k] > 0) this.L[k] = limits[k];
    // lower-case persona -> { name, B: Set(lower), names: Map(lower -> name), seen: 'YYYY-MM' }; least recently
    // seen first
    this.lists = new Map();
    this.online = new Map();             // lower-case persona -> buddy session
    this.requests = new Map();           // "from>to" (lower case) -> when: friend requests waiting for an answer
    this.made = new Map();               // client group -> Bucket: new friends lists
    this.timer = null; this.dirty = false;
    if (dir) this.load();
  }
  file() { return path.join(this.dir, 'buddies.json'); }
  load() {
    let j;
    try { j = JSON.parse(fs.readFileSync(this.file(), 'utf8')); } catch { return; }
    const rows = (Array.isArray(j?.personas) ? j.personas : []).filter(r => validName(r?.name))
      .map(r => ({ r, seen: /^\d{4}-\d{2}$/.test(r.seen) ? r.seen : '1970-01' })).sort((a, b) => (a.seen < b.seen ? -1 : a.seen > b.seen ? 1 : 0));
    // (a file of before the audit also has the blocked lists, I: they are not read)
    for (const { r, seen } of rows.slice(-this.L.lists)) {
      const l = { name: r.name, B: new Set(), names: new Map(), seen };
      for (const n of Array.isArray(r.B) ? r.B.slice(0, MAX_LIST) : []) if (validName(n)) { l.B.add(n.toLowerCase()); l.names.set(n.toLowerCase(), n); }
      if (l.B.size) this.lists.set(r.name.toLowerCase(), l);
    }
  }
  save() {
    if (!this.dir || !this.dirty) return;
    try {
      const personas = [...this.lists.values()].filter(l => l.B.size)
        .map(l => ({ name: l.name, seen: l.seen, B: [...l.B].map(k => l.names.get(k) ?? k) }));
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file()}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 2, note: 'NFSU2 online friends lists (persona names only)', personas }), { mode: 0o600 });
      fs.renameSync(tmp, this.file());
      this.dirty = false;
    } catch (e) { this.log(`[online] the friends lists could not be written: ${e.message}`); }
  }
  touch() {
    this.dirty = true;
    if (!this.dir || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.save(); }, this.saveMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } this.save(); }
  /** a persona's friends list, or null: none is made by asking */
  list(name) { return this.lists.get(name.toLowerCase()) ?? null; }
  /** a persona's friends list, made if needed (on behalf of client `group`): null when that client made its
   *  share of new lists this hour; the least recently seen list goes when there are too many */
  make(name, group) {
    const k = name.toLowerCase(), l = this.lists.get(k);
    if (l) return l;
    let b = this.made.get(group);
    if (!b) {
      if (this.made.size >= 10_000) for (const [g, x] of this.made) if (x.take(0) && x.v >= x.cap) this.made.delete(g);
      this.made.set(group, b = new Bucket(this.L.listRate / 3600, this.L.listRate, this.now));
    }
    if (!b.take()) return null;
    for (const [old] of this.lists) { if (this.lists.size < this.L.lists) break; this.lists.delete(old); this.dirty = true; }
    const n = { name, B: new Set(), names: new Map(), seen: monthOf(this.now()) };
    this.lists.set(k, n);
    return n;
  }
  /** a persona was seen: its list moves to the most recently seen end */
  seen(name) {
    const k = name.toLowerCase(), l = this.lists.get(k);
    if (!l) return;
    this.lists.delete(k); this.lists.set(k, l);
    const m = monthOf(this.now());
    if (l.seen !== m) { l.seen = m; this.touch(); }
  }
  /** presence of one persona as its friends see it */
  presence(b) {
    return [['USER', b.persona], ['SHOW', b.show], ['STAT', b.stat], ['PROD', b.prod], ['TITL', TITL], ['EXTR', 'NFS-CONSOLE-2005'], ['ATTR', 'D']];
  }
  offline(name) { return [['USER', name], ['SHOW', 'DISC'], ['STAT', ''], ['PROD', ''], ['TITL', TITL], ['EXTR', 'NFS-CONSOLE-2005'], ['ATTR', 'D']]; }
  /** every online persona that has b as a friend gets its presence now */
  announce(b, gone = false) {
    const me = b.persona.toLowerCase(), what = gone ? this.offline(b.persona) : this.presence(b);
    b.told = this.now();
    for (const o of this.online.values()) {
      if (o === b || !o.persona || !(this.list(o.persona)?.B.has(me) || o.met.has(me))) continue;
      o.send('PGET', what);
    }
  }
  /** b's presence changed: out now, or the latest of it once presenceMs has passed since the last */
  presenceChanged(b) {
    if (b.presenceTimer) return;
    const wait = (b.told ?? -Infinity) + this.L.presenceMs - this.now();
    if (wait <= 0) return this.announce(b);
    b.presenceTimer = setTimeout(() => { b.presenceTimer = null; if (b.persona) this.announce(b); }, wait);
    b.presenceTimer.unref?.();
  }

  /** b and the persona who become friends (each on the other's list), both told (RNOT ATTR=0: no request
   *  pending any more) with each other's presence */
  befriend(b, who, how) {
    const k = who.toLowerCase(), me = b.persona.toLowerCase();
    this.requests.delete(`${k}>${me}`); this.requests.delete(`${me}>${k}`);
    const has = (l, n) => l?.B.has(n), full = l => (l?.B.size ?? 0) >= MAX_LIST;
    if ((full(this.list(b.persona)) && !has(this.list(b.persona), k)) || (full(this.list(who)) && !has(this.list(who), me))) return;
    const mine = this.make(b.persona, b.conn.group), them = mine && this.make(who, b.conn.group);
    if (!mine || !them) return;
    for (const [l, n] of [[mine, who], [them, b.persona]]) { l.B.add(n.toLowerCase()); l.names.set(n.toLowerCase(), n); }
    this.touch();
    this.log(`[online] "${b.persona}" and "${who}" are friends (${how})`, b.conn.group);
    const o = this.online.get(k);
    b.send('RNOT', [['USER', who], ['CHNG', 'A'], ['ATTR', 0]]);
    b.send('PGET', o ? this.presence(o) : this.offline(who));
    if (o) { o.send('RNOT', [['USER', b.persona], ['CHNG', 'A'], ['ATTR', 0]]); o.send('PGET', this.presence(b)); }
  }

  connect(conn) {
    const r = new FrameReader();
    const b = { conn, persona: null, show: 'CHAT', stat: '', prod: '', msgs: { t: this.now(), v: 5 }, met: new Set(),
      blocked: new Set(), blockedNames: new Map(), told: null, presenceTimer: null,
      rate: new Bucket(this.L.msgRate, 3 * this.L.msgRate, this.now), heavy: new Bucket(this.L.heavyRate, 4, this.now),
      send: (kind, fields = [], code = 0) => conn.write(encodeFrame(kind, code, fields)) };
    const t = setTimeout(() => conn.destroy('buddy: no login'), 60_000);
    conn.onclose = () => { clearTimeout(t); this.gone(b); };
    conn.onend = () => { this.gone(b); conn.end(); };
    conn.ondata = buf => {
      for (const m of r.push(buf)) {
        if (!conn.open) return;
        if (!b.rate.take()) { conn.destroy('buddy: too many messages'); return; }
        if (!/^[!-~]{4}$/.test(m.kind)) { conn.destroy('buddy: not the lobby protocol'); return; }
        const f = fieldMap(m.body);
        try { this.message(b, m.kind, f, t); } catch (e) {
          console.error(`[online] buddy "${m.kind}" failed: ${e?.stack || e}`); conn.destroy('server error'); return;
        }
      }
      if (r.error) conn.destroy('buddy: not the lobby protocol');
    };
  }
  gone(b) {
    clearTimeout(b.presenceTimer); b.presenceTimer = null;
    if (!b.persona) return;
    // every name that points at this connection (there is one: a second AUTH is refused)
    let was = false;
    for (const [k, o] of [...this.online]) if (o === b) { this.online.delete(k); was = true; }
    if (was) this.announce(b, true);
    b.persona = null;
  }
  message(b, kind, f, loginTimer) {
    const id = f.get('ID') ?? undefined, withId = id !== undefined ? [['ID', id]] : [];
    if (kind === 'AUTH') {
      if (b.persona) return b.send('AUTH', [['TITL', 'EA MESSENGER']], 'logn');
      // the lobby's key for this browser's persona: the only thing that says who this is
      const key = String(f.get('LKEY') ?? '');
      const find = () => key.length >= 24 ? [...this.lobby.sessions].find(x => x.lkey && x.vip === b.conn.vip && x.lkey.startsWith(key)) : null;
      let s = find();
      if (!s && (b.tries = (b.tries ?? 0) + 1) <= 6) {    // the lobby login may finish a moment later
        return setTimeout(() => { if (!b.conn.open || b.persona) return; this.message(b, kind, f, loginTimer); }, 500);
      }
      if (!s) return b.send('AUTH', [['TITL', 'EA MESSENGER']], 'pass');
      clearTimeout(loginTimer);
      const k = s.persona.toLowerCase(), old = this.online.get(k);
      if (old && old !== b) old.conn.destroy('logged in again');
      b.persona = s.persona; this.online.set(k, b);
      this.seen(s.persona);
      b.send('AUTH', [['TITL', 'EA MESSENGER']]);
      return;
    }
    if (kind === 'PING') return b.send('PING');
    if (kind === 'DISC') { this.gone(b); return b.conn.end(); }
    if (!b.persona) return b.send(kind.slice(0, 4), [], 'auth');
    const me = b.persona.toLowerCase();
    switch (kind) {
      case 'EPGT': return b.send('EPGT', [...withId, ['ENAB', 'N'], ['ADDR', '']]);
      case 'RGET': {
        if (!b.heavy.take()) return b.send('RGET', withId, 'full');
        const which = String(f.get('LIST') ?? 'B').toUpperCase() === 'I' ? 'I' : 'B';
        const mine = this.list(b.persona);
        const names = which === 'I' ? [...b.blocked].map(k => b.blockedNames.get(k) ?? k) : mine ? [...mine.B].map(k => mine.names.get(k) ?? k) : [];
        b.send('RGET', [...withId, ['SIZE', names.length]]);
        for (const n of names) b.send('ROST', [...withId, ['USER', n], ['LIST', which]]);
        if (which === 'B') for (const n of names) {
          const o = this.online.get(n.toLowerCase());
          b.send('PGET', o ? this.presence(o) : this.offline(n));
        }
        return;
      }
      case 'RADD': case 'RDEL': {
        const which = String(f.get('LIST') ?? 'B').toUpperCase() === 'I' ? 'I' : 'B';
        const who = String(f.get('USER') ?? '').replace(/[@/].*$/, '');
        if (!validName(who) || who.toLowerCase() === me) return b.send(kind, withId, 'user');
        const k = who.toLowerCase();
        if (which === 'I') {                               // the session's own (see above)
          if (kind === 'RADD') {
            if (b.blocked.size >= MAX_LIST && !b.blocked.has(k)) return b.send(kind, withId, 'full');
            b.blocked.add(k); b.blockedNames.set(k, who);
          } else { b.blocked.delete(k); b.blockedNames.delete(k); }
          return b.send(kind, withId);
        }
        if (kind === 'RDEL') {
          const mine = this.list(b.persona);
          if (mine?.B.delete(k)) { mine.names.delete(k); this.touch(); }
          return b.send(kind, withId);
        }
        const cur = this.list(b.persona);
        if (cur && cur.B.size >= MAX_LIST && !cur.B.has(k)) return b.send(kind, withId, 'full');
        const mine = cur ?? this.make(b.persona, b.conn.group);
        if (!mine) return b.send(kind, withId, 'full');
        mine.B.add(k); mine.names.set(k, who);
        this.touch();
        b.send(kind, withId);
        const o = this.online.get(k);
        b.send('PGET', o ? this.presence(o) : this.offline(who));
        if (o && !o.blocked.has(me)) o.send('RNOT', [['USER', b.persona], ['LIST', 'B']]);
        return;
      }
      case 'RADM': {
        // a friend request (Send Friend Request): to the persona, which answers with RRSP
        const who = String(f.get('USER') ?? '').replace(/[@/].*$/, ''), k = who.toLowerCase();
        if (!validName(who) || k === me) return b.send(kind, withId, 'user');
        const mine = this.list(b.persona);
        if (mine && mine.B.size >= MAX_LIST && !mine.B.has(k)) return b.send(kind, withId, 'full');
        b.send(kind, withId);
        const o = this.online.get(k);
        if (!o || o.blocked.has(me)) return;               // offline, or blocked by that persona
        // two requests that cross (the asked one asks back: "Send Friend Request" in the asker's menu) make friends
        if (this.requests.has(`${k}>${me}`)) return this.befriend(b, who, 'asked back');
        if (this.requests.size > 10_000) this.requests.clear();
        this.requests.set(`${me}>${k}`, this.now());
        this.log(`[online] "${b.persona}" asked "${who}" to be friends`, b.conn.group);
        // a roster update for the asked one: the asker, with a "request" bit in ATTR (the game keeps two such
        // bits, 0x40000 and 0x80000, and clears them when the request is answered: RNOT, 0x74E2B0; with 0x80000
        // the asker appears on the list, the menu offers no accept: the asked one answers with a request back),
        // then the asker's presence for that entry
        o.send('RNOT', [['USER', b.persona], ['CHNG', 'A'], ['ATTR', 0x80000]]);
        return o.send('PGET', this.presence(b));
      }
      case 'RRSP': {
        // the answer to a friend request; ANSW's coding is UNVERIFIED: anything but a "no" accepts
        const who = String(f.get('USER') ?? '').replace(/[@/].*$/, ''), k = who.toLowerCase();
        const key = `${k}>${me}`, asked = this.requests.get(key);
        b.send(kind, withId);
        if (!asked || this.now() - asked > 3600_000) return;
        this.requests.delete(key);
        const answer = String(f.get('ANSW') ?? '');
        if (/^(n|d|0|false)/i.test(answer)) { this.log(`[online] "${b.persona}" declined "${who}"'s friend request`, b.conn.group); return; }
        return this.befriend(b, who, `ANSW=${cleanText(answer, 8)}`);
      }
      case 'PADD': case 'PDEL': {
        // the Messenger's "All" list: players this one searched for or met (in memory only); their presence
        const who = String(f.get('USER') ?? '').replace(/[@/].*$/, '');
        b.send(kind, withId);
        if (!validName(who)) return;
        if (kind === 'PDEL') return b.met.delete(who.toLowerCase());
        if (b.met.size < MAX_LIST) b.met.add(who.toLowerCase());
        const o = this.online.get(who.toLowerCase());
        return b.send('PGET', o ? this.presence(o) : this.offline(who));
      }
      case 'USCH': {
        // Search: personas online now or known from their races whose name starts with the text (at most MAXR, 20)
        if (!b.heavy.take()) return b.send('USCH', [...withId, ['SIZE', 0]]);
        const q = String(f.get('USER') ?? '').replace(/[@/].*$/, '').toLowerCase().slice(0, 15);
        const max = Math.min(20, Math.max(1, Number(f.get('MAXR') ?? 20) | 0));
        const found = new Map();
        if (q) {
          for (const s of this.lobby.byPersona.values()) if (s.persona.toLowerCase().startsWith(q)) found.set(s.persona.toLowerCase(), s.persona);
          for (const n of this.lobby.results.startingWith(q, max + 1)) found.set(n.toLowerCase(), n);
        }
        found.delete(me);
        const names = [...found.values()].sort().slice(0, max);
        b.send('USCH', [...withId, ['SIZE', names.length]]);
        for (const n of names) b.send('USER', [...withId, ['USER', n]]);
        return;
      }
      case 'PSET': {
        const show = String(f.get('SHOW') ?? 'CHAT').slice(0, 8), stat = String(f.get('STAT') ?? '').slice(0, 64), prod = cleanText(f.get('PROD'), 64);
        b.send('PSET', withId);
        if (b.told !== null && show === b.show && stat === b.stat && prod === b.prod) return;
        b.show = show; b.stat = stat; b.prod = prod;
        return this.presenceChanged(b);
      }
      case 'SEND': case 'GINV': case 'GRSP': case 'GRVK': {
        const to = String(f.get('USER') ?? '').replace(/[@/].*$/, ''), o = this.online.get(to.toLowerCase());
        const t = this.now();
        b.msgs.v = Math.min(5, b.msgs.v + (t - b.msgs.t) / 500); b.msgs.t = t;
        if (b.msgs.v < 1) return b.send(kind, withId, 'full');
        b.msgs.v--;
        b.send(kind, withId);
        if (!o || !o.persona || o.blocked.has(me)) return;   // offline, or this sender is blocked
        if (kind === 'SEND') {
          o.send('RECV', [['USER', b.persona], ['BODY', cleanText(f.get('BODY'), 500)], ['SUBJ', cleanText(f.get('SUBJ'), 64)],
            ['TYPE', String(f.get('TYPE') ?? 'C').slice(0, 4)], ['TIME', Math.floor(t / 1000)]]);
        } else {
          // a game invite and its answers: the game's own fields, the sender named by the server
          const fields = [...f].filter(([k, v]) => v !== null && !['USER', 'ID', 'LKEY'].includes(k)).map(([k, v]) => [k, cleanText(v, 128)]);
          o.send(kind, [['USER', b.persona], ...fields.slice(0, 12)]);
        }
        return;
      }
      default: return b.send(kind.slice(0, 4), withId);
    }
  }
}
