/* roam_x86_oracle.c -- is the free-roam core bit-identical on 32-bit x86?
 *
 * Runs tests/roam_selftest.c twice: natively (arm64, linked in) and as a
 * 32-bit x86 ELF object (clang -target i686, -msse2 -mfpmath=sse
 * -ffp-contract=off, the flags a Windows companion build would use) loaded
 * by a minimal ELF32 relocatable loader into Unicorn 2.1 and executed there.
 * Both produce a byte stream (every message encoding, decoded floats, CRCs,
 * the car-look record, exp/sqrt, matrix/quaternion conversions, the
 * interpolator's poses, a two-session exchange); they must be equal.
 *
 *   tools/roam_x86check.sh        (builds both and runs this)
 *   out/roam_x86_oracle out/roam_selftest_x86.o
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unicorn/unicorn.h>

int roam_selftest(uint8_t *out, int cap);    /* the native build */

#define BASE     0x00100000u   /* the object's sections */
#define STACK    0x00800000u
#define STACK_SZ 0x00100000u
#define OUTBUF   0x00a00000u
#define OUT_SZ   0x00100000u
#define SENTINEL 0xFFFE0000u

typedef struct { uint32_t name, type, flags, addr, off, size, link, info, align, entsize; } Shdr;
typedef struct { uint32_t name, value, size; uint8_t info, other; uint16_t shndx; } Sym;
static uint32_t rd32(const uint8_t *p){ return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static uint16_t rd16(const uint8_t *p){ return (uint16_t)(p[0] | p[1] << 8); }

static int g_returned;
static bool on_unmapped(uc_engine *uc, uc_mem_type t, uint64_t a, int sz, int64_t v, void *u){
    (void)uc; (void)t; (void)sz; (void)v; (void)u;
    if ((uint32_t)a == SENTINEL){ g_returned = 1; return false; }
    fprintf(stderr, "x86: unmapped access at 0x%08llx\n", (unsigned long long)a);
    return false;
}

int main(int argc, char **argv){
    if (argc < 2){ fprintf(stderr, "usage: roam_x86_oracle roam_selftest_x86.o\n"); return 2; }
    FILE *f = fopen(argv[1], "rb");
    if (!f){ perror(argv[1]); return 2; }
    fseek(f, 0, SEEK_END); long fl = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *e = malloc((size_t)fl); if (fread(e, 1, (size_t)fl, f) != (size_t)fl) return 2; fclose(f);
    if (memcmp(e, "\x7f" "ELF", 4) || e[4] != 1 || rd16(e + 16) != 1 || rd16(e + 18) != 3){
        fprintf(stderr, "not an ELF32 i386 relocatable object\n"); return 2; }
    uint32_t shoff = rd32(e + 32), shentsize = rd16(e + 46), shnum = rd16(e + 48);
    Shdr *sh = calloc(shnum, sizeof *sh);
    for (uint32_t i = 0; i < shnum; i++){
        const uint8_t *p = e + shoff + i * shentsize;
        sh[i].name = rd32(p); sh[i].type = rd32(p + 4); sh[i].flags = rd32(p + 8); sh[i].off = rd32(p + 16);
        sh[i].size = rd32(p + 20); sh[i].link = rd32(p + 24); sh[i].info = rd32(p + 28); sh[i].align = rd32(p + 32); sh[i].entsize = rd32(p + 36);
    }
    /* lay the allocated sections out */
    uint32_t at = BASE, *base = calloc(shnum, 4);
    for (uint32_t i = 0; i < shnum; i++){
        if (!(sh[i].flags & 2u)) continue;                     /* SHF_ALLOC */
        uint32_t al = sh[i].align ? sh[i].align : 1; at = (at + al - 1) & ~(al - 1);
        base[i] = at; at += sh[i].size;
    }
    uint32_t img_sz = ((at - BASE) + 0xFFFu) & ~0xFFFu;
    uint8_t *img = calloc(1, img_sz);
    for (uint32_t i = 0; i < shnum; i++)
        if ((sh[i].flags & 2u) && sh[i].type != 8u) memcpy(img + (base[i] - BASE), e + sh[i].off, sh[i].size);   /* not NOBITS */
    /* symbols */
    uint32_t symtab = 0; for (uint32_t i = 0; i < shnum; i++) if (sh[i].type == 2u) symtab = i;
    if (!symtab){ fprintf(stderr, "no symbol table\n"); return 2; }
    uint32_t nsym = sh[symtab].size / 16; const uint8_t *strtab = e + sh[sh[symtab].link].off;
    Sym *sy = calloc(nsym, sizeof *sy);
    uint32_t entry = 0;
    for (uint32_t i = 0; i < nsym; i++){
        const uint8_t *p = e + sh[symtab].off + i * 16;
        sy[i].name = rd32(p); sy[i].value = rd32(p + 4); sy[i].size = rd32(p + 8); sy[i].info = p[12]; sy[i].shndx = rd16(p + 14);
        if (!strcmp((const char *)strtab + sy[i].name, "roam_selftest") && sy[i].shndx) entry = base[sy[i].shndx] + sy[i].value;
    }
    if (!entry){ fprintf(stderr, "roam_selftest not in the object\n"); return 2; }
    /* relocations: R_386_32 (1) S + A, R_386_PC32 (2) / R_386_PLT32 (4) S + A - P */
    int nrel = 0;
    for (uint32_t i = 0; i < shnum; i++){
        if (sh[i].type != 9u) continue;                        /* SHT_REL */
        uint32_t tgt = sh[i].info;
        if (!(sh[tgt].flags & 2u)) continue;                   /* debug sections */
        for (uint32_t r = 0; r < sh[i].size / 8; r++){
            const uint8_t *p = e + sh[i].off + r * 8;
            uint32_t off = rd32(p), info = rd32(p + 4), type = info & 0xFF, si = info >> 8;
            const Sym *s = &sy[si];
            if (!s->shndx){ fprintf(stderr, "undefined symbol %s\n", strtab + s->name); return 2; }
            uint32_t S = base[s->shndx] + s->value, P = base[tgt] + off;
            uint8_t *w = img + (P - BASE); uint32_t A = rd32(w), v;
            if (type == 1) v = S + A; else if (type == 2 || type == 4) v = S + A - P;
            else { fprintf(stderr, "relocation type %u not handled\n", type); return 2; }
            w[0] = (uint8_t)v; w[1] = (uint8_t)(v >> 8); w[2] = (uint8_t)(v >> 16); w[3] = (uint8_t)(v >> 24);
            nrel++;
        }
    }
    /* run it */
    uc_engine *uc;
    if (uc_open(UC_ARCH_X86, UC_MODE_32, &uc)){ fprintf(stderr, "uc_open failed\n"); return 2; }
    uc_mem_map(uc, BASE, img_sz, UC_PROT_ALL); uc_mem_write(uc, BASE, img, img_sz);
    uc_mem_map(uc, STACK, STACK_SZ, UC_PROT_READ | UC_PROT_WRITE);
    uc_mem_map(uc, OUTBUF, OUT_SZ, UC_PROT_READ | UC_PROT_WRITE);
    uc_hook hk; uc_hook_add(uc, &hk, UC_HOOK_MEM_UNMAPPED, (void *)on_unmapped, 0, 1, 0);
    uint32_t cr0 = 0x00000033u, cr4 = 0x00000600u;            /* MP|ET|NE|PE, OSFXSR|OSXMMEXCPT: SSE on */
    uc_reg_write(uc, UC_X86_REG_CR0, &cr0); uc_reg_write(uc, UC_X86_REG_CR4, &cr4);
    uint32_t mx = 0x1F80; uc_reg_write(uc, UC_X86_REG_MXCSR, &mx);
    uint16_t cw = 0x007F; uc_reg_write(uc, UC_X86_REG_FPCW, &cw);   /* x87 at 24-bit precision, as D3D9 sets it: SSE code must not care */
    uint32_t esp = STACK + STACK_SZ - 64, args[3] = { SENTINEL, OUTBUF, OUT_SZ };
    uc_mem_write(uc, esp, args, sizeof args);
    uc_reg_write(uc, UC_X86_REG_ESP, &esp);
    g_returned = 0;
    uc_err err = uc_emu_start(uc, entry, 0, 0, 0);
    uint32_t eax = 0, eip = 0; uc_reg_read(uc, UC_X86_REG_EAX, &eax); uc_reg_read(uc, UC_X86_REG_EIP, &eip);
    if (!g_returned){ fprintf(stderr, "x86 run did not return (err %d: %s, eip 0x%08x)\n", err, uc_strerror(err), eip); return 1; }
    uint8_t *xo = malloc(OUT_SZ), *no = malloc(OUT_SZ);
    uc_mem_read(uc, OUTBUF, xo, eax);
    int nn = roam_selftest(no, OUT_SZ);
    printf("roam_x86_oracle: object %ld bytes, %d relocations; x86 (Unicorn) produced %u bytes, arm64 %d bytes\n", fl, nrel, eax, nn);
    if ((int)eax != nn){ printf("FAIL: lengths differ\n"); return 1; }
    for (int i = 0; i < nn; i++) if (xo[i] != no[i]){ printf("FAIL: first difference at byte %d (x86 %02x, arm64 %02x)\n", i, xo[i], no[i]); return 1; }
    uint32_t h = 0x811C9DC5u; for (int i = 0; i < nn; i++){ h ^= no[i]; h *= 0x01000193u; }
    printf("PASS: identical, %d bytes, FNV-1a %08x\n", nn, h);
    uc_close(uc);
    return 0;
}
