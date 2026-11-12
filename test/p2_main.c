// Proof 2: guest threads executing REAL translated ARM64 code in parallel, one Emscripten pthread (one worker) per
// guest thread, all on the one shared memory, with their SVCs answered by nxnative's C kernel (hle_thread.c).
// The ARM64 guest is guest/mt.c; the translator is nxweb's (src/a64, shared mode), used as built by nxweb.
// Usage: node p2.js <guest.bin> <translator.shared.wasm> <helpers.shared.wasm> <guest_add3 address> [mutex rounds] [compute rounds]
#include "dm.h"
#include "nx_port.h"
#include <stdatomic.h>
#include <emscripten.h>
#include <emscripten/stack.h>
#include <emscripten/threading.h>

uint32_t svc_thread_main_init(void);
void nx_translator_start(const uint8_t *tr, uint32_t tr_len, const uint8_t *hlp, uint32_t hlp_len, uint64_t code_lo, uint64_t code_size);
void nx_js_guest_run(uint64_t *io);
void nx_js_thread_stats(double *out);
void nx_note_thread(uint64_t entry);
extern struct nx_seen { uint64_t entry; int js_tid; uintptr_t pt; } nx_seen[]; extern _Atomic int nx_nseen;
extern _Atomic uint64_t nx_stat_translate_ns, nx_stat_translate_calls, nx_stat_unit_bytes, nx_stat_svcs;
uint32_t nx_unit_count(void);

#define BASE 0x08000000ull
#define DATA 0x09000000ull
#define STACK_TOP 0x09200000ull
#define CODE_SPAN 0x00100000ull
struct shared { uint32_t mutex, pad; uint64_t counter, atomic_counter, lock_svcs, per_thread[16], result[16]; };
#define S ((struct shared *)(uintptr_t)DATA)

// the SVCs of the test guest ABI that are not thread SVCs (nxweb docs/CONTRACT.md)
int nx_svc_other(int num, uint64_t *regs) {
    switch (num) {
    case 0x27: fwrite((const void *)(uintptr_t)regs[0], 1, (size_t)regs[1], stdout); regs[0] = 0; return 1;
    case 0x1E: regs[0] = now_ns() / 52; return 1;
    }
    return 0;
}
static uint8_t *load(const char *path, uint32_t *len) {
    FILE *f = fopen(path, "rb"); if (!f) die("cannot open %s", path);
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *p = malloc((size_t)n); if (fread(p, 1, (size_t)n, f) != (size_t)n) die("short read of %s", path);
    fclose(f); *len = (uint32_t)n; return p;
}
static uint32_t g_self;
static uint64_t run(int threads, uint64_t rounds, int mode, double *ms) {
    memset(S, 0, sizeof *S);
    uint64_t io[8] = {DATA, g_self, (uint64_t)threads, rounds, (uint64_t)mode, BASE, STACK_TOP};
    uint64_t t0 = now_ns();
    nx_js_guest_run(io);
    *ms = (now_ns() - t0) / 1e6;
    return io[0];
}
// the guest's compute(), compiled natively into this module: what the translated code has to return
static uint64_t compute(uint64_t seed, uint64_t rounds) {
    uint64_t x = seed | 1, acc = 0; uint32_t tab[64];
    for (int i = 0; i < 64; i++) tab[i] = (uint32_t)(i * 2654435761u);
    for (uint64_t i = 0; i < rounds; i++) {
        x ^= x << 13; x ^= x >> 7; x ^= x << 17;
        uint32_t *p = &tab[x & 63];
        if (x & 0x100) acc += *p; else acc ^= (uint64_t)*p << (x & 31);
        *p += (uint32_t)acc;
    }
    return acc ^ x;
}
static int g_fail;
#define CHECK(c, ...) do { if (!(c)) { LOG("[RED] FAIL " __VA_ARGS__); g_fail = 1; } } while (0)
static void *watchdog(void *arg) { (void)arg; sleep(240); LOG("[RED] FAIL no result after 240 s"); extern void svc_thread_dump(void); svc_thread_dump(); emscripten_force_exit(2); return NULL; }

int main(int argc, char **argv) {
    if (argc < 5) die("usage: p2 guest.bin translator.wasm helpers.wasm add3_addr [mutex rounds] [compute rounds]");
    uint64_t add3 = strtoull(argv[4], 0, 16), mrounds = argc > 5 ? strtoull(argv[5], 0, 10) : 200000, crounds = argc > 6 ? strtoull(argv[6], 0, 10) : 100000000;
    g_t0_ns = now_ns();
    pthread_key_create(&g_key18, NULL);
    { pthread_t wd; pthread_create(&wd, NULL, watchdog, NULL); }
    // Emscripten's own data, stack and heap must lie outside the guest's address space and nxweb's host area (0 .. 0x0800_0000)
    static int probe; void *heap = malloc(16);
    printf("layout: module data %p, C stack %p, heap %p; guest code %#llx, guest data %#llx; memory %zu MB\n", (void *)&probe, (void *)emscripten_stack_get_base(), heap,
           BASE, DATA, emscripten_get_heap_size() >> 20);
    if ((uintptr_t)&probe < STACK_TOP || emscripten_stack_get_end() < STACK_TOP || (uintptr_t)heap < STACK_TOP) die("the Emscripten module overlaps the guest address space");
    uint32_t glen, tlen, hlen;
    uint8_t *g = load(argv[1], &glen), *tr = load(argv[2], &tlen), *hlp = load(argv[3], &hlen);
    memcpy((void *)(uintptr_t)BASE, g, glen);
    uint64_t t0 = now_ns();
    nx_translator_start(tr, tlen, hlp, hlen, BASE, CODE_SPAN);
    printf("translator thread ready in %.0f ms (nxweb translator %u bytes, helpers %u bytes, guest image %u bytes)\n", (now_ns() - t0) / 1e6, tlen, hlen, glen);
    g_self = svc_thread_main_init();
    nx_note_thread(BASE);

    double ms; uint64_t r;
    // warm-up: translates what the guest reaches (lazily, from whichever thread gets there first)
    r = run(2, 1000, 0, &ms); CHECK(r == 2000, "warm-up counter %llu", (unsigned long long)r);
    run(2, 1000, 1, &ms); run(2, 1000, 2, &ms);
    printf("translated on demand: %u units, %llu bytes of wasm, %llu requests to the translator thread, %.1f ms in it\n", nx_unit_count(), (unsigned long long)nx_stat_unit_bytes,
           (unsigned long long)nx_stat_translate_calls, nx_stat_translate_ns / 1e6);

    // a host call into guest code (what hle_bind_system_event does with nn::os::CreateSystemEvent)
    r = nx_guest_call(add3, 5, 7, 11); CHECK(r == 5 + 14 + 33, "nx_guest_call(guest_add3) = %llu", (unsigned long long)r);
    printf("%s host -> guest call: guest_add3(5, 7, 11) = %llu\n", r == 52 ? "ok  " : "FAIL", (unsigned long long)r);

    for (int threads = 2; threads <= 4; threads += 2) {
        uint64_t s0 = nx_stat_svcs;
        r = run(threads, mrounds, 0, &ms);
        int ok = r == (uint64_t)threads * mrounds && S->mutex == 0;
        for (int i = 0; i < threads; i++) ok &= S->per_thread[i] == mrounds;
        CHECK(ok, "mutex counter %llu, want %llu (lock word %#x)", (unsigned long long)r, (unsigned long long)threads * mrounds, S->mutex);
        printf("%s guest mutex + counter, %d guest threads x %llu rounds: counter %llu (exact), every thread did %llu, %llu contended locks (svcArbitrateLock), %llu SVCs in all, %.0f ms\n", ok ? "ok  " : "FAIL",
               threads, (unsigned long long)mrounds, (unsigned long long)r, (unsigned long long)S->per_thread[threads - 1], (unsigned long long)S->lock_svcs, (unsigned long long)(nx_stat_svcs - s0), ms);
    }
    r = run(4, mrounds * 5, 2, &ms);
    CHECK(r == 4 * mrounds * 5, "atomic counter %llu", (unsigned long long)r);
    printf("%s guest atomic counter (no kernel), 4 guest threads x %llu: %llu, %.0f ms (%.1f M increments/s)\n", r == 4 * mrounds * 5 ? "ok  " : "FAIL", (unsigned long long)(mrounds * 5), (unsigned long long)r, ms, 4 * mrounds * 5 / ms / 1e3);

    // throughput: the same pure computation on 1, 2 and 4 guest threads (best of 3)
    uint64_t n0 = now_ns(); uint64_t nat = compute(0x9E3779B97F4A7C15ull, crounds); double nat_ms = (now_ns() - n0) / 1e6;
    double one = 0;
    for (int threads = 1; threads <= 4; threads *= 2) {
        double best = 1e30; int ok = 1;
        uint64_t want = 0; for (int i = 0; i < threads; i++) want ^= compute(0x9E3779B97F4A7C15ull * (uint64_t)(i + 1), crounds);
        for (int rep = 0; rep < 3; rep++) { r = run(threads, crounds, 1, &ms); ok &= r == want; if (ms < best) best = ms; }
        CHECK(ok, "compute on %d threads returned %#llx, the same C code compiled natively gives %#llx", threads, (unsigned long long)r, (unsigned long long)want);
        double rate = threads * (double)crounds / best / 1e3;
        if (threads == 1) one = rate;
        printf("%s translated compute loop, %d guest thread%s x %llu iterations: %.0f ms, %.1f M iterations/s in all (x%.2f of one thread); result equals the natively compiled C\n", ok ? "ok  " : "FAIL",
               threads, threads > 1 ? "s" : " ", (unsigned long long)crounds, best, rate, rate / one);
    }
    printf("     (the same loop compiled by Emscripten into this module: %.0f ms, %.1f M iterations/s; result %#llx)\n", nat_ms, crounds / nat_ms / 1e3, (unsigned long long)nat);

    double st[4] = {0}; nx_js_thread_stats(st);
    printf("main guest thread's worker: core + helpers + table set up in %.1f ms; %d units instantiated in %.1f ms (%.0f bytes)\n", st[0], (int)st[3], st[1], st[2]);
    int n = nx_nseen, distinct = 0; if (n > 64) n = 64;
    for (int i = 0; i < n; i++) { int seen = 0; for (int j = 0; j < i; j++) seen |= nx_seen[j].js_tid == nx_seen[i].js_tid; distinct += !seen; }
    printf("guest thread starts: %d, on %d different node worker threads (ids:", n, distinct);
    for (int i = 0; i < n && i < 12; i++) printf(" %d", nx_seen[i].js_tid);
    printf("%s)\n", n > 12 ? " ..." : "");
    CHECK(distinct >= 2, "all guest threads ran on one worker");
    printf(g_fail ? "P2 FAIL\n" : "P2 PASS\n");
    fflush(stdout);
    emscripten_force_exit(g_fail);
}
