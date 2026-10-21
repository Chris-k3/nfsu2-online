// The virtual LAN switch (web/server/lan.mjs) with fake clients:
//   node --test web/test/lan.test.mjs
// Address assignment, peer lists, unicast and broadcast routing (source
// rewritten), UDP frames (kind 1/2 with ports) passed through untouched,
// ping/pong, disconnects, reconnecting to the same address (only with the
// token the welcome gave: the audit's F1), the latency of a frame through the
// switch on this machine, what a peer learns about the others (names and
// virtual addresses only), the peer list (the changes to the page, the whole
// list to a page of before; a rename costs nothing: the security review), the limits (players, frame size and rate, control
// messages, a broadcast charged per receiver, limits shared by one client
// address, a flood never getting a slower receiver cut: the audit's F2),
// WebSocket keepalive and idle close, the page's notices when the switch is
// full (web/src/net/index.ts), the 2000 addresses of 10.77.0.0/21, LAN play's
// broadcasts only to the browsers with it open, a page that lets go freeing its
// address at once, the page holding a place only while a mailbox wants it (and
// a module of before always), and (against the real server, when the game
// folder is there) the Origin check and /lan?resume.  The switches made
// in this process listen on an ephemeral port of 127.0.0.1; the real server
// on NFSU2_TEST_PORT (8528).
// NFSU2_TEST_LAN=<lan.mjs>: another switch module (a negative control: the
// switch before the audit's fixes fails the F1 and F2 tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import * as esbuild from 'esbuild';
import * as P from '../src/net/proto.ts';
import { serverCommand } from '../tools/server-cmd.mjs';
const { LanSwitch, LAN_WSS_OPTIONS } = await import(process.env.NFSU2_TEST_LAN ? path.resolve(process.env.NFSU2_TEST_LAN) : '../server/lan.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ip = (s) => s.split('.').reduce((a, b) => ((a << 8) | +b) >>> 0, 0);
const ipStr = (v) => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
// every address the switch hands out: host bytes 2-251 in each /24 of 10.77.0.0/21
const ALL_VIPS = [0, 1, 2, 3, 4, 5, 6, 7].flatMap(b => Array.from({ length: 250 }, (_, i) => ((10 << 24) | (77 << 16) | (b << 8) | (i + 2)) >>> 0));

// a switch on an ephemeral port, wired as server.mjs wires it (?g=<id> and ?s=<id>: the group and site ids the
// server would derive from the client's address; ?vip= is what the switch before the audit took as a request)
async function startSwitch(opts) {
  const lan = new LanSwitch(opts);
  const srv = http.createServer((q, s) => { s.writeHead(404); s.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20, ...LAN_WSS_OPTIONS });
  srv.on('upgrade', (q, sock, head) => {
    const u = new URL(q.url, 'http://x');
    if (u.pathname !== '/lan') return sock.destroy();
    const legacy = !('reserved' in lan);
    wss.handleUpgrade(q, sock, head, ws => lan.attach(ws, null, legacy ? u.searchParams.get('vip')
      : { resume: u.searchParams.has('resume'), group: u.searchParams.get('g'), site: u.searchParams.get('s') }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { lan, port: srv.address().port, close: () => new Promise(r => { lan.stop(); for (const c of wss.clients) c.terminate(); srv.close(r); }) };
}

// a fake browser: collects control messages and frames; resume = { vip, token }: reconnects as the page
// does (/lan?resume, then a hello with the old address and the token before anything else); deltas: its hello
// asks for the changes to the peer list, as the page's does (a page of before did not: the whole list each time);
// lan: 0 or 1 in its hello, LAN play open or not, as the page's says (a page of before said nothing).
// view: the peer list as the whole lists and the changes made it; ctlBytes: the bytes of control messages it got
// bundle: its hello says it takes bundles (the switch then sends it its datagrams as bundles, kind 32); dgrams()
// takes them apart
class Client {
  constructor(port, name, query = '', resume = null, { deltas = false, lan, bundle = false } = {}) {
    this.name = name; this.frames = []; this.ctl = []; this.waiters = []; this.resume = resume; this.deltas = deltas;
    this.extra = { ...(deltas ? { deltas: 1 } : {}), ...(lan !== undefined ? { lan } : {}), ...(bundle ? { bundle: 1 } : {}) };
    this.view = null; this.ctlBytes = 0;
    const q = resume ? (query ? query + '&resume' : '?resume') : query;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/lan${q}`);
    this.ws.binaryType = 'nodebuffer';
    if (resume) this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name, vip: ipStr(resume.vip), token: resume.token, ...this.extra })));
    this.ws.on('message', (d, bin) => {
      if (bin) this.frames.push({ buf: Buffer.from(d), t: performance.now() });
      else {
        const m = JSON.parse(String(d));
        this.ctl.push(m); this.ctlBytes += d.length;
        if (m.t === 'peers') this.view = new Map(m.peers.map(p => [p.vip >>> 0, p]));
        if (m.t === 'delta' && this.view) { for (const v of m.gone) this.view.delete(v >>> 0); for (const p of m.peers) this.view.set(p.vip >>> 0, p); }
      }
      for (const w of this.waiters.splice(0)) w();
    });
    this.closed = new Promise(r => this.ws.on('close', r));
  }
  async welcome() {
    const m = await this.until(() => this.ctl.find(m => m.t === 'welcome'));
    this.vip = m.vip >>> 0; this.token = m.token;
    if (!this.resume) this.ws.send(JSON.stringify({ t: 'hello', name: this.name, ...this.extra }));
    return m;
  }
  until(f, ms = 2000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${this.name}: timed out`)), ms);
      const check = () => { const v = f(); if (v) { clearTimeout(t); res(v); } else this.waiters.push(check); };
      check();
    });
  }
  lastPeers() { return this.view && [...this.view.values()]; }
  udp(dst, sport, dport, data, kind = 1, fakeSrc = 0) {
    const f = Buffer.alloc(16 + data.length);
    f[0] = kind; f.writeUInt32BE(fakeSrc, 4); f.writeUInt32BE(dst >>> 0, 8);
    f.writeUInt16BE(sport, 12); f.writeUInt16BE(dport, 14); Buffer.from(data).copy(f, 16);
    this.ws.send(f);
  }
  /** a bundle: entries of { f: a frame, to: [vip, ...] } (no to: the frame's own destination) */
  sendBundle(entries) { this.ws.send(bundleOf(entries)); }
  /** every datagram it got, the bundles taken apart: { buf, msg (which message), kind, src, dst, data } */
  dgrams() {
    const out = [];
    this.frames.forEach(({ buf }, msg) => {
      const one = b => out.push({ buf: b, msg, kind: b[0], src: b.readUInt32BE(4), dst: b.readUInt32BE(8), data: b.subarray(16).toString() });
      if (buf[0] !== 32) return one(buf);
      for (let at = 4; at + 4 <= buf.length;) { const f = at + 4 + 4 * buf[at], end = f + buf.readUInt16BE(at + 2); one(buf.subarray(f, end)); at = end; }
    });
    return out;
  }
  close() { this.ws.close(); return this.closed; }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/** a frame as Client.udp makes one */
function frameOf(dst, data, kind = 1, sport = 9999, dport = 9999) {
  const f = Buffer.alloc(16 + Buffer.byteLength(data));
  f[0] = kind; f.writeUInt32BE(dst >>> 0, 8); f.writeUInt16BE(sport, 12); f.writeUInt16BE(dport, 14); Buffer.from(data).copy(f, 16);
  return f;
}
/** a bundle (lan.mjs kind 32) of entries { f, to } */
function bundleOf(entries) {
  const parts = [Buffer.from([32, 0, 0, 0])];
  for (const { f, to = [] } of entries) {
    const h = Buffer.alloc(4 + 4 * to.length);
    h[0] = to.length; h.writeUInt16BE(f.length, 2); to.forEach((v, j) => h.writeUInt32BE(v >>> 0, 4 + 4 * j));
    parts.push(h, f);
  }
  return Buffer.concat(parts);
}

test('addresses, peer lists, unicast, broadcast, ping, disconnect, reconnect', async () => {
  const sw = await startSwitch();
  try {
    const a = new Client(sw.port, 'Alice'), b = new Client(sw.port, 'Bob'), c = new Client(sw.port, 'Carol');
    const wa = await a.welcome(), wb = await b.welcome(), wc = await c.welcome();
    // addresses: round the eight /24s of 10.77.0.0/21 in order of arrival; mask /21
    assert.equal(wa.vipStr, '10.77.0.2'); assert.equal(wb.vipStr, '10.77.1.2'); assert.equal(wc.vipStr, '10.77.2.2');
    assert.equal(ipStr(wa.vip), '10.77.0.2'); assert.equal(wa.mask, '255.255.248.0');
    // everyone's peer list ends with all three names
    for (const x of [a, b, c])
      await x.until(() => { const p = x.lastPeers(); return p && p.length === 3 && ['Alice', 'Bob', 'Carol'].every(n => p.some(q => q.name === n)); });

    // unicast A -> B, with a forged source: B sees A's real address, ports and data intact; C sees nothing
    a.udp(b.vip, 47210, 47211, 'hello bob', 1, ip('10.77.0.99'));
    const fb = await b.until(() => b.frames[0]);
    assert.equal(fb.buf[0], 1);
    assert.equal(fb.buf.readUInt32BE(4), a.vip, 'source rewritten to the sender');
    assert.equal(fb.buf.readUInt32BE(8), b.vip);
    assert.equal(fb.buf.readUInt16BE(12), 47210); assert.equal(fb.buf.readUInt16BE(14), 47211);
    assert.equal(fb.buf.subarray(16).toString(), 'hello bob');
    await sleep(50);
    assert.equal(c.frames.length, 0, 'unicast reaches only its destination');
    assert.equal(a.frames.length, 0);

    // broadcast from C: A and B get it, C does not; kind 2 (test loopback) is routed like any kind
    c.udp(0xffffffff, 47300, 47301, 'beacon', 2);
    const ga = await a.until(() => a.frames[0]), gb = await b.until(() => b.frames[1]);
    for (const g of [ga, gb]) {
      assert.equal(g.buf[0], 2); assert.equal(g.buf.readUInt32BE(4), c.vip); assert.equal(g.buf.readUInt32BE(8), 0xffffffff);
      assert.equal(g.buf.readUInt16BE(14), 47301); assert.equal(g.buf.subarray(16).toString(), 'beacon');
    }
    await sleep(50);
    assert.equal(c.frames.length, 0, 'a broadcast does not come back to its sender');

    // a frame shorter than the switch header is ignored
    a.ws.send(Buffer.alloc(8));
    // ping / pong
    a.ws.send(JSON.stringify({ t: 'ping', id: 7 }));
    await a.until(() => a.ctl.find(m => m.t === 'pong' && m.id === 7));

    // B leaves: the others' peer lists drop it; frames to its address are counted as dropped
    const bvip = b.vip;
    await b.close();
    await a.until(() => { const p = a.lastPeers(); return p && p.length === 2 && !p.some(q => q.name === 'Bob'); });
    const d0 = sw.lan.info().dropped;
    a.udp(bvip, 1, 2, 'into the void');
    await sleep(50);
    assert.equal(sw.lan.info().dropped, d0 + 1);

    // B comes back with its token (?resume, then the hello): it gets its address back
    const b2 = new Client(sw.port, 'Bob', '', { vip: bvip, token: wb.token });
    const wb2 = await b2.welcome();
    assert.equal(wb2.vip >>> 0, bvip, 'a reconnect with the token gets the same address back');
    assert.notEqual(wb2.token, wb.token, 'a new token each welcome');
    // the old request (?vip=), a taken address, a wrong token, or one outside the LAN: a fresh address
    const d = new Client(sw.port, 'Dave', `?vip=${ipStr(a.vip)}`, { vip: a.vip, token: 'x'.repeat(22) });
    const wd = await d.welcome();
    assert.notEqual(wd.vip >>> 0, a.vip);
    const e = new Client(sw.port, 'Eve', '?vip=192.168.1.20', { vip: ip('192.168.1.20'), token: wa.token });
    const we = await e.welcome();
    assert.equal(we.vip >>> 24, 10); assert.equal((we.vip >>> 16) & 255, 77);
    const f = new Client(sw.port, 'Fred', '?vip=10.77.0.255');
    const wf = await f.welcome();
    assert.ok((wf.vip & 255) >= 2 && (wf.vip & 255) <= 251, 'only host addresses .2 .. .251');
    // all addresses distinct
    const vips = [a.vip, b2.vip, c.vip, d.vip, e.vip, f.vip];
    assert.equal(new Set(vips).size, vips.length);
    // A -> the reconnected B works again
    a.udp(bvip, 5, 6, 'welcome back');
    const fb2 = await b2.until(() => b2.frames[0]);
    assert.equal(fb2.buf.subarray(16).toString(), 'welcome back');

    const info = sw.lan.info();
    assert.equal(info.peers.length, 6);
    for (const x of [a, b2, c, d, e, f]) await x.close();
    await sleep(50);
    assert.equal(sw.lan.info().peers.length, 0, 'every address freed');
  } finally { await sw.close(); }
});

test('latency of a frame through the switch (this machine)', async () => {
  // limits far above the 2160 frames sent here (the limits have tests of their own)
  const sw = await startSwitch({ frameRate: 100000, groupFrameRate: 100000 });
  try {
    const a = new Client(sw.port, 'A'), b = new Client(sw.port, 'B');
    await a.welcome(); await b.welcome();
    const N = 2000, lat = [];
    // 200-byte datagrams (a roam snapshot is 182 bytes), one at a time
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      a.udp(b.vip, 47210, 47210, Buffer.alloc(200, i & 255));
      await b.until(() => b.frames.length > i, 2000);
      lat.push(b.frames[i].t - t0);
    }
    lat.sort((x, y) => x - y);
    const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
    console.log(`switch one-way latency, ${N} frames of 216 bytes over localhost: p50 ${q(0.5).toFixed(3)} ms, ` +
      `p99 ${q(0.99).toFixed(3)} ms, max ${lat[lat.length - 1].toFixed(3)} ms`);
    assert.ok(q(0.5) < 5, 'well under a frame');
    // a burst: 20 Hz x 8 friends for one second, sent at once, all arrive in order
    const before = b.frames.length;
    for (let i = 0; i < 160; i++) a.udp(b.vip, 47210, 47210, Buffer.from(String(i)));
    await b.until(() => b.frames.length === before + 160, 3000);
    assert.deepEqual(b.frames.slice(before).map(f => +f.buf.subarray(16).toString()), [...Array(160).keys()]);
    await a.close(); await b.close();
  } finally { await sw.close(); }
});

// the real server: the /lan upgrade path (Origin check, ?resume and the token)
const DATA = process.env.NFSU2_DATA || path.join(os.homedir(), 'projects/nsfu2/Need for Speed - Underground 2');
test('server.mjs: /lan accepts its own pages and tools, refuses other sites; an address only back to its token', { skip: !fs.existsSync(path.join(DATA, 'SPEED2.EXE')) && 'no game folder' }, async () => {
  const hport = +(process.env.NFSU2_TEST_PORT || 8528);
  const st = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'lantest-'));
  const srv = spawn(...serverCommand(path.join(HERE, '../server/server.mjs'), ['--data', DATA, '--http-port', String(hport), '--state', st]),
    { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((res, rej) => {
      let out = '';
      const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000);
      srv.stdout.on('data', d => { out += d; if (out.includes('  access    :')) { clearTimeout(t); res(); } });
      srv.on('exit', c => { clearTimeout(t); rej(new Error('server exited ' + c + ' ' + out)); });
    });
    const open = (headers, q = '', first = null, keep = false) => new Promise(res => {
      const ws = new WebSocket(`ws://127.0.0.1:${hport}/lan${q}`, { headers });
      if (first) ws.on('open', () => ws.send(JSON.stringify(first)));
      ws.on('message', (d, bin) => { if (!bin) { const m = JSON.parse(String(d)); if (m.t === 'welcome') { res(keep ? { ...m, ws } : m); if (!keep) ws.close(); } } });
      ws.on('error', () => res(null)); ws.on('unexpected-response', () => res(null)); ws.on('close', () => res(null));
    });
    assert.ok(await open({}), 'no Origin (a tool): accepted');
    assert.ok(await open({ origin: `http://127.0.0.1:${hport}` }), 'the server\'s own page: accepted');
    assert.equal(await open({ origin: 'https://evil.example' }), null, 'another site: refused');
    // an address back only with its token
    const a = await open({}, '', null, true);
    const vip = a.vipStr;
    a.ws.close();
    await sleep(100);
    const thief = await open({}, `?vip=${vip}&resume`, { t: 'hello', name: 'thief', vip, token: 'A'.repeat(22) });
    assert.notEqual(thief.vipStr, vip, '?vip= or a wrong token: never the departed player\'s address');
    const back = await open({}, '?resume', { t: 'hello', name: 'player', vip, token: a.token });
    assert.equal(back.vipStr, vip, 'its own token: the address back');
  } finally {
    // the server saves its addresses as it stops: remove the folder only after it is gone
    const gone = srv.exitCode !== null || srv.signalCode !== null ? null : new Promise(res => srv.once('exit', res));
    srv.kill(); await gone;
    fs.rmSync(st, { recursive: true, force: true });
  }
});

test('what a peer learns about the others: virtual addresses and cleaned names, nothing else', async () => {
  const sw = await startSwitch();
  try {
    const a = new Client(sw.port, 'Alice'), b = new Client(sw.port, '  B‮ob\u0000​\n\tthe\u0007 driver with a very long name indeed  ', '', null, { deltas: true });
    await a.welcome(); await b.welcome();
    const want = 'Bob the driver with a very long';   // bidi, zero-width and control characters gone, spaces folded, 32 characters
    await a.until(() => a.lastPeers()?.some(p => p.name.startsWith('Bob')));
    a.ws.send(JSON.stringify({ t: 'ping', id: 1 }));
    await a.until(() => a.ctl.find(m => m.t === 'pong'));
    b.udp(a.vip, 1, 2, 'x');
    await a.until(() => a.frames[0]);
    const names = a.lastPeers().map(p => p.name).sort();
    assert.deepEqual(names, ['Alice', want.slice(0, 32)]);
    assert.equal([...names[1]].length <= 32, true);
    // every control message has only these fields, and no address but a virtual one
    await b.until(() => b.ctl.some(m => m.t === 'delta'));
    const shape = { welcome: ['t', 'vip', 'vipStr', 'mask', 'token', 'bundle'], peers: ['t', 'peers'], delta: ['t', 'peers', 'gone'], pong: ['t', 'id'] };
    for (const m of [...a.ctl, ...b.ctl]) {
      assert.deepEqual(Object.keys(m).sort(), [...shape[m.t]].sort(), `fields of ${m.t}`);
      if (m.t === 'peers' || m.t === 'delta') for (const p of m.peers) assert.deepEqual(Object.keys(p).sort(), ['name', 'vip']);
      if (m.t === 'delta') assert.ok(m.gone.every(v => Number.isInteger(v)), 'gone: addresses only');
      for (const [, ip4] of JSON.stringify(m).matchAll(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g))
        assert.ok(/^10\.77\.[0-7]\./.test(ip4) || ip4 === '255.255.248.0', `only virtual addresses (${ip4})`);
      assert.ok(!JSON.stringify(m).includes('127.0.0.1') && !/::1|::ffff/.test(JSON.stringify(m)), 'no real address');
    }
    // a peer's token reaches that peer only
    const wa = a.ctl.find(m => m.t === 'welcome'), wb = b.ctl.find(m => m.t === 'welcome');
    assert.match(wa.token, /^[A-Za-z0-9_-]{22}$/);
    assert.ok(![...a.ctl, ...a.frames.map(f => ({ s: f.buf.toString('latin1') }))].some(m => JSON.stringify(m).includes(wb.token)), 'A never sees B\'s token');
    // the frame's header carries the sender's virtual address only
    assert.equal(a.frames[0].buf.readUInt32BE(4), b.vip);
    assert.ok(!('from' in sw.lan.info().peers[0]), 'the switch keeps no real address');
    await a.close(); await b.close();
  } finally { await sw.close(); }
});

test('the peer list: the page hears what changed, a page of before the whole list; a name is the first hello\'s', async () => {
  const sw = await startSwitch();
  try {
    const a = new Client(sw.port, 'Alice', '', null, { deltas: true }), b = new Client(sw.port, 'Bob');
    const wa = await a.welcome(); await b.welcome();
    const names = (c) => (c.lastPeers() ?? []).map(p => p.name).sort().join(',');
    const same = (want) => Promise.all([a, b].map(c => c.until(() => names(c) === want)));
    await same('Alice,Bob');
    // Carol joins: the page gets her as a change, not the whole list again; the page of before the whole list
    const c = new Client(sw.port, 'Carol', '', null, { deltas: true });
    await c.welcome();
    await same('Alice,Bob,Carol');
    assert.equal(a.ctl.filter(m => m.t === 'peers').length, 1, 'the whole list once: at the page\'s hello');
    assert.ok(a.ctl.some(m => m.t === 'delta' && m.peers.some(p => p.name === 'Carol')));
    assert.equal(b.ctl.filter(m => m.t === 'delta').length, 0, 'a page of before gets no changes it cannot read');
    // more hellos from Carol (the audit: each sent everyone the whole list): her name stays, nobody hears a thing
    await sleep(300);
    const n0 = a.ctl.length, m0 = b.ctl.length;
    for (let i = 0; i < 30; i++) c.ws.send(JSON.stringify({ t: 'hello', name: `Mallory${i}`, deltas: 1 }));
    c.ws.send(JSON.stringify({ t: 'ping', id: 5 }));
    await c.until(() => c.ctl.some(m => m.t === 'pong' && m.id === 5));
    await sleep(1300);
    assert.equal(a.ctl.length, n0, 'nothing more to the page');
    assert.equal(b.ctl.length, m0, 'nothing more to the page of before');
    assert.equal(names(a), 'Alice,Bob,Carol');
    // joins in a burst: one change to each player, the whole list to the page of before at most once a second
    const d0 = a.ctl.length, f0 = b.ctl.length;
    const burst = Array.from({ length: 5 }, (_, i) => new Client(sw.port, `P${i}`, '', null, { deltas: i % 2 === 0 }));
    await Promise.all(burst.map(x => x.welcome()));
    const all = 'Alice,Bob,Carol,P0,P1,P2,P3,P4';
    await same(all);
    for (const x of burst) await x.until(() => names(x) === all);
    assert.ok(a.ctl.length - d0 <= 2, `the page: ${a.ctl.length - d0} messages for 5 joins`);
    assert.ok(b.ctl.length - f0 <= 2, `the page of before: ${b.ctl.length - f0} whole lists for 5 joins`);
    // a player who leaves and is back (with its token) before the change goes out: gone, then back
    await sleep(1100);
    const cv = c.vip, wc = c.ctl.find(m => m.t === 'welcome');
    c.ws.terminate();
    const c2 = new Client(sw.port, 'Carol', '', { vip: cv, token: wc.token }, { deltas: true });
    assert.equal((await c2.welcome()).vip >>> 0, cv);
    const back = await a.until(() => a.ctl.find(m => m.t === 'delta' && m.gone.includes(cv)));
    assert.ok(back.peers.some(p => p.vip === cv && p.name === 'Carol'), 'gone and back in one change');
    await same(all);
    // leaves: off every list
    await c2.close(); for (const x of burst) await x.close();
    await same('Alice,Bob');
    assert.ok(names(a).length && wa.vip);
    await a.close(); await b.close();
  } finally { await sw.close(); }
});

test('the cost of the peer list: a rename costs nothing, a join one small change to each player (the security review)', async () => {
  const sw = await startSwitch({ maxPeers: 250 });
  const N = 100, PRE = 10;                      // 100 players, 10 of them with a page of before
  const players = [];
  try {
    for (let i = 0; i < N; i++) players.push(new Client(sw.port, `Driver ${String(i).padStart(3, '0')}`, `?g=${i}`, null, { deltas: i >= PRE }));
    await Promise.all(players.map(p => p.welcome()));
    await Promise.all(players.map(p => p.until(() => p.view?.size === N, 5000)));
    await sleep(1200);
    const bytes = () => players.reduce((n, p) => n + p.ctlBytes, 0);
    // a client sends 40 hellos with new names: before, each sent the whole list (4 KB) to all 100
    let b0 = bytes();
    const m = new Client(sw.port, 'M', '?g=m', null, { deltas: true });
    await m.welcome();
    await m.until(() => m.view?.size === N + 1);
    for (let i = 0; i < 40; i++) m.ws.send(JSON.stringify({ t: 'hello', name: i % 2 ? 'A'.repeat(32) : 'B'.repeat(32) }));
    await sleep(1300);
    const rename = bytes() - b0;
    // its join (one change to each page, the whole list to the 10 of before) and nothing for the renames
    const list = Buffer.byteLength(JSON.stringify({ t: 'peers', peers: players[0].lastPeers() }));
    console.log(`peer list at ${N + 1} players: a join and 40 renames sent the others ${rename} bytes (the whole list ${list} bytes; ` +
      `before, ${41} whole lists to each: ${41 * list * N} bytes)`);
    assert.ok(rename < (N - PRE) * 120 + PRE * (list + 200), `${rename} bytes`);
    // churn: one client opens and closes connections 10 times; each costs the pages one small change, the pages
    // of before one whole list a second
    b0 = bytes();
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) { const x = new Client(sw.port, 'churn', '?g=m', null, { deltas: true }); await x.welcome(); await x.close(); }
    await sleep(1300);
    const churn = bytes() - b0, secs = (performance.now() - t0) / 1000;
    console.log(`10 joins and leaves in ${secs.toFixed(1)} s: ${churn} bytes to the others`);
    assert.ok(churn < 20 * (N - PRE) * 120 + Math.ceil(secs + 1) * PRE * (list + 200), `${churn} bytes`);
    await m.close();
  } finally { for (const p of players) p.ws.terminate(); await sw.close(); }
});

test('limits: players, frame size, frame rate, control messages', async () => {
  const sw = await startSwitch({ maxPeers: 2, maxFrame: 1600, frameRate: 50, textRate: 5, maxText: 256 });
  try {
    assert.equal(sw.lan.full, false);
    const a = new Client(sw.port, 'A'), b = new Client(sw.port, 'B');
    await a.welcome(); await b.welcome();
    assert.equal(sw.lan.full, true, 'full: maxPeers on the switch');
    // a third player: the switch is full (1013, a fixed reason)
    const c = new WebSocket(`ws://127.0.0.1:${sw.port}/lan`);
    const [code, reason] = await new Promise(r => c.on('close', (k, why) => r([k, String(why)])));
    assert.equal(code, 1013); assert.equal(reason, 'LAN full');
    // a frame over maxFrame is dropped, one at the limit goes through
    a.udp(b.vip, 1, 2, Buffer.alloc(1600 - 16 + 1));
    a.udp(b.vip, 1, 2, Buffer.alloc(1600 - 16));
    await b.until(() => b.frames.length === 1);
    assert.equal(b.frames[0].buf.length, 1600);
    // frame rate: a burst of 500 at 50/s (bucket of 2 s = 100) loses the rest
    for (let i = 0; i < 500; i++) a.udp(b.vip, 1, 2, 'x');
    await sleep(300);
    const got = b.frames.length - 1;
    assert.ok(got >= 95 && got <= 120, `burst limited to about two seconds' worth (${got})`);
    // control messages: over maxText dropped; a flood of pings answered up to the bucket (2 s x 5)
    a.ws.send(JSON.stringify({ t: 'ping', id: 99, pad: 'x'.repeat(300) }));
    for (let i = 0; i < 50; i++) a.ws.send(JSON.stringify({ t: 'ping', id: i }));
    await sleep(300);
    const pongs = a.ctl.filter(m => m.t === 'pong');
    assert.ok(!pongs.some(m => m.id === 99), 'an oversized control message is ignored');
    assert.ok(pongs.length >= 9 && pongs.length <= 12, `pings answered up to the bucket (${pongs.length})`);
    assert.ok(sw.lan.info().limited >= 400);
    await a.close(); await b.close();
  } finally { await sw.close(); }
});

test('keepalive: pings well under a proxy idle cut, dead and idle connections closed', async () => {
  const sw = await startSwitch({ keepaliveMs: 150, idleMs: 600 });
  try {
    // a live client answers pings (ws does automatically)
    const a = new Client(sw.port, 'A');
    let pings = 0; a.ws.on('ping', () => pings++);
    await a.welcome();
    // a dead one does not answer: gone after two intervals
    const dead = new WebSocket(`ws://127.0.0.1:${sw.port}/lan`, { autoPong: false });
    const deadClosed = new Promise(r => dead.on('close', r));
    await new Promise(r => dead.on('open', r));
    const t0 = performance.now();
    await deadClosed;
    const tDead = performance.now() - t0;
    assert.ok(tDead < 600, `no pong: closed after ${tDead.toFixed(0)} ms`);
    assert.ok(pings >= 2, `pings to a live client (${pings})`);
    // A answers pings but never sends anything: closed once idle for idleMs
    const t1 = performance.now();
    await a.closed;
    const tIdle = performance.now() - t1;
    assert.ok(tIdle < 1200, `idle client closed (${tIdle.toFixed(0)} ms)`);
  } finally { await sw.close(); }
});

// WebSocket control frames (pings, pongs): the switch answers pings itself, a
// few a second; a client that floods them, or sends pongs nobody asked for, is
// cut (no browser does either), and only a pong to the switch's own ping counts
// as a sign of life.  The phase-2 deploy review's finding 1: the ws library
// answered every ping, so a client that never read made the server queue
// pongs without end.
function rawWs(port, query = '') {
  // a client on a plain socket: exact frames, and it reads only when told to
  return new Promise((res, rej) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('error', () => {});
    s.once('connect', () => s.write(`GET /lan${query} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n\r\n`));
    s.once('data', d => (String(d).startsWith('HTTP/1.1 101') ? res(s) : rej(new Error(String(d).split('\r\n')[0]))));
  });
}
// a masked client frame (mask 0: the payload as it is)
const frame = (op, payload = Buffer.alloc(0)) => Buffer.concat([Buffer.from([0x80 | op, 0x80 | payload.length, 0, 0, 0, 0]), payload]);
const PING = 0x9, PONG = 0xa;

test('control frames: pings answered a few a second, a ping flood cut, unasked pongs never count', async () => {
  const sw = await startSwitch({ keepaliveMs: 200, ctlRate: 10 });
  try {
    // a few pings: each answered exactly once, with its own payload
    const a = new WebSocket(`ws://127.0.0.1:${sw.port}/lan`);
    await new Promise(r => a.on('open', r));
    const pongs = [];
    a.on('pong', d => pongs.push(String(d)));
    for (let i = 0; i < 5; i++) a.ping(`p${i}`);
    await sleep(200);
    assert.deepEqual(pongs, ['p0', 'p1', 'p2', 'p3', 'p4'], 'one pong per ping, payload echoed');
    // a flood from a client that never reads: cut at once, whatever it sends next
    const f = await rawWs(sw.port);
    f.pause();
    const closed = new Promise(r => f.on('close', r));
    const burst = Buffer.concat(Array(512).fill(frame(PING, Buffer.alloc(125, 0x41))));
    let sent = 0;
    const t0 = performance.now();
    while (!f.destroyed && performance.now() - t0 < 3000) {
      if (!f.write(burst)) await Promise.race([new Promise(r => f.once('drain', r)), closed]);
      sent += burst.length;
      if (sent % (burst.length * 8) === 0) f.write(frame(PONG));
    }
    await Promise.race([closed, sleep(2000)]);
    assert.ok(f.destroyed || f.closed, `the flooding client is cut (sent ${(sent / 1048576).toFixed(1)} MB)`);
    assert.ok(sent < 64 << 20, `cut early (after ${(sent / 1048576).toFixed(1)} MB)`);
    // a client that never answers the switch's pings but sends pongs of its own, a few a second: still dead
    const d = await rawWs(sw.port);
    d.resume();
    const dClosed = new Promise(r => d.on('close', r));
    const unasked = setInterval(() => { try { d.write(frame(PONG, Buffer.from('alive?'))); } catch { /* gone */ } }, 150);
    const t1 = performance.now();
    const r = await Promise.race([dClosed.then(() => 'closed'), sleep(3000).then(() => 'still open')]);
    clearInterval(unasked);
    assert.equal(r, 'closed', 'unasked pongs do not keep a connection alive');
    assert.ok(performance.now() - t1 < 1500, `closed by the keepalive (${(performance.now() - t1).toFixed(0)} ms)`);
    // a client that answers the switch's pings stays (a ws client does by itself)
    let pinged = 0; a.on('ping', () => pinged++);
    a.send(JSON.stringify({ t: 'hello', name: 'A' }));
    await sleep(700);
    assert.equal(a.readyState, WebSocket.OPEN, 'a live client stays');
    assert.ok(pinged >= 2, `pinged (${pinged})`);
    a.close(); d.destroy();
  } finally { await sw.close(); }
});

test('a receiver that never reads: cut by the keepalive tick once its queue is over the limit', async () => {
  // B sends to A, which never reads, until A's queue on the switch is just over the limit, then stops: no
  // further send finds it, the next keepalive tick does (before the missing pong would); the peer list goes out at
  // once here, before the flood (it would otherwise be the send that finds it)
  const sw = await startSwitch({ keepaliveMs: 400, sendBuffer: 16 << 10, shedQueue: 1 << 20, byteRate: 64 << 20, frameRate: 100000,
    groupByteRate: 64 << 20, groupFrameRate: 100000, peersMs: 1, fullPeersMs: 1 });
  try {
    const a = await rawWs(sw.port);
    a.pause();
    const b = new Client(sw.port, 'B');
    await b.welcome();
    await sleep(50);
    const pa = [...sw.lan.peers.values()].find(p => p.name !== 'B');
    let n = 0;
    while (pa.ws.bufferedAmount <= 16 << 10 && n < 20000) {
      const f = Buffer.alloc(8000); f[0] = 1; f.writeUInt32BE(pa.vip, 8);
      b.ws.send(f); n++;
      await new Promise(r => b.ws.send(Buffer.alloc(0), r));   // let the switch take it
      await sleep(1);
    }
    assert.ok(pa.ws.bufferedAmount > 16 << 10, `A's queue grew (${pa.ws.bufferedAmount} bytes after ${n} frames)`);
    // (seen from the switch: A's own socket is paused and may not notice)
    const t0 = performance.now();
    while (sw.lan.peers.has(pa.vip) && performance.now() - t0 < 1500) await sleep(20);
    assert.ok(!sw.lan.peers.has(pa.vip), 'A is off the switch');
    assert.equal(sw.lan.info().cuts.queue, 1, `cut by the tick for its queue: ${JSON.stringify(sw.lan.info().cuts)}`);
    await b.close(); a.destroy();
  } finally { await sw.close(); }
});

test('LAN impairment (--lan-impair): UDP lost, TCP delayed in order, free roam untouched', async () => {
  const sw = await startSwitch({ impair: 'delay=80,jitter=0,loss=100,seed=3' });
  try {
    const a = new Client(sw.port, 'A'), b = new Client(sw.port, 'B');
    await a.welcome(); await b.welcome();
    // LAN UDP (kind 3) and ICMP (kind 5): every one lost at loss=100
    a.udp(b.vip, 9999, 9999, 'udp', 3); a.udp(b.vip, 0, 0, 'icmp', 5);
    // free roam (kind 1): not impaired, arrives at once
    const t0 = performance.now();
    a.udp(b.vip, 47210, 47210, 'roam', 1);
    const r = await b.until(() => b.frames.find(f => f.buf[0] === 1));
    assert.ok(r.t - t0 < 60, `kind 1 not delayed (${(r.t - t0).toFixed(1)} ms)`);
    // LAN TCP (kind 4): never lost, delayed by 80 ms, in order
    const t1 = performance.now();
    for (let i = 0; i < 5; i++) a.udp(b.vip, 50000, 9900, `seg${i}`, 4);
    await b.until(() => b.frames.filter(f => f.buf[0] === 4).length === 5, 3000);
    const tcp = b.frames.filter(f => f.buf[0] === 4);
    assert.deepEqual(tcp.map(f => f.buf.subarray(16).toString()), ['seg0', 'seg1', 'seg2', 'seg3', 'seg4'], 'in order');
    assert.ok(tcp[0].t - t1 >= 75, `TCP delayed (${(tcp[0].t - t1).toFixed(1)} ms)`);
    await sleep(200);
    assert.equal(b.frames.filter(f => f.buf[0] === 3 || f.buf[0] === 5).length, 0, 'UDP and ICMP lost');
    assert.equal(sw.lan.info().lost, 2);
    await a.close(); await b.close();
  } finally { await sw.close(); }
});

// ---- the audit's F1: a departed player's address and the frames meant for it ----
test('a departed player\'s address goes only to its token: an attacker who asks first gets nothing of it', async () => {
  const sw = await startSwitch({ reserveMs: 1500 });
  try {
    const alice = new Client(sw.port, 'Alice'), bob = new Client(sw.port, 'Bob');
    await alice.welcome(); const wb = await bob.welcome();
    const mallory = new Client(sw.port, 'Mallory');
    await mallory.welcome();
    await mallory.until(() => mallory.lastPeers()?.length === 3);
    // Bob drops; Mallory sees it in the peer list and asks for Bob's address at once, every way it can
    const bvip = bob.vip;
    const gone = mallory.until(() => mallory.lastPeers()?.length === 2 && !mallory.lastPeers().some(p => p.vip === bvip));
    bob.ws.terminate();
    await gone;
    const grabs = [];
    for (let i = 0; i < 4; i++) grabs.push(new Client(sw.port, 'Bob', `?vip=${ipStr(bvip)}`, i % 2 ? { vip: bvip, token: 'B'.repeat(22) } : null));
    const got = await Promise.all(grabs.map(g => g.welcome()));
    assert.ok(got.every(w => (w.vip >>> 0) !== bvip), `Mallory's connections got ${got.map(w => w.vipStr).join(', ')}, never ${ipStr(bvip)}`);
    // Bob's page comes back 250 ms later with its token: its own address
    await sleep(250);
    const bob2 = new Client(sw.port, 'Bob', '', { vip: bvip, token: wb.token });
    const wb2 = await bob2.welcome();
    assert.equal(wb2.vip >>> 0, bvip, 'Bob gets its address back');
    // Alice's frame for Bob reaches Bob, and none of Mallory's connections
    alice.udp(bvip, 9999, 9999, 'race-data-for-Bob', 3);
    const f = await bob2.until(() => bob2.frames[0]);
    assert.equal(f.buf.subarray(16).toString(), 'race-data-for-Bob');
    await sleep(100);
    assert.equal([mallory, ...grabs].reduce((n, c) => n + c.frames.length, 0), 0, 'nothing for Bob reached the attacker');
    // one Bob on the switch at Bob's address (the peer list comes up to a second later)
    await alice.until(() => alice.lastPeers()?.filter(p => (p.vip >>> 0) === bvip).length === 1);
    // a reservation ends: after reserveMs the address is an ordinary free one again (no token needed)
    await bob2.close();
    await sleep(50);
    const r0 = sw.lan.info().reserved;
    assert.ok(r0 >= 1, 'reserved while it waits for its token');
    await sleep(1700);
    sw.lan.keepalive();
    assert.equal(sw.lan.reserved.has(bvip), false, 'the reservation ended');
    for (const c of [alice, mallory, ...grabs]) await c.close();
  } finally { await sw.close(); }
});

test('a resume replaces the same client\'s older connection (one that died without a close), and only with the token', async () => {
  const sw = await startSwitch();
  try {
    const a = new Client(sw.port, 'Alice'), b = new Client(sw.port, 'Bob');
    await a.welcome(); const wb = await b.welcome();
    // a wrong token while Bob is still connected: a fresh address, Bob stays
    const x = new Client(sw.port, 'Bob', '', { vip: b.vip, token: 'C'.repeat(22) });
    const wx = await x.welcome();
    assert.notEqual(wx.vip >>> 0, b.vip);
    assert.equal(b.ws.readyState, WebSocket.OPEN);
    // Bob's page thinks its connection is gone and comes back with its token: the old one is closed
    const b2 = new Client(sw.port, 'Bob', '', { vip: b.vip, token: wb.token });
    const wb2 = await b2.welcome();
    assert.equal(wb2.vip >>> 0, b.vip);
    await b.closed;
    await sleep(50);
    assert.ok(sw.lan.peers.get(b.vip)?.ws, 'the new connection holds the address after the old one closed');
    a.udp(b.vip, 1, 2, 'to the new one');
    assert.equal((await b2.until(() => b2.frames[0])).buf.subarray(16).toString(), 'to the new one');
    await a.until(() => a.lastPeers()?.filter(p => p.name === 'Bob').length === 2);   // Bob, and the wrong-token client
    // a ?resume that never sends its hello gets a fresh address after resumeWaitMs; a binary first message the same
    await x.close(); await a.close(); await b2.close();
  } finally { await sw.close(); }
});

test('reservations: never handed to another client, not even when every address is held or reserved (LAN full instead); a silent ?resume times out to a fresh one', async () => {
  const sw = await startSwitch({ maxPeers: 2000, resumeWaitMs: 300 });
  try {
    const now = Date.now();
    ALL_VIPS.forEach((v, i) => sw.lan.reserved.set(v, { hash: crypto.randomBytes(32), until: now + 60_000 + i, group: 'others' }));
    const c = new Client(sw.port, 'C', '?g=newcomer');
    const code = await new Promise(r => c.ws.on('close', (k, why) => r(`${k} ${why}`)));
    assert.equal(code, '1013 LAN full', 'a newcomer waits for an address to free; nobody\'s reservation is given away');
    assert.equal(sw.lan.info().reserved, ALL_VIPS.length, 'every reservation kept');
    sw.lan.reserved.clear();
    const t0 = performance.now();
    const silent = new WebSocket(`ws://127.0.0.1:${sw.port}/lan?resume`);
    const m = await new Promise(r => silent.on('message', d => r(JSON.parse(String(d)))));
    assert.equal(m.t, 'welcome');
    assert.ok(performance.now() - t0 >= 250, 'after the wait');
    silent.close();
  } finally { await sw.close(); }
});

// the review of F1: with every address held or reserved, opening and closing connections fast enough made the
// switch hand out the oldest reservation, a dropped player's address, within 60 ms
test('churning connections never takes a dropped player\'s address; each client keeps only its own share of reservations', async () => {
  const sw = await startSwitch({ maxPeers: 2000, groupReserve: 8, siteReserve: 16 });
  try {
    const alice = new Client(sw.port, 'Alice', '?g=alice'), bob = new Client(sw.port, 'Bob', '?g=bob');
    await alice.welcome(); const wb = await bob.welcome();
    // the rest of the addresses held by others, so that the switch has no free one left once Bob drops
    const now = Date.now();
    for (const v of ALL_VIPS)
      if (v !== alice.vip && v !== bob.vip) sw.lan.reserved.set(v, { hash: crypto.randomBytes(32), until: now + 60_000, group: 'others' });
    const bvip = bob.vip;
    bob.ws.terminate();
    await alice.until(() => !alice.lastPeers()?.some(p => p.vip === bvip));
    assert.equal(sw.lan.full, true, 'full with one player on: every other address kept for its player');
    // Mallory opens and closes connections as fast as it can, from many addresses of its own
    let got = 0, full = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 600) {
      const ends = Array.from({ length: 20 }, (_, i) => {
        const ws = new WebSocket(`ws://127.0.0.1:${sw.port}/lan?g=m${i % 5}&s=mallory`);
        return new Promise(res => {
          ws.on('message', d => { const w = JSON.parse(String(d)); if (w.t === 'welcome') { res(w.vip >>> 0); ws.terminate(); } });
          ws.on('close', k => res(k));
          ws.on('error', () => res(0));
        });
      });
      for (const r of await Promise.all(ends)) { if (r === bvip) got++; else if (r === 1013) full++; }
    }
    console.log(`churn: Mallory's connections got Bob's address ${got} times; "LAN full" ${full} times; reserved ${sw.lan.info().reserved}`);
    assert.equal(got, 0, 'never Bob\'s address');
    assert.ok(full > 0, 'LAN full instead');
    const bob2 = new Client(sw.port, 'Bob', '?g=bob', { vip: bvip, token: wb.token });
    assert.equal((await bob2.welcome()).vip >>> 0, bvip, 'Bob gets his address back');
    await bob2.close(); await alice.close();
    for (const r of sw.lan.reserved.values()) r.until = Date.now() - 1;
    assert.equal(sw.lan.full, false, 'not full once the kept addresses run out');
  } finally { await sw.close(); }
  // a client that drops many connections keeps groupReserve reservations (its own oldest go), a site siteReserve
  const sw2 = await startSwitch({ maxPeers: 2000, groupReserve: 3, siteReserve: 5 });
  try {
    const leave = async (q, n) => { const cs = Array.from({ length: n }, () => new Client(sw2.port, 'x', q)); const v = []; for (const c of cs) v.push((await c.welcome()).vip >>> 0); for (const c of cs) await c.close(); await sleep(20); return v; };
    const first = await leave('?g=one', 6);
    const kept = [...sw2.lan.reserved.keys()];
    assert.deepEqual(kept.sort(), first.slice(3).sort(), 'the newest 3 of one client kept, its own oldest gone');
    await leave('?g=two&s=site', 3); await leave('?g=three&s=site', 3);
    const bySite = [...sw2.lan.reserved.values()].filter(r => r.site === 'site').length;
    assert.equal(bySite, 5, 'one site keeps 5');
    assert.equal([...sw2.lan.reserved.values()].filter(r => r.group === 'one').length, 3, 'another client\'s reservations untouched');
    console.log(`reservations: ${sw2.lan.info().reserved} kept, ${sw2.lan.info().evicted} given up by their own clients`);
  } finally { await sw2.close(); }
});

// ---- the audit's F2: what one client can make the switch send, and whom it can get cut ----
// a client on a plain socket that reads only when told to (a slow or stalled receiver)
async function rawPeer(port, name, query = '') {
  const s = await rawWs(port, query);
  s.write(frame(0x1, Buffer.from(JSON.stringify({ t: 'hello', name }))));
  return s;
}
test('a flood of datagrams never gets a slower receiver cut: they are dropped for it, as a full link drops UDP', async () => {
  const sw = await startSwitch({ sendBuffer: 256 << 10, shedQueue: 32 << 10, roamQueue: 16 << 10, byteRate: 64 << 20, frameRate: 100000,
    groupByteRate: 64 << 20, groupFrameRate: 100000 });
  try {
    const victim = await rawPeer(sw.port, 'Victim');
    victim.pause();                                       // reads nothing: the slowest possible link
    const attacker = new Client(sw.port, 'Attacker');
    await attacker.welcome();
    await sleep(100);
    const pv = [...sw.lan.peers.values()].find(p => p.name === 'Victim');
    // 8 KB datagrams of each kind but the stream, unicast and broadcast, far past every queue limit
    for (let i = 0; i < 400; i++) { attacker.udp(i % 4 === 3 ? 0xffffffff : pv.vip, 1, 2, Buffer.alloc(8000), [1, 2, 3, 5][i % 4]); if (i % 50 === 49) await sleep(5); }
    await sleep(500);
    const info = sw.lan.info();
    console.log(`datagram flood at a reader that never reads: victim queue ${pv.ws.bufferedAmount} bytes, shed ${info.shed}, cuts ${JSON.stringify(info.cuts)}`);
    assert.ok(sw.lan.peers.has(pv.vip), 'the victim is still on the switch');
    assert.equal(info.cuts.slow, 0, 'nobody cut for a slow queue');
    assert.ok(info.shed > 0, 'datagrams dropped for the full queue');
    assert.ok(pv.ws.bufferedAmount <= (32 << 10) + 8192, `the victim's queue stays at the drop mark (${pv.ws.bufferedAmount})`);
    victim.destroy(); await attacker.close();
  } finally { await sw.close(); }
});

test('free roam\'s datagrams (kind 1) are dropped at a much shorter queue than the others: no seconds of old positions', async () => {
  const sw = await startSwitch({ sendBuffer: 4 << 20, shedQueue: 256 << 10, roamQueue: 16 << 10, byteRate: 64 << 20, frameRate: 100000,
    groupByteRate: 64 << 20, groupFrameRate: 100000 });
  try {
    const victim = await rawPeer(sw.port, 'Victim');
    victim.pause();
    const sender = new Client(sw.port, 'Sender');
    await sender.welcome();
    await sleep(100);
    const pv = [...sw.lan.peers.values()].find(p => p.name === 'Victim');
    // free roam: past the kernel's buffers, then the switch's queue stops at roamQueue
    for (let i = 0; i < 400; i++) { sender.udp(pv.vip, 1, 2, Buffer.alloc(8000), 1); if (i % 50 === 49) await sleep(5); }
    await sleep(300);
    const roamQ = pv.ws.bufferedAmount, roamShed = sw.lan.info().shed;
    // LAN play's datagrams (kind 3) still queue up to shedQueue
    for (let i = 0; i < 60; i++) { sender.udp(pv.vip, 1, 2, Buffer.alloc(8000), 3); if (i % 20 === 19) await sleep(5); }
    await sleep(300);
    const lanQ = pv.ws.bufferedAmount;
    console.log(`kind 1 queue ${roamQ} bytes (shed ${roamShed}), then kind 3 queue ${lanQ} bytes`);
    assert.ok(roamShed > 0, 'free-roam datagrams dropped');
    assert.ok(roamQ > 0 && roamQ <= (16 << 10) + 8192, `free roam stops at roamQueue (${roamQ})`);
    assert.ok(lanQ > (16 << 10) + 8192 && lanQ <= (256 << 10) + 8192, `LAN play's datagrams go on to shedQueue (${lanQ})`);
    assert.ok(sw.lan.peers.has(pv.vip), 'the receiver is still on the switch');
    victim.destroy(); await sender.close();
  } finally { await sw.close(); }
});

// a raw peer that reads about `rate` bytes a second
// (it takes at least one chunk, up to 64 KB, every 250 ms)
function throttle(s, rate) {
  let budget = rate / 4;
  const t = setInterval(() => { budget = rate / 4; if (s.isPaused()) s.resume(); }, 250);
  s.on('data', d => { budget -= d.length; if (budget <= 0) s.pause(); });
  s.on('close', () => clearInterval(t));
  return t;
}
const STREAM_OPTS = { sendBuffer: 4 << 20, shedQueue: 32 << 10, streamQueue: 512 << 10, streamShare: 256 << 10, stallMs: 400,
  byteRate: 64 << 20, frameRate: 100000, groupByteRate: 64 << 20, groupFrameRate: 100000 };
test('a burst of stream segments (kind 4) at a receiver: the sender is cut, not the receiver', async () => {
  const sw = await startSwitch(STREAM_OPTS);
  try {
    const victim = await rawPeer(sw.port, 'Victim', '?g=victim');
    victim.pause();
    const attacker = new Client(sw.port, 'Attacker', '?g=attacker');
    await attacker.welcome();
    await sleep(100);
    const pv = [...sw.lan.peers.values()].find(p => p.name === 'Victim');
    for (let i = 0; i < 300 && attacker.ws.readyState === WebSocket.OPEN; i++) { attacker.udp(pv.vip, 50000, 9900, Buffer.alloc(8000), 4); if (i % 20 === 19) await sleep(5); }
    await Promise.race([attacker.closed, sleep(2000)]);
    const info = sw.lan.info();
    console.log(`stream burst: attacker ${attacker.ws.readyState === WebSocket.CLOSED ? 'cut' : 'still on'}, victim ${sw.lan.peers.has(pv.vip) ? 'still on' : 'cut'}, cuts ${JSON.stringify(info.cuts)}`);
    assert.equal(info.cuts.hog, 1, 'the sender is cut for flooding');
    assert.ok(sw.lan.peers.has(pv.vip), 'the receiver stays');
    assert.equal(info.cuts.slow, 0);
    // normal stream traffic (the LAN lobby: a few small segments) still flows
    const a = new Client(sw.port, 'A'), b = new Client(sw.port, 'B');
    await a.welcome(); await b.welcome();
    for (let i = 0; i < 50; i++) a.udp(b.vip, 50000, 9900, `seg${i}`, 4);
    await b.until(() => b.frames.length === 50);
    victim.destroy(); await a.close(); await b.close();
  } finally { await sw.close(); }
});

// the review of F2: stream segments from 9 client addresses, each under its own share, got a receiver that reads
// (slower than all of them together) cut
test('stream segments from many clients at a receiver that reads: the clients flooding it go, it stays', async () => {
  const sw = await startSwitch({ ...STREAM_OPTS, stallMs: 1000 });
  try {
    const victim = await rawPeer(sw.port, 'Victim', '?g=victim');
    throttle(victim, 200 << 10);                              // reads about 250 KB/s
    const att = [];
    for (let i = 0; i < 9; i++) { const c = new Client(sw.port, `a${i}`, `?g=a${i}`); await c.welcome(); att.push(c); }
    await sleep(100);
    const pv = [...sw.lan.peers.values()].find(p => p.name === 'Victim');
    // each sends 80 KB a second for 5 s: 720 KB/s in all
    const t0 = performance.now();
    while (performance.now() - t0 < 5000) {
      for (const a of att) if (a.ws.readyState === WebSocket.OPEN) for (let k = 0; k < 2; k++) a.udp(pv.vip, 50000, 9900, Buffer.alloc(8000), 4);
      await sleep(200);
    }
    await sleep(300);
    const info = sw.lan.info(), cut = att.filter(a => a.ws.readyState !== WebSocket.OPEN).length;
    console.log(`9 clients streaming at a receiver reading about 250 KB/s: receiver ${sw.lan.peers.has(pv.vip) ? 'still on' : 'CUT'}; senders cut ${cut}/9; cuts ${JSON.stringify(info.cuts)}`);
    assert.ok(sw.lan.peers.has(pv.vip), 'the receiver that reads stays');
    assert.equal(info.cuts.slow, 0);
    assert.ok(cut >= 1 && info.cuts.hog >= 1, 'senders cut');
    victim.destroy(); for (const a of att) a.ws.terminate();
  } finally { await sw.close(); }
});

// the review of F2's fix: a receiver that stopped reading (and kept its connection alive with text pings) got
// the SENDER of an ordinary stream cut
test('a receiver that stopped reading: it goes, not the player streaming to it', async () => {
  const sw = await startSwitch(STREAM_OPTS);
  try {
    const guest = await rawPeer(sw.port, 'Guest', '?g=guest');
    const keep = setInterval(() => guest.write(frame(0x1, Buffer.from(JSON.stringify({ t: 'ping', id: 1 })))), 200);
    const host = new Client(sw.port, 'Host', '?g=host');
    await host.welcome();
    await sleep(100);
    const pg = [...sw.lan.peers.values()].find(p => p.name === 'Guest');
    guest.pause();                                            // stops reading, still sends
    const t0 = performance.now();
    while (performance.now() - t0 < 5000 && sw.lan.peers.has(pg.vip) && host.ws.readyState === WebSocket.OPEN) {
      host.udp(pg.vip, 50000, 9900, Buffer.alloc(8000), 4); host.udp(pg.vip, 50000, 9900, Buffer.alloc(8000), 4);
      await sleep(25);                                        // 640 KB/s
    }
    clearInterval(keep);
    const info = sw.lan.info();
    console.log(`host streaming to a guest that stopped reading: host ${host.ws.readyState === WebSocket.OPEN ? 'still on' : 'CUT'}, guest ${sw.lan.peers.has(pg.vip) ? 'still on' : 'cut'} after ${(performance.now() - t0).toFixed(0)} ms; cuts ${JSON.stringify(info.cuts)}`);
    assert.equal(host.ws.readyState, WebSocket.OPEN, 'the host stays');
    assert.ok(!sw.lan.peers.has(pg.vip), 'the guest that stopped reading goes');
    assert.equal(info.cuts.hog, 0);
    guest.destroy(); await host.close();
  } finally { await sw.close(); }
});

test('a broadcast costs its size for every player it reaches; one client address shares one budget', async () => {
  const RATE = 64 << 10;
  const sw = await startSwitch({ byteRate: RATE, frameRate: 100000, groupByteRate: RATE, groupFrameRate: 100000, siteByteRate: RATE, siteFrameRate: 100000, maxPeers: 16 });
  try {
    const rx = [];
    for (let i = 0; i < 7; i++) { const c = new Client(sw.port, `R${i}`); await c.welcome(); rx.push(c); }
    const tx = new Client(sw.port, 'Sender');
    await tx.welcome();
    // 3 s of 1000-byte broadcasts as fast as the sender can
    const t0 = performance.now();
    while (performance.now() - t0 < 3000) { for (let i = 0; i < 20; i++) tx.udp(0xffffffff, 1, 2, Buffer.alloc(1000 - 16)); await sleep(2); }
    await sleep(300);
    const out = rx.reduce((n, c) => n + c.frames.reduce((m, f) => m + f.buf.length, 0), 0);
    const secs = (performance.now() - t0) / 1000;
    console.log(`broadcast: the switch sent the 7 receivers ${(out / 1024).toFixed(0)} KB in ${secs.toFixed(1)} s for one sender limited to ${RATE >> 10} KB/s (burst 2 s)`);
    assert.ok(out <= RATE * (secs + 2) * 1.1, `the switch sends no more for a sender than its rate, broadcast or not (${out} bytes)`);
    // two connections of one client address (one group) share its budget; another address has its own
    const g1 = new Client(sw.port, 'G1', '?g=home'), g2 = new Client(sw.port, 'G2', '?g=home'), other = new Client(sw.port, 'Other', '?g=elsewhere');
    await g1.welcome(); await g2.welcome(); await other.welcome();
    const dst = rx[0];
    const before = dst.frames.length;
    const blast = (c) => { for (let i = 0; i < 400; i++) c.udp(dst.vip, 1, 2, Buffer.alloc(1000 - 16)); };
    blast(g1); blast(g2);
    await sleep(500);
    const fromGroup = dst.frames.slice(before).filter(f => [g1.vip, g2.vip].includes(f.buf.readUInt32BE(4))).length;
    const before2 = dst.frames.length;
    blast(other);
    await sleep(500);
    const fromOther = dst.frames.slice(before2).filter(f => f.buf.readUInt32BE(4) === other.vip).length;
    console.log(`one address with two connections got ${fromGroup} frames through, another address alone ${fromOther} (the budget of one address: ${(2 * RATE) >> 10} KB burst)`);
    assert.ok(fromGroup <= (2 * RATE) / 1000 + 20, `two connections of one address share one budget (${fromGroup})`);
    assert.ok(fromOther >= 100, `another address is not affected (${fromOther})`);
    // the addresses of one site (an IPv6 /48) share the site's budget too
    const s1 = new Client(sw.port, 'S1', '?g=s1&s=site'), s2 = new Client(sw.port, 'S2', '?g=s2&s=site');
    await s1.welcome(); await s2.welcome();
    const before3 = dst.frames.length;
    blast(s1); blast(s2);
    await sleep(500);
    const fromSite = dst.frames.slice(before3).filter(f => [s1.vip, s2.vip].includes(f.buf.readUInt32BE(4))).length;
    console.log(`two addresses of one site got ${fromSite} frames through (the site's budget: ${(2 * RATE) >> 10} KB burst)`);
    assert.ok(fromSite <= (2 * RATE) / 1000 + 20, `one site shares one budget (${fromSite})`);
    for (const c of [...rx, tx, g1, g2, other, s1, s2]) await c.close();
  } finally { await sw.close(); }
});

test('the most free roam sends goes through one connection: 32 friends at 60 snapshots a second', { timeout: 30_000 }, async () => {
  const sw = await startSwitch();
  try {
    const a = new Client(sw.port, 'Roamer'), b = new Client(sw.port, 'Friend');
    await a.welcome(); await b.welcome();
    // 4 s (past the 2 s burst) of 2000 snapshots of 94 bytes a second: 32 x 60, HELLOs and PINGs
    const t0 = performance.now();
    let sent = 0;
    while (performance.now() - t0 < 4000) {
      for (const due = Math.floor((performance.now() - t0) * 2); sent < due; sent++) a.udp(b.vip, 47210, 47210, Buffer.alloc(94 - 16));
      await sleep(5);
    }
    await sleep(300);
    console.log(`free roam at the most: ${b.frames.length} of ${sent} snapshots through`);
    assert.ok(b.frames.length >= sent * 0.99, `none dropped by the connection's limits (${b.frames.length} of ${sent})`);
    await a.close(); await b.close();
  } finally { await sw.close(); }
});

test('with a store, a restart of the server keeps each player\'s address for its token (and only for it)', async () => {
  let saved = [];
  const store = { load: () => saved, save: l => { saved = JSON.parse(JSON.stringify(l)); } };
  const sw = await startSwitch({ store });
  const a = new Client(sw.port, 'Alice'), b = new Client(sw.port, 'Bob');
  const wa = await a.welcome(), wb = await b.welcome();
  await sleep(600);
  assert.equal(saved.length, 2, 'both addresses stored');
  assert.ok(!JSON.stringify(saved).includes(wa.token) && !JSON.stringify(saved).includes(wb.token), 'hashes, not the tokens');
  await sw.close();
  await a.closed; await b.closed;
  // the server comes back: an attacker who asks first gets neither address; the players get theirs
  const sw2 = await startSwitch({ store });
  try {
    const m = new Client(sw2.port, 'Mallory', '', { vip: a.vip, token: wb.token });
    const wm = await m.welcome();
    assert.ok(![a.vip, b.vip].includes(wm.vip >>> 0), `the attacker got ${wm.vipStr}`);
    const a2 = new Client(sw2.port, 'Alice', '', { vip: a.vip, token: wa.token }), b2 = new Client(sw2.port, 'Bob', '', { vip: b.vip, token: wb.token });
    assert.equal((await a2.welcome()).vip >>> 0, a.vip);
    assert.equal((await b2.welcome()).vip >>> 0, b.vip);
    for (const c of [m, a2, b2]) await c.close();
  } finally { await sw2.close(); }
});

// the page (web/src/net/index.ts), bundled as the app bundles it, against a switch on port
let pageJs = null;
async function pageNet(port) {
  pageJs ??= (await esbuild.build({ entryPoints: [path.join(HERE, '../src/net/index.ts')], bundle: true, write: false, format: 'esm', platform: 'neutral' })).outputFiles[0].text;
  globalThis.location ??= new URL(`http://127.0.0.1:${port}/`);
  return import('data:text/javascript;base64,' + Buffer.from(pageJs).toString('base64'));
}
// a net mailbox at ptr of memory as the runtime fills it before it registers it (ver 2: a module of before)
function mailbox(memory, ptr, ver = P.NET_VERSION) {
  const hdr = ver === 2 ? P.NET_V2_HDR_BYTES : P.NET_HDR_BYTES, w = new Int32Array(memory.buffer, ptr, hdr / 4);
  w[P.W_MAGIC] = P.NET_MAGIC; w[P.W_VERSION] = ver; w[P.W_HDR_BYTES] = hdr; w[P.W_SLOT_BYTES] = P.NET_SLOT_BYTES;
  w[P.W_TX_SLOTS] = P.NET_TX_SLOTS; w[P.W_RX_SLOTS] = P.NET_RX_SLOTS;
  w[P.W_TX_OFF] = hdr; w[P.W_RX_OFF] = hdr + P.NET_TX_SLOTS * P.NET_SLOT_BYTES;
  return { w, ptr, size: ver === 2 ? P.NET_V2_MAILBOX_BYTES : P.NET_MAILBOX_BYTES };
}
// the runtime's want word: set, then the TX bell rung (net_lan.c / roam_web.c set_want)
function want(mb, on) { Atomics.store(mb.w, P.W_WANT, on); Atomics.add(mb.w, P.W_TX_BELL, 1); Atomics.notify(mb.w, P.W_TX_BELL); }
// a game process with these mailboxes (HostKind: Net 4 = free roam, Lan 7 = LAN play); the others never come
const fakeGame = (memory, boxes) => ({ memory, ctl: new Int32Array(1), exited: new Promise(() => {}),
  registered: k => boxes[k] ? Promise.resolve({ ptr: boxes[k].ptr, size: boxes[k].size }) : new Promise(() => {}) });
const until = async (f, ms = 5000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(20); } };

// on a switch with room for one: the second game hears "the server is full" once while it keeps trying, and "a
// place freed up" when the first leaves and it gets on
test('the page: a notice when the switch is full, and one when a place frees up', async () => {
  const sw = await startSwitch({ maxPeers: 1 });
  const { attachNet } = await pageNet(sw.port);
  // a game with free roam's mailbox at 0, running (want); LAN play's never comes
  const game = (name, notices) => {
    const memory = new WebAssembly.Memory({ initial: 10, maximum: 10, shared: true }), mb = mailbox(memory, 0);
    want(mb, 1);
    return attachNet(fakeGame(memory, { 4: mb }), { url: `ws://127.0.0.1:${sw.port}/lan`, name, onNotice: t => notices.push(t), pingMs: 60_000 });
  };
  const na = [], nb = [];
  const a = game('A', na);
  try {
    await a.online;
    const b = game('B', nb);
    try {
      await until(() => nb.length === 1);
      assert.equal(nb[0], 'The server is full: playing with others waits for a free place');
      await until(() => sw.lan.info().refused >= 3);
      assert.equal(nb.length, 1, 'said once while it keeps trying');
      assert.equal(b.state === 'online', false);
      a.close();
      assert.match(await b.online, /^10\.77\.[0-7]\.\d+$/);
      await until(() => nb.length === 2);
      assert.equal(nb[1], 'A place on the server freed up: you can play with others now');
      assert.deepEqual(na, [], 'the first game heard nothing');
    } finally { b.close(); }
  } finally { a.close(); await sw.close(); }
});

test('addresses: 2000 on 10.77.0.0/21, handed out round its eight /24s; never .0, .1 or .252 and up; full past them', async () => {
  const lan = new LanSwitch({ maxPeers: 2000 });
  try {
    const got = [];
    for (let i = 0; i < 2000; i++) {
      const v = lan.allocate();
      assert.ok(v, `address ${i}`);
      got.push(v);
      lan.reserved.set(v, { hash: crypto.randomBytes(32), until: Date.now() + 60_000, group: `g${i}` });
    }
    assert.deepEqual(got.slice(0, 10).map(ipStr), ['10.77.0.2', '10.77.1.2', '10.77.2.2', '10.77.3.2', '10.77.4.2', '10.77.5.2',
      '10.77.6.2', '10.77.7.2', '10.77.0.3', '10.77.1.3']);
    assert.equal(new Set(got).size, 2000, 'all distinct');
    assert.deepEqual([...got].sort((x, y) => x - y), [...ALL_VIPS].sort((x, y) => x - y), 'every one of them');
    assert.equal(lan.allocate(), 0, 'none left');
    assert.equal(lan.full, true);
  } finally { lan.stop(); }
});

test('LAN play\'s broadcasts (kinds 3-5) reach only the browsers with LAN play open; free roam\'s reach everyone', async () => {
  const sw = await startSwitch();
  try {
    const open = new Client(sw.port, 'Open', '', null, { lan: 1 }), shut = new Client(sw.port, 'Shut', '', null, { lan: 0 });
    const old = new Client(sw.port, 'Old'), later = new Client(sw.port, 'Later', '', null, { lan: 0 });
    const tx = new Client(sw.port, 'Host', '', null, { lan: 1 });
    const all = [open, shut, old, later, tx];
    for (const c of all) await c.welcome();
    for (const c of all) await c.until(() => c.ctl.some(m => m.t === 'peers'));        // its hello is in
    tx.udp(0xffffffff, 9999, 9999, 'any LAN games?', 3);
    tx.udp(0xffffffff, 47210, 47210, 'free roam', 1);
    await open.until(() => open.frames.length === 2); await old.until(() => old.frames.length === 2);
    await shut.until(() => shut.frames.length === 1); await later.until(() => later.frames.length === 1);
    await sleep(50);
    assert.deepEqual(shut.frames.map(f => f.buf[0]), [1], 'LAN play shut: free roam\'s broadcast only');
    assert.deepEqual(old.frames.map(f => f.buf[0]).sort(), [1, 3], 'a page of before (no lan in its hello): every broadcast, as before');
    // LAN play opens later ({"t":"lan"}), then shuts again
    later.ws.send(JSON.stringify({ t: 'lan', on: 1 }));
    await sleep(50);
    tx.udp(0xffffffff, 9999, 9999, 'again', 5);
    await later.until(() => later.frames.length === 2);
    assert.equal(later.frames[1].buf[0], 5);
    later.ws.send(JSON.stringify({ t: 'lan', on: 0 }));
    await sleep(50);
    tx.udp(0xffffffff, 9999, 9999, 'once more', 3);
    await open.until(() => open.frames.length === 4);
    await sleep(50);
    assert.equal(later.frames.length, 2, 'shut again: no more of them');
    assert.equal(shut.frames.length, 1);
    // unicast is not affected
    tx.udp(shut.vip, 9999, 9999, 'to you', 3);
    await shut.until(() => shut.frames.length === 2);
    for (const c of all) await c.close();
  } finally { await sw.close(); }
});

test('a page that lets go (1000 "idle" or "closed") frees its address at once; a connection lost otherwise keeps it for its token', async () => {
  const sw = await startSwitch();
  try {
    const a = new Client(sw.port, 'A'), b = new Client(sw.port, 'B'), c = new Client(sw.port, 'C'), d = new Client(sw.port, 'D');
    for (const x of [a, b, c, d]) await x.welcome();
    a.ws.close(1000, 'idle'); b.ws.close(1000, 'closed'); c.ws.close(1000, 'bye'); d.ws.terminate();
    await Promise.all([a.closed, b.closed, c.closed, d.closed]);
    await until(() => sw.lan.info().peers.length === 0);
    assert.deepEqual([...sw.lan.reserved.keys()].sort(), [c.vip, d.vip].sort(), 'only the ones that did not say so keep their address');
    assert.equal(sw.lan.info().released, 2);
  } finally { await sw.close(); }
});

// the page holds a place only while a mailbox wants it (free roam while it runs, LAN play from the game's
// WSAStartup to its last WSACleanup), and tells the switch whether LAN play is open; a module of before (a
// version 2 mailbox, no want word) always wants it, as before
test('the page: the switch let go when no mailbox wants it, taken again when one does; LAN play open or not; a module of before', async () => {
  const sw = await startSwitch();
  const { attachNet } = await pageNet(sw.port);
  const pages = Math.ceil(2 * P.NET_MAILBOX_BYTES / 65536);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  const roam = mailbox(memory, 0), lanMb = mailbox(memory, P.NET_MAILBOX_BYTES);
  const logs = [];
  const link = attachNet(fakeGame(memory, { 4: roam, 7: lanMb }), { url: `ws://127.0.0.1:${sw.port}/lan`, name: 'P', pingMs: 60_000, idleMs: 300, log: l => logs.push(l) });
  const peer = () => [...sw.lan.peers.values()][0];
  try {
    await sleep(300);
    assert.equal(sw.lan.peers.size, 0, 'nothing wants the switch yet: no connection');
    want(lanMb, 1);                                                        // the game's WSAStartup
    const v1 = await link.online;
    await until(() => sw.lan.peers.size === 1 && peer().hello);
    assert.equal(peer().lan, true, 'LAN play open: said in the hello');
    assert.equal(Atomics.load(lanMb.w, P.W_PAGE_STATE), P.NET_PAGE_ONLINE);
    want(roam, 1); want(lanMb, 0);                                         // free roam on, LAN screens left
    await until(() => peer().lan === false);
    await sleep(600);
    assert.equal(sw.lan.peers.size, 1, 'free roam still wants it');
    want(roam, 0);                                                         // free roam off too
    await sleep(100);
    assert.equal(sw.lan.peers.size, 1, 'kept for idleMs');
    await until(() => sw.lan.peers.size === 0);
    assert.equal(link.state, 'idle');
    assert.equal(sw.lan.info().released, 1, 'its address freed at once');
    assert.equal(sw.lan.reserved.size, 0);
    for (const mb of [roam, lanMb]) assert.equal(Atomics.load(mb.w, P.W_PAGE_STATE), P.NET_PAGE_IDLE);
    // a want back within idleMs keeps the place; after it, the page connects again
    want(lanMb, 1);
    await until(() => sw.lan.peers.size === 1 && Atomics.load(lanMb.w, P.W_PAGE_STATE) === P.NET_PAGE_ONLINE);
    assert.equal(peer().lan, true);
    const v2 = P.ipStr(Atomics.load(lanMb.w, P.W_VIP) >>> 0);
    assert.notEqual(v2, v1, 'a new address (the old one went back)');
    want(lanMb, 0); await sleep(100); want(lanMb, 1); await sleep(500);
    assert.equal(sw.lan.peers.size, 1); assert.equal(sw.lan.info().released, 1, 'a short break keeps the place');
    // peer bits: one bit per host of the /21 (a peer in another /24 has its own bit; the third lands in
    // 10.77.4.x, past a /22)
    const others = [new Client(sw.port, 'O1'), new Client(sw.port, 'O2'), new Client(sw.port, 'O3')];
    for (const o of others) await o.welcome();
    const hs = others.map(o => (o.vip & 0x7ff) >>> 0);
    assert.ok(hs.some(h => h >= 1024), `a host past the /22 (${hs.map(h => h.toString(16))})`);
    for (const h of hs) await until(() => (Atomics.load(lanMb.w, P.W_PEER_BITS + (h >>> 5)) >>> (h & 31)) & 1);
    for (const o of others) await o.close();
    assert.ok(logs.some(l => /goes back/.test(l)), 'the console says why it let go');
  } finally { link.close(); await sw.close(); }
  // a module of before: version 2, no want word, always connected
  const sw2 = await startSwitch();
  try {
    const mem2 = new WebAssembly.Memory({ initial: 10, maximum: 10, shared: true }), old = mailbox(mem2, 0, 2);
    const l2 = attachNet(fakeGame(mem2, { 7: old }), { url: `ws://127.0.0.1:${sw2.port}/lan`, name: 'Old', pingMs: 60_000, idleMs: 100 });
    try {
      await l2.online;
      await until(() => sw2.lan.peers.size === 1 && [...sw2.lan.peers.values()][0].hello);
      assert.equal([...sw2.lan.peers.values()][0].lan, true, 'its LAN mailbox counts as open');
      await sleep(400);
      assert.equal(sw2.lan.peers.size, 1, 'never let go');
      const c = new Client(sw2.port, 'C'); await c.welcome();
      const h = c.vip & 255;                                               // its bitmap: by the last byte, 8 words
      await until(() => (Atomics.load(old.w, P.W_PEER_BITS + (h >>> 5)) >>> (h & 31)) & 1);
      await c.close();
    } finally { l2.close(); }
  } finally { await sw2.close(); }
  // a module of version 3: bits for a /22 (32 words), nothing written past them (its header's padding)
  const sw3 = await startSwitch();
  try {
    const mem3 = new WebAssembly.Memory({ initial: 10, maximum: 10, shared: true }), v3 = mailbox(mem3, 0, 3);
    want(v3, 1);
    const l3 = attachNet(fakeGame(mem3, { 7: v3 }), { url: `ws://127.0.0.1:${sw3.port}/lan`, name: 'V3', pingMs: 60_000, idleMs: 60_000 });
    try {
      await l3.online;
      const cs = [1, 2, 3, 4, 5].map(i => new Client(sw3.port, `C${i}`));
      for (const c of cs) await c.welcome();
      const hs = cs.map(c => (c.vip & 0x7ff) >>> 0), low = hs.filter(h => h < 1024);
      assert.ok(low.length && low.length < hs.length, `hosts on both sides of 1024 (${hs.map(h => h.toString(16))})`);
      for (const h of low) await until(() => (Atomics.load(v3.w, P.W_PEER_BITS + (h >>> 5)) >>> (h & 31)) & 1);
      for (let i = P.NET_V3_PEER_BITS / 32; i < P.NET_PEER_BITS / 32; i++) assert.equal(Atomics.load(v3.w, P.W_PEER_BITS + i), 0, `word ${i} untouched`);
      for (const c of cs) await c.close();
    } finally { l3.close(); }
  } finally { await sw3.close(); }
});

// an away player (the app's check, web/src/app/away.ts) gives the place back although the game still wants it,
// and takes one again when they are back
test('the page: away, the place goes back while the game wants it and stays free; back, it is taken again', async () => {
  const sw = await startSwitch();
  const { attachNet } = await pageNet(sw.port);
  const memory = new WebAssembly.Memory({ initial: 10, maximum: 10, shared: true }), roam = mailbox(memory, 0);
  const logs = [];
  const link = attachNet(fakeGame(memory, { 4: roam }), { url: `ws://127.0.0.1:${sw.port}/lan`, name: 'P', pingMs: 60_000, idleMs: 100, log: l => logs.push(l) });
  try {
    want(roam, 1);                                                         // free roam runs
    const v1 = await link.online;
    await until(() => sw.lan.peers.size === 1);
    link.setAway(true);
    assert.equal(link.state, 'away');
    assert.equal(Atomics.load(roam.w, P.W_PAGE_STATE), P.NET_PAGE_IDLE, 'C hears that the page let go');
    await until(() => sw.lan.peers.size === 0);
    assert.equal(sw.lan.info().released, 1, 'its address freed at once');
    assert.equal(sw.lan.reserved.size, 0);
    want(roam, 0); want(roam, 1); await sleep(300);                        // the game wants it again, and again
    assert.equal(sw.lan.peers.size, 0, 'nothing connects while away');
    want(roam, 0); await sleep(300);
    assert.equal(link.state, 'away', 'the idle timer does not end away');
    link.setAway(false);
    assert.equal(link.state, 'idle', 'back, with nothing that wants the switch: no connection');
    await sleep(200);
    assert.equal(sw.lan.peers.size, 0);
    link.setAway(true); want(roam, 1); link.setAway(false);                // back while free roam runs
    await until(() => sw.lan.peers.size === 1 && Atomics.load(roam.w, P.W_PAGE_STATE) === P.NET_PAGE_ONLINE);
    assert.notEqual(P.ipStr(Atomics.load(roam.w, P.W_VIP) >>> 0), v1, 'a new address');
    assert.ok(logs.some(l => /the player is away/.test(l)) && logs.some(l => /here again/.test(l)), 'the console says so');
  } finally { link.close(); await sw.close(); }
});

// the server's console says what the players on the switch do (server.mjs, every 5 minutes): each counted once
test('breakdown: Online mode, the LAN or Online screens, free roam, an older page, leaving or starting', async () => {
  const inOnline = new Set(), inRoam = new Set();
  const online = { vip: 0x0A4D0001, name: 'online', vips: () => inOnline, peerGone() {} };
  const roam = { vip: 0x0A4D00FD, vips: () => inRoam, peerGone() {} };
  const sw = await startSwitch({ online, roam });
  try {
    const c = (name, lan) => new Client(sw.port, name, '', null, { lan });
    const ol = c('Online', 1), ls = c('LanScreens', 1), fr = c('Roamer', 0), oldRoam = c('OldRoamer'), old = c('Old'), going = c('Leaving', 0);
    const all = [ol, ls, fr, oldRoam, old, going];
    for (const x of all) await x.welcome();
    for (const x of all) await x.until(() => x.ctl.some(m => m.t === 'peers'));
    inOnline.add(ol.vip); inRoam.add(fr.vip); inRoam.add(oldRoam.vip); inRoam.add(ol.vip);
    assert.deepEqual(sw.lan.breakdown(), { players: 6, online: 1, lan: 1, roam: 2, older: 1, other: 1, bundles: 0 });
    for (const x of all) await x.close();
  } finally { await sw.close(); }
});

// ---- bundles (kind 32): several frames in one message ------------------------------------------------------------
test('bundles: each entry reaches its destinations as a frame of its own; a client that takes bundles gets one message a turn, one that does not gets frames as before', async () => {
  const sw = await startSwitch();
  try {
    const a = new Client(sw.port, 'A', '', null, { bundle: true }), b = new Client(sw.port, 'B', '', null, { bundle: true });
    const c = new Client(sw.port, 'C'), d = new Client(sw.port, 'D', '', null, { bundle: true });
    const [wa] = [await a.welcome(), await b.welcome(), await c.welcome(), await d.welcome()];
    assert.equal(wa.bundle, 1, 'the welcome says the switch takes bundles');
    await sleep(100);
    // a snapshot to three friends once, one frame to B alone, a LAN broadcast
    a.sendBundle([{ f: frameOf(0, 'snap'), to: [b.vip, c.vip, d.vip] }, { f: frameOf(b.vip, 'only-b') }, { f: frameOf(0xFFFFFFFF, 'lan', 3) }]);
    await b.until(() => b.dgrams().length >= 3); await c.until(() => c.dgrams().length >= 2); await d.until(() => d.dgrams().length >= 2);
    await sleep(100);
    const got = x => x.dgrams().map(g => `${g.data}>${g.dst === 0xFFFFFFFF ? 'all' : g.dst === x.vip ? 'me' : g.dst}`);
    assert.deepEqual(got(b), ['snap>me', 'only-b>me', 'lan>all'], 'B: in order, each with its own destination');
    assert.deepEqual(got(c), ['snap>me', 'lan>all']);
    assert.deepEqual(got(d), ['snap>me', 'lan>all']);
    for (const x of [b, c, d]) assert.ok(x.dgrams().every(g => g.src === a.vip), 'from A, as the switch wrote it');
    assert.equal(b.frames.length, 1, 'B (takes bundles): one message for the three');
    assert.equal(b.frames[0].buf[0], 32);
    assert.equal(c.frames.length, 2, 'C (a client of before): two frames, as before');
    assert.ok(c.frames.every(f => f.buf[0] !== 32));
    assert.deepEqual(a.dgrams(), [], 'nothing back to the sender');
    const i = sw.lan.info();
    assert.equal(i.bundlesIn, 1); assert.equal(i.bundlesOut, 2); assert.equal(i.frames, 5, 'five frames routed');
    // what comes in one turn from several senders goes to B as one message
    const n0 = b.frames.length;
    c.udp(b.vip, 9999, 9999, 'c1'); d.udp(b.vip, 9999, 9999, 'd1'); a.udp(b.vip, 9999, 9999, 'a1');
    await b.until(() => b.dgrams().length >= 6);
    assert.deepEqual(b.dgrams().slice(3).map(g => g.data).sort(), ['a1', 'c1', 'd1']);
    console.log(`three senders to B: ${b.frames.length - n0} message(s)`);
    for (const x of [a, b, c, d]) await x.close();
  } finally { await sw.close(); }
});

test('bundles: each frame pays the budgets as a frame of its own; a broken entry, one over the budget, or a bundle too large ends it', async () => {
  const sw = await startSwitch({ frameRate: 10 });
  try {
    const a = new Client(sw.port, 'A', '?g=a'), b = new Client(sw.port, 'B', '?g=b');
    await a.welcome(); await b.welcome(); await sleep(50);
    // 30 times to B in one entry: the burst (2 s of 10 a second) gets through, the rest and what follows do not
    a.sendBundle([{ f: frameOf(0, 'x'), to: Array(30).fill(b.vip) }, { f: frameOf(b.vip, 'after') }]);
    await sleep(300);
    assert.equal(b.dgrams().length, 20); assert.ok(b.dgrams().every(g => g.data === 'x'));
    assert.ok(sw.lan.info().limited >= 1);
  } finally { await sw.close(); }
  const sw2 = await startSwitch();
  try {
    const a = new Client(sw2.port, 'A'), b = new Client(sw2.port, 'B');
    await a.welcome(); await b.welcome(); await sleep(50);
    const good = bundleOf([{ f: frameOf(b.vip, 'one') }]);
    // an entry longer than what is left: the ones before it went, nothing after
    a.ws.send(Buffer.concat([good, Buffer.from([0, 0, 0x10, 0x00]), frameOf(b.vip, 'cut off')]));
    // a bundle in a bundle, a bundle over maxBundle (64 KB)
    a.sendBundle([{ f: Buffer.concat([Buffer.from([32, 0, 0, 0]), frameOf(b.vip, 'nested').subarray(4)]) }]);
    a.ws.send(bundleOf(Array.from({ length: 9 }, () => ({ f: frameOf(b.vip, 'z'.repeat(8000)) }))));
    await sleep(300);
    assert.deepEqual(b.dgrams().map(g => g.data), ['one']);
    assert.ok(sw2.lan.info().limited >= 3, `limited ${sw2.lan.info().limited}`);
    a.udp(b.vip, 9999, 9999, 'still fine');
    await b.until(() => b.dgrams().length === 2);
  } finally { await sw2.close(); }
});

// the page's TX ring (as C fills it) and RX ring (as C reads it)
function txPush(memory, mb, { kind = 1, dst, sport = 47210, dport = 47210, data }) {
  const w = mb.w, dv = new DataView(memory.buffer), head = Atomics.load(w, P.W_TX_HEAD);
  const s = mb.ptr + w[P.W_TX_OFF] + ((head >>> 0) % P.NET_TX_SLOTS) * P.NET_SLOT_BYTES, d = Buffer.from(data);
  dv.setUint32(s + P.S_LEN, d.length, true); dv.setUint32(s + P.S_KIND, kind, true); dv.setUint32(s + P.S_DST_IP, dst >>> 0, true);
  dv.setUint16(s + P.S_SRC_PORT, sport, true); dv.setUint16(s + P.S_DST_PORT, dport, true);
  dv.setFloat64(s + P.S_T_MS, performance.timeOrigin + performance.now(), true);
  new Uint8Array(memory.buffer).set(d, s + P.S_DATA);
  Atomics.store(w, P.W_TX_HEAD, (head + 1) | 0);
}
const txBell = mb => { Atomics.add(mb.w, P.W_TX_BELL, 1); Atomics.notify(mb.w, P.W_TX_BELL); };
function rxTake(memory, mb) {
  const w = mb.w, dv = new DataView(memory.buffer), out = [];
  let tail = Atomics.load(w, P.W_RX_TAIL);
  for (const head = Atomics.load(w, P.W_RX_HEAD); tail !== head; tail = (tail + 1) | 0) {
    const s = mb.ptr + w[P.W_RX_OFF] + ((tail >>> 0) % P.NET_RX_SLOTS) * P.NET_SLOT_BYTES;
    out.push({ src: dv.getUint32(s + P.S_SRC_IP, true), dst: dv.getUint32(s + P.S_DST_IP, true),
      data: Buffer.from(new Uint8Array(memory.buffer, s + P.S_DATA, dv.getUint32(s + P.S_LEN, true))).toString() });
  }
  Atomics.store(w, P.W_RX_TAIL, tail);
  return out;
}

test('the page: what C queued at once goes as one bundle, a snapshot to several friends once; bundles from the switch are taken apart in order', async () => {
  const sw = await startSwitch();
  const { attachNet } = await pageNet(sw.port);
  const memory = new WebAssembly.Memory({ initial: 10, maximum: 10, shared: true }), roam = mailbox(memory, 0);
  want(roam, 1); Atomics.store(roam.w, P.W_MODE, P.NET_MODE_VLAN);
  const link = attachNet(fakeGame(memory, { 4: roam }), { url: `ws://127.0.0.1:${sw.port}/lan`, name: 'P', pingMs: 60_000 });
  try {
    const me = P.ipNum(await link.online);
    const b = new Client(sw.port, 'B'), c = new Client(sw.port, 'C', '', null, { bundle: true });
    await b.welcome(); await c.welcome(); await sleep(100);
    // a tick of free roam: the same snapshot to B and C, another frame to B, the snapshot to the hub's address
    txPush(memory, roam, { dst: b.vip, data: 'snap' }); txPush(memory, roam, { dst: c.vip, data: 'snap' });
    txPush(memory, roam, { dst: b.vip, data: 'more' }); txPush(memory, roam, { dst: P.NET_ROAM_HUB, data: 'snap' });
    txBell(roam);
    await b.until(() => b.dgrams().length >= 2); await c.until(() => c.dgrams().length >= 1);
    assert.deepEqual(b.dgrams().map(g => [g.data, g.src === me, g.dst === b.vip]), [['snap', true, true], ['more', true, true]]);
    assert.deepEqual(c.dgrams().map(g => [g.data, g.src === me, g.dst === c.vip]), [['snap', true, true]]);
    assert.equal(sw.lan.info().bundlesIn, 1, 'the four went as one message');
    // three from C at once (one bundle): the switch sends them to the page as one message, and C hears them in order
    c.sendBundle([{ f: frameOf(me, 'r1', 1, 47210, 47210) }, { f: frameOf(me, 'r2', 1, 47210, 47210) }, { f: frameOf(me, 'r3', 1, 47210, 47210) }]);
    await until(() => Atomics.load(roam.w, P.W_RX_HEAD) - Atomics.load(roam.w, P.W_RX_TAIL) >= 3);
    assert.deepEqual(rxTake(memory, roam).map(r => [r.data, r.src === c.vip, r.dst === me]), [['r1', true, true], ['r2', true, true], ['r3', true, true]]);
    assert.ok(sw.lan.info().bundlesOut >= 1, 'to the page as a bundle');
    const s = link.stats();
    assert.equal(s.framesOut, 4); assert.equal(s.framesIn, 3, 'frames counted one by one');
    await b.close(); await c.close();
  } finally { link.close(); await sw.close(); }
});
