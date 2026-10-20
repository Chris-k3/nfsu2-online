/* Runtime wrappers for lifted functions.
 *
 * The D3DX effect parameter tree was being parsed CYCLICALLY (node 0 -> 6 -> 4..8 -> 6)
 * and one past the node array's capacity (8) was requested (index 8).
 * The root cause is still open. There are two guards here:
 *   1) array bounds: return safely on an index past the capacity
 *   2) visited set: each node at most once per top-level walk
 * That way the walk terminates and the game can make progress.            */
#include "cpu.h"
#include <stdio.h>
#include <math.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include "enhance.h"

void guest_backtrace(CPU*,int);

uint64_t g_cycle_break = 0, g_oob_node = 0, g_depth_guard = 0;
static uint64_t guard_total = 0, guard_cap = 0;
static CPU *g_guard_cpu = 0;

#ifdef __wasm__
#define HEAP_LO 0x08000000u
#define HEAP_HI 0x28000000u
#else
#define HEAP_LO 0x10000000u
#define HEAP_HI 0x2F000000u
#endif

/* Find the heap block that contains a guest address (header: +0 size, +4 signature) */
static int block_of(uint32_t addr, uint32_t *ubeg, uint32_t *uend){
    if (addr < HEAP_LO || addr >= HEAP_HI) return 0;
    for (uint32_t p = (addr & ~15u); p >= HEAP_LO; p -= 16u){
        if (!mem_is_committed(p+4)) return 0;
        if (MR32(p+4) == 0xA110C8EDu){
            uint32_t sz = MR32(p), beg = p + 16u, end = beg + sz;
            if (addr >= beg && addr < end){ *ubeg = beg; *uend = end; return 1; }
            return 0;
        }
        if (p < 16u) break;
    }
    return 0;
}

static void guard_hit(void){
    if (!guard_cap){ const char *e = getenv("GUARD_CAP");
                     guard_cap = e ? (uint64_t)atoll(e) : 2000000ull; }
    if (guard_total == 5000 && g_guard_cpu && getenv("GUARD_BT")){
        fprintf(stderr,"\n=== call chain at the 5000th guard hit ===\n");
        guest_backtrace(g_guard_cpu, 14);
    }
    if (++guard_total > guard_cap){
        fprintf(stderr,"\n*** GUARD CEILING (%llu) - the effect system cannot make progress.\n",
                (unsigned long long)guard_cap);
        { extern uint32_t g_watch_addr; extern void watch_dump(const char*,int);
          if (g_watch_addr) watch_dump("guard ceiling", 20); }
        { extern void (*g_report_fn)(void); if (g_report_fn) g_report_fn(); }
        _exit(6);
    }
}

/* --- shared: node array bounds + visit check ------------------------- */
typedef struct { uint64_t bits[8]; uint32_t tab; } VisSet;   /* 512 nodes */

/* The tree guard is NOW OFF BY DEFAULT.
 * The cyclic parse actually came from CPU emulation bugs (x87 rounding,
 * SSE width, adc/sbb carry...).  With those fixed the walk terminates on
 * its own; the guard is only turned on with GUARD_ON=1, and then it also
 * cuts valid nodes and breaks the tree.                                  */
static int g_guard_off = -1;
static int guard_off(void){
    if (g_guard_off < 0) g_guard_off = getenv("GUARD_ON") ? 0 : 1;
    return g_guard_off;
}

static int node_guard(CPU *c, uint32_t a1, int depth, VisSet *vs){
    if (guard_off()) return 0;
    uint32_t tab = c->ecx + 0x2cu;
    if (!mem_is_committed(tab)) return 0;
    uint32_t arr = MR32(tab), beg, end;
    if (block_of(arr, &beg, &end)){
        uint32_t cap = (end - arr) / 0x64u;
        if (a1 >= cap){ g_oob_node++; guard_hit(); return 1; }
    }
    if (depth == 0){                       /* top level: reset the set */
        for (int i=0;i<8;i++) vs->bits[i]=0;
        vs->tab = arr;
    }
    if (arr == vs->tab && a1 < 512u){
        uint64_t *w = &vs->bits[a1 >> 6]; uint64_t b = 1ull << (a1 & 63);
        if (*w & b){ g_cycle_break++; guard_hit(); return 1; }
        *w |= b;
    }
    return 0;
}

/* --- sub_0066aa2f(a1, a2) : the main tree walker, ret 8, HRESULT ----- */
void sub_0066aa2f_orig(CPU *c);
static _Thread_local int d_aa3f = 0;
static _Thread_local VisSet vs_aa3f;

/* Dump the effect parameter tree's node array (diagnostic).
 * Node: 0x64 bytes.  +0x04 array base, +0x18/+0x1a child node indices
 * (0xFFFF = none), +0x58 type tag.                                       */
static void dump_nodes(CPU *c){
    uint32_t tab = c->ecx + 0x2cu;
    if (!mem_is_committed(tab)) return;
    uint32_t arr = MR32(tab), beg, end;
    if (!block_of(arr, &beg, &end)){ fprintf(stderr,"  [tree] array 0x%08x outside any block\n", arr); return; }
    uint32_t cap = (end - arr) / 0x64u;
    fprintf(stderr,"  [tree] array=0x%08x capacity=%u (block %08x..%08x)\n", arr, cap, beg, end);
    /* raw dump: to understand the node layout */
    for (uint32_t i = 0; i < cap && i < 4; i++){
        uint32_t n = arr + i*0x64u;
        if (!mem_is_committed(n+0x63)) break;
        fprintf(stderr,"    node[%u] raw @%08x:\n", i, n);
        for (int rw = 0; rw < 0x64; rw += 16){
            fprintf(stderr,"      +%02x:", rw);
            for (int q = 0; q < 16 && rw+q < 0x64; q++)
                fprintf(stderr," %02x", MR8(n+rw+q));
            fprintf(stderr,"   ");
            for (int q = 0; q < 16 && rw+q < 0x64; q++){
                uint8_t ch = MR8(n+rw+q);
                fputc((ch>=32&&ch<127)?ch:'.', stderr);
            }
            fprintf(stderr,"\n");
        }
        /* where do +0 and +4 point? */
        for (int f = 0; f <= 4; f += 4){
            uint32_t ptr = MR32(n+f);
            if (ptr && mem_is_committed(ptr+31)){
                fprintf(stderr,"      [+%d]->%08x:", f, ptr);
                for (int q=0;q<24;q++) fprintf(stderr," %02x", MR8(ptr+q));
                fprintf(stderr,"   ");
                for (int q=0;q<24;q++){ uint8_t ch=MR8(ptr+q);
                    fputc((ch>=32&&ch<127)?ch:'.', stderr); }
                fprintf(stderr,"\n");
            }
        }
    }
    for (uint32_t i = 0; i < cap && i < 64; i++){
        uint32_t n = arr + i*0x64u;
        if (!mem_is_committed(n+0x5C)) break;
        uint32_t nameptr = MR32(n);
        char nm[40]; nm[0]=0;
        if (nameptr && mem_is_committed(nameptr)){
            for (int k=0;k<32;k++){ uint8_t ch=MR8(nameptr+k);
                if (!ch || ch<32 || ch>126){ nm[k]=0; break; } nm[k]=(char)ch; nm[k+1]=0; }
        }
        fprintf(stderr,"    [%2u] name=0x%08x '%s' base=0x%08x sub18=%5u sub1a=%5u type=0x%08x\n",
                i, nameptr, nm, MR32(n+4),
                MR16(n+0x18), MR16(n+0x1a), MR32(n+0x58));
    }
}

/* Recursion chain: (node index, array base) pairs.
 * Dumped once the depth threshold is passed, to see the cycle concretely. */
static _Thread_local uint32_t chain_idx[160], chain_arr[160];
static int chain_dumped = 0;

void sub_0066aa2f(CPU *c){
    uint32_t a1 = MR32(c->esp + 4u);
    g_guard_cpu = c;
    { static int dumped = 0;
      if (!dumped && getenv("TREEDUMP")){ dumped = 1; dump_nodes(c); } }
    if (getenv("WALKLOG")){
        static int nlog = 0;
        if (nlog < 60){ nlog++;
            uint32_t tabp = c->ecx + 0x2cu;
            uint32_t arr = mem_is_committed(tabp) ? MR32(tabp) : 0;
            uint32_t esi = arr + a1*0x64u;
            if (mem_is_committed(esi+0x35))
                fprintf(stderr,"    [walk] depth=%2d a1=%-5u node=%08x "
                        "sub18=%5u sub1a=%5u count=%u base=%08x\n",
                        d_aa3f, a1, esi, MR16(esi+0x18), MR16(esi+0x1a),
                        MR16(esi+0x34), MR32(esi+4));
            else
                fprintf(stderr,"    [walk] depth=%2d a1=%-5u node=%08x UNREADABLE\n",
                        d_aa3f, a1, esi);
        }
    }
    if (d_aa3f < 160){ chain_idx[d_aa3f] = a1;
        chain_arr[d_aa3f] = mem_is_committed(c->ecx+0x2c) ? MR32(c->ecx+0x2c) : 0; }
    if (!chain_dumped && d_aa3f >= 40 && getenv("CHAIN")){
        chain_dumped = 1;
        fprintf(stderr,"  [chain] recursion depth %d, (index@array):\n", d_aa3f);
        for (int q = 0; q <= d_aa3f && q < 160; q++){
            fprintf(stderr," %u@%08x", chain_idx[q], chain_arr[q]);
            if ((q % 8) == 7) fprintf(stderr,"\n");
        }
        fprintf(stderr,"\n");
    }
    if (node_guard(c, a1, d_aa3f, &vs_aa3f)){
        POP32(c->eip); c->esp += 8u; c->eax = 0;   /* S_OK */
        return;
    }
    if (d_aa3f >= 128){ g_depth_guard++; guard_hit();
        POP32(c->eip); c->esp += 8u; c->eax = 0; return; }
    d_aa3f++;
    sub_0066aa2f_orig(c);
    d_aa3f--;
}

/* --- sub_0065ae25(a1, a2, a3) : helper walker, ret 0xc -------------- */
void sub_0065ae25_orig(CPU *c);
static _Thread_local int d_ae35 = 0;
static _Thread_local VisSet vs_ae35;

void sub_0065ae25(CPU *c){
    uint32_t a1 = MR32(c->esp + 4u);
    g_guard_cpu = c;
    if (node_guard(c, a1, d_ae35, &vs_ae35)){
        POP32(c->eip); c->esp += 12u; c->eax = 0;
        return;
    }
    if (d_ae35 >= 128){ g_depth_guard++; guard_hit();
        POP32(c->eip); c->esp += 12u; c->eax = 0; return; }
    d_ae35++;
    sub_0065ae25_orig(c);
    d_ae35--;
}

/* --- sub_006e2be0(list, b, c): walks the list and frees every item ------
 * The first argument can arrive NULL (a case that does not occur on Windows).
 * The original code has no null check and crashes; we return safely.     */
void sub_006e2be0(CPU *c);                     /* generated original */
uint64_t g_null_list = 0, g_e2be0_calls = 0;
static void wrap_6e2be0(CPU *c){
    uint32_t a1 = MR32(c->esp + 4u);
    g_e2be0_calls++;
    if (a1 == 0 || !mem_is_committed(a1 + 4u)){
        g_null_list++;
        POP32(c->eip);                          /* ret (cdecl: caller cleans up) */
        return;
    }
    sub_006e2be0(c);
}


/* --- sub_006623da: copies an effect parameter value into the shader constant block ---
 * __thiscall, 7 stack arguments.  Stack layout (caller 0x00669700):
 *   [esp+04] a1  -> *(a1)=source data, *(a1+4)=type descriptor
 *   [esp+08] a2  = destination (inside the constant block)
 *   [esp+0c] a3  = D3DXPARAMETER_TYPE (1=BOOL 2=INT 3=FLOAT)
 *   [esp+10] a4  = row count
 *   [esp+14] a5  = column count
 * Input/output is dumped to see why the WVP matrix was written incompletely. */
void sub_006623da_orig(CPU *c);
uint64_t g_copy_calls = 0;

void sub_006623da(CPU *c){
    uint32_t a1 = MR32(c->esp + 4u),  dst = MR32(c->esp + 8u);
    uint32_t ty = MR32(c->esp + 12u), rows = MR32(c->esp + 16u);
    uint32_t cols = MR32(c->esp + 20u);
    uint32_t src = (a1 && mem_is_committed(a1+7)) ? MR32(a1) : 0;
    uint32_t td  = (a1 && mem_is_committed(a1+7)) ? MR32(a1+4) : 0;
    uint32_t cls = (td && mem_is_committed(td+7)) ? MR32(td+4) : 0xFFFFFFFFu;
    g_copy_calls++;
    /* the FE effect's constant block is 80 bytes; trace only copies writing to it */
    static int n = 0;
    int is80 = 0;
    { uint32_t b1, e1;
      if (block_of(dst, &b1, &e1) && (e1 - b1) == 80u) is80 = 1; }
    int show = 0;   /* decided AFTER the copy */
    (void)show;
    /* MPROTSRC=1: WHO writes the FE effect's WVP value field?
     * Once the copy source is known we make the page read-only and catch it. */
    if (is80 && src && getenv("MPROTSRC")){
        static int armed3 = 0;
        uint32_t b2, e2;
        if (!armed3 && block_of(dst, &b2, &e2) && dst == b2){
            armed3 = 1;
            void mprot_arm(uint32_t);
            fprintf(stderr,"  [copy] WVP source %08x -- page write-protected\n", src);
            mprot_arm(src);
        }
    }
    sub_006623da_orig(c);
    /* Dump only the copies that write a MEANINGFUL value into the 80-byte FE block */
    if (getenv("COPYLOG") && is80 && n < 14 && dst && mem_is_committed(dst+63)){
        int meaningful = 0;
        for (int q=0;q<16;q++){
            float fv = MRF32(dst + 4*q);
            if (fv != 0.f && fabsf(fv) > 1e-6f && fabsf(fv) < 1e6f) meaningful = 1;
        }
        if (meaningful){ n++;
            uint32_t bb, ee; block_of(dst, &bb, &ee);
            fprintf(stderr,"  [copy %llu] a2=%u class=%d source=%08x target=%08x"
                    " (block %08x offset %d)\n",
                    (unsigned long long)g_copy_calls, ty, (int)cls, src, dst,
                    bb, (int)(dst - bb));
            if (src && mem_is_committed(src+63)){
                fprintf(stderr,"      source:");
                for (int r2=0;r2<4;r2++)
                    fprintf(stderr," [%.4g %.4g %.4g %.4g]", MRF32(src+r2*16),
                            MRF32(src+r2*16+4), MRF32(src+r2*16+8), MRF32(src+r2*16+12));
                fprintf(stderr,"\n");
            }
            fprintf(stderr,"      target:");
            for (int r2=0;r2<4;r2++)
                fprintf(stderr," [%.4g %.4g %.4g %.4g]", MRF32(dst+r2*16),
                        MRF32(dst+r2*16+4), MRF32(dst+r2*16+8), MRF32(dst+r2*16+12));
            fprintf(stderr,"\n");
            guest_backtrace(c, 8);
        }
    }
}

void overrides_install(void){
    void dispatch_patch(uint32_t, void(*)(CPU*));
    dispatch_patch(0x006e2be0u, wrap_6e2be0);
}

void overrides_report(void){
    if (g_e2be0_calls)
        fprintf(stderr,"  sub_006e2be0: %llu calls, %llu NULL lists skipped\n",
                (unsigned long long)g_e2be0_calls,(unsigned long long)g_null_list);
    if (g_cycle_break || g_oob_node || g_depth_guard)
        fprintf(stderr,"  tree guard: cycles %llu, out of bounds %llu, depth %llu\n",
                (unsigned long long)g_cycle_break,
                (unsigned long long)g_oob_node,
                (unsigned long long)g_depth_guard);
}

/* --- sub_0050d510: the game's DEBUG printf ------------------------------
 * In the retail build it is stubbed out as "xor eax,eax; ret", so the
 * engine's whole internal log is thrown away: front-end package switches,
 * the message queue, "Joy Event" input dispatch...  We catch and print it here.
 * cdecl, variadic: format = [esp+4], arguments from [esp+8].           */
uint32_t g_fe_mgr = 0;   /* front-end package manager (captured) */
void sub_0050d510_orig(CPU *c);

static const char *gstr(uint32_t p){
    if (!p || !mem_is_committed(p)) return "(null)";
    return (const char *)(g_mem + p);
}
void sub_0050d510(CPU *c){
    /* v12na: screen tracking (autotest waitfng/tapuntil) -- independent of GAMELOG.
     * The current front-end screen's name is taken from the "Init Package %s"
     * and "SwitchFEngPackages from %s to %s" calls. */
    { uint32_t fp = MR32(c->esp + 4u);
      if (fp && mem_is_committed(fp + 31)){
          const char *f = (const char *)(g_mem + fp);
          extern void autotest_note_screen(const char *);
          if (!strncmp(f, "Init Package %s", 15)) autotest_note_screen(gstr(MR32(c->esp + 8u)));
          else if (!strncmp(f, "SwitchFEngPackages from %s to %s", 32))
              autotest_note_screen(gstr(MR32(c->esp + 12u)));
      } }
    static int on = -1;
    if (on < 0){ const char *e = getenv("GAMELOG"); on = (e && *e && *e != '0'); }
    if (on){
        uint32_t fp = MR32(c->esp + 4u);
        if (fp && mem_is_committed(fp)){
            const char *f = (const char *)(g_mem + fp);
            uint32_t ap = c->esp + 8u;          /* next varargs slot */
            char out[1024]; size_t o = 0;
            for (const char *q = f; *q && o < sizeof out - 8; q++){
                if (*q != '%'){ out[o++] = *q; continue; }
                q++;
                if (*q == '%'){ out[o++] = '%'; continue; }
                /* skip the flag/width/precision fields */
                while (*q && (strchr("-+ #0", *q) || (*q >= '0' && *q <= '9') ||
                              *q == '.' || *q == 'l' || *q == 'h')) q++;
                char cv = *q;
                if (!cv) break;
                char tmp[256];
                if (cv == 's'){
                    uint32_t sp = mem_is_committed(ap+3) ? MR32(ap) : 0; ap += 4;
                    snprintf(tmp, sizeof tmp, "%s", gstr(sp));
                } else if (cv == 'c'){
                    uint32_t v = mem_is_committed(ap+3) ? MR32(ap) : 0; ap += 4;
                    snprintf(tmp, sizeof tmp, "%c", (int)(v & 0xFFu));
                } else if (cv == 'f' || cv == 'g' || cv == 'e'){
                    uint64_t lo = mem_is_committed(ap+7) ? ((uint64_t)MR32(ap) |
                                  ((uint64_t)MR32(ap+4) << 32)) : 0; ap += 8;
                    double dv; memcpy(&dv, &lo, 8);
                    snprintf(tmp, sizeof tmp, "%g", dv);
                } else {
                    uint32_t v = mem_is_committed(ap+3) ? MR32(ap) : 0; ap += 4;
                    if (cv == 'x') snprintf(tmp, sizeof tmp, "%x", v);
                    else if (cv == 'X') snprintf(tmp, sizeof tmp, "%X", v);
                    else if (cv == 'u') snprintf(tmp, sizeof tmp, "%u", v);
                    else if (cv == 'p') snprintf(tmp, sizeof tmp, "%08x", v);
                    else snprintf(tmp, sizeof tmp, "%d", (int)v);
                }
                for (const char *t2 = tmp; *t2 && o < sizeof out - 2; t2++) out[o++] = *t2;
            }
            out[o] = 0;
            fprintf(stderr, "  [game] %s%s", out,
                    (o && out[o-1] == '\n') ? "" : "\n");
            /* Inside SwitchFEngPackages ebx = the front-end package manager
             * ("this").  printf is called right at that point, so we catch the
             * pointer here for free; it is needed to force a switch. */
            if (!strncmp(out, "SwitchFEngPackages", 18)) g_fe_mgr = c->ebx;
            /* WHO triggers the screen switch?  The call chain of a successful
             * switch shows what is missing at the splash screen. */
            { const char *bt = getenv("GAMELOG_BT");
              static int nbt = 0;
              if (bt && *bt && nbt < 4 && !strncmp(out, bt, strlen(bt))){
                  nbt++; guest_backtrace(c, 16); } }
        }
    }
    sub_0050d510_orig(c);
}


/* --- Force rain (FORCERAIN) -----------------------------------------------
 * The game picks the weather at random at race start (measured: rain in ~1
 * of 8 runs); debugging a rain-specific problem needs reproducible rain.
 * Rain::Update = sub_0061f120 (__thiscall, ecx = the Rain* at eView+0x64):
 *   Rain+0x5094 target precipitation (0..1), +0x1f0 current intensity (moves
 *   toward the target), +0x509c cloud intensity.  The target is computed every
 *   frame by sub_0061e380 (if the "Rain" zone object 0x8a1f28 is active);
 *   otherwise the old target stays.
 * FORCERAIN=1 sets the target to 1.0, FORCERAIN=2 sets it to 0 (always dry).
 * FORCERAIN=3 OVERCAST sky without rain (+0x509c and its target +0x5098 = 0;
 * 1.0 = clear sky), FORCERAIN=4 overcast sky + rain.
 * Without the variable the behaviour is EXACTLY the game's.  In both builds. */
static int force_rain(void){
    static int fr = -1;
    if (fr < 0){ const char *e = getenv("FORCERAIN"); fr = e ? atoi(e) : 0; }
    return fr;
}
void sub_0061e380_orig(CPU *c);
void sub_0061e380(CPU *c){
    sub_0061e380_orig(c);
    int fr = force_rain();
    if (fr == 1 || fr == 4) ST(0) = 1.0; else if (fr == 2 || fr == 3) ST(0) = 0.0;
}
void sub_0061f120_orig(CPU *c);
void sub_0061f120(CPU *c){
    uint32_t rain = c->ecx;
    int fr = force_rain();
    if (fr && rain && mem_is_committed(rain + 0x50a3u))
        MRF32(rain + 0x5094u) = (fr == 1 || fr == 4) ? 1.0f : 0.0f;
    sub_0061f120_orig(c);
    if (fr >= 3 && rain && mem_is_committed(rain + 0x50a3u)){
        MRF32(rain + 0x5098u) = 0.0f; MRF32(rain + 0x509cu) = 0.0f; }
}

/* --- Force the sky transition (FORCETOD) ----------------------------------
 * sub_0060faa0 = time-of-day / sky state machine (every frame while the game
 * state is 6).  A 300 s cycle on the world timer 0x7fb718 (s):
 * if (int)timer % 300 == 60 and state 0x8a1c8c == 0 it moves to state 2 and
 * the sky transition (skymorph.efx: sunset -> night) starts.  Test runs last
 * ~60 s, so they only hit this transition now and then (measured: ~1 in 8
 * runs), and the HD build got very slow when they did.
 * FORCETOD=1 triggers the transition at the first chance; FORCETOD=<frame count>
 * after that many calls.  Unset, the behaviour is EXACTLY the game's.  In both builds. */
void sub_0060faa0_orig(CPU *c);
void sub_0060faa0(CPU *c){
    static int ft = -1, done = 0; static long calls = 0;
    if (ft < 0){ const char *e = getenv("FORCETOD"); ft = e ? atoi(e) : 0; }
    if (ft > 0 && !done && MR32(0x8654a4u) == 6u && MR32(0x8a1c78u) != 0u && ++calls >= ft &&
        MR32(0x8a1c8cu) == 0u){
        static int st = -1;
        if (st < 0){ const char *e = getenv("FORCETOD_STATE"); st = e ? atoi(e) : 2; if (st < 1 || st > 4) st = 2; }
        MR32(0x8a1c8cu) = (uint32_t)st; done = 1;
        fprintf(stderr, "[FORCETOD] sky state forced to %d (call %ld)\n", st, calls);
    }
    sub_0060faa0_orig(c);
}

/* --- sub_005c7ec0: per-view camera/projection setup ---------------------
 * __thiscall(ecx = matrix struct, [esp+4] = eView*), ret 0x10.
 *   eView+0x04 = view id (1 main, 3 rear-view mirror, 4 road reflection)
 *   eView+0x40 = Camera*  (CameraParams: +0xbc NearZ, +0xc0 FarZ, +0xc4 FOV)
 *   ecx+0x00 view matrix, +0x40 projection, +0x80 their product
 * The game only passes identity matrices to SetTransform; the camera can only
 * be read here.  Behaviour is UNCHANGED: only the address is captured and (in
 * the HD build) the main view's matrices are recorded into the frame.  In the
 * original build enh_view_setup is an empty inline function.               */
void sub_005c7ec0_orig(CPU *c);
void sub_005c7ec0(CPU *c){
    uint32_t plat = c->ecx, view = MR32(c->esp + 4u);
    sub_005c7ec0_orig(c);
    if (view && plat && mem_is_committed(view + 0x43u) && mem_is_committed(plat + 0xbfu))
        enh_view_setup(MR32(view + 4u), (const float *)(g_mem + plat),
                       MR32(view + 0x40u));
}


/* --- sub_0075bed4: the CRT's _ftol2 ---------------------------------------
 * ST(0) -> int64 in edx:eax, truncated toward zero; pops ST(0).  The hottest
 * lifted function on both ports (3.4 % of the Mac's race frame; 2.3 % in
 * Chrome).  It
 * rounds with fistp in the control word's RC, takes the difference (rounded
 * through X87R at PC=24), stores it as a float and adds or subtracts its sign
 * bit as a carry.  The wasm build runs this equivalent of the lifted body:
 * the same edx:eax, ecx, flags, x87 slots and top, esp and eip; only the
 * scratch stores below the caller's esp (its own frame) are not made.
 * tests/main_all.c section 6 checks it against the lifted body.  The Mac
 * keeps the lifted body (one forwarding call). */
void sub_0075bed4_orig(CPU *c);
void sub_0075bed4(CPU *restrict c){
#ifdef __wasm__
    FTOL2_BODY(c);                                          /* cpu.h */
    POP32(c->eip);
#else
    sub_0075bed4_orig(c);
#endif
}

/* --- the view-frustum box test ---------------------------------------------
 * sub_005bc210(M, lo, hi), cdecl: the box lo..hi (3 floats each, in and out)
 * through the matrix M (rows 0-2, translation in row 3), min and max per
 * axis summed term by term.  sub_005bc300(lo, hi, M), thiscall, ret 0xC: the
 * box (through M when M is not 0) against the six planes (n.x n.y n.z d) at
 * [ecx] + 0xC0: 0 outside one of them, 1 crossing one, 2 inside all.
 * sub_0048ac60 is a jmp to it that the lift copies whole.  The three were
 * ~6 % of a race frame in Chrome: run per object, with the x87 stack in
 * memory and every result tested.
 * On wasm they run in f32 here: at PC=24 and RC=nearest the x87 rounds each
 * result to 24 bits once, as f32 arithmetic does, while the result is a
 * normal float or zero (the lifted X87R gives the same: for float operands
 * the double result rounded to float is the correctly rounded one).  Every
 * result is checked for that; anything else (a NaN, an infinity, a float
 * subnormal, another control word) runs the lifted body from the untouched
 * state.  Same registers, flags, x87 top and condition bits, outputs and
 * stores at or above the caller's esp as the lifted bodies; not the scratch
 * stores below it, nor the x87 slots they leave empty.  tests/main_all.c
 * section 7 checks them against the lifted bodies.  The Mac keeps those. */
void sub_005bc210_orig(CPU *c);
void sub_005bc300_orig(CPU *c);
void sub_0048ac60_orig(CPU *c);
uint64_t g_cull_lifted;            /* calls that ran the lifted body (tests) */
#ifdef __wasm__
/* the x87 at PC=24 has this result too: a normal float or zero */
static inline uint32_t cull_ok(float x){
    float a = __builtin_fabsf(x);
    return (uint32_t)(x == 0.0f) | ((uint32_t)(a >= 0x1p-126f) & (uint32_t)(a <= 0x1.fffffep127f));
}
/* sub_005bc210's arithmetic on lo/hi (in place); 0 if the lifted body must
 * run.  *cmp: its last fcom (row 2, column 2: lo product vs hi product),
 * *pb: the hi product it stored in its first argument's slot then. */
static int cull_xform(uint32_t M, float lo[3], float hi[3], int *cmp, float *pb_last){
    float mn[3], mx[3], pa = 0, pb = 0;
    uint32_t ok = 1;
    for (int j = 0; j < 3; j++) mn[j] = mx[j] = MRF32(M + 0x30u + 4u * (uint32_t)j);
    for (int i = 0; i < 3; i++)
        for (int j = 0; j < 3; j++){
            float m = MRF32(M + 16u * (uint32_t)i + 4u * (uint32_t)j);
            pa = lo[i] * m; pb = hi[i] * m;
            if (pa < pb){ mn[j] += pa; mx[j] += pb; } else { mn[j] += pb; mx[j] += pa; }
            ok &= cull_ok(pa) & cull_ok(pb) & cull_ok(mn[j]) & cull_ok(mx[j]);
        }
    if (!ok) return 0;
    *cmp = pa < pb ? -1 : pa > pb ? 1 : 0; *pb_last = pb;
    for (int j = 0; j < 3; j++){ lo[j] = mn[j]; hi[j] = mx[j]; }
    return 1;
}
static void cull_fsw(CPU *restrict c, int cmp){
    c->fsw &= (uint16_t)~(FSW_C0 | FSW_C2 | FSW_C3);
    if (cmp < 0) c->fsw |= FSW_C0; else if (cmp == 0) c->fsw |= FSW_C3;
}
static int xform_native(CPU *restrict c){
    if (c->fcw & 0x0F00u) return 0;
    uint32_t e = c->esp, M = MR32(e + 4u), A = MR32(e + 8u), B = MR32(e + 12u);
    float lo[3], hi[3]; int cmp; float pb;
    for (int j = 0; j < 3; j++){ lo[j] = MRF32(A + 4u * (uint32_t)j); hi[j] = MRF32(B + 4u * (uint32_t)j); }
    if (!cull_xform(M, lo, hi, &cmp, &pb)) return 0;
    for (int j = 0; j < 3; j++){ MRF32(A + 4u * (uint32_t)j) = lo[j]; MRF32(B + 4u * (uint32_t)j) = hi[j]; }
    MRF32(e + 4u) = pb;                                   /* its fstp [esp+0x20] scratch */
    cull_fsw(c, cmp);
    c->eax = (M & 0xffff0000u) | fsw_get_top(c, ((uint32_t)c->top - 7u) & 7u);   /* fnstsw ax */
    c->ecx = A + 12u; c->edx = M + 0x38u;
    { uint32_t a = e - 12u, r = e; FLAGS_ADD_M(a, 0xcu, r, 32, F_ALL); }         /* add esp, 0xc */
    POP32(c->eip);
    return 1;
}
static int frustum_native(CPU *restrict c){
    if (c->fcw & 0x0F00u) return 0;
    uint32_t e = c->esp, P1 = MR32(e + 4u), P2 = MR32(e + 8u), M = MR32(e + 12u);
    float lo[3], hi[3], C[3], H[3]; int cmp; float pb;
    for (int j = 0; j < 3; j++){ lo[j] = MRF32(P1 + 4u * (uint32_t)j); hi[j] = MRF32(P2 + 4u * (uint32_t)j); }
    if (M && !cull_xform(M, lo, hi, &cmp, &pb)) return 0;
    float half = MRF32(0x00784260u), K = MRF32(0x007d7d3cu);
    uint32_t ok = 1;
    for (int j = 0; j < 3; j++){
        float s = hi[j] + lo[j]; C[j] = s * half; H[j] = hi[j] - C[j];
        ok &= cull_ok(s) & cull_ok(C[j]) & cull_ok(H[j]);
    }
    if (!ok) return 0;
    uint32_t base = MR32(c->ecx), p = base + 0xc0u, inter = 0;
    int k, last = 0;
    for (k = 0; k < 6; k++, p += 16u){
        float nx = MRF32(p), ny = MRF32(p + 4u), nz = MRF32(p + 8u), d = MRF32(p + 12u);
        float r1 = __builtin_fabsf(nz) * H[2], r2 = __builtin_fabsf(nx) * H[0], r3 = __builtin_fabsf(ny) * H[1];
        float r12 = r1 + r2, r = r12 + r3;
        float s1 = C[2] * nz, s2 = C[0] * nx, s3 = C[1] * ny;
        float s12 = s1 + s2, s123 = s12 + s3, s = s123 + d, sp = s + r;
        if (!(cull_ok(r1) & cull_ok(r2) & cull_ok(r3) & cull_ok(r12) & cull_ok(r) & cull_ok(s1) & cull_ok(s2)
              & cull_ok(s3) & cull_ok(s12) & cull_ok(s123) & cull_ok(s) & cull_ok(sp))) return 0;
        if (sp < K) break;                                /* outside this plane */
        float sm = s - r;
        if (!cull_ok(sm)) return 0;
        if (sm < K) inter = 1;
        last = sm < K ? -1 : sm > K ? 1 : 0;
    }
    if (k < 6){                                           /* fcomp; ...; fstp st0; xor eax, eax */
        cull_fsw(c, -1);
        c->eax = 0; c->ecx = base + 0xc4u + 16u * (uint32_t)k; c->edx = (uint32_t)k + 1u;
        FLAGS_LOG_M(0u, 32, F_ALL);
    } else {                                              /* test esi, esi; sete al; inc eax */
        cull_fsw(c, last);
        uint32_t a = inter ? 0u : 1u, r = a + 1u;
        c->eax = r; c->ecx = base + 0xc4u + 0x60u; c->edx = 7u;
        FLAGS_LOG_M(inter, 32, F_ALL);
        { uint32_t cf = c->cf; FLAGS_ADD_M(a, 1u, r, 32, F_ALL); c->cf = cf; }
    }
    POP32(c->eip); c->esp += 12u;
    return 1;
}
#endif
void sub_005bc210(CPU *restrict c){
#ifdef __wasm__
    if (xform_native(c)) return;
#endif
    g_cull_lifted++;
    sub_005bc210_orig(c);
}
void sub_005bc300(CPU *restrict c){
#ifdef __wasm__
    if (frustum_native(c)) return;
#endif
    g_cull_lifted++;
    sub_005bc300_orig(c);
}
void sub_0048ac60(CPU *restrict c){
#ifdef __wasm__
    if (frustum_native(c)) return;
#endif
    g_cull_lifted++;
    sub_0048ac60_orig(c);
}

/* --- sub_0068ce7c: D3DXMatrixMultiply, the SSE version ---------------------
 * (out, a, b), stdcall: out = a * b, 4x4 floats, returns out.  D3DX calls it
 * through its CPU table for every matrix product: 2.7 % of a race frame in
 * Chrome, where the lift does each packed operation lane by lane through the
 * SSE NaN rule.  On wasm it runs here as f32x4 operations in the same order
 * (row 0 (a0 b0 + a1 b1) + (a2 b2 + a3 b3), rows 1 and 2 summed left to
 * right, row 3 as row 0): IEEE results like SSE's, denormals included (the
 * game leaves MXCSR at its default).  A NaN anywhere runs the lifted body
 * (wasm does not keep SSE's NaN operand order).  The same memory, eax, ecx,
 * edx and xmm0-7 as the lifted body; tests/main_all.c section 8 checks it.
 * The Mac keeps the lifted body. */
void sub_0068ce7c_orig(CPU *c);
uint64_t g_mmul_lifted;            /* calls that ran the lifted body (tests) */
void sub_0068ce7c(CPU *restrict c){
#ifdef __wasm__
#pragma clang fp contract(off)
    typedef float v4 __attribute__((vector_size(16), aligned(4)));
    uint32_t e = c->esp, out = MR32(e + 4u), A = MR32(e + 8u), B = MR32(e + 12u);
    v4 r0, r1, r2, r3; float a[16];
    memcpy(&r0, g_mem + B, 16); memcpy(&r1, g_mem + B + 16u, 16);
    memcpy(&r2, g_mem + B + 32u, 16); memcpy(&r3, g_mem + B + 48u, 16);
    memcpy(a, g_mem + A, 64);
#define BC(x_) ((v4){ (x_), (x_), (x_), (x_) })
    v4 o0 = (BC(a[0]) * r0 + BC(a[1]) * r1) + (BC(a[2]) * r2 + BC(a[3]) * r3);
    v4 o1 = ((BC(a[4]) * r0 + BC(a[5]) * r1) + BC(a[6]) * r2) + BC(a[7]) * r3;
    v4 o2 = ((BC(a[8]) * r0 + BC(a[9]) * r1) + BC(a[10]) * r2) + BC(a[11]) * r3;
    v4 p0 = r0 * BC(a[12]), p1 = r1 * BC(a[13]), p3 = r3 * BC(a[15]), q = r2 * BC(a[14]) + p3;
    v4 o3 = (p0 + p1) + q;
    __typeof__(o0 != o0) nan = (o0 != o0) | (o1 != o1) | (o2 != o2) | (o3 != o3);
    if (!(nan[0] | nan[1] | nan[2] | nan[3])){
        memcpy(g_mem + out, &o0, 16); memcpy(g_mem + out + 16u, &o1, 16);
        memcpy(g_mem + out + 32u, &o2, 16); memcpy(g_mem + out + 48u, &o3, 16);
        v4 x7 = BC(a[15]);
        memcpy(&c->xmm[0], &o3, 16); memcpy(&c->xmm[1], &p1, 16); memcpy(&c->xmm[2], &q, 16); memcpy(&c->xmm[3], &p3, 16);
        memcpy(&c->xmm[4], &o0, 16); memcpy(&c->xmm[5], &o1, 16); memcpy(&c->xmm[6], &o2, 16); memcpy(&c->xmm[7], &x7, 16);
        c->eax = out; c->ecx = B; c->edx = out;
        POP32(c->eip); c->esp += 12u;
        return;
    }
#undef BC
    g_mmul_lifted++;
#endif
    sub_0068ce7c_orig(c);
}

/* --- UI_ChoosePerformancePackage: a field the game never initialises ------
 * The Performance Shop's package screen (vtable 0x79D2D0, 0x250 bytes from
 * operator new, constructor sub_00559c90) never writes its field +0xC0, but
 * its refresh method sub_005620d0 -- first called from inside the
 * constructor (0x556E60 -> 0x557119) -- reads it: -10 or 1 there means
 * "close the parts list and open it again".  The field holds whatever the
 * heap block held before (0xEEEEEEEE in a fresh block; 1 after some heap
 * histories: movies played, 60 fps or a slow frame rate).  With 1, entering
 * a category whose carousel starts at "Choose Individual Parts" (Nitrous
 * Oxide) opens UI_BuyPerformanceParts twice; the first one is popped at once,
 * the package screen stays hidden with control mask 0 under the second, and
 * after ESC no screen takes input: the shop is dead until Cmd-Q
 * (+0xC0 = 1 at sub_005620d0's first call, 0xC3ED0000 in the good run;
 * the mouse position plays no part).  Nothing else in the game reads or writes the
 * field (all accesses in 0x540000..0x575000), so the screen is given the
 * value of a fresh block before its constructor runs: the parts list opens
 * once, both screens keep input, and ESC goes back to the categories, as in
 * every run where the stale value was not -10 or 1. */
void sub_00559c90_orig(CPU *c);
void sub_00559c90(CPU *c){
    uint32_t self = c->ecx;
    if (self && mem_is_committed(self) && mem_is_committed(self + 0xc3u))
        MR32(self + 0xc0u) = 0xEEEEEEEEu;
    sub_00559c90_orig(c);
}
