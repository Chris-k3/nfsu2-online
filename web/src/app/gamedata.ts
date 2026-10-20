// The game data in this browser's cache (datacache.ts), as "Game data on this
// PC" at the bottom of the start page and offline mode count it.  The I/O
// worker fills it with the blocks the game reads.  Downloading all of it ahead
// is off: the server's bandwidth cannot keep up with every player doing it.

import { MANIFEST_URL, fetchedAhead, manifestFiles, scanCache, type Manifest } from '../host/datacache';

/** Whether every movie is in this browser's cache (only one that played is). */
export async function moviesKept(): Promise<boolean> {
  const r = await fetch(MANIFEST_URL, { cache: 'no-cache' });
  if (!r.ok) return false;
  const s = await scanCache(manifestFiles(await r.json() as Manifest).filter(f => !fetchedAhead(f)));
  return s.have >= s.total;
}

/** How much of the game data but the movies this browser keeps: bytes in the cache, of their total. */
export async function gameDataKept(): Promise<{ have: number; total: number }> {
  const r = await fetch(MANIFEST_URL, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const s = await scanCache(manifestFiles(await r.json() as Manifest).filter(fetchedAhead));
  return { have: s.have, total: s.total };
}
