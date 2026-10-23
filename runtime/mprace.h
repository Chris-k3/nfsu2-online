/* mprace.h -- a multiplayer race from free roam: the trip from the career's
 * free roam to the game's own LAN race and back (mprace.c), which the lobby
 * (roam_game.c mp_*) starts in every game of its players at once. */
#ifndef MPRACE_H
#define MPRACE_H
#include <stdint.h>

typedef struct {
    int      host;                 /* 1: this game hosts the LAN game; 0: it joins the host's */
    uint32_t host_ip;              /* the host's virtual address (10.77.x.y, host byte order) */
    char     host_name[16];        /* the host's LAN name (its game's name) */
    char     name[16];             /* our LAN name: letters, digits, - and _ */
    char     password[12];         /* the game's password: only the lobby's players join it */
    uint32_t race;                 /* the career race (its name hash, race record +8): for the log and the prize */
    int      mode;                 /* the network race's type [0x850088]: 0 circuit, 1 sprint, 2 drag, 3 drift, 4 URL, 0xA Street X */
    int      track, laps, reverse;
    int      players;              /* the host: the lobby's players, itself too (it starts once they are all ready) */
} MpRace;
enum { MPR_IDLE = 0, MPR_OUT, MPR_LAN, MPR_RACE, MPR_BACK, MPR_DONE, MPR_FAILED };
/* what quitting a started race with its pause menu's Quit costs the bank (what it holds at most) */
#define MPRACE_QUIT_FEE 75

/* the career has a car of its own, one the LAN race can take (not a new
 * career's prologue car): a trip without one would race a car made of
 * garbage */
int  mprace_car_ok(void);
/* the trip starts at the next frame; 0 when one runs already, the game is
 * not in career free roam or the career has no car of its own */
int  mprace_start(const MpRace *r);
/* where the trip is (MPR_*); MPR_DONE / MPR_FAILED until the next start or
 * mprace_ack */
int  mprace_phase(void);
void mprace_ack(void);
/* our place in the race (1 ..), 0: none (not finished, left, failed); the
 * prize the career's bank got for it */
int  mprace_place(void);
int  mprace_prize(void);
/* the player quit the race (its pause menu's Quit); the fee the bank paid for it (less than MPRACE_QUIT_FEE when it
 * held less, 0 before the crib) */
int  mprace_quit(void);
int  mprace_fee(void);
/* the reason a failed trip gives ("the host's game was not found") */
const char *mprace_why(void);
/* a joiner's host closed its game (free roam heard it quit): the trip ends
 * once in the LAN menus, as the host's LAN server is gone with it */
void mprace_host_gone(void);
/* the host: a player of the lobby is not coming after all (its trip did not start, it quit): the room does not wait
 * for it; with nobody else left the trip ends */
void mprace_player_gone(void);
/* the player is in career free roam again while the trip is not over (it made its way back by hand, or the trip
 * lost its way): the trip is over, as done once raced (the prize, if the crib did not pay it, into the bank now),
 * else as failed */
void mprace_end_in_roam(void);
/* the game's input is the trip's own: the player's keys, mouse and pad are
 * not passed on (runtime/web/input_web.c, dinput_pad.c) */
int  mprace_owns_input(void);
/* the trip is in the game's menus (out of free roam, the LAN screens, the
 * race's loading, the way back): the page covers them (the lobby's panel,
 * roam_game.c mp_panel); not in the race, not on its results */
int  mprace_covered(void);
/* where the trip is, for the player: "Leaving free roam", "Loading the race", ... */
const char *mprace_step(void);
#endif
