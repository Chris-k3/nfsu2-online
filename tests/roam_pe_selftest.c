/* roam_pe_selftest.c -- the free-roam core's cross-platform check on the
 * Windows build: out/win/roam_selftest.dll (tests/roam_selftest.c on the very
 * roam_core.o and roam_libc.o linked into NFSU2FreeRoam.asi, built by
 * i686-w64-mingw32-gcc with the plugin's flags) is loaded by tests/asi_vm.c's
 * PE loader at a base it was not linked for, run under Unicorn (x87 at the
 * 24-bit precision the game's Direct3D device sets), and its byte stream is
 * compared with the arm64 build of the same test.
 *   out/roam_pe_selftest out/win/roam_selftest.dll
 */
#include "asi_vm.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>

int roam_selftest(uint8_t *out, int cap);
static uint8_t *g_m; static uint8_t g_bits[1u << 15];
static int committed(void *u, uint32_t a){ (void)u; return (g_bits[a >> 17] >> ((a >> 14) & 7)) & 1; }
static void commit(void *u, uint32_t a, uint32_t n){
    (void)u;
    for (uint32_t b = a >> 14; b <= (a + n - 1) >> 14; b++)
        if (!((g_bits[b >> 3] >> (b & 7)) & 1)){ mprotect(g_m + ((uint64_t)b << 14), 0x4000, PROT_READ | PROT_WRITE); g_bits[b >> 3] |= (uint8_t)(1u << (b & 7)); }
}
static int imp(void *u, xvm *vm, int idx, const char *dll, const char *name, uint32_t esp, uint32_t *eax){
    (void)u; (void)vm; (void)idx; (void)esp; (void)eax; fprintf(stderr, "unexpected import %s!%s\n", dll, name); return -1; }
int main(int argc, char **argv){
    if (argc < 2){ fprintf(stderr, "usage: roam_pe_selftest roam_selftest.dll\n"); return 2; }
    g_m = mmap(0, 1ull << 32, PROT_NONE, MAP_PRIVATE | MAP_ANON | MAP_NORESERVE, -1, 0);
    const uint32_t BASE = 0x00500000u, STACK = 0x00800000u, OUT = 0x00a00000u, OUTSZ = 0x00100000u;
    commit(0, STACK, 0x100000); commit(0, OUT, OUTSZ);
    xvm_cfg c = { 0, g_m, committed, 0, 0x007F, imp, 0, 0, 0, 0 };    /* FPCW 0x7F: 24-bit x87, as under D3D9 */
    xvm *vm = xvm_new(&c);
    xpe pe;
    if (xpe_load(&pe, vm, argv[1], 0, BASE, commit)){ fprintf(stderr, "cannot load %s\n", argv[1]); return 2; }
    xvm_bind_pe(vm, &pe);
    uint32_t fn = xpe_export(&pe, "roam_selftest_run");
    if (!fn){ fprintf(stderr, "no roam_selftest_run export\n"); return 2; }
    uint32_t r[XR__N] = {0}; r[XR_ESP] = STACK + 0x100000u - 64u;
    uint32_t args[3] = { 0, OUT, OUTSZ }; xvm_write(vm, r[XR_ESP], args, sizeof args);
    if (!xvm_call(vm, fn, r)){ fprintf(stderr, "x86 run stopped: %s\n", xvm_why(vm)); return 1; }
    int nx = (int)r[XR_EAX];
    uint8_t *no = malloc(OUTSZ);
    int nn = roam_selftest(no, (int)OUTSZ);
    printf("roam_pe_selftest: %s loaded at 0x%08x (linked for 0x%08x, %d relocations, %d imports); "
           "x86 (Unicorn) produced %d bytes, arm64 %d bytes\n", argv[1], BASE, pe.pref_base, pe.nreloc, pe.nimp, nx, nn);
    if (nx != nn){ printf("FAIL: lengths differ\n"); return 1; }
    for (int i = 0; i < nn; i++) if (g_m[OUT + i] != no[i]){ printf("FAIL: first difference at byte %d (x86 %02x, arm64 %02x)\n", i, g_m[OUT + i], no[i]); return 1; }
    uint32_t h = 0x811C9DC5u; for (int i = 0; i < nn; i++){ h ^= no[i]; h *= 0x01000193u; }
    printf("PASS: identical, %d bytes, FNV-1a %08x\n", nn, h);
    return 0;
}
