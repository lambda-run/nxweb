// Robustness: 63 threads beside the main one contend on four mutexes and two condition variables with timeouts,
// sleep, and exit; the main thread joins each wave and starts the next until stress_ms() of guest time have passed.
// Everything that happens is folded into checksums: the same seed must print the same lines.
#include "rt.h"
u32 mutex_slow;
IMPORT u32 stress_seed(void);
IMPORT u32 stress_ms(void);
#define NT 63
static Mutex locks[4]; static CondVar conds[2];
static u64 counter[4], sum, wakes, timeouts, signals;
static u8 stacks[NT][0x4000] __attribute__((aligned(16)));
static Thread th[NT]; static u32 seeds[NT];
static u32 next(u32 *s) { *s = *s * 1664525u + 1013904223u; return *s >> 8; }
static void worker(void *arg) {
  u32 id = (u32)(u64)arg, *s = &seeds[id];
  int rounds = 6 + next(s) % 10;
  for (int i = 0; i < rounds; i++) {
    u32 r = next(s), k = r & 3;
    mutex_lock(&locks[k]);
    counter[k] += id + 1;
    if ((r >> 2) % 5 == 0) {                         // wait for a signal, at most 1 to 4 ms
      Result rc = cond_wait(&conds[k & 1], &locks[k], 1000000ll * (1 + (r >> 5) % 4));
      if (rc == R_TIMEOUT) timeouts++; else wakes++;
    }
    sum = sum * 31 + counter[k] + id;
    mutex_unlock(&locks[k]);
    if ((r >> 8) % 3 == 0) { cond_wake(&conds[(r >> 10) & 1], 1 + (r >> 11) % 3); signals++; }   // unsynchronized on purpose: the scheduler is deterministic
    svcSleepThread(100000ll * (1 + (r >> 13) % 30));
  }
}
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  u32 seed = stress_seed(), waves = 0;
  u64 t0 = svcGetSystemTick(), limit = (u64)stress_ms() * 19200;
  while (svcGetSystemTick() - t0 < limit) {
    for (u32 i = 0; i < NT; i++) { seeds[i] = seed = seed * 1103515245u + 12345u + i; thread_start(&th[i], worker, (void *)(u64)i, stacks[i] + sizeof stacks[i], 44 + (int)(i % 3), (int)(i % 4)); }
    for (u32 i = 0; i < NT; i++) thread_join(&th[i]);
    waves++;
  }
  Line l; l.n = 0;
  l_s(&l, "waves "); l_u(&l, waves); l_s(&l, ", threads "); l_u(&l, waves * NT); l_s(&l, ", counters "); for (int k = 0; k < 4; k++) { l_u(&l, counter[k]); l_c(&l, ' '); }
  l_s(&l, "checksum "); l_x(&l, sum); l_out(&l);
  l_s(&l, "condition waits: "); l_u(&l, wakes); l_s(&l, " woken, "); l_u(&l, timeouts); l_s(&l, " timed out; "); l_u(&l, signals); l_s(&l, " signals; lock words ");
  for (int k = 0; k < 4; k++) { l_x(&l, locks[k]); l_c(&l, ' '); } l_s(&l, "; guest ms "); l_u(&l, (svcGetSystemTick() - t0) / 19200); l_out(&l);
  return 0;
}
