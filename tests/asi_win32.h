/* asi_win32.h -- the Win32 functions NFSU2FreeRoam.asi imports (KERNEL32,
 * WS2_32), implemented for a plugin running under tests/asi_vm.c.  The host
 * decides the clock, the environment, the .ini file, where created files go
 * and what the socket does (a scripted queue in the offline harness,
 * guarded loopback sockets in the virtual Windows friend).  No thread is
 * ever created (CreateThread fails: the plugin then polls from its frame
 * hook, as it would on Windows if CreateThread failed). */
#ifndef ASI_WIN32_H
#define ASI_WIN32_H
#include "asi_vm.h"
#include <stdio.h>

typedef struct {
    void       *user;
    int64_t   (*now_us)(void *user);                       /* QueryPerformanceCounter at 1 MHz */
    const char *(*getenv)(void *user, const char *name);   /* GetEnvironmentVariableA */
    char        ini_path[512];                             /* GetPrivateProfileStringA reads this host file */
    char        module_path[260];                          /* GetModuleFileNameA (a Windows path) */
    char        file_dir[512];                             /* CreateFileA("...\\x.log") -> file_dir/x.log */
    int       (*sock_bind)(void *user, uint32_t ip, uint16_t port);
    int       (*sock_send)(void *user, uint32_t ip, uint16_t port, const uint8_t *b, int n);
    int       (*sock_recv)(void *user, uint8_t *b, int cap, uint32_t *ip, uint16_t *port);
    /* state */
    uint32_t    veh;                                       /* AddVectoredExceptionHandler's handler */
    FILE       *file[8]; char file_path[8][600];
    int         wsa_err;
    uint32_t    last_error;
    uint64_t    calls, bytes_sent, bytes_recv;
    int         threads_refused;
} aw32;

/* import handler for xvm_cfg.import: the number of argument dwords popped,
 * or -1 for an import it does not know */
int aw32_import(aw32 *w, xvm *vm, const char *dll, const char *name, uint32_t esp, uint32_t *eax);
void aw32_close(aw32 *w);
#endif
