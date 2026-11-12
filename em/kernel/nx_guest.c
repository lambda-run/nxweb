// nxem: the guest execution seam, C glue over nxnative. nxnative jumps into rewritten native code (entry.S
// dm_thread_enter) and takes SVCs through its gate; here every guest pthread drives its own instance of nxweb's
// translated wasm units (kernel/nx_guest.js) and the units' `svc` import lands in nx_svc on the same pthread.
// The unit registry and the translator service are C++ (kernel/nx_units.cpp); this file is what needs dm.h.
#include "dm.h"
#include "nx_port.h"
#include "nx_guest.h"
#include <stdatomic.h>
#include <stdarg.h>
#include <emscripten.h>

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
EMSCRIPTEN_KEEPALIVE void nx_svc(int num, double regs_) {
    uint64_t *regs = (uint64_t *)(uintptr_t)regs_;
    atomic_fetch_add_explicit(&nx_stat_svcs, 1, memory_order_relaxed);
    thr_svc_enter(regs, regs[32]);
    if (!svc_thread(num, regs) && !nx_svc_other(num, regs)) {
        LOG("[RED] svc %#x at pc %#llx (x0=%#llx x1=%#llx x2=%#llx): not implemented", num, (unsigned long long)regs[32], (unsigned long long)regs[0], (unsigned long long)regs[1], (unsigned long long)regs[2]);
        nx_boot_report("an SVC that is not implemented"); die("svc %#x", num);
    }
    thr_svc_leave();
}

EMSCRIPTEN_KEEPALIVE void nx_guest_fault(double pc, double what_) {
    const char *what = (const char *)(uintptr_t)what_;
    module_t *m = module_of((void *)(uintptr_t)pc);
    LOG("[RED] guest fault at pc %#llx (%s+%#llx): %s", (unsigned long long)pc, m ? m->name : "?", (unsigned long long)(m ? (uint64_t)pc - (uint64_t)(uintptr_t)m->base : 0), what);
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
    nx_js_guest_run(io);
    // the entry function returned to the exit pc: the same as ExitThread
    uint64_t regs[100] = {0};
    svc_thread(0x0A, regs);
    abort();
}
