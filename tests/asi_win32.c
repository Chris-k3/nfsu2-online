/* asi_win32.c -- see asi_win32.h. */
#include "asi_win32.h"
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <ctype.h>

#define A(i) xvm_rd32(vm, esp + 4u + 4u * (i))
static void wr32(xvm *vm, uint32_t a, uint32_t v){ xvm_write(vm, a, &v, 4); }
static int gstr(xvm *vm, uint32_t a, char *o, int cap){
    int i = 0;
    for (; i < cap - 1; i++){ uint8_t c = 0; if (xvm_read(vm, a + (uint32_t)i, &c, 1) || !c) break; o[i] = (char)c; }
    o[i] = 0; return i;
}
static uint32_t pstr(xvm *vm, uint32_t a, uint32_t cap, const char *s){
    uint32_t n = (uint32_t)strlen(s);
    if (!cap) return 0;
    if (n > cap - 1) n = cap - 1;
    xvm_write(vm, a, s, n); uint8_t z = 0; xvm_write(vm, a + n, &z, 1);
    return n;
}
/* GetPrivateProfileStringA: [section] key = value, case-insensitive, the
 * value trimmed of blanks (comments after a value are NOT removed, as on
 * Windows: the plugin strips them itself) */
static int ini_get(const char *path, const char *sec, const char *key, char *out, int cap){
    FILE *f = fopen(path, "r");
    if (!f) return 0;
    char line[600]; int in = 0, found = 0;
    while (fgets(line, sizeof line, f)){
        char *p = line; while (*p == ' ' || *p == '\t') p++;
        size_t n = strlen(p); while (n && (p[n - 1] == '\n' || p[n - 1] == '\r' || p[n - 1] == ' ' || p[n - 1] == '\t')) p[--n] = 0;
        if (*p == ';' || !*p) continue;
        if (*p == '['){ char *e = strchr(p, ']'); if (e){ *e = 0; in = !strcasecmp(p + 1, sec); } continue; }
        if (!in) continue;
        char *eq = strchr(p, '='); if (!eq) continue;
        char *k = p, *ke = eq; while (ke > k && (ke[-1] == ' ' || ke[-1] == '\t')) ke--;
        if ((size_t)(ke - k) != strlen(key) || strncasecmp(k, key, (size_t)(ke - k))) continue;
        char *v = eq + 1; while (*v == ' ' || *v == '\t') v++;
        size_t vn = strlen(v);
        if (vn >= 2 && ((v[0] == '"' && v[vn - 1] == '"') || (v[0] == '\'' && v[vn - 1] == '\''))){ v[vn - 1] = 0; v++; }
        snprintf(out, (size_t)cap, "%s", v); found = 1; break;
    }
    fclose(f);
    return found;
}
static void sa_get(xvm *vm, uint32_t a, uint32_t *ip, uint16_t *port){
    uint8_t s[8] = {0}; xvm_read(vm, a, s, 8);
    *port = (uint16_t)(s[2] << 8 | s[3]); *ip = (uint32_t)s[4] << 24 | (uint32_t)s[5] << 16 | (uint32_t)s[6] << 8 | s[7];
}
static void sa_put(xvm *vm, uint32_t a, uint32_t ip, uint16_t port){
    uint8_t s[16] = { 2, 0, (uint8_t)(port >> 8), (uint8_t)port, (uint8_t)(ip >> 24), (uint8_t)(ip >> 16), (uint8_t)(ip >> 8), (uint8_t)ip };
    xvm_write(vm, a, s, 16);
}

int aw32_import(aw32 *w, xvm *vm, const char *dll, const char *n, uint32_t esp, uint32_t *eax){
    (void)dll;
    w->calls++;
    int na = xvm_import_nargs(n);
    if (na < 0) return -1;
    uint32_t r = 0;
    if (!strcmp(n, "GetModuleHandleA")) r = A(0) ? 0u : 0x00400000u;
    else if (!strcmp(n, "GetModuleFileNameA")) r = pstr(vm, A(1), A(2), w->module_path);
    else if (!strcmp(n, "DisableThreadLibraryCalls") || !strcmp(n, "FlushInstructionCache") || !strcmp(n, "CloseHandle")){
        if (!strcmp(n, "CloseHandle")){ uint32_t h = A(0); if (h >= 0x1000 && h < 0x1008 && w->file[h - 0x1000]){ fclose(w->file[h - 0x1000]); w->file[h - 0x1000] = 0; } }
        r = 1;
    }
    else if (!strcmp(n, "GetCurrentProcess")) r = 0xFFFFFFFFu;
    else if (!strcmp(n, "GetCurrentProcessId")) r = 100;
    else if (!strcmp(n, "GetCurrentThreadId")) r = 1;
    else if (!strcmp(n, "GetLastError")) r = w->last_error;
    else if (!strcmp(n, "GetTickCount")) r = (uint32_t)(w->now_us(w->user) / 1000);
    else if (!strcmp(n, "QueryPerformanceCounter") || !strcmp(n, "QueryPerformanceFrequency")){
        int64_t v = !strcmp(n, "QueryPerformanceFrequency") ? 1000000 : w->now_us(w->user);
        xvm_write(vm, A(0), &v, 8); r = 1;
    }
    else if (!strcmp(n, "GetLocalTime")){
        int64_t us = w->now_us(w->user); uint64_t s = (uint64_t)us / 1000000u;
        uint16_t st[8] = { 2026, 10, 0, 18, (uint16_t)(s / 3600 % 24), (uint16_t)(s / 60 % 60), (uint16_t)(s % 60), (uint16_t)(us / 1000 % 1000) };
        xvm_write(vm, A(0), st, 16);
    }
    else if (!strcmp(n, "Sleep")) r = 0;
    else if (!strcmp(n, "WaitForSingleObject")) r = 0;
    else if (!strcmp(n, "GetEnvironmentVariableA")){
        char nm[128]; gstr(vm, A(0), nm, sizeof nm);
        const char *v = w->getenv ? w->getenv(w->user, nm) : 0;
        if (!v){ r = 0; w->last_error = 203; }                  /* ERROR_ENVVAR_NOT_FOUND */
        else if (strlen(v) + 1 > A(2)) r = (uint32_t)strlen(v) + 1;
        else r = pstr(vm, A(1), A(2), v);
    }
    else if (!strcmp(n, "GetPrivateProfileStringA")){
        char sec[64], key[64], def[256], val[600];
        gstr(vm, A(0), sec, sizeof sec); gstr(vm, A(1), key, sizeof key);
        if (A(2)) gstr(vm, A(2), def, sizeof def); else def[0] = 0;
        if (!ini_get(w->ini_path, sec, key, val, sizeof val)) snprintf(val, sizeof val, "%s", def);
        r = pstr(vm, A(3), A(4), val);
    }
    else if (!strcmp(n, "CreateFileA")){
        char p[300]; gstr(vm, A(0), p, sizeof p);
        const char *b = p; for (const char *q = p; *q; q++) if (*q == '\\' || *q == '/') b = q + 1;
        int k = 0; while (k < 8 && w->file[k]) k++;
        r = 0xFFFFFFFFu;                                         /* INVALID_HANDLE_VALUE */
        if (k < 8){
            if (p[0] == '/') snprintf(w->file_path[k], sizeof w->file_path[k], "%s", p);
            else snprintf(w->file_path[k], sizeof w->file_path[k], "%s/%s", w->file_dir, b);
            w->file[k] = fopen(w->file_path[k], "wb");
            if (w->file[k]) r = 0x1000u + (uint32_t)k;
        }
    }
    else if (!strcmp(n, "WriteFile")){
        uint32_t h = A(0), len = A(2);
        FILE *f = h >= 0x1000 && h < 0x1008 ? w->file[h - 0x1000] : 0;
        uint8_t *tmp = malloc(len ? len : 1);
        if (f && !xvm_read(vm, A(1), tmp, len)){ fwrite(tmp, 1, len, f); fflush(f); r = 1; }
        free(tmp);
        if (A(3)) wr32(vm, A(3), r ? len : 0);
    }
    else if (!strcmp(n, "InitializeCriticalSection")){ uint8_t z[24] = {0}; xvm_write(vm, A(0), z, 24); }
    else if (!strcmp(n, "EnterCriticalSection") || !strcmp(n, "TryEnterCriticalSection")){
        uint32_t cs = A(0), rec = xvm_rd32(vm, cs + 8);
        wr32(vm, cs + 12, 1); wr32(vm, cs + 8, rec + 1); r = 1;           /* one thread: always free */
    }
    else if (!strcmp(n, "LeaveCriticalSection")){
        uint32_t cs = A(0), rec = xvm_rd32(vm, cs + 8);
        if (rec) rec--;
        wr32(vm, cs + 8, rec); if (!rec) wr32(vm, cs + 12, 0);
    }
    else if (!strcmp(n, "DeleteCriticalSection")) r = 0;
    else if (!strcmp(n, "VirtualProtect")){ if (A(3)) wr32(vm, A(3), 0x40); r = 1; }
    else if (!strcmp(n, "VirtualQuery")){
        uint32_t a = A(0), mbi = A(1);
        uint32_t m[7] = {0};
        uint8_t probe;
        if (!xvm_read(vm, a, &probe, 1)){
            uint32_t lo = a & ~0x3FFFu, hi = lo + 0x4000u;
            for (int k = 0; k < 4096 && lo >= 0x4000u && !xvm_read(vm, lo - 1, &probe, 1); k++) lo -= 0x4000u;
            for (int k = 0; k < 4096 && hi && !xvm_read(vm, hi, &probe, 1); k++) hi += 0x4000u;
            m[0] = lo; m[1] = lo; m[2] = 0x04; m[3] = hi - lo; m[4] = 0x1000; m[5] = (a >= 0x400000u && a < 0x932000u) ? 0x40u : 0x04u; m[6] = 0x20000;
        } else { m[0] = a & ~0x3FFFu; m[3] = 0x4000; m[4] = 0x10000; m[5] = 0x01; }
        xvm_write(vm, mbi, m, 28); r = 28;
    }
    else if (!strcmp(n, "AddVectoredExceptionHandler")){ w->veh = A(1); r = 0xEE000001u; }
    else if (!strcmp(n, "CreateThread")){ w->threads_refused++; w->last_error = 8; r = 0; }
    else if (!strcmp(n, "lstrlenA")){ char b[1024]; r = (uint32_t)gstr(vm, A(0), b, sizeof b); }
    else if (!strcmp(n, "lstrcpyA")){ char b[1024]; gstr(vm, A(1), b, sizeof b); pstr(vm, A(0), sizeof b, b); r = A(0); }
    else if (!strcmp(n, "lstrcmpA") || !strcmp(n, "lstrcmpiA")){
        char x[512], y[512]; gstr(vm, A(0), x, sizeof x); gstr(vm, A(1), y, sizeof y);
        int c = !strcmp(n, "lstrcmpA") ? strcmp(x, y) : strcasecmp(x, y); r = (uint32_t)(c < 0 ? -1 : c > 0 ? 1 : 0);
    }
    /* ---- WS2_32 ---- */
    else if (!strcmp(n, "WSAStartup")){ uint8_t z[400] = {0}; z[0] = 2; z[1] = 2; z[2] = 2; z[3] = 2; xvm_write(vm, A(1), z, 400); r = 0; }
    else if (!strcmp(n, "WSACleanup")) r = 0;
    else if (!strcmp(n, "WSAGetLastError")) r = (uint32_t)w->wsa_err;
    else if (!strcmp(n, "socket")) r = (A(0) == 2 && A(1) == 2) ? 0x200u : 0xFFFFFFFFu;
    else if (!strcmp(n, "ioctlsocket") || !strcmp(n, "setsockopt") || !strcmp(n, "WSAIoctl") || !strcmp(n, "closesocket")) r = 0;
    else if (!strcmp(n, "select")) r = 0;
    else if (!strcmp(n, "bind")){
        uint32_t ip; uint16_t port; sa_get(vm, A(1), &ip, &port);
        if (w->sock_bind && w->sock_bind(w->user, ip, port) != 0){ w->wsa_err = 10048; r = 0xFFFFFFFFu; } else r = 0;
    }
    else if (!strcmp(n, "sendto")){
        uint32_t ip; uint16_t port; sa_get(vm, A(4), &ip, &port);
        uint32_t len = A(2); uint8_t b[1500];
        if (len > sizeof b || xvm_read(vm, A(1), b, len)){ w->wsa_err = 10040; r = 0xFFFFFFFFu; }
        else { int k = w->sock_send ? w->sock_send(w->user, ip, port, b, (int)len) : -1;
               if (k < 0){ w->wsa_err = 10065; r = 0xFFFFFFFFu; } else { r = (uint32_t)k; w->bytes_sent += len; } }
    }
    else if (!strcmp(n, "recvfrom")){
        uint8_t b[1500]; uint32_t ip = 0; uint16_t port = 0;
        int k = w->sock_recv ? w->sock_recv(w->user, b, (int)sizeof b, &ip, &port) : -1;
        if (k < 0){ w->wsa_err = 10035; r = 0xFFFFFFFFu; }        /* WSAEWOULDBLOCK */
        else {
            uint32_t cap = A(2), m = (uint32_t)k < cap ? (uint32_t)k : cap;
            xvm_write(vm, A(1), b, m);
            if (A(4)) sa_put(vm, A(4), ip, port);
            if (A(5)) wr32(vm, A(5), 16);
            r = m; w->bytes_recv += m;
        }
    }
    else return -1;
    *eax = r;
    return na;
}
void aw32_close(aw32 *w){ for (int k = 0; k < 8; k++) if (w->file[k]){ fclose(w->file[k]); w->file[k] = 0; } }
