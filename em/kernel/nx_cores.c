// nxem: one running guest thread per virtual core.
// nxnative gives every guest thread a host thread and lets the host schedule them: on a Mac with idle cores a guest
// thread that spins on SleepThread(0) costs one core. The game was written for a console where a core runs ONE thread
// and a yield hands that core to a peer; here 90 guest threads on real cores all run at once, and its spin-waits
// (3.4 million yields in 10 s, measured in Chrome) never meet the scheduler they wait for. So each of the 8 virtual
// cores has one token. A guest thread holds its core's token while it runs guest code and gives it up when it blocks
// in the kernel or in host code, and when it yields; the token goes to the waiting thread of the best priority (then
// first come). It is taken again only at the boundary back to guest code (the end of an SVC or host call), never
// inside host code, where the thread may hold a host lock. A thread whose mask allows several cores takes a free
// one of them, else waits for its preferred core. No preemption between SVCs, except at a slice end of translated code.
// Off unless NX_CORES=1 (the page: ?cores=1): in the node harness it made the boot about three times slower (the same
// 318,000 host calls took 79 s instead of 26 s), because loading is the part that runs in parallel and the port's
// threads are much slower per core than the console's; what it does to the title's yield-spinning is not measured yet.
#include "dm.h"
#include "nx_port.h"
#include "nx_guest.h"
#include <stdatomic.h>

int nx_thr_sched(int *prio, uint64_t *mask);   // appended to the ported hle_thread.c: the calling guest thread's core, priority and mask; -1 when it is none

enum { NCORE = 8 };
typedef struct waiter { pthread_cond_t cv; int prio, granted; uint64_t seq; struct waiter *next; } waiter;
static struct { pthread_mutex_t m; int busy; waiter *head; _Atomic int nwait; } g_core[NCORE];
static pthread_once_t g_once = PTHREAD_ONCE_INIT; static int g_on;
static _Atomic uint64_t g_seq, g_waits, g_wait_ns, g_handoffs;
static __thread int t_held = -1;
static void init(void) { const char *e = getenv("NX_CORES"); g_on = e && *e == '1'; for (int i = 0; i < NCORE; i++) pthread_mutex_init(&g_core[i].m, NULL); }

void nx_core_release(void) {
    if (t_held < 0) return;
    int c = t_held; t_held = -1;
    pthread_mutex_lock(&g_core[c].m);
    waiter *b = NULL, **bp = NULL;
    for (waiter **p = &g_core[c].head; *p; p = &(*p)->next) if (!b || (*p)->prio < b->prio || ((*p)->prio == b->prio && (*p)->seq < b->seq)) { b = *p; bp = p; }
    if (b) { *bp = b->next; g_core[c].nwait--; b->granted = 1; pthread_cond_signal(&b->cv); g_handoffs++; }
    else g_core[c].busy = 0;
    pthread_mutex_unlock(&g_core[c].m);
}
// The calling guest thread is about to run guest code: it holds a core when this returns
void nx_core_ensure(void) {
    pthread_once(&g_once, init);
    if (!g_on || t_held >= 0) return;
    int prio; uint64_t mask; int pref = nx_thr_sched(&prio, &mask);
    if (pref < 0) return;
    pref &= NCORE - 1; if (!(mask & 0xFF)) mask = 1ull << pref;
    for (int k = 0; k < NCORE; k++) {   // a free core of its mask, the preferred one first
        int c = (pref + k) & (NCORE - 1);
        if (!(mask >> c & 1)) continue;
        pthread_mutex_lock(&g_core[c].m);
        int got = !g_core[c].busy; if (got) g_core[c].busy = 1;
        pthread_mutex_unlock(&g_core[c].m);
        if (got) { t_held = c; return; }
    }
    uint64_t t0 = now_ns();
    waiter w = {.prio = prio, .seq = ++g_seq}; pthread_cond_init(&w.cv, NULL);
    pthread_mutex_lock(&g_core[pref].m);
    if (!g_core[pref].busy) g_core[pref].busy = 1;
    else { w.next = g_core[pref].head; g_core[pref].head = &w; g_core[pref].nwait++; while (!w.granted) pthread_cond_wait(&w.cv, &g_core[pref].m); }
    pthread_mutex_unlock(&g_core[pref].m);
    pthread_cond_destroy(&w.cv);
    t_held = pref; g_waits++; g_wait_ns += now_ns() - t0;
}
// A yield, or a slice end: when a thread waits for this core it gets it, and the caller queues behind
void nx_core_yield(void) { if (t_held >= 0 && atomic_load_explicit(&g_core[t_held].nwait, memory_order_relaxed)) { nx_core_release(); nx_core_ensure(); } }
void nx_core_stats(char *out, size_t n) {
    pthread_once(&g_once, init);
    if (!g_on) { snprintf(out, n, "off (NX_CORES=1 turns it on): every guest thread runs whenever the host runs it"); return; }
    int busy = 0, wait = 0; for (int i = 0; i < NCORE; i++) { busy += g_core[i].busy; wait += g_core[i].nwait; }
    snprintf(out, n, "%d of %d cores running, %d threads waiting for one; %llu waits for a core so far (%.1f ms each), %llu hand-overs", busy, NCORE, wait,
             (unsigned long long)g_waits, g_waits ? g_wait_ns / 1e6 / g_waits : 0.0, (unsigned long long)g_handoffs);
}
