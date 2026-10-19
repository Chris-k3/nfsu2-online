// The server's /players (how many play on this server now, for the start page's Multiplayer settings) and the
// line the page makes of it:
//   node --test web/test/players.test.mjs
// Against the real server when the game folder is there: the two counts and whether it is full, nothing else in
// the body, never cached, the Host check of every route, null with --online off, full with --max-peers 1.  The online count itself (logged in, or racing
// an online race) is in online-lobby.test.mjs.
// Ports: NFSU2_TEST_PLAYERS_PORT1 (8530), NFSU2_TEST_PLAYERS_PORT2 (8630).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import * as esbuild from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.NFSU2_DATA || path.join(os.homedir(), 'projects/nsfu2/Need for Speed - Underground 2');
const P1 = +(process.env.NFSU2_TEST_PLAYERS_PORT1 || 8530), P2 = +(process.env.NFSU2_TEST_PLAYERS_PORT2 || 8630);
const SKIP = !fs.existsSync(path.join(DATA, 'SPEED2.EXE')) && 'no game folder (NFSU2_DATA)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function server(port, extra = []) {
  const st = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'nfsu2-players-test-'));
  const srv = spawn(process.execPath, [path.join(HERE, '../server/server.mjs'), '--data', DATA, '--http-port', String(port), '--state', st, ...extra],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    let out = '';
    const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000);
    srv.stdout.on('data', d => { out += d; if (out.includes('  access    :')) { clearTimeout(t); res(); } });
    srv.on('exit', c => { clearTimeout(t); rej(new Error('server exited ' + c + ' ' + out)); });
  });
  return {
    get: (p, host = `localhost:${port}`) => new Promise((res, rej) => {
      http.get({ host: '127.0.0.1', port, path: p, headers: { host } }, r => {
        let body = ''; r.on('data', d => { body += d; }); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body }));
      }).on('error', rej);
    }),
    // a browser's game on the switch: its welcome, then its hello
    player: name => new Promise(res => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/lan`);
      ws.on('message', (d, bin) => { if (!bin && JSON.parse(String(d)).t === 'welcome') { ws.send(JSON.stringify({ t: 'hello', name })); res(ws); } });
    }),
    stop: async () => {
      const gone = srv.exitCode !== null || srv.signalCode !== null ? null : new Promise(res => srv.once('exit', res));
      srv.kill(); await gone;
      fs.rmSync(st, { recursive: true, force: true });
    },
  };
}

test('/players: two counts and full, nothing else, never cached, only for the server\'s own names', { skip: SKIP }, async () => {
  const s = await server(P1);
  try {
    let r = await s.get('/players');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.match(r.headers['cache-control'], /no-store/);
    assert.equal(r.headers['cdn-cache-control'], 'no-store');
    assert.ok(r.headers['x-content-type-options'], 'the security headers of every response');
    assert.deepEqual(JSON.parse(r.body), { players: 0, online: 0, full: false });
    assert.deepEqual(Object.keys(JSON.parse(r.body)), ['players', 'online', 'full'], 'nothing else in the body');
    // two games on the switch, one leaves
    const a = await s.player('Alice'), b = await s.player('Bob');
    await sleep(100);
    assert.deepEqual(JSON.parse((await s.get('/players')).body), { players: 2, online: 0, full: false });
    b.close(); await sleep(300);
    r = await s.get('/players');
    assert.equal(r.body, '{"players":1,"online":0,"full":false}', 'counts only: no names, addresses or times');
    a.close();
    // another site's name (DNS rebinding) gets what every route gives it
    assert.equal((await s.get('/players', 'evil.example')).status, 421);
    // HEAD: the headers, no body
    const head = await new Promise(res => http.request({ host: '127.0.0.1', port: P1, path: '/players', method: 'HEAD', headers: { host: `localhost:${P1}` } },
      x => { let n = 0; x.on('data', d => { n += d.length; }); x.on('end', () => res({ status: x.statusCode, n })); }).end());
    assert.deepEqual(head, { status: 200, n: 0 });
  } finally { await s.stop(); }
});

test('/players with --online off: online is null', { skip: SKIP }, async () => {
  const s = await server(P2, ['--online', 'off']);
  try {
    assert.deepEqual(JSON.parse((await s.get('/players')).body), { players: 0, online: null, full: false });
  } finally { await s.stop(); }
});

test('/players with --max-peers 1: full while one plays, and the next game gets "LAN full"', { skip: SKIP }, async () => {
  const s = await server(P1, ['--max-peers', '1']);
  try {
    const a = await s.player('Alice');
    await sleep(100);
    assert.deepEqual(JSON.parse((await s.get('/players')).body), { players: 1, online: 0, full: true });
    const b = new WebSocket(`ws://127.0.0.1:${P1}/lan`);
    assert.deepEqual(await new Promise(r => b.on('close', (k, why) => r([k, String(why)]))), [1013, 'LAN full']);
    a.close(); await sleep(300);
    assert.deepEqual(JSON.parse((await s.get('/players')).body), { players: 0, online: 0, full: false });
  } finally { await s.stop(); }
});

test('the page\'s line', async () => {
  const out = await esbuild.build({ entryPoints: [path.join(HERE, '../src/app/players.ts')], bundle: true, write: false, format: 'esm', platform: 'neutral' });
  const { playersText } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
  assert.equal(playersText({ players: 0, online: 0 }), 'On this server now: nobody is playing.');
  assert.equal(playersText({ players: 1, online: 0 }), 'On this server now: 1 player, 0 in Online mode.');
  assert.equal(playersText({ players: 3, online: 2 }), 'On this server now: 3 players, 2 in Online mode.');
  assert.equal(playersText({ players: 3, online: null }), 'On this server now: 3 players.');
  assert.equal(playersText({ players: 3, online: 1, full: false }), 'On this server now: 3 players, 1 in Online mode.');
  assert.equal(playersText({ players: 128, online: 9, full: true }),
    'On this server now: 128 players, 9 in Online mode. The server is full: playing with others waits until a place frees up.');
  assert.equal(playersText({ players: -1, online: 0 }), '');
  assert.equal(playersText({}), '');
});
