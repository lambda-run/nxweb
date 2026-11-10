// Code spread over more than the translator's fixed pc map range covers: WIDE_N tiny functions, one per 64 KB of
// text (26 MB for 416), each called once through a table. Every call translates code in a 64 KB page of its own, so
// the pc map needs WIDE_N leaves; the fixed range holds 326 and the rest come from the code region (rt_runtime.ts
// leafAlloc). Stored without compression: the text is mostly padding.
#include "rt.h"
u32 mutex_slow;
#ifndef WIDE_N
#define WIDE_N 416
#endif
#define STR2(x) #x
#define STR(x) STR2(x)
__asm__(
  ".text\n"
  ".set wide_i, 0\n"
  ".rept " STR(WIDE_N) "\n"
  ".balign 0x10000\n"
  ".if wide_i == 0\n.globl wide_first\n.hidden wide_first\nwide_first:\n.endif\n"
  "add w0, w0, #(wide_i & 0xFFF)\n"
  "add w0, w0, #1\n"
  "ret\n"
  ".set wide_i, wide_i + 1\n"
  ".endr\n"
  ".balign 0x10000\n"
);
extern u32 wide_first(u32);
static NOINLINE u64 opaque(u64 p) { __asm__ volatile("" : "+r"(p)); return p; }

int rt_entry(u64 x0, Handle main_thread) {
  u32 sum = 0;
  for (int round = 0; round < 2; round++)
    for (u64 i = 0; i < WIDE_N; i++) sum = ((u32 (*)(u32))opaque((u64)wide_first + i * 0x10000))(sum);
  say_u("functions: ", WIDE_N);
  say_u("sum: ", sum);
  return 11;
}
