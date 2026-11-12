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
#include <unistd.h>

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
EMSCRIPTEN_KEEPALIVE int nx_mod_count(void) { return g_nmod; }
// 0 base, 1 size, 2 end of text, 3 offset of the read-only data, 4 of the data, 5 the name's address
EMSCRIPTEN_KEEPALIVE double nx_mod_field(int i, int f) {
    module_t *m = &g_mods[i];
    return f == 0 ? (double)(uintptr_t)m->base : f == 1 ? (double)m->size : f == 2 ? (double)m->text_end : f == 3 ? (double)m->ro_off : f == 4 ? (double)m->data_off : (double)(uintptr_t)m->name;
}
module_t *module_of(const void *p) {
    for (int i = 0; i < g_nmod; i++) if ((const uint8_t *)p >= g_mods[i].base && (const uint8_t *)p < g_mods[i].base + g_mods[i].size) return &g_mods[i];
    return NULL;
}
void *guest_sym(const char *name) { return (void *)(uintptr_t)nx_tr_job(1, (uint64_t)(uintptr_t)name); }   // the loader's symbol tables live in the translator thread's realm
// loader.c's services, answered from nxweb's loader (the translator thread's realm) and the mapped images
void *module_sym(module_t *m, const char *name) {
    uint64_t q[2] = {(uint64_t)(uintptr_t)name, (uint64_t)(m - g_mods)};
    return (void *)(uintptr_t)nx_tr_job(2, (uint64_t)(uintptr_t)q);
}
int dm_game_imports(const char *prefix) { return (int)nx_tr_job(3, (uint64_t)(uintptr_t)prefix); }
static const uint8_t *find_in(const module_t *m, const char *pat) {
    size_t n = strlen(pat);
    for (const uint8_t *p = m->base + m->ro_off, *e = m->base + m->size - n; p < e; p++) if (*p == (uint8_t)pat[0] && !memcmp(p, pat, n)) return p;
    return NULL;
}
static module_t *sdk_mod(void) { for (int i = 0; i < g_nmod; i++) if (!strcmp(g_mods[i].name, "sdk")) return &g_mods[i]; return NULL; }
int dm_sdk_ounce(void) { static int v = -1; if (v < 0) { module_t *m = sdk_mod(); v = m && find_in(m, "spec: Ounce") != NULL; } return v; }
int dm_sdk_major(void) {   // "NintendoSDK nnSdk-Generic_22_2_8-Release": the first number after nnSdk-
    static int v = -1;
    if (v < 0) { module_t *m = sdk_mod(); const uint8_t *p = m ? find_in(m, "nnSdk-") : NULL; v = 0;
        if (p) { p += 6; while (*p && (*p < '0' || *p > '9') && *p != ' ') p++; v = atoi((const char *)p); } }
    return v;
}

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
static _Atomic int g_stub_owner[MAX_STUB];   // 0 not asked, -1 none, else the owner realm's code for the name
static uint64_t g_stub_base; static _Atomic int g_first_seq; static int g_nstub;
static _Atomic uint64_t g_host_calls, g_host_unported, g_owner_calls, g_owner_ns;
#include <emscripten/threading.h>
void dm_host_lock(pthread_mutex_t *m);
// The request slot of the owner realm (kernel/nx_owner.js nx_owner_serve): one caller at a time, in arrival order.
// Emscripten's own synchronous proxy costs a wake-up of the main thread's event loop per call (measured: about 150 us
// under node); here the owner keeps watching the slot between the calls of a burst.
static struct { _Atomic uint32_t state; int32_t code; int32_t result; int32_t pad; double ctx; } g_slot;
static pthread_mutex_t g_slot_mu = PTHREAD_MUTEX_INITIALIZER; static int g_slot_on;
static int owner_request(int code, uint64_t *regs) {
    dm_host_lock(&g_slot_mu);   // a guest thread that waits here holds no guest core (hle_thread.c)
    if (!g_slot_on) { g_slot_on = 1; nx_owner_serve((double)(uintptr_t)&g_slot); }
    g_slot.code = code; g_slot.ctx = (double)(uintptr_t)regs;
    atomic_store(&g_slot.state, 1); emscripten_futex_wake(&g_slot.state, 1);
    for (int spin = 0; atomic_load(&g_slot.state) != 2; spin++) if (spin > 20000) emscripten_futex_wait(&g_slot.state, 1, 5.0);
    int r = g_slot.result;
    atomic_store(&g_slot.state, 0);
    pthread_mutex_unlock(&g_slot_mu);
    return r;
}
// A host call that one of nxweb's modules answers (owner/owner.ts): on the owner thread, in arrival order
static void owner_call(int code, uint64_t *regs) {
    uint64_t args[8], t0 = now_ns(); memcpy(args, regs, sizeof args);
    _Atomic uint32_t *cell = (_Atomic uint32_t *)((uint8_t *)regs + 0x3F0);
    for (;;) {
        int r = owner_request(code, regs);
        if (r == 0) break;
        if (r == 1) { while (!atomic_load(cell)) emscripten_futex_wait(cell, 0, 1e9); break; }   // pending: the owner sets the cell when the storage answered
        memcpy(regs, args, sizeof args); usleep(200);                                             // retry: busy with another thread's pending call
    }
    atomic_fetch_add_explicit(&g_owner_calls, 1, memory_order_relaxed); atomic_fetch_add_explicit(&g_owner_ns, now_ns() - t0, memory_order_relaxed);
}
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
// ---- host functions the guest is given as addresses (a thread entry the host starts: hle_guestthread.c): stubs 40000..40255
enum { HOSTFN_BASE = 40000, HOSTFN_MAX = 256 };
static void (*g_hostfn[HOSTFN_MAX])(void *); static _Atomic int g_nhostfn; static pthread_mutex_t g_hostfn_mu = PTHREAD_MUTEX_INITIALIZER;
uint64_t nx_host_entry(void (*fn)(void *)) {
    pthread_mutex_lock(&g_hostfn_mu);
    int i = 0; for (; i < g_nhostfn; i++) if (g_hostfn[i] == fn) break;
    if (i == g_nhostfn) { if (i == HOSTFN_MAX) die("more than %d host functions given to the guest", HOSTFN_MAX); g_hostfn[i] = fn; g_nhostfn = i + 1; }
    pthread_mutex_unlock(&g_hostfn_mu);
    return g_stub_base + 4ull * (uint64_t)(HOSTFN_BASE + i);
}

EMSCRIPTEN_KEEPALIVE void nx_host_call(double ctx_) {
    uint64_t *regs = (uint64_t *)(uintptr_t)ctx_;
    uint64_t id = (regs[32] - g_stub_base) / 4;
    if (regs[32] >= g_stub_base && id >= HOSTFN_BASE && id < HOSTFN_BASE + (uint64_t)g_nhostfn) {   // a host function the guest was given by address
        void (*fn)(void *) = g_hostfn[id - HOSTFN_BASE];
        regs[32] = regs[30];
        fn((void *)(uintptr_t)regs[0]);
        return;
    }
    if (regs[32] >= g_stub_base && id < MAX_STUB && !g_stub_name[id]) {   // not a stub of the loader's: one the owner realm handed out (an NVN entry point)?
        int code = nx_owner_stub((int)id);
        if (code) { char nm[128]; nx_owner_stub_name((int)id, (double)(uintptr_t)nm, sizeof nm); g_stub_owner[id] = code; g_stub_name[id] = strdup(nm); if ((int)id >= g_nstub) g_nstub = (int)id + 1; }
    }
    if (regs[32] < g_stub_base || id >= MAX_STUB || !g_stub_name[id]) { char w[64]; die("host call at pc %#llx (called from %s): not a stub", (unsigned long long)regs[32], nx_where(regs[30], w, sizeof w)); }
    atomic_fetch_add_explicit(&g_host_calls, 1, memory_order_relaxed);
    const nx_hle_ent *e = g_stub_ent[id];
    int own = g_stub_owner[id];
    if (!own) { own = nx_owner_lookup((double)(uintptr_t)g_stub_name[id]); g_stub_owner[id] = own = own ? own : -1; }   // nxweb's module wins where both have the name: its back end is the one that exists here
    if (own > 0) e = NULL;
    if (!atomic_fetch_add(&g_stub_calls[id], 1)) {
        char w[64]; int seq = atomic_fetch_add(&g_first_seq, 1) + 1;
        if (own > 0) { if (seq <= 60) LOG("host call #%d %s (thread %#x, from %s): nxweb's module, on the owner thread", seq, g_stub_name[id], thr_cur_handle(), nx_where(regs[30], w, sizeof w)); }
        else if (seq <= 400) LOG("%shost call #%d %s (thread %#x, from %s)%s", e && !(e->flags & NX_HLE_HAND) ? "" : "[RED] ", seq, g_stub_name[id], thr_cur_handle(), nx_where(regs[30], w, sizeof w),
                            !e ? ": not ported, answers 0" : e->flags & NX_HLE_HAND ? ": needs a hand-written thunk" : "");
    }
    regs[32] = regs[30];   // return to the caller (the thunk may still redirect)
    int k = trk(); g_trk[k].in_host = (int)id + 1;
    if (own > 0) owner_call(own, regs);
    else if (e) e->thunk(regs);
    else { atomic_fetch_add_explicit(&g_host_unported, 1, memory_order_relaxed); regs[0] = 0; }
    g_trk[k].in_host = 0;
}

// One line of progress (the boot harness prints it every 30 s): is the game still getting on
extern _Atomic uint64_t nx_stat_svcs;
// This process's resident and swapped memory in MB (Linux /proc; 0 elsewhere)
void nx_rss_mb(int *rss, int *swap) {
    *rss = *swap = 0; FILE *f = fopen("/proc/self/status", "r"); if (!f) return;
    char l[160]; while (fgets(l, sizeof l, f)) { if (!strncmp(l, "VmRSS:", 6)) *rss = atoi(l + 6) / 1024; else if (!strncmp(l, "VmSwap:", 7)) *swap = atoi(l + 7) / 1024; }
    fclose(f);
}
// Resident MB of the linear memory itself (the largest mapping: guest memory, Emscripten's heap, the registry), from /proc/self/smaps
static int linear_rss_mb(void) {
    FILE *f = fopen("/proc/self/smaps", "r"); if (!f) return 0;
    char l[256]; unsigned long long a, b, best = 0; long rss = 0; int in = 0;
    while (fgets(l, sizeof l, f)) {
        if (sscanf(l, "%llx-%llx ", &a, &b) == 2 && strchr(l, '-') < l + 20 && l[0] != 'R') { in = b - a >= (8ull << 30); if (in && b - a > best) best = b - a; }
        else if (in && !strncmp(l, "Rss:", 4)) rss += atol(l + 4);
    }
    fclose(f); return (int)(rss / 1024);
}
// Where the process's memory is, by kind of mapping (Linux): executable = compiled code, large = the linear memory, the rest by size class
static void smaps_report(void) {
    FILE *f = fopen("/proc/self/smaps", "r"); if (!f) return;
    char l[256], perm[8] = ""; unsigned long long a, b, size = 0; long kb;
    long exec = 0, lin = 0, big = 0, mid = 0, small = 0, file = 0; int nbig = 0, nmid = 0, nsmall = 0, isfile = 0;
    while (fgets(l, sizeof l, f)) {
        char p4[8]; unsigned long long off; char dev[16]; unsigned long ino;
        if (sscanf(l, "%llx-%llx %7s %llx %15s %lu", &a, &b, p4, &off, dev, &ino) == 6) { size = b - a; snprintf(perm, sizeof perm, "%s", p4); isfile = ino != 0; }
        else if (sscanf(l, "Rss: %ld kB", &kb) == 1) {
            if (isfile) file += kb; else if (perm[2] == 'x') exec += kb; else if (size >= (8ull << 30)) lin += kb;
            else if (size >= (64ull << 20)) { big += kb; nbig += kb > 0; } else if (size >= (1ull << 20)) { mid += kb; nmid += kb > 0; } else { small += kb; nsmall += kb > 0; }
        }
    }
    fclose(f);
    LOG("memory by mapping: linear memory %ld MB; executable (compiled code) %ld MB; anonymous >= 64 MB: %ld MB in %d; 1..64 MB: %ld MB in %d; < 1 MB: %ld MB in %d; files %ld MB", lin >> 10, exec >> 10, big >> 10, nbig, mid >> 10, nmid, small >> 10, nsmall, file >> 10);
}
void nx_progress(void) {
    double os[12] = {0}; nx_owner_stats((double)(uintptr_t)os);
    struct nx_stats s; nx_get_stats(&s); char w[64] = "?"; uint64_t sl = 0; int h = 0;
    for (int i = 0; i < g_ntrk && i < 64; i++) if (g_trk[i].handle == 0x1001) { nx_where(g_trk[i].pc, w, sizeof w); sl = g_trk[i].slices; h = g_trk[i].in_host; }
    int rss, swp; nx_rss_mb(&rss, &swp);
    LOG("memory: process %d MB resident (of it the linear memory %d MB) + %d MB swapped; guest: alias region %llu MB mapped, heap %llu MB set; translated wasm %llu MB", rss, linear_rss_mb(), swp, (unsigned long long)(nx_mem_alias_mapped() >> 20), (unsigned long long)(nx_mem_heap_size() >> 20), (unsigned long long)(s.unit_bytes >> 20));
    LOG("progress %4.0f s: %llu SVCs, %llu host calls (%0.f NVN, %0.f fs), %0.f submits, %0.f presents, %u units translated, threads created %d; main thread: %llu slices, at %s%s%s", (now_ns() - g_t0_ns) / 1e9,
        (unsigned long long)nx_stat_svcs, (unsigned long long)g_host_calls, os[10], os[0], os[8], os[7], nx_unit_count(), (int)g_ntrk, (unsigned long long)sl, w, h ? " in " : "", h ? g_stub_name[h - 1] : "");
}

// ---- what a boot run reports when it ends (by time, by a fault, by the guest)
void svc_thread_dump(void);
void nx_boot_report(const char *why) {
    static _Atomic int once; if (atomic_exchange(&once, 1)) return;
    smaps_report();
    nx_tr_job(5, 0); { double os[12] = {0}; os[11] = 1; nx_owner_stats((double)(uintptr_t)os); }   // where the JS side's memory is
    if (getenv("NX_CACHE")) nx_tr_job(4, 0);   // keep what this run translated
    char b[2000]; nx_svc_counts(b, sizeof b);
    struct nx_stats s; nx_get_stats(&s);
    LOG("==== boot report: %s, %.1f s after the start", why, (now_ns() - g_t0_ns) / 1e9);
    LOG("translated: %u units, %.1f MB of wasm, %llu requests, %.1f s in the translator", nx_unit_count(), s.unit_bytes / 1048576.0, (unsigned long long)s.translate_calls, s.translate_ns / 1e9);
    LOG("SVCs outside the thread kernel, by number: %s", b[0] ? b : "none");
    LOG("heap %llu MB; host calls %llu (%llu to functions that are not ported), %d distinct names", (unsigned long long)(nx_mem_heap_size() >> 20), (unsigned long long)g_host_calls, (unsigned long long)g_host_unported, (int)g_first_seq);
    { double os[12] = {0}; nx_owner_stats((double)(uintptr_t)os);
      LOG("graphics (nxweb's recorder on the owner thread): %.0f host calls of it (%.0f NVN calls recorded, %.0f waited), %.1f us each inside; host stream %.0f batches, %.1f MB; presents %.0f", os[4], os[10], os[6], os[4] ? os[5] / 1e3 / os[4] : 0.0, os[8], os[9] / 1048576, os[7]);
      LOG("owner thread: %llu proxied calls, %.1f us each on the caller's side; nn::fs %0.f calls (%0.f pending, %0.f retried), %.1f us each inside the module", (unsigned long long)g_owner_calls,
          g_owner_calls ? g_owner_ns / 1e3 / g_owner_calls : 0.0, os[0], os[1], os[2], os[0] ? os[3] / 1e3 / os[0] : 0.0); }
    int n = 0;
    for (int pass = 0; pass < 2; pass++) for (int i = 0; i < g_nstub && n < 60; i++) {
        if (!g_stub_calls[i] || g_stub_owner[i] > 0 || (pass == 0) != (g_stub_ent[i] == NULL)) continue;
        if (pass == 0) { LOG("  not ported: %s x%u", g_stub_name[i], g_stub_calls[i]); n++; }
    }
    for (int i = 0; i < g_ntrk && i < 64; i++) {
        char w[64]; int h = g_trk[i].in_host;
        LOG("  thread %#x: %llu slices of translated code, last slice ended at %s%s%s", g_trk[i].handle, (unsigned long long)g_trk[i].slices, nx_where(g_trk[i].pc, w, sizeof w), h ? "; inside host call " : "", h ? g_stub_name[h - 1] : "");
    }
    svc_thread_dump();
}
