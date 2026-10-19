#!/usr/bin/env python3
"""Every place in SPEED2.EXE v1.2 that the popular ASI mods patch, as one list
(win/roam_asi/modsites.txt), for the free-roam plugin's checks: its own patch
(0x581475) and the code it fingerprints must stay clear of them.

  tools/roam_modsites.py --src <dir with exopts/ unlimiter/> --wfp <wfp_resolve.out> > win/roam_asi/modsites.txt

Sources (open source, read only; nothing of them is copied, only addresses):
  ExOpts/NFSU2ExOpts 801539e (NFSU2ExtraOptions 5.1.0.1340): every injector::
    WriteMemory/MakeNOP/MakeRangedNOP/MakeJMP/MakeCALL in ExtraOptionsStuff.h
    and HotkeyStuff.h (the hotkeys' run-time toggles too);
  nlgxzef/NFSU2Unlimiter d2d1304 (3.0.0.1337): the same in UnlimiterStuff.h,
    which includes the in-flight patches of its LoaderCarInfo cave;
  ThirteenAG/WidescreenFixesPack 17c4408 (NFSUnderground2.WidescreenFix): every
    pattern resolved against v1.2 (the output of its wfp_resolve.py), whether the local ini enables it or not:
    16 bytes from each match and 4 bytes at each written address.
Each line: start address, length, mod, what.  Conservative (a superset).
"""
import re, sys, argparse

SIZES = {'BYTE': 1, 'unsigned char': 1, 'char': 1, 'bool': 1, 'WORD': 2, 'short': 2, 'unsigned short': 2,
         'int': 4, 'DWORD': 4, 'float': 4, 'uint32_t': 4, 'unsigned int': 4, 'double': 8, '': 4}
# symbolic addresses the sources use: their own "#define _Name 0x..." (read
# from every header), plus this one
SYMS = {'CubicCameraMover_Update': 0x453570}


def read_defines(root):
    import glob
    for f in glob.glob(root + '/**/*.h', recursive=True):
        for m in re.finditer(r'^\s*#define\s+(_[A-Za-z0-9_]+)\s+(0x[0-9A-Fa-f]+)\b', open(f, encoding='utf-8', errors='replace').read(), re.M):
            SYMS.setdefault(m.group(1), int(m.group(2), 16))


def parse_injector(path, tag, out, notes):
    txt = open(path, encoding='utf-8', errors='replace').read()
    txt = re.sub(r'/\*.*?\*/', '', txt, flags=re.S)
    txt = '\n'.join(l.split('//')[0] for l in txt.splitlines())
    for m in re.finditer(r'injector::(WriteMemory|MakeNOP|MakeRangedNOP|MakeJMP|MakeCALL)(?:<([^>]*)>)?\(\s*([^,]+?)\s*,\s*([^;]*)\);', txt):
        kind, typ, addr, rest = m.groups()
        a = None
        mm = re.match(r'^\(?\s*(0x[0-9A-Fa-f]+)\s*\)?(\s*\+\s*(0x[0-9A-Fa-f]+|\d+))?$', addr)
        loop = re.match(r'^(0x[0-9A-Fa-f]+)\s*\+\s*4\s*\*\s*i$', addr)
        if loop:                       # a table written in a loop: up to 64 dwords
            out.append((int(loop.group(1), 16), 256, tag, kind + ' table'))
            continue
        if mm:
            a = int(mm.group(1), 16) + (int(mm.group(3), 0) if mm.group(3) else 0)
        elif addr in SYMS:
            a = SYMS[addr]
        if a is None:
            notes.append('%s: %s(%s, ...) at a run-time address: not listed' % (tag, kind, addr))
            continue
        if kind == 'WriteMemory':
            n = SIZES.get((typ or '').strip(), 4)
        elif kind == 'MakeNOP':
            parts = [p.strip() for p in rest.split(',')]
            n = int(parts[0], 0) if parts and re.match(r'^(0x[0-9A-Fa-f]+|\d+)$', parts[0]) else 1
        elif kind == 'MakeRangedNOP':
            n = int(rest.split(',')[0].strip(), 16) - a
        else:
            n = 5
        out.append((a, max(n, 1), tag, kind))


def parse_wfp(path, out):
    for line in open(path, encoding='utf-8', errors='replace'):
        m = re.search(r"matches: \[([^\]]*)\]", line)
        if m:
            for a in re.findall(r"0x[0-9a-f]+", m.group(1)):
                out.append((int(a, 16), 16, 'WidescreenFix', 'pattern'))
            continue
        m = re.search(r'@([0-9a-f]{8})\b', line)
        if m and '->' not in line.split('@', 1)[1][:12]:
            out.append((int(m.group(1), 16), 4, 'WidescreenFix', 'write'))
        elif m:   # "@addr -> ptr X": an operand rewrite at addr (4 bytes); X is only read
            out.append((int(m.group(1), 16), 4, 'WidescreenFix', 'operand'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--wfp', required=True)
    a = ap.parse_args()
    out, notes = [], []
    read_defines(a.src + '/exopts')
    read_defines(a.src + '/unlimiter')
    parse_injector(a.src + '/exopts/NFSU2ExtraOptions/ExtraOptionsStuff.h', 'ExtraOptions', out, notes)
    parse_injector(a.src + '/exopts/NFSU2ExtraOptions/HotkeyStuff.h', 'ExtraOptions', out, notes)
    parse_injector(a.src + '/unlimiter/UnlimiterStuff.h', 'Unlimiter', out, notes)
    parse_wfp(a.wfp, out)
    # WidescreenFix patches outside its pattern list: IAT slots (CreateThread
    # 0x783248; WriteSettingsToFile 0x783000..0x783014)
    out.append((0x783248, 4, 'WidescreenFix', 'IAT'))
    out.append((0x783000, 0x18, 'WidescreenFix', 'IAT (WriteSettingsToFile)'))
    out = sorted(set(out))
    print('# SPEED2.EXE v1.2: addresses the ASI mods patch (tools/roam_modsites.py; ExtraOptions 801539e,')
    print('# Unlimiter d2d1304, WidescreenFix 17c4408).  start length mod what')
    for n in notes:
        print('#  note: ' + n)
    for s, n, tag, kind in out:
        print('0x%08x %d %s %s' % (s, n, tag, kind))
    print('%d sites' % len(out), file=sys.stderr)


if __name__ == '__main__':
    main()
