/* racenet.c -- how the other players' cars came in during a network race
 * (the game's Online and LAN races), written to the log when the race ends.
 *
 * Players report cars that "freeze and then move two frames" or "move a bit
 * left, a bit right".  Each cause wants another fix: a race link that held
 * the datagrams (TCP waits for a lost segment, then hands over everything at
 * once), a player whose game ran slowly or stalled, or the game's own way of
 * showing the cars.  So when its player finishes the race (or leaves it)
 * each game writes:
 *   - its own frames while racing: the rate, the frames over 50 ms, the
 *     longest;
 *   - each race link (the addresses the game's UDP 3658 heard from: the
 *     creator for a joiner, every joiner for the creator, the race being a
 *     star around the game's creator): datagrams, the longest wait, the
 *     waits of 250 ms or more and how many datagrams came at once ending
 *     them, against how many came at once otherwise (racenet.h, net_lan.c);
 *   - each other car: its updates (the game's car states, 0x5F8900) a
 *     second, the longest wait, the waits over 100, 250 and 500 ms, its
 *     jumps as shown here (a frame whose move differs from the frame
 *     before's by over 0.5 m and over 2 m), the "hits" of a far car passed
 *     (sub_005f8d40), its states' age by this game's race clock (mean,
 *     least, most: the way's delay), and that player's own frame rate and
 *     race clock, which every game sends the others every FS_MS.
 *
 * It also shows the cars more smoothly than the game alone: a car far from
 * the player no longer loses its predictions to a "hit" of its own physics
 * (sub_005f8d40; it stood still for a frame or two, then stepped).
 * NFSU2_RACE_SMOOTH=0 turns that off.
 *
 * The game (SPEED2.EXE v1.2 NA, static reading):
 *  - The car states (MSG_U_BI_CARSPAM) go out from a scheduler with tiers of
 *    20, 10 and 5 a second (0x583710, the table 0x7FBE68); the creator
 *    passes the joiners' on.
 *  - 0x5FD360 decodes one into a remote car's controller (its flags: 1 the
 *    position, orientation and acceleration, 2 the velocity and spin, 4 and
 *    8 more; a field not sent keeps what the controller held) and calls 0x5F8900
 *    (thiscall, ret 4: the controller, the state): the state's controls go
 *    into the car ([ctl+0x10], the world's car), and a prediction from the
 *    pool [0x89012C] ("ExtrapolatedStateSlotPool", made by the World
 *    constructor for network races only) joins the car's list, at most 10,
 *    each living the link's latency + 0.1 + 0.333 s.  Every frame 0x5F8AF0
 *    blends the live ones, the newest weighed most; with none left the car
 *    gets fixed controls until the next state.
 *
 * Frame rates go on the horn's port (racehorn.c's HORN_PORT, whose receiver
 * hands "N2FS" messages here): "N2FS", version 1, flags (2: relayed), the
 * frames a second x 10 (u16, little-endian), the longest frame in ms (u16),
 * the frames over 50 ms (u8), 0, its race clock (u32, 1/4000 s), then the
 * name the player races under (16 bytes, as racehorn.c's).  The creator
 * passes each joiner's on to the other joiners, marked relayed.  A game of
 * an older version sends none and drops these.
 *
 * The race clocks: a joiner's follows the creator's (0x5891B0, about 20
 * samples a second, each the creator's clock plus half the round trip), and
 * every car state is stamped with its sender's.  "their race clock ... off
 * ours" is the N2FS clock against this game's, the way's delay in it: tens
 * of ms when they agree.  (tools/lan_trace.py lines instances up by their
 * wall clocks, which in the browser can be a second or more apart: that
 * looked like a joiner's race clock 1.2-1.6 s behind for a whole race, while
 * this figure said -8 ms.)
 */
#include "cpu.h"
#include "racenet.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define G_FLOW       0x008654a4u   /* 6: in the world */
#define G_NETMODE    0x00850078u   /* 8 Online, 0x200 LAN (1 career) */
#define G_NET_HOST   0x00866a14u   /* host race state, > 0: this game created the race */
#define G_WORLD      0x00890080u   /* World*: +0 the cars' list (a car's first two dwords are its node) */
#define G_PLAYER1    0x008900acu   /* Player*: +4 car */
#define G_WORLDDT    0x00865154u   /* float: this frame's world dt (s) */
#define G_RACE       0x00890118u   /* the race coordinator*: +0 state, +0x24 racers, +0xBD0 racer pointers */
#define RC_RACING    4u            /*   (a network race stays at 4 behind the results, until it is left) */
#define RCR_DONE     0x10u         /* a racer: +0 its car, +0x10 u16 how it finished, 0 not yet */
#define G_NETPLAYERS 0x0089cf50u   /* the network race's players: 6 pointers, name at +0x12 */
#define NP_NAME      0x12u
#define CTL_CAR      0x10u         /* a remote car's controller: its world car */
#define CTL_PREV_V   0x140u        /*   the car's velocity as the last blend left it (3 floats) */
#define CTL_HIT      0x184u        /*   world time (1/4000 s) of the last hit it saw */
#define ST_TIME      0x7cu         /* a car state: float, the sender's race clock (s) */
#define G_WORLDTIME  0x0086518cu   /* the race clock (WorldTimer, 1/4000 s), slaved to the creator's */
#define CAR_POS      0x60u         /* a car: position, velocity (3 floats each) */
#define CAR_VEL      0x70u
#define HIT_M        80.f          /* m: a remote car farther from the player's is out of reach of a hit here */
#define HORN_PORT    3659u         /* racehorn.c's */
#define PEER_MS      5000u
#define FS_MS        2000u
#define FS_N         (16 + NAME_N)
#define NAME_N       16
#define NCARS        8
#define NLINKS       16
#define SLOW_US      50000u        /* a frame longer than this is a stall */

/* net_lan.c in the browser (racehorn.c has the stand-ins for the others) */
int vlan_rt_send(uint16_t port, uint32_t ip_h, const void *p, int n);
int vlan_race_peers(uint32_t *ip_h, int max, uint32_t within_ms);
__attribute__((weak)) int vlan_race_links(RaceLink *o, int max, int reset){ (void)o; (void)max; (void)reset; return 0; }

static int ok(uint32_t a, uint32_t n){ return a && mem_is_committed(a) && mem_is_committed(a + n); }
static uint32_t rd32(uint32_t a){ return ok(a, 3) ? MR32(a) : 0u; }
static void rd3(uint32_t a, float *o){ o[0] = MRF32(a); o[1] = MRF32(a + 4u); o[2] = MRF32(a + 8u); }
static uint64_t now_us(void){
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000u + (uint64_t)ts.tv_nsec / 1000u;
}
/* the name of the player whose car this is, as racehorn.c's car_name */
static void car_name(uint32_t car, char *o){
    int i = ok(car, 0x9e0) ? (int16_t)MR16(car + 0xau) : -1;
    uint32_t pl = i >= 0 && i < 6 ? rd32(G_NETPLAYERS + 4u * (uint32_t)i) : 0;
    int n = 0;
    if (ok(pl, NP_NAME + NAME_N))
        for (; n < NAME_N - 1; n++){ uint8_t ch = MR8(pl + NP_NAME + (uint32_t)n); if (ch < 0x20 || ch > 0x7e) break; o[n] = (char)ch; }
    o[n] = 0;
}

/* this race (R.on while the coordinator says racing) */
static struct {
    int on, host;
    char me[NAME_N];
    uint64_t t0, prev;                               /* its start, the last frame */
    uint32_t frames, slow; uint64_t longest;
    uint64_t w0; uint32_t wframes, wslow; uint64_t wlongest;   /* since our last N2FS */
} R;
/* the other cars, by their world car */
typedef struct {
    uint32_t car; char name[NAME_N];
    uint32_t n, g100, g250, g500; uint64_t first, last, gap_max;
    float p[3], d[3], step; int have_p, jumped; uint32_t jumps, big; float jump_max;   /* as shown, last frame */
    uint32_t unhit;                                   /* far "hits" passed (sub_005f8d40) */
    float age_min, age_max; double age_sum;           /* its states' age by our race clock (s) */
} Car;
static Car g_car[NCARS];
/* the others' frame rates, by name */
typedef struct { char name[NAME_N]; uint32_t n, slow, longest_ms; float sum, lo; double clock; } Fps;
static Fps g_fps[NCARS];

static Car *car_of(uint32_t car, int add){
    for (int i = 0; i < NCARS; i++) if (g_car[i].car == car) return &g_car[i];
    if (!add) return 0;
    for (int i = 0; i < NCARS; i++) if (!g_car[i].car){ memset(&g_car[i], 0, sizeof g_car[i]); g_car[i].car = car; return &g_car[i]; }
    return 0;
}

/* NFSU2_RACE_SMOOTH=0 shows the other cars as the game itself does (A/B tests) */
static int smooth_on(void){
    static int on = -1;
    if (on < 0){ const char *e = getenv("NFSU2_RACE_SMOOTH"); on = !(e && e[0] == '0'); }
    return on;
}
/* the car is farther than HIT_M from the player's */
static int far_from_me(uint32_t car){
    uint32_t pl = rd32(G_PLAYER1), me = pl ? rd32(pl + 4u) : 0;
    if (!ok(me, CAR_POS + 12u) || !ok(car, CAR_VEL + 12u) || car == me) return 0;
    float a[3], b[3], d2 = 0;
    rd3(me + CAR_POS, a); rd3(car + CAR_POS, b);
    for (int i = 0; i < 3; i++) d2 += (a[i] - b[i]) * (a[i] - b[i]);
    return __builtin_isfinite(d2) && d2 > HIT_M * HIT_M;
}
/* A remote car's predictions are moved on every world step by 0x5F8D40
 * (thiscall: the controller, the step), which first compares the car's
 * velocity with the one the last blend left it ([ctl+0x140]): a change of
 * 4 m/s or more is taken for a hit here, stamped [ctl+0x184], and the next
 * blend drops every prediction made from a state older than that (1 m/s
 * puts the car's own velocity and spin into the controller).  Far from the
 * player (seen at 220-335 m) the car's own physics changes its velocity that
 * much now and then: hit-marked in 5 % of the frames, its predictions gone
 * until the next state, the car stood still for a frame or two and then
 * stepped, 400-950 times a race to the creator's eyes.  Beyond HIT_M no hit
 * of this game can touch the car, and a hit of its own comes with its
 * owner's states, so its check sees no change. */
void sub_005f8d40_orig(CPU *c);
void sub_005f8d40(CPU *c){
    uint32_t ctl = c->ecx, car = ok(ctl, CTL_HIT + 4u) ? rd32(ctl + CTL_CAR) : 0;
    if (car && smooth_on() && far_from_me(car)){
        float v[3], pv[3], d2 = 0;
        rd3(car + CAR_VEL, v); rd3(ctl + CTL_PREV_V, pv);
        for (int i = 0; i < 3; i++) d2 += (v[i] - pv[i]) * (v[i] - pv[i]);
        Car *e = R.on ? car_of(car, 0) : 0;
        if (e && d2 >= 16.f) e->unhit++;
        for (int i = 0; i < 3; i++) MRF32(ctl + CTL_PREV_V + 4u * (uint32_t)i) = v[i];
    }
    sub_005f8d40_orig(c);
}

/* a car state came for a remote car (thiscall: the controller, the state) */
void sub_005f8900_orig(CPU *c);
void sub_005f8900(CPU *c){
    uint32_t ctl = c->ecx, st = MR32(c->esp + 4u), car = ok(ctl, CTL_CAR + 4u) ? MR32(ctl + CTL_CAR) : 0;
    Car *e = car && R.on ? car_of(car, 1) : 0;
    if (e){
        uint64_t t = now_us();
        if (e->n){
            uint64_t g = t - e->last;
            if (g > e->gap_max) e->gap_max = g;
            e->g100 += g > 100000u; e->g250 += g > 250000u; e->g500 += g > 500000u;
        } else e->first = t;
        if (ok(st, ST_TIME + 4u)){                        /* the state's age by this game's race clock */
            float age = (float)rd32(G_WORLDTIME) * 0.00025f - MRF32(st + ST_TIME);
            if (__builtin_isfinite(age)){
                if (!e->n || age < e->age_min) e->age_min = age;
                if (!e->n || age > e->age_max) e->age_max = age;
                e->age_sum += age;
            }
        }
        e->n++; e->last = t;
        if (!e->name[0]) car_name(car, e->name);
    }
    sub_005f8900_orig(c);
}

static void send_all(const uint8_t *m, uint32_t except){
    uint32_t peers[16];
    int n = vlan_race_peers(peers, 16, PEER_MS);
    for (int i = 0; i < n; i++) if (peers[i] != except) vlan_rt_send(HORN_PORT, peers[i], m, FS_N);
}
/* an N2FS from the horn's port (racehorn.c) */
void racenet_heard(uint8_t *m, int n, uint32_t from){
    if (n < FS_N || memcmp(m, "N2FS", 4) || m[4] != 1) return;
    char name[NAME_N];
    int k = 0;
    for (; k < NAME_N - 1 && m[16 + k] >= 0x20 && m[16 + k] <= 0x7e; k++) name[k] = (char)m[16 + k];
    name[k] = 0;
    if (!name[0]) return;
    if (!(m[5] & 2)){ m[5] |= 2; send_all(m, from); }   /* the creator passes it on */
    if (!R.on) return;
    int j = 0;
    while (j < NCARS && g_fps[j].name[0] && strcmp(g_fps[j].name, name)) j++;
    if (j == NCARS) return;
    Fps *f = &g_fps[j];
    float fps = (float)(m[6] | m[7] << 8) / 10.f;
    uint32_t longest = (uint32_t)(m[8] | m[9] << 8);
    if (!f->name[0]){ memcpy(f->name, name, NAME_N); f->lo = fps; }
    f->n++; f->sum += fps; if (fps < f->lo) f->lo = fps;
    f->slow += m[10]; if (longest > f->longest_ms) f->longest_ms = longest;
    uint32_t theirs = (uint32_t)m[12] | (uint32_t)m[13] << 8 | (uint32_t)m[14] << 16 | (uint32_t)m[15] << 24;
    f->clock += ((double)theirs - (double)rd32(G_WORLDTIME)) / 4.0;   /* ms, the way's delay in it */
}

/* this game's player has finished the race (or left it: the coordinator's
 * own racer entries) */
static int finished(uint32_t rc, uint32_t me){
    uint32_t n = rd32(rc + 0x24u);
    for (uint32_t i = 0; i < n && i < 8; i++){
        uint32_t r = rd32(rc + 0xbd0u + 4u * i);
        if (r && rd32(r) == me) return ok(r, RCR_DONE + 2u) && MR16(r + RCR_DONE) != 0;
    }
    return 0;
}
static void begin(uint64_t t, uint32_t me){
    memset(&R, 0, sizeof R);
    memset(g_car, 0, sizeof g_car);
    memset(g_fps, 0, sizeof g_fps);
    R.on = 1; R.t0 = R.w0 = t;
    R.host = (int32_t)rd32(G_NET_HOST) > 0;
    car_name(me, R.me);
    vlan_race_links(0, 0, 1);
    fprintf(stderr, "[racenet] race begins: me %s, %s\n", R.me[0] ? R.me : "(no name)",
            R.host ? "the game's creator" : "a joiner (every car comes through the creator)");
}
static void ip_str(uint32_t h, char *o){ snprintf(o, 16, "%u.%u.%u.%u", h >> 24, h >> 16 & 255u, h >> 8 & 255u, h & 255u); }
static void end(uint64_t t){
    double s = (double)(t - R.t0) / 1e6;
    fprintf(stderr, "[racenet] race over for me after %.1f s: %u frames, %.1f fps, %u over 50 ms (longest %.0f ms)\n",
            s, R.frames, s > 0 ? R.frames / s : 0., R.slow, (double)R.longest / 1000.0);
    RaceLink L[NLINKS];
    int nl = vlan_race_links(L, NLINKS, 1);
    for (int i = 0; i < nl; i++){
        char a[16]; ip_str(L[i].ip_h, a);
        uint32_t runs = L[i].runs - L[i].gaps, rest = L[i].n - L[i].after;
        fprintf(stderr, "[racenet]   link %s: %u datagrams (%.1f/s), longest wait %u ms, %u waits of %u ms or more",
                a, L[i].n, s > 0 ? L[i].n / s : 0., L[i].gap_max_ms, L[i].gaps, RACENET_GAP_MS);
        if (L[i].gaps) fprintf(stderr, ", %.1f at once after them", (double)L[i].after / L[i].gaps);
        fprintf(stderr, " (%.1f at once otherwise)\n", runs ? (double)rest / runs : 0.);
    }
    for (int i = 0; i < NCARS; i++){
        Car *e = &g_car[i];
        if (!e->car) continue;
        double span = e->n > 1 ? (double)(e->last - e->first) / 1e6 : 0.;
        fprintf(stderr, "[racenet]   car %s: %u updates (%.1f/s), longest wait %.0f ms, waits over 100/250/500 ms %u/%u/%u, "
                "jumps over 0.5 m %u, over 2 m %u (largest %.1f m), far \"hits\" passed %u, "
                "its states %.0f ms old by our race clock (%.0f to %.0f)",
                e->name[0] ? e->name : "-", e->n, span > 0 ? (e->n - 1) / span : 0., (double)e->gap_max / 1000.0,
                e->g100, e->g250, e->g500, e->jumps, e->big, (double)e->jump_max, e->unhit,
                e->n ? e->age_sum / e->n * 1000.0 : 0., (double)e->age_min * 1000.0, (double)e->age_max * 1000.0);
        Fps *f = 0;
        for (int j = 0; j < NCARS && e->name[0]; j++) if (!strcmp(g_fps[j].name, e->name)) f = &g_fps[j];
        if (f && f->n) fprintf(stderr, "; their game %.1f fps (lowest %.1f), %u frames over 50 ms (longest %u ms), "
                               "their race clock %+.0f ms off ours\n", (double)(f->sum / (float)f->n), (double)f->lo,
                               f->slow, f->longest_ms, f->clock / f->n);
        else fprintf(stderr, "; their frame rate unknown (an older version)\n");
    }
    R.on = 0;
}

/* every frame, on the game thread (roam.c's main-loop hook) */
void racenet_frame(CPU *c){
    (void)c;
    uint32_t pl = rd32(G_PLAYER1), me = pl ? rd32(pl + 4u) : 0, w = rd32(G_WORLD), rc = rd32(G_RACE);
    int racing = rd32(G_FLOW) == 6u && (rd32(G_NETMODE) & 0x208u) && ok(me, 0x9e0) && ok(w, 0x80) && rd32(rc) == RC_RACING &&
                 !finished(rc, me);
    uint64_t t = now_us();
    if (racing && !R.on) begin(t, me);
    else if (!racing && R.on) end(t);
    if (!R.on) return;
    /* our frames (the first one has no length) */
    uint64_t dt = R.prev ? t - R.prev : 0;
    if (R.prev){
        R.frames++; R.wframes++;
        if (dt > SLOW_US){ R.slow++; R.wslow++; }
        if (dt > R.longest) R.longest = dt;
        if (dt > R.wlongest) R.wlongest = dt;
    }
    R.prev = t;
    /* the other cars as shown: a jump is a frame's move that differs from the
     * frame before's, scaled to this frame's length, by over 0.5 m (a car
     * that stands still and then steps, or snaps: a hit's change of speed
     * moves it a few cm a frame).  Not the car's speed: a far car's reads 0.
     * The frame's length is the longer of the world's step and the wall
     * clock's (a world that catches up after a stall moves every car that
     * far).  Two frames in a row count once. */
    float wdt = MRF32(G_WORLDDT), fdt = (float)dt / 1e6f, step = wdt > fdt && wdt < 1.f ? wdt : fdt;
    uint32_t car = rd32(w);
    for (int k = 0; car && car != w && k < 64 && ok(car, 0x9e0); k++, car = rd32(car)){
        Car *e = car == me ? 0 : car_of(car, 0);
        if (!e) continue;
        float p[3], d[3];
        rd3(car + 0x60u, p);
        for (int i = 0; i < 3; i++) d[i] = p[i] - e->p[i];
        if (e->have_p > 1 && dt && e->step > 0.f){
            float s = step / e->step, x2 = 0;
            for (int i = 0; i < 3; i++) x2 += (d[i] - e->d[i] * s) * (d[i] - e->d[i] * s);
            float x = __builtin_sqrtf(x2);
            int jump = __builtin_isfinite(x) && x > 0.5f;
            if (jump && !e->jumped){ e->jumps++; e->big += x > 2.f; }
            if (jump && x > e->jump_max) e->jump_max = x;
            e->jumped = jump;
        }
        if (e->have_p) memcpy(e->d, d, sizeof d);
        memcpy(e->p, p, sizeof p); e->step = step; e->have_p += e->have_p < 2;
    }
    /* our frame rate to the others */
    if (t - R.w0 >= FS_MS * 1000u && R.me[0]){
        uint8_t m[FS_N];
        uint32_t fps10 = (uint32_t)((double)R.wframes * 1e7 / (double)(t - R.w0) + 0.5), ms = (uint32_t)(R.wlongest / 1000u);
        if (fps10 > 0xffffu) fps10 = 0xffffu;
        if (ms > 0xffffu) ms = 0xffffu;
        memset(m, 0, sizeof m);
        memcpy(m, "N2FS", 4); m[4] = 1;
        m[6] = (uint8_t)fps10; m[7] = (uint8_t)(fps10 >> 8); m[8] = (uint8_t)ms; m[9] = (uint8_t)(ms >> 8);
        m[10] = (uint8_t)(R.wslow > 255u ? 255u : R.wslow);
        uint32_t clk = rd32(G_WORLDTIME);
        m[12] = (uint8_t)clk; m[13] = (uint8_t)(clk >> 8); m[14] = (uint8_t)(clk >> 16); m[15] = (uint8_t)(clk >> 24);
        memcpy(m + 16, R.me, strlen(R.me));
        send_all(m, 0);
        R.w0 = t; R.wframes = 0; R.wslow = 0; R.wlongest = 0;
    }
}
