// The server's /data-blocks/ (runs of 1 MiB blocks of a game file, compressed) against a made-up game folder,
// so it runs anywhere:
//   node --test web/test/data-blocks.test.mjs
// The manifest names it; every encoding gives back the file's exact bytes; a run that does not compress goes
// as it is (judged per run); requests out of bounds, outside the game's files or past the end are refused; a client holding all
// its compressors gets the rest as they are (never refused, never queued), and gets them back when it lets go.
// Port: NFSU2_TEST_BLOCKS_PORT (8532).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pickEncoding } from '../server/headers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.NFSU2_TEST_BLOCKS_PORT || 8532);
const M = 1 << 20;
const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'nfsu2-blocks-test-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// random bytes (AES-CTR over zeros), or bytes of 2 bits each that compress to about a quarter
const bytes = (size, seed, packs) => {
  const b = crypto.createCipheriv('aes-128-ctr', crypto.createHash('sha256').update(seed).digest().subarray(0, 16), Buffer.alloc(16)).update(Buffer.alloc(size));
  if (packs) for (let i = 0; i < size; i++) b[i] = (b[i] & 3) * 0x41;
  return b;
};
const DATA = path.join(TMP, 'game');
const FILES = { 'SPEED2.EXE': bytes(3 * M + 17, 'exe', false), 'TRACKS/L4RA.BUN': bytes(8 * M + 5, 'track', true),
  'MOVIES/INTRO.VP6': bytes(2 * M, 'movie', false),
  // a first block that does not compress before two that do (as the game's music): judged per run
  'PFDATA/MIX.MUS': Buffer.concat([bytes(M, 'mix0', false), bytes(2 * M, 'mix1', true)]) };
for (const [p, b] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(DATA, p)), { recursive: true }); fs.writeFileSync(path.join(DATA, p), b); }
fs.writeFileSync(path.join(DATA, 'NOTES.TXT'), 'not the game');
fs.writeFileSync(path.join(TMP, 'game.wasm'), Buffer.alloc(8));

async function server() {
  const st = path.join(TMP, 'state');
  const srv = spawn(process.execPath, [path.join(HERE, '../server/server.mjs'), '--data', DATA, '--http-port', String(PORT), '--state', st,
    '--wasm', path.join(TMP, 'game.wasm')], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    let out = '';
    const t = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000);
    srv.stdout.on('data', d => { out += d; if (out.includes('  access    :')) { clearTimeout(t); res(); } });
    srv.on('exit', c => { clearTimeout(t); rej(new Error('server exited ' + c + ' ' + out)); });
  });
  return { stop: async () => { const gone = srv.exitCode !== null ? null : new Promise(r => srv.once('exit', r)); srv.kill(); await gone; } };
}
/** an answer, its body as it came over the wire, and that body decoded */
function get(p, { ae = 'gzip, deflate, br, zstd', method = 'GET' } = {}) {
  return new Promise((res, rej) => {
    const q = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { host: `localhost:${PORT}`, 'accept-encoding': ae } }, r => {
      const c = []; r.on('data', d => c.push(d));
      r.on('end', () => {
        const wire = Buffer.concat(c), enc = r.headers['content-encoding'];
        const body = enc === 'zstd' ? zlib.zstdDecompressSync(wire) : enc === 'br' ? zlib.brotliDecompressSync(wire) : enc === 'gzip' ? zlib.gunzipSync(wire) : wire;
        res({ status: r.statusCode, headers: r.headers, wire, body });
      });
    });
    q.on('error', rej); q.end();
  });
}
const slice = (file, b, n) => FILES[file].subarray(b * M, Math.min(FILES[file].length, (b + n) * M));

test('Accept-Encoding: the first of the server\'s encodings the client takes', () => {
  const have = ['zstd', 'br', 'gzip'];
  assert.equal(pickEncoding('gzip, deflate, br, zstd', have), 'zstd');
  assert.equal(pickEncoding('gzip, br', have), 'br');                         // Cloudflare's edge to an origin
  assert.equal(pickEncoding('GZIP', have), 'gzip');
  assert.equal(pickEncoding('br;q=0, gzip', have), 'gzip');
  assert.equal(pickEncoding('zstd;q=0.0, br; q=1', have), 'br');
  assert.equal(pickEncoding('identity', have), null);
  assert.equal(pickEncoding('*', have), null);
  assert.equal(pickEncoding(undefined, have), null);
  assert.equal(pickEncoding('zstd, br', ['br', 'gzip']), 'br');               // a Node without zstd
});

test('/data-blocks/: named by the manifest, exact in every encoding, as they are where they do not compress, bounds refused', { timeout: 60_000 }, async () => {
  const s = await server();
  try {
    const man = JSON.parse((await get('/data-manifest', { ae: 'identity' })).body);
    assert.deepEqual(man.blocks, { url: '/data-blocks/', size: M, max: 8 });

    // a run that compresses: every encoding the client may take, the exact bytes, smaller on the wire
    const encs = [...(zlib.zstdDecompressSync ? ['zstd'] : []), 'br', 'gzip'];
    for (const [ae, want] of [['gzip, deflate, br, zstd', encs[0]], ['gzip, br', 'br'], ['gzip', 'gzip'], ['identity', undefined]]) {
      const r = await get('/data-blocks/TRACKS/L4RA.BUN?b=1&n=8', { ae });
      assert.equal(r.status, 200, ae);
      assert.equal(r.headers['content-encoding'], want, ae);
      assert.ok(r.body.equals(slice('TRACKS/L4RA.BUN', 1, 8)), `exact bytes with ${ae}`);
      assert.match(r.headers.vary ?? '', /accept-encoding/i);
      assert.match(r.headers['cache-control'], /no-store/);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      if (want) { assert.ok(r.wire.length < r.body.length * 0.5, `${ae}: ${r.wire.length} on the wire for ${r.body.length}`); assert.equal(r.headers['content-length'], undefined); }
      else assert.equal(+r.headers['content-length'], r.body.length);
    }
    // the last, short block; one block; a file that does not compress (random bytes, the movies' video)
    assert.ok((await get('/data-blocks/TRACKS/L4RA.BUN?b=8&n=1')).body.equals(slice('TRACKS/L4RA.BUN', 8, 1)));
    for (const [f, b, n, enc] of [['SPEED2.EXE', 0, 4, undefined], ['MOVIES/INTRO.VP6', 1, 1, undefined], ['PFDATA/MIX.MUS', 0, 3, undefined],
      ['PFDATA/MIX.MUS', 1, 2, encs[0]]]) {
      const r = await get(`/data-blocks/${f}?b=${b}&n=${n}`);
      assert.equal(r.headers['content-encoding'], enc, `${f} from block ${b}`);
      assert.ok(r.body.equals(slice(f, b, n)), f);
    }
    // HEAD: the headers of the plain answer, no body
    const h = await get('/data-blocks/TRACKS/L4RA.BUN?b=0&n=2', { method: 'HEAD' });
    assert.equal(h.status, 200); assert.equal(+h.headers['content-length'], 2 * M); assert.equal(h.wire.length, 0);

    // refused: out of bounds, past the end, not a game file, not inside the folder
    const status = async p => (await get(p)).status;
    for (const p of ['SPEED2.EXE', 'SPEED2.EXE?b=0', 'SPEED2.EXE?b=0&n=0', 'SPEED2.EXE?b=0&n=9', 'SPEED2.EXE?b=-1&n=1', 'SPEED2.EXE?b=1e3&n=1',
      'SPEED2.EXE?b=12345678&n=1', 'SPEED2.EXE?b=0&n=01x']) assert.equal(await status(`/data-blocks/${p}`), 400, p);
    assert.equal(await status('/data-blocks/SPEED2.EXE?b=4&n=1'), 416);       // 3 MiB + 17: blocks 0..3
    assert.equal(await status('/data-blocks/NOTES.TXT?b=0&n=1'), 404);
    assert.equal(await status('/data-blocks/TRACKS?b=0&n=1'), 404);
    assert.equal(await status('/data-blocks/TRACKS/.hidden?b=0&n=1'), 404);
    // (TRACKS/../SPEED2.EXE is SPEED2.EXE: the URL is resolved before anything is looked up, as for /data/)
    assert.equal(await status('/data-blocks/..%2fstate/etag.key?b=0&n=1'), 400);
  } finally { await s.stop(); }
});

test('/data-blocks/: a client holding all its compressors gets the rest as they are, and gets them back when it lets go', { timeout: 60_000 }, async () => {
  const s = await server();
  const held = [];
  try {
    // 8 compressed runs that are not read: each holds its compressor (about 2 MB compressed, more than the
    // socket takes), the 9th and 10th come as they are
    const open = () => new Promise((res, rej) => {
      const q = http.request({ host: '127.0.0.1', port: PORT, path: '/data-blocks/TRACKS/L4RA.BUN?b=0&n=8', headers: { host: `localhost:${PORT}`, 'accept-encoding': 'zstd, br, gzip' } }, r => {
        r.pause(); held.push(r); res(r.headers['content-encoding'] ?? 'none');
      });
      q.on('error', rej); q.end();
    });
    const encs = [];
    for (let i = 0; i < 10; i++) encs.push(await open());
    assert.deepEqual(encs.slice(0, 8).map(e => e !== 'none'), Array(8).fill(true), encs.join(' '));
    assert.deepEqual(encs.slice(8), ['none', 'none'], encs.join(' '));
    // the uncompressed answers are still exact
    const plain = await get('/data-blocks/TRACKS/L4RA.BUN?b=2&n=1');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.ok(plain.body.equals(slice('TRACKS/L4RA.BUN', 2, 1)));
    // letting go (the client goes away mid-answer) gives the compressors back
    for (const r of held.splice(0)) r.destroy();
    let enc;
    for (let i = 0; i < 40 && !enc; i++) { await new Promise(r => setTimeout(r, 50)); enc = (await get('/data-blocks/TRACKS/L4RA.BUN?b=0&n=1')).headers['content-encoding']; }
    assert.ok(enc, 'compressed again once the held answers are gone');
  } finally { for (const r of held) r.destroy(); await s.stop(); }
});
