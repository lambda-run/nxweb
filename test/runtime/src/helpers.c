// Guests for the helper Workers (RuntimeOptions.helpers; test/runtime/helpers.mts), one per build (-DMODE=n).
// Everything printed is independent of the schedule and of where a thread ran.
#include "rt.h"
u32 mutex_slow;
#define STACK 0x4000
static u8 stacks[4][STACK] __attribute__((aligned(16)));
static Thread th[4];
static void *stack_top(int i) { return stacks[i] + STACK; }
#define K 0xBF58476D1CE4E5B9ul
static NOINLINE u64 mix(u64 h, u32 n) { for (u32 i = 0; i < n; i++) { h ^= h >> 29; h *= K; h += i; } return h; }

#if MODE == 0
// four threads that only compute, one on each core
#ifndef ITER
#define ITER 100000000u
#endif
static u64 out[4];
static void fn(void *arg) { u64 id = (u64)arg; out[id] = mix(0x9E3779B97F4A7C15ul * (id + 1), ITER); }
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  for (u64 i = 0; i < 4; i++) thread_start(&th[i], fn, (void *)i, stack_top(i), 44, i);
  for (int i = 0; i < 4; i++) thread_join(&th[i]);
  Line l; l.n = 0;
  for (int i = 0; i < 4; i++) { l_s(&l, "compute "); l_u(&l, i); l_s(&l, ": "); l_x(&l, out[i]); l_out(&l); }
  say("compute done");
  return 0;
}

#elif MODE == 1
// a thread that computes between hand-overs (it goes out) and one that only locks, signals and waits (it stays)
#define ROUNDS 400
static Mutex m; static CondVar cv; static volatile u32 turn; static u32 ping, pong; static u64 acc;
static void heavy_fn(void *arg) {
  u64 h = 1;
  for (u32 r = 0; r < ROUNDS; r++) {
    h = mix(h, 60000);
    mutex_lock(&m);
    while (turn != 0) cond_wait(&cv, &m, -1);
    acc += h & 0xFF; turn = 1; pong++;
    cond_wake(&cv, -1);
    mutex_unlock(&m);
  }
}
static void light_fn(void *arg) {
  for (u32 r = 0; r < ROUNDS; r++) {
    mutex_lock(&m);
    while (turn != 1) cond_wait(&cv, &m, -1);
    acc = acc * 31 + r; turn = 0; ping++;
    cond_wake(&cv, -1);
    mutex_unlock(&m);
  }
}
// both take one lock around a counter: the user-mode fast path of one runs beside the kernel's hand-over to the other
#define LOCKS 20000
static Mutex cm; static volatile u32 counter;
static void heavy_count(void *arg) { u64 h = 7; for (u32 i = 0; i < LOCKS; i++) { h = mix(h, 300); mutex_lock(&cm); u32 v = counter; h = mix(h, 8); counter = v + 1; mutex_unlock(&cm); } }
static void light_count(void *arg) { for (u32 i = 0; i < LOCKS; i++) { mutex_lock(&cm); u32 v = counter; counter = v + 1; mutex_unlock(&cm); if (i % 4 == 0) svcSleepThread(0); } }
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  thread_start(&th[0], heavy_fn, 0, stack_top(0), 44, 1);
  thread_start(&th[1], light_fn, 0, stack_top(1), 44, 2);
  thread_join(&th[0]); thread_join(&th[1]);
  Line l; l.n = 0;
  l_s(&l, "ping-pong: ping="); l_u(&l, ping); l_s(&l, " pong="); l_u(&l, pong); l_s(&l, " acc="); l_x(&l, acc); l_out(&l);
  thread_start(&th[0], heavy_count, 0, stack_top(0), 44, 1);
  thread_start(&th[1], light_count, 0, stack_top(1), 44, 2);
  thread_join(&th[0]); thread_join(&th[1]);
  l_s(&l, "counter="); l_u(&l, counter); l_s(&l, " of "); l_u(&l, 2 * LOCKS); l_s(&l, ", lock word="); l_x(&l, cm); l_out(&l);
  say("ping done");
  return 0;
}

#elif MODE == 2
// code that is first reached while a thread is out: by that thread (the helper has no unit for it), and by the main
// thread (translated here while the helper runs; the helper meets it later)
#define F(n) static NOINLINE u64 fa##n(u64 x) { return mix(x + n, 40 + n); } static NOINLINE u64 fb##n(u64 x) { return mix(x ^ n, 30 + n) * (2 * n + 3); }
F(0) F(1) F(2) F(3) F(4) F(5) F(6) F(7) F(8) F(9) F(10) F(11) F(12) F(13) F(14) F(15)
#define P(n) fa##n,
#define Q(n) fb##n,
#define ALL(X) X(0) X(1) X(2) X(3) X(4) X(5) X(6) X(7) X(8) X(9) X(10) X(11) X(12) X(13) X(14) X(15)
static u64 (*volatile ta[16])(u64) = { ALL(P) };
static u64 (*volatile tb[16])(u64) = { ALL(Q) };
static u64 res_a;
static volatile u32 stage;
static void fn(void *arg) {
  u64 h = mix(3, 6000000);
  for (int i = 0; i < 16; i++) { h = ta[i](h); h = mix(h, 200000); }   // never run before: the helper asks for each
  static volatile u64 w; while (stage < 1) w = mix(w, 50000);                                  // until the main thread has run all of tb
  u64 g = 5;
  for (int i = 0; i < 16; i++) g = tb[i](g);                             // translated by the main thread meanwhile
  res_a = mix(h, 1000) ^ g;
}
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  thread_start(&th[0], fn, 0, stack_top(0), 44, 1);
  svcSleepThread(3000000);
  u64 g = 5;
  for (int i = 0; i < 16; i++) { g = tb[i](g); svcSleepThread(200000); }
  stage = 1;
  thread_join(&th[0]);
  Line l; l.n = 0;
  l_s(&l, "units: main "); l_x(&l, g); l_s(&l, " thread "); l_x(&l, res_a); l_out(&l);
  say("units done");
  return 0;
}

#elif MODE == 3
// a thread computes (it goes out), then stores through a null pointer
EXPORT NOINLINE void poke(u64 p, u64 v) { *(volatile u32 *)p = (u32)v; }
static void fn(void *arg) { u64 h = mix(11, 5000000); poke((u64)arg, h); say("not reached"); }
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  say("a worker computes, then stores through a null pointer");
  thread_start(&th[0], fn, (void *)0x10, stack_top(0), 44, 1);
  thread_join(&th[0]);
  return 0;
}

#elif MODE == 5
// three compute threads that queue on one core (they take turns: the one that is out is asked back), then a thread
// that is paused and resumed while it computes
static u64 out[3];
static void fn(void *arg) { u64 id = (u64)arg; out[id] = mix(0x9E3779B97F4A7C15ul * (id + 1), 12000000u); }
static volatile u32 prog; static u64 res;
static void steps(void *arg) { u64 h = 1; for (u32 r = 0; r < 300; r++) { h = mix(h, 100000); prog = r + 1; } res = h; }
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  for (u64 i = 0; i < 3; i++) thread_start(&th[i], fn, (void *)i, stack_top(i), 44, 1);
  for (int i = 0; i < 3; i++) thread_join(&th[i]);
  Line l; l.n = 0;
  l_s(&l, "one core: "); l_x(&l, out[0]); l_c(&l, ' '); l_x(&l, out[1]); l_c(&l, ' '); l_x(&l, out[2]); l_out(&l);
  thread_start(&th[0], steps, 0, stack_top(0), 44, 2);
  while (prog < 20) svcSleepThread(200000);
  Result rc = svcSetThreadActivity(th[0].h, 1);
  u32 p1 = prog; svcSleepThread(5000000); u32 p2 = prog;
  l_s(&l, "pause: rc="); l_x(&l, rc); l_s(&l, ", progress while paused: "); l_s(&l, p1 == p2 ? "none" : "SOME"); l_s(&l, ", before the end: "); l_s(&l, p2 < 300 ? "yes" : "no"); l_out(&l);
  rc = svcSetThreadActivity(th[0].h, 0);
  thread_join(&th[0]);
  l_s(&l, "resume: rc="); l_x(&l, rc); l_s(&l, " steps="); l_u(&l, prog); l_s(&l, " result="); l_x(&l, res); l_out(&l);
  say("sched done");
  return 0;
}

#elif MODE == 6
// a thread that computes and reads the system counter (mrs cntpct_el0): the reads never step back, and they agree
// with GetSystemTick before and after
static inline u64 counter_now(void) { u64 v; __asm__ volatile("mrs %0, cntpct_el0" : "=r"(v)); return v; }
static u32 back, reads; static u64 first, last, svc0, svc1, sum;
static void fn(void *arg) {
  u64 h = mix(1, 3000000), prev = 0;
  svc0 = svcGetSystemTick();
  for (u32 r = 0; r < 3000; r++) {
    h = mix(h, 20000);
    u64 t = counter_now();
    if (r == 0) first = t;
    if (t < prev) back++;
    prev = t; reads++;
  }
  last = prev; sum = h;
  svc1 = svcGetSystemTick();
}
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  thread_start(&th[0], fn, 0, stack_top(0), 44, 1);
  thread_join(&th[0]);
  Line l; l.n = 0;
  l_s(&l, "counter: "); l_u(&l, reads); l_s(&l, " reads, steps back: "); l_u(&l, back);
  l_s(&l, ", between the two GetSystemTick: "); l_s(&l, first >= svc0 && last <= svc1 ? "yes" : "NO");
  l_s(&l, ", moved: "); l_s(&l, last > first ? "yes" : "NO"); l_s(&l, ", result "); l_x(&l, sum); l_out(&l);
  say("clock done");
  return 0;
}

#else
// a thread that computes without end; the main thread sleeps
static volatile u64 sink;
static void fn(void *arg) { u64 h = 1; for (;;) { h = mix(h, 100000); sink = h; } }
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  thread_start(&th[0], fn, 0, stack_top(0), 44, 1);
  say("spinning");
  for (;;) svcSleepThread(1000000);
  return 0;
}
#endif
