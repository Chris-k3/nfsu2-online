// The online host's results store (web/server/online/stats.mjs):
//   node --test web/test/online-stats.test.mjs
// Counts per race type, ranked and unranked, rating points; the game's STAT
// field; the boards' order; the month rolling over; saving (atomic, only
// public fields) and reading back; a damaged file kept aside; pruning; the
// race report decoder on a real report and on damaged ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Stats, decodeResult } from '../server/online/stats.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-online-'));
const T0 = Date.UTC(2026, 9, 19, 12);

test('counts, points, STAT, boards, months', () => {
  let t = T0;
  const st = new Stats({ now: () => t });
  st.addRace({ type: 0, ranked: true, track: 4014, players: [{ name: 'Alpha', place: 1, time: 100 }, { name: 'Bravo', place: 2, time: 101 },
    { name: 'Charlie', place: 0, time: 0 }] });
  st.addRace({ type: 0, ranked: false, track: 4014, players: [{ name: 'Bravo', place: 1, time: 99.5 }, { name: 'Alpha', place: 2, time: 102 }] });
  const b = st.board(0);
  assert.deepEqual(b.map(r => [r.name, r.points, r.wins, r.losses, r.races]),
    [['Alpha', 100, 1, 1, 2], ['Bravo', 50, 1, 1, 2], ['Charlie', 0, 0, 1, 1]]);
  const stat = st.statField('alpha').split(',');
  assert.equal(stat.length, 39); assert.equal(stat[38], '');
  assert.deepEqual(stat.slice(0, 8).map(x => parseInt(x, 16)), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(st.statField('Charlie').split(',').slice(0, 2).map(x => parseInt(x, 16)), [0, 1], 'a dropped race: a disconnect');
  assert.deepEqual(stat.slice(8, 13).map(x => parseInt(x, 16)), [100, 1, 0, 0, 1]);
  assert.equal(st.rec('Bravo').best['0:4014'], 99.5);
  assert.equal(st.statField('nobody'), '0,'.repeat(38));
  // a new month: the monthly counts start again, the overall ones stay
  t = Date.UTC(2026, 10, 2);
  assert.equal(st.board(0, true).length, 0);
  assert.equal(st.board(0).length, 3);
  assert.equal(st.statField('Alpha', true), '0,'.repeat(38));
  st.addRace({ type: 1, ranked: false, track: 1, players: [{ name: 'Alpha', place: 1, time: 50 }, { name: 'Bravo', place: 2, time: 51 }] });
  assert.equal(st.board(1, true)[0].name, 'Alpha');
});

test('saved atomically with public fields only, read back, a damaged file kept aside, pruned', () => {
  const dir = tmp();
  let t = T0;
  const a = new Stats({ dir, now: () => t, saveMs: 60_000 });
  a.addRace({ type: 2, ranked: true, track: 7, players: [{ name: 'Alpha', place: 1, time: 10 }, { name: 'Bravo', place: 2, time: 11 }] });
  a.stop();
  const text = fs.readFileSync(path.join(dir, 'stats.json'), 'utf8');
  assert.deepEqual(fs.readdirSync(dir), ['stats.json'], 'no temporary file left');
  const j = JSON.parse(text);
  assert.deepEqual(Object.keys(j.personas[0]).sort(), ['all', 'best', 'month', 'name', 'seen']);
  assert.ok(!/\b10\.77\.|PASS|MID|ADDR|@/.test(text));
  const b = new Stats({ dir, now: () => t });
  assert.deepEqual(b.board(2).map(r => [r.name, r.points]), [['Alpha', 100], ['Bravo', 0]]);
  // a hand-edited file: unknown fields and bad numbers are dropped
  fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify({ personas: [{ name: 'Evil<script>', all: {} },
    { name: 'Okay', seen: '2026-10', all: { 0: { races: -5, rw: 'x', points: 7, secret: 'y' } }, ip: '1.2.3.4' }] }));
  const c = new Stats({ dir, now: () => t });
  assert.equal(c.rec('Evil<script>'), null);
  assert.deepEqual(c.rec('Okay').all[0], { races: 0, rw: 0, rl: 0, uw: 0, ul: 0, points: 7, dc: 0 });
  assert.ok(!('ip' in c.rec('Okay')));
  // damaged: moved aside, a fresh start
  fs.writeFileSync(path.join(dir, 'stats.json'), '{not json');
  const logs = [];
  const d = new Stats({ dir, now: () => t, log: s => logs.push(s) });
  assert.equal(d.board(0).length, 0);
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('stats.json.bad-')));
  assert.ok(logs.some(l => l.includes('could not be read')));
  // personas not seen for a year are forgotten at the next save
  d.addRace({ type: 0, ranked: false, track: 1, players: [{ name: 'Old', place: 1, time: 5 }, { name: 'Older', place: 2, time: 6 }] });
  t = Date.UTC(2027, 11, 1);
  d.addRace({ type: 0, ranked: false, track: 1, players: [{ name: 'New', place: 1, time: 5 }, { name: 'Newer', place: 2, time: 6 }] });
  d.stop();
  const names = JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8')).personas.map(p => p.name).sort();
  assert.deepEqual(names, ['New', 'Newer']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('race report decoder', () => {
  const r = decodeResult('AwIAAQ+uAAIBAQEVQAADJ0M60exCuGZnQflKqkIogLdAsZmaQU2tD0I5HwoAAAAAAAAAAAAAAAAAAAAAAAAAAAIBFUAAAOhDO6uGQreo9kH44idCKNlYQL3CkEFciThCPgV4AAAAAAAAAAAAAAAAAAAAAAAAAA==');
  assert.deepEqual([r.type, r.track, r.laps, r.players.length], [0, 4014, 2, 2]);
  assert.deepEqual(r.players.map(p => [p.index, p.place, Math.round(p.time * 100) / 100, p.dropped]), [[1, 1, 186.82, false], [0, 2, 187.67, false]]);
  assert.equal(decodeResult('not base64 at all!'), null);
  assert.equal(decodeResult(Buffer.from([2, 1, 0, 0, 0, 0, 0, 0]).toString('base64')), null, 'another version');
  assert.equal(decodeResult(Buffer.from([3, 2, 0, 0, 0, 0, 0, 0, 1, 1]).toString('base64')), null, 'cut short');
  const dropped = Buffer.alloc(8 + 55 * 2); dropped[0] = 3; dropped[1] = 2;
  dropped[8] = 0; dropped[9] = 1; dropped.writeFloatBE(90, 16);
  dropped[8 + 2] = 1; dropped[63] = 1; dropped[64] = 2; dropped[65] = 0x0c; dropped.writeFloatBE(-1, 63 + 32);
  assert.deepEqual(decodeResult(dropped.toString('base64')).players.map(p => p.dropped), [false, true]);
  dropped[65] = 1; dropped.writeFloatBE(0, 63 + 32); dropped.writeFloatBE(-1, 63 + 44);
  assert.deepEqual(decodeResult(dropped.toString('base64')).players.map(p => p.dropped), [false, true]);
});
