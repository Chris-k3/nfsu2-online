// The Crews setting (settings.ini roam_crew, NFSU2_ROAM_CREW): the crews a player is in, by name, in the player's
// order and separated by commas ("Blue Room, Night Owls").  Crew-mates still see everyone in free roam, but each other
// in their crew's colour, at any distance.  A crew is its name's hash, as a Room is (players.ts roomHash: capitals A
// to Z and spaces do not count), so "Blue Room" and "blueroom" are the same crew.  Not private: anyone who types the
// same name is in it.  A name that reads as a slur (names.mjs, as for a player's name) is no crew: the box does not
// join it and a hand-written one is left out, as the game does (runtime/roam_game.c crews_parse).  Pure (no DOM), so
// the settings and their tests use it under node.
import { N } from './i18n';
import { blockedName } from './names.mjs';
import { roomHash } from './players';

/** most crews a player is in (roam_core.h RC_CREW_MAX), and the longest name, in characters (the texts say 4 and 24) */
export const CREW_MAX = 4;
export const CREW_LEN = 24;
/** a crew of more players than this in one room is not linked first by the server's hub (hub.rs CREW_GROUP_MAX): its
 *  players see each other only nearby, as everyone else, and the control says so by its count */
export const CREW_BIG = 64;
/** the colours a player picks a crew's from (its name over the car, its map arrow), rrggbb: no green or orange, the
 *  game's own arrow's and the opponents'.  The first 4 are the defaults by the crew's place in the list, and must
 *  match runtime/roam_game.c's CREW_RGB. */
export const CREW_PALETTE: readonly string[] = ['3cd2ff', 'ff50c8', 'a078ff', 'ff4646', '4f7dff', 'fff03c', '3cf0f0', 'ff9ad5'];
/** each palette colour's name (the picker's buttons say it) */
export const CREW_COLOUR_NAMES: readonly string[] = [N('Cyan'), N('Magenta'), N('Violet'), N('Red'), N('Blue'), N('Yellow'), N('Teal'), N('Light pink')];

/** a crew as the controls show it: its name, and its colour (rrggbb, lower case: the one set, else its place's) */
export interface Crew { name: string; rgb: string }

/** the blanks bundle.m's trim and the hash skip (ASCII only: a no-break space is a character of the name) */
const BLANKS = /[\t\n\v\f\r ]+/g;
const trimBlanks = (s: string) => s.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '');
/** a name's length as the player counts it: characters, not bytes */
export const crewLength = (name: string) => [...trimBlanks(name)].length;

/** The crews a value names, as the game takes them: split at its commas and trimmed, the empty ones, repeats (the
 *  same hash as an earlier one) and the ones that read as a slur left out, the first 4. */
export function crewList(value: string): string[] {
  const out: string[] = [], seen = new Set<number>();
  for (const part of value.split(',')) {
    const name = trimBlanks(part).replace(BLANKS, ' '), h = roomHash(name);
    if (!h || seen.has(h) || blockedName(name)) continue;
    seen.add(h); out.push(name);
    if (out.length === CREW_MAX) break;
  }
  return out;
}

/** a list as settings.ini keeps it */
export const crewsValue = (list: readonly string[]) => list.join(', ');

/** What a typed name does to the list: ok, the name to join (trimmed); or why not, an English text for t() (null:
 *  nothing typed, nothing to say; name: the crew it repeats).  A comma would split it, and a # or ; after a blank
 *  would start a comment in settings.ini (the free-roam keys' "value ; comment"), so a name has none of them. */
export type CrewCheck = { ok: true; name: string } | { ok: false; why: string | null; name?: string };
export function checkCrew(typed: string, list: readonly string[]): CrewCheck {
  if (list.length >= CREW_MAX) return { ok: false, why: N('Up to 4 crews: leave one to join another.') };
  const name = trimBlanks(typed).replace(BLANKS, ' ');
  if (!roomHash(name)) return { ok: false, why: null };
  if (/[,;#\x00-\x1f\x7f]/.test(name)) return { ok: false, why: N('No commas, # or ; in a crew name.') };
  if (crewLength(name) > CREW_LEN) return { ok: false, why: N('At most 24 characters.') };
  if (blockedName(name)) return { ok: false, why: N('Not a crew name: it reads as a slur.') };
  const h = roomHash(name), same = list.find(c => roomHash(c) === h);
  if (same !== undefined) return { ok: false, why: N('Already in your crews: {name}.'), name: same };
  return { ok: true, name };
}

/** settings.ini's check of a whole value: every crew at most 24 characters (more than 4, or repeats, are fine: the
 *  game takes the first 4) */
export const crewsOk = (value: string) => value.split(',').every(c => crewLength(c) <= CREW_LEN);

// ---- the crews' colours (settings.ini roam_crew_colours, NFSU2_ROAM_CREW_RGB) ----
// One entry per crew, in the order of roam_crew as the game takes it (crewList), joined by ", ": 6 hex digits without
// a '#' (one after a blank would start a comment), or empty for the place's default (CREW_PALETTE[i]).

/** an entry as bundle.m's K_RGBS takes it: spaces and tabs, then none or 6 hex digits (any case), then spaces and tabs */
const RGB_ENTRY = /^[ \t]*([0-9A-Fa-f]{6})?[ \t]*$/;
/** settings.ini's check of the colours (bundle.m K_RGBS): at most 4 entries, each as RGB_ENTRY */
export function rgbsOk(value: string): boolean {
  const e = value.split(',');
  return e.length <= CREW_MAX && e.every(x => RGB_ENTRY.test(x));
}

/** The crews of the two settings: each name with its colour (entry i, else CREW_PALETTE[i]); a colours value the
 *  check refuses counts as none. */
export function crewsOf(crews: string, rgbs: string): Crew[] {
  const set = rgbsOk(rgbs) ? rgbs.split(',').map(x => (RGB_ENTRY.exec(x)?.[1] ?? '').toLowerCase()) : [];
  return crewList(crews).map((name, i) => ({ name, rgb: set[i] || CREW_PALETTE[i] }));
}

/** the colours as settings.ini keeps them.  Every crew's is written, its place's default too: a crew keeps the colour
 *  it was seen in when one before it is left and it moves up a place. */
export const rgbsValue = (list: readonly Crew[]) => list.map(c => c.rgb).join(', ');

/** a joining crew's colour: the first of the palette no crew has (the defaults first) */
export const freeColour = (list: readonly Crew[]) => CREW_PALETTE.find(p => !list.some(c => c.rgb === p)) ?? CREW_PALETTE[0];

/** the colours as the game's net mailbox takes them (crews_rgb: 0x00rrggbb each) */
export const rgbWords = (list: readonly Crew[]) => list.map(c => parseInt(c.rgb, 16) >>> 0);
