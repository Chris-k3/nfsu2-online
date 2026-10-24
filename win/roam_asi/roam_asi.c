/* roam_asi.c -- NFSU2FreeRoam.asi: free-roam multiplayer for the original PC
 * game (SPEED2.EXE v1.2 North America), the Windows companion of the Mac
 * port's feature.
 *
 * An Ultimate ASI Loader plugin (scripts\NFSU2FreeRoam.asi, settings in
 * scripts\NFSU2FreeRoam.ini, log in scripts\NFSU2FreeRoam.log).  The game
 * side is the Mac port's own runtime/roam_game.c and the protocol is the
 * same runtime/roam_core.c, built for 32-bit x86 (roam_host_win.h); the
 * network is roam_win.c (Winsock).
 *
 * What it changes in the game: one 5-byte call at 0x581475 in GameLoop (the
 * second of two empty debug calls between World::DoTimestep and the camera,
 * audio and render; the first, 0x581470, is ExtraOptions' hook) now calls
 * roam_frame_thunk, which runs the frame step and then jumps on to the
 * call's previous target (the game's empty 0x4022C0, or another mod's hook
 * that was there first).  Nothing else is patched; the game's own functions
 * are called from that hook only, on the game's main thread, exactly as the
 * Mac port calls them.
 *
 * Fail closed: the plugin checks the exe in memory first (entry point, the
 * code of every game function it calls, the instructions that use the game
 * globals it reads, the hook site; win/roam_asi/roam_fp.h, generated from
 * SPEED2.EXE by tools/roam_fingerprint.py) and does nothing on any mismatch,
 * with the reason in the log, never a message box.  A fault inside the frame
 * step (in the plugin, or in a game function it called) is caught by a
 * vectored exception handler: the game continues, the plugin switches
 * itself off and says so in the log.
 *
 * No C runtime: KERNEL32 and WS2_32 only (roam_libc.c has the few C
 * functions); built freestanding by tools/build_roam_asi.sh.
 */
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <stdarg.h>
#include "roam_core.h"
#include "roam_plat.h"
#include "roam_fp.h"

int  vsnprintf(char *buf, size_t n, const char *fmt, va_list ap);
int  snprintf(char *buf, size_t n, const char *fmt, ...);
typedef struct CPU CPU;                           /* the port's guest CPU: always 0 here */
void roam_game_frame(CPU *c);                     /* runtime/roam_game.c */
void roam_game_report(void);
void roam_win_poll(void);                         /* roam_win.c */
void roam_plat_fault_unlock(void);
int  roam_plat_quiesced(void);

#ifndef ROAM_ASI_VERSION
#define ROAM_ASI_VERSION "1.0"
#endif
void roam_log(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

#define HOOK_SITE     0x00581475u                 /* call 0x4022C0 in GameLoop */
#define HOOK_ORIG_TGT 0x004022C0u                 /* the empty debug function (ret) */
#define EXE_BASE      0x00400000u
#define EXE_TEXT_LO   0x00401000u
#define EXE_TEXT_HI   0x00783000u
#define EXE_END       0x00932000u

static HMODULE g_self;
static uint32_t g_self_lo, g_self_hi;             /* the plugin's image */
static char    g_ini[MAX_PATH], g_logpath[MAX_PATH];
static int     g_inited, g_ready, g_dead;
static long    g_frame;
/* test aid (tests/asi_harness.c): NFSU2_ROAM_TEST_FAULT=N makes the first
 * game function called with an object in frame N get a bad one (a fault in
 * the game's code), -N a bad write in the plugin's own code in frame N */
static int     g_test_fault;
static volatile uint32_t g_test_fault_ptr = 0x10u;
/* test aid: NFSU2_ROAM_TEST_FAULT_SEH=N makes the plugin call the game's
 * Car::SetDriverType (0x5EBA30, which puts an SEH frame into FS:[0] first)
 * with a bad object in frame N: a fault inside a game function's SEH frame */
static int     g_test_fault_seh;

/* ---- the log --------------------------------------------------------------------------------- */
static HANDLE           g_log = INVALID_HANDLE_VALUE;
static CRITICAL_SECTION g_log_mu;
static uint32_t         g_log_bytes;
#define LOG_MAX (8u << 20)
void roam_log(const char *fmt, ...){
    if (g_log == INVALID_HANDLE_VALUE) return;
    char b[1100];
    SYSTEMTIME t; GetLocalTime(&t);
    int k = snprintf(b, sizeof b, "%02u:%02u:%02u.%03u ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    va_list ap; va_start(ap, fmt);
    int n = vsnprintf(b + k, sizeof b - (size_t)k - 2, fmt, ap);
    va_end(ap);
    if (n < 0) return;
    n += k; if (n > (int)sizeof b - 3) n = (int)sizeof b - 3;
    /* the core and the game side end their lines with \n: Windows wants \r\n */
    if (n > 0 && b[n - 1] == '\n') n--;
    b[n++] = '\r'; b[n++] = '\n';
    EnterCriticalSection(&g_log_mu);
    DWORD w = 0;
    if (g_log_bytes < LOG_MAX){
        WriteFile(g_log, b, (DWORD)n, &w, 0);
        g_log_bytes += (uint32_t)n;
        if (g_log_bytes >= LOG_MAX){ const char *m = "... log full (8 MB): nothing more is written\r\n"; WriteFile(g_log, m, (DWORD)lstrlenA(m), &w, 0); }
    }
    LeaveCriticalSection(&g_log_mu);
}
static void log_open(void){
    InitializeCriticalSection(&g_log_mu);
    g_log = CreateFileA(g_logpath, GENERIC_WRITE, FILE_SHARE_READ, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
}

/* ---- options: the environment (tests), then scripts\NFSU2FreeRoam.ini [FreeRoam] -------------- */
static const struct { const char *name, *key, *def; } OPTS[] = {
    { "NFSU2_ROAM",             "Enable",     "1" },  /* installing the plugin is the opt-in */
    { "NFSU2_ROAM_NAME",        "Name",       ""  },
    { "NFSU2_ROAM_PORT",        "Port",       ""  },
    { "NFSU2_ROAM_PEERS",       "Peers",      ""  },
    { "NFSU2_ROAM_COLLIDE",     "Collide",    ""  },
    { "NFSU2_ROAM_DISCOVERY",   "Discovery",  ""  },
    { "NFSU2_ROAM_ROOM",        "Room",       ""  },
    { "NFSU2_ROAM_CREW",        "Crew",       ""  },
    { "NFSU2_ROAM_CREW_RGB",    "CrewColours", "" },
    { "NFSU2_ROAM_MAX_PLAYERS", "MaxPlayers", ""  },
    { "NFSU2_ROAM_MAX_CARS",    "MaxCars",    ""  },
    { "NFSU2_ROAM_RATE",        "Rate",       ""  },
    { "NFSU2_ROAM_DELAY",       "Delay",      ""  },
    { "NFSU2_ROAM_EXTRAP",      "Extrap",     ""  },
    { "NFSU2_ROAM_CARPOOL_KB",  "CarPoolKB",  ""  },
    { "NFSU2_ROAM_NETTHREAD",   "NetThread",  ""  },
    { "NFSU2_ROAM_LOG",         "Log",        "1" },
    { "NFSU2_ROAM_HARNESS",     "TestMode",   ""  },  /* test aid: loopback only, no broadcast */
    { "NFSU2_ROAM_POSELOG",     "PoseLog",    ""  },  /* test aid: a CSV of every pose */
};
#define NOPT (int)(sizeof OPTS / sizeof OPTS[0])
static char g_optval[NOPT][160];
static int  g_opt_loaded;
static void trim(char *s){
    /* a comment after the value: ';' or '#' at the start or after a blank
     * (as on the Mac: "Team#1" stays a name) */
    for (char *c = s; *c; c++) if ((*c == ';' || *c == '#') && (c == s || c[-1] == ' ' || c[-1] == '\t')){ *c = 0; break; }
    int n = lstrlenA(s);
    while (n && (s[n - 1] == ' ' || s[n - 1] == '\t' || s[n - 1] == '\r' || s[n - 1] == '\n')) s[--n] = 0;
    int i = 0; while (s[i] == ' ' || s[i] == '\t') i++;
    if (i) for (int j = 0; ; j++){ s[j] = s[i + j]; if (!s[j]) break; }
}
static void opts_load(void){
    for (int i = 0; i < NOPT; i++){
        char *v = g_optval[i];
        DWORD n = GetEnvironmentVariableA(OPTS[i].name, v, sizeof g_optval[i]);
        if (n > 0 && n < sizeof g_optval[i]){ trim(v); continue; }
        GetPrivateProfileStringA("FreeRoam", OPTS[i].key, OPTS[i].def, v, sizeof g_optval[i], g_ini);
        trim(v);
    }
    g_opt_loaded = 1;
}
const char *roam_opt(const char *name){
    if (!g_opt_loaded) opts_load();
    for (int i = 0; i < NOPT; i++) if (!lstrcmpA(OPTS[i].name, name)) return g_optval[i][0] ? g_optval[i] : 0;
    /* other names: test aids from the environment only */
    static char ev[4][160]; static int k;
    char *v = ev[k++ & 3];
    DWORD n = GetEnvironmentVariableA(name, v, 160);
    return n > 0 && n < 160 ? v : 0;
}
static int opt_int(const char *name, int def){
    const char *v = roam_opt(name);
    if (!v) return def;
    int neg = *v == '-', x = 0, nd = 0;
    for (const char *p = v + neg; *p >= '0' && *p <= '9'; p++, nd++) x = x * 10 + (*p - '0');
    if (!nd) return (!lstrcmpiA(v, "on") || !lstrcmpiA(v, "yes") || !lstrcmpiA(v, "true")) ? 1 :
                    (!lstrcmpiA(v, "off") || !lstrcmpiA(v, "no") || !lstrcmpiA(v, "false")) ? 0 : def;
    return neg ? -x : x;
}

/* ---- guest memory: VirtualQuery, cached ------------------------------------------------------- */
static struct { uint32_t lo, hi; } g_vq[32];
static int g_vqn, g_vqnext;
static void vq_flush(void){ g_vqn = 0; g_vqnext = 0; }
int roam_win_committed(uint32_t a){
    if (a >= EXE_BASE && a < EXE_END) return 1;               /* the exe image is always there */
    for (int i = 0; i < g_vqn; i++) if (a >= g_vq[i].lo && a < g_vq[i].hi) return 1;
    if (a < 0x10000u) return 0;
    MEMORY_BASIC_INFORMATION mi;
    if (!VirtualQuery((LPCVOID)(uintptr_t)a, &mi, sizeof mi) || mi.State != MEM_COMMIT) return 0;
    DWORD p = mi.Protect;
    if (p & (PAGE_GUARD | PAGE_NOACCESS)) return 0;
    if (!(p & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE |
               PAGE_EXECUTE_WRITECOPY))) return 0;
    uint32_t lo = (uint32_t)(uintptr_t)mi.BaseAddress, hi = lo + (uint32_t)mi.RegionSize;
    if (hi < lo) hi = 0xFFFFFFFFu;
    int k = g_vqn < 32 ? g_vqn++ : (g_vqnext++ & 31);
    g_vq[k].lo = lo; g_vq[k].hi = hi;
    return 1;
}

/* ---- calling the game's code ---------------------------------------------------------------- */
/* roam_call_asm(fn, ecx, edx, n, args): pushes args[n-1] .. args[0], loads
 * ecx and edx, calls fn, and restores esp from ebp afterwards, so that
 * thiscall/stdcall (callee pops) and cdecl (caller pops) both come back
 * balanced; ebx, esi, edi, ebp are saved here as well */
uint32_t roam_call_asm(uint32_t fn, uint32_t ecx, uint32_t edx, int n, const uint32_t *args);
__asm__(
    ".text\n"
    ".globl _roam_call_asm\n"
    "_roam_call_asm:\n"
    "    pushl %ebp\n"
    "    movl  %esp, %ebp\n"
    "    pushl %ebx\n"
    "    pushl %esi\n"
    "    pushl %edi\n"
    "    movl  20(%ebp), %eax\n"
    "    movl  24(%ebp), %esi\n"
    "1:  testl %eax, %eax\n"
    "    jle   2f\n"
    "    decl  %eax\n"
    "    pushl (%esi,%eax,4)\n"
    "    jmp   1b\n"
    "2:  movl  12(%ebp), %ecx\n"
    "    movl  16(%ebp), %edx\n"
    "    call  *8(%ebp)\n"
    "    leal  -12(%ebp), %esp\n"
    "    popl  %edi\n"
    "    popl  %esi\n"
    "    popl  %ebx\n"
    "    popl  %ebp\n"
    "    ret\n");
static uint32_t g_game_mxcsr, g_our_mxcsr = 0x1F80u;   /* MXCSR default: round to nearest, all masked */
static uint16_t g_game_fcw;
static uint32_t g_x87_popped;
uint32_t roam_win_mxcsr_default(void){ return 0x1F80u; }
uint32_t roam_win_call(uint32_t fn, uint32_t ecx, uint32_t edx, int n, const uint32_t *args){
    uint16_t sw0, sw1;
    if (g_test_fault > 0 && g_frame >= g_test_fault && ecx){ g_test_fault = 0; ecx = g_test_fault_ptr; }
    __asm__ volatile ("fnstsw %0" : "=m"(sw0));
    __asm__ volatile ("ldmxcsr %0" :: "m"(g_game_mxcsr));          /* the game's code, the game's MXCSR */
    uint32_t r = roam_call_asm(fn, ecx, edx, n, args);
    __asm__ volatile ("ldmxcsr %0" :: "m"(g_our_mxcsr));
    __asm__ volatile ("fnstsw %0" : "=m"(sw1));
    /* a function that returns a float leaves it in st(0): pop it, so the
     * x87 stack is as the game left it */
    int t0 = (sw0 >> 11) & 7, t1 = (sw1 >> 11) & 7, k = 0;
    while (t1 != t0 && k < 8){ __asm__ volatile ("fstp %%st(0)" ::: "st"); t1 = (t1 + 1) & 7; k++; }
    g_x87_popped += (uint32_t)k;
    return r;
}

/* ---- the frame hook ---------------------------------------------------------------------------- */
uint32_t g_roam_chain = HOOK_ORIG_TGT;            /* where the patched call went before */
uint32_t g_roam_resume_esp, g_roam_resume_ebp;   /* the fault guard's way back */
uint32_t g_roam_resume_seh;                       /* the thread's SEH chain head (FS:[0]) at the hook */
void roam_frame_thunk(void);
void roam_fault_resume(void);
void roam_asi_frame(void);
void roam_asi_fault(void);
__asm__(
    ".text\n"
    ".globl _roam_frame_thunk\n"
    "_roam_frame_thunk:\n"
    "    pushal\n"
    "    pushfl\n"
    "    movl  %esp, %ebp\n"
    "    andl  $-16, %esp\n"
    "    cld\n"
    "    movl  %esp, _g_roam_resume_esp\n"
    "    movl  %ebp, _g_roam_resume_ebp\n"
    "    movl  %fs:0, %eax\n"
    "    movl  %eax, _g_roam_resume_seh\n"
    "    call  _roam_asi_frame\n"
    "3:  movl  %ebp, %esp\n"
    "    popfl\n"
    "    popal\n"
    "    jmp   *_g_roam_chain\n"
    /* back from a fault: the game functions the plugin calls (CreateCar,
     * SetRideInfo, SetDriverType, SetPhysicsMode, ...) put an SEH frame on
     * the stack and into FS:[0] at their start; a fault inside them leaves
     * FS:[0] pointing below the stack the plugin resumes on, which is then
     * reused, and the next exception on this thread would walk a garbage
     * chain (with SEHOP: the process is ended).  The chain as it was at the
     * hook goes back first. */
    ".globl _roam_fault_resume\n"
    "_roam_fault_resume:\n"
    "    movl  _g_roam_resume_esp, %esp\n"
    "    movl  _g_roam_resume_ebp, %ebp\n"
    "    movl  _g_roam_resume_seh, %eax\n"
    "    movl  %eax, %fs:0\n"
    "    call  _roam_asi_fault\n"
    "    jmp   3b\n");

static volatile LONG g_guard;                     /* inside the frame step */
static DWORD  g_guard_tid;
static DWORD  g_fault_code; static uint32_t g_fault_eip, g_fault_addr; static int g_fault_rw;
static LONG CALLBACK roam_veh(EXCEPTION_POINTERS *ep){
    if (!g_guard || GetCurrentThreadId() != g_guard_tid) return EXCEPTION_CONTINUE_SEARCH;
    DWORD code = ep->ExceptionRecord->ExceptionCode;
    if (code != EXCEPTION_ACCESS_VIOLATION && code != EXCEPTION_ILLEGAL_INSTRUCTION && code != EXCEPTION_INT_DIVIDE_BY_ZERO &&
        code != EXCEPTION_PRIV_INSTRUCTION && code != EXCEPTION_IN_PAGE_ERROR && code != EXCEPTION_DATATYPE_MISALIGNMENT &&
        code != EXCEPTION_ARRAY_BOUNDS_EXCEEDED && code != EXCEPTION_INT_OVERFLOW) return EXCEPTION_CONTINUE_SEARCH;
    uint32_t eip = (uint32_t)ep->ContextRecord->Eip;
    /* only faults in our code or in the game's: anything else (a system
     * DLL probing memory under its own __try) is not ours to catch */
    if (!((eip >= g_self_lo && eip < g_self_hi) || (eip >= EXE_TEXT_LO && eip < EXE_TEXT_HI))) return EXCEPTION_CONTINUE_SEARCH;
    g_guard = 0;
    g_fault_code = code; g_fault_eip = eip;
    g_fault_addr = ep->ExceptionRecord->NumberParameters >= 2 ? (uint32_t)ep->ExceptionRecord->ExceptionInformation[1] : 0;
    g_fault_rw = ep->ExceptionRecord->NumberParameters >= 1 ? (int)ep->ExceptionRecord->ExceptionInformation[0] : -1;
    ep->ContextRecord->Eip = (DWORD)(uintptr_t)roam_fault_resume;
    return EXCEPTION_CONTINUE_EXECUTION;
}
/* back from a fault: the game's FPU state, the plugin off for good */
void roam_asi_fault(void){
    __asm__ volatile ("fninit");
    __asm__ volatile ("fldcw %0" :: "m"(g_game_fcw));
    __asm__ volatile ("ldmxcsr %0" :: "m"(g_game_mxcsr));
    g_dead = 1;
    roam_plat_fault_unlock();
    roam_log("[roam] FAULT %08lx at %08x (%s %08x) in frame %ld, in %s: free-roam multiplayer is OFF until the game restarts; "
             "the game continues. Please send this log to the developers.\n", (unsigned long)g_fault_code, g_fault_eip,
             g_fault_rw == 1 ? "writing" : g_fault_rw == 8 ? "executing" : "reading", g_fault_addr, g_frame,
             g_fault_eip >= g_self_lo && g_fault_eip < g_self_hi ? "the plugin" : "a game function the plugin called");
    roam_plat_stop(1);                            /* BYE: friends remove this car at once */
}
long roam_win_frame_no(void){ return g_frame; }
uint64_t roam_win_ns(void){
    static LARGE_INTEGER f; LARGE_INTEGER c;
    if (!f.QuadPart && (!QueryPerformanceFrequency(&f) || !f.QuadPart)) f.QuadPart = 1000;
    QueryPerformanceCounter(&c);
    return (uint64_t)(c.QuadPart / f.QuadPart) * 1000000000ull + (uint64_t)(c.QuadPart % f.QuadPart) * 1000000000ull / (uint64_t)f.QuadPart;
}
static uint32_t g_world_last;
void roam_asi_frame(void){
    if (g_dead || !g_ready) return;
    __asm__ volatile ("stmxcsr %0" : "=m"(g_game_mxcsr));
    __asm__ volatile ("fnstcw %0" : "=m"(g_game_fcw));
    __asm__ volatile ("ldmxcsr %0" :: "m"(g_our_mxcsr));
    g_guard_tid = GetCurrentThreadId(); g_guard = 1;
    g_frame++;
    /* the World object changes at every track load: forget the memory map */
    uint32_t w = *(volatile uint32_t *)(uintptr_t)0x00890080u;
    if (w != g_world_last || (g_frame & 1023) == 0){ vq_flush(); g_world_last = w; }
    if (g_test_fault < 0 && g_frame == -g_test_fault) *(volatile uint32_t *)(uintptr_t)g_test_fault_ptr = 1u;
    if (g_test_fault_seh > 0 && g_frame == g_test_fault_seh){ uint32_t a = 0; roam_win_call(0x005EBA30u, g_test_fault_ptr, 0, 1, &a); }
    roam_win_poll();                              /* NetThread = 0, or no thread: receive here */
    roam_game_frame(0);
    g_guard = 0;
    __asm__ volatile ("ldmxcsr %0" :: "m"(g_game_mxcsr));
}

/* ---- the pose log (test aid) ------------------------------------------------------------------- */
typedef struct rh_file rh_file;
struct rh_file { HANDLE h; uint32_t n; char b[60000]; };
rh_file *rh_fopen(const char *path){
    static rh_file f;
    if (f.h && f.h != INVALID_HANDLE_VALUE) return 0;
    f.h = CreateFileA(path, GENERIC_WRITE, FILE_SHARE_READ, 0, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, 0);
    f.n = 0;
    return f.h == INVALID_HANDLE_VALUE ? 0 : &f;
}
void rh_fflush(rh_file *f){ if (f && f->n){ DWORD w; WriteFile(f->h, f->b, f->n, &w, 0); f->n = 0; } }
int rh_fprintf(rh_file *f, const char *fmt, ...){
    if (!f) return 0;
    if (f->n > sizeof f->b - 600) rh_fflush(f);
    va_list ap; va_start(ap, fmt);
    int n = vsnprintf(f->b + f->n, sizeof f->b - f->n, fmt, ap);
    va_end(ap);
    if (n > 0) f->n += (uint32_t)n < sizeof f->b - f->n ? (uint32_t)n : (uint32_t)(sizeof f->b - f->n - 1);
    return n;
}

/* ---- the exe check ------------------------------------------------------------------------------- */
/* readable without a fault (at load there is no fault guard yet: a packed or
 * different exe must not crash the game here) */
static int readable(uint32_t a, uint32_t n){
    for (uint32_t p = a & ~0xFFFu; p < a + n; p += 0x1000u){
        MEMORY_BASIC_INFORMATION mi;
        if (!VirtualQuery((LPCVOID)(uintptr_t)p, &mi, sizeof mi) || mi.State != MEM_COMMIT || (mi.Protect & (PAGE_GUARD | PAGE_NOACCESS)) ||
            !(mi.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)))
            return 0;
    }
    return 1;
}
static int exe_check(void){
    if ((uint32_t)(uintptr_t)GetModuleHandleA(0) != EXE_BASE){
        roam_log("[roam] the game is not loaded at 0x400000: not SPEED2.EXE v1.2\n"); return 0; }
    const uint8_t *mz = (const uint8_t *)(uintptr_t)EXE_BASE;
    if (!readable(EXE_BASE, 0x400)){ roam_log("[roam] the exe's header is not readable\n"); return 0; }
    uint32_t pe = *(const uint32_t *)(mz + 0x3C);
    if (mz[0] != 'M' || mz[1] != 'Z' || pe > 0x300 || *(const uint32_t *)(mz + pe) != 0x00004550u){
        roam_log("[roam] no PE header at 0x400000\n"); return 0; }
    uint32_t entry = *(const uint32_t *)(mz + pe + 0x28), stamp = *(const uint32_t *)(mz + pe + 8),
             size = *(const uint32_t *)(mz + pe + 0x50);
    roam_log("[roam] exe: entry point 0x%08x, time stamp 0x%08x, image size 0x%x\n", EXE_BASE + entry, stamp, size);
    if (EXE_BASE + entry != RF_ENTRY_VA){
        roam_log("[roam] entry point 0x%08x is not v1.2 North America's 0x%08x\n", EXE_BASE + entry, RF_ENTRY_VA); return 0; }
    int bad = 0, hooked = 0, nfn = 0, nref = 0;
    for (unsigned i = 0; i < sizeof RF / sizeof RF[0]; i++){
        const uint8_t *p = (const uint8_t *)(uintptr_t)RF[i].va;
        if (!readable(RF[i].va, RF[i].len)){ roam_log("[roam]   0x%08x %s: not readable\n", RF[i].va, RF[i].what); bad++; continue; }
        uint32_t crc = rc_crc32(p, RF[i].len);
        if (RF[i].kind == RF_FN) nfn++; else nref++;
        if (crc == RF[i].crc) continue;
        /* a function another mod has replaced with a jump to its own code
         * (Unlimiter does this with UpdatePartsEnabled): still the same
         * function to call */
        if (RF[i].kind == RF_FN && (p[0] == 0xE9 || (p[0] == 0xFF && p[1] == 0x25) || (p[0] == 0x68 && p[5] == 0xC3))){
            roam_log("[roam]   0x%08x %s: replaced by another mod (a jump at its start): fine\n", RF[i].va, RF[i].what);
            hooked++; continue;
        }
        roam_log("[roam]   0x%08x %s: different code (crc %08x, v1.2 NA has %08x)\n", RF[i].va, RF[i].what, crc, RF[i].crc);
        bad++;
    }
    if (bad){ roam_log("[roam] %d of %u checks differ: this is not SPEED2.EXE v1.2 (North America)\n", bad, (unsigned)(sizeof RF / sizeof RF[0])); return 0; }
    roam_log("[roam] SPEED2.EXE v1.2 (North America) recognised: %d game functions (%d replaced by other mods) and %d "
             "uses of game globals checked\n", nfn, hooked, nref);
    return 1;
}

/* ---- the hook ------------------------------------------------------------------------------------- */
static int hook_install(void){
    uint8_t *site = (uint8_t *)(uintptr_t)HOOK_SITE;
    if (!readable(HOOK_SITE, 5)) return 0;
    if (site[0] != 0xE8){
        roam_log("[roam] the frame hook site 0x%08x is %02x %02x %02x %02x %02x, not a call: another mod changed it? Plugin off\n",
                 HOOK_SITE, site[0], site[1], site[2], site[3], site[4]);
        return 0;
    }
    int32_t rel; memcpy(&rel, site + 1, 4);
    uint32_t tgt = HOOK_SITE + 5u + (uint32_t)rel;
    uint32_t mine = (uint32_t)(uintptr_t)roam_frame_thunk;
    if (tgt == mine){ roam_log("[roam] the frame hook is already installed\n"); return 1; }
    if (tgt != HOOK_ORIG_TGT) roam_log("[roam] another mod hooks 0x%08x too (it calls 0x%08x): it is called after this plugin's step\n", HOOK_SITE, tgt);
    g_roam_chain = tgt;
    DWORD old;
    if (!VirtualProtect(site, 5, PAGE_EXECUTE_READWRITE, &old)){ roam_log("[roam] VirtualProtect failed (%lu)\n", GetLastError()); return 0; }
    int32_t nrel = (int32_t)(mine - (HOOK_SITE + 5u));
    uint8_t code[5] = { 0xE8 }; memcpy(code + 1, &nrel, 4);
    memcpy(site, code, 5);
    VirtualProtect(site, 5, old, &old);
    FlushInstructionCache(GetCurrentProcess(), site, 5);
    roam_log("[roam] frame hook: call at 0x%08x now goes to the plugin (0x%08x), then on to 0x%08x\n", HOOK_SITE, mine, tgt);
    return 1;
}

/* ---- start-up ---------------------------------------------------------------------------------------- */
static void init_once(void){
    if (g_inited) return;
    g_inited = 1;
    char me[MAX_PATH];
    DWORD n = GetModuleFileNameA(g_self, me, sizeof me);
    if (!n || n >= sizeof me - 4) return;
    lstrcpyA(g_ini, me); lstrcpyA(g_logpath, me);
    int dot = -1; for (int i = 0; g_ini[i]; i++) if (g_ini[i] == '.') dot = i; else if (g_ini[i] == '\\' || g_ini[i] == '/') dot = -1;
    if (dot < 0){ dot = lstrlenA(g_ini); }
    lstrcpyA(g_ini + dot, ".ini"); lstrcpyA(g_logpath + dot, ".log");
    opts_load();
    if (opt_int("NFSU2_ROAM_LOG", 1)) log_open();
    {
        IMAGE_DOS_HEADER *d = (IMAGE_DOS_HEADER *)g_self; IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)((uint8_t *)g_self + d->e_lfanew);
        g_self_lo = (uint32_t)(uintptr_t)g_self; g_self_hi = g_self_lo + nt->OptionalHeader.SizeOfImage;
    }
    roam_log("[roam] NFSU2FreeRoam.asi %s (protocol %d) at 0x%08x; settings %s\n", ROAM_ASI_VERSION, RC_PROTO_VER, g_self_lo, g_ini);
    if (!opt_int("NFSU2_ROAM", 1)){ roam_log("[roam] Enable = 0 in the .ini: the plugin does nothing\n"); return; }
    if (!exe_check()){ roam_log("[roam] free-roam multiplayer stays OFF; the game runs as without the plugin\n"); return; }
    g_test_fault = opt_int("NFSU2_ROAM_TEST_FAULT", 0);
    g_test_fault_seh = opt_int("NFSU2_ROAM_TEST_FAULT_SEH", 0);
    if (!AddVectoredExceptionHandler(1, roam_veh)) roam_log("[roam] no fault guard (AddVectoredExceptionHandler failed)\n");
    if (!hook_install()) return;
    g_ready = 1;
    roam_log("[roam] ready: the network starts with the game's first frame\n");
}

__declspec(dllexport) void InitializeASI(void){ init_once(); }

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID reserved){
    if (reason == DLL_PROCESS_ATTACH){
        g_self = (HMODULE)h;
        DisableThreadLibraryCalls(h);
        /* like ExtraOptions and Unlimiter: everything at load (only kernel32
         * calls: the .ini, the log, the exe check, one 5-byte patch); the
         * network starts later, at the first frame.  InitializeASI (Ultimate
         * ASI Loader calls it next) finds it done. */
        init_once();
    } else if (reason == DLL_PROCESS_DETACH){
        /* at process exit every other thread is gone already; if the network
         * thread died holding the session lock, skip the report (and the
         * BYE: friends drop this car after 2 s anyway) */
        if (g_ready && !g_dead){ g_dead = 1; if (roam_plat_quiesced()) roam_game_report(); }
        if (g_x87_popped) roam_log("[roam] %u float result(s) of game functions popped off the x87 stack\n", g_x87_popped);
        roam_log("[roam] unloaded%s\n", reserved ? " (game exit)" : "");
        if (g_log != INVALID_HANDLE_VALUE){ CloseHandle(g_log); g_log = INVALID_HANDLE_VALUE; }
    }
    return TRUE;
}
