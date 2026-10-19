/* selftest_dll.c -- out/win/roam_selftest.dll: tests/roam_selftest.c on the
 * plugin's own core object, exported for the cross-platform byte check
 * (tools/roam_x86check.sh loads it into Unicorn with tests/asi_vm.c).  Test
 * only: never shipped. */
#include <stdint.h>
int roam_selftest(uint8_t *out, int cap);
__declspec(dllexport) int roam_selftest_run(uint8_t *out, int cap){ return roam_selftest(out, cap); }
int __attribute__((stdcall)) roam_selftest_dllmain(void *h, unsigned long reason, void *reserved){
    (void)h; (void)reason; (void)reserved; return 1; }
