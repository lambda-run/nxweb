// (e) Host functions: a forced take-over of a function the library defines, a weak take-over of one nobody defines,
// an import nobody has at all, host functions that read and write guest memory, and one that blocks the calling
// thread until another guest thread makes the host signal.
#include "rt.h"
u32 mutex_slow;
IMPORT int forced_fn(int x);          // host_lib defines it; the host takes it over for everyone
IMPORT int lib_calls_forced(int x);   // host_lib's own call of forced_fn: also the host's
IMPORT int weak_fn(int x);            // nobody defines it; the host's weaker table fills it
IMPORT int lib_wins(int x);           // host_lib defines it and the host offers a weak one: the library's is used
IMPORT int missing_fn(int x);         // nobody: an unresolved import
IMPORT void host_log(const char *s);
IMPORT void host_fill(u8 *p, u32 n, u32 seed);
IMPORT u32 host_sum(const u8 *p, u32 n);
IMPORT s64 host_wait(s64 timeout_ns);   // blocks until host_post, returns the posted value, or -1 on timeout
IMPORT void host_post(s64 v);

static u8 stack[0x4000] __attribute__((aligned(16)));
static Thread poster;
static void post_fn(void *arg) { svcSleepThread(2000000); host_post((s64)(u64)arg); }

int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  say_u("forced_fn(5) = ", forced_fn(5));
  say_u("lib_calls_forced(5) = ", lib_calls_forced(5));
  say_u("weak_fn(3) = ", weak_fn(3));
  say_u("lib_wins(3) = ", lib_wins(3));
  say_u("missing_fn(9) = ", missing_fn(9));
  say_u("missing_fn(10) = ", missing_fn(10));
  host_log("a line from the guest through host_log");
  static u8 buf[64];
  host_fill(buf, 64, 3);
  u32 s = 0; for (int i = 0; i < 64; i++) s += buf[i];
  Line l; l.n = 0;
  l_s(&l, "host_fill wrote, guest sums "); l_u(&l, s); l_s(&l, ", host_sum reads "); l_u(&l, host_sum(buf, 64)); l_out(&l);
  l_s(&l, "host_wait(1 ms) with nobody posting = "); l_d(&l, host_wait(1000000)); l_out(&l);
  thread_start(&poster, post_fn, (void *)77, stack + sizeof stack, 44, 1);
  u64 t0 = svcGetSystemTick();
  s64 v = host_wait(-1);
  l_s(&l, "host_wait() = "); l_d(&l, v); l_s(&l, ", blocked at least 2 ms: "); l_s(&l, svcGetSystemTick() - t0 >= 38400 ? "yes" : "no"); l_out(&l);
  thread_join(&poster);
  say("host calls done");
  svcExitProcess(0);
}
