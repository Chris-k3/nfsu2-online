/* roam_hubwire.c -- the C side of web/test/roam-hub.test.mjs: what
 * runtime/roam_core.c sends the server's free-roam hub, and what it makes of
 * the hub's answer.
 *   roam_hubwire hello|snap|bye   one datagram, as roam_core encodes it, in hex
 *   roam_hubwire peers <hex>      a PEERS datagram decoded: "ok <n> a.b.c.d:port:id ..." or "err <code>" */
#include "roam_core.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv){
    if (argc < 2) return 2;
    rc_msg m; memset(&m, 0, sizeof m);
    m.h.sender = 0x1234ABCDu; m.h.seq = 7;
    uint8_t b[RC_MAX_DGRAM]; int n;
    if (!strcmp(argv[1], "peers")){
        const char *h = argc > 2 ? argv[2] : "";
        n = 0;
        for (; h[0] && h[1] && n < RC_MAX_DGRAM; h += 2){ unsigned v; sscanf(h, "%2x", &v); b[n++] = (uint8_t)v; }
        int e = rc_decode(b, n, &m);
        if (e != RC_OK || m.h.type != RC_MSG_PEERS){ printf("err %d\n", e); return 0; }
        printf("ok %u", m.u.peers.n);
        for (int i = 0; i < m.u.peers.n; i++){
            uint32_t ip = m.u.peers.e[i].ip;
            printf(" %u.%u.%u.%u:%u:%u", ip >> 24, (ip >> 16) & 255u, (ip >> 8) & 255u, ip & 255u, m.u.peers.e[i].port, m.u.peers.e[i].id);
        }
        printf("\n");
        return 0;
    }
    if (!strcmp(argv[1], "hello")){
        m.h.type = RC_MSG_HELLO;
        m.u.hello.core_ver = RC_CORE_VER; m.u.hello.platform = RC_PLAT_MAC; m.u.hello.status = RC_ST_ROAM;
        m.u.hello.listen_port = 47210; m.u.hello.cfg_rev = 3; m.u.hello.room = rc_fnv1a("blue");
        strcpy(m.u.hello.name, "Ann K.");
        m.u.hello.n_seen = 2; m.u.hello.seen[0] = 0x11; m.u.hello.seen[1] = 0x22;
    } else if (!strcmp(argv[1], "snap")){
        m.h.type = RC_MSG_SNAP;
        m.u.snap.status = RC_ST_ROAM; m.u.snap.epoch = 1; m.u.snap.cfg_rev = 3; m.u.snap.n = 3;
        for (int k = 0; k < 3; k++){
            rc_state *s = &m.u.snap.s[k];
            s->t_us = 1000000u - 50000u * (uint32_t)k; s->q[3] = 1;
            s->p[0] = 1695.25f - (float)k; s->p[1] = -883.5f; s->p[2] = 24.125f; s->v[0] = 20.f;
        }
    } else if (!strcmp(argv[1], "bye")){
        m.h.type = RC_MSG_BYE; m.u.bye.reason = 0;
    } else return 2;
    n = rc_encode(&m, b, sizeof b);
    if (n <= 0) return 1;
    for (int i = 0; i < n; i++) printf("%02x", b[i]);
    printf("\n");
    return 0;
}
