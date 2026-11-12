// nxem: the process side of the C glue: the module table nxnative's
// code asks (module_of, guest_sym), each thread's thread-local region, the SVCs that are neither thread SVCs
// (hle_thread.c) nor memory SVCs (nx_mem.cpp), and the dispatch of host calls: a guest call that lands on a loader stub
// arrives here with the calling thread's context block and is answered by the generated thunk of nxnative's HLE
// function of that name (tools/gen_hle.py), when that function's file is part of the build.
#include "dm.h"
#include "nx_port.h"
#include "nx_guest.h"
#define NX_HLE_NO_NXNATIVE
#include "nx_hle.h"
#include <stdatomic.h>
#include <emscripten.h>

// ---- modules
static module_t g_mods[16];
module_t *g_mod = g_mods; int g_nmod;
EMSCRIPTEN_KEEPALIVE void nx_module_add(double name_, double base, double size, double text_end, double ro_off, double data_off) {
    const char *name = (const char *)(uintptr_t)name_;   // strings come from JS as addresses in doubles (kernel/nx_guest.h)
    if (g_nmod == 16) die("more than 16 modules");
    module_t *m = &g_mods[g_nmod];
    snprintf(m->name, sizeof m->name, "%s", name); m->base = (uint8_t *)(uintptr_t)base; m->size = (size_t)size;
    m->text_end = (uint64_t)text_end; m->ro_off = (uint64_t)ro_off; m->data_off = (uint64_t)data_off;
    nx_mem_module(name, (uint64_t)base, (uint64_t)size, (uint64_t)ro_off, (uint64_t)data_off);
    g_nmod++;
}
module_t *module_of(const void *p) {
    for (int i = 0; i < g_nmod; i++) if ((const uint8_t *)p >= g_mods[i].base && (const uint8_t *)p < g_mods[i].base + g_mods[i].size) return &g_mods[i];
    return NULL;
}
void *guest_sym(const char *name) { return (void *)(uintptr_t)nx_tr_job(1, (uint64_t)(uintptr_t)name); }   // the loader's symbol tables live in the translator thread's realm
// "main+0x1234" for a log line
const char *nx_where(uint64_t pc, char *buf, size_t n) {
    module_t *m = module_of((void *)(uintptr_t)pc);
    if (m) snprintf(buf, n, "%s+%#llx", m->name, (unsigned long long)(pc - (uint64_t)(uintptr_t)m->base)); else snprintf(buf, n, "%#llx", (unsigned long long)pc);
    return buf;
}

// ---- thread-local region (nxnative thread.c guest_thread_init, without the pthread keys: the translated code reads
// tpidr_el0 / tpidrro_el0 from its core's globals, which kernel/nx_guest.js sets from nx_tls / nx_tlr)
#define TLS_SIZE 8192
#define TLR_SIZE 0x200
#define THREAD_OBJ_SIZE 0x400
static __thread uint8_t *t_tls, *t_tlr;
void guest_thread_init(void) {
    free(t_tls); free(t_tlr);
    t_tls = calloc(1, TLS_SIZE); t_tlr = calloc(1, TLR_SIZE + THREAD_OBJ_SIZE);
    if (!t_tls || !t_tlr) die("guest thread-local block allocation failed");
    *(void **)(t_tlr + 0x1f8) = t_tlr + TLR_SIZE;   // current thread object
}
void guest_thread_set_id(uint64_t id) { if (!t_tlr) guest_thread_init(); *(uint32_t *)(t_tlr + 0x110) = (uint32_t)id; }
EMSCRIPTEN_KEEPALIVE double nx_tlr(void) { return (double)(uintptr_t)t_tlr; }
EMSCRIPTEN_KEEPALIVE double nx_tls(void) { return (double)(uintptr_t)t_tls; }

// ---- SVCs
static _Atomic uint64_t g_svc_count[128];
__attribute__((weak)) int nx_svc_other(int num, uint64_t *regs) {   // weak: proof 2 answers the test guests' SVCs itself
    if (num >= 0 && num < 128) atomic_fetch_add_explicit(&g_svc_count[num], 1, memory_order_relaxed);
    if (nx_mem_svc(num, regs)) return 1;
    switch (num) {
    case 0x1E: regs[0] = 0; regs[1] = now_ns() / 32; return 1;                 // GetSystemTick: 31.25 MHz, the Switch 2's counter (hle_os.c guest_ticks)
    case 0x27: fprintf(stderr, "[guest] %.*s\n", (int)regs[1], (const char *)(uintptr_t)regs[0]); regs[0] = 0; return 1;
    case 0x26: {  // Break(reason, ptr, size)
        char w[64]; uint32_t res = regs[1] && regs[2] >= 4 ? *(uint32_t *)(uintptr_t)regs[1] : 0;
        LOG("[RED] Break reason=%#llx Result=%#x called from %s", (unsigned long long)regs[0], res, nx_where(regs[30], w, sizeof w));
        if (regs[0] & 0x80000000ull) { regs[0] = 0; return 1; }
        nx_boot_report("the guest called svcBreak"); emscripten_force_exit(42);
    }
    }
    return 0;
}
void nx_svc_counts(char *out, size_t n) {
    size_t o = 0; out[0] = 0;
    for (int i = 0; i < 128 && o + 24 < n; i++) if (g_svc_count[i]) o += (size_t)snprintf(out + o, n - o, "%s%#x:%llu", o ? " " : "", i, (unsigned long long)g_svc_count[i]);
}

// ---- where each guest thread is, for the report: the pc at its last slice end, and the host call it is inside
static struct { _Atomic uint64_t pc, slices; _Atomic int in_host; _Atomic uint32_t handle; } g_trk[64];
static _Atomic int g_ntrk; static __thread int t_trk = -1;
uint32_t thr_cur_handle(void);
static int trk(void) { if (t_trk < 0) { t_trk = atomic_fetch_add(&g_ntrk, 1) & 63; } g_trk[t_trk].handle = thr_cur_handle(); return t_trk; }
EMSCRIPTEN_KEEPALIVE void nx_note_pc(double pc) { int k = trk(); g_trk[k].pc = (uint64_t)pc; g_trk[k].slices++; }

// ---- host calls
enum { MAX_STUB = 65536 };
static char *g_stub_name[MAX_STUB]; static const nx_hle_ent *g_stub_ent[MAX_STUB]; static _Atomic uint32_t g_stub_calls[MAX_STUB];
static uint64_t g_stub_base; static _Atomic int g_first_seq; static int g_nstub;
static _Atomic uint64_t g_host_calls, g_host_unported;
__attribute__((weak)) const nx_hle_ent *nx_hle_find(const char *mangled) { (void)mangled; return NULL; }   // the generated table of the HLE files in the build
// every name nxnative's host answers, built or not (generated: build.py hle_names): the loader has to bind them all to stubs
typedef struct { const char *name; uint32_t flags; } nx_hle_name;
__attribute__((weak)) const nx_hle_name nx_hle_names[1]; __attribute__((weak)) const unsigned nx_hle_names_n = 0;
EMSCRIPTEN_KEEPALIVE unsigned nx_hle_name_count(void) { return nx_hle_names_n; }
EMSCRIPTEN_KEEPALIVE double nx_hle_name_at(unsigned i) { return (double)(uintptr_t)nx_hle_names[i].name; }
EMSCRIPTEN_KEEPALIVE unsigned nx_hle_name_flags(unsigned i) { return nx_hle_names[i].flags; }
EMSCRIPTEN_KEEPALIVE void nx_stub_base_set(double base) { g_stub_base = (uint64_t)base; }
EMSCRIPTEN_KEEPALIVE void nx_stub_set(uint32_t id, double name_) {
    const char *name = (const char *)(uintptr_t)name_;
    if (id >= MAX_STUB) die("stub id %u", id);
    free(g_stub_name[id]); g_stub_name[id] = strdup(name); g_stub_ent[id] = nx_hle_find(name);
    if ((int)id >= g_nstub) g_nstub = (int)id + 1;
}
EMSCRIPTEN_KEEPALIVE int nx_hle_have(double name) { const nx_hle_ent *e = nx_hle_find((const char *)(uintptr_t)name); return e ? (int)e->flags : 0; }
EMSCRIPTEN_KEEPALIVE void nx_host_call(double ctx_) {
    uint64_t *regs = (uint64_t *)(uintptr_t)ctx_;
    uint64_t id = (regs[32] - g_stub_base) / 4;
    if (regs[32] < g_stub_base || id >= MAX_STUB || !g_stub_name[id]) { char w[64]; die("host call at pc %#llx (called from %s): not a stub", (unsigned long long)regs[32], nx_where(regs[30], w, sizeof w)); }
    atomic_fetch_add_explicit(&g_host_calls, 1, memory_order_relaxed);
    const nx_hle_ent *e = g_stub_ent[id];
    if (!atomic_fetch_add(&g_stub_calls[id], 1)) {
        char w[64]; int seq = atomic_fetch_add(&g_first_seq, 1) + 1;
        if (seq <= 400) LOG("%shost call #%d %s (thread %#x, from %s)%s", e && !(e->flags & NX_HLE_HAND) ? "" : "[RED] ", seq, g_stub_name[id], thr_cur_handle(), nx_where(regs[30], w, sizeof w),
                            !e ? ": not ported, answers 0" : e->flags & NX_HLE_HAND ? ": needs a hand-written thunk" : "");
    }
    regs[32] = regs[30];   // return to the caller (the thunk may still redirect)
    int k = trk(); g_trk[k].in_host = (int)id + 1;
    if (e) e->thunk(regs);
    else { atomic_fetch_add_explicit(&g_host_unported, 1, memory_order_relaxed); regs[0] = 0; }
    g_trk[k].in_host = 0;
}

// ---- what a boot run reports when it ends (by time, by a fault, by the guest)
void svc_thread_dump(void);
void nx_boot_report(const char *why) {
    static _Atomic int once; if (atomic_exchange(&once, 1)) return;
    char b[2000]; nx_svc_counts(b, sizeof b);
    struct nx_stats s; nx_get_stats(&s);
    LOG("==== boot report: %s, %.1f s after the start", why, (now_ns() - g_t0_ns) / 1e9);
    LOG("translated: %u units, %.1f MB of wasm, %llu requests, %.1f s in the translator", nx_unit_count(), s.unit_bytes / 1048576.0, (unsigned long long)s.translate_calls, s.translate_ns / 1e9);
    LOG("SVCs outside the thread kernel, by number: %s", b[0] ? b : "none");
    LOG("heap %llu MB; host calls %llu (%llu to functions that are not ported), %d distinct names", (unsigned long long)(nx_mem_heap_size() >> 20), (unsigned long long)g_host_calls, (unsigned long long)g_host_unported, (int)g_first_seq);
    int n = 0;
    for (int pass = 0; pass < 2; pass++) for (int i = 0; i < g_nstub && n < 60; i++) {
        if (!g_stub_calls[i] || (pass == 0) != (g_stub_ent[i] == NULL)) continue;
        if (pass == 0) { LOG("  not ported: %s x%u", g_stub_name[i], g_stub_calls[i]); n++; }
    }
    for (int i = 0; i < g_ntrk && i < 64; i++) {
        char w[64]; int h = g_trk[i].in_host;
        LOG("  thread %#x: %llu slices of translated code, last slice ended at %s%s%s", g_trk[i].handle, (unsigned long long)g_trk[i].slices, nx_where(g_trk[i].pc, w, sizeof w), h ? "; inside host call " : "", h ? g_stub_name[h - 1] : "");
    }
    svc_thread_dump();
}
