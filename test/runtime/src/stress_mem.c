// Robustness: the main thread resizes the heap and maps and unmaps heap pages into the stack region in a loop while
// another thread reads and writes the part of the heap that always exists.
#include "rt.h"
u32 mutex_slow;
IMPORT u32 stress_seed(void);
IMPORT u32 stress_rounds(void);
IMPORT void stress_mark(u32 round);       // the test notes the process's memory and handles
static volatile int stop; static u64 touches, bad; static u8 *heap; static u8 tstack[0x4000] __attribute__((aligned(16)));
static void toucher(void *arg) {
  u32 s = (u32)(u64)arg;
  while (!stop) {
    for (int i = 0; i < 64; i++) { s = s * 1664525u + 1013904223u; u32 off = (s >> 8) % (0x200000 - 8) & ~7u; u64 *p = (u64 *)(heap + off); if (*p != 0 && *p != (0xA5A5000000000000ull | off)) bad++; *p = 0xA5A5000000000000ull | off; touches++; }
    svcSleepThread(50000);
  }
}
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  u32 seed = stress_seed(), rounds = stress_rounds();
  void *base = 0; u64 stack_region = 0, sum = 0, maps = 0, fails = 0;
  svcGetInfo(&stack_region, 14, 0xFFFF8001u, 0);
  if (svcSetHeapSize(&base, 0x800000)) { say("SetHeapSize failed"); return 1; }
  heap = base;
  static Thread t; thread_start(&t, toucher, (void *)(u64)seed, tstack + sizeof tstack, 44, 1);
  u8 *dst = (u8 *)(stack_region + 0x4000000);
  for (u32 r = 0; r < rounds; r++) {
    seed = seed * 1103515245u + 12345u;
    u64 size = 0x400000ull * (1 + (seed >> 9) % 8);                 // 4 to 32 MB; the first 2 MB are the toucher's
    void *b2 = 0;
    if (svcSetHeapSize(&b2, size) || b2 != base) fails++;
    u64 off = 0x200000 + ((seed >> 12) % ((size - 0x210000) >> 12) << 12), n = 0x10000;
    u8 *src = heap + off;
    for (u64 i = 0; i < n; i += 512) src[i] = (u8)(r + i / 512);
    if (svcMapMemory(dst, src, n)) { fails++; continue; }
    for (u64 i = 0; i < n; i += 512) { sum = sum * 131 + dst[i] + (off >> 12) + (size >> 22); dst[i] ^= 0x5A; }   // through the mapping
    if (svcUnmapMemory(dst, src, n)) fails++;
    for (u64 i = 0; i < n; i += 512) if (src[i] != (u8)((r + i / 512) ^ 0x5A)) fails++;   // what was written through it is in the heap again
    maps++;
    if (r == rounds / 10 || r == rounds - 1) stress_mark(r);
    if ((r & 15) == 0) svcSleepThread(20000);
  }
  stop = 1; thread_join(&t);
  svcSetHeapSize(&base, 0x800000);
  Line l; l.n = 0;
  l_s(&l, "rounds "); l_u(&l, rounds); l_s(&l, ", mapped and unmapped "); l_u(&l, maps); l_s(&l, ", failures "); l_u(&l, fails); l_s(&l, ", checksum "); l_x(&l, sum);
  l_s(&l, "; the other thread: "); l_u(&l, touches); l_s(&l, " touches, "); l_u(&l, bad); l_s(&l, " wrong"); l_out(&l);
  return 0;
}
