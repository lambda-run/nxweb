// A process with more than 4 GB: what a Switch 2 title does at start (SetHeapSize of 6.2 GB in one call), then a
// pattern written and read back at the bottom, in the middle and at the top of the heap and in a mapping at the top
// of the alias region, and QueryMemory over what was made. Only for a 64-bit memory with a layout made for a 9 GB
// pool (test: "a 9 GB pool"). It touches a handful of pages: the machine need not have the memory.
#include "rt.h"
u32 mutex_slow;

#define CUR 0xFFFF8001u
#define HEAP 0x18ce00000ul
static NOINLINE Result map_physical(u64 addr, u64 size, int unmap) {
  register u64 x0 __asm__("x0") = addr; register u64 x1 __asm__("x1") = size;
  if (unmap) __asm__ volatile("svc 0x2D" : "+r"(x0) : "r"(x1) : "x2", "x3", "x4", "x5", "x6", "x7", "memory");
  else __asm__ volatile("svc 0x2C" : "+r"(x0) : "r"(x1) : "x2", "x3", "x4", "x5", "x6", "x7", "memory");
  return (Result)x0;
}
// 512 words that depend on their own address: a page read back through a truncated address does not match
static void fill(u64 *p) { for (u64 k = 0; k < 512; k++) p[k] = ((u64)(p + k) * 0x9E3779B97F4A7C15ul) ^ k; }
static u32 wrong(const u64 *p) { u32 n = 0; for (u64 k = 0; k < 512; k++) if (p[k] != (((u64)(p + k) * 0x9E3779B97F4A7C15ul) ^ k)) n++; return n; }
static void seg(Line *l, const char *what, u64 addr) {
  MemoryInfo mi; u32 pi;
  Result rc = svcQueryMemory(&mi, &pi, addr);
  l_s(l, what); l_s(l, ": rc="); l_x(l, rc); l_s(l, " "); l_x(l, mi.addr); l_s(l, " + "); l_x(l, mi.size); l_s(l, " state="); l_x(l, mi.type & 0xFF); l_s(l, " perm="); l_x(l, mi.perm); l_out(l);
}

int rt_entry(u64 x0, Handle main_thread) {
  Line l; l.n = 0;
  u64 ab = 0, as = 0, hb = 0, hs = 0, pool = 0;
  svcGetInfo(&ab, 2, CUR, 0); svcGetInfo(&as, 3, CUR, 0); svcGetInfo(&hb, 4, CUR, 0); svcGetInfo(&hs, 5, CUR, 0); svcGetInfo(&pool, 6, CUR, 0);
  l_s(&l, "heap region "); l_x(&l, hb); l_s(&l, " + "); l_x(&l, hs); l_s(&l, ", alias region "); l_x(&l, ab); l_s(&l, " + "); l_x(&l, as); l_s(&l, ", pool "); l_x(&l, pool); l_out(&l);

  void *base = 0;
  Result rc = svcSetHeapSize(&base, HEAP);
  l_s(&l, "SetHeapSize(0x18ce00000): rc="); l_x(&l, rc); l_s(&l, " base="); l_x(&l, (u64)base); l_out(&l);
  if (rc) return 1;
  u64 off[3] = { 0, (HEAP / 2) & ~0xFFFul, HEAP - 0x1000 };
  const char *name[3] = { "bottom", "middle", "top" };
  for (int i = 0; i < 3; i++) fill((u64 *)((u8 *)base + off[i]));
  for (int i = 0; i < 3; i++) {
    u64 *p = (u64 *)((u8 *)base + off[i]);
    l_s(&l, "heap "); l_s(&l, name[i]); l_s(&l, " (+"); l_x(&l, off[i]); l_s(&l, "): "); l_u(&l, wrong(p)); l_s(&l, " of 512 words wrong");
    // the same offset 4 GB lower is heap as well and was never written
    if (off[i] >= 0x100000000ul) { l_s(&l, "; 4 GB lower reads "); l_x(&l, p[-(0x100000000l / 8)]); }
    l_out(&l);
  }
  seg(&l, "the heap's last byte", (u64)base + HEAP - 1);

  u64 m = ab + as - 0x4000000;
  rc = map_physical(m, 0x4000, 0);
  l_s(&l, "MapPhysicalMemory at the alias region's end - 64 MB (above 8 GB: "); l_s(&l, m > 0x200000000ul ? "yes" : "no"); l_s(&l, "): rc="); l_x(&l, rc); l_out(&l);
  if (rc) return 2;
  for (int i = 0; i < 4; i++) fill((u64 *)(m + 0x1000 * i));
  u32 bad = 0; for (int i = 0; i < 4; i++) bad += wrong((u64 *)(m + 0x1000 * i));
  l_s(&l, "alias mapping: "); l_u(&l, bad); l_s(&l, " of 2048 words wrong; 4 GB lower reads "); l_x(&l, *(u64 *)(m - 0x100000000ul)); l_out(&l);
  seg(&l, "the mapping", m + 0x1000);
  seg(&l, "below it", m - 0x1000);
  rc = map_physical(m, 0x4000, 1);
  l_s(&l, "UnmapPhysicalMemory: rc="); l_x(&l, rc); l_out(&l);

  rc = svcSetHeapSize(&base, HEAP + 0x200000000ul);
  l_s(&l, "SetHeapSize(6.2 GB + 8 GB): rc="); l_x(&l, rc); l_out(&l);
  rc = svcSetHeapSize(&base, 0x200000);
  l_s(&l, "SetHeapSize(2 MB): rc="); l_x(&l, rc); l_out(&l);
  return 0;
}
