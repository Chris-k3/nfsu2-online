// The container image (Dockerfile) never holds the game or anything made from it: .dockerignore lets only the
// server's and the page's sources into the build, the Dockerfile copies nothing else from the checkout, and none
// of those files has a game file's name or is a link out of its folder.  The image itself, built and run with
// Caddy in Chrome: node web/tools/deploy-e2e.mjs --mode docker (docs/web/DOCKER.md).
//   node --test web/test/docker.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// what may go into the build: sources only, never gen/ (the lifted game code), out/ (the module) or the game folder
const ALLOWED = ['app/registry-defaults.txt', 'web/package.json', 'web/package-lock.json', 'web/build.mjs', 'web/index.html',
  'web/src/', 'web/server/'];
// the game's file names (web/deploy/pack.sh refuses the same in its bundle)
const GAME_NAMES = /(^|\/)SPEED2\.EXE$|\.(BUN|BIN|LZC|VIV|MUS|ASF|VP6|ABK|GIN|CSI|MPF|AUD|LZW|DLL|EXE)$/i;

const ignore = fs.readFileSync(path.join(REPO, '.dockerignore'), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

test('.dockerignore: everything is left out, then only the allowed sources are let in', () => {
  assert.equal(ignore[0], '*', 'the first pattern leaves everything out');
  const allowed = ignore.slice(1).map(l => { assert.ok(l.startsWith('!'), `"${l}": after "*", only exceptions`); return l.slice(1); });
  for (const a of allowed) assert.ok(ALLOWED.includes(a), `"${a}" is not one of the server's or the page's sources`);
});

test('Dockerfile: copies from the checkout only what .dockerignore lets in', () => {
  const copies = fs.readFileSync(path.join(REPO, 'Dockerfile'), 'utf8').split('\n')
    .filter(l => /^COPY\s/.test(l) && !/--from=/.test(l))
    .flatMap(l => l.replace(/^COPY\s+/, '').split(/\s+/).filter(w => !w.startsWith('--')).slice(0, -1));
  assert.ok(copies.length > 0);
  for (const c of copies) assert.ok(ALLOWED.some(a => c === a || c === a.replace(/\/$/, '') || c.startsWith(a)), `COPY ${c}`);
});

test('the build context: no game file names, no links', () => {
  const files = [];
  const walk = rel => {
    const st = fs.lstatSync(path.join(REPO, rel));
    assert.ok(!st.isSymbolicLink(), `${rel} is a link`);
    if (st.isDirectory()) for (const e of fs.readdirSync(path.join(REPO, rel))) walk(`${rel}/${e}`);
    else files.push(rel);
  };
  for (const a of ALLOWED) walk(a.replace(/\/$/, ''));
  assert.ok(files.length > 20, `${files.length} files`);
  const bad = files.filter(f => GAME_NAMES.test(f));
  assert.deepEqual(bad, []);
});
