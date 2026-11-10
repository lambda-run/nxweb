// Support for the runtime's test modules: types, SVCs, output, and the SDK's user-mode synchronization (a mutex with a
// user-mode fast path on the lock word and ArbitrateLock/ArbitrateUnlock on contention, a condition variable on
// WaitProcessWideKeyAtomic/SignalProcessWideKey), written the way libnx and nn::os do it.
#pragma once
typedef unsigned char u8; typedef unsigned int u32; typedef unsigned long u64; typedef int s32; typedef long s64;
typedef u32 Handle; typedef u32 Result;
#define EXPORT __attribute__((visibility("default")))
#define IMPORT extern __attribute__((visibility("default")))
#define NOINLINE __attribute__((noinline))
#define R_TIMEOUT 0xEA01u
#define WAITERS 0x40000000u

typedef struct { u64 addr, size; u32 type, attr, perm, ipc, dev, pad; } MemoryInfo;
Result svcSetHeapSize(void **out, u64 size);
Result svcQueryMemory(MemoryInfo *info, u32 *pageinfo, u64 addr);
void svcExitProcess(int code) __attribute__((noreturn));
Result svcCreateThread(Handle *out, void (*entry)(void *), void *arg, void *stack_top, int prio, int core);
Result svcStartThread(Handle h);
void svcExitThread(void) __attribute__((noreturn));
void svcSleepThread(s64 ns);
Result svcSignalEvent(Handle h);
Result svcClearEvent(Handle h);
Result svcCloseHandle(Handle h);
Result svcResetSignal(Handle h);
Result svcWaitSynchronization(s32 *index, const Handle *handles, s32 count, s64 timeout);
Result svcArbitrateLock(Handle owner, u32 *lock, Handle self);
Result svcArbitrateUnlock(u32 *lock);
Result svcWaitProcessWideKeyAtomic(u32 *lock, u32 *key, Handle self, s64 timeout);
Result svcSignalProcessWideKey(u32 *key, s32 count);
u64 svcGetSystemTick(void);
Result svcBreak(u64 reason, u64 a, u64 b);
Result svcOutputDebugString(const char *s, u64 len);
Result svcGetInfo(u64 *out, u32 id0, Handle h, u64 id1);
Result svcCreateEvent(Handle *writable, Handle *readable);
Result svcMapMemory(void *dst, void *src, u64 size);
Result svcUnmapMemory(void *dst, void *src, u64 size);

// ---- output: a line is built in a buffer and written with one SVC ----
typedef struct { char b[240]; u32 n; } Line;
static inline void l_c(Line *l, char c) { if (l->n < sizeof l->b) l->b[l->n++] = c; }
static inline void l_s(Line *l, const char *s) { while (*s) l_c(l, *s++); }
static inline void l_u(Line *l, u64 v) { char t[20]; int n = 0; do { t[n++] = '0' + v % 10; v /= 10; } while (v); while (n) l_c(l, t[--n]); }
static inline void l_d(Line *l, s64 v) { if (v < 0) { l_c(l, '-'); v = -v; } l_u(l, (u64)v); }
static inline void l_x(Line *l, u64 v) { l_s(l, "0x"); int sh = 60; while (sh && !((v >> sh) & 15)) sh -= 4; for (; sh >= 0; sh -= 4) l_c(l, "0123456789abcdef"[(v >> sh) & 15]); }
static inline void l_out(Line *l) { l_c(l, '\n'); svcOutputDebugString(l->b, l->n); l->n = 0; }
static inline void say(const char *s) { Line l; l.n = 0; l_s(&l, s); l_out(&l); }
static inline void say_u(const char *s, u64 v) { Line l; l.n = 0; l_s(&l, s); l_u(&l, v); l_out(&l); }
static inline void say_x(const char *s, u64 v) { Line l; l.n = 0; l_s(&l, s); l_x(&l, v); l_out(&l); }

// ---- the current thread's handle: kept in the ThreadLocalRegion (tpidrro_el0), where libnx keeps its ThreadVars ----
static inline u8 *tlr(void) { u64 v; __asm__ volatile("mrs %0, tpidrro_el0" : "=r"(v)); return (u8 *)v; }
static inline Handle self_handle(void) { return *(Handle *)(tlr() + 0x1E4); }
static inline void set_self_handle(Handle h) { *(Handle *)(tlr() + 0x1E4) = h; }

// ---- threads ----
typedef struct { Handle h; void (*fn)(void *); void *arg; } Thread;
static void thread_tramp(void *p) { Thread *t = p; set_self_handle(t->h); t->fn(t->arg); svcExitThread(); }
static inline Result thread_start(Thread *t, void (*fn)(void *), void *arg, void *stack_top, int prio, int core) {
  t->fn = fn; t->arg = arg;
  Result rc = svcCreateThread(&t->h, thread_tramp, t, stack_top, prio, core);
  return rc ? rc : svcStartThread(t->h);
}
static inline Result thread_join(Thread *t) {
  s32 idx = -1;
  Result rc = svcWaitSynchronization(&idx, &t->h, 1, -1);
  svcCloseHandle(t->h);
  return rc;
}

// ---- mutex (libnx mutexLock / mutexUnlock) ----
typedef u32 Mutex;
extern u32 mutex_slow;   // how often a lock went to the kernel
static inline int cas32(u32 *p, u32 expect, u32 want) { return __atomic_compare_exchange_n(p, &expect, want, 0, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST); }
static inline void mutex_lock(Mutex *m) {
  const Handle self = self_handle();
  for (;;) {
    u32 cur = __atomic_load_n(m, __ATOMIC_SEQ_CST);
    if (cur == 0) { if (cas32(m, 0, self)) return; continue; }        // fast path: nobody holds it
    if (!(cur & WAITERS) && !cas32(m, cur, cur | WAITERS)) continue;  // tell the owner that somebody waits
    mutex_slow++;
    svcArbitrateLock(cur & ~WAITERS, m, self);                        // the kernel queues us; the unlocker hands the lock over
    if ((__atomic_load_n(m, __ATOMIC_SEQ_CST) & ~WAITERS) == self) return;
  }
}
static inline void mutex_unlock(Mutex *m) {
  const Handle self = self_handle();
  if (!cas32(m, self, 0)) svcArbitrateUnlock(m);                      // waiters bit set: the kernel picks the next owner
}
// ---- condition variable (libnx condvarWaitTimeout / condvarWake) ----
typedef u32 CondVar;
static inline Result cond_wait(CondVar *c, Mutex *m, s64 timeout) {
  Result rc = svcWaitProcessWideKeyAtomic(m, c, self_handle(), timeout);
  if (rc == R_TIMEOUT) mutex_lock(m);                                 // on a signal the kernel gave us the lock
  return rc;
}
static inline void cond_wake(CondVar *c, int n) { svcSignalProcessWideKey(c, n); }
