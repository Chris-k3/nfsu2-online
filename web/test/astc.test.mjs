// DXT1 rewritten as ASTC 4x4 (web/src/gpu/astc.ts), without a GPU:
//   node --test web/test/astc.test.mjs
// A decoder of the few ASTC blocks astc.ts writes (from the Khronos spec: block modes 0x042, 0x051, 0x451, endpoint
// modes 8 and 12) reads them back, and every texel is compared with the CPU's unpacking (dxt.ts) within what the
// rewriting allows.  The GPU check (web/tools/astc-check.mjs, Chrome and WebKit) gave the same figures on an Apple
// GPU: four colours at most 2 of 255 off, three colours 1, two-plane blocks 1 and their alpha exact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entry = `export { unpackDxt } from './web/src/gpu/dxt.ts'; export { dxt1ToAstc, dxt1HasPunch } from './web/src/gpu/astc.ts';`;
const js = (await esbuild.build({ stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' }, bundle: true, format: 'esm', write: false, platform: 'neutral' })).outputFiles[0].text;
const { unpackDxt, dxt1ToAstc, dxt1HasPunch } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const DXT1 = 0x31545844;

/** one ASTC block (16 bytes) as 16 RGBA texels, or a string saying what it is not */
function decode(b) {
  const bit = i => (b[i >> 3] >> (i & 7)) & 1;
  const bits = (pos, n) => { let v = 0; for (let i = 0; i < n; i++) v |= bit(pos + i) << i; return v; };
  const mode = bits(0, 11), dual = (mode & 0x400) !== 0, base = mode & 0x3FF;
  if (base !== 0x042 && base !== 0x051) return `block mode ${mode.toString(16)}`;
  if (bits(11, 2) !== 0) return 'more than one partition';
  const trits = base === 0x051, nw = dual ? 32 : 16, wbits = trits ? Math.ceil(nw * 8 / 5) : nw * 2;
  // the weights: bit i of their sequence at bit 127 - i
  const wbit = i => bit(127 - i), wread = (pos, n) => { let v = 0; for (let i = 0; i < n; i++) v |= wbit(pos + i) << i; return v; };
  const w = [];
  if (!trits) for (let i = 0; i < nw; i++) w.push([0, 21, 43, 64][wread(2 * i, 2)]);
  else {
    for (let g = 0, pos = 0; g < nw; g += 5) {
      const n = Math.min(5, nw - g), len = [0, 2, 4, 5, 7, 8][n], T = wread(pos, len); pos += len;
      const t = (x, i, k = 1) => (x >> i) & ((1 << k) - 1);
      let C, t3, t4;
      if (t(T, 2, 3) === 7) { C = t(T, 5, 3) << 2 | t(T, 0, 2); t4 = 2; t3 = 2; }
      else { C = t(T, 0, 5); if (t(T, 5, 2) === 3) { t4 = 2; t3 = t(T, 7); } else { t4 = t(T, 7); t3 = t(T, 5, 2); } }
      let t0, t1, t2;
      if (t(C, 0, 2) === 3) { t2 = 2; t1 = t(C, 4); t0 = t(C, 3) << 1 | (t(C, 2) & ~t(C, 3) & 1); }
      else if (t(C, 2, 2) === 3) { t2 = 2; t1 = 2; t0 = t(C, 0, 2); }
      else { t2 = t(C, 4); t1 = t(C, 2, 2); t0 = t(C, 1) << 1 | (t(C, 0) & ~t(C, 1) & 1); }
      w.push(...[t0, t1, t2, t3, t4].slice(0, n).map(x => [0, 32, 64][x]));
    }
  }
  const cem = bits(13, 4);
  let e0, e1;
  if (cem === 8 && !dual) {
    const v = Array.from({ length: 6 }, (_, i) => bits(17 + 8 * i, 8));
    if (v[1] + v[3] + v[5] < v[0] + v[2] + v[4]) return 'blue contraction';
    e0 = [v[0], v[2], v[4], 255]; e1 = [v[1], v[3], v[5], 255];
  } else if (cem === 12 && dual) {
    const v = Array.from({ length: 8 }, (_, i) => { const q = bits(17 + 7 * i, 7); return q << 1 | q >> 6; });
    if (v[1] + v[3] + v[5] < v[0] + v[2] + v[4]) return 'blue contraction';
    e0 = [v[0], v[2], v[4], v[6]]; e1 = [v[1], v[3], v[5], v[7]];
  } else return `endpoint mode ${cem}${dual ? ' with two planes' : ''}`;
  const ccs = dual ? bits(128 - wbits - 2, 2) : -1;
  const out = [];
  for (let i = 0; i < 16; i++) {
    const px = [0, 1, 2, 3].map(c => {
      const wt = dual ? w[2 * i + (c === ccs ? 1 : 0)] : w[i];
      const C = Math.floor((e0[c] * 257 * (64 - wt) + e1[c] * 257 * wt + 32) / 64);
      return Math.round(C / 65535 * 255);
    });
    out.push(px);
  }
  return out;
}

const block = (c0, c1, idx) => new Uint8Array([c0 & 255, c0 >> 8, c1 & 255, c1 >> 8, idx & 255, (idx >> 8) & 255, (idx >> 16) & 255, idx >>> 24]);
/** the largest colour difference between the rewritten block and the unpacked one, and whether the alphas match */
function compare(src) {
  const a = dxt1ToAstc(src, 0, 8, 1, 1), got = decode(a);
  if (typeof got === 'string') return { error: got };
  const u = unpackDxt(DXT1, src, 0, 8, 4, 4);
  let max = 0, alpha = true;
  for (let i = 0; i < 16; i++) {
    const want = [u[4 * i + 2], u[4 * i + 1], u[4 * i], u[4 * i + 3]];
    if (got[i][3] !== want[3]) alpha = false;
    if (want[3]) max = Math.max(max, ...[0, 1, 2].map(c => Math.abs(got[i][c] - want[c])));
  }
  return { max, alpha };
}

test('four colours: the endpoints exact, the thirds within 2', () => {
  // c0 = F800 (red), c1 = 001F (blue); first row codes 0 1 2 3
  const src = block(0xF800, 0x001F, 0xE4);
  const a = decode(dxt1ToAstc(src, 0, 8, 1, 1));
  assert.deepEqual(a[0], [255, 0, 0, 255]);
  assert.deepEqual(a[1], [0, 0, 255, 255]);
  assert.deepEqual(a.slice(2, 4), [[171, 0, 84, 255], [84, 0, 171, 255]]);   // BC1: 170/85
  assert.deepEqual(compare(src), { max: 1, alpha: true });
});

test('the endpoints swapped when the second is darker (no blue contraction)', () => {
  // c0 = FFFF (white) > c1 = 0000 (black): the decoder would contract a white second endpoint's blue
  assert.deepEqual(compare(block(0xFFFF, 0x0000, 0x1B)), { max: 1, alpha: true });
});

test('three colours without a hole: the midpoint exact', () => {
  const src = block(0x001F, 0xF800, 0x24);           // c0 < c1, codes 0 1 2 0 ...
  const a = decode(dxt1ToAstc(src, 0, 8, 1, 1));
  assert.deepEqual(a.slice(0, 3), [[0, 0, 255, 255], [255, 0, 0, 255], [128, 0, 128, 255]]);   // BC1: 127/127, rounded
  assert.equal(compare(src).alpha, true);
});

test('a transparent texel: two planes, alpha exact', () => {
  const src = block(0x001F, 0xF800, 0xE4);           // c0 < c1 and code 3 in the first row
  assert.equal(dxt1HasPunch(src, 0, 8, 1, 1), true);
  const punch = { blocks: 0 };
  const a = decode(dxt1ToAstc(src, 0, 8, 1, 1, undefined, punch));
  assert.equal(punch.blocks, 1);
  assert.equal(a[3][3], 0);
  assert.deepEqual(compare(src), { max: 1, alpha: true });
});

test('dxt1HasPunch: only code 3 in a three-colour block', () => {
  assert.equal(dxt1HasPunch(block(0xF800, 0x001F, 0xFFFFFFFF), 0, 8, 1, 1), false);   // four colours: code 3 is a colour
  assert.equal(dxt1HasPunch(block(0x001F, 0xF800, 0xAAAAAAAA), 0, 8, 1, 1), false);   // three colours, codes 2 only
  assert.equal(dxt1HasPunch(block(0x1234, 0x1234, 0xC0000000), 0, 8, 1, 1), true);    // one colour, code 3 at the last texel
  // a level of 2x2 blocks, pitch 24: the hole in the last block
  const lv = new Uint8Array(48);
  lv.set(block(0xF800, 0x001F, 0), 0); lv.set(block(0xF800, 0x001F, 0), 8);
  lv.set(block(0xF800, 0x001F, 0), 24); lv.set(block(0x001F, 0xF800, 3), 32);
  assert.equal(dxt1HasPunch(lv, 0, 24, 2, 2), true);
  assert.equal(dxt1HasPunch(lv, 0, 24, 2, 1), false);
});

test('random blocks of every kind, within the limits', () => {
  let seed = 7;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8;
  const worst = { four: 0, three: 0, holes: 0 };
  for (let i = 0; i < 20000; i++) {
    let c0 = rnd() & 0xFFFF, c1 = i % 5 === 4 ? c0 : rnd() & 0xFFFF;
    if (i % 7 === 0) c0 = [0, 0xFFFF, 0xF800, 0x07E0, 0x001F][rnd() % 5];
    const idx = (rnd() << 8 ^ rnd()) >>> 0, src = block(c0, c1, idx);
    const r = compare(src);
    assert.ok(!r.error, `block ${i}: ${r.error}`);
    assert.ok(r.alpha, `block ${i}: alpha`);
    const k = c0 > c1 ? 'four' : dxt1HasPunch(src, 0, 8, 1, 1) ? 'holes' : 'three';
    worst[k] = Math.max(worst[k], r.max);
  }
  assert.ok(worst.four <= 2 && worst.three <= 1 && worst.holes <= 1, JSON.stringify(worst));
});

test('the layout: blocks in rows of a wider pitch, an offset, into a buffer kept', () => {
  // 3x2 blocks at offset 5, pitch 30 (6 bytes past the blocks in each row)
  const src = new Uint8Array(5 + 60);
  for (let i = 0; i < 6; i++) src.set(block(0xF800 - i, 0x001F + i, 0x1B * i), 5 + Math.floor(i / 3) * 30 + (i % 3) * 8);
  const buf = new Uint8Array(200), out = dxt1ToAstc(src, 5, 30, 3, 2, buf);
  assert.equal(out.buffer, buf.buffer);
  assert.equal(out.length, 96);
  for (let i = 0; i < 6; i++) {
    const one = dxt1ToAstc(block(0xF800 - i, 0x001F + i, 0x1B * i), 0, 8, 1, 1);
    assert.deepEqual(Array.from(out.subarray(i * 16, i * 16 + 16)), Array.from(one));
  }
  assert.notEqual(dxt1ToAstc(src, 5, 30, 3, 2, new Uint8Array(16)).buffer.byteLength, 16);
});
