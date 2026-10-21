// The container images (Dockerfile, the Node server's; web/server-rs/Dockerfile, the Rust server's) never hold the
// game or anything made from it: each one's .dockerignore lets only the server's and the page's sources into the
// build, the Dockerfile copies nothing else from the checkout, and none of those files has a game file's name or is
// a link out of its folder.  The Node image itself, built and run with Caddy in Chrome: node web/tools/deploy-e2e.mjs
// --mode docker (docs/web/VPS.md).
//   node --test web/test/docker.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// the game's file names (web/deploy/pack.sh refuses the same in its bundle)
const GAME_NAMES = /(^|\/)SPEED2\.EXE$|\.(BUN|BIN|LZC|VIV|MUS|ASF|VP6|ABK|GIN|CSI|MPF|AUD|LZW|DLL|EXE)$/i;

// each image: its Dockerfile, its ignore file, and what may go into its build (sources only, never gen/ (the lifted
// game code), out/ (the module) or the game folder)
const IMAGES = [
  { name: 'Node', dockerfile: 'Dockerfile', ignore: '.dockerignore',
    allowed: ['app/registry-defaults.txt', 'web/package.json', 'web/package-lock.json', 'web/build.mjs', 'web/index.html', 'web/src/', 'web/server/'] },
  { name: 'Rust', dockerfile: 'web/server-rs/Dockerfile', ignore: 'web/server-rs/Dockerfile.dockerignore',
    allowed: ['app/registry-defaults.txt', 'web/package.json', 'web/package-lock.json', 'web/build.mjs', 'web/index.html', 'web/src/',
      'web/server/names.mjs', 'web/server/cloudflare-ips.txt', 'web/server-rs/'] },
];

for (const img of IMAGES) {
  const ignore = fs.readFileSync(path.join(REPO, img.ignore), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  // after "*": exceptions (!x), and exclusions inside one of them (a build folder), which only narrow what goes in
  const excluded = ignore.slice(1).filter(l => !l.startsWith('!')).map(l => l.replace(/\/$/, ''));

  test(`${img.name} image: ${img.ignore} leaves everything out, then lets in only the allowed sources`, () => {
    assert.equal(ignore[0], '*', 'the first pattern leaves everything out');
    for (const l of ignore.slice(1)) {
      if (l.startsWith('!')) assert.ok(img.allowed.includes(l.slice(1)), `"${l.slice(1)}" is not one of the server's or the page's sources`);
      else assert.ok(img.allowed.some(a => a.endsWith('/') && l.startsWith(a)), `"${l}": after "*", only exceptions, or exclusions inside them`);
    }
  });

  test(`${img.name} image: ${img.dockerfile} copies from the checkout only what ${img.ignore} lets in`, () => {
    const copies = fs.readFileSync(path.join(REPO, img.dockerfile), 'utf8').split(/\r?\n/)
      .filter(l => /^COPY\s/.test(l) && !/--from=/.test(l))
      .flatMap(l => l.replace(/^COPY\s+/, '').split(/\s+/).filter(w => !w.startsWith('--')).slice(0, -1));
    assert.ok(copies.length > 0);
    for (const c of copies) assert.ok(img.allowed.some(a => c === a || c === a.replace(/\/$/, '') || c.startsWith(a)), `COPY ${c}`);
  });

  test(`${img.name} image: the build context has no game file names and no links`, () => {
    const files = [];
    const walk = rel => {
      if (excluded.includes(rel)) return;
      const st = fs.lstatSync(path.join(REPO, rel));
      assert.ok(!st.isSymbolicLink(), `${rel} is a link`);
      if (st.isDirectory()) for (const e of fs.readdirSync(path.join(REPO, rel))) walk(`${rel}/${e}`);
      else files.push(rel);
    };
    for (const a of img.allowed) walk(a.replace(/\/$/, ''));
    assert.ok(files.length > 20, `${files.length} files`);
    const bad = files.filter(f => GAME_NAMES.test(f));
    assert.deepEqual(bad, []);
  });
}
