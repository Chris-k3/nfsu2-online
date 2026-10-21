/* Checks on the full build of the 23k lifted functions */
#include "cpu.h"
#include "decls.h"
#include <stdio.h>
#include <math.h>
#include <string.h>
#include <unistd.h>
void dispatch_init(void); void dispatch_report(void);
extern const uint32_t g_fn_count;
uint64_t mem_committed(void);
extern uint64_t g_stat_indirect_ok, g_stat_indirect_miss, g_stat_unsupported;

static CPU cpu; static CPU *const c = &cpu;
#define STACK_TOP 0x00F00000u
static void reset(void){ memset(&cpu,0,sizeof cpu); cpu.esp=STACK_TOP; cpu.top=0; cpu.fcw=0x037f; }
static float GF(uint32_t a){ return MRF32(a); }
int pass=0,fail=0;
#define CHKI(n,g,e) do{ uint32_t _g=(g),_e=(e); if(_g==_e){pass++;printf("  \033[32mPASS\033[0m  %-40s = 0x%08x\n",n,_g);} \
  else{fail++;printf("  \033[31mFAIL\033[0m  %-40s = 0x%08x (expected 0x%08x)\n",n,_g,_e);} }while(0)
#define CHKF(n,g,e) do{ float _g=(g),_e=(e); if(memcmp(&_g,&_e,4)==0){pass++;printf("  \033[32mPASS\033[0m  %-40s = %.9g\n",n,(double)_g);} \
  else{fail++;printf("  \033[31mFAIL\033[0m  %-40s = %.9g (expected %.9g)\n",n,(double)_g,(double)_e);} }while(0)

/* --- 5. Guest heap (runtime/heap.c): Win32 heap and VirtualAlloc semantics ---
 * Calls go through heap_api() exactly as the import bridge makes them
 * (stdcall arguments on the guest stack). */
int      heap_api_kind(const char *name);
uint32_t heap_api(CPU *c, int kind);
static uint32_t H(const char *fn, int n, ...){
    __builtin_va_list ap; __builtin_va_start(ap, n);
    uint32_t a[8]; for (int i = 0; i < n; i++) a[i] = __builtin_va_arg(ap, uint32_t);
    __builtin_va_end(ap);
    reset();
    for (int i = n - 1; i >= 0; i--) PUSH32(a[i]);
    cpu.eip = 0x00401000u;                         /* "caller" */
    return heap_api(&cpu, heap_api_kind(fn));
}
static uint32_t rng_state = 12345u;
static uint32_t rnd(void){ rng_state = rng_state * 1103515245u + 12345u; return rng_state >> 8; }
/* --- 6. _ftol2 (0x75BED4): the runtime's equivalent (runtime/overrides.c,
 * wasm) against the lifted body, from the same CPU state: every register,
 * flag, x87 slot, top and the return.  Inputs: integers, halves, fractions
 * around them, both signs, the int64 limits, huge values, infinities, NaNs,
 * random bit patterns; control words of the game thread (PC=24, nearest),
 * the CRT (PC=53/64) and the directed rounding modes. */
void sub_0075bed4_orig(CPU *c);
/* What a caller can observe: the general registers, esp/eip, top, the x87
 * registers still on the stack (not the two the call pushed and popped:
 * empty slots, which an X87OPT lift does not write back), and the flags.  A
 * FLAGABI lift (web/gen.sh; web/tools/main_all.sh defines LIFT_FLAGABI) has
 * proved that no caller reads flags after _ftol2 returns and leaves them as
 * they happen to be: they are not compared then. */
#define FTOL_SENT 0x55u
static int ftol_same(const CPU *a, const CPU *b, uint32_t T){
    if (memcmp(a->r, b->r, sizeof a->r) || a->eip != b->eip || a->top != b->top) return 0;
#ifndef LIFT_FLAGABI
    const uint32_t *fa = &a->cf, *fb = &b->cf;
    for (int k = 0; k < 7; k++) if (fa[k] != fb[k]) return 0;
#endif
    for (uint32_t k = 0; k < 8; k++)
        if (k != T && k != ((T - 1u) & 7u) && memcmp(&a->st[k], &b->st[k], 8)) return 0;
    return 1;
}
static void ftol_tests(void){
    printf("\n--- 6. _ftol2 (0x75BED4): runtime equivalent vs lifted body ---\n");
    static const uint16_t cws[] = { 0x007f, 0x027f, 0x037f, 0x047f, 0x087f, 0x0c7f, 0x0e7f, 0x0f7f, 0x003f };
    double base[] = { 0, 1, -1, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 0.49999997, -0.49999997, 0.7, -0.7, 123456.789, -123456.789,
        4294967295.5, 4294967296.0, -4294967296.0, 4294967296.25, -4294967296.25, 4294967295.75, 2147483647.5, -2147483648.5,
        9007199254740993.0, 9.2233720368547748e18, -9.2233720368547758e18, 9.2233720368547758e18, 1e19, -1e19, 1e300, -1e300,
        1e-300, -1e-300, 4.9e-324, INFINITY, -INFINITY, NAN, -NAN, 16777217.0, -16777217.0, 0.1, -0.1, 1e-10, -1e-10 };
    int n = 0, bad = 0; uint32_t seed = 0x5eed1234u;
    for (unsigned w = 0; w < sizeof cws / sizeof *cws; w++)
        for (int i = 0; i < 4000; i++){
            double v;
            if (i < (int)(sizeof base / sizeof *base)) v = base[i];
            else if (i < 2000){ seed = seed * 1103515245u + 12345u; double m = (double)(seed >> 8) / 65536.0; v = (seed & 1) ? -m : m;
                if (i & 2) v = nearbyint(v) + ((seed >> 3 & 3) - 1.5) * 0.5; }
            else { uint64_t b; seed = seed * 1103515245u + 12345u; b = (uint64_t)seed << 32;
                seed = seed * 1103515245u + 12345u; b |= seed; memcpy(&v, &b, 8); }
            CPU a; reset(); cpu.fcw = cws[w]; cpu.top = (int32_t)(i & 7);
            for (int k = 0; k < 8; k++) cpu.st[k] = 1000.0 + k;
            cpu.st[cpu.top] = v; cpu.ecx = 0x1234u; cpu.edx = 0x55aa55aau; cpu.eax = 0xdeadbeefu;
            { uint32_t *f = &cpu.cf; for (int k = 0; k < 7; k++) f[k] = FTOL_SENT; }
            PUSH32(0xC0DE0000u + (uint32_t)i);
            a = cpu; CPU *s = &a;
            sub_0075bed4_orig(s); sub_0075bed4(&cpu);
            n++;
            if (!ftol_same(&a, &cpu, (uint32_t)(i & 7))){ if (bad++ < 8) printf("  differs: fcw %04x v %.17g: lifted %08x:%08x top %d, runtime %08x:%08x top %d\n",
                cws[w], v, a.edx, a.eax, a.top, cpu.edx, cpu.eax, cpu.top); }
        }
    char nm[64]; snprintf(nm, sizeof nm, "_ftol2 equivalent (%d inputs)", n);
    CHKI(nm, (uint32_t)bad, 0u);
    /* A lifted caller: 0x48AC70(a, b) on an object with v at +0xC returns
     * (int)(v / b * a) when a * 0.5 < b, else (int)(v + v), each step rounded
     * to float (the game thread's control word).  The x87 values the caller
     * keeps in locals must reach _ftol2, and its pop must reach the caller. */
    int bad2 = 0, n2 = 0;
    for (int i = 0; i < 2000; i++){
        float a = (float)((int)(rnd() % 20001) - 10000) / 64.0f, b = (float)(1 + rnd() % 8000) / 32.0f;
        float v = (float)((int)(rnd() % 200001) - 100000) / 16.0f;
        if (i & 1) b = -b;
        reset(); cpu.fcw = 0x007f; cpu.top = (int32_t)(i & 7);
        uint32_t OBJ = 0x00E00000u; MRF32(OBJ + 0xcu) = v; cpu.ecx = OBJ;
        uint32_t ab, bb; memcpy(&ab, &a, 4); memcpy(&bb, &b, 4);
        PUSH32(bb); PUSH32(ab); PUSH32(0xC0DE0000u + (uint32_t)i);
        uint32_t e = cpu.esp;
        sub_0048ac70(&cpu);
        float h = a * 0.5f, r = h < b ? v / b * a : v + v;
        n2++;
        if (cpu.eax != (uint32_t)(int32_t)truncf(r) || cpu.top != (int32_t)(i & 7) || cpu.esp != e + 12u){
            if (bad2++ < 8) printf("  differs: 0x48AC70(%g, %g) v %g: %d (top %d), expected %d\n", (double)a, (double)b, (double)v,
                                   (int32_t)cpu.eax, cpu.top, (int32_t)truncf(r)); }
    }
    snprintf(nm, sizeof nm, "_ftol2 from a lifted caller (%d inputs)", n2);
    CHKI(nm, (uint32_t)bad2, 0u);
}

/* --- 7. The view-frustum box test (0x5BC300, its jmp thunk 0x48AC60) and
 * the box transform (0x5BC210): the runtime's f32 versions (runtime/
 * overrides.c, wasm) against the lifted bodies, from the same CPU state and
 * memory: the general registers, eip, top, the x87 condition bits, the
 * outputs and the stores at or above esp; the flags unless the lift is
 * FLAGABI's (no caller reads them).  Inputs: boxes of world-sized numbers
 * through rotation/scale/translation matrices (with exact zeros), against
 * the planes of a view frustum (inside, crossing, outside), the game
 * thread's control word; some with a NaN, an infinity, a tiny or a huge
 * value, or another control word, which the runtime leaves to the lifted
 * body. */
void sub_005bc210_orig(CPU *c); void sub_005bc300_orig(CPU *c); void sub_0048ac60_orig(CPU *c);
extern uint64_t g_cull_lifted;
static float frnd(float lo, float hi){ return lo + (hi - lo) * (float)(rnd() & 0xffffff) / 16777216.0f; }
static float fspecial(void){
    static const float v[] = { NAN, -NAN, INFINITY, -INFINITY, 1e-40f, -1e-42f, 1e-30f, 3e38f, -3e38f, 1e30f, 0.0f, -0.0f };
    return v[rnd() % (sizeof v / sizeof *v)];
}
#define CULL_M 0x00E10000u   /* matrix */
#define CULL_A 0x00E10100u   /* lo */
#define CULL_B 0x00E10200u   /* hi */
#define CULL_V 0x00E10300u   /* the view: [+0] -> planes base */
#define CULL_P 0x00E10400u   /* planes base (planes at +0xC0) */
static int cull_inputs(int i){
    /* a box somewhere in the world */
    float cx = frnd(-3000, 3000), cy = frnd(-3000, 3000), cz = frnd(-200, 200), e = frnd(0.05f, 150);
    float lo[3] = { cx - e * frnd(0.2f, 1), cy - e * frnd(0.2f, 1), cz - e * frnd(0.2f, 1) };
    float hi[3] = { cx + e * frnd(0.2f, 1), cy + e * frnd(0.2f, 1), cz + e * frnd(0.2f, 1) };
    for (int j = 0; j < 3; j++){ MRF32(CULL_A + 4u * j) = lo[j]; MRF32(CULL_B + 4u * j) = hi[j]; }
    /* rotation about z (sometimes axis-aligned: exact zeros), a scale, a translation */
    float a = (i % 5 == 0) ? 0.0f : frnd(-3.2f, 3.2f), s = frnd(0.5f, 2.0f), ca = cosf(a) * s, sa = sinf(a) * s;
    float m[16] = { ca, sa, 0, 0,  -sa, ca, 0, 0,  0, 0, s, 0,  frnd(-500, 500), frnd(-500, 500), frnd(-20, 20), 1 };
    if (i % 7 == 1){ m[2] = frnd(-0.3f, 0.3f); m[8] = frnd(-0.3f, 0.3f); }
    for (int k = 0; k < 16; k++) MRF32(CULL_M + 4u * k) = m[k];
    /* six planes around a camera near the box, some of them past it */
    float px = cx + frnd(-400, 400), py = cy + frnd(-400, 400), pz = cz + frnd(-50, 50);
    MR32(CULL_V) = CULL_P;
    for (int k = 0; k < 6; k++){
        float nx = frnd(-1, 1), ny = frnd(-1, 1), nz = frnd(-0.3f, 0.3f), l = sqrtf(nx * nx + ny * ny + nz * nz) + 1e-3f;
        nx /= l; ny /= l; nz /= l;
        if (i % 11 == 3) nz = 0.0f;
        float d = -(nx * px + ny * py + nz * pz) + frnd(-300, 300);
        uint32_t p = CULL_P + 0xC0u + 16u * k;
        MRF32(p) = nx; MRF32(p + 4) = ny; MRF32(p + 8) = nz; MRF32(p + 12) = d;
    }
    /* some special values (the runtime hands those to the lifted body) */
    if (i % 13 == 5){
        static const uint32_t where[] = { CULL_A, CULL_A + 4, CULL_B + 8, CULL_M, CULL_M + 20, CULL_M + 52,
                                          CULL_P + 0xC4, CULL_P + 0xD0 + 12, CULL_P + 0x11C };
        MRF32(where[rnd() % (sizeof where / sizeof *where)]) = fspecial();
        return 1;
    }
    return 0;
}
static int cull_same(const CPU *a, const CPU *b, int nslots, uint32_t T){
    if (memcmp(a->r, b->r, sizeof a->r) || a->eip != b->eip || a->top != b->top) return 0;
    if ((a->fsw & (FSW_C0 | FSW_C2 | FSW_C3)) != (b->fsw & (FSW_C0 | FSW_C2 | FSW_C3))) return 0;
#ifndef LIFT_FLAGABI
    const uint32_t *fa = &a->cf, *fb = &b->cf;
    for (int k = 0; k < 7; k++) if (fa[k] != fb[k]) return 0;
#endif
    for (uint32_t k = 0; k < 8; k++){              /* the slots below top that the call used are empty */
        int used = 0;
        for (int q = 1; q <= nslots; q++) if (k == ((T - (uint32_t)q) & 7u)) used = 1;
        if (!used && memcmp(&a->st[k], &b->st[k], 8)) return 0;
    }
    return 1;
}
static void cull_tests(void){
    printf("\n--- 7. View-frustum box test (0x5BC300, 0x48AC60) and box transform (0x5BC210): runtime vs lifted ---\n");
    static const uint16_t cws[] = { 0x007f, 0x007f, 0x007f, 0x027f };   /* the game thread's (PC=24, nearest); PC=53 */
    static const char *const names[] = { "0x5BC210 transform", "0x5BC300 (no matrix)", "0x5BC300 (matrix)", "0x48AC60 (matrix)" };
    int n = 0, bad = 0, res[3] = { 0, 0, 0 }, slow = 0, ordinary_slow = 0;
    for (int f = 0; f < 4; f++)
        for (int i = 0; i < 3000; i++){
            int special = cull_inputs(i);
            static uint8_t in[0x600], outL[0x600];
            memcpy(in, g_mem + CULL_M, sizeof in);
            reset(); cpu.fcw = cws[i & 3]; cpu.top = (int32_t)(i & 7);
            for (int k = 0; k < 8; k++) cpu.st[k] = 1000.0 + k;
            cpu.ebx = 0x11111111u; cpu.ebp = 0x22222222u; cpu.esi = 0x33333333u; cpu.edi = 0x44444444u;
            cpu.eax = 0xdeadbeefu; cpu.ecx = CULL_V; cpu.edx = 0x55aa55aau; cpu.fsw = 0x0100u;
            { uint32_t *fl = &cpu.cf; for (int k = 0; k < 7; k++) fl[k] = FTOL_SENT; }
            if (f == 0){ PUSH32(CULL_B); PUSH32(CULL_A); PUSH32(CULL_M); }
            else { PUSH32(f >= 2 ? CULL_M : 0u); PUSH32(CULL_B); PUSH32(CULL_A); }
            PUSH32(0xC0DE0000u + (uint32_t)i);
            uint32_t e = cpu.esp;
            uint8_t stk[64], stkL[64]; memcpy(stk, g_mem + e, sizeof stk);
            CPU a = cpu; CPU *s = &a;
            if (f == 0) sub_005bc210_orig(s); else if (f == 3) sub_0048ac60_orig(s); else sub_005bc300_orig(s);
            memcpy(outL, g_mem + CULL_M, sizeof outL); memcpy(stkL, g_mem + e, sizeof stkL);
            memcpy(g_mem + CULL_M, in, sizeof in); memcpy(g_mem + e, stk, sizeof stk);
            uint64_t lifted0 = g_cull_lifted;
            if (f == 0) sub_005bc210(&cpu); else if (f == 3) sub_0048ac60(&cpu); else sub_005bc300(&cpu);
            n++;
            if (g_cull_lifted != lifted0){ slow++; if (!special && cws[i & 3] == 0x007f) ordinary_slow++; }
            int same = cull_same(&a, &cpu, f == 1 ? 3 : 8, (uint32_t)(i & 7)) && !memcmp(outL, g_mem + CULL_M, sizeof outL)
                       && !memcmp(stkL, g_mem + e, sizeof stkL);
            if (f && a.eax < 3u) res[a.eax]++;
            if (!same && bad++ < 8)
                printf("  differs: %s #%d cw %04x: lifted eax %08x ecx %08x edx %08x fsw %04x, runtime eax %08x ecx %08x edx %08x fsw %04x\n",
                       names[f], i, cws[i & 3], a.eax, a.ecx, a.edx, a.fsw, cpu.eax, cpu.ecx, cpu.edx, cpu.fsw);
        }
    printf("  %d calls, %d of them by the lifted body; boxes outside %d, crossing %d, inside %d\n",
           n, slow, res[0], res[1], res[2]);
    char nm[64]; snprintf(nm, sizeof nm, "frustum test equivalent (%d inputs)", n);
    CHKI(nm, (uint32_t)bad, 0u);
    CHKI("frustum test: ordinary calls by the lifted body", (uint32_t)ordinary_slow, 0u);
    CHKI("frustum test: special values by the lifted body", (uint32_t)(slow > 0), 1u);
}

/* --- 8. D3DXMatrixMultiply, SSE (0x68CE7C): the runtime's f32x4 version
 * (runtime/overrides.c, wasm) against the lifted body: the product, the
 * general registers, eip, xmm0-7 and the flags.  Inputs: random matrices
 * with zeros, denormals and overflows, the output aliased with either
 * input; some with a NaN, which the runtime leaves to the lifted body. */
void sub_0068ce7c_orig(CPU *c);
extern uint64_t g_mmul_lifted;
static void mmul_tests(void){
    printf("\n--- 8. D3DXMatrixMultiply SSE (0x68CE7C): runtime vs lifted ---\n");
    const uint32_t MA = 0x00E20000u, MB = 0x00E20100u, MO = 0x00E20200u;
    int n = 0, bad = 0, slow = 0, ordinary_slow = 0;
    for (int i = 0; i < 6000; i++){
        int special = 0;
        for (int k = 0; k < 16; k++){ MRF32(MA + 4u * k) = frnd(-4, 4); MRF32(MB + 4u * k) = frnd(-1000, 1000); }
        if (i % 3 == 0) for (int k = 0; k < 16; k++) if (rnd() & 1) MRF32(MA + 4u * k) = 0.0f;
        if (i % 17 == 2) MRF32(MB + 4u * (rnd() % 16)) = 1e-41f;                       /* a denormal */
        if (i % 19 == 4){ MRF32(MA + 4u * (rnd() % 16)) = 3e38f; special = 1; }       /* an overflow */
        if (i % 13 == 5){ MRF32((rnd() & 1 ? MA : MB) + 4u * (rnd() % 16)) = fspecial(); special = 1; }
        uint32_t out = i % 7 == 0 ? MA : i % 7 == 1 ? MB : MO;
        static uint8_t in[0x300], outL[0x300];
        memcpy(in, g_mem + MA, sizeof in);
        reset();
        cpu.eax = 0xdeadbeefu; cpu.ecx = 0x1234u; cpu.edx = 0x55aa55aau; cpu.ebx = 0x11111111u; cpu.ebp = 0x22222222u;
        { uint32_t *fl = &cpu.cf; for (int k = 0; k < 7; k++) fl[k] = FTOL_SENT; }
        for (int k = 0; k < 8; k++) for (int q = 0; q < 4; q++) cpu.xmm[k].u32[q] = rnd();
        PUSH32(MB); PUSH32(MA); PUSH32(out); PUSH32(0xC0DE0000u + (uint32_t)i);
        CPU a = cpu; CPU *s = &a;
        sub_0068ce7c_orig(s);
        memcpy(outL, g_mem + MA, sizeof outL); memcpy(g_mem + MA, in, sizeof in);
        uint64_t slow0 = g_mmul_lifted;
        sub_0068ce7c(&cpu);
        n++;
        if (g_mmul_lifted != slow0){ slow++; if (!special) ordinary_slow++; }
        int same = !memcmp(a.r, cpu.r, sizeof a.r) && a.eip == cpu.eip && !memcmp(a.xmm, cpu.xmm, sizeof a.xmm)
                   && !memcmp(&a.cf, &cpu.cf, 7 * sizeof(uint32_t)) && !memcmp(outL, g_mem + MA, sizeof outL);
        if (!same && bad++ < 8)
            printf("  differs: #%d out %08x: lifted eax %08x xmm0 %08x out[0] %08x, runtime eax %08x xmm0 %08x out[0] %08x\n",
                   i, out, a.eax, a.xmm[0].u32[0], *(uint32_t *)(outL + (out - MA)), cpu.eax, cpu.xmm[0].u32[0], MR32(out));
    }
    printf("  %d calls, %d of them by the lifted body\n", n, slow);
    char nm[64]; snprintf(nm, sizeof nm, "D3DXMatrixMultiply equivalent (%d inputs)", n);
    CHKI(nm, (uint32_t)bad, 0u);
    CHKI("D3DXMatrixMultiply: ordinary calls by the lifted body", (uint32_t)ordinary_slow, 0u);
    CHKI("D3DXMatrixMultiply: NaNs by the lifted body", (uint32_t)(slow > 0), 1u);
}

/* --- 9. A car's shadow outline (0x60CEE0): the runtime's version (runtime/
 * overrides.c, wasm) against the lifted body: the order of the point array,
 * eax, ebx, ebp, esi, edi, esp, eip and the x87 top (ecx, edx, the flags and
 * the x87 condition bits are dead at its only caller, 0x60D000).  Inputs:
 * 0..120 points on a coarse grid (many equal x or y, duplicates) or spread
 * out, near the origin or at world coordinates, with either comparator and
 * the game thread's control word or PC=53; some with a NaN, an infinity, a
 * tiny or a huge coordinate. */
void sub_0060cee0_orig(CPU *c);
extern uint64_t g_hull_lifted;
static void hull_tests(void){
    printf("\n--- 9. Shadow outline (0x60CEE0): runtime vs lifted ---\n");
    const uint32_t PTS = 0x00E30000u, ARR = 0x00E38000u;
    int n = 0, bad = 0, slow = 0;
    for (int i = 0; i < 6000; i++){
        uint32_t np = rnd() % 121u;
        int grid = i % 3 != 0;
        for (uint32_t k = 0; k < np; k++){
            float x = grid ? (float)(int)(rnd() % 9u) * 0.5f - 2.0f : frnd(-3, 3);
            float y = grid ? (float)(int)(rnd() % 9u) * 0.25f - 1.0f : frnd(-5, 5);
            if (i % 5 == 0){ x += 1695.3f; y -= 883.6f; }
            if (i % 11 == 7 && rnd() % 16u == 0){ if (rnd() & 1) x = fspecial(); else y = fspecial(); }
            MRF32(PTS + 16u * k) = x; MRF32(PTS + 16u * k + 4u) = y; MRF32(PTS + 16u * k + 8u) = 24.1f;
            MR32(ARR + 4u * k) = PTS + 16u * k;
        }
        for (uint32_t k = np; k > 1; k--){
            uint32_t j = rnd() % k, t = MR32(ARR + 4u * (k - 1u));
            MR32(ARR + 4u * (k - 1u)) = MR32(ARR + 4u * j); MR32(ARR + 4u * j) = t;
        }
        uint32_t cmp = (i & 1) ? 0x0060cec0u : 0x0060ce60u;
        static uint8_t in[0x200], outL[0x200];
        memcpy(in, g_mem + ARR, sizeof in);
        reset(); cpu.fcw = (i % 7 == 3) ? 0x027f : 0x007f; cpu.top = (int32_t)(i & 7);
        cpu.ebx = 0x11111111u; cpu.ebp = 0x22222222u; cpu.esi = 0x33333333u; cpu.edi = 0x44444444u;
        PUSH32(cmp); PUSH32(np); PUSH32(ARR); PUSH32(0xC0DE0000u + (uint32_t)i);
        CPU a = cpu; CPU *s = &a;
        sub_0060cee0_orig(s);
        memcpy(outL, g_mem + ARR, sizeof outL); memcpy(g_mem + ARR, in, sizeof in);
        uint64_t slow0 = g_hull_lifted;
        sub_0060cee0(&cpu);
        n++;
        if (g_hull_lifted != slow0) slow++;
        int same = a.eax == cpu.eax && a.ebx == cpu.ebx && a.ebp == cpu.ebp && a.esi == cpu.esi && a.edi == cpu.edi
                   && a.esp == cpu.esp && a.eip == cpu.eip && a.top == cpu.top && !memcmp(outL, g_mem + ARR, sizeof outL);
        if (!same && bad++ < 8)
            printf("  differs: #%d %u points, comparator %08x cw %04x: lifted eax %u, runtime eax %u\n",
                   i, np, cmp, cpu.fcw, a.eax, cpu.eax);
    }
    printf("  %d calls, %d of them by the lifted body\n", n, slow);
    char nm[64]; snprintf(nm, sizeof nm, "shadow outline equivalent (%d inputs)", n);
    CHKI(nm, (uint32_t)bad, 0u);
    CHKI("shadow outline: calls by the lifted body", (uint32_t)slow, 0u);
}

/* --- 10. Spherical-harmonic light (0x4895E0): the runtime's f32x4 version
 * (runtime/overrides.c, wasm) against the lifted body: the 40 coefficients,
 * the general registers, eip, the x87 top and condition bits, the flags
 * unless the lift is FLAGABI's, and the stores at or above esp (its store
 * over the colour argument).  Inputs: unit directions (some along an axis:
 * exact zeros), colours and scales of the game's range, coefficients summed
 * so far (some zero); some with a NaN, an infinity, a tiny or a huge value,
 * or another control word, which the runtime leaves to the lifted body. */
void sub_004895e0_orig(CPU *c);
extern uint64_t g_sh_lifted;
static uint32_t f2u(float f){ uint32_t u; memcpy(&u, &f, 4); return u; }
static void sh_tests(void){
    printf("\n--- 10. Spherical-harmonic light (0x4895E0): runtime vs lifted ---\n");
    const uint32_t COL = 0x00E40100u;
    int n = 0, bad = 0, slow = 0, ordinary_slow = 0;
    for (int i = 0; i < 8000; i++){
        int special = 0;
        /* as 0x48ED60 has them: on the stack just above the arguments (or, as
         * no caller has them, over the arguments: the runtime leaves that to
         * the lifted body) */
        const uint32_t OUT = (i % 97 == 50) ? STACK_TOP - 24u + 8u : (i % 5 == 4) ? STACK_TOP + 0x40u : 0x00E40000u;
        if (i % 97 == 50) special = 1;
        for (int k = 0; k < 40; k++) MRF32(OUT + 4u * k) = (i % 4 == 0) ? 0.0f : frnd(-3, 3);
        for (int k = 0; k < 4; k++) MRF32(COL + 4u * k) = (rnd() % 8u == 0) ? 0.0f : frnd(0, k == 3 ? 1.0f : 2.0f);
        float dx = frnd(-1, 1), dy = frnd(-1, 1), dz = frnd(-1, 1), l = sqrtf(dx * dx + dy * dy + dz * dz) + 1e-6f, sc = frnd(0, 3);
        dx /= l; dy /= l; dz /= l;
        if (i % 6 == 1){ dx = 0.0f; dy = 0.0f; dz = (rnd() & 1) ? 1.0f : -1.0f; }
        if (i % 6 == 2) dx = 0.0f;
        if (i % 13 == 5){
            special = 1;
            switch (rnd() % 4u){
            case 0: dx = fspecial(); break;
            case 1: MRF32(COL + 4u * (rnd() % 4u)) = fspecial(); break;
            case 2: MRF32(OUT + 4u * (rnd() % 40u)) = fspecial(); break;
            default: sc = fspecial();
            }
        }
        static uint8_t in[0x200], outL[0x200], stk[64], stkL[64];
        memcpy(in, g_mem + OUT, sizeof in);
        reset(); cpu.fcw = (i % 9 == 4) ? 0x027f : 0x007f; if (cpu.fcw != 0x007f) special = 1;
        cpu.top = (int32_t)(i & 7);
        for (int k = 0; k < 8; k++) cpu.st[k] = 1000.0 + k;
        cpu.eax = 0xdeadbeefu; cpu.ecx = OUT; cpu.edx = 0x55aa55aau; cpu.ebx = 0x11111111u;
        cpu.ebp = 0x22222222u; cpu.esi = 0x33333333u; cpu.edi = 0x44444444u; cpu.fsw = 0x0100u;
        { uint32_t *fl = &cpu.cf; for (int k = 0; k < 7; k++) fl[k] = FTOL_SENT; }
        PUSH32(f2u(dz)); PUSH32(f2u(dy)); PUSH32(f2u(dx)); PUSH32(f2u(sc)); PUSH32(COL); PUSH32(0xC0DE0000u + (uint32_t)i);
        uint32_t e = cpu.esp;
        memcpy(stk, g_mem + e, sizeof stk);
        CPU a = cpu; CPU *s = &a;
        sub_004895e0_orig(s);
        memcpy(outL, g_mem + OUT, sizeof outL); memcpy(stkL, g_mem + e, sizeof stkL);
        memcpy(g_mem + OUT, in, sizeof in); memcpy(g_mem + e, stk, sizeof stk);
        uint64_t slow0 = g_sh_lifted;
        sub_004895e0(&cpu);
        n++;
        if (g_sh_lifted != slow0){ slow++; if (!special) ordinary_slow++; }
        int same = !memcmp(a.r, cpu.r, sizeof a.r) && a.eip == cpu.eip && a.top == cpu.top
                   && (a.fsw & (FSW_C0 | FSW_C2 | FSW_C3)) == (cpu.fsw & (FSW_C0 | FSW_C2 | FSW_C3))
                   && !memcmp(outL, g_mem + OUT, sizeof outL) && !memcmp(stkL, g_mem + e, sizeof stkL);
#ifndef LIFT_FLAGABI
        same = same && !memcmp(&a.cf, &cpu.cf, 7 * sizeof(uint32_t));
#endif
        if (!same && bad++ < 8)
            printf("  differs: #%d cw %04x: lifted out[0] %08x eax %08x esp %08x, runtime out[0] %08x eax %08x esp %08x\n",
                   i, cpu.fcw, *(uint32_t *)outL, a.eax, a.esp, MR32(OUT), cpu.eax, cpu.esp);
    }
    printf("  %d calls, %d of them by the lifted body\n", n, slow);
    char nm[64]; snprintf(nm, sizeof nm, "SH light equivalent (%d inputs)", n);
    CHKI(nm, (uint32_t)bad, 0u);
    CHKI("SH light: ordinary calls by the lifted body", (uint32_t)ordinary_slow, 0u);
    CHKI("SH light: special values by the lifted body", (uint32_t)(slow > 0), 1u);
}

/* --- 11. Spherical-harmonic rotation (0x489BA0): the runtime's f32x4
 * version (runtime/overrides.c, wasm) against the lifted body: the 40
 * coefficients, the general registers, eip, the x87 top and condition bits,
 * the flags unless the lift is FLAGABI's, and the stores at or above esp (its
 * store over the matrix argument).  Inputs: rotations (some about an axis:
 * exact zeros and ones), scaled ones, coefficients (some zero); some with a
 * NaN, an infinity, a tiny or a huge value, or another control word. */
void sub_00489ba0_orig(CPU *c);
extern uint64_t g_shrot_lifted;
static void shrot_tests(void){
    printf("\n--- 11. Spherical-harmonic rotation (0x489BA0): runtime vs lifted ---\n");
    const uint32_t OUT = 0x00E60000u, MAT = 0x00E60100u;
    int n = 0, bad = 0, slow = 0, ordinary_slow = 0;
    for (int i = 0; i < 8000; i++){
        int special = 0;
        for (int k = 0; k < 40; k++) MRF32(OUT + 4u * k) = (i % 4 == 0 && k % 3 == 0) ? 0.0f : frnd(-2, 2);
        float ax = frnd(-3.2f, 3.2f), ay = frnd(-3.2f, 3.2f), s = (i % 5 == 1) ? frnd(0.5f, 2.0f) : 1.0f;
        float ca = cosf(ax), sa = sinf(ax), cb = cosf(ay), sb = sinf(ay);
        float m[12] = { cb * s, sa * sb * s, -ca * sb * s, 0,   0, ca * s, sa * s, 0,   sb * s, -sa * cb * s, ca * cb * s, 0 };
        if (i % 7 == 2){ float id[12] = { 1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0 }; memcpy(m, id, sizeof m); }
        for (int k = 0; k < 12; k++) MRF32(MAT + 4u * k) = m[k];
        if (i % 13 == 5){
            special = 1;
            if (rnd() & 1) MRF32(MAT + 4u * (rnd() % 11u)) = fspecial(); else MRF32(OUT + 4u * (rnd() % 40u)) = fspecial();
        }
        static uint8_t in[0x200], outL[0x200], stk[64], stkL[64];
        memcpy(in, g_mem + OUT, sizeof in);
        reset(); cpu.fcw = (i % 9 == 4) ? 0x027f : 0x007f; if (cpu.fcw != 0x007f) special = 1;
        cpu.top = (int32_t)(i & 7);
        for (int k = 0; k < 8; k++) cpu.st[k] = 1000.0 + k;
        cpu.eax = 0xdeadbeefu; cpu.ecx = OUT; cpu.edx = 0x55aa55aau; cpu.ebx = 0x11111111u;
        cpu.ebp = 0x22222222u; cpu.esi = 0x33333333u; cpu.edi = 0x44444444u; cpu.fsw = 0x0100u;
        { uint32_t *fl = &cpu.cf; for (int k = 0; k < 7; k++) fl[k] = FTOL_SENT; }
        PUSH32(MAT); PUSH32(0xC0DE0000u + (uint32_t)i);
        uint32_t e = cpu.esp;
        memcpy(stk, g_mem + e, sizeof stk);
        CPU a = cpu; CPU *sp = &a;
        sub_00489ba0_orig(sp);
        memcpy(outL, g_mem + OUT, sizeof outL); memcpy(stkL, g_mem + e, sizeof stkL);
        memcpy(g_mem + OUT, in, sizeof in); memcpy(g_mem + e, stk, sizeof stk);
        uint64_t slow0 = g_shrot_lifted;
        sub_00489ba0(&cpu);
        n++;
        if (g_shrot_lifted != slow0){ slow++; if (!special) ordinary_slow++; }
        int same = !memcmp(a.r, cpu.r, sizeof a.r) && a.eip == cpu.eip && a.top == cpu.top
                   && (a.fsw & (FSW_C0 | FSW_C2 | FSW_C3)) == (cpu.fsw & (FSW_C0 | FSW_C2 | FSW_C3))
                   && !memcmp(outL, g_mem + OUT, sizeof outL) && !memcmp(stkL, g_mem + e, sizeof stkL);
#ifndef LIFT_FLAGABI
        same = same && !memcmp(&a.cf, &cpu.cf, 7 * sizeof(uint32_t));
#endif
        if (!same && bad++ < 8){
            int q = 0; while (q < 40 && MR32(OUT + 4u * q) == *(uint32_t *)(outL + 4 * q)) q++;
            printf("  differs: #%d cw %04x: first coefficient %d lifted %08x runtime %08x; eax %08x/%08x edx %08x/%08x\n",
                   i, cpu.fcw, q, q < 40 ? *(uint32_t *)(outL + 4 * q) : 0u, q < 40 ? MR32(OUT + 4u * q) : 0u,
                   a.eax, cpu.eax, a.edx, cpu.edx);
        }
    }
    printf("  %d calls, %d of them by the lifted body\n", n, slow);
    char nm[64]; snprintf(nm, sizeof nm, "SH rotation equivalent (%d inputs)", n);
    CHKI(nm, (uint32_t)bad, 0u);
    CHKI("SH rotation: ordinary calls by the lifted body", (uint32_t)ordinary_slow, 0u);
    CHKI("SH rotation: special values by the lifted body", (uint32_t)(slow > 0), 1u);
}

static void heap_tests(void){
    printf("\n--- 5. Guest heap (TLSF + VA manager) ---\n");
    uint32_t ph = H("GetProcessHeap", 0);
    CHKI("GetProcessHeap", ph, 1u);
    uint32_t h2 = H("HeapCreate", 3, 0u, 0x1000u, 0u);
    CHKI("HeapCreate (CRT heap handle)", h2, 2u);
    uint32_t p = H("HeapAlloc", 3, h2, 0u, 100u);
    CHKI("HeapAlloc 16-byte aligned", p & 15u, 0u);
    CHKI("HeapSize", H("HeapSize", 3, h2, 0u, p), 100u);
    uint32_t z = H("HeapAlloc", 3, h2, 8u, 4000u);
    { int nz = 0; for (uint32_t i = 0; i < 4000u; i++) nz += MR8(z + i) != 0; CHKI("HEAP_ZERO_MEMORY", (uint32_t)nz, 0u); }
    memset(g_mem + p, 0x5A, 100);
    uint32_t p2 = H("HeapReAlloc", 4, h2, 0u, p, 5000u);
    { int ok = 1; for (uint32_t i = 0; i < 100u; i++) ok &= MR8(p2 + i) == 0x5A; CHKI("HeapReAlloc keeps data", (uint32_t)ok, 1u); }
    CHKI("HeapSize after realloc", H("HeapSize", 3, h2, 0u, p2), 5000u);
    CHKI("HeapFree", H("HeapFree", 3, h2, 0u, p2), 1u);
    CHKI("HeapFree twice fails", H("HeapFree", 3, h2, 0u, p2), 0u);
    CHKI("HeapFree of a non-block fails", H("HeapFree", 3, h2, 0u, 0x00E00010u), 0u);
    CHKI("HeapFree(NULL)", H("HeapFree", 3, h2, 0u, 0u), 1u);
    /* reuse: a freed block's space comes back */
    uint32_t q1 = H("HeapAlloc", 3, h2, 0u, 256u);
    H("HeapFree", 3, h2, 0u, q1);
    uint32_t q2 = H("HeapAlloc", 3, h2, 0u, 256u);
    CHKI("freed block is reused", q2, q1);
    H("HeapFree", 3, h2, 0u, q2); H("HeapFree", 3, h2, 0u, z);
    /* stress: random sizes, random frees, contents and overlap checked */
    enum { N = 3000 };
    static uint32_t ptr[N], sz[N]; int bad = 0, overlap = 0;
    for (int it = 0; it < 60000; it++){
        int i = (int)(rnd() % N);
        if (ptr[i]){
            for (uint32_t k = 0; k < sz[i]; k += 64) if (MR8(ptr[i] + k) != (uint8_t)(i + k)) bad++;
            if (rnd() & 1){ H("HeapFree", 3, h2, 0u, ptr[i]); ptr[i] = 0; }
            else { uint32_t ns = 1u + rnd() % (rnd() & 7 ? 2000u : 300000u);
                   uint32_t np = H("HeapReAlloc", 4, h2, 0u, ptr[i], ns);
                   if (!np){ bad++; continue; }
                   uint32_t keep = sz[i] < ns ? sz[i] : ns;
                   for (uint32_t k = 0; k < keep; k += 64) if (MR8(np + k) != (uint8_t)(i + k)) bad++;
                   ptr[i] = np; sz[i] = ns;
                   for (uint32_t k = 0; k < ns; k += 64) MR8(np + k) = (uint8_t)(i + k); }
        } else {
            uint32_t n = 1u + rnd() % (rnd() & 15 ? 1500u : 2000000u);
            uint32_t a = H("HeapAlloc", 3, h2, 0u, n);
            if (!a || (a & 15u)){ bad++; continue; }
            ptr[i] = a; sz[i] = n;
            for (uint32_t k = 0; k < n; k += 64) MR8(a + k) = (uint8_t)(i + k);
        }
    }
    for (int i = 0; i < N; i++) if (ptr[i]) for (int j = i + 1; j < N; j++)
        if (ptr[j] && ptr[i] < ptr[j] + sz[j] && ptr[j] < ptr[i] + sz[i]) overlap++;
    CHKI("stress: contents intact", (uint32_t)bad, 0u);
    CHKI("stress: no overlapping blocks", (uint32_t)overlap, 0u);
    for (int i = 0; i < N; i++) if (ptr[i]){ H("HeapFree", 3, h2, 0u, ptr[i]); ptr[i] = 0; }
    void heap_totals(uint64_t *, uint64_t *, uint64_t *, uint64_t *);
    uint64_t live, va0, va1; heap_totals(&live, 0, &va0, 0);
    CHKI("stress: all freed -> live bytes 0", (uint32_t)live, 0u);
    /* the whole segment coalesced: a 3.5 MB block fits without new VA */
    uint32_t big = H("HeapAlloc", 3, h2, 0u, 900000u);
    heap_totals(0, 0, &va1, 0);
    CHKI("coalescing: no new VA for a block that fits a free segment", (uint32_t)(va1 > va0), 0u);
    H("HeapFree", 3, h2, 0u, big);
    /* large blocks give their VA back */
    uint32_t lg = H("HeapAlloc", 3, h2, 0u, 64u << 20); heap_totals(0, 0, &va1, 0);
    CHKI("64 MB block: VA grows", (uint32_t)(va1 >= va0 + (64u << 20)), 1u);
    H("HeapFree", 3, h2, 0u, lg); heap_totals(0, 0, &va1, 0);
    CHKI("64 MB block freed: VA back", (uint32_t)(va1 == va0), 1u);
    /* GlobalAlloc / GlobalFree */
    uint32_t g = H("GlobalAlloc", 2, 0x40u, 300u);
    { int nz = 0; for (uint32_t i = 0; i < 300u; i++) nz += MR8(g + i) != 0; CHKI("GMEM_ZEROINIT", (uint32_t)nz, 0u); }
    CHKI("GlobalFree returns NULL", H("GlobalFree", 1, g), 0u);
    /* VirtualAlloc: reserve, commit inside, query, decommit, release */
    uint32_t r = H("VirtualAlloc", 4, 0u, 0x30000u, 0x2000u, 4u);
    CHKI("VirtualAlloc reserve: 64 KB aligned", r & 0xFFFFu, 0u);
    uint32_t mbi = 0x00E08000u;
    H("VirtualQuery", 3, r, mbi, 28u);
    CHKI("VirtualQuery reserved: MEM_RESERVE", MR32(mbi + 16), 0x2000u);
    CHKI("VirtualQuery AllocationBase", MR32(mbi + 4), r);
    uint32_t cm = H("VirtualAlloc", 4, r + 0x5123u, 0x2000u, 0x1000u, 4u);
    CHKI("VirtualAlloc commit: page of lpAddress", cm, r + 0x5000u);
    MR32(r + 0x5000u) = 0xC0FFEEu;
    H("VirtualQuery", 3, r + 0x5000u, mbi, 28u);
    CHKI("VirtualQuery committed: MEM_COMMIT", MR32(mbi + 16), 0x1000u);
    CHKI("VirtualQuery committed run size", MR32(mbi + 12), 0x3000u);
    CHKI("recommit keeps data", (H("VirtualAlloc", 4, r + 0x5000u, 0x1000u, 0x1000u, 4u), MR32(r + 0x5000u)), 0xC0FFEEu);
    CHKI("VirtualFree MEM_DECOMMIT", H("VirtualFree", 3, r + 0x4000u, 0xC000u, 0x4000u), 1u);
    H("VirtualQuery", 3, r + 0x5000u, mbi, 28u);
    CHKI("decommitted: MEM_RESERVE again", MR32(mbi + 16), 0x2000u);
    H("VirtualAlloc", 4, r + 0x5000u, 0x1000u, 0x1000u, 4u);
    CHKI("recommit after decommit reads zero", MR32(r + 0x5000u), 0u);
    CHKI("VirtualFree MEM_RELEASE needs size 0", H("VirtualFree", 3, r, 0x1000u, 0x8000u), 0u);
    CHKI("VirtualFree MEM_RELEASE", H("VirtualFree", 3, r, 0u, 0x8000u), 1u);
    H("VirtualQuery", 3, r, mbi, 28u);
    CHKI("released: MEM_FREE", MR32(mbi + 16), 0x10000u);
    uint32_t r2 = H("VirtualAlloc", 4, 0u, 0x10000u, 0x3000u, 4u);
    CHKI("reserve+commit reads zero", MR32(r2 + 0x100u), 0u);
    H("VirtualFree", 3, r2, 0u, 0x8000u);
    /* reserve+commit at a fixed, unaligned address: the region starts at the
     * 64 KB boundary below it, and every page up to lpAddress+dwSize is committed */
#ifdef __wasm__
#define FIXED_VA 0x20000000u        /* inside the wasm heap VA (heap.c GH_BASE..GH_LIMIT) */
#else
#define FIXED_VA 0x40000000u
#endif
    uint32_t fx = H("VirtualAlloc", 4, FIXED_VA + 0x8000u, 0x10000u, 0x3000u, 4u);
    CHKI("VirtualAlloc fixed reserve+commit: 64 KB base", fx, FIXED_VA);
    H("VirtualQuery", 3, FIXED_VA + 0x17000u, mbi, 28u);
    CHKI("fixed reserve+commit: last page committed", MR32(mbi + 16), 0x1000u);
    H("VirtualFree", 3, fx, 0u, 0x8000u);
    CHKI("HeapDestroy", H("HeapDestroy", 1, h2), 1u);
}

/* Virtual clock (win32.c host_us): inside one long frame, after the stall
 * valve has added its 200 ms, time must still move.  The game busy-waits on
 * QueryPerformanceCounter in places (0x45A630 waits 20 ticks for each sound
 * object it destroys on the way into a race); with a frozen clock that wait
 * never ended and the career hung (career-46/seg08, career-60/seg02). */
uint64_t host_us(void); void vclock_tick(void);
static void clock_tests(void){
    printf("\n--- 6. Virtual clock: time advances in a long frame too ---\n");
    vclock_tick();
    usleep(120000);                                   /* a 120 ms frame ...      */
    for (int i = 0; i < 4000; i++) (void)host_us();   /* ... that polled a lot   */
    uint64_t t0 = host_us(); long k = 0;
    while (host_us() < t0 + 20 && k < 2000000) k++;   /* the 0x45A630 wait */
    CHKI("20 us wait ends in a stalled frame", k < 2000000, 1u);
    uint64_t t1 = host_us(); vclock_tick();
    CHKI("monotonic across the next tick", host_us() >= t1, 1u);
}

int main(int argc,char**argv){
    mem_init(); mem_fault_handler_install();
    if(mem_load_pe(argc>1?argv[1]:"SPEED2.EXE")) return 1;
    mem_commit(0x00E00000u, 0x00200000u);        /* test heap + stack */
    dispatch_init();
    fprintf(stderr,"  committed guest memory: %.1f MB\n\n",(double)mem_committed()/1048576.0);
    printf("=== FULL BUILD: %u functions linked ===\n\n", g_fn_count);

    printf("--- 1. Direct calls (functions verified before) ---\n");
    reset(); PUSH32(7u); PUSH32(0xDEADC0DEu); sub_0048b1e0(&cpu);
    CHKI("sub_0048b1e0(7)", cpu.eax, 0x832de0u + 7*0x70u);
    reset(); PUSH32(0xDEADC0DEu); sub_0077b970(&cpu);
    CHKF("sub_0077b970 -> [0x82875c]", GF(0x82875c),
         (float)((((double)GF(0x786ff4)+(double)GF(0x786ff0))+(double)GF(0x82a4e8))+(double)GF(0x7844c0)));

    printf("\n--- 2. INDIRECT dispatch: the same functions by address ---\n");
    uint64_t ok0=g_stat_indirect_ok;
    reset(); PUSH32(7u); PUSH32(0xDEADC0DEu); dispatch_indirect(&cpu, 0x0048b1e0u);
    CHKI("dispatch(0x0048b1e0)(7)", cpu.eax, 0x832de0u + 7*0x70u);
    reset(); PUSH32(0xDEADC0DEu); dispatch_indirect(&cpu, 0x0077b950u);
    CHKF("dispatch(0x0077b950) -> [0x82a468]", GF(0x82a468),
         (float)((((double)GF(0x82a4e8)-(double)GF(0x786ff0))-(double)GF(0x786ff4))-(double)GF(0x7844c0)));
    CHKI("dispatch resolve count", (uint32_t)(g_stat_indirect_ok-ok0), 2u);
    uint64_t miss0=g_stat_indirect_miss;
    reset(); PUSH32(0xDEADC0DEu); dispatch_indirect(&cpu, 0x00123456u);  /* invalid */
    CHKI("invalid address -> miss counter", (uint32_t)(g_stat_indirect_miss-miss0), 1u);

    printf("\n--- 3. Dispatch table integrity (5000 random functions) ---\n");
    extern const uint32_t g_fn_addr[];
    int bad=0;
    for(uint32_t i=0;i<g_fn_count;i+=(g_fn_count/5000?g_fn_count/5000:1)){
        /* every registered address must resolve to its own index */
        uint32_t a=g_fn_addr[i];
        uint64_t o1=g_stat_indirect_ok;
        reset(); PUSH32(0xDEADC0DEu);
        /* to test only resolvability without calling: we cannot check the table
           indirectly; at least verify that the address is in range */
        if(!(a>=0x00401000u && a<0x00401000u+0x00381af1u)) bad++;
        (void)o1;
    }
    CHKI("all function addresses inside .text", (uint32_t)bad, 0u);

    printf("\n--- 4. Separate tests (x87 + integer, through the full build) ---\n");
    int32_t iv[]={0,1,-1,12345,-987654,2147483647};
    for(unsigned k=0;k<sizeof iv/sizeof*iv;k++){
        reset(); uint32_t OBJ=0x00E00000u,INNER=0x00E01000u,OUT=0x00E02000u;
        MR32(OBJ+0xc)=INNER; MR32(INNER+0xc)=(uint32_t)iv[k];
        PUSH32(OUT); PUSH32(0xDEADC0DEu); cpu.ecx=OBJ; sub_006e1c00(&cpu);
        char nm[64]; snprintf(nm,sizeof nm,"fild(%d)",iv[k]);
        CHKF(nm, GF(OUT), (float)iv[k]);
    }
    reset(); { double d=INFINITY; uint64_t b; memcpy(&b,&d,8);
      PUSH32((uint32_t)(b>>32)); PUSH32((uint32_t)b); PUSH32(0xDEADC0DEu); sub_0075dc4b(&cpu);
      CHKI("_finite(inf)", cpu.eax, 0u); }
    reset(); { double d=1.0; uint64_t b; memcpy(&b,&d,8);
      PUSH32((uint32_t)(b>>32)); PUSH32((uint32_t)b); PUSH32(0xDEADC0DEu); sub_0075dc4b(&cpu);
      CHKI("_finite(1.0)", cpu.eax, 1u); }

    heap_tests();
    clock_tests();
    ftol_tests();
    cull_tests();
    mmul_tests();
    hull_tests();
    sh_tests();
    shrot_tests();

    printf("\n---------------------------------------------\n  PASSED: %d    FAILED: %d\n",pass,fail);
    dispatch_report();
    return fail?1:0;
}
