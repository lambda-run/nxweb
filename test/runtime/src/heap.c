// (d) SetHeapSize, a simple allocator on the heap, and a QueryMemory walk over the whole address space.
#include "rt.h"
u32 mutex_slow;

// first fit, split, and merge with the next block on free
typedef struct Block { u64 size; u64 used; } Block;   // size includes the header
static u8 *heap_lo, *heap_hi;
static void heap_init(void *base, u64 size) { heap_lo = base; heap_hi = heap_lo + size; Block *b = base; b->size = size; b->used = 0; }
static void *alloc(u64 n) {
  n = ((n + 15) & ~15ul) + sizeof(Block);
  for (u8 *p = heap_lo; p < heap_hi; p += ((Block *)p)->size) {
    Block *b = (Block *)p;
    if (!b->used) {
      while (p + b->size < heap_hi && !((Block *)(p + b->size))->used) b->size += ((Block *)(p + b->size))->size;
      if (b->size >= n) {
        if (b->size - n >= 2 * sizeof(Block)) { Block *r = (Block *)(p + n); r->size = b->size - n; r->used = 0; b->size = n; }
        b->used = 1;
        return b + 1;
      }
    }
  }
  return 0;
}
static void release(void *p) { ((Block *)p - 1)->used = 0; }

static u32 rng = 12345;
static u32 next(void) { rng = rng * 1664525u + 1013904223u; return rng >> 8; }

int rt_entry(u64 x0, Handle main_thread) {
  Line l; l.n = 0;
  void *base = 0;
  Result rc = svcSetHeapSize(&base, 0x400000);
  l_s(&l, "SetHeapSize(4 MB): rc="); l_x(&l, rc); l_s(&l, " base="); l_x(&l, (u64)base); l_out(&l);
  heap_init(base, 0x400000);

  enum { N = 200 };
  static u8 *ptr[N]; static u32 len[N];
  u32 bad = 0, failed = 0;
  for (int round = 0; round < 3; round++) {
    for (int i = 0; i < N; i++) {
      if (ptr[i]) continue;
      len[i] = 16 + next() % 6000;
      ptr[i] = alloc(len[i]);
      if (!ptr[i]) { failed++; continue; }
      for (u32 k = 0; k < len[i]; k++) ptr[i][k] = (u8)(i * 7 + k);
    }
    for (int i = 0; i < N; i++) {
      if (!ptr[i]) continue;
      for (u32 k = 0; k < len[i]; k++) if (ptr[i][k] != (u8)(i * 7 + k)) { bad++; break; }
      if ((i + round) % 2 == 0) { release(ptr[i]); ptr[i] = 0; }
    }
  }
  u64 used = 0; u32 blocks = 0;
  for (u8 *p = heap_lo; p < heap_hi; p += ((Block *)p)->size) { blocks++; if (((Block *)p)->used) used += ((Block *)p)->size; }
  l_s(&l, "allocator: 3 rounds of 200 blocks, corrupted="); l_u(&l, bad); l_s(&l, " failed="); l_u(&l, failed);
  l_s(&l, " blocks="); l_u(&l, blocks); l_s(&l, " bytes in use="); l_u(&l, used); l_out(&l);

  void *base2 = 0;
  rc = svcSetHeapSize(&base2, 0x800000);
  ((u8 *)base2)[0x7FFFFF] = 0x5A;
  l_s(&l, "SetHeapSize(8 MB): rc="); l_x(&l, rc); l_s(&l, " same base: "); l_s(&l, base2 == base ? "yes" : "no");
  l_s(&l, ", first allocation intact: "); l_s(&l, ((Block *)base)->size ? "yes" : "no"); l_out(&l);

  u64 lo = 0, span = 0;
  svcGetInfo(&lo, 12, 0xFFFF8001, 0); svcGetInfo(&span, 13, 0xFFFF8001, 0);
  l_s(&l, "address space "); l_x(&l, lo); l_s(&l, " + "); l_x(&l, span); l_out(&l);
  u64 addr = lo; u32 n = 0, gaps = 0;
  while (addr < lo + span && n < 64) {
    MemoryInfo mi; u32 pi;
    rc = svcQueryMemory(&mi, &pi, addr);
    if (rc || mi.addr != addr || !mi.size) { gaps++; break; }
    l_s(&l, "  "); l_x(&l, mi.addr); l_s(&l, " + "); l_x(&l, mi.size); l_s(&l, " state="); l_x(&l, mi.type);
    l_s(&l, " perm="); l_c(&l, mi.perm & 1 ? 'r' : '-'); l_c(&l, mi.perm & 2 ? 'w' : '-'); l_c(&l, mi.perm & 4 ? 'x' : '-'); l_out(&l);
    addr += mi.size; n++;
  }
  l_s(&l, "walk: "); l_u(&l, n); l_s(&l, " segments, contiguous and complete: "); l_s(&l, !gaps && addr == lo + span ? "yes" : "no"); l_out(&l);
  svcExitProcess(0);
}
