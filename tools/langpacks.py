#!/usr/bin/env python3
"""The language packs: LANGPACKS/<language> in the game folder, from the
"Multi 13 languages" mod for NFSU2 (KyoriAsh, nfsmods.xyz/mod/5749).

    tools/langpacks.py <mod folder> <game folder>

<mod folder> holds every archive of the mod extracted into it, Core and the
dubs (nfsug2Multi13Core.rar, nfsug2Multi13{Fr,De,It,Es,Ja,Ru}Dub.rar; the
English dub is the game's own).  The dubs need RAR 7's unrar (`unrar x`):
libarchive (bsdtar, Windows' tar) cannot read their dictionary size.

The mod's own installer copies its files over the game's and sets the
registry; the port reads them from a folder per language instead
(runtime/language.c, fileio.c's language pack), so every player picks one
for themselves and the game folder stays as it was.  A pack holds only what
differs from the game folder: a file there is read in place of the game's file
of the same path.

  - the dubbed speech banks, from each dub's sdat*.viv: speech/UG2_Speech_FR,
    _GR, _IT, _SP and _JP are the game's own names for French, German, Italian,
    Spanish and Japanese; Russian's stands in for the English bank.  The rest of
    the archive is the game's (the cutscene sound, nisaudio) or its music,
    which stays the game's.
  - the dubbed movies (Lang/Movies/<Xx>), and the Danish, Dutch and Swedish EA
    logos
  - the full Chinese, Japanese and Thai texts (the game folder's are short
    early versions) with the fonts drawn for them (LanguageTexturesGl), and
    Japanese's in-game textures (GlobalB_ja)
  - Russian, which takes English's place: its text, fonts and credits
Rerunning it copies only what changed.  Prints what each pack holds.
"""
import filecmp, os, shutil, struct, sys

LANGS = ['french', 'german', 'italian', 'spanish', 'dutch', 'swedish', 'danish',
         'korean', 'chinese', 'japanese', 'russian', 'thai']
# the dubs: Lang/Movies/<dir> and Lang/Sdata/sdat<dir lower-cased>.viv
DUBS = {'french': 'Fr', 'german': 'De', 'italian': 'It', 'spanish': 'Es', 'japanese': 'Ja', 'russian': 'Ru'}
# (language, file in the mod folder, the game's file it stands in for)
FILES = [
    ('chinese', 'Languages/Chinese.bin', 'LANGUAGES/Chinese.bin'),
    ('chinese', 'Lang/Languages/LanguageTexturesGl.bin', 'LANGUAGES/LanguageTextures.bin'),
    ('chinese', 'Credits/CHINESE.TXT', 'CREDITS/CHINESE.TXT'),
    ('chinese', 'Memcard/LOCALE_CHINESE.loc', 'memcard/LOCALE_CHINESE.loc'),
    ('japanese', 'Languages/Japanese.bin', 'LANGUAGES/Japanese.bin'),
    ('japanese', 'Lang/Languages/LanguageTexturesGl.bin', 'LANGUAGES/LanguageTextures.bin'),
    ('japanese', 'Lang/Global/GlobalB_ja.lzc', 'GLOBAL/GlobalB.lzc'),
    ('japanese', 'Credits/JAPANESE.TXT', 'CREDITS/JAPANESE.TXT'),
    ('japanese', 'Memcard/LOCALE_JAPANESE.loc', 'memcard/LOCALE_JAPANESE.loc'),
    ('thai', 'Languages/Thailand.bin', 'LANGUAGES/Thailand.bin'),
    ('thai', 'Lang/Languages/LanguageTexturesGl.bin', 'LANGUAGES/LanguageTextures.bin'),
    ('thai', 'Credits/THAILAND.TXT', 'CREDITS/THAILAND.TXT'),
    ('thai', 'Memcard/LOCALE_THAILAND.loc', 'memcard/LOCALE_THAILAND.loc'),
    ('russian', 'Lang/Languages/English_ru.bin', 'LANGUAGES/English.bin'),
    ('russian', 'Lang/Languages/LanguageTexturesRu.bin', 'LANGUAGES/LanguageTextures.bin'),
    ('russian', 'Lang/Global/GLOBALA_ru.BUN', 'GLOBAL/GLOBALA.BUN'),
    ('russian', 'Lang/Credits/UK_ENGLISH_ru.txt', 'CREDITS/NA_ENGLISH.TXT'),
    ('russian', 'Lang/Credits/UK_ENGLISH_ru.txt', 'CREDITS/UK_ENGLISH.TXT'),
    ('russian', 'Lang/Memcard/LOCALE_ENGLISH_Ru.loc', 'memcard/LOCALE_ENGLISH.loc'),
    ('danish', 'Movies/ealogo_dn.vp6', 'MOVIES/ealogo.vp6'),
    ('dutch', 'Movies/ealogo_du.vp6', 'MOVIES/ealogo.vp6'),
    ('swedish', 'Movies/ealogo_sw.vp6', 'MOVIES/ealogo.vp6'),
]


def find(root, rel):
    """rel under root, each part matched case-insensitively; None if missing"""
    cur = root
    for part in rel.split('/'):
        if not os.path.isdir(cur): return None
        hit = next((n for n in os.listdir(cur) if n.lower() == part.lower()), None)
        if hit is None: return None
        cur = os.path.join(cur, hit)
    return cur


def game_name(game, rel):
    """rel spelled as the game folder spells it, as far as it has it"""
    out, cur = [], game
    for part in rel.split('/'):
        hit = next((n for n in os.listdir(cur) if n.lower() == part.lower()), None) if os.path.isdir(cur) else None
        out.append(hit or part); cur = os.path.join(cur, hit or part)
    return '/'.join(out)


def viv_entries(path):
    """(name, offset, size) of a BIG4/BIGF archive (EA's .viv)"""
    with open(path, 'rb') as f:
        head = f.read(16)
        if head[:3] != b'BIG': sys.exit(f'{path}: not a .viv archive')
        n, hdr = struct.unpack('>II', head[8:16]); d = f.read(hdr - 16)
    out, q = [], 0
    for _ in range(n):
        off, size = struct.unpack('>II', d[q:q + 8]); q += 8
        e = d.index(b'\0', q); out.append((d[q:e].decode('latin1'), off, size)); q = e + 1
    return out


class Pack:
    def __init__(self, game, lang):
        self.game, self.root, self.files, self.bytes = game, os.path.join(game, 'LANGPACKS', lang), 0, 0
        self.made = set()

    def target(self, rel):
        return os.path.join(self.root, game_name(self.game, rel))

    def same_as_game(self, rel, data=None, src=None):
        g = find(self.game, rel)
        if not g or os.path.getsize(g) != (len(data) if data is not None else os.path.getsize(src)): return False
        if src: return filecmp.cmp(src, g, shallow=False)
        with open(g, 'rb') as f: return f.read() == data

    def add_file(self, src, rel):
        if self.same_as_game(rel, src=src): return
        dst = self.target(rel)
        if not (os.path.exists(dst) and filecmp.cmp(src, dst, shallow=False)):
            os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copyfile(src, dst)
        self.files += 1; self.bytes += os.path.getsize(dst); self.made.add(dst)

    def add_data(self, data, rel):
        if self.same_as_game(rel, data=data): return
        dst = self.target(rel)
        if not (os.path.exists(dst) and os.path.getsize(dst) == len(data) and open(dst, 'rb').read() == data):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, 'wb') as f: f.write(data)
        self.files += 1; self.bytes += len(data); self.made.add(dst)

    def drop_stale(self):
        """what an earlier run put here and this one did not"""
        for d, dirs, names in os.walk(self.root, topdown=False):
            for n in names:
                if os.path.join(d, n) not in self.made: os.remove(os.path.join(d, n))
            if not os.listdir(d): os.rmdir(d)


def main():
    if len(sys.argv) != 3: sys.exit(__doc__)
    mod, game = sys.argv[1], sys.argv[2]
    if not find(game, 'SPEED2.EXE'): sys.exit(f'{game}: no SPEED2.EXE, not the game folder')
    missing = [s for _, s, _ in FILES if not find(mod, s)]
    missing += [f'Lang/Sdata/sdat{x.lower()}.viv' for x in DUBS.values() if not find(mod, f'Lang/Sdata/sdat{x.lower()}.viv')]
    missing += [f'Lang/Movies/{x}' for x in DUBS.values() if not find(mod, f'Lang/Movies/{x}')]
    if missing: sys.exit(f'{mod}: the mod is not all there (extract every archive into it), missing:\n  ' + '\n  '.join(missing))

    for lang in LANGS:
        p = Pack(game, lang)
        for l, src, rel in FILES:
            if l == lang: p.add_file(find(mod, src), rel)
        if lang in DUBS:
            viv = find(mod, f'Lang/Sdata/sdat{DUBS[lang].lower()}.viv')
            with open(viv, 'rb') as f:
                for name, off, size in viv_entries(viv):
                    if not name.lower().startswith('speech/ug2_speech'): continue
                    f.seek(off); p.add_data(f.read(size), name)
            mdir = find(mod, f'Lang/Movies/{DUBS[lang]}')
            for n in sorted(os.listdir(mdir)): p.add_file(os.path.join(mdir, n), f'MOVIES/{n}')
        p.drop_stale()
        print(f'{lang:9} {p.files:3} files {p.bytes / 1048576:8.1f} MB  {p.root if p.files else "(none needed)"}')


if __name__ == '__main__':
    main()
