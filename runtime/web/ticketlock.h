/* wasm: a FIFO ticket lock on wasm atomics (memory.atomic.wait32/notify).
 *
 * The guest lock (win32_ext.c) uses it in the browser.  wasi-libc's
 * pthread_mutex is a futex lock with no order: a thread that unlocks and
 * relocks at once (the fair yield, a 10 ms Sleep loop) usually wins again,
 * and the threads parked on the lock (the DirectSound feeder, the loader,
 * the winmm timer) can starve.  Here every locker draws a ticket and the
 * lock is handed over in ticket order.
 *
 * Unlock wakes every waiter and each re-checks its ticket: the game has at
 * most ~8 threads, so a targeted wake is not worth a per-ticket word.  All
 * operations are sequentially consistent (as every wasm atomic is), which the
 * "waiters?" check in unlock relies on: either the unlocker sees a new ticket
 * and notifies, or the new waiter sees the new owner number.  Must not be
 * used on the page's main thread (Atomics.wait is not allowed there); every
 * guest thread is a worker. */
#ifndef NFSU2_TICKETLOCK_H
#define NFSU2_TICKETLOCK_H
#include <stdatomic.h>
#include <stdint.h>

typedef struct { _Atomic uint32_t next, serving; } ticketlock;
#define TICKETLOCK_INIT { 0, 0 }

static inline uint32_t ticket_take(ticketlock *l){ return atomic_fetch_add(&l->next, 1u); }
/* Wait until ticket `me` is served.  Returns 0 if it was served at once. */
static inline int ticket_wait(ticketlock *l, uint32_t me){
    uint32_t s = atomic_load(&l->serving);
    if (s == me) return 0;
    do __builtin_wasm_memory_atomic_wait32((int *)&l->serving, (int)s, -1);
    while ((s = atomic_load(&l->serving)) != me);
    return 1;
}
static inline void ticket_lock(ticketlock *l){ ticket_wait(l, ticket_take(l)); }
/* Threads queued behind the owner (0 = nobody waits). */
static inline uint32_t ticket_queued(ticketlock *l){ return atomic_load(&l->next) - atomic_load(&l->serving) - 1u; }
/* Hand the lock to the next ticket; returns how many threads still queue. */
static inline uint32_t ticket_unlock(ticketlock *l){
    uint32_t s = atomic_fetch_add(&l->serving, 1u) + 1u;
    uint32_t q = atomic_load(&l->next) - s;
    if (q) __builtin_wasm_memory_atomic_notify((int *)&l->serving, ~0u);
    return q;
}
#endif
