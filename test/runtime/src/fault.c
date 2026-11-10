// (f) Faults, one per build (-DMODE=n). Each prints a line and then does the thing that must stop the process.
#include "rt.h"
u32 mutex_slow;
#if MODE == 3
static u8 stack[0x4000] __attribute__((aligned(16)));
static Thread t;
#endif
#pragma clang diagnostic ignored "-Winfinite-recursion"
static NOINLINE u64 recurse(u64 n, volatile u64 *up) {
  volatile u64 here[4];
  here[0] = n; here[1] = up ? *up : 0;
  return recurse(n + 1, &here[0]) + here[1] + 1;
}
static void load_fn(void *arg) {
  say("worker: loading from 0xf0000000, beyond the end of the linear memory");
  say_x("read ", *(volatile u32 *)arg);
}
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
#if MODE == 1
  say("jumping to 0x60000000, which is not mapped");
  ((void (*)(void))0x60000000ul)();
#elif MODE == 2
  say("executing an undefined instruction");
  __asm__ volatile(".inst 0x0000dead");
#elif MODE == 3
  thread_start(&t, load_fn, (void *)0xF0000000ul, stack + sizeof stack, 44, 2);
  thread_join(&t);
#elif MODE == 4
  say("recursing without end");
  say_u("depth ", recurse(0, 0));
#elif MODE == 5
  say("calling svcBreak");
  u32 result = 0x1234;
  svcBreak(0, (u64)&result, 4);
#elif MODE == 6
  say("reading through a null pointer");
  say_x("read ", *(volatile u32 *)x0);
#elif MODE == 7
  say("writing into the host area (0x1000100, the kernel's static data)");
  *(volatile u32 *)(x0 + 0x1000100) = 0x55;
#endif
  say("NOT REACHED");
  return 1;
}
