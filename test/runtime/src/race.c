// (c) A program whose output DOES depend on the schedule: four threads on four cores write to a shared log and bump
// a counter with no lock at all. The same budget must give the same output every run (determinism).
#include "rt.h"
u32 mutex_slow;
#define NT 4
static u8 stacks[NT][0x2000] __attribute__((aligned(16)));
static Thread th[NT];
static char log_[NT * 24 + 1];
static volatile u32 pos, shared;
static NOINLINE void spin(u32 n) { for (volatile u32 i = 0; i < n; i++) { } }
static void race_fn(void *arg) {
  u32 id = (u32)(u64)arg;
  for (int i = 0; i < 24; i++) {
    u32 v = shared;
    spin(40 + id * 7);
    shared = v + 1;                       // a lost update whenever another thread ran in between
    u32 p = pos; pos = p + 1;
    if (p < sizeof log_ - 1) log_[p] = 'A' + id;
  }
}
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  for (u64 i = 0; i < NT; i++) thread_start(&th[i], race_fn, (void *)i, stacks[i] + 0x2000, 44, i);
  for (int i = 0; i < NT; i++) thread_join(&th[i]);
  Line l; l.n = 0;
  l_s(&l, "order "); l_s(&l, log_); l_out(&l);
  l_s(&l, "shared="); l_u(&l, shared); l_s(&l, " of 96, pos="); l_u(&l, pos); l_out(&l);
  return 0;
}
