// Keyphrase saves: this browser's saves kept on the server too, under a keyphrase only the player has, so the career
// goes on in any browser the keyphrase is typed into (docs/web/PLAYING.md, Saves).  The server keeps what it is sent
// and gives it back to whoever shows the token (web/server-rs/crates/vault: the caps, the copy of an earlier day, two
// years unused); all that knows a save is here, so the server never sees one:
// - the keyphrase: "nfsu2-xyz-" and 8 of vault-words.ts's 1296 words (about 2^83), from crypto.getRandomValues; read
//   back in any case, with any separators, "nfsu2-xyz" optional;
// - PBKDF2-SHA-256 of it (100,000 rounds, a fixed salt: the keyphrase is all there is) gives 64 bytes: an AES-GCM key
//   and a token.  The server keeps the keyphrase under the token's SHA-256 and never sees the key;
// - what is sent: the save folder but the F12 screenshots and a test's input script, as a stored zip (zip.ts),
//   deflated, then sealed: a version byte (1), a 12-byte IV, the AES-256-GCM ciphertext and its tag.  A player's
//   folder is 6-14 KB so; the server takes 256 KB;
// - VaultSync: this browser's link (the keyphrase, the version it has, a hash of the files it sent or took) and the
//   two ways of syncing.  Sending: after the game saves and when it closes, if the files changed since; taking: when
//   the page opens and before Play, if another browser sent a newer version and the files here did not change.  Both
//   changed (to something else): a conflict, the player picks.  A browser with no profile while its keyphrase has
//   some (its storage cleared, an empty backup restored) never sends by itself either.

import { WORDS } from './vault-words';
import { unzip, zip } from './zip';
import { coverOf, profileName } from './profile';
import { isScreenshot, PROFILES_DIR } from './savefs';

export const PREFIX = 'nfsu2-xyz';
export const PHRASE_WORDS = 8;
export const KDF_ROUNDS = 100_000;
/** what the server takes (crates/vault VaultOptions::sized) */
export const MAX_BOX = 256 << 10;
/** the most a keyphrase's zip inflates to: a backup's saves and settings (saves-ui.ts MAX_OTHER) */
const MAX_PLAIN = 256 << 20;
const SALT = 'nfsu2-xyz keyphrase saves v1', AAD = 'nfsu2-xyz keyphrase saves v1';
const WORD_SET = new Set(WORDS);
const enc = new TextEncoder();

export class VaultError extends Error {}

/** A new keyphrase: the prefix and PHRASE_WORDS random words. */
export function newPhrase(): string {
  const words: string[] = [];
  const limit = Math.floor(65536 / WORDS.length) * WORDS.length;     // past it, a value would favour the first words
  while (words.length < PHRASE_WORDS)
    for (const v of crypto.getRandomValues(new Uint16Array(PHRASE_WORDS)))
      if (v < limit && words.length < PHRASE_WORDS) words.push(WORDS[v % WORDS.length]);
  return [PREFIX, ...words].join('-');
}

/** A keyphrase as typed or pasted (any case, any separators, the prefix optional), or what is wrong with it. */
export function readPhrase(text: string): { phrase: string } | { bad: string } {
  let w = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (w[0] === 'nfsu2' && w[1] === 'xyz') w = w.slice(2);
  if (!w.length) return { bad: 'Type or paste your keyphrase.' };
  const unknown = w.find(x => !WORD_SET.has(x));
  if (unknown) return { bad: `"${unknown}" is not a keyphrase word: check its spelling.` };
  if (w.length !== PHRASE_WORDS) return { bad: `A keyphrase has ${PHRASE_WORDS} words after ${PREFIX}; this has ${w.length}.` };
  return { phrase: [PREFIX, ...w].join('-') };
}

export interface Keys { key: CryptoKey; token: string }

const base64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** The key that seals a keyphrase's saves and the token the server keeps them under. */
export async function keysOf(phrase: string): Promise<Keys> {
  const base = await crypto.subtle.importKey('raw', enc.encode(phrase), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SALT), iterations: KDF_ROUNDS }, base, 512));
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, token: base64url(bits.subarray(32)) };
}

export async function seal(key: CryptoKey, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(AAD) }, key, plain as BufferSource));
  const out = new Uint8Array(13 + ct.length);
  out[0] = 1; out.set(iv, 1); out.set(ct, 13);
  return out;
}

export async function unseal(key: CryptoKey, box: Uint8Array): Promise<Uint8Array> {
  if (box.length < 13 + 16 || box[0] !== 1) throw new VaultError('what the server holds for this keyphrase is not a keyphrase\'s saves');
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.slice(1, 13), additionalData: enc.encode(AAD) }, key, box.slice(13)));
  } catch { throw new VaultError('these saves do not open with this keyphrase'); }
}

export interface SaveFile { path: string; data: Uint8Array; mtime?: number }

/** A file of the save folder a keyphrase keeps: all but the F12 screenshots and a test's input script. */
export const keeps = (path: string) => !isScreenshot(path) && path !== 'autotest-script.txt';

/** a stream's bytes, at most max of them */
async function bytesOf(s: ReadableStream<Uint8Array>, max = Infinity): Promise<Uint8Array> {
  const rd = s.getReader(), parts: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      if ((n += value.length) > max) throw new VaultError('these saves are larger than a keyphrase keeps');
      parts.push(value);
    }
  } catch (e) { void rd.cancel().catch(() => {}); throw e; }
  const out = new Uint8Array(n);
  let p = 0;
  for (const x of parts) { out.set(x, p); p += x.length; }
  return out;
}

/** The files as a zip, deflated. */
export async function pack(files: SaveFile[]): Promise<Uint8Array> {
  const z = zip(files.map(f => ({ name: f.path, data: f.data, mtime: f.mtime })));
  return bytesOf(new Blob([z as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw')));
}

/** pack()'s zip again (at most MAX_PLAIN: what restores as a backup would) */
export async function unpack(packed: Uint8Array): Promise<Uint8Array> {
  try { return await bytesOf(new Blob([packed as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')), MAX_PLAIN); }
  catch (e) { throw e instanceof VaultError ? e : new VaultError(`these saves are damaged (${e instanceof Error ? e.message : e})`); }
}

/** What the files hold, whatever their times: SHA-256 over their paths and bytes, in path order. */
export async function contentHash(files: SaveFile[]): Promise<string> {
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const parts = sorted.flatMap(f => {
    const name = enc.encode(f.path), head = new Uint8Array(8), v = new DataView(head.buffer);
    v.setUint32(0, name.length); v.setUint32(4, f.data.length);
    return [head, name, f.data];
  });
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', await new Blob(parts as BlobPart[]).arrayBuffer())));
}

/** The profiles among the files ("NFS Underground 2/<NAME>/<NAME>", not a cover shoot's). */
export function profilesIn(files: SaveFile[]): string[] {
  return files.map(f => f.path.split('/'))
    .filter(p => p.length === 3 && p[0] === PROFILES_DIR && p[1].toLowerCase() === p[2].toLowerCase() && !coverOf(p[1])).map(p => p[1]);
}

/** every profile whole, as the game wrote it (its checksums hold): none was read halfway through a save */
const wholeProfiles = (files: SaveFile[]) => files.every(f => {
  const p = f.path.split('/');
  if (p.length !== 3 || p[0] !== PROFILES_DIR || p[1].toLowerCase() !== p[2].toLowerCase() || coverOf(p[1])) return true;
  const r = profileName(f.data);
  return 'name' in r && !r.edited;
});

// ------------------------------------------------------------- the server --

/** A version on the server: its rev (the ETag), when it was saved, when the copy of an earlier day was (null: none). */
export interface Remote { rev: string; saved: number; earlier: number | null }
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

function remoteOf(r: Response): Remote | null {
  const rev = r.headers.get('etag'), saved = Number(r.headers.get('x-vault-saved')), e = r.headers.get('x-vault-earlier');
  return rev && saved ? { rev, saved, earlier: e ? Number(e) : null } : null;
}

function failure(r: Response): VaultError {
  return new VaultError(r.status === 429 ? 'the server asks this address to wait a minute (too many requests)'
    : r.status === 507 ? 'the server has no room for more saves now'
    : r.status === 503 ? 'the server takes no more new keyphrases for now: try again in an hour'
    : r.status === 413 ? 'these saves are larger than the server takes'
    : `the server answered ${r.status}`);
}

const incomplete = () => new VaultError('the server\'s answer is incomplete');

/** /vault for one keyphrase's token. */
export class VaultApi {
  /** timeoutMs: each request's answer, at most */
  constructor(private token: string, private f: Fetch = (u, i) => fetch(u, i), private timeoutMs = 30_000) {}

  private req(method: string, headers: Record<string, string> = {}, body?: Uint8Array, query = '') {
    return this.f(`/vault${query}`, {
      method, headers: { authorization: `Bearer ${this.token}`, ...headers }, body: body as BodyInit | undefined, cache: 'no-store',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  /** The current version (or the copy of an earlier day), null when there is none; { same } when it is still `rev`. */
  async get(rev?: string | null, earlier = false): Promise<{ box: Uint8Array; remote: Remote } | { same: Remote } | null> {
    const r = await this.req('GET', rev && !earlier ? { 'if-none-match': rev } : {}, undefined, earlier ? '?earlier' : '');
    if (r.status === 404) return null;
    const remote = remoteOf(r);
    if (r.status === 304) { if (!remote) throw incomplete(); return { same: remote }; }
    if (!r.ok) throw failure(r);
    if (!remote) throw incomplete();
    return { box: new Uint8Array(await r.arrayBuffer()), remote };
  }

  /** Saved over `rev` (null: as a new keyphrase), or what is there instead (null: nothing). */
  async put(box: Uint8Array, rev: string | null): Promise<{ saved: Remote } | { conflict: Remote | null }> {
    const r = await this.req('PUT', rev ? { 'if-match': rev } : { 'if-none-match': '*' }, box);
    if (r.status === 412) return { conflict: remoteOf(r) };
    if (!r.ok) throw failure(r);
    const remote = remoteOf(r);
    if (!remote) throw incomplete();
    return { saved: remote };
  }

  /** The keyphrase and its versions gone from the server: false when there was none. */
  async remove(): Promise<boolean> {
    const r = await this.req('DELETE');
    if (r.status === 404) return false;
    if (!r.ok) throw failure(r);
    return true;
  }
}

/** Whether this server keeps keyphrase saves: /vault without a token answers 401 there (404 on one without). */
export async function vaultAvailable(f: Fetch = (u, i) => fetch(u, i)): Promise<boolean> {
  try { return (await f('/vault', { cache: 'no-store' })).status === 401; } catch { return false; }
}

// ------------------------------------------------------------- syncing --

/** This browser's keyphrase and the version of its saves it has. */
export interface Link {
  phrase: string;
  /** the version this browser sent or took (its ETag) */
  rev: string;
  /** contentHash of the files here as they were then */
  hash: string;
  /** when that version was saved (the server's clock), and the copy of an earlier day (null: none) */
  saved: number;
  earlier: number | null;
  /** its profiles */
  profiles: number;
}

export interface VaultDeps {
  /** the files of the save folder a keyphrase keeps (keeps()) */
  files(): Promise<SaveFile[]>;
  /** a keyphrase's version in place of the saves here (its zip): throws when it may not be written now */
  restore(zip: Uint8Array): Promise<void>;
  /** the link kept in this browser */
  load(): Link | null;
  save(l: Link | null): void;
  fetch?: Fetch;
}

export type SyncState =
  | { s: 'off' }
  | { s: 'synced' }
  | { s: 'working'; what: string }
  /** both changed ('both'), or no profile here while the keyphrase keeps some ('empty'): the player picks */
  | { s: 'conflict'; why: 'both' | 'empty'; theirs: Remote | null }
  /** the last try failed: the next save, Play or Sync now tries again */
  | { s: 'error'; msg: string }
  /** the keyphrase is not on the server any more (deleted in another browser, or two years unused): unlinked */
  | { s: 'gone' };

/** a failure's words for the player */
export function failureText(e: unknown): string {
  return e instanceof VaultError ? e.message : e instanceof TypeError ? 'the server does not answer'
    : e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'the server did not answer in time'
    : String(e instanceof Error ? e.message : e);
}

export class VaultSync {
  link: Link | null;
  state: SyncState;
  onChange: () => void = () => {};
  /** another browser's version came in (pull, takeTheirs) */
  onTaken: (r: Remote) => void = () => {};
  private keys: { phrase: string; k: Keys } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private d: VaultDeps) {
    this.link = d.load();
    this.state = this.link ? { s: 'synced' } : { s: 'off' };
  }

  private async keysFor(phrase: string): Promise<Keys> {
    if (this.keys?.phrase !== phrase) this.keys = { phrase, k: await keysOf(phrase) };
    return this.keys.k;
  }
  private api(k: Keys, timeoutMs?: number) { return new VaultApi(k.token, this.d.fetch, timeoutMs); }
  private set(state: SyncState) { this.state = state; this.onChange(); }
  private setLink(l: Link | null) { this.link = l; this.d.save(l); }

  /** one job at a time, in order: its state while it runs, a failure's words after */
  private run<T>(what: string, job: () => Promise<T>): Promise<T> {
    const p = this.queue.then(async () => {
      this.set({ s: 'working', what });
      try { return await job(); }
      catch (e) { this.set({ s: 'error', msg: failureText(e) }); throw e; }
      finally { if (this.state.s === 'working') this.set(this.link ? { s: 'synced' } : { s: 'off' }); }
    });
    this.queue = p.catch(() => {});
    return p;
  }

  private async boxOf(k: Keys, files: SaveFile[]): Promise<Uint8Array> {
    const box = await seal(k.key, await pack(files));
    if (box.length > MAX_BOX) throw new VaultError(`these saves pack into ${Math.ceil(box.length / 1024)} KB, more than the server takes (${MAX_BOX >> 10} KB)`);
    return box;
  }

  private linked(phrase: string, r: Remote, hash: string, files: SaveFile[]) {
    this.setLink({ phrase, rev: r.rev, hash, saved: r.saved, earlier: r.earlier, profiles: profilesIn(files).length });
  }

  private gone() { this.setLink(null); this.set({ s: 'gone' }); }

  /** A new keyphrase for the saves here, their first version sent: the keyphrase. */
  create(): Promise<string> {
    return this.run('Making keyphrase', async () => {
      for (;;) {
        const phrase = newPhrase(), k = await this.keysFor(phrase), files = await this.d.files();
        const r = await this.api(k).put(await this.boxOf(k, files), null);
        if ('conflict' in r) continue;                  // one of 2^83 taken already: never, but not this one
        this.linked(phrase, r.saved, await contentHash(files), files);
        return phrase;
      }
    });
  }

  /** What a keyphrase holds (its zip, for the player to look at before it replaces the saves here), or null: none. */
  peek(phrase: string, earlier = false): Promise<{ zip: Uint8Array; remote: Remote } | null> {
    return this.run('Loading', async () => {
      const k = await this.keysFor(phrase), r = await this.api(k).get(null, earlier);
      if (!r || 'same' in r) return null;
      return { zip: await unpack(await unseal(k.key, r.box)), remote: r.remote };
    });
  }

  /** The saves here are a keyphrase's version now (the player restored what peek() gave): this browser follows it. */
  adopt(phrase: string, remote: Remote): Promise<void> {
    return this.run('Linking', async () => {
      const files = await this.d.files();
      this.linked(phrase, remote, await contentHash(files), files);
    });
  }

  /** a version's files */
  private async filesOf(k: Keys, box: Uint8Array): Promise<SaveFile[]> {
    return (await unzip(await unpack(await unseal(k.key, box)))).map(e => ({ path: e.name, data: e.data, mtime: e.mtime }));
  }

  /** a version in place of the saves here, and the link to it */
  private async take(phrase: string, k: Keys, box: Uint8Array, remote: Remote) {
    await this.d.restore(await unpack(await unseal(k.key, box)));
    const files = await this.d.files();
    this.linked(phrase, remote, await contentHash(files), files);
    this.onTaken(remote);
  }

  /** Another browser's newer version, taken when the saves here did not change since they synced (timeoutMs: the server's answer, at most). */
  pull(o: { timeoutMs?: number } = {}): Promise<void> {
    if (!this.link || this.state.s === 'conflict') return Promise.resolve();
    return this.run('Checking', async () => {
      const l = this.link!, k = await this.keysFor(l.phrase), r = await this.api(k, o.timeoutMs).get(l.rev);
      if (!r) return this.gone();
      if ('same' in r) { if (r.same.earlier !== l.earlier) this.setLink({ ...l, earlier: r.same.earlier }); return; }
      const files = await this.d.files(), hash = await contentHash(files);
      if (hash === l.hash) return this.take(l.phrase, k, r.box, r.remote);
      // both changed: to the same (a settings.ini both pages brought up to date)?
      if (await contentHash(await this.filesOf(k, r.box)) === hash) return this.linked(l.phrase, r.remote, hash, files);
      this.set({ s: 'conflict', why: 'both', theirs: r.remote });
    });
  }

  /**
   * The saves here sent, when they changed since they synced.  playing: a game runs, so a profile read halfway
   * through a save (its checksums do not hold) waits for the next save or the game's end.
   */
  push(o: { playing?: boolean } = {}): Promise<void> {
    if (!this.link || this.state.s === 'conflict') return Promise.resolve();
    return this.run('Syncing', async () => {
      const l = this.link!, files = await this.d.files();
      if (o.playing && !wholeProfiles(files)) return;
      const hash = await contentHash(files);
      if (hash === l.hash) return;
      if (!profilesIn(files).length && l.profiles > 0) return this.set({ s: 'conflict', why: 'empty', theirs: null });
      const k = await this.keysFor(l.phrase), r = await this.api(k).put(await this.boxOf(k, files), l.rev);
      if ('saved' in r) return this.linked(l.phrase, r.saved, hash, files);
      if (!r.conflict) return this.gone();
      this.set({ s: 'conflict', why: 'both', theirs: r.conflict });
    });
  }

  /** A conflict settled for the saves here: sent over whatever the keyphrase has. */
  keepMine(): Promise<void> {
    const st = this.state;
    if (!this.link || st.s !== 'conflict') return Promise.resolve();
    return this.run('Syncing', async () => {
      const l = this.link!, files = await this.d.files(), hash = await contentHash(files), k = await this.keysFor(l.phrase);
      const box = await this.boxOf(k, files), api = this.api(k);
      let r = await api.put(box, st.theirs?.rev ?? l.rev);
      if ('conflict' in r && r.conflict) r = await api.put(box, r.conflict.rev);
      if ('saved' in r) return this.linked(l.phrase, r.saved, hash, files);
      if (!r.conflict) return this.gone();
      this.set({ s: 'conflict', why: 'both', theirs: r.conflict });
    });
  }

  /** A conflict settled for the keyphrase's version: it replaces the saves here. */
  takeTheirs(): Promise<void> {
    if (!this.link || this.state.s !== 'conflict') return Promise.resolve();
    return this.run('Loading', async () => {
      const l = this.link!, k = await this.keysFor(l.phrase), r = await this.api(k).get();
      if (!r) return this.gone();
      if ('box' in r) await this.take(l.phrase, k, r.box, r.remote);
    });
  }

  /** This browser stops syncing (after what it is doing); the saves stay here and on the server. */
  forget(): Promise<void> {
    return this.run('Stopping', async () => this.setLink(null));
  }

  /** The keyphrase and its versions deleted from the server, and this browser unlinked. */
  remove(): Promise<void> {
    if (!this.link) return Promise.resolve();
    return this.run('Deleting', async () => {
      const k = await this.keysFor(this.link!.phrase);
      await this.api(k).remove();
      this.setLink(null);
    });
  }
}
