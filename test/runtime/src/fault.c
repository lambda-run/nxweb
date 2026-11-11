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
// FAR: the address the worker loads from (a process placed above 4 GB in a 64-bit memory has memory at 0xF000_0000)
#ifndef FAR
#define FAR 0xF0000000ul
#define FAR_S "0xf0000000"
#endif
static void load_fn(void *arg) {
  say("worker: loading from " FAR_S ", beyond the end of the linear memory");
  say_x("read ", *(volatile u32 *)arg);
}
// exported (in the dynamic symbol table) so the fault report can name them: the fault's pc is in read_word, x30 in
// read_through (the volatile keeps the call from becoming a tail call)
EXPORT NOINLINE u32 read_word(u64 p) { return *(volatile u32 *)p; }
EXPORT NOINLINE u32 read_through(u64 p) { volatile u32 v = read_word(p); return v; }
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
#if MODE == 1
  say("jumping to 0x60000000, which is not mapped");
  ((void (*)(void))0x60000000ul)();
#elif MODE == 2
  say("executing an undefined instruction");
  __asm__ volatile(".inst 0x0000dead");
#elif MODE == 3
  thread_start(&t, load_fn, (void *)FAR, stack + sizeof stack, 44, 2);
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
  say_x("read ", read_through(x0));
#elif MODE == 7
  say("writing into the host area (0x1000100, the kernel's static data)");
  *(volatile u32 *)(x0 + 0x1000100) = 0x55;
#endif
  say("NOT REACHED");
  return 1;
}
