// The game data cache in OPFS "cache/", shared by the I/O worker (which fills
// it with the blocks the game reads) and the predownload worker (which fills
// all of it ahead, predownload-worker.ts).  One sparse file per file of the
// install folder, named by its path, size and mtime (a file changed on the
// server is a new name), next to a ".have" map of one byte per 1 MiB block.
// A block's data is written before its byte in the map.

export const BLOCK = 1 << 20;
export const CACHE_DIR = 'cache';
/** where the server has the manifest and the install folder (web/server/server.mjs) */
export const MANIFEST_URL = '/data-manifest', DATA_BASE = '/data/';

/** the server's /data-manifest: every file and folder of the install folder it serves, and where it serves runs
 *  of their blocks compressed (an older server has no "blocks": byte ranges of /data/ then) */
export interface Manifest {
  files: { p: string; d?: number; s?: number; m?: number }[];
  blocks?: { url: string; size: number; max: number };
}
/** The manifest's compressed runs, if it has them in this cache's block size: [url, most blocks a request]. */
export function blockRuns(m: Manifest): { url: string; max: number } | null {
  const b = m.blocks;
  return b && typeof b.url === 'string' && b.url.startsWith('/') && b.size === BLOCK && b.max >= 1 ? { url: b.url, max: b.max } : null;
}
/** blocks first .. first+n-1 of a file, compressed: a 200 whose body (decoded by the browser) is exactly their bytes.  The
 *  file's mtime (m) makes a changed file a new address, so the server lets Cloudflare keep the answer for good. */
export const runUrl = (base: string, path: string, first: number, n: number, mtime: number) =>
  `${dataUrl(base, path)}?b=${first}&n=${n}&m=${mtime}`;
export interface DataFile { path: string; size: number; mtime: number }
export interface CacheFile { h: FileSystemSyncAccessHandle; have: Uint8Array; haveH: FileSystemSyncAccessHandle }

export const manifestFiles = (m: Manifest): DataFile[] => m.files.filter(f => !f.d).map(f => ({ path: f.p, size: f.s ?? 0, mtime: f.m ?? 0 }));
/** What "Download all game data" fetches: all but the movies (MOVIES/, a third of the folder in VP6 video that
 *  does not compress).  They stream as they play, and with Movies off the game never opens them. */
export const fetchedAhead = (f: DataFile) => f.path.split('/')[0].toLowerCase() !== 'movies';
export const dataUrl = (base: string, path: string) => base + path.split('/').map(encodeURIComponent).join('/');
export function cacheKey(f: DataFile) { return `${f.path.replace(/[^A-Za-z0-9._-]/g, '_')}.${f.size}.${f.mtime}`; }
export const blockCount = (size: number) => Math.ceil(size / BLOCK);
export const blockLen = (size: number, bi: number) => Math.min(BLOCK, size - bi * BLOCK);

/** A file's sync handles and its map, made empty if it does not fit the file (workers only). */
export async function openCacheFile(dir: FileSystemDirectoryHandle, f: DataFile): Promise<CacheFile> {
  const k = cacheKey(f);
  const fh = await dir.getFileHandle(k, { create: true });
  const mh = await dir.getFileHandle(k + '.have', { create: true });
  const h = await (fh as any).createSyncAccessHandle({ mode: 'readwrite-unsafe' }) as FileSystemSyncAccessHandle;
  let haveH: FileSystemSyncAccessHandle;
  try { haveH = await (mh as any).createSyncAccessHandle({ mode: 'readwrite-unsafe' }) as FileSystemSyncAccessHandle; }
  catch (e) { h.close(); throw e; }
  const nb = blockCount(f.size);
  const have = new Uint8Array(nb);
  if (haveH.getSize() === nb) haveH.read(have, { at: 0 }); else { haveH.truncate(0); haveH.write(have, { at: 0 }); }
  return { h, have, haveH };
}

/** block bi of the file is in its cache file now */
export function putBlock(cf: CacheFile, bi: number, b: Uint8Array) {
  cf.h.write(b, { at: bi * BLOCK }); cf.have[bi] = 1; cf.haveH.write(cf.have.subarray(bi, bi + 1), { at: bi });
}

export interface Scan {
  /** bytes of the manifest's files, and of those that are in the cache */
  total: number; have: number;
  /** what the cache files take already (their sizes: the browser counts a sparse file's whole length) */
  allocated: number;
  /** each file's map (null: nothing of it yet) */
  files: { f: DataFile; have: Uint8Array | null }[];
}

/** What of the manifest's files the cache holds.  Async reads only (any thread), no handle is opened. */
export async function scanCache(files: DataFile[]): Promise<Scan> {
  const s: Scan = { total: 0, have: 0, allocated: 0, files: [] };
  let dir: FileSystemDirectoryHandle | null = null;
  try { dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(CACHE_DIR); } catch { /* no cache yet */ }
  for (const f of files) {
    s.total += f.size;
    let have: Uint8Array | null = null;
    if (dir) try {
      const k = cacheKey(f);
      const m = new Uint8Array(await (await (await dir.getFileHandle(k + '.have')).getFile()).arrayBuffer());
      s.allocated += Math.min(f.size, (await (await dir.getFileHandle(k)).getFile()).size);
      if (m.length === blockCount(f.size)) have = m;
    } catch { /* not cached */ }
    if (have) for (let bi = 0; bi < have.length; bi++) if (have[bi]) s.have += blockLen(f.size, bi);
    s.files.push({ f, have });
  }
  return s;
}
