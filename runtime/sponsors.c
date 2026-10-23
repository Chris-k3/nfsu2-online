/* sponsors.c -- the career's sponsor screens take a click or a tap to go on.
 *
 * In stage 2 and later a race win can end on "Select a sponsor!"
 * (UI_SponsorPopup.fng, handler 0x4c12e0: PAD_ACCEPT or a button press opens
 * the sponsor screen, PAD_BACK goes back to the race reward) and then the
 * sponsor screen (UI_Sponsorship_new.fng, uiSponsorsMain 0x4c1340: an
 * IconScrollerMenu of the offers, Left/Right change the sponsor, Enter asks
 * "Want to sign on with ...?").
 *
 * A screen's PC help bar (UI_PC_Help_Bar.fng, the buttons bottom right) shows
 * the buttons of its row in the screen table (0x7f7dc8, 0x1c-byte rows:
 * package name, constructor, hash, help bar mask, ...; MenuScreen 0x551de0
 * hands the mask to the bar, 0x54e6e0): 0x400 Back, 0x4 Continue (as Enter),
 * the race reward 0x404.  Both sponsor screens have 0x400, Back alone: the
 * popup takes no click but Back, so with a mouse or on a phone (a tap is a
 * click) Back and the race reward's Continue went round between the two and
 * nothing chose a sponsor (players' reports from Android, 2026-10-23).  The
 * sponsor screen itself signs on a click of the sponsor's logo and changes
 * the sponsor on its arrows or the scroll bar under its title, none of which
 * looks like a button.
 *
 * Both get Continue (0x404), as the race reward has.  Original: none of this
 * (keyboard and controller play the same either way). */
#include "cpu.h"
#include <stdio.h>
#include <string.h>

#define ROW         0x1cu
#define ROW_MASK    0x0cu
#define HB_BACK     0x400u
#define HB_CONTINUE 0x004u

static int row_is(uint32_t row, const char *name, uint32_t ctor){
    uint32_t s = MR32(row);
    return MR32(row + 4u) == ctor && mem_is_committed(s) && mem_is_committed(s + 31u)
        && !strcmp((const char *)(g_mem + s), name);
}

void sponsors_install(void){
    static const struct { const char *name; uint32_t ctor, row; } S[] = {
        { "UI_SponsorPopup.fng",    0x004c1280u, 0x007f89d0u },
        { "UI_Sponsorship_new.fng", 0x004f4730u, 0x007f89ecu },
    };
    /* only on the data of the exe this port is made for */
    for (size_t i = 0; i < sizeof S / sizeof S[0]; i++)
        if (!mem_is_committed(S[i].row + ROW - 1u) || !row_is(S[i].row, S[i].name, S[i].ctor)
            || MR32(S[i].row + ROW_MASK) != HB_BACK){
            fprintf(stderr, "sponsors: the exe's screen table is not the one expected, left as it is\n");
            return;
        }
    for (size_t i = 0; i < sizeof S / sizeof S[0]; i++) MR32(S[i].row + ROW_MASK) = HB_BACK | HB_CONTINUE;
}
