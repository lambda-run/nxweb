// EXPERIMENTAL (spike, SPIKE.md). Store, barrier, load on two cores at the same moment (Dekker's test):
//   core 1:  X = 1; dmb ish; r0 = Y        core 2:  Y = 1; dmb ish; r1 = X
// With the barrier, r0 == 0 && r1 == 0 is impossible on ARM. A translator that compiles `dmb` to nothing lets an x86
// host's store buffer produce it. For Workers only: the three threads spin (no SVC), which green threads would turn
// into three time slices per round.
#include "rt.h"
u32 mutex_slow;
#ifndef ROUNDS
#define ROUNDS 200000
#endif
static u8 stacks[2][0x4000] __attribute__((aligned(16)));
static Thread th[2];
// each on its own cache line
static struct { volatile u32 v; u32 pad[31]; } X, Y, R0, R1, round_, done0, done1;
static void t0_fn(void *arg) {
  for (u32 i = 1; i <= ROUNDS; i++) {
    while (round_.v != i) { }
    X.v = 1;
    __asm__ volatile("dmb ish");
    R0.v = Y.v;
    done0.v = i;
  }
}
static void t1_fn(void *arg) {
  for (u32 i = 1; i <= ROUNDS; i++) {
    while (round_.v != i) { }
    Y.v = 1;
    __asm__ volatile("dmb ish");
    R1.v = X.v;
    done1.v = i;
  }
}
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  thread_start(&th[0], t0_fn, 0, stacks[0] + 0x4000, 44, 1);
  thread_start(&th[1], t1_fn, 0, stacks[1] + 0x4000, 44, 2);
  u32 both0 = 0;
  for (u32 i = 1; i <= ROUNDS; i++) {
    X.v = 0; Y.v = 0;
    __asm__ volatile("dmb ish");
    round_.v = i;
    while (done0.v != i || done1.v != i) { }
    if (R0.v == 0 && R1.v == 0) both0++;
  }
  thread_join(&th[0]); thread_join(&th[1]);
  Line l; l.n = 0;
  l_s(&l, "dekker: both cores read 0 after their barrier in "); l_u(&l, both0); l_s(&l, " of "); l_u(&l, ROUNDS); l_s(&l, " rounds"); l_out(&l);
  return 0;
}
