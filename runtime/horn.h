/* horn.h -- horns between players: the horn key and the horns in the sound
 * output (horn.c).  Free roam (roam_game.c) and network races (racehorn.c)
 * say which horns sound where; the mixers (audio.m, audio_web.c) add them to
 * their mix. */
#ifndef HORN_H
#define HORN_H
#include <stdint.h>

#define HORN_VOICES 8                /* the player's horn and 7 others' */

/* 1 while the horn key (H) or the controller's left stick click is held.
 * Game thread. */
int  horn_held(void);
/* A frame of horns, on the game thread: horn_begin with the listener (the
 * camera's position and forward, and the player's car's velocity, m and
 * m/s; pos 0: nobody else's horn can sound), horn_sound for every horn that
 * sounds now, then horn_end: a horn not sounded since horn_begin fades out.
 * who names the horn's source (one voice each), name picks its pitch (one
 * of five: a player sounds the same on every screen).  p and v: where the
 * car is and how it moves; p 0: the player's own horn.  horn_sound returns
 * 1 when that horn starts now, 0 while it goes on, -1 when it is out of
 * hearing or out of voices. */
void horn_begin(const float *pos, const float *fwd, const float *vel);
int  horn_sound(uint32_t who, const char *name, const float *p, const float *v);
void horn_end(void);
/* Adds the sounding voices to an interleaved stereo float mix.  Mixer
 * thread. */
void horn_mix(float *acc, unsigned frames, unsigned rate);
#endif
