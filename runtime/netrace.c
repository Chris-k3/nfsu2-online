/* netrace.c -- network races (Online and LAN): every track open, 2 laps, 6
 * players, drift from 2 laps.
 *
 * In a race between players the career's unlocks only get in the way, so a
 * network game can be created on any track, either direction, whatever the
 * profile has unlocked; and a new game starts at 2 laps instead of 3.  Career,
 * Quick Race, cars and parts keep the game's own unlocks.  A game takes up to
 * 6 players in every mode but drag, as the game's own URL races do; drag
 * keeps one car per lane.  A drift game takes 2 laps or more, as a circuit,
 * ranked or not (the game's least was 4, longer than any of the career's
 * stadium and parkade drifts: 2 or 3 laps).
 *
 * The game (SPEED2.EXE v1.2 NA, static reading):
 *  - The track lock is 0x5156f0, cdecl (mask, track, reverse, 0) -> al: 1
 *    with the "unlock all things" debug byte [0x838464], else the career's
 *    unlock table (0x5143c0 on 0x85ad40, its only caller) for the mask bits
 *    1 and 0x1f8; bits 6 are always open.  Mask 0x1f8 is the network race's
 *    (online [0x850078] = 8, LAN 0x200): the track list of Create Game
 *    (0x4cded0 -> 0x4b4c10, the item's lock +8) and the options' Direction
 *    Reverse (0x4b41c0).  Quick Race passes 1.
 *  - The network race's laps are the word [0x8500ba] (NUMLAPS, the gcre
 *    PARAMS LAPS, 0x584860), in the online/LAN object 0x850080 (+0x3a).  Only
 *    the game state's constructor 0x53ed20 (static init, 0x77d390) gives it a
 *    default, 3 (0x53ed6b); the save keeps none of it but the login (0x515bf0).
 *    The options' Laps (0x4b3e40, the arrows 0x4b3f10) keep it between the
 *    mode's least (the option's word +0x54: 2 for circuit (0) and URL (4), 4
 *    for drift (3), Street X (0xA) and mode 5, else 1) and 10, the arrows
 *    wrapping round; a joiner takes the host's (0x601d20).  The constructor
 *    sets the least and raises the laps to it; in a ranked online game
 *    ([0x850098]) the options screen (0x4ef620) raises them again on its
 *    updates, with the least's getter 0x498400 (the same table).  Quick
 *    Race's Laps (0x4b3d60) is 1 to 10 in every mode.  The race's setup takes
 *    the laps as they are (drift 0x53f830), 1 on a point-to-point track (its
 *    info +0x80 = 1: downhill drift; +0x85, 0x53fdea).
 *  - Max Players is the byte [0x850080] (MAXPLYS, the gcre MAXSIZE), its
 *    least [0x850081] = 2, 3 for a ranked game ([0x850098]).  The option's
 *    constructor 0x4b3110 sets it to the mode's most: 6 for URL (mode
 *    [0x850088] = 4; Street X is 0xA), 3 for drag (2) on track 4402, which
 *    has three lanes, else 4.  Its arrows 0x4b3190 step it between the two, wrapping round,
 *    and its vtable +0xc (0x4b3220) shows it.  The race coordinator
 *    ([0x890118]) has 6 racer entries, and the start grid (0x5eb5d0) lines up
 *    any number of cars in two columns where a track has fewer start markers.
 */
#include "cpu.h"

#define G_NET_LAPS  0x008500bau    /* word: the network race's laps */
#define MASK_NET    0x1f8u         /* 0x5156f0's mask bits of a network race */
#define G_NET_MAX   0x00850080u    /* byte: Max Players */
#define G_NET_MIN   0x00850081u    /* byte: its least */
#define G_NET_MODE  0x00850088u    /* int: 0 circuit, 1 sprint, 2 drag, 3 drift, 4 URL, 0xA Street X */
#define MODE_DRAG   2u
#define MODE_DRIFT  3u
#define LAPS_LEAST  0x54u          /* word: the Laps option's least */
#define DRIFT_LEAST 2u             /* a circuit's */
#define NET_MOST    6u             /* the race coordinator's racer entries */
#define MSG_LEFT    0x9120409eu
#define MSG_RIGHT   0xb5971bf1u
#define RET_ARROWS  0x004b3218u    /* the return address of the arrows' own call of +0xc */

/* the track lock: open for a network race, else the game's */
void sub_005156f0_orig(CPU *c);
void sub_005156f0(CPU *c){
    if (!(MR32(c->esp + 4u) & MASK_NET)){ sub_005156f0_orig(c); return; }
    c->eax = (c->eax & 0xffffff00u) | 1u;
    POP32(c->eip);
}

/* the game state's constructor (thiscall, returns this): laps 2, not 3 */
void sub_0053ed20_orig(CPU *c);
void sub_0053ed20(CPU *c){
    sub_0053ed20_orig(c);
    MR16(G_NET_LAPS) = 2;
}

/* the Laps option's constructor (thiscall, 5 arguments, returns this): drift
 * from 2 laps, and the laps kept that its least of 4 raised */
void sub_004b3e40_orig(CPU *c);
void sub_004b3e40(CPU *c){
    uint32_t self = c->ecx, laps = MR16(G_NET_LAPS);
    sub_004b3e40_orig(c);
    if (MR32(G_NET_MODE) != MODE_DRIFT) return;
    MR16(self + LAPS_LEAST) = DRIFT_LEAST;
    MR16(G_NET_LAPS) = (uint16_t)(laps < DRIFT_LEAST ? DRIFT_LEAST : laps > 10u ? 10u : laps);
}

/* its least's getter (thiscall, -> ax, also into the option's +0x54), a
 * ranked game's: drift 2 */
void sub_00498400_orig(CPU *c);
void sub_00498400(CPU *c){
    uint32_t self = c->ecx;
    sub_00498400_orig(c);
    if (MR32(G_NET_MODE) != MODE_DRIFT) return;
    MR16(self + LAPS_LEAST) = DRIFT_LEAST;
    c->eax = (c->eax & 0xffff0000u) | DRIFT_LEAST;
}

/* Max Players' constructor (thiscall, 5 arguments, returns this): 6, drag as
 * the game has it */
void sub_004b3110_orig(CPU *c);
void sub_004b3110(CPU *c){
    sub_004b3110_orig(c);
    if (MR32(G_NET_MODE) != MODE_DRAG) MR8(G_NET_MAX) = NET_MOST;
}

/* its arrows (thiscall (arg, msg), ret 8): up to 6, drag as the game has it */
void sub_004b3190_orig(CPU *c);
void sub_004b3190(CPU *c){
    uint32_t self = c->ecx, msg = MR32(c->esp + 8u), n = MR8(G_NET_MAX), lo = MR8(G_NET_MIN);
    if (msg == MSG_LEFT) n = n > lo ? n - 1u : NET_MOST;
    else if (msg == MSG_RIGHT) n = n < NET_MOST ? n + 1u : lo;
    sub_004b3190_orig(c);
    if (MR32(G_NET_MODE) == MODE_DRAG || MR8(G_NET_MAX) == n) return;
    MR8(G_NET_MAX) = (uint8_t)n;                      /* and shown again */
    CPU save = *c;
    c->esp = (c->esp - 256u) & ~15u;
    c->ecx = self;
    PUSH32(RET_ARROWS);
    dispatch_indirect(c, MR32(MR32(self) + 0xcu));
    *c = save;
}
