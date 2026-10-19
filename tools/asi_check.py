#!/usr/bin/env python3
"""Checks NFSU2FreeRoam.asi as a file, without Windows (pefile, capstone).

  tools/asi_check.py out/win/NFSU2FreeRoam.asi [SPEED2.EXE]

  1. PE: 32-bit x86 DLL, GUI subsystem, DYNAMIC_BASE + NX_COMPAT, relocations,
     no TLS, no section both writable and executable, under 256 KB.
  2. Exports exactly InitializeASI; the entry point is DllMain.
  3. Imports only KERNEL32 and WS2_32, and only the functions listed here
     (no C runtime, no libgcc/winpthread DLL, nothing a friend's PC lacks:
     every one exists since Windows XP).
  4. The frame hook site in SPEED2.EXE (0x581475) holds the call the plugin
     expects (E8 46 0E E8 FF = call 0x4022C0, and 0x4022C0 is a ret), and
     neither it nor 16 bytes around it are patched by ExtraOptions, Unlimiter
     or WidescreenFix (win/roam_asi/modsites.txt); the plugin's code
     fingerprint (win/roam_asi/roam_fp.h) matches the exe and avoids every
     mod patch site.
  5. The thunks (capstone): the frame thunk saves and restores every
     register and the flags, realigns the stack, keeps the thread's SEH chain
     head (FS:[0]) and ends in an indirect jump through the chain pointer;
     the fault guard's way back puts FS:[0] back before anything else runs;
     the call thunk restores esp from ebp.
Exit status 0 when everything passes.
"""
import sys, os, re, zlib
import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_32

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALLOWED = {
    'KERNEL32.dll': {
        'AddVectoredExceptionHandler', 'CloseHandle', 'CreateFileA', 'CreateThread', 'DeleteCriticalSection',
        'DisableThreadLibraryCalls', 'EnterCriticalSection', 'FlushInstructionCache', 'GetCurrentProcess',
        'GetCurrentProcessId', 'GetCurrentThreadId', 'GetEnvironmentVariableA', 'GetLastError', 'GetLocalTime',
        'GetModuleFileNameA', 'GetModuleHandleA', 'GetPrivateProfileStringA', 'GetTickCount',
        'InitializeCriticalSection', 'InterlockedCompareExchange', 'LeaveCriticalSection', 'QueryPerformanceCounter',
        'QueryPerformanceFrequency', 'Sleep', 'TryEnterCriticalSection', 'VirtualProtect', 'VirtualQuery',
        'WaitForSingleObject', 'WriteFile', 'lstrcmpA', 'lstrcmpiA', 'lstrcpyA', 'lstrlenA'},
    'WS2_32.dll': {
        'WSACleanup', 'WSAGetLastError', 'WSAIoctl', 'WSAStartup', '__WSAFDIsSet', 'bind', 'closesocket',
        'ioctlsocket', 'recvfrom', 'select', 'sendto', 'setsockopt', 'socket'},
}
HOOK_SITE = 0x581475
fails = []


def check(cond, msg):
    print(('  ok    ' if cond else '  FAIL  ') + msg)
    if not cond:
        fails.append(msg)


def main():
    asi = sys.argv[1]
    exe = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, '..', '..', 'gamedata', 'SPEED2.EXE')
    data = open(asi, 'rb').read()
    pe = pefile.PE(data=data)
    print('%s: %d bytes' % (asi, len(data)))
    print('1. PE structure')
    check(pe.FILE_HEADER.Machine == 0x14C, 'machine i386 (0x14c)')
    check(pe.FILE_HEADER.Characteristics & 0x2000 != 0, 'a DLL')
    check(pe.OPTIONAL_HEADER.Magic == 0x10B, 'PE32 (32-bit)')
    check(pe.OPTIONAL_HEADER.Subsystem == 2, 'GUI subsystem')
    dc = pe.OPTIONAL_HEADER.DllCharacteristics
    check(dc & 0x40 and dc & 0x100, 'DYNAMIC_BASE and NX_COMPAT (0x%x)' % dc)
    relocs = sum(len(b.entries) for b in getattr(pe, 'DIRECTORY_ENTRY_BASERELOC', []))
    check(relocs > 0, 'base relocations present (%d): loads at any address' % relocs)
    tls = pe.OPTIONAL_HEADER.DATA_DIRECTORY[9]
    check(tls.VirtualAddress == 0 and tls.Size == 0, 'no TLS directory (nothing runs before DllMain)')
    wx = [s.Name.rstrip(b'\0').decode() for s in pe.sections if s.Characteristics & 0x80000000 and s.Characteristics & 0x20000000]
    check(not wx, 'no section both writable and executable%s' % (' (' + ', '.join(wx) + ')' if wx else ''))
    check(len(data) < 256 * 1024, 'under 256 KB')
    check(pe.FILE_HEADER.TimeDateStamp == 0, 'no time stamp (reproducible build)')
    dbg = os.path.join(os.path.dirname(asi), 'dbg', os.path.basename(asi))
    if os.path.exists(dbg) and dbg != asi:
        dp = pefile.PE(dbg)
        same = [(x.Name, x.get_data()) for x in pe.sections] == [(x.Name, x.get_data()) for x in dp.sections[:len(pe.sections)]] and \
            pe.OPTIONAL_HEADER.AddressOfEntryPoint == dp.OPTIONAL_HEADER.AddressOfEntryPoint
        check(same, 'the same sections and entry point as dbg/%s, the copy with symbols the tests run' % os.path.basename(dbg))
    print('2. Exports and entry point')
    exps = [e.name.decode() for e in pe.DIRECTORY_ENTRY_EXPORT.symbols] if hasattr(pe, 'DIRECTORY_ENTRY_EXPORT') else []
    check(exps == ['InitializeASI'], 'exports exactly InitializeASI (%s)' % ', '.join(exps))
    mp = open(asi.replace('.asi', '.map')).read() if os.path.exists(asi.replace('.asi', '.map')) else ''
    m = re.search(r'0x([0-9a-f]+)\s+_?DllMain@12', mp)
    check(m is not None and int(m.group(1), 16) == pe.OPTIONAL_HEADER.ImageBase + pe.OPTIONAL_HEADER.AddressOfEntryPoint,
          'the entry point is DllMain (%s)' % ('0x%x' % int(m.group(1), 16) if m else 'no linker map'))
    print('3. Imports')
    dlls = {}
    for d in pe.DIRECTORY_ENTRY_IMPORT:
        dlls[d.dll.decode()] = sorted(i.name.decode() for i in d.imports)
    check(set(dlls) <= set(ALLOWED), 'DLLs: %s' % ', '.join(dlls))
    for d, fns in dlls.items():
        extra = [f for f in fns if f not in ALLOWED.get(d, ())]
        check(not extra, '%s: %d functions, all in the allowed list%s' % (d, len(fns), (' -- NOT: ' + ', '.join(extra)) if extra else ''))
        print('        ' + ' '.join(fns))
    print('4. SPEED2.EXE: hook site, fingerprint, other mods')
    ex = pefile.PE(exe, fast_load=True)
    img = ex.get_memory_mapped_image()
    b = lambda va, n: img[va - 0x400000: va - 0x400000 + n]
    check(b(HOOK_SITE, 5) == bytes.fromhex('e8460ee8ff'), '0x581475: E8 46 0E E8 FF (call 0x4022C0)')
    check(b(0x4022C0, 1) == b'\xc3', '0x4022C0: ret (the empty debug function)')
    check(ex.OPTIONAL_HEADER.ImageBase + ex.OPTIONAL_HEADER.AddressOfEntryPoint == 0x75BCC7, 'entry point 0x75BCC7 (v1.2 NA)')
    sites = []
    for l in open(os.path.join(ROOT, 'win', 'roam_asi', 'modsites.txt')):
        if l.startswith('0x'):
            p = l.split()
            sites.append((int(p[0], 16), int(p[0], 16) + int(p[1]), p[2], ' '.join(p[3:])))
    near = [s for s in sites if s[0] < HOOK_SITE + 5 + 16 and s[1] > HOOK_SITE - 16]
    over = [s for s in sites if s[0] < HOOK_SITE + 5 and s[1] > HOOK_SITE]
    check(not over, 'no mod patches 0x581475..0x581479 (%d mod sites known)' % len(sites))
    print('        within 16 bytes: ' + ('; '.join('%s %s at 0x%x..0x%x' % (s[2], s[3], s[0], s[1] - 1) for s in near) or 'none'))
    fp = open(os.path.join(ROOT, 'win', 'roam_asi', 'roam_fp.h')).read()
    ents = re.findall(r'\{ 0x([0-9A-F]+)u,\s*(\d+), (RF_\w+)\s*, 0x([0-9A-F]+)u, "([^"]*)" \}', fp)
    bad = [e for e in ents if zlib.crc32(b(int(e[0], 16), int(e[1]))) != int(e[3], 16)]
    check(ents and not bad, 'fingerprint: %d windows, all match the exe' % len(ents))
    clash = []
    for va, n, kind, crc, what in ents:
        lo, hi = int(va, 16), int(va, 16) + int(n)
        for s in sites:
            if s[0] < hi and s[1] > lo and not (kind == 'RF_FN' and s[0] == lo):
                clash.append('%s at 0x%x: %s %s' % (what, lo, s[2], s[3]))
    check(not clash, 'fingerprint windows avoid every mod patch site (except whole-function replacements at the entry)' +
          ('' if not clash else ': ' + '; '.join(clash)))
    print('5. Thunks')
    dbgpe = pefile.PE(dbg) if os.path.exists(dbg) else None

    def sym(name):
        m = re.search(r'0x([0-9a-f]+)\s+_?%s\b' % re.escape(name.lstrip('_')), mp)
        return int(m.group(1), 16) if m else None
    md = Cs(CS_ARCH_X86, CS_MODE_32)
    ft, ct, chain = sym('_roam_frame_thunk'), sym('_roam_call_asm'), sym('_g_roam_chain')
    if dbgpe and ft and ct:
        dimg = dbgpe.get_memory_mapped_image()
        base = dbgpe.OPTIONAL_HEADER.ImageBase
        code = lambda va, n: dimg[va - base: va - base + n]
        ins = list(md.disasm(code(ft, 64), ft))
        txt = ['%s %s' % (i.mnemonic, i.op_str) for i in ins]
        print('        frame thunk: ' + ' | '.join(txt[:12]))
        check(txt[:2] == ['pushal ', 'pushfd '] or (txt[0].startswith('pushal') and txt[1].startswith('pushf')), 'frame thunk starts with pushal; pushfd')
        k = next((i for i, t in enumerate(txt) if t.startswith('jmp dword ptr')), None)
        check(k is not None and txt[k - 1].startswith('popal') and txt[k - 2].startswith('popf') and
              ('0x%x' % chain) in txt[k], 'frame thunk ends popfd; popal; jmp [g_roam_chain]')
        check(any(t.startswith('and esp, 0xfffffff0') for t in txt), 'frame thunk aligns the stack to 16 bytes')
        check(any(t == 'cld ' or t.startswith('cld') for t in txt), 'frame thunk clears the direction flag')
        seh = sym('_g_roam_resume_seh')
        k0 = next((i for i, t in enumerate(txt) if t.startswith('mov eax, dword ptr fs:[0]')), None)
        check(seh is not None and k0 is not None and k0 + 1 < len(txt) and txt[k0 + 1].startswith('mov dword ptr [0x%x], eax' % seh),
              'frame thunk keeps FS:[0] (the SEH chain head) in g_roam_resume_seh')
        fr = sym('_roam_fault_resume')
        if fr:
            rt = ['%s %s' % (i.mnemonic, i.op_str) for i in md.disasm(code(fr, 32), fr)]
            print('        fault resume: ' + ' | '.join(rt[:6]))
            kc = next((i for i, t in enumerate(rt) if t.startswith('call')), None)
            check(seh is not None and kc is not None and any(t.startswith('mov eax, dword ptr [0x%x]' % seh) for t in rt[:kc]) and
                  any(t.startswith('mov dword ptr fs:[0], eax') for t in rt[:kc]),
                  'the fault guard puts FS:[0] back before it calls into the plugin')
        else:
            check(False, 'symbol roam_fault_resume')
        ins = list(md.disasm(code(ct, 64), ct))
        txt = ['%s %s' % (i.mnemonic, i.op_str) for i in ins]
        print('        call thunk: ' + ' | '.join(txt[:20]))
        r = next((i for i, t in enumerate(txt) if t.startswith('ret')), None)
        check(r is not None and txt[r - 5].startswith('lea esp, [ebp - 0xc]'), 'call thunk restores esp from ebp after the call')
        check(any(t.startswith('call dword ptr [ebp + 8]') for t in txt), 'call thunk calls the function pointer argument')
    else:
        check(False, 'symbols of the thunks (NFSU2FreeRoam.dbg.asi, .map)')
    print('%s: %s' % (os.path.basename(asi), 'PASS' if not fails else 'FAIL (%d)' % len(fails)))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
