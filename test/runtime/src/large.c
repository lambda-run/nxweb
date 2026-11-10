// A module far larger than the fixed file staging range: 40 MB of read-only data and 24 MB of data that the test
// fills after the build (test/runtime/large_nso.ts: the read-only data with noise, stored as it is; the data with a
// pattern, LZ4 compressed), and 8 MB of bss. It checks every byte of both through a 32-bit FNV over their words, that
// the bss is zero, and that the heap region, where the runtime staged the file while loading, reads zero.
#include "rt.h"
u32 mutex_slow;
#ifndef RO_MB
#define RO_MB 40
#endif
#ifndef DATA_MB
#define DATA_MB 24
#endif
#ifndef BSS_MB
#define BSS_MB 8
#endif
#ifndef HEAP_MB
#define HEAP_MB 96
#endif
#define MB (1ul << 20)
const u8 large_ro[RO_MB * MB] = "LARGE-RO-PAD-0001";
u8 large_data[DATA_MB * MB] = "LARGE-DATA-PAD-01";
u8 large_bss[BSS_MB * MB];

// the compiler knows what the arrays hold at build time: it must not use that
static NOINLINE const u32 *opaque(const void *p) { __asm__ volatile("" : "+r"(p)); return p; }
static NOINLINE u32 fnv(const void *p, u64 bytes) {
  const u32 *w = opaque(p);
  u32 h = 2166136261u;
  for (u64 i = 0, n = bytes / 4; i < n; i++) h = (h ^ w[i]) * 16777619u;
  return h;
}
static NOINLINE u64 nonzero(const void *p, u64 bytes) {
  const u64 *w = (const u64 *)opaque(p);
  u64 c = 0;
  for (u64 i = 0, n = bytes / 8; i < n; i++) if (w[i]) c++;
  return c;
}

int rt_entry(u64 x0, Handle main_thread) {
  say_x("ro: ", fnv(large_ro, sizeof large_ro));
  say_x("data: ", fnv(large_data, sizeof large_data));
  say_u("bss words not zero: ", nonzero(large_bss, sizeof large_bss));
  large_data[sizeof large_data - 1] ^= 0x5A; large_bss[sizeof large_bss - 1] = 1;
  say_u("data and bss are written: ", ((u8 *)opaque(large_data))[sizeof large_data - 1] != 0 && nonzero(large_bss, sizeof large_bss) == 1);
  void *base = 0;
  Result rc = svcSetHeapSize(&base, HEAP_MB * MB);
  say_x("SetHeapSize: rc=", rc);
  say_u("heap words not zero: ", rc ? ~0ul : nonzero(base, HEAP_MB * MB));
  return 9;
}
