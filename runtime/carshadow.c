/* carshadow.c -- a car's shadow on the road no longer covers its wheels.
 *
 * 0x6162e0 and 0x620ae0 (called from the car drawing, 0x630de0..0x6316d0)
 * lay a car's shadow on the ground under it, 16 points each at the road's
 * height there, and lift every point by the constant at 0x7a66b4 (.rdata,
 * 0.04): 4 cm above the road, which puts the shadow's edge into the bottom
 * of each tyre (plain in screenshots from low down).  Here 0.015, as in
 * TerminatorVasya's NFSU2 Shadow Fix (nfsmods.xyz/mod/7328, github.com/
 * TVasya/NFSU2ShadowFix: ShadowOffset, its value for normal play; with 0 the
 * shadow clips into the road while driving).  The lifted code reads the
 * constant from memory each time (MRF32(0x7a66b4u)), so one write at start
 * is all.  The mod's other setting, FancyShadowsEnabled (0x8026b8), only
 * writes the game's own default, 1.  Garages draw their shadow elsewhere. */
#include "cpu.h"
#include <stdio.h>

#define SHADOW_LIFT     0x007a66b4u   /* float, m above the ground */

void carshadow_install(void){
    if (MRF32(SHADOW_LIFT) != 0.04f){      /* only on the data of the exe this port is made for */
        fprintf(stderr, "[shadow] the exe's shadow lift is not the one expected: left as it is\n");
        return;
    }
    MRF32(SHADOW_LIFT) = 0.015f;
}
