// The game's sound delay and the audio ring, on the player's page (web/index.html)
// with sound attached, in headless Chrome (muted: the output is a timer, so its
// latency is not a device's), against a running server started with --dev:
//   node web/tools/audio-test.mjs [--base http://localhost:8611] [--out <dir>] [--only delay,ring]
// Steps (each prints PASS/FAIL with evidence; the page logs go to --out):
//   delay  a quick race (tests/scripts/quickrace.txt): 30 s in, the game writes its
//          sound at most SETTLED_MS ahead of the mixer again, the boot's late
//          wake-ups forgotten (runtime/sndlead.c; 164 ms there before it, 81-97
//          after, 2026-10-24), no slice is mixed before the game wrote it, and
//          the ring ends at its start target
//   ring   the main menu with two pump stalls (tests/scripts/audio_ring.txt):
//          an underrun raises the ring target, 20 s without one bring it back to
//          the start, and an underrun at a size a lowering left keeps the size before it
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { requireDev } from './dev-server.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('--base', 'http://localhost:8611');
await requireDev(BASE);
const OUT = path.resolve(arg('--out', 'out/web/audio-test'));
const ONLY = arg('--only', '') ? new Set(arg('--only').split(',')) : null;
const RUN = `audiotest-${Date.now().toString(36)}`;
const SETTLED_MS = 130;
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function report(step, ok, evidence) {
  results.push({ step, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}: ${evidence}`);
}
const browser = await chromium.launch({ channel: 'chrome', headless: !process.argv.includes('--headed'),
  args: ['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    ...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(' ') : [])] });

// Play with this input script; the page log once the game ended (exit code, lines without the [tid] prefix)
async function play(step, script, ms) {
  const q = new URLSearchParams({ reg: '/tests/web/seed/registry_perf4_native.txt', save: `${RUN}-${step}`, script });
  for (const e of ['NFSU2_ROAM=0', 'NFSFULL=0', 'NFSU2_AUDIO_STATUS=5', 'NFSU2_TIMEOUT=400']) q.append('env', e);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.on('pageerror', e => console.log(`  ${step} PAGEERROR ${e}`));
  await page.goto(`${BASE}/?${q}&fresh`);
  await page.waitForFunction(() => window.__nfsu2?.phase === 'ready', null, { timeout: 120000 });
  await page.click('#play');
  const end = await page.waitForFunction(() => window.__nfsu2?.phase === 'exited', null, { timeout: ms, polling: 1000 })
    .then(() => 'exited', () => 'timeout');
  const text = await page.evaluate(() => window.__nfsu2.log.text());
  fs.writeFileSync(path.join(OUT, `${step}.log`), text);
  await page.context().close();
  const lines = text.split('\n').map(l => l.replace(/^\[\d+!?\] ?/, ''));
  const x = /\[app\] the game exited with code (-?\d+)/.exec(text);
  return { end, code: x ? +x[1] : null, lines };
}
const num = (re, lines) => { for (const l of lines) { const m = re.exec(l); if (m) return m.slice(1).map(Number); } return null; };

if (!ONLY || ONLY.has('delay')) {
  const r = await play('delay', '/tests/scripts/quickrace.txt', 600000);
  const ahead = num(/sound write-ahead : the game wrote ([\d.]+) ms ahead of the mixer on average, at most ([\d.]+) ms; (\d+) slices/, r.lines);
  const ring = num(/sound output path : AudioWorklet ring, \d+-frame slices, target (\d+) frames .*?(\d+) underruns, target grew (\d+) times and came down (\d+) times \(to (\d+) frames/, r.lines);
  const lat = num(/worklet attached: (\d+) Hz, base latency ([\d.]+) ms, output latency ([\d.]+) ms/, r.lines);
  // the status line 30 s in: lead=<least>..<most>ms over its 5 s
  const at30 = r.lines.map(l => /\[audio\] t=([\d.]+)s .* lead=(\d+)\.\.(\d+)ms/.exec(l)).find(m => m && +m[1] >= 30);
  const ok = r.end === 'exited' && r.code === 0 && ahead && at30 && +at30[3] <= SETTLED_MS && ahead[2] === 0 && ring && ring[0] === ring[4];
  report('delay', ok, `${r.end}, exit ${r.code}; ` + (at30 ? `${at30[2]}..${at30[3]} ms ahead at ${at30[1]} s (limit ${SETTLED_MS}); ` : 'no status line at 30 s; ') +
    (ahead ? `${ahead[0]} ms on average (at most ${ahead[1]}), ${ahead[2]} slices mixed unwritten` : 'no write-ahead line') +
    (ring ? `; ring target ${ring[0]} frames (start ${ring[4]}), ${ring[1]} underruns, raised ${ring[2]}, lowered ${ring[3]}` : '; no ring line') +
    (lat ? `; context ${lat[0]} Hz, base ${lat[1]} ms, output ${lat[2]} ms` : ''));
}

if (!ONLY || ONLY.has('ring')) {
  const r = await play('ring', '/tests/scripts/audio_ring.txt', 400000);
  // the pump's lines in order, each placed after the script's "stall N" markers
  let phase = 0; const ev = [];
  for (const l of r.lines) {
    const s = /LOG stall (\d)/i.exec(l); if (s) { phase = +s[1]; continue; }
    let m;
    if ((m = /ring target raised to (\d+) frames/.exec(l))) ev.push({ phase, kind: 'up', to: +m[1] });
    else if ((m = /ring target lowered to (\d+) frames/.exec(l))) ev.push({ phase, kind: 'down', to: +m[1] });
    else if ((m = /it stays at (\d+) frames \(/.exec(l))) ev.push({ phase, kind: 'floor', to: +m[1] });
  }
  const start = num(/output paced by the AudioWorklet \(ring \d+ frames, target (\d+)/, r.lines)?.[0];
  const of = (p, k) => ev.filter(e => e.phase === p && e.kind === k);
  const back = of(1, 'up').length > 0 && of(1, 'down').at(-1)?.to === start;   // stall 1: up, then down to the start
  const floor = of(2, 'floor')[0]?.to;                                         // stall 2: the size before that last lowering
  const held = of(2, 'down').every(e => e.to >= floor);
  const last = num(/sound output path : AudioWorklet ring, \d+-frame slices, target (\d+) frames/, r.lines)?.[0];
  const ok = r.end === 'exited' && r.code === 0 && back && floor === start + 512 && of(2, 'up').length > 0 && held && last === floor;
  report('ring', ok, `${r.end}, exit ${r.code}; start ${start}, at the end ${last}; ` +
    [1, 2].map(p => `stall ${p}: ${ev.filter(e => e.phase === p).map(e => `${e.kind} ${e.to}`).join(', ') || 'nothing'}`).join('; '));
}

await browser.close();
const failed = results.filter(x => !x.ok).length;
console.log(`${results.length - failed} of ${results.length} passed; logs in ${OUT}`);
process.exit(failed ? 1 : 0);
