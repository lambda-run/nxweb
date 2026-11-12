// Proof 1: nxnative's thread / synchronisation core (dm/host/hle_thread.c, ported by kernel/port_thread.py)
// compiled with Emscripten pthreads, stressed from several pthreads (each one a Web Worker / node worker_thread).
// The "guest" side here is C that does what the SDK's nn::os does in user mode (the lock word protocol of
// ArbitrateLock / ArbitrateUnlock, WaitProcessWideKeyAtomic / SignalProcessWideKey, events, sleeps) and enters
// the kernel through svc_thread(), the same entry the translated game code uses in proof 2.
// Usage: node p1_stress.js [threads] [rounds]
#include "dm.h"
#include <stdatomic.h>
#include <unistd.h>
#include <emscripten/threading.h>

int svc_thread(int num, uint64_t *regs);
uint32_t svc_thread_main_init(void);
void svc_thread_dump(void);
void thr_svc_enter(uint64_t *regs, uint64_t pc);
void thr_svc_leave(void);

#define WAITERS 0x40000000u
#define R_TIMEOUT 0xEA01u
#define R_CANCELLED 0xEC01u
#define P(x) ((uint64_t)(uintptr_t)(x))

static __thread uint32_t self_h;
static _Atomic uint64_t n_svc, n_lock_svc, n_cv_wait, n_cv_timeout;
static _Atomic int g_done;
static const char *g_stage = "start";

static uint64_t svc(int n, uint64_t *r) {
    atomic_fetch_add_explicit(&n_svc, 1, memory_order_relaxed);
    thr_svc_enter(r, 0);
    if (!svc_thread(n, r)) die("svc %#x is not a thread SVC", n);
    thr_svc_leave();
    return r[0];
}
#define SVC(n, ...) ({ uint64_t r_[100] = {__VA_ARGS__}; svc(n, r_); })

// ---- what a thread start looks like to the kernel: entry, argument (the SDK's ThreadType, name pointer at +0x1a0), stack top
typedef struct { void (*fn)(void *); void *arg; uint32_t handle; char pad[0x1a0 - 20]; uint64_t name; char nm[32]; } start_t;
void dm_thread_enter(uint64_t entry, uint64_t arg, uint64_t sp) {
    (void)entry; (void)sp;
    start_t *s = (start_t *)(uintptr_t)arg;
    self_h = s->handle;
    s->fn(s->arg);
    SVC(0x0A);
    abort();
}
uint64_t nx_guest_call(uint64_t pc, uint64_t a0, uint64_t a1, uint64_t a2) { (void)pc; (void)a0; (void)a1; (void)a2; abort(); }
static uint32_t spawn(const char *name, void (*fn)(void *), void *arg, int prio, int core) {
    start_t *s = calloc(1, sizeof *s);
    s->fn = fn; s->arg = arg; s->name = P(s->nm); snprintf(s->nm, sizeof s->nm, "%s", name);
    uint64_t r[100] = {0, 0x1000, P(s), P(s) + 0x100, (uint64_t)prio, (uint64_t)core};
    if (svc(0x08, r)) die("CreateThread failed");
    s->handle = (uint32_t)r[1];
    if (SVC(0x09, s->handle)) die("StartThread failed");
    return s->handle;
}
static void join(uint32_t h) {   // nn::os::WaitThread: WaitSynchronization on the thread handle, then CloseHandle
    uint64_t r[100] = {0, P(&h), 1, (uint64_t)-1};
    if (svc(0x18, r)) die("WaitSynchronization(thread) = %#llx", (unsigned long long)r[0]);
    SVC(0x16, h);
}

// ---- user-mode halves of the kernel primitives (the public libnx algorithms; nn::os does the same)
static void g_lock(_Atomic uint32_t *m) {
    uint32_t self = self_h;
    for (;;) {
        uint32_t cur = 0;
        if (atomic_compare_exchange_strong(m, &cur, self)) return;
        if (!(cur & WAITERS) && !atomic_compare_exchange_strong(m, &cur, cur | WAITERS)) continue;
        atomic_fetch_add_explicit(&n_lock_svc, 1, memory_order_relaxed);
        SVC(0x1A, cur & ~WAITERS, P(m), self);
        if ((atomic_load(m) & ~WAITERS) == self) return;
    }
}
static void g_unlock(_Atomic uint32_t *m) {
    uint32_t e = self_h;
    if (!atomic_compare_exchange_strong(m, &e, 0)) SVC(0x1B, P(m));
}
static uint32_t g_cv_wait(_Atomic uint32_t *key, _Atomic uint32_t *m, int64_t ns) {
    atomic_fetch_add_explicit(&n_cv_wait, 1, memory_order_relaxed);
    uint32_t rc = (uint32_t)SVC(0x1C, P(m), P(key), self_h, (uint64_t)ns);
    if (rc == R_TIMEOUT) { atomic_fetch_add_explicit(&n_cv_timeout, 1, memory_order_relaxed); g_lock(m); }   // on a signal the kernel hands the lock over; on a timeout user mode takes it again
    else if (rc) die("WaitProcessWideKeyAtomic = %#x", rc);
    else if ((atomic_load(m) & ~WAITERS) != self_h) die("woken from a condition wait without the lock (word %#x, self %#x)", atomic_load(m), self_h);
    return rc;
}
static void g_cv_wake(_Atomic uint32_t *key, int n) { if (atomic_load(key)) SVC(0x1D, P(key), (uint64_t)n); }
static void ev_create(uint32_t *w, uint32_t *r) { uint64_t x[100] = {0}; if (svc(0x45, x)) die("CreateEvent"); *w = (uint32_t)x[1]; *r = (uint32_t)x[2]; }
static uint32_t ev_wait(const uint32_t *hs, int n, int64_t ns, int *idx) {
    uint64_t x[100] = {0, P(hs), (uint64_t)n, (uint64_t)ns};
    svc(0x18, x); if (idx) *idx = (int)x[1];
    return (uint32_t)x[0];
}
#define CHECK(c, ...) do { if (!(c)) { LOG("[RED] FAIL " __VA_ARGS__); svc_thread_dump(); emscripten_force_exit(1); } } while (0)

// ---- A. a plain counter under a guest mutex
static int A_rounds;
static _Atomic uint32_t A_m; static volatile uint64_t A_counter; static _Atomic int A_in;
static void A_worker(void *arg) {
    (void)arg;
    for (int i = 0; i < A_rounds; i++) {
        g_lock(&A_m);
        if (atomic_fetch_add(&A_in, 1) != 0) die("two threads inside the mutex");
        A_counter = A_counter + 1;
        atomic_fetch_sub(&A_in, 1);
        g_unlock(&A_m);
    }
}

// ---- B. a bounded queue: mutex + two condition variables, some waits timed
enum { QCAP = 4 };
static _Atomic uint32_t B_m, B_not_full, B_not_empty;
static uint32_t B_q[QCAP]; static int B_n, B_head; static uint64_t B_sum_out, B_taken; static int B_items, B_prod;
static void B_producer(void *arg) {
    uint32_t base = (uint32_t)(uintptr_t)arg;
    for (int i = 0; i < B_items; i++) {
        g_lock(&B_m);
        while (B_n == QCAP) g_cv_wait(&B_not_full, &B_m, i & 1 ? -1 : 300000);
        B_q[(B_head + B_n++) % QCAP] = base + (uint32_t)i;
        g_cv_wake(&B_not_empty, 1);
        g_unlock(&B_m);
    }
}
static void B_consumer(void *arg) {
    (void)arg;
    for (;;) {
        g_lock(&B_m);
        while (B_n == 0 && B_taken < (uint64_t)B_items * B_prod) g_cv_wait(&B_not_empty, &B_m, 500000);
        if (B_n == 0) { g_cv_wake(&B_not_empty, -1); g_unlock(&B_m); return; }
        B_sum_out += B_q[B_head]; B_head = (B_head + 1) % QCAP; B_n--; B_taken++;
        if (B_taken == (uint64_t)B_items * B_prod) g_cv_wake(&B_not_empty, -1);
        g_cv_wake(&B_not_full, 1);
        g_unlock(&B_m);
    }
}

// ---- C. events: strict ping-pong over two kernel events, waited on with WaitSynchronization
typedef struct { uint32_t aw, ar, bw, br, dummy_r; int rounds; _Atomic int pings, pongs; } pp_t;
static void C_ping(void *arg) {
    pp_t *p = arg; uint32_t hs[2] = {p->dummy_r, p->br};
    for (int i = 0; i < p->rounds; i++) {
        SVC(0x11, p->aw);
        int idx = -1; uint32_t rc = ev_wait(hs, 2, -1, &idx);
        if (rc || idx != 1) die("ping: WaitSynchronization = %#x index %d", rc, idx);
        if (SVC(0x17, p->br)) die("ping: ResetSignal on a signalled event failed");
        p->pings++;
    }
}
static void C_pong(void *arg) {
    pp_t *p = arg;
    for (int i = 0; i < p->rounds; i++) {
        int idx = -1; uint32_t rc = ev_wait(&p->ar, 1, -1, &idx);
        if (rc || idx != 0) die("pong: WaitSynchronization = %#x index %d", rc, idx);
        SVC(0x12, p->ar);
        p->pongs++;
        SVC(0x11, p->bw);
    }
}

// ---- D. sleeps, timeouts, address arbiter, cancel
static void D_sleeper(void *arg) { uint64_t *out = arg, t0 = now_ns(); for (int i = 0; i < 20; i++) SVC(0x0B, 2000000); *out = now_ns() - t0; }
static _Atomic uint32_t D_addr; static _Atomic int D_woken;
static void D_addr_waiter(void *arg) {
    (void)arg;
    uint32_t rc = (uint32_t)SVC(0x34, P(&D_addr), 2, 7, (uint64_t)-1);   // wait while *addr == 7
    if (rc) die("WaitForAddress = %#x", rc);
    D_woken++;
}
static uint32_t D_cancel_rc; static uint32_t D_never_r;
static void D_cancel_waiter(void *arg) { (void)arg; D_cancel_rc = ev_wait(&D_never_r, 1, -1, NULL); }

static void *watchdog(void *arg) {
    int secs = (int)(intptr_t)arg;
    for (int i = 0; i < secs * 10 && !g_done; i++) usleep(100000);
    if (!g_done) { LOG("[RED] FAIL no progress after %d s in stage '%s': deadlock", secs, g_stage); svc_thread_dump(); emscripten_force_exit(2); }
    return NULL;
}

int main(int argc, char **argv) {
    int nt = argc > 1 ? atoi(argv[1]) : 8, rounds = argc > 2 ? atoi(argv[2]) : 20000;
    g_t0_ns = now_ns();
    pthread_key_create(&g_key18, NULL);
    self_h = svc_thread_main_init();
    pthread_t wd; pthread_create(&wd, NULL, watchdog, (void *)(intptr_t)150);
    uint32_t h[64]; char nm[32];
    uint64_t t0, t1;

    // A: two passes. Pass 1: every thread on its own core number and equal priority (free running);
    // pass 2: three cores, mixed priorities, so wakes go through the same-core handoff (note_runnable / dm_yield_to_core_peers).
    for (int pass = 0; pass < 2; pass++) {
        g_stage = pass ? "A mutex (3 cores, mixed priorities)" : "A mutex (one core each)";
        A_rounds = rounds; A_counter = 0; uint64_t l0 = n_lock_svc;
        t0 = now_ns();
        for (int i = 0; i < nt; i++) { snprintf(nm, sizeof nm, "A%d", i); h[i] = spawn(nm, A_worker, NULL, pass ? 44 + i % 3 : 45, pass ? i % 3 : i % 60 + 1); }
        for (int i = 0; i < nt; i++) join(h[i]);
        t1 = now_ns();
        CHECK(A_counter == (uint64_t)nt * rounds && atomic_load(&A_m) == 0, "%s: counter %llu, want %llu, lock word %#x", g_stage, (unsigned long long)A_counter, (unsigned long long)nt * rounds, atomic_load(&A_m));
        printf("ok   %s: %d threads x %d lock/unlock, counter exact, %llu ArbitrateLock calls, %.0f ms (%.2f M lock pairs/s)\n", g_stage, nt, rounds,
               (unsigned long long)(n_lock_svc - l0), (t1 - t0) / 1e6, nt * (double)rounds / ((t1 - t0) / 1e3));
    }

    g_stage = "B condition variables";
    B_prod = nt / 2 > 0 ? nt / 2 : 1; B_items = rounds / 4; int ncons = B_prod;
    t0 = now_ns();
    for (int i = 0; i < B_prod; i++) { snprintf(nm, sizeof nm, "Bp%d", i); h[i] = spawn(nm, B_producer, (void *)(uintptr_t)(i * 1000000), 44 + i % 2, i % 3); }
    for (int i = 0; i < ncons; i++) { snprintf(nm, sizeof nm, "Bc%d", i); h[B_prod + i] = spawn(nm, B_consumer, NULL, 45 - i % 2, (i + 1) % 3); }
    for (int i = 0; i < B_prod + ncons; i++) join(h[i]);
    t1 = now_ns();
    uint64_t want = 0; for (int p = 0; p < B_prod; p++) want += (uint64_t)B_items * (uint64_t)(p * 1000000) + (uint64_t)B_items * (B_items - 1) / 2;
    CHECK(B_sum_out == want && B_taken == (uint64_t)B_items * B_prod && B_n == 0 && !atomic_load(&B_m), "queue: sum %llu want %llu, taken %llu", (unsigned long long)B_sum_out, (unsigned long long)want, (unsigned long long)B_taken);
    printf("ok   %s: %d producers, %d consumers, %llu items through a queue of %d, sum exact, %llu condition waits (%llu timed out), %.0f ms\n", g_stage, B_prod, ncons,
           (unsigned long long)B_taken, QCAP, (unsigned long long)n_cv_wait, (unsigned long long)n_cv_timeout, (t1 - t0) / 1e6);

    g_stage = "C events";
    int pairs = nt / 2 > 0 ? nt / 2 : 1; pp_t *pp = calloc((size_t)pairs, sizeof *pp); uint32_t dw;
    t0 = now_ns();
    for (int i = 0; i < pairs; i++) {
        ev_create(&pp[i].aw, &pp[i].ar); ev_create(&pp[i].bw, &pp[i].br); ev_create(&dw, &pp[i].dummy_r); SVC(0x16, dw); pp[i].rounds = rounds / 4;
        snprintf(nm, sizeof nm, "Cpong%d", i); h[2 * i] = spawn(nm, C_pong, &pp[i], 44, i % 3);
        snprintf(nm, sizeof nm, "Cping%d", i); h[2 * i + 1] = spawn(nm, C_ping, &pp[i], 46, (i + 1) % 3);
    }
    for (int i = 0; i < 2 * pairs; i++) join(h[i]);
    t1 = now_ns();
    for (int i = 0; i < pairs; i++) CHECK(pp[i].pings == rounds / 4 && pp[i].pongs == rounds / 4, "pair %d: %d pings %d pongs", i, pp[i].pings, pp[i].pongs);
    printf("ok   %s: %d pairs x %d round trips (SignalEvent / WaitSynchronization / ResetSignal / ClearEvent), %.0f ms (%.0f round trips/s)\n", g_stage, pairs, rounds / 4,
           (t1 - t0) / 1e6, pairs * (rounds / 4.0) / ((t1 - t0) / 1e9));
    for (int i = 0; i < pairs; i++) { SVC(0x16, pp[i].aw); SVC(0x16, pp[i].ar); SVC(0x16, pp[i].bw); SVC(0x16, pp[i].br); SVC(0x16, pp[i].dummy_r); }

    g_stage = "D sleeps and timeouts";
    uint64_t slept[4];
    for (int i = 0; i < 4; i++) { snprintf(nm, sizeof nm, "Dsleep%d", i); h[i] = spawn(nm, D_sleeper, &slept[i], 45, i % 3); }
    for (int i = 0; i < 4; i++) join(h[i]);
    uint64_t smin = slept[0], smax = slept[0]; for (int i = 1; i < 4; i++) { if (slept[i] < smin) smin = slept[i]; if (slept[i] > smax) smax = slept[i]; }
    CHECK(smin >= 39000000ull && smax < 400000000ull, "20 x SleepThread(2 ms) took %.1f .. %.1f ms", smin / 1e6, smax / 1e6);
    uint32_t ew, er; ev_create(&ew, &er);
    t0 = now_ns(); uint32_t rc = ev_wait(&er, 1, 5000000, NULL); t1 = now_ns();
    CHECK(rc == R_TIMEOUT && t1 - t0 >= 4500000ull && t1 - t0 < 200000000ull, "WaitSynchronization timeout: rc %#x after %.2f ms", rc, (t1 - t0) / 1e6);
    static _Atomic uint32_t tm, tkey;
    g_lock(&tm); t0 = now_ns(); rc = g_cv_wait(&tkey, &tm, 5000000); t1 = now_ns(); g_unlock(&tm);
    CHECK(rc == R_TIMEOUT && t1 - t0 >= 4500000ull, "WaitProcessWideKeyAtomic timeout: rc %#x after %.2f ms", rc, (t1 - t0) / 1e6);
    D_addr = 7;
    for (int i = 0; i < 3; i++) { snprintf(nm, sizeof nm, "Daddr%d", i); h[i] = spawn(nm, D_addr_waiter, NULL, 45, 1 + i % 2); }
    for (int tries = 0; tries < 2000 && atomic_load(&D_woken) < 3; tries++) { SVC(0x35, P(&D_addr), 0, 0, 1); SVC(0x0B, 100000); }   // SignalToAddress(Signal, count 1) until all three have come and gone
    for (int i = 0; i < 3; i++) join(h[i]);
    CHECK(D_woken == 3, "address arbiter: %d of 3 waiters woken", atomic_load(&D_woken));
    uint32_t nw; ev_create(&nw, &D_never_r);
    uint32_t ch = spawn("Dcancel", D_cancel_waiter, NULL, 45, 2);
    SVC(0x0B, 3000000); SVC(0x19, ch); join(ch);
    CHECK(D_cancel_rc == R_CANCELLED, "CancelSynchronization: the waiter got %#x", D_cancel_rc);
    printf("ok   %s: 4 threads x 20 SleepThread(2 ms) took %.1f .. %.1f ms; timed waits return 0xEA01 on time; WaitForAddress / SignalToAddress; CancelSynchronization\n", g_stage, smin / 1e6, smax / 1e6);

    g_done = 1;
    printf("P1 PASS: %llu thread SVCs from %d pthreads, no deadlock\n", (unsigned long long)n_svc, nt);
    emscripten_force_exit(0);
}
