/* srvoracle.c -- differential test of server.dll's lifted code (gen/server)
 * against the ORIGINAL x86 code of the same file under Unicorn.
 *
 *   tests/srvoracle.sh [cases-per-function]     (builds and runs it)
 *
 * The lobby protocol of EA's LAN server is TagField text (KEY=VALUE records
 * in a 12-byte framed message), so the functions under test are the TagField
 * codec the server parses and builds every lobby message with, plus its date
 * helpers.  For every case both sides start from identical guest memory: the
 * module image as module.c maps it (original file, own relocations, base
 * 0x00A00000), a 64 KB scratch region with random records, keys and buffers,
 * and a stack holding the cdecl arguments.  The lifted function runs on the
 * runtime's guest memory, the original under Unicorn on private copies; then
 * eax, edx, esp, the scratch region, the stack and the module's .data/.bss
 * must be bit-identical.  A guest fault (unmapped access) or a call that
 * leaves the tested code (an import) must happen on both sides, at the same
 * address.  Argument types are guesses from the code; a wrong guess still
 * gives a valid comparison (both sides get the same inputs).
 *
 * Test-only: Unicorn is GPLv2 and never part of the game binary or the app. */
#include "cpu.h"
#include "module.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <setjmp.h>
#include <sys/time.h>
#include <unicorn/unicorn.h>

/* ---- what module.c and the lifted shards need from the runtime --------- */
const uint32_t g_imp_count = 0;
static char g_dll[1024];
int fileio_resolve_game(const char *win, char *out, size_t n){ (void)win; snprintf(out, n, "%s", g_dll); return 1; }
uint32_t call_guest(CPU *c, uint32_t fn, int nargs, const uint32_t *args){ (void)c; (void)fn; (void)nargs; (void)args; return 0; }
uint32_t com_scratch(uint32_t n){ (void)n; return 0; }
void guest_sleep_ns(long ns){ (void)ns; }
uint64_t win32_ext_threads(void){ return 0; }
uint64_t win32_ext_threads_exited(void){ return 0; }
uint32_t win32_heap_used(void){ return 0; }
int win32_tls_in_use(void){ return 0; }
int win32_obj_live(void){ return 0; }
uint32_t module_map_for_test(const char *name);
void mem_init(void); void mem_commit(uint32_t, uint32_t);

static sigjmp_buf g_jb;
static volatile uint32_t g_left_at;          /* lifted: target of a call out of the module */
static volatile uint32_t g_fault_at;
guest_fn_t g_dtab[DISPATCH_TEXT_SIZE];      /* empty: every indirect call comes here */
void dispatch_indirect(CPU *c, uint32_t a){
    mod_fn f = module_fn_at(a);
    if (f){ f(c); return; }
    g_left_at = a; siglongjmp(g_jb, 2);
}
void unsupported_insn(CPU *c, uint32_t a, const char *mn){ (void)c; (void)mn; g_left_at = a; siglongjmp(g_jb, 3); }
static void on_fault(int sig, siginfo_t *si, void *uc){
    (void)sig; (void)uc;
    g_fault_at = (uint32_t)((uint8_t *)si->si_addr - g_mem);
    siglongjmp(g_jb, 1);
}
/* a case that does not return within the budget (both sides): "loop" */
static void on_alarm(int sig){ (void)sig; g_left_at = 0; siglongjmp(g_jb, 4); }

/* ---- layout ------------------------------------------------------------- */
#define IMG    0x00A00000u
#define DATA   0x00A41000u                   /* .data + BSS, the writable part */
#define DATASZ 0x00014000u
#define SCR    0x20000000u
#define SCRSZ  0x00010000u
#define STK    0x30000000u
#define STKSZ  0x00010000u
#define ESP0   (STK + STKSZ - 0x1000u)
#define RETMAGIC 0x3000FFF0u                 /* return address: mapped, never executed */

static uint8_t *g_img0;                      /* the freshly mapped image */
static size_t g_budget = 30000000u;           /* Unicorn instructions per case (ORACLE_BUDGET) */
static int g_lift_s = 1;                      /* lifted: seconds per case before it counts as a loop */
static uc_engine *g_uc;

/* ---- random inputs ------------------------------------------------------ */
static uint64_t g_rs = 0x9E3779B97F4A7C15ull;
static uint32_t rnd(void){ g_rs ^= g_rs << 13; g_rs ^= g_rs >> 7; g_rs ^= g_rs << 17; return (uint32_t)(g_rs >> 16); }
static const char *const KEYS[] = { "NAME", "PERS", "ADDR", "PORT", "MID", "MAC", "LANG", "SKU", "VERS", "A",
                                    "name", "Name", "LADDR", "ROOM", "X", "USERS", "PRIV", "B" };
#define NKEYS (int)(sizeof KEYS / sizeof KEYS[0])
static int put_value(char *p, int cap){
    char tmp[256]; int n = 0;
    switch (rnd() % 9){
    case 0: n = snprintf(tmp, sizeof tmp, "%d", (int)rnd() - (int)(rnd() & 0x7fffffff)); break;
    case 1: n = snprintf(tmp, sizeof tmp, "%u.%u.%u.%u", rnd() % 300, rnd() % 256, rnd() % 256, rnd() % 256); break;
    case 2: n = snprintf(tmp, sizeof tmp, "\"%s %d\"", KEYS[rnd() % NKEYS], (int)(rnd() % 1000)); break;
    case 3: n = snprintf(tmp, sizeof tmp, "%%%02x%%%02xabc%%", rnd() & 255, rnd() & 255); break;
    case 4: n = snprintf(tmp, sizeof tmp, "0x%x", rnd()); break;
    case 5: n = snprintf(tmp, sizeof tmp, "+%u", rnd() % 100000); break;
    case 6: { int l = (int)(rnd() % 40); for (n = 0; n < l; n++) tmp[n] = (char)(0x21 + rnd() % 94); tmp[n] = 0; break; }
    case 7: { int l = (int)(rnd() % 12); for (n = 0; n < l; n++) tmp[n] = (char)(1 + rnd() % 255); tmp[n] = 0; break; }
    default: n = snprintf(tmp, sizeof tmp, "%s", KEYS[rnd() % NKEYS]); break;
    }
    if (n >= cap) n = cap - 1;
    if (n < 0) n = 0;
    memcpy(p, tmp, (size_t)n); p[n] = 0;
    return n;
}
static void put_record(char *p, int cap){
    int k = 0, nf = (int)(rnd() % 12);
    static const char *const SEP[] = { " ", "\n", "\t", "  ", "\r\n", "" };
    for (int f = 0; f < nf && k < cap - 300; f++){
        k += snprintf(p + k, (size_t)(cap - k), "%s%s%c", KEYS[rnd() % NKEYS], rnd() % 7 ? "" : " ", rnd() % 5 ? '=' : ':');
        k += put_value(p + k, cap - k);
        k += snprintf(p + k, (size_t)(cap - k), "%s", SEP[rnd() % 6]);
    }
    p[k] = 0;
}
static int32_t rnd_len(void){
    static const int32_t L[] = { -1, 0, 1, 2, 3, 5, 8, 16, 31, 64, 100, 256, 600, 2000 };
    return L[rnd() % (sizeof L / sizeof L[0])];
}

/* ---- functions under test ------------------------------------------------
 * spec letters, one per cdecl argument:
 *   r  record buffer (2 KB, writable, random record)   s  random value string
 *   k  key string                                       b  2 KB buffer, random bytes
 *   n  length (also <= 0, > buffer)                     i  random int
 *   f  structure format ("2b w l a")
 *   z  NULL or a pointer into the first record          v  random 32-bit value
 *   t  a date as six dwords (second ... year)
 * "regs": the same letters for eax and ebx, for EA's register-passing helpers. */
typedef struct { uint32_t va; const char *name, *spec, *regs; } Target;   /* regs: eax, ebx spec letters */
static const Target T[] = {
    { 0x00A01D70u, "7-bit varint decode",           "n",      "bb" },   /* eax = src, ebx = dst, count */
    { 0x00A01DC0u, "append raw field",              "rns",    0    },
    { 0x00A02000u, "TagFieldFind",                  "rk",     0    },
    { 0x00A020D0u, "find next (?)",                 "rzk",    0    },
    { 0x00A021B0u, "TagFieldDelete",                "rk",     0    },
    { 0x00A02230u, "strnzcpy",                      "bns",    0    },
    { 0x00A02270u, "get token (?)",                 "rbn",    0    },
    { 0x00A02310u, "set number (?)",                "rnki",   0    },
    { 0x00A023E0u, "set address/flags (?)",         "rnki",   0    },
    { 0x00A02490u, "set string (?)",                "rnks",   0    },
    { 0x00A02BB0u, "set (?)",                       "rnks",   0    },
    { 0x00A02BF0u, "dupl/merge (?)",                "rns",    0    },
    { 0x00A02E80u, "TagFieldGetNumber",             "si",     0    },
    { 0x00A02ED0u, "TagFieldGetFlags",              "si",     0    },
    { 0x00A02F10u, "TagFieldGetAddress",            "si",     0    },
    { 0x00A02F60u, "TagFieldGetString/Delim (?)",   "sbnsii", 0    },
    { 0x00A030F0u, "get binary (?)",                "sbni",   0    },
    { 0x00A03280u, "get structure (?)",             "sbn",    0    },
    { 0x00A03360u, "structure format (?)",          "rnfb",   0    },
    { 0x00A03870u, "compare (?)",                   "ss",     0    },
    { 0x00A01B90u, "date: seconds -> struct",       "b",      "v"  },    /* eax = seconds */
    { 0x00A04F70u, "date: format (?)",              "bbn",    0    },
};
#define NT (int)(sizeof T / sizeof T[0])

static uint32_t g_args[8]; static int g_nargs; static uint32_t g_reg[2];   /* eax, ebx */
static void make_case(const Target *t){
    memset(g_mem + SCR, 0, SCRSZ);
    memset(g_mem + STK, 0, STKSZ);
    uint32_t next = SCR + 0x1000u, rec0 = 0;
    g_nargs = 0;
    char spec[16]; snprintf(spec, sizeof spec, "%s%s", t->regs ? t->regs : "", t->spec);
    int nreg = t->regs ? (int)strlen(t->regs) : 0;
    for (const char *p = spec; *p; p++){
        uint32_t v = 0;
        switch (*p){
        case 'r': put_record((char *)(g_mem + next), 0x800); v = next; if (!rec0) rec0 = next; next += 0x1000u; break;
        case 'b': for (uint32_t i = 0; i < 0x800u; i++) MR8(next + i) = (uint8_t)rnd(); v = next; next += 0x1000u; break;
        case 's': put_value((char *)(g_mem + next), 0x200); if (rnd() % 3 == 0) put_record((char *)(g_mem + next), 0x800);
                  v = next; next += 0x1000u; break;
        case 'k': snprintf((char *)(g_mem + next), 64, "%s", rnd() % 9 ? KEYS[rnd() % NKEYS] : ""); v = next; next += 0x100u; break;
        case 'n': v = (uint32_t)rnd_len(); break;
        case 'f': {   /* a structure format: [count]b|w|l|a ..., sometimes "#NAME=" first */
            char *f = (char *)(g_mem + next); int k = 0, nt = (int)(rnd() % 8);
            if (rnd() % 4 == 0) k += snprintf(f + k, 16, "#%s=", KEYS[rnd() % NKEYS]);
            for (int q = 0; q < nt; q++){
                if (rnd() % 2) k += snprintf(f + k, 8, "%u", rnd() % 12);
                f[k++] = "bwla"[rnd() % 4];
            }
            f[k] = 0; v = next; next += 0x100u; break; }
        case 'i': v = rnd() % 4 ? rnd() % 1000 : rnd(); break;
        case 'z': v = rnd() % 2 || !rec0 ? 0u : rec0 + rnd() % 64; break;
        case 'v': v = rnd() ^ (rnd() << 16); break;
        case 't': {   /* a plausible date: sec, min, hour, day, month, year (1971-2037) */
            static const uint32_t lim[6] = { 60, 60, 24, 28, 12, 67 }, add[6] = { 0, 0, 0, 1, 1, 1971 };
            for (int f = 0; f < 6; f++) MR32(next + 4u*f) = add[f] + rnd() % lim[f];
            v = next; next += 0x100u; break; }
        }
        if (p - spec < nreg) g_reg[p - spec] = v; else g_args[g_nargs++] = v;
    }
    if (!t->regs) g_reg[0] = g_reg[1] = 0;
    else if (nreg < 2) g_reg[1] = 0;
}

typedef struct { uint32_t eax, edx, esp; int how; uint32_t where; } Out;   /* how: 0 ret, 1 fault, 2 left, 3 trap, 4 loop */
static uint8_t g_lsave_data[DATASZ], g_lsave_scr[SCRSZ], g_lsave_stk[STKSZ];
static uint8_t g_usave_data[DATASZ], g_usave_scr[SCRSZ], g_usave_stk[STKSZ];

/* x87 control word of both sides: ORACLE_FCW, default 0x027F (PC=53), what
 * the DLL's threads start with on Windows and in the runtime; gen.sh lifts
 * server.dll with the exe's X87PC mode, so the precision control matters */
static uint16_t g_fcw = 0x027f;
static Out run_lifted(uint32_t va){
    static CPU c; Out o = {0};
    memset(&c, 0, sizeof c); c.fcw = g_fcw; c.esp = ESP0; c.eax = g_reg[0]; c.ebx = g_reg[1];
    for (int i = g_nargs - 1; i >= 0; i--){ c.esp -= 4; MR32(c.esp) = g_args[i]; }
    c.esp -= 4; MR32(c.esp) = RETMAGIC;
    mod_fn f = module_fn_at(va);
    struct itimerval it = { {0, 0}, {g_lift_s, 0} }, off = { {0, 0}, {0, 0} };
    int r = sigsetjmp(g_jb, 1);
    if (r == 0){ setitimer(ITIMER_REAL, &it, 0); f(&c); o.how = 0; o.where = c.eip; }
    else { o.how = r; o.where = r == 1 ? g_fault_at : g_left_at; }
    setitimer(ITIMER_REAL, &off, 0);
    o.eax = c.eax; o.edx = c.edx; o.esp = c.esp;
    return o;
}

static uint32_t g_ufault;
static bool on_umem(uc_engine *uc, uc_mem_type t, uint64_t a, int sz, int64_t v, void *u){
    (void)uc; (void)t; (void)sz; (void)v; (void)u; g_ufault = (uint32_t)a; return false;
}
static Out run_unicorn(uint32_t va){
    Out o = {0};
    uc_mem_write(g_uc, DATA, g_mem + DATA, DATASZ);
    uc_mem_write(g_uc, SCR, g_mem + SCR, SCRSZ);
    uc_mem_write(g_uc, STK, g_mem + STK, STKSZ);
    uint32_t esp = ESP0, z = 0, ef = 0x202;
    for (int i = g_nargs - 1; i >= 0; i--){ esp -= 4; uc_mem_write(g_uc, esp, &g_args[i], 4); }
    esp -= 4; { uint32_t ra = RETMAGIC; uc_mem_write(g_uc, esp, &ra, 4); }
    int regs[] = { UC_X86_REG_EAX, UC_X86_REG_EBX, UC_X86_REG_ECX, UC_X86_REG_EDX, UC_X86_REG_ESI, UC_X86_REG_EDI, UC_X86_REG_EBP };
    for (unsigned i = 0; i < sizeof regs / sizeof regs[0]; i++) uc_reg_write(g_uc, regs[i], &z);
    uc_reg_write(g_uc, UC_X86_REG_EAX, &g_reg[0]); uc_reg_write(g_uc, UC_X86_REG_EBX, &g_reg[1]);
    uc_reg_write(g_uc, UC_X86_REG_ESP, &esp);
    uc_reg_write(g_uc, UC_X86_REG_EFLAGS, &ef);
    { uint32_t cw = g_fcw; uc_reg_write(g_uc, UC_X86_REG_FPCW, &cw); }
    g_ufault = 0;
    uc_err e = uc_emu_start(g_uc, va, RETMAGIC, 0, g_budget);
    uint32_t eip = 0;
    uc_reg_read(g_uc, UC_X86_REG_EIP, &eip);
    uc_reg_read(g_uc, UC_X86_REG_EAX, &o.eax); uc_reg_read(g_uc, UC_X86_REG_EDX, &o.edx);
    uc_reg_read(g_uc, UC_X86_REG_ESP, &o.esp);
    if (e == UC_ERR_OK && eip == RETMAGIC){ o.how = 0; o.where = eip; }
    else if (e == UC_ERR_FETCH_UNMAPPED){ o.how = 2; o.where = eip; }          /* an import (IMP_MAGIC) */
    else if (e == UC_ERR_READ_UNMAPPED || e == UC_ERR_WRITE_UNMAPPED){ o.how = 1; o.where = g_ufault; }
    else if (e == UC_ERR_OK){ o.how = 4; o.where = 0; }                            /* instruction budget used up */
    else { o.how = 9; o.where = eip; fprintf(stderr, "  unicorn: %s at 0x%08x\n", uc_strerror(e), eip); }
    uc_mem_read(g_uc, DATA, g_usave_data, DATASZ);
    uc_mem_read(g_uc, SCR, g_usave_scr, SCRSZ);
    uc_mem_read(g_uc, STK, g_usave_stk, STKSZ);
    return o;
}

static int first_diff(const uint8_t *a, const uint8_t *b, uint32_t n){
    for (uint32_t i = 0; i < n; i++) if (a[i] != b[i]) return (int)i;
    return -1;
}

int main(int argc, char **argv){
    const char *dll = getenv("SRVDLL");
    int ncase = argc > 1 ? atoi(argv[1]) : 2000;
    if (!dll){ fprintf(stderr, "SRVDLL=<path to server.dll> required\n"); return 2; }
    snprintf(g_dll, sizeof g_dll, "%s", dll);
    mem_init();
    if (!module_map_for_test("server.dll")){ fprintf(stderr, "srvoracle: server.dll could not be mapped\n"); return 2; }
    mem_commit(SCR, SCRSZ); mem_commit(STK, STKSZ);
    g_img0 = malloc(DATASZ); memcpy(g_img0, g_mem + DATA, DATASZ);
    struct sigaction sa; memset(&sa, 0, sizeof sa); sa.sa_sigaction = on_fault; sa.sa_flags = SA_SIGINFO;
    sigaction(SIGSEGV, &sa, 0); sigaction(SIGBUS, &sa, 0);
    signal(SIGALRM, on_alarm);
    setvbuf(stdout, 0, _IOLBF, 0);

    if (uc_open(UC_ARCH_X86, UC_MODE_32, &g_uc) != UC_ERR_OK){ fprintf(stderr, "uc_open failed\n"); return 2; }
    uc_mem_map(g_uc, IMG, 0x58000u, UC_PROT_ALL);
    uc_mem_write(g_uc, IMG, g_mem + IMG, 0x58000u);
    uc_mem_map(g_uc, SCR, SCRSZ, UC_PROT_ALL);
    uc_mem_map(g_uc, STK, STKSZ, UC_PROT_ALL);
    uc_hook hk; uc_hook_add(g_uc, &hk, UC_HOOK_MEM_READ_UNMAPPED | UC_HOOK_MEM_WRITE_UNMAPPED, (void *)on_umem, 0, 1, 0);

    int total_diff = 0;
    printf("server.dll differential test: lifted C vs original x86 (Unicorn), %d cases per function\n", ncase);
    printf("  %-10s %-30s %7s %7s %6s %6s %6s %6s\n", "function", "", "cases", "same", "fault", "left", "loop", "DIFF");
    if (getenv("ORACLE_BUDGET")) g_budget = (size_t)strtoull(getenv("ORACLE_BUDGET"), 0, 0);
    if (getenv("ORACLE_FCW")) g_fcw = (uint16_t)strtoul(getenv("ORACLE_FCW"), 0, 0);
    printf("  x87 control word 0x%04x on both sides (PC=%d)\n", g_fcw, (g_fcw >> 8 & 3) == 0 ? 24 : (g_fcw >> 8 & 3) == 2 ? 53 : 64);
    const char *only = getenv("ORACLE_FNS");
    for (int t = 0; t < NT; t++){
        if (only){ char h[16]; snprintf(h, sizeof h, "%x", T[t].va); if (!strstr(only, h)) continue; }
        int same = 0, fault = 0, left = 0, loop = 0, diff = 0, shown = 0;
        g_rs = 0x9E3779B97F4A7C15ull ^ T[t].va;
        for (int k = 0; k < ncase; k++){
            memcpy(g_mem + DATA, g_img0, DATASZ);
            make_case(&T[t]);
            /* Unicorn first: it works on copies of the very inputs */
            Out u = run_unicorn(T[t].va);
            Out l = run_lifted(T[t].va);
            memcpy(g_lsave_data, g_mem + DATA, DATASZ);
            memcpy(g_lsave_scr, g_mem + SCR, SCRSZ);
            memcpy(g_lsave_stk, g_mem + STK, STKSZ);
            const char *why = 0; int at = -1;
            if (u.how != l.how) why = "outcome";
            else if (u.how == 1 || u.how == 2){ if (u.where != l.where) why = "where"; }
            else if (u.how == 0){
                if (u.eax != l.eax) why = "eax";
                else if (u.edx != l.edx) why = "edx";
                else if (u.esp != l.esp) why = "esp";
                else if ((at = first_diff(g_lsave_scr, g_usave_scr, SCRSZ)) >= 0) why = "scratch";
                else if ((at = first_diff(g_lsave_stk + 0, g_usave_stk + 0, STKSZ)) >= 0) why = "stack";
                else if ((at = first_diff(g_lsave_data, g_usave_data, DATASZ)) >= 0) why = "data";
            }
            if (why){
                diff++;
                if (shown++ < 3){
                    fprintf(stderr, "  DIFF %08x case %d (%s): lifted how=%d at=%08x eax=%08x edx=%08x esp=%08x | "
                                    "original how=%d at=%08x eax=%08x edx=%08x esp=%08x", T[t].va, k, why,
                            l.how, l.where, l.eax, l.edx, l.esp, u.how, u.where, u.eax, u.edx, u.esp);
                    if (at >= 0) fprintf(stderr, " first byte +0x%x", at);
                    fprintf(stderr, "\n    args:");
                    for (int i = 0; i < g_nargs; i++) fprintf(stderr, " %08x", g_args[i]);
                    fprintf(stderr, "\n");
                }
            } else if (u.how == 0) same++;
            else if (u.how == 1) fault++;
            else if (u.how == 4) loop++;
            else left++;
        }
        total_diff += diff;
        printf("  %08x   %-30s %7d %7d %6d %6d %6d %6d\n", T[t].va, T[t].name, ncase, same, fault, left, loop, diff);
    }
    printf("result: %s (%d differing cases)\n", total_diff ? "FAIL" : "PASS", total_diff);
    uc_close(g_uc);
    return total_diff ? 1 : 0;
}
