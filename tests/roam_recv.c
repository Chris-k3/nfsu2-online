/* roam_recv.c -- a viewer peer for tests (loopback only, test mode): it joins
 * a game instance, renders the game's car with the core's interpolation at
 * 120 Hz on the host clock (what a viewer whose own world runs in real time
 * does) and prints, every second, how the shown car behaved: interpolated /
 * extrapolated / held frames, re-syncs (the sender's clock epoch changed),
 * corrections over 5 m, the distance shown against speed x time, and the
 * largest step.  From the free-roam adversarial review:
 * a sender whose world runs slower than real time.
 *
 *   out/roam_recv <own port> <game's port> <seconds>     (inside tests/net/loopback-only.sb)
 */
#include "roam_core.h"
#include "roam_plat.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <math.h>

void roam_game_event(int ev, int peer, const char *text){ fprintf(stderr, "[recv] event %d peer %d: %s\n", ev, peer, text); }
static rc_session g_s;
int main(int argc, char **argv){
    int port = atoi(argv[1]), peer = atoi(argv[2]); double secs = atof(argv[3]);
    rc_config cf; memset(&cf, 0, sizeof cf);
    cf.self_id = roam_plat_random(); cf.port = (uint16_t)port; snprintf(cf.name, sizeof cf.name, "Viewer");
    cf.platform = RC_PLAT_TOOL; cf.test_mode = 1; cf.max_players = 8; cf.rate_hz = 20;
    rc_io io = { 0, 0, 0, 0 };
    rc_session_init(&g_s, &cf, &io);
    roam_plat_cfg pc = { (uint16_t)port, 1, 0, 0 };
    if (roam_plat_start(&pc, &g_s) != 0) return 1;
    uint8_t rec[64]; rc_carcfg cc; memset(&cc, 0, sizeof cc); cc.type_hash = 1; memcpy(cc.type_name, "PEUGOT", 6); cc.ride_b[3] = 1;
    int rn = rc_carcfg_encode(&cc, rec, sizeof rec);
    roam_plat_lock(); rc_add_peer(&g_s, 0x7F000001u, (uint16_t)peer, 1, roam_plat_now_us()); rc_set_cfg(&g_s, rec, rn, roam_plat_now_us()); roam_plat_unlock();
    int64_t t0 = roam_plat_now_us(), last_rep = t0, prev = t0;
    uint64_t pi = 0, pe = 0, ph = 0, pep = 0, psn = 0; float lastp[3] = {0}; int have_last = 0;
    double dist_shown = 0, dist_snap_speed = 0; double maxstep = 0;
    for (;;){
        int64_t now = roam_plat_now_us();
        if (now - t0 > (int64_t)(secs * 1e6)) break;
        rc_state st; memset(&st, 0, sizeof st); st.t_us = (uint32_t)now; st.q[3] = 1; st.p[0] = 2000; st.p[1] = -900; st.p[2] = 24;   /* far away, standing */
        roam_plat_lock();
        rc_set_status(&g_s, RC_ST_ROAM); rc_push_state(&g_s, &st, now);
        for (int i = 0; i < RC_TABLE; i++){
            rc_peer *p = &g_s.peer[i];
            if (p->state != RC_PS_EST || !p->mo.n || p->status != RC_ST_ROAM) continue;
            rc_pose P;
            if (rc_interp_eval(&p->mo, now, now - prev, 100000, 250000, &P)){
                if (have_last){
                    double d = sqrt((P.p[0]-lastp[0])*(P.p[0]-lastp[0]) + (P.p[1]-lastp[1])*(P.p[1]-lastp[1]));
                    dist_shown += d; if (d > maxstep) maxstep = d;
                    dist_snap_speed += fabs(P.speed) * (now - prev) / 1e6;
                }
                memcpy(lastp, P.p, sizeof lastp); have_last = 1;
            }
            if (now - last_rep >= 1000000){
                rc_interp *m = &p->mo;
                printf("t=%5.1f s  interp %3llu extrap %3llu hold %3llu  re-syncs +%llu  snaps>5m +%llu  shown %.1f m vs speed x time %.1f m  largest step %.2f m\n",
                       (now - t0) / 1e6, (unsigned long long)(m->n_interp - pi), (unsigned long long)(m->n_extrap - pe), (unsigned long long)(m->n_hold - ph),
                       (unsigned long long)(m->n_epoch - pep), (unsigned long long)(m->n_snap - psn), dist_shown, dist_snap_speed, maxstep);
                fflush(stdout);
                pi = m->n_interp; pe = m->n_extrap; ph = m->n_hold; pep = m->n_epoch; psn = m->n_snap;
                dist_shown = dist_snap_speed = maxstep = 0; last_rep = now;
            }
        }
        roam_plat_unlock();
        prev = now;
        usleep(8333);
    }
    roam_plat_stop(0);
    return 0;
}
