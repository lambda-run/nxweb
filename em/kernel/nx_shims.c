// nxem: the host facilities hle_thread.c takes from the rest of nxnative (loader.c, thread.c, hle_os.c, crash.c,
// hle_nvn.c), reduced to what the thread core needs. All weak: the real definition wins when its file is in the build.
#include "dm.h"
#include "nx_port.h"
#include <emscripten/heap.h>
#include <emscripten/threading.h>
__attribute__((weak)) struct dm_flags g_flag;
__attribute__((weak)) uint64_t g_t0_ns;
__attribute__((weak)) pthread_key_t g_key18;                 // the guest's x18 slot (loader.c): unused here, x18 is a wasm global of the thread's core
__attribute__((weak)) __thread uint64_t dm_clock_reads;      // hle_os.c
__attribute__((weak)) __thread _Atomic int dm_host_work;     // hle_nvn.c
__attribute__((weak)) void crash_thread_init(void) {}
__attribute__((weak)) void guest_thread_init(void) {}                         // kernel/nx_proc.c for a real game
__attribute__((weak)) void guest_thread_set_id(uint64_t id) { (void)id; }
__attribute__((weak)) void guest_gate_stack(int own_stack) { (void)own_stack; }
__attribute__((weak)) void *guest_sym(const char *name) { (void)name; return NULL; }
__attribute__((weak)) module_t *module_of(const void *p) { (void)p; return NULL; }
// The clock behind everything the guest reads as time. A browser's clock is coarse (performance.now() steps by 5 us in
// an isolated page, 100 us otherwise) and each worker adds its own, separately rounded, time origin: two reads of the
// system counter a few microseconds apart gave the SAME tick, and a read on one thread could be earlier than one made
// before it on another. A console's counter does neither, and a game divides by such differences (an elapsed time of 0
// between two reads makes 0/0: the title's transforms came out as NaN now and then, see the fault dumps of 2026-11-12).
// So: never less than the last value any thread got, plus one counter tick (32 ns at the Switch 2's 31.25 MHz).
#include <stdatomic.h>
static _Atomic uint64_t g_mono_last; _Atomic uint64_t nx_mono_bumps;
uint64_t nx_mono_ns(void) {
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    uint64_t v = (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec, l = atomic_load_explicit(&g_mono_last, memory_order_relaxed);
    for (;;) {
        if (v <= l) { v = l + 32; atomic_fetch_add_explicit(&nx_mono_bumps, 1, memory_order_relaxed); }
        if (atomic_compare_exchange_weak(&g_mono_last, &l, v)) return v;
    }
}
__attribute__((weak)) uint64_t now_ns(void) { return nx_mono_ns(); }
__attribute__((weak)) uint64_t guest_ns(void) { return now_ns(); }
__attribute__((weak)) int dm_detclock_enabled(void) { return 0; }
void nx_setname_self(const char *name) { emscripten_set_thread_name(pthread_self(), name); }
int pthread_cond_timedwait_relative_np(pthread_cond_t *c, pthread_mutex_t *m, const struct timespec *rel) {
    struct timespec dl; clock_gettime(CLOCK_REALTIME, &dl);
    dl.tv_sec += rel->tv_sec; dl.tv_nsec += rel->tv_nsec; if (dl.tv_nsec >= 1000000000) { dl.tv_sec++; dl.tv_nsec -= 1000000000; }
    return pthread_cond_timedwait(c, m, &dl);
}
int nx_vm_read(uint64_t addr, size_t n, void *dst, size_t *got) {
    if (addr + n < addr || addr + n > (uint64_t)emscripten_get_heap_size()) { if (got) *got = 0; return 1; }
    memcpy(dst, (const void *)(uintptr_t)addr, n); if (got) *got = n; return 0;
}
