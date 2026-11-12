// nxem: the guest execution seam, C glue over nxnative. nxnative jumps into rewritten native code (entry.S
// dm_thread_enter) and takes SVCs through its gate; here every guest pthread drives its own instance of nxweb's
// translated wasm units (kernel/nx_guest.js) and the units' `svc` import lands in nx_svc on the same pthread.
// The unit registry and the translator service are C++ (kernel/nx_units.cpp); this file is what needs dm.h.
#include "dm.h"
#include "nx_port.h"
#include "nx_guest.h"
#include <stdatomic.h>
#include <stdarg.h>
#include <time.h>
#include <emscripten.h>
#include <emscripten/threading.h>

int svc_thread(int num, uint64_t *regs);
void thr_svc_enter(uint64_t *regs, uint64_t pc);
void thr_svc_leave(void);
void dm_thread_native_wait(int entering);

_Noreturn void nx_die(const char *what) { die("%s", what); }
void nx_log(const char *line) { LOG("%s", line); }
uint64_t nx_now_ns(void) { return now_ns(); }
void nx_native_wait(int entering) { dm_thread_native_wait(entering); }

// ---- SVC entry: regs is the thread's context block (nxweb docs/CONTRACT.md: x0..x30 at +0, sp +0xF8, pc +0x100)
_Atomic uint64_t nx_stat_svcs;
_Atomic uint64_t nx_svc_by_num[128];   // every SVC by number (the progress line shows which ones a spinning thread makes)
// (A floor under long runs of yields, 100 us a pass after 2 ms, was tried here on 2026-11-12 and taken out: the game's
// main thread works between its yields, and the floor made its start about eight times slower in Chrome. hle_thread.c's
// own back-off, which leaves a loop whose registers move alone, is what applies.)
// Yields that only wait. A thread that has yielded more than 64 times in a row, with no other SVC and no host call in
// between, is not working between its yields: it waits for another thread. On the console that yield hands its core
// over; here it would spin on a real core (3.4 million yields in 10 s at the title, measured in Chrome). Such a yield
// parks first: up to NX_YIELD_PARK_US microseconds (the page: ?yieldpark=; 0 = never), ended early by any SVC that
// wakes or starts a thread. A thread that works between its yields (the game's main thread makes host calls there)
// never gets to 64 and is not slowed, which is what the fixed floor tried on 2026-11-12 got wrong.
static _Atomic uint32_t g_wake_word; static _Atomic int g_parked;
_Atomic uint64_t nx_stat_yield_parks;
static __thread unsigned t_yields;
void nx_yield_reset(void) { t_yields = 0; }
static int park_us(void) { static int v = -1; if (v < 0) { const char *e = getenv("NX_YIELD_PARK_US"); v = e && *e ? atoi(e) : 100; } return v; }
static void yield_or_wake(int num, const uint64_t *regs) {
    if (num == 0x0B && (int64_t)regs[0] <= 0) {
        if (++t_yields > 64 && park_us() > 0) {
            uint32_t w = atomic_load(&g_wake_word);
            atomic_fetch_add(&g_parked, 1);
            emscripten_futex_wait(&g_wake_word, w, park_us() / 1000.0);
            atomic_fetch_sub(&g_parked, 1);
            atomic_fetch_add_explicit(&nx_stat_yield_parks, 1, memory_order_relaxed);
        }
        return;
    }
    t_yields = 0;
    if (num == 0x09 || num == 0x0A || num == 0x11 || num == 0x1B || num == 0x1D || num == 0x35) {   // StartThread, ExitThread, SignalEvent, ArbitrateUnlock, SignalProcessWideKey, SignalToAddress
        atomic_fetch_add(&g_wake_word, 1);
        if (atomic_load(&g_parked)) emscripten_futex_wake(&g_wake_word, 1 << 30);
    }
}
EMSCRIPTEN_KEEPALIVE void nx_svc(int num, double regs_) {
    uint64_t *regs = (uint64_t *)(uintptr_t)regs_;
    atomic_fetch_add_explicit(&nx_stat_svcs, 1, memory_order_relaxed);
    if (num >= 0 && num < 128) atomic_fetch_add_explicit(&nx_svc_by_num[num], 1, memory_order_relaxed);
    yield_or_wake(num, regs);
    if (num == 0x0B || num == 0x0A) nx_core_release();   // a sleep, a yield, the end of the thread: its core is free meanwhile
    thr_svc_enter(regs, regs[32]);
    if (!svc_thread(num, regs) && !nx_svc_other(num, regs)) {
        LOG("[RED] svc %#x at pc %#llx (x0=%#llx x1=%#llx x2=%#llx): not implemented", num, (unsigned long long)regs[32], (unsigned long long)regs[0], (unsigned long long)regs[1], (unsigned long long)regs[2]);
        { extern char g_stop_why[400]; snprintf(g_stop_why, 400, "svc %#x at pc %#llx is not implemented", num, (unsigned long long)regs[32]); }
        nx_boot_report("an SVC that is not implemented"); die("svc %#x", num);
    }
    thr_svc_leave();
    nx_core_ensure();   // back to guest code: on a core again (a yield queues behind whoever waited for it)
}

EMSCRIPTEN_KEEPALIVE void nx_guest_fault(double pc, double what_) {
    const char *what = (const char *)(uintptr_t)what_;
    module_t *m = module_of((void *)(uintptr_t)pc);
    LOG("[RED] guest fault at pc %#llx (%s+%#llx): %s", (unsigned long long)pc, m ? m->name : "?", (unsigned long long)(m ? (uint64_t)pc - (uint64_t)(uintptr_t)m->base : 0), what);
    { extern char g_stop_why[400];
      snprintf(g_stop_why, 400, "guest fault at pc %#llx (%s+%#llx): %s", (unsigned long long)pc, m ? m->name : "?", (unsigned long long)(m ? (uint64_t)pc - (uint64_t)(uintptr_t)m->base : 0), what); }
    nx_boot_report("a guest fault");
    emscripten_force_exit(3);
}

static __thread uint64_t t_last_x1;
// A guest function called from host code with up to 8 integer / pointer arguments (hle/nx_hle.h NXG)
uint64_t nx_guest_calln(uint64_t pc, int n, ...) {
    uint64_t a[9] = {0}; va_list ap; va_start(ap, n);
    for (int i = 0; i < n && i < 8; i++) a[i] = va_arg(ap, uint64_t);
    va_end(ap);
    a[8] = pc;
    nx_core_ensure();
    nx_js_guest_callv(a, n);
    t_last_x1 = a[1];
    return a[0];
}
uint64_t nx_guest_x1(void) { return t_last_x1; }
uint64_t nx_guest_call(uint64_t pc, uint64_t a0, uint64_t a1, uint64_t a2) { return nx_guest_calln(pc, 3, a0, a1, a2); }

// ---- thread entry: hle_thread.c's thread_main calls this on the new pthread, after StartThread
#define NX_MAX_SEEN 64
struct nx_seen { uint64_t entry; int js_tid; uintptr_t pt; } nx_seen[NX_MAX_SEEN]; _Atomic int nx_nseen;   // js_tid: an id of the worker's JS realm
void nx_note_thread(uint64_t entry) { int i = atomic_fetch_add(&nx_nseen, 1); if (i < NX_MAX_SEEN) nx_seen[i] = (struct nx_seen){entry, nx_js_tid(), (uintptr_t)pthread_self()}; }
void dm_thread_enter(uint64_t entry, uint64_t arg, uint64_t sp) {
    nx_note_thread(entry);
    uint64_t io[8] = {arg, 0, 0, 0, 0, entry, sp};
    nx_js_guest_setup((double)sp);
    nx_core_ensure();
    nx_js_guest_run(io);
    nx_core_release();
    // the entry function returned to the exit pc: the same as ExitThread
    uint64_t regs[100] = {0};
    svc_thread(0x0A, regs);
    abort();
}
