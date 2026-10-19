/* roam_fakepeer.c -- a stand-in free-roam player for tests (loopback only).
 *
 * Speaks the real protocol through the real core and platform layer
 * (roam_core.c, roam_bsd.c), so a game instance sees it as a friend: it
 * joins, sends a car-look record and 20 snapshots a second, and leaves.  Its
 * car follows a recorded drive (the "L" rows of an NFSU2_ROAM_POSELOG file)
 * or a circle.  Always in test-harness mode: bound to 127.0.0.1, peers in
 * 127/8 only, no broadcast.
 *
 *   roam_fakepeer --port 47310 --peer 127.0.0.1:47301 --name Carol --cfg car.bin
 *                 (--track pose.csv [--start S] | --circle X,Y,Z,R,SPEED)
 *                 [--seconds T] [--cycles N --off S] [--abrupt] [--status-cycle]
 *   --stock NAME    instead of --cfg: a stock car of that type (the game's
 *                   CarTypeInfo name, e.g. PEUGOT, 350Z; hashed as the game
 *                   does, bStringHash 0x43DB50)
 *   --cycles N      join, drive T seconds, leave (BYE, or nothing with
 *                   --abrupt), wait --off seconds; N times, a new id each time
 *   --status-cycle  every 10 s alternate free roam / shop (the car must
 *                   disappear and come back)
 *   --shift DX,DY   move the whole track (to put it next to the viewer)
 *   --delay S       wait S seconds before the first join
 *   --pose X,Y,Z,YAW  stand still there (yaw in radians, 0 = +x)
 *   --brakeblink      brake pedal on and off every 2 s (brake lights test)
 *   --switch S,NAME   after S seconds change to a stock car of type NAME
 *                     (a new car-look revision: as after a car-lot visit)
 *   --looks A,B,...   with --look-every S: every S seconds the next stock car
 *                     of the list (at most 16, then from the start again), a
 *                     new look each time (the Cars pool tests)
 */
#include "roam_core.h"
#include "roam_plat.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <unistd.h>
#include <signal.h>
#include <time.h>

void roam_game_event(int ev, int peer, const char *text){
    (void)peer;
    fprintf(stderr, "[fake] %s%s\n", ev == RC_EV_JOIN ? "JOIN: " : ev == RC_EV_LEAVE ? "LEAVE: " : "", text);
}
typedef struct { double t; float p[3]; } TP;
static TP *g_tr; static int g_ntr;
static int load_track(const char *path, double start){
    FILE *f = fopen(path, "r");
    if (!f){ fprintf(stderr, "fakepeer: cannot read %s\n", path); return 0; }
    char line[512]; int cap = 0; double t0 = -1;
    while (fgets(line, sizeof line, f)){
        if (line[0] != 'L') continue;
        long long host; double sync; char id[16]; float x, y, z, sp;
        if (sscanf(line, "L,%lld,%lf,%15[^,],%f,%f,%f,%f", &host, &sync, id, &x, &y, &z, &sp) != 7) continue;
        double t = sync / 1e6;
        if (t0 < 0) t0 = t;
        if (t - t0 < start) continue;
        if (g_ntr == cap){ cap = cap ? cap * 2 : 4096; g_tr = realloc(g_tr, sizeof *g_tr * (size_t)cap); }
        if (g_ntr && t <= g_tr[g_ntr - 1].t) continue;
        g_tr[g_ntr].t = t; g_tr[g_ntr].p[0] = x; g_tr[g_ntr].p[1] = y; g_tr[g_ntr].p[2] = z; g_ntr++;
    }
    fclose(f);
    if (g_ntr < 2){ fprintf(stderr, "fakepeer: no L rows in %s\n", path); return 0; }
    double b = g_tr[0].t; for (int i = 0; i < g_ntr; i++) g_tr[i].t -= b;
    fprintf(stderr, "fakepeer: track %d frames, %.1f s\n", g_ntr, g_tr[g_ntr - 1].t);
    return 1;
}
/* position at t (looped), velocity by central difference */
static void track_at(double t, float *p, float *v){
    double span = g_tr[g_ntr - 1].t;
    t = fmod(t, span); if (t < 0) t += span;
    int lo = 0, hi = g_ntr - 1;
    while (hi - lo > 1){ int m = (lo + hi) / 2; if (g_tr[m].t <= t) lo = m; else hi = m; }
    double u = (t - g_tr[lo].t) / (g_tr[hi].t - g_tr[lo].t);
    for (int i = 0; i < 3; i++) p[i] = (float)(g_tr[lo].p[i] + u * (g_tr[hi].p[i] - g_tr[lo].p[i]));
    int a = lo > 3 ? lo - 4 : 0, b = hi + 4 < g_ntr ? hi + 4 : g_ntr - 1;
    double dt = g_tr[b].t - g_tr[a].t;
    for (int i = 0; i < 3; i++) v[i] = dt > 0 ? (float)((g_tr[b].p[i] - g_tr[a].p[i]) / dt) : 0.f;
}
static volatile sig_atomic_t g_quit;
static void on_sig(int s){ (void)s; g_quit = 1; }

int main(int argc, char **argv){
    int port = 47310, np = 0, cycles = 1, abrupt = 0, status_cycle = 0, brakeblink = 0;
    uint32_t pip[8]; uint16_t ppt[8];
    const char *name = "Fake", *cfgp = 0, *trackp = 0, *stock = 0;
    double delay = 0, seconds = 60, off = 5, start = 0, cx = 0, cy = 0, cz = 0, cr = 20, csp = 15, shx = 0, shy = 0;
    int circle = 0, pose = 0; double pz[4] = {0}, sw_at = -1; char sw_name[32] = {0};
    char looks[16][24]; int nlooks = 0, look_i = 0; double look_every = 0, look_next = 0;   /* --looks, --look-every */
    for (int i = 1; i < argc; i++){
        const char *a = argv[i], *v = i + 1 < argc ? argv[i + 1] : "";
        if (!strcmp(a, "--port")){ port = atoi(v); i++; }
        else if (!strcmp(a, "--peer")){ np += roam_plat_parse_peers(v, 1, 47210, pip + np, ppt + np, 8 - np); i++; }
        else if (!strcmp(a, "--name")){ name = v; i++; }
        else if (!strcmp(a, "--cfg")){ cfgp = v; i++; }
        else if (!strcmp(a, "--stock")){ stock = v; i++; }
        else if (!strcmp(a, "--track")){ trackp = v; i++; }
        else if (!strcmp(a, "--start")){ start = atof(v); i++; }
        else if (!strcmp(a, "--circle")){ circle = sscanf(v, "%lf,%lf,%lf,%lf,%lf", &cx, &cy, &cz, &cr, &csp) == 5; i++; }
        else if (!strcmp(a, "--shift")){ sscanf(v, "%lf,%lf", &shx, &shy); i++; }
        else if (!strcmp(a, "--seconds")){ seconds = atof(v); i++; }
        else if (!strcmp(a, "--cycles")){ cycles = atoi(v); i++; }
        else if (!strcmp(a, "--off")){ off = atof(v); i++; }
        else if (!strcmp(a, "--abrupt")) abrupt = 1;
        else if (!strcmp(a, "--brakeblink")) brakeblink = 1;
        else if (!strcmp(a, "--delay")){ delay = atof(v); i++; }
        else if (!strcmp(a, "--switch")){ char nm[32] = {0}; if (sscanf(v, "%lf,%31s", &sw_at, nm) == 2) snprintf(sw_name, sizeof sw_name, "%s", nm); i++; }
        else if (!strcmp(a, "--pose")){ pose = sscanf(v, "%lf,%lf,%lf,%lf", &pz[0], &pz[1], &pz[2], &pz[3]) == 4; i++; }
        else if (!strcmp(a, "--status-cycle")) status_cycle = 1;
        else if (!strcmp(a, "--looks")){ char tmp[400]; snprintf(tmp, sizeof tmp, "%s", v); for (char *q = strtok(tmp, ","); q && nlooks < 16; q = strtok(0, ",")) snprintf(looks[nlooks++], 24, "%s", q); i++; }
        else if (!strcmp(a, "--look-every")){ look_every = atof(v); look_next = look_every; i++; }
        else { fprintf(stderr, "fakepeer: unknown %s\n", a); return 2; }
    }
    uint8_t cfg[RC_CFG_MAX]; int cfgn = 0;
    if (cfgp){ FILE *f = fopen(cfgp, "rb"); if (f){ cfgn = (int)fread(cfg, 1, sizeof cfg, f); fclose(f); } }
    if (stock){
        rc_carcfg sc; memset(&sc, 0, sizeof sc);
        uint32_t h = 0xFFFFFFFFu; for (const char *q = stock; *q; q++) h = h * 33u + (uint8_t)*q;
        sc.type_hash = h; snprintf(sc.type_name, sizeof sc.type_name, "%s", stock); sc.ride_b[3] = 1;
        cfgn = rc_carcfg_encode(&sc, cfg, sizeof cfg);
    }
    rc_carcfg cc;
    if (cfgn <= 0 || rc_carcfg_decode(cfg, cfgn, &cc) != RC_OK){ fprintf(stderr, "fakepeer: --cfg: no valid car record\n"); return 2; }
    if (!circle && !pose && (!trackp || !load_track(trackp, start))) return 2;
    if (!np){ fprintf(stderr, "fakepeer: --peer 127.0.0.1:PORT needed\n"); return 2; }
    signal(SIGINT, on_sig); signal(SIGTERM, on_sig);
    if (delay > 0) usleep((useconds_t)(delay * 1e6));
    for (int cyc = 0; cyc < cycles && !g_quit; cyc++){
        static rc_session s;
        rc_config cf; memset(&cf, 0, sizeof cf);
        cf.self_id = roam_plat_random(); cf.port = (uint16_t)port; snprintf(cf.name, sizeof cf.name, "%s", name);
        cf.platform = RC_PLAT_TOOL; cf.test_mode = 1; cf.max_players = 8; cf.rate_hz = 20;
        rc_io io = { 0, 0, 0, 0 };
        rc_session_init(&s, &cf, &io);
        roam_plat_cfg pc = { (uint16_t)port, 1, 0, 0 };
        if (roam_plat_start(&pc, &s) != 0) return 1;
        int64_t t0 = roam_plat_now_us();
        roam_plat_lock();
        for (int i = 0; i < np; i++) rc_add_peer(&s, pip[i], ppt[i], 1, t0);
        rc_set_cfg(&s, cfg, cfgn, t0);
        roam_plat_unlock();
        fprintf(stderr, "fakepeer: cycle %d/%d, id %08x, %s's %s, %.0f s\n", cyc + 1, cycles, cf.self_id, name, cc.type_name, seconds);
        for (;;){
            int64_t now = roam_plat_now_us();
            double t = (now - t0) / 1e6;
            if (t >= seconds || g_quit) break;
            rc_state st; memset(&st, 0, sizeof st);
            st.t_us = (uint32_t)now;
            if (pose){
                st.p[0] = (float)pz[0]; st.p[1] = (float)pz[1]; st.p[2] = (float)pz[2];
                st.v[0] = (float)cos(pz[3]) * 0.001f; st.v[1] = (float)sin(pz[3]) * 0.001f;   /* the heading comes from v */
            } else if (circle){
                double a = csp / cr * t;
                st.p[0] = (float)(cx + cr * cos(a)); st.p[1] = (float)(cy + cr * sin(a)); st.p[2] = (float)cz;
                st.v[0] = (float)(-csp * sin(a)); st.v[1] = (float)(csp * cos(a)); st.w[2] = (float)(csp / cr);
            } else {
                /* a looped track jumps back to its start: a teleport, so
                 * the receivers snap instead of blending */
                static long lap = -1; long l = (long)(t / g_tr[g_ntr - 1].t);
                if (lap >= 0 && l != lap){ roam_plat_lock(); rc_bump_epoch(&s); roam_plat_unlock(); }
                lap = l;
                track_at(t, st.p, st.v); st.p[0] += (float)shx; st.p[1] += (float)shy;
            }
            double yaw = atan2(st.v[1], st.v[0]);
            st.q[2] = (float)sin(yaw / 2); st.q[3] = (float)cos(yaw / 2);
            st.speed = sqrtf(st.v[0] * st.v[0] + st.v[1] * st.v[1]); st.rpm = 2000 + 150 * st.speed; st.gear = 3; st.throttle = 0.6f;
            if (brakeblink && ((long)(t / 2.0) & 1)){ st.brake = 1.f; st.throttle = 0; st.bits |= RC_BIT_BRAKE; }
            if (sw_at >= 0 && t >= sw_at){
                rc_carcfg sc; memset(&sc, 0, sizeof sc);
                uint32_t h = 0xFFFFFFFFu; for (const char *q = sw_name; *q; q++) h = h * 33u + (uint8_t)*q;
                sc.type_hash = h; snprintf(sc.type_name, sizeof sc.type_name, "%s", sw_name); sc.ride_b[3] = 1;
                uint8_t nb[RC_CFG_MAX]; int nn = rc_carcfg_encode(&sc, nb, sizeof nb);
                roam_plat_lock(); rc_set_cfg(&s, nb, nn, now); roam_plat_unlock();
                fprintf(stderr, "fakepeer: switched to a stock %s (revision %u)\n", sw_name, s.cfg_rev);
                sw_at = -1;
            }
            if (nlooks && look_every > 0 && t >= look_next){
                look_next += look_every;
                const char *nm = looks[look_i++ % nlooks];
                rc_carcfg sc; memset(&sc, 0, sizeof sc);
                uint32_t h = 0xFFFFFFFFu; for (const char *q = nm; *q; q++) h = h * 33u + (uint8_t)*q;
                sc.type_hash = h; snprintf(sc.type_name, sizeof sc.type_name, "%s", nm); sc.ride_b[3] = 1;
                uint8_t nb[RC_CFG_MAX]; int nn = rc_carcfg_encode(&sc, nb, sizeof nb);
                roam_plat_lock(); rc_set_cfg(&s, nb, nn, now); roam_plat_unlock();
                fprintf(stderr, "fakepeer: look %s (revision %u)\n", nm, s.cfg_rev);
            }
            uint8_t status = RC_ST_ROAM;
            if (status_cycle && ((int)(t / 10.0) & 1)) status = RC_ST_SHOP;
            roam_plat_lock();
            rc_set_status(&s, status);
            if (status == RC_ST_ROAM) rc_push_state(&s, &st, now);
            roam_plat_unlock();
            usleep(8000);
        }
        if (abrupt){
            /* gone without a word, as a crashed or unplugged peer */
            fprintf(stderr, "fakepeer: cycle %d: vanishing without BYE\n", cyc + 1);
            roam_plat_lock(); for (int i = 0; i < RC_TABLE; i++) s.peer[i].state = RC_PS_FREE; roam_plat_unlock();
        }
        roam_plat_stop(0);
        if (cyc + 1 < cycles) usleep((useconds_t)(off * 1e6));
    }
    return 0;
}
