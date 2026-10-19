/* keyboard_mac.m -- real keyboard input: NSEvent -> Win32 keyboard messages
 * and DirectInput key state, the way Windows delivers a key to the game.
 *
 * For every key the game sees (AppKit main thread, from metal.m's event loop):
 *   - DirectInput: the key's position as a DIK scan code (layout
 *     independent: the key right of Tab is DIK_Q on every layout), into the
 *     shared key state and event ring (runtime/keyboard.c);
 *   - WM_KEYDOWN / WM_KEYUP (WM_SYSKEYDOWN / WM_SYSKEYUP while Option = Alt
 *     is held and the key types nothing) with the Windows virtual-key code
 *     (letters follow the layout, as Windows' do), and lParam = repeat count
 *     1 | scan code << 16 | extended << 24 | Alt << 29 | previous state << 30
 *     | transition << 31;
 *   - WM_CHAR with the characters the keyboard layout produces (Shift,
 *     Caps Lock and Option included; Option+key that types a character is
 *     treated like AltGr on Windows), in the game's ANSI code page 1252.
 *     Dead keys work as on Windows: WM_DEADCHAR, then the composed
 *     character from the next key (UCKeyTranslate keeps the dead-key state,
 *     what ToUnicode does on Windows).  Return, Backspace, Escape and Tab
 *     give 0x0D, 0x08, 0x1B, 0x09 (a Mac Delete key's own character is 0x7F);
 *   - autorepeat: further WM_KEYDOWN (previous-state bit set) and WM_CHAR,
 *     no new DirectInput event (DirectInput reports changes only).
 * Command keys are the app's (Cmd-Q, Cmd-H, Cmd-M, Cmd-F, Ctrl-Cmd-F, Cmd-Tab
 * never reaches us): a key pressed with Command goes to the menu and the game
 * never sees it, nor the Command key itself.  A key's release always reaches
 * the game if its press did, Command or not, so nothing sticks.  Losing focus
 * (another app, another window of ours) releases every key the game holds:
 * DirectInput key-up events and WM_KEYUP.
 *
 * NFSU2_KEYLAYOUT=<input source id> (test): use that keyboard layout (for
 * example com.apple.keylayout.German) instead of the one selected in macOS,
 * for characters, key names and the ns* script commands. */
#import <Cocoa/Cocoa.h>
#import <Carbon/Carbon.h>
#include <pthread.h>
#include <stdatomic.h>
#include "kbd.h"

#define WM_KEYDOWN    0x0100u
#define WM_KEYUP      0x0101u
#define WM_CHAR       0x0102u
#define WM_DEADCHAR   0x0103u
#define WM_SYSKEYDOWN 0x0104u
#define WM_SYSKEYUP   0x0105u
#define WM_SYSCHAR    0x0106u

/* ---- key table: mac virtual key code -> DIK (position), VK, name ---------- */
typedef struct { const char *name; uint8_t dik, vk, nochar; } MacKey;
static MacKey K[128] = {
    [0x00] = {"A", 0x1E, 'A', 0}, [0x01] = {"S", 0x1F, 'S', 0}, [0x02] = {"D", 0x20, 'D', 0},
    [0x03] = {"F", 0x21, 'F', 0}, [0x04] = {"H", 0x23, 'H', 0}, [0x05] = {"G", 0x22, 'G', 0},
    [0x06] = {"Z", 0x2C, 'Z', 0}, [0x07] = {"X", 0x2D, 'X', 0}, [0x08] = {"C", 0x2E, 'C', 0},
    [0x09] = {"V", 0x2F, 'V', 0}, [0x0A] = {"OEM_102", 0x56, 0xE2, 0}, [0x0B] = {"B", 0x30, 'B', 0},
    [0x0C] = {"Q", 0x10, 'Q', 0}, [0x0D] = {"W", 0x11, 'W', 0}, [0x0E] = {"E", 0x12, 'E', 0},
    [0x0F] = {"R", 0x13, 'R', 0}, [0x10] = {"Y", 0x15, 'Y', 0}, [0x11] = {"T", 0x14, 'T', 0},
    [0x12] = {"1", 0x02, '1', 0}, [0x13] = {"2", 0x03, '2', 0}, [0x14] = {"3", 0x04, '3', 0},
    [0x15] = {"4", 0x05, '4', 0}, [0x16] = {"6", 0x07, '6', 0}, [0x17] = {"5", 0x06, '5', 0},
    [0x18] = {"EQUALS", 0x0D, 0xBB, 0}, [0x19] = {"9", 0x0A, '9', 0}, [0x1A] = {"7", 0x08, '7', 0},
    [0x1B] = {"MINUS", 0x0C, 0xBD, 0}, [0x1C] = {"8", 0x09, '8', 0}, [0x1D] = {"0", 0x0B, '0', 0},
    [0x1E] = {"RBRACKET", 0x1B, 0xDD, 0}, [0x1F] = {"O", 0x18, 'O', 0}, [0x20] = {"U", 0x16, 'U', 0},
    [0x21] = {"LBRACKET", 0x1A, 0xDB, 0}, [0x22] = {"I", 0x17, 'I', 0}, [0x23] = {"P", 0x19, 'P', 0},
    [0x24] = {"RETURN", 0x1C, 0x0D, 0}, [0x25] = {"L", 0x26, 'L', 0}, [0x26] = {"J", 0x24, 'J', 0},
    [0x27] = {"APOSTROPHE", 0x28, 0xDE, 0}, [0x28] = {"K", 0x25, 'K', 0},
    [0x29] = {"SEMICOLON", 0x27, 0xBA, 0}, [0x2A] = {"BACKSLASH", 0x2B, 0xDC, 0},
    [0x2B] = {"COMMA", 0x33, 0xBC, 0}, [0x2C] = {"SLASH", 0x35, 0xBF, 0}, [0x2D] = {"N", 0x31, 'N', 0},
    [0x2E] = {"M", 0x32, 'M', 0}, [0x2F] = {"PERIOD", 0x34, 0xBE, 0}, [0x30] = {"TAB", 0x0F, 0x09, 0},
    [0x31] = {"SPACE", 0x39, 0x20, 0}, [0x32] = {"GRAVE", 0x29, 0xC0, 0}, [0x33] = {"BACK", 0x0E, 0x08, 0},
    [0x35] = {"ESCAPE", 0x01, 0x1B, 0},
    [0x36] = {"RCMD", 0, 0, 1}, [0x37] = {"LCMD", 0, 0, 1},            /* the app's, never the game's */
    [0x38] = {"LSHIFT", 0x2A, 0x10, 1}, [0x39] = {"CAPSLOCK", 0x3A, 0x14, 1},
    [0x3A] = {"LOPTION", 0x38, 0x12, 1}, [0x3B] = {"LCONTROL", 0x1D, 0x11, 1},
    [0x3C] = {"RSHIFT", 0x36, 0x10, 1}, [0x3D] = {"ROPTION", 0xB8, 0x12, 1},
    [0x3E] = {"RCONTROL", 0x9D, 0x11, 1}, [0x3F] = {"FN", 0, 0, 1},
    [0x40] = {"F17", 0, 0x80, 1}, [0x41] = {"DECIMAL", 0x53, 0x6E, 0}, [0x43] = {"MULTIPLY", 0x37, 0x6A, 0},
    [0x45] = {"ADD", 0x4E, 0x6B, 0}, [0x47] = {"CLEAR", 0x45, 0x90, 1},  /* Clear sits where Num Lock is */
    [0x4B] = {"DIVIDE", 0xB5, 0x6F, 0}, [0x4C] = {"NUMPADENTER", 0x9C, 0x0D, 0},
    [0x4E] = {"SUBTRACT", 0x4A, 0x6D, 0}, [0x4F] = {"F18", 0, 0x81, 1}, [0x50] = {"F19", 0, 0x82, 1},
    [0x51] = {"NUMPADEQUALS", 0x8D, 0x92, 0}, [0x52] = {"NUMPAD0", 0x52, 0x60, 0},
    [0x53] = {"NUMPAD1", 0x4F, 0x61, 0}, [0x54] = {"NUMPAD2", 0x50, 0x62, 0},
    [0x55] = {"NUMPAD3", 0x51, 0x63, 0}, [0x56] = {"NUMPAD4", 0x4B, 0x64, 0},
    [0x57] = {"NUMPAD5", 0x4C, 0x65, 0}, [0x58] = {"NUMPAD6", 0x4D, 0x66, 0},
    [0x59] = {"NUMPAD7", 0x47, 0x67, 0}, [0x5A] = {"F20", 0, 0x83, 1}, [0x5B] = {"NUMPAD8", 0x48, 0x68, 0},
    [0x5C] = {"NUMPAD9", 0x49, 0x69, 0}, [0x5D] = {"YEN", 0x7D, 0xDC, 0}, [0x5E] = {"RO", 0x73, 0xE2, 0},
    [0x5F] = {"NUMPADCOMMA", 0xB3, 0x6C, 0},
    [0x60] = {"F5", 0x3F, 0x74, 1}, [0x61] = {"F6", 0x40, 0x75, 1}, [0x62] = {"F7", 0x41, 0x76, 1},
    [0x63] = {"F3", 0x3D, 0x72, 1}, [0x64] = {"F8", 0x42, 0x77, 1}, [0x65] = {"F9", 0x43, 0x78, 1},
    [0x66] = {"EISU", 0x7B, 0x1D, 1}, [0x67] = {"F11", 0x57, 0x7A, 1}, [0x68] = {"KANA", 0x70, 0x15, 1},
    [0x69] = {"F13", 0x64, 0x7C, 1}, [0x6A] = {"F16", 0, 0x7F, 1}, [0x6B] = {"F14", 0x65, 0x7D, 1},
    [0x6D] = {"F10", 0x44, 0x79, 1}, [0x6E] = {"APPS", 0xDD, 0x5D, 1}, [0x6F] = {"F12", 0x58, 0x7B, 1},
    [0x71] = {"F15", 0x66, 0x7E, 1}, [0x72] = {"INSERT", 0xD2, 0x2D, 1},   /* Help sits where Insert is */
    [0x73] = {"HOME", 0xC7, 0x24, 1}, [0x74] = {"PRIOR", 0xC9, 0x21, 1}, [0x75] = {"DELETE", 0xD3, 0x2E, 1},
    [0x76] = {"F4", 0x3E, 0x73, 1}, [0x77] = {"END", 0xCF, 0x23, 1}, [0x78] = {"F2", 0x3C, 0x71, 1},
    [0x79] = {"NEXT", 0xD1, 0x22, 1}, [0x7A] = {"F1", 0x3B, 0x70, 1}, [0x7B] = {"LEFT", 0xCB, 0x25, 1},
    [0x7C] = {"RIGHT", 0xCD, 0x27, 1}, [0x7D] = {"DOWN", 0xD0, 0x28, 1}, [0x7E] = {"UP", 0xC8, 0x26, 1},
};
static const struct { const char *alias, *name; } k_alias[] = {
    {"ENTER", "RETURN"}, {"ESC", "ESCAPE"}, {"BACKSPACE", "BACK"}, {"SHIFT", "LSHIFT"},
    {"CTRL", "LCONTROL"}, {"CONTROL", "LCONTROL"}, {"ALT", "LOPTION"}, {"OPTION", "LOPTION"},
    {"LMENU", "LOPTION"}, {"RMENU", "ROPTION"}, {"LALT", "LOPTION"}, {"RALT", "ROPTION"},
    {"CMD", "LCMD"}, {"COMMAND", "LCMD"}, {"CAPITAL", "CAPSLOCK"}, {"CAPS", "CAPSLOCK"},
    {"PGUP", "PRIOR"}, {"PAGEUP", "PRIOR"}, {"PGDN", "NEXT"}, {"PAGEDOWN", "NEXT"},
    {"HELP", "INSERT"}, {"FORWARDDELETE", "DELETE"}, {"NUMLOCK", "CLEAR"}, {"SECTION", "OEM_102"},
};

/* ISO keyboards report the key left of 1 as kVK_ISO_Section (0x0A) and the
 * extra key right of the left Shift as kVK_ANSI_Grave (0x32), so by position
 * those two swap their DIK codes (DIK_GRAVE / DIK_OEM_102) there. */
static int g_iso = -1;
static uint8_t key_dik(uint16_t kc){
    if (kc >= 128) return 0;
    if (g_iso == 1 && kc == 0x0A) return 0x29;
    if (g_iso == 1 && kc == 0x32) return 0x56;
    return K[kc].dik;
}

/* ---- keyboard layout ----------------------------------------------------- */
static CFDataRef g_layout_data;
static const UCKeyboardLayout *g_layout;
static UInt32 g_dead;                       /* dead-key state of the text being typed */
static uint8_t g_vk_layout[128];            /* VK of letter keys on this layout (0 = table) */
/* key names on this layout, for DIK codes (double buffered: the guest reads) */
static char g_names[2][256][12];
static _Atomic int g_names_cur = -1;

static int uc_translate(uint16_t kc, UInt32 mods, int dead_keys, UInt32 *state, UniChar *out, UniCharCount *n){
    *n = 0;
    if (!g_layout) return 0;
    UInt32 st0 = 0;
    OSStatus e = UCKeyTranslate(g_layout, kc, kUCKeyActionDown, mods, LMGetKbdType(),
                                dead_keys ? 0 : kUCKeyTranslateNoDeadKeysMask,
                                state ? state : &st0, 8, n, out);
    return e == noErr;
}
static int cp1252(uint32_t u){
    if (u < 0x80u || (u >= 0xA0u && u <= 0xFFu)) return (int)u;
    static const uint16_t hi[32] = {
        0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039,
        0x0152, 0, 0x017D, 0, 0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC,
        0x2122, 0x0161, 0x203A, 0x0153, 0, 0x017E, 0x0178 };
    for (int i = 0; i < 32; i++) if (hi[i] && hi[i] == u) return 0x80 + i;
    return -1;
}
static void build_layout_tables(void){
    int nb = atomic_load(&g_names_cur) == 0 ? 1 : 0;
    memset(g_names[nb], 0, sizeof g_names[nb]);
    memset(g_vk_layout, 0, sizeof g_vk_layout);
    for (uint16_t kc = 0; kc < 128; kc++){
        uint8_t dik = key_dik(kc);
        if (!K[kc].name || K[kc].nochar || !dik) continue;
        if (kc == 0x24 || kc == 0x30 || kc == 0x31 || kc == 0x33 || kc == 0x35) continue;  /* named keys */
        if (kc >= 0x41 && kc <= 0x5C) continue;                                          /* keypad */
        if (kc == 0x5F) continue;
        UniChar u[8]; UniCharCount n;
        if (!uc_translate(kc, 0, 0, NULL, u, &n) || n != 1 || u[0] < 0x21 || u[0] == 0x7F) continue;
        /* letters in capitals, as on the keys; one that has none (ß) as it is */
        NSString *s = [[NSString stringWithCharacters:u length:1] uppercaseString];
        unichar up = [s length] == 1 ? [s characterAtIndex:0] : u[0];
        int b = cp1252(up);
        if (b < 0x21) continue;
        g_names[nb][dik][0] = (char)b; g_names[nb][dik][1] = 0;
        if (up >= 'A' && up <= 'Z') g_vk_layout[kc] = (uint8_t)up;
        else if (K[kc].vk >= 'A' && K[kc].vk <= 'Z'){
            /* a letter position with a non-letter here (AZERTY's M position) */
            switch (u[0]){
            case ',': g_vk_layout[kc] = 0xBC; break; case '.': g_vk_layout[kc] = 0xBE; break;
            case '-': g_vk_layout[kc] = 0xBD; break; case ';': g_vk_layout[kc] = 0xBA; break;
            default: break; }
        }
    }
    atomic_store(&g_names_cur, nb);
}
static void load_layout(void){
    TISInputSourceRef src = NULL;
    const char *want = getenv("NFSU2_KEYLAYOUT");
    if (want && *want){
        NSDictionary *f = @{ (__bridge NSString *)kTISPropertyInputSourceID: [NSString stringWithUTF8String:want] };
        CFArrayRef a = TISCreateInputSourceList((__bridge CFDictionaryRef)f, true);
        if (a && CFArrayGetCount(a)) src = (TISInputSourceRef)CFRetain(CFArrayGetValueAtIndex(a, 0));
        if (a) CFRelease(a);
        if (!src) fprintf(stderr, "[key] NFSU2_KEYLAYOUT %s: no such keyboard layout\n", want);
    }
    if (!src) src = TISCopyCurrentKeyboardLayoutInputSource();
    CFDataRef d = src ? (CFDataRef)TISGetInputSourceProperty(src, kTISPropertyUnicodeKeyLayoutData) : NULL;
    if (d) CFRetain(d);
    if (g_layout_data) CFRelease(g_layout_data);
    g_layout_data = d;
    g_layout = d ? (const UCKeyboardLayout *)CFDataGetBytePtr(d) : NULL;
    g_dead = 0;
    g_iso = KBGetLayoutType(LMGetKbdType()) == kKeyboardISO;
    NSString *sid = src ? (__bridge NSString *)TISGetInputSourceProperty(src, kTISPropertyInputSourceID) : nil;
    fprintf(stderr, "[key] keyboard layout %s%s, keyboard type %u%s\n",
            sid ? [sid UTF8String] : "?", g_layout ? "" : " (no layout data: OS characters only)",
            (unsigned)LMGetKbdType(), g_iso ? " (ISO)" : "");
    if (src) CFRelease(src);
    build_layout_tables();
}
const char *kbdmac_layout_name(unsigned dik){
    int c = atomic_load(&g_names_cur);
    if (c < 0 || dik > 255 || !g_names[c][dik][0]) return 0;
    return g_names[c][dik];
}

static int g_inited;
static void kinit(void){
    if (g_inited) return;
    g_inited = 1;
    load_layout();
    [[NSDistributedNotificationCenter defaultCenter]
        addObserverForName:(__bridge NSString *)kTISNotifySelectedKeyboardInputSourceChanged object:nil
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(NSNotification *n){ (void)n;
                    const char *w = getenv("NFSU2_KEYLAYOUT");
                    if (!(w && *w)) load_layout(); }];
}

/* ---- delivering keys to the game ------------------------------------------ */
/* alttext: pressed with Option and typed text (AltGr-like), so its release
 * is a WM_KEYUP even while Option is still down, as with AltGr on Windows */
typedef struct { uint8_t down, dik, vk, sys, alttext; } Down;
static Down g_down[128];            /* keys the game has seen go down */
static int  g_alt_other;            /* a key was pressed while Option was down */

static uint32_t key_lparam(uint8_t dik, int alt, int prev, int up){
    return 1u | ((uint32_t)(dik & 0x7Fu) << 16) | ((dik & 0x80u) ? (1u << 24) : 0u)
         | (alt ? (1u << 29) : 0u) | (prev ? (1u << 30) : 0u) | (up ? (1u << 31) : 0u);
}
static uint8_t key_vk(uint16_t kc){
    if (g_vk_layout[kc]) return g_vk_layout[kc];
    /* the ISO swap of key_dik: the VK follows the key's position too, so
     * VK and scan code name the same key (VK_OEM_3 left of 1, VK_OEM_102
     * right of the left Shift) */
    if (g_iso == 1 && kc == 0x0A) return K[0x32].vk;
    if (g_iso == 1 && kc == 0x32) return K[0x0A].vk;
    return K[kc].vk;
}

static void post(uint32_t m, uint32_t wp, uint32_t lp){
    kbd_post(m, wp, lp);
    if (kbd_log()) fprintf(stderr, "[key]   -> %s 0x%02x lParam 0x%08x\n", kbd_msg_name(m), wp, lp);
}
static void press(uint16_t kc, int sys, int repeat){
    uint8_t dik = key_dik(kc), vk = key_vk(kc);
    if (!repeat){
        g_down[kc].down = 1; g_down[kc].dik = dik; g_down[kc].vk = vk; g_down[kc].sys = (uint8_t)sys;
        g_down[kc].alttext = 0;
        if (dik) kbd_set_key(KSRC_HOST, dik, 1);
    }
    if (vk) post(sys ? WM_SYSKEYDOWN : WM_KEYDOWN, vk, key_lparam(dik, sys, repeat, 0));
}
static void release(uint16_t kc, int alt){
    Down *d = &g_down[kc];
    if (!d->down) return;
    d->down = 0;
    if (d->dik) kbd_set_key(KSRC_HOST, d->dik, 0);
    /* Alt alone: WM_SYSKEYUP; a key released while Alt is down too, unless
     * it was pressed as Option text (WM_KEYDOWN, so WM_KEYUP) */
    int sys = (kc == 0x3A || kc == 0x3D) ? !g_alt_other : (alt && !d->alttext);
    if (d->vk) post(sys ? WM_SYSKEYUP : WM_KEYUP, d->vk, key_lparam(d->dik, sys, 1, 1));
}
void kbdmac_release_all(const char *why){
    int n = 0;
    for (uint16_t kc = 0; kc < 128; kc++) if (g_down[kc].down){ release(kc, 0); n++; }
    kbd_release_source(KSRC_HOST);
    g_dead = 0; g_alt_other = 0;
    if (n || kbd_log()) fprintf(stderr, "[key] %s: %d held key(s) released\n", why, n);
}

/* The characters a key down types, in code page 1252.  Returns the count;
 * *dead = the spacing character of a dead key (no WM_CHAR then). */
static int key_chars(NSEvent *ev, uint16_t kc, NSEventModifierFlags fl, uint8_t *out, int cap, int *dead){
    *dead = 0;
    switch (kc){
    case 0x24: case 0x4C: out[0] = 0x0D; g_dead = 0; return 1;      /* Return, keypad Enter */
    case 0x33: out[0] = 0x08; g_dead = 0; return 1;                  /* Delete = Backspace */
    case 0x35: out[0] = 0x1B; g_dead = 0; return 1;
    case 0x30: out[0] = 0x09; g_dead = 0; return 1;                  /* Tab, also with Shift */
    default: break;
    }
    if (K[kc].nochar){ g_dead = 0; return 0; }
    UniChar u[8]; UniCharCount n = 0; int composed = 0;
    if (g_layout){
        UInt32 mods = ((fl & NSEventModifierFlagShift) ? (shiftKey >> 8) : 0)
                    | ((fl & NSEventModifierFlagCapsLock) ? (alphaLock >> 8) : 0)
                    | ((fl & NSEventModifierFlagOption) ? (optionKey >> 8) : 0)
                    | ((fl & NSEventModifierFlagControl) ? (controlKey >> 8) : 0);
        UInt32 before = g_dead;
        if (uc_translate(kc, mods, 1, &g_dead, u, &n)){
            if (n == 0 && g_dead){
                UniChar s[8]; UniCharCount sn;
                if (uc_translate(kc, mods, 0, NULL, s, &sn) && sn >= 1){ int b = cp1252(s[0]); *dead = b > 0 ? b : '?'; }
                else *dead = '?';
                return 0;
            }
            if (before){
                UniChar p[8]; UniCharCount pn;
                composed = !uc_translate(kc, mods, 0, NULL, p, &pn) || pn != n || memcmp(p, u, n * sizeof *u);
            }
        }
    }
    if (!composed){
        /* the characters macOS produced for the event */
        NSString *s = [ev characters];
        NSUInteger l = [s length];
        if (l){ if (l > 8) l = 8; [s getCharacters:u range:NSMakeRange(0, l)]; n = l; }
    }
    int k = 0;
    for (UniCharCount i = 0; i < n && k < cap; i++){
        if (u[i] >= 0xF700 && u[i] <= 0xF8FF) continue;              /* function keys */
        if (u[i] == 0x7F){ out[k++] = 0x08; continue; }
        int b = cp1252(u[i]);
        out[k++] = (uint8_t)(b >= 0 ? b : '?');                      /* as Windows does for an ANSI window */
    }
    return k;
}

static NSEventModifierFlags g_syn_mods;    /* modifiers held by synthesised events */
static void key_down(NSEvent *ev){
    uint16_t kc = [ev keyCode];
    NSEventModifierFlags fl = [ev modifierFlags];
    if (kc >= 128 || !K[kc].name){ if (kbd_log()) fprintf(stderr, "[key] key code 0x%02x ignored\n", kc); return; }
    int repeat = [ev isARepeat];
    if (repeat && !g_down[kc].down) return;                    /* pressed with Command */
    if (!repeat && g_down[kc].down) repeat = 1;                /* its key up was lost */
    uint8_t ch[8]; int dead = 0;
    int nch = key_chars(ev, kc, fl, ch, 8, &dead);
    /* Option+key that types something (a character or a dead key) is text,
     * like AltGr on Windows; otherwise it is Alt+key: WM_SYSKEYDOWN */
    int opt = (fl & NSEventModifierFlagOption) && !(fl & NSEventModifierFlagControl);
    int text = dead != 0;
    for (int i = 0; i < nch; i++) if (ch[i] >= 0x20 && ch[i] != '?') text = 1;
    int sys = opt && !text;
    if (sys) nch = 0;
    if (g_down[0x3A].down || g_down[0x3D].down) g_alt_other = 1;
    if (kbd_log())
        fprintf(stderr, "[key] host %s kc=0x%02x %s flags 0x%lx chars %d%s\n", repeat ? "repeat " : "keyDown",
                kc, K[kc].name, (unsigned long)fl, nch, dead ? " (dead key)" : "");
    press(kc, sys, repeat);
    if (!repeat) g_down[kc].alttext = (uint8_t)(opt && text);
    if (dead) post(sys ? 0x0107u : WM_DEADCHAR, (uint32_t)dead, key_lparam(key_dik(kc), sys, repeat, 0));
    for (int i = 0; i < nch; i++) post(WM_CHAR, ch[i], key_lparam(key_dik(kc), 0, repeat, 0));
    if (sys && !K[kc].nochar){                                 /* Alt+key: WM_SYSCHAR with the key's character */
        NSString *s = [ev charactersIgnoringModifiers];
        int b = [s length] ? cp1252([s characterAtIndex:0]) : -1;
        if (b >= 0x20 && b != 0x7F) post(WM_SYSCHAR, (uint32_t)b, key_lparam(key_dik(kc), 1, repeat, 0));
    }
}
static void key_up(NSEvent *ev){
    uint16_t kc = [ev keyCode];
    if (kc >= 128) return;
    NSEventModifierFlags fl = [ev modifierFlags];
    if (kbd_log() && g_down[kc].down) fprintf(stderr, "[key] host keyUp   kc=0x%02x %s\n", kc, K[kc].name);
    release(kc, (fl & NSEventModifierFlagOption) != 0);
}
/* Modifier keys come as flagsChanged; the device-dependent bits tell left
 * from right.  Caps Lock reports each press (it toggles): a short tap. */
static void flags_changed(NSEvent *ev){
    uint16_t kc = [ev keyCode];
    NSEventModifierFlags fl = [ev modifierFlags];
    static const struct { uint16_t kc; uint32_t dev; NSEventModifierFlags gen; } M[] = {
        {0x38, 0x0002, NSEventModifierFlagShift},   {0x3C, 0x0004, NSEventModifierFlagShift},
        {0x3B, 0x0001, NSEventModifierFlagControl}, {0x3E, 0x2000, NSEventModifierFlagControl},
        {0x3A, 0x0020, NSEventModifierFlagOption},  {0x3D, 0x0040, NSEventModifierFlagOption},
        {0x37, 0x0008, NSEventModifierFlagCommand}, {0x36, 0x0010, NSEventModifierFlagCommand} };
    if (kc == 0x39){                                           /* Caps Lock */
        if (fl & NSEventModifierFlagCommand) return;
        if (kbd_log()) fprintf(stderr, "[key] host Caps Lock %s\n", (fl & NSEventModifierFlagCapsLock) ? "on" : "off");
        press(kc, 0, 0); release(kc, 0);
        return;
    }
    for (unsigned i = 0; i < sizeof M / sizeof *M; i++){
        if (M[i].kc != kc) continue;
        int down = (fl & 0x207Fu) ? (fl & M[i].dev) != 0 : (fl & M[i].gen) != 0;
        if (!K[kc].dik) return;                                /* Command: the app's */
        if (down && !g_down[kc].down){
            if (fl & NSEventModifierFlagCommand) return;       /* part of a Command shortcut */
            int alt = kc == 0x3A || kc == 0x3D;
            if (alt) g_alt_other = 0; else if (g_down[0x3A].down || g_down[0x3D].down) g_alt_other = 1;
            if (kbd_log()) fprintf(stderr, "[key] host %s down\n", K[kc].name);
            press(kc, alt || (fl & NSEventModifierFlagOption), 0);
        } else if (!down && g_down[kc].down){
            if (kbd_log()) fprintf(stderr, "[key] host %s up\n", K[kc].name);
            release(kc, (fl & NSEventModifierFlagOption) != 0);
        }
        return;
    }
}

/* metal.m's event loop, for key and flagsChanged events: 1 = handled, 0 =
 * AppKit's (a Command shortcut: the caller passes it to [NSApp sendEvent:]). */
int kbdmac_handle(NSEvent *ev){
    kinit();
    NSEventType t = [ev type];
    if (t == NSEventTypeFlagsChanged){ flags_changed(ev); return 1; }
    if (t == NSEventTypeKeyDown){
        if ([ev modifierFlags] & NSEventModifierFlagCommand){
            uint16_t kc = [ev keyCode];
            /* a key the game holds that repeats once Command is down too: no
             * shortcut, and no more key downs for the game either */
            if (kc < 128 && g_down[kc].down){
                if (kbd_log()) fprintf(stderr, "[key] host repeat  kc=0x%02x with Command: held by the game, dropped\n", kc);
                return 1;
            }
            if (kbd_log()) fprintf(stderr, "[key] host keyDown kc=0x%02x with Command -> app, not the game\n", kc);
            return 0;
        }
        key_down(ev);
        return 1;
    }
    if (t == NSEventTypeKeyUp){
        uint16_t kc = [ev keyCode];
        if (kc < 128 && g_down[kc].down){ key_up(ev); return 1; }
        return ([ev modifierFlags] & NSEventModifierFlagCommand) ? 0 : 1;
    }
    return 0;
}

/* ---- synthesised events (autotest ns* commands) ---------------------------
 * Requests come from the guest thread; kbdmac_tick() (main thread, once per
 * event-loop pass, before the queue is read) turns them into NSEvents posted
 * to AppKit's queue, so they arrive like a real keyboard's. */
typedef struct { int type; char key[40]; uint32_t ch; double a, b; } Req;
static Req g_rq[256]; static unsigned g_rq_h, g_rq_t;
static pthread_mutex_t g_rq_mx = PTHREAD_MUTEX_INITIALIZER;
static void enqueue(const Req *r){
    pthread_mutex_lock(&g_rq_mx);
    unsigned nx = (g_rq_t + 1u) % 256u;
    if (nx != g_rq_h){ g_rq[g_rq_t] = *r; g_rq_t = nx; }
    pthread_mutex_unlock(&g_rq_mx);
}
static int lookup_key(const char *nm){
    if (!strncasecmp(nm, "kc:", 3)){ unsigned v = (unsigned)strtoul(nm + 3, 0, 0); return v < 128 ? (int)v : -1; }
    if (!strncasecmp(nm, "DIK_", 4)) nm += 4;
    for (unsigned i = 0; i < sizeof k_alias / sizeof *k_alias; i++)
        if (!strcasecmp(nm, k_alias[i].alias)){ nm = k_alias[i].name; break; }
    for (int kc = 0; kc < 128; kc++) if (K[kc].name && !strcasecmp(K[kc].name, nm)) return kc;
    return -1;
}
int kbdmac_synth_key(int type, const char *key){
    /* validate here (guest thread) so the script logs a bad name */
    char tmp[40]; snprintf(tmp, sizeof tmp, "%s", key);
    char *last = tmp;
    for (char *p = tmp; (p = strchr(p, '+')) && p[1]; p++) last = p + 1;
    if (lookup_key(last) < 0) return 0;
    Req r = { type, {0}, 0, 0, 0 };
    snprintf(r.key, sizeof r.key, "%s", key);
    enqueue(&r);
    return 1;
}
int kbdmac_synth_char(int type, uint32_t u){
    Req r = { type, {0}, u, 0, 0 };
    enqueue(&r);
    return 1;
}
void kbdmac_synth_simple(int type, double a, double b){
    Req r = { type, {0}, 0, a, b };
    enqueue(&r);
}

NSWindow *metal_nswindow(void);                    /* metal.m */
static NSInteger win_number(void){ NSWindow *w = metal_nswindow(); return w ? [w windowNumber] : 0; }
static NSTimeInterval now_ts(void){ return [[NSProcessInfo processInfo] systemUptime]; }

/* modifier flags bits of a modifier key (generic | device-dependent) */
static NSEventModifierFlags mod_bits(uint16_t kc){
    switch (kc){
    case 0x38: return NSEventModifierFlagShift | 0x0002;   case 0x3C: return NSEventModifierFlagShift | 0x0004;
    case 0x3B: return NSEventModifierFlagControl | 0x0001; case 0x3E: return NSEventModifierFlagControl | 0x2000;
    case 0x3A: return NSEventModifierFlagOption | 0x0020;  case 0x3D: return NSEventModifierFlagOption | 0x0040;
    case 0x37: return NSEventModifierFlagCommand | 0x0008; case 0x36: return NSEventModifierFlagCommand | 0x0010;
    case 0x3F: return NSEventModifierFlagFunction;
    default: return 0;
    }
}
static int is_modifier(uint16_t kc){ return mod_bits(kc) != 0 || kc == 0x39; }
static void post_flags(uint16_t kc, int down){
    if (kc == 0x39){
        if (down){ g_syn_mods ^= NSEventModifierFlagCapsLock; } else return;   /* one event per press */
    } else if (down) g_syn_mods |= mod_bits(kc);
    else {
        g_syn_mods &= ~(mod_bits(kc) & 0xFFFFu);
        NSEventModifierFlags gen = mod_bits(kc) & ~(NSEventModifierFlags)0xFFFFu;
        /* the generic flag stays while the other side's key is held */
        int other = 0;
        for (uint16_t o = 0x36; o <= 0x3E; o++)
            if (o != kc && (mod_bits(o) & gen) && (g_syn_mods & mod_bits(o) & 0xFFFFu)) other = 1;
        if (!other) g_syn_mods &= ~gen;
    }
    NSEvent *e = [NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint modifierFlags:g_syn_mods
                                 timestamp:now_ts() windowNumber:win_number() context:nil characters:@""
                charactersIgnoringModifiers:@"" isARepeat:NO keyCode:kc];
    if (e) [NSApp postEvent:e atStart:NO];
}
/* the characters a key types with g_syn_mods, as macOS would put in the event */
static NSString *syn_chars(uint16_t kc, NSEventModifierFlags fl, int ignoring){
    switch (kc){
    case 0x24: return @"\r";  case 0x4C: return @"\x03"; case 0x33: return @"\x7f";
    case 0x35: return @"\x1b"; case 0x30: return (fl & NSEventModifierFlagShift) ? @"\x19" : @"\t";
    case 0x7B: return [NSString stringWithFormat:@"%C", (unichar)NSLeftArrowFunctionKey];
    case 0x7C: return [NSString stringWithFormat:@"%C", (unichar)NSRightArrowFunctionKey];
    case 0x7D: return [NSString stringWithFormat:@"%C", (unichar)NSDownArrowFunctionKey];
    case 0x7E: return [NSString stringWithFormat:@"%C", (unichar)NSUpArrowFunctionKey];
    case 0x73: return [NSString stringWithFormat:@"%C", (unichar)NSHomeFunctionKey];
    case 0x77: return [NSString stringWithFormat:@"%C", (unichar)NSEndFunctionKey];
    case 0x74: return [NSString stringWithFormat:@"%C", (unichar)NSPageUpFunctionKey];
    case 0x79: return [NSString stringWithFormat:@"%C", (unichar)NSPageDownFunctionKey];
    case 0x75: return [NSString stringWithFormat:@"%C", (unichar)NSDeleteFunctionKey];
    case 0x72: return [NSString stringWithFormat:@"%C", (unichar)NSHelpFunctionKey];
    default: break;
    }
    static const uint8_t fk[] = {0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F,
                                 0x69, 0x6B, 0x71, 0x6A, 0x40, 0x4F, 0x50, 0x5A};
    for (unsigned i = 0; i < sizeof fk; i++)
        if (fk[i] == kc) return [NSString stringWithFormat:@"%C", (unichar)(NSF1FunctionKey + i)];
    if (K[kc].nochar) return @"";
    UInt32 mods = ((fl & NSEventModifierFlagShift) ? (shiftKey >> 8) : 0)
                | ((fl & NSEventModifierFlagCapsLock) ? (alphaLock >> 8) : 0)
                | (!ignoring && (fl & NSEventModifierFlagOption) ? (optionKey >> 8) : 0)
                | (!ignoring && (fl & NSEventModifierFlagControl) ? (controlKey >> 8) : 0);
    UniChar u[8]; UniCharCount n;
    if (!uc_translate(kc, mods, 0, NULL, u, &n)) return @"";
    return [NSString stringWithCharacters:u length:n];
}
static NSEventModifierFlags key_extra_flags(uint16_t kc){
    if (kc >= 0x7B && kc <= 0x7E) return NSEventModifierFlagFunction | NSEventModifierFlagNumericPad;
    if (kc >= 0x41 && kc <= 0x5C && !K[kc].nochar) return NSEventModifierFlagNumericPad;
    if (K[kc].nochar && !is_modifier(kc)) return NSEventModifierFlagFunction;
    return 0;
}
static void post_key(uint16_t kc, int type){
    if (is_modifier(kc)){ post_flags(kc, type != KSYN_UP); return; }
    NSEventModifierFlags fl = g_syn_mods | key_extra_flags(kc);
    NSEvent *e = [NSEvent keyEventWithType:type == KSYN_UP ? NSEventTypeKeyUp : NSEventTypeKeyDown
                                  location:NSZeroPoint modifierFlags:fl timestamp:now_ts()
                              windowNumber:win_number() context:nil
                                characters:syn_chars(kc, fl, 0)
               charactersIgnoringModifiers:syn_chars(kc, fl, 1)
                                 isARepeat:type == KSYN_REPEAT keyCode:kc];
    if (e) [NSApp postEvent:e atStart:NO];
}
/* "cmd+shift+Q": modifiers down in order, the key, and (key up) the reverse */
static void synth_key(const Req *r){
    char tmp[40]; snprintf(tmp, sizeof tmp, "%s", r->key);
    uint16_t mods[4]; int nm = 0;
    char *p = tmp, *plus;
    while ((plus = strchr(p, '+')) && plus[1]){
        *plus = 0;
        int m = lookup_key(!strcasecmp(p, "cmd") ? "LCMD" : !strcasecmp(p, "shift") ? "LSHIFT"
                         : !strcasecmp(p, "ctrl") ? "LCONTROL" : !strcasecmp(p, "opt") || !strcasecmp(p, "alt")
                         ? "LOPTION" : p);
        if (m >= 0 && nm < 4) mods[nm++] = (uint16_t)m;
        p = plus + 1;
    }
    int kc = lookup_key(p);
    if (kc < 0) return;
    if (r->type == KSYN_UP){
        post_key((uint16_t)kc, KSYN_UP);
        for (int i = nm - 1; i >= 0; i--) post_flags(mods[i], 0);
    } else {
        if (r->type == KSYN_DOWN) for (int i = 0; i < nm; i++) post_flags(mods[i], 1);
        post_key((uint16_t)kc, r->type);
    }
}
/* nstype: the key (and Shift / Option) typing u on this layout, or a dead
 * key followed by one */
typedef struct { int kc, mods, dkc, dmods; } Stroke;
static int find_stroke(uint32_t u, Stroke *s){
    static const int mset[4] = {0, shiftKey >> 8, optionKey >> 8, (shiftKey | optionKey) >> 8};
    s->dkc = -1;
    switch (u){
    case '\r': case '\n': s->kc = 0x24; s->mods = 0; return 1;
    case '\b': s->kc = 0x33; s->mods = 0; return 1;
    case '\t': s->kc = 0x30; s->mods = 0; return 1;
    case 0x1B: s->kc = 0x35; s->mods = 0; return 1;
    default: break;
    }
    for (int m = 0; m < 4; m++)
        for (int kc = 0; kc < 128; kc++){
            if (!K[kc].name || K[kc].nochar || (kc >= 0x41 && kc <= 0x5F)) continue;   /* main keys */
            UniChar c[8]; UniCharCount n;
            if (uc_translate((uint16_t)kc, (UInt32)mset[m], 0, NULL, c, &n) && n == 1 && c[0] == u){
                UInt32 st = 0; UniCharCount n2;
                uc_translate((uint16_t)kc, (UInt32)mset[m], 1, &st, c, &n2);
                if (n2 == 0 && st) continue;                       /* a dead key there */
                s->kc = kc; s->mods = mset[m]; return 1;
            }
        }
    for (int dm = 0; dm < 4; dm++)
        for (int dk = 0; dk < 128; dk++){
            if (!K[dk].name || K[dk].nochar) continue;
            UniChar c[8]; UniCharCount n; UInt32 st = 0;
            if (!uc_translate((uint16_t)dk, (UInt32)mset[dm], 1, &st, c, &n) || n || !st) continue;
            for (int m = 0; m < 4; m++)
                for (int kc = 0; kc < 0x41; kc++){
                    if (!K[kc].name || K[kc].nochar) continue;
                    UInt32 st2 = st;
                    if (uc_translate((uint16_t)kc, (UInt32)mset[m], 1, &st2, c, &n) && n == 1 && c[0] == u){
                        s->dkc = dk; s->dmods = mset[dm]; s->kc = kc; s->mods = mset[m]; return 1; }
                }
        }
    return 0;
}
static void stroke_mods(int mods, int down){
    if (mods & (shiftKey >> 8)) post_flags(0x38, down);
    if (mods & (optionKey >> 8)) post_flags(0x3A, down);
}
static void synth_char(const Req *r){
    Stroke s;
    if (!find_stroke(r->ch, &s)){
        if (r->type == KSYN_CHAR_DOWN) fprintf(stderr, "[key] nstype: no key types U+%04X on this layout\n", r->ch);
        return;
    }
    if (r->type == KSYN_CHAR_DOWN){
        if (s.dkc >= 0){
            stroke_mods(s.dmods, 1);
            post_key((uint16_t)s.dkc, KSYN_DOWN); post_key((uint16_t)s.dkc, KSYN_UP);
            stroke_mods(s.dmods, 0);
        }
        stroke_mods(s.mods, 1);
        post_key((uint16_t)s.kc, KSYN_DOWN);
    } else {
        post_key((uint16_t)s.kc, KSYN_UP);
        stroke_mods(s.mods, 0);
    }
}
static void synth_mouse(const Req *r){
    NSWindow *w = metal_nswindow();
    if (!w) return;
    static NSPoint at = {0, 0}; static int have = 0;
    NSRect cr = [[w contentView] frame];
    if (r->type == KSYN_MOUSE_MOVE || !have){
        double x = r->type == KSYN_MOUSE_MOVE ? r->a : 0.5, y = r->type == KSYN_MOUSE_MOVE ? r->b : 0.5;
        at = NSMakePoint(cr.origin.x + x * cr.size.width, cr.origin.y + (1.0 - y) * cr.size.height);
        have = 1;
    }
    if (r->type == KSYN_SCROLL){
        /* AppKit has no constructor for scroll events: a CGEvent, posted the same way */
        CGEventRef cg = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 1, (int32_t)r->a);
        NSEvent *e = cg ? [NSEvent eventWithCGEvent:cg] : nil;
        if (cg) CFRelease(cg);
        if (e) [NSApp postEvent:e atStart:NO];
        return;
    }
    int b = (int)r->a;
    NSEventType t = r->type == KSYN_MOUSE_MOVE ? NSEventTypeMouseMoved
                  : r->type == KSYN_MOUSE_DOWN ? (b == 0 ? NSEventTypeLeftMouseDown : b == 1 ? NSEventTypeRightMouseDown : NSEventTypeOtherMouseDown)
                  : (b == 0 ? NSEventTypeLeftMouseUp : b == 1 ? NSEventTypeRightMouseUp : NSEventTypeOtherMouseUp);
    NSEvent *e = [NSEvent mouseEventWithType:t location:at modifierFlags:g_syn_mods timestamp:now_ts()
                                windowNumber:[w windowNumber] context:nil eventNumber:0 clickCount:1
                                    pressure:r->type == KSYN_MOUSE_DOWN ? 1.f : 0.f];
    if (e) [NSApp postEvent:e atStart:NO];
}
void kbdmac_tick(void){
    kinit();
    for (;;){
        Req r;
        pthread_mutex_lock(&g_rq_mx);
        if (g_rq_h == g_rq_t){ pthread_mutex_unlock(&g_rq_mx); break; }
        r = g_rq[g_rq_h]; g_rq_h = (g_rq_h + 1u) % 256u;
        pthread_mutex_unlock(&g_rq_mx);
        switch (r.type){
        case KSYN_DOWN: case KSYN_UP: case KSYN_REPEAT: synth_key(&r); break;
        case KSYN_CHAR_DOWN: case KSYN_CHAR_UP: synth_char(&r); break;
        case KSYN_FOCUS_OUT: case KSYN_FOCUS_IN: {
            /* AppKit's own handlers (metal.m's NfsuDelegate), as for a real switch */
            id del = [NSApp delegate];
            NSString *nm = r.type == KSYN_FOCUS_OUT ? NSApplicationDidResignActiveNotification
                                                    : NSApplicationDidBecomeActiveNotification;
            NSNotification *n = [NSNotification notificationWithName:nm object:NSApp];
            SEL sel = r.type == KSYN_FOCUS_OUT ? @selector(applicationDidResignActive:)
                                               : @selector(applicationDidBecomeActive:);
            fprintf(stderr, "[key] simulated %s\n", r.type == KSYN_FOCUS_OUT ? "focus loss" : "focus gain");
            if ([del respondsToSelector:sel]){
                #pragma clang diagnostic push
                #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
                [del performSelector:sel withObject:n];
                #pragma clang diagnostic pop
            }
            break; }
        default: synth_mouse(&r); break;
        }
    }
}
