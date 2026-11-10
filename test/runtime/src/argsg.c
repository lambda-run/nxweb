// Arguments beyond the eighth, both ways, and code the guest writes at run time (what nn::jit needs of the runtime):
//   host_twelve     a host function with twelve arguments: the last four are on this thread's stack
//   host_call13     the host calls sum13 with thirteen arguments: the last five arrive on the stack
//   host_jit_*      code memory from the host; the guest writes instructions, says so, and calls them
#include "rt.h"
u32 mutex_slow;
IMPORT u64 host_twelve(u64 a, u64 b, u64 c, u64 d, u64 e, u64 f, u64 g, u64 h, u64 i, u64 j, u64 k, u64 l);
IMPORT u64 host_call13(void *fn);
IMPORT void *host_jit_alloc(u64 size);
IMPORT void host_jit_written(void *rx, u64 offset, u64 size);
IMPORT void host_jit_free(void *rx, u64 size);
static NOINLINE u64 sum13(u64 a, u64 b, u64 c, u64 d, u64 e, u64 f, u64 g, u64 h, u64 i, u64 j, u64 k, u64 l, u64 m) {
  return a + 2 * b + 3 * c + 4 * d + 5 * e + 6 * f + 7 * g + 8 * h + 9 * i + 10 * j + 11 * k + 12 * l + 13 * m;
}
int rt_entry(u64 x0, Handle main_thread) {
  say_u("host_twelve(1..12), weighted by position = ", host_twelve(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12));
  volatile u64 canary = 0x1122334455667788ull;
  say_u("host_call13: sum13(101..113), weighted = ", host_call13(sum13));
  say_x("a local of the caller after the call with stack arguments: ", canary);
  u32 *volatile code = host_jit_alloc(0x1000);
  if (!code) { say("no code memory"); return 1; }
  for (int round = 0; round < 3; round++) {
    code[0] = 0x52800000u | (u32)(41 + round) << 5;   // mov w0, #41 + round
    code[1] = 0xd65f03c0u;                            // ret
    host_jit_written(code, 0, 8);
    say_u("generated code returns ", (u64)((int (*)(void))code)());
  }
  host_jit_free(code, 0x1000);
  u32 *volatile again = host_jit_alloc(0x1000);
  say(again == code ? "freed code memory is handed out again" : "freed code memory was not reused");
  again[0] = 0x52800000u | 7u << 5; again[1] = 0xd65f03c0u;
  host_jit_written(again, 0, 8);
  say_u("code in the reused block returns ", (u64)((int (*)(void))again)());
  return 0;
}
