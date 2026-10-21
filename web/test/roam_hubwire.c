/* roam_hubwire.c -- the C side of the hub's tests (web/server-rs/crates/roam/tests/roam_hub.rs, roam_ahead.rs): what
 * runtime/roam_core.c sends the server's free-roam hub, and what it makes of
 * the hub's answer.
 *   roam_hubwire hello|snap|bye   one datagram, as roam_core encodes it, in hex
 *   roam_hubwire peers <hex>      a PEERS datagram decoded: "ok <n> a.b.c.d:port:id ..." or "err <code>"
 *   roam_hubwire map <hex>...     a session that hears the hub (10.77.0.253:47210) asks for the world map
 *                                 ("ask <hex>": its MAPREQ) and takes these datagrams from the hub; then
 *                                 "map <gen> <total> <n> x,y,h ..." (what it holds) */
#include "roam_core.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void unhex(const char *h, uint8_t *b, int *n){
    *n = 0;
    for (; h[0] && h[1] && *n < RC_MAX_DGRAM; h += 2){ unsigned v; sscanf(h, "%2x", &v); b[(*n)++] = (uint8_t)v; }
}
static void sent(void *user, uint32_t ip, uint16_t port, const uint8_t *buf, int len){
    (void)user;
    if (ip != 0x0A4D00FDu || port != 47210 || len < 6 || buf[5] != RC_MSG_MAPREQ) return;
    printf("ask ");
    for (int i = 0; i < len; i++) printf("%02x", buf[i]);
    printf("\n");
}
static rc_session S;

int main(int argc, char **argv){
    if (argc < 2) return 2;
    rc_msg m; memset(&m, 0, sizeof m);
    m.h.sender = 0x1234ABCDu; m.h.seq = 7;
    uint8_t b[RC_MAX_DGRAM]; int n;
    if (!strcmp(argv[1], "map")){
        rc_config c; memset(&c, 0, sizeof c);
        c.self_id = 0x1234ABCDu; c.port = 47210; c.max_players = RC_MAX_PLAYERS; c.rate_hz = 20;
        c.hub_ip = 0x0A4D00FDu; c.hub_port = 47210;
        rc_io io; memset(&io, 0, sizeof io); io.send = sent;
        rc_session_init(&S, &c, &io);
        int64_t t = 1000000;
        rc_tick(&S, t);
        m.h.type = RC_MSG_PEERS; m.h.sender = 0xB0Bu;                 /* the hub answers: an empty list */
        n = rc_encode(&m, b, sizeof b);
        rc_receive(&S, 0x0A4D00FDu, 47210, b, n, t += 1000);
        if (!rc_ask_map(&S, t += 1000)){ printf("not asked\n"); return 0; }
        for (int i = 2; i < argc; i++){ unhex(argv[i], b, &n); rc_receive(&S, 0x0A4D00FDu, 47210, b, n, t += 1000); }
        printf("map %u %u %d", S.map_gen, S.map_total, S.map_n);
        for (int i = 0; i < S.map_n; i++) printf(" %d,%d,%u", S.map_e[i].x, S.map_e[i].y, S.map_e[i].heading);
        printf("\n");
        return 0;
    }
    if (!strcmp(argv[1], "peers")){
        unhex(argc > 2 ? argv[2] : "", b, &n);
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
