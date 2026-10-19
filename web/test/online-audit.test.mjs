// The Online mode's fixes for its security and privacy audit (the Online audit, ONL-1 to ONL-13), one test per
// finding, against the online host (web/server/online/) in this process and, for what the switch does, against
// a switch (web/server/lan.mjs) on an ephemeral port of 127.0.0.1:
//   node --test web/test/online-audit.test.mjs
// - ONL-1:  EA Messenger has a message rate (over it: closed), its lists and its search a rate of their own,
//           and a presence goes out only when it changed, at most once a second (the latest)
// - ONL-2:  a game's record goes only to the players looking at the game list, at most once a second per game;
//           a room's population at most once a second; a gset that changes nothing goes nowhere; what the
//           host sends because of a client's frame is charged to that client (over its budget: that stream
//           goes, the others stay); a receiver far behind loses its online stream, not its connection
// - ONL-3:  a friend taken off the list is gone from it; only adding a friend makes a list; the lists are
//           capped and one client makes only so many; a second login on a Messenger connection is refused
// - ONL-4:  a Messenger connection that logged in twice and closed leaves nothing that breaks the others
// - ONL-5:  one browser is one player of a race; a browser keeps few open games; a race whose players' browsers
//           left the server ends
// - ONL-6:  a blocked list is the session's own: the next holder of the name sees none, and none is stored
// - ONL-7:  one report decides nothing, reports that differ decide nothing; a ranked race of two gives no
//           points; a race too short for its type is not taken; a full store makes room; the rankings are
//           built once for many asks; best times are capped
// - ONL-8:  no line per friend added; the lines a client causes carry its key (server.mjs: a few a minute each)
// - ONL-9:  one client (one address) holds only its share of the lobby; the last quarter is for clients that
//           hold none
// - ONL-12: the trace file is 0600, shows no LKEY, and follows a bounded number of streams
// - ONL-13: the online folder is 0700; a Messenger login key works only from its own browser
// NFSU2_TEST_SERVER_DIR=<a folder with lan.mjs and online/>: another server (a negative control: the server
// before these fixes fails these tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRV = process.env.NFSU2_TEST_SERVER_DIR ? path.resolve(process.env.NFSU2_TEST_SERVER_DIR) : path.join(HERE, '../server');
const { OnlineHost, PORTS } = await import(path.join(SRV, 'online/index.mjs'));
const { VHOST_VIP, lanFrame } = await import(path.join(SRV, 'online/vhost.mjs'));
const { encodeFrame, FrameReader, fieldMap } = await import(path.join(SRV, 'online/aries.mjs'));
const { Stats } = await import(path.join(SRV, 'online/stats.mjs'));
const { LobbyTrace } = await import(path.join(SRV, 'online/trace.mjs'));
const { LanSwitch, LAN_WSS_OPTIONS } = await import(path.join(SRV, 'lan.mjs'));

const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'nfsu2-online-audit-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const ip = (s) => s.split('.').reduce((a, b) => ((a << 8) | +b) >>> 0, 0);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SYN = 1, SYNACK = 2, RST = 3, DATA = 4, FIN = 5;

// ---- one online host and its browsers, in this process (frames to a browser go to its fake game at once) ----
function world(opts = {}) {
  let t = 1_000_000;
  const lines = [];
  const host = new OnlineHost({ log: (s, key) => lines.push({ s, key }), now: () => t, ...opts });
  const clients = new Map();
  host.attachSwitch((vip, f) => { clients.get(vip)?.frame(f); return true; });
  const w = { host, lines, clients, text: () => lines.map(l => l.s), advance: ms => { t += ms; host.lobby.tick(); }, now: () => t };
  // a browser: its virtual address, and the opaque id of its client (one address) the switch would pass
  w.client = (vipText, group = `client ${vipText}`) => { const c = new Game(w, ip(vipText), group); clients.set(c.vip, c); return c; };
  return w;
}
let nextPort = 50000, nextCid = 1;
class Game {
  constructor(w, vip, group) { this.w = w; this.vip = vip; this.ctx = { group, site: null }; this.conns = new Map(); }
  frame(f) {
    const port = f.readUInt16BE(14), op = f[16], c = this.conns.get(port);
    if (!c) return;
    if (op === SYNACK) c.open = true;
    else if (op === RST) c.reset = true;
    else if (op === FIN) c.fin = true;
    else if (op === DATA) for (const m of c.r.push(f.subarray(24))) c.msgs.push({ kind: m.kind, code: m.code, f: fieldMap(m.body, []) });
  }
  connect(dport) {
    const c = { port: nextPort++, cid: nextCid++, dport, r: new FrameReader(1 << 16), msgs: [], open: false, reset: false, fin: false };
    this.conns.set(c.port, c);
    const out = (op, data) => this.w.host.frame(this.vip, lanFrame(4, this.vip, VHOST_VIP, c.port, dport, op, c.cid, data), this.ctx);
    out(SYN);
    c.send = (kind, fields = []) => out(DATA, encodeFrame(kind, 0, fields));
    c.close = () => out(FIN);
    c.last = kind => c.msgs.filter(m => m.kind === kind).at(-1);
    c.count = kind => c.msgs.filter(m => m.kind === kind).length;
    return c;
  }
  /** a lobby session up to a persona (what the game does from its account screen to the Online Main Menu) */
  login(name, persona = name) {
    const c = this.connect(PORTS.lobby);
    c.send('addr', [['ADDR', '10.77.0.99'], ['PORT', c.port]]);
    c.send('skey', [['SKEY', '$5075626c6963204b6579']]);
    c.send('news', [['NAME', 7]]);
    c.send('sele', [['MYGAME', 1], ['STATS', 5000], ['ASYNC', 1], ['MESGS', 1]]);
    c.send('auth', [['NAME', name], ['PASS', 'secret']]);
    if (persona !== name) c.send('cper', [['PERS', persona]]);
    c.send('pers', [['PERS', persona]]);
    c.lkey = c.last('pers')?.f.get('LKEY');
    return c;
  }
  /** an EA Messenger connection, logged in with a lobby session's key */
  buddy(lkey) {
    const c = this.connect(PORTS.buddy);
    c.send('AUTH', [['PROD', 'NFS-CONSOLE-2005'], ['VERS', '0.1'], ['PRES', 20920], ['USER', '/PC/NFS-CONSOLE-2005'], ['LKEY', lkey]]);
    return c;
  }
}

/** the game's race report (rank RESU), version 3: players [{ index, place, time }] */
function resu(type, track, players) {
  const b = Buffer.alloc(8 + 55 * players.length);
  b[0] = 3; b[1] = players.length; b[2] = type; b[3] = 0; b.writeUInt16BE(track, 4); b[6] = 0; b[7] = 2;
  players.forEach((p, i) => { const o = 8 + 55 * i; b[o] = p.index; b[o + 1] = p.place; b[o + 2] = 1; b.writeFloatBE(p.time, o + 8); });
  return b.toString('base64');
}
/** a started race of game `name` between sessions (the first creates it); returns its AUTH */
function race(name, sessions, extra = []) {
  const [h, ...rest] = sessions;
  h.send('gcre', [['NAME', name], ['PARAMS', 'TRACK=4014'], ...extra]);
  for (const s of rest) s.send('gjoi', [['NAME', name]]);
  h.send('gsta', [['NAME', name]]);
  return h.last('+ses')?.f.get('AUTH');
}
const report = (c, auth, names, players, type = 0) => c.send('rank', [['AUTH', auth], ['RESU', resu(type, 4014, players)],
  ...names.map((n, i) => [`NAME${i}`, n])]);

// ---- a switch with the online host on an ephemeral port, and browsers on it ----
async function startSwitch(opts) {
  const lan = new LanSwitch(opts);
  const srv = http.createServer((q, s) => { s.writeHead(404); s.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20, ...LAN_WSS_OPTIONS });
  srv.on('upgrade', (q, sock, head) => {
    const u = new URL(q.url, 'http://x');
    wss.handleUpgrade(q, sock, head, ws => lan.attach(ws, null, { group: u.searchParams.get('g'), site: null }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { lan, port: srv.address().port, close: () => new Promise(r => { lan.stop(); for (const c of wss.clients) c.terminate(); srv.close(r); }) };
}
class Browser {
  constructor(port, group) { this.port = port; this.group = group; this.conns = new Map(); }
  async open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/lan?g=${encodeURIComponent(this.group)}`);
    this.ws.binaryType = 'nodebuffer';
    this.closed = new Promise(r => this.ws.on('close', r));
    await new Promise((res, rej) => {
      this.ws.on('message', (d, bin) => {
        if (!bin) { const m = JSON.parse(String(d)); if (m.t === 'welcome') { this.vip = m.vip >>> 0; res(); } return; }
        const f = Buffer.from(d), c = this.conns.get(f.readUInt16BE(14));
        if (!c || f[0] !== 4) return;
        if (f[16] === SYNACK) c.opened();
        else if (f[16] === RST) c.reset = true;
        else if (f[16] === DATA) for (const m of c.r.push(f.subarray(24))) c.msgs.push({ kind: m.kind, code: m.code, f: fieldMap(m.body, []) });
      });
      this.ws.on('error', rej);
    });
    return this;
  }
  async connect(dport) {
    const c = { port: nextPort++, cid: nextCid++, r: new FrameReader(1 << 16), msgs: [], reset: false };
    this.conns.set(c.port, c);
    const out = (op, data) => this.ws.send(lanFrame(4, this.vip, VHOST_VIP, c.port, dport, op, c.cid, data));
    c.send = (kind, fields = []) => out(DATA, encodeFrame(kind, 0, fields));
    c.wait = async (pred, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(10); } return false; };
    const opened = new Promise(r => { c.opened = r; });
    out(SYN);
    await opened;
    return c;
  }
  async login(name) {
    const c = await this.connect(PORTS.lobby);
    c.send('auth', [['NAME', name], ['PASS', 'x']]);
    c.send('pers', [['PERS', name]]);
    assert.ok(await c.wait(() => c.msgs.some(m => m.kind === 'pers')), `${name} logged in`);
    return c;
  }
}

// ---- ONL-1 ----
test('ONL-1: EA Messenger: a message rate, the lists and the search rated, presence only when it changed', async () => {
  const w = world(), ga = w.client('10.77.0.2'), gb = w.client('10.77.0.3');
  const la = ga.login('Flooder'), lb = gb.login('Friend1');
  const a = ga.buddy(la.lkey), b = gb.buddy(lb.lkey);
  assert.equal(a.last('AUTH').code, '');
  b.send('RADD', [['USER', 'Flooder'], ['LIST', 'B'], ['ID', 1]]);
  const pgets = () => b.msgs.filter(m => m.kind === 'PGET' && m.f.get('USER') === 'Flooder');
  // ten presences that change nothing, then ten that do, in one moment: the friend hears of the first and,
  // a second later, of the last
  const p0 = pgets().length;
  for (let i = 0; i < 10; i++) a.send('PSET', [['SHOW', 'CHAT'], ['STAT', ''], ['PROD', 'same']]);
  const p1 = pgets().length;
  assert.ok(p1 - p0 <= 1, `the same presence ten times: ${p1 - p0} PGET to the friend`);
  for (let i = 0; i < 10; i++) a.send('PSET', [['SHOW', 'CHAT'], ['STAT', ''], ['PROD', `p${i}`]]);
  assert.ok(pgets().length - p1 <= 1, `ten changes in one moment: ${pgets().length - p1} PGET at once`);
  await sleep(1200);
  assert.equal(pgets().at(-1).f.get('PROD'), 'p9', 'the latest presence follows');
  // the lists: four at once, then "full"; a flood of messages closes the connection
  w.advance(10_000);
  for (let i = 0; i < 100; i++) a.send('RGET', [['LIST', 'B'], ['ID', i]]);
  const answered = a.msgs.filter(m => m.kind === 'RGET' && !m.code).length;
  assert.ok(answered <= 5, `RGET answered with the list ${answered} times out of 100`);
  assert.ok(a.reset, 'a flood of messages: the connection is closed');
  // the search: four at once, then nothing
  const c = gb.buddy(gb.login('Friend2').lkey);
  for (let i = 0; i < 10; i++) c.send('USCH', [['USER', 'flo'], ['ID', i]]);
  const found = c.msgs.filter(m => m.kind === 'USCH' && m.f.get('SIZE') !== '0').length;
  assert.ok(found <= 4, `10 searches: ${found} done`);
});

// ---- ONL-2 ----
test('ONL-2: the lobby: game records to the game list only, at most once a second a game; populations the same; a gset that changes nothing goes nowhere', () => {
  const w = world();
  const host = w.client('10.77.0.2').login('MalHost'), mate = w.client('10.77.0.3').login('Mate');
  const viewers = [4, 5, 6].map(i => w.client(`10.77.0.${i}`).login(`View${i}`));
  const idle = [7, 8].map(i => w.client(`10.77.0.${i}`).login(`Idle${i}`));
  for (const v of viewers) v.send('gsea', [['START', 0], ['COUNT', 20]]);
  host.send('gcre', [['NAME', 'junk'], ['PARAMS', 'TRACK=1']]);
  mate.send('gjoi', [['NAME', 'junk']]);
  for (let i = 0; i < 30; i++) host.send('gset', [['PARAMS', `TRACK=${i}`]]);
  for (const v of viewers) assert.ok(v.count('+agm') <= 3, `a viewer got ${v.count('+agm')} game records for 31 changes in one moment`);
  for (const v of idle) assert.equal(v.count('+agm'), 0, 'a player not looking at the game list gets no game records');
  w.advance(1000);
  for (const v of viewers) assert.equal(v.last('+agm').f.get('PARAMS'), 'TRACK=29', 'the latest record follows');
  // a gset that changes nothing: nothing to the game's players, nothing to the list
  const m0 = mate.count('+mgm'), a0 = viewers[0].count('+agm');
  for (let i = 0; i < 10; i++) host.send('gset', [['PARAMS', 'TRACK=29']]);
  w.advance(1000);
  assert.equal(mate.count('+mgm') - m0, 0, 'unchanged settings: no update to the players');
  assert.equal(viewers[0].count('+agm') - a0, 0, 'unchanged settings: no update to the list');
  // rooms entered and left over and over: the others hear of a room's population at most once a second
  const pop0 = viewers[1].count('+pop');
  for (let i = 0; i < 20; i++) idle[0].send('move', [['NAME', i % 2 ? 'Lounge' : 'Circuit']]);
  assert.ok(viewers[1].count('+pop') - pop0 <= 4, `20 moves: ${viewers[1].count('+pop') - pop0} population updates to another player`);
});

test('ONL-2: the switch: what the host sends for a client is charged to it (over its budget: that stream goes); a receiver far behind loses its online stream, not its connection', async () => {
  const online = new OnlineHost({ log: () => {} });
  // budgets small enough that one big car description to a room of five is more than a client's share
  const sw = await startSwitch({ online, byteRate: 4 << 10, groupByteRate: 4 << 10, siteByteRate: 1 << 20 });
  try {
    const victims = [];
    for (let i = 0; i < 5; i++) {
      const b = await new Browser(sw.port, `v${i}`).open(), c = await b.login(`Victim${i}`);
      c.send('move', [['NAME', 'Lounge']]);
      assert.ok(await c.wait(() => c.msgs.some(m => m.kind === 'move')));
      victims.push({ b, c });
    }
    await sleep(2500);                                     // the victims' budgets fill up again
    const mal = await new Browser(sw.port, 'mal').open(), mc = await mal.login('Mallory');
    mc.send('move', [['NAME', 'Lounge']]);
    assert.ok(await mc.wait(() => mc.msgs.some(m => m.kind === 'move')));
    await sleep(2500);
    mc.send('auxi', [['TEXT', 'C=' + 'A'.repeat(2000)]]);
    assert.ok(await mc.wait(() => mc.reset, 2000), 'the client whose message made the server send more than its share loses that stream');
    assert.equal(mal.ws.readyState, 1, '... not its whole connection');
    for (const v of victims) assert.ok(!v.c.reset && v.b.ws.readyState === 1, 'the others keep theirs');
    // a receiver whose queue is far behind: its online stream goes, its connection stays
    const slow = victims[0], peer = sw.lan.peers.get(slow.b.vip);
    Object.defineProperty(peer.ws, 'bufferedAmount', { get: () => 9 << 20, configurable: true });
    victims[1].c.send('mesg', [['TEXT', 'hello room']]);
    await sleep(300);
    assert.equal(peer.ws.readyState, 1, 'the slow receiver is still on the switch');
    assert.equal(sw.lan.cuts.slow, 0, 'no connection was cut for it');
    assert.ok(![...online.lobby.sessions].some(s => s.persona === 'Victim0'), 'its lobby session went');
    delete peer.ws.bufferedAmount;
  } finally { await sw.close(); online.stop(); }
});

// ---- ONL-3 ----
test('ONL-3: EA Messenger memory: a friend taken off is gone, only adding a friend makes a list, lists are capped, a second login is refused', () => {
  const w = world({ buddyLimits: { lists: 10, listRate: 5 } });
  const g = w.client('10.77.0.2'), l = g.login('Flooder'), b = g.buddy(l.lkey);
  for (let i = 0; i < 300; i++) {
    b.send('RADD', [['USER', `Ghost${i}`], ['LIST', 'B']]); b.send('RDEL', [['USER', `Ghost${i}`], ['LIST', 'B']]);
    if (i % 10 === 9) w.advance(3000);
  }
  assert.ok(!b.reset);
  assert.equal(w.host.buddies.list('Flooder').names.size, 0, 'names of friends taken off are gone');
  // a persona that only asks and talks has no list
  const g2 = w.client('10.77.0.3'), l2 = g2.login('Quiet'), q = g2.buddy(l2.lkey);
  q.send('EPGT', [['ID', 1]]); q.send('RGET', [['LIST', 'B']]); q.send('PSET', [['SHOW', 'CHAT']]); q.send('PING');
  assert.ok(!w.host.buddies.lists.has('quiet'), 'no list without a friend added');
  // a second login on a connection that is logged in
  const l3 = g2.login('Quiet2');
  q.send('AUTH', [['LKEY', l3.lkey]]);
  assert.equal(q.last('AUTH').code, 'logn');
  // one client makes listRate new lists an hour; the store keeps `lists` of them, the least recently seen going
  const made = group => {
    let ok = 0;
    for (let i = 0; i < 6; i++) {
      const c = w.client(`10.77.${group.charCodeAt(0)}.${10 + i}`, group), cl = c.login(`P${group}${i}`), cb = c.buddy(cl.lkey);
      cb.send('RADD', [['USER', 'Someone'], ['LIST', 'B'], ['ID', 1]]);
      if (cb.last('RADD').code === '') ok++;
    }
    return ok;
  };
  assert.ok(made('G') <= 5, 'one client: at most listRate new lists');
  made('H'); made('I');
  assert.ok(w.host.buddies.lists.size <= 10, `${w.host.buddies.lists.size} lists kept (the cap is 10)`);
});

// ---- ONL-4 ----
test('ONL-4: a Messenger connection that logged in twice and closed breaks nobody\'s Messenger', () => {
  const errors = [], err = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const w = world();
    const v = w.client('10.77.0.10'), vb = v.buddy(v.login('Victim1').lkey);
    vb.send('PSET', [['SHOW', 'CHAT'], ['STAT', 'EX=0'], ['PROD', 'x']]);
    const a = w.client('10.77.0.20'), l1 = a.login('Mal1'), l2 = a.login('Mal2');
    const ab = a.buddy(l1.lkey);
    ab.send('AUTH', [['LKEY', l2.lkey]]);
    ab.close();
    vb.send('PSET', [['SHOW', 'AWAY'], ['STAT', 'EX=0'], ['PROD', 'x']]);
    assert.ok(!vb.reset, 'the victim\'s Messenger after the other left');
    const n = w.client('10.77.0.11'), nb = n.buddy(n.login('Victim2').lkey);
    nb.send('PSET', [['SHOW', 'CHAT']]);
    assert.ok(!nb.reset, 'a new player\'s Messenger');
    const x = w.client('10.77.0.12'), xb = x.buddy(x.login('Victim3').lkey);
    xb.send('SEND', [['USER', 'Mal1'], ['BODY', 'hi']]);
    xb.send('SEND', [['USER', 'Mal2'], ['BODY', 'hi']]);
    assert.ok(!xb.reset, 'a message to the names that connection used');
    assert.deepEqual(errors, [], 'no handler failed');
  } finally { console.error = err; }
});

// ---- ONL-5 ----
test('ONL-5: one browser is one player of a race; a browser keeps few open games; a race whose players left the server ends', () => {
  const w = world();
  const one = w.client('10.77.0.2'), sa = one.login('MalA'), sb = one.login('MalB');
  sa.send('gcre', [['NAME', 'g1']]); sb.send('gjoi', [['NAME', 'g1']]);
  sa.send('gsta', [['NAME', 'g1']]);
  assert.equal(sa.last('gsta').code, 'nepl', 'two players in one browser cannot start a race');
  // open games: openPerVip (2) for one browser
  const b = w.client('10.77.0.3'), s1 = b.login('Open1'), s2 = b.login('Open2'), s3 = b.login('Open3');
  s1.send('gcre', [['NAME', 'o1']]); s2.send('gcre', [['NAME', 'o2']]); s3.send('gcre', [['NAME', 'o3']]);
  assert.equal(s3.last('gcre').code, 'full', 'a third open game from one browser');
  // a race whose players' browsers left the switch ends after a while; one whose players are still here goes on
  const p = w.client('10.77.0.4').login('Racer1'), q = w.client('10.77.0.5').login('Racer2');
  assert.ok(race('left', [p, q]));
  const r = w.client('10.77.0.6').login('Racer3'), s = w.client('10.77.0.7').login('Racer4');
  assert.ok(race('stays', [r, s]));
  for (const c of [p, q, r, s]) c.close();
  w.host.peerGone(ip('10.77.0.4')); w.host.peerGone(ip('10.77.0.5'));
  w.advance(130_000);
  const names = [...w.host.lobby.games.values()].map(g => g.name);
  assert.ok(!names.includes('left'), 'the race of browsers that left ended');
  assert.ok(names.includes('stays'), 'the race of browsers still here goes on');
});

// ---- ONL-6 ----
test('ONL-6: a blocked list is the session\'s own: the next holder of the name sees none, none is stored', () => {
  const dir = path.join(TMP, 'onl6');
  const w = world({ stateDir: dir });
  const ga = w.client('10.77.0.50'), la = ga.login('AliceAcct', 'Alice'), ab = ga.buddy(la.lkey);
  for (const [L, u] of [['B', 'BobFriend'], ['I', 'Mallory']]) ab.send('RADD', [['LIST', L], ['USER', u], ['ID', 1]]);
  // while Alice is online the block works
  const gm = w.client('10.77.0.51'), mb = gm.buddy(gm.login('Mallory').lkey);
  mb.send('SEND', [['USER', 'Alice'], ['BODY', 'hi']]);
  assert.equal(ab.count('RECV'), 0, 'a blocked sender\'s message does not arrive');
  ab.close(); la.close(); mb.close();
  w.host.buddies.save();
  const stored = fs.readFileSync(path.join(dir, 'buddies.json'), 'utf8');
  assert.ok(!stored.includes('Mallory'), `the blocked list is not stored: ${stored}`);
  assert.ok(stored.includes('BobFriend'), 'the friends list is');
  // Mallory takes the name while Alice is away
  const g2 = w.client('10.77.0.52'), l2 = g2.login('Mallory99', 'Alice'), b2 = g2.buddy(l2.lkey);
  b2.send('RGET', [['LIST', 'I'], ['ID', 2]]);
  assert.equal(b2.last('RGET').f.get('SIZE'), '0', 'the next holder of the name sees no blocked list');
});

// ---- ONL-7 ----
test('ONL-7: results: one report or reports that differ decide nothing; ranked needs three; a race too short is not taken', () => {
  const w = world();
  const board = () => w.host.lobby.results.board(0).map(r => `${r.name}:${r.points}:${r.wins}:${r.losses}`).sort();
  // (a) one player's report alone
  const m = w.client('10.77.0.2').login('Mallory'), al = w.client('10.77.0.3').login('Alice');
  let auth = race('a', [m, al]);
  w.advance(60_000);
  report(m, auth, ['Mallory', 'Alice'], [{ index: 0, place: 1, time: 50 }, { index: 1, place: 2, time: 55 }]);
  assert.deepEqual(board(), [], 'one report decides nothing');
  // (b) two reports that differ: neither counts
  const bob = w.client('10.77.0.4').login('Bob'), carol = w.client('10.77.0.5').login('Carol');
  auth = race('b', [bob, carol]);
  w.advance(60_000);
  report(carol, auth, ['Bob', 'Carol'], [{ index: 1, place: 1, time: 50 }, { index: 0, place: 2, time: 51 }]);
  report(bob, auth, ['Bob', 'Carol'], [{ index: 0, place: 1, time: 50 }, { index: 1, place: 2, time: 51 }]);
  assert.deepEqual(board(), [], 'reports that differ decide nothing');
  // (c) a ranked race of two: counted, no points
  const x = w.client('10.77.0.6').login('Xeno'), y = w.client('10.77.0.7').login('Yuri');
  auth = race('c', [x, y], [['SYSFLAGS', 1 << 18]]);
  w.advance(60_000);
  for (const c of [x, y]) report(c, auth, ['Xeno', 'Yuri'], [{ index: 0, place: 1, time: 50 }, { index: 1, place: 2, time: 51 }]);
  assert.deepEqual(board(), ['Xeno:0:1:0', 'Yuri:0:0:1'], 'a ranked race of two players gives no points');
  // (d) too short for its type, though both agree
  const p = w.client('10.77.0.8').login('Quick1'), q = w.client('10.77.0.9').login('Quick2');
  auth = race('d', [p, q]);
  w.advance(3000);
  for (const c of [p, q]) report(c, auth, ['Quick1', 'Quick2'], [{ index: 0, place: 1, time: 1.5 }, { index: 1, place: 2, time: 2 }]);
  assert.ok(!board().some(r => r.startsWith('Quick')), 'a 3-second circuit race is not taken');
});

test('results: race types by the game\'s numbers (drag 2, drift 3); its seventh (6) is a result that counts nowhere', () => {
  const w = world();
  const boards = () => [0, 1, 2, 3, 4, 5].map(t => w.host.lobby.results.board(t).length);
  // a quarter-mile drag: times well under the other types' 20 s
  const a = w.client('10.77.0.2').login('Drag1'), b = w.client('10.77.0.3').login('Drag2');
  let auth = race('drag', [a, b]);
  w.advance(40_000);
  for (const c of [a, b]) report(c, auth, ['Drag1', 'Drag2'], [{ index: 0, place: 1, time: 11.2 }, { index: 1, place: 2, time: 12.5 }], 2);
  assert.ok(w.text().some(l => l.endsWith('"drag" (drag, unranked): 1 Drag1 0:11.20, 2 Drag2 0:12.50')), w.text().join('\n'));
  // drift: places by points, not by time
  const c = w.client('10.77.0.4').login('Drift1'), d = w.client('10.77.0.5').login('Drift2');
  auth = race('drift', [c, d]);
  w.advance(110_000);
  for (const x of [c, d]) report(x, auth, ['Drift1', 'Drift2'], [{ index: 0, place: 1, time: 104 }, { index: 1, place: 2, time: 92 }], 3);
  assert.ok(w.text().some(l => l.includes('"drift" (drift, unranked): 1 Drift1')), w.text().join('\n'));
  assert.deepEqual(boards(), [0, 0, 2, 2, 0, 0]);
  // the seventh: the result is taken and logged; no board or career counts it
  const e = w.client('10.77.0.6').login('Seven1'), f = w.client('10.77.0.7').login('Seven2');
  auth = race('seven', [e, f]);
  w.advance(110_000);
  for (const x of [e, f]) report(x, auth, ['Seven1', 'Seven2'], [{ index: 0, place: 1, time: 100 }, { index: 1, place: 2, time: 104 }], 6);
  assert.ok(w.text().some(l => l.includes('"seven" (type 6, unranked): 1 Seven1') && l.endsWith('(no stats for this race type)')), w.text().join('\n'));
  assert.ok(!w.text().some(l => l.includes('not taken')), w.text().join('\n'));
  assert.deepEqual(boards(), [0, 0, 2, 2, 0, 0]);
  assert.equal(w.host.lobby.games.size, 0, 'every race is over');
});

test('ONL-7: the results store: room for new players when full, the rankings built once for many asks, best times capped', () => {
  const st = new Stats({ max: 3 });
  st.addRace({ type: 0, ranked: false, track: 1, players: [{ name: 'Old1', place: 1, time: 50 }, { name: 'Old2', place: 2, time: 51 }] });
  st.addRace({ type: 0, ranked: false, track: 1, players: [{ name: 'New1', place: 1, time: 50 }, { name: 'New2', place: 2, time: 51 }] });
  assert.ok(st.p.size <= 3, `${st.p.size} records (the cap is 3)`);
  assert.ok(st.rec('New1') && st.rec('New2'), 'the newest players are recorded');
  // the board for the Rankings: built once for 50 asks within a few seconds
  const w = world(), a = w.client('10.77.0.2').login('Asker');
  const results = w.host.lobby.results, built = { n: 0 }, real = results.board.bind(results);
  results.board = (...x) => { built.n++; return real(...x); };
  for (let i = 0; i < 30; i++) a.send('snap', [['INDEX', i], ['CHAN', 6], ['START', 0], ['RANGE', 10]]);
  assert.ok(built.n <= 2, `the board was built ${built.n} times for 30 asks`);
  // best times: at most 300 tracks a persona
  const s2 = new Stats();
  for (let t = 0; t < 400; t++) s2.addRace({ type: 0, ranked: false, track: t, players: [{ name: 'Alpha', place: 1, time: 50 }, { name: 'Bravo', place: 2, time: 51 }] });
  assert.ok(Object.keys(s2.rec('Alpha').best).length <= 300, `${Object.keys(s2.rec('Alpha').best).length} best times kept`);
});

// ---- ONL-8 ----
test('ONL-8: no line per friend added; the lines a client causes carry its key', () => {
  const w = world(), g = w.client('10.77.0.2', 'G8'), l = g.login('Flooder'), b = g.buddy(l.lkey);
  for (let i = 0; i < 20; i++) b.send('RADD', [['USER', `Pal${i}`], ['LIST', 'B']]);
  assert.equal(w.text().filter(s => s.includes('added a friend')).length, 0);
  const login = w.lines.find(x => x.s.includes('logged in as "Flooder"'));
  assert.equal(login?.key, 'G8', 'a client\'s line carries its key (server.mjs: a few a minute per key)');
});

// ---- ONL-9 ----
test('ONL-9: one client holds only its share of the lobby; the last quarter is for clients that hold none', () => {
  const w = world({ limits: { sessions: 12 } });
  const conns = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) conns.push(w.client(`10.77.0.${10 + i}`, 'Big').connect(PORTS.lobby));
  assert.equal(conns.filter(c => c.reset).length, 1, 'one client: 8 lobby sessions, the 9th refused');
  // 8 + 1 of 12 in use: the last quarter only for a client with none
  const other = w.client('10.77.0.20', 'Other').connect(PORTS.lobby);
  assert.ok(!other.reset);
  const again = w.client('10.77.0.21', 'Other').connect(PORTS.lobby);
  assert.ok(again.reset, 'a client that holds a session already: none of the last quarter');
  const fresh = w.client('10.77.0.22', 'Fresh').connect(PORTS.lobby);
  assert.ok(!fresh.reset, 'a client that holds none gets one');
});

// ---- ONL-12 ----
test('ONL-12: the trace file is 0600, shows no LKEY, and follows a bounded number of streams', async () => {
  const file = path.join(TMP, 'trace.txt');
  const tr = new LobbyTrace(file);
  const key = 'abcdef0123456789abcdef01234567';
  tr.frame(lanFrame(4, VHOST_VIP, ip('10.77.0.2'), PORTS.lobby, 40000, DATA, 7, encodeFrame('pers', 0, [['PERS', 'Alpha'], ['LKEY', key]])));
  for (let i = 0; i < 300; i++) tr.frame(lanFrame(4, ip('10.77.0.3'), VHOST_VIP, 41000 + i, PORTS.lobby, DATA, i, Buffer.from('partial')));
  assert.ok(tr.streams.size <= 256, `${tr.streams.size} streams followed`);
  tr.close();
  await sleep(100);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('PERS="Alpha"') && !text.includes(key), text);
});

// ---- ONL-13 ----
test('ONL-13: the online folder is 0700; a Messenger login key works only from its own browser', async () => {
  const dir = path.join(TMP, 'onl13', 'online');
  const w = world({ stateDir: dir });
  const g = w.client('10.77.0.2'), l = g.login('Alpha'), b = g.buddy(l.lkey);
  b.send('RADD', [['USER', 'Bravo'], ['LIST', 'B']]);
  w.host.buddies.save();
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const other = w.client('10.77.0.9').buddy(l.lkey);
  await sleep(3500);
  assert.equal(other.last('AUTH')?.code, 'pass', 'Alpha\'s key from another browser');
  w.host.stop();
});
