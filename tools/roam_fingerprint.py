#!/usr/bin/env python3
"""The exe check of the Windows free-roam plugin: win/roam_asi/roam_fp.h.

  tools/roam_fingerprint.py <SPEED2.EXE v1.2 NA> > win/roam_asi/roam_fp.h

The plugin may only run in the exact game build whose addresses
runtime/roam_game.c uses.  This lists, from the exe on disk:
  - every game function roam_game.c calls (its #define FN_*): a CRC-32 of the
    first bytes of its code (up to 32, stopping before any byte a known mod
    patches, win/roam_asi/modsites.txt);
  - every game global it reads or writes (#define G_*): the instructions of the
    game that use that address (up to 2 per global, none inside a mod's patch),
    as CRC-32s of their bytes -- if they are there, the global is too;
  - the 8 bytes after the frame hook (0x58147A, GameLoop).
The plugin compares them in memory at start-up (roam_asi.c exe_check) and
stays off on any difference.  A function whose first byte another mod has
replaced with a jump is accepted (it is still that function).
Only addresses and CRCs go into the header, no game code.
"""
import sys, re, zlib, os
import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_32
from capstone.x86 import X86_OP_MEM, X86_OP_IMM

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAME = os.path.join(ROOT, 'runtime', 'roam_game.c')
SITES = os.path.join(ROOT, 'win', 'roam_asi', 'modsites.txt')
HOOK_SITE, HOOK_NEXT = 0x581475, 0x58147A
# globals the game only reaches as base + offset: check the base instead
CONTAINER = {0x863470: 0x85AD40,          # G_CAREER_RACE = Career (0x85AD40) + 0x8730
             0x828164: 0x828154}          # G_CARS_POOL = the bMemory pool table (0x828154)[4]


def main():
    exe = sys.argv[1]
    pe = pefile.PE(exe, fast_load=True)
    base = pe.OPTIONAL_HEADER.ImageBase
    img = pe.get_memory_mapped_image()
    text = [s for s in pe.sections if s.Name.rstrip(b'\0') == b'.text'][0]
    tlo, thi = base + text.VirtualAddress, base + text.VirtualAddress + text.Misc_VirtualSize
    entry = base + pe.OPTIONAL_HEADER.AddressOfEntryPoint
    assert base == 0x400000 and entry == 0x75BCC7, 'not SPEED2.EXE v1.2 NA (entry %#x)' % entry

    def b(va, n):
        return img[va - base: va - base + n]
    sites = []
    for l in open(SITES):
        if l.startswith('0x'):
            a, n = l.split()[:2]
            sites.append((int(a, 16), int(a, 16) + int(n)))

    def patched(lo, hi):
        return any(s < hi and e > lo for s, e in sites)

    src = open(GAME).read()
    fns = [(n, int(v, 16)) for n, v in re.findall(r'#define\s+(FN_\w+)\s+(0x[0-9a-fA-F]+)u', src)]
    gls = [(n, int(v, 16)) for n, v in re.findall(r'#define\s+(G_\w+)\s+(0x[0-9a-fA-F]+)u', src)]
    out = []
    for name, va in fns:
        assert tlo <= va < thi, name
        n = 32
        # stop before a byte a mod patches (but a mod replacing the whole
        # function with a 5-byte jump at its start is fine: the plugin then
        # sees the jump and accepts it)
        for k in range(5 if patched(va, va + 1) else 1, 32):
            if patched(va + k, va + k + 1):
                n = k
                break
        assert n >= 8, '%s: only %d bytes before a mod patch' % (name, n)
        why = ' (its first byte: a mod replaces it)' if patched(va, va + 1) else ''
        out.append((va, n, 'RF_FN', zlib.crc32(b(va, n)), '%s%s' % (name, why)))
    # instructions that use each global
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    md.detail = True
    code = b(tlo, thi - tlo)
    want = {CONTAINER.get(va, va): name + ('' if va not in CONTAINER else ' (via %#x)' % CONTAINER[va]) for name, va in gls}
    found = {va: [] for va in want}
    # every place the address's 4 bytes occur in .text, decoded from each
    # possible instruction start before it (opcode, ModRM, SIB): kept when
    # that instruction really uses the address as an absolute operand
    import struct
    for va in want:
        pat = struct.pack('<I', va)
        i = code.find(pat)
        while i >= 0 and len(found[va]) < 2:
            h = tlo + i
            # the decodes that cover the address as an absolute operand; a
            # memory operand or a push/mov of the address first (an
            # accumulator-immediate ALU form is usually a misaligned decode)
            cands = []
            for st in range(h - 1, h - 8, -1):
                ins = next(md.disasm(b(st, 16), st, 1), None)
                if not ins or not (ins.address < h and h + 4 <= ins.address + ins.size):
                    continue
                mem = any(op.type == X86_OP_MEM and op.mem.base == 0 and (op.mem.disp & 0xFFFFFFFF) == va for op in ins.operands)
                imm = any(op.type == X86_OP_IMM and (op.imm & 0xFFFFFFFF) == va for op in ins.operands)
                if not (mem or imm):
                    continue
                rank = 0 if mem else 1 if ins.mnemonic in ('push', 'mov') else 2
                cands.append((rank, ins.address, ins.size, '%s %s' % (ins.mnemonic, ins.op_str)))
            for rank, ia, isz, txt in sorted(cands):
                if not patched(ia, ia + isz) and all(not (a < ia + isz and ia < a + n) for a, n, _ in found[va]) and \
                        (rank < 2 or not any(r < 2 for r, *_ in cands)):
                    found[va].append((ia, isz, txt))
                    break
            i = code.find(pat, i + 1)
    for va, name in sorted(want.items(), key=lambda x: x[1]):
        assert found[va], '%s (%#x): no instruction uses it' % (name, va)
        for a, n, txt in found[va]:
            out.append((a, n, 'RF_REF', zlib.crc32(b(a, n)), '%s: %s' % (name, txt)))
    # the code after the hook site (GameLoop: the camera update's arguments)
    assert not patched(HOOK_NEXT, HOOK_NEXT + 8)
    out.append((HOOK_NEXT, 8, 'RF_REF', zlib.crc32(b(HOOK_NEXT, 8)), 'GameLoop: the code after the frame hook'))
    assert b(HOOK_SITE, 5) == bytes.fromhex('e8460ee8ff')
    print('/* roam_fp.h -- generated by tools/roam_fingerprint.py from SPEED2.EXE v1.2 (North America):')
    print(' * the exe check of NFSU2FreeRoam.asi (roam_asi.c exe_check).  Addresses and CRC-32s only. */')
    print('#ifndef ROAM_FP_H\n#define ROAM_FP_H')
    print('#define RF_ENTRY_VA 0x%08Xu' % entry)
    print('enum { RF_FN = 1, RF_REF = 2 };')
    print('static const struct { uint32_t va; uint16_t len; uint8_t kind; uint32_t crc; const char *what; } RF[] = {')
    for va, n, kind, crc, what in out:
        print('    { 0x%08Xu, %2d, %-6s, 0x%08Xu, "%s" },' % (va, n, kind, crc, what.replace('"', "'")))
    print('};\n#endif')
    print('%d function checks, %d global uses' % (len(fns), len(out) - len(fns)), file=sys.stderr)


if __name__ == '__main__':
    main()
