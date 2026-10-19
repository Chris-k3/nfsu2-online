/* NFSU2 native port - x86-32 CPU state and guest memory access (macOS ARM64) */
#ifndef NFSU2_CPU_H
#define NFSU2_CPU_H
#include <math.h>
#include <stdint.h>
#include <string.h>

/* Guest memory base. Guest 32-bit address -> host address in one ARM64 instruction:
 *   ldr w0, [x_base, w_addr, uxtw]        (zero extra cost)              */
#ifdef __wasm__
/* wasm: guest address == linear memory address.  The guest owns
 * [0, GUEST_END); the runtime's data, heap and stacks live above it
 * (wasm-ld --global-base=GUEST_END).  Built with
 * -fno-delete-null-pointer-checks: address 0 is valid wasm memory, so
 * g_mem + a is plain integer arithmetic and every MR* is one load/store with
 * the guest displacement in the offset immediate. */
#define g_mem ((uint8_t *)0)
#define GUEST_END 0x28000000u
#define GSZ ((uint64_t)GUEST_END)
#else
extern uint8_t *g_mem;
/* The whole 32-bit guest address space is reserved as PROT_NONE; the regions
 * in use are made RW with mem_commit. A bad guest access then becomes a
 * diagnosable signal instead of crashing the host.                       */
#define GSZ 0x100000000ull
#endif

#ifdef __wasm__
/* Guest memory is untyped: the game stores a float with fstp and reads the
 * same bytes back with mov (every by-value vector copy does), so MRF32 and
 * MR32 of one address must never be assumed apart.  Plain float/uint32_t
 * lvalues let clang's type-based alias analysis do exactly that: clang 23's
 * wasm backend (DAGCombiner with IR alias analysis) moved the i32 load of
 * "fstp [esp+8]; mov edx,[esp+8]" above the f32 store in the vector
 * normalize at 0x4870B0, so the vectors it returned had a stale z and the
 * car-light and street-lamp glows were drawn far above the scene.
 * may_alias gives the guest accesses the
 * character type's alias set: they may alias one another whatever their
 * type.  The Mac build keeps the plain types (same C, same latent hazard;
 * Apple clang's arm64 code for 0x4870B0 keeps the order). */
typedef uint16_t __attribute__((may_alias)) gm_u16;
typedef uint32_t __attribute__((may_alias)) gm_u32;
typedef uint64_t __attribute__((may_alias)) gm_u64;
typedef float    __attribute__((may_alias)) gm_f32;
typedef double   __attribute__((may_alias)) gm_f64;
#endif

#if defined(__wasm__) && defined(NFSU2_MEMCHECK)
/* debug build (web/build.sh MEMCHECK=shard_0025,...): every guest access is
 * checked against the guest span and reported with the lifted function */
uint8_t *guest_memchk(uint32_t a, unsigned n, const char *fn);
#define MR8(a)   (*(uint8_t *)guest_memchk((uint32_t)(a), 1, __func__))
#define MR16(a)  (*(gm_u16  *)guest_memchk((uint32_t)(a), 2, __func__))
#define MR32(a)  (*(gm_u32  *)guest_memchk((uint32_t)(a), 4, __func__))
#define MR64(a)  (*(gm_u64  *)guest_memchk((uint32_t)(a), 8, __func__))
#define MRF32(a) (*(gm_f32  *)guest_memchk((uint32_t)(a), 4, __func__))
#define MRF64(a) (*(gm_f64  *)guest_memchk((uint32_t)(a), 8, __func__))
#elif defined(__wasm__)
#define MR8(a)   (*(uint8_t *)(g_mem + (uint32_t)(a)))
#define MR16(a)  (*(gm_u16  *)(g_mem + (uint32_t)(a)))
#define MR32(a)  (*(gm_u32  *)(g_mem + (uint32_t)(a)))
#define MR64(a)  (*(gm_u64  *)(g_mem + (uint32_t)(a)))
#define MRF32(a) (*(gm_f32  *)(g_mem + (uint32_t)(a)))
#define MRF64(a) (*(gm_f64  *)(g_mem + (uint32_t)(a)))
#else
#define MR8(a)   (*(uint8_t  *)(g_mem + (uint32_t)(a)))
#define MR16(a)  (*(uint16_t *)(g_mem + (uint32_t)(a)))
#define MR32(a)  (*(uint32_t *)(g_mem + (uint32_t)(a)))
#define MR64(a)  (*(uint64_t *)(g_mem + (uint32_t)(a)))
#define MRF32(a) (*(float    *)(g_mem + (uint32_t)(a)))
#define MRF64(a) (*(double   *)(g_mem + (uint32_t)(a)))
#endif

enum { R_EAX=0,R_ECX,R_EDX,R_EBX,R_ESP,R_EBP,R_ESI,R_EDI };

/* An indirect or out-of-range jmp at the end of a lifted function: control
 * goes to the target and never comes back here.  On wasm it has to be a real
 * tail call (return_call), otherwise every pass through a lifted loop that
 * leaves by a jump table adds frames until the ~1 MB engine stack overflows.
 * The target travels in eip so
 * dispatch_tail has the lifted functions' own signature.  The Mac keeps the
 * plain call (clang turns it into a tail call on arm64 anyway). */
struct CPU;
void dispatch_indirect(struct CPU *c, uint32_t addr);
void dispatch_tail(struct CPU *c);
#ifdef __wasm__
#define DISPATCH_TAIL(c_, t_) { (c_)->eip = (uint32_t)(t_); __attribute__((musttail)) return dispatch_tail(c_); }
#else
#define DISPATCH_TAIL(c_, t_) { dispatch_indirect((c_), (uint32_t)(t_)); return; }
#endif

typedef struct CPU {
    union {
        uint32_t r[8];
        struct { uint32_t eax,ecx,edx,ebx,esp,ebp,esi,edi; };
    };
    uint32_t eip;
    uint32_t fs_base, gs_base;   /* TEB / TLS base (flat model) */
    /* flags - each kept as 0/1 (clang DCE drops the unused ones) */
    uint32_t cf,pf,af,zf,sf,of,df;
    /* x87 stack */
    double   st[8];
    int32_t  top;
    uint16_t fcw, fsw;
    /* MMX (not shared with x87, kept separately) */
    uint64_t mm[8];
    /* SSE */
    union { uint8_t b[16]; float f[4]; double d[2]; uint32_t u32[4]; uint64_t u64[2]; } xmm[8];
    /* EFLAGS system bits (preserved by pushfd/popfd): ID (21), AC (18).
     * Without them the game's "is CPUID there" test (it tries to flip the
     * ID bit, 0x5CDCF5 / 0x5C0B09) always failed, the CPU MHz was never
     * measured and the first run picked performance level 0. */
    uint32_t sysfl;
} CPU;

/* ---- flag helpers ----------------------------------------------------- */
static inline uint32_t parity8(uint32_t v){ v&=0xff; v^=v>>4; v^=v>>2; v^=v>>1; return (~v)&1; }

/* ---- flag masks --------------------------------------------------------
 * Every arithmetic instruction computed all six flags EAGERLY (ZF/SF/PF/CF/OF/AF),
 * but the following branch usually reads only one.  Measured: the generated
 * code has 110k FLAGS_ADD + 130k FLAGS_SUB + 130k FLAGS_LOG, while OF is
 * read directly in only 22 places (CC_O/CC_NO) and PF in 5.7k.
 * The generator (tools/lift.py) now solves flag LIVENESS over the control
 * flow graph and passes each call a "flags read later" mask.  The mask is a
 * compile-time constant, so the unused branches are removed entirely.     */
#define F_CF  0x01u
#define F_PF  0x02u
#define F_AF  0x04u
#define F_ZF  0x08u
#define F_SF  0x10u
#define F_OF  0x20u
#define F_ALL 0x3Fu

#define SETZSP_M(res,bits,M) do{ \
    if((M)&F_ZF) c->zf = ((uint##bits##_t)(res)==0); \
    if((M)&F_SF) c->sf = (((uint##bits##_t)(res))>>((bits)-1))&1; \
    if((M)&F_PF) c->pf = parity8((uint32_t)(res)); }while(0)
#define SETZSP(res,bits) SETZSP_M(res,bits,F_ALL)

/* ADD */
#define FLAGS_ADD_M(a,b,res,bits,M) do{ SETZSP_M(res,bits,M); \
    if((M)&F_CF) c->cf = ((uint##bits##_t)(res) < (uint##bits##_t)(a)); \
    if((M)&F_AF) c->af = ((((a)^(b)^(res))>>4)&1); \
    if((M)&F_OF) c->of = ((~((a)^(b)) & ((a)^(res)))>>((bits)-1))&1; }while(0)
#define FLAGS_ADD(a,b,res,bits) FLAGS_ADD_M(a,b,res,bits,F_ALL)
/* SUB / CMP */
#define FLAGS_SUB_M(a,b,res,bits,M) do{ SETZSP_M(res,bits,M); \
    if((M)&F_CF) c->cf = ((uint##bits##_t)(a) < (uint##bits##_t)(b)); \
    if((M)&F_AF) c->af = ((((a)^(b)^(res))>>4)&1); \
    if((M)&F_OF) c->of = ((((a)^(b)) & ((a)^(res)))>>((bits)-1))&1; }while(0)
#define FLAGS_SUB(a,b,res,bits) FLAGS_SUB_M(a,b,res,bits,F_ALL)
/* ADC/SBB: with carry-in 1 the result can EQUAL the input; the (res<a)
 * test then missed the carry (example: sbb eax,eax  CF=1 -> CF=1).       */
#define FLAGS_ADC_M(a,b,cin,res,bits,M) do{ SETZSP_M(res,bits,M); \
    if((M)&F_CF) c->cf = (cin) ? ((uint##bits##_t)(res) <= (uint##bits##_t)(a)) \
                               : ((uint##bits##_t)(res) <  (uint##bits##_t)(a)); \
    if((M)&F_AF) c->af = ((((a)^(b)^(res))>>4)&1); \
    if((M)&F_OF) c->of = ((~((a)^(b)) & ((a)^(res)))>>((bits)-1))&1; }while(0)
#define FLAGS_ADC(a,b,cin,res,bits) FLAGS_ADC_M(a,b,cin,res,bits,F_ALL)
#define FLAGS_SBB_M(a,b,cin,res,bits,M) do{ SETZSP_M(res,bits,M); \
    if((M)&F_CF) c->cf = (cin) ? ((uint##bits##_t)(a) <= (uint##bits##_t)(b)) \
                               : ((uint##bits##_t)(a) <  (uint##bits##_t)(b)); \
    if((M)&F_AF) c->af = ((((a)^(b)^(res))>>4)&1); \
    if((M)&F_OF) c->of = ((((a)^(b)) & ((a)^(res)))>>((bits)-1))&1; }while(0)
#define FLAGS_SBB(a,b,cin,res,bits) FLAGS_SBB_M(a,b,cin,res,bits,F_ALL)
/* logical: CF=OF=0 */
#define FLAGS_LOG_M(res,bits,M) do{ SETZSP_M(res,bits,M); \
    if((M)&F_CF) c->cf=0; if((M)&F_OF) c->of=0; if((M)&F_AF) c->af=0; }while(0)
#define FLAGS_LOG(res,bits) FLAGS_LOG_M(res,bits,F_ALL)

/* ---- stack ------------------------------------------------------------ */
/* CRITICAL: the operand may depend on esp (example: push [esp+8], push esp).
 * x86 semantics: PUSH reads the value first, then decrements esp.        */
#define PUSH32(v) do{ uint32_t _pv = (uint32_t)(v); c->esp -= 4; MR32(c->esp) = _pv; }while(0)
/* POP: esp is incremented first; the destination address uses the NEW esp (pop [esp+N]). */
#define POP32(d)  do{ uint32_t _qv = MR32(c->esp); c->esp += 4; (d) = _qv; }while(0)

/* ---- conditions ------------------------------------------------------- */
#define CC_O   (c->of)
#define CC_NO  (!c->of)
#define CC_B   (c->cf)
#define CC_AE  (!c->cf)
#define CC_E   (c->zf)
#define CC_NE  (!c->zf)
#define CC_BE  (c->cf||c->zf)
#define CC_A   (!c->cf&&!c->zf)
#define CC_S   (c->sf)
#define CC_NS  (!c->sf)
#define CC_P   (c->pf)
#define CC_NP  (!c->pf)
#define CC_L   (c->sf!=c->of)
#define CC_GE  (c->sf==c->of)
#define CC_LE  (c->zf||(c->sf!=c->of))
#define CC_G   (!c->zf&&(c->sf==c->of))


/* ---- x87 FPU stack ----------------------------------------------------
 * NOTE: ARM64 has no 80-bit extended float; we use double (64-bit).
 * This can deviate slightly from x86's 80-bit intermediate precision.    */
#define ST(n)    (c->st[(c->top + (n)) & 7])
/* CAUTION: the source value must be computed BEFORE top changes.  ST(i) is
 * defined relative to top, so "fld st(0)" in the old FPUSH read the newly
 * opened empty slot -> it loaded garbage instead of copying itself.  That
 * broke the CRT's __ftol routine (it starts with fld st(0)), i.e. EVERY
 * float->int conversion in the game.  Symptom: the frame-delta measurement
 * always came out as 1 unit. */
#define FPUSH(v) do{ double _fpv = (double)(v); \
    c->top = (c->top - 1) & 7; c->st[c->top] = _fpv; }while(0)
#define FPOP()   do{ c->top = (c->top + 1) & 7; }while(0)

/* x87 compare -> status word C0/C2/C3 bits (8/10/14) */
#define FSW_C0 (1u<<8)
#define FSW_C1 (1u<<9)
#define FSW_C2 (1u<<10)
#define FSW_C3 (1u<<14)
/* fnstsw: on real hardware the TOP field (bits 11-13) is read as well. */
static inline uint16_t fsw_get(const struct CPU *c){
    return (uint16_t)((c->fsw & (uint16_t)~0x3800u) | (uint16_t)((c->top & 7u) << 11));
}
/* X87OPT: with in-block x87 register allocation c->top is written at the end
 * of the region; fnstsw takes the (static) top at that point explicitly. */
static inline uint16_t fsw_get_top(const struct CPU *c, uint32_t top){
    return (uint16_t)((c->fsw & (uint16_t)~0x3800u) | (uint16_t)((top & 7u) << 11));
}
static inline void fcompare(struct CPU *c, double a, double b){
    c->fsw &= (uint16_t)~(FSW_C0|FSW_C2|FSW_C3);
    if (a != a || b != b)      c->fsw |= FSW_C0|FSW_C2|FSW_C3;  /* unordered (NaN) */
    else if (a > b)            ;                                 /* all 0 */
    else if (a < b)            c->fsw |= FSW_C0;
    else                       c->fsw |= FSW_C3;
}
/* fcomi / fucomi: write EFLAGS directly */
#define FCOMI(a,b) do{ double _x=(a),_y=(b); \
    if(_x!=_x||_y!=_y){ c->zf=1;c->pf=1;c->cf=1; } \
    else { c->pf=0; c->zf=(_x==_y); c->cf=(_x<_y); } c->of=c->sf=c->af=0; }while(0)

/* ---- EFLAGS pack/unpack (pushfd/popfd/sahf) --------------------------- */
static inline uint32_t eflags_get(const struct CPU *c){
    return 0x00000202u | (c->cf&1u) | ((c->pf&1u)<<2) | ((c->af&1u)<<4)
         | ((c->zf&1u)<<6) | ((c->sf&1u)<<7) | ((c->df&1u)<<10) | ((c->of&1u)<<11)
         | (c->sysfl & 0x00240000u);
}
static inline void eflags_set(struct CPU *c, uint32_t f){
    c->cf=f&1u; c->pf=(f>>2)&1u; c->af=(f>>4)&1u;
    c->zf=(f>>6)&1u; c->sf=(f>>7)&1u; c->df=(f>>10)&1u; c->of=(f>>11)&1u;
    c->sysfl = f & 0x00240000u;
}

/* ---- string instructions ---------------------------------------------- */
#define DFSTEP(n) (c->df ? -(int32_t)(n) : (int32_t)(n))

/* ---- watchpoint: watch a guest memory address ------------------------ */
extern uint32_t g_watch_addr, g_watch_val, g_watch_prev_ip;
void watch_report_change(uint32_t culprit_ip, uint32_t oldv, uint32_t newv);

/* Instruction-level execution trace: the last 64K guest instruction addresses.
 * On a crash/error it answers "how did we get here" exactly.              */
#define ITRACE_BITS 16
#define ITRACE_SIZE (1u << ITRACE_BITS)
#define ITRACE_MASK (ITRACE_SIZE - 1u)
extern uint32_t g_itrace[ITRACE_SIZE];
extern uint64_t g_itrace_n;

static inline void watch_check(uint32_t ip){
    g_itrace[(uint32_t)g_itrace_n & ITRACE_MASK] = ip;
    g_itrace_n++;
    if (__builtin_expect(g_watch_addr != 0u, 0)){
        uint32_t v = *(uint32_t*)(g_mem + g_watch_addr);
        if (__builtin_expect(v != g_watch_val, 0)){
            watch_report_change(g_watch_prev_ip, g_watch_val, v);
            g_watch_val = v;
        }
    }
    g_watch_prev_ip = ip;
}
void itrace_dump(int n);

/* ---- function coverage measurement (if generated with COVERAGE=1) -----
 * Goal: answer "which code NEVER runs?".  Shows the subsystem that does
 * not run directly instead of chasing symptoms.                        */
extern uint32_t *g_cov;   /* CALL COUNT per function */
extern uint32_t g_last_fn;          /* for the sampler: the last function entered */
extern int      g_prof_on;          /* 1 if SAMPLE / COVERAGE is on */
/* CAUTION: g_last_fn used to be written UNCONDITIONALLY here.  That is a
 * global store on EVERY guest function entry (millions per second).  Write
 * it only while measuring. */
static inline void cov_hit(uint32_t va){
    if (__builtin_expect(g_prof_on, 0)){
        g_last_fn = va;
        if (g_cov && va >= 0x00401000u && va < 0x00401000u + (3676913u))
            g_cov[va - 0x00401000u]++;
    }
}
void cov_report(const char *path);

/* x87 rounding: the result follows the control word's RC field (bits 10-11).
 * 00=nearest (even), 01=down, 10=up, 11=toward zero (chop).
 * The CRT's __ftol routine sets RC to 11 and calls fistp; if we ignore that,
 * every float->int conversion comes out one too high when the fraction >= 0.5. */
static inline double x87_round(uint16_t fcw, double v){
    switch ((fcw >> 10) & 3u){
    case 0:  return nearbyint(v);      /* host mode: nearest, even */
    case 1:  return floor(v);
    case 2:  return ceil(v);
    default: return trunc(v);
    }
}

/* ---- x87 precision control (lift-time X87PC=1, tools/lift.py) ---------
 * The hardware rounds the result of FADD/FSUB/FMUL/FDIV/FSQRT (and their
 * P/R/I forms) to the significand width the control word's PC field
 * (bits 8-9) selects: 00 = 24 bits, 10 = 53, 11 = 64.  The game's main
 * thread runs at PC=00 on Windows (Direct3D's CreateDevice without
 * D3DCREATE_FPU_PRESERVE sets it), so its intermediates are single
 * precision with the extended exponent range.  Our registers are doubles:
 * PC=53/64 stay double, PC=24 rounds the double result to 24 bits in the
 * rounding direction of the RC field.  The double is the correctly rounded
 * (to nearest) exact result, so with RC = nearest this is exact whenever
 * both operands have at most 24 significant bits (Figueroa: 53 >= 2*24+2);
 * with a wider operand (fild of a big int, a double constant) a 24-bit tie
 * can very rarely round differently.  With RC = down/up/chop it is NOT
 * exact: when the nearest double is itself a 24-bit value (e.g. an add or
 * subtract of operands more than ~29 binary orders apart) the directed
 * rounding is lost, 1 ulp off (checked against Unicorn's x87).  The game
 * does no x87 arithmetic at such RC on its PC=24 thread (its fldcw sites
 * are float->int loops and CRT/D3DX code at PC=64), so this is accepted.
 * Exponent range: extended vs double, irrelevant here.                   */
/* Out of line and cold: the fast path below inlines only the FCVT pair, which
 * keeps an X87PC=1 build ~20 MB smaller. */
static __attribute__((noinline, cold, unused)) double x87_round24(double v, uint32_t rc){
    uint64_t b; memcpy(&b, &v, 8);
    uint64_t low = b & 0x1FFFFFFFull;            /* the 29 bits below 24 */
    if (!low || ((b >> 52) & 0x7FFu) == 0x7FFu) return v;   /* exact, inf, nan */
    uint64_t t = b - low;                        /* toward zero */
    int up;
    if (rc == 0) up = low > 0x10000000ull || (low == 0x10000000ull && (t & 0x20000000ull));
    else if (rc == 3) up = 0;
    else up = (int)(b >> 63) == (rc == 1);       /* down: negatives grow; up: positives */
    if (up) t += 0x20000000ull;
    memcpy(&v, &t, 8); return v;
}
/* PC=24 with RC=nearest (the game thread's word): the hardware double->float
 * conversion rounds to nearest even exactly like x87_round24 as long as the
 * result is a normal float, and is ~40% cheaper on the dependency chain.
 * Zero, float subnormals, overflow and NaN take the exact path. */
static inline double x87_pcround(uint16_t fcw, double v){
    if (__builtin_expect((fcw & 0x0F00u) == 0u, 1)){
        float f = (float)v, a = __builtin_fabsf(f);
        if (__builtin_expect(a > 0x1p-126f && a <= 0x1.fffffep127f, 1)) return (double)f;
#ifdef __wasm__
        /* Zero is exact too.  The game's matrix products make many zero
         * terms, and on wasm their call to the out-of-line path cost ~1.4 %
         * of a race frame. */
        if (v == 0.0) return v;
#endif
        return x87_round24(v, 0);
    }
    if (fcw & 0x0300u) return v;                 /* PC=53/64: double */
    return x87_round24(v, (fcw >> 10) & 3u);
}
#define X87R(v) x87_pcround(c->fcw, (v))

/* ---- invalid-operation results and out-of-range conversions ----------
 * On x86 invalid operations such as 0/0, sqrt(-x) produce "real indefinite":
 * a quiet NaN with a NEGATIVE sign.  C's sqrt/0.0 result is a positive NaN,
 * so it has to be fixed up separately.  If one of the inputs is a NaN, that
 * one propagates.                                                       */
#define X87_INDEF (-__builtin_nan(""))
/* Two NaN operands: the x87 returns the one with the LARGER significand
 * (Intel SDM vol. 1, table 4-7); the ARM FPU (and the old code here) returns
 * the first.  Found by the drift oracle (runtime/oracle.c): the rigid-
 * body integrator 0x5AA480 adds NaN garbage of unused state slots.
 * The NaN path is out of line and cold: inlined at every x87 operation it
 * made the lifted code ~8 MB (17 %) larger, X87PC=0 builds included. */
static __attribute__((noinline, cold, unused)) double x87_r2_nan(double a, double b){
    if (a != a && b != b){
        uint64_t x, y; memcpy(&x, &a, 8); memcpy(&y, &b, 8);
        return (y & 0x000FFFFFFFFFFFFFull) > (x & 0x000FFFFFFFFFFFFFull) ? b : a;
    }
    if (a != a) return a;
    if (b != b) return b;
    return X87_INDEF;
}
static inline double x87_r2(double a, double b, double r){
    if (__builtin_expect(r == r, 1)) return r;
    return x87_r2_nan(a, b);
}
static inline double x87_r1(double a, double r){
    if (r == r) return r;
    if (a != a) return a;
    return X87_INDEF;
}
static inline float sse_r2f(float a, float b, float r){
    if (r == r) return r;
    if (a != a) return a;
    if (b != b) return b;
    return (float)X87_INDEF;
}
static inline float sse_r1f(float a, float r){
    if (r == r) return r;
    if (a != a) return a;
    return (float)X87_INDEF;
}
static inline double sse_r2d(double a, double b, double r){ return x87_r2(a,b,r); }
static inline double sse_r1d(double a, double r){ return x87_r1(a,r); }

/* Out of range / NaN -> "integer indefinite" (the most negative value). */
static inline uint32_t x86_cvt_i32(double v){
    if (!(v >= -2147483648.0 && v <= 2147483647.0)) return 0x80000000u;
    return (uint32_t)(int32_t)v;
}
static inline uint16_t x86_cvt_i16(double v){
    if (!(v >= -32768.0 && v <= 32767.0)) return 0x8000u;
    return (uint16_t)(int16_t)v;
}
static inline uint64_t x86_cvt_i64(double v){
    if (!(v >= -9223372036854775808.0 && v < 9223372036854775808.0))
        return 0x8000000000000000ull;
    return (uint64_t)(int64_t)v;
}

/* ---- 80-bit extended floating point (x87 tbyte) <-> double ----------- */
static inline void f80_store(uint8_t *p, double v){
    /* sign, 15-bit exponent, 64-bit explicit mantissa */
    uint64_t bits; memcpy(&bits, &v, 8);
    uint32_t sign = (uint32_t)(bits >> 63);
    int32_t  exp  = (int32_t)((bits >> 52) & 0x7FF);
    uint64_t man  = bits & 0xFFFFFFFFFFFFFull;
    uint16_t e80; uint64_t m80;
    if (exp == 0x7FF){ e80 = 0x7FFF; m80 = man ? (0xC000000000000000ull | (man << 11)) : 0x8000000000000000ull; }
    else if (exp == 0){
        if (!man){ e80 = 0; m80 = 0; }
        else { int sh = 0; while (!(man & 0x10000000000000ull)) { man <<= 1; sh++; }
               e80 = (uint16_t)(16383 - 1022 - sh); m80 = (man << 11) | 0x8000000000000000ull; }
    } else { e80 = (uint16_t)(exp - 1023 + 16383); m80 = 0x8000000000000000ull | (man << 11); }
    memcpy(p, &m80, 8);
    uint16_t se = (uint16_t)((sign << 15) | e80);
    memcpy(p + 8, &se, 2);
}
static inline double f80_load(const uint8_t *p){
    uint64_t m80; uint16_t se;
    memcpy(&m80, p, 8); memcpy(&se, p + 8, 2);
    uint32_t sign = (uint32_t)(se >> 15);
    int32_t  e80  = (int32_t)(se & 0x7FFF);
    if (e80 == 0 && m80 == 0) return sign ? -0.0 : 0.0;
    if (e80 == 0x7FFF){
        double inf = sign ? -1.0/0.0 : 1.0/0.0;
        return (m80 << 1) ? (0.0/0.0) : inf;
    }
    int32_t exp = e80 - 16383 + 1023;
    uint64_t man = (m80 & 0x7FFFFFFFFFFFFFFFull) >> 11;
    if (exp <= 0)   return sign ? -0.0 : 0.0;
    if (exp >= 0x7FF){ double inf = sign ? -1.0/0.0 : 1.0/0.0; return inf; }
    uint64_t bits = ((uint64_t)sign << 63) | ((uint64_t)(uint32_t)exp << 52) | man;
    double d; memcpy(&d, &bits, 8); return d;
}
#define WCHK(ip) watch_check(ip)
void guest_hook(CPU *c, uint32_t ip);

void mem_init(void);
void mem_commit(uint32_t addr, uint32_t size);
int  mem_load_pe(const char *path);
void mem_fault_handler_install(void);
void mem_altstack_install(void);
extern uint8_t g_cbits[1u<<15];   /* bitmap of the committed 16 KB pages */
static inline int mem_is_committed(uint32_t addr){
    uint32_t pg = (addr) >> 14;
    return (g_cbits[pg>>3] >> (pg&7)) & 1;
}

#endif
