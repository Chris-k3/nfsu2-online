#!/usr/bin/env python3
"""The pause menu's Photo Mode icon (runtime/photo.c): a still camera drawn in the style of the game's own
INGAME_ICON_* textures (white, the parts in alpha levels with gaps between them, tinted by the menu), shown in place
of INGAME_ICON_VOIP_ON, which nothing in the PC game draws.  Writes runtime/web/photo_icon.h: that texture's key as
texrep_web.c sees its level 0 (CRC-32, Adler-32, size, D3DFORMAT) and the drawing's alpha at 512 x 256 (the icon is
2:1, drawn stretched to a square), run-length coded.

    .venv/bin/python3 tools/photoicon.py [game folder] [--png out.png]
"""
import os, re, sys, zlib
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import texpacks as T

GAME = '/home/thom/nfsu2-data/Need for Speed - Underground 2'
NAME = 'INGAME_ICON_VOIP_ON'
W, H = 512, 256
N = 1024                                   # drawn square, at twice the size
RIM, FILL, DARK = 210, 120, 70             # the alpha levels the game's icons use (rims, faces, shade)


def draw():
    im = Image.new('L', (N, N), 0)
    d = ImageDraw.Draw(im)
    def disc(r, a): d.ellipse((512 - r, 560 - r, 512 + r, 560 + r), fill=a)
    d.polygon([(372, 300), (652, 300), (700, 370), (324, 370)], fill=RIM)           # the prism's hump
    d.polygon([(398, 318), (626, 318), (662, 362), (362, 362)], fill=FILL)
    d.rounded_rectangle((232, 280, 344, 336), 16, fill=RIM)                          # the shutter button
    d.rounded_rectangle((150, 360, 874, 760), 60, fill=RIM)                          # the body
    d.rounded_rectangle((176, 386, 848, 734), 44, fill=FILL)
    d.rectangle((176, 430, 848, 470), fill=DARK)                                     # its band
    disc(196, 0)                                                                     # the gap round the lens
    disc(176, RIM)
    disc(150, DARK)
    disc(112, FILL)
    disc(70, DARK)
    d.pieslice((452, 500, 572, 620), 200, 250, fill=255)                             # the glint
    d.rounded_rectangle((736, 402, 812, 446), 10, fill=165)                          # the flash window
    return im.resize((W, H), Image.LANCZOS)


def rle(b):
    out, i = bytearray(), 0
    while i < len(b):
        j = i
        while j < len(b) and j - i < 255 and b[j] == b[i]: j += 1
        out += bytes((j - i, b[i])); i = j
    return bytes(out)


def main():
    a = [x for i, x in enumerate(sys.argv[1:], 1) if not x.startswith('--') and sys.argv[i - 1] != '--png']
    game = a[0] if a else GAME
    d = open(os.path.join(game, 'GLOBAL', 'InGameCommon.bun'), 'rb').read()
    want = T.bstring_hash(NAME)
    key = next(((w, h, fmt, lv) for nh, w, h, fmt, lv in T.textures(d) if nh == want and lv), None)
    if not key: sys.exit(f'{NAME}: not in InGameCommon.bun')
    w, h, fmt, lv = key
    alpha = draw()
    if '--png' in sys.argv:
        out = sys.argv[sys.argv.index('--png') + 1]
        Image.merge('LA', (Image.new('L', alpha.size, 255), alpha)).save(out)
    runs = rle(alpha.tobytes())
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(root, 'runtime', 'web', 'photo_icon.h'), 'w', newline='\n') as f:
        f.write('/* photo_icon.h -- made by tools/photoicon.py: the pause menu\'s Photo Mode icon (texrep_web.c) */\n')
        f.write(f'#define PHOTO_ICON_KEY_CRC   0x{zlib.crc32(lv):08x}u   /* {NAME}\'s level 0 */\n')
        f.write(f'#define PHOTO_ICON_KEY_ADLER 0x{zlib.adler32(lv):08x}u\n')
        f.write(f'#define PHOTO_ICON_KEY_W     {w}u\n#define PHOTO_ICON_KEY_H     {h}u\n')
        f.write(f'#define PHOTO_ICON_KEY_FMT   0x{fmt:08x}u\n')
        f.write(f'#define PHOTO_ICON_W         {W}u\n#define PHOTO_ICON_H         {H}u\n')
        f.write(f'/* (count, alpha) pairs, row by row */\nstatic const unsigned char photo_icon_rle[{len(runs)}] = {{\n')
        for i in range(0, len(runs), 24):
            f.write('    ' + ','.join(str(x) for x in runs[i:i + 24]) + ',\n')
        f.write('};\n')
    print(f'runtime/web/photo_icon.h: {NAME} {w}x{h} crc {zlib.crc32(lv):08x}, {W}x{H} icon in {len(runs)} bytes')


if __name__ == '__main__':
    main()
