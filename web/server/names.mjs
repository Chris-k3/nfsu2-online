// A player's name that reads as a slur.  The server refuses one for the Online mode (online/lobby.mjs: an
// account or persona; online/stats.mjs drops the results kept under one) and the switch's peer list shows
// "player" for one (lan.mjs cleanName); the page's settings refuse one as "Your name" (web/src/app/settings.ts).
// runtime/names.h is the same lists and the same matching for the game (the names over the cars in free roam,
// and the Mac's settings); web/test/names.test.mjs checks that the two agree.
//
// A name is read as letters only: a to z in lower case, the digits and signs that stand for letters as those
// (0 o, 1 ! | l i, 3 e, 4 @ a, 5 $ s, 7 + t, 6 9 g, 8 b), anything else left out: "N1-g g@" reads "nigga".
// Before that (here only: the game's names are ASCII) accents, fullwidth and styled letters go (NFKD) and the
// Cyrillic and Greek letters that look like Latin ones read as those.  A word matches where each of its letters
// comes at least as many times in a row as in the word ("niiiggga"; "Niger" is not "nigger").
//  - anywhere: a word long enough that no other word has it inside it
//  - whole: a short one that other words have inside them ("Mustafa GS", "raccoon", "spicy", "Pakize"), only as
//    a part of the name on its own, and plural: the parts are split where a character is no letter and where a
//    capital follows a small letter ("f4g_42", "XxCoonXx"); the name's letters together count as one too ("F A G").
export const SLURS = Object.freeze({
  anywhere: Object.freeze(['nigg', 'niqq', 'faggot', 'trann', 'retard', 'ibne', 'wetback', 'beaner',
    'raghead', 'towelhead', 'chingchong', 'jigaboo', 'porchmonkey', 'junglebunny']),
  whole: Object.freeze(['fag', 'dyke', 'coon', 'spic', 'paki', 'kike', 'gook', 'chink']),
});

const LOOKALIKE = {
  А: 'A', а: 'a', В: 'B', в: 'b', Е: 'E', е: 'e', К: 'K', к: 'k', М: 'M', м: 'm', Н: 'H', н: 'h', О: 'O', о: 'o',
  Р: 'P', р: 'p', С: 'C', с: 'c', Т: 'T', т: 't', У: 'Y', у: 'y', Х: 'X', х: 'x', І: 'I', і: 'i', Ј: 'J', ј: 'j',
  Ѕ: 'S', ѕ: 's', Ԁ: 'D', ԁ: 'd', п: 'n', Ь: 'b', ь: 'b', ԛ: 'q',
  Α: 'A', α: 'a', Β: 'B', β: 'b', Ε: 'E', ε: 'e', Ζ: 'Z', Η: 'H', η: 'n', Ι: 'I', ι: 'i', Κ: 'K', κ: 'k', Μ: 'M',
  Ν: 'N', ν: 'v', Ο: 'O', ο: 'o', Ρ: 'P', ρ: 'p', Τ: 'T', τ: 't', Υ: 'Y', υ: 'u', Χ: 'X', χ: 'x', Ϲ: 'C', ϲ: 'c',
  ı: 'i', Ł: 'L', ł: 'l', Ø: 'O', ø: 'o', Đ: 'D', đ: 'd', ŋ: 'n', ɡ: 'g', '¡': 'i', '€': 'e',
};
const FROM = '01!|l34@5$7+698', TO = 'oiiiieaassttggb';

/** ch as a letter (above), else '' */
function letter(ch) {
  if (ch >= 'A' && ch <= 'Z') ch = ch.toLowerCase();
  const i = FROM.indexOf(ch);
  if (i >= 0) return TO[i];
  return ch >= 'a' && ch <= 'z' ? ch : '';
}
const word = w => [...w].map(letter).join('');
const ANYWHERE = SLURS.anywhere.map(word), WHOLE = SLURS.whole.map(word);
/** the end of word w (its letters) at s[i], each letter at least as many times in a row as in w; -1 if it is not
 *  there */
function at(s, i, w) {
  for (let j = 0; j < w.length;) {
    const c = w[j];
    let m = 0, k = 0;
    for (; w[j] === c; j++) m++;
    while (s[i + k] === c) k++;
    if (k < m) return -1;
    i += k;
  }
  return i;
}
/** t is all one of words, or its plural */
function whole(t, words) {
  return words.some(w => {
    let e = at(t, 0, w);
    if (e < 0) return false;
    while (t[e] === 's') e++;
    return e === t.length;
  });
}

/** name reads as a slur (above) */
export function blockedName(name) {
  const str = [...String(name ?? '').normalize('NFKD').replace(/\p{M}/gu, '')].map(ch => LOOKALIKE[ch] ?? ch);
  let s = '', t = '', low = false;
  for (const ch of [...str, '']) {
    const c = ch && letter(ch);
    if ((!c || (low && ch >= 'A' && ch <= 'Z')) && t) {
      if (whole(t, WHOLE)) return true;
      t = '';
    }
    if (c) { if (s.length < 255) s += c; if (t.length < 255) t += c; }
    low = ch >= 'a' && ch <= 'z';
  }
  return ANYWHERE.some(w => { for (let i = 0; i < s.length; i++) if (at(s, i, w) >= 0) return true; return false; }) || whole(s, WHOLE);
}
