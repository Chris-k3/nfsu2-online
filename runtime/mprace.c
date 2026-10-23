/* mprace.c -- a multiplayer race from free roam: the trip from the career's
 * free roam to the game's own LAN race and back.
 *
 * The free-roam lobby (roam_game.c mp_*) starts it in every game of its
 * players at once.  It drives the game along what a player can do by hand
 * in the original game: pause, Quit (the game keeps where the car was and
 * saves nothing), the main menu's LAN, a LAN game on the career race's track
 * with the career car, the race, Resume Career, the crib, Return to Explore
 * Mode -- which puts the car back where it was.  The career is never called:
 * a LAN race does not touch it (a proof run diffed the career and the save
 * before and after: the save the same byte for byte, the career's saved
 * fields too), so the race neither counts in it nor changes it.  Only the
 * prize goes into the career's bank: in the crib, after it took its snapshot
 * of the profile and before Return to Explore Mode, whose autosave (the
 * profile changed) then saves it as any money; with the game's autosave off
 * the crib takes no snapshot and saves nothing, as for any money.  A player
 * who quits the race with its pause menu's Quit pays MPRACE_QUIT_FEE out of
 * the bank there instead (never more than it holds).  A race that ends under
 * the player (the host's game gone, or in a race of two the other player's:
 * either one's quit ends it) costs nothing, and a closed tab saves nothing
 * anyway.
 *
 * It works as the career bot does (career.c): each frame it looks at the
 * screens and does the next step of its goal there -- the race, or, after
 * the race or when something went wrong, back to the career -- through the
 * game's own handlers and messages (no key needs a menu's focus), keys only
 * where a screen's own step is its first item.  The host starts the game's
 * LAN server and creates the game (track, laps, direction, type, a password
 * only the lobby's players know); the others connect to its virtual address
 * (no server list: a LAN server of another name or another player cannot
 * catch them) and join its game, found in the lobby's list by its host.
 * The player's input is muted while it drives (mprace_owns_input), not in
 * the race and not on the results.
 *
 * The game (SPEED2.EXE v1.2 NA), as read for this file:
 *  - Leaving free roam: the race coordinator ([0x8900D8], state +0: 4 racing,
 *    6 paused) pauses on 0x5F4230(the player's +8), which shows UI_Pause;
 *    its Quit's Yes is the message 0x30ED2368 to UI_Pause (0x4C2170 ->
 *    0x4A7CF0: the front end's first screen UI_Main, the spot kept, career
 *    +0x8744), sent with 0x55DDA0(msg, package) as the help bar's buttons do.
 *  - UI_Main: the LAN item's handler 0x4AEDE0 ("UI_Main.fng", 0x0C407210, 0,
 *    0, 0): [0x850078] = 0x200, UI_PC_LAN_ServerSelect.  Career: 0x537980
 *    (UI_Main, UI_StartCareer, 0); Resume Career there 0x495A30(1): mode 1,
 *    the crib.
 *  - UI_PC_LAN_ServerSelect (screen vtable 0x796420; +0x904 its "Looking
 *    for LAN servers" dialog, +0x908 the servers found, node +0x18 the
 *    address): Host LAN Server is PAD_BUTTON1 (0xC519BFC0) to it; joining
 *    writes the server's address as text to 0x7FBDDC, its port to [0x7FBE04]
 *    (9900), [0x8500C7] = 0, and switches to UI_PC_LAN.fng (0x537980): what
 *    picking a server does (the lobby's connect, 0x588692, reads only those).
 *  - UI_PC_LAN: its name entry (buffer 0x83A8B0, length [0x83A9B0], active
 *    [0x83A9C0], record [0x83A9C4]) accepts with 0x54C7F0 on the record: 1 to
 *    12 letters and digits; a host's game then starts server.dll (5 s), both
 *    log in on UI_OLMAIN (the LAN object's state [0x8500D0] 0x11 once idle).
 *  - The lobby client 0x86A858: its +0xC callback says the screen up
 *    (0x4D17F0 PC_OL_Lobby, 0x4D2760 PC_OL_GameRoom; +0x10 the screen); the
 *    game we are in at 0x86A874 (-1 none), its players' count 0x86AA30, each
 *    one's flags 0x86AA70 + 0x64 i (0x08000000 ready; player 0 the host).
 *    Create Game is the lobby's first button: Mode, Track, Options (where the
 *    settings object 0x850080 is set up), then the room's constructor sends
 *    the game from that object.  Join: gjoi 0x58D6B0(name, password, 0x49EB10,
 *    the lobby screen) for the game whose HOST (record +0x38) is the host's
 *    LAN name, in the list the lobby's Refresh (0x4BB0F0) fills, filtered by
 *    the settings object (mode and options as the host's).  Ready 0x58AD20
 *    (1); the host's Start 0x4BB6E0(room): now when all are ready, else the
 *    game's 10 s countdown and its KICK of the rest.
 *  - Results: the rows 0x851044 ([0x85105C] of them, entry +4 the car's id,
 *    +8 1 finished) in their order; ours by our car's id (car +0xA).
 *  - The pause menu's Quit (0x4C2820, a LAN race too: its dialog's text
 *    LAN_QUIT_TO_MAIN, or OL_UNRANKED_QUIT_SESSION by 0x5F0120) has the Yes
 *    0x30ED2368, as in free roam; UI_Pause's handler 0x4C2170 (only from its
 *    vtable, 0x797CB8) runs it at once, or later on 0xE1FDE1D1 when the
 *    message it held back (+0x13C) is that Yes: 0x4A7CF0, the coordinator's
 *    end of the race (event 8, 6).  Losing the host is the network code's
 *    dialog (OL_HOST_LOST, 0x4A0215), not this.
 *  - Leaving LAN: Yes of UI_OLMAIN's "exit LAN mode?" is 0xD05FC3A3 to it
 *    (0x4A0140: the lobby and the server closed, UI_Main).  The others leave
 *    before the host, whose leaving closes its server under them.
 *  - The crib: Return to Explore Mode's Yes is 0x451E768E to it (0x4AF3A0):
 *    the profile compared with the snapshot the crib took when it came up
 *    (0x52A460: only with the autosave on, [0x844AD8]); changed: MC_Main
 *    saves it; then free roam at the spot.
 *  - A dialog: its handle [0x838974] (0 none), its text 0x838640.
 */
#include "cpu.h"
#include "mprace.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>

long autotest_frame(void);
const char *autotest_top_fng(void);
void autotest_tap(unsigned dik, long frames);
int career_fe_active(const char *name);
void dispatch_indirect(CPU *c, uint32_t addr);

#define G_FLOW          0x008654a4u   /* GameFlowManager state: 3 front end, 6 world */
#define G_GAMEMODE      0x00850078u   /* 1 career, 2 main menu, 0x200 LAN */
#define G_CAREER        0x0085ad40u
#define C_BANK          0x7134u       /* Career: the bank */
#define G_CAREER_CAR    0x00863480u   /* the career car's handle (CAREER_SLOT_n) */
#define G_QR_CAR        0x0083aab8u   /* player 1's quick-race / network car handle */
#define G_QR_CARCAT     0x0083aac0u   /* its car select's category: 4 Career */
#define G_RACECO        0x008900d8u   /* the race coordinator: +0 its state (4 racing, 6 paused) */
#define G_PLAYER1       0x008900acu
#define G_RACETYPE      0x0089e7b0u   /* 0 free roam, 7 an outrun */
#define FN_PAUSE        0x005f4230u   /* thiscall coordinator (the player's +8): pause, UI_Pause */
#define FN_FE_SEND      0x0055dda0u   /* cdecl (msg, package name): a message to that screen, as the help bar's buttons */
#define FN_FE_SWITCH    0x00537980u   /* cdecl (from package, to package, 0) */
#define FN_MAIN_LAN     0x004aede0u   /* cdecl (package, msg, 0, 0, 0): the main menu's LAN */
#define FN_RESUME       0x00495a30u   /* cdecl (1): Resume Career, from UI_StartCareer */
#define MSG_QUIT_YES    0x30ed2368u   /* UI_Pause: Quit's Yes */
#define FN_PAUSE_MSG    0x004c2170u   /* UI_Pause's message handler (thiscall msg, obj, a3, a4; ret 0x10) */
#define MSG_PAUSE_LATER 0xe1fde1d1u   /* ...the message it acts on later: its +0x13C, the one it held back */
#define PAUSE_HELD      0x13cu
#define MSG_BUTTON      0x0c407210u
#define MSG_BUTTON1     0xc519bfc0u   /* PAD_BUTTON1: Host LAN Server */
#define MSG_LAN_EXIT    0xd05fc3a3u   /* UI_OLMAIN: "exit LAN mode?" Yes */
#define MSG_CRIB_GO     0x451e768eu   /* UI_CareerCrib: "Return to Explore Mode?" Yes */
#define G_LAN_HOST      0x008500c7u   /* byte: this game hosts the LAN server */
#define G_LAN_ADDR      0x007fbddcu   /* the LAN server's address, text (40 bytes) */
#define G_LAN_PORT      0x007fbe04u   /* word: its port */
#define LAN_PORT        9900u
#define G_TXT_BUF       0x0083a8b0u   /* the text entry: buffer, length, active, record */
#define G_TXT_LEN       0x0083a9b0u
#define G_TXT_ON        0x0083a9c0u   /* byte: the text entry is up */
#define G_TXT_REC       0x0083a9c4u
#define FN_TXT_ACCEPT   0x0054c7f0u   /* thiscall record: Accept */
#define G_DLG           0x00838974u   /* the dialog's handle, 0 none */
#define G_DLG_TEXT      0x00838640u   /* its info, copied: the text */
#define G_DLG_MSG1      0x00838944u   /* the left button's message */
#define G_DLG_MSG2      0x0083894cu   /* the right one's */
#define G_DLG_MSG3      0x00838954u   /* a single button's (the middle one) */
#define G_DLG_NBUT      0x00838968u   /* how many buttons: 0 (a "please wait"), 1, 2 */
#define G_DLG_LABEL3    0x00838950u   /* a single button's label (a language hash) */
#define LBL_CANCEL      0x541389e5u   /* "Cancel": a "please wait" that can be called off ("Connecting to lobby...") */
#define VT_DIALOG       0x0079c88cu   /* the generic dialog's class: +0x50 the message it answers with on its next update */
#define MSG_LOOK_CANCEL 0x7345710fu   /* "Looking for LAN servers ..."'s Cancel */
#define MSG_RETRY       0x73c044ecu   /* "lost the connection ... reconnect?" Retry (the host's server not up yet) */
#define G_SNAPSHOT      0x00851148u   /* the crib's snapshot of the profile (0: none) */
#define G_LANSTATE      0x008500d0u   /* the LAN object's UI state: 2 the server list's, 0x11 idle, 0x12 busy */
#define FN_LANSTATE     0x005031b0u   /* thiscall 0x850080 (state) */
#define G_NET           0x00850080u   /* the network race's settings */
#define N_MAX           0x00u         /* byte: most players */
#define N_MIN           0x01u
#define N_JOIN          0x04u         /* dword: 0 create, 1 join */
#define N_MODE          0x08u
#define N_RESTRICT      0x0cu         /* byte: Car Performance Restrictions, non-zero: none */
#define N_RANKED        0x18u
#define N_BREAKER       0x19u         /* byte: Race Breaker */
#define N_COLLIDE       0x1au         /* byte: Collision Detection */
#define N_PASSWD_ON     0x1bu
#define N_PASSWD        0x1cu         /* char[13] */
#define N_PASSWD2       0x29u         /* char[13]: confirmed */
#define N_TRACK         0x38u         /* word */
#define N_LAPS          0x3au         /* word */
#define N_DIR           0x3cu         /* dword: 1 reverse */
#define N_PRIVATE       0x48u
#define G_LOBBY         0x0086a858u   /* the lobby client: +8 the game list; +0xC/+0x10 the screen's callback and context */
#define CB_LOBBY        0x004d17f0u   /* PC_OL_Lobby's callback: [0x86A868] is the screen */
#define CB_ROOM         0x004d2760u   /* PC_OL_GameRoom's */
#define G_GAME_IDENT    0x0086a874u   /* the game we are in: -1 none */
#define G_GAME_COUNT    0x0086aa30u   /* its players */
#define G_GAME_FLAGS0   0x0086aa70u   /* player i's flags at + 0x64 i */
#define GF_READY        0x08000000u
#define FN_REFRESH      0x004bb0f0u   /* thiscall lobby screen (0), ret 4 */
#define FN_GJOI         0x0058d6b0u   /* thiscall 0x86A858 (name, password, callback, context), ret 0x10: -1 not sent */
#define CB_JOINED       0x0049eb10u
#define FN_READY        0x0058ad20u   /* thiscall 0x86A858 (1): we are ready */
#define FN_AMREADY      0x0058d9f0u   /* thiscall 0x86A858 -> al: we are ready */
#define FN_START        0x004bb6e0u   /* thiscall room: start (now, or the 10 s countdown) */
#define G_START_CLR     0x00838528u   /* byte */
#define G_RESULTS       0x00851044u   /* the results' rows (entry*: +4 the car's id, +8 completion), [0x85105C] of them */
#define G_RESULTS_N     0x0085105cu
#define SS_LOOKING      0x904u        /* ServerSelect: its "Looking for LAN servers" dialog, 0 when gone */
#define SS_LIST         0x908u        /* ...the servers found: node +0 next, +0x18 address (host order) */
#define VT_SERVERSEL    0x00796420u
#define G_FEMGR         0x008637b4u   /* the FE manager's screens: n = [it]; until n == it: screen [n - 4 + 0x14], n = [n] */
#define S_MAIN          0x0078f530u   /* "UI_Main.fng" in the exe */
#define S_SERVERSEL     0x00790428u   /* "UI_PC_LAN_ServerSelect.fng" */
#define S_LANNAME       0x0079909cu   /* "UI_PC_LAN.fng" */
#define HOOK_MAINLOOP   0x00581475u
/* The trip's waits are in its clock's ticks, 60 a second (clk): real time while the game runs; they were game
 * frames, which at 120 fps passed twice as fast (a player's results gone in 4 s, the room's waits halved) */
#define STEP_FRAMES     (60 * 120)    /* ticks a phase may take before the trip gives up: out and into the LAN; the race's loading */
#define ROOM_FRAMES     (60 * 60)     /* the host's wait for the others in its room, a minute at most */
#define BACK_FRAMES     (60 * 240)    /* back to the career */
#define MP_PRIZE_N      4
static const int k_prize[MP_PRIZE_N] = { 400, 300, 200, 100 };   /* 1st to 4th; 5th and 6th nothing */

enum { G_RACE_GOAL = 1, G_CAREER_GOAL = 2 };
static struct {
    int      phase, goal;
    MpRace   r;
    long     next, since, step_at, look_at, load_at, frame0, results_at, left_at;   /* step_at: in the game's room */
    char     top[64];
    int      place, prize, paid, raced, owns;
    int      quit_race, fee;                       /* the player quit the race (its pause menu); the fee the bank paid */
    int      paused, quit, lan, hosted, named, carset, created, settings, joined, started, left, career, resumed, crib_go, ndlg, host_gone;
    int      logged_place, perf_logged;
    uint32_t room[10];                             /* the host's room as last logged */
    long     ready, dlg_at, wait_at;
    char     keys[16]; int nkeys; long key_at;     /* keys to press, one every 20 frames: L LEFT, R RETURN, E ESCAPE */
    char     why[96];
    const char *step;                              /* where the trip is, for the player (mprace_step) */
} M;

/* the trip's clock in ticks of 1/60 s: real time, advanced once a frame (clk_step) by at most 0.1 s, so that a game
 * parked meanwhile (its tab in the background: no frames) does not run out the trip's waits */
static uint64_t g_clk_us, g_clk_last;
static void clk_step(void){
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    uint64_t us = (uint64_t)ts.tv_sec * 1000000u + (uint64_t)ts.tv_nsec / 1000u, d = g_clk_last && us > g_clk_last ? us - g_clk_last : 0;
    g_clk_us += d > 100000u ? 100000u : d; g_clk_last = us;
}
static long clk(void){ return (long)(g_clk_us / 16667u); }
static int okm(uint32_t a, uint32_t n){ return a && mem_is_committed(a) && mem_is_committed(a + n); }
static uint32_t rd(uint32_t a){ return okm(a, 3) ? MR32(a) : 0; }
static uint32_t call(CPU *c, uint32_t fn, uint32_t ecx, int n, const uint32_t *arg){
    CPU save = *c;
    c->esp = (c->esp - 512u) & ~15u;
    for (int i = n - 1; i >= 0; i--) PUSH32(arg[i]);
    c->ecx = ecx;
    PUSH32(HOOK_MAINLOOP);
    dispatch_indirect(c, fn);
    uint32_t r = c->eax;
    *c = save;
    return r;
}
static void gs(uint32_t a, const char *s, uint32_t cap){
    uint32_t i = 0;
    for (; s[i] && i + 1 < cap; i++) MR8(a + i) = (uint8_t)s[i];
    MR8(a + i) = 0;
}
static int on(const char *pkg){ const char *t = autotest_top_fng(); return (t && !strcasecmp(t, pkg)) || career_fe_active(pkg); }
#define K_ESC   0x01u
#define K_RET   0x1cu
#define K_LEFT  0xcbu
static void keys(const char *k){ snprintf(M.keys, sizeof M.keys, "%s", k); M.nkeys = (int)strlen(M.keys); M.key_at = 0; }
static int keys_run(long f){
    if (!M.nkeys) return 0;
    if (f < M.key_at) return 1;
    char k = M.keys[0]; memmove(M.keys, M.keys + 1, sizeof M.keys - 1); M.nkeys--;
    autotest_tap(k == 'L' ? K_LEFT : k == 'E' ? K_ESC : K_RET, 6);
    M.key_at = f + 20;
    return 1;
}
#define G_NET_HOST      0x00866a14u   /* the network race's host state, > 0 in one (framerate.c) */
#define G_NET_CLIENT    0x008669f4u   /* ... its client state */
#define G_CAREER_RACE   0x00863470u   /* Career +0x8730: the career race being run (0 free roam) */
static void state_log(const char *where){
    fprintf(stderr, "[mprace] f=%ld state %s: mode 0x%x, race type %u, net host %d client %d, LAN mode %u, career race %08x, coordinator %u\n",
            autotest_frame(), where, rd(G_GAMEMODE), rd(G_RACETYPE), (int32_t)rd(G_NET_HOST), (int32_t)rd(G_NET_CLIENT),
            rd(G_NET + N_MODE), rd(G_CAREER_RACE), rd(rd(G_RACECO)));
}
static void mlog(const char *fmt, const char *a){ fprintf(stderr, "[mprace] f=%ld ", autotest_frame()); fprintf(stderr, fmt, a); fputc('\n', stderr); }
static void fail(const char *why){
    if (M.goal == G_CAREER_GOAL) return;
    snprintf(M.why, sizeof M.why, "%s", why);
    mlog("FAILED: %s: back to the career", why); state_log("failed");
    M.goal = G_CAREER_GOAL; M.phase = MPR_BACK; M.since = clk();
    M.step = "Back to free roam";
}
static void to_phase(int ph){
    static const char *const nm[] = { "idle", "out of free roam", "in the LAN menus", "racing", "back to the career", "done", "failed" };
    if (ph != M.phase) fprintf(stderr, "[mprace] f=%ld %s -> %s\n", autotest_frame(), nm[M.phase], nm[ph]);
    M.phase = ph; M.since = clk();
}

/* ---- a car's performance, as the game rates it -------------------------------------------------- */
/* A car's physics info is [car + 0x10] + 0x10 (the ride's; the race's racer
 * setup 0x5B5CC0 and the front end's car stats read it so), built by
 * 0x5B4DC0 from its CarTypeInfo (+0 the type's index) and its performance
 * parts (+0x2E0, set by 0x5A64A0(level, category), -1 every category):
 *  - 0x5AC4F0 copies the type's physics block (CarTypeInfo +0x110, 0x2B0
 *    bytes) to +0x30 and puts each part category's changes in: 0x5A6B50 the
 *    weight (+0x140 the mass), 0x5A6BD0 the gearbox, 0x5A6D00 and 0x5A6E30
 *    the engine's torque curve (+0x230: 9 points from the idle rpm +0x220 to
 *    the most +0x228, 0x7881F4 = 8 steps), and so on;
 *  - 0x5B5AB0 makes the push per kg at every speed from the torque, gears
 *    and wheels (+0x55C, a table: +0 points, +4 its first speed, +8 its
 *    last, +0xC points per m/s, +0x10 the values; 0x5764D0 reads it);
 *  - its rating (+8, a float) adds up the push beyond drag (speed squared
 *    times +0x290, per kg) in steps of 3 mph (0x7A1A80) over those speeds,
 *    and the class (+4, a byte; -1 not rated yet) is 0 above 500, 1 above
 *    401, 2 above 273 (0x7A1A84), else 3; a type with CarTypeInfo +0x844
 *    set is class 3 unrated;
 *  - its top speed (0x5B5930) is the first of those speeds where drag is no
 *    less than the push, at most +0x2C0 mph when that is set. */
#define PI_TYPE         0x000u
#define PI_CLASS        0x004u
#define PI_RATING       0x008u
#define PI_MASS         0x140u
#define PI_RPM_IDLE     0x220u
#define PI_RPM_MAX      0x228u
#define PI_TORQUE       0x230u
#define PI_DRAG         0x290u
#define PI_LIMIT_MPH    0x2c0u
#define PI_PARTS        0x2e0u
#define PI_PARTS_SIZE   0x94u         /* up to +0x374, the next of its parts */
#define PI_PUSH         0x55cu
#define FN_PI_BUILD     0x005b4dc0u   /* thiscall info (mode 0, 1, 1): the copy, the push table, rating and class */
#define FN_PI_PARTS     0x005a64a0u   /* thiscall info +0x2E0 (level, category or -1) */
#define PI_STEP         1.3410819f    /* 0x7A1A80: 3 mph */
#define G_CARTYPES      0x008a1cccu   /* CarTypeInfo[] */
#define G_RACESTATUS    0x00890118u   /* GRaceStatus: +0x24 racers, +0xBD0 their entries (+0 the car) */
#define CARTYPE_SIZE    0x890u
#define N_PLAYER_TYPES  31            /* CarTypeInfo 0..30: the player's cars; then traffic */
static uint32_t perf_info(uint32_t car){
    uint32_t r = okm(car, 0x14) ? rd(car + 0x10u) : 0;
    return r && okm(r + 0x10u, PI_PUSH + 0x14u) ? r + 0x10u : 0;
}
static float push_at(uint32_t t, float v){                               /* 0x5764D0 */
    int n = (int)rd(t); uint32_t vals = rd(t + 0x10u);
    if (n < 1 || n > 4096 || !okm(vals, 4u * (uint32_t)n)) return 0.f;
    float x = (v - MRF32(t + 4u)) * MRF32(t + 0xcu);
    int i = (int)x;
    if (i < 0 || x <= 0.f) return MRF32(vals);
    if (i >= n - 1) return MRF32(vals + 4u * (uint32_t)(n - 1));
    float fr = x - (float)i;
    return MRF32(vals + 4u * (uint32_t)i) * (1.f - fr) + MRF32(vals + 4u * (uint32_t)(i + 1)) * fr;
}
int mprace_car_perf(uint32_t car, CarPerf *p){
    memset(p, 0, sizeof *p); p->cls = -1; p->type = -1;
    uint32_t pi = perf_info(car), types = rd(G_CARTYPES);
    if (!pi) return 0;
    p->type = (int)rd(pi + PI_TYPE);
    if (types && p->type >= 0 && p->type < 64 && okm(types + CARTYPE_SIZE * (uint32_t)p->type, 0x40)){
        uint32_t nm = types + CARTYPE_SIZE * (uint32_t)p->type;
        int k = 0; for (; k < (int)sizeof p->name - 1 && MR8(nm + (uint32_t)k); k++) p->name[k] = (char)MR8(nm + (uint32_t)k);
        p->name[k] = 0;
    }
    /* (the game's units: the mass in tonnes, the torque in kN m) */
    float mass_t = MRF32(pi + PI_MASS);
    p->cls = (int)(int8_t)MR8(pi + PI_CLASS); p->rating = MRF32(pi + PI_RATING); p->mass = mass_t * 1000.f;
    p->rpm_idle = MRF32(pi + PI_RPM_IDLE); p->rpm_max = MRF32(pi + PI_RPM_MAX);
    for (int i = 0; i < 9; i++){
        p->torque[i] = MRF32(pi + PI_TORQUE + 4u * (uint32_t)i) * 1000.f;
        float rpm = p->rpm_idle + (float)i * (p->rpm_max - p->rpm_idle) / 8.f, w = p->torque[i] * rpm / 9.5493043f;
        if (w > p->power) p->power = w;
    }
    /* the top speed, as 0x5B5930 finds it */
    uint32_t t = pi + PI_PUSH;
    float v = MRF32(t + 4u), last = MRF32(t + 8u), k = MRF32(pi + PI_DRAG);
    if (mass_t > 0.f){
        while (v < last){
            if (v * k * v / mass_t > push_at(t, v)) break;
            v += PI_STEP;
        }
        float lim = MRF32(pi + PI_LIMIT_MPH);
        if (lim > 0.f && lim * 0.44702727f < v) v = lim * 0.44702727f;
        p->top = v;
    }
    return 1;
}
void mprace_perf_log(const char *who, uint32_t car){
    CarPerf p;
    if (!mprace_car_perf(car, &p)){ fprintf(stderr, "[mprace] f=%ld %s: no physics info\n", autotest_frame(), who); return; }
    fprintf(stderr, "[mprace] f=%ld %s: %s (type %d), class %d, rating %.1f, top speed %.0f km/h, %.0f kg, %.0f kW (%.0f hp), "
            "%.0f kW per t; torque %.0f..%.0f rpm:", autotest_frame(), who, p.name, p.type, p.cls, (double)p.rating,
            (double)(p.top * 3.6f), (double)p.mass, (double)(p.power / 1000.f), (double)(p.power / 745.7f),
            p.mass > 0.f ? (double)(p.power / p.mass) : 0.0, (double)p.rpm_idle, (double)p.rpm_max);
    for (int i = 0; i < 9; i++) fprintf(stderr, " %.0f", (double)p.torque[i]);
    fprintf(stderr, " N m\n");
}
void mprace_perf_survey(CPU *c, uint32_t car){
    uint32_t pi = perf_info(car), types = rd(G_CARTYPES);
    if (!pi || !types){ fprintf(stderr, "[mprace] perf survey: the car has no physics info\n"); return; }
    uint8_t parts[PI_PARTS_SIZE]; uint32_t type = rd(pi + PI_TYPE);
    for (uint32_t i = 0; i < PI_PARTS_SIZE; i++) parts[i] = MR8(pi + PI_PARTS + i);
    for (int t = 0; t < N_PLAYER_TYPES; t++){
        for (int lv = 0; lv <= 3; lv += 3){
            uint32_t a[3] = { (uint32_t)lv, 0xffffffffu, 0 };
            MR32(pi + PI_TYPE) = (uint32_t)t;
            call(c, FN_PI_PARTS, pi + PI_PARTS, 2, a);
            a[0] = 0; a[1] = 1; a[2] = 1;
            call(c, FN_PI_BUILD, pi, 3, a);
            mprace_perf_log(lv ? "perf survey, every part" : "perf survey, stock", car);
        }
    }
    MR32(pi + PI_TYPE) = type;
    for (uint32_t i = 0; i < PI_PARTS_SIZE; i++) MR8(pi + PI_PARTS + i) = parts[i];
    uint32_t a[3] = { 0, 1, 1 };
    call(c, FN_PI_BUILD, pi, 3, a);
    mprace_perf_log("perf survey, the car again", car);
}

/* The race's setup (0x53FEB0) looks the network car's handle up among the
 * front end's cars (G_FECARS +0x9BD8: 91 records, 0x5036F0; each +8 its
 * handle) and fills the race car's description from the one it finds; with
 * none found it went on with the description as the stack held it: a car
 * named "" (CARS\\VINYLS.BIN, CARS\(null)\PARTS_ANIMATIONS.BIN), garbage
 * physics and stores anywhere -- a hang at the race's start, a trap in a
 * car's wheels (0x5921B0), the runtime's own memory past the guest's end
 * written over (players' reports, 2026-10-22).  A career's car is none of
 * them until the player has a car of their own: a new career's is "CAREER_0"
 * (0x532830), the prologue's 350Z, until the first car is bought (then
 * CAREER_SLOT_n). */
#define G_FECARS        0x0083ad90u
#define FECARS_N        0x5bu
int mprace_car_ok(void){
    uint32_t h = rd(G_CAREER_CAR);
    for (uint32_t i = 0; h && i < FECARS_N; i++){
        uint32_t e = rd(G_FECARS + 0x9bd8u + 4u * i);
        if (e && rd(e + 8u) == h) return 1;
    }
    return 0;
}

/* UI_Pause's messages: in the race, the one that ends it by Quit's Yes (at
 * once, or held back until the screen's next 0xE1FDE1D1) is the player
 * quitting it, for the fee; then the game's own handler, as always.  The
 * vtable is its only caller, so a patch of its entry sees every message. */
void sub_004c2170(CPU *c);
void dispatch_patch(uint32_t a, void (*f)(CPU *));
static void pause_msg(CPU *c){
    uint32_t m = MR32(c->esp + 4u);
    if (M.phase == MPR_RACE && !M.results_at && !M.quit_race
        && (m == MSG_QUIT_YES || (m == MSG_PAUSE_LATER && rd(c->ecx + PAUSE_HELD) == MSG_QUIT_YES))){
        M.quit_race = 1;
        mlog("the player quits the race (its pause menu's Quit%s)", m == MSG_QUIT_YES ? "" : ", held back");
    }
    sub_004c2170(c);
}

int mprace_start(const MpRace *r){
    static int patched;
    if (M.phase != MPR_IDLE && M.phase != MPR_DONE && M.phase != MPR_FAILED) return 0;
    if (rd(G_FLOW) != 6u || !(rd(G_GAMEMODE) & 1u)) return 0;
    if (!mprace_car_ok()){
        fprintf(stderr, "[mprace] f=%ld start: the career car 0x%08x is none of the game's cars (no car of its own yet): not going\n",
                autotest_frame(), rd(G_CAREER_CAR));
        return 0;
    }
    if (!patched){ dispatch_patch(FN_PAUSE_MSG, pause_msg); patched = 1; }
    memset(&M, 0, sizeof M);
    M.r = *r; M.goal = G_RACE_GOAL; M.frame0 = autotest_frame();
    M.step = "Leaving free roam";
    to_phase(MPR_OUT);
    fprintf(stderr, "[mprace] f=%ld start: %s, mode %d, track %d%s, %d laps, %d players, LAN name %s%s%s\n", M.frame0,
            r->host ? "host" : "join", r->mode, r->track, r->reverse ? " reverse" : "", r->laps, r->players, r->name,
            r->host ? "" : ", host ", r->host ? "" : r->host_name);
    { uint32_t pl = rd(G_PLAYER1); mprace_perf_log("our car in free roam", pl ? rd(pl + 4u) : 0); }
    return 1;
}
int mprace_phase(void){ return M.phase; }
void mprace_ack(void){ if (M.phase == MPR_DONE || M.phase == MPR_FAILED) M.phase = MPR_IDLE; }
int mprace_place(void){ return M.place; }
int mprace_prize(void){ return M.prize; }
int mprace_quit(void){ return M.quit_race; }
int mprace_fee(void){ return M.fee; }
const char *mprace_why(void){ return M.why[0] ? M.why : "unknown"; }
void mprace_host_gone(void){ if (!M.r.host && M.goal == G_RACE_GOAL && (M.phase == MPR_OUT || M.phase == MPR_LAN)) M.host_gone = 1; }
void mprace_player_gone(void){
    if (!M.r.host || M.goal != G_RACE_GOAL || M.started || (M.phase != MPR_OUT && M.phase != MPR_LAN)) return;
    if (M.r.players > 1) M.r.players--;
    fprintf(stderr, "[mprace] f=%ld a player of the lobby is not coming: %d players\n", autotest_frame(), M.r.players);
    if (M.r.players < 2) fail("the others left the race");
}
int mprace_owns_input(void){ return __atomic_load_n(&M.owns, __ATOMIC_RELAXED); }   /* (the input thread asks) */
/* the prize into the bank, or the quit's fee out of it (what it holds at most), once; where: for the log */
static void pay(const char *where){
    if (M.paid) return;
    M.paid = 1;
    uint32_t b = rd(G_CAREER + C_BANK);
    if (M.prize > 0){
        MR32(G_CAREER + C_BANK) = b + (uint32_t)M.prize;
        fprintf(stderr, "[mprace] f=%ld the prize: $%d into the bank ($%u -> $%u)%s\n", autotest_frame(), M.prize, b, b + (uint32_t)M.prize, where);
    } else if (M.quit_race){
        M.fee = b < MPRACE_QUIT_FEE ? (int)b : MPRACE_QUIT_FEE;
        MR32(G_CAREER + C_BANK) = b - (uint32_t)M.fee;
        fprintf(stderr, "[mprace] f=%ld the fee for quitting the race: $%d out of the bank ($%u -> $%u)%s\n", autotest_frame(), M.fee, b, b - (uint32_t)M.fee, where);
    }
}
void mprace_end_in_roam(void){
    if (M.phase == MPR_IDLE || M.phase == MPR_DONE || M.phase == MPR_FAILED) return;
    pay(", in free roam");
    if (!M.raced && !M.why[0]) snprintf(M.why, sizeof M.why, "the trip lost its way");
    mlog("back in free roam without the trip's way back: %s", M.raced ? "done" : M.why);
    state_log("ended in free roam");
    M.goal = G_CAREER_GOAL; M.owns = 0; M.nkeys = 0;
    to_phase(M.raced ? MPR_DONE : MPR_FAILED);
}
int mprace_covered(void){ return M.phase == MPR_OUT || M.phase == MPR_LAN || (M.phase == MPR_BACK && M.owns); }
const char *mprace_step(void){ return M.step ? M.step : ""; }

static uint32_t screen_of(uint32_t vt){
    uint32_t n = rd(G_FEMGR);
    for (int k = 0; n && n != G_FEMGR && k < 256; k++, n = rd(n)){ uint32_t sc = rd(n - 4u + 0x14u); if (okm(sc, 0x920) && MR32(sc) == vt) return sc; }
    return 0;
}
/* our place from the race's results (0x54CCA0's rows; the local human's car
 * by its id), 0 when not finished */
static int results_place(void){
    uint32_t pl = rd(G_PLAYER1), car = pl ? rd(pl + 4u) : 0, n = rd(G_RESULTS_N);
    if (!okm(car, 0xc) || n > 6) return 0;
    uint16_t id = (uint16_t)MR16(car + 0xau);
    for (uint32_t k = 0; k < n; k++){
        uint32_t e = rd(G_RESULTS + 4u * k);
        if (okm(e, 0xc) && (uint16_t)MR16(e + 4u) == id) return MR32(e + 8u) == 1u ? (int)k + 1 : 0;
    }
    return 0;
}
/* the host's game in the joiner's list (its HOST our host's LAN name): its record, or 0 */
static uint32_t find_game(void){
    uint32_t h = rd(G_LOBBY + 8u), n = h ? rd(h + 0x14u) : 0, arr = h ? rd(h + 0x40u) : 0;
    for (uint32_t k = 0; k < n && k < 256; k++){
        uint32_t p = rd(arr + 4u * k), rec = p ? rd(p) : 0;
        if (!okm(rec, 0x1c0)) continue;
        char host[17]; for (int i = 0; i < 16; i++) host[i] = (char)MR8(rec + 0x38u + (uint32_t)i); host[16] = 0;
        if (!strcmp(host, M.r.host_name)) return rec;
    }
    return 0;
}
/* the race's settings in the LAN object, as Create Game's screens leave
 * them: the host's (on UI_QRModeOptions, after its setup); the joiner's
 * search filter (the same mode and options) */
static void write_settings(int host){
    uint32_t b = G_NET;
    MR32(b + N_MODE) = (uint32_t)M.r.mode;
    MR8(b + N_RESTRICT) = 1; MR8(b + N_COLLIDE) = 1; MR8(b + N_RANKED) = 0; MR8(b + N_PRIVATE) = 0;
    MR8(b + N_BREAKER) = (M.r.mode == 3 || M.r.mode == 0xa) ? 0 : 1;
    if (!host) return;
    /* the career race's laps within the network race's least (netrace.c):
     * circuit and drift 2 (the career's stadium and parkade drifts: 2 or 3;
     * a downhill drift is one run whatever its laps), Street X 4 */
    int laps = M.r.laps;
    if (M.r.mode == 1 || M.r.mode == 2) laps = 1;
    else { int lo = M.r.mode == 0xa ? 4 : 2; if (laps < lo) laps = lo; }
    if (laps > 10) laps = 10;
    MR16(b + N_TRACK) = (uint16_t)M.r.track; MR16(b + N_LAPS) = (uint16_t)laps; MR32(b + N_DIR) = M.r.reverse ? 1u : 0u;
    int mx = M.r.players < 2 ? 2 : M.r.players > 6 ? 6 : M.r.players;
    MR8(b + N_MAX) = (uint8_t)mx; MR8(b + N_MIN) = 2;
    MR8(b + N_PASSWD_ON) = 1; gs(b + N_PASSWD, M.r.password, 13); gs(b + N_PASSWD2, M.r.password, 13);
    fprintf(stderr, "[mprace] f=%ld the game: mode %d, track %d%s, %d laps, %d players\n", autotest_frame(), M.r.mode, M.r.track,
            M.r.reverse ? " reverse" : "", laps, mx);
}
/* a message to a screen, as its help bar's buttons send them */
static void send_to(CPU *c, uint32_t msg, uint32_t pkg){ uint32_t a[2] = { msg, pkg }; call(c, FN_FE_SEND, 0, 2, a); }
static uint32_t gstr_tmp(CPU *c, const char *s);
/* the dialog up answered with msg, as a press of its button does (0x54C1BC:
 * the message to its +0x50, 0 to +0x54; it goes on its next update) */
static int dlg_answer(uint32_t msg){
    uint32_t d = screen_of(VT_DIALOG);
    if (!d || !msg) return 0;
    MR32(d + 0x50u) = msg; MR32(d + 0x54u) = 0;
    return 1;
}
static void dlg_text(char *t, int n){ int i = 0; for (; i < n - 1; i++){ t[i] = (char)MR8(G_DLG_TEXT + (uint32_t)i); if (!t[i]) break; } t[i] = 0; }

/* ---- toward the race -------------------------------------------------------------------------- */
static void step_race(CPU *c, long f){
    uint32_t cb = rd(G_LOBBY + 0xcu), ctx = rd(G_LOBBY + 0x10u), flow = rd(G_FLOW);
    if (M.host_gone && M.phase == MPR_LAN){
        /* the host quit: its LAN server went with it (a "Connecting to lobby..." called off) */
        if (rd(G_DLG) && rd(G_DLG_NBUT) == 1u) dlg_answer(rd(G_DLG_MSG3));
        char w[64]; snprintf(w, sizeof w, "%s closed the game", M.r.host_name);
        fail(w);
        return;
    }
    if (rd(G_DLG) && M.phase == MPR_LAN){
        /* a dialog on the way: "please wait" ones (no button, or "Looking for
         * LAN servers"' Cancel) go by themselves; the joiner's "reconnect?"
         * (the host's server not listening yet) is retried, 8 times at most;
         * an error's OK ends the trip */
        uint32_t nb = rd(G_DLG_NBUT), m1 = rd(G_DLG_MSG1), m2 = rd(G_DLG_MSG2), m3 = rd(G_DLG_MSG3);
        if (!M.dlg_at) M.dlg_at = f;
        int wait = nb == 0 || (nb == 1 && (m3 == MSG_LOOK_CANCEL || rd(G_DLG_LABEL3) == LBL_CANCEL));
        if ((wait && f - M.dlg_at < 60 * 30) || f - M.dlg_at < 60) return;      /* (a "please wait" of 30 s: given up) */
        char t[96]; dlg_text(t, sizeof t);
        if (nb == 2 && (m1 == MSG_RETRY || m2 == MSG_RETRY)){
            if (++M.ndlg > 8){ fail("the host's LAN server did not answer"); dlg_answer(m1 == MSG_RETRY ? m2 : m1); return; }
            mlog("a dialog: \"%s\": retry", t); dlg_answer(MSG_RETRY); M.dlg_at = 0; M.next = f + 120;
            return;
        }
        /* a "please wait" that did not end: the host's server that did not answer (or ours that did not start) */
        char w[120];
        if (wait) snprintf(w, sizeof w, "%s", M.r.host ? "the LAN server did not start" : "the host's game did not answer");
        else snprintf(w, sizeof w, "the game said \"%s\"", t);
        fprintf(stderr, "[mprace] f=%ld a dialog: \"%s\" (%u buttons: %08x %08x %08x, label %08x): the trip ends\n", autotest_frame(), t, nb, m1, m2, m3,
                rd(G_DLG_LABEL3));
        dlg_answer(nb == 1 ? m3 : m2);                                            /* OK, or No / Cancel */
        fail(w);
        return;
    }
    M.dlg_at = 0;
    /* free roam: pause; UI_Pause: Quit, Yes */
    if (M.phase == MPR_OUT){
        if (flow == 6u && on("UI_pause.fng")){
            if (!M.quit){ send_to(c, MSG_QUIT_YES, gstr_tmp(c, "UI_Pause.fng")); M.quit = 1; M.next = f + 60; mlog("quit to the main menu%s", ""); }
            return;
        }
        /* the world map or a message open at the start (the world paused): closed first, as the player would */
        if (flow == 6u && !M.paused && on("UI_InGame_WorldMap.fng")){ autotest_tap(K_ESC, 6); M.next = f + 60; return; }
        if (flow == 6u && !M.paused && (on("UI_EngageMessageDialog.fng") || on("UI_SMS_Message.fng") || on("UI_SMS_Mailbox.fng"))){
            autotest_tap(on("UI_EngageMessageDialog.fng") ? K_RET : K_ESC, 6); M.next = f + 60; return;
        }
        if (flow == 6u && !M.paused){
            uint32_t co = rd(G_RACECO), pl = rd(G_PLAYER1);
            if (rd(co) != 4u || rd(G_RACETYPE) || !pl) return;                     /* an outrun, a cut scene: later */
            call(c, FN_PAUSE, co, 1, (uint32_t[]){ rd(pl + 8u) });
            M.paused = 1; M.next = f + 30;
            return;
        }
        if (flow == 3u && on("UI_Main.fng")){
            /* the main menu's LAN item, as it acts */
            uint32_t a[5] = { S_MAIN, MSG_BUTTON, 0, 0, 0 };
            call(c, FN_MAIN_LAN, 0, 5, a);
            M.lan = 1; M.next = f + 60;
            M.step = M.r.host ? "Setting up the race" : "Looking for the host's race";
            to_phase(MPR_LAN);
            return;
        }
        return;
    }
    if (on("UI_PC_LAN_ServerSelect.fng")){
        uint32_t ss = screen_of(VT_SERVERSEL);
        if (!ss || rd(G_LANSTATE) != 2u || rd(ss + SS_LOOKING)) return;           /* the network not up, or still looking */
        if (M.r.host){
            if (M.hosted) return;
            send_to(c, MSG_BUTTON1, S_SERVERSEL);                                   /* Host LAN Server */
            M.hosted = 1;
            mlog("host the LAN server%s", "");
        } else {
            /* the host's server should be up: its advert among the servers found (by its address), or 12 s
             * (it starts in about 6); a LAN broadcast may never come on a crowded server (with 50 players on the
             * switch it did not: the trip waited 45 s for it), and one not listening yet is asked again
             * (the "reconnect?" dialog, below) */
            int seen = 0; uint32_t head = ss + SS_LIST;
            for (uint32_t n = rd(head), k = 0; n && n != head && k < 128; n = rd(n), k++) if (rd(n + 0x18u) == M.r.host_ip) seen = 1;
            if (!M.look_at) M.look_at = f;
            if (!seen && f - M.look_at < 60 * 12) return;
            char ip[20]; snprintf(ip, sizeof ip, "%u.%u.%u.%u", M.r.host_ip >> 24, (M.r.host_ip >> 16) & 255u, (M.r.host_ip >> 8) & 255u, M.r.host_ip & 255u);
            MR8(G_LAN_HOST) = 0; gs(G_LAN_ADDR, ip, 40); MR16(G_LAN_PORT) = LAN_PORT;
            uint32_t a[3] = { S_SERVERSEL, S_LANNAME, 0 };
            call(c, FN_FE_SWITCH, 0, 3, a);
            mlog(seen ? "join the host's LAN server at %s" : "join the host's LAN server at %s (its advert not seen)", ip);
        }
        M.next = f + 60;
        return;
    }
    if (on("UI_PC_LAN.fng")){
        if (MR8(G_TXT_ON) != 1u || !rd(G_TXT_REC) || M.named) return;
        gs(G_TXT_BUF, M.r.name, 13); MR32(G_TXT_LEN) = (uint32_t)strlen(M.r.name);
        call(c, FN_TXT_ACCEPT, rd(G_TXT_REC), 0, 0);
        M.named = 1; M.next = f + 30;
        mlog("the LAN name %s", M.r.name);
        return;
    }
    if (on("UI_OLMAIN.fng") && cb != CB_LOBBY && cb != CB_ROOM){
        if (rd(G_LANSTATE) != 0x11u || rd(G_DLG)) return;                       /* logging in, or a dialog */
        if (!M.carset){
            /* the career car, as the car select's Career category picks it */
            MR32(G_QR_CAR) = rd(G_CAREER_CAR); MR32(G_QR_CARCAT) = 4;
            M.carset = 1;
            fprintf(stderr, "[mprace] f=%ld the career car 0x%08x\n", autotest_frame(), rd(G_CAREER_CAR));
        }
        autotest_tap(K_RET, 6); M.next = f + 120;                               /* Lobby: the first item */
        return;
    }
    if (cb == CB_LOBBY && okm(ctx, 0x110)){
        if (rd(G_LANSTATE) != 0x11u || rd(G_GAME_IDENT) != 0xffffffffu || rd(G_DLG)) return;
        if (M.r.host){
            if (!M.created){ autotest_tap(K_RET, 6); M.created = 1; M.next = f + 60; mlog("create the game%s", ""); }   /* Create Game */
            return;
        }
        /* the joiner: the list filtered as the host's game is, then the host's game by its HOST */
        write_settings(0);
        uint32_t rec = find_game();
        if (!rec){
            MR32(ctx + 0x100u) = 0; uint32_t z = 0; call(c, FN_REFRESH, ctx, 1, &z);
            M.next = f + 180;
            return;
        }
        MR32(G_NET + N_JOIN) = 1; MR8(G_NET + N_PASSWD_ON) = 1;
        gs(G_NET + N_PASSWD, M.r.password, 13); gs(G_NET + N_PASSWD2, M.r.password, 13);
        uint32_t a[4] = { rec + 4u, G_NET + N_PASSWD, CB_JOINED, ctx };
        int32_t r = (int32_t)call(c, FN_GJOI, G_LOBBY, 4, a);
        if (r >= 0){ uint32_t st = 0x12; call(c, FN_LANSTATE, G_NET, 1, &st); }
        char nm[40]; for (int i = 0; i < 36; i++) nm[i] = (char)MR8(rec + 4u + (uint32_t)i); nm[36] = 0;
        fprintf(stderr, "[mprace] f=%ld join the game %s: %d\n", autotest_frame(), nm, r);
        M.next = f + 240;
        return;
    }
    if (M.r.host && M.created && (on("UI_QRModeSelect.fng") || on("UI_QRTrackSelect.fng"))){ autotest_tap(K_RET, 6); M.next = f + 90; return; }
    if (M.r.host && M.created && on("UI_QRModeOptions.fng")){
        if (!M.settings){ write_settings(1); M.settings = 1; }
        autotest_tap(K_RET, 6); M.next = f + 120;
        return;
    }
    if (cb == CB_ROOM && okm(ctx, 0x1180)){
        if (!M.step_at) M.step_at = f;
        M.step = M.started || MR8(ctx + 0x1178u) ? "Starting the race" : "Waiting for the others";
        uint32_t n = rd(G_GAME_COUNT);
        if (!M.r.host){
            /* ready (the join's own callback sent "not ready" first): again every 5 s until the game says so */
            if ((!M.ready || f - M.ready > 300) && !(call(c, FN_AMREADY, G_LOBBY, 0, 0) & 0xffu)){
                uint32_t one = 1; call(c, FN_READY, G_LOBBY, 1, &one); MR8(ctx + 0x11bfu) = 1;
                if (!M.ready) mlog("ready%s", "");
                M.ready = f;
            }
            return;
        }
        int ready = 0;
        for (uint32_t i = 1; i < n && i < 6; i++) ready += (rd(G_GAME_FLAGS0 + 0x64u * i) & GF_READY) != 0;
        {   /* the room as the host sees it, when it changes */
            uint32_t now[10] = { n, MR8(ctx + 0x1178u), MR8(ctx + 0x1180u), (uint32_t)ready };
            for (uint32_t i = 0; i < 6; i++) now[4 + i] = rd(G_GAME_FLAGS0 + 0x64u * i);
            if (memcmp(now, M.room, sizeof now)){
                memcpy(M.room, now, sizeof now);
                fprintf(stderr, "[mprace] f=%ld the room: %u in the game, %d ready, counting down %u, can start %u; flags %08x %08x %08x %08x %08x %08x\n",
                        autotest_frame(), n, ready, now[1], now[2], now[4], now[5], now[6], now[7], now[8], now[9]);
            }
        }
        int all = n >= (uint32_t)M.r.players && ready == (int)n - 1 && n >= 2;
        int late = f - M.step_at > ROOM_FRAMES && ready >= 1;
        if ((all || late) && !M.started && !MR8(ctx + 0x1178u) && MR8(ctx + 0x1180u)){
            uint32_t one = 1; call(c, FN_READY, G_LOBBY, 1, &one); MR8(G_START_CLR) = 0;
            call(c, FN_START, ctx, 0, 0);
            M.started = 1;
            fprintf(stderr, "[mprace] f=%ld start the race: %u in the game, %d ready%s\n", autotest_frame(), n, ready, all ? "" : " (the rest: the game's countdown)");
        }
        if (f - M.step_at > ROOM_FRAMES + 60 * 30 && !M.started) fail("nobody came into the game");
        return;
    }
}

/* ---- the race and its results ----------------------------------------------------------------- */
static int step_racing(long f){
    if (rd(G_FLOW) == 6u && (rd(G_GAMEMODE) & 0x200u) && M.phase == MPR_LAN){ to_phase(MPR_RACE); M.raced = 1; mlog("the race is on%s", ""); }
    if (M.phase == MPR_LAN && M.lan && rd(G_FLOW) != 3u){                                    /* (the room's start: the race's world loads) */
        M.step = "Loading the race";
        if (!M.load_at) M.load_at = f;
    }
    if (M.phase != MPR_RACE) return 0;
    if (!M.perf_logged){
        /* our car's performance in the race, once its physics info is rated (or 20 s on) */
        uint32_t pl = rd(G_PLAYER1), car = pl ? rd(pl + 4u) : 0, pi = perf_info(car);
        if ((pi && (int8_t)MR8(pi + PI_CLASS) >= 0) || f - M.since > 60 * 20){
            mprace_perf_log("our car in the race", car); M.perf_logged = 1;
            /* and every racer's, as this game has them (GRaceStatus: +0x24 racers, +0xBD0 theirs, each +0 its car,
             * [[car +0x14] +4] its driver) */
            uint32_t gs = rd(G_RACESTATUS), n = gs ? rd(gs + 0x24u) : 0;
            for (uint32_t i = 0; i < n && i < 8; i++){
                uint32_t rc = rd(rd(gs + 0xbd0u + 4u * i)); char who[48];
                snprintf(who, sizeof who, "racer %u (driver %d%s)", i, (int)rd(rd(rc + 0x14u) + 4u), rc == car ? ", ours" : "");
                mprace_perf_log(who, rc);
            }
        }
    }
    if (on("UI_PostRaceResults.fng")){
        /* our place; while the results are up, again until there is one (our
         * row may be filled in after the screen came: finishing just then) */
        int first = !M.results_at;
        if (first) M.results_at = f;
        if (first || !M.place){
            M.place = results_place();
            M.prize = M.place >= 1 && M.place <= MP_PRIZE_N ? k_prize[M.place - 1] : 0;
        }
        if (first || (M.place && !M.logged_place)){
            M.logged_place = M.place != 0;
            fprintf(stderr, "[mprace] f=%ld the results: place %d, prize $%d%s\n", autotest_frame(), M.place, M.prize, first ? "" : " (our row came later)");
            /* the rows as the game has them (our car's id; each row's car and how it ended: 1 finished) */
            uint32_t pl = rd(G_PLAYER1), car = pl ? rd(pl + 4u) : 0, n = rd(G_RESULTS_N);
            fprintf(stderr, "[mprace]   our car %04x;", okm(car, 0xc) ? (unsigned)MR16(car + 0xau) : 0xffffu);
            for (uint32_t k = 0; k < n && k < 6; k++){
                uint32_t e = rd(G_RESULTS + 4u * k);
                if (okm(e, 0xc)) fprintf(stderr, " row %u: car %04x, %u;", k + 1, (unsigned)MR16(e + 4u), MR32(e + 8u));
            }
            fputc('\n', stderr);
        }
        /* the player reads them; Continue after 8 s, the host 4 s after the others (its leaving closes the server) */
        if (f - M.results_at > 60 * (M.r.host ? 12 : 8)){ autotest_tap(K_RET, 6); M.goal = G_CAREER_GOAL; M.step = "Back to free roam"; to_phase(MPR_BACK); M.next = f + 120; }
        return 1;
    }
    /* the menus again: the player left the race (its pause menu's Quit to LAN Main Menu: no results), or the
     * results with their own Continue, before ours (the game's room came up, and the trip waited there for
     * good): back */
    if (rd(G_FLOW) == 3u){
        if (M.results_at && !M.place){ M.place = results_place(); M.prize = M.place >= 1 && M.place <= MP_PRIZE_N ? k_prize[M.place - 1] : 0; }
        if (M.results_at) fprintf(stderr, "[mprace] f=%ld the results left by the player: place %d, prize $%d\n", autotest_frame(), M.place, M.prize);
        else mlog("the race was left: not finished%s", M.quit_race ? " (the player's own Quit: the fee)" : "");
        M.goal = G_CAREER_GOAL; M.step = "Back to free roam"; to_phase(MPR_BACK);
    }
    return 1;
}

/* ---- back to the career --------------------------------------------------------------------- */
static void step_back(CPU *c, long f){
    uint32_t cb = rd(G_LOBBY + 0xcu), flow = rd(G_FLOW);
    if (rd(G_DLG)){
        /* a dialog on the way back: Yes / OK (the left button, or the only
         * one); a "please wait" goes by itself, or with its Cancel after 5 s
         * (on the way out of the LAN menus there is nothing to wait for: a
         * host gone left one "connecting" for a minute) */
        uint32_t nb = rd(G_DLG_NBUT);
        char t[96]; dlg_text(t, sizeof t);
        int cancel = nb == 1 && (rd(G_DLG_MSG3) == MSG_LOOK_CANCEL || rd(G_DLG_LABEL3) == LBL_CANCEL);
        if (nb == 0 || cancel){
            if (!M.wait_at){ M.wait_at = f; mlog("a \"please wait\" on the way back: \"%s\"", t); }
            if (cancel && f - M.wait_at > 60 * 5){ mlog("... called off%s", ""); dlg_answer(rd(G_DLG_MSG3)); M.wait_at = 0; M.next = f + 90; }
            return;
        }
        M.wait_at = 0;
        mlog("a dialog on the way back: \"%s\": yes / OK", t);
        dlg_answer(nb == 1 ? rd(G_DLG_MSG3) : rd(G_DLG_MSG1));
        M.next = f + 90;
        return;
    }
    M.wait_at = 0;
    if (on("UI_PostRaceResults.fng")){ autotest_tap(K_RET, 6); M.next = f + 180; return; }   /* (Continue missed) */
    if (flow == 6u){
        /* free roam again: done (the career's own free roam, not a LAN race's world); a test's
         * NFSU2_MPRACE_TEST_NODONE=1 misses it, as a trip that lost its way would (roam_game.c's MP_STALE_US) */
        static int nodone = -1;
        if (nodone < 0){ const char *e = getenv("NFSU2_MPRACE_TEST_NODONE"); nodone = e && *e == '1'; }
        if ((rd(G_GAMEMODE) & 1u) && rd(G_RACETYPE) == 0 && rd(rd(G_RACECO)) == 4u && on("HUD_SingleRace.fng") && !nodone){
            state_log("back in free roam"); to_phase(M.why[0] ? MPR_FAILED : MPR_DONE);
            M.owns = 0;
            return;
        }
        /* still in the LAN race's world (the results went): its pause menu would leave it; wait for the game */
        return;
    }
    if (cb == CB_ROOM){ autotest_tap(K_ESC, 6); M.next = f + 90; return; }        /* "exit this game session?" next */
    if (cb == CB_LOBBY){ autotest_tap(K_ESC, 6); M.next = f + 120; return; }      /* LAN Main */
    if (on("UI_OLMAIN.fng")){ send_to(c, MSG_LAN_EXIT, gstr_tmp(c, "UI_OLMAIN.fng")); M.left = 1; M.next = f + 120; mlog("leave LAN%s", ""); return; }
    if (on("UI_PC_LAN.fng") || on("UI_PC_LAN_ServerSelect.fng") || on("UI_QRModeSelect.fng") || on("UI_QRTrackSelect.fng") || on("UI_QRModeOptions.fng")){
        autotest_tap(K_ESC, 6); M.next = f + 90; return;
    }
    if (on("UI_Main.fng")){
        uint32_t a[3] = { S_MAIN, gstr_tmp(c, "UI_StartCareer.fng"), 0 };
        call(c, FN_FE_SWITCH, 0, 3, a);
        M.career = 1; M.next = f + 90;
        mlog("the career%s", "");
        return;
    }
    if (on("UI_StartCareer.fng")){
        if (!M.resumed){ uint32_t one = 1; call(c, FN_RESUME, 0, 1, &one); M.resumed = 1; mlog("resume the career%s", ""); }
        M.next = f + 90;
        return;
    }
    if (on("UI_CareerCrib.fng") && !on("MC_Main.fng")){
        /* the prize (or the fee), once the crib took its snapshot (the autosave on), so that its autosave sees it */
        if (!M.paid){
            if (rd(G_SNAPSHOT) == 0 && f - M.since < 60 * 3) return;               /* (its INIT_COMPLETE) */
            pay(rd(G_SNAPSHOT) ? "" : "; the game's autosave is off: saved at the next save");
        }
        if (!M.crib_go){
            state_log("at the crib");
            send_to(c, MSG_CRIB_GO, gstr_tmp(c, "UI_CareerCrib.fng")); M.crib_go = 1; mlog("return to explore mode%s", "");
        }
        M.next = f + 120;
        return;
    }
    if (on("MC_Main.fng")){ keys("LR"); M.next = f + 90; return; }               /* the autosave's prompts: yes / OK */
}

/* a guest string (scratch, up to 8 of them alive) */
static uint32_t g_tmp; static int g_tmp_i;
static uint32_t gstr_tmp(CPU *c, const char *s){
    if (!g_tmp){ uint32_t sz = 0x200; g_tmp = call(c, 0x00575620u, 0, 1, &sz); if (!g_tmp) return 0; }
    uint32_t a = g_tmp + 0x40u * (uint32_t)(g_tmp_i++ & 7);
    gs(a, s, 0x40);
    return a;
}

void mprace_frame(CPU *c){
    clk_step();
    if (M.phase == MPR_IDLE || M.phase == MPR_DONE || M.phase == MPR_FAILED){ M.owns = 0; return; }
    long f = clk();
    /* the player's input is ours out of free roam and back, not in the race, not on its results */
    M.owns = M.phase == MPR_OUT || M.phase == MPR_LAN || (M.phase == MPR_BACK && !on("UI_PostRaceResults.fng"));
    if (step_racing(f)) return;
    if (keys_run(f) || f < M.next) return;
    if (M.goal == G_RACE_GOAL){
        /* in the game's room the wait counts from there (each game's own: the host's for the others, then the
         * game's 10 s countdown), and the race's loading from its start: a joiner's wait counted from the server
         * list ran out while a late start loaded, and it sat out the race under the cover */
        long lim = M.phase != MPR_LAN ? STEP_FRAMES : M.load_at ? M.load_at - M.since + STEP_FRAMES
                 : M.step_at ? M.step_at - M.since + ROOM_FRAMES + 60 * 40 : STEP_FRAMES;
        if (f - M.since > lim){
            fail(M.phase == MPR_OUT ? "the game did not leave free roam" : M.load_at ? "the race did not load" : "the LAN race did not come together");
            return;
        }
        step_race(c, f);
    } else {
        if (f - M.since > BACK_FRAMES){
            /* stuck on the way back: say so, and leave the rest to the player */
            if (!M.why[0]) snprintf(M.why, sizeof M.why, "the way back stopped on %s", autotest_top_fng() ? autotest_top_fng() : "?");
            mlog("FAILED: %s", M.why);
            to_phase(MPR_FAILED); M.owns = 0;
            return;
        }
        step_back(c, f);
    }
}
