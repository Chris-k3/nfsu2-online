// A profile the game saved ("NFS Underground 2/<NAME>/<NAME>", 54,966 bytes)
// as far as the page reads or changes it: the file's checksums and the game's
// own Save option (Options, Gameplay, Save: Autosave, Prompt or Off).
//
// Layout and checksum: the clean-room description of this SPEED2.EXE (v1.2 NA,
// the README's SHA-256) in github.com/whoismept/OpenUG2,
// docs/cleanroom-settings/SPEC.md §3.2-3.5 (file), §5.1 and §5.8 (Save):
//   0   "20CM"          4  u32 file size     8  u32 sizeA = 8     12 u32 sizeB = 54,930
//   16  checksum(A)     20 checksum(B)       24 checksum(bytes 0..23)
//   28  block A: u32 version 0x10D, u32 payload size 54,930
//   36  block B, the payload: +50,987 u8 autosave, +50,988 u8 prompt, +53,761 the name (32 bytes, NUL-padded)
// autosave 1 shows "Autosave" (prompt is then 1 too: selecting Autosave sets
// both), autosave 0 with prompt 1 "Prompt", both 0 "Off".  A new profile is on
// Prompt (the tests' "save the profile?" after a purchase, after Options), whose
// question opens on "No".  checksum(D) is CRC-32/BZIP2 of D but its last 4
// bytes, XOR those 4 bytes read big-endian; stored little-endian.  The name's
// place agrees with the save editors that work on players' real profiles
// (0xD225 in hackch/NFSU2-Savegame-Editor); those editors leave the checksums
// stale, so a file whose checksums do not hold here is left alone instead of
// being "repaired".  Checked in the game (2026-10-19): a profile it created
// came in on Prompt, and after withAutosave it loaded with Options, Gameplay,
// Save at Autosave and every other Gameplay option as before.  Every check
// below must still hold before the page writes a byte.
//
// Pure (no DOM, no OPFS) so it can be checked under node; turnOnAutosave
// takes the save folder's file functions.

export const PROFILE_SIZE = 54966;
const PAYLOAD = 54930, VERSION = 0x10D;
const B = 36;                                        // the payload's start in the file
const AUTOSAVE = B + 50987, PROMPT = B + 50988, NAME = B + 53761;

const T = new Uint32Array(256);                      // MSB-first CRC table, polynomial 0x04C11DB7
for (let i = 0; i < 256; i++) {
  let r = i << 24;
  for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04C11DB7 : r << 1;
  T[i] = r >>> 0;
}

/** The game's checksum of a block (SPEC §3.4): 0 below 4 bytes. */
export function checksum(d: Uint8Array): number {
  if (d.length < 4) return 0;
  let r = ~((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
  for (let i = 4; i < d.length; i++) r = (((r << 8) | d[i]) ^ T[r >>> 24]) >>> 0;
  return ~r >>> 0;
}

export type SaveMode = 'autosave' | 'prompt' | 'off';

const u32 = (f: Uint8Array, at: number) => new DataView(f.buffer, f.byteOffset, f.byteLength).getUint32(at, true);
const lowerAscii = (s: string) => s.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32));

/**
 * The Save option of a profile file, or why the page does not trust the file
 * enough to change it: its size, header, checksums, version, the name inside
 * against its folder's (ASCII letters in any case), and both Save bytes 0 or 1.
 */
export function readSaveMode(file: Uint8Array, name: string): { mode: SaveMode } | { bad: string } {
  if (file.length !== PROFILE_SIZE) return { bad: `${file.length} bytes, not ${PROFILE_SIZE}` };
  if (file[0] !== 0x32 || file[1] !== 0x30 || file[2] !== 0x43 || file[3] !== 0x4D) return { bad: 'not a profile file (no "20CM")' };
  if (u32(file, 4) !== file.length || u32(file, 8) !== 8 || u32(file, 12) !== PAYLOAD) return { bad: 'unexpected block sizes' };
  if (u32(file, 24) !== checksum(file.subarray(0, 24)) || u32(file, 16) !== checksum(file.subarray(28, B)) ||
      u32(file, 20) !== checksum(file.subarray(B))) return { bad: 'its checksums do not match (edited outside the game?)' };
  if (u32(file, 28) !== VERSION || u32(file, 32) !== PAYLOAD) return { bad: `version ${u32(file, 28)}, not ${VERSION}` };
  let inside = '';
  for (let i = NAME; i < NAME + 32 && file[i]; i++) inside += String.fromCharCode(file[i]);
  if (lowerAscii(inside) !== lowerAscii(name)) return { bad: `the name inside is "${inside}"` };
  const a = file[AUTOSAVE], p = file[PROMPT];
  if (a > 1 || p > 1) return { bad: `unexpected Save bytes ${a}, ${p}` };
  return { mode: a ? 'autosave' : p ? 'prompt' : 'off' };
}

/** A copy of a profile file readSaveMode accepted, with Save at Autosave (both bytes 1, as the game's menu sets it) and its checksums made again. */
export function withAutosave(file: Uint8Array): Uint8Array {
  const f = file.slice();
  f[AUTOSAVE] = 1; f[PROMPT] = 1;
  const dv = new DataView(f.buffer);
  dv.setUint32(20, checksum(f.subarray(B)), true);
  dv.setUint32(24, checksum(f.subarray(0, 24)), true);
  return f;
}

// ------------------------------------------------- once per profile --

/** The save folder's file of the profiles turnOnAutosave has looked at: each one gets Autosave once. */
export const AUTOSAVE_SEEN = 'autosave-profiles.txt';
const SEEN_HEAD = `# Profiles the page has looked at for settings.ini's "autosave": each one is set
# to Autosave once (if it was on Prompt, the game's default), then left as the
# game's Options, Gameplay, Save set it.  Delete a name to have it set again.
`;

export interface SaveFiles {
  listFiles(): Promise<{ path: string }[]>;
  readBytes(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string | null>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
}

/**
 * Before a Play (no game runs in this tab): every profile not looked at yet that
 * is on Prompt is set to Autosave.  Profiles on Autosave or Off, and those set,
 * are remembered (AUTOSAVE_SEEN), so a choice made in the game later stays; a
 * file readSaveMode does not trust is left alone and looked at again next time.
 * Names of profiles that are gone are dropped (a new profile of the same name
 * gets Autosave too).  turnedOn: the profiles set now; notes: one line each for the log.
 */
export async function turnOnAutosave(fs: SaveFiles, profilesDir: string): Promise<{ turnedOn: string[]; notes: string[] }> {
  const seenText = await fs.readText(AUTOSAVE_SEEN) ?? '';
  const seen = new Set(seenText.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')));
  const turnedOn: string[] = [], notes: string[] = [], now: string[] = [];
  for (const { path } of await fs.listFiles()) {
    const p = path.split('/');
    if (p.length !== 3 || p[0] !== profilesDir || lowerAscii(p[2]) !== lowerAscii(p[1])) continue;
    const name = p[1];
    if (seen.has(name)) { now.push(name); continue; }
    const file = await fs.readBytes(path);
    const r = readSaveMode(file, name);
    if ('bad' in r) { notes.push(`${name} left as it is: ${r.bad}`); continue; }
    if (r.mode === 'prompt') {
      await fs.writeFile(path, withAutosave(file));
      turnedOn.push(name);
      notes.push(`${name}: Save set from Prompt to Autosave (Options, Gameplay, Save in the game)`);
    } else notes.push(`${name}: Save is ${r.mode === 'off' ? 'Off' : 'Autosave'} already, left as it is`);
    now.push(name);
  }
  const text = SEEN_HEAD + now.map(n => n + '\n').join('');
  if (text !== seenText && (now.length || seenText)) await fs.writeFile(AUTOSAVE_SEEN, text);
  return { turnedOn, notes };
}
