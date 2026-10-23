// How many play on this server now, for the start page's Multiplayer settings: the server's /players (three
// counts, whether it is full and whether free roam is busy, nothing else; with a Room setting, how many are in
// free roam in that room too).  Asked every 15 s, and only while the start page is visible and no game runs; a
// server without the route shows nothing.  Whether the server answered at all goes to reached() (offline mode).

/** roam: driving in free roam or paused there (null, or missing from an older server: not shown);
 *  roamBusy: free roam gives fewer cars a player now (the server's hub cut its links), so the first Play does not ask about it;
 *  room: of roam, those in the room asked for (/players?room=, missing without one or from an older server) */
export interface PlayerCounts { players: number; online: number | null; roam?: number | null; full?: boolean; roamBusy?: boolean; room?: number }

const EVERY_MS = 15_000;
const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** The Room setting's hash, as roam_core.c rc_room_hash makes it (FNV-1a of the name's UTF-8 without its spaces and
 *  with its capitals A to Z small; 0: no room), for /players?room= */
export function roomHash(name: string): number {
  let h = 0x811c9dc5, kept = 0;
  for (let b of new TextEncoder().encode(name)) {
    if (b === 0x20 || (b >= 0x09 && b <= 0x0d)) continue;
    if (b >= 0x41 && b <= 0x5a) b += 0x20;
    h = Math.imul(h ^ b, 0x01000193) >>> 0; kept++;
  }
  return !kept ? 0 : h || 1;
}

/** The line the page shows ('' for an answer it cannot read); room: the player's Room setting, when free roam is on
 *  ('' for none): free roam shows only that room's players, which the line says, with how many are there. */
export function playersText(c: PlayerCounts, room = ''): string {
  if (!Number.isInteger(c.players) || c.players < 0) return '';
  if (c.players === 0) return 'On this server now: nobody is playing.';
  const count = (k: number | null | undefined, what: string) => Number.isInteger(k) && k! >= 0 ? `, ${k} ${what}` : '';
  const on = count(c.online, 'in Online mode') + count(c.roam, 'in free roam');
  room = room.trim();
  const inRoom = !room ? '' : Number.isInteger(c.room) && c.room! >= 0
    ? ` You are in room "${room}": ${c.room === 0 ? 'nobody' : c.room} in free roam there.` : ` You are in room "${room}".`;
  const full = c.full === true ? ' The server is full: playing with others waits until a place frees up.' : '';
  return `On this server now: ${n(c.players, 'player', 'players')}${on}.${inRoom}${full}`;
}

/** Whether the server answers (any answer but a 5xx from a proxy in front of it), within ms. */
export async function serverAnswers(ms: number): Promise<boolean> {
  try { return (await fetch('/players', { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(ms) })).status < 500; }
  catch { return false; }
}

/** show(line) at once and every 15 s while idle() and the page is visible; reached(whether the server answered);
 *  room(): the Room setting while free roam is on ('' for none); last(): the newest answer (null before the first,
 *  or from a server without the route) */
export function watchPlayers(show: (line: string) => void, idle: () => boolean, reached?: (ok: boolean) => void, room: () => string = () => '') {
  let gone = false, last: PlayerCounts | null = null;
  const ask = async () => {
    if (gone || document.visibilityState !== 'visible' || !idle()) return;
    try {
      const name = room(), hash = roomHash(name);
      const r = await fetch(hash ? `/players?room=${hash}` : '/players', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      reached?.(r.status < 500);
      if (r.status === 404) { gone = true; last = null; show(''); return; }
      if (r.ok) { last = await r.json() as PlayerCounts; show(playersText(last, hash ? name : '')); }
    } catch { reached?.(false); }
  };
  window.setInterval(() => void ask(), EVERY_MS);
  document.addEventListener('visibilitychange', () => void ask());
  void ask();
  return { now: () => void ask(), last: () => last };
}
