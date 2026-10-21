// The JS side of crosscheck.rs: the Node server's own hub (web/server/roam-hub.mjs) over the scenarios the Rust test
// made, event by event, and Math.hypot itself.  stdin and stdout are binary (little-endian), as crosscheck.rs writes
// and reads them:
//   in:  u32 n, n x (f64 x, f64 y, f64 z)                      the hypots
//        u32 scenarios, each: u32 + JSON options, u32 hub id, u32 events, each: u8 kind and
//          0 f64 t (the clock) | 1 u32 from, u32 len, frame | 2 u32 vip (peerGone) | 3 f64 busy (a tick) | 4 (info)
//   out: n x f64                                                Math.hypot of each
//        for each tick: u32 frames, each: u32 vip, u32 len, frame; then a record; for each info: a record
//        a record: u32 + JSON { info (no tickMsMax), logs since the last record[, vips, links] }
import { RoamHub } from '../../../../server/roam-hub.mjs';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const b = Buffer.concat(chunks);
let o = 0;
const u8 = () => b[o++];
const u32 = () => { const v = b.readUInt32LE(o); o += 4; return v; };
const f64 = () => { const v = b.readDoubleLE(o); o += 8; return v; };
const out = [];
const w32 = v => { const x = Buffer.alloc(4); x.writeUInt32LE(v >>> 0); out.push(x); };
const wstr = s => { const x = Buffer.from(s, 'utf8'); w32(x.length); out.push(x); };

const nh = u32(), hb = Buffer.alloc(8 * nh);
for (let i = 0; i < nh; i++) { const x = f64(), y = f64(), z = f64(); hb.writeDoubleLE(Math.hypot(x, y, z), 8 * i); }
out.push(hb);

const ns = u32();
for (let s = 0; s < ns; s++) {
  const ol = u32(), opts = JSON.parse(b.toString('utf8', o, o + ol)); o += ol;
  const id = u32();
  let t = 0, busy = 0, logs = [], sc = 0, frames = [];
  const hub = new RoamHub({ timer: false, now: () => t, busy: () => busy, log: l => logs.push(l), ...opts });
  hub.id = id;
  // every 11th send from the 8th on does not go (as crosscheck.rs's)
  hub.attachSwitch((vip, f) => { const ok = sc++ % 11 !== 7; frames.push([vip, Buffer.from(f)]); return ok; });
  const record = full => {
    const i = hub.info(); delete i.tickMsMax;
    const r = { info: i, logs };
    if (full) { r.vips = [...hub.vips()].sort((x, y) => x - y); r.links = [...hub.players].map(([k, p]) => [k, [...p.links.keys()]]); }
    wstr(JSON.stringify(r));
    logs = [];
  };
  const ne = u32();
  for (let e = 0; e < ne; e++) {
    const k = u8();
    if (k === 0) t = f64();
    else if (k === 1) { const from = u32(), len = u32(); hub.frame(from, b.subarray(o, o + len)); o += len; }
    else if (k === 2) hub.peerGone(u32());
    else if (k === 3) {
      busy = f64();
      hub.tick();
      w32(frames.length);
      for (const [vip, f] of frames) { w32(vip); w32(f.length); out.push(f); }
      frames = [];
      record(false);
    } else if (k === 4) record(true);
    else throw new Error(`event kind ${k}`);
  }
}
process.stdout.write(Buffer.concat(out));
