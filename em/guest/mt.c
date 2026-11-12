// Proof 2 guest (ARM64, freestanding): the user-mode half of a Horizon mutex (the lock word protocol nn::os and
// libnx use, with svcArbitrateLock / svcArbitrateUnlock under contention) around a plain shared counter, run by
// several guest threads the guest creates itself with svcCreateThread / svcStartThread and joins with
// svcWaitSynchronization. Entry at offset 0:
//   x0 = struct shared * (zeroed by the host), x1 = main thread handle, x2 = threads, x3 = rounds, x4 = mode
//   mode 0: mutex + counter;  mode 1: pure computation, nothing shared (throughput);  mode 2: LSE/exclusive atomic counter, no kernel
//   mode 3: the same atomic increment on a 32-bit word at an ODD address (the game does this; a wasm atomic traps there)
// Returns the counter (mode 0, 2) or the xor of the per-thread results (mode 1).
typedef unsigned long u64; typedef unsigned int u32;
#define WAITERS 0x40000000u
struct shared { u32 mutex; u32 pad; volatile u64 counter; u64 atomic_counter; u64 lock_svcs; u64 per_thread[32]; u64 result[32]; u64 started; u64 mis[2]; };
struct targ { u32 handle, idx; u64 rounds, mode, threads; struct shared *s; };

#define SVC_ASM(n) "svc #" #n
static inline u64 svc_create_thread(u32 *out, void (*entry)(void *), void *arg, void *stack_top, int prio, int core) {
  register u64 x0 __asm__("x0"); register u64 x1 __asm__("x1") = (u64)entry; register u64 x2 __asm__("x2") = (u64)arg;
  register u64 x3 __asm__("x3") = (u64)stack_top; register u64 x4 __asm__("x4") = (u64)prio; register u64 x5 __asm__("x5") = (u64)core;
  __asm__ volatile(SVC_ASM(0x08) : "=r"(x0), "+r"(x1) : "r"(x2), "r"(x3), "r"(x4), "r"(x5) : "memory");
  *out = (u32)x1; return x0;
}
#define DEF_SVC(name, n) static inline u64 name(u64 a, u64 b, u64 c, u64 d) { \
  register u64 x0 __asm__("x0") = a; register u64 x1 __asm__("x1") = b; register u64 x2 __asm__("x2") = c; register u64 x3 __asm__("x3") = d; \
  __asm__ volatile(SVC_ASM(n) : "+r"(x0), "+r"(x1), "+r"(x2), "+r"(x3) : : "memory"); return x0; }
DEF_SVC(svc_start_thread, 0x09)
DEF_SVC(svc_exit_thread, 0x0A)
DEF_SVC(svc_close, 0x16)
DEF_SVC(svc_wait_sync, 0x18)       // x1 = handles, x2 = count, x3 = timeout
DEF_SVC(svc_arb_lock, 0x1A)        // w0 = owner handle, x1 = address, w2 = own tag
DEF_SVC(svc_arb_unlock, 0x1B)      // x0 = address

static inline int cas32(u32 *p, u32 *expect, u32 v) { return __atomic_compare_exchange_n(p, expect, v, 0, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST); }
static void lock(struct shared *s, u32 self) {
  for (;;) {
    u32 cur = 0;
    if (cas32(&s->mutex, &cur, self)) return;
    if (!(cur & WAITERS) && !cas32(&s->mutex, &cur, cur | WAITERS)) continue;
    __atomic_fetch_add(&s->lock_svcs, 1, __ATOMIC_RELAXED);
    svc_arb_lock(cur & ~WAITERS, (u64)&s->mutex, self, 0);
    if ((__atomic_load_n(&s->mutex, __ATOMIC_SEQ_CST) & ~WAITERS) == self) return;
  }
}
static void unlock(struct shared *s, u32 self) {
  u32 e = self;
  if (!cas32(&s->mutex, &e, 0)) svc_arb_unlock((u64)&s->mutex, 0, 0, 0);
}
__attribute__((noinline)) static u64 compute(u64 seed, u64 rounds) {   // xorshift + a data-dependent branch + a small table: integer code the compiler cannot fold
  u64 x = seed | 1, acc = 0; u32 tab[64];
  for (int i = 0; i < 64; i++) tab[i] = (u32)(i * 2654435761u);
  for (u64 i = 0; i < rounds; i++) {
    x ^= x << 13; x ^= x >> 7; x ^= x << 17;
    u32 *p = &tab[x & 63];
    if (x & 0x100) acc += *p; else acc ^= (u64)*p << (x & 31);
    *p += (u32)acc;
  }
  return acc ^ x;
}
static void work(struct targ *t) {
  struct shared *s = t->s;
  // start gate: every thread spins here until all of them run, so the rounds below really overlap
  __atomic_fetch_add(&s->started, 1, __ATOMIC_SEQ_CST);
  while (__atomic_load_n(&s->started, __ATOMIC_SEQ_CST) < t->threads) ;
  if (t->mode == 0) {
    for (u64 i = 0; i < t->rounds; i++) { lock(s, t->handle); s->counter = s->counter + 1; unlock(s, t->handle); s->per_thread[t->idx]++; }
  } else if (t->mode == 1) {
    s->result[t->idx] = compute(0x9E3779B97F4A7C15ul * (t->idx + 1), t->rounds);
    s->per_thread[t->idx] = t->rounds;
  } else if (t->mode == 3) {
    u32 *odd = (u32 *)((char *)s->mis + 1);
    for (u64 i = 0; i < t->rounds; i++) __atomic_fetch_add(odd, 1, __ATOMIC_SEQ_CST);
    s->per_thread[t->idx] = t->rounds;
  } else {
    for (u64 i = 0; i < t->rounds; i++) __atomic_fetch_add(&s->atomic_counter, 1, __ATOMIC_SEQ_CST);
    s->per_thread[t->idx] = t->rounds;
  }
}
static void thread_entry(void *arg) { work(arg); svc_exit_thread(0, 0, 0, 0); for (;;) ; }

static struct targ T[32];
static char stacks[32][0x4000] __attribute__((aligned(16)));
__attribute__((section(".text.start"))) u64 guest_main(struct shared *s, u64 main_handle, u64 threads, u64 rounds, u64 mode) {
  if (threads > 32) threads = 32;
  for (u64 i = 0; i < threads; i++) { T[i].idx = (u32)i; T[i].rounds = rounds; T[i].mode = mode; T[i].threads = threads; T[i].s = s; }
  T[0].handle = (u32)main_handle;
  for (u64 i = 1; i < threads; i++) {
    if (svc_create_thread(&T[i].handle, thread_entry, &T[i], stacks[i] + sizeof stacks[i], 44, (int)(i % 3))) return ~0ul;
    if (svc_start_thread(T[i].handle, 0, 0, 0)) return ~1ul;
  }
  work(&T[0]);
  for (u64 i = 1; i < threads; i++) {
    u32 h = T[i].handle;
    if (svc_wait_sync(0, (u64)&h, 1, ~0ul)) return ~2ul;
    svc_close(h, 0, 0, 0);
  }
  if (mode == 1) { u64 r = 0; for (u64 i = 0; i < threads; i++) r ^= s->result[i]; return r; }
  if (mode == 3) return *(u32 *)((char *)s->mis + 1);
  return mode == 0 ? s->counter : s->atomic_counter;
}
// a function the host calls directly (nx_guest_call), as hle_bind_system_event calls nn::os::CreateSystemEvent
u64 guest_add3(u64 a, u64 b, u64 c) { return a + 2 * b + 3 * c; }
