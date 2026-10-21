// The saves panel's restore limits (web/src/app/saves-ui.ts readBackup) on a
// backup bigger than the restore budget: 24 F12 screenshots at this Mac's
// native size (3024x1964 TGA, 23.8 MB each, 570 MB in all) listed before the
// profile, registry.txt and settings.ini (phase-1 app review, finding 5).
//   node --test web/test/restore-limit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entry = `export { readBackup, isScreenshot } from './web/src/app/saves-ui.ts'; export { zip, unzip } from './web/src/app/zip.ts';
  export { checksum } from './web/src/app/profile.ts';`;
const js = (await esbuild.build({ stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral' })).outputFiles[0].text;
const { readBackup, isScreenshot, zip, checksum } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const SHOT = 18 + 3024 * 1964 * 4;                       // a 32-bit TGA at 3024x1964
const enc = new TextEncoder();
/** a profile file the game would load (profile.ts checks: header, checksums, version, the name inside), all else zero */
function profile(name) {
  const f = new Uint8Array(54966), v = new DataView(f.buffer);
  f.set(enc.encode('20CM')); v.setUint32(4, 54966, true); v.setUint32(8, 8, true); v.setUint32(12, 54930, true);
  v.setUint32(28, 0x10D, true); v.setUint32(32, 54930, true); f.set(enc.encode(name), 36 + 53761);
  v.setUint32(16, checksum(f.subarray(28, 36)), true); v.setUint32(20, checksum(f.subarray(36)), true); v.setUint32(24, checksum(f.subarray(0, 24)), true);
  return f;
}
function backup(nShots) {
  const e = [];
  const shot = new Uint8Array(SHOT); shot[2] = 2;
  for (let i = 0; i < nShots; i++) e.push({ name: `nfsu2${String(i).padStart(3, '0')}.tga`, data: shot });
  e.push({ name: 'NFS Underground 2/ROTEST/ROTEST', data: profile('ROTEST') });
  e.push({ name: 'registry.txt', data: enc.encode('NotFirstTime=1\n') });
  e.push({ name: 'settings.ini', data: enc.encode('# NFSU2 settings\nmovies = off\n') });
  return zip(e);
}

test('screenshots never crowd out the profile, registry.txt or settings.ini', async () => {
  const z = backup(24);
  assert.ok(z.length > 512 * 1048576, `backup ${z.length} bytes`);
  const r = await readBackup(z);
  const paths = r.entries.map(e => e.path);
  for (const p of ['NFS Underground 2/ROTEST/ROTEST', 'registry.txt', 'settings.ini']) assert.ok(paths.includes(p), `${p} kept`);
  assert.deepEqual(r.profiles, ['ROTEST']);
  const shots = paths.filter(isScreenshot);
  assert.equal(shots.length, 22, 'the first 512 MiB of screenshots');
  assert.deepEqual(r.skipped, ['nfsu2022.tga', 'nfsu2023.tga']);
  console.log(`backup ${(z.length / 1048576).toFixed(0)} MB, ${r.entries.length} entries kept, skipped ${r.skipped.join(', ')}`);
});

test('a backup within the budget restores whole', async () => {
  const r = await readBackup(backup(3));
  assert.equal(r.entries.length, 6);
  assert.deepEqual(r.skipped, []);
});
