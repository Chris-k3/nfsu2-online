// Cloud saves, the last part of the Saves section (index.html #vault): keyphrase saves (vault.ts) made, loaded from
// another browser, synced, settled when two browsers changed them, gone back a day, stopped or deleted.  Shown only
// where the server keeps them (vaultAvailable).  One box holds the keyphrase in every state: the one this browser
// syncs with (read only, with its download), or one typed in to load.  It shows the first 3 characters and dots for
// the rest until its eye shows it all.  Only the tab that owns the saves syncs (instance.ts); the link (the keyphrase
// and the version it has) is kept in this browser's localStorage, beside the saves it is for.
//
// When it syncs: the page opens (or this tab takes the saves over), Play (newer saves from another browser come in
// first, 4 s at most), 10 s after the game's last save of a burst, when the game ends, a few seconds after the Saves
// or Settings section changed the files, and Sync now.

import { listFiles, readBytes } from './savefs';
import { backupItems, readVault, restoreVault } from './saves-ui';
import { downloadBlob } from './logs';
import { kept, keeps, keptBy, readPhrase, vaultAvailable, VaultError, VaultSync, type Link, type Remote, type SaveFile } from './vault';
import { codeOf, dateLocale, live, N, t, tn, tvars, type Msg } from './i18n';

export interface VaultPanelDeps {
  saveDir: string;
  /** this tab owns the saves (another tab of this browser only looks) */
  owner(): boolean;
  /** a game runs in this tab */
  playing(): boolean;
  /** a game runs or starts here, or another tab owns the saves: nothing writes into them from this section */
  busy(): boolean;
  confirm(title: string, body: Node | string, ok: string, danger?: boolean): Promise<boolean>;
  /** the saves here were replaced: the Saves list and the settings again */
  onRestored(): void;
  log(s: string): void;
}

/** where a save folder's link is kept (localStorage) */
const linkKey = (saveDir: string) => `nfsu2-keyphrase:${saveDir}`;

/** A save folder emptied (a test page's &fresh): its link goes too, or the page would sync an empty folder. */
export function forgetLink(saveDir: string) {
  try { localStorage.removeItem(linkKey(saveDir)); } catch { /* storage off */ }
}

const today = (d: Date) => d.toDateString() === new Date().toDateString();
const clock = (d: Date) => d.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
/** "14:05" today, "21 Oct" before */
function short(at: number): string {
  const d = new Date(at);
  return today(d) ? clock(d) : d.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' });
}
/** "today at 14:05", "21 Oct 2026, 14:05" */
function when(at: number): string {
  const d = new Date(at);
  return today(d) ? t('today at {time}', { time: clock(d) }) : `${d.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' })}, ${clock(d)}`;
}
/** the box's dots: the first 3 characters, then one dot each */
export const masked = (s: string) => s.slice(0, 3) + '•'.repeat(Math.max(0, s.length - 3));

const QUIT_FIRST = N('Quit the game first.');

export class VaultPanel {
  private sync: VaultSync | null = null;
  /** this tab owns the saves, and its settings are loaded: it may sync */
  private owned = false;
  /** the box shows dots after the first 3 characters */
  private hidden = true;
  /** the box holds the linked keyphrase (not one typed in) */
  private holdsLink = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** when check() last asked the server (a tab shown again asks at most once a minute) */
  private checked = 0;
  /** Play stopped waiting for the server: no version replaces the saves until the game ends (check()) */
  private held = false;
  private readonly key: string;
  private readonly input: HTMLInputElement;

  constructor(private root: HTMLElement, private d: VaultPanelDeps) {
    this.key = linkKey(d.saveDir);
    this.input = this.$<HTMLInputElement>('#vault-input');
    const on = (id: string, f: () => unknown) => { this.$<HTMLButtonElement>(id).onclick = () => void f(); };
    on('#vault-make', () => this.make());
    // shown, it is selected, and the linked keyphrase copied
    on('#vault-eye', async () => {
      this.hidden = !this.hidden;
      this.mask();
      if (this.hidden || !this.input.value) return;
      this.input.focus(); this.input.select();
      if (!this.sync?.link) return;
      try { await navigator.clipboard.writeText(this.input.value); this.msg(() => t('Copied.')); } catch { /* the selection is there to copy */ }
    });
    on('#vault-file', () => { if (this.sync?.link) downloadBlob(`${this.sync.link.phrase}\n`, 'nfsu2-keyphrase.txt', 'text/plain'); });
    on('#vault-sync', () => this.syncNow());
    on('#vault-earlier', () => this.goBack());
    on('#vault-stop', () => this.stop());
    on('#vault-delete', () => this.remove());
    on('#vault-mine', () => this.keepMine());
    on('#vault-theirs', () => this.takeTheirs());
    this.$<HTMLFormElement>('#vault-form').onsubmit = e => { e.preventDefault(); if (!this.sync?.link) void this.use(this.input.value); };
    // the dots follow the field's text and its scrolling
    for (const ev of ['input', 'scroll', 'keyup', 'select', 'pointerup', 'focus']) this.input.addEventListener(ev, () => this.mask());
  }

  private $<T extends HTMLElement = HTMLElement>(sel: string) { return this.root.querySelector<T>(sel)!; }
  /** the line under the buttons, drawn again when the page's language changes (a Msg); code: a failure's name */
  private msg(s: string | Msg, warn = false, code?: string) {
    const m = this.$('#vault-msg');
    live(m, typeof s === 'string' ? () => s : s, code); m.classList.toggle('warn', warn);
  }

  /** the box's dots (or not), and its eye */
  private mask() {
    const m = this.$('#vault-mask'), eye = this.$('#vault-eye');
    this.$('#vault-box').classList.toggle('masked', this.hidden);
    m.textContent = masked(this.input.value);
    m.scrollLeft = this.input.scrollLeft;
    eye.setAttribute('aria-pressed', String(!this.hidden));
    eye.setAttribute('aria-label', this.hidden ? t('Show keyphrase') : t('Hide keyphrase'));
  }

  private load(): Link | null {
    try { const t = localStorage.getItem(this.key); return t ? JSON.parse(t) as Link : null; } catch { return null; }
  }
  private save(l: Link | null) {
    try { if (l) localStorage.setItem(this.key, JSON.stringify(l)); else localStorage.removeItem(this.key); } catch { /* storage off: this page's link only */ }
  }

  /** a VaultSync on the link kept now (another tab may have changed it while this one only looked) */
  private makeSync() {
    const s = new VaultSync({ files: o => this.files(o), restore: zip => this.restore(zip), load: () => this.load(), save: l => this.save(l) });
    s.onChange = () => this.show();
    s.onTaken = r => {
      this.msg(() => t('Saves from your other browser came in ({when}).', { when: short(r.saved) }));
      this.d.log('[app] keyphrase: the saves another browser sent came in');
    };
    this.sync = s;
  }

  /** Shows the section when this server keeps keyphrase saves. */
  async start() {
    if (!await vaultAvailable()) return;
    this.makeSync();
    this.root.hidden = false;
    this.show();
    if (this.owned) this.check();
  }

  /** This tab owns the saves now and has loaded its settings: it syncs from here on. */
  ownerNow() {
    this.owned = true;
    if (!this.sync) return;
    this.makeSync();
    this.show();
    this.check();
  }

  /** newer saves from another browser in, then these out when they changed */
  private check() {
    const s = this.sync;
    if (!s?.link || !this.d.owner() || this.d.busy()) return;
    this.checked = Date.now();
    this.held = false;
    void s.pull().then(() => s.push()).catch(() => {});
  }

  /** The tab is shown again: newer saves from another browser, at most once a minute. */
  shown() { if (Date.now() - this.checked > 60_000) this.check(); }

  /** the files of the save folder as a keyphrase keeps them (was: as a link of that version counted them) */
  private async files(o: { was?: number } = {}): Promise<SaveFile[]> {
    const out: SaveFile[] = [], want = o.was ? keptBy(o.was) : keeps;
    for (const f of await listFiles(this.d.saveDir))
      if (want(f.path)) out.push({ path: f.path, data: await readBytes(this.d.saveDir, f.path), mtime: f.mtime });
    return o.was ? out : kept(out);
  }

  /** a version of the keyphrase's (its zip) in place of the saves here, when no game uses them */
  private async restore(zip: Uint8Array) {
    if (this.d.playing() || this.held || !this.d.owner()) throw new VaultError(N('a game is running here: the other browser\'s saves come in after it'), 'VAULT-PLAYING');
    await restoreVault(this.d.saveDir, await readVault(zip));
    this.d.onRestored();
  }

  // ---- when it syncs ----

  /** The game saved a profile: sent 10 s after the last save of a burst. */
  saved() { this.later(10_000); }
  /** The Saves or Settings section changed the files: sent in a few seconds. */
  changed() { this.later(3000); }
  private later(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (this.d.owner()) void this.sync?.push({ playing: this.d.playing() }).catch(() => {}); }, ms);
  }
  /** The game ended: newer saves from another browser in (when none came here), then what it saved goes. */
  gameEnded() {
    clearTimeout(this.timer);
    this.show();
    this.check();
  }
  /**
   * Before a game: newer saves from another browser come in first (the server asked for 4 s at most, 5 s in all with
   * a job of the section's before it).  True when they did.  Given up on, what comes later waits for the game's end.
   */
  async beforePlay(): Promise<boolean> {
    const s = this.sync;
    this.held = false;
    if (!s?.link || !this.d.owner() || this.d.playing()) return false;
    const before = s.link.rev;
    const done = await Promise.race([s.pull({ timeoutMs: 4000 }).then(() => true, () => true), new Promise<boolean>(r => setTimeout(r, 5000, false))]);
    if (!done) this.held = true;
    return !!s.link && s.link.rev !== before;
  }
  /** A game started or ended, or this tab's ownership changed: the buttons again. */
  refresh() { this.show(); }

  // ---- the buttons ----

  private async make() {
    if (!this.sync || !this.d.owner()) return;
    try {
      await this.sync.create();
      this.hidden = false;
      this.show();
      this.msg(() => t('Keyphrase made. Keep it safe: it is the only way back to these saves.'));
      this.d.log('[app] keyphrase: made one, the saves went to the server');
    } catch { /* the state says why */ }
  }

  private async use(text: string) {
    const s = this.sync;
    if (!s) return;
    const p = readPhrase(text);
    if ('bad' in p) { const w = p.why; this.msg(() => tvars(w.t, w.v), true); return; }
    if (this.d.busy()) { this.msg(() => t(QUIT_FIRST), true); return; }
    let got: Awaited<ReturnType<VaultSync['peek']>>;
    try { got = await s.peek(p.phrase); } catch { return; }
    if (!got) { this.msg(() => t('No cloud saves for this keyphrase. Check it for typos.'), true); return; }
    if (await this.replace(got, t('Load cloud saves?'),
      t('They replace the profiles and settings.ini here with the ones saved {when}. Screenshots stay, and so do this device\'s graphics, frame rate, sound output and controller settings.', { when: when(got.remote.saved) }), t('Load'))) {
      await s.adopt(p.phrase, got.remote).catch(() => {});
      this.msg(() => t('Loaded. This browser syncs from now on.'));
      this.d.log('[app] keyphrase: loaded its saves, this browser syncs with it');
    }
  }

  /** what a version brings, asked; then it replaces the saves here.  False: nothing changed. */
  private async replace(got: { zip: Uint8Array; remote: Remote }, title: string, text: string, ok: string): Promise<boolean> {
    let r: Awaited<ReturnType<typeof readVault>>;
    try { r = await readVault(got.zip); } catch (e) { this.msg(() => t('These saves cannot be read: {error}.', { error: e instanceof Error ? e.message : String(e) }), true, 'VAULT-UNREADABLE'); return false; }
    const body = document.createElement('div'), p = document.createElement('p'), ul = document.createElement('ul');
    p.textContent = text;
    for (const t of backupItems(r, true)) { const li = document.createElement('li'); li.textContent = t; ul.append(li); }
    body.append(p, ul);
    if (!await this.d.confirm(title, body, ok, (await listFiles(this.d.saveDir)).some(f => keeps(f.path)))) { this.msg(''); return false; }
    if (this.d.busy()) { this.msg(() => t(QUIT_FIRST), true); return false; }
    try { await restoreVault(this.d.saveDir, r); }
    catch (e) { this.msg(() => t('Loading stopped halfway: {error}. Load again before playing.', { error: e instanceof Error ? e.message : String(e) }), true, 'VAULT-LOAD-HALFWAY'); return false; }
    finally { this.d.onRestored(); }
    return true;
  }

  private async syncNow() {
    const s = this.sync;
    if (!s?.link || this.d.busy()) return;
    this.msg('');
    try { await s.pull(); await s.push(); } catch { return; /* the state says why */ }
    // the server has no saves for the keyphrase: the ones here go there again, if the player says so
    if (!s.link?.gone || !await this.d.confirm(t('Send these saves to the cloud again?'),
      t('The cloud has no saves for this keyphrase now. The saves here go there under the same keyphrase, and your other browsers with it sync again.'), t('Send'))) return;
    try { await s.resend(); this.msg(() => t('Sent. This browser syncs again.')); this.d.log('[app] keyphrase: its saves were gone from the server, sent again'); }
    catch { /* the state says why */ }
  }

  private async goBack() {
    const s = this.sync, l = s?.link;
    if (!s || !l?.earlier) return;
    if (this.d.busy()) { this.msg(() => t(QUIT_FIRST), true); return; }
    let got: Awaited<ReturnType<VaultSync['peek']>>;
    try { got = await s.peek(l.phrase, true); } catch { return; }
    if (!got) { this.msg(() => t('The cloud has no earlier copy now.'), true); return; }
    const at = got.remote.saved;
    if (await this.replace(got, t('Go back to {when}?', { when: short(at) }),
      t('The cloud copy from {when} replaces the saves here and becomes the latest. Progress since then is lost. Screenshots stay.', { when: when(at) }), t('Go back'))) {
      this.msg(() => t('Back to {when}.', { when: short(at) }));
      this.d.log('[app] keyphrase: went back to the copy of an earlier day');
      await s.push().catch(() => {});
    }
  }

  private async stop() {
    const s = this.sync;
    if (!s?.link) return;
    if (!await this.d.confirm(t('Stop syncing here?'), t('Your saves stay here and in the cloud. To sync again, you need the keyphrase.'), t('Stop syncing'))) return;
    const phrase = s.link.phrase;
    await s.forget().catch(() => {});
    // the keyphrase stays in the box, to keep or to load again (the job's end showed the box empty)
    this.holdsLink = false;
    this.input.value = phrase;
    this.show();
    this.msg(() => t('Stopped syncing. Your saves stay here and in the cloud.'));
  }

  private async remove() {
    const s = this.sync;
    if (!s?.link) return;
    if (!await this.d.confirm(t('Delete your cloud saves?'), t('They are deleted from the server now, with the earlier copy. This browser keeps its saves; other browsers stop syncing.'),
      t('Delete'), true)) return;
    try {
      await s.remove();
      this.msg(() => t('Deleted from the cloud. Your saves stay here.'));
      this.d.log('[app] keyphrase: its saves were deleted from the server');
    } catch { /* the state says why */ }
  }

  /** a conflict settled for the saves here; with no profile here, only once the player says so (every browser that
   *  syncs with the keyphrase loses its profiles then) */
  private async keepMine() {
    const s = this.sync, st = s?.state;
    if (!s?.link || st?.s !== 'conflict') return;
    const n = s.link.profiles;
    if (st.why === 'empty' && !await this.d.confirm(t('Keep this browser\'s saves?'),
      tn(n, 'This browser has no profiles. The cloud\'s profile is deleted, here and in every browser that syncs with this keyphrase.',
        'This browser has no profiles. The cloud\'s {n} profiles are deleted, here and in every browser that syncs with this keyphrase.'), t('Keep this browser\'s'), true)) return;
    await s.keepMine().catch(() => {});
  }

  /** a conflict settled for the keyphrase's version; one with no profile, only once the player says so */
  private async takeTheirs() {
    const s = this.sync, st = s?.state;
    if (!s?.link || st?.s !== 'conflict') return;
    if (this.d.busy()) { this.msg(() => t(QUIT_FIRST), true); return; }
    if (st.why === 'bare' && !await this.d.confirm(t('Use the cloud\'s saves?'),
      t('They have no profiles: the profiles here are deleted.'), t('Use the cloud\'s'), true)) return;
    if (this.d.busy()) { this.msg(() => t(QUIT_FIRST), true); return; }
    await s.takeTheirs().catch(() => {});
  }

  // ---- what it shows ----

  private show() {
    const s = this.sync;
    if (!s) return;
    const l = s.link, st = s.state, owner = this.d.owner(), busy = this.d.busy();
    const working = st.s === 'working';
    // beside the heading: Enable cloud saving, or what it is doing, or when it last synced
    this.$('#vault-make').hidden = !!l || working;
    const note = this.$('#vault-when');
    note.hidden = !l && !working;
    note.textContent = st.s === 'working' ? `${t(st.what)}…` : l ? t('Synced {when}', { when: short(l.saved) }) : '';
    // the box: the linked keyphrase (read only, with its download), or one to type in and load
    if (l) { this.input.value = l.phrase; this.holdsLink = true; }
    else if (this.holdsLink) { this.input.value = ''; this.holdsLink = false; }
    this.input.readOnly = !!l;
    this.$('#vault-file').hidden = !l;
    this.$('#vault-load').hidden = !!l;
    this.$('#vault-about').hidden = !!l;
    this.mask();
    this.$('#vault-on').hidden = !l;
    const earlier = this.$<HTMLButtonElement>('#vault-earlier');
    earlier.hidden = !l?.earlier;
    if (l?.earlier) earlier.textContent = t('Go back to {when}', { when: short(l.earlier) });
    const conflict = st.s === 'conflict' ? st : null;
    this.$('#vault-conflict').hidden = !conflict || !l;
    for (const id of ['#vault-make', '#vault-mine', '#vault-delete', '#vault-stop']) this.$<HTMLButtonElement>(id).disabled = !owner || working;
    for (const id of ['#vault-sync', '#vault-earlier', '#vault-theirs', '#vault-load']) this.$<HTMLButtonElement>(id).disabled = busy || working;
    // under it, only what needs the player: another tab syncs, a failure, a conflict, the keyphrase gone
    const n = l?.profiles ?? 0, theirs = conflict?.theirs ? short(conflict.theirs.saved) : '';
    const failed = st.s === 'error' ? tvars(st.why.t, st.why.v) : '';
    const status = this.$('#vault-status');
    status.textContent = !owner && l ? t('Another tab is syncing these saves.')
      : st.s === 'error' ? (l ? t('Sync failed: {error}. It tries again at the next save.', { error: failed }) : t('{Error}.', { Error: `${failed[0]?.toUpperCase() ?? ''}${failed.slice(1)}` }))
      : st.s === 'gone' ? t('The cloud has no saves for this keyphrase now: deleted in another browser, unused for 2 years, or lost on the server. Nothing is sent; Sync now looks again and can send these saves there.')
      : conflict?.why === 'empty' ? tn(n, 'No profiles here, but the cloud has one. Nothing was sent.', 'No profiles here, but the cloud has {n}. Nothing was sent.')
      : conflict?.why === 'bare' ? (theirs ? tn(n, 'The cloud\'s saves from {when} have no profiles, but this browser has one. Keep which?', 'The cloud\'s saves from {when} have no profiles, but this browser has {n}. Keep which?', { when: theirs })
        : tn(n, 'The cloud\'s saves have no profiles, but this browser has one. Keep which?', 'The cloud\'s saves have no profiles, but this browser has {n}. Keep which?'))
      : conflict?.why === 'older' && l ? (theirs ? t('The cloud has older saves ({when}) than this browser\'s ({mine}): the server lost the newer ones. Keep which?', { when: theirs, mine: short(l.saved) })
        : t('The cloud has older saves than this browser\'s ({mine}): the server lost the newer ones. Keep which?', { mine: short(l.saved) }))
      : conflict ? (theirs ? t('Changed here and in another browser ({when}). Keep which?', { when: theirs }) : t('Changed here and in another browser. Keep which?'))
      : '';
    if (st.s === 'error' && st.code && (owner || !l)) status.append(codeOf(st.code));
  }
}
