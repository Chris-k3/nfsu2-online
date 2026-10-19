/* asi_vm.h -- run 32-bit Windows x86 code (the free-roam plugin
 * NFSU2FreeRoam.asi, and the game's own functions it calls) under Unicorn,
 * on a guest address space that is a host buffer (the port's 4 GB arena, or
 * a snapshot of it).  Used by tests/asi_harness.c (offline, two copies of a
 * snapshot) and runtime/roam_asipeer.c (a "virtual Windows friend" inside a
 * running port instance).  Test tooling: never part of the plugin.
 *
 * - A minimal PE loader: sections at any base, base relocations, imports
 *   bound to stub addresses; the host implements each import (stdcall).
 * - xvm_call: run from an address until the code returns to a sentinel
 *   return address planted on the stack, with every register in and out.
 * - Guest pages are mapped into Unicorn on first touch (16 KB blocks of the
 *   host buffer, zero copy); "foreign" code (the exe's .text, when the host
 *   bridges calls into it) is mapped without execute rights, and each
 *   transfer into it goes to the host's callback instead.
 */
#ifndef ASI_VM_H
#define ASI_VM_H
#include <stdint.h>
#include <unicorn/unicorn.h>

typedef struct xvm xvm;
typedef struct {
    void     *user;
    uint8_t  *mem;                                  /* host address of guest address 0 */
    int     (*committed)(void *user, uint32_t a);   /* guest address a is backed (RW) */
    uint32_t  fs_base;                              /* the TEB */
    uint16_t  fcw;                                  /* x87 control word at the start */
    /* a call of import idx (stdcall): read the arguments at esp + 4..., set
     * *eax; return the number of argument dwords the callee pops, or -1 for
     * "not implemented" (the run stops) */
    int     (*import)(void *user, xvm *vm, int idx, const char *dll, const char *name, uint32_t esp, uint32_t *eax);
    /* a transfer into [foreign_lo, foreign_hi): return 1 when the host ran
     * it (it has set the registers, eip = where to go on), 0 to stop */
    int     (*foreign)(void *user, xvm *vm, uint32_t target);
    uint32_t  foreign_lo, foreign_hi;
    /* a fault the code did not handle (an unmapped or protected access):
     * return 1 when the host has set the registers to go on (exception
     * dispatch), 0 to stop the run */
    int     (*fault)(void *user, xvm *vm, uint32_t eip, uint32_t addr, int write);
} xvm_cfg;

enum { XR_EAX, XR_ECX, XR_EDX, XR_EBX, XR_ESP, XR_EBP, XR_ESI, XR_EDI, XR_EIP, XR_EFL, XR__N };

xvm      *xvm_new(const xvm_cfg *cfg);
void      xvm_free(xvm *vm);
uc_engine *xvm_uc(xvm *vm);
void      xvm_get(xvm *vm, uint32_t *r);           /* XR__N registers */
void      xvm_set(xvm *vm, const uint32_t *r);
/* run fn with the registers r (in: r[XR_ESP] points at a return address
 * slot, which is replaced by the sentinel while running); out: the
 * registers after the return (esp above the popped return address).
 * Returns 1 on a normal return, 0 on a stop (xvm_why tells). */
int       xvm_call(xvm *vm, uint32_t fn, uint32_t *r);
const char *xvm_why(xvm *vm);
/* an emulated stub: when execution reaches addr, fn runs instead (it reads
 * the arguments, sets eax, and returns the stack bytes to pop besides the
 * return address) */
typedef int (*xvm_stub_fn)(void *user, xvm *vm, uint32_t addr, uint32_t *r);
int       xvm_stub(xvm *vm, uint32_t addr, xvm_stub_fn fn);
/* the guest memory as the emulator sees it (same bytes as cfg.mem) */
int       xvm_read(xvm *vm, uint32_t a, void *dst, uint32_t n);
int       xvm_write(xvm *vm, uint32_t a, const void *src, uint32_t n);
uint32_t  xvm_rd32(xvm *vm, uint32_t a);
/* trace: every transfer from [from_lo, from_hi) into [to_lo, to_hi) */
typedef void (*xvm_trace_fn)(void *user, xvm *vm, uint32_t from, uint32_t to);
void      xvm_trace(xvm *vm, uint32_t from_lo, uint32_t from_hi, uint32_t to_lo, uint32_t to_hi, xvm_trace_fn fn);
uint64_t  xvm_insns(xvm *vm);                      /* instructions run (when counting is on) */
void      xvm_count(xvm *vm, int on);

/* ---- PE ---------------------------------------------------------------------- */
typedef struct {
    uint32_t base, size, entry;                    /* where it is loaded */
    uint32_t pref_base;                            /* the image base in the file */
    int      nimp;
    struct { char dll[32], name[48]; uint32_t iat; } imp[128];
    int      nexp;
    struct { char name[48]; uint32_t va; } exp[16];
    int      nsym;                                 /* from the linker map, if given */
    struct { char name[48]; uint32_t va; } *sym;
    int      nreloc;
} xpe;
/* map the PE file into guest memory at base (commit(user, a, n) must back
 * [a, a+n) first), relocate it, bind its imports to stub addresses; mapfile
 * (GNU ld -Map) may be 0.  0 on success. */
int       xpe_load(xpe *pe, xvm *vm, const char *path, const char *mapfile, uint32_t base,
                   void (*commit)(void *user, uint32_t a, uint32_t n));
uint32_t  xpe_export(const xpe *pe, const char *name);
uint32_t  xpe_sym(const xpe *pe, const char *name);  /* linker map symbol (relocated) */
void      xvm_bind_pe(xvm *vm, const xpe *pe);       /* the imports of this PE go to cfg.import */
/* nargs of the stdcall imports the plugin uses (-1: unknown) */
int       xvm_import_nargs(const char *name);
#endif
