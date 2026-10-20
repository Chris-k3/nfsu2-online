/* roam_game.c -- free-roam multiplayer: the game side (v1.2 NA port).
 *
 * Friends on the same LAN, each in their own career free roam, see each
 * other's cars: right model and customization, moving smoothly, with their
 * names on the minimap arrow's racer record.  Off unless NFSU2_ROAM=1.
 * The wire format is in roam_core.h.
 *
 * Per frame, at the main-loop hook between World::DoTimestep and the camera
 * and render (roam.c's instruction hook at 0x581475), on the guest thread:
 *  - a sync clock: the sum of world dt (what the cars move by), slewed to
 *    the host clock (at most 5 %) and following it while the world stands
 *    (pause, SMS, streaming), stamps the local samples and is the render
 *    clock of the remote cars;
 *  - the local car's state goes to the session (roam_core), which sends a
 *    snapshot 20 times a second; its car look (type and part hashes) goes
 *    out when it changes;
 *  - remote players get "slots": the 3 parked free-roam opponent cars (the
 *    outrun challengers' cars; the RandomEncounterManager is held off while
 *    we use them) and up to 29 cars of our own (CreateCar), the nearest
 *    players first.  World::IndexCars' array holds 22 cars and the world has
 *    20, so the first 2 of ours are indexed as AI racers and the others stay
 *    out of it, on the World's list only, which is what the renderer walks
 *    (finish_create); those get their minimap arrows here (arrows_update).  The game has 6 paint slots
 *    (DUMMY_SKIN1-6: the player, the 3 opponent cars, the first 2 of ours);
 *    the others composite into textures of our own (skin_textures,
 *    roam_game_texture).  A slot's car gets the player's ride (streamed
 *    in through the CarLoader, then Car::SetRideInfo), no brain and no
 *    physics, and its pose is written every frame from the core's
 *    interpolation.  Solid cars (the default) keep their collision body,
 *    except while they are ghosts: from the moment they appear (or jump,
 *    or the player's car does) until they are clear of the player's car,
 *    so nobody is shoved out of a car that appeared inside theirs; they are
 *    drawn where the friend is now (predicted by half the round trip), so
 *    a contact is at the same spot on both screens.  Ghost cars
 *    (NFSU2_ROAM_COLLIDE=0) have no collision body and are drawn a little in
 *    the past (NFSU2_ROAM_DELAY), smoothed through the jitter buffer.
 *  - names over friends' cars, as the game's own LAN races show them
 *    (roam_game_hud).
 *  - horns: the player's goes out with the snapshots, friends' sound from
 *    their cars (horns_update, horn.c).
 *  - outruns: two players who stay near each other can challenge each other
 *    to the game's own outrun, raced against each other's car (du_frame).
 *  - leaving free roam (shop, crib, race, menus) parks the cars; their
 *    rides are unloaded once the world is gone.  A peer that leaves, times
 *    out or goes into a shop or race disappears (soft-parked), and its slot
 *    is given back after a while.
 * The network itself runs on roam_bsd.c's thread; the game thread only
 * takes the session lock for a few microseconds per frame.
 *
 * The same file is the game side of the Windows companion for the original
 * PC game (win/roam_asi, NFSU2FreeRoam.asi), built with -DROAM_HOST_WIN:
 * every guest access, guest call, option, log line and clock goes through
 * the host names of roam_host.h (the port) or roam_host_win.h (Windows), and
 * every float operation is a basic IEEE operation (no libm; both builds use
 * -ffp-contract=off), so both platforms make the same writes into the game
 * for the same inputs (tests/asi_harness.c checks that).
 */
#ifdef ROAM_HOST_WIN
#include "roam_host_win.h"
#else
#include "roam_host.h"
#endif
#include "roam_core.h"
#include "roam_plat.h"

/* ---- game addresses (v1.2 NA) ------------------------------------------------ */
#define G_FLOW          0x008654a4u   /* GameFlowManager state: 3 front end, 6 in the world */
#define G_GAMEMODE      0x00850078u   /* 1 career, 0x200 LAN */
#define G_WORLD         0x00890080u   /* World*: +0x10 cars, +0x14/+0x18 AI range, +0x1C cars[] */
#define G_PLAYER1       0x008900acu   /* Player*: +4 car */
#define G_RACE          0x00890118u   /* race coordinator: +0 state (4 racing), +0x24 racers, +0xC40 encounters */
#define G_CAREER_RACE   0x00863470u   /* career race being run (0 = free roam) */
#define G_WORLDDT       0x00865154u   /* float: this frame's world dt (s) */
#define G_PROFILE_NAME  0x0083a9e0u   /* 16 bytes */
#define G_CARTYPES      0x008a1cccu   /* CarTypeInfo[]: 0x890 bytes, +0 name, +0xD0 name hash */
#define G_PARTOWNERS    0x008a1cb8u   /* CarPart byte +7 -> owner (car type) hash table */
#define G_CARPARTDB     0x008a2b68u
#define G_CARLOADER     0x008a3288u   /* entries on +0x58, handle at entry +0x123C */
#define G_CARPOOL_KB    0x007fa9d4u   /* free-roam "Cars" pool size (KB), read at the track load */
#define G_CARS_POOL     0x00828164u   /* bMemory pool 4: +0x24 size, +0x28 used */
#define G_RECORDS       0x00890160u   /* racer records, 0x940 bytes each */
#define RC_ENCOUNTERS   0xc40u
#define FN_MALLOC       0x00575620u   /* cdecl (size) */
#define FN_CAR_ACTIVATE 0x005f6d50u
#define FN_CAR_DEACTIVATE 0x005f6e20u
#define FN_CAR_SETDRIVER 0x005eba30u  /* thiscall (type) */
#define FN_CAR_SETPHYS  0x005f46a0u   /* thiscall (mode) */
#define FN_CAR_SECTION  0x005f6cd0u   /* thiscall (): track section / collider after a move */
#define FN_ROADTRACK    0x005da330u   /* thiscall (car +0x8D8, pos*): road tracker, as Car::SetPosition does */
#define FN_CAR_BODYPOS  0x005f5010u   /* thiscall (): +0x50 = +0x60 - centre-of-mass offset (and a ground snap) */
#define FN_CAR_SETRIDE  0x00601110u   /* thiscall (RideInfo*) */
#define FN_BODY_DISABLE 0x005930f0u   /* DynamicCollisionBody (car +0x3C): ++[+0x17] */
#define FN_TYPE_BY_HASH 0x00610130u   /* cdecl (hash) -> CarTypeInfo* or 0 */
#define FN_GETCARPART   0x0061b980u   /* thiscall CarPartDB (type, slot, key, prev, -1) */
#define FN_RIDE_INIT    0x00610270u   /* thiscall (type, 0, b5, b6) */
#define FN_RIDE_STOCK   0x00637040u   /* thiscall (0): stock parts */
#define FN_RIDE_PARTSON 0x0061bcd0u   /* thiscall (): UpdatePartsEnabled */
#define FN_RIDE_SKINS   0x0061c280u   /* thiscall (n): DUMMY_SKIN<n> / WHEEL / SPINNER */
#define FN_PERF_SET     0x005ac4b0u   /* thiscall RideInfo +0x2F0 (perf*): installed performance parts from bits */
#define FN_PHYS_UPDATE  0x005b4fc0u   /* thiscall RideInfo +0x10 (1, 1, 1): physics from tuning and parts */
#define FN_LOADER_LOAD  0x0063bc70u   /* thiscall (ride, 0, 0) -> handle */
#define FN_LOADER_SERVICE 0x0063bcd0u /* thiscall (0, 0) */
#define FN_LOADER_LOADED 0x00610910u  /* thiscall loader (entry) */
#define FN_LOADER_WAIT  0x0061ca50u   /* thiscall (handle) */
#define FN_LOADER_UNLOAD 0x0063ae00u  /* thiscall (handle) */
#define FN_LOADER_PURGE 0x0063a1b0u   /* thiscall (phase), callee pops: phase 0 unloads one unreferenced entry -> 1, none -> 0 */
#define FN_CREATECAR    0x00606480u   /* ecx grid {vec3, +0x10 u16 heading}, edx record, (driver, start) */
#define FN_INDEXCARS    0x005f0d20u   /* thiscall World */
#define FN_MM_REBUILD   0x004f92a0u   /* cdecl (): the minimap's icons made again (0x4ECC80), as Player 0x5EA980 does */
#define FN_EM_OVER      0x00500ca0u   /* thiscall G_ENCOUNTERS: the outrun is over (the manager's state 5 calls it) */
#define G_ENCOUNTERS    0x0085ef70u   /* the career's outrun bookkeeping (the manager asks it whether one is due) */
#define EM_TABLE        0x1b10u       /* manager: 3 x {+0 time, +4 state, +8 flag, +0xC car} */
#define EM_STANDDOWN_US 20000000      /* its cars out of sight (250 m) by then, or parked anyway */
#define PARK_Z          (-123456.f)   /* Car::Deactivate's parking spot (0, 0, -123456) */
#define RIDE_SZ         0x900u
#define REC_SZ          0x940u
#define NSLOT           32            /* 3 opponent cars + 29 of our own */
#define NOPP            3             /* slots 0-2: the parked free-roam opponent cars */
#define WORLD_INDEX     22            /* World::IndexCars' cars[] (World +0x1C; other fields follow) */
#define KIND_OUT        4             /* a racer record kind IndexCars skips (1 human, 2 AI racer, 3 traffic) */
#define SKIN_GAME       6             /* the game's paint slots, DUMMY_SKIN1-6 */
#ifdef ROAM_HOST_WIN
#define MAX_CARS        5             /* the Windows plugin: the game's own paint slots and car index only */
#else
#define MAX_CARS        NSLOT
#endif
#define CLEAR_M         6.f           /* a ghost becomes solid once its centre is this far from the player's car's */
#define JUMP_M          5.f           /* a friend's car drawn this far from where it was last frame is a ghost again */

/* ---- guest access ----------------------------------------------------------------- */
static int ok(uint32_t a, uint32_t n){ return a && rh_committed(a) && rh_committed(a + n); }
static uint32_t rd32(uint32_t a){ return ok(a, 3) ? MR32(a) : 0u; }
static uint32_t gcall0(CPU *c, uint32_t fn, uint32_t ecx){ return rh_call(c, fn, ecx, 0, 0, 0); }
static uint32_t gcall1(CPU *c, uint32_t fn, uint32_t ecx, uint32_t a){ return rh_call(c, fn, ecx, 0, 1, &a); }
static uint32_t player_car(void){ uint32_t p = rd32(G_PLAYER1); return p ? rd32(p + 4u) : 0; }
static uint32_t world(void){ uint32_t w = rd32(G_WORLD); return ok(w, 0x80) ? w : 0; }
static int du_racing(uint32_t race);
/* free roam: the career's world with no race but free roam's own one-racer
 * one, or an outrun with a friend (du_racing): that is still free roam */
static int roaming(void){
    uint32_t race = rd32(G_RACE);
    return rd32(G_FLOW) == 6u && ok(race, 0xc44) && MR32(race) == 4u && (MR32(race + 0x24u) == 1u || du_racing(race)) &&
           !rd32(G_CAREER_RACE) && !(rd32(G_GAMEMODE) & 0x200u) && world() && player_car();
}
static uint32_t encounter_mgr(void){ uint32_t r = rd32(G_RACE); return ok(r, 0xc44) ? r + RC_ENCOUNTERS : 0; }
/* one of the game's own opponent cars: an AI racer (kind 2) whose racer
 * record is in the game's record array -- never a car of ours, whose record
 * is a copy in our own memory (World::IndexCars sorts both kinds into the
 * same AI range, in the order of the World's list, which the game changes) */
static int game_opponent(uint32_t car){
    uint32_t rec = ok(car, 0x9e0) ? rd32(car + 0x14u) : 0;
    return rec >= G_RECORDS && rec < G_RECORDS + 22u * REC_SZ && (rec - G_RECORDS) % REC_SZ == 0 && MR32(rec + 4u) == 2u;
}
static uint32_t ai_car(uint32_t w, int i){
    int first = (int)MR32(w + 0x14u), end = (int)MR32(w + 0x18u);
    if (first < 0 || end > 22 || i < 0 || first + i >= end) return 0;
    uint32_t car = rd32(w + 0x1cu + 4u * (uint32_t)(first + i));
    return ok(car, 0x9e0) ? car : 0;
}
static int car_out(uint32_t car){ return __builtin_fabsf(MRF32(car + 0x68u) - PARK_Z) >= 0.001f; }   /* 0x5ED430 */
#define RIDE_ENTRIES    128           /* the car loader's ride entries with free-roam multiplayer on (g_pools) */
static uint32_t loader_entry(uint32_t h){
    uint32_t head = G_CARLOADER + 0x58u, e = rd32(head);
    for (int k = 0; e && e != head && k < 4 * RIDE_ENTRIES; k++, e = rd32(e)) if (rd32(e + 0x123cu) == h) return e;
    return 0;
}
/* The car loader serves its loads one after another, about half a second
 * each: a load may take 15 s, and a second more for each load ahead of it
 * (32 friends arriving at once queue 61 loads, a car of our own's and the
 * friend's ride each) */
static int loads_waiting(void);
static int64_t load_wait_us(void){ return 15000000 + 1000000 * (int64_t)loads_waiting(); }
static void cstr(uint32_t a, char *o, int n){
    int i = 0;
    if (ok(a, (uint32_t)n)) for (; i < n - 1 && MR8(a + (uint32_t)i) >= 0x20 && MR8(a + (uint32_t)i) < 0x7f; i++) o[i] = (char)MR8(a + (uint32_t)i);
    o[i] = 0;
}
static uint32_t pool_free(void){
    uint32_t p = rd32(G_CARS_POOL);
    if (!ok(p, 0x30)) return 0xffffffffu;
    uint32_t sz = MR32(p + 0x24u), used = MR32(p + 0x28u);
    return used <= sz ? sz - used : 0;
}
static void pool_log(const char *why){
    uint32_t p = rd32(G_CARS_POOL);
    if (ok(p, 0x30)) rlog("[roam] f=%ld car pool (%s): %.2f of %.2f MB used\n", rh_frame(), why,
                             MR32(p + 0x28u) / 1048576.0, MR32(p + 0x24u) / 1048576.0);
}

/* ---- options --------------------------------------------------------------------------- */
/* a player's option without a comment after it: the Mac's settings.ini only
 * knows whole-line comments, so "roam_name = Thom   ; me" would make the
 * comment part of the name; on both platforms a ';' or '#' at the start or
 * after a blank starts a comment ("Team#1" stays a name) */
static const char *opt(const char *k){
    const char *v = rh_opt(k);
    if (!v) return 0;
    static char buf[4][256]; static int nb;
    char *o = buf[nb++ & 3];
    int n = 0;
    for (int i = 0; v[i] && n < 255; i++){
        if ((v[i] == ';' || v[i] == '#') && (i == 0 || v[i - 1] == ' ' || v[i - 1] == '\t')) break;
        o[n++] = v[i];
    }
    while (n && (o[n - 1] == ' ' || o[n - 1] == '\t')) n--;
    o[n] = 0;
    return o;
}
static int env_int(const char *k, int def, int lo, int hi){
    const char *v = opt(k);
    if (!v || !*v) return def;
    long x; char *e = 0;
    if (!strcasecmp(v, "on") || !strcasecmp(v, "yes") || !strcasecmp(v, "true")) x = 1;
    else if (!strcasecmp(v, "off") || !strcasecmp(v, "no") || !strcasecmp(v, "false")) x = 0;
    else { x = strtol(v, &e, 10);       /* decimal, as settings.ini checks it: "047300" is 47300, not octal */
           if (e == v || *e){ rlog("[roam] %s=\"%s\" is not a number, using %d\n", k, v, def); return def; } }
    if (x < lo || x > hi){ rlog("[roam] %s=%ld out of range %d..%d, using %d\n", k, x, lo, hi, def); return def; }
    return (int)x;
}
static struct {
    int on, test, collide, max_cars, rate, delay_ms, extrap_ms, carpool_kb, labels;
    int test_owncars;                         /* NFSU2_ROAM_TEST_OWNCARS (test aid): friends only in cars of our own (slots 3 and up) */
    int test_outside;                         /* NFSU2_ROAM_TEST_OUTSIDE (test aid): every car of our own outside the car index */
    char name[RC_NAME_MAX + 1], room[64];
} O;

/* ---- state ------------------------------------------------------------------------------- */
static rc_session g_s;
static int g_inited, g_net_ok;
static long g_frame0;
/* sync clock (µs): world time pulled to the host clock */
static double g_sync; static int g_sync_paused, g_in_roam;
static double g_vscale = 1.0;                 /* world seconds per stamp second (velocities on the wire) */
static int64_t g_last_host;
/* local car */
static float g_lp[3]; static int g_lp_ok;
static int64_t g_cfg_next;
static int g_horn;                            /* the player's horn sounds this frame */
/* guest memory for rides and records (allocated once, never freed) */
static uint32_t g_gmem;
/* slots */
/* FREE: no friend, the car (if any) has its own ride.  CREATING: a car of
 * our own is being made.  LOADING: the friend's ride is streaming in.
 * ACTIVE: the friend's car is shown (or hidden while the friend is in a shop
 * or race).  PARKED: no friend any more, but the car keeps the last friend's
 * ride, hidden, so that the same look coming back costs nothing (no new
 * load, no new composited skin) */
enum { SL_FREE, SL_CREATING, SL_LOADING, SL_ACTIVE, SL_PARKED };
typedef struct {
    int      st;
    int      peer; uint32_t peer_id;          /* session table index and id */
    char     name[RC_NAME_MAX + 1];
    uint32_t car, world;                      /* the slot's car in this world */
    int      created;                         /* one of our own cars (k >= NOPP) */
    int      unindexed;                       /* ...past World::IndexCars' 22: record kind KIND_OUT */
    uint32_t ride_new, ride_orig, rec;        /* guest buffers */
    uint32_t h_cur, h_new;                    /* CarLoader handles (on the car / loading) */
    uint32_t h_orig;                          /* a car of our own: its first ride (an opponent's copy) */
    int      have_orig, activated;
    uint32_t cfg_gen;  int pending_cfg;       /* the record the car shows / one waiting */
    uint32_t look;                            /* hash of the record the car shows (0: none) */
    int64_t  load_t0, load_wait; long load_f0;    /* load_wait: how long the load may take (loads_waiting) */
    int      hidden;
    int      paused;                          /* the friend is paused (for a second now): so says the name over the car */
    int64_t  paused_since;
    int64_t  near_since;                      /* within DU_NEAR_M of the player's car since (0: not), for an outrun */
    int      ghost;                           /* solid cars: no collision body until clear of the player's car */
    float    drawn[3];                        /* where the car was drawn last frame (+0x60) */
    float    com[3];                          /* centre-of-mass offset in the car's frame (forward, left, up) */
    float    spin[4], steer;                  /* the wheels' angles about the axle and the front wheels' steering (rad) */
    int64_t  unseen_since;                    /* the peer is not visible: release after a while */
    int64_t  release_after;
    char     carname[RC_CFG_TYPE_NAME + 1];
    /* statistics */
    uint32_t loads, remode, pose_frames, wakes;   /* wakes: the game's wake-ups refused (roam_game_inert) */
} Slot;
static Slot g_sl[NSLOT];
static uint32_t g_world_seen;
static uint32_t g_handles_pending[3 * NSLOT]; static int g_npending;   /* unload once the world is gone */
static int g_created_n;                       /* cars of our own in this world */
/* the outrun challengers' manager: the game's (EM_GAME), held off by us
 * (EM_HELD: state 6, its cars parked), or being stood down (EM_STANDDOWN:
 * state 6, its cars still out until they are out of sight) */
enum { EM_GAME, EM_HELD, EM_STANDDOWN };
static int g_em; static int64_t g_em_release_at, g_em_sd_t0;
static int g_em_pin;                          /* a car of ours in its window: held until the world changes */
static int g_em_racing_noted;
/* frame cost */
static uint64_t g_cost_sum, g_cost_n, g_cost_max, g_cost_win_sum, g_cost_win_n, g_cost_win_max;
static uint64_t g_cost_hud;                   /* roam_game_hud since the last frame, counted with the next one */
static int64_t g_cost_win_t0;
/* statistics */
static int g_joins, g_leaves;                 /* changed with the session lock held */
static uint32_t g_teleports, g_clock_snaps, g_acquires, g_releases, g_load_fail, g_creates, g_reuses, g_restores;
/* test aid: per-frame pose log */
static rh_file *g_poselog;
/* a script command that calls guest code waits for the main-loop hook */
#ifdef ROAM_HOST_SCRIPT
#define NJOB 4
static char g_job[NJOB][240]; static int g_njob;
static void run_job(CPU *c, const char *job);
#endif

/* ---- events from the session (network or game thread, lock held) ------------------------ */
void roam_game_event(int ev, int peer, const char *text){
    if (ev == RC_EV_JOIN) __atomic_fetch_add(&g_joins, 1, __ATOMIC_RELAXED);
    if (ev == RC_EV_LEAVE) __atomic_fetch_add(&g_leaves, 1, __ATOMIC_RELAXED);
    rlog("[roam] %s%s (peer %d)\n", ev == RC_EV_JOIN ? "JOIN: " : ev == RC_EV_LEAVE ? "LEAVE: " : "", text, peer);
}

/* ---- the local car -------------------------------------------------------------------------- */
static void rd3(uint32_t a, float *o){ o[0] = MRF32(a); o[1] = MRF32(a + 4u); o[2] = MRF32(a + 8u); }
static int local_state(rc_state *s){
    uint32_t car = player_car();
    if (!ok(car, 0x9e0)) return 0;
    float f[3], l[3], u[3];
    memset(s, 0, sizeof *s);
    s->t_us = (uint32_t)(uint64_t)(int64_t)g_sync;
    rd3(car + 0x60u, s->p); rd3(car + 0x70u, s->v); rd3(car + 0x110u, s->w);
    rd3(car + 0x90u, f); rd3(car + 0xa0u, l); rd3(car + 0xb0u, u);
    rc_m2q(f, l, u, s->q);
    s->speed = MRF32(car + 0x42cu); s->rpm = MRF32(car + 0x440u); s->gear = (int8_t)MR32(car + 0x434u);
    uint32_t ctl = MR32(car + 0x30u);
    if (ok(ctl, 0x220)){
        s->throttle = MRF32(ctl + 0x20cu); s->brake = MRF32(ctl + 0x214u);
        s->steer = (float)(int16_t)MR16(ctl + 0x1e0u) / 32767.f;
        if (s->brake > 0.1f) s->bits |= RC_BIT_BRAKE;
        if (MRF32(ctl + 0x210u) > 0.1f) s->bits |= RC_BIT_HANDBRAKE;
    }
    if (s->speed < -0.5f) s->bits |= RC_BIT_REVERSE;
    if (g_horn) s->bits |= RC_BIT_HORN;
    if (g_sync_paused > 1){ for (int i = 0; i < 3; i++){ s->v[i] = 0; s->w[i] = 0; } s->speed = 0; s->rpm = 0; }
    for (int i = 0; i < 3; i++) if (!__builtin_isfinite(s->p[i]) || !__builtin_isfinite(s->v[i])) return 0;
    /* the stamp clock may run a little faster than the world (it is pulled
     * to the host clock): velocities per stamp second, so the receiver's
     * tangents and dead reckoning match the stamps */
    for (int i = 0; i < 3; i++){ s->v[i] = (float)(s->v[i] * g_vscale); s->w[i] = (float)(s->w[i] * g_vscale); }
    /* the rest comes from the car unchecked: never NaN or infinity on the wire */
    for (int i = 0; i < 3; i++) if (!__builtin_isfinite(s->w[i])) s->w[i] = 0;
    if (!__builtin_isfinite(s->speed)) s->speed = 0;
    if (!__builtin_isfinite(s->rpm)) s->rpm = 0;
    if (!__builtin_isfinite(s->throttle)) s->throttle = 0;
    if (!__builtin_isfinite(s->brake)) s->brake = 0;
    if (!__builtin_isfinite(s->steer)) s->steer = 0;
    if (__builtin_fabsf(s->p[2] - PARK_Z) < 100.f) return 0;
    return 1;
}
/* the car look: type name hash and one (slot, key, owner) per filled part
 * slot of the car's RideInfo */
static int local_cfg(uint8_t *out, int cap, char *tname){
    uint32_t car = player_car(), ride = car ? rd32(car + 0x10u) : 0, types = rd32(G_CARTYPES), owners = rd32(G_PARTOWNERS);
    if (!ok(ride, 0x8f0) || !types || !owners) return 0;
    uint32_t type = MR32(ride);
    if (type >= 256) return 0;                       /* Unlimiter adds car types after the stock ones */
    uint32_t ti = types + type * 0x890u;
    if (!ok(ti, 0x100)) return 0;
    static rc_carcfg c;
    memset(&c, 0, sizeof c);
    c.type_hash = MR32(ti + 0xd0u);
    cstr(ti, c.type_name, sizeof c.type_name);
    if (tname) snprintf(tname, RC_CFG_TYPE_NAME + 1, "%s", c.type_name);
    for (int i = 0; i < 4; i++) c.ride_b[i] = MR8(ride + 4u + (uint32_t)i);
    /* performance, as the game's LAN car description (0x5F0320) has it */
    memset(c.perf, 0, sizeof c.perf);
    for (int i = 0; i < 10; i++) if (MR32(ride + 0x318u + 4u * (uint32_t)i)) c.perf[i >> 3] |= (uint8_t)(0x80u >> (i & 7));
    for (int i = 0; i < 68; i++) if (MR8(ride + 0x340u + (uint32_t)i)) c.perf[2 + (i >> 3)] |= (uint8_t)(0x80u >> (i & 7));
    for (int i = 0; i < 41; i++) c.perf[11 + i] = MR8(ride + 0x398u + (uint32_t)i);
    c.has_perf = 1;
    for (uint32_t sl = 0; sl < RC_PART_SLOTS; sl++){
        uint32_t part = MR32(ride + 0x590u + 4u * sl);
        if (!part || !ok(part, 0xe)) continue;
        uint32_t key = (uint32_t)MR16(part + 2u) << 16 | MR16(part);
        uint32_t own = rd32(owners + 4u * MR8(part + 7u));
        c.part[c.n_parts].slot = (uint8_t)sl; c.part[c.n_parts].key = key; c.part[c.n_parts].owner = own; c.n_parts++;
    }
    return rc_carcfg_encode(&c, out, cap);
}

/* ---- building a remote ride ---------------------------------------------------------------- */
/* Decode a car-look record into the RideInfo at ride (0x8F0 bytes of guest
 * memory) with skin slot n: RideInfo::Init, stock parts, then each slot of
 * the record looked up by its key in the CarPartDB (NewGetCarPart, owner
 * checked) and written; slots the record does not name are left empty, as
 * on the sender; a part this game does not have keeps the stock part.
 * Returns the number of parts not found, or -1. */
static int build_ride(CPU *c, const rc_carcfg *cc, uint32_t ride, uint32_t skin, char *why, int whylen){
    uint32_t types = rd32(G_CARTYPES);
    uint32_t ti = gcall1(c, FN_TYPE_BY_HASH, 0, cc->type_hash);
    uint32_t type;
    int missing = 0;
    if (ti && types && ti >= types && (ti - types) % 0x890u == 0) type = (ti - types) / 0x890u;
    else {
        /* an add-on car this game does not have (Unlimiter): a stock car of
         * a type with the same name prefix, or the Peugeot 206 (type 0) */
        type = 0;
        for (uint32_t i = 0; i < 46 && types; i++){
            char n[20]; cstr(types + i * 0x890u, n, sizeof n);
            if (n[0] && !strncasecmp(n, cc->type_name, 4)){ type = i; break; }
        }
        snprintf(why, (size_t)whylen, "car type %s unknown here, shown as type %u", cc->type_name, type);
        missing = -1;
    }
    for (uint32_t i = 0; i < 0x8f0u; i += 4) MR32(ride + i) = 0;
    uint32_t ia[4] = { type, 0, cc->ride_b[1], cc->ride_b[2] };
    rh_call(c, FN_RIDE_INIT, ride, 0, 4, ia);
    /* performance and tuning first, the way the game's own LAN car
     * description decoder (0x5F04D0) builds a remote car: without them the
     * physics block is incomplete and CreateCar's physics pass faults */
    {
        uint8_t pf[RC_PERF_BYTES];
        if (cc->has_perf) memcpy(pf, cc->perf, sizeof pf);
        else { memset(pf, 0, sizeof pf); memset(pf + 11, 0x64, 41); }      /* stock: no parts, default tuning */
        for (int i = 0; i < 10; i++) MR32(ride + 0x318u + 4u * (uint32_t)i) = (pf[i >> 3] >> (7 - (i & 7))) & 1u;
        uint32_t perf = g_gmem + 0x40u;                                    /* scratch: {u32 0, 9 bytes of bits} */
        MR32(perf) = 0; MR8(perf + 4u) = 0;
        for (int i = 0; i < 9; i++) MR8(perf + 5u + (uint32_t)i) = pf[2 + i];
        gcall1(c, FN_PERF_SET, ride + 0x2f0u, perf);
        for (int i = 0; i < 41; i++) MR8(ride + 0x398u + (uint32_t)i) = pf[11 + i];
        /* the physics pass (0x5B4FC0) is not run: on a ride built here it
         * faults (an empty engine table, 0x5764D0); remote cars need no
         * physics, and only SetRideInfo (which does not run it) sees them */
    }
    gcall1(c, FN_RIDE_STOCK, ride, 0);
    if (missing < 0 || cc->n_parts == 0){                /* stock car */
        gcall1(c, FN_RIDE_SKINS, ride, skin);
        return missing < 0 ? 0 : 0;
    }
    uint32_t owners = rd32(G_PARTOWNERS);
    uint32_t want[RC_PART_SLOTS] = {0}; uint8_t named[RC_PART_SLOTS] = {0};
    for (int k = 0; k < cc->n_parts; k++){
        uint32_t sl = cc->part[k].slot, prev = 0, found = 0;
        named[sl] = 1;
        for (int tries = 0; tries < 6; tries++){
            uint32_t a[5] = { type, sl, cc->part[k].key, prev, 0xffffffffu };
            uint32_t p = rh_call(c, FN_GETCARPART, G_CARPARTDB, 0, 5, a);
            if (!p || !ok(p, 0xe)) break;
            if (!owners || rd32(owners + 4u * MR8(p + 7u)) == cc->part[k].owner){ found = p; break; }
            prev = p;
        }
        if (found) want[sl] = found; else missing++;
    }
    for (uint32_t sl = 0; sl < RC_PART_SLOTS; sl++){
        if (named[sl] && want[sl]) MR32(ride + 0x590u + 4u * sl) = want[sl];
        else if (!named[sl]) MR32(ride + 0x590u + 4u * sl) = 0;
        /* named but not found here: the stock part stays */
    }
    for (int i = 0; i < 4; i++) MR8(ride + 4u + (uint32_t)i) = cc->ride_b[i];
    gcall0(c, FN_RIDE_PARTSON, ride);
    gcall1(c, FN_RIDE_SKINS, ride, skin);
    if (missing > 0) snprintf(why, (size_t)whylen, "%d part(s) not in this game, stock parts instead", missing);
    return missing;
}

/* ---- paint slots past the game's six ---------------------------------------------------------- */
/* A car's paint (the composited skin: base colour, vinyls) goes into the
 * texture its ride names DUMMY_SKIN<n>, its rims into DUMMY_WHEEL<n> and its
 * spinners into DUMMY_SPINNER<n> (0x61C280).  The game's are n = 1..6
 * (GlobalMemoryFile.bin); its compositor (0x61D790) keeps a cache for those
 * six and composites into any other texture GetTextureInfo (0x4901D0)
 * finds.  The game's six are texture packs of their own in CARS/TEXTURES.BIN
 * (pixels, then the TextureInfo, then its platform record), which the car
 * loader reads in while a car uses that slot; slot 1, the player's car, is
 * always there.  Slots 7 and up get copies of a slot that is there: its
 * TextureInfo (0x7C bytes) and platform record (0x20 bytes: +0/+4 the links
 * of the game's list of D3D textures, +0x18 the texture) copied, pixels of
 * their own (zero), the D3D texture made by the game (0x5CE170), handed out
 * by the port's override of GetTextureInfo (roam.c).  Made once, when a car
 * first needs them, and kept. */
#define FN_TEXINFO      0x004901d0u   /* cdecl (hash, default, 0) -> TextureInfo* (one that is loaded) */
#define FN_TEX_CREATE   0x005ce170u   /* thiscall TextureInfo: its D3D texture from +0x70's pixels */
#define TI_SZ           0x7cu         /* TextureInfo: +0 platform record, +0x24 name hash, +0x40 bytes of mip 0, +0x4E mips,
                                       * +0x6C itself (or the texture named by +0x2C), +0x70 pixels */
#define PLAT_SZ         0x20u         /* platform record: +0x18 the D3D texture */
static struct { uint32_t hash, ti; } g_tex[3 * NSLOT]; static int g_ntex;
static uint8_t g_texbits[0x2000u / 8u];       /* hash & 0x1fff of every g_tex: the override's quick no */
#ifndef ROAM_HOST_WIN
static uint32_t bhash(const char *s){ uint32_t h = 0xffffffffu; for (; *s; s++) h = h * 33u + (uint8_t)*s; return h; }  /* bStringHash 0x43DB50 */
static int8_t g_skin_ok[NSLOT + SKIN_GAME];   /* paint slot n: 1 its textures are there, -1 they could not be made */
#endif
uint32_t roam_game_texture(uint32_t h){
    if (!(g_texbits[(h & 0x1fffu) >> 3] & (1u << (h & 7u)))) return 0;
    for (int i = 0; i < g_ntex; i++) if (g_tex[i].hash == h) return g_tex[i].ti;
    return 0;
}
static int skin_textures(CPU *c, uint32_t n){
    if (n <= SKIN_GAME) return 1;
#ifdef ROAM_HOST_WIN
    (void)c; return 0;
#else
    if (n >= sizeof g_skin_ok) return 0;
    if (g_skin_ok[n]) return g_skin_ok[n] > 0;
    static const char *const fmt[3] = { "DUMMY_SKIN%u", "DUMMY_WHEEL%u", "DUMMY_SPINNER%u" };
    int had = 0, made = 0;
    for (int i = 0; i < 3 && g_ntex < 3 * NSLOT; i++){
        char nm[24];
        uint32_t src = 0;
        for (uint32_t t = 1; t <= SKIN_GAME && !src; t++){                                /* a slot that is there now */
            snprintf(nm, sizeof nm, fmt[i], (unsigned)t);
            uint32_t a[3] = { bhash(nm), 0, 0 };
            src = rh_call(c, FN_TEXINFO, 0, 0, 3, a);
            if (!ok(src, TI_SZ) || !ok(rd32(src), PLAT_SZ)) src = 0;
        }
        if (!src) continue;                                                               /* no spinners, say */
        had++;
        /* the pixels: mip 0's bytes, each further mip a quarter of the one before */
        uint32_t px = MR32(src + 0x40u), mips = MR8(src + 0x4eu), total = 0;
        for (uint32_t m = 0, b = px; m < (mips ? mips : 1u) && b; m++, b >>= 2) total += b > 16u ? b : 16u;
        if (!px || px > (16u << 20)){ rlog("[roam] f=%ld %s: %u bytes of pixels?\n", rh_frame(), nm, px); break; }
        uint32_t sz = TI_SZ + PLAT_SZ + total + 64u, ti = rh_call(c, FN_MALLOC, 0, 0, 1, &sz), pl = ti + TI_SZ;
        if (!ti) break;
        uint32_t pix = (pl + PLAT_SZ + 63u) & ~63u;
        memcpy(GPTR(ti), GPTR(src), TI_SZ); memcpy(GPTR(pl), GPTR(rd32(src)), PLAT_SZ);
        memset(GPTR(pix), 0, total);
        MR32(pl) = 0; MR32(pl + 4u) = 0; MR32(pl + 0x18u) = 0;
        snprintf(nm, sizeof nm, fmt[i], (unsigned)n);
        MR32(ti) = pl; MR32(ti + 0x24u) = bhash(nm); MR32(ti + 0x70u) = pix;
        for (uint32_t q = 0; q < 0x18u; q++) MR8(ti + 8u + q) = q < 0x17u && q < strlen(nm) ? (uint8_t)nm[q] : 0;   /* its name */
        if (MR32(ti + 0x6cu) == src) MR32(ti + 0x6cu) = ti;
        gcall0(c, FN_TEX_CREATE, ti);
        if (!rd32(pl + 0x18u)){ rlog("[roam] f=%ld %s: the game made no texture\n", rh_frame(), nm); break; }
        uint32_t h = MR32(ti + 0x24u);
        g_tex[g_ntex].hash = h; g_tex[g_ntex].ti = ti; g_ntex++;
        g_texbits[(h & 0x1fffu) >> 3] |= (uint8_t)(1u << (h & 7u));
        made++;
    }
    g_skin_ok[n] = had && made == had ? 1 : -1;
    if (g_skin_ok[n] > 0) rlog("[roam] f=%ld paint slot %u: %d textures of our own (the paint %ux%u, format 0x%02x, %u mips)\n", rh_frame(), n,
                               made, (unsigned)MR16(g_tex[g_ntex - made].ti + 0x44u), (unsigned)MR16(g_tex[g_ntex - made].ti + 0x46u),
                               (unsigned)MR8(g_tex[g_ntex - made].ti + 0x4au), (unsigned)MR8(g_tex[g_ntex - made].ti + 0x4eu));
    else rlog("[roam] f=%ld paint slot %u: its textures could not be made (%d of %d): no car in that slot\n", rh_frame(), n, made, had);
    return g_skin_ok[n] > 0;
#endif
}

/* ---- slots ------------------------------------------------------------------------------------ */
static uint32_t skin_of(uint32_t rec){ return rec >= G_RECORDS && rec < G_RECORDS + 22u * REC_SZ ? (rec - G_RECORDS) / REC_SZ + 1u : 0; }
/* slot k's paint slot: an opponent car's own (its record's place: 2-4), ours
 * 5 and up */
static uint32_t slot_skin(int k){
    if (k >= NOPP) return 5u + (uint32_t)(k - NOPP);
    uint32_t n = skin_of(g_sl[k].car ? rd32(g_sl[k].car + 0x14u) : 0);
    return n ? n : 2u + (uint32_t)k;
}
/* g_gmem: scratch for guest-call arguments (+0x40 a performance block, +0x80
 * a grid entry, +0x100 the name labels' vectors and strings), then the
 * slots' rides and records */
#define GM_SCRATCH 0x200u
static void gmem_init(CPU *c){
    if (g_gmem) return;
    uint32_t sz = NSLOT * (2u * RIDE_SZ + REC_SZ) + 0x100u + GM_SCRATCH;
    g_gmem = rh_call(c, FN_MALLOC, 0, 0, 1, &sz);
    if (!g_gmem){ rlog("[roam] guest malloc failed\n"); return; }
    for (uint32_t i = 0; i < sz; i += 4) MR32(g_gmem + i) = 0;
    for (int k = 0; k < NSLOT; k++){
        uint32_t b = ((g_gmem + 0xffu) & ~0xffu) + GM_SCRATCH;
        b += (uint32_t)k * (2u * RIDE_SZ + REC_SZ);
        g_sl[k].ride_new = b; g_sl[k].ride_orig = b + RIDE_SZ; g_sl[k].rec = b + 2u * RIDE_SZ;
    }
}
static void unload_later(uint32_t h){
    if (!h) return;
    if (g_npending < 3 * NSLOT) g_handles_pending[g_npending++] = h;
    else rlog("[roam] too many rides waiting to be unloaded, one kept\n");
}
static void set_name(Slot *s){
    uint32_t rec = s->car ? rd32(s->car + 0x14u) : 0;
    if (!ok(rec, 0x920)) return;
    for (int i = 0; i < 16; i++) MR8(rec + 0x90cu + (uint32_t)i) = i < 15 ? (uint8_t)s->name[i] : 0;
    MR8(rec + 0x90cu + 15u) = 0;
}
static void make_inert(CPU *c, uint32_t car){
    if (rd32(car + 0x24u) != 0) gcall1(c, FN_CAR_SETDRIVER, car, 0);
    if (rd32(car + 0x28u) != 0) gcall1(c, FN_CAR_SETPHYS, car, 0);
}
/* the car's collision body on or off: a disable count at +0x17 (0x5930F0
 * adds one, 0 is on) */
static void body_set(CPU *c, uint32_t car, int solid){
    uint32_t body = rd32(car + 0x3cu);
    if (!ok(body, 0x20)) return;
    if (!solid && MR8(body + 0x17u) == 0) gcall0(c, FN_BODY_DISABLE, body);
    else if (solid && MR8(body + 0x17u) != 0) MR8(body + 0x17u) = 0;
}
/* a shown friend's car: solid unless it is a ghost, and a ghost until it is
 * clear of the player's car */
static void body_update(CPU *c, int k){
    Slot *s = &g_sl[k];
    uint32_t me = player_car();
    if (O.collide && s->ghost && ok(me, 0x70)){
        float dx = MRF32(s->car + 0x60u) - MRF32(me + 0x60u), dy = MRF32(s->car + 0x64u) - MRF32(me + 0x64u),
              dz = MRF32(s->car + 0x68u) - MRF32(me + 0x68u);
        if (dx * dx + dy * dy + dz * dz > CLEAR_M * CLEAR_M){
            s->ghost = 0;
            rlog("[roam] f=%ld slot %d: %s's car is solid now\n", rh_frame(), k, s->name);
        }
    }
    body_set(c, s->car, O.collide && !s->ghost);
}
static void ghost_all(void){ for (int k = 0; k < NSLOT; k++) g_sl[k].ghost = 1; }
static void soft_park(CPU *c, uint32_t car){
    MRF32(car + 0x60u) = 0; MRF32(car + 0x64u) = 0; MRF32(car + 0x68u) = PARK_Z;
    MRF32(car + 0x50u) = 0; MRF32(car + 0x54u) = 0; MRF32(car + 0x58u) = PARK_Z;
    for (uint32_t o = 0x70u; o < 0x7cu; o += 4) MRF32(car + o) = 0;
    for (uint32_t o = 0x110u; o < 0x11cu; o += 4) MRF32(car + o) = 0;
    MRF32(car + 0x42cu) = 0; MRF32(car + 0x430u) = 0;
    gcall0(c, FN_CAR_SECTION, car);
}
/* The RandomEncounterManager (race coordinator +0xC40; Update 0x42EDF0):
 * state 0 resets it (0x412F90: its three rides unloaded, World cars[first ..
 * first+2] taken as its cars), 1 asks the career whether an outrun is due,
 * 3 cruises its cars near the player and tries to engage, 4 races, 5 parks
 * its cars -- 0x40BF60, and 0x40BFB0 for every car of the AI range that is
 * out, not engaged and 250 m away, friends' cars included -- tells the
 * career (0x500CA0) and goes to 0; at 6 and above Update does nothing.  It
 * drove a friend's car it had taken as its own into a fault (0x41C100 on a
 * null brain), so it never sees one:
 *  - while any friend has (or is about to get) a car in this world it is
 *    held in 6;
 *  - from 3 or 5 it is stood down the way its own state 5 does it, but for
 *    its three cars only: each is parked once it is engaged in an outrun or
 *    250 m from the player, or after 20 s anyway; then the career is told
 *    and it goes to 0, which re-reads its cars (the game's three opponent
 *    cars: ours are kept out of that window, keep_out_of_window) and then
 *    to 1, where it is held;
 *  - during an outrun (4) it is left alone (the race has two racers, so
 *    this is not free roam for roaming(): friends' cars are hidden, as in
 *    any race); its 5 afterwards is taken over as above;
 *  - a minute after the last friend left it is let go (6 -> 0). */
static void em_update(CPU *c, int want, int64_t host){
    uint32_t em = encounter_mgr();
    if (!em) return;
    uint32_t st = MR32(em);
    if (g_em == EM_HELD){ if (st != 6u) MR32(em) = 6u; return; }
    if (g_em == EM_STANDDOWN){
        MR32(em) = 6u;
        uint32_t me = player_car();
        int out = 0, parked = 0;
        for (uint32_t k = 0; k < 3; k++){
            uint32_t car = rd32(em + EM_TABLE + 0xcu + 0x10u * k);
            if (!ok(car, 0x9e0) || !car_out(car)) continue;
            float dx = me ? MRF32(car + 0x60u) - MRF32(me + 0x60u) : 1e4f, dy = me ? MRF32(car + 0x64u) - MRF32(me + 0x64u) : 0;
            if (MR8(car + 0x998u) || dx * dx + dy * dy > 250.f * 250.f || host - g_em_sd_t0 > EM_STANDDOWN_US){
                gcall0(c, FN_CAR_DEACTIVATE, car); MR8(em + EM_TABLE + 8u + 0x10u * k) = 0; parked++;
            } else out++;
        }
        if (parked) rlog("[roam] f=%ld outrun challengers: %d car(s) parked, %d still near you\n", rh_frame(), parked, out);
        if (!out){
            gcall0(c, FN_EM_OVER, G_ENCOUNTERS);
            MR32(em) = 0;                       /* its next Update resets it (state 0), then it is held at 1 */
            g_em = EM_GAME;
            rlog("[roam] f=%ld outrun challengers stood down after %.1f s\n", rh_frame(), (host - g_em_sd_t0) / 1e6);
        }
        return;
    }
    if (!want) return;
    if (st == 4u){                              /* an outrun is being raced: not interrupted */
        if (!g_em_racing_noted){ g_em_racing_noted = 1;
            rlog("[roam] f=%ld an outrun is on: the outrun challengers are stood down when it is over\n", rh_frame()); }
        return;
    }
    g_em_racing_noted = 0;
    if (st == 3u || st == 5u){
        MR32(em) = 6u; g_em = EM_STANDDOWN; g_em_sd_t0 = host;
        rlog("[roam] f=%ld outrun challengers off while friends are here: standing down (state %u)\n", rh_frame(), st);
        return;
    }
    MR32(em) = 6u; g_em = EM_HELD;              /* 0, 1, 2: its cars are parked */
    rlog("[roam] f=%ld outrun challengers off while friends are here (state %u)\n", rh_frame(), st);
}
/* a car of ours in the manager's window, World cars[first .. first+2] */
static int ours_in_window(uint32_t w){
    for (int i = 0; i < 3; i++){ uint32_t car = ai_car(w, i); if (car && !game_opponent(car)) return 1; }
    return 0;
}
static void em_let_go(void){
    uint32_t em = encounter_mgr(), w = world();
    if (g_em != EM_HELD || !em) return;
    if (g_em_pin || (w && ours_in_window(w))){
        static long said; if (rh_frame() - said > 7200){ said = rh_frame();
            rlog("[roam] f=%ld outrun challengers stay off: a car of ours is in their window\n", rh_frame()); }
        return;
    }
    if (MR32(em) == 6u){ MR32(em) = 0; rlog("[roam] f=%ld outrun challengers back on\n", rh_frame()); }
    g_em = EM_GAME;
}
/* a game opponent car that no slot uses (slots 0-2) */
static uint32_t free_opponent_car(uint32_t w){
    int n = (int)MR32(w + 0x18u) - (int)MR32(w + 0x14u);
    for (int i = 0; i < n && i < 22; i++){
        uint32_t car = ai_car(w, i);
        if (!car || !game_opponent(car) || car_out(car)) continue;
        int used = 0;
        for (int k = 0; k < NSLOT; k++) if (g_sl[k].car == car) used = 1;
        if (!used) return car;
    }
    return 0;
}
static int opp_slots_used(void){ int n = 0; for (int k = 0; k < NOPP; k++) if (g_sl[k].st != SL_FREE) n++; return n; }

/* the manager's state 0 takes World cars[first .. first+2] as its three
 * cars; IndexCars puts the AI racers in the order of the World's list, and
 * the game changes that order (one of ours had become
 * cars[first] after a reversal of the list).  Our cars go to the end of the
 * list, as CreateCar appends, and the cars are indexed again: then the three
 * game opponents come first.  Only IndexCars writes cars[], and the game
 * calls it only when it builds a world. */
static void keep_out_of_window(CPU *c, uint32_t w){
    if (!ours_in_window(w)) return;
    for (int k = NOPP; k < NSLOT; k++){
        uint32_t car = g_sl[k].car;
        if (!g_sl[k].created || g_sl[k].unindexed || g_sl[k].world != w || !ok(car, 0x10)) continue;
        uint32_t nx = rd32(car), pv = rd32(car + 4u);
        if (!ok(nx, 8) || !ok(pv, 8) || rd32(pv) != car || rd32(nx + 4u) != car) continue;   /* not linked as expected */
        MR32(pv) = nx; MR32(nx + 4u) = pv;                           /* unlink */
        uint32_t tail = MR32(w + 4u);
        MR32(tail) = car; MR32(w + 4u) = car; MR32(car) = w; MR32(car + 4u) = tail;   /* append */
    }
    gcall0(c, FN_INDEXCARS, w);
    int still = ours_in_window(w);
    if (still) g_em_pin = 1;
    rlog("[roam] f=%ld car(s) of our own moved after the game's opponent cars in the AI range [%u, %u)%s\n", rh_frame(),
            MR32(w + 0x14u), MR32(w + 0x18u), still ? ": STILL in the outrun manager's window, it stays off in this world" : "");
}
/* forget every slot of a world that is gone (its cars were freed with it) */
static void world_gone(void){
    for (int k = 0; k < NSLOT; k++){
        Slot *s = &g_sl[k];
        if (s->h_cur) unload_later(s->h_cur);
        if (s->h_new) unload_later(s->h_new);
        if (s->h_orig) unload_later(s->h_orig);
        uint32_t rn = s->ride_new, ro = s->ride_orig, rec = s->rec;
        memset(s, 0, sizeof *s);
        s->ride_new = rn; s->ride_orig = ro; s->rec = rec;
    }
    g_created_n = 0; g_em = EM_GAME; g_em_pin = 0; g_em_racing_noted = 0; g_em_release_at = 0;
}
static void flush_unloads(CPU *c){
    for (int i = 0; i < g_npending; i++) gcall1(c, FN_LOADER_UNLOAD, G_CARLOADER, g_handles_pending[i]);
    if (g_npending) rlog("[roam] f=%ld %d ride(s) of friends' cars unloaded\n", rh_frame(), g_npending);
    g_npending = 0;
}
/* leaving free roam with the world still there: park the cars (rides stay
 * until the world is gone) */
static void park_all(CPU *c){
    for (int k = 0; k < NSLOT; k++){
        Slot *s = &g_sl[k];
        if (s->st == SL_ACTIVE && ok(s->car, 0x9e0) && !s->hidden){ soft_park(c, s->car); s->hidden = 1; }
    }
}
/* the friend is gone (left, timed out, or away too long): the car is
 * hidden but keeps the friend's ride for a while (SL_PARKED) */
static void release(CPU *c, int k, const char *why){
    Slot *s = &g_sl[k];
    if (s->st == SL_FREE || s->st == SL_PARKED) return;
    rlog("[roam] f=%ld slot %d: %s's car removed (%s)\n", rh_frame(), k, s->name, why);
    g_releases++;
    if (s->h_new){ unload_later(s->h_new); s->h_new = 0; s->pending_cfg = 0; }
    if (s->st == SL_CREATING){                      /* not made yet: forget it */
        if (s->h_orig) unload_later(s->h_orig);
        s->h_orig = 0; s->st = SL_FREE; s->peer = -1; s->peer_id = 0;
        return;
    }
    if (ok(s->car, 0x9e0) && s->h_cur){
        if (!s->hidden){ soft_park(c, s->car); s->hidden = 1; }
        s->st = SL_PARKED;
    } else s->st = SL_FREE;                          /* nothing of the friend's on it */
    s->peer = -1; s->peer_id = 0; s->unseen_since = 0; s->name[0] = 0;
    if (s->st == SL_FREE && k < NOPP){ s->car = 0; s->world = 0; }
}
/* the car gets its own ride back (still resident: the world, or for a car
 * of our own its first load, holds it), is deactivated, and the friend's
 * ride is unloaded */
static void restore(CPU *c, int k){
    Slot *s = &g_sl[k];
    if (s->st != SL_PARKED) return;
    if (ok(s->car, 0x9e0) && s->have_orig && s->activated){
        body_set(c, s->car, 1);
        gcall1(c, FN_CAR_SETRIDE, s->car, s->ride_orig);
        gcall0(c, FN_CAR_DEACTIVATE, s->car);
        s->activated = 0;
    }
    if (s->h_cur) gcall1(c, FN_LOADER_UNLOAD, G_CARLOADER, s->h_cur);
    Slot keep = *s;
    memset(s, 0, sizeof *s);
    s->ride_new = keep.ride_new; s->ride_orig = keep.ride_orig; s->rec = keep.rec; s->peer = -1;
    if (keep.created){                              /* the car stays ours, parked, for the next friend */
        s->car = keep.car; s->created = 1; s->unindexed = keep.unindexed; s->world = keep.world; s->h_orig = keep.h_orig;
        s->have_orig = keep.have_orig;
        memcpy(s->com, keep.com, sizeof s->com);
    }
    rlog("[roam] f=%ld slot %d: car back to its own ride\n", rh_frame(), k);
}
/* Room in the Cars pool for one more ride (3.6 MB), for a friend's new look
 * and for a car of our own alike.  An earlier look's ride, once unloaded,
 * stays in the loader with no reference: its model keeps its pool memory
 * until the loader runs short, and then the loader's own purge also evicts
 * composited skins (phase 1, the black player car of research §5.4).  So the
 * pool fills after about a dozen car types in one world and every new look
 * would be refused.  The unreferenced entries go first (phase 0, one per
 * call); entries in use (the player's, traffic's, parked friends' cars) are
 * not touched.  No room: logged once per friend every 1,200 frames. */
#define POOL_NEED (3600u * 1024u)
static struct { uint32_t id; long next; } g_memnote[RC_TABLE];
static int pool_room(CPU *c, const Slot *s, const char *car /* 0: a car of our own */){
    if (pool_free() >= POOL_NEED) return 1;
    int n = 0;
    while (pool_free() < POOL_NEED && n < 64 && (gcall1(c, FN_LOADER_PURGE, G_CARLOADER, 0) & 0xffu)) n++;
    if (n){ rlog("[roam] f=%ld car pool: %d unused model(s) unloaded\n", rh_frame(), n); pool_log("unloaded"); }
    if (pool_free() >= POOL_NEED) return 1;
    int i = s->peer >= 0 && s->peer < RC_TABLE ? s->peer : 0;
    if (g_memnote[i].id != s->peer_id || rh_frame() >= g_memnote[i].next){
        g_memnote[i].id = s->peer_id; g_memnote[i].next = rh_frame() + 1200;
        if (car) rlog("[roam] f=%ld not enough car memory for %s's %s (%u KB free): not shown (raise NFSU2_ROAM_CARPOOL_KB)\n",
                         rh_frame(), s->name, car, pool_free() / 1024u);
        else rlog("[roam] f=%ld not enough car memory for a car of our own for %s (%u KB free): not shown (raise NFSU2_ROAM_CARPOOL_KB)\n",
                  rh_frame(), s->name, pool_free() / 1024u);
        pool_log("full");
    }
    return 0;
}
/* A racer number no car of this world has and no car of ours being made
 * (a signed byte): 103 to 127, then 99 down to 66 (the player has 0, the
 * opponent cars 100 to 102, traffic from 50).  The minimap finds a car by it
 * (0x5F0E30, the first on the World's list), so each must be its own. */
static int racer_number_used(uint32_t w, int n){
    uint32_t it = rd32(w);
    for (int m = 0; it && it != w && m < 128 && ok(it, 0x9e0); m++, it = rd32(it)) if ((int16_t)MR16(it + 0xau) == n) return 1;
    for (int k = NOPP; k < NSLOT; k++) if ((g_sl[k].st == SL_CREATING || g_sl[k].created) && (int8_t)MR8(g_sl[k].rec + 1u) == n) return 1;
    return 0;
}
static int racer_number(uint32_t w){
    for (int n = 103; n <= 127; n++) if (!racer_number_used(w, n)) return n;
    for (int n = 99; n >= 66; n--) if (!racer_number_used(w, n)) return n;
    return 127;
}
/* a car of our own (slots 3 and up): a copy of the first opponent's racer
 * record (a racer number of its own, paint slot 5 and up), its ride loaded
 * through the CarLoader, then CreateCar (finish_create); the friend's ride
 * follows as for an opponent car */
static int begin_create(CPU *c, int k){
    Slot *s = &g_sl[k];
    uint32_t w = world(), opp = 0;
    for (int i = 0; w && i < 22 && !opp; i++){ uint32_t car = ai_car(w, i); if (car && game_opponent(car)) opp = car; }
    uint32_t orec = opp ? rd32(opp + 0x14u) : 0;
    if (!ok(orec, REC_SZ) || !g_gmem) return 0;
    if (!skin_textures(c, slot_skin(k))) return 0;
    if (!pool_room(c, s, 0)) return 0;
    int rn = racer_number(w);
    memcpy(GPTR(s->rec), GPTR(orec), REC_SZ);
    MR8(s->rec + 1u) = (uint8_t)rn; MR8(s->rec + 0x900u) = 0;
    gcall1(c, FN_RIDE_SKINS, s->rec + 0x10u, slot_skin(k));
    uint32_t a3[3] = { s->rec + 0x10u, 0, 0 };
    s->load_wait = load_wait_us();
    s->h_orig = rh_call(c, FN_LOADER_LOAD, G_CARLOADER, 0, 3, a3);
    uint32_t a2[2] = { 0, 0 }; rh_call(c, FN_LOADER_SERVICE, G_CARLOADER, 0, 2, a2);
    s->load_t0 = roam_plat_now_us(); s->load_f0 = rh_frame();
    return 1;
}
static int finish_create(CPU *c, int k){
    Slot *s = &g_sl[k];
    uint32_t e = loader_entry(s->h_orig);
    uint32_t done = e ? gcall1(c, FN_LOADER_LOADED, G_CARLOADER, e) : 0;
    if (!done){
        if (roam_plat_now_us() - s->load_t0 > s->load_wait){ unload_later(s->h_orig); s->h_orig = 0; g_load_fail++; return -1; }
        return 0;
    }
    gcall1(c, FN_LOADER_WAIT, G_CARLOADER, s->h_orig);
    uint32_t w = world(), me = player_car();
    if (!w || !me) return -1;
    uint32_t grid = g_gmem + 0x80u;                          /* scratch: the grid entry {vec3, +0x10 heading} */
    for (uint32_t i = 0; i < 0x20u; i += 4) MR32(grid + i) = 0;
    MRF32(grid) = MRF32(me + 0x60u) + 6.f; MRF32(grid + 4) = MRF32(me + 0x64u); MRF32(grid + 8) = MRF32(me + 0x68u) + 0.5f;
    /* World::IndexCars writes cars[] without a bound, and the World's
     * fields follow its 22 entries: a car past them is of a kind IndexCars
     * skips, on the World's list only (the renderer walks the list; nothing
     * reads the debug arrays its index 0 writes, 0x89CCF8) */
    uint32_t n0 = MR32(w + 0x10u), a2[2] = { 0, 0 };
    int out = n0 >= WORLD_INDEX || O.test_outside;
    if (out) MR32(s->rec + 4u) = KIND_OUT;
    rh_call(c, FN_CREATECAR, grid, s->rec, 2, a2);
    if (!out) gcall0(c, FN_INDEXCARS, w);
    /* the new car is the one on the World's list with our racer record
     * (CreateCar's eax is not the car) */
    uint32_t car = 0, it = rd32(w);
    for (int n = 0; it && it != w && n < 128 && ok(it, 0x9e0); n++, it = rd32(it)) if (rd32(it + 0x14u) == s->rec) car = it;
    if (!car){ rlog("[roam] f=%ld slot %d: CreateCar made no car\n", rh_frame(), k); return -1; }
    s->car = car; s->created = 1; s->unindexed = out; s->world = w; s->activated = 1; g_created_n++; g_creates++;
    if (!out){
        keep_out_of_window(c, w);
        /* the minimap makes its icons when the HUD is built: an AI racer's
         * arrow for each car of the World's AI range then (by racer number,
         * 0x4EC950), so a car made later has none.  They are made again, now
         * with this one */
        gcall0(c, FN_MM_REBUILD, 0);
    }
    memcpy(GPTR(s->ride_orig), GPTR(s->rec + 0x10u), 0x8f0); s->have_orig = 1;
    make_inert(c, car);
    body_set(c, car, 0); s->ghost = 1;
    soft_park(c, car);
    rlog("[roam] f=%ld slot %d: car of our own created: car 0x%08x, %s, cars %u -> %u, AI range [%u, %u)\n", rh_frame(), k,
            car, out ? "outside the car index" : "indexed", n0, MR32(w + 0x10u), MR32(w + 0x14u), MR32(w + 0x18u));
    return 1;
}
/* start loading peer's ride for slot k */
static int begin_load(CPU *c, int k, const uint8_t *cfg, int len, uint32_t gen){
    Slot *s = &g_sl[k];
    rc_carcfg cc;
    if (rc_carcfg_decode(cfg, len, &cc) != RC_OK) return 0;
    uint32_t skin = slot_skin(k);
    if (!skin_textures(c, skin)) return 0;
    if (!pool_room(c, s, cc.type_name)) return 0;
    uint32_t ride = s->ride_new;
    char why[96] = {0};
    int miss = build_ride(c, &cc, ride, skin, why, sizeof why);
    if (miss < 0) return 0;
    if (rh_opt("NFSU2_ROAM_TEST_COPYRIDE")){
        /* test control: the player's own RideInfo byte for byte (same car
         * type only), the slot's skin number: rebuilt vs. copied looks */
        uint32_t me = player_car(), own = me ? rd32(me + 0x10u) : 0;
        if (ok(own, 0x8f0) && MR32(own) == MR32(ride)){
            memcpy(GPTR(ride), GPTR(own), 0x8f0); gcall1(c, FN_RIDE_SKINS, ride, skin);
            rlog("[roam] f=%ld slot %d: TEST: the player's own ride copied instead of the rebuilt one\n", rh_frame(), k); }
    }
    if (why[0]) rlog("[roam] f=%ld slot %d: %s's car: %s\n", rh_frame(), k, s->name, why);
    uint32_t a3[3] = { ride, 0, 0 };
    s->load_wait = load_wait_us();
    s->h_new = rh_call(c, FN_LOADER_LOAD, G_CARLOADER, 0, 3, a3);
    uint32_t a2[2] = { 0, 0 }; rh_call(c, FN_LOADER_SERVICE, G_CARLOADER, 0, 2, a2);
    s->load_t0 = roam_plat_now_us(); s->load_f0 = rh_frame(); s->pending_cfg = 1; s->cfg_gen = gen;
    s->look = rc_fnv1a_bytes(cfg, (uint32_t)len);
    snprintf(s->carname, sizeof s->carname, "%s", cc.type_name);
    s->loads++;
    rlog("[roam] f=%ld slot %d: loading %s's %s (%u parts, skin %u, handle 0x%x)\n", rh_frame(), k, s->name,
            cc.type_name, cc.n_parts, skin, s->h_new);
    return 1;
}
/* the loading ride is in: put it on the slot's car */
static int finish_load(CPU *c, int k){
    Slot *s = &g_sl[k];
    uint32_t e = loader_entry(s->h_new);
    uint32_t done = e ? gcall1(c, FN_LOADER_LOADED, G_CARLOADER, e) : 0;
    if (!done){
        if (roam_plat_now_us() - s->load_t0 > s->load_wait){
            rlog("[roam] f=%ld slot %d: %s's car did not load in %.0f s\n", rh_frame(), k, s->name, s->load_wait / 1e6);
            unload_later(s->h_new); s->h_new = 0; s->pending_cfg = 0; g_load_fail++;
            return -1;
        }
        return 0;
    }
    gcall1(c, FN_LOADER_WAIT, G_CARLOADER, s->h_new);
    uint32_t car = s->car;
    if (!s->have_orig){                             /* an opponent car, first time: keep its own ride */
        memcpy(GPTR(s->ride_orig), GPTR(rd32(car + 0x14u) + 0x10u), 0x8f0);
        s->have_orig = 1;
    }
    if (!s->activated){ gcall0(c, FN_CAR_ACTIVATE, car); s->activated = 1; }
    gcall1(c, FN_CAR_SETRIDE, car, s->ride_new);
    make_inert(c, car);
    body_set(c, car, 0); s->ghost = 1;
    soft_park(c, car);
    if (s->h_cur) gcall1(c, FN_LOADER_UNLOAD, G_CARLOADER, s->h_cur);
    s->h_cur = s->h_new; s->h_new = 0;
    s->pending_cfg = 0; s->hidden = 1;
    /* the renderer draws a car at +0x50 (with the matrix copy at +0xD0),
     * the body position minus the centre-of-mass offset; the game sets it
     * in 0x5F5010 (when a car lands on loaded track, or is placed), so a
     * car moved from outside needs it every frame.  The offset is fixed in
     * the car's own frame: the player's car has +0x60 - +0x50 = R (0.30, 0,
     * 0.30) for a 206 at every heading (its physics object's world vector),
     * while for a car without physics 0x5F5010 subtracts the RidePhysicsInfo
     * vector ([+0x20]) as it is, unrotated -- so the value measured here is
     * the body-frame vector, and apply_pose rotates it with the car
     * (written unrotated, the drawn car was 0.2 to 0.6 m
     * off where the friend's own game draws it) */
    gcall0(c, FN_CAR_BODYPOS, s->car);
    for (int i = 0; i < 3; i++){ s->com[i] = MRF32(s->car + 0x60u + 4u * (uint32_t)i) - MRF32(s->car + 0x50u + 4u * (uint32_t)i);
        if (!__builtin_isfinite(s->com[i]) || __builtin_fabsf(s->com[i]) > 3.f) s->com[i] = 0; }
    soft_park(c, s->car);
    set_name(s);
    char tn[20]; cstr(rd32(s->car + 0xcu), tn, sizeof tn);
    rlog("[roam] f=%ld slot %d: %s's %s ready after %ld frames (%.0f ms); car 0x%08x is now a %s (centre of mass %.2f %.2f %.2f)\n",
            rh_frame(), k, s->name, s->carname, rh_frame() - s->load_f0, (roam_plat_now_us() - s->load_t0) / 1000.0, s->car, tn,
            (double)s->com[0], (double)s->com[1], (double)s->com[2]);
    pool_log("after load");
    return 1;
}
/* sin and cos of a in [-pi, pi] (Taylor to the x^15 / x^14 term, < 1e-5),
 * from basic operations: this file has no libm */
static void sincos_pi(float a, float *sn, float *cs){
    float x2 = a * a;
    *sn = a * (1.f - x2 / 6.f * (1.f - x2 / 20.f * (1.f - x2 / 42.f * (1.f - x2 / 72.f * (1.f - x2 / 110.f *
               (1.f - x2 / 156.f * (1.f - x2 / 210.f)))))));
    *cs = 1.f - x2 / 2.f * (1.f - x2 / 12.f * (1.f - x2 / 30.f * (1.f - x2 / 56.f * (1.f - x2 / 90.f *
               (1.f - x2 / 132.f * (1.f - x2 / 182.f))))));
}
/* The wheels.  The renderer draws each wheel with its matrix in the car,
 * +0x130 + 0x40 k for front left, front right, rear right, rear left (rows:
 * forward, left, up, then the wheel's place, which is left alone), and the
 * front brake calipers with +0x230 / +0x270; the game's physics writes them
 * (the spin about the axle and the steering of the front wheels), and in
 * physics mode 0 they stand still.  Spin: the wheel's angle goes down by
 * speed / tyre radius (RidePhysicsInfo +0x20 + 0x30 k) as the car goes
 * forward.  Steering: the friend's own, the controls' +0x1e0 that goes on the
 * wire as steer.  It is the angle the game's physics turns the front wheels
 * to over a few frames, 16 bits to a full turn (steer 1 = 180 degrees, left
 * positive), speed-dependent lock included (car dumps: the caliper settles at
 * 180 degrees x steer at speed under the game's autopilot, and at 45 degrees
 * for the keys' full lock standing still); so whatever the friend steers
 * shows, counter-steer and standing still too.  Smoothed over 80 ms, at most
 * 0.8 rad. */
static void wheels_pose(Slot *s, const rc_pose *P, float dt){
    uint32_t car = s->car, ph = MR32(car + 0x20u);
    if (!(dt > 0.f)) dt = 0.f;
    if (dt > 0.1f) dt = 0.1f;
    float v = P->speed, want = P->steer * 3.14159265f;
    if (want > 0.8f) want = 0.8f;
    if (want < -0.8f) want = -0.8f;
    float k = dt / 0.08f;
    s->steer += (want - s->steer) * (k < 1.f ? k : 1.f);
    if (!__builtin_isfinite(s->steer)) s->steer = 0.f;
    float ss, cs; sincos_pi(s->steer, &ss, &cs);
    for (uint32_t w = 0; w < 4; w++){
        float r = ok(ph, 0xc0) ? MRF32(ph + 0x20u + 0x30u * w) : 0.f;
        if (!(r > 0.05f && r < 2.f)) r = 0.33f;
        float d = v / r * dt;                                        /* at most 100 m/s: a few turns per frame */
        if (!__builtin_isfinite(d) || d > 32.f || d < -32.f) d = 0.f;
        float a = s->spin[w] - d;
        while (a > 3.14159265f) a -= 6.28318531f;
        while (a < -3.14159265f) a += 6.28318531f;
        s->spin[w] = a;
        float sa, ca; sincos_pi(a, &sa, &ca);
        float sy = w < 2 ? ss : 0.f, cy = w < 2 ? cs : 1.f;
        uint32_t m = car + 0x130u + 0x40u * w;
        MRF32(m + 0x00u) = ca * cy;  MRF32(m + 0x04u) = ca * sy;  MRF32(m + 0x08u) = sa;
        MRF32(m + 0x10u) = -sy;      MRF32(m + 0x14u) = cy;       MRF32(m + 0x18u) = 0.f;
        MRF32(m + 0x20u) = -sa * cy; MRF32(m + 0x24u) = -sa * sy; MRF32(m + 0x28u) = ca;
        if (w < 2){
            uint32_t b = car + 0x230u + 0x40u * w;
            MRF32(b + 0x00u) = cy;  MRF32(b + 0x04u) = sy;
            MRF32(b + 0x10u) = -sy; MRF32(b + 0x14u) = cy;
        }
    }
}
static void apply_pose(CPU *c, Slot *s, const rc_pose *P, float dt){
    uint32_t car = s->car;
    float f[3], l[3], u[3];
    rc_q2m(P->q, f, l, u);
    for (int i = 0; i < 3; i++){
        uint32_t o = 4u * (uint32_t)i;
        MRF32(car + 0x60u + o) = P->p[i];
        MRF32(car + 0x50u + o) = P->p[i] - (s->com[0] * f[i] + s->com[1] * l[i] + s->com[2] * u[i]);
        MRF32(car + 0x70u + o) = P->v[i]; MRF32(car + 0x110u + o) = P->w[i];
        MRF32(car + 0x90u + o) = f[i]; MRF32(car + 0xa0u + o) = l[i]; MRF32(car + 0xb0u + o) = u[i];
        MRF32(car + 0xd0u + o) = f[i]; MRF32(car + 0xe0u + o) = l[i]; MRF32(car + 0xf0u + o) = u[i];
    }
    MR16(car + 0x40cu) = (uint16_t)(int)(rc_atan2f(f[1], f[0]) / (2.f * 3.14159265f) * 65536.f);
    MRF32(car + 0x42cu) = P->speed; MRF32(car + 0x430u) = P->speed; MRF32(car + 0x440u) = P->rpm;
    MR32(car + 0x434u) = (uint32_t)(int32_t)P->gear;
    uint32_t ph = MR32(car + 0x20u);
    if (ok(ph, 0xc0)) for (uint32_t w = 0; w < 4; w++){ float r = MRF32(ph + 0x20u + 0x30u * w); if (r > 0.05f) MRF32(car + 0x330u + 4u * w) = P->speed / r; }
    uint32_t ctl = MR32(car + 0x30u);
    if (ok(ctl, 0x220)){
        MRF32(ctl + 0x20cu) = P->throttle; MRF32(ctl + 0x214u) = P->brake;
        MR16(ctl + 0x1e0u) = (uint16_t)(int16_t)(P->steer * 32767.f);
    }
    if (rd32(car + 0x28u) != 0){ gcall1(c, FN_CAR_SETPHYS, car, 0); s->remode++; }
    gcall1(c, FN_ROADTRACK, car + 0x8d8u, car + 0x60u);
    gcall0(c, FN_CAR_SECTION, car);
    wheels_pose(s, P, dt);
    s->pose_frames++;
}

/* ---- names over friends' cars --------------------------------------------------------------------- */
/* In the game's own LAN races the HUD's online part (made by 0x4F80E0 for a
 * network race only) owns the HUD package's text objects ONLINE_PLAYER_1..6,
 * and its update (0x4EBEC0, from the HUD update) puts each player's name
 * 1.7 m above their car through the player's view: hidden behind the
 * camera, off the screen and from 100 m on, scaled 25 m / distance within
 * 0.5 .. 1, and all of them while the game's player-names option is off.
 * In free roam that part does not exist and nothing uses the objects, so
 * friends' cars get them the same way, from the same point of the frame
 * (roam_game_hud, after the HUD update: this frame's camera), the nearest
 * cars first.  Past the six, copies of ONLINE_PLAYER_1 (fe_clone). */
#define G_VIEW1         0x00832e50u   /* eView 1: [+0] +0x80 view*projection, +0x40 camera (+0x40 position, +0x50 forward) */
#define G_VIEW_W        0x00870980u   /* view size in pixels (0x5BC1F0, 0x5BC200) */
#define G_VIEW_H        0x00870984u
#define G_SHOW_NAMES    0x008500c9u   /* byte: the player-names option */
#define PL_HUD          0x9a4u        /* Player: the HUD, +0x10 its package's name */
#define FN_FE_HASH      0x00505450u   /* cdecl (name) -> hash (upper case) */
#define FN_FE_FIND      0x00537a10u   /* cdecl (package name, hash) -> FE object */
#define FN_FE_PRINTF    0x00537be0u   /* cdecl (object, format, ...) */
#define FN_FE_SETSTR    0x00535fe0u   /* thiscall object (char*): its text, the string grown to fit */
#define FN_FE_COLOR     0x00517e20u   /* thiscall object (int rgba[4]*, 0) */
#define FN_FE_POS       0x00517c10u   /* thiscall object (float xyz*, 0): HUD units from the centre */
#define FN_FE_SCALE     0x00517db0u   /* thiscall object (float xyz*, 0) */
#define FN_FE_SHOW      0x0050ca50u   /* cdecl (object) */
#define FN_FE_HIDE      0x0050ca00u   /* cdecl (object) */
#define FN_VIEW_SCREEN  0x005bc4a0u   /* thiscall view (out*, in*): world -> view pixels, z > 0 in front */
#define TAG_SCR         0x100u        /* g_gmem scratch: +0 in, +0x10 out, +0x20 vectors, +0x40 "%s", +0x48 text */
#define TAG_TEXT_MAX    (RC_NAME_MAX + 10)  /* "<name> (paused)" */
#define TAG_GAME        6             /* the HUD's ONLINE_PLAYER_1..6 */
#define TAG_N           NSLOT
#define TAG_DUEL        TAG_N         /* one more: the outrun's line of text (du_hud) */
#define TAG_DUEL_MAX    80
static struct { uint32_t hud, obj[TAG_N + 1]; uint8_t looked[TAG_N + 1], shown[TAG_N + 1]; char text[TAG_N + 1][TAG_DUEL_MAX]; } g_tag;
static void gstr(uint32_t a, const char *s, uint32_t cap){
    uint32_t i = 0;
    for (; s[i] && i + 1 < cap; i++) MR8(a + i) = (uint8_t)s[i];
    MR8(a + i) = 0;
}
static uint32_t gvec(uint32_t a, float x, float y, float z){ MRF32(a) = x; MRF32(a + 4u) = y; MRF32(a + 8u) = z; return a; }
static void tag_hide(CPU *c, int k){
    if (g_tag.shown[k] && g_tag.obj[k]) gcall1(c, FN_FE_HIDE, 0, g_tag.obj[k]);
    g_tag.shown[k] = 0;
}
/* A copy of FE object o of package pkg, named `name`: its class's Clone
 * (vtable slot 1, thiscall (1): its scripts copied too; its render object,
 * +0x58, which that leaves unset, made by the renderer as for a new object),
 * the hash the package's lookups compare (+0x10), and linked after o in the
 * list that holds it: the package's own (FEPackage +0x48 count, +0x4C first,
 * +0x50 last) or a group's (type 5: +0x60, +0x64, +0x68), each object's +4
 * next, +8 previous.  The FE renderer draws what those lists hold and the
 * package frees it with the rest.  0 when the list is not as expected. */
#define FN_FE_PACKAGE   0x0052cef0u   /* cdecl (package name) -> FEPackage* */
#define FN_FE_FINDOBJ   0x005379c0u   /* cdecl (package name, hash) -> FE object of any type */
static uint32_t fe_list_of(uint32_t first, uint32_t o, int depth){   /* the address of the list's "first" that holds o */
    int n = 0;
    for (uint32_t it = rd32(first); it && n < 4096; it = rd32(it + 4u), n++){
        if (it == o) return first;
        if (depth < 8 && rd32(it + 0x18u) == 5u){ uint32_t l = fe_list_of(it + 0x64u, o, depth + 1); if (l) return l; }
    }
    return 0;
}
static uint32_t fe_clone(CPU *c, uint32_t pkg, uint32_t o, const char *name){
    uint32_t pk = gcall1(c, FN_FE_PACKAGE, 0, pkg), l = ok(pk, 0x54) ? fe_list_of(pk + 0x4cu, o, 0) : 0;
    if (!l || !ok(rd32(o), 8)) return 0;
    uint32_t n = 0, last = 0;
    for (uint32_t it = rd32(l); it && n < 4096; it = rd32(it + 4u)){ last = it; n++; }
    if (n != rd32(l - 4u) || last != rd32(l + 4u)) return 0;          /* not the count and last we take it for */
    uint32_t one = 1, cl = rh_call(c, rd32(rd32(o) + 4u), o, 0, 1, &one);
    if (!ok(cl, 0x5c)) return 0;
    MR32(cl + 0x58u) = 0;
    uint32_t sa = g_gmem + TAG_SCR + 0x48u;
    gstr(sa, name, 24);
    MR32(cl + 0x10u) = gcall1(c, FN_FE_HASH, 0, sa);
    uint32_t nx = rd32(o + 4u);
    MR32(cl + 4u) = nx; MR32(cl + 8u) = o; MR32(o + 4u) = cl;
    if (nx) MR32(nx + 8u) = cl; else MR32(l + 4u) = cl;
    MR32(l - 4u) += 1;
    return cl;
}
/* the label's FE object, looked up (or made) once per HUD */
static uint32_t tag_obj(CPU *c, int k, uint32_t pkg){
    if (g_tag.looked[k]) return g_tag.obj[k];
    g_tag.looked[k] = 1;
    if (k >= TAG_GAME){
        uint32_t o1 = tag_obj(c, 0, pkg);
        char nm[24]; snprintf(nm, sizeof nm, k == TAG_DUEL ? "ROAM_OUTRUN" : "ROAM_PLAYER_%d", k + 1);   /* past the HUD's six: copies of the first */
        g_tag.obj[k] = o1 ? fe_clone(c, pkg, o1, nm) : 0;
        if (!g_tag.obj[k] && k == TAG_DUEL) rlog("[roam] f=%ld no copy of ONLINE_PLAYER_1 for the outrun's line of text\n", rh_frame());
        else if (!g_tag.obj[k]) rlog("[roam] f=%ld no copy of ONLINE_PLAYER_1 for name %d: one name fewer over friends' cars\n", rh_frame(), k + 1);
        return g_tag.obj[k];
    }
    char nm[24]; snprintf(nm, sizeof nm, "ONLINE_PLAYER_%d", k + 1);
    uint32_t sa = g_gmem + TAG_SCR + 0x48u;
    gstr(sa, nm, 24);
    uint32_t h = gcall1(c, FN_FE_HASH, 0, sa), a[2] = { pkg, h };
    g_tag.obj[k] = rh_call(c, FN_FE_FIND, 0, 0, 2, a);
    if (!ok(g_tag.obj[k], 0x70)) g_tag.obj[k] = 0;
    if (!g_tag.obj[k]) rlog("[roam] f=%ld no %s in the HUD: one name fewer over friends' cars\n", rh_frame(), nm);
    return g_tag.obj[k];
}
static void tag_text(CPU *c, int k, uint32_t obj, const char *name){
    if (!strcmp(g_tag.text[k], name)) return;
    snprintf(g_tag.text[k], sizeof g_tag.text[k], "%s", name);
    uint32_t col = g_gmem + TAG_SCR + 0x20u, fmt = g_gmem + TAG_SCR + 0x40u, txt = g_gmem + TAG_SCR + 0x48u;
    for (uint32_t i = 0; i < 4; i++) MR32(col + 4u * i) = 0xffu;               /* white, as 0x4F80E0 */
    uint32_t ac[2] = { col, 0 }; rh_call(c, FN_FE_COLOR, obj, 0, 2, ac);
    MR32(obj + 0x6cu) = (MR32(obj + 0x6cu) & ~0xfu) | 5u;                     /* centred */
    MR32(obj + 0x1cu) |= 0x100u;
    gstr(fmt, "%s", 4); gstr(txt, name, TAG_DUEL_MAX);
    if (k == TAG_DUEL){
        /* FEPrintf keeps a text within the object's string as it is (20 for
         * ONLINE_PLAYER_1's); the string's own setter, which it calls, grows it */
        gcall1(c, FN_FE_SETSTR, obj, txt);
        MR32(obj + 0x1cu) |= 2u;
        return;
    }
    uint32_t ap[3] = { obj, fmt, txt }; rh_call(c, FN_FE_PRINTF, 0, 0, 3, ap);
}
static void tags_update(CPU *c){
    uint32_t pl = rd32(G_PLAYER1), hud = pl && ok(pl, PL_HUD + 4u) ? rd32(pl + PL_HUD) : 0;
    uint32_t pkg = hud && ok(hud, 0x14) ? rd32(hud + 0x10u) : 0;
    if (hud != g_tag.hud){                          /* another HUD: its own objects (the old ones went with it) */
        memset(&g_tag, 0, sizeof g_tag);
        g_tag.hud = hud;
    }
    if (!hud || !ok(pkg, 0x20) || !g_gmem) return;
    uint32_t cam = rd32(G_VIEW1 + 0x40u);
    int on = O.labels && g_in_roam && MR8(G_SHOW_NAMES) && ok(cam, 0x60);
    /* the cars a name shows on: in front of the camera, within 100 m and on
     * the screen; the nearest TAG_N of them get one */
    struct { int k; float d2, hx, hy, z; } t[NSLOT];
    int n = 0;
    for (int k = 0; on && k < NSLOT; k++){
        Slot *s = &g_sl[k];
        if (s->st != SL_ACTIVE || s->hidden || !s->name[0] || !ok(s->car, 0x9e0)) continue;
        uint32_t car = s->car;
        float p[3], u[3], d[3];
        rd3(car + 0x60u, p); rd3(car + 0xb0u, u);
        for (int i = 0; i < 3; i++) d[i] = p[i] - MRF32(cam + 0x40u + 4u * (uint32_t)i);
        float ahead = d[0] * MRF32(cam + 0x50u) + d[1] * MRF32(cam + 0x54u) + d[2] * MRF32(cam + 0x58u);
        float d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        if (ahead < 0.f || !(d2 > 0.f) || !(d2 < 100.f * 100.f)) continue;
        uint32_t in = gvec(g_gmem + TAG_SCR, u[0] * 1.7f + p[0], u[1] * 1.7f + p[1], u[2] * 1.7f + p[2]);
        uint32_t out = g_gmem + TAG_SCR + 0x10u, av[2] = { out, in };
        rh_call(c, FN_VIEW_SCREEN, G_VIEW1, 0, 2, av);
        float x = MRF32(out), y = MRF32(out + 4u), z = MRF32(out + 8u);
        float w = (float)(int32_t)MR32(G_VIEW_W), h = (float)(int32_t)MR32(G_VIEW_H);
        if (!(z > 0.f) || !(x >= 0.f) || !(x <= w) || !(y >= 0.f) || !(y <= h)) continue;
        int j = n++;
        for (; j > 0 && t[j - 1].d2 > d2; j--) t[j] = t[j - 1];      /* nearest first */
        t[j].k = k; t[j].d2 = d2; t[j].hx = x / w * 640.f; t[j].hy = y / h * 480.f; t[j].z = z;
    }
    for (int i = 0; i < TAG_N; i++){
        if (i >= n){ tag_hide(c, i); continue; }
        uint32_t obj = tag_obj(c, i, pkg);
        if (!obj) continue;
        const Slot *s = &g_sl[t[i].k];
        float hx = t[i].hx, hy = t[i].hy;
        rh_hud_marker(&hx, &hy);
        char tx[TAG_TEXT_MAX];
        snprintf(tx, sizeof tx, s->paused ? "%s (paused)" : "%s", s->name);
        tag_text(c, i, obj, tx);
        uint32_t ap[2] = { gvec(g_gmem + TAG_SCR + 0x20u, hx - 320.f, hy - 240.f, t[i].z), 0 };
        rh_call(c, FN_FE_POS, obj, 0, 2, ap);
        float sc = 25.f / rc_sqrtf(t[i].d2);
        if (sc < 0.5f) sc = 0.5f;
        if (sc > 1.f) sc = 1.f;
        uint32_t as[2] = { gvec(g_gmem + TAG_SCR + 0x30u, sc, sc, 1.f), 0 };
        rh_call(c, FN_FE_SCALE, obj, 0, 2, as);
        gcall1(c, FN_FE_SHOW, 0, obj);
        g_tag.shown[i] = 1;
    }
}

/* ---- minimap arrows --------------------------------------------------------------------------------- */
/* The minimap's icons (G_MM_ICONS, made by 0x4EC950 when the HUD is built
 * and again by 0x4F92A0) give an AI racer's arrow (type 3) to each car of the
 * World's AI range.  An icon keeps the car's racer number and finds the car
 * by it every frame on the World's list (0x4CA6D0 -> 0x5F0E30), and draws
 * one of the free "visuals" of its type, which 0x4DB900 makes from the HUD's
 * AIRACERINDICATOR_0..7 at each rebuild (and frees, 0x4EC6F0).  Our cars
 * outside the car index get theirs here: an icon by racer number (0x4EC790),
 * made again whenever the minimap's icons are; when no visual is free, a
 * visual of our own from the game's pools (it frees them with its own) on a
 * copy of AIRACERINDICATOR_0 (fe_clone) that no visual holds now. */
#define G_MM_ICONS      0x008364d4u   /* the minimap's icons: +0/+4 their list (icon +0x1C its visual), +0x18 the package's name */
#define G_MM_VISUALS    0x00836560u   /* the free visuals: nodes {+0 next, +4 previous, +8 visual {+0 FE object, +4 type}} */
#define G_MM_VISPOOL    0x008364b4u   /* the visuals' pool */
#define FN_MM_ADDICON   0x004ec790u   /* thiscall icons (type, racer number), callee pops: an icon with a free visual of that type */
#define FN_POOL_ALLOC   0x0043f8f0u   /* cdecl (pool) */
#define FN_NODE_ALLOC   0x00440ec0u   /* cdecl (): a list node, +8 its data */
#define MM_AIRACER      3u
static struct { uint32_t hud, icons, copy[NSLOT], hash[NSLOT]; int ncopy; uint32_t icon_car[NSLOT]; int said; } g_mm;
/* a visual (a free one, or one for a copy of AIRACERINDICATOR_0) in the free list */
static int mm_visual_held(uint32_t icons, uint32_t fo){
    for (uint32_t n = rd32(G_MM_VISUALS), m = 0; n && n != G_MM_VISUALS && m < 256; n = rd32(n), m++) if (rd32(rd32(n + 8u)) == fo) return 1;
    for (uint32_t n = rd32(icons), m = 0; n && n != icons && m < 256; n = rd32(n), m++) if (rd32(rd32(n + 0x1cu)) == fo) return 1;
    return 0;
}
/* a copy is the HUD package's object: a HUD made again (after a shop the
 * new one can have the old one's address, and g_mm.hud is the same) has
 * none of ours, they were freed with the old package.  So a copy is taken
 * again only while the package still holds it under its name (a freed one
 * drawn by the minimap faulted in the arrow's rotation, 0x517C80) */
static int mm_copy_live(CPU *c, uint32_t icons, int i){
    uint32_t pk = gcall1(c, FN_FE_PACKAGE, 0, rd32(icons + 0x18u));
    return ok(pk, 0x54) && fe_list_of(pk + 0x4cu, g_mm.copy[i], 0) && rd32(g_mm.copy[i] + 0x10u) == g_mm.hash[i];
}
static int mm_visual(CPU *c, uint32_t icons){
    for (uint32_t n = rd32(G_MM_VISUALS), m = 0; n && n != G_MM_VISUALS && m < 256; n = rd32(n), m++){
        uint32_t v = rd32(n + 8u);
        if (ok(v, 8) && MR32(v + 4u) == MM_AIRACER) return 1;
    }
    int i = 0;
    while (i < g_mm.ncopy && mm_visual_held(icons, g_mm.copy[i])) i++;
    uint32_t fo = i < g_mm.ncopy ? g_mm.copy[i] : 0;
    if (fo && !mm_copy_live(c, icons, i)){
        rlog("[roam] f=%ld minimap: a new HUD at the old one's address: its %d copies of AIRACERINDICATOR_0 forgotten\n", rh_frame(), g_mm.ncopy);
        g_mm.ncopy = 0; fo = 0;
    }
    if (!fo){
        if (g_mm.ncopy >= NSLOT) return 0;
        uint32_t pkg = rd32(icons + 0x18u), sa = g_gmem + TAG_SCR + 0x48u;
        gstr(sa, "AIRACERINDICATOR_0", 24);
        uint32_t a[2] = { pkg, gcall1(c, FN_FE_HASH, 0, sa) }, o0 = ok(pkg, 0x10) ? rh_call(c, FN_FE_FINDOBJ, 0, 0, 2, a) : 0;
        char nm[24]; snprintf(nm, sizeof nm, "ROAM_AIRACER_%d", g_mm.ncopy);
        fo = ok(o0, 0x5c) ? fe_clone(c, pkg, o0, nm) : 0;
        if (!fo) return 0;
        g_mm.hash[g_mm.ncopy] = MR32(fo + 0x10u); g_mm.copy[g_mm.ncopy++] = fo;
    }
    uint32_t pool = rd32(G_MM_VISPOOL), v = pool ? rh_call(c, FN_POOL_ALLOC, 0, 0, 1, &pool) : 0, n = v ? rh_call(c, FN_NODE_ALLOC, 0, 0, 0, 0) : 0;
    if (!ok(v, 8) || !ok(n, 12)) return 0;
    MR32(v) = fo; MR32(v + 4u) = MM_AIRACER;
    uint32_t tail = rd32(G_MM_VISUALS + 4u);                              /* at the end, as 0x4DB900 adds them */
    MR32(n + 8u) = v; MR32(tail) = n; MR32(G_MM_VISUALS + 4u) = n; MR32(n + 4u) = tail; MR32(n) = G_MM_VISUALS;
    return 1;
}
static void arrows_update(CPU *c, uint32_t w){
    uint32_t pl = rd32(G_PLAYER1), hud = pl && ok(pl, PL_HUD + 4u) ? rd32(pl + PL_HUD) : 0, icons = rd32(G_MM_ICONS);
    if (hud != g_mm.hud){ memset(&g_mm, 0, sizeof g_mm); g_mm.hud = hud; }      /* our copies went with the old HUD */
    if (icons != g_mm.icons){ memset(g_mm.icon_car, 0, sizeof g_mm.icon_car); g_mm.icons = icons; }
    if (!hud || !ok(icons, 0x1c) || !g_gmem) return;
    for (int k = NOPP; k < NSLOT; k++){
        Slot *s = &g_sl[k];
        if (!s->created || !s->unindexed || s->world != w || !ok(s->car, 0x9e0) || g_mm.icon_car[k] == s->car) continue;
        if (!mm_visual(c, icons)){
            if (!g_mm.said++) rlog("[roam] f=%ld no minimap arrow for a friend's car (no AIRACERINDICATOR to copy, or the minimap's pools are full)\n", rh_frame());
            return;
        }
        uint32_t a[2] = { MM_AIRACER, (uint32_t)(int32_t)(int16_t)MR16(s->car + 0xau) };
        rh_call(c, FN_MM_ADDICON, icons, 0, 2, a);
        g_mm.icon_car[k] = s->car;
    }
}

/* ---- per-frame --------------------------------------------------------------------------------- */
typedef struct { int idx; uint32_t id; char name[RC_NAME_MAX + 1]; int visible, paused; float dist; uint32_t cfg_gen;
                 int duels;            /* takes outrun challenges (its HELLO) */
                 int has_cfg;          /* a complete car record is held */
                 int cfg_len;          /* > 0: the record is copied here (a slot needs it) */
                 uint8_t cfg[RC_CFG_MAX]; int have_pose; rc_pose pose; float err; uint32_t look; } PeerView;
static PeerView g_pv[RC_TABLE]; static int g_npv;

/* ---- horns ----------------------------------------------------------------------------------------- */
/* H or the controller's left stick click sounds the player's horn in free
 * roam while the world runs, and the snapshots carry it (RC_BIT_HORN); a
 * friend's horn sounds from their car, as the camera hears it (horn.c: the
 * distance, the side, Doppler). */
static int g_horns_on;                        /* horns were driven last frame */
static void horns_update(const rc_state *ls, int heard){
    float L[3] = {0}, f[3] = {1.f, 0.f, 0.f};
    uint32_t cam = rd32(G_VIEW1 + 0x40u), me = player_car();
    if (!ls) heard = 0;
    if (heard && ok(cam, 0x60)){ rd3(cam + 0x40u, L); rd3(cam + 0x50u, f); }       /* the listener: the camera, */
    else if (heard && ok(me, 0x9e0)){ rd3(me + 0x60u, L); rd3(me + 0x90u, f); }   /* else the player's car */
    else heard = 0;
    if (!heard && !g_horn && !g_horns_on) return;     /* racehorn.c may have the voices */
    rh_horn_begin(heard ? L : 0, f, ls ? ls->v : 0);
    if (g_horn) rh_horn_sound(g_s.conf.self_id, O.name, 0, 0);
    for (int i = 0; heard && i < g_npv; i++){
        const PeerView *v = &g_pv[i];
        if (v->visible && !v->paused && v->have_pose && (v->pose.bits & RC_BIT_HORN))
            rh_horn_sound(v->id, v->name, v->pose.p, v->pose.v);
    }
    rh_horn_end();
    g_horns_on = heard || g_horn;
}

/* How far behind its sender's clock a friend's car is drawn (the render
 * delay of rc_interp_eval).  Ghost cars: the display delay
 * (NFSU2_ROAM_DELAY), smooth through the jitter buffer.  Solid cars: where
 * the friend is now, the newest state carried on by the one-way network
 * delay (half the smallest of the last 8 round trips, at most 150 ms): a
 * friend at 30 m/s drawn 150 ms in the past is hit 4.5 m behind the car's
 * real place, and at another spot on each screen.  A change is slewed at
 * 5 % of the frame's time, so the car never jumps. */
#define RD_PINGS 8
static struct { uint32_t id; int32_t rtt[RD_PINGS], last; int n, h, init; int64_t d; } g_rd[RC_TABLE];
static int64_t render_delay(int i, const rc_peer *p, int64_t frame_dt){
    if (g_rd[i].id != p->id){ memset(&g_rd[i], 0, sizeof g_rd[i]); g_rd[i].id = p->id; }
    if (p->rtt_us > 0 && p->rtt_us != g_rd[i].last){
        g_rd[i].last = p->rtt_us; g_rd[i].rtt[g_rd[i].h] = p->rtt_us; g_rd[i].h = (g_rd[i].h + 1) % RD_PINGS;
        if (g_rd[i].n < RD_PINGS) g_rd[i].n++;
    }
    int64_t want = (int64_t)O.delay_ms * 1000;
    if (O.collide){
        int32_t m = 0;
        for (int k = 0; k < g_rd[i].n; k++) if (k == 0 || g_rd[i].rtt[k] < m) m = g_rd[i].rtt[k];
        want = -(int64_t)(m / 2 < 150000 ? m / 2 : 150000);
    }
    if (!g_rd[i].init){ g_rd[i].d = want; g_rd[i].init = 1; }
    else {
        int64_t lim = (frame_dt > 1000000 ? 1000000 : frame_dt < 0 ? 0 : frame_dt) / 20 + 1, d = want - g_rd[i].d;
        g_rd[i].d += d > lim ? lim : d < -lim ? -lim : d;
    }
    return g_rd[i].d;
}

/* ---- outruns between players --------------------------------------------------------------------- */
/* Two players who stay near each other in free roam (within DU_NEAR_M for
 * DU_NEAR_US) get the game's own outrun challenge: the HUD's outrun icon
 * (0x4DB890: the "!" and two cars, the D-pad's Up lit) and a line of text
 * naming the friend (du_hud).  Engage (Enter, or the pad's D-pad Up: the
 * game's action 0xF, however the player set it) challenges; the friend gets
 * the icon and "<name> challenges you" and takes it with Engage, or lets it
 * go.  Then both games run the game's own outrun -- the "1,000 Feet" meter,
 * the result message, the bank reward or loss -- each against the other's
 * car as shown there:
 *  - started as Engage starts one (0x602E09), from the main-loop hook, with
 *    the World's AI range narrowed to the friend's car for the call, so the
 *    race (0x607180) has the two cars as its racers whichever slot the car
 *    has (one past World::IndexCars' 22 too);
 *  - the game decides it as its own: the racer ranked first wins once the
 *    other is 300 m behind it (1,000 feet with imperial units; 0x607C9C,
 *    the distances from 0x5FC510).  It ranks the opponent first at the
 *    start ("Catch Them!"), and only the leader's AI road path puts the
 *    player past it; a friend's car has none.  So each frame the one
 *    getting away is ranked first (du_rank): the one moving away from the
 *    other the faster, from where both cars are drawn frame to frame (the
 *    friend's velocity as sent is too rough), over DU_AWAY_US.  Only
 *    someone driving away takes the two 300 m apart, so a car standing
 *    still never wins, however the road bends (where the cars head would
 *    not do: on a loop the one getting away heads back).  Each game works
 *    it out from its own screen, and the two agree;
 *  - each game tells the other its result; one that has none yet takes it
 *    (race +0xBEC/+0xBF0, as the game's result message 0x4A7B30 does), so
 *    a few metres of network delay never make two winners;
 *  - a player who leaves (back to the menus, quits, loses the connection)
 *    loses: the other wins.
 * While it runs both still count as in free roam: friends' cars stay, and
 * friends still see the two.  Messages: RC_MSG_DUEL (roam_core.h), each
 * repeated until answered (a datagram lost on a LAN).  Not in the Windows
 * plugin (DUELS): its players are not offered one. */
#ifdef ROAM_HOST_WIN
#define DUELS           0
#else
#define DUELS           1
#endif
#define G_ACTIONS       0x0086eaf0u   /* the joystick actions held this frame, a bit per action, 0 = held (0x5CFD60) */
#define ACT_ENGAGE      15u           /* Engage */
#define G_RACETYPE      0x0089e7b0u   /* 0 free roam, 7 an outrun */
#define G_OUTRUN_STATE  (G_ENCOUNTERS + 0x1ae8u)  /* 2: an outrun can be taken (0x500D20) */
#define G_ENGAGE        0x00838590u
#define PL_OPPONENT     0x250u        /* Player: the car an outrun is against */
#define PL_MARKER       0x9acu        /* Player: the event or shop marker Engage would enter */
#define RACE_RESULT     0xbecu        /* race: the result message's position (+0xBF0 its player number) */
#define FN_HUD_OUTRUN   0x004db890u   /* thiscall HUD (car or 0): the outrun icon on or off */
#define FN_OUTRUN_START 0x00607180u   /* thiscall race: an outrun against player +0x250, the AI range its racers */
#define FN_ENGAGE_DONE  0x005010e0u   /* thiscall G_ENGAGE: what Engage does after starting one */
#define DU_NEAR_M       30.f          /* the game's own reach for a challenge (0x40C030) */
#define DU_NEAR_US      3000000
#define DU_PROMPT_M     40.f          /* the offer stays while the two are this near */
#define DU_KEEP_M       60.f          /* a challenge stands while the two are this near */
#define DU_RANK_MPS     2.f           /* the order changes when the other gets away this much faster (m/s) */
#define DU_AWAY_US      1000000
#define DU_OFFER_US     15000000      /* a challenge nobody takes goes */
#define DU_GONE_US      2000000       /* a friend whose car is not shown for this long has left the outrun */
#define DU_NOTE_US      4000000
enum { DU_IDLE, DU_SENT, DU_GOT, DU_ACCEPTED, DU_RACE, DU_OVER };
static const char *const du_st[] = { "idle", "challenge sent", "challenged", "accepted", "racing", "over" };
static struct {
    int      st;
    uint32_t id, duel;                        /* the friend; the outrun's id (the challenger's) */
    char     name[RC_NAME_MAX + 1];
    int      mine;                            /* we challenged */
    int64_t  since, tx_at, heard;             /* this state's start, our last message, the friend's last */
    uint8_t  op, arg;                         /* what we say until answered */
    uint32_t car;                             /* the friend's car: the outrun's opponent */
    int      won;                             /* our game's result: 1 won, 2 lost, 0 none (yet) */
    int      their;                           /* the friend's game's, for us: 1 we won, 2 we lost */
    int      posted, nres;                    /* we gave the game a result; results still to send */
    int64_t  gone_at;
    float    gap, away;                       /* metres between the cars; how much faster we get away (m/s, smoothed) */
    float    was[4]; int64_t away_at;         /* where the two cars were (ours x y, the friend's x y), and when */
    uint32_t ranks;                           /* order changes */
    uint32_t icon, hud;                       /* the car the HUD's outrun icon is on (0 off), in this HUD */
    int      engage;                          /* Engage held last frame */
    char     note[TAG_DUEL_MAX]; int64_t note_until;
    uint32_t offers, races, wins, losses;     /* statistics */
} g_du;
static int du_racing(uint32_t race){
    return (g_du.st == DU_RACE || g_du.st == DU_OVER) && g_du.car && MR32(G_RACETYPE) == 7u && MR32(race + 0x24u) >= 2u;
}
/* the outrun's friend keeps the slot (assign) */
static int du_keeps(int k){ return g_du.st != DU_IDLE && g_sl[k].peer_id == g_du.id; }
static void du_note(int64_t host, const char *fmt, const char *name){
    snprintf(g_du.note, sizeof g_du.note, fmt, name);
    g_du.note_until = host + DU_NOTE_US;
    rlog("[roam] f=%ld outrun: %s\n", rh_frame(), g_du.note);
}
static void du_send(int64_t host, uint8_t op, uint8_t arg){
    roam_plat_lock(); rc_send_duel(&g_s, g_du.id, op, arg, g_du.duel); roam_plat_unlock();
    g_du.op = op; g_du.arg = arg; g_du.tx_at = host;
}
static void du_to(int st, int64_t host){
    if (st != g_du.st) rlog("[roam] f=%ld outrun with %s: %s -> %s\n", rh_frame(), g_du.name[0] ? g_du.name : "?", du_st[g_du.st], du_st[st]);
    g_du.st = st; g_du.since = host;
    if (st == DU_IDLE){ g_du.id = 0; g_du.duel = 0; g_du.car = 0; g_du.won = g_du.their = 0; g_du.posted = 0; g_du.nres = 0; g_du.op = 0; }
}
/* the friend's slot with a car shown, or -1 */
static int du_slot(uint32_t id){
    for (int k = 0; k < NSLOT; k++)
        if (g_sl[k].st == SL_ACTIVE && g_sl[k].peer_id == id && !g_sl[k].hidden && ok(g_sl[k].car, 0x9e0)) return k;
    return -1;
}
static const PeerView *du_pv(uint32_t id){ for (int i = 0; i < g_npv; i++) if (g_pv[i].id == id) return &g_pv[i]; return 0; }
/* the friend can race now: shown, in free roam and not paused, takes challenges */
static int du_able(int k){
    const PeerView *v = k >= 0 ? du_pv(g_sl[k].peer_id) : 0;
    return v && v->visible && !v->paused && v->duels && !g_sl[k].paused;
}
static float du_dist(uint32_t car){
    uint32_t me = player_car();
    float dx = MRF32(car + 0x60u) - MRF32(me + 0x60u), dy = MRF32(car + 0x64u) - MRF32(me + 0x64u);
    return rc_sqrtf(dx * dx + dy * dy);
}
static void du_icon(CPU *c, uint32_t car){
    uint32_t pl = world() ? rd32(G_PLAYER1) : 0, hud = pl ? rd32(pl + PL_HUD) : 0;
    if (hud != g_du.hud){ g_du.hud = hud; g_du.icon = 0; }                 /* a new HUD: nothing on it yet */
    if (!hud || g_du.icon == car) return;
    gcall1(c, FN_HUD_OUTRUN, hud, car);
    g_du.icon = car;
}
/* our game can race now: free roam, the world running, no race, no marker
 * Engage would enter */
static int du_free(int in_roam, int world_runs){
    uint32_t race = rd32(G_RACE), pl = rd32(G_PLAYER1);
    return in_roam && world_runs && pl && ok(race, 0xc44) && MR32(race + 0x24u) == 1u && !MR32(G_RACETYPE) && !rd32(pl + PL_MARKER);
}
/* the game's outrun against the friend's car, as Engage starts one */
static int du_start(CPU *c, int64_t host){
    int k = du_slot(g_du.id);
    uint32_t w = world(), race = rd32(G_RACE), pl = rd32(G_PLAYER1);
    if (k < 0 || !w || !pl || !ok(race, 0xc44) || MR32(race + 0x24u) != 1u || MR32(G_RACETYPE)) return 0;
    uint32_t first = MR32(w + 0x14u), end = MR32(w + 0x18u);
    if (first >= WORLD_INDEX) return 0;
    uint32_t car = g_sl[k].car, keep = MR32(w + 0x1cu + 4u * first);
    du_icon(c, 0);
    MR32(w + 0x1cu + 4u * first) = car; MR32(w + 0x18u) = first + 1u;     /* the AI range: the friend's car alone */
    MR32(pl + PL_OPPONENT) = car; MR32(G_OUTRUN_STATE) = 2u;
    gcall0(c, FN_OUTRUN_START, race);
    gcall0(c, FN_ENGAGE_DONE, G_ENGAGE);
    MR32(w + 0x1cu + 4u * first) = keep; MR32(w + 0x18u) = end;
    g_du.car = car; g_du.won = g_du.their = 0; g_du.posted = 0; g_du.nres = 0; g_du.gone_at = 0; g_du.ranks = 0; g_du.away = 0; g_du.away_at = 0;
    if (MR32(G_RACETYPE) != 7u || MR32(race + 0x24u) != 2u){
        rlog("[roam] f=%ld outrun with %s: the game did not start it (race type %u, %u racers)\n", rh_frame(), g_du.name,
                MR32(G_RACETYPE), MR32(race + 0x24u));
        MR32(pl + PL_OPPONENT) = 0; g_du.car = 0;
        return 0;
    }
    g_du.races++;
    rlog("[roam] f=%ld outrun with %s: on, against car 0x%08x, %.0f m apart\n", rh_frame(), g_du.name, car, (double)du_dist(car));
    return 1;
}
/* a result into the game, as its result message does (0x4A7B30): the
 * player's position, 1 won or 2 lost; the race finishes on its next update */
static void du_post(int won, const char *why){
    uint32_t race = rd32(G_RACE), me = player_car(), owner = me ? rd32(me + 0x18u) : 0;
    if (g_du.posted || !ok(race, 0xc44) || !du_racing(race)) return;
    MR32(race + RACE_RESULT + 4u) = owner ? rd32(owner + 0x10u) : 0;
    MR32(race + RACE_RESULT) = won ? 1u : 2u;
    g_du.posted = 1;
    rlog("[roam] f=%ld outrun with %s: %s for us (%s), %.0f m apart\n", rh_frame(), g_du.name, won ? "a win" : "a loss", why, (double)g_du.gap);
}
/* our game's outrun is over: the player's racer says how (FinishRacer's
 * completion, 6 won, 7 lost; it stays a few seconds after the race), or it
 * ended without one */
static int du_outcome(uint32_t race){
    uint32_t me = player_car();
    for (uint32_t i = 0; me && i < 6; i++){
        uint32_t r = race + 0x30u + 0x1f0u * i;
        if (rd32(r) != me) continue;
        uint32_t ct = MR16(r + 0x10u);
        return ct == 6u ? 1 : ct == 7u ? 2 : 0;
    }
    return 0;
}
/* the race's order: the one ahead first (position 1), as the game's own
 * outrun has it once the player gets past the AI */
static void du_rank(uint32_t race, int me_first){
    uint32_t a = rd32(race + 0xbd0u), b = rd32(race + 0xbd4u);
    if (MR32(race + 0x24u) != 2u || !ok(a, 0x1f0) || !ok(b, 0x1f0) || (rd32(a) == player_car()) == me_first) return;
    MR32(race + 0xbd0u) = b; MR32(race + 0xbd4u) = a;
    MR8(b + 0xau) = 1; MR8(a + 0xau) = 2;
    g_du.ranks++;
}
/* the outrun is over in the game (its result shown) or never was: what it
 * leaves behind goes, and the career's outrun bookkeeping starts again */
static void du_clear(CPU *c){
    uint32_t race = rd32(G_RACE), pl = rd32(G_PLAYER1);
    if (ok(race, 0xc44) && !MR32(G_RACETYPE)){ MR32(race + RACE_RESULT) = 0; MR32(race + RACE_RESULT + 4u) = 0; }
    if (pl && rd32(pl + PL_OPPONENT) == g_du.car) MR32(pl + PL_OPPONENT) = 0;
    gcall0(c, FN_EM_OVER, G_ENCOUNTERS);
}
/* one DUEL message from the friend `from` */
static void du_recv(CPU *c, int64_t host, uint32_t from, uint8_t op, uint8_t arg, uint32_t duel, int in_roam, int world_runs){
    uint32_t self = g_s.conf.self_id;
    int ours = g_du.st != DU_IDLE && from == g_du.id && duel == g_du.duel;
    if (ours) g_du.heard = host;
    switch (op){
    case RC_DUEL_OFFER: {
        if (ours) return;                                              /* repeated */
        int k = du_slot(from);
        if (g_du.st == DU_SENT && from == g_du.id){
            /* we challenged each other: the lower id's challenge it is */
            g_du.heard = host;
            if (self < from){ rlog("[roam] f=%ld outrun with %s: challenged each other, ours stands\n", rh_frame(), g_du.name);
                              goto accepted; }
            rlog("[roam] f=%ld outrun with %s: challenged each other, theirs stands\n", rh_frame(), g_du.name);
            g_du.duel = duel; g_du.mine = 0;
            du_send(host, RC_DUEL_ACCEPT, 0); du_to(DU_ACCEPTED, host);
            return;
        }
        if (g_du.st != DU_IDLE || k < 0 || !du_able(k) || !du_free(in_roam, world_runs) || du_dist(g_sl[k].car) > DU_KEEP_M){
            roam_plat_lock(); rc_send_duel(&g_s, from, RC_DUEL_CANCEL, RC_DC_BUSY, duel); roam_plat_unlock();
            return;
        }
        g_du.id = from; g_du.duel = duel; g_du.mine = 0; g_du.heard = host; g_du.op = 0;
        snprintf(g_du.name, sizeof g_du.name, "%s", g_sl[k].name);
        du_to(DU_GOT, host);
        return; }
    case RC_DUEL_ACCEPT:
        if (!ours) return;
        if (g_du.st == DU_RACE && g_du.mine){ du_send(host, RC_DUEL_START, 0); return; }   /* our START was lost */
        if (g_du.st != DU_SENT) return;
    accepted:
        if (!du_start(c, host)){
            du_send(host, RC_DUEL_CANCEL, RC_DC_BUSY); du_note(host, "The outrun with %s could not start", g_du.name); du_to(DU_IDLE, host);
            return;
        }
        du_send(host, RC_DUEL_START, 0); du_to(DU_RACE, host);
        return;
    case RC_DUEL_START:
        if (!ours || g_du.st != DU_ACCEPTED) return;
        if (!du_start(c, host)){
            du_send(host, RC_DUEL_CANCEL, RC_DC_LEFT); du_note(host, "The outrun with %s could not start", g_du.name); du_to(DU_IDLE, host);
            return;
        }
        g_du.op = 0;
        du_to(DU_RACE, host);
        return;
    case RC_DUEL_RESULT:                                               /* the friend won (1) or lost (2) */
        if (ours && (g_du.st == DU_RACE || g_du.st == DU_OVER) && (arg == 1 || arg == 2)) g_du.their = arg == 1 ? 2 : 1;
        return;
    case RC_DUEL_CANCEL:
        if (!ours) return;
        if (g_du.st == DU_RACE){ g_du.their = 1; du_note(host, "%s left the outrun", g_du.name); du_post(1, "the friend left"); return; }
        if (g_du.st == DU_OVER) return;
        if (g_du.st == DU_SENT) du_note(host, arg == RC_DC_BUSY ? "%s cannot race now" : "%s did not take the outrun", g_du.name);
        else if (g_du.st == DU_GOT) du_note(host, "%s called off the outrun", g_du.name);
        else du_note(host, "The outrun with %s is off", g_du.name);
        du_to(DU_IDLE, host);
        return;
    }
}
/* per frame, after the slots (the friends' cars are where they are drawn) */
static void du_frame(CPU *c, int64_t host, int in_roam, int world_runs, const uint32_t *in, int nin){
    if (!DUELS) return;
    for (int i = 0; i < nin; i++) du_recv(c, host, in[4 * i], (uint8_t)in[4 * i + 1], (uint8_t)in[4 * i + 2], in[4 * i + 3], in_roam, world_runs);
    uint32_t race = rd32(G_RACE), me = player_car();
    int eng = in_roam && world_runs && !(rd32(G_ACTIONS) & (1u << ACT_ENGAGE));
    int press = eng && !g_du.engage;
    g_du.engage = eng;
    int free = du_free(in_roam, world_runs);
    /* who has been near for the time it takes */
    for (int k = 0; k < NSLOT; k++){
        Slot *s = &g_sl[k];
        int near = free && me && s->st == SL_ACTIVE && !s->hidden && ok(s->car, 0x9e0) && du_able(k) &&
                   du_dist(s->car) < (g_du.st == DU_IDLE && g_du.icon == s->car ? DU_PROMPT_M : DU_NEAR_M);
        if (!near) s->near_since = 0;
        else if (!s->near_since) s->near_since = host;
    }
    int k = g_du.st != DU_IDLE ? du_slot(g_du.id) : -1;
    switch (g_du.st){
    case DU_IDLE: {
        int best = -1; float bd = 0;
        for (int j = 0; j < NSLOT; j++){
            if (!g_sl[j].near_since || host - g_sl[j].near_since < DU_NEAR_US) continue;
            float d = du_dist(g_sl[j].car);
            if (best < 0 || d < bd){ best = j; bd = d; }
        }
        du_icon(c, best >= 0 ? g_sl[best].car : 0);
        if (best < 0 || !press) break;
        roam_plat_lock(); do g_du.duel = roam_plat_random(); while (!g_du.duel); roam_plat_unlock();
        g_du.id = g_sl[best].peer_id; g_du.mine = 1; g_du.heard = host; g_du.offers++;
        snprintf(g_du.name, sizeof g_du.name, "%s", g_sl[best].name);
        du_send(host, RC_DUEL_OFFER, 0);
        du_to(DU_SENT, host);
        break; }
    case DU_SENT:
    case DU_GOT:
    case DU_ACCEPTED:
        du_icon(c, k >= 0 && g_du.st == DU_GOT ? g_sl[k].car : 0);
        if (k < 0 || !du_able(k) || !free || du_dist(g_sl[k].car) > DU_KEEP_M){
            if (g_du.st != DU_GOT) du_send(host, RC_DUEL_CANCEL, RC_DC_WITHDRAWN);
            du_note(host, k < 0 || !du_able(k) ? "The outrun with %s is off" : "The outrun with %s is off: too far apart", g_du.name);
            du_to(DU_IDLE, host);
            break;
        }
        if (g_du.st == DU_SENT){
            if (host - g_du.since > DU_OFFER_US){
                du_send(host, RC_DUEL_CANCEL, RC_DC_WITHDRAWN); du_note(host, "%s did not take the outrun", g_du.name); du_to(DU_IDLE, host);
            } else if (host - g_du.tx_at >= 500000) du_send(host, RC_DUEL_OFFER, 0);
        } else if (g_du.st == DU_GOT){
            if (host - g_du.heard > 2000000 || host - g_du.since > DU_OFFER_US){ du_to(DU_IDLE, host); break; }   /* the challenge stopped */
            if (press){ du_send(host, RC_DUEL_ACCEPT, 0); du_to(DU_ACCEPTED, host); }
        } else {
            if (host - g_du.since > 4000000){ du_note(host, "The outrun with %s did not start", g_du.name); du_to(DU_IDLE, host); }
            else if (host - g_du.tx_at >= 300000) du_send(host, RC_DUEL_ACCEPT, 0);
        }
        break;
    case DU_RACE: {
        if (!ok(race, 0xc44) || !me || !du_racing(race)){
            /* our game's outrun is over: its result to the friend, or we left it */
            g_du.won = ok(race, 0xc44) ? du_outcome(race) : 0;
            if (g_du.won == 1) g_du.wins++;
            if (g_du.won == 2) g_du.losses++;
            rlog("[roam] f=%ld outrun with %s: over, %s, %.0f m apart, the order changed %u time(s)%s\n", rh_frame(), g_du.name,
                    g_du.won == 1 ? "WON" : g_du.won == 2 ? "LOST" : "we left it", (double)g_du.gap, g_du.ranks,
                    g_du.their && g_du.won && g_du.their != g_du.won ? "; the friend's game said otherwise" : "");
            if (!g_du.won){
                for (int n = 0; n < 3; n++) du_send(host, RC_DUEL_CANCEL, RC_DC_LEFT);
                if (ok(race, 0xc44)) du_clear(c);
                du_to(DU_IDLE, host);
                break;
            }
            g_du.nres = 5; g_du.tx_at = 0;
            du_to(DU_OVER, host);
            break;
        }
        if (g_du.mine && g_du.op == RC_DUEL_START && host - g_du.since < 1000000 && host - g_du.tx_at >= 300000) du_send(host, RC_DUEL_START, 0);
        /* the friend is gone (not shown, not in free roam, no packets): its
         * car stays where it was (the slots leave it), and we win */
        const PeerView *v = du_pv(g_du.id);
        if (!car_out(g_du.car) || (k >= 0 && g_sl[k].car != g_du.car)){
            /* its car was parked (the friend left the session): at once, before the game's next update counts it */
            if (!g_du.posted){ du_note(host, "%s left the outrun", g_du.name); du_post(1, "the friend's car is gone"); }
            break;
        }
        if (k < 0 || !v || !v->visible){
            if (!g_du.gone_at) g_du.gone_at = host;
            if (host - g_du.gone_at > DU_GONE_US && !g_du.posted){ du_note(host, "%s left the outrun", g_du.name); du_post(1, "the friend is gone"); }
            break;
        }
        g_du.gone_at = 0;
        if (g_du.their){ du_post(g_du.their == 1, "the friend's game has its result"); break; }
        uint32_t car = g_du.car;
        float p[4] = { MRF32(me + 0x60u), MRF32(me + 0x64u), MRF32(car + 0x60u), MRF32(car + 0x64u) };
        float dx = p[0] - p[2], dy = p[1] - p[3];
        g_du.gap = rc_sqrtf(dx * dx + dy * dy);
        float dt = (float)(host - g_du.away_at) / 1e6f;
        if (g_du.away_at && dt > 0.f && g_du.gap > 1.f){
            /* our speed away from the friend less the friend's away from us,
             * from how each car moved since the last frame: the friend's game
             * gets minus this.  A jump (a respawn) counts for nothing */
            float ux = dx / g_du.gap, uy = dy / g_du.gap;
            float a = ((p[0] - g_du.was[0]) * ux + (p[1] - g_du.was[1]) * uy) / dt, b = -((p[2] - g_du.was[2]) * ux + (p[3] - g_du.was[3]) * uy) / dt;
            if (!__builtin_isfinite(a - b) || __builtin_fabsf(a) > 150.f || __builtin_fabsf(b) > 150.f) a = b = 0;
            float t = dt * 1e6f / (float)DU_AWAY_US;
            g_du.away += (a - b - g_du.away) * (t < 1.f ? t : 1.f);
        }
        for (int i = 0; i < 4; i++) g_du.was[i] = p[i];
        g_du.away_at = host;
        if (g_du.away > DU_RANK_MPS) du_rank(race, 1);
        else if (g_du.away < -DU_RANK_MPS) du_rank(race, 0);
        break; }
    case DU_OVER:
        if (g_du.nres > 0 && host - g_du.tx_at >= 300000){ du_send(host, RC_DUEL_RESULT, (uint8_t)g_du.won); g_du.nres--; }
        if (!g_du.nres){
            if (ok(race, 0xc44)) du_clear(c);
            du_to(DU_IDLE, host);
        }
        break;
    }
}
/* the line of text, top centre, after the HUD's update (roam_game_hud) */
static void du_hud(CPU *c, int64_t host){
    uint32_t pl = rd32(G_PLAYER1), hud = pl && ok(pl, PL_HUD + 4u) ? rd32(pl + PL_HUD) : 0;
    uint32_t pkg = hud && ok(hud, 0x14) ? rd32(hud + 0x10u) : 0;
    if (!hud || hud != g_tag.hud || !ok(pkg, 0x20) || !g_gmem) return;
    char tx[TAG_DUEL_MAX] = {0};
    if (g_in_roam){
        if (g_du.st == DU_IDLE && g_du.icon){
            for (int k = 0; k < NSLOT; k++) if (g_sl[k].car == g_du.icon && g_sl[k].st == SL_ACTIVE)
                snprintf(tx, sizeof tx, "Press Enter to challenge %s to an outrun", g_sl[k].name);
        }
        else if (g_du.st == DU_SENT) snprintf(tx, sizeof tx, "Waiting for %s to take the outrun", g_du.name);
        else if (g_du.st == DU_GOT) snprintf(tx, sizeof tx, "%s challenges you to an outrun: press Enter to take it", g_du.name);
        else if (g_du.st == DU_ACCEPTED) snprintf(tx, sizeof tx, "Outrun with %s", g_du.name);
        if (!tx[0] && g_du.note[0] && host < g_du.note_until && g_du.st != DU_RACE && g_du.st != DU_OVER) snprintf(tx, sizeof tx, "%s", g_du.note);
    }
    if (!tx[0]){ tag_hide(c, TAG_DUEL); return; }
    uint32_t obj = tag_obj(c, TAG_DUEL, pkg);
    if (!obj) return;
    tag_text(c, TAG_DUEL, obj, tx);
    /* above the top of the HUD's middle (the prologue's arrow), in front
     * (the names over cars come with their depth, about 0.99; 1 is not drawn) */
    uint32_t ap[2] = { gvec(g_gmem + TAG_SCR + 0x20u, 0.f, -165.f, 0.5f), 0 };
    rh_call(c, FN_FE_POS, obj, 0, 2, ap);
    uint32_t as[2] = { gvec(g_gmem + TAG_SCR + 0x30u, 1.f, 1.f, 1.f), 0 };
    rh_call(c, FN_FE_SCALE, obj, 0, 2, as);
    gcall1(c, FN_FE_SHOW, 0, obj);
    g_tag.shown[TAG_DUEL] = 1;
}

/* the app has parked the game in the background (macOS: lifecycle.c; the
 * game thread then waits in GetMessageA and this file runs no frame) */
static int g_parked;
static uint8_t local_status(int in_roam){
    uint32_t flow = rd32(G_FLOW);
    if (in_roam) return g_sync_paused > 1 || g_parked ? RC_ST_PAUSED : RC_ST_ROAM;
    if (flow == 6u){
        /* a race (career event, or more than one racer); otherwise the
         * world is still coming up */
        uint32_t race = rd32(G_RACE);
        if (rd32(G_CAREER_RACE) || (ok(race, 0x28) && MR32(race + 0x24u) > 1u)) return RC_ST_EVENT;
        return RC_ST_LOADING;
    }
    if (flow == 3u) return (rd32(G_GAMEMODE) & 1u) ? RC_ST_SHOP : RC_ST_MENUS;
    return RC_ST_LOADING;
}
static void init_once(CPU *c){
    (void)c;
    g_inited = 1;
    O.on = env_int("NFSU2_ROAM", 0, 0, 1);
    if (!O.on) return;
    O.test = roam_plat_test_mode();
#ifdef ROAM_HOST_WIN
    O.collide = env_int("NFSU2_ROAM_COLLIDE", 0, 0, 1);     /* the Windows plugin: ghosts unless Collide = 1 */
#else
    O.collide = env_int("NFSU2_ROAM_COLLIDE", 1, 0, 1);
#endif
    O.labels = env_int("NFSU2_ROAM_LABELS", 1, 0, 1);
    O.test_owncars = env_int("NFSU2_ROAM_TEST_OWNCARS", 0, 0, 1);
    O.test_outside = env_int("NFSU2_ROAM_TEST_OUTSIDE", 0, 0, 1);
    O.max_cars = env_int("NFSU2_ROAM_MAX_CARS", MAX_CARS, 0, MAX_CARS);
    O.rate = env_int("NFSU2_ROAM_RATE", 20, 10, 60);
    O.delay_ms = env_int("NFSU2_ROAM_DELAY", 100, 0, 1000);
    O.extrap_ms = env_int("NFSU2_ROAM_EXTRAP", 250, 0, 1000);
    O.carpool_kb = env_int("NFSU2_ROAM_CARPOOL_KB", 48000, 0, 128000);
    int port = env_int("NFSU2_ROAM_PORT", RC_DEFAULT_PORT, 1024, 65535);
    int maxp = env_int("NFSU2_ROAM_MAX_PLAYERS", RC_MAX_PLAYERS, 2, RC_MAX_PLAYERS);
    int disc = env_int("NFSU2_ROAM_DISCOVERY", 1, 0, 1);
    const char *nm = opt("NFSU2_ROAM_NAME");
    if (nm && *nm) rc_name_clean(O.name, nm, 64);
    else O.name[0] = 0;                                    /* the profile name, once there is one */
    const char *rm = opt("NFSU2_ROAM_ROOM");
    snprintf(O.room, sizeof O.room, "%s", rm ? rm : "");
    rc_config cf; memset(&cf, 0, sizeof cf);
    cf.self_id = roam_plat_random(); cf.port = (uint16_t)port; cf.room = rc_fnv1a(O.room);
    snprintf(cf.name, sizeof cf.name, "%s", O.name[0] ? O.name : "Player");
#ifdef ROAM_HOST_WIN
    cf.platform = RC_PLAT_WIN;                             /* HELLO byte 18: the Windows plugin */
#else
    cf.platform = RC_PLAT_MAC;
#endif
    cf.test_mode = O.test; cf.max_players = maxp; cf.rate_hz = O.rate; cf.duels = DUELS;
    cf.discovery = disc && !O.test;
    rc_io io = { 0, 0, 0, 0 };
    rc_session_init(&g_s, &cf, &io);
    roam_plat_cfg pc = { (uint16_t)port, O.test, disc, rh_opt("NFSU2_ROAM_IMPAIR") };
    if (roam_plat_start(&pc, &g_s) != 0){
        rlog("[roam] free-roam multiplayer could not start (see above): off\n"); O.on = 0; return; }
    g_net_ok = 1;
    uint32_t pip[RC_MAX_PEERS * 2]; uint16_t ppt[RC_MAX_PEERS * 2];
    int np = roam_plat_parse_peers(opt("NFSU2_ROAM_PEERS"), O.test, (uint16_t)port, pip, ppt, RC_MAX_PEERS * 2);
    roam_plat_lock();
    for (int i = 0; i < np; i++) rc_add_peer(&g_s, pip[i], ppt[i], 1, roam_plat_now_us());
    roam_plat_unlock();
    /* the free-roam car pool: room for friends' cars (read at the next track load) */
    if (O.carpool_kb && rd32(G_CARPOOL_KB) && rd32(G_CARPOOL_KB) < (uint32_t)O.carpool_kb){
        rlog("[roam] free-roam car memory pool %u -> %d KB\n", rd32(G_CARPOOL_KB), O.carpool_kb);
        MR32(G_CARPOOL_KB) = (uint32_t)O.carpool_kb;
    }
    const char *pl = rh_opt("NFSU2_ROAM_POSELOG");
    if (pl && *pl){ g_poselog = rh_fopen(pl); if (g_poselog) rh_fprintf(g_poselog, "kind,host_us,sync_us,id,x,y,z,speed,mode,err,fx,fy,fz,uz,rx,ry,rz\n"); }
    g_frame0 = rh_frame();
    char ids[16];
    rlog("[roam] free-roam multiplayer ON: id %08x, port %d, %d configured peer(s), room \"%s\", up to %d players, "
                    "%d remote cars, %d Hz, %s%s\n", cf.self_id, port, np, O.room, maxp, O.max_cars, O.rate,
            O.collide ? "solid cars" : "ghost cars", O.test ? ", test harness (loopback only)" : "");
    (void)ids;
}

static void cost_add(uint64_t t0){
    uint64_t ns = rh_ns() - t0 + g_cost_hud;
    g_cost_hud = 0;
    g_cost_sum += ns; g_cost_n++; if (ns > g_cost_max) g_cost_max = ns;
    g_cost_win_sum += ns; g_cost_win_n++; if (ns > g_cost_win_max) g_cost_win_max = ns;
}
static void periodic_log(int64_t host){
    if (!g_cost_win_t0) g_cost_win_t0 = host;
    if (host - g_cost_win_t0 < 30000000) return;
    roam_plat_stats ps; roam_plat_get_stats(&ps);
    roam_plat_lock();
    int est = rc_established(&g_s);
    rlog("[roam] f=%ld stats: %d friend(s), tx %u (%.1f KB), rx %u, bad %u, other version %u, other room %u, policy %u, ratelimit %u, "
                    "stray %u, second address %u, blocked %llu; frame cost mean %.1f us max %.1f us (%llu frames); heap %u MB\n",
            rh_frame(), est, g_s.tx, g_s.tx_bytes / 1024.0, g_s.rx, g_s.rx_bad, g_s.rx_version, g_s.rx_room, g_s.rx_policy, g_s.rx_ratelimit,
            g_s.rx_stray, g_s.rx_dup_id, (unsigned long long)ps.blocked, g_cost_win_n ? g_cost_win_sum / 1000.0 / (double)g_cost_win_n : 0.0,
            g_cost_win_max / 1000.0, (unsigned long long)g_cost_win_n, rh_heap_mb());
    if (g_s.conf.hub_ip)
        rlog("[roam]   the server's hub: %s, %u lists, %u HELLOs of players it did not list ignored\n",
                g_s.hub_was == 2 ? "answering (it picks the players near us)" : g_s.hub_was == 1 ? "no answer yet" : "silent (broadcast discovery)",
                g_s.hub_lists, g_s.rx_unlisted);
    for (int i = 0; i < RC_TABLE; i++){
        const rc_peer *p = &g_s.peer[i];
        if (p->state != RC_PS_EST) continue;
        const rc_interp *m = &p->mo;
        rlog("[roam]   %s (%s, %s, rtt %.1f ms, render delay %.0f ms): snaps %u, snaps lost %u, interp %llu extrap %llu hold %llu, dup %llu, late %llu, "
                        "corrections > 5 m %llu, largest %.2f m, re-syncs %llu\n",
                p->name, p->platform == RC_PLAT_WIN ? "Windows" : p->platform == RC_PLAT_MAC ? "Mac" : "tool", rc_status_name(p->status),
                p->rtt_us / 1000.0, g_rd[i].id == p->id ? g_rd[i].d / 1000.0 : (double)O.delay_ms, p->rx_snap, p->seq_lost,
                (unsigned long long)m->n_interp, (unsigned long long)m->n_extrap, (unsigned long long)m->n_hold,
                (unsigned long long)m->n_dup, (unsigned long long)m->n_stale, (unsigned long long)m->n_snap, (double)m->err_max, (unsigned long long)m->n_epoch);
    }
    roam_plat_unlock();
    g_cost_win_t0 = host; g_cost_win_sum = g_cost_win_n = g_cost_win_max = 0;
}

static int loads_waiting(void){
    int n = 0;
    for (int k = 0; k < NSLOT; k++) n += (g_sl[k].st == SL_CREATING) + (g_sl[k].h_new != 0);
    return n;
}
/* What costs a frame time: a car of our own made (its paint textures, its
 * first ride asked for, or CreateCar), a ride asked for.  At most two a
 * frame: 32 friends arriving at once made 29 cars in one frame (112 ms) */
#define HEAVY_PER_FRAME 2
static int g_heavy;
/* choose which friends get the slots: visible ones, nearest first; a slot
 * keeps its friend while the friend stays visible, unless a much nearer
 * friend has none (step 5: with the server's hub there can be more
 * friends near us than slots).  A friend whose car
 * cannot be made now (no car memory, a record not understood) is skipped
 * for this frame and the next one is served: a farther friend whose look a
 * parked car already wears, or one with a car that fits, is not kept
 * waiting behind him (int3a review: a nearest friend without memory hid
 * every other friend until he left) */
static void assign(CPU *c, int64_t host){
    int nslots = O.max_cars;
    uint8_t tried[RC_TABLE] = {0};             /* g_pv indices refused this frame */
    for (int k = 0; k < nslots; k++){
        Slot *s = &g_sl[k];
        if (s->st == SL_FREE || s->st == SL_PARKED) continue;
        int found = -1;
        for (int i = 0; i < g_npv; i++) if (g_pv[i].idx == s->peer && g_pv[i].id == s->peer_id) found = i;
        if (found < 0){ release(c, k, "left"); continue; }
        if (!g_pv[found].visible){
            if (!s->unseen_since) s->unseen_since = host;
            if (host - s->unseen_since > 60000000) release(c, k, "away for a minute");
        } else s->unseen_since = 0;
    }
    for (;;){
        /* the nearest visible friend without a slot */
        int best = -1;
        for (int i = 0; i < g_npv; i++){
            if (tried[i] || !g_pv[i].visible || !g_pv[i].has_cfg || !g_pv[i].cfg_len || !g_pv[i].have_pose) continue;
            int has = 0;
            for (int k = 0; k < nslots; k++)
                if (g_sl[k].st != SL_FREE && g_sl[k].st != SL_PARKED && g_sl[k].peer == g_pv[i].idx && g_sl[k].peer_id == g_pv[i].id) has = 1;
            if (has) continue;
            if (best < 0 || g_pv[i].dist < g_pv[best].dist) best = i;
        }
        if (best < 0) return;
        PeerView *v = &g_pv[best];
        int k = -1, reuse = 0;
        /* 1. a parked car already wearing this look: no load at all */
        for (int j = 0; j < nslots && k < 0; j++)
            if (g_sl[j].st == SL_PARKED && g_sl[j].look == v->look && ok(g_sl[j].car, 0x9e0)){ k = j; reuse = 1; }
        /* 2. a free slot: an opponent car while the outrun manager is idle,
         *    else one of our own */
        for (int j = 0; j < nslots && k < 0; j++){
            if (g_sl[j].st != SL_FREE) continue;
            if (j < NOPP){
                if (O.test_owncars) continue;
                uint32_t w = world(), car = w && g_em == EM_HELD ? free_opponent_car(w) : 0;
                if (!car) continue;
                g_sl[j].car = car; g_sl[j].world = w; g_sl[j].created = 0;
            }
            k = j;
        }
        /* 3. a parked car with another look: the new ride replaces it */
        for (int j = 0; j < nslots && k < 0; j++) if (g_sl[j].st == SL_PARKED && ok(g_sl[j].car, 0x9e0)) k = j;
        if (k < 0){
            /* 4. a friend out of sight: the one unseen the longest gives way */
            int far = -1;
            for (int j = 0; j < nslots; j++)
                if (g_sl[j].st == SL_ACTIVE && g_sl[j].unseen_since && !du_keeps(j) && (far < 0 || g_sl[j].unseen_since < g_sl[far].unseen_since)) far = j;
            /* 5. else the farthest shown one, for a friend much nearer (well
             *    within 60 % of its distance and 50 m nearer: no swapping
             *    back and forth at the edge) -- with more players than
             *    slots, the cars shown are the nearest ones */
            if (far < 0){
                float fd = 0.f; int fj = -1;
                for (int j = 0; j < nslots; j++){
                    if (g_sl[j].st != SL_ACTIVE || du_keeps(j)) continue;
                    for (int i = 0; i < g_npv; i++)
                        if (g_pv[i].idx == g_sl[j].peer && g_pv[i].id == g_sl[j].peer_id && g_pv[i].dist > fd){ fd = g_pv[i].dist; fj = j; }
                }
                if (fj >= 0 && v->dist < fd * 0.6f && fd - v->dist > 50.f) far = fj;
            }
            if (far < 0) return;
            release(c, far, g_sl[far].unseen_since ? "slot needed for a nearer friend" : "a much nearer friend takes the slot");
            continue;
        }
        Slot *s = &g_sl[k];
        int was = s->st;
        s->peer = v->idx; s->peer_id = v->id; s->unseen_since = 0; s->near_since = 0;
        snprintf(s->name, sizeof s->name, "%s", v->name);
        if (reuse){
            s->st = SL_ACTIVE; s->cfg_gen = v->cfg_gen; s->hidden = 1; g_acquires++; g_reuses++;
            set_name(s);
            rlog("[roam] f=%ld slot %d for %s, %.0f m away: the parked %s already wears this look\n", rh_frame(), k,
                    s->name, (double)v->dist, s->carname);
            continue;
        }
        if (g_heavy >= HEAVY_PER_FRAME){                                        /* the next frame */
            s->peer = -1; s->peer_id = 0; s->name[0] = 0;
            if (was == SL_FREE && k < NOPP){ s->car = 0; s->world = 0; }
            return;
        }
        g_heavy++;
        if (k >= NOPP && !s->car){
            if (!begin_create(c, k)){ s->peer = -1; s->peer_id = 0; s->name[0] = 0; tried[best] = 1; continue; }
            s->st = SL_CREATING; g_acquires++;
            rlog("[roam] f=%ld slot %d (car of our own, being created) for %s, %.0f m away\n", rh_frame(), k, s->name,
                    (double)v->dist);
            continue;
        }
        if (!begin_load(c, k, v->cfg, v->cfg_len, v->cfg_gen)){
            /* not now (memory, record): try again later */
            s->peer = -1; s->peer_id = 0; s->name[0] = 0;
            if (was == SL_FREE && k < NOPP){ s->car = 0; s->world = 0; }
            tried[best] = 1;
            continue;
        }
        s->st = SL_LOADING; g_acquires++;
        rlog("[roam] f=%ld slot %d (%s) for %s, %.0f m away\n", rh_frame(), k,
                k < NOPP ? "free-roam opponent car" : "car of our own", s->name, (double)v->dist);
    }
}

void roam_game_frame(CPU *c){
    if (!g_inited) init_once(c);
    if (!O.on) return;
    uint64_t t0 = rh_ns();
    int64_t host = roam_plat_now_us();
    int in_roam = roaming();
    uint32_t w = world();
    /* a different world: every slot of the old one is gone */
    if (w != g_world_seen){
        if (g_world_seen){
            int any = 0; for (int k = 0; k < NSLOT; k++) if (g_sl[k].st != SL_FREE || g_sl[k].car) any = 1;
            if (any || g_npending) rlog("[roam] f=%ld world 0x%08x -> 0x%08x: friends' cars gone with it\n", rh_frame(), g_world_seen, w);
            world_gone();
            flush_unloads(c);                           /* before the next world loads its own cars */
            memset(&g_tag, 0, sizeof g_tag);            /* never touch the old HUD's objects */
            memset(&g_mm, 0, sizeof g_mm);              /* (nor its minimap's: the next HUD may be at its address) */
        }
        g_world_seen = w;
    }
    if (g_npending && (!w || in_roam)) flush_unloads(c);      /* the old world's cars are gone */
    /* sync clock */
    float wdt = rd32(G_FLOW) == 6u ? MRF32(G_WORLDDT) : 0.f;
    if (!__builtin_isfinite(wdt) || wdt < 0 || wdt > 1.f) wdt = 0;
    int64_t frame_dt = 0;                       /* the sync clock's step this frame (remote cars move by it) */
    int64_t hdt = host - g_last_host;
    if (hdt < 0 || hdt > 1000000) hdt = 0;
    if (!in_roam){
        g_sync = (double)host; g_sync_paused = 0;
        if (g_in_roam){ roam_plat_lock(); rc_bump_clock(&g_s); roam_plat_unlock(); }
    } else if (!g_in_roam){
        g_sync = (double)host; g_sync_paused = 0;
        roam_plat_lock(); rc_bump_epoch(&g_s); rc_bump_clock(&g_s); roam_plat_unlock();
        g_lp_ok = 0; g_cfg_next = 0;
        if (!g_gmem) gmem_init(c);
        memset(&g_tag, 0, sizeof g_tag);                /* the labels of this stay in free roam's HUD */
    } else if (wdt <= 0.f){
        /* paused, SMS, map, streaming: the local world stands, but friends
         * keep driving, so the clock follows the host clock */
        g_sync_paused++;
        if (hdt > 0){ g_sync += (double)hdt; frame_dt = hdt; }
    } else {
        /* the world moved: the clock advances by world dt (what the cars
         * moved by, so stamps and motion agree) and is pulled to the host
         * clock with a 250 ms time constant.  A world that runs slower than
         * real time -- the game's 50 ms dt clamp below 20 fps, a frame
         * limiter's smaller clamp, slow motion, hitches -- leaves it a
         * steady (1 - rate) x 250 ms behind instead of drifting off: a
         * friend's car still moves in real time on every screen, and a
         * re-anchor (a re-sync at every friend) is left for stalls of over
         * a second */
        double before = g_sync;
        g_sync += wdt * 1e6;
        double err = (double)host - g_sync;
        if (__builtin_fabs(err) > 1000000.0){
            g_sync = (double)host; g_clock_snaps++;
            roam_plat_lock(); rc_bump_clock(&g_s); roam_plat_unlock();
        } else {
            double k = (double)hdt / 250000.0;
            g_sync += err * (k < 1.0 ? k : 1.0);
            if (g_sync < before) g_sync = before;               /* never backwards */
        }
        double step = g_sync - before;
        frame_dt = (int64_t)step;
        /* world time per stamp time, smoothed alike (1 while the world runs
         * in real time) */
        double r = step > 1.0 ? (double)wdt * 1e6 / step : 1.0;
        if (r > 1.0) r = 1.0;
        if (r < 0.05) r = 0.05;
        double kk = (double)hdt / 250000.0;
        g_vscale += (r - g_vscale) * (kk < 1.0 ? kk : 1.0);
        g_sync_paused = 0;
    }
    g_in_roam = in_roam;
    g_last_host = host;
    /* the player's name: the profile's, unless NFSU2_ROAM_NAME */
    if (!O.name[0] && ok(G_PROFILE_NAME, 16) && MR8(G_PROFILE_NAME) >= 0x20){
        char pn[17]; cstr(G_PROFILE_NAME, pn, sizeof pn);
        if (pn[0] && strcasecmp(pn, "No Profile")){
            rc_name_clean(O.name, pn, 16);
            roam_plat_lock(); snprintf(g_s.conf.name, sizeof g_s.conf.name, "%s", O.name); roam_plat_unlock();
            rlog("[roam] my name: %s (the profile's; NFSU2_ROAM_NAME changes it)\n", O.name);
        }
    }
    /* local state and look; the horn only while the world runs (not in the
     * pause menu, the map or the messages) */
    int world_runs = in_roam && g_sync_paused <= 1 && !g_parked;
    g_horn = world_runs && rh_horn_held();
    rc_state ls; int have_ls = in_roam && local_state(&ls);
    uint8_t cfgb[RC_CFG_MAX]; int cfgn = 0; char tname[RC_CFG_TYPE_NAME + 1] = {0};
    if (in_roam && host >= g_cfg_next){ cfgn = local_cfg(cfgb, sizeof cfgb, tname); g_cfg_next = host + 5000000; }
    if (have_ls){
        if (g_lp_ok){
            float dx = ls.p[0] - g_lp[0], dy = ls.p[1] - g_lp[1], dz = ls.p[2] - g_lp[2];
            float v = rc_sqrtf(ls.v[0]*ls.v[0] + ls.v[1]*ls.v[1] + ls.v[2]*ls.v[2]) / (float)g_vscale;
            if (rc_sqrtf(dx*dx + dy*dy + dz*dz) > v * wdt + 10.f){
                g_teleports++; ghost_all(); roam_plat_lock(); rc_bump_epoch(&g_s); roam_plat_unlock(); }
        }
        memcpy(g_lp, ls.p, sizeof g_lp); g_lp_ok = 1;
    }
    roam_plat_lock();
    rc_set_status(&g_s, local_status(in_roam));
    if (cfgn > 0){
        uint16_t before = g_s.cfg_rev;
        rc_set_cfg(&g_s, cfgb, cfgn, host);
        if (g_s.cfg_rev != before) rlog("[roam] f=%ld my car: %s, %d-byte record, revision %u\n", rh_frame(), tname, cfgn, g_s.cfg_rev);
    }
    if (have_ls) rc_push_state(&g_s, &ls, host);
    /* outrun messages for us (du_frame) */
    uint32_t duin[4 * RC_DUEL_INBOX]; int nduin = 0;
    while (nduin < RC_DUEL_INBOX){
        uint8_t op, arg;
        if (!rc_take_duel(&g_s, &duin[4 * nduin], &op, &arg, &duin[4 * nduin + 3])) break;
        duin[4 * nduin + 1] = op; duin[4 * nduin + 2] = arg; nduin++;
    }
    /* what the slots need from the session */
    g_npv = 0;
    if (in_roam){
        for (int i = 0; i < RC_TABLE; i++){
            rc_peer *p = &g_s.peer[i];
            if (p->state != RC_PS_EST) continue;
            PeerView *v = &g_pv[g_npv++];
            v->idx = i; v->id = p->id; snprintf(v->name, sizeof v->name, "%s", p->name);
            /* shown while it is in free roam and its snapshots keep coming,
             * or while it is paused there: a paused game (pause menu, or a
             * window in the background: lifecycle.c parks the game, no
             * frames, no snapshots) still pings and announces, and its car
             * holds still where it stopped (roam_core.c).  With the snapshot
             * age rule alone a friend's car vanished 2 s after their window
             * lost focus, and came back when it got it again. */
            v->visible = !p->lost && p->mo.n > 0 &&
                         (p->status == RC_ST_PAUSED ||
                          (p->status == RC_ST_ROAM && host - p->last_snap_rx < 2000000));
            v->paused = p->status == RC_ST_PAUSED; v->duels = p->duels;
            v->cfg_gen = p->cfg_gen; v->cfg_len = 0; v->has_cfg = p->cfg_len > 0; v->err = 0;
            int slotted = -1;
            for (int k = 0; k < NSLOT; k++) if (g_sl[k].st != SL_FREE && g_sl[k].st != SL_PARKED && g_sl[k].peer == i && g_sl[k].peer_id == p->id) slotted = k;
            /* the record only when a slot will need it */
            if (p->cfg_len && (slotted < 0 || g_sl[slotted].cfg_gen != p->cfg_gen)){
                memcpy(v->cfg, p->cfg, (size_t)p->cfg_len); v->cfg_len = p->cfg_len; v->look = rc_fnv1a_bytes(p->cfg, (uint32_t)p->cfg_len); }
            v->have_pose = 0;
            if (v->visible){
                if (slotted >= 0 && g_sl[slotted].st == SL_ACTIVE){
                    /* the car was not drawn last frame (just loaded, the
                     * friend back from a park, a stall, a shop, or we are
                     * back in free roam): it appears where the friend is,
                     * not blended from where it was last drawn seconds ago
                     * (int3a review: up to 5 m of slide after a clock
                     * re-anchor) */
                    if (g_sl[slotted].hidden) p->mo.snap_pending = 1;
                    v->have_pose = rc_interp_eval(&p->mo, (int64_t)g_sync, frame_dt, render_delay(i, p, frame_dt),
                                                  (int64_t)O.extrap_ms * 1000, &v->pose);
                }
                else v->have_pose = rc_interp_peek(&p->mo, p->mo.t[p->mo.n - 1], 0, &v->pose);
            }
            float dx = v->pose.p[0] - g_lp[0], dy = v->pose.p[1] - g_lp[1];
            v->dist = v->have_pose ? rc_sqrtf(dx*dx + dy*dy) : 1e9f;
            v->err = rc_sqrtf(p->mo.err_p[0] * p->mo.err_p[0] + p->mo.err_p[1] * p->mo.err_p[1] + p->mo.err_p[2] * p->mo.err_p[2]);
        }
    }
    roam_plat_unlock();
    /* slots (guest calls, outside the lock) */
    if (!in_roam){
        if (w) park_all(c);
    } else {
        /* the outrun challengers' manager first: whether opponent cars are
         * free this frame depends on it */
        int want = 0;
        for (int k = 0; k < NSLOT; k++) if (g_sl[k].st != SL_FREE && g_sl[k].st != SL_PARKED) want = 1;
        for (int i = 0; i < g_npv; i++) if (g_pv[i].visible && g_pv[i].has_cfg && g_pv[i].have_pose) want = 1;
        em_update(c, want, host);
        g_heavy = 0;
        assign(c, host);
        for (int k = 0; k < NSLOT; k++){
            Slot *s = &g_sl[k];
            if (s->st == SL_FREE || s->st == SL_PARKED) continue;
            PeerView *v = 0;
            for (int i = 0; i < g_npv; i++) if (g_pv[i].idx == s->peer && g_pv[i].id == s->peer_id) v = &g_pv[i];
            if (!v) continue;
            /* a second first: a hitch in the friend's game (streaming) is a pause too */
            if (!v->paused) s->paused_since = 0;
            else if (!s->paused_since) s->paused_since = host;
            s->paused = s->paused_since && host - s->paused_since >= 1000000;
            if (s->st == SL_CREATING){
                if (g_heavy >= HEAVY_PER_FRAME) continue;                          /* CreateCar: the next frame */
                int r = finish_create(c, k);
                if (r > 0) g_heavy++;
                if (r < 0){ release(c, k, "could not create a car"); continue; }
                if (r > 0){
                    if (v->cfg_len > 0 && begin_load(c, k, v->cfg, v->cfg_len, v->cfg_gen)) s->st = SL_LOADING;
                    else release(c, k, "the car could not be loaded now");
                }
                continue;
            }
            if (s->st == SL_LOADING){
                int r = finish_load(c, k);
                if (r > 0) s->st = SL_ACTIVE;
                else if (r < 0) release(c, k, "load failed");
                continue;
            }
            if (!ok(s->car, 0x9e0)) continue;
            /* a new look: load it while the old one stays on */
            if (!s->h_new && v->cfg_len > 0 && v->cfg_gen != s->cfg_gen && g_heavy < HEAVY_PER_FRAME && begin_load(c, k, v->cfg, v->cfg_len, v->cfg_gen))
                g_heavy++;
            if (s->h_new){
                int r = finish_load(c, k);
                if (r < 0) s->cfg_gen = v->cfg_gen;                 /* do not retry this one */
            }
            if (v->visible && v->have_pose){
                make_inert(c, s->car);
                /* appearing, or a jump (the friend's teleport, a snap): a
                 * ghost until clear, never shoving the player's car out */
                float jx = v->pose.p[0] - s->drawn[0], jy = v->pose.p[1] - s->drawn[1], jz = v->pose.p[2] - s->drawn[2];
                if (s->hidden || jx * jx + jy * jy + jz * jz > JUMP_M * JUMP_M) s->ghost = 1;
                apply_pose(c, s, &v->pose, (float)frame_dt / 1e6f);
                body_update(c, k);
                for (int i = 0; i < 3; i++) s->drawn[i] = v->pose.p[i];
                s->hidden = 0;
                if (g_poselog)
                    rh_fprintf(g_poselog, "R,%lld,%.0f,%08x,%.4f,%.4f,%.4f,%.3f,%d,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f\n", (long long)host, g_sync, s->peer_id,
                            (double)v->pose.p[0], (double)v->pose.p[1], (double)v->pose.p[2], (double)v->pose.speed, v->pose.mode, (double)v->err,
                            (double)MRF32(s->car + 0x90u), (double)MRF32(s->car + 0x94u), (double)MRF32(s->car + 0x98u), (double)MRF32(s->car + 0xb8u),
                            (double)MRF32(s->car + 0x50u), (double)MRF32(s->car + 0x54u), (double)MRF32(s->car + 0x58u));
            } else if (!s->hidden && !(g_du.st == DU_RACE && s->car == g_du.car)){ soft_park(c, s->car); s->hidden = 1; }
            /* (an outrun's opponent stays where it was: parked, the game would count it 120 km behind) */
        }
        arrows_update(c, w);
        int busy = 0;
        for (int k = 0; k < NSLOT; k++) if (g_sl[k].st != SL_FREE && g_sl[k].st != SL_PARKED) busy = 1;
        if (busy) g_em_release_at = 0;
        else if (g_em == EM_HELD){
            /* no friend's car in this world for a minute: the opponent cars
             * get their own rides back and the outrun challengers return */
            if (!g_em_release_at) g_em_release_at = host + 60000000;
            if (host >= g_em_release_at){
                for (int k = 0; k < NOPP; k++) if (g_sl[k].st == SL_PARKED){ restore(c, k); g_restores++; }
                if (!opp_slots_used()) em_let_go();
                g_em_release_at = 0;
            }
        }
    }
    du_frame(c, host, in_roam, world_runs, duin, nduin);
    horns_update(have_ls ? &ls : 0, world_runs);
    if (g_poselog && have_ls){
        uint32_t me = player_car();
        rh_fprintf(g_poselog, "L,%lld,%.0f,%08x,%.4f,%.4f,%.4f,%.3f,0,0,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f\n", (long long)host, g_sync, g_s.conf.self_id,
                (double)ls.p[0], (double)ls.p[1], (double)ls.p[2], (double)ls.speed,
                (double)MRF32(me + 0x90u), (double)MRF32(me + 0x94u), (double)MRF32(me + 0x98u), (double)MRF32(me + 0xb8u),
                (double)MRF32(me + 0x50u), (double)MRF32(me + 0x54u), (double)MRF32(me + 0x58u));
        static int nfl; if (++nfl % 240 == 0) rh_fflush(g_poselog);
    }
    cost_add(t0);
    periodic_log(host);
#ifdef ROAM_HOST_SCRIPT
    for (int j = 0; j < g_njob; j++) run_job(c, g_job[j]);
    g_njob = 0;
#endif
}

/* the port's hook after the HUD update (roam.c, in 0x600590 behind its call
 * of 0x4EC5A0, on the guest thread): the names over friends' cars, placed
 * with this frame's camera, where the game places its own */
void roam_game_hud(CPU *c){
    if (!O.on || !g_net_ok) return;
    uint64_t t0 = rh_ns();
    tags_update(c);
    if (DUELS) du_hud(c, roam_plat_now_us());
    g_cost_hud += rh_ns() - t0;
}

/* ---- report at exit ----------------------------------------------------------------------------- */
void roam_game_report(void){
    if (!O.on || !g_net_ok) return;
    roam_plat_stats ps; roam_plat_get_stats(&ps);
    rlog("\n  [roam] free-roam multiplayer: joins %d, leaves %d, slots acquired %u / released %u, cars created %u, "
                    "load failures %u, looks reused %u, rides given back %u, local teleports %u, clock re-anchors %u\n", __atomic_load_n(&g_joins, __ATOMIC_RELAXED),
            __atomic_load_n(&g_leaves, __ATOMIC_RELAXED), g_acquires, g_releases, g_creates, g_load_fail, g_reuses, g_restores, g_teleports, g_clock_snaps);
    rlog("  [roam] datagrams sent %llu (%llu bytes), received %llu (%llu bytes), blocked %llu, send errors %llu, "
                    "impairment dropped %llu duplicated %llu\n", (unsigned long long)ps.sent, (unsigned long long)ps.sent_bytes,
            (unsigned long long)ps.recv, (unsigned long long)ps.recv_bytes, (unsigned long long)ps.blocked,
            (unsigned long long)ps.send_err, (unsigned long long)ps.impair_drop, (unsigned long long)ps.impair_dup);
    if (g_du.offers || g_du.races) rlog("  [roam] outruns with friends: %u challenge(s) made, %u raced, %u won, %u lost\n",
                                        g_du.offers, g_du.races, g_du.wins, g_du.losses);
    rlog("  [roam] game-thread cost per frame: mean %.1f us, max %.1f us over %llu frames\n",
            g_cost_n ? g_cost_sum / 1000.0 / (double)g_cost_n : 0.0, g_cost_max / 1000.0, (unsigned long long)g_cost_n);
    if (g_poselog){ rh_fflush(g_poselog); }
    roam_plat_stop(0);
}

/* ---- script commands ("roam mp ...", roam.c; the port's test harness only) ------------------- */
#ifdef ROAM_HOST_SCRIPT
#define G_HOTPOS        0x00890140u
#define G_HOTPOS_ANGLE  0x008900d0u
#define G_HOTPOS_JUMP   0x008900cdu
#define G_HOTPOS_VALID  0x008900ceu
int roam_game_cmd(CPU *c, const char *args, long *wait_start){
    (void)c;
    char sub[32] = {0}, a1[200] = {0}, a2[64] = {0}; int used = 0;
    sscanf(args, "%31s %n", sub, &used);
    sscanf(args + used, "%199s %63s", a1, a2);
    long f = rh_frame();
    if (!O.on){ rlog("[roam] f=%ld mp %s: multiplayer is off (NFSU2_ROAM=1)\n", f, sub); return 1; }
    if (!strcasecmp(sub, "status")){
        roam_plat_lock();
        rlog("[roam] f=%ld mp status: %s, %d friend(s), my cfg rev %u\n", f, rc_status_name(g_s.status), rc_established(&g_s), g_s.cfg_rev);
        for (int i = 0; i < RC_TABLE; i++){
            const rc_peer *p = &g_s.peer[i]; char b[16];
            if (p->state == RC_PS_FREE) continue;
            rlog("[roam]   peer %d %s:%u id %08x state %d %s (%s) cfg rev %u%s, %d states\n", i, roam_ip_str(p->ip, b), p->port,
                    p->id, p->state, p->name, rc_status_name(p->status), p->cfg_rev, p->cfg_len ? "" : " (none yet)", p->mo.n);
        }
        roam_plat_unlock();
        uint32_t icons = rd32(G_MM_ICONS); int arrows = 0, freev = 0;
        for (uint32_t n = ok(icons, 0x1c) ? rd32(icons) : 0, m = 0; n && n != icons && m < 256; n = rd32(n), m++)
            if (ok(rd32(n + 0x1cu), 8) && MR32(rd32(n + 0x1cu) + 4u) == MM_AIRACER) arrows++;
        for (uint32_t n = rd32(G_MM_VISUALS), m = 0; n && n != G_MM_VISUALS && m < 256; n = rd32(n), m++)
            if (ok(rd32(n + 8u), 8) && MR32(rd32(n + 8u) + 4u) == MM_AIRACER) freev++;
        rlog("[roam]   minimap: %d cars' arrows, %d free, %d copies of AIRACERINDICATOR_0\n", arrows, freev, g_mm.ncopy);
        uint32_t me = player_car();
        if (me) rlog("[roam]   me: car 0x%08x at %.1f %.1f %.1f heading 0x%04x speed %.1f\n", me, (double)MRF32(me + 0x60u),
                        (double)MRF32(me + 0x64u), (double)MRF32(me + 0x68u), MR16(me + 0x40cu), (double)MRF32(me + 0x42cu));
        for (int k = 0; k < NSLOT; k++) if (g_sl[k].st != SL_FREE){
            uint32_t car = g_sl[k].car;
            float dx = car ? MRF32(car + 0x60u) - (me ? MRF32(me + 0x60u) : 0) : 0, dy = car ? MRF32(car + 0x64u) - (me ? MRF32(me + 0x64u) : 0) : 0;
            rlog("[roam]   slot %d: %s %s car 0x%08x %s, %u frames posed; at %.1f %.1f %.1f (%.1f m away) heading 0x%04x, "
                            "on track %u, active %u, driver %u, physics %u, render 0x%08x, index %d, drawn at %.1f %.1f %.1f\n", k, g_sl[k].name, g_sl[k].carname, car,
                    g_sl[k].st == SL_ACTIVE ? (g_sl[k].hidden ? "hidden" : "shown") : g_sl[k].st == SL_PARKED ? "parked" : "loading", g_sl[k].pose_frames,
                    car ? (double)MRF32(car + 0x60u) : 0, car ? (double)MRF32(car + 0x64u) : 0, car ? (double)MRF32(car + 0x68u) : 0,
                    sqrt((double)(dx * dx + dy * dy)), car ? MR16(car + 0x40cu) : 0, car ? MR8(car + 0x5c0u) : 0, car ? MR8(car + 0x550u) : 0,
                    car ? MR32(car + 0x24u) : 0, car ? MR32(car + 0x28u) : 0, car ? MR32(car + 0x554u) : 0, car ? (int16_t)MR16(car + 8u) : -1,
                    car ? (double)MRF32(car + 0x50u) : 0, car ? (double)MRF32(car + 0x54u) : 0, car ? (double)MRF32(car + 0x58u) : 0);
        }
        return 1;
    }
    if (!strcasecmp(sub, "waitpeers") || !strcasecmp(sub, "waitcars") || !strcasecmp(sub, "waitsolid")){
        /* friends established / friends' cars shown / of those, solid (no longer ghosts) */
        int want = atoi(a1); long tmo = a2[0] ? atol(a2) : 0;
        if (*wait_start < 0) *wait_start = f;
        int have = 0;
        if (!strcasecmp(sub, "waitpeers")){ roam_plat_lock(); have = rc_established(&g_s); roam_plat_unlock(); }
        else for (int k = 0; k < NSLOT; k++)
            if (g_sl[k].st == SL_ACTIVE && !g_sl[k].hidden && (strcasecmp(sub, "waitsolid") || (O.collide && !g_sl[k].ghost))) have++;
        if (have >= want){ rlog("[roam] f=%ld mp %s %d satisfied after %ld frames\n", f, sub, want, f - *wait_start); *wait_start = -1; return 1; }
        if (tmo && f - *wait_start >= tmo){ rlog("[roam] f=%ld mp %s %d TIMEOUT (have %d)\n", f, sub, want, have); *wait_start = -1; return 1; }
        return 0;
    }
    if (!strcasecmp(sub, "follow")){
        /* "mp follow K [back] [left]": the player jumps behind slot K's car
         * (hot-position jump), for frame dumps; left 0 puts it right behind
         * (the collision tests drive into the friend's car from there) */
        char a3[32] = {0}; sscanf(args + used, "%*s %*s %31s", a3);
        int k = atoi(a1); float back = a2[0] ? (float)atof(a2) : 12.f;
        if (a1[0] < '0' || a1[0] > '9'){ k = -1; for (int j = 0; j < NSLOT; j++) if (g_sl[j].st != SL_FREE && !strcasecmp(g_sl[j].name, a1)) k = j; }
        if (k < 0 || k >= NSLOT || g_sl[k].st != SL_ACTIVE || g_sl[k].hidden){ rlog("[roam] f=%ld mp follow %d: no car shown there\n", f, k); return 1; }
        uint32_t car = g_sl[k].car;
        /* by default behind it and 3.5 m to the left, so that the player's
         * own car (the chase camera looks over it) does not hide the friend's */
        float fx = MRF32(car + 0x90u), fy = MRF32(car + 0x94u), lx = MRF32(car + 0xa0u), ly = MRF32(car + 0xa4u);
        float side = a3[0] ? (float)atof(a3) : 3.5f;
        MRF32(G_HOTPOS) = MRF32(car + 0x60u) - back * fx + side * lx; MRF32(G_HOTPOS + 4) = MRF32(car + 0x64u) - back * fy + side * ly;
        MRF32(G_HOTPOS + 8) = MRF32(car + 0x68u) + 0.5f;
        MR16(G_HOTPOS_ANGLE) = MR16(car + 0x40cu); MR8(G_HOTPOS_VALID) = 1; MR8(G_HOTPOS_JUMP) = 1;
        rlog("[roam] f=%ld mp follow: behind %s's car at %.1f %.1f %.1f\n", f, g_sl[k].name,
                (double)MRF32(car + 0x60u), (double)MRF32(car + 0x64u), (double)MRF32(car + 0x68u));
        return 1;
    }
    if (!strcasecmp(sub, "net")){
        /* "mp net off|on": stop the network (as quitting would: BYE), or
         * restart it with a new id (a rejoin) */
        if (!strcasecmp(a1, "off") && g_net_ok){
            roam_plat_stop(1); g_net_ok = 0;
            rc_config cf = g_s.conf; rc_io io = { 0, 0, 0, 0 };
            roam_plat_lock(); rc_session_init(&g_s, &cf, &io); roam_plat_unlock();   /* no friends any more */
            rlog("[roam] f=%ld mp net off\n", f); }
        else if (!strcasecmp(a1, "on") && !g_net_ok){
            rc_config cf = g_s.conf; cf.self_id = roam_plat_random();
            rc_io io = { 0, 0, 0, 0 };
            rc_session_init(&g_s, &cf, &io);
            roam_plat_cfg pc = { cf.port, O.test, cf.discovery, rh_opt("NFSU2_ROAM_IMPAIR") };
            if (roam_plat_start(&pc, &g_s) == 0){
                g_net_ok = 1;
                uint32_t pip[RC_MAX_PEERS * 2]; uint16_t ppt[RC_MAX_PEERS * 2];
                int np = roam_plat_parse_peers(opt("NFSU2_ROAM_PEERS"), O.test, cf.port, pip, ppt, RC_MAX_PEERS * 2);
                roam_plat_lock(); for (int i = 0; i < np; i++) rc_add_peer(&g_s, pip[i], ppt[i], 1, roam_plat_now_us()); roam_plat_unlock();
                g_cfg_next = 0;
                rlog("[roam] f=%ld mp net on: id %08x\n", f, cf.self_id);
            }
        }
        return 1;
    }
    if (!strcasecmp(sub, "outrun") || !strcasecmp(sub, "waitoutrun")){
        /* "mp outrun": the outrun with a friend; "mp waitoutrun STATE [tmo]":
         * wait for prompt (the challenge is offered), idle, sent, got,
         * accepted, race or over */
        static const char *const st[] = { "idle", "sent", "got", "accepted", "race", "over" };
        if (!strcasecmp(sub, "outrun")){
            rlog("[roam] f=%ld mp outrun: %s%s%s%s, %.0f m apart, getting away %.1f m/s faster; %u challenge(s), %u raced, %u won, %u lost\n", f, st[g_du.st],
                    g_du.id ? " with " : "", g_du.id ? g_du.name : "", g_du.icon ? ", challenge offered" : "", (double)g_du.gap, (double)g_du.away,
                    g_du.offers, g_du.races, g_du.wins, g_du.losses);
            return 1;
        }
        long tmo = a2[0] ? atol(a2) : 0;
        if (*wait_start < 0) *wait_start = f;
        int have = !strcasecmp(a1, "prompt") ? g_du.st == DU_IDLE && g_du.icon : !strcasecmp(a1, st[g_du.st]);
        if (have){ rlog("[roam] f=%ld mp waitoutrun %s satisfied after %ld frames\n", f, a1, f - *wait_start); *wait_start = -1; return 1; }
        if (tmo && f - *wait_start >= tmo){ rlog("[roam] f=%ld mp waitoutrun %s TIMEOUT (%s)\n", f, a1, st[g_du.st]); *wait_start = -1; return 1; }
        return 0;
    }
    if (!strcasecmp(sub, "cfgdump") || !strcasecmp(sub, "cfgtest")){
        if (g_njob == NJOB){ rlog("[roam] f=%ld mp %s: busy\n", f, sub); return 1; }
        snprintf(g_job[g_njob++], sizeof g_job[0], "%s", args);
        return 1;
    }
    rlog("[roam] f=%ld mp: unknown '%s'\n", f, sub);
    return 1;
}
static void run_job(CPU *c, const char *job){
    char sub[32] = {0}, a1[200] = {0}, a2[64] = {0}; int used = 0;
    sscanf(job, "%31s %n", sub, &used);
    sscanf(job + used, "%199s %63s", a1, a2);
    long f = rh_frame();
    if (!strcasecmp(sub, "cfgdump")){
        /* write a car-look record: the player's car, or a stock car of type N */
        uint8_t b[RC_CFG_MAX]; int n = 0; char tn[RC_CFG_TYPE_NAME + 1] = {0};
        if (a2[0]){
            uint32_t t = (uint32_t)atoi(a2), types = rd32(G_CARTYPES);
            rc_carcfg cc; memset(&cc, 0, sizeof cc);
            if (types && t < 46){ cc.type_hash = MR32(types + t * 0x890u + 0xd0u); cstr(types + t * 0x890u, cc.type_name, sizeof cc.type_name);
                cc.ride_b[3] = 1; n = rc_carcfg_encode(&cc, b, sizeof b); snprintf(tn, sizeof tn, "%s", cc.type_name); }
        } else n = local_cfg(b, sizeof b, tn);
        FILE *o = n > 0 ? fopen(a1, "wb") : 0;
        if (o){ fwrite(b, 1, (size_t)n, o); fclose(o); }
        rlog("[roam] f=%ld mp cfgdump %s: %s, %d bytes\n", f, a1, tn, n);
        return;
    }
    if (!strcasecmp(sub, "cfgtest")){
        /* the player's look -> record -> a RideInfo built from it: every part
         * slot and the derived bytes must come out the same */
        uint8_t b[RC_CFG_MAX]; char tn[RC_CFG_TYPE_NAME + 1];
        int n = local_cfg(b, sizeof b, tn);
        rc_carcfg cc;
        if (n <= 0 || rc_carcfg_decode(b, n, &cc) != RC_OK || !g_gmem){ rlog("[roam] f=%ld mp cfgtest: no record\n", f); return; }
        uint32_t car = player_car(), src = rd32(car + 0x10u), dst = g_sl[NSLOT - 1].ride_new;
        char why[96] = {0};
        int miss = build_ride(c, &cc, dst, 1u, why, sizeof why);      /* the player's skin slot */
        int diff_slots = 0, diff_bytes = 0, first = -1;
        for (uint32_t sl = 0; sl < RC_PART_SLOTS; sl++) if (MR32(src + 0x590u + 4u * sl) != MR32(dst + 0x590u + 4u * sl)) diff_slots++;
        for (uint32_t o = 0; o < 0x8f0u; o++){
            if (o >= 0x10u && o < 0x580u) continue;                  /* physics/tuning block: not visual */
            if (MR8(src + o) != MR8(dst + o)){ diff_bytes++; if (first < 0) first = (int)o; }
        }
        int diff_perf = 0, diff_phys = 0;
        for (uint32_t o = 0x318u; o < 0x3c1u; o++) if ((o < 0x384u || o >= 0x398u) && MR8(src + o) != MR8(dst + o)) diff_perf++;
        for (uint32_t o = 0x10u; o < 0x580u; o++) if (MR8(src + o) != MR8(dst + o)) diff_phys++;
        rlog("[roam] f=%ld mp cfgtest: %s, %d parts in a %d-byte record, %d not found%s%s; rebuilt ride: %d of 170 part slots differ, "
                        "%d other bytes differ (first at +0x%x); performance/tuning bytes differing %d, physics block bytes differing %d\n",
                f, tn, cc.n_parts, n, miss, why[0] ? ": " : "", why, diff_slots, diff_bytes, first, diff_perf, diff_phys);
        return;
    }
}
#endif /* ROAM_HOST_SCRIPT */

#ifndef ROAM_HOST_WIN
/* roam.c, Car::SetPhysicsMode (0x5F46A0): refuse the null brain's wake-up
 * (0x404890, returning to 0x4048B6 for mode 3 or 0x4048C0 for mode 1) of a
 * friend's car.  The game wakes a car in mode 0 into its AI physics on every
 * frame another car is near it (within some 10 m in the tests, touching or
 * not); for a friend's car that physics then ran on
 * a ride built without its physics pass (build_ride), drove the car for the
 * rest of the timestep and left its wheel and suspension state in the car
 * (+0x340..+0x38C), which nothing of ours puts back.  Kept in mode 0 the car
 * is still solid: a car that hits it is pushed in its owner's game as before.
 * Other callers (Car::Activate, SetRideInfo) are not refused: make_inert puts
 * their mode back to 0, as it always did.  1: refused. */
int roam_game_inert(uint32_t car, uint32_t mode, uint32_t from){
    if (!mode || !car || (from != 0x004048b6u && from != 0x004048c0u)) return 0;
    for (int k = 0; k < NSLOT; k++) if (g_sl[k].car == car && (g_sl[k].st == SL_ACTIVE || g_sl[k].st == SL_LOADING)){
        if (!g_sl[k].wakes++) rlog("[roam] f=%ld slot %d: %s's car stays without physics when a car comes near\n", rh_frame(), k, g_sl[k].name);
        return 1;
    }
    return 0;
}
/* roam.c, 0x42CD60, from the race's end (0x5F8490 -> 0x42EFB0): every car of
 * the World's AI range that is out gets a new goal from its brain (car +0x2C):
 * the one at the brain's +0x6FC is looked at and let go through its vtable
 * (0x42AA20 -> 0x402070), and the new one kept there.  During an outrun
 * between players friends' cars are out in that range (the three opponent
 * cars and the first 2 of ours), and their brains (vtable 0x7A5CA8, driver 0)
 * hold no goal there: one held 0xE490B3FC in the tests, and a player's game
 * trapped at an outrun's end reading past the memory (2026-10-20).  The AI
 * range goes without friends' cars for the call, as du_start narrows it. */
void roam_game_goals(CPU *c, void (*orig)(CPU *)){
    uint32_t w = world(), first = w ? MR32(w + 0x14u) : 0, end = w ? MR32(w + 0x18u) : 0, was[WORLD_INDEX], n = first;
    if (!w || first > end || end > WORLD_INDEX){ orig(c); return; }
    for (uint32_t i = first; i < end; i++){
        uint32_t car = was[i] = MR32(w + 0x1cu + 4u * i);
        int ours = 0;
        for (int k = 0; k < NSLOT && !ours; k++) ours = car && g_sl[k].car == car;
        if (!ours) MR32(w + 0x1cu + 4u * n++) = car;
    }
    if (n == end){ orig(c); return; }
    rlog("[roam] f=%ld the race's end: new goals for the AI range's cars, not for %u friends' car(s)\n", rh_frame(), end - n);
    MR32(w + 0x18u) = n;
    orig(c);
    for (uint32_t i = first; i < end; i++) MR32(w + 0x1cu + 4u * i) = was[i];
    MR32(w + 0x18u) = end;
}
/* roam.c, bSlotPool's constructor (0x440DF0), at the game's start.  With
 * free-roam multiplayer on, three pools get more entries:
 *  - the car loader's rides (CarLoadedRideInfoSlotPool, 22 x 0x1240 bytes):
 *    its Load (0x63AE70) waits until one is free, purging, for good when every
 *    entry is in use (the player's, the opponent cars', traffic's (up to 7), a
 *    car of our own's first ride, each friend's): 128 (600 KB);
 *  - the minimap's visuals and icons (MinimapEntity 102 x 8, MinimapElements
 *    102 x 0x20 bytes), taken with 0x43F8F0, which never grows a pool: a
 *    friend's arrow is one of each (minimap arrows), and an icon the pool
 *    could not give is linked in as a null pointer (0x4EC790): 256 each. */
static struct { uint32_t name, count; const char *what; int said; } g_pools[] = {
    { 0x007a8694u, RIDE_ENTRIES, "rides the car loader holds" },   /* "CarLoadedRideInfoSlotPool" */
    { 0x00790b18u, 256, "minimap visuals" },                       /* "MinimapEntity" */
    { 0x00790b08u, 256, "minimap icons" },                         /* "MinimapElements" */
};
uint32_t roam_game_pool(uint32_t name, uint32_t count){
    for (unsigned i = 0; i < sizeof g_pools / sizeof g_pools[0]; i++){
        if (name != g_pools[i].name || count >= g_pools[i].count || !env_int("NFSU2_ROAM", 0, 0, 1)) continue;
        if (!g_pools[i].said++) rlog("[roam] %u %s, not %u (friends' cars)\n", g_pools[i].count, g_pools[i].what, count);
        return g_pools[i].count;
    }
    return count;
}
/* lifecycle.c, on the guest thread, when the app parks the game in the
 * background (Cmd-Tab, hidden: WM_ACTIVATEAPP(FALSE), then the game waits in
 * GetMessageA) and when it lets it run again (lifecycle_game_parked(): not
 * while a LAN session keeps the game running in the background).  No frame
 * runs while parked, but the network thread keeps answering friends with
 * the last status, so a player in free roam is announced as paused now
 * (friends see "paused" and the car standing where it stopped, for as long
 * as the pings keep coming); the next frame after the park sends the real status again.
 * int3a review: friends saw a frozen car marked "free roam". */
void roam_game_parked(int on){
    g_parked = on;
    if (!O.on || !g_net_ok) return;
    roam_plat_lock();
    int was_roam = g_s.status == RC_ST_ROAM;
    if (on && was_roam) rc_set_status(&g_s, RC_ST_PAUSED);
    roam_plat_unlock();
    if (on && was_roam) rlog("[roam] f=%ld the app is in the background: friends see you paused\n", rh_frame());
}
/* discord.c (the port's Discord presence): friends connected now, i.e.
 * established and not lost; 0 while free-roam multiplayer is off.  Takes the
 * session lock, so any thread may ask. */
int roam_game_friends(void){
    if (!O.on || !g_net_ok) return 0;
    int n = 0;
    roam_plat_lock();
    for (int i = 0; i < RC_TABLE; i++) if (g_s.peer[i].state == RC_PS_EST && !g_s.peer[i].lost) n++;
    roam_plat_unlock();
    return n;
}
#endif
