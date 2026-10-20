// The saves section of the start page: the profiles in this browser (each can
// be renamed: profile.ts renameProfile), a backup of the whole save
// overlay as a zip (profiles, registry.txt, settings.ini, screenshots) and
// restoring one.  And the section at the bottom of the page, the game data on
// this PC: how much of it is kept (gamedata.ts), or deleted.  Its download
// button stays, off, with the reason: downloading all of it ahead is off while
// the server's bandwidth cannot keep up.  The game data is never part of a
// backup and never written back: it stays on the server.

import { cacheBytes, clearCache, clearSaveDir, filesOf, listFiles, listProfiles, PROFILES_DIR, readBytes, writeFile, type Profile } from './savefs';
import { NAME_MAX, renameProfile } from './profile';
import { listZip, unzip, zip, ZipError, type ZipEntry } from './zip';
import { downloadBlob, stamp } from './logs';
import { fmtBytes } from './checks';
import { resolveEnv } from './settings';
import { gameDataKept } from './gamedata';

export interface SavesDeps {
  saveDir: string;
  /** true while a game runs in this tab: no rename, no restore, no cache delete */
  busy(): boolean;
  confirm(title: string, body: Node | string, ok: string, danger?: boolean): Promise<boolean>;
  /** after a restore: settings.ini may have changed */
  onRestored(): void;
}

// Limits for a restore, judged by each entry's declared size before anything is
// inflated, and held while inflating (zip.ts stops an entry at its declared
// size: a 4 MB zip that declares 100 bytes and inflates to 4 GB is refused
// after 100, the audit's PAGE-4).  Screenshots (F12, about 24 MB each at this Mac's native size) have
// their own budget, so however many a backup holds they never crowd out the
// profiles, registry.txt or settings.ini (phase-1 app review, finding 5).
const MAX_ENTRY = 64 << 20, MAX_SHOTS = 512 << 20, MAX_OTHER = 256 << 20;
/** an F12 screenshot: an image file at the top of the save folder (nfsu2000.tga ...) */
export const isScreenshot = (path: string) => !path.includes('/') && /\.(tga|bmp|png|jpe?g)$/i.test(path);

/**
 * What a backup's settings.ini would change that a player should know before restoring it: the network
 * (free roam on, the name shown to others), variables set by their own names, and lines the page ignores
 * (files and automation are the page's own).  [] when it holds none of these.
 */
export function settingsWarnings(text: string): string[] {
  const r = resolveEnv(text, {}, {});
  const set = (k: string) => r.source[k] === 'settings.ini';
  const out: string[] = [];
  const net = Object.keys(r.env).filter(k => set(k) && /^NFSU2_(ROAM|NET|LAN)/.test(k)).map(k => `${k}=${r.env[k]}`);
  if (set('NFSU2_ROAM') && parseInt(r.env.NFSU2_ROAM, 10) === 1)
    out.push(`It turns on free-roam multiplayer: your profile name${set('NFSU2_ROAM_NAME') ? ` (shown as "${r.env.NFSU2_ROAM_NAME}")` : ''}, car and position go to the other players on this server.`);
  if (net.length) out.push(`Network settings: ${net.join(', ')}`);
  const raw = r.other.filter(o => !o.refused).map(o => `${o.key} = ${o.value}`);
  if (raw.length) out.push(`Variables set by their own names: ${raw.slice(0, 6).join(', ')}${raw.length > 6 ? ' …' : ''}`);
  const ignored = r.other.filter(o => o.refused === 'only the page sets it').map(o => o.key);
  if (ignored.length) out.push(`Ignored, only the page sets them: ${ignored.join(', ')}`);
  return out;
}

/** A path from a backup that may be written into the save overlay, or null. */
export function safeEntryPath(name: string): string | null {
  const n = name.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return null;
  const parts = n.split('/').filter(p => p !== '' && p !== '.');
  if (!parts.length || parts.some(p => p === '..' || p.length > 255 || /[\x00-\x1f]/.test(p))) return null;
  return parts.join('/');
}

export async function exportSaves(saveDir: string): Promise<{ zip: Uint8Array; files: number; name: string; shotBytes: number }> {
  const files = await listFiles(saveDir);
  const entries: ZipEntry[] = [];
  let shotBytes = 0;
  for (const f of files) {
    if (f.path === 'autotest-script.txt') continue;          // a test run's input script, not a save
    const data = await readBytes(saveDir, f.path);
    if (isScreenshot(f.path)) shotBytes += data.length;
    entries.push({ name: f.path, data, mtime: f.mtime });
  }
  return { zip: zip(entries), files: entries.length, name: `nfsu2-saves-${stamp()}.zip`, shotBytes };
}

export interface Restore { entries: { path: string; data: Uint8Array; mtime?: number }[]; profiles: string[]; skipped: string[] }

export async function readBackup(buf: Uint8Array): Promise<Restore> {
  // a backup zipped from a folder ("saves/NFS Underground 2/...") still restores: strip one common top folder
  const listed = await listZip(buf);
  const names = listed.map(n => safeEntryPath(n)).filter((x): x is string => !!x);
  const top = names.length && names.every(n => n.includes('/') && n.split('/')[0] === names[0].split('/')[0]) &&
    !names.some(n => n.startsWith(PROFILES_DIR + '/')) ? names[0].split('/')[0] + '/' : '';
  const local = (name: string) => { let p = safeEntryPath(name); if (p && top && p.startsWith(top)) p = p.slice(top.length); return p; };
  let shots = 0, other = 0;
  const refused: string[] = [];
  const all = await unzip(buf, (name, size) => {
    const p = local(name);
    if (!p || size > MAX_ENTRY) return false;
    if (isScreenshot(p)) return (shots += size) <= MAX_SHOTS || ((shots -= size), false);
    return (other += size) <= MAX_OTHER || ((other -= size), false);
  }, refused);
  const out: Restore = { entries: [], profiles: [], skipped: refused };
  for (const e of all) {
    const p = local(e.name)!;
    out.entries.push({ path: p, data: e.data, mtime: e.mtime });
    const s = p.split('/');
    if (s.length === 3 && s[0] === PROFILES_DIR && s[2].toLowerCase() === s[1].toLowerCase()) out.profiles.push(s[1]);
  }
  return out;
}

export async function restoreSaves(saveDir: string, r: Restore) {
  await clearSaveDir(saveDir);
  for (const e of r.entries) await writeFile(saveDir, e.path, e.data);
}

export class SavesPanel {
  /** root: the Saves section; dataPanel: Game data on this PC */
  constructor(private root: HTMLElement, private dataPanel: HTMLElement, private deps: SavesDeps) {
    root.querySelector<HTMLButtonElement>('#export')!.onclick = () => void this.doExport();
    const inp = root.querySelector<HTMLInputElement>('#import')!;
    inp.onchange = () => { const f = inp.files?.[0]; inp.value = ''; if (f) void this.doImport(f); };
    dataPanel.querySelector<HTMLButtonElement>('#clear-cache')!.onclick = () => void this.doClearCache();
  }

  private msg(s: string) { this.root.querySelector('#saves-msg')!.textContent = s; }
  private dataMsg(s: string, warn = false) { const m = this.dataPanel.querySelector('#data-msg')!; m.textContent = s; m.classList.toggle('warn', warn); }

  /** the game data in this browser: of the server's files (null: their list did not load), and all that is kept */
  private data: { have: number; total: number } | null = null;
  private kept = { bytes: 0, files: 0 };
  private counted = 0;                     // the latest count wins (one may start while the data is deleted)
  private profiles: Profile[] = [];
  /** the profile whose name is being edited; focusName: whose Rename button gets the focus when the list is shown */
  private renaming: string | null = null;
  private focusName: string | null = null;
  /** what the section is writing into the saves (a rename, a restore): settled() waits for it */
  private writing: Promise<unknown> = Promise.resolve();

  /** Resolves when the section writes nothing into the saves: a game starts after that. */
  settled(): Promise<void> { return this.writing.then(() => {}, () => {}); }
  private write<T>(job: Promise<T>): Promise<T> { this.writing = job; return job; }

  /** Show the profiles and the downloaded game data as they are now. */
  async refresh() {
    const files = await listFiles(this.deps.saveDir);
    this.profiles = await listProfiles(this.deps.saveDir, files);
    const busy = this.deps.busy();
    // a name being typed stays as it is (the list is shown again when the edit ends)
    if (!this.profiles.some(p => p.name === this.renaming)) { this.renaming = null; this.showProfiles(); }
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.profiles .rename-btn, .profiles .renaming [type="submit"]')) b.disabled = busy;
    this.root.querySelector<HTMLLabelElement>('.file-btn')!.toggleAttribute('aria-disabled', busy);
    this.root.querySelector<HTMLInputElement>('#import')!.disabled = busy;
    this.dataPanel.querySelector<HTMLButtonElement>('#clear-cache')!.disabled = busy;
    const waiting = /^Quit the game \(or close/;
    if (busy) { this.msg('Quit the game (or close the other tab that runs it) to rename a profile or restore a backup.'); this.dataMsg('Quit the game (or close the other tab that runs it) to change the game data.'); }
    else {
      if (waiting.test(this.root.querySelector('#saves-msg')!.textContent ?? '')) this.msg('');
      if (waiting.test(this.dataPanel.querySelector('#data-msg')!.textContent ?? '')) this.dataMsg('');
    }
    this.root.dataset.files = String(files.length);
    const n = ++this.counted;
    const [kept, data] = await Promise.all([cacheBytes(), gameDataKept().catch(() => null)]);
    if (n !== this.counted) return;
    this.kept = kept; this.data = data;
    this.showData();
  }

  /** What is kept, and the download button (off) with its reason while some of the data is not here. */
  private showData() {
    const info = this.dataPanel.querySelector('#cache-info')!;
    const d = this.data, rest = d ? d.total - d.have : 0;
    const fetchBtn = this.dataPanel.querySelector<HTMLButtonElement>('#fetch-all')!, off = this.dataPanel.querySelector<HTMLElement>('#fetch-off')!;
    fetchBtn.textContent = d && d.have ? `Download the rest (${fmtBytes(rest)})` : `Download the game data${d ? ` (${fmtBytes(d.total)})` : ''}`;
    fetchBtn.hidden = off.hidden = !!d && rest <= 0;
    if (d && rest <= 0)
      info.textContent = `The game data (${fmtBytes(d.total)}) is kept in this browser: the game loads it from this PC, not the network. Only the movies stream from the server, as they play` +
        `${'serviceWorker' in navigator ? ', and the game starts without the server too (offline, with the movies off)' : ''}. Deleting it only means downloading it again.`;
    else if (d ? d.have : this.kept.bytes)
      info.textContent = `${d ? `${fmtBytes(d.have)} of the game's ${fmtBytes(d.total)} (without the movies)` : fmtBytes(this.kept.bytes)} is kept in this browser, so the game loads that from this PC instead of the network. ` +
        'Deleting it only means downloading it again.';
    else
      info.textContent = 'Nothing downloaded yet. The game streams its data from the server as it needs it and keeps it here.';
  }

  /** The profiles, each with its Rename button, or the name being edited. */
  private showProfiles() {
    const ul = this.root.querySelector('#profiles')!, busy = this.deps.busy();
    let focus: HTMLElement | null = null;
    ul.replaceChildren();
    if (!this.profiles.length) {
      const li = document.createElement('li'); li.className = 'empty';
      li.textContent = 'No profiles yet. Create one in the game: it is saved in this browser.';
      ul.append(li);
    }
    for (const p of this.profiles) {
      const li = document.createElement('li');
      if (p.name === this.renaming) {
        const { form, input } = this.renameForm(p.name, busy);
        const help = document.createElement('p'); help.className = 'hint'; help.id = 'rename-help';
        help.textContent = `Letters and digits, up to ${NAME_MAX}, as in the game.`;
        const m = document.createElement('p'); m.className = 'msg warn'; m.id = 'rename-msg'; m.setAttribute('role', 'alert');
        li.className = 'renaming'; li.append(form, help, m); ul.append(li);
        focus = input;
        continue;
      }
      const n = document.createElement('span'); n.className = 'name'; n.textContent = p.name;
      const m = document.createElement('span'); m.className = 'meta';
      m.textContent = `saved ${new Date(p.mtime).toLocaleString()}, ${fmtBytes(p.size)}`;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'text-btn rename-btn'; b.textContent = 'Rename';
      b.setAttribute('aria-label', `Rename ${p.name}`); b.disabled = busy;
      b.onclick = () => { this.renaming = p.name; this.showProfiles(); };
      if (p.name === this.focusName) focus = b;
      li.append(n, m, b); ul.append(li);
    }
    this.focusName = null;
    if (focus) { focus.focus(); if (focus instanceof HTMLInputElement) focus.select(); }
  }

  private renameForm(name: string, busy: boolean) {
    const form = document.createElement('form'); form.className = 'row';
    const input = document.createElement('input');
    input.type = 'text'; input.value = name; input.maxLength = NAME_MAX; input.spellcheck = false; input.autocomplete = 'off';
    input.setAttribute('aria-label', `New name for ${name}`); input.setAttribute('aria-describedby', 'rename-help rename-msg');
    // what the game's field keeps: other characters never appear
    input.oninput = () => {
      const v = input.value, keep = (t: string) => t.replace(/[^A-Za-z0-9]/g, '');
      if (keep(v) === v) return;
      const at = keep(v.slice(0, input.selectionStart ?? v.length)).length;
      input.value = keep(v); input.setSelectionRange(at, at);
    };
    const ok = document.createElement('button'); ok.type = 'submit'; ok.className = 'btn'; ok.textContent = 'Rename'; ok.disabled = busy;
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'text-btn'; cancel.textContent = 'Cancel';
    cancel.onclick = () => this.endRename(name);
    form.append(input, ok, cancel);
    form.onsubmit = e => { e.preventDefault(); void this.doRename(name, input.value); };
    form.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); this.endRename(name); } };
    return { form, input };
  }

  private endRename(name: string) { this.renaming = null; this.focusName = name; this.showProfiles(); }

  private async doRename(from: string, to: string) {
    const say = (s: string) => { this.root.querySelector('#rename-msg')!.textContent = s; };
    if (to === from) { this.endRename(from); return; }
    if (this.deps.busy()) { say('Quit the game (or close the other tab that runs it) to rename a profile.'); return; }
    const ok = this.root.querySelector<HTMLButtonElement>('.profiles .renaming [type="submit"]')!;
    if (ok.disabled) return;
    ok.disabled = true;
    let r: Awaited<ReturnType<typeof renameProfile>>;
    try { r = await this.write(renameProfile(filesOf(this.deps.saveDir), PROFILES_DIR, from, to)); }
    catch (err) { this.renaming = null; this.msg(`Renaming ${from} stopped: ${err}`); await this.refresh(); return; }
    if ('refused' in r) { ok.disabled = this.deps.busy(); say(r.refused); return; }
    this.renaming = null; this.focusName = to;
    this.msg(`Renamed ${from} to ${to}.`);
    await this.refresh();
  }

  private async doExport() {
    try {
      const e = await exportSaves(this.deps.saveDir);
      downloadBlob(e.zip as BlobPart, e.name, 'application/zip');
      this.msg(`Downloaded ${e.name}: ${e.files} files, ${fmtBytes(e.zip.length)}.` + (e.shotBytes > MAX_SHOTS
        ? ` It holds ${fmtBytes(e.shotBytes)} of screenshots: a restore keeps the saves and settings and only the first ${fmtBytes(MAX_SHOTS)} of screenshots.` : ''));
    } catch (err) { this.msg(`The backup failed: ${err}`); }
  }

  private async doImport(file: File) {
    if (this.deps.busy()) { this.msg('Quit the game first: restoring replaces the saves it is using.'); return; }
    let r: Restore;
    try { r = await readBackup(new Uint8Array(await file.arrayBuffer())); }
    catch (err) { this.msg(err instanceof ZipError ? `${file.name} cannot be restored: ${err.message}.` : `${file.name} cannot be read: ${err}`); return; }
    if (!r.entries.length) { this.msg(`${file.name} has no save files.`); return; }
    const body = document.createElement('div');
    const p = document.createElement('p');
    p.textContent = `Restoring replaces every profile, the game's options and settings.ini in this browser with the ${r.entries.length} files in ${file.name}.`;
    const ul = document.createElement('ul');
    const ini = r.entries.find(e => e.path === 'settings.ini');
    const warn = ini ? settingsWarnings(new TextDecoder().decode(ini.data)) : [];
    const items = [
      r.profiles.length ? `Profiles: ${r.profiles.join(', ')}` : 'No profiles',
      r.entries.some(e => e.path === 'registry.txt') ? 'The game\'s options (registry.txt)' : 'No registry.txt: the next launch starts with fresh game options',
      ini ? (warn.length ? `settings.ini. ${warn.join(' ')}` : 'settings.ini') : 'No settings.ini: the defaults apply',
    ];
    if (r.skipped.length) items.push(`${r.skipped.length} entries are skipped (unsafe names, or over the size limits): ${r.skipped.slice(0, 3).join(', ')}${r.skipped.length > 3 ? ' …' : ''}`);
    for (const t of items) { const li = document.createElement('li'); li.textContent = t; ul.append(li); }
    body.append(p, ul);
    if (!await this.deps.confirm('Restore this backup?', body, 'Restore backup', true)) { this.msg('Nothing changed.'); return; }
    try {
      await this.write(restoreSaves(this.deps.saveDir, r));
      this.msg(`Restored ${r.entries.length} files from ${file.name}.`);
      this.deps.onRestored();
    } catch (err) { this.msg(`Restoring stopped halfway: ${err}. Restore the backup again before playing.`); }
    await this.refresh();
  }

  private async doClearCache() {
    if (this.deps.busy()) return;
    if (!await this.deps.confirm('Delete the downloaded game data?', 'The game will stream it from the server again the next time, which is slower once. Your saves are not touched.', 'Delete game data', true)) return;
    await clearCache();
    await this.refresh();
    this.dataMsg('Downloaded game data deleted.');
  }
}
