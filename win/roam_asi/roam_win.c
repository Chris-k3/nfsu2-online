/* roam_win.c -- free-roam multiplayer: the Winsock platform layer under the
 * core, for NFSU2FreeRoam.asi.  It implements runtime/roam_plat.h exactly as
 * runtime/roam_bsd.c does on the Mac: one UDP socket, a network thread (or,
 * with NetThread=0 in the .ini, polling from the frame hook), the session
 * lock, the monotonic clock, the test-harness guard, the LAN discovery
 * targets.
 *
 * Test-harness guard (fail closed), as on the Mac: in test mode
 * (NFSU2_ROAM_HARNESS=1 in the environment, or TestMode=1 in the .ini) the
 * socket is bound to 127.0.0.1, every destination outside 127/8 and every
 * broadcast is refused before it reaches Winsock and logged as
 * "[roam] BLOCKED ...", and listed peers outside 127/8 are refused.
 *
 * Windows specifics: an ICMP "port unreachable" makes the next recvfrom of a
 * UDP socket fail with WSAECONNRESET (switched off with SIO_UDP_CONNRESET,
 * and ignored anyway); the interfaces for the directed broadcasts come from
 * SIO_GET_INTERFACE_LIST; the clock is QueryPerformanceCounter.
 */
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include "roam_plat.h"

void roam_log(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
const char *roam_opt(const char *name);
void roam_game_event(int ev, int peer, const char *text);
int snprintf(char *buf, size_t n, const char *fmt, ...);
uint32_t roam_win_mxcsr_default(void);

#ifndef SIO_UDP_CONNRESET
#define SIO_UDP_CONNRESET _WSAIOW(IOC_VENDOR, 12)
#endif

static SOCKET           g_fd = INVALID_SOCKET;
static HANDLE           g_thr;
static volatile LONG    g_stop;
static CRITICAL_SECTION g_mu;
static volatile LONG    g_mu_init;
static rc_session      *g_s;
static roam_plat_cfg    g_cfg;
static roam_plat_stats  g_st;          /* written under g_mu */
static int              g_wsa;
static int              g_threaded;
static int64_t          g_next_tick;
static LARGE_INTEGER    g_qpf;

static void mu_init(void){
    if (InterlockedCompareExchange(&g_mu_init, 1, 0) == 0){ InitializeCriticalSection(&g_mu); g_mu_init = 2; }
    while (g_mu_init != 2) Sleep(0);
}
void roam_plat_lock(void){ mu_init(); EnterCriticalSection(&g_mu); }
void roam_plat_unlock(void){ LeaveCriticalSection(&g_mu); }
int64_t roam_plat_now_us(void){
    LARGE_INTEGER c;
    if (!g_qpf.QuadPart && (!QueryPerformanceFrequency(&g_qpf) || !g_qpf.QuadPart)) g_qpf.QuadPart = 1000;
    QueryPerformanceCounter(&c);
    int64_t f = g_qpf.QuadPart, q = c.QuadPart / f, r = c.QuadPart % f;
    return q * 1000000 + r * 1000000 / f;
}
uint32_t roam_plat_random(void){
    /* test aid (tests/asi_harness.c): a fixed session id, to compare the
     * plugin's datagrams byte for byte with the Mac build's */
    const char *tid = roam_opt("NFSU2_ROAM_TEST_ID");
    if (tid && *tid){
        uint32_t v = 0;
        for (const char *p = tid[0] == '0' && (tid[1] == 'x' || tid[1] == 'X') ? tid + 2 : tid; *p; p++)
            v = v << 4 | (uint32_t)(*p >= 'a' ? *p - 'a' + 10 : *p >= 'A' ? *p - 'A' + 10 : *p - '0');
        if (v) return v;
    }
    /* a session id: unique per start, not a secret */
    LARGE_INTEGER c; QueryPerformanceCounter(&c);
    uint32_t h = 0x811C9DC5u, v[6] = { (uint32_t)c.QuadPart, (uint32_t)(c.QuadPart >> 32), GetTickCount(),
                                       GetCurrentProcessId(), GetCurrentThreadId(), (uint32_t)(uintptr_t)&c };
    static uint32_t salt;
    for (int i = 0; i < 6; i++) for (int k = 0; k < 4; k++){ h ^= (v[i] >> (8 * k)) & 255u; h *= 0x01000193u; }
    h ^= ++salt * 0x9E3779B9u;
    h ^= h >> 16; h *= 0x7FEB352Du; h ^= h >> 15; h *= 0x846CA68Bu; h ^= h >> 16;
    return h ? h : 1u;
}
const char *roam_ip_str(uint32_t ip, char *b){
    snprintf(b, 16, "%u.%u.%u.%u", ip >> 24, (ip >> 16) & 255u, (ip >> 8) & 255u, ip & 255u); return b; }
void roam_plat_get_stats(roam_plat_stats *o){ roam_plat_lock(); *o = g_st; roam_plat_unlock(); }

static int opt_on(const char *k){ const char *v = roam_opt(k); return v && *v && !(v[0] == '0' && !v[1]); }
int roam_plat_test_mode(void){
    return opt_on("NFSU2_ROAM_HARNESS") || opt_on("NFSU2_NET_HARNESS");
}

/* ---- the guard ---------------------------------------------------------------- */
static void blocked(const char *what, uint32_t ip){
    char b[16];
    g_st.blocked++;
    if (g_st.blocked <= 20 || g_st.blocked % 1000 == 0)
        roam_log("[roam] BLOCKED %s %s (test harness: loopback only; %llu refused so far)\n",
                 what, roam_ip_str(ip, b), (unsigned long long)g_st.blocked);
}
int roam_plat_guard(int test_mode, uint32_t ip, int is_bcast){
    if (!test_mode) return 1;
    if (is_bcast){ blocked("broadcast to", ip); return 0; }
    if ((ip >> 24) != 127){ blocked("sendto", ip); return 0; }
    return 1;
}

/* ---- sending (with the lock held, from either thread) ------------------------------ */
static uint16_t be16(uint16_t v){ return (uint16_t)(v >> 8 | v << 8); }
static uint32_t be32(uint32_t v){ return v >> 24 | (v >> 8 & 0xFF00u) | (v << 8 & 0xFF0000u) | v << 24; }
static void do_send(uint32_t ip, uint16_t port, const uint8_t *buf, int len, int is_bcast){
    if (!roam_plat_guard(g_cfg.test_mode, ip, is_bcast) || g_fd == INVALID_SOCKET) return;
    struct sockaddr_in sa; memset(&sa, 0, sizeof sa);
    sa.sin_family = AF_INET; sa.sin_port = be16(port); sa.sin_addr.s_addr = be32(ip);
    int n = sendto(g_fd, (const char *)buf, len, 0, (struct sockaddr *)&sa, sizeof sa);
    if (n == len){ g_st.sent++; g_st.sent_bytes += (uint64_t)len; return; }
    g_st.send_err++;
    if (g_st.send_err <= 5 || g_st.send_err % 1000 == 0){
        char b[16];
        int e = WSAGetLastError();
        roam_log("[roam] sendto %s:%u failed: Winsock error %d%s\n", roam_ip_str(ip, b), port, e,
                 e == WSAEACCES ? " (broadcast not allowed on this socket)" :
                 e == WSAENETUNREACH || e == WSAEHOSTUNREACH ? " (no route: is the PC on the same network?)" :
                 e == WSAEWOULDBLOCK ? " (send buffer full)" : "");
    }
}
static void io_send(void *u, uint32_t ip, uint16_t port, const uint8_t *buf, int len){ (void)u; do_send(ip, port, buf, len, 0); }

int roam_bcast_targets(const roam_if *ifs, int n, uint32_t *out, int max){
    int k = 0;
    if (k < max) out[k++] = 0xFFFFFFFFu;
    for (int i = 0; i < n && k < max; i++){
        const roam_if *f = &ifs[i];
        if (!f->up || f->loopback || !f->can_broadcast || !f->mask || f->mask == 0xFFFFFFFFu) continue;
        if (!rc_addr_private(f->addr)) continue;            /* only private LANs */
        uint32_t b = (f->addr & f->mask) | ~f->mask;
        int dup = 0; for (int j = 0; j < k; j++) if (out[j] == b) dup = 1;
        if (!dup) out[k++] = b;
    }
    return k;
}
static void io_broadcast(void *u, uint16_t port, const uint8_t *buf, int len){
    (void)u;
    if (g_cfg.test_mode || !g_cfg.discovery){ roam_plat_guard(1, 0xFFFFFFFFu, 1); return; }
    roam_if ifs[32]; int n = 0;
    INTERFACE_INFO il[32]; DWORD got = 0;
    if (WSAIoctl(g_fd, SIO_GET_INTERFACE_LIST, 0, 0, il, sizeof il, &got, 0, 0) == 0){
        int m = (int)(got / sizeof il[0]);
        for (int i = 0; i < m && n < 32; i++){
            if (il[i].iiAddress.Address.sa_family != AF_INET) continue;
            roam_if *f = &ifs[n++];
            memset(f, 0, sizeof *f);
            snprintf(f->name, sizeof f->name, "if%d", i);
            f->addr = be32(il[i].iiAddress.AddressIn.sin_addr.s_addr);
            f->mask = be32(il[i].iiNetmask.AddressIn.sin_addr.s_addr);
            f->up = !!(il[i].iiFlags & IFF_UP);
            f->loopback = !!(il[i].iiFlags & IFF_LOOPBACK);
            f->can_broadcast = !!(il[i].iiFlags & IFF_BROADCAST);
        }
    }
    uint32_t t[16]; int k = roam_bcast_targets(ifs, n, t, 16);
    for (int i = 0; i < k; i++) do_send(t[i], port, buf, len, 1);
}
static void io_event(void *u, int ev, int peer, const char *text){ (void)u; roam_game_event(ev, peer, text); }

/* ---- receiving and the timers (network thread, or the frame hook) ---------------------- */
static void pump(void){
    uint8_t buf[1500];
    int64_t now = roam_plat_now_us();
    for (int k = 0; k < 256; k++){
        struct sockaddr_in sa; int sl = sizeof sa;
        int n = recvfrom(g_fd, (char *)buf, sizeof buf, 0, (struct sockaddr *)&sa, &sl);
        if (n < 0){
            int e = WSAGetLastError();
            if (e == WSAECONNRESET || e == WSAEMSGSIZE) continue;  /* an ICMP for an earlier datagram; an oversized one */
            break;                                                   /* WSAEWOULDBLOCK: nothing more */
        }
        if (sa.sin_family != AF_INET) continue;
        uint32_t ip = be32(sa.sin_addr.s_addr); uint16_t port = be16(sa.sin_port);
        roam_plat_lock();
        g_st.recv++; g_st.recv_bytes += (uint64_t)n;
        if (n > RC_MAX_DGRAM){ g_s->rx++; g_s->rx_bad++; }
        else rc_receive(g_s, ip, port, buf, n, now);
        roam_plat_unlock();
    }
    if (now >= g_next_tick){ roam_plat_lock(); rc_tick(g_s, now); roam_plat_unlock(); g_next_tick = now + 10000; }
}
static DWORD WINAPI net_main(LPVOID u){
    (void)u;
    uint32_t mx = roam_win_mxcsr_default();            /* the core's floats: round to nearest, no FTZ/DAZ */
    __asm__ volatile ("ldmxcsr %0" :: "m"(mx));
    while (!g_stop){
        fd_set rs; FD_ZERO(&rs); FD_SET(g_fd, &rs);
        struct timeval tv = { 0, 5000 };
        (void)select(0, &rs, 0, 0, &tv);
        pump();
    }
    return 0;
}
/* NetThread=0: called by the frame hook instead */
void roam_win_poll(void){ if (g_fd != INVALID_SOCKET && !g_threaded && g_s) pump(); }

int roam_plat_start(const roam_plat_cfg *cfg, rc_session *s){
    g_cfg = *cfg; g_s = s;
    memset(&g_st, 0, sizeof g_st);
    mu_init();
    if (g_cfg.test_mode && g_cfg.discovery){
        roam_log("[roam] LAN discovery DISABLED: automated run (test harness), no broadcast will be sent; "
                 "only loopback peers\n");
        g_cfg.discovery = 0;
    }
    if (g_cfg.impair && *g_cfg.impair) roam_log("[roam] NFSU2_ROAM_IMPAIR is a Mac test aid: ignored here\n");
    if (!g_wsa){
        WSADATA wd;
        int e = WSAStartup(MAKEWORD(2, 2), &wd);
        if (e){ roam_log("[roam] WSAStartup failed: %d\n", e); return -1; }
        g_wsa = 1;
    }
    SOCKET fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (fd == INVALID_SOCKET){ roam_log("[roam] socket: Winsock error %d\n", WSAGetLastError()); return -1; }
    u_long nb = 1; ioctlsocket(fd, FIONBIO, &nb);
    BOOL no = FALSE; DWORD got = 0;
    WSAIoctl(fd, SIO_UDP_CONNRESET, &no, sizeof no, 0, 0, &got, 0, 0);
    BOOL excl = TRUE; setsockopt(fd, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&excl, sizeof excl);
    if (g_cfg.discovery){ BOOL one = TRUE; setsockopt(fd, SOL_SOCKET, SO_BROADCAST, (const char *)&one, sizeof one); }
    struct sockaddr_in sa; memset(&sa, 0, sizeof sa);
    sa.sin_family = AF_INET; sa.sin_port = be16(g_cfg.port);
    sa.sin_addr.s_addr = be32(g_cfg.test_mode ? 0x7F000001u : 0u);
    if (bind(fd, (struct sockaddr *)&sa, sizeof sa) != 0){
        roam_log("[roam] cannot use UDP port %u (Winsock error %d): another program has it? Set the same other "
                 "Port in NFSU2FreeRoam.ini on every machine\n", g_cfg.port, WSAGetLastError());
        closesocket(fd); return -1;
    }
    g_fd = fd;
    rc_io io = { 0, io_send, io_broadcast, io_event };
    roam_plat_lock(); s->io = io; roam_plat_unlock();
    g_stop = 0; g_next_tick = 0;
    const char *nt = roam_opt("NFSU2_ROAM_NETTHREAD");
    g_threaded = !(nt && nt[0] == '0' && !nt[1]);
    if (g_threaded){
        g_thr = CreateThread(0, 64 * 1024, net_main, 0, 0, 0);
        if (!g_thr){ roam_log("[roam] CreateThread failed (%lu): polling from the game's frames instead\n", GetLastError()); g_threaded = 0; }
    }
    roam_log("[roam] UDP %s:%u open%s%s\n", g_cfg.test_mode ? "127.0.0.1" : "0.0.0.0", g_cfg.port,
             g_cfg.test_mode ? " (test harness: loopback only)" : g_cfg.discovery ? ", LAN discovery on" : "",
             g_threaded ? "" : ", polled from the frame hook");
    return 0;
}
/* exiting: whether the network thread may still hold the lock (at process
 * exit Windows has already stopped every other thread) */
void roam_plat_stop(uint8_t reason){
    if (g_fd == INVALID_SOCKET) return;
    mu_init();
    if (TryEnterCriticalSection(&g_mu)){ rc_shutdown(g_s, reason); LeaveCriticalSection(&g_mu); }
    g_stop = 1;
    if (g_thr){ WaitForSingleObject(g_thr, 200); CloseHandle(g_thr); g_thr = 0; }
    closesocket(g_fd); g_fd = INVALID_SOCKET;
}

/* after a fault inside the frame step: the game thread may hold the
 * session lock (any depth); let it go, or the network thread waits forever */
void roam_plat_fault_unlock(void){
    if (g_mu_init != 2) return;
    for (int i = 0; i < 64 && g_mu.OwningThread == (HANDLE)(uintptr_t)GetCurrentThreadId(); i++) LeaveCriticalSection(&g_mu);
}
/* 1 when nobody else holds the session lock (process exit: then nobody can) */
int roam_plat_quiesced(void){
    if (g_mu_init != 2) return 1;
    if (!TryEnterCriticalSection(&g_mu)) return 0;
    LeaveCriticalSection(&g_mu);
    return 1;
}

/* "a.b.c.d[:port], ..." without sscanf; IPv4 literals only (no DNS) */
static int num(const char **p, unsigned *v, unsigned max){
    const char *q = *p; unsigned x = 0; int nd = 0;
    while (*q >= '0' && *q <= '9' && nd < 6){ x = x * 10u + (unsigned)(*q - '0'); q++; nd++; }
    if (!nd || x > max) return 0;
    *v = x; *p = q; return 1;
}
int roam_plat_parse_peers(const char *list, int test_mode, uint16_t defport, uint32_t *ip, uint16_t *port, int max){
    int n = 0;
    if (!list) return 0;
    const char *p = list;
    while (*p && n < max){
        while (*p == ' ' || *p == ',' || *p == ';' || *p == '\t') p++;
        if (!*p) break;
        char tok[64]; int k = 0;
        while (*p && *p != ',' && *p != ';' && *p != ' ' && *p != '\t' && k < 63) tok[k++] = *p++;
        tok[k] = 0;
        const char *t = tok; unsigned a, b, c, d, pt = defport;
        int good = num(&t, &a, 255) && *t++ == '.' && num(&t, &b, 255) && *t++ == '.' && num(&t, &c, 255) && *t++ == '.' &&
                   num(&t, &d, 255);
        if (good && *t == ':'){ t++; good = num(&t, &pt, 65535) && pt != 0; }
        if (!good || *t){
            roam_log("[roam] peer \"%s\" ignored: write a.b.c.d or a.b.c.d:port (IPv4 numbers, no names)\n", tok);
            continue;
        }
        uint32_t v = a << 24 | b << 16 | c << 8 | d;
        if (test_mode && a != 127){ roam_log("[roam] peer %s REFUSED: test harness, only 127.x.x.x peers\n", tok); continue; }
        ip[n] = v; port[n] = (uint16_t)pt; n++;
    }
    return n;
}
