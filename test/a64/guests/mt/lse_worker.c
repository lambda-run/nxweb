// One function, run by several host threads at once on one shared memory (test/a64/lse_threads.ts): every update
// below is an LSE atomic, and the totals the test checks afterwards only come out when each is atomic.
// Built by ../build.py with the Switch 2 flags into out/mt_lse_worker.bin; `worker` is at offset 0.
#include <stdatomic.h>
typedef unsigned long u64;
struct shared {
  _Atomic u64 add;                 // LDADD: + 1 per round
  _Atomic u64 cas;                 // CAS loop: + 3 per round
  u64 umax;                        // LDUMAX of (round << 8 | thread)
  long smin;                       // LDSMIN of -(round)
  _Atomic unsigned char lock;      // SWPB spin lock around `plain`
  _Atomic unsigned short add16;    // LDADDH: + 1 per round, wraps
  _Atomic unsigned int clr32;      // LDSET / LDCLR of the thread's own bit: 0 at the end
  volatile u64 plain;              // + 1 per round under the lock, not atomic by itself
  _Atomic u64 bits;                // LDSET then LDCLR of the thread's own bit
  _Atomic u64 x;                   // LDEOR with the same value twice
  _Atomic __int128 wide;           // CASP loop: + 1 per round, starts just below a carry into the upper word
};
__attribute__((section(".text.start"))) u64 worker(struct shared *s, u64 rounds, u64 tid) {
  u64 spins = 0;
  for (u64 i = 0; i < rounds; i++) {
    atomic_fetch_add(&s->add, 1);
    u64 e = atomic_load_explicit(&s->cas, memory_order_acquire);
    while (!atomic_compare_exchange_strong(&s->cas, &e, e + 3)) spins++;
    __atomic_fetch_max(&s->umax, (i << 8) | tid, __ATOMIC_SEQ_CST);
    __atomic_fetch_min(&s->smin, -(long)i, __ATOMIC_SEQ_CST);
    while (atomic_exchange(&s->lock, 1)) spins++;
    s->plain = s->plain + 1;
    atomic_store(&s->lock, 0);
    atomic_fetch_add(&s->add16, 1);
    atomic_fetch_or(&s->clr32, 1u << tid); atomic_fetch_and(&s->clr32, ~(1u << tid));
    atomic_fetch_or(&s->bits, 1ul << (tid + 32)); atomic_fetch_and(&s->bits, ~(1ul << (tid + 32)));
    atomic_fetch_xor(&s->x, 0x0101010101010101ul * (tid + 1) + i); atomic_fetch_xor(&s->x, 0x0101010101010101ul * (tid + 1) + i);
    __int128 w = atomic_load(&s->wide);
    while (!atomic_compare_exchange_strong(&s->wide, &w, w + 1)) spins++;
  }
  return spins;
}
