/* netrace.c -- network races (Online and LAN): every track open, 2 laps.
 *
 * In a race between players the career's unlocks only get in the way, so a
 * network game can be created on any track, either direction, whatever the
 * profile has unlocked; and a new game starts at 2 laps instead of 3.  Career,
 * Quick Race, cars and parts keep the game's own unlocks.
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
 *    mode's minimum (1, 2 or 4) and 10, the arrows wrapping round; a joiner
 *    takes the host's (0x601d20).
 */
#include "cpu.h"

#define G_NET_LAPS  0x008500bau    /* word: the network race's laps */
#define MASK_NET    0x1f8u         /* 0x5156f0's mask bits of a network race */

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
