// The online races' results per persona: the one thing the online host keeps
// on disk (<state>/online/stats.json).  What is in it is public in the game
// anyway (the rankings and every player's online career): a persona name, its
// races, wins and losses per race type, ranked and unranked, rating points,
// best times per track, the month they were last seen.  Nothing about who
// plays a persona: no account name, address, password or adapter id.
//
// A race counts once: the first result report (rank, RESU) from one of its
// players that passes the checks in lobby.mjs; the others' reports are only
// compared with it.  Rating points per race: (players - place) * 100 /
// (players - 1), so the winner gets 100 and the last 0, ranked races only.
// Every count is kept twice: overall and for the current month (the month's
// counts start again when it changes, as the game's monthly rankings did).
// Personas not seen for pruneMonths months are forgotten; with MAX_PERSONAS
// of them, the least recently seen goes for a new one (the Online audit's
// ONL-7: a full store refused every new player), and a persona keeps its best
// times on MAX_BEST tracks.  The rankings are built at most every boardMs
// (the game asks for them often: building one of 100,000 records took 18 ms),
// and names are found by their beginning in a sorted list (EA Messenger's
// search).
//
// Written atomically (a temporary file, then rename), at most every saveMs
// and when the server stops.  A file that does not parse is kept aside
// (stats.json.bad-<time>) and the server starts with no results.
import fs from 'node:fs';
import path from 'node:path';

/** the race types, in the order of the server config's tier points and of the game's stat blocks */
export const RACE_TYPES = Object.freeze(['circuit', 'sprint', 'drift', 'drag', 'streetx', 'url']);
const MAX_PERSONAS = 100_000, MAX_BEST = 300;

const monthOf = t => { const d = new Date(t); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const blank = () => ({ races: 0, rw: 0, rl: 0, uw: 0, ul: 0, points: 0, dc: 0 });

export class Stats {
  /** dir: where stats.json lives (null: in memory only, for the tests) */
  constructor({ dir = null, now = () => Date.now(), log = () => {}, saveMs = 30_000, pruneMonths = 12, max = MAX_PERSONAS, boardMs = 5000 } = {}) {
    this.dir = dir; this.now = now; this.log = log; this.saveMs = saveMs; this.pruneMonths = pruneMonths; this.max = max; this.boardMs = boardMs;
    this.p = new Map();                  // lower-case name -> record, the least recently seen first
    this.boards = new Map();             // "type:monthly" -> { t, month, rows (with rank), index (lower-case name -> row) }
    this.sorted = null;                  // the names, sorted (lower case), and when: { t, names }
    this.dirty = false; this.timer = null;
    if (dir) this.load();
  }
  file() { return path.join(this.dir, 'stats.json'); }
  load() {
    let text;
    try { text = fs.readFileSync(this.file(), 'utf8'); } catch { return; }
    try {
      const j = JSON.parse(text);
      const rows = (Array.isArray(j?.personas) ? j.personas : []).filter(r => typeof r?.name === 'string' && /^[A-Za-z0-9_-]{3,15}$/.test(r.name))
        .map(clean).sort((a, b) => (a.seen < b.seen ? -1 : a.seen > b.seen ? 1 : 0));
      for (const r of rows.slice(-this.max)) this.p.set(r.name.toLowerCase(), r);
      this.log(`[online] results of ${this.p.size} personas read from ${this.file()}`);
    } catch (e) {
      const aside = `${this.file()}.bad-${Date.now()}`;
      try { fs.renameSync(this.file(), aside); } catch { /* gone */ }
      this.log(`[online] ${this.file()} could not be read (${e.message}): moved to ${aside}, starting with no results`);
    }
  }
  /** a persona's record (made when asked for by a race: the least recently seen goes when there are max) */
  rec(name, make = false) {
    const k = name.toLowerCase();
    let r = this.p.get(k);
    if (!r && make) {
      for (const [old] of this.p) { if (this.p.size < this.max) break; this.p.delete(old); }
      r = { name, seen: monthOf(this.now()), all: {}, month: { key: monthOf(this.now()), t: {} }, best: {} };
      this.p.set(k, r); if (this.sorted) this.sorted.stale = true;
    }
    if (r) this.roll(r);
    return r ?? null;
  }
  /** r raced now: the most recently seen */
  saw(r) { const k = r.name.toLowerCase(); this.p.delete(k); this.p.set(k, r); r.seen = monthOf(this.now()); }
  /** a new month: the monthly counts start again */
  roll(r) {
    const m = monthOf(this.now());
    if (r.month.key !== m) r.month = { key: m, t: {} };
  }
  /**
   * One race's result: type (0..5, RACE_TYPES), ranked, track, the players in finishing order
   * [{ name, place (1..n, 0 = did not finish), time (s) }].
   */
  addRace({ type, ranked, track, players }) {
    const n = players.length;
    if (n < 2 || !(type >= 0 && type < RACE_TYPES.length)) return;
    for (const pl of players) {
      const r = this.rec(pl.name, true);
      this.saw(r);
      const won = pl.place === 1, pts = ranked && pl.place ? Math.round((n - pl.place) * 100 / (n - 1)) : 0;
      for (const t of [r.all, r.month.t]) {
        const c = t[type] ??= blank();
        c.races++; c.points += pts;
        if (ranked) won ? c.rw++ : c.rl++; else won ? c.uw++ : c.ul++;
        if (!pl.place) c.dc++;                             // dropped out of the race
      }
      if (pl.place && pl.time > 0 && Number.isInteger(track)) {
        const key = `${type}:${track}`;
        if (!(r.best[key] <= pl.time) && (key in r.best || Object.keys(r.best).length < MAX_BEST)) r.best[key] = Math.round(pl.time * 1000) / 1000;
      }
    }
    this.touch();
  }
  /**
   * The 38 numbers of the game's STAT field (hex, each followed by a comma), as its Personal Stats screen
   * reads them (found by sending distinct values): [0] not shown, [1] client
   * disconnects, [2] host disconnects (both shown as a share of the games), [3] top speed (mm/s), [4]
   * biggest drift points, [5] longest powerslide (mm), [6] longest jump (ms), [7] quickest drag (ms); then
   * per race type rating, ranked wins, ranked losses, unranked wins, unranked losses (Games, Wins and
   * Losses on the screen are their sums).  The race reports' own figures (speeds, jumps) are not read yet:
   * [3]..[7] stay 0.
   */
  statField(name, monthly = false) {
    const r = name ? this.rec(name) : null;
    const t = r ? (monthly ? r.month.t : r.all) : {};
    const sum = blank();
    for (const c of Object.values(t)) for (const k of Object.keys(sum)) sum[k] += c[k];
    const v = [0, sum.dc, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < RACE_TYPES.length; i++) { const c = t[i] ?? blank(); v.push(c.points, c.rw, c.rl, c.uw, c.ul); }
    return v.map(x => (x >>> 0).toString(16) + ',').join('');
  }
  /** a ranking: [{ name, points, wins, losses, races }] best first (points, then wins, then fewer losses, then name) */
  board(type, monthly = false) {
    const rows = [];
    for (const r of this.p.values()) {
      this.roll(r);
      const c = (monthly ? r.month.t : r.all)[type];
      if (!c || !c.races) continue;
      rows.push({ name: r.name, points: c.points, wins: c.rw + c.uw, losses: c.rl + c.ul, races: c.races });
    }
    return rows.sort((a, b) => b.points - a.points || b.wins - a.wins || a.losses - b.losses || (a.name < b.name ? -1 : 1));
  }
  /** a ranking as the game's Rankings ask for it: the board with each row's rank, and the rows by name; built at
   *  most every boardMs (a race's result shows within that) */
  ranking(type, monthly = false) {
    const key = `${type}:${monthly}`, now = this.now(), month = monthOf(now);
    let b = this.boards.get(key);
    if (!b || now - b.t >= this.boardMs || b.month !== month) {
      const rows = this.board(type, monthly).map((r, i) => ({ ...r, rank: i + 1 }));
      b = { t: now, month, rows, index: new Map(rows.map((r, i) => [r.name.toLowerCase(), i])) };
      this.boards.set(key, b);
    }
    return b;
  }
  /** at most max names that begin with prefix (lower case), from a sorted list built at most every boardMs */
  startingWith(prefix, max) {
    const now = this.now();
    if (!this.sorted || (this.sorted.stale && now - this.sorted.t >= this.boardMs)) {
      this.sorted = { t: now, stale: false, names: [...this.p.values()].map(r => [r.name.toLowerCase(), r.name]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) };
    }
    const n = this.sorted.names;
    let lo = 0, hi = n.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (n[m][0] < prefix) lo = m + 1; else hi = m; }
    const out = [];
    for (let i = lo; i < n.length && out.length < max && n[i][0].startsWith(prefix); i++) if (this.p.has(n[i][0])) out.push(n[i][1]);
    return out;
  }
  touch() {
    this.dirty = true;
    if (!this.dir || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.save(); }, this.saveMs);
    this.timer.unref?.();
  }
  prune() {
    const [y, m] = monthOf(this.now()).split('-').map(Number), cut = y * 12 + m - this.pruneMonths;
    for (const [k, r] of this.p) { const [ry, rm] = r.seen.split('-').map(Number); if (ry * 12 + rm < cut) this.p.delete(k); }
  }
  save() {
    if (!this.dir || !this.dirty) return;
    try {
      this.prune();
      const body = JSON.stringify({ v: 1, note: 'NFSU2 online results per persona (public in the game)', personas: [...this.p.values()] });
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file()}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.file());
      this.dirty = false;
    } catch (e) { this.log(`[online] the results could not be written: ${e.message}`); }
  }
  stop() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } this.save(); }
}

/** a stored record, with only the fields this file writes (numbers checked) */
function clean(r) {
  const num = v => (Number.isFinite(v) && v >= 0 ? Math.min(v, 2 ** 31) : 0);
  const counts = t => {
    const o = {};
    for (let i = 0; i < RACE_TYPES.length; i++) {
      const c = t?.[i]; if (!c) continue;
      o[i] = { races: num(c.races), rw: num(c.rw), rl: num(c.rl), uw: num(c.uw), ul: num(c.ul), points: num(c.points), dc: num(c.dc) };
    }
    return o;
  };
  const best = {};
  for (const [k, v] of Object.entries(r.best ?? {})) if (/^\d:\d{1,6}$/.test(k) && Number.isFinite(v) && v > 0) best[k] = v;
  const seen = /^\d{4}-\d{2}$/.test(r.seen) ? r.seen : '1970-01';
  return { name: r.name, seen, all: counts(r.all), month: { key: /^\d{4}-\d{2}$/.test(r.month?.key) ? r.month.key : seen, t: counts(r.month?.t) }, best };
}

/**
 * The game's race report (rank RESU, base64), version 3 as SPEED2.EXE writes it:
 *   [0] version 3, [1] players, [2] race type, [3] the reporter's index, [4..5] track (big-endian),
 *   [6] direction, [7] laps; then per player 55 bytes: [0] index into the report's NAME list,
 *   [1] place, [2] 0x01 finished / 0x0c dropped out, [3] the car, [8..11] the total time in seconds (float,
 *   big-endian; a dropped player's: until it left), [12..15] the best lap, more floats (speeds and other
 *   figures, not read), [32..35] -1.0 for a dropped player (the research says [44..47]: both are taken),
 *   [53] a bit mask, each set bit adding 2 bytes after the record (one byte here: UNVERIFIED)
 * (from the reports of real races here and the research's notes; the fields not used are UNVERIFIED).
 * Returns null for anything that does not parse.
 */
export function decodeResult(b64) {
  let b;
  try { b = Buffer.from(String(b64), 'base64'); } catch { return null; }
  if (b.length < 8 || b[0] !== 3) return null;
  const n = b[1];
  if (n < 1 || n > 8) return null;
  const out = { version: 3, type: b[2], reporter: b[3], track: b.readUInt16BE(4), dir: b[6], laps: b[7], players: [] };
  let o = 8;
  for (let i = 0; i < n; i++) {
    if (o + 55 > b.length) return null;
    const mask = b[o + 53];
    let extra = 0; for (let m = mask; m; m &= m - 1) extra += 2;
    // dropped out: the flag byte 0x0c instead of 0x01 and -1.0 at 32 (a four-player race here), or -1.0 at 44 (the research)
    const time = b.readFloatBE(o + 8), dropped = (b[o + 2] & 0x08) !== 0 || b.readFloatBE(o + 32) === -1 || b.readFloatBE(o + 44) === -1;
    out.players.push({ index: b[o], place: b[o + 1], car: b[o + 3], time: Number.isFinite(time) ? time : 0, dropped });
    o += 55 + extra;
  }
  return out;
}
