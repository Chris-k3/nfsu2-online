/* poselog_unit.c -- the free-roam pose log's buffer in the browser
 * (runtime/roam_host.h rh_fopen): every stdio flush there is a synchronous
 * round trip to the I/O worker and an OPFS write, so roam_game.c's periodic
 * rh_fflush every 240 frames must be the only one.  Writes 240 frames of
 * rows as roam_game.c does (one L row for our car, one R row per friend's car
 * shown, 147 bytes as the longest of the perf track's logs) for 1 and for 5
 * friends' cars, and checks that nothing reached the file before the flush.
 * Run by web/test/roam-wasm.test.mjs with a directory at /tmp. */
#include "roam_host.h"
#include <sys/stat.h>

long autotest_frame(void){ return 0; }
uint32_t win32_heap_live(void){ return 0; }
void dispatch_indirect(CPU *c, uint32_t addr){ (void)c; (void)addr; }

static long size_of(const char *p){ struct stat st; return stat(p, &st) == 0 ? (long)st.st_size : -1; }

int main(void){
    int fails = 0;
    for (int cars = 1; cars <= 5; cars += 4){
        char path[64]; snprintf(path, sizeof path, "/tmp/pose-%d.csv", cars);
        rh_file *f = rh_fopen(path);
        if (!f){ printf("poselog: cannot open %s\n", path); return 1; }
        long held = 0;
        for (int frame = 0; frame < 240; frame++)
            for (int r = 0; r <= cars; r++)
                held += rh_fprintf(f, "%c,%0136d,%07d\n", r ? 'R' : 'L', 0, frame);   /* 147 bytes */
        long before = size_of(path);
        rh_fflush(f);
        long after = size_of(path);
        int ok = before == 0 && after == held;
        printf("  %s  %d friend car(s): %ld bytes in 240 frames, %ld in the file before the periodic flush, %ld after\n",
               ok ? "PASS" : "FAIL", cars, held, before, after);
        fails += !ok;
        fclose(f);
    }
    printf("poselog_unit: %s\n", fails ? "FAILED" : "passed");
    return fails ? 1 : 0;
}
