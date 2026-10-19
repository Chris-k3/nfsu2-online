/* net_oracle.c -- differential test of the code that produces SPEED2.EXE's
 * network bytes: the ORIGINAL x86 functions run under Unicorn (an x86
 * emulator) and the lifted C runs natively, from the same inputs and the
 * same guest memory; return values and every byte of writable guest memory
 * (.data, the test area with its stack, the TEB) are compared.  A mismatch
 * would mean the Mac puts different bytes on the wire than a Windows PC.
 *
 * Cases (random inputs, fixed seed):
 *   crc32       0x43BCD0  CRC-32 (R_BI_DATACRC, the tuning check)
 *   bitwrite    0x581D00  race-message bit packer (MSB first)
 *   bitread     0x581D90  race-message bit reader
 *   qsetup      0x581F50  float quantiser set-up (min, max, bits)
 *   qencode     0x581FE0  float -> quantised int (x87, _ftol)
 *   qdecode     0x582030  quantised int -> float (x87, result in ST0)
 *   addrfmt     0x742E60  DirtyAddr "$%08x" text (lobby ADDR/LADDR, sprintf)
 *   addrparse   0x742E30  DirtyAddr text -> address
 *   advtquery   0x74F640  ProtoAdvt query packet, captured at sendto
 *   sendto      0x74A5C0  DirtySock SocketSendto: UDP and the raw-ICMP path
 *                         (IP header stripped, IP_TTL), captured at Winsock
 * The Winsock calls are not the HLE here: both runs call the same stub,
 * reached through the game's own IAT slots (pointed at a guest address that
 * Unicorn hooks and dispatch_patch maps for the lifted code), which records
 * the exact bytes and arguments handed to Winsock.
 *
 * x87: the lifted code computes in doubles; Unicorn honours the precision
 * control.  Float cases run at PC=53 (Windows' default) and PC=24 (the game
 * thread after CreateDevice without D3DCREATE_FPU_PRESERVE); a PC=24
 * difference is reported, not failed.
 *
 * Build and run: tests/net/oracle.sh (needs Unicorn 2.1.x, UNICORN_INC/LIB).
 * Unicorn is GPLv2: this binary is a test tool only, never part of the app. */
#include "cpu.h"
#include "decls.h"
#include <unicorn/unicorn.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void dispatch_init(void); void win32_init(void); uint32_t win32_heap_used(void);
typedef void (*guest_fn)(CPU *);
void dispatch_patch(uint32_t a, guest_fn f);

#define TA      0x00E00000u            /* test area: inputs, objects, stack */
#define TA_SZ   0x00200000u
#define STK     (TA + TA_SZ - 0x1000u) /* initial esp */
#define TEB     0x00C00000u
#define STUBVA  0x00EF0000u            /* fake import entry points (in the test area) */
#define SENT    0xFFFE0000u            /* return sentinel (unmapped) */
#define GDT_VA  0xFFFF0000u
/* writable image ranges copied privately for Unicorn */
static struct { uint32_t va, sz; } k_rw[] = { { 0x007E8000u, 0x000D4000u }, { 0x008BC000u, 0x00076000u },
                                             { TA, TA_SZ }, { TEB, 0x2000u }, { 0x10000000u, 0x10000u } };
#define NRW 5
static uint8_t *g_rw[NRW];
static uc_engine *uc;
static uint8_t g_gdt[0x1000];
static int g_pc = 53;
/* The lifted side runs with the x87 control word of the case, as the
 * original under Unicorn does (cw below): with X87PC=1 (gen.sh's default)
 * the lifted code rounds to the precision control in fcw, so a fixed
 * 0x037F (PC=64) would compare PC=64 lifted code against PC=24/53 x86. */
static uint16_t case_fcw(void){ return (uint16_t)(g_pc == 24 ? 0x007f : g_pc == 53 ? 0x027f : 0x037f); }
static int g_done, g_fault; static uint32_t g_fault_at;

/* ---- import stubs, the same for both runs ----
 * Winsock calls are recorded (name, arguments, the bytes handed over); the
 * TEB-only kernel32 calls the CRT makes on the way (per-thread data, last
 * error) are answered from each run's own TEB.  Both runs reach a stub through
 * the game's IAT slot, pointed at STUBVA + 16 * index: Unicorn hooks that
 * address, dispatch_patch maps it to lifted_stub for the lifted code. */
typedef struct { char name[16]; uint32_t args[6]; uint8_t data[1024]; uint32_t len; } Rec;
static Rec g_rec[2][8]; static int g_nrec[2]; static int g_side;     /* 0 = Unicorn, 1 = lifted */
enum { ST_SENDTO, ST_SEND, ST_SETSOCKOPT, ST_GETLASTERROR, ST_SETLASTERROR, ST_TLSGET, ST_TLSSET, ST_GETTID,
       ST_ENTERCS, ST_LEAVECS, ST_XCHG, ST_N };
static const struct { const char *name; int nargs; uint32_t iat; } k_stub[ST_N] = {
    { "sendto", 6, 0x007833f0u }, { "send", 4, 0x007833f4u }, { "setsockopt", 5, 0x007833ccu },
    { "GetLastError", 0, 0x00783114u }, { "SetLastError", 1, 0x007830e4u },
    { "TlsGetValue", 1, 0x007832b0u }, { "TlsSetValue", 2, 0x007832acu }, { "GetCurrentThreadId", 0, 0x00783200u },
    { "EnterCriticalSection", 1, 0x007831a8u }, { "LeaveCriticalSection", 1, 0x007831bcu },
    { "InterlockedExchange", 2, 0x007831acu } };
static uint8_t g_ucbuf[2048];
static const uint8_t *mem_view(uint32_t p, uint32_t n){
    if (!p) return 0;
    if (g_side == 1) return mem_is_committed(p) ? g_mem + p : 0;
    if (n > sizeof g_ucbuf || uc_mem_read(uc, p, g_ucbuf, n)) return 0;
    return g_ucbuf;
}
static uint32_t m_rd32(uint32_t a){ const uint8_t *v = mem_view(a, 4); uint32_t r = 0; if (v) memcpy(&r, v, 4); return r; }
static void m_wr32(uint32_t a, uint32_t v){ if (g_side == 1) MR32(a) = v; else uc_mem_write(uc, a, &v, 4); }
static uint32_t stub_call(int which, const uint32_t *a){
    switch (which){
    case ST_GETLASTERROR: return m_rd32(TEB + 0x34);
    case ST_SETLASTERROR: m_wr32(TEB + 0x34, a[0]); return 0;
    case ST_TLSGET: return a[0] < 64 ? m_rd32(m_rd32(TEB + 0x2C) + 4 * a[0]) : 0;
    case ST_TLSSET: if (a[0] < 64) m_wr32(m_rd32(TEB + 0x2C) + 4 * a[0], a[1]); return a[0] < 64;
    case ST_GETTID: return m_rd32(TEB + 0x24);
    case ST_ENTERCS: case ST_LEAVECS: return 0;          /* one thread here */
    case ST_XCHG: { uint32_t o = m_rd32(a[0]); m_wr32(a[0], a[1]); return o; }
    default: break;
    }
    if (g_nrec[g_side] >= 8) return 0;
    Rec *r = &g_rec[g_side][g_nrec[g_side]++]; memset(r, 0, sizeof *r);
    snprintf(r->name, sizeof r->name, "%s", k_stub[which].name);
    for (int i = 0; i < k_stub[which].nargs; i++) r->args[i] = a[i];
    uint32_t p = which == ST_SETSOCKOPT ? a[3] : a[1], n = which == ST_SETSOCKOPT ? a[4] : a[2];
    if (n > sizeof r->data - 16) n = sizeof r->data - 16;
    const uint8_t *src = mem_view(p, n); if (src) memcpy(r->data, src, n);
    r->len = n;
    if (which == ST_SENDTO && a[4]){                     /* the destination sockaddr too */
        const uint8_t *sa = mem_view(a[4], 16); if (sa){ memcpy(r->data + n, sa, 16); r->len += 16; }
    }
    return which == ST_SETSOCKOPT ? 0 : a[2];            /* bytes "sent" */
}
static int g_stub_index;
static void lifted_stub(CPU *c, int which){
    uint32_t ret; POP32(ret);
    uint32_t a[6]; for (int i = 0; i < k_stub[which].nargs; i++) a[i] = MR32(c->esp + 4u * (uint32_t)i);
    c->eax = stub_call(which, a);
    c->esp += 4u * (uint32_t)k_stub[which].nargs; c->eip = ret;
}
#define LS(i) static void ls_##i(CPU *c){ lifted_stub(c, i); }
LS(0) LS(1) LS(2) LS(3) LS(4) LS(5) LS(6) LS(7) LS(8) LS(9) LS(10)
static const guest_fn k_ls[ST_N] = { ls_0, ls_1, ls_2, ls_3, ls_4, ls_5, ls_6, ls_7, ls_8, ls_9, ls_10 };
static void uc_stub_hook(uc_engine *u, uint64_t addr, uint32_t size, void *ud){
    (void)size; (void)ud;
    int which = (int)((addr - STUBVA) / 16);
    if (which < 0 || which >= ST_N || (addr - STUBVA) % 16) return;
    uint32_t esp, ret, a[6]; uc_reg_read(u, UC_X86_REG_ESP, &esp);
    uc_mem_read(u, esp, &ret, 4);
    for (int i = 0; i < k_stub[which].nargs; i++) uc_mem_read(u, esp + 4 + 4u * (uint32_t)i, &a[i], 4);
    uint32_t eax = stub_call(which, a);
    esp += 4u + 4u * (uint32_t)k_stub[which].nargs;
    uc_reg_write(u, UC_X86_REG_ESP, &esp); uc_reg_write(u, UC_X86_REG_EAX, &eax); uc_reg_write(u, UC_X86_REG_EIP, &ret);
}

/* ---- Unicorn machine ---- */
static void gdt_entry(int i, uint32_t base, uint32_t limit, int code, int dpl){
    uint8_t *d = g_gdt + 8 * i; limit >>= 12;
    d[0] = limit & 0xFF; d[1] = (limit >> 8) & 0xFF; d[2] = base & 0xFF; d[3] = (base >> 8) & 0xFF; d[4] = (base >> 16) & 0xFF;
    d[5] = (uint8_t)(0x80 | (dpl << 5) | 0x10 | (code ? 0x0A : 0x02)); d[6] = (uint8_t)(0xC0 | ((limit >> 16) & 0x0F)); d[7] = (base >> 24) & 0xFF;
}
static bool on_unmapped(uc_engine *u, uc_mem_type t, uint64_t a, int sz, int64_t v, void *ud){
    (void)u; (void)t; (void)sz; (void)v; (void)ud;
    if ((uint32_t)a == SENT){ g_done = 1; return false; }
    g_fault = 1; g_fault_at = (uint32_t)a; return false;
}
static void uc_setup(void){
    if (uc_open(UC_ARCH_X86, UC_MODE_32, &uc)){ fprintf(stderr, "uc_open failed\n"); exit(2); }
    /* headers, .text, .rdata (with the IAT): read-only views of guest memory */
    uc_mem_map_ptr(uc, 0x00400000u, 0x003E8000u, UC_PROT_READ | UC_PROT_EXEC, g_mem + 0x00400000u);
    for (int i = 0; i < NRW; i++){
        g_rw[i] = aligned_alloc(0x4000, (k_rw[i].sz + 0x3FFFu) & ~0x3FFFu);
        memcpy(g_rw[i], g_mem + k_rw[i].va, k_rw[i].sz);
        if (uc_mem_map_ptr(uc, k_rw[i].va, k_rw[i].sz, UC_PROT_ALL, g_rw[i])){ fprintf(stderr, "map %x failed\n", k_rw[i].va); exit(2); }
    }
    uc_mem_map_ptr(uc, GDT_VA, 0x1000, UC_PROT_READ | UC_PROT_WRITE, g_gdt);
    gdt_entry(1, 0, 0xFFFFF000u, 1, 3); gdt_entry(2, 0, 0xFFFFF000u, 0, 3); gdt_entry(3, 0, 0xFFFFF000u, 0, 0);
    gdt_entry(4, TEB, 0xFFFFF000u, 0, 3);
    uc_mem_write(uc, GDT_VA, g_gdt, 8 * 6);
    uc_x86_mmr gdtr = { 0, GDT_VA, 8 * 6 - 1, 0 }; uc_reg_write(uc, UC_X86_REG_GDTR, &gdtr);
    uint32_t sel = (3 << 3) | 0; uc_reg_write(uc, UC_X86_REG_SS, &sel);
    sel = (2 << 3) | 3; uc_reg_write(uc, UC_X86_REG_DS, &sel); uc_reg_write(uc, UC_X86_REG_ES, &sel); uc_reg_write(uc, UC_X86_REG_GS, &sel);
    sel = (4 << 3) | 3; uc_reg_write(uc, UC_X86_REG_FS, &sel);
    uc_hook h;
    uc_hook_add(uc, &h, UC_HOOK_MEM_UNMAPPED | UC_HOOK_MEM_PROT, (void *)on_unmapped, 0, 1, 0);
    uc_hook_add(uc, &h, UC_HOOK_CODE, (void *)uc_stub_hook, 0, STUBVA, STUBVA + 16 * ST_N);
}
/* write test inputs into both memories */
static void put(uint32_t a, const void *p, uint32_t n){ memcpy(g_mem + a, p, n); uc_mem_write(uc, a, p, n); }
static void put32(uint32_t a, uint32_t v){ put(a, &v, 4); }
static uint32_t ta_bump;
static uint32_t talloc(uint32_t n){ uint32_t p = (ta_bump + 15u) & ~15u; ta_bump = p + n; return p; }

/* Run va with the given stack arguments and registers in both worlds.
 * Returns 1 if both returned. */
typedef struct { uint32_t eax, ecx, edx, ebx, esi, edi, ebp, esp; double st0; int top; } Out;
static int run(uint32_t va, guest_fn lifted, const uint32_t *args, int nargs, uint32_t ecx, uint32_t edx, Out *ou, Out *ol){
    uint32_t esp = STK - 4u * (uint32_t)(nargs + 1);
    put32(esp, SENT);
    for (int i = 0; i < nargs; i++) put32(esp + 4 + 4u * (uint32_t)i, args[i]);
    /* Unicorn */
    uint32_t z = 0, ebp = 0x12345678u, ebx = 0x0BADF00Du, esi = 0x51515151u, edi = 0xD1D1D1D1u, fl = 0x202;
    uc_reg_write(uc, UC_X86_REG_EAX, &z); uc_reg_write(uc, UC_X86_REG_ECX, &ecx); uc_reg_write(uc, UC_X86_REG_EDX, &edx);
    uc_reg_write(uc, UC_X86_REG_EBX, &ebx); uc_reg_write(uc, UC_X86_REG_ESI, &esi); uc_reg_write(uc, UC_X86_REG_EDI, &edi);
    uc_reg_write(uc, UC_X86_REG_EBP, &ebp); uc_reg_write(uc, UC_X86_REG_ESP, &esp); uc_reg_write(uc, UC_X86_REG_EFLAGS, &fl);
    uint16_t cw = (uint16_t)(0x007F | ((g_pc == 24 ? 0 : g_pc == 53 ? 2 : 3) << 8)), sw = 0, tag = 0xFFFF;
    uc_reg_write(uc, UC_X86_REG_FPCW, &cw); uc_reg_write(uc, UC_X86_REG_FPSW, &sw); uc_reg_write(uc, UC_X86_REG_FPTAG, &tag);
    g_side = 0; g_nrec[0] = 0; g_done = g_fault = 0;
    uc_emu_start(uc, va, 0, 0, 20000000);
    uc_reg_read(uc, UC_X86_REG_EAX, &ou->eax); uc_reg_read(uc, UC_X86_REG_ECX, &ou->ecx); uc_reg_read(uc, UC_X86_REG_EDX, &ou->edx);
    uc_reg_read(uc, UC_X86_REG_EBX, &ou->ebx); uc_reg_read(uc, UC_X86_REG_ESI, &ou->esi); uc_reg_read(uc, UC_X86_REG_EDI, &ou->edi);
    uc_reg_read(uc, UC_X86_REG_EBP, &ou->ebp); uc_reg_read(uc, UC_X86_REG_ESP, &ou->esp);
    uc_reg_read(uc, UC_X86_REG_FPSW, &sw); ou->top = (sw >> 11) & 7;
    { uint8_t f[10]; uc_reg_read(uc, UC_X86_REG_FP0 + ou->top, f);   /* FPn are physical registers: ST(0) = R[top] */
      uint64_t m; uint16_t se; memcpy(&m, f, 8); memcpy(&se, f + 8, 2);
      int e = se & 0x7FFF; ou->st0 = (e == 0 && m == 0) ? 0.0 : ldexp((double)m, e - 16383 - 63); if (se >> 15) ou->st0 = -ou->st0; }
    int okU = g_done && !g_fault;
    if (!okU){ fprintf(stderr, "  unicorn: %s at %08x\n", g_fault ? "fault" : "did not return", g_fault_at); }
    /* lifted */
    CPU c; memset(&c, 0, sizeof c);
    c.eax = 0; c.ecx = ecx; c.edx = edx; c.ebx = ebx; c.esi = esi; c.edi = edi; c.ebp = ebp; c.esp = esp;
    c.fs_base = TEB; c.gs_base = TEB; c.fcw = case_fcw(); c.top = 0;
    MR32(esp) = SENT;
    g_side = 1; g_nrec[1] = 0;
    lifted(&c);
    ol->eax = c.eax; ol->ecx = c.ecx; ol->edx = c.edx; ol->ebx = c.ebx; ol->esi = c.esi; ol->edi = c.edi; ol->ebp = c.ebp; ol->esp = c.esp;
    ol->top = c.top & 7; ol->st0 = c.st[c.top & 7];
    return okU;
}
/* compare the writable memories; resync the Unicorn copy afterwards */
static int g_mem_diffs;
static uint32_t g_dead_lo, g_dead_hi;     /* dead stack below the final esp: not compared */
static int memcmp_all(const char *what, int verbose){
    int nd = 0;
    for (int i = 0; i < NRW; i++){
        if (!memcmp(g_rw[i], g_mem + k_rw[i].va, k_rw[i].sz)) continue;
        for (uint32_t o = 0; o < k_rw[i].sz; o++)
            if (g_rw[i][o] != g_mem[k_rw[i].va + o] && !(k_rw[i].va + o >= g_dead_lo && k_rw[i].va + o < g_dead_hi)){
                if (verbose && nd < 8) fprintf(stderr, "  %s: byte %08x unicorn %02x lifted %02x\n", what, k_rw[i].va + o, g_rw[i][o], g_mem[k_rw[i].va + o]);
                nd++;
            }
        memcpy(g_rw[i], g_mem + k_rw[i].va, k_rw[i].sz);
    }
    g_mem_diffs += nd;
    return nd;
}
static int recs_equal(void){
    if (g_nrec[0] != g_nrec[1]) return 0;
    for (int i = 0; i < g_nrec[0]; i++){
        Rec *a = &g_rec[0][i], *b = &g_rec[1][i];
        if (strcmp(a->name, b->name) || memcmp(a->args, b->args, sizeof a->args) || a->len != b->len || memcmp(a->data, b->data, a->len)) return 0;
    }
    return 1;
}

/* ---- the cases ---- */
static uint64_t rs = 0x9E3779B97F4A7C15ull;
static uint32_t rnd(void){ rs ^= rs << 13; rs ^= rs >> 7; rs ^= rs << 17; return (uint32_t)(rs >> 16); }
static float rndf(float lo, float hi){ return lo + (hi - lo) * (float)(rnd() & 0xFFFFFF) / (float)0xFFFFFF; }
typedef struct { const char *name; int n, same, regdiff, memdiff, recdiff, fail, st0diff; double st0max; } Stat;
static Stat S[16]; static int nS;
static Stat *stat(const char *n){ for (int i = 0; i < nS; i++) if (!strcmp(S[i].name, n)) return &S[i]; memset(&S[nS], 0, sizeof S[0]); S[nS].name = n; return &S[nS++]; }
static void tally(Stat *s, int okU, const Out *u, const Out *l, int cmp_regs, int cmp_st0){
    s->n++;
    if (!okU){ s->fail++; return; }
    int d = 0;
    if (u->eax != l->eax || u->esp != l->esp || u->ebx != l->ebx || u->esi != l->esi || u->edi != l->edi || u->ebp != l->ebp ||
        (cmp_regs && (u->ecx != l->ecx || u->edx != l->edx))){ s->regdiff++; d = 1;
        if (s->regdiff <= 3) fprintf(stderr, "  %s: eax %08x/%08x esp %08x/%08x ecx %08x/%08x edx %08x/%08x\n", s->name,
                                     u->eax, l->eax, u->esp, l->esp, u->ecx, l->ecx, u->edx, l->edx); }
    if (cmp_st0 && memcmp(&u->st0, &l->st0, 8) && !(u->st0 != u->st0 && l->st0 != l->st0)){
        s->st0diff++; d = 1;
        double rel = fabs(u->st0 - l->st0) / (fabs(u->st0) > 1e-30 ? fabs(u->st0) : 1e-30);
        if (rel > s->st0max) s->st0max = rel;
    }
    g_dead_hi = l->esp; g_dead_lo = l->esp - 0x10000u;
    int md = memcmp_all(s->name, s->memdiff < 3);
    g_dead_lo = g_dead_hi = 0;
    if (md){ s->memdiff++; d = 1; }
    if (!recs_equal()){ s->recdiff++; d = 1; }
    if (!d) s->same++;
}

static void c_crc32(int n){
    Stat *s = stat("crc32");
    for (int k = 0; k < n; k++){
        ta_bump = TA + 0x1000;
        uint32_t len = k < 4 ? (uint32_t)k : rnd() % 700, buf = talloc(len + 4);
        uint8_t tmp[704]; for (uint32_t i = 0; i < len; i++) tmp[i] = (uint8_t)rnd(); put(buf, tmp, len);
        uint32_t a[3] = { buf, len, k & 1 ? 0xFFFFFFFFu : rnd() }; Out u, l;
        int ok = run(0x0043bcd0u, sub_0043bcd0, a, 3, 0, 0, &u, &l);
        tally(s, ok, &u, &l, 0, 0);
    }
}
static uint32_t g_stream;                 /* bit stream object: 0x400 bytes + write pos +0x400 + read pos +0x404 */
static void c_bits(int n){
    Stat *sw = stat("bitwrite"), *sr = stat("bitread");
    for (int k = 0; k < n; k++){
        ta_bump = TA + 0x1000;
        g_stream = talloc(0x410);
        uint8_t z[0x410]; memset(z, 0, sizeof z); put(g_stream, z, sizeof z);
        int nw = 1 + (int)(rnd() % 40);
        uint32_t vals[48], bits[48];
        for (int i = 0; i < nw; i++){
            bits[i] = 1 + rnd() % 32; vals[i] = rnd() ^ (rnd() << 16);
            if (bits[i] < 32) vals[i] &= (1u << bits[i]) - 1;
            uint32_t a[2] = { vals[i], bits[i] }; Out u, l;
            int ok = run(0x00581d00u, sub_00581d00, a, 2, g_stream, 0, &u, &l);
            tally(sw, ok, &u, &l, 0, 0);
        }
        uint32_t out = talloc(4);
        for (int i = 0; i < nw; i++){
            uint32_t a[2] = { out, bits[i] }; Out u, l;
            int ok = run(0x00581d90u, sub_00581d90, a, 2, g_stream, 0, &u, &l);
            tally(sr, ok, &u, &l, 0, 0);
        }
    }
}
static void c_quant(int n){
    Stat *ss = stat("qsetup"), *se = stat("qencode"), *sd = stat("qdecode");
    for (int k = 0; k < n; k++){
        ta_bump = TA + 0x1000;
        uint32_t q = talloc(0x150), name = talloc(16);
        uint8_t z[0x150]; memset(z, 0, sizeof z); put(q, z, sizeof z); put(name, "q_test", 7);
        float mn = rndf(-500.f, 0.f), mx = mn + rndf(0.01f, 2000.f); uint32_t nb = 2 + rnd() % 22;
        uint32_t a[4]; memcpy(&a[1], &mn, 4); memcpy(&a[2], &mx, 4); a[0] = name; a[3] = nb;
        Out u, l;
        int ok = run(0x00581f50u, sub_00581f50, a, 4, q, 0, &u, &l);
        tally(ss, ok, &u, &l, 0, 0);
        for (int i = 0; i < 20; i++){
            float v = i < 2 ? (i ? mx + 1.f : mn - 1.f) : rndf(mn - 0.1f * (mx - mn), mx + 0.1f * (mx - mn));
            uint32_t b; memcpy(&b, &v, 4);
            ok = run(0x00581fe0u, sub_00581fe0, &b, 1, q, 0, &u, &l);
            tally(se, ok, &u, &l, 0, 0);
            uint32_t qi = rnd() % (1u << nb);
            ok = run(0x00582030u, sub_00582030, &qi, 1, q, 0, &u, &l);
            /* the result is in ST0; the float a caller would store is compared */
            float fu = (float)u.st0, fl = (float)l.st0;
            u.st0 = fu; l.st0 = fl;
            tally(sd, ok, &u, &l, 0, 1);
        }
    }
}
static void c_addr(int n){
    Stat *sf = stat("addrfmt"), *sp = stat("addrparse");
    { /* warm-up: the CRT's lazy locale bookkeeping (first sprintf/strtoul of
       * the thread) happens once, in the lifted run, then both copies agree */
      ta_bump = TA + 0x1000;
      uint32_t buf = talloc(32), ap = talloc(4), out = talloc(4), str = talloc(16);
      put32(ap, 0x0100007Fu); put(str, "$7f000001", 10);
      CPU c; memset(&c, 0, sizeof c); c.fs_base = c.gs_base = TEB; c.fcw = case_fcw(); g_side = 1;
      c.esp = STK - 12; MR32(c.esp) = SENT; MR32(c.esp + 4) = buf; MR32(c.esp + 8) = ap; sub_00742e60(&c);
      c.esp = STK - 16; MR32(c.esp) = SENT; MR32(c.esp + 4) = out; MR32(c.esp + 8) = 4; MR32(c.esp + 12) = str; sub_00742e30(&c);
      memcmp_all("warm-up", 0); g_mem_diffs = 0; }
    for (int k = 0; k < n; k++){
        ta_bump = TA + 0x1000;
        uint32_t buf = talloc(32), ap = talloc(4), out = talloc(4), str = talloc(16);
        uint8_t z[32]; memset(z, 0xEE, 32); put(buf, z, 32);
        put32(ap, rnd() ^ (rnd() << 16));
        uint32_t a[2] = { buf, ap }; Out u, l;
        int ok = run(0x00742e60u, sub_00742e60, a, 2, 0, 0, &u, &l);
        tally(sf, ok, &u, &l, 0, 0);
        char t[16]; snprintf(t, sizeof t, "$%08x", rnd() ^ (rnd() << 16)); put(str, t, (uint32_t)strlen(t) + 1);
        uint32_t b[3] = { out, 4, str };
        ok = run(0x00742e30u, sub_00742e30, b, 3, 0, 0, &u, &l);
        tally(sp, ok, &u, &l, 0, 0);
    }
}
static void c_advt(int n){
    Stat *s = stat("advtquery");
    for (int k = 0; k < n; k++){
        ta_bump = TA + 0x1000;
        uint32_t sock = talloc(0x50), adv = talloc(0x80);
        uint8_t z[0x80]; memset(z, 0, sizeof z); put(sock, z, 0x50); put(adv, z, 0x80);
        put32(sock + 0xC, 2); put32(sock + 0x18, 0x1000u + 4u * (rnd() % 64));     /* SOCK_DGRAM, Winsock handle */
        put32(adv + 0x38, sock);
        uint8_t sa[16] = { 2, 0, 0x27, 0x0F, 255, 255, 255, 255 };              /* 255.255.255.255:9999 */
        if (k & 1){ sa[4] = 10; sa[5] = 77; sa[6] = 0; sa[7] = (uint8_t)(2 + rnd() % 200); }
        put(adv + 0x3C, sa, 16);
        Out u, l;
        int ok = run(0x0074f640u, sub_0074f640, 0, 0, 0, adv, &u, &l);
        tally(s, ok, &u, &l, 0, 0);
        if (k == 0 && g_nrec[1]){
            Rec *r = &g_rec[1][0];
            fprintf(stderr, "  advtquery: %s(handle %x, len %u, flags %u, tolen %u): ", r->name, r->args[0], r->args[2], r->args[3], r->args[5]);
            for (int i = 0; i < 16; i++) fprintf(stderr, "%02x", r->data[i]);
            fprintf(stderr, "... to %u.%u.%u.%u:%u\n", r->data[384 + 4], r->data[384 + 5], r->data[384 + 6], r->data[384 + 7], r->data[384 + 2] << 8 | r->data[384 + 3]);
        }
    }
}
static void c_sendto(int n){
    Stat *s = stat("sendto");
    for (int k = 0; k < n; k++){
        ta_bump = TA + 0x1000;
        uint32_t sock = talloc(0x50), buf = talloc(600), to = talloc(16);
        uint8_t z[0x50]; memset(z, 0, sizeof z); put(sock, z, 0x50);
        int raw = k % 3 == 0;
        put32(sock + 0xC, raw ? 3 : 2); put32(sock + 0x18, 0x1004u);
        uint32_t len = raw ? 20 + 8 + rnd() % 64 : 1 + rnd() % 544;
        uint8_t d[600]; for (uint32_t i = 0; i < len; i++) d[i] = (uint8_t)rnd();
        if (raw){ d[0] = 0x45; d[8] = (uint8_t)(1 + rnd() % 255); d[9] = 1; }       /* guest-built IPv4 header, TTL */
        put(buf, d, len);
        uint8_t sa[16] = { 2, 0, (uint8_t)(rnd() >> 8), (uint8_t)rnd(), 10, 77, 0, (uint8_t)(2 + rnd() % 200) };
        sa[8] = raw ? d[8] : 0;                                                     /* DirtySock keeps the TTL in sin_zero */
        put(to, sa, 16);
        uint32_t a[6] = { sock, buf, len, 0, (k & 4) && !raw ? 0u : to, 16 };
        Out u, l;
        int ok = run(0x0074a5c0u, sub_0074a5c0, a, 6, 0, 0, &u, &l);
        tally(s, ok, &u, &l, 0, 0);
        if (k < 2 && g_nrec[1]){
            fprintf(stderr, "  sendto (%s): ", raw ? "raw ICMP" : "UDP");
            for (int i = 0; i < g_nrec[1]; i++) fprintf(stderr, "%s(len %u) ", g_rec[1][i].name, g_rec[1][i].len);
            fprintf(stderr, "\n");
        }
    }
}

int main(int argc, char **argv){
    const char *exe = argc > 1 ? argv[1] : "SPEED2.EXE";
    int n = argc > 2 ? atoi(argv[2]) : 300;
    mem_init(); mem_fault_handler_install();
    if (mem_load_pe(exe)) return 1;
    mem_commit(TA, TA_SZ); mem_commit(TEB, 0x2000);
    memset(g_mem + TEB, 0, 0x2000); MR32(TEB + 0x18) = TEB; MR32(TEB + 0x24) = 1; MR32(TEB + 0x2C) = TEB + 0x1000;
    dispatch_init(); win32_init();
    /* the CRT's per-thread data for this test thread (_mtinit 0x762018: TlsAlloc,
     * calloc, TlsSetValue), made once by the lifted code with the runtime's HLE;
     * Unicorn gets a copy of it with the heap page */
    { CPU c; memset(&c, 0, sizeof c); c.esp = STK; c.fs_base = c.gs_base = TEB; c.fcw = case_fcw();
      MR32(c.esp) = SENT; sub_00762018(&c);
      uint32_t ptd = MR32(MR32(TEB + 0x2C) + 4 * MR32(0x0081a314u));
      fprintf(stderr, "CRT per-thread data: _mtinit -> %u, TLS index %u, block %08x\n", c.eax, MR32(0x0081a314u), ptd);
      uint32_t used = win32_heap_used(); k_rw[4].sz = (used + 0xFFFFu) & ~0xFFFFu; }
    for (int i = 0; i < ST_N; i++){
        uint32_t va = STUBVA + 16u * (uint32_t)i;
        MR8(va) = 0xCC;                                  /* something to fetch for Unicorn */
        MR32(k_stub[i].iat) = va;
        dispatch_patch(va, k_ls[i]);
    }
    uc_setup();
    int pcs[2] = { 53, 24 };
    int fail = 0;
    const char *lx = getenv("NET_ORACLE_X87PC");
    int lenient = lx && *lx == '0';
    for (int pi = 0; pi < 2; pi++){
        g_pc = pcs[pi]; nS = 0;
        printf("=== x87 precision control under Unicorn: PC=%d ===\n", g_pc);
        c_crc32(n); c_bits(n / 10 + 1); c_quant(n / 10 + 1); c_addr(n); c_advt(n / 10 + 1); c_sendto(n);
        printf("%-10s %6s %9s %8s %8s %8s %8s %8s %10s\n", "case", "calls", "identical", "regs", "memory", "winsock", "st0", "aborted", "st0 max rel");
        for (int i = 0; i < nS; i++){
            Stat *s = &S[i];
            printf("%-10s %6d %9d %8d %8d %8d %8d %8d %10.3g\n", s->name, s->n, s->same, s->regdiff, s->memdiff, s->recdiff, s->st0diff, s->fail, s->st0max);
            /* every case counts at PC=24 too: since the X87PC=1 lift (gen.sh's
             * default) the quantisers round as on Windows.  Only a doubles lift
             * (X87PC=0) differs there by up to one quantum: NET_ORACLE_X87PC=0 */
            int fp = !strcmp(s->name, "qencode") || !strcmp(s->name, "qdecode") || !strcmp(s->name, "qsetup");
            if (s->fail || (s->same != s->n && !(fp && g_pc == 24 && lenient))) fail = 1;
        }
    }
    printf("net_oracle: %s\n", fail ? "DIFFERENCES (see above)"
           : lenient ? "lifted == original for every case (float cases at PC=53; NET_ORACLE_X87PC=0)"
                     : "lifted == original for every case, at PC=53 and at PC=24");
    return fail;
}
