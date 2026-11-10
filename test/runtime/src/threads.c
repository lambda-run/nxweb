// (c) Threads on four cores with the SDK's synchronization. Everything printed is independent of the schedule.
#include "rt.h"
u32 mutex_slow;
#define NT 4
#define STACK 0x4000
static u8 stacks[NT][STACK] __attribute__((aligned(16)));
static Thread th[NT];
static void *stack_top(int i) { return stacks[i] + STACK; }

// ---- 0: plain computation on every core at once (no SVC inside: slices end by budget only) ----
static u64 mixed[NT];
static void mix_fn(void *arg) {
  u64 id = (u64)arg, h = 0x9E3779B97F4A7C15ul * (id + 1);
  for (u32 i = 0; i < 400000; i++) { h ^= h >> 29; h *= 0xBF58476D1CE4E5B9ul; h += i; }
  mixed[id] = h;
}

// ---- 1: a counter under a mutex, with a sleep inside the critical section so that others contend ----
static Mutex m1; static volatile u32 counter;
static void count_fn(void *arg) {
  for (int i = 0; i < 200; i++) {
    mutex_lock(&m1);
    u32 v = counter;
    if (i % 16 == (int)(u64)arg) svcSleepThread(1000);
    counter = v + 1;
    mutex_unlock(&m1);
  }
}

// ---- 2: producers and consumers on a bounded queue with two condition variables ----
#define QCAP 8
static Mutex qm; static CondVar not_empty, not_full;
static u32 q[QCAP], qhead, qcount, produced, consumed, closed;
static u64 sum_in, sum_out;
static void produce_fn(void *arg) {
  u32 id = (u32)(u64)arg;
  for (u32 i = 0; i < 100; i++) {
    u32 v = id * 1000 + i;
    mutex_lock(&qm);
    while (qcount == QCAP) cond_wait(&not_full, &qm, -1);
    q[(qhead + qcount++) % QCAP] = v; produced++; sum_in += v;
    cond_wake(&not_empty, 1);
    mutex_unlock(&qm);
  }
}
static void consume_fn(void *arg) {
  (void)arg;
  for (;;) {
    mutex_lock(&qm);
    while (qcount == 0 && !closed) cond_wait(&not_empty, &qm, -1);
    if (qcount == 0) { mutex_unlock(&qm); return; }
    u32 v = q[qhead]; qhead = (qhead + 1) % QCAP; qcount--; consumed++; sum_out += v;
    cond_wake(&not_full, 1);
    mutex_unlock(&qm);
  }
}

// ---- 3: events ----
static Handle ev_w, ev_r;
static void signal_fn(void *arg) { svcSleepThread((s64)(u64)arg); svcSignalEvent(ev_w); }

// ---- 4: sleeps end in the order of their deadlines ----
static Mutex om; static u32 order[3], norder;
static void sleep_fn(void *arg) {
  u64 id = (u64)arg;
  static const s64 ns[3] = { 3000000, 1000000, 2000000 };
  svcSleepThread(ns[id]);
  mutex_lock(&om); order[norder++] = (u32)id; mutex_unlock(&om);
}
static volatile u32 quick_done;
static void quick_fn(void *arg) { quick_done = (u32)(u64)arg; }

int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  Line l; l.n = 0;

  for (u64 i = 0; i < NT; i++) thread_start(&th[i], mix_fn, (void *)i, stack_top(i), 44, i);
  for (int i = 0; i < NT; i++) thread_join(&th[i]);
  l_s(&l, "0 compute: "); l_x(&l, mixed[0] ^ mixed[1] ^ mixed[2] ^ mixed[3]); l_out(&l);

  for (u64 i = 0; i < NT; i++) thread_start(&th[i], count_fn, (void *)i, stack_top(i), 44, i);
  for (int i = 0; i < NT; i++) thread_join(&th[i]);
  l_s(&l, "1 mutex: counter="); l_u(&l, counter); l_s(&l, " of 800, lock word="); l_x(&l, m1);
  l_s(&l, ", ArbitrateLock used: "); l_s(&l, mutex_slow ? "yes" : "no"); l_out(&l);

  for (u64 i = 0; i < 2; i++) thread_start(&th[i], produce_fn, (void *)(i + 1), stack_top(i), 44, i);
  for (u64 i = 2; i < 4; i++) thread_start(&th[i], consume_fn, 0, stack_top(i), 44, i);
  thread_join(&th[0]); thread_join(&th[1]);
  mutex_lock(&qm); closed = 1; cond_wake(&not_empty, -1); mutex_unlock(&qm);
  thread_join(&th[2]); thread_join(&th[3]);
  l_s(&l, "2 condvar: produced="); l_u(&l, produced); l_s(&l, " consumed="); l_u(&l, consumed);
  l_s(&l, " sum in="); l_u(&l, sum_in); l_s(&l, " out="); l_u(&l, sum_out); l_s(&l, " left="); l_u(&l, qcount); l_out(&l);

  Handle never_w, never_r; s32 idx = -1;
  svcCreateEvent(&ev_w, &ev_r); svcCreateEvent(&never_w, &never_r);
  u64 t0 = svcGetSystemTick();
  Result rc = svcWaitSynchronization(&idx, &ev_r, 1, 1000000);
  u64 ticks = svcGetSystemTick() - t0;
  l_s(&l, "3 event: wait 1 ms on an unsignaled event: rc="); l_x(&l, rc);
  l_s(&l, ", at least 19200 ticks passed: "); l_s(&l, ticks >= 19200 ? "yes" : "no"); l_out(&l);
  thread_start(&th[0], signal_fn, (void *)2000000, stack_top(0), 44, 2);
  Handle two[2] = { never_r, ev_r };
  rc = svcWaitSynchronization(&idx, two, 2, 1000000000);
  l_s(&l, "3 event: signaled by another thread: rc="); l_x(&l, rc); l_s(&l, " index="); l_d(&l, idx); l_out(&l);
  thread_join(&th[0]);
  l_s(&l, "3 event: ResetSignal rc="); l_x(&l, svcResetSignal(ev_r)); l_s(&l, ", again rc="); l_x(&l, svcResetSignal(ev_r));
  l_s(&l, ", poll rc="); l_x(&l, svcWaitSynchronization(&idx, &ev_r, 1, 0)); l_out(&l);

  for (u64 i = 0; i < 3; i++) thread_start(&th[i], sleep_fn, (void *)i, stack_top(i), 44, i + 1);
  for (int i = 0; i < 3; i++) thread_join(&th[i]);
  l_s(&l, "4 sleep: wake order "); for (int i = 0; i < 3; i++) { l_u(&l, order[i]); l_c(&l, ' '); }
  l_s(&l, "(sleeps of 3, 1 and 2 ms)"); l_out(&l);

  thread_start(&th[0], quick_fn, (void *)77, stack_top(0), 44, 3);
  svcSleepThread(1000000);   // it has exited by now: the wait on its handle returns at once
  rc = svcWaitSynchronization(&idx, &th[0].h, 1, 0);
  l_s(&l, "5 join: wait on an exited thread rc="); l_x(&l, rc); l_s(&l, " index="); l_d(&l, idx); l_s(&l, ", it left "); l_u(&l, quick_done); l_out(&l);
  svcCloseHandle(th[0].h);
  say("threads done");
  return 7;
}
