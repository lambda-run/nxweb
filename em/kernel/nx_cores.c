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
// 2026-11-12, NX_COREEXCL=1 (the page: ?coreexcl=1; NX_CORES=1 is the same now): the exclusion a console core gives.
// The game pins one thread of each kind to every core (BaseProcCreateAndDeleteThread prio 51, BaseProcExecutor prio 44,
// ...); on the console two threads of one core never run at the same time and the one of higher priority is never
// interrupted by the other, and a fault on the title that comes and goes with timing suggests code that relies on it.
// What the first version lacked, and why it crawled: (1) preemption. A thread of lower priority kept its core for a
// whole slice of translated code (2^26 instructions) while a thread of higher priority waited: now the slice is
// 2^17 instructions (nx_slice_budget) and at its end the core goes to a waiting thread of HIGHER priority only (equal
// priorities do not time-slice on Horizon); (2) a thread that wants a busy core spins for a moment before it sleeps
// (most holds end at the next SVC, microseconds away).
// (3) the holder kept its core through host-side waits (measured in Chrome: 6,958 waits for a core of 300 ms each,
// one or two of eight cores running): the core is now given up around a unit's translation, compile and instantiation,
// around every request to the owner thread, and when a thread has to sleep for the recorder's lock.
// Off unless NX_CORES=1 (the page: ?cores=1): in the node harness it made the boot about three times slower (the same
// 318,000 host calls took 79 s instead of 26 s), because loading is the part that runs in parallel and the port's
// threads are much slower per core than the console's; what it does to the title's yield-spinning is not measured yet.
#include "dm.h"
#include "nx_port.h"
#include "nx_guest.h"
#include <stdatomic.h>
#include <emscripten.h>

uint32_t thr_cur_handle(void);
int nx_thr_sched(int *prio, uint64_t *mask);   // appended to the ported hle_thread.c: the calling guest thread's core, priority and mask; -1 when it is none

enum { NCORE = 8 };
typedef struct waiter { pthread_cond_t cv; int prio, granted; uint64_t seq; struct waiter *next; } waiter;
static struct { _Atomic uint32_t holder; pthread_mutex_t m; _Atomic int busy; waiter *head; _Atomic int nwait; _Atomic int best; } g_core[NCORE];   // best: the best (lowest) priority waiting, INT32_MAX when none
static pthread_once_t g_once = PTHREAD_ONCE_INIT; static int g_on;
static _Atomic uint64_t g_seq, g_waits, g_wait_ns, g_handoffs, g_preempts, g_slices;
static __thread int t_held = -1, t_prio = 0; static __thread uint64_t t_since;
static void best_set(int c) { int b = INT32_MAX; for (waiter *w = g_core[c].head; w; w = w->next) if (w->prio < b) b = w->prio; atomic_store(&g_core[c].best, b); }   // (under the core's mutex)
static void init(void) { const char *e = getenv("NX_CORES"), *x = getenv("NX_COREEXCL"); g_on = (e && *e == '1') || (x && *x == '1'); for (int i = 0; i < NCORE; i++) g_core[i].best = INT32_MAX; for (int i = 0; i < NCORE; i++) pthread_mutex_init(&g_core[i].m, NULL); }

void nx_core_release(void) {
    if (t_held < 0) return;
    int c = t_held; t_held = -1;
    pthread_mutex_lock(&g_core[c].m);
    waiter *b = NULL, **bp = NULL;
    for (waiter **p = &g_core[c].head; *p; p = &(*p)->next) if (!b || (*p)->prio < b->prio || ((*p)->prio == b->prio && (*p)->seq < b->seq)) { b = *p; bp = p; }
    if (b) { *bp = b->next; g_core[c].nwait--; best_set(c); b->granted = 1; pthread_cond_signal(&b->cv); g_handoffs++; }
    else atomic_store(&g_core[c].busy, 0);
    pthread_mutex_unlock(&g_core[c].m);
}
// The calling guest thread is about to run guest code: it holds a core when this returns
void nx_core_ensure(void) {
    pthread_once(&g_once, init);
    if (!g_on || t_held >= 0) return;
    int prio; uint64_t mask; int pref = nx_thr_sched(&prio, &mask);
    if (pref < 0) return;
    pref &= NCORE - 1; if (!(mask & 0xFF)) mask = 1ull << pref;
    t_prio = prio;
    for (int spin = 0; spin < 2000; spin++) {   // a free core of its mask, the preferred one first; a busy one is usually free within microseconds
        for (int k = 0; k < NCORE; k++) {
            int c = (pref + k) & (NCORE - 1), z = 0;
            if (!(mask >> c & 1)) continue;
            if (atomic_load_explicit(&g_core[c].nwait, memory_order_relaxed) && spin) continue;   // (not past the threads that queue for it)
            if (atomic_compare_exchange_strong(&g_core[c].busy, &z, 1)) { t_held = c; t_since = now_ns(); atomic_store_explicit(&g_core[c].holder, thr_cur_handle(), memory_order_relaxed); return; }
        }
        if (atomic_load_explicit(&g_core[pref].best, memory_order_relaxed) <= prio) break;   // others of at least this priority already queue: join them
    }
    uint64_t t0 = now_ns();
    waiter w = {.prio = prio, .seq = ++g_seq}; pthread_cond_init(&w.cv, NULL);
    pthread_mutex_lock(&g_core[pref].m);
    { int z = 0; if (atomic_compare_exchange_strong(&g_core[pref].busy, &z, 1)) w.granted = 1; }
    if (!w.granted) { w.next = g_core[pref].head; g_core[pref].head = &w; g_core[pref].nwait++; best_set(pref); while (!w.granted) pthread_cond_wait(&w.cv, &g_core[pref].m); }
    pthread_mutex_unlock(&g_core[pref].m);
    pthread_cond_destroy(&w.cv);
    t_held = pref; t_since = now_ns(); atomic_store_explicit(&g_core[pref].holder, thr_cur_handle(), memory_order_relaxed); g_waits++; g_wait_ns += now_ns() - t0;
}
// A slice end of translated code: a waiting thread of higher priority gets the core (preemption), and the caller queues behind
// One of EQUAL priority gets it only after the caller has had the core for 10 ms: Horizon does not time-slice equal
// priorities (but for priority 59), yet a thread that spins on something a peer of its core must do would otherwise
// never let it (the console's cores are not this exact, and the port's proof 2 puts all its threads on one core).
void nx_core_yield(void) {
    if (t_held < 0) return;
    int best = atomic_load_explicit(&g_core[t_held].best, memory_order_relaxed);
    if (best < t_prio || (best == t_prio && now_ns() - t_since > 10000000ull)) { if (best < t_prio) g_preempts++; else g_slices++; nx_core_release(); nx_core_ensure(); }
}
int nx_core_excl(void) { pthread_once(&g_once, init); return g_on; }
// for kernel/nx_guest.js: around the compile and instantiation of a unit (tens of milliseconds of host work in the middle of guest code)
EMSCRIPTEN_KEEPALIVE void nx_core_out(void) { nx_core_release(); }
EMSCRIPTEN_KEEPALIVE void nx_core_in(void) { nx_core_ensure(); }
// instructions of translated code per slice: short when a core can be asked for
EMSCRIPTEN_KEEPALIVE int nx_slice_budget(void) { pthread_once(&g_once, init); return g_on ? 1 << 17 : 1 << 26; }
void nx_core_stats(char *out, size_t n) {
    pthread_once(&g_once, init);
    if (!g_on) { snprintf(out, n, "off (NX_COREEXCL=1 turns it on): every guest thread runs whenever the host runs it"); return; }
    int busy = 0, wait = 0; char hold[200] = ""; size_t ho = 0;
    for (int i = 0; i < NCORE; i++) { busy += g_core[i].busy; wait += g_core[i].nwait; if (g_core[i].busy && ho < sizeof hold) ho += (size_t)snprintf(hold + ho, sizeof hold - ho, " core %d: thread %#x (%d waiting)", i, atomic_load(&g_core[i].holder), atomic_load(&g_core[i].nwait)); }
    snprintf(out, n, "%d of %d cores running, %d threads waiting for one; %llu waits for a core so far (%.1f ms each), %llu hand-overs, %llu preemptions at a slice end, %llu turns given to an equal after 10 ms; holders now:%s", busy, NCORE, wait,
             (unsigned long long)g_waits, g_waits ? g_wait_ns / 1e6 / g_waits : 0.0, (unsigned long long)g_handoffs, (unsigned long long)g_preempts, (unsigned long long)g_slices, hold[0] ? hold : " none");
}
