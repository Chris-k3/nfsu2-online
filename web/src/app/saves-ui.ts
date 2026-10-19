// The saves section of the start page: the profiles in this browser, a backup of the whole save
// overlay as a zip (profiles, registry.txt, settings.ini, screenshots) and
// restoring one, and the downloaded game data on this PC.  The game data
// itself is never part of a backup and never written: it stays on the server.

import { cacheBytes, clearCache, clearSaveDir, listFiles, listProfiles, PROFILES_DIR, readBytes, writeFile } from './savefs';
import { listZip, unzip, zip, ZipError, type ZipEntry } from './zip';
import { downloadBlob, stamp } from './logs';
import { fmtBytes } from './checks';
import { resolveEnv } from './settings';

export interface SavesDeps {
  saveDir: string;
  /** true while a game runs in this tab: no restore, no cache delete */
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
  constructor(private root: HTMLElement, private deps: SavesDeps) {
    root.querySelector<HTMLButtonElement>('#export')!.onclick = () => void this.doExport();
    const inp = root.querySelector<HTMLInputElement>('#import')!;
    inp.onchange = () => { const f = inp.files?.[0]; inp.value = ''; if (f) void this.doImport(f); };
    root.querySelector<HTMLButtonElement>('#clear-cache')!.onclick = () => void this.doClearCache();
  }

  private msg(s: string) { this.root.querySelector('#saves-msg')!.textContent = s; }

  /** Show the profiles and the downloaded game data as they are now. */
  async refresh() {
    const files = await listFiles(this.deps.saveDir);
    const profiles = await listProfiles(this.deps.saveDir, files);
    const ul = this.root.querySelector('#profiles')!;
    ul.replaceChildren();
    if (!profiles.length) {
      const li = document.createElement('li'); li.className = 'empty';
      li.textContent = 'No profiles yet. Create one in the game: it is saved in this browser.';
      ul.append(li);
    }
    for (const p of profiles) {
      const li = document.createElement('li');
      const n = document.createElement('span'); n.className = 'name'; n.textContent = p.name;
      const m = document.createElement('span'); m.className = 'meta';
      m.textContent = `saved ${new Date(p.mtime).toLocaleString()}, ${fmtBytes(p.size)}`;
      li.append(n, m); ul.append(li);
    }
    const busy = this.deps.busy();
    this.root.querySelector<HTMLLabelElement>('.file-btn')!.toggleAttribute('aria-disabled', busy);
    this.root.querySelector<HTMLInputElement>('#import')!.disabled = busy;
    this.root.querySelector<HTMLButtonElement>('#clear-cache')!.disabled = busy;
    if (busy) this.msg('Quit the game (or close the other tab that runs it) to restore a backup or delete game data.');
    else if (/^Quit the game \(or close/.test(this.root.querySelector('#saves-msg')!.textContent ?? '')) this.msg('');
    const c = await cacheBytes();
    this.root.querySelector('#cache-info')!.textContent = c.bytes
      ? `${fmtBytes(c.bytes)} from ${c.files} files is kept in this browser, so the game loads from this PC instead of the network. Deleting it only means downloading it again.`
      : 'Nothing downloaded yet. The game streams its data from the server the first time and keeps it here.';
    this.root.dataset.files = String(files.length);
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
      await restoreSaves(this.deps.saveDir, r);
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
    this.msg('Downloaded game data deleted.');
  }
}
