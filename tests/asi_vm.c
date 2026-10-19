/* asi_vm.c -- see asi_vm.h.  The Unicorn set-up (flat GDT, a data segment
 * for fs, a sentinel return address on an unmapped page, guest pages mapped
 * on demand straight from the host buffer) follows feat/drift's
 * runtime/oracle.c. */
#include "asi_vm.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PG        0x4000u               /* mapping granule: the port's commit block */
#define GDT_VA    0xFFFF0000u
#define SENTINEL  0xFFFE0000u
#define STUB_BASE 0xFFC00000u           /* import i: STUB_BASE + 16 i */
#define MAXSTUB   64
enum { ST_NONE, ST_RET, ST_IMPORT, ST_FOREIGN, ST_FAULT };

struct xvm {
    xvm_cfg   cfg;
    uc_engine *uc;
    uint8_t   mapped[1u << 15];         /* 16 KB blocks mapped into Unicorn */
    uint8_t   gdt[0x1000];
    int       stop; uint32_t stop_addr; int stop_write;
    char      why[160];
    const xpe *pe;                       /* imports */
    struct { uint32_t addr; xvm_stub_fn fn; } stub[MAXSTUB]; int nstub;
    struct { uint32_t flo, fhi, tlo, thi; xvm_trace_fn fn; } tr; uint32_t prev_block;
    int       counting; uint64_t insns;
};

uc_engine *xvm_uc(xvm *vm){ return vm->uc; }
const char *xvm_why(xvm *vm){ return vm->why; }
static const int RID[XR__N] = { UC_X86_REG_EAX, UC_X86_REG_ECX, UC_X86_REG_EDX, UC_X86_REG_EBX, UC_X86_REG_ESP,
                                UC_X86_REG_EBP, UC_X86_REG_ESI, UC_X86_REG_EDI, UC_X86_REG_EIP, UC_X86_REG_EFLAGS };
void xvm_get(xvm *vm, uint32_t *r){ for (int i = 0; i < XR__N; i++) uc_reg_read(vm->uc, RID[i], &r[i]); }
void xvm_set(xvm *vm, const uint32_t *r){ for (int i = 0; i < XR__N; i++) uc_reg_write(vm->uc, RID[i], &r[i]); }

static int in_foreign(xvm *vm, uint32_t a){ return a >= vm->cfg.foreign_lo && a < vm->cfg.foreign_hi; }
static int map_block(xvm *vm, uint32_t a){
    uint32_t b = a >> 14;
    if (vm->mapped[b >> 3] & (1u << (b & 7))) return 1;
    if (!vm->cfg.committed(vm->cfg.user, a)) return 0;
    uint32_t lo = b << 14;
    int prot = UC_PROT_ALL;
    /* foreign code: no execute right, so every transfer into it stops */
    if (vm->cfg.foreign && lo + PG > vm->cfg.foreign_lo && lo < vm->cfg.foreign_hi) prot = UC_PROT_READ | UC_PROT_WRITE;
    if (uc_mem_map_ptr(vm->uc, lo, PG, (uint32_t)prot, vm->cfg.mem + lo)) return 0;
    vm->mapped[b >> 3] |= (uint8_t)(1u << (b & 7));
    return 1;
}
static bool on_unmapped(uc_engine *uc, uc_mem_type type, uint64_t addr, int size, int64_t value, void *ud){
    (void)uc; (void)size; (void)value;
    xvm *vm = ud; uint32_t a = (uint32_t)addr;
    if (type == UC_MEM_FETCH_UNMAPPED && a == SENTINEL){ vm->stop = ST_RET; return false; }
    if (type == UC_MEM_FETCH_UNMAPPED && vm->pe && a >= STUB_BASE && a < STUB_BASE + 16u * (uint32_t)vm->pe->nimp){
        vm->stop = ST_IMPORT; vm->stop_addr = a; return false; }
    if (map_block(vm, a)) return true;
    vm->stop = ST_FAULT; vm->stop_addr = a; vm->stop_write = type == UC_MEM_WRITE_UNMAPPED ? 1 : type == UC_MEM_FETCH_UNMAPPED ? 8 : 0;
    return false;
}
static bool on_prot(uc_engine *uc, uc_mem_type type, uint64_t addr, int size, int64_t value, void *ud){
    (void)uc; (void)size; (void)value;
    xvm *vm = ud; uint32_t a = (uint32_t)addr;
    if (type == UC_MEM_FETCH_PROT && in_foreign(vm, a)){ vm->stop = ST_FOREIGN; vm->stop_addr = a; return false; }
    vm->stop = ST_FAULT; vm->stop_addr = a; vm->stop_write = type == UC_MEM_WRITE_PROT ? 1 : type == UC_MEM_FETCH_PROT ? 8 : 0;
    return false;
}
static void on_stub(uc_engine *uc, uint64_t addr, uint32_t size, void *ud){
    (void)uc; (void)size;
    xvm *vm = ud;
    for (int i = 0; i < vm->nstub; i++){
        if (vm->stub[i].addr != (uint32_t)addr) continue;
        uint32_t r[XR__N]; xvm_get(vm, r);
        uint32_t ret = xvm_rd32(vm, r[XR_ESP]);
        int pop = vm->stub[i].fn(vm->cfg.user, vm, (uint32_t)addr, r);
        r[XR_ESP] += 4u + (uint32_t)pop; r[XR_EIP] = ret;
        xvm_set(vm, r);
        return;
    }
}
static void on_block(uc_engine *uc, uint64_t addr, uint32_t size, void *ud){
    (void)uc; (void)size;
    xvm *vm = ud; uint32_t a = (uint32_t)addr;
    if (vm->tr.fn && vm->prev_block >= vm->tr.flo && vm->prev_block < vm->tr.fhi && a >= vm->tr.tlo && a < vm->tr.thi)
        vm->tr.fn(vm->cfg.user, vm, vm->prev_block, a);
    vm->prev_block = a;
}
static void on_insn(uc_engine *uc, uint64_t addr, uint32_t size, void *ud){ (void)uc; (void)addr; (void)size; ((xvm *)ud)->insns++; }
void xvm_count(xvm *vm, int on){
    if (on && !vm->counting){ uc_hook h; uc_hook_add(vm->uc, &h, UC_HOOK_CODE, (void *)on_insn, vm, 1, 0); }
    vm->counting = on;
}
uint64_t xvm_insns(xvm *vm){ return vm->insns; }

static void gdt_entry(xvm *vm, int i, uint32_t base, uint32_t limit, int code, int dpl){
    uint8_t *d = vm->gdt + 8 * i;
    limit >>= 12;
    d[0] = limit & 0xFF; d[1] = (limit >> 8) & 0xFF;
    d[2] = base & 0xFF; d[3] = (base >> 8) & 0xFF; d[4] = (base >> 16) & 0xFF;
    d[5] = (uint8_t)(0x80 | (dpl << 5) | 0x10 | (code ? 0x0A : 0x02));
    d[6] = (uint8_t)(0xC0 | ((limit >> 16) & 0x0F));
    d[7] = (base >> 24) & 0xFF;
}
xvm *xvm_new(const xvm_cfg *cfg){
    xvm *vm = calloc(1, sizeof *vm);
    vm->cfg = *cfg;
    if (uc_open(UC_ARCH_X86, UC_MODE_32, &vm->uc)){ free(vm); return 0; }
    uc_hook h;
    uc_hook_add(vm->uc, &h, UC_HOOK_MEM_UNMAPPED, (void *)on_unmapped, vm, 1, 0);
    uc_hook_add(vm->uc, &h, UC_HOOK_MEM_PROT, (void *)on_prot, vm, 1, 0);
    uc_mem_map_ptr(vm->uc, GDT_VA, 0x1000, UC_PROT_READ | UC_PROT_WRITE, vm->gdt);
    gdt_entry(vm, 1, 0, 0xFFFFF000u, 1, 3);
    gdt_entry(vm, 2, 0, 0xFFFFF000u, 0, 3);
    gdt_entry(vm, 3, 0, 0xFFFFF000u, 0, 0);
    gdt_entry(vm, 4, cfg->fs_base, 0xFFFFF000u, 0, 3);
    gdt_entry(vm, 5, 0, 0xFFFFF000u, 1, 0);
    uc_x86_mmr gdtr = { 0, GDT_VA, 8 * 6 - 1, 0 };
    uc_reg_write(vm->uc, UC_X86_REG_GDTR, &gdtr);
    uint32_t sel = (3 << 3) | 0; uc_reg_write(vm->uc, UC_X86_REG_SS, &sel);
    sel = (2 << 3) | 3; uc_reg_write(vm->uc, UC_X86_REG_DS, &sel); uc_reg_write(vm->uc, UC_X86_REG_ES, &sel);
    uc_reg_write(vm->uc, UC_X86_REG_GS, &sel);
    sel = (4 << 3) | 3; uc_reg_write(vm->uc, UC_X86_REG_FS, &sel);
    uint32_t cr0 = 0x00000033u, cr4 = 0x00000600u;   /* PE MP ET NE; OSFXSR OSXMMEXCPT: SSE on */
    uc_reg_write(vm->uc, UC_X86_REG_CR0, &cr0); uc_reg_write(vm->uc, UC_X86_REG_CR4, &cr4);
    uint32_t mx = 0x1F80; uc_reg_write(vm->uc, UC_X86_REG_MXCSR, &mx);
    uint16_t cw = cfg->fcw; uc_reg_write(vm->uc, UC_X86_REG_FPCW, &cw);
    uc_hook_add(vm->uc, &h, UC_HOOK_BLOCK, (void *)on_block, vm, 1, 0);
    return vm;
}
void xvm_free(xvm *vm){ if (vm){ uc_close(vm->uc); free(vm); } }
int xvm_stub(xvm *vm, uint32_t addr, xvm_stub_fn fn){
    if (vm->nstub == MAXSTUB) return -1;
    vm->stub[vm->nstub].addr = addr; vm->stub[vm->nstub].fn = fn; vm->nstub++;
    uc_hook h; uc_hook_add(vm->uc, &h, UC_HOOK_CODE, (void *)on_stub, vm, addr, addr);
    return 0;
}
void xvm_trace(xvm *vm, uint32_t flo, uint32_t fhi, uint32_t tlo, uint32_t thi, xvm_trace_fn fn){
    vm->tr.flo = flo; vm->tr.fhi = fhi; vm->tr.tlo = tlo; vm->tr.thi = thi; vm->tr.fn = fn;
}
int xvm_read(xvm *vm, uint32_t a, void *dst, uint32_t n){
    for (uint32_t i = 0; i < n; i += PG - ((a + i) & (PG - 1)))
        if (!vm->cfg.committed(vm->cfg.user, a + i)) return -1;
    if (n && !vm->cfg.committed(vm->cfg.user, a + n - 1)) return -1;
    memcpy(dst, vm->cfg.mem + a, n); return 0;
}
int xvm_write(xvm *vm, uint32_t a, const void *src, uint32_t n){
    for (uint32_t i = 0; i < n; i += PG - ((a + i) & (PG - 1)))
        if (!vm->cfg.committed(vm->cfg.user, a + i)) return -1;
    if (n && !vm->cfg.committed(vm->cfg.user, a + n - 1)) return -1;
    memcpy(vm->cfg.mem + a, src, n); return 0;
}
uint32_t xvm_rd32(xvm *vm, uint32_t a){ uint32_t v = 0; xvm_read(vm, a, &v, 4); return v; }

int xvm_call(xvm *vm, uint32_t fn, uint32_t *r){
    uint32_t esp0 = r[XR_ESP], saved = xvm_rd32(vm, esp0), sent = SENTINEL;
    if (xvm_write(vm, esp0, &sent, 4)){ snprintf(vm->why, sizeof vm->why, "stack 0x%08x not mapped", esp0); return 0; }
    r[XR_EIP] = fn;
    xvm_set(vm, r);
    uint32_t eip = fn;
    int ok = 0;
    vm->why[0] = 0;
    for (int guard = 0; guard < 4000000; guard++){
        vm->stop = ST_NONE;
        uc_err err = uc_emu_start(vm->uc, eip, 0, 0, 0);
        xvm_get(vm, r);
        if (vm->stop == ST_RET){ ok = 1; break; }
        if (vm->stop == ST_IMPORT){
            int idx = (int)((vm->stop_addr - STUB_BASE) / 16u);
            uint32_t ret = xvm_rd32(vm, r[XR_ESP]), eax = r[XR_EAX];
            int pop = vm->cfg.import ? vm->cfg.import(vm->cfg.user, vm, idx, vm->pe->imp[idx].dll, vm->pe->imp[idx].name, r[XR_ESP], &eax) : -1;
            if (pop < 0){ snprintf(vm->why, sizeof vm->why, "import %s!%s not implemented", vm->pe->imp[idx].dll, vm->pe->imp[idx].name); break; }
            xvm_get(vm, r);                                 /* the handler may have run code */
            r[XR_EAX] = eax; r[XR_ESP] += 4u + 4u * (uint32_t)pop; r[XR_EIP] = ret;
            xvm_set(vm, r); eip = ret;
            continue;
        }
        if (vm->stop == ST_FOREIGN){
            uint32_t tgt = vm->stop_addr;
            if (vm->cfg.foreign && vm->cfg.foreign(vm->cfg.user, vm, tgt)){ xvm_get(vm, r); eip = r[XR_EIP]; continue; }
            snprintf(vm->why, sizeof vm->why, "call into 0x%08x not bridged", tgt); break;
        }
        if (vm->stop == ST_FAULT){
            uint32_t a = vm->stop_addr;
            if (vm->cfg.fault && vm->cfg.fault(vm->cfg.user, vm, r[XR_EIP], a, vm->stop_write)){ xvm_get(vm, r); eip = r[XR_EIP]; continue; }
            snprintf(vm->why, sizeof vm->why, "fault: %s 0x%08x at eip 0x%08x", vm->stop_write == 1 ? "write" : vm->stop_write == 8 ? "fetch" : "read", a, r[XR_EIP]);
            break;
        }
        snprintf(vm->why, sizeof vm->why, "stopped: %s at eip 0x%08x", err ? uc_strerror(err) : "no reason", r[XR_EIP]);
        break;
    }
    xvm_write(vm, esp0, &saved, 4);
    if (ok && r[XR_ESP] <= esp0){ snprintf(vm->why, sizeof vm->why, "returned with esp 0x%08x not above 0x%08x", r[XR_ESP], esp0); ok = 0; }
    return ok;
}

/* ---- PE -------------------------------------------------------------------------------- */
static uint32_t g32(const uint8_t *p){ return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static uint16_t g16(const uint8_t *p){ return (uint16_t)(p[0] | p[1] << 8); }
int xpe_load(xpe *pe, xvm *vm, const char *path, const char *mapfile, uint32_t base,
             void (*commit)(void *user, uint32_t a, uint32_t n)){
    memset(pe, 0, sizeof *pe);
    FILE *f = fopen(path, "rb");
    if (!f){ fprintf(stderr, "asi_vm: cannot read %s\n", path); return -1; }
    fseek(f, 0, SEEK_END); long fl = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *d = malloc((size_t)fl);
    if (fread(d, 1, (size_t)fl, f) != (size_t)fl){ fclose(f); free(d); return -1; }
    fclose(f);
    if (fl < 0x200 || d[0] != 'M' || d[1] != 'Z'){ free(d); return -1; }
    const uint8_t *nt = d + g32(d + 0x3C);
    if (g32(nt) != 0x4550u || g16(nt + 4) != 0x14C){ fprintf(stderr, "asi_vm: %s is not a PE32 i386 image\n", path); free(d); return -1; }
    int nsec = g16(nt + 6), opt = g16(nt + 20);
    const uint8_t *oh = nt + 24, *sh = oh + opt;
    pe->pref_base = g32(oh + 28); pe->size = g32(oh + 56); pe->base = base; pe->entry = base + g32(oh + 16);
    uint32_t hdrs = g32(oh + 60);
    commit(vm->cfg.user, base, pe->size);
    uint8_t *img = vm->cfg.mem + base;
    memset(img, 0, pe->size);
    memcpy(img, d, hdrs < (uint32_t)fl ? hdrs : (uint32_t)fl);
    for (int i = 0; i < nsec; i++){
        const uint8_t *s = sh + 40 * i;
        uint32_t va = g32(s + 12), raw = g32(s + 16), ptr = g32(s + 20);
        if (raw && ptr + raw <= (uint32_t)fl && va + raw <= pe->size) memcpy(img + va, d + ptr, raw);
    }
    free(d);
    const uint8_t *dd = oh + 96;
    /* base relocations */
    uint32_t delta = base - pe->pref_base, rva = g32(dd + 5 * 8), rsz = g32(dd + 5 * 8 + 4);
    for (uint32_t o = 0; rva && o + 8 <= rsz; ){
        uint32_t page = g32(img + rva + o), bs = g32(img + rva + o + 4);
        if (bs < 8) break;
        for (uint32_t k = 8; k + 2 <= bs; k += 2){
            uint16_t e = g16(img + rva + o + k);
            if ((e >> 12) == 3){ uint8_t *p = img + page + (e & 0xFFFu); uint32_t v = g32(p) + delta; memcpy(p, &v, 4); pe->nreloc++; }
            else if ((e >> 12) != 0){ fprintf(stderr, "asi_vm: relocation type %u not handled\n", e >> 12); return -1; }
        }
        o += bs;
    }
    /* imports: every name thunk -> a stub address */
    uint32_t irva = g32(dd + 1 * 8);
    for (uint32_t di = irva; irva; di += 20){
        uint32_t oft = g32(img + di), name = g32(img + di + 12), ft = g32(img + di + 16);
        if (!name && !ft) break;
        uint32_t th = oft ? oft : ft;
        for (uint32_t k = 0; ; k += 4){
            uint32_t v = g32(img + th + k);
            if (!v) break;
            if (v & 0x80000000u){ fprintf(stderr, "asi_vm: import by ordinal not handled\n"); return -1; }
            if (pe->nimp == 128) return -1;
            int i = pe->nimp++;
            snprintf(pe->imp[i].dll, sizeof pe->imp[i].dll, "%s", (const char *)img + name);
            snprintf(pe->imp[i].name, sizeof pe->imp[i].name, "%s", (const char *)img + v + 2);
            pe->imp[i].iat = base + ft + k;
            uint32_t stub = STUB_BASE + 16u * (uint32_t)i; memcpy(img + ft + k, &stub, 4);
        }
    }
    /* exports */
    uint32_t erva = g32(dd);
    if (erva){
        uint32_t nn = g32(img + erva + 24), af = g32(img + erva + 28), an = g32(img + erva + 32), ao = g32(img + erva + 36);
        for (uint32_t k = 0; k < nn && pe->nexp < 16; k++){
            snprintf(pe->exp[pe->nexp].name, sizeof pe->exp[0].name, "%s", (const char *)img + g32(img + an + 4 * k));
            pe->exp[pe->nexp].va = base + g32(img + af + 4u * g16(img + ao + 2 * k)); pe->nexp++;
        }
    }
    /* linker map: "  0x10001000   name" */
    if (mapfile){
        FILE *m = fopen(mapfile, "r");
        if (m){
            char line[512]; int cap = 0;
            while (fgets(line, sizeof line, m)){
                unsigned long a; char nm[256];
                if (sscanf(line, " 0x%lx %255s", &a, nm) != 2 || strchr(nm, '(') || strchr(nm, '=') || a < pe->pref_base || a >= pe->pref_base + pe->size) continue;
                if (pe->nsym == cap){ cap = cap ? cap * 2 : 512; pe->sym = realloc(pe->sym, sizeof *pe->sym * (size_t)cap); }
                snprintf(pe->sym[pe->nsym].name, sizeof pe->sym[0].name, "%s", nm);
                pe->sym[pe->nsym].va = (uint32_t)a - pe->pref_base + base; pe->nsym++;
            }
            fclose(m);
        }
    }
    return 0;
}
uint32_t xpe_export(const xpe *pe, const char *name){ for (int i = 0; i < pe->nexp; i++) if (!strcmp(pe->exp[i].name, name)) return pe->exp[i].va; return 0; }
uint32_t xpe_sym(const xpe *pe, const char *name){
    for (int i = 0; i < pe->nsym; i++) if (!strcmp(pe->sym[i].name, name) || (pe->sym[i].name[0] == '_' && !strcmp(pe->sym[i].name + 1, name))) return pe->sym[i].va;
    return 0;
}
void xvm_bind_pe(xvm *vm, const xpe *pe){ vm->pe = pe; }

int xvm_import_nargs(const char *n){
    static const struct { const char *n; int a; } T[] = {
        { "AddVectoredExceptionHandler", 2 }, { "CloseHandle", 1 }, { "CreateFileA", 7 }, { "CreateThread", 6 },
        { "DeleteCriticalSection", 1 }, { "DisableThreadLibraryCalls", 1 }, { "EnterCriticalSection", 1 },
        { "FlushInstructionCache", 3 }, { "GetCurrentProcess", 0 }, { "GetCurrentProcessId", 0 }, { "GetCurrentThreadId", 0 },
        { "GetEnvironmentVariableA", 3 }, { "GetLastError", 0 }, { "GetLocalTime", 1 }, { "GetModuleFileNameA", 3 },
        { "GetModuleHandleA", 1 }, { "GetPrivateProfileStringA", 6 }, { "GetTickCount", 0 }, { "InitializeCriticalSection", 1 },
        { "LeaveCriticalSection", 1 }, { "QueryPerformanceCounter", 1 }, { "QueryPerformanceFrequency", 1 }, { "Sleep", 1 },
        { "TryEnterCriticalSection", 1 }, { "VirtualProtect", 4 }, { "VirtualQuery", 3 }, { "WaitForSingleObject", 2 },
        { "WriteFile", 5 }, { "lstrcmpA", 2 }, { "lstrcmpiA", 2 }, { "lstrcpyA", 2 }, { "lstrlenA", 1 },
        { "WSACleanup", 0 }, { "WSAGetLastError", 0 }, { "WSAIoctl", 9 }, { "WSAStartup", 2 }, { "bind", 3 },
        { "closesocket", 1 }, { "ioctlsocket", 3 }, { "recvfrom", 6 }, { "select", 5 }, { "sendto", 6 }, { "setsockopt", 5 },
        { "socket", 3 },
    };
    for (unsigned i = 0; i < sizeof T / sizeof T[0]; i++) if (!strcmp(T[i].n, n)) return T[i].a;
    return -1;
}
