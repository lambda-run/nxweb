// EXPERIMENTAL (spike, SPIKE.md). Eight guest threads on four cores; everything printed is independent of the
// schedule, so green threads and any number of Workers must print the same text.
#include "rt.h"
u32 mutex_slow;
Result svcSetThreadActivity(Handle h, int activity);
Result svcGetThreadContext3(void *ctx, Handle h);
#define NT 8
#define STACK 0x4000
#ifndef ITER_A
#define ITER_A 100000
#endif
#ifndef ITER_M
#define ITER_M 2500
#endif
static u8 stacks[NT][STACK] __attribute__((aligned(16)));
static Thread th[NT];
static void *stack_top(int i) { return stacks[i] + STACK; }
static void start_all(void (*fn)(void *)) { for (u64 i = 0; i < NT; i++) thread_start(&th[i], fn, (void *)i, stack_top(i), 44, i % 4); }
static void join_all(void) { for (int i = 0; i < NT; i++) thread_join(&th[i]); }

// ---- 1: atomic increments: ldxr/stxr loops on a 64-bit and a 32-bit word next to each other ----
static struct { u64 a64; u32 a32; u32 pad; } at;
static void atom_fn(void *arg) {
  for (u32 i = 0; i < ITER_A; i++) { __atomic_fetch_add(&at.a64, 1, __ATOMIC_SEQ_CST); __atomic_fetch_add(&at.a32, 3, __ATOMIC_SEQ_CST); }
}
// ---- 2: plain increments under the SDK mutex (user-mode fast path, ArbitrateLock / ArbitrateUnlock on contention) ----
static Mutex m2; static volatile u64 mcount; static volatile u32 inside;
static u32 overlaps;
static void mutex_fn(void *arg) {
  for (u32 i = 0; i < ITER_M; i++) {
    mutex_lock(&m2);
    if (inside) overlaps++;
    inside = 1;
    u64 v = mcount;
    for (volatile u32 k = 0; k < ((i + (u32)(u64)arg) & 7); k++) { }
    mcount = v + 1;
    inside = 0;
    mutex_unlock(&m2);
  }
}
// ---- 3: an instruction that goes through the translator's helper module (FRECPE, table-driven) on every core ----
static NOINLINE u64 recpe_sum(u64 seed) {
  u64 h = seed;
  float in[4], out[4];
  for (u32 i = 0; i < 20000; i++) {
    for (int k = 0; k < 4; k++) in[k] = 1.0f + (float)((i * 4 + k) % 977) * 0.37f + (float)seed;
    __asm__ volatile("ldr q0, [%0]\n frecpe v1.4s, v0.4s\n str q1, [%1]" : : "r"(in), "r"(out) : "v0", "v1", "memory");
    for (int k = 0; k < 4; k++) { u32 b; __builtin_memcpy(&b, &out[k], 4); h = (h ^ b) * 0x9E3779B97F4A7C15ul; h ^= h >> 29; }
  }
  return h;
}
static u64 recpe_ref[NT], recpe_got[NT];
static void recpe_fn(void *arg) { u64 id = (u64)arg; recpe_got[id] = recpe_sum(id); }
// ---- 4: SetThreadActivity / GetThreadContext3 on a thread that computes on another core without any SVC ----
static volatile u64 spin_count; static volatile u32 spin_stop;
static void spin_fn(void *arg) { while (!spin_stop) spin_count++; }
static u64 tctx[0x320 / 8];
// ---- 5: the memory grows (SetHeapSize) while other cores run; a thread on another core then uses the new part ----
static char *heap_top_text;
static void heap_fn(void *arg) {
  static const char msg[] = "5 heap: a thread on core 2 wrote this at the top of a 64 MB heap\n";
  for (u32 i = 0; i < sizeof msg - 1; i++) heap_top_text[i] = msg[i];
  svcOutputDebugString(heap_top_text, sizeof msg - 1);
}
static volatile u64 churn;
static void churn_fn(void *arg) { for (u32 i = 0; i < 300000; i++) churn += i; }

int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  Line l; l.n = 0;

  start_all(atom_fn); join_all();
  l_s(&l, "1 atomics: a64="); l_u(&l, at.a64); l_s(&l, " of "); l_u(&l, (u64)NT * ITER_A);
  l_s(&l, ", a32="); l_u(&l, at.a32); l_s(&l, " of "); l_u(&l, (u32)(3u * NT * ITER_A)); l_out(&l);

  start_all(mutex_fn); join_all();
  l_s(&l, "2 mutex: count="); l_u(&l, mcount); l_s(&l, " of "); l_u(&l, (u64)NT * ITER_M);
  l_s(&l, ", overlaps="); l_u(&l, overlaps); l_s(&l, ", lock word="); l_x(&l, m2); l_out(&l);

  for (u64 i = 0; i < NT; i++) recpe_ref[i] = recpe_sum(i);
  start_all(recpe_fn); join_all();
  u32 same = 0; for (int i = 0; i < NT; i++) same += recpe_ref[i] == recpe_got[i];
  l_s(&l, "3 helpers: "); l_u(&l, same); l_s(&l, " of 8 threads got the single-thread result"); l_out(&l);

  thread_start(&th[0], spin_fn, 0, stack_top(0), 44, 1);
  u32 frozen = 0, moved = 0, ctxok = 0;
  for (int r = 0; r < 20; r++) {
    svcSleepThread(100000);
    Result rc = svcSetThreadActivity(th[0].h, 1);
    u64 a = spin_count;
    for (volatile u32 k = 0; k < 20000; k++) { }
    u64 b = spin_count;
    Result rc2 = svcGetThreadContext3(tctx, th[0].h);
    if (rc == 0 && a == b) frozen++;
    if (rc2 == 0 && tctx[0x100 / 8] >= 0x08000000ul && tctx[0x100 / 8] < (u64)(void *)stacks && tctx[0xF8 / 8] > (u64)(void *)stacks[0] && tctx[0xF8 / 8] <= (u64)stack_top(0)) ctxok++;
    svcSetThreadActivity(th[0].h, 0);
    for (int w = 0; w < 2000 && spin_count == b; w++) svcSleepThread(100000);   // however long its core takes to pick it up
    if (spin_count > b) moved++;
  }
  spin_stop = 1; thread_join(&th[0]);
  l_s(&l, "4 pause: counter stood still "); l_u(&l, frozen); l_s(&l, " of 20, context plausible "); l_u(&l, ctxok);
  l_s(&l, " of 20, ran on after resume "); l_u(&l, moved); l_s(&l, " of 20"); l_out(&l);

  for (u64 i = 1; i < 4; i++) thread_start(&th[i], churn_fn, 0, stack_top(i), 44, i);
  void *heap = 0;
  Result rc = svcSetHeapSize(&heap, 64ul << 20);
  heap_top_text = (char *)heap + (64ul << 20) - 128;
  thread_start(&th[4], heap_fn, 0, stack_top(4), 44, 2);
  for (int i = 1; i < 5; i++) thread_join(&th[i]);
  l_s(&l, "5 heap: SetHeapSize rc="); l_x(&l, rc); l_s(&l, ", first byte of the text there: "); l_c(&l, heap_top_text[0]); l_out(&l);
  say("stress done");
  return 9;
}
