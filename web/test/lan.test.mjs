// The virtual LAN switch (web/server/lan.mjs) with fake clients:
//   node --test web/test/lan.test.mjs
// Address assignment, peer lists, unicast and broadcast routing (source
// rewritten), UDP frames (kind 1/2 with ports) passed through untouched,
// ping/pong, disconnects, reconnecting to the same address (only with the
// token the welcome gave: the audit's F1), the latency of a frame through the
// switch on this machine, what a peer learns about the others (names and
// virtual addresses only), the limits (players, frame size and rate, control
// messages, a broadcast charged per receiver, limits shared by one client
// address, a flood never getting a slower receiver cut: the audit's F2),
// WebSocket keepalive and idle close, and (against the real server, when the
// game folder is there) the Origin check and /lan?resume.  The switches made
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
const { LanSwitch, LAN_WSS_OPTIONS } = await import(process.env.NFSU2_TEST_LAN ? path.resolve(process.env.NFSU2_TEST_LAN) : '../server/lan.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ip = (s) => s.split('.').reduce((a, b) => ((a << 8) | +b) >>> 0, 0);
const ipStr = (v) => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');

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
// does (/lan?resume, then a hello with the old address and the token before anything else)
class Client {
  constructor(port, name, query = '', resume = null) {
    this.name = name; this.frames = []; this.ctl = []; this.waiters = []; this.resume = resume;
    const q = resume ? (query ? query + '&resume' : '?resume') : query;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/lan${q}`);
    this.ws.binaryType = 'nodebuffer';
    if (resume) this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name, vip: ipStr(resume.vip), token: resume.token })));
    this.ws.on('message', (d, bin) => {
      if (bin) this.frames.push({ buf: Buffer.from(d), t: performance.now() });
      else this.ctl.push(JSON.parse(String(d)));
      for (const w of this.waiters.splice(0)) w();
    });
    this.closed = new Promise(r => this.ws.on('close', r));
  }
  async welcome() {
    const m = await this.until(() => this.ctl.find(m => m.t === 'welcome'));
    this.vip = m.vip >>> 0; this.token = m.token;
    if (!this.resume) this.ws.send(JSON.stringify({ t: 'hello', name: this.name }));
    return m;
  }
  until(f, ms = 2000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${this.name}: timed out`)), ms);
      const check = () => { const v = f(); if (v) { clearTimeout(t); res(v); } else this.waiters.push(check); };
      check();
    });
  }
  lastPeers() { const l = this.ctl.filter(m => m.t === 'peers'); return l.length ? l[l.length - 1].peers : null; }
  udp(dst, sport, dport, data, kind = 1, fakeSrc = 0) {
    const f = Buffer.alloc(16 + data.length);
    f[0] = kind; f.writeUInt32BE(fakeSrc, 4); f.writeUInt32BE(dst >>> 0, 8);
    f.writeUInt16BE(sport, 12); f.writeUInt16BE(dport, 14); Buffer.from(data).copy(f, 16);
    this.ws.send(f);
  }
  close() { this.ws.close(); return this.closed; }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('addresses, peer lists, unicast, broadcast, ping, disconnect, reconnect', async () => {
  const sw = await startSwitch();
  try {
    const a = new Client(sw.port, 'Alice'), b = new Client(sw.port, 'Bob'), c = new Client(sw.port, 'Carol');
    const wa = await a.welcome(), wb = await b.welcome(), wc = await c.welcome();
    // addresses: 10.77.0.2, .3, .4 in order of arrival; mask /24
    assert.equal(wa.vipStr, '10.77.0.2'); assert.equal(wb.vipStr, '10.77.0.3'); assert.equal(wc.vipStr, '10.77.0.4');
    assert.equal(ipStr(wa.vip), '10.77.0.2'); assert.equal(wa.mask, '255.255.255.0');
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
  const srv = spawn(process.execPath, [path.join(HERE, '../server/server.mjs'), '--data', DATA, '--http-port', String(hport), '--state', st],
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
    const a = new Client(sw.port, 'Alice'), b = new Client(sw.port, '  B‮ob\u0000​\n\tthe\u0007 driver with a very long name indeed  ');
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
    const shape = { welcome: ['t', 'vip', 'vipStr', 'mask', 'token'], peers: ['t', 'peers'], pong: ['t', 'id'] };
    for (const m of [...a.ctl, ...b.ctl]) {
      assert.deepEqual(Object.keys(m).sort(), [...shape[m.t]].sort(), `fields of ${m.t}`);
      if (m.t === 'peers') for (const p of m.peers) assert.deepEqual(Object.keys(p).sort(), ['name', 'vip']);
      for (const [, ip4] of JSON.stringify(m).matchAll(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g))
        assert.ok(ip4.startsWith('10.77.0.') || ip4 === '255.255.255.0', `only virtual addresses (${ip4})`);
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

test('limits: players, frame size, frame rate, control messages', async () => {
  const sw = await startSwitch({ maxPeers: 2, maxFrame: 1600, frameRate: 50, textRate: 5, maxText: 256 });
  try {
    const a = new Client(sw.port, 'A'), b = new Client(sw.port, 'B');
    await a.welcome(); await b.welcome();
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
  // further send finds it, the next keepalive tick does (before the missing pong would)
  const sw = await startSwitch({ keepaliveMs: 400, sendBuffer: 16 << 10, shedQueue: 1 << 20, byteRate: 64 << 20, frameRate: 100000,
    groupByteRate: 64 << 20, groupFrameRate: 100000 });
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
    // one Bob on the switch at Bob's address
    const peers = alice.lastPeers();
    assert.equal(peers.filter(p => (p.vip >>> 0) === bvip).length, 1);
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
    assert.equal(a.lastPeers().filter(p => p.name === 'Bob').length, 2, 'Bob, and the wrong-token client');
    // a ?resume that never sends its hello gets a fresh address after resumeWaitMs; a binary first message the same
    await x.close(); await a.close(); await b2.close();
  } finally { await sw.close(); }
});

test('reservations: never handed to another client, not even when every address is held or reserved (LAN full instead); a silent ?resume times out to a fresh one', async () => {
  const sw = await startSwitch({ maxPeers: 250, resumeWaitMs: 300 });
  try {
    const now = Date.now();
    for (let i = 2; i <= 251; i++) sw.lan.reserved.set(((10 << 24) | (77 << 16) | i) >>> 0, { hash: crypto.randomBytes(32), until: now + 60_000 + i, group: 'others' });
    const c = new Client(sw.port, 'C', '?g=newcomer');
    const code = await new Promise(r => c.ws.on('close', (k, why) => r(`${k} ${why}`)));
    assert.equal(code, '1013 LAN full', 'a newcomer waits for an address to free; nobody\'s reservation is given away');
    assert.equal(sw.lan.info().reserved, 250, 'every reservation kept');
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
  const sw = await startSwitch({ maxPeers: 250, groupReserve: 8, siteReserve: 16 });
  try {
    const alice = new Client(sw.port, 'Alice', '?g=alice'), bob = new Client(sw.port, 'Bob', '?g=bob');
    await alice.welcome(); const wb = await bob.welcome();
    // the rest of the addresses held by others, so that the switch has no free one left once Bob drops
    const now = Date.now();
    for (let i = 2; i <= 251; i++) {
      const v = ((10 << 24) | (77 << 16) | i) >>> 0;
      if (v !== alice.vip && v !== bob.vip) sw.lan.reserved.set(v, { hash: crypto.randomBytes(32), until: now + 60_000, group: 'others' });
    }
    const bvip = bob.vip;
    bob.ws.terminate();
    await alice.until(() => !alice.lastPeers()?.some(p => p.vip === bvip));
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
  } finally { await sw.close(); }
  // a client that drops many connections keeps groupReserve reservations (its own oldest go), a site siteReserve
  const sw2 = await startSwitch({ maxPeers: 250, groupReserve: 3, siteReserve: 5 });
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
  const sw = await startSwitch({ sendBuffer: 256 << 10, shedQueue: 32 << 10, byteRate: 64 << 20, frameRate: 100000, groupByteRate: 64 << 20, groupFrameRate: 100000 });
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
