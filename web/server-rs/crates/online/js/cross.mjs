// The JS side of nfsu2-online's cross-checks (src/tests/cross.rs): reads one JSON request on stdin, runs the
// Node server's own modules on it, writes the answer as JSON on stdout.
//   node crates/online/js/cross.mjs < request.json
// mode: aries (encode/parse/redact/reader over a corpus), text (Number, cleanText, the name regexes), json (what
// JSON.parse says of broken files), stats (race results recorded and stats.json written; files read back and
// written again), buddies (buddies.json read and written again), trace (the trace's lines), session (a scripted
// OnlineHost: every frame out, every line, info(), the files).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRV = path.join(HERE, '../../../../server/online');
const aries = await import(path.join(SRV, 'aries.mjs'));
const { Stats, decodeResult } = await import(path.join(SRV, 'stats.mjs'));
const { cleanText, validName } = await import(path.join(SRV, 'lobby.mjs'));
const { Buddies } = await import(path.join(SRV, 'buddy.mjs'));

const req = JSON.parse(fs.readFileSync(0, 'utf8'));
const latin1 = hex => Buffer.from(hex, 'hex').toString('latin1');
const hexOf = s => Buffer.from(s, 'latin1').toString('hex');
let res;

if (req.mode === 'aries') {
  res = {
    values: req.values.map(v => { try { return hexOf(aries.encodeValue(typeof v === 'number' ? v : latin1(v))); } catch (e) { return 'ERR'; } }),
    fields: req.bodies.map(b => aries.parseFields(Buffer.from(b, 'hex')).map(([k, v]) => [hexOf(k), v === null ? null : hexOf(v)])),
    redact: req.bodies.map(b => Buffer.from(aries.redactBody(Buffer.from(b, 'hex')), 'utf8').toString('hex')),
    encoded: req.fieldLists.map(l => { try { return aries.encodeFrame(latin1(l.kind), l.code ? latin1(l.code) : 0, l.fields.map(([k, v]) => [latin1(k), typeof v === 'number' ? v : latin1(v)])).toString('hex'); } catch (e) { return 'ERR ' + e.message; } }),
    streams: req.streams.map(s => {
      const r = new aries.FrameReader(s.max);
      const got = [];
      for (const c of s.chunks) for (const m of r.push(Buffer.from(c, 'hex'))) got.push([hexOf(m.kind), hexOf(m.code), Buffer.from(m.body).toString('hex')]);
      return { got, error: r.error, pending: r.pending };
    }),
    results: req.results.map(b64 => { const r = decodeResult(b64); return r ? JSON.stringify(r) : null; }),
  };
} else if (req.mode === 'text') {
  const fmtTime = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
  res = {
    numbers: req.strings.map(s => { const n = Number(latin1(s)); return [String(n), n | 0, n >>> 0]; }),
    clean: req.strings.map(s => hexOf(cleanText(latin1(s), 12))),
    strip: req.strings.map(s => Buffer.from(latin1(s).replace(/[@/].*$/, ''), 'latin1').toString('hex')),
    lower: req.strings.map(s => Buffer.from(latin1(s).toLowerCase(), 'utf16le').toString('hex')),
    upper: req.strings.map(s => Buffer.from(latin1(s).toUpperCase(), 'utf16le').toString('hex')),
    valid: req.strings.map(s => validName(latin1(s))),
    times: req.times.map(fmtTime),
  };
} else if (req.mode === 'json') {
  res = req.texts.map(t => { try { return ['ok', JSON.stringify(JSON.parse(t))]; } catch (e) { return ['err', e.message]; } });
} else if (req.mode === 'stats') {
  // race results recorded with a manual clock; the file; the boards, the STAT fields and the search
  const dir = req.dir;
  let t = req.t0;
  const st = new Stats({ dir, now: () => t, saveMs: 1e12, max: req.max, pruneMonths: req.pruneMonths });
  const asks = [];
  for (const op of req.ops) {
    if (op.at !== undefined) t = op.at;
    if (op.race) st.addRace(op.race);
    if (op.ask) asks.push({ stat: st.statField(op.ask, false), month: st.statField(op.ask, true),
      boards: [0, 1, 2, 3, 4, 5].map(k => st.board(k, op.monthly).map(r => [r.name, r.points, r.wins, r.losses, r.races])),
      found: st.startingWith(op.ask.toLowerCase().slice(0, 2), 5) });
  }
  st.stop();
  res = { asks, file: fs.readFileSync(path.join(dir, 'stats.json'), 'utf8') };
} else if (req.mode === 'stats-load') {
  // each file read as the server reads it, and written again
  res = req.files.map((text, i) => {
    const dir = path.join(req.dir, `l${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stats.json'), text);
    const lines = [];
    const st = new Stats({ dir, now: () => req.t0, log: s => lines.push(s.replace(/\.bad-\d+/, '.bad-<t>')), saveMs: 1e12 });
    st.dirty = true; st.save();
    let out = null; try { out = fs.readFileSync(path.join(dir, 'stats.json'), 'utf8'); } catch { /* moved aside, none written */ }
    return { lines, out };
  });
} else if (req.mode === 'buddies') {
  res = req.files.map((text, i) => {
    const dir = path.join(req.dir, `b${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'buddies.json'), text);
    const b = new Buddies({ lobby: null, dir, now: () => req.t0, limits: req.limits });
    b.dirty = true; b.save();
    return fs.readFileSync(path.join(dir, 'buddies.json'), 'utf8');
  });
} else if (req.mode === 'trace') {
  const { LobbyTrace } = await import(path.join(SRV, 'trace.mjs'));
  const tr = new LobbyTrace(req.file);
  for (const f of req.frames) tr.frame(Buffer.from(f, 'hex'));
  tr.close();
  await new Promise(r => tr.out.on('finish', r));
  res = { text: fs.readFileSync(req.file, 'utf8'), streams: tr.streams.size };
} else if (req.mode === 'session') {
  res = await session(req);
}
// (exit once it is all out: a pipe takes it in parts; the services' unref'd timers would keep the process up)
process.stdout.write(JSON.stringify(res), () => process.exit(0));

// ---- a scripted session ----
async function session(req) {
  const { OnlineHost } = await import(path.join(SRV, 'index.mjs'));
  const { VHOST_VIP, lanFrame } = await import(path.join(SRV, 'vhost.mjs'));
  const ip = s => s.split('.').reduce((a, b) => ((a << 8) | +b) >>> 0, 0);
  const sleep = fakeTimers();
  let t = req.t0;
  const lines = [], sent = [], slow = new Set();
  const host = new OnlineHost({ log: (s, key) => lines.push([s, key ?? null]), now: () => t, stateDir: req.stateDir ?? null,
    limits: req.limits, buddyLimits: req.buddyLimits });
  const conns = [];
  const route = (vip, f) => {
    if (f[16] !== 4) return;
    const c = conns.find(x => x.vip === vip && x.port === f.readUInt16BE(14));
    if (!c) return;
    for (const m of c.r.push(f.subarray(24))) c.last[m.kind] = aries.fieldMap(m.body, []);
  };
  host.attachSwitch((vip, f) => {
    const refused = slow.has(vip);
    sent.push([vip, Buffer.from(f).toString('hex'), refused]);
    if (refused) return false;
    route(vip, f);
    return true;
  });
  const value = (v) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return latin1(v);
    if (v.lkey !== undefined) return conns[v.lkey].last.pers?.get('LKEY') ?? '';
    if (v.ses !== undefined) return conns[v.ses[0]].last['+ses']?.get(v.ses[1]) ?? '';
    if (v.resu !== undefined) return resu(Number(conns[v.resu[0]].last['+ses']?.get('COUNT') ?? 2), v.resu[1]);
    throw new Error('a value: ' + JSON.stringify(v));
  };
  const frame = (c, op, data = null) => host.frame(c.vip, lanFrame(4, c.vip, VHOST_VIP, c.port, c.dport, op, c.cid, data), { group: c.group, site: null });
  const steps = [];
  for (const st of req.steps) {
    const m = { sent: sent.length, lines: lines.length };
    const c = st.conn !== undefined ? conns[st.conn] : null;
    let info = null;
    switch (st.op) {
      case 'connect': {
        const k = { vip: ip(st.vip), port: st.port, dport: st.dport, cid: st.cid, group: st.group, r: new aries.FrameReader(1 << 16), last: {} };
        conns.push(k); frame(k, 1); break;
      }
      case 'send': {
        const fields = st.fields.map(([k, v]) => [latin1(k), value(v)]);
        // the names of a race's players, as its +ses gave them
        const ses = st.names !== undefined ? conns[st.names].last['+ses'] : null;
        if (ses) for (let i = 0; i < Number(ses.get('COUNT') ?? 0); i++) fields.push([`NAME${i}`, ses.get(`OPPO${i}`)]);
        frame(c, 4, aries.encodeFrame(latin1(st.kind), 0, fields));
        break;
      }
      case 'text': frame(c, 4, aries.encodeFrame(latin1(st.kind), 0, latin1(st.text))); break;
      case 'raw': frame(c, 4, Buffer.from(st.hex, 'hex')); break;
      // a whole switch frame from a browser, whatever it holds
      case 'frame': host.frame(ip(st.vip), Buffer.from(st.hex, 'hex'), { group: st.group, site: null }); break;
      case 'fin': frame(c, 5); break;
      case 'rst': frame(c, 3); break;
      case 'advance': t += st.ms; host.lobby.tick(); break;
      case 'sleep': sleep(st.ms); break;
      case 'gone': host.peerGone(ip(st.vip)); break;
      case 'slow': if (st.on) slow.add(ip(st.vip)); else slow.delete(ip(st.vip)); break;
      case 'info': info = { info: host.info(), vips: [...host.vips()].sort((a, b) => a - b) }; break;
      case 'stop': host.stop(); break;
    }
    steps.push({ sent: sent.slice(m.sent), lines: lines.slice(m.lines), info });
  }
  const read = f => { try { return fs.readFileSync(path.join(req.stateDir, f), 'utf8'); } catch { return null; } };
  return { steps, stats: req.stateDir ? read('stats.json') : null, buddies: req.stateDir ? read('buddies.json') : null };
}

/**
 * The services' timers on a clock of the script's own, as cross.rs's World runs them (its `sleep`): the session's
 * steps run in one go, so real timers would never fire in it.  setTimeout and setInterval as Node takes their delay
 * (below 1 ms or past 2^31 - 1: 1 ms); timers fire by their time, those of one time in the order they were set; an
 * interval is set again before it runs (as the Rust host's tick).  Returns sleep(ms): the clock moves on, stopping at
 * each timer's time.
 */
function fakeTimers() {
  let now = 0, seq = 0;
  const live = new Map();               // id -> { at, seq, fn, every }
  const handle = id => ({ id, unref() { return this; }, ref() { return this; }, hasRef() { return false; } });
  const delay = ms => { ms *= 1; return ms >= 1 && ms <= 2 ** 31 - 1 ? ms : 1; };
  const set = (fn, ms, every) => { const id = ++seq; live.set(id, { at: now + delay(ms), seq: id, fn, every: every ? delay(ms) : 0 }); return handle(id); };
  const clear = h => { if (h && typeof h === 'object') live.delete(h.id); };
  globalThis.setTimeout = (fn, ms) => set(fn, ms, false);
  globalThis.setInterval = (fn, ms) => set(fn, ms, true);
  globalThis.clearTimeout = clear;
  globalThis.clearInterval = clear;
  return ms => {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const [id, x] of live) if (x.at <= end && (!next || x.at < next[1].at || (x.at === next[1].at && x.seq < next[1].seq))) next = [id, x];
      if (!next) break;
      const [id, x] = next;
      now = Math.max(now, x.at);
      live.delete(id);
      // an interval keeps its handle: the next one under the same id, set before it runs
      if (x.every) { const n = ++seq; live.set(id, { at: now + x.every, seq: n, fn: x.fn, every: x.every }); }
      x.fn();
    }
    now = end;
  };
}

/** a race report for n players (version 3), the same as cross.rs `resu`: places, times and type from `seed` */
function resu(n, seed) {
  const b = Buffer.alloc(8 + 55 * n);
  b[0] = 3; b[1] = n; b[2] = seed % 7; b[3] = 0; b.writeUInt16BE(4014, 4); b[7] = 2;
  for (let i = 0; i < n; i++) {
    const o = 8 + 55 * i;
    b[o] = i; b[o + 1] = ((i + seed) % n) + 1; b[o + 2] = (seed + i) % 5 === 0 ? 0x0c : 1;
    b.writeFloatBE(Math.fround(25 + i * 1.5 + (seed % 7) * 10.25), o + 8);
  }
  return b.toString('base64');
}
