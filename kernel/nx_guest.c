// nxem: the guest execution seam, C half. nxnative jumps into rewritten native code (entry.S dm_thread_enter) and
// takes SVCs through its gate; here every guest pthread drives its own instance of nxweb's translated wasm units
// (kernel/nx_guest.js) and the units' `svc` import lands in nx_svc on the same pthread.
//   - unit registry: the bytes of every translated unit, in the shared memory, so that each thread can instantiate
//     them into its own table (a WebAssembly.Module cannot be handed to a thread that is blocked or running);
//   - translator service: one pthread owns the translator (its state is one JS realm's); a thread that reaches
//     code nobody translated yet asks it and waits on a condition variable.
#include "dm.h"
#include "nx_port.h"
#include <stdatomic.h>
#include <emscripten.h>

int svc_thread(int num, uint64_t *regs);
void thr_svc_enter(uint64_t *regs, uint64_t pc);
void thr_svc_leave(void);
void dm_thread_native_wait(int entering);

// ---- JS half (kernel/nx_guest.js)
void nx_js_guest_run(uint64_t *io);                    // io: x0..x4, pc, sp in; x0 out. Returns when the guest reaches the exit pc
void nx_js_tr_init(const uint8_t *tr, uint32_t tr_len, const uint8_t *hlp, uint32_t hlp_len, double code_lo, double code_size);
uint32_t nx_js_tr_translate(double pc);
int nx_js_tid(void);

// ---- registry (written by the translator thread only; readers take the count first)
enum { NX_MAX_UNITS = 1 << 16 };
static uint32_t g_table_cap = 1 << 18;   // slots of every thread's table; nx_set_table_cap before the first guest thread, or threads grow theirs when they sync
typedef struct { uint8_t *bytes; uint32_t len, table_base, nfuncs; } nx_unit_t;
static nx_unit_t g_units[NX_MAX_UNITS];
static _Atomic uint32_t g_nunits;
static struct { uint8_t *p; uint32_t len; } g_wmod[2];   // 0 = the core module (CPU state + run loop), 1 = helpers
_Atomic uint64_t nx_stat_translate_ns, nx_stat_translate_calls, nx_stat_unit_bytes;

// Addresses cross the JS boundary as doubles (exact to 2^53): the same code for a 32-bit and a 64-bit memory.
EMSCRIPTEN_KEEPALIVE void nx_unit_publish(double bytes_, uint32_t len, uint32_t table_base, uint32_t nfuncs) {
    uint8_t *bytes = (uint8_t *)(uintptr_t)bytes_;
    uint32_t i = atomic_load(&g_nunits);
    if (i >= NX_MAX_UNITS || table_base + nfuncs > g_table_cap) die("translated-unit registry or function table full (%u units, table index %u)", i, table_base + nfuncs);
    g_units[i] = (nx_unit_t){bytes, len, table_base, nfuncs};
    nx_stat_unit_bytes += len;
    atomic_store(&g_nunits, i + 1);
}
EMSCRIPTEN_KEEPALIVE uint32_t nx_unit_count(void) { return atomic_load(&g_nunits); }
EMSCRIPTEN_KEEPALIVE double nx_unit_bytes(uint32_t i) { return (double)(uintptr_t)g_units[i].bytes; }
EMSCRIPTEN_KEEPALIVE uint32_t nx_unit_len(uint32_t i) { return g_units[i].len; }
EMSCRIPTEN_KEEPALIVE uint32_t nx_unit_base(uint32_t i) { return g_units[i].table_base; }
EMSCRIPTEN_KEEPALIVE uint32_t nx_unit_nfuncs(uint32_t i) { return g_units[i].nfuncs; }
EMSCRIPTEN_KEEPALIVE uint32_t nx_table_cap(void) { return g_table_cap; }
EMSCRIPTEN_KEEPALIVE void nx_set_table_cap(uint32_t n) { g_table_cap = n; }
EMSCRIPTEN_KEEPALIVE void nx_mod_set(int which, double p, uint32_t len) { g_wmod[which].p = (uint8_t *)(uintptr_t)p; g_wmod[which].len = len; }
EMSCRIPTEN_KEEPALIVE double nx_mod_ptr(int which) { return (double)(uintptr_t)g_wmod[which].p; }
EMSCRIPTEN_KEEPALIVE int nx_is64(void) { return sizeof(void *) == 8; }
EMSCRIPTEN_KEEPALIVE uint32_t nx_mod_len(int which) { return g_wmod[which].len; }

// ---- translator service
static pthread_mutex_t tr_m = PTHREAD_MUTEX_INITIALIZER, tr_gate = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t tr_cv = PTHREAD_COND_INITIALIZER;
static int tr_state, tr_ready;   // 0 idle, 1 requested, 2 answered
static uint64_t tr_pc; static uint32_t tr_res;
static struct { const uint8_t *tr, *hlp; uint32_t tr_len, hlp_len; uint64_t code_lo, code_size; } tr_arg;
static void *tr_main(void *arg) {
    (void)arg;
    nx_setname_self("nx translator");
    nx_js_tr_init(tr_arg.tr, tr_arg.tr_len, tr_arg.hlp, tr_arg.hlp_len, (double)tr_arg.code_lo, (double)tr_arg.code_size);
    pthread_mutex_lock(&tr_m);
    tr_ready = 1; pthread_cond_broadcast(&tr_cv);
    for (;;) {
        while (tr_state != 1) pthread_cond_wait(&tr_cv, &tr_m);
        uint64_t pc = tr_pc;
        pthread_mutex_unlock(&tr_m);
        uint64_t t0 = now_ns();
        uint32_t r = nx_js_tr_translate((double)pc);   // translates if needed, instantiates in this realm, publishes the bytes
        nx_stat_translate_ns += now_ns() - t0; nx_stat_translate_calls++;
        pthread_mutex_lock(&tr_m);
        tr_res = r; tr_state = 2; pthread_cond_broadcast(&tr_cv);
    }
    return NULL;
}
void nx_translator_start(const uint8_t *tr, uint32_t tr_len, const uint8_t *hlp, uint32_t hlp_len, uint64_t code_lo, uint64_t code_size) {
    tr_arg.tr = tr; tr_arg.tr_len = tr_len; tr_arg.hlp = hlp; tr_arg.hlp_len = hlp_len; tr_arg.code_lo = code_lo; tr_arg.code_size = code_size;
    pthread_t th; pthread_attr_t a; pthread_attr_init(&a); pthread_attr_setstacksize(&a, 4 << 20);
    if (pthread_create(&th, &a, tr_main, NULL)) die("pthread_create (translator)");
    pthread_mutex_lock(&tr_m); while (!tr_ready) pthread_cond_wait(&tr_cv, &tr_m); pthread_mutex_unlock(&tr_m);
}
// Called from a guest thread's `translate` import: the table index of the function at pc. The caller is blocked like
// in a native HLE wait (it holds no guest core meanwhile), so a same-core handoff does not wait for it.
EMSCRIPTEN_KEEPALIVE uint32_t nx_translate(double pc) {
    dm_thread_native_wait(1);
    pthread_mutex_lock(&tr_gate);
    pthread_mutex_lock(&tr_m);
    tr_pc = (uint64_t)pc; tr_state = 1; pthread_cond_broadcast(&tr_cv);
    while (tr_state != 2) pthread_cond_wait(&tr_cv, &tr_m);
    uint32_t r = tr_res; tr_state = 0;
    pthread_mutex_unlock(&tr_m);
    pthread_mutex_unlock(&tr_gate);
    dm_thread_native_wait(0);
    return r;
}

// ---- SVC entry: regs is the thread's context block (nxweb docs/CONTRACT.md: x0..x30 at +0, sp +0xF8, pc +0x100)
__attribute__((weak)) int nx_svc_other(int num, uint64_t *regs) { (void)num; (void)regs; return 0; }
_Atomic uint64_t nx_stat_svcs;
EMSCRIPTEN_KEEPALIVE void nx_svc(int num, double regs_) {
    uint64_t *regs = (uint64_t *)(uintptr_t)regs_;
    atomic_fetch_add_explicit(&nx_stat_svcs, 1, memory_order_relaxed);
    thr_svc_enter(regs, regs[32]);
    if (!svc_thread(num, regs) && !nx_svc_other(num, regs)) die("svc %#x at pc %#llx: not implemented", num, (unsigned long long)regs[32]);
    thr_svc_leave();
}

// ---- thread entry: hle_thread.c's thread_main calls this on the new pthread, after StartThread
#define NX_MAX_SEEN 64
struct nx_seen { uint64_t entry; int js_tid; uintptr_t pt; } nx_seen[NX_MAX_SEEN]; _Atomic int nx_nseen;   // js_tid: an id of the worker's JS realm
void nx_note_thread(uint64_t entry) { int i = atomic_fetch_add(&nx_nseen, 1); if (i < NX_MAX_SEEN) nx_seen[i] = (struct nx_seen){entry, nx_js_tid(), (uintptr_t)pthread_self()}; }
void dm_thread_enter(uint64_t entry, uint64_t arg, uint64_t sp) {
    nx_note_thread(entry);
    uint64_t io[8] = {arg, 0, 0, 0, 0, entry, sp};
    nx_js_guest_run(io);
    // the entry function returned to the exit pc: the same as ExitThread
    uint64_t regs[100] = {0};
    svc_thread(0x0A, regs);
    abort();
}
