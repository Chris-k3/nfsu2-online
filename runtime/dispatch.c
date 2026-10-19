/* Indirect call dispatch: guest address -> lifted native function.
 * O(1) direct index table (a uint32 array the size of .text).          */
#include "cpu.h"
uint64_t g_icall_hits = 0;
#include <stdio.h>
#include <stdlib.h>
#include "module.h"

typedef void (*guest_fn)(CPU*);
extern const uint32_t g_fn_addr[];
extern const guest_fn g_fn_ptr[];
extern const uint32_t g_fn_count;

#define TEXT_BASE 0x00401000u
#define TEXT_SIZE 0x00381af1u

static uint32_t *g_idx;

/* statistics */
uint64_t g_stat_indirect_ok = 0, g_stat_indirect_miss = 0, g_stat_unsupported = 0;
#define MISS_MAX 64
static uint32_t g_miss[MISS_MAX], g_miss_from[MISS_MAX]; static int g_miss_n = 0;
extern uint32_t g_watch_prev_ip;
static uint32_t g_unsup[MISS_MAX]; static int g_unsup_n = 0;

extern void (*g_backtrace_fn)(struct CPU*,int);
void guest_backtrace(CPU*,int);

void dispatch_init(void){
    if (g_idx) return;
    g_backtrace_fn = (void(*)(struct CPU*,int))guest_backtrace;
    g_idx = calloc(TEXT_SIZE, sizeof(uint32_t));
    if (!g_idx){ fprintf(stderr,"dispatch table could not be allocated\n"); exit(1); }
    uint32_t dup = 0, oob = 0;
    for (uint32_t i = 0; i < g_fn_count; i++){
        uint32_t a = g_fn_addr[i];
        if (a - TEXT_BASE >= TEXT_SIZE){ oob++; continue; }
        if (g_idx[a - TEXT_BASE]) dup++;
        g_idx[a - TEXT_BASE] = i + 1;
    }
    fprintf(stderr, "dispatch: %u functions registered (%u duplicates, %u out of range), table %.1f MB\n",
            g_fn_count, dup, oob, TEXT_SIZE*4.0/1048576.0);
}

int  win32_call(CPU*, uint32_t);
int  run_generated(CPU*, uint32_t);
void genexec_report(void);
int  com_call(CPU*, uint32_t);
int  g_guest_exited = 0;

/* --- run-time patches: replace indirect call targets ---
 * Without regenerating (only functions that are called indirectly). */
#define PATCH_MAX 24
static struct { uint32_t addr; guest_fn fn; } g_patch[PATCH_MAX];
static int g_patch_n = 0;
void dispatch_patch(uint32_t a, guest_fn f){
    if (a >= 0xE0000000u){        /* the order in dispatch_indirect relies on this */
        fprintf(stderr,"dispatch_patch: address %08x outside the text range, ignored\n", a);
        return; }
    if (g_patch_n < PATCH_MAX){ g_patch[g_patch_n].addr=a; g_patch[g_patch_n].fn=f; g_patch_n++; }
}

/* A tail jump (DISPATCH_TAIL in cpu.h): target in c->eip.  Lifted targets
 * and patches are tail-called so the jumping function's frame is gone; COM,
 * Win32 and generated code return here and end the chain like a call would. */
void dispatch_tail(CPU *c){
    uint32_t addr = c->eip;
    if (addr < 0xE0000000u){
        for (int i = 0; i < g_patch_n; i++)
            if (g_patch[i].addr == addr){ g_stat_indirect_ok++;
#ifdef __wasm__
                __attribute__((musttail))
#endif
                return g_patch[i].fn(c); }
        uint32_t off = addr - TEXT_BASE;
        if (off < TEXT_SIZE){
            uint32_t k = g_idx[off];
            if (k){ g_stat_indirect_ok++;
#ifdef __wasm__
                __attribute__((musttail))
#endif
                return g_fn_ptr[k-1](c); }
        }
        /* a lifted DLL (server.dll, module.c): its loops jump through tables
         * too, so its targets are tail calls as well */
        else { mod_fn f = module_fn_at(addr);
               if (f){ g_stat_indirect_ok++;
#ifdef __wasm__
                   __attribute__((musttail))
#endif
                   return f(c); } }
    }
    dispatch_indirect(c, addr);
}

void dispatch_indirect(CPU *c, uint32_t addr){
    /* The CHEAP range test first.  COM vtable methods (0xE...) and Win32
     * import bridges (0xF...) are far above the guest text range, so they
     * NEVER collide with the patch table below -- patches are always inside
     * .text (dispatch_patch is only called with a guest function
     * address).  Every call used to scan the g_patch[] array linearly
     * first; a run has 377 million COM calls alone. */
    if (addr >= 0xE0000000u){
#ifdef __wasm__
        /* NFSU2_STACKPROBE: engine stack high-water at COM/Win32 calls (runtime/web/stackprobe.c) */
        { extern int g_stackprobe; if (g_stackprobe > 0){ void stackprobe_check(CPU *); stackprobe_check(c); } }
#endif
        if (addr < 0xF0000000u){ com_call(c, addr); return; }
        if (win32_call(c, addr - 0xF0000000u) < 0) g_guest_exited = 1;
        return;
    }
    for (int i = 0; i < g_patch_n; i++)
        if (g_patch[i].addr == addr){ g_stat_indirect_ok++; g_patch[i].fn(c); return; }
    /* EFXSTAT: inventory of the D3DX effect vtable calls (d3dx_hle.c) */
    { extern int g_efx_stat; extern void efx_stat_note(CPU *c, uint32_t addr);
      if (g_efx_stat && addr - 0x650000u < 0x40000u) efx_stat_note(c, addr); }
    uint32_t off = addr - TEXT_BASE;
    if (off < TEXT_SIZE){
        uint32_t k = g_idx[off];
        if (k){
            /* ICALL=<address>: count the INDIRECT calls to that function and
             * dump the call chain for the first few.  Needed because virtual
             * calls do not show up in the static graph. */
            static uint32_t want = 0xFFFFFFFFu;
            if (want == 0xFFFFFFFFu){ const char *e = getenv("ICALL");
                                      want = e ? (uint32_t)strtoul(e,0,0) : 0; }
            if (want && addr == want){
                extern uint64_t g_icall_hits; g_icall_hits++;
                { static uint32_t seen[256]; static int ns=0;
                  uint32_t h2 = MR32(c->esp+8);
                  int f3=0; for(int q=0;q<ns;q++) if(seen[q]==h2) f3=1;
                  if(!f3 && ns<256){ seen[ns++]=h2;
                    fprintf(stderr,"  [bind] hash=0x%08X %s\n", h2,
                            h2==0x3EE7363Fu ? "  <<< WORLDVIEWPROJECTION" :
                           (h2==0x04191C37u ? "  <<< TEXTUREOFFSET" : "")); } }
                static int shown = 0;
                if (shown < 3){ shown++;
                    fprintf(stderr,"  [icall] 0x%08x called (arg1=%08x arg2=%08x arg3=%08x)\n",
                            addr, MR32(c->esp+4), MR32(c->esp+8), MR32(c->esp+12));
                    guest_backtrace(c, 10);
                }
            }
            g_stat_indirect_ok++; g_fn_ptr[k-1](c); return; }
    }
    /* A lifted DLL (server.dll at 0x00A00000, module.c): its own index,
     * before the interpreter would take the address as generated code. */
    { mod_fn f = module_fn_at(addr);
      if (f){ g_stat_indirect_ok++; f(c); return; } }
    /* No lifted counterpart.  The game may have generated code at this
     * address AT RUN TIME (NFSU2's material pipeline does this heavily).
     * Try a small x86 interpreter; on an unknown instruction it returns
     * safely (restores esp) and falls through to the diagnosis below. */
    { static int gx = -1;
      if (gx < 0){ const char *e = getenv("GENEXEC"); gx = (e && *e=='0') ? 0 : 1; }
      if (gx && mem_is_committed(addr) && run_generated(c, addr)){
          g_stat_indirect_ok++; return;
      } }

    g_stat_indirect_miss++;
    /* Caller: the return address is ALREADY ON THE STACK (before POP32).
     * g_watch_prev_ip used to be used, but that is only filled when the
     * instruction trace is on, so the report always showed 0x00000000. */
    { uint32_t ret = MR32(c->esp);
      if (g_miss_n < MISS_MAX){ g_miss_from[g_miss_n]=ret; g_miss[g_miss_n++]=addr; }
      static int shown = 0;
      if (shown < 5){ shown++;
          fprintf(stderr, "\n  [UNRESOLVED INDIRECT CALL] target=0x%08x  return=0x%08x\n"
                  "      eax=%08x ecx=%08x edx=%08x ebx=%08x esi=%08x edi=%08x\n"
                  "      arg1=%08x arg2=%08x arg3=%08x\n",
                  addr, ret, c->eax, c->ecx, c->edx, c->ebx, c->esi, c->edi,
                  MR32(c->esp+4), MR32(c->esp+8), MR32(c->esp+12));
          /* The bytes at the target: did the game generate CODE at run time
           * (a thunk), or is the pointer bad?  The quickest way to tell. */
          if (mem_is_committed(addr+15)){
              fprintf(stderr, "      96 bytes at the target:\n       ");
              for (int q = 0; q < 96; q++){
                  if (q && !(q & 15)) fprintf(stderr, "\n       ");
                  fprintf(stderr, " %02x", MR8(addr+q));
              }
              fprintf(stderr, "\n");
          } else fprintf(stderr, "      target NOT COMMITTED (not data, a garbage pointer)\n");
          guest_backtrace(c, 12);
      } }
    POP32(c->eip);            /* drop the return address, swallow the call */
}

void unsupported_insn(CPU *c, uint32_t addr, const char *mn){
    (void)c; (void)mn;
    g_stat_unsupported++;
    { extern void autotest_note_trap(uint32_t, const char*); autotest_note_trap(addr, mn); }
    if (g_unsup_n < MISS_MAX) g_unsup[g_unsup_n++] = addr;
}

void cpuid_shim(CPU *c){
    /* generic Pentium III-like: SSE yes, 3DNow no */
    switch (c->eax){
    case 0: c->eax=1; c->ebx=0x756e6547; c->edx=0x49656e69; c->ecx=0x6c65746e; break;
    case 1: c->eax=0x000006d8; c->ebx=0; c->ecx=0; c->edx=0x0383fbff; break;
    default: c->eax=c->ebx=c->ecx=c->edx=0; break;
    }
}
/* rdtsc: tied to real time, a fixed 3.0 GHz (consistent with QPC).  It used
 * to return +3000 per call, so the game's CPU MHz measurement (0x5C0AD0:
 * QPC + rdtsc + Sleep) found ~0 MHz and on the first run set ALL graphics
 * settings to the lowest (g_PerformanceLevel=0, 640x480).
 * Can be changed with NFSU2_TSC_MHZ. */
#include <mach/mach_time.h>
uint64_t rdtsc_shim(void){
    static mach_timebase_info_data_t tb; static uint64_t mhz = 0;
    if (!tb.denom){ mach_timebase_info(&tb);
        const char *e = getenv("NFSU2_TSC_MHZ"); mhz = e && *e ? strtoull(e, 0, 0) : 3000u; }
    __uint128_t ns = (__uint128_t)mach_absolute_time() * tb.numer / tb.denom;
    return (uint64_t)(ns * mhz / 1000u);
}

void dispatch_report(void){
    fprintf(stderr,"\n=== runtime ===\n");
    fprintf(stderr,"  indirect calls resolved  : %llu\n", (unsigned long long)g_stat_indirect_ok);
    fprintf(stderr,"  indirect calls unresolved: %llu\n", (unsigned long long)g_stat_indirect_miss);
    fprintf(stderr,"  unsupported instructions : %llu\n", (unsigned long long)g_stat_unsupported);
    genexec_report();
    if (g_miss_n){ fprintf(stderr,"  unresolved indirect calls (target <- calling instruction):\n");
        int shown=0;
        for(int i=0;i<g_miss_n && shown<12;i++){
            int dup=0; for(int j=0;j<i;j++) if(g_miss_from[j]==g_miss_from[i]) dup=1;
            if(dup) continue;
            fprintf(stderr,"    0x%08x  <-  0x%08x\n", g_miss[i], g_miss_from[i]); shown++; }
    }
    if (g_unsup_n){ fprintf(stderr,"  first trap addresses     :"); for(int i=0;i<g_unsup_n && i<10;i++) fprintf(stderr," 0x%08x",g_unsup[i]); fprintf(stderr,"\n"); }
}

/* --- guest stack tracer: resolves the return addresses in the .text range --- */
static uint32_t nearest_fn(uint32_t a){
    uint32_t lo=0, hi=g_fn_count, best=0;
    while(lo<hi){ uint32_t m=(lo+hi)/2;
        if(g_fn_addr[m]<=a){ best=g_fn_addr[m]; lo=m+1; } else hi=m; }
    return best;
}
void guest_backtrace(CPU *c, int maxn){
    fprintf(stderr,"    guest stack trace (esp=0x%08x):\n", c->esp);
    int shown=0;
    for (uint32_t k=0; k<2048 && shown<maxn; k++){
        uint32_t a = c->esp + 4u*k;
        if (!mem_is_committed(a)) continue;      /* skip an unmapped page */
        uint32_t v = MR32(a);
        const char *mn = 0; uint32_t mf;
        if (v - TEXT_BASE < TEXT_SIZE){
            uint32_t f = nearest_fn(v);
            fprintf(stderr,"      [%2d] +0x%04x  return 0x%08x   (sub_%08x + 0x%x)\n",
                    shown, k*4, v, f, v-f);
            shown++;
        } else if ((mf = module_nearest_fn(v, &mn)) != 0){
            fprintf(stderr,"      [%2d] +0x%04x  return 0x%08x   (%s sub_%08x + 0x%x)\n",
                    shown, k*4, v, mn, mf, v-mf);
            shown++;
        }
    }
}

/* Resolve the generated guest function from a faulting host PC: g_fn_ptr
 * maps host addresses to guest addresses; the nearest function start below
 * the PC is looked up. */
uint32_t guest_fn_from_host(const void *pc){
    uintptr_t p = (uintptr_t)pc, best = 0; uint32_t bestg = 0;
    for (uint32_t i = 0; i < g_fn_count; i++){
        uintptr_t f = (uintptr_t)g_fn_ptr[i];
        if (f <= p && f > best){ best = f; bestg = g_fn_addr[i]; }
    }
    /* the nearest start below pc may belong to a lifted DLL instead */
    { uint32_t mg = module_fn_from_host(pc);
      if (mg){ uintptr_t mf = 0;
          mod_fn fp = module_fn_at(mg); mf = (uintptr_t)fp;
          if (mf <= p && mf > best) bestg = mg; } }
    return bestg;
}
