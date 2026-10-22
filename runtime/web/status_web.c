/* The page's frame-rate overlay reads the game's own counters from here
 * (HOST_KIND_STATUS, layout in status_proto.h).  A small thread refreshes
 * the renderer's counters four times a second; other parts of the web
 * runtime may set their own with host_status_set().  With the null renderer
 * "frames" still counts the game's presents, so the overlay shows the game's
 * frame rate rather than the page's display rate. */
#include "cpu.h"
#include "status_proto.h"
#include "host_abi.h"
#include <pthread.h>
#include <string.h>
#include <strings.h>
#include <time.h>
#include <unistd.h>

long metal_frames(void); long metal_tris(void); long metal_tex_created(void);
unsigned long metal_tex_released(void); long metal_frames_dropped(void);

static HostStatus g_st;
static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;

int host_status_slot(const char *name){
    pthread_mutex_lock(&g_mu);
    int i = 0;
    for (; i < (int)g_st.count; i++) if (!strncmp(g_st.item[i].name, name, HOST_STATUS_NAME)) break;
    if (i == (int)g_st.count){
        if (i >= HOST_STATUS_MAX){ pthread_mutex_unlock(&g_mu); return -1; }
        __atomic_add_fetch(&g_st.seq, 1, __ATOMIC_RELEASE);
        strncpy(g_st.item[i].name, name, HOST_STATUS_NAME);
        g_st.item[i].value = 0;
        __atomic_store_n(&g_st.count, (uint32_t)i + 1, __ATOMIC_RELAXED);
        __atomic_add_fetch(&g_st.seq, 1, __ATOMIC_RELEASE);
    }
    pthread_mutex_unlock(&g_mu);
    return i;
}

void host_status_set(int slot, double value){ host_status_set_n(&slot, &value, 1); }

/* several counters in one sequence-lock section, so the page never sees one
 * of them newer than another (frames and frames_t below) */
void host_status_set_n(const int *slot, const double *value, int n){
    pthread_mutex_lock(&g_mu);
    __atomic_add_fetch(&g_st.seq, 1, __ATOMIC_RELEASE);
    for (int i = 0; i < n; i++) if (slot[i] >= 0 && slot[i] < HOST_STATUS_MAX) g_st.item[slot[i]].value = value[i];
    __atomic_add_fetch(&g_st.seq, 1, __ATOMIC_RELEASE);
    pthread_mutex_unlock(&g_mu);
}

/* "frames_t" is the time "frames" was read, in ms on CLOCK_MONOTONIC (the
 * page's performance.timeOrigin + now(), the same clock).  The page divides
 * the change in frames by the change in frames_t: its own sampling times
 * (animation frames, about every 250 ms) do not line up with this thread's
 * updates, and dividing by them misread a steady 60 fps as 56 or 75 (phase-1
 * app review, finding 1). */
static void *status_main(void *unused){
    (void)unused;
    int slot[5] = { host_status_slot("frames"), host_status_slot("frames_t"), host_status_slot("frames_dropped"),
                    host_status_slot("tris"), host_status_slot("textures") };
    for (;;){
        struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
        double v[5] = { (double)metal_frames(), ts.tv_sec * 1e3 + ts.tv_nsec * 1e-6, (double)metal_frames_dropped(),
                        (double)metal_tris(), (double)metal_tex_created() - (double)metal_tex_released() };
        host_status_set_n(slot, v, 5);
        usleep(g_st.period_ms * 1000u);
    }
    return 0;
}

/* "drive": what the page's touch controls (web/src/app/touch.ts) need of the
 * game, set at every Present (autotest.c): 1 while the player drives in a
 * race, 2 in free roam, 0 elsewhere.  Driving is GameFlow 6 with a race HUD
 * (HUD_*.fng) the top package; the pause menu (UI_pause.fng), the results,
 * the world's loading screen and the Engage dialog over the HUD are not, nor
 * is a cutscene (NIS, as runtime/discord.c tells one). */
const char *autotest_top_fng(void);
int career_fe_active(const char *name);
int roam_exploring(void);
static int drive_state(void){
    if (!mem_is_committed(0x8654a7u) || MR32(0x8654a4u) != 6u) return 0;
    const char *top = autotest_top_fng();
    if (!top || strncasecmp(top, "HUD_", 4) || !strcasecmp(top, "HUD_World_Loading.fng")) return 0;
    if (mem_is_committed(0x827ecbu) && (MR32(0x827e98u) | MR32(0x827eb0u) | MR32(0x827ec8u))) return 0;
    if (career_fe_active("UI_EngageMessageDialog.fng")) return 0;
    return roam_exploring() ? 2 : 1;
}
void status_web_frame(void){
    static int slot = -2, last = -1;
    if (slot == -2) slot = host_status_slot("drive");
    int v = drive_state();
    if (v != last && slot >= 0){ last = v; host_status_set(slot, v); }
}

/* main_web.c, before the guest starts */
void status_web_start(void){
    g_st.magic = HOST_STATUS_MAGIC;
    g_st.period_ms = 250;
    nfsu2_register(HOST_KIND_STATUS, &g_st, sizeof g_st);
    pthread_attr_t at; pthread_attr_init(&at);
    pthread_attr_setstacksize(&at, 64u * 1024u);
    pthread_t th;
    if (pthread_create(&th, &at, status_main, 0) == 0) pthread_detach(th);
}
