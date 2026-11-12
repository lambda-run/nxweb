// nxem: nxweb's NVN recorder called by the guest threads themselves.
//
// The recorder (gfx64.wasm) is an AssemblyScript module; tools/globals_to_memory.mjs moved its globals into the shared
// memory, so every thread can have an instance and they are all the one recorder. An NVN entry point whose stub does
// nothing but nvn_call(id, args) (nxweb's RtGfx.direct: all but the handful that wait, pace or look shaders up) is
// answered here on the calling thread, under the recorder's lock, instead of on the owner thread. The owner is still
// asked for what only it can do: gfx_exec (the WebGPU replayer), at a flush (kernel/nx_guest.js $nxGfx).
// The words at NXG are laid out in owner/owner.ts.
#include <stdatomic.h>
#include <stdint.h>
#include <string.h>
#include <pthread.h>
#include <emscripten.h>
#include <emscripten/threading.h>
#include "nx_guest.h"

#define NXG 0x1FF1F000u
#define GL_LOCK ((_Atomic uint32_t *)(uintptr_t)NXG)
#define GL_WAITERS ((_Atomic uint32_t *)(uintptr_t)(NXG + 4))
#define GL_ON ((_Atomic uint32_t *)(uintptr_t)(NXG + 44))
static uint32_t g_depth;   // the holder's
static _Atomic uint64_t g_calls, g_ns, g_contended, g_lock_ns;
static __thread uint32_t t_me; static __thread uint64_t t_flush_ns;
EMSCRIPTEN_KEEPALIVE void nx_gfx_flush_ns(double ns) { t_flush_ns += (uint64_t)ns; }   // kernel/nx_guest.js: the time a flush waited for the owner
uint64_t nx_now_ns(void);
void nx_core_release(void);
void nx_js_gfx_call(int id, double args);
uint64_t nx_guest_calln(uint64_t pc, int n, ...);

static inline uint32_t me(void) { if (!t_me) t_me = (uint32_t)(uintptr_t)pthread_self() | 2; return t_me; }   // never 0 (free) or 1 (the owner)
int nx_gfx_enabled(void) { return atomic_load(GL_ON) != 0; }
void nx_gfx_lock(void) {
    uint32_t m = me();
    if (atomic_load(GL_LOCK) == m) { g_depth++; return; }   // a callback of the recorder into guest code that calls NVN again
    for (int spin = 0;; spin++) {
        uint32_t z = 0;
        if (atomic_compare_exchange_weak(GL_LOCK, &z, m)) break;
        if (spin < 4000) continue;   // (a call of the recorder is about a microsecond: the lock is usually free again within the spin)
        if (spin == 4000) { atomic_fetch_add_explicit(&g_contended, 1, memory_order_relaxed); nx_core_release(); }   // (its core is free while it sleeps; taken again at the end of the host call)
        atomic_fetch_add(GL_WAITERS, 1); if (z) emscripten_futex_wait(GL_LOCK, z, 1.0); atomic_fetch_sub(GL_WAITERS, 1);
    }
    g_depth = 1;
}
void nx_gfx_unlock(void) {
    if (--g_depth) return;
    atomic_store(GL_LOCK, 0);
    if (atomic_load(GL_WAITERS)) emscripten_futex_wake(GL_LOCK, 1);
}
// A thread that holds the lock and is about to wait for the owner for something else gives it up for that time (the
// owner may need the recorder to answer): the depth it held, 0 when it does not hold it
int nx_gfx_release_all(void) {
    if (!t_me || atomic_load(GL_LOCK) != t_me) return 0;
    int d = (int)g_depth; g_depth = 1; nx_gfx_unlock();
    return d;
}
void nx_gfx_reacquire(int depth) { if (depth) { nx_gfx_lock(); g_depth = (uint32_t)depth; } }

// code: (NVN function id + 1) | abi << 16 (abi: bits 0..3 how many of d0..d7 it reads, bit 4 a float result)
uint64_t nx_gfx_direct(int code, uint64_t *regs) {   // returns how long the lock was held, ns
    int id = (code & 0xFFFF) - 1, abi = code >> 16;
    uint64_t *a = regs + 0x340 / 8, t0 = nx_now_ns();   // the argument block: x0..x7, d0..d7, then the result
    memcpy(a, regs, 64);
    if (abi & 15) for (int i = 0; i < 8; i++) a[8 + i] = regs[38 + 2 * i];
    nx_gfx_lock();
    uint64_t t1 = nx_now_ns(), t_hold = 0;
    nx_js_gfx_call(id, (double)(uintptr_t)a);
    nx_gfx_unlock();
    if (abi & 16) { regs[38] = a[8]; regs[39] = 0; } else regs[0] = a[16];
    { void nx_acc_add(int, double); uint64_t t2 = nx_now_ns(), fl = t_flush_ns; t_flush_ns = 0;   // (kernel/nx_proc.c: 0 NVN, 9 NVN-lock, 10 flush)
      nx_acc_add(9, (double)(t1 - t0)); nx_acc_add(10, (double)fl); nx_acc_add(0, (double)(t2 - t1 > fl ? t2 - t1 - fl : 0)); t_hold = t2 - t1; }
    atomic_fetch_add_explicit(&g_calls, 1, memory_order_relaxed); atomic_fetch_add_explicit(&g_ns, nx_now_ns() - t0, memory_order_relaxed); atomic_fetch_add_explicit(&g_lock_ns, t1 - t0, memory_order_relaxed);
    return t_hold;
}
// The recorder's callback into guest code (gfx_guest_call: the command memory callbacks), on the thread that is in the
// recorder: blk = the function and four arguments, the result comes back in blk[0]
EMSCRIPTEN_KEEPALIVE void nx_gfx_guest_call(double blk_) {
    uint64_t *b = (uint64_t *)(uintptr_t)blk_;
    b[0] = nx_guest_calln(b[0], 4, b[1], b[2], b[3], b[4]);
}
// out: calls answered on the calling thread, their time in ns (lock wait included), times a thread had to sleep for the lock, ns getting the lock
EMSCRIPTEN_KEEPALIVE void nx_gfx_stats(double out_) { double *o = (double *)(uintptr_t)out_; o[0] = (double)atomic_load(&g_calls); o[1] = (double)atomic_load(&g_ns); o[2] = (double)atomic_load(&g_contended); o[3] = (double)atomic_load(&g_lock_ns); }

// ---- nxweb's fs module the same way (owner/owner.ts NXF): nn::fs calls run in the calling thread's instance under the
// module's lock; the storage (the dev_* imports) is the owner's, asked through the lock holder's request words, and a
// call whose storage answer is not there yet waits on its context block's cell, which the owner's completion sets.
#include <unistd.h>
#define NXF 0x1FF1F100u
#define FL_LOCK ((_Atomic uint32_t *)(uintptr_t)NXF)
#define FL_WAITERS ((_Atomic uint32_t *)(uintptr_t)(NXF + 4))
#define FL_ON ((_Atomic uint32_t *)(uintptr_t)(NXF + 28))
static _Atomic uint64_t g_fs_calls, g_fs_ns, g_fs_pending;
int nx_js_fs_call(int id, double ctx);
void nx_core_release(void);
int nx_fs_enabled(void) { return atomic_load(FL_ON) != 0; }
static void fs_lock(void) {
    uint32_t m = me();
    for (int spin = 0;; spin++) {
        uint32_t z = 0;
        if (atomic_compare_exchange_weak(FL_LOCK, &z, m)) break;
        if (spin < 4000) continue;
        atomic_fetch_add(FL_WAITERS, 1); if (z) emscripten_futex_wait(FL_LOCK, z, 1.0); atomic_fetch_sub(FL_WAITERS, 1);
    }
}
static void fs_unlock(void) { atomic_store(FL_LOCK, 0); if (atomic_load(FL_WAITERS)) emscripten_futex_wake(FL_LOCK, 1); }
// id: the module's function id; regs: the caller's context block (x0..x7 are the arguments, x0 takes the result)
void nx_fs_direct(int id, uint64_t *regs) {
    uint64_t args[8], t0 = nx_now_ns(); memcpy(args, regs, sizeof args);
    _Atomic uint32_t *cell = (_Atomic uint32_t *)((uint8_t *)regs + 0x3F0);
    for (;;) {
        atomic_store(cell, 0);
        fs_lock();
        int r = nx_js_fs_call(id, (double)(uintptr_t)regs);   // 0 done, 1 pending, 2 retry (busy with another thread's pending call)
        fs_unlock();
        if (r == 0) break;
        if (r == 1) { atomic_fetch_add_explicit(&g_fs_pending, 1, memory_order_relaxed); nx_core_release(); while (!atomic_load(cell)) emscripten_futex_wait(cell, 0, 1e9); break; }
        memcpy(regs, args, sizeof args); usleep(200);
    }
    atomic_fetch_add_explicit(&g_fs_calls, 1, memory_order_relaxed); atomic_fetch_add_explicit(&g_fs_ns, nx_now_ns() - t0, memory_order_relaxed);
}
// out: nn::fs calls answered on the calling thread, their time in ns (waits for the storage included), how many waited for the storage
EMSCRIPTEN_KEEPALIVE void nx_fs_stats(double out_) { double *o = (double *)(uintptr_t)out_; o[0] = (double)atomic_load(&g_fs_calls); o[1] = (double)atomic_load(&g_fs_ns); o[2] = (double)atomic_load(&g_fs_pending); }
