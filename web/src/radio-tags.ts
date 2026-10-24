// What the game's plaque shows of a track: artist, title and album, in letters its font draws.
import type { Lines } from './app/radio-link';

const PLAQUE_CHARS = 40;                 // what the game's plaque shows of a line

/** Artist and title from the file name ("Artist - Title.mp3"), else the name alone. */
export function nameTags(name: string): Lines {
  const stem = name.replace(/\.[^.]+$/, ''), at = stem.indexOf(' - ');
  return at > 0 ? { artist: stem.slice(0, at).trim(), title: stem.slice(at + 3).trim(), album: '' } : { artist: '', title: stem, album: '' };
}

// The plaque's font draws ASCII for certain; anything else is written with the nearest ASCII letters.
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};
const NEAREST: Record<string, string> = { ł: 'l', đ: 'd', ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ı: 'i', '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...' };
const cased = (from: string, to: string) => from === from.toLowerCase() ? to : to.charAt(0).toUpperCase() + to.slice(1);

/** The text in ASCII: accents dropped, Cyrillic romanized, a sign with no nearest letter is "?". */
export function gameText(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const low = ch.toLowerCase(), base = ch.normalize('NFD').replace(/\p{M}/gu, '');
    if (ch.charCodeAt(0) < 0x80) out += ch.charCodeAt(0) >= 0x20 ? ch : ' ';
    else if (CYRILLIC[low] !== undefined) out += cased(ch, CYRILLIC[low]);
    else if (NEAREST[low] !== undefined) out += cased(ch, NEAREST[low]);
    else out += base && base.charCodeAt(0) < 0x80 ? base : '?';
  }
  return out;
}

/** What the game's plaque can show: no artist in the title, "&" as "and" (the game eats it), a line no longer than its own longest. */
export function plaqueTags(tags: Lines, album = 'My music'): Lines {
  const fit = (s: string) => { const t = gameText(s).replace(/&/g, 'and').replace(/\s+/g, ' ').trim(); return t.length > PLAQUE_CHARS ? t.slice(0, PLAQUE_CHARS - 3).trimEnd() + '...' : t; };
  const own = tags.artist + ' - ';
  const title = tags.artist && tags.title.toLowerCase().startsWith(own.toLowerCase()) ? tags.title.slice(own.length) : tags.title;
  return { artist: fit(tags.artist) || 'Unknown artist', title: fit(title), album: fit(tags.album) || fit(album) || 'My music' };
}

/** The tags of a track: what its file name says. */
export async function tagsOf(handle: { name: string }): Promise<Lines> { return nameTags(handle.name); }
