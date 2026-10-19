// How many play on this server now, for the start page's Multiplayer settings: the server's /players (two
// counts, nothing else).  Asked every 15 s, and only while the start page is visible and no game runs; a
// server without the route shows nothing.

export interface PlayerCounts { players: number; online: number | null }

const EVERY_MS = 15_000;
const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** The line the page shows ('' for an answer it cannot read). */
export function playersText(c: PlayerCounts): string {
  if (!Number.isInteger(c.players) || c.players < 0) return '';
  if (c.players === 0) return 'On this server now: nobody is playing.';
  const on = Number.isInteger(c.online) && c.online! >= 0 ? `, ${c.online} in Online mode` : '';
  return `On this server now: ${n(c.players, 'player', 'players')}${on}.`;
}

/** show(line) at once and every 15 s while idle() and the page is visible */
export function watchPlayers(show: (line: string) => void, idle: () => boolean) {
  let gone = false;
  const ask = async () => {
    if (gone || document.visibilityState !== 'visible' || !idle()) return;
    try {
      const r = await fetch('/players', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (r.status === 404) { gone = true; show(''); return; }
      if (r.ok) show(playersText(await r.json() as PlayerCounts));
    } catch { /* the last line stays until the next answer */ }
  };
  window.setInterval(() => void ask(), EVERY_MS);
  document.addEventListener('visibilitychange', () => void ask());
  void ask();
  return { now: () => void ask() };
}
