// The counter while the guest clock is frozen for background: a thread that reads cntpct_el0 parks at the read and
// goes on, with its registers intact, when the freeze ends.
#include "rt.h"
u32 mutex_slow;
IMPORT void host_freeze(int on);
u64 cnt_read_keep(u64 a, u64 b, u64 *tick);   // svc.S: reads the counter into *tick, returns a + b
static u8 stack[0x4000] __attribute__((aligned(16)));
static Thread t;
static volatile u64 done, tick, sum;
static void reader(void *arg) { u64 v = 0; sum = cnt_read_keep(40, 2, &v); tick = v; done = 1; }
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  u64 t0 = 0;
  cnt_read_keep(0, 0, &t0);
  host_freeze(1);
  thread_start(&t, reader, 0, stack + sizeof stack, 44, 1);
  volatile u64 spin = 0;
  for (u64 i = 0; i < 400000; i++) spin += i;
  say(done ? "the reader read the counter while it was frozen" : "the reader is parked at its counter read");
  host_freeze(0);
  thread_join(&t);
  Line l; l.n = 0; l_s(&l, "the reader went on: a + b = "); l_u(&l, sum); l_s(&l, tick >= t0 ? ", its tick is not before the freeze" : ", its tick is BEFORE the freeze"); l_out(&l);
  return 0;
}
