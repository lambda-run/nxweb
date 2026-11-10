// EXPERIMENTAL (spike, SPIKE.md). Compute-heavy guest for the speed measurement: NT threads, thread i on core i % 4.
//   WORK 1: SHA-256 of a private 64 KB buffer, chained        WORK 2: an LZ77 compressor over a private 64 KB buffer
//   WORK 3: contention: a short private computation, then a shared structure under ONE SDK mutex and a shared atomic counter
//   WORK 4: SVC-heavy: every thread signals and waits its own event in a loop (the kernel lock is the shared thing)
//   WORK 5: ping-pong (NT 2): a token goes back and forth between two cores through two events (two wakes per round)
#include "rt.h"
u32 mutex_slow;
#ifndef NT
#define NT 4
#endif
#ifndef WORK
#define WORK 1
#endif
#ifndef ROUNDS
#define ROUNDS 40
#endif
#define STACK 0x8000
static u8 stacks[NT][STACK] __attribute__((aligned(16)));
static Thread th[NT];
#define BUF 65536
static u8 data[NT][BUF];
static u64 result[NT];
static inline u64 rng(u64 *s) { u64 x = *s; x ^= x >> 12; x ^= x << 25; x ^= x >> 27; *s = x; return x * 0x2545F4914F6CDD1Dul; }

// ---- SHA-256 (the block function of test/guests/src/mixed_sha256.c) ----
static const u32 K[64] = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2 };
static inline u32 rotr(u32 x, unsigned n) { return (x >> n) | (x << (32 - n)); }
static NOINLINE void sha256_block(u32 *hh, const u8 *p) {
  u32 w[64];
  for (int i = 0; i < 16; i++) w[i] = (u32)p[4 * i] << 24 | (u32)p[4 * i + 1] << 16 | (u32)p[4 * i + 2] << 8 | p[4 * i + 3];
  for (int i = 16; i < 64; i++) {
    u32 s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  u32 a = hh[0], b = hh[1], c = hh[2], d = hh[3], e = hh[4], f = hh[5], g = hh[6], h = hh[7];
  for (int i = 0; i < 64; i++) {
    u32 t1 = h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
    u32 t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
    h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
  }
  hh[0] += a; hh[1] += b; hh[2] += c; hh[3] += d; hh[4] += e; hh[5] += f; hh[6] += g; hh[7] += h;
}
static u64 sha_work(u8 *buf, u32 rounds) {
  u32 h[8] = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 };
  for (u32 r = 0; r < rounds; r++) {
    for (u32 o = 0; o < BUF; o += 64) sha256_block(h, buf + o);
    for (int i = 0; i < 8; i++) { buf[4 * i] ^= (u8)h[i]; buf[4 * i + 1] ^= (u8)(h[i] >> 8); }   // the next round hashes something else
  }
  return ((u64)h[0] << 32 | h[1]) ^ ((u64)h[2] << 32 | h[3]);
}

// ---- LZ77: hash of 4 bytes -> last position, greedy matches, byte-oriented output ----
#define HBITS 13
static u32 heads[NT][1 << HBITS];
static u8 packed[NT][BUF + BUF / 8 + 64];
static NOINLINE u32 lz_compress(const u8 *src, u32 n, u8 *dst, u32 *head) {
  for (u32 i = 0; i < (1u << HBITS); i++) head[i] = 0xFFFFFFFFu;
  u32 o = 0, i = 0, lit = 0;
  while (i + 4 <= n) {
    u32 v; __builtin_memcpy(&v, src + i, 4);
    u32 hsh = (v * 2654435761u) >> (32 - HBITS), cand = head[hsh];
    head[hsh] = i;
    u32 len = 0;
    if (cand != 0xFFFFFFFFu && i - cand < 65536) { while (i + len < n && len < 255 && src[cand + len] == src[i + len]) len++; }
    if (len >= 4) {
      dst[o++] = (u8)lit; for (u32 k = 0; k < lit; k++) dst[o++] = src[i - lit + k];
      dst[o++] = (u8)len; dst[o++] = (u8)(i - cand); dst[o++] = (u8)((i - cand) >> 8);
      i += len; lit = 0;
    } else {
      i++; lit++;
      if (lit == 255) { dst[o++] = 255; for (u32 k = 0; k < 255; k++) dst[o++] = src[i - 255 + k]; dst[o++] = 0; dst[o++] = 0; dst[o++] = 0; lit = 0; }
    }
  }
  lit += n - i;
  dst[o++] = (u8)lit; for (u32 k = 0; k < lit; k++) dst[o++] = src[n - lit + k];
  return o;
}
static u64 lz_work(u64 id, u32 rounds) {
  u64 h = 0;
  for (u32 r = 0; r < rounds; r++) {
    u32 n = lz_compress(data[id], BUF, packed[id], heads[id]);
    for (u32 i = 0; i < n; i += 97) h = (h ^ packed[id][i]) * 0x9E3779B97F4A7C15ul + n;
    data[id][(r * 131) % BUF] ^= (u8)r;
  }
  return h;
}

// ---- contention ----
static Mutex shared_m; static u64 shared_table[32]; static u64 shared_atomic;
static u64 contend_work(u64 id, u32 rounds) {
  u64 h = id + 1;
  for (u32 r = 0; r < rounds; r++) {
    for (u32 i = 0; i < 2000; i++) { h ^= h >> 29; h *= 0xBF58476D1CE4E5B9ul; h += i; }      // private work
    __atomic_fetch_add(&shared_atomic, 1, __ATOMIC_SEQ_CST);                                 // a shared line every core writes
    mutex_lock(&shared_m);                                                                  // a shared structure under one lock
    for (u32 i = 0; i < 32; i++) shared_table[i] += (id + 1) * (i + 1);
    mutex_unlock(&shared_m);
  }
  return h;
}
// ---- SVC-heavy ----
static u64 svc_work(u64 id, u32 rounds) {
  Handle w, r; s32 idx = -1; u64 ok = 0;
  svcCreateEvent(&w, &r);
  for (u32 i = 0; i < rounds; i++) {
    svcSignalEvent(w);
    if (svcWaitSynchronization(&idx, &r, 1, -1) == 0) ok++;
    svcResetSignal(r);
  }
  svcCloseHandle(w); svcCloseHandle(r);
  return ok;
}

// ---- ping-pong: two threads on two cores hand a token back and forth through two events ----
static Handle ping_w[2], ping_r[2];
static u64 ping_work(u64 id, u32 rounds) {
  s32 idx = -1; u64 ok = 0;
  for (u32 i = 0; i < rounds; i++) {
    if (svcWaitSynchronization(&idx, &ping_r[id], 1, -1) == 0) ok++;
    svcResetSignal(ping_r[id]);
    svcSignalEvent(ping_w[id ^ 1]);
  }
  return ok;
}

static void work_fn(void *arg) {
  u64 id = (u64)arg;
#if WORK == 1
  result[id] = sha_work(data[id], ROUNDS);
#elif WORK == 2
  result[id] = lz_work(id, ROUNDS);
#elif WORK == 3
  result[id] = contend_work(id, ROUNDS);
#elif WORK == 4
  result[id] = svc_work(id, ROUNDS);
#else
  result[id] = ping_work(id, ROUNDS);
#endif
}
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  for (u64 t = 0; t < NT; t++) {
    u64 s = 0x1234567 + t;
    // compressible: runs of a few symbols with noise
    for (u32 i = 0; i < BUF; i++) { u64 x = rng(&s); data[t][i] = (x & 7) ? (u8)('a' + (i / 13 + t) % 7) : (u8)(x >> 8); }
  }
#if WORK == 5
  svcCreateEvent(&ping_w[0], &ping_r[0]); svcCreateEvent(&ping_w[1], &ping_r[1]);
  svcSignalEvent(ping_w[0]);
#endif
  for (u64 i = 0; i < NT; i++) thread_start(&th[i], work_fn, (void *)i, stacks[i] + STACK, 44, i % 4);
  for (int i = 0; i < NT; i++) thread_join(&th[i]);
  Line l; l.n = 0;
  l_s(&l, "bench work "); l_u(&l, WORK); l_s(&l, ":");
  for (int i = 0; i < NT; i++) { l_c(&l, ' '); l_x(&l, result[i]); }
#if WORK == 3
  u64 ts = 0; for (int i = 0; i < 32; i++) ts += shared_table[i];
  l_s(&l, " shared table sum="); l_u(&l, ts); l_s(&l, " atomic="); l_u(&l, shared_atomic);
#endif
  l_out(&l);
  return 0;
}
