// Stale lifted C (the perf review): gen.sh stamps gen/all and gen/server
// (tools/genstamp.sh), web/build.sh refuses a gen made from another override
// list, hook list or lifter (web/tools/gencheck.sh), and a plain ./gen.sh
// leaves no web-lift.txt behind.
//   node --test web/test/gencheck.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(REPO, 'out/web/test'); fs.mkdirSync(OUT, { recursive: true });
const sources = execFileSync('bash', [path.join(REPO, 'tools/genstamp.sh'), 'sources'], { encoding: 'utf8' }).trim();
const orig = execFileSync('bash', [path.join(REPO, 'tools/genstamp.sh'), 'overrides'], { encoding: 'utf8' }).trim().split(',').filter(Boolean);
const STAMP = `# gen.sh 2026-10-18T00:00:00Z: what gen/all and gen/server were lifted from\n${sources}\nexe 0 server.dll 0\noptions X87PC=1 X87OPT=1 FLAGABI=0\n`;

/** a fake gen dir: decls.h with the runtime's _orig declarations, and the given stamps */
function gen(name, { all = STAMP, server = all, decls = orig } = {}) {
  const g = path.join(OUT, `gencheck-${name}`);
  fs.rmSync(g, { recursive: true, force: true });
  for (const d of ['all', 'server']) fs.mkdirSync(path.join(g, d), { recursive: true });
  fs.writeFileSync(path.join(g, 'all/decls.h'), decls.map(a => `void sub_00${a}_orig(CPU*);\n`).join(''));
  if (all !== null) fs.writeFileSync(path.join(g, 'all/stamp.txt'), all);
  if (server !== null) fs.writeFileSync(path.join(g, 'server/stamp.txt'), server);
  return g;
}
const check = (g, env = {}) => spawnSync('bash', [path.join(REPO, 'web/tools/gencheck.sh')], { cwd: REPO, encoding: 'utf8', env: { ...process.env, GEN: g, ...env } });

test('gencheck: a gen stamped from this checkout passes', () => {
  const r = check(gen('ok'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, '');
});

test('gencheck: another hook list, override list or lifter is refused, and says which', () => {
  for (const [k, what] of [['hooks', /hook list/], ['overrides', /override list/], ['lifter', /lifter \(tools\/lift\.py/]]) {
    const stale = STAMP.replace(new RegExp(`^${k} \\S+`, 'm'), `${k} 0000000000000000`);
    const r = check(gen(`stale-${k}`, { all: stale }));
    assert.equal(r.status, 1, `${k}: ${r.stdout}`);
    assert.match(r.stdout, /is stale/);
    assert.match(r.stdout, what);
    const ok = check(gen(`stale-ok-${k}`, { all: stale }), { GEN_STALE_OK: '1' });
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.stdout, /building anyway/);
  }
});

test('gencheck: an unfinished lift, a gen/server from another run, missing _orig declarations are refused', () => {
  let r = check(gen('incomplete', { all: 'incomplete: gen.sh has not finished (or failed)\n', server: null }));
  assert.equal(r.status, 1); assert.match(r.stdout, /not a finished lift/);
  r = check(gen('server', { server: STAMP.replace('2026-10-18T00:00:00Z', '2026-10-17T00:00:00Z') }));
  assert.equal(r.status, 1); assert.match(r.stdout, /server is not from the gen\.sh run/);
  r = check(gen('server-missing', { server: null }));
  assert.equal(r.status, 1); assert.match(r.stdout, /differs or is missing/);
  r = check(gen('decls', { decls: orig.slice(1) }));
  assert.equal(r.status, 1); assert.match(r.stdout, /older than the runtime/);
});

test('gencheck: a gen without a stamp (made before stamps) gets a note only', () => {
  const r = check(gen('nostamp', { all: null, server: null }));
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /has no stamp/);
});

test('a plain ./gen.sh drops web-lift.txt and leaves gen/all unstamped until it finishes', () => {
  // gen.sh in a copy of the checkout's scripts and runtime sources; it fails
  // at its first lifter step (no Python there), after its preamble
  const t = path.join(OUT, 'gencheck-gensh');
  fs.rmSync(t, { recursive: true, force: true });
  fs.mkdirSync(path.join(t, 'tools'), { recursive: true }); fs.mkdirSync(path.join(t, 'runtime')); fs.mkdirSync(path.join(t, 'gen/all'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'gen.sh'), path.join(t, 'gen.sh'));
  fs.copyFileSync(path.join(REPO, 'tools/genstamp.sh'), path.join(t, 'tools/genstamp.sh'));
  for (const f of fs.readdirSync(path.join(REPO, 'runtime'))) if (/\.(c|m)$/.test(f)) fs.copyFileSync(path.join(REPO, 'runtime', f), path.join(t, 'runtime', f));
  for (const f of ['lift.py', 'genall.py', 'reloc2.py', 'argcount.py', 'flagabi.py', 'prepare_module.py']) fs.writeFileSync(path.join(t, 'tools', f), '');
  fs.writeFileSync(path.join(t, 'gen/all/web-lift.txt'), 'FLAGABI X87OPT\n');
  fs.writeFileSync(path.join(t, 'gen/all/stamp.txt'), STAMP);
  fs.writeFileSync(path.join(t, 'SPEED2.EXE'), 'not a PE file');
  const r = spawnSync('bash', [path.join(t, 'gen.sh'), path.join(t, 'SPEED2.EXE')], { cwd: t, encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'gen.sh failed (no lifter in the copy)');
  assert.match(r.stdout, /OVERRIDE \(\d+\)/, 'it got past its preamble');
  assert.ok(!fs.existsSync(path.join(t, 'gen/all/web-lift.txt')), 'web-lift.txt is gone');
  assert.match(fs.readFileSync(path.join(t, 'gen/all/stamp.txt'), 'utf8'), /^incomplete/);
});

test('web/gen.sh refuses to lift through a worktree\'s link to the shared gen', () => {
  const t = path.join(OUT, 'gencheck-shared');
  fs.rmSync(t, { recursive: true, force: true });
  fs.mkdirSync(path.join(t, 'web'), { recursive: true }); fs.mkdirSync(path.join(t, 'shared/all'), { recursive: true }); fs.mkdirSync(path.join(t, 'gen'));
  fs.copyFileSync(path.join(REPO, 'web/gen.sh'), path.join(t, 'web/gen.sh'));
  fs.writeFileSync(path.join(t, 'shared/all/web-lift.txt'), 'FLAGABI X87OPT\n');
  fs.symlinkSync(path.join(t, 'shared/all'), path.join(t, 'gen/all'));
  fs.writeFileSync(path.join(t, 'SPEED2.EXE'), 'x');
  const r = spawnSync('bash', [path.join(t, 'web/gen.sh'), path.join(t, 'SPEED2.EXE')], { cwd: t, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /gen\/all is a link to .*which other worktrees build against/);
  assert.ok(fs.existsSync(path.join(t, 'shared/all/web-lift.txt')), 'the shared gen is untouched');
});
