// The log of a game the page did not get to end (web/src/app/lastgame.ts): kept in localStorage while it runs, offered
// by the next page unless the game ended as games end.
//   node --test web/test/lastgame.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bundle = async f => import('data:text/javascript;base64,' + Buffer.from((await esbuild.build({ entryPoints: [path.join(ROOT, f)], bundle: true, format: 'esm', write: false })).outputFiles[0].text).toString('base64'));
const { LastGameKeeper, lastGameToOffer, lastGameLine, lastGameEnd } = await bundle('web/src/app/lastgame.ts');
const { LogRing } = await bundle('web/src/app/logs.ts');

const store = new Map();
let full = false;
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => { if (full) throw new Error('QuotaExceededError'); store.set(k, String(v)); } };
globalThis.document = { hidden: false };
beforeEach(() => { store.clear(); full = false; document.hidden = false; });

function game(held) {
  const log = new LogRing(1 << 20, false), notes = [];
  log.keep('=== NFSU2 web, a game ==='); log.add('[4!] [status] f=3600 t=60.0s fps=60.0');
  const k = new LastGameKeeper('save', log, s => notes.push(s));
  k.start('abc1234', held);
  return { log, k, notes };
}

test('each copy notes what the game held then, and the line says it', () => {
  let held = 'textures 230 MB (201 unpacked from DXT)';
  const { k } = game(() => held);
  clearInterval(k.timer);
  assert.match(lastGameLine(lastGameToOffer('save')), /\) ended without the page closing it, .*; at that copy it held textures 230 MB \(201 unpacked from DXT\); its log is at the start of this file$/);
  held = "textures 412 MB (380 unpacked from DXT), 19 friends' cars in the game, 34 friends connected";
  k.hidden(true);
  assert.match(lastGameLine(lastGameToOffer('save')), /at that copy it held textures 412 MB \(380 unpacked from DXT\), 19 friends' cars in the game, 34 friends connected;/);
});

test('nothing known, a held() that throws, and an older copy without it: the line as before', () => {
  for (const held of [undefined, () => '', () => { throw new Error('renderer gone'); }]) {
    store.clear();
    const { k } = game(held);
    clearInterval(k.timer);
    const r = lastGameToOffer('save');
    assert.doesNotMatch(lastGameLine(r), /it held/);
    delete r.held;
    assert.match(lastGameLine(r), /the page on screen at its last copy: [^;]*; its log is at the start of this file$/);
  }
});

test('a game the page did not end is offered, with its log as it was last copied', () => {
  const { log, k } = game();
  log.add('[gpu] the last line before Safari stopped the page');
  k.hidden(true);                                   // a hidden page writes at once
  const r = lastGameToOffer('save');
  assert.ok(r);
  assert.equal(r.rev, 'abc1234'); assert.equal(r.ended, null); assert.equal(r.hidden, true);
  assert.match(r.log, /the last line before Safari stopped the page/);
  assert.match(lastGameLine(r), /^\[app\] the last game \(game abc1234, started \d\d:\d\d:\d\d, last copy \d\d:\d\d:\d\d, [\d.]+ min in\) ended without the page closing it, the page hidden/);
  assert.equal(lastGameEnd(r), 'stopped');
  clearInterval(k.timer);
});

test('a normal close and a Stop are not offered; a stop for a reason, a crash and a closed page are', () => {
  for (const [code, why, offered] of [[0, 'exit', false], [-1, 'exit', false], [-1, 'GPU-LOST', true], [134, 'exit', true], [-2, 'page closed', true]]) {
    store.clear();
    const { k } = game();
    k.end(code, why);
    assert.equal(!!lastGameToOffer('save'), offered, `${code} ${why}`);
    if (!offered) continue;
    assert.match(lastGameLine(lastGameToOffer('save')), why === 'page closed' ? /was running when the page was closed or reloaded/ : /stopped \(/);
    // the start page: a reload or a closed tab is the player's own, not an error
    assert.equal(lastGameEnd(lastGameToOffer('save')), why === 'page closed' ? 'left' : 'error', `${code} ${why}`);
  }
});

test('another save folder has its own, and nothing kept is nothing offered', () => {
  const { k } = game();
  assert.equal(lastGameToOffer('other'), null);
  store.set('nfsu2.lastgame.save', '{not json');
  assert.equal(lastGameToOffer('save'), null);
  clearInterval(k.timer);
});

test('full or blocked storage: said once in the log, the game goes on', () => {
  full = true;
  const { k, notes } = game();
  k.hidden(true); k.hidden(false);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /could not be kept/);
  clearInterval(k.timer);
});
