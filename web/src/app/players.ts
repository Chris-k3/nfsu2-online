// How many play on this server now, for the start page's Multiplayer settings: the server's /players (three
// counts, whether it is full and whether free roam is busy, nothing else).  Asked every 15 s, and only while the
// start page is visible and no game runs; a server without the route shows nothing.  Whether the server answered
// at all goes to reached() (offline mode).

/** roam: driving in free roam or paused there (null, or missing from an older server: not shown);
 *  roamBusy: free roam gives fewer cars a player now (the server's hub cut its links), so the first Play does not ask about it */
export interface PlayerCounts { players: number; online: number | null; roam?: number | null; full?: boolean; roamBusy?: boolean }

const EVERY_MS = 15_000;
const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** The line the page shows ('' for an answer it cannot read). */
export function playersText(c: PlayerCounts): string {
  if (!Number.isInteger(c.players) || c.players < 0) return '';
  if (c.players === 0) return 'On this server now: nobody is playing.';
  const count = (k: number | null | undefined, what: string) => Number.isInteger(k) && k! >= 0 ? `, ${k} ${what}` : '';
  const on = count(c.online, 'in Online mode') + count(c.roam, 'in free roam');
  const full = c.full === true ? ' The server is full: playing with others waits until a place frees up.' : '';
  return `On this server now: ${n(c.players, 'player', 'players')}${on}.${full}`;
}

/** Whether the server answers (any answer but a 5xx from a proxy in front of it), within ms. */
export async function serverAnswers(ms: number): Promise<boolean> {
  try { return (await fetch('/players', { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(ms) })).status < 500; }
  catch { return false; }
}

/** show(line) at once and every 15 s while idle() and the page is visible; reached(whether the server answered);
 *  last(): the newest answer (null before the first, or from a server without the route) */
export function watchPlayers(show: (line: string) => void, idle: () => boolean, reached?: (ok: boolean) => void) {
  let gone = false, last: PlayerCounts | null = null;
  const ask = async () => {
    if (gone || document.visibilityState !== 'visible' || !idle()) return;
    try {
      const r = await fetch('/players', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      reached?.(r.status < 500);
      if (r.status === 404) { gone = true; last = null; show(''); return; }
      if (r.ok) { last = await r.json() as PlayerCounts; show(playersText(last)); }
    } catch { reached?.(false); }
  };
  window.setInterval(() => void ask(), EVERY_MS);
  document.addEventListener('visibilitychange', () => void ask());
  void ask();
  return { now: () => void ask(), last: () => last };
}
