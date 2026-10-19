/* horn.c -- horns between players: the horn key, where each horn is heard
 * from, and a car horn synthesised over the game's sound.  See horn.h.
 *
 * The PC game has no horn.  Its input names one (JOY_EVENT_HONK_HORN, 0xA3,
 * which no key or button map uses) and its audio a CARSFX_TrafficHorn class
 * (0x47E610), but none of its sound banks holds a horn: every sound in
 * SOUND/ was decoded (EA-XA, the BNKl banks of the .abk files) and looked
 * at, and the traffic bank has two engine loops only.  So the horn is made
 * here, as a car's dual horn sounds: two tones a major third apart, each a
 * buzzy band-limited wave with its upper harmonics lifted around 2.7 kHz,
 * summed through a soft clip that gives the pair its rasp, high-passed.
 * Each player's horn has its own pitch (one of five, from the name), so
 * players can tell who honks.
 *
 * The key: H, and the controller's left stick click.  Both are the game's
 * hydraulics ("Hydraulic Pressurize": H in its keyboard map 0x7FCAC0, the
 * left stick in the pad layout of dinput_pad.c), a feature the PC game does
 * not have.
 *
 * Where a horn is heard from: the player's own in the middle; another
 * player's from their car as the camera hears it, full within NEAR_M, then
 * falling with the distance until it is gone at FAR_M (the last 50 m a
 * fade), from the side the car is on, duller the farther it is, its pitch
 * shifted by how fast the car and the player come or go (Doppler).
 *
 * Threads: horn_begin/horn_sound/horn_end on the game thread, every frame
 * while horns may sound; the mixer (audio.m: the AudioUnit callback,
 * audio_web.c: the audio pump) reads each voice through relaxed atomics,
 * one word per field, and smooths every change, so a torn update is never
 * heard.  A voice that has not been set for 250 ms (a parked game) falls
 * silent. */
#include "horn.h"
#include "kbd.h"
#include "gamepad.h"
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#define DIK_H     0x23
#define F_LOW     405.f              /* Hz: the low horn */
#define F_HIGH    510.f              /* the high horn, a major third up */
#define LEVEL     0.55f              /* another player's horn within NEAR_M: about -8 dBFS at its peaks */
#define SELF      0.7f               /* the player's own horn, of that */
#define NEAR_M    8.f
#define FAR_M     250.f
#define SOUND_MPS 343.f
#define STALE_MS  250u
#define REUSE_MS  400u               /* a voice let go fades out (to -80 dB in 280 ms) before another horn takes it */
#define TBL       2048

int horn_held(void){
    if (kbd_key_down(DIK_H)) return 1;
    PadState s;
    return gamepad_read(&s) && (s.buttons & 1u << PAD_LS);
}

static uint32_t now_ms(void){
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint32_t)((uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u);
}
static uint32_t fnv1a(const char *s){
    uint32_t h = 2166136261u;
    for (; s && *s; s++){ h ^= (uint8_t)*s; h *= 16777619u; }
    return h;
}
static int g_logged;
#define HLOG(...) do { if (__atomic_add_fetch(&g_logged, 1, __ATOMIC_RELAXED) <= 40) fprintf(stderr, __VA_ARGS__); } while (0)

/* ---- game thread -> mixer: one word per field ------------------------------------ */
static struct { uint32_t tune, gain, pan, pitch, stamp; } g_in[HORN_VOICES];
static uint32_t fbits(float f){ uint32_t u; memcpy(&u, &f, 4); return u; }
static float bitsf(uint32_t u){ float f; memcpy(&f, &u, 4); return f; }
#define PUT(f, v) __atomic_store_n(&(f), (v), __ATOMIC_RELAXED)
#define GET(f)    __atomic_load_n(&(f), __ATOMIC_RELAXED)
static void voice_set(int v, uint32_t tune, float gain, float pan, float pitch){
    PUT(g_in[v].tune, tune); PUT(g_in[v].gain, fbits(gain)); PUT(g_in[v].pan, fbits(pan));
    PUT(g_in[v].pitch, fbits(pitch)); PUT(g_in[v].stamp, now_ms());
}

/* ---- the game thread: which horn has which voice ---------------------------------- */
static struct { int used, sounded; uint32_t who, tune, free_at; float pan, pitch; } g_vo[HORN_VOICES];
static struct { int ok; float p[3], l[2], v[3]; } g_lis;
void horn_begin(const float *pos, const float *fwd, const float *vel){
    g_lis.ok = pos && fwd;
    if (!g_lis.ok) return;
    for (int a = 0; a < 3; a++){ g_lis.p[a] = pos[a]; g_lis.v[a] = vel ? vel[a] : 0.f; }
    float lx = -fwd[1], ly = fwd[0], ln = sqrtf(lx * lx + ly * ly);   /* the camera's left, level (z is up) */
    if (ln > 0.001f){ g_lis.l[0] = lx / ln; g_lis.l[1] = ly / ln; } else { g_lis.l[0] = 0.f; g_lis.l[1] = 1.f; }
}
int horn_sound(uint32_t who, const char *name, const float *p, const float *v){
    float gain = SELF, pan = 0.f, pitch = 1.f, dist = 0.f;
    if (p){
        if (!g_lis.ok) return -1;
        float d[3] = { p[0] - g_lis.p[0], p[1] - g_lis.p[1], p[2] - g_lis.p[2] };
        dist = sqrtf(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
        if (!(dist < FAR_M)) return -1;
        gain = dist > NEAR_M ? NEAR_M / dist : 1.f;
        if (dist > FAR_M - 50.f) gain *= (FAR_M - dist) / 50.f;
        if (dist > 0.1f){
            float vl = 0.f, vs = 0.f;
            pan = -(d[0] * g_lis.l[0] + d[1] * g_lis.l[1]) / dist;
            for (int a = 0; a < 3; a++){ vl += g_lis.v[a] * d[a] / dist; vs += (v ? v[a] : 0.f) * d[a] / dist; }
            /* c + the player's speed towards the horn over c + the horn's speed away */
            pitch = (SOUND_MPS + vl) / (SOUND_MPS + vs);
            if (!(pitch >= 0.5f)) pitch = 0.5f;
            if (pitch > 2.f) pitch = 2.f;
        }
    }
    int k = 0, start = 0;
    while (k < HORN_VOICES && !(g_vo[k].used && g_vo[k].who == who)) k++;
    if (k == HORN_VOICES){
        uint32_t now = now_ms();
        for (k = 0; k < HORN_VOICES; k++) if (!g_vo[k].used && (!g_vo[k].free_at || (int32_t)(now - g_vo[k].free_at) >= 0)) break;
        if (k == HORN_VOICES) return -1;
        g_vo[k].used = 1; g_vo[k].who = who; g_vo[k].tune = fnv1a(name); g_vo[k].free_at = 0; start = 1;
        if (p) HLOG("[horn] %s's horn, %.0f m away\n", name && *name ? name : "a player", (double)dist);
        else HLOG("[horn] my horn\n");
    }
    g_vo[k].sounded = 1; g_vo[k].pan = pan; g_vo[k].pitch = pitch;
    voice_set(k, g_vo[k].tune, gain, pan, pitch);
    return start;
}
void horn_end(void){
    uint32_t now = now_ms();
    for (int k = 0; k < HORN_VOICES; k++){
        if (g_vo[k].sounded){ g_vo[k].sounded = 0; continue; }
        if (g_vo[k].used){ g_vo[k].used = 0; g_vo[k].free_at = now + REUSE_MS; }
        voice_set(k, g_vo[k].tune, 0.f, g_vo[k].pan, g_vo[k].pitch > 0.f ? g_vo[k].pitch : 1.f);   /* fades as it was */
    }
}

/* ---- the mixer ----------------------------------------------------------------- */
/* one cycle: harmonics 1..24 at 1/k (a sawtooth's), those near 2.7 kHz (for
 * a 405 Hz tone) lifted up to 2.5 x; the highest stays below 20 kHz at the
 * highest pitch and Doppler shift */
static float g_tbl[TBL + 1];
static int g_tbl_ok;
static void tbl_init(void){
    double peak = 0.0;
    for (int i = 0; i < TBL; i++){
        double x = 2.0 * M_PI * i / TBL, s = 0.0;
        for (int k = 1; k <= 24; k++){
            double d = (F_LOW * k - 2700.0) / 1100.0;
            s += sin(k * x) / k * (1.0 + 1.5 * exp(-d * d));
        }
        g_tbl[i] = (float)s;
        if (fabs(s) > peak) peak = fabs(s);
    }
    for (int i = 0; i < TBL; i++) g_tbl[i] = (float)(g_tbl[i] / peak);
    g_tbl[TBL] = g_tbl[0];
    g_tbl_ok = 1;
}
static inline float wave(float ph){                      /* ph in [0, 1) */
    float x = ph * TBL; int i = (int)x;
    return g_tbl[i] + (g_tbl[i + 1] - g_tbl[i]) * (x - (float)i);
}
static float detune(uint32_t tune){
    static const float k[5] = { 1.f, 0.94f, 1.06f, 0.89f, 1.12f };
    return k[(tune * 2654435761u >> 16) % 5u];
}

static struct {
    int   live;                                          /* sounding or fading out */
    float f1, f2;                                        /* the two tones, cycles per sample at pitch 1 */
    float p1, p2;                                        /* phases, cycles */
    float env, gl, gr, pitch, hx, hy, lp;
    uint32_t frames; float peak[2];                      /* the log line at the end */
} g_v[HORN_VOICES];

void horn_mix(float *acc, unsigned frames, unsigned rate){
    if (!rate || !frames) return;
    if (!g_tbl_ok) tbl_init();
    uint32_t now = now_ms();
    float fs = (float)rate;
    float k_att = 1.f - expf(-1.f / (0.008f * fs)), k_rel = 1.f - expf(-1.f / (0.030f * fs));
    float k_smooth = 1.f - expf(-1.f / (0.020f * fs));
    float k_hp = 1.f / (1.f + 2.f * (float)M_PI * 180.f / fs);
    for (int v = 0; v < HORN_VOICES; v++){
        float gain = bitsf(GET(g_in[v].gain));
        if (now - GET(g_in[v].stamp) > STALE_MS) gain = 0.f;
        if (!g_v[v].live){
            if (!(gain > 0.f)) continue;
            memset(&g_v[v], 0, sizeof g_v[v]);
            g_v[v].live = 1;
            float t = detune(GET(g_in[v].tune));            /* a voice keeps its pitch until it is silent */
            g_v[v].f1 = F_LOW * t / fs; g_v[v].f2 = F_HIGH * t / fs;
            g_v[v].pitch = bitsf(GET(g_in[v].pitch));
        }
        float pan = bitsf(GET(g_in[v].pan)), tp = bitsf(GET(g_in[v].pitch));
        float th = (pan + 1.f) * (float)M_PI * 0.25f;     /* equal power */
        float tgl = gain * cosf(th), tgr = gain * sinf(th), te = gain > 0.f ? 1.f : 0.f;
        /* far horns lose their top: a one-pole low-pass from ~1.5 kHz (gain 0.05, 160 m) up to none (gain 0.6) */
        float k_lp = 0.15f + 0.85f * (gain * 1.7f > 1.f ? 1.f : gain * 1.7f);
        float f1 = g_v[v].f1, f2 = g_v[v].f2;
        float p1 = g_v[v].p1, p2 = g_v[v].p2, env = g_v[v].env, gl = g_v[v].gl, gr = g_v[v].gr, pt = g_v[v].pitch;
        float hx = g_v[v].hx, hy = g_v[v].hy, lp = g_v[v].lp, pk0 = g_v[v].peak[0], pk1 = g_v[v].peak[1];
        for (unsigned i = 0; i < frames; i++){
            pt += (tp - pt) * k_smooth;
            p1 += f1 * pt; if (p1 >= 1.f) p1 -= 1.f;
            p2 += f2 * pt; if (p2 >= 1.f) p2 -= 1.f;
            float s = (wave(p1) + 0.9f * wave(p2)) * 1.2f;
            s = s / (1.f + fabsf(s));
            hy = k_hp * (hy + s - hx); hx = s;
            lp += (hy - lp) * k_lp;
            env += (te - env) * (te > env ? k_att : k_rel);
            gl += (tgl - gl) * k_smooth; gr += (tgr - gr) * k_smooth;
            float o = lp * env * LEVEL, oL = o * gl, oR = o * gr;
            acc[2 * i] += oL; acc[2 * i + 1] += oR;
            if (fabsf(oL) > pk0) pk0 = fabsf(oL);
            if (fabsf(oR) > pk1) pk1 = fabsf(oR);
        }
        g_v[v].p1 = p1; g_v[v].p2 = p2; g_v[v].env = env; g_v[v].gl = gl; g_v[v].gr = gr; g_v[v].pitch = pt;
        g_v[v].hx = hx; g_v[v].hy = hy; g_v[v].lp = lp; g_v[v].peak[0] = pk0; g_v[v].peak[1] = pk1;
        g_v[v].frames += frames;
        if (te == 0.f && env < 1e-4f){
            g_v[v].live = 0;
            HLOG("[horn] voice %d: %.2f s, peak left %.1f dBFS, right %.1f dBFS\n", v, (double)g_v[v].frames / fs,
                 pk0 > 1e-6f ? 20.0 * log10(pk0) : -120.0, pk1 > 1e-6f ? 20.0 * log10(pk1) : -120.0);
        }
    }
}
