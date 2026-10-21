// Profiles from the PC game through Restore a backup (web/src/app/saves-ui.ts
// readBackup, addProfiles; profile.ts profileName, modCars):
//   node --test web/test/pcsave.test.mjs
// - a zip of the PC's NFS Underground 2 folder, in any shape (the folder, its
//   profile folders, deeper), or one profile's own file: each profile goes to
//   "NFS Underground 2/<the name inside>/", its cover shoots beside it, other files are left out
// - a zip with registry.txt or settings.ini at its top is a backup of the page's and
//   replaces everything, as before; a cover shoot is no profile in its list
// - a profile the game would not load (checksums, version, a name its field does not
//   make) is left out with why, its cover shoots too; one with cars a mod added
//   (a car type the game's 31 player cars do not have) comes in with a warning
// - adding: a profile of the same name here (in any case) goes with its cover shoots,
//   the other profiles and files stay, and its autosave-profiles.txt line goes
// The profiles here are synthetic: the car records' layout of profile.ts, all else zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entry = `export * as P from './web/src/app/profile.ts'; export { readBackup, addProfiles } from './web/src/app/saves-ui.ts';
  export { zip } from './web/src/app/zip.ts';`;
const js = (await esbuild.build({ stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral' })).outputFiles[0].text;
const { P, readBackup, addProfiles, zip } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const DIR = 'NFS Underground 2', B = 36;
const enc = new TextEncoder();
const at = n => `${DIR}/${n}/${n}`;

function seal(f) {
  f.writeUInt32LE(P.checksum(f.subarray(28, 36)), 16); f.writeUInt32LE(P.checksum(f.subarray(36)), 20); f.writeUInt32LE(P.checksum(f.subarray(0, 24)), 24);
  return new Uint8Array(f.buffer, f.byteOffset, f.length);
}
/**
 * A profile as the game writes one, as far as the page reads it: the 31 stock cars, a
 * career car (type name or hash), the 6 preset cars, the name inside.
 */
function profile(name, { career = ['240SX'], stock = 31, custom = [], inside = name, version = 0x10D } = {}) {
  const f = Buffer.alloc(54966);
  f.write('20CM', 0, 'latin1');
  f.writeUInt32LE(54966, 4); f.writeUInt32LE(8, 8); f.writeUInt32LE(54930, 12);
  f.writeUInt32LE(version, 28); f.writeUInt32LE(54930, 32);
  const type = c => typeof c === 'number' ? c : P.bStringHash(c);
  for (let i = 0; i < 48; i++) f.writeUInt32LE(i < stock ? i : 0xFFFFFFFF, B + i * 24 + 20);
  f.writeUInt32LE(stock, B + 1152);
  for (let i = 0; i < 20; i++) f.writeUInt32LE(2, B + 1156 + i * 1072 + 16);
  custom.forEach((c, i) => f.writeUInt32LE(type(c), B + 1156 + i * 1072 + 28));
  career.forEach((c, i) => f.writeUInt32LE(type(c), B + 22596 + i * 2034 + 28));
  ['MIATA', 'FOCUS', '240SX', 'COROLLA', 'PEUGOT', 'FOCUS'].forEach((c, i) => f.writeUInt32LE(type(c), B + 32770 + i * 1076 + 28));
  f.write(inside, B + 53761, 'latin1');
  return seal(f);
}
/** a cover shoot's file: the same container, 1,048,612 bytes */
const cover = n => { const d = new Uint8Array(1048612); d.set(enc.encode('20CM')); d[40] = n.length; return d; };
const z = files => zip(Object.entries(files).map(([name, data]) => ({ name, data: typeof data === 'string' ? enc.encode(data) : data })));
const sorted = a => [...a].sort();
const paths = r => sorted(r.entries.map(e => e.path));

test('bStringHash gives the car type hashes the game data holds (CarTypeInfo +0xd0)', () => {
  assert.equal(P.bStringHash('PEUGOT'), 0x72b2e513);
  assert.equal(P.bStringHash('240SX'), 0x0150fb80);
  assert.equal(P.bStringHash('IMPREZAWRX'), 0xcf4458f8);
  assert.equal(P.bStringHash('TAXI'), 0x001d1775);
});

test('modCars: none among the game\'s own cars; a car type past them, by index or by hash', () => {
  assert.equal(P.modCars(profile('A')), 0);
  assert.equal(P.modCars(profile('A', { career: [] })), 0, 'no career car yet');
  assert.equal(P.modCars(profile('A', { career: ['240SX', 'SKYLINE', 'RX8'], custom: ['GOLF'] })), 0);
  assert.equal(P.modCars(profile('A', { career: ['240SX', 0x1badcafe] })), 1, 'a career car of an unknown type');
  assert.equal(P.modCars(profile('A', { custom: [0xdeadbeef, 'MIATA'] })), 1, 'a customized one');
  assert.equal(P.modCars(profile('A', { career: ['TAXI'] })), 1, 'a traffic car is no player car');
  assert.equal(P.modCars(profile('A', { stock: 33 })), 2, 'two car types past the stock list');
});

test('profileName: the checks of a profile from elsewhere, and why one is refused', () => {
  assert.deepEqual(P.profileName(profile('Zelshia')), { name: 'Zelshia' });
  const edited = Buffer.from(profile('Zelshia')); edited[0xA16A] ^= 0x40;      // a save editor's money change
  assert.match(P.profileName(edited).bad, /checksums/);
  assert.match(P.profileName(profile('Zelshia', { version: 0x10C })).bad, /another version/);
  assert.match(P.profileName(profile('X', { inside: 'TOOLONGNAME' })).bad, /not one the game makes/);
  assert.match(P.profileName(profile('X', { inside: 'a b' })).bad, /not one the game makes/);
  assert.match(P.profileName(profile('Zelshia').subarray(0, 54000)).bad, /54000 bytes/);
});

test('a PC save\'s profiles are found wherever the zip has them', async () => {
  const folder = await readBackup(z({
    [at('Zelshia')]: profile('Zelshia'), [at('Zelshia DVD 1')]: cover('a'), [at('Zelshia Magazine 1')]: cover('b'),
    [at('MEH')]: profile('MEH'), [`${DIR}/desktop.ini`]: '[.ShellClassInfo]\n',
  }));
  assert.equal(folder.kind, 'profiles');
  assert.deepEqual(sorted(folder.profiles), ['MEH', 'Zelshia']);
  assert.deepEqual(paths(folder), sorted([at('MEH'), at('Zelshia'), at('Zelshia DVD 1'), at('Zelshia Magazine 1')]));
  assert.deepEqual(folder.skipped, [`${DIR}/desktop.ini`]);
  assert.deepEqual([folder.refused, folder.modded], [[], []]);

  const one = await readBackup(z({ 'Zelshia/Zelshia': profile('Zelshia') }));
  assert.deepEqual([one.kind, paths(one)], ['profiles', [at('Zelshia')]], 'one profile folder, zipped');
  const two = await readBackup(z({ 'A1/A1': profile('A1'), 'B2/B2': profile('B2'), 'B2 DVD 3/B2 DVD 3': cover('c') }));
  assert.deepEqual(paths(two), sorted([at('A1'), at('B2'), at('B2 DVD 3')]), 'profile folders at the top');
  const deep = await readBackup(z({ 'backup/AppData/Local/NFS Underground 2/A1/A1': profile('A1') }));
  assert.deepEqual(paths(deep), sorted([at('A1')]));
  const cased = await readBackup(z({ 'zelshia/zelshia': profile('Zelshia'), 'zelshia DVD 1/zelshia DVD 1': cover('d') }));
  assert.deepEqual(paths(cased), sorted([at('Zelshia'), at('Zelshia DVD 1')]), 'named as inside, covers too');
  const orphan = await readBackup(z({ 'A1/A1': profile('A1'), 'OTHER DVD 1/OTHER DVD 1': cover('e') }));
  assert.deepEqual([paths(orphan), orphan.skipped], [[at('A1')], ['OTHER DVD 1/OTHER DVD 1']], 'a cover shoot without its profile');

  const file = await readBackup(profile('Zelshia'), 'Zelshia (1)');
  assert.deepEqual([file.kind, paths(file), file.profiles], ['profiles', [at('Zelshia')], ['Zelshia']], 'a profile\'s own file');
  const lone = await readBackup(cover('x'), 'Zelshia DVD 1');
  assert.deepEqual([lone.profiles, lone.refused, lone.skipped], [[], [], ['Zelshia DVD 1']], 'a cover shoot alone: no profile, nothing refused');
  const bad = Buffer.from(profile('Zelshia')); bad[5000] ^= 1;
  const badFile = await readBackup(new Uint8Array(bad), 'Zelshia');
  assert.deepEqual([badFile.profiles, badFile.refused.map(x => x.name)], [[], ['Zelshia']]);
  await assert.rejects(readBackup(enc.encode('just some text'), 'notes.txt'), /not a zip/);
});

test('a profile the game would not load is left out with why, its covers too; a mod\'s cars warn', async () => {
  const edited = Buffer.from(profile('EDIT')); edited[0xA16A] ^= 0x40;
  const r = await readBackup(z({
    [at('EDIT')]: new Uint8Array(edited), [at('EDIT DVD 1')]: cover('f'),
    [at('OLDV')]: profile('OLDV', { version: 0x10C }), [at('MOD')]: profile('MOD', { career: ['240SX', 0x5ec0ffee] }),
    [at('OK')]: profile('OK'),
  }));
  assert.deepEqual(sorted(r.profiles), ['MOD', 'OK']);
  assert.deepEqual(r.modded, ['MOD']);
  assert.deepEqual(Object.fromEntries(r.refused.map(x => [x.name, x.why])), {
    EDIT: 'its checksums do not match (edited outside the game?)', OLDV: 'saved by another version of the game (version 268, not 269)' });
  assert.deepEqual(paths(r), sorted([at('MOD'), at('OK')]));
  assert.deepEqual(r.skipped, [at('EDIT DVD 1')]);
  const none = await readBackup(z({ [at('EDIT')]: new Uint8Array(edited) }));
  assert.deepEqual([none.kind, none.entries, none.refused.length], ['profiles', [], 1]);
});

test('a backup of the page\'s restores in place, without a profile the game would not load', async () => {
  const edited = Buffer.from(profile('BAD')); edited[9000] ^= 2;
  const r = await readBackup(z({
    'registry.txt': 'NotFirstTime=1\n', 'settings.ini': 'movies = off\n', 'nfsu2000.tga': new Uint8Array(40), 'autosave-profiles.txt': 'frik\n',
    [at('frik')]: profile('frik'), [at('frik DVD 1')]: cover('g'),
    [at('BAD')]: new Uint8Array(edited), [at('BAD Magazine 1')]: cover('h'), [at('MOD')]: profile('MOD', { custom: [0x12345678] }),
  }));
  assert.equal(r.kind, 'backup');
  assert.deepEqual(sorted(r.profiles), ['MOD', 'frik'], 'a cover shoot is no profile');
  assert.deepEqual(r.modded, ['MOD']);
  assert.deepEqual(r.refused.map(x => x.name), ['BAD']);
  assert.deepEqual(paths(r), sorted([at('MOD'), at('frik'), at('frik DVD 1'), 'autosave-profiles.txt', 'nfsu2000.tga', 'registry.txt', 'settings.ini']));
  const inside = await readBackup(z({ 'registry.txt': 'x', [at('NAMEA')]: profile('NAMEB') }));
  assert.deepEqual([inside.profiles, inside.refused], [[], [{ name: 'NAMEA', why: 'the name inside is "NAMEB"' }]]);
});

/** the save folder in memory, as savefs.ts filesOf gives it */
function folder(files) {
  const m = new Map(Object.entries(files));
  const writes = [];
  return {
    m, writes,
    listFiles: async () => [...m.keys()].sort().map(p => ({ path: p })),
    readBytes: async p => { if (!m.has(p)) throw new Error(`no ${p}`); const v = m.get(p); return typeof v === 'string' ? enc.encode(v) : v; },
    readText: async p => { const v = m.get(p); return v === undefined ? null : typeof v === 'string' ? v : new TextDecoder().decode(v); },
    writeFile: async (p, d) => { writes.push(p); m.set(p, d); },
    remove: async p => { writes.push(`-${p}`); for (const k of [...m.keys()]) if (k === p || k.startsWith(p + '/')) m.delete(k); },
  };
}

test('adding: a profile of the same name goes with its covers (in any case), all else stays', async () => {
  const thom = profile('THOM'), seen = '# the page\'s notes\nzelshia\nTHOM\n';
  const fs = folder({
    [at('zelshia')]: profile('zelshia'), [at('zelshia DVD 1')]: cover('old1'), [at('zelshia DVD 2')]: cover('old2'),
    [at('THOM')]: thom, [at('THOM DVD 1')]: cover('t'), 'registry.txt': 'NotFirstTime=1\n', 'settings.ini': 'movies = off\n',
    [P.AUTOSAVE_SEEN]: seen,
  });
  const zel = profile('Zelshia'), c1 = cover('new1');
  const r = await readBackup(z({ 'Zelshia/Zelshia': zel, 'Zelshia DVD 1/Zelshia DVD 1': c1, 'MEH/MEH': profile('MEH') }));
  await addProfiles(fs, r);
  assert.deepEqual(sorted(fs.m.keys()), sorted([at('MEH'), at('THOM'), at('THOM DVD 1'), at('Zelshia'), at('Zelshia DVD 1'),
    P.AUTOSAVE_SEEN, 'registry.txt', 'settings.ini']));
  assert.deepEqual([...fs.m.get(at('Zelshia'))], [...zel]);
  assert.deepEqual([...fs.m.get(at('Zelshia DVD 1'))], [...c1]);
  assert.equal(fs.m.get(at('THOM')), thom);
  assert.equal(fs.m.get('settings.ini'), 'movies = off\n');
  assert.equal(fs.m.get(P.AUTOSAVE_SEEN), '# the page\'s notes\nTHOM\n', 'Autosave comes to it as to a new profile');
  assert.equal(fs.writes.findIndex(w => w.startsWith('-')), r.entries.length, `the new folders are written before the old ones go: ${fs.writes.join(', ')}`);
  assert.deepEqual(fs.writes.slice(r.entries.length), [`-${DIR}/zelshia DVD 1`, `-${DIR}/zelshia DVD 2`, `-${DIR}/zelshia`, P.AUTOSAVE_SEEN]);

  // the same name exactly: the file is written over, an old cover shoot of it goes
  const fs2 = folder({ [at('MEH')]: profile('MEH', { career: ['RX7'] }), [at('MEH Magazine 2')]: cover('m') });
  const meh = profile('MEH');
  await addProfiles(fs2, await readBackup(meh, 'MEH'));
  assert.deepEqual([...fs2.m.keys()], [at('MEH')]);
  assert.deepEqual([...fs2.m.get(at('MEH'))], [...meh]);
  assert.deepEqual(fs2.writes, [at('MEH'), `-${DIR}/MEH Magazine 2`]);
});
