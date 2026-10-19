// web/start.sh in a stub tree: a failing build stops it with the build's error,
// and the server is not started (phase-2 integrate review, finding 2).  The
// stub's web/build.sh, web/build.mjs and server only print and exit as told.
//   node --test web/test/start-sh.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-startsh-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

let n = 0;
/** a tree with start.sh, a module and a page older than their sources */
function tree({ module = 0, page = 0 } = {}) {
  const t = path.join(base, `t${n++}`);
  const w = (p, s, mode) => { fs.mkdirSync(path.dirname(path.join(t, p)), { recursive: true }); fs.writeFileSync(path.join(t, p), s); if (mode) fs.chmodSync(path.join(t, p), mode); };
  w('web/start.sh', fs.readFileSync(path.join(ROOT, 'web/start.sh')), 0o755);
  w('game/SPEED2.EXE', 'x');
  for (const d of ['web/node_modules/esbuild', 'web/node_modules/ws', 'deps/wasi-sdk-34']) fs.mkdirSync(path.join(t, d), { recursive: true });
  w('gen/all/fntab.c', '');
  w('out/web/nfsu2.wasm', 'old module');
  w('web/dist/main.js', 'old page');
  const past = new Date(Date.now() - 3600e3);
  fs.utimesSync(path.join(t, 'out/web/nfsu2.wasm'), past, past);
  fs.utimesSync(path.join(t, 'web/dist/main.js'), past, past);
  // several newer sources: the stale checks must not trip over their own pipes
  for (let i = 0; i < 300; i++) w(`runtime/f${i}.c`, '');
  for (let i = 0; i < 300; i++) w(`web/src/f${i}.ts`, '');
  const errs = Array.from({ length: 30 }, (_, i) => `error line ${i + 1}`).join('\n');
  w('web/build.sh', `#!/bin/bash\necho compiling\n${module ? `echo "${errs}" >&2\nexit ${module}` : 'echo "link OK: out/web/nfsu2.wasm"; echo new > out/web/nfsu2.wasm'}\n`, 0o755);
  w('web/build.mjs', page ? `console.error(${JSON.stringify(errs.replace(/error/g, 'page error'))}); process.exit(${page});\n` : `console.log('page built');\n`);
  w('web/server/server.mjs', `console.log('SERVER STARTED with ' + require('fs').readFileSync('out/web/nfsu2.wasm', 'utf8').trim());\n`.replace("require('fs')", "(await import('node:fs'))"));
  return t;
}
const run = t => {
  const r = spawnSync('bash', [path.join(t, 'web/start.sh'), '--data', path.join(t, 'game'), '--http-port', '48080'],
    { cwd: t, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

test('a module build that fails stops start.sh with its error; no server', () => {
  const r = run(tree({ module: 1 }));
  assert.notEqual(r.code, 0);
  assert.match(r.out, /error line 1\b/, 'more than the last 3 lines of the error');
  assert.match(r.out, /error line 30/);
  assert.match(r.out, /The game module did not build/);
  assert.doesNotMatch(r.out, /SERVER STARTED|Starting the server/);
});

test('a page build that fails stops start.sh with its error; no server', () => {
  const r = run(tree({ page: 2 }));
  assert.notEqual(r.code, 0);
  assert.match(r.out, /page error line 1\b/);
  assert.match(r.out, /The page did not build/);
  assert.doesNotMatch(r.out, /SERVER STARTED|Starting the server/);
});

test('builds that succeed start the server with the new module', () => {
  const r = run(tree());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /link OK/);
  assert.match(r.out, /page built/);
  assert.match(r.out, /SERVER STARTED with new/);
});
