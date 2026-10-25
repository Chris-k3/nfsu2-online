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
const { LastGameKeeper, lastGameToOffer, lastGameLine } = await bundle('web/src/app/lastgame.ts');
const { LogRing } = await bundle('web/src/app/logs.ts');

const store = new Map();
let full = false;
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => { if (full) throw new Error('QuotaExceededError'); store.set(k, String(v)); } };
globalThis.document = { hidden: false };
beforeEach(() => { store.clear(); full = false; document.hidden = false; });

function game() {
  const log = new LogRing(1 << 20, false), notes = [];
  log.keep('=== NFSU2 web, a game ==='); log.add('[4!] [status] f=3600 t=60.0s fps=60.0');
  const k = new LastGameKeeper('save', log, s => notes.push(s));
  k.start('abc1234');
  return { log, k, notes };
}

test('a game the page did not end is offered, with its log as it was last copied', () => {
  const { log, k } = game();
  log.add('[gpu] the last line before Safari stopped the page');
  k.hidden(true);                                   // a hidden page writes at once
  const r = lastGameToOffer('save');
  assert.ok(r);
  assert.equal(r.rev, 'abc1234'); assert.equal(r.ended, null); assert.equal(r.hidden, true);
  assert.match(r.log, /the last line before Safari stopped the page/);
  assert.match(lastGameLine(r), /^\[app\] the last game \(game abc1234, started \d\d:\d\d:\d\d, last copy \d\d:\d\d:\d\d, [\d.]+ min in\) ended without the page closing it, the page hidden/);
  clearInterval(k.timer);
});

test('a normal close and a Stop are not offered; a stop for a reason, a crash and a closed page are', () => {
  for (const [code, why, offered] of [[0, 'exit', false], [-1, 'exit', false], [-1, 'GPU-LOST', true], [134, 'exit', true], [-2, 'page closed', true]]) {
    store.clear();
    const { k } = game();
    k.end(code, why);
    assert.equal(!!lastGameToOffer('save'), offered, `${code} ${why}`);
    if (offered) assert.match(lastGameLine(lastGameToOffer('save')), why === 'page closed' ? /was running when the page was closed or reloaded/ : /stopped \(/);
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
