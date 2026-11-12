// nxem: the host facilities hle_thread.c takes from the rest of nxnative (loader.c, thread.c, hle_os.c, crash.c,
// hle_nvn.c), reduced to what the thread core needs. In a full port most of these come back as the real files.
#include "dm.h"
#include "nx_port.h"
#include <emscripten/heap.h>
#include <emscripten/threading.h>
struct dm_flags g_flag;
uint64_t g_t0_ns;
pthread_key_t g_key18;                 // the guest's x18 slot (loader.c): unused here, x18 is a wasm global of the thread's core
__thread uint64_t dm_clock_reads;      // hle_os.c
__thread _Atomic int dm_host_work;     // hle_nvn.c
void crash_thread_init(void) {}
void guest_thread_init(void) {}
void guest_thread_set_id(uint64_t id) { (void)id; }
void guest_gate_stack(int own_stack) { (void)own_stack; }
__attribute__((weak)) void *guest_sym(const char *name) { (void)name; return NULL; }
__attribute__((weak)) module_t *module_of(const void *p) { (void)p; return NULL; }
uint64_t now_ns(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec; }
uint64_t guest_ns(void) { return now_ns(); }
int dm_detclock_enabled(void) { return 0; }
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
