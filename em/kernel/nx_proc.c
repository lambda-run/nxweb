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

int thr_limit_used(void);
EMSCRIPTEN_KEEPALIVE int nx_live_threads(void) { return thr_limit_used(); }   // live guest threads (the page's runtime label)

// The page's keyboard and first controller, for nxnative's hle_hid.c (its front-end paths dm_input_set / dm_pad_set:
// atomics, any thread). NpadButton bits and sticks of +-32767 as dm_input.h.
__attribute__((weak)) void dm_input_set(uint64_t buttons, int32_t lx, int32_t ly, int32_t rx, int32_t ry);
__attribute__((weak)) void dm_pad_set(uint64_t buttons, int32_t lx, int32_t ly, int32_t rx, int32_t ry);
EMSCRIPTEN_KEEPALIVE void nx_input(int controller, double buttons, int lx, int ly, int rx, int ry) {
    if (controller) { if (dm_pad_set) dm_pad_set((uint64_t)buttons, lx, ly, rx, ry); }
    else if (dm_input_set) dm_input_set((uint64_t)buttons, lx, ly, rx, ry);
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

// The system counter (`mrs cntpct_el0`, the translated code's cntpct import; svc GetSystemTick): hle_os.c's guest_ticks,
// 31.25 MHz for a Switch 2 SDK (which converts with that rate whatever CNTFRQ_EL0 says), 19.2 MHz otherwise. Until
// 2026-11-12 the port answered 19.2 MHz to this game: its clock ran at 61 % of real time (a 24 pictures/s movie at
// about 15). A local read: no lock, no proxy. Each read counts on the reading thread (guest_clock_read_wait: thr_yield
// tells a wait for a time by it).
__attribute__((weak)) void guest_clock_read_wait(void);
__attribute__((weak)) uint64_t guest_ticks(void);
// the guest clock in ns for the owner realm (NVN timestamps and counter reports are stamped on it: owner/owner.ts RtShim.guestNs)
EMSCRIPTEN_KEEPALIVE double nx_guest_ns_d(void) { return (double)guest_ns(); }
EMSCRIPTEN_KEEPALIVE double nx_cntpct(void) {
    if (guest_clock_read_wait) guest_clock_read_wait();
    return guest_ticks ? (double)guest_ticks() : (double)(guest_ns() / 625 * 12 + guest_ns() % 625 * 12 / 625);
}

// ---- files for the translation cache (kernel/nx_guest.js): Node's files, or the page's in-memory /cache
#include <sys/stat.h>
EMSCRIPTEN_KEEPALIVE double nx_cache_dir(void) {
    const char *e = getenv("NX_CACHE"); struct stat st;
    if (e) return (double)(uintptr_t)e;
    return (double)(uintptr_t)(stat("/cache", &st) == 0 ? "/cache" : "");
}
EMSCRIPTEN_KEEPALIVE double nx_file_read(double path, double len_out) {   // the file's bytes (malloc), 0 when there is none
    FILE *f = fopen((const char *)(uintptr_t)path, "rb"); if (!f) return 0;
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *p = n > 0 ? malloc((size_t)n) : NULL;
    if (p && fread(p, 1, (size_t)n, f) != (size_t)n) { free(p); p = NULL; }
    fclose(f);
    if (p && !getenv("NX_CACHE")) remove((const char *)(uintptr_t)path);   // the page's copy in memory: read once
    *(uint64_t *)(uintptr_t)len_out = p ? (uint64_t)n : 0;
    return (double)(uintptr_t)p;
}
EMSCRIPTEN_KEEPALIVE int nx_file_write(double path, double data, double len) {
    char tmp[600]; snprintf(tmp, sizeof tmp, "%s.tmp", (const char *)(uintptr_t)path);
    FILE *f = fopen(tmp, "wb"); if (!f) return 0;
    int ok = fwrite((const void *)(uintptr_t)data, 1, (size_t)len, f) == (size_t)len;
    ok = !fclose(f) && ok;
    return ok && !rename(tmp, (const char *)(uintptr_t)path);
}

// ---- SVCs
static _Atomic uint64_t g_svc_count[128];
__attribute__((weak)) int nx_svc_other(int num, uint64_t *regs) {   // weak: proof 2 answers the test guests' SVCs itself
    if (num >= 0 && num < 128) atomic_fetch_add_explicit(&g_svc_count[num], 1, memory_order_relaxed);
    if (nx_mem_svc(num, regs)) return 1;
    switch (num) {
    case 0x1E: regs[0] = 0; regs[1] = (uint64_t)nx_cntpct(); return 1;            // GetSystemTick: the same counter
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
// Where each guest thread's wall-clock time goes (nx_acc_add; the page's status line and the harness print the main
// thread's and the busiest others' per frame: a sum over threads hides the critical path). Guest code is what is left
// of the wall clock. The categories from A_WAIT0 on are time the thread did not run: "host cores busy" is the rest.
enum { A_GFX_CALL, A_HLE, A_SVC, A_TRANSLATE, A_WAIT0, A_SLEEP = A_WAIT0, A_WAITSYNC, A_LOCK, A_CV, A_ADDR, A_GFX_LOCK, A_FLUSH, A_OWNER, A_FS, A_N };
static const char *const g_acc_name[A_N] = {"NVN", "host", "svc", "translate", "sleep/yield", "wait-sync", "lock", "condvar", "wait-addr", "NVN-lock", "flush", "owner", "fs"};
enum { NTRK = 256 };
static struct { _Atomic uint64_t pc, slices; _Atomic int in_host; _Atomic uint32_t handle; _Atomic uint64_t acc[A_N], born; uint64_t seen[2][A_N], seen_at[2], seen_slices[2]; char name[28]; } g_trk[NTRK];
static _Atomic int g_ntrk; static __thread int t_trk = -1;
static int trk(void);
int thr_name_of(pthread_t pt, char *out, size_t n);
EMSCRIPTEN_KEEPALIVE void nx_acc_add(int cat, double ns) { if (cat >= 0 && cat < A_N && ns > 0) atomic_fetch_add_explicit(&g_trk[trk()].acc[cat], (uint64_t)ns, memory_order_relaxed); }
// out: one line. frames: presents in the interval (0: per second). Called from one thread at a time (the page's status timer, the harness's progress)
EMSCRIPTEN_KEEPALIVE double nx_thread_split(double out_, int n, double frames, int who) {   // who: 0 the page's status timer, 1 the progress line (each has its own "since last time")
    char *out = (char *)(uintptr_t)out_; size_t o = 0; uint64_t now = nx_now_ns(); double busy_all = 0, wall_all = 0;
    struct { int i; double busy, wall, d[A_N]; } top[4] = {{-1}, {-1}, {-1}, {-1}};
    for (int i = 0; i < g_ntrk && i < NTRK; i++) {
        uint64_t born = g_trk[i].born, at = g_trk[i].seen_at[who] ? g_trk[i].seen_at[who] : born; if (!born || now <= at) continue;
        double wall = (double)(now - at), blocked = 0, d[A_N];
        for (int c = 0; c < A_N; c++) { uint64_t v = g_trk[i].acc[c]; d[c] = (double)(v - g_trk[i].seen[who][c]); g_trk[i].seen[who][c] = v; if (c >= A_WAIT0) blocked += d[c]; }
        g_trk[i].seen_at[who] = now;
        { uint64_t sl = g_trk[i].slices; double any = 0; for (int c = 0; c < A_N; c++) any += d[c];   // a pool worker without a guest thread (or a thread that has exited) did nothing at all: not counted
          int idle = any == 0 && sl == g_trk[i].seen_slices[who]; g_trk[i].seen_slices[who] = sl; if (idle) continue; }
        double busy = wall > blocked ? wall - blocked : 0; busy_all += busy; wall_all = wall > wall_all ? wall : wall_all;
        int slot = g_trk[i].handle == 0x1001 ? 0 : -1;
        if (slot < 0) for (int k = 1; k < 4; k++) if (top[k].i < 0 || busy > top[k].busy) { for (int j = 3; j > k; j--) top[j] = top[j - 1]; slot = k; break; }
        if (slot >= 0) { top[slot].i = i; top[slot].busy = busy; top[slot].wall = wall; memcpy(top[slot].d, d, sizeof d); }
    }
    double per = frames > 0 ? frames : wall_all / 1e9; if (per <= 0) per = 1;
    for (int k = 0; k < 4 && o + 200 < (size_t)n; k++) {
        if (top[k].i < 0) continue;
        double other = 0; for (int c = 0; c < A_N; c++) other += top[k].d[c];
        o += (size_t)snprintf(out + o, (size_t)n - o, "%s%s: guest %.1f", k ? " | " : "", g_trk[top[k].i].name[0] ? g_trk[top[k].i].name : "?", (top[k].wall > other ? top[k].wall - other : 0) / 1e6 / per);
        for (int c = 0; c < A_N && o + 40 < (size_t)n; c++) if (top[k].d[c] / 1e6 / per >= 0.05) o += (size_t)snprintf(out + o, (size_t)n - o, " %s %.1f", g_acc_name[c], top[k].d[c] / 1e6 / per);
    }
    if (o < (size_t)n) out[o] = 0;
    return wall_all > 0 ? busy_all / wall_all : 0;   // guest threads running at once, on average: host cores busy with them
}
uint32_t thr_cur_handle(void);
static int trk(void) {
    if (t_trk < 0) { t_trk = atomic_fetch_add(&g_ntrk, 1) & (NTRK - 1); g_trk[t_trk].born = nx_now_ns(); }
    uint32_t h = thr_cur_handle();
    if (g_trk[t_trk].handle != h || !g_trk[t_trk].name[0]) { g_trk[t_trk].handle = h; char nm[96] = ""; thr_name_of(pthread_self(), nm, sizeof nm); snprintf(g_trk[t_trk].name, sizeof g_trk[t_trk].name, "%s", nm); }
    return t_trk;
}
EMSCRIPTEN_KEEPALIVE void nx_note_pc(double pc) { int k = trk(); g_trk[k].pc = (uint64_t)pc; g_trk[k].slices++; nx_core_yield(); }   // a slice end: a waiting thread of this core gets it

// ---- the last SVCs and host calls of each thread (as nxweb's fault report keeps them): dumped for the thread that aborts
enum { RING = 64 };
typedef struct { int32_t kind, num; uint64_t a[3], ret, lr; } ring_ent;   // (num was 16 bits until 8d733f4: the stubs the owner hands out, 65535 downwards, printed as '?')   // kind 0 SVC (num), 1 host call (num = stub id)
static __thread ring_ent t_ring[RING]; static __thread unsigned t_ring_n;
static char *g_stub_name_of(int id);
void nx_ring_note(int kind, int num, const uint64_t *in, uint64_t ret, uint64_t lr) {
    ring_ent *e = &t_ring[t_ring_n++ % RING];
    e->kind = kind; e->num = num; e->a[0] = in[0]; e->a[1] = in[1]; e->a[2] = in[2]; e->ret = ret; e->lr = lr;
}
int thr_name_of(pthread_t pt, char *out, size_t n);
void nx_ring_dump(const char *why) {
    char nm[96] = "?", w[64]; thr_name_of(pthread_self(), nm, sizeof nm);
    LOG("[RED] %s on thread %s: its last %u SVCs and host calls, oldest first (arguments x0..x2 as entered, then the result):", why, nm, t_ring_n < RING ? t_ring_n : RING);
    for (unsigned i = t_ring_n < RING ? 0 : t_ring_n - RING; i < t_ring_n; i++) {
        ring_ent *e = &t_ring[i % RING];
        if (e->kind) LOG("  host %s(%#llx, %#llx, %#llx) = %#llx   from %s", g_stub_name_of(e->num), (unsigned long long)e->a[0], (unsigned long long)e->a[1], (unsigned long long)e->a[2], (unsigned long long)e->ret, nx_where(e->lr, w, sizeof w));
        else LOG("  svc %#x(%#llx, %#llx, %#llx) = %#llx   from %s", e->num, (unsigned long long)e->a[0], (unsigned long long)e->a[1], (unsigned long long)e->a[2], (unsigned long long)e->ret, nx_where(e->lr, w, sizeof w));
    }
}

// ---- host calls
enum { MAX_STUB = 65536 };
static char *g_stub_name[MAX_STUB]; static const nx_hle_ent *g_stub_ent[MAX_STUB]; static _Atomic uint32_t g_stub_calls[MAX_STUB];
static _Atomic int g_stub_direct[MAX_STUB];   // 0 not asked, -1 no, else nx_gfx_direct's code: the calling thread answers it in its instance of the recorder
static uint8_t g_stub_texinit[MAX_STUB];    // nvnTextureInitialize: its builder's size is looked at
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
static uint64_t g_slot_queue_ns, g_slot_serve_ns, g_slot_n;
static _Atomic int g_slot_waiting; static _Atomic uint64_t g_slot_depth[8];   // callers at the slot when one arrives: 0, 1, 2, 3, 4-7, 8-15, 16-31, 32+
// For the page's frame split (main thread): out = requests, ns waiting for the slot, ns from request to answer, then the 8 depth counts
EMSCRIPTEN_KEEPALIVE void nx_slot_stats(double out_) { double *o = (double *)(uintptr_t)out_; o[0] = (double)g_slot_n; o[1] = (double)g_slot_queue_ns; o[2] = (double)g_slot_serve_ns; for (int i = 0; i < 8; i++) o[3 + i] = (double)g_slot_depth[i]; }   // waiting for the slot (behind other threads); from the request to its answer
// The owner starts watching the request slot and the two modules' holder requests (kernel/nx_owner.js nx_owner_serve):
// before the first of either. (Until f09b22b only the first slot request started it: with nn::fs on the calling thread
// the first thing asked of the owner is a storage read, which nobody watched for: the boot hung in MountRom.)
static pthread_once_t g_serve_once = PTHREAD_ONCE_INIT;
static void serve_start(void) { g_slot_on = 1; nx_owner_serve((double)(uintptr_t)&g_slot); }
static void owner_serve_start(void) { pthread_once(&g_serve_once, serve_start); }
static int owner_request(int code, uint64_t *regs) {
    int gl = nx_gfx_release_all();   // (a callback of the recorder into guest code that asks the owner for something)
    nx_core_release();   // waiting for the owner thread is not running: the caller's core is free (taken again at the end of the host call)
    uint64_t t0 = now_ns();
    { int d = atomic_fetch_add(&g_slot_waiting, 1); atomic_fetch_add_explicit(&g_slot_depth[d < 4 ? d : d < 8 ? 4 : d < 16 ? 5 : d < 32 ? 6 : 7], 1, memory_order_relaxed); }
    dm_host_lock(&g_slot_mu);   // a guest thread that waits here holds no guest core (hle_thread.c)
    uint64_t t1 = now_ns();
    owner_serve_start();
    g_slot.code = code; g_slot.ctx = (double)(uintptr_t)regs;
    atomic_store(&g_slot.state, 1); emscripten_futex_wake(&g_slot.state, 1);
    for (int spin = 0; atomic_load(&g_slot.state) != 2; spin++) if (spin > 20000) emscripten_futex_wait(&g_slot.state, 1, 5.0);
    int r = g_slot.result;
    atomic_store(&g_slot.state, 0);
    atomic_fetch_sub(&g_slot_waiting, 1);
    g_slot_queue_ns += t1 - t0; g_slot_serve_ns += now_ns() - t1; g_slot_n++;   // (under the slot's lock)
    pthread_mutex_unlock(&g_slot_mu);
    nx_gfx_reacquire(gl);
    return r;
}
// A host call that one of nxweb's modules answers (owner/owner.ts): on the owner thread, in arrival order
void nx_owner_do(int code, uint64_t *regs) {
    uint64_t args[8], t0 = now_ns(); memcpy(args, regs, sizeof args);
    _Atomic uint32_t *cell = (_Atomic uint32_t *)((uint8_t *)regs + 0x3F0);
    for (;;) {
        int r = owner_request(code, regs);
        if (r == 0) break;
        if (r == 1) { nx_core_release(); while (!atomic_load(cell)) emscripten_futex_wait(cell, 0, 1e9); break; }   // pending: the owner sets the cell when the storage answered
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

// The registers of a thread that stops (an abort it called, a fault) and where its frames return to
void nx_regs_dump(const uint64_t *regs, const char *what) {
    char w[64];
    LOG("  registers at %s: pc=%#llx (%s) lr=%#llx sp=%#llx", what, (unsigned long long)regs[32], nx_where(regs[32], w, sizeof w), (unsigned long long)regs[30], (unsigned long long)regs[31]);
    for (int i = 0; i < 30; i += 5) LOG("    x%-2d=%#llx x%-2d=%#llx x%-2d=%#llx x%-2d=%#llx x%-2d=%#llx", i, (unsigned long long)regs[i], i + 1, (unsigned long long)regs[i + 1], i + 2, (unsigned long long)regs[i + 2], i + 3, (unsigned long long)regs[i + 3], i + 4, (unsigned long long)regs[i + 4]);
    LOG("  frame 0: return to %s", nx_where(regs[30], w, sizeof w));
    if (strcmp(what, "the fault") == 0) {
        // what the registers point at (a fault report has to say what the data was): 0x140 bytes for the callee-saved ones, 0x40 for the rest
        for (int i = 0; i <= 31; i++) {
            uint64_t a = regs[i] & ~7ull; int n = i >= 19 && i <= 28 ? 0x140 : i == 31 ? 0x100 : 0x40;
            if (i == 29 || i == 30 || a < 0x8000000 || a + (uint64_t)n > (14ull << 30)) continue;
            for (int o = 0; o < n; o += 32) { const uint32_t *p = (const uint32_t *)(uintptr_t)(a + (uint64_t)o);
                LOG("    [%s%d %#llx +%03x] %08x %08x %08x %08x %08x %08x %08x %08x", i == 31 ? "sp" : "x", i == 31 ? 0 : i, (unsigned long long)a, o, p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7]); }
        }
        for (int i = 0; i < 32; i += 2) LOG("    v%-2d=%016llx:%016llx v%-2d=%016llx:%016llx", i, (unsigned long long)regs[39 + 2 * i], (unsigned long long)regs[38 + 2 * i], i + 1, (unsigned long long)regs[41 + 2 * i], (unsigned long long)regs[40 + 2 * i]);
    }
    uint64_t fp = regs[29];
    for (int k = 1; k < 16 && fp > 0x8000000 && fp < (16ull << 30) && !(fp & 7); k++) { uint64_t *f = (uint64_t *)(uintptr_t)fp; LOG("  frame %d: return to %s", k, nx_where(f[1], w, sizeof w)); if (f[0] <= fp) break; fp = f[0]; }
}
// nvnTextureInitialize(texture, builder): a size no device has (the replayer's WebGPU error "Texture size (65535 x 65535 x 1)
// exceeded maximum" was seen in the page) is reported with who asked and what the builder holds. The builder is the
// recorder's (nxweb src/gfx/obj.ts tex_builder_t): +8 target, +12 format, +16 flags, +20 samples, +24 width, +28 height, +32 depth, +36 levels, +40 stride
static _Atomic int g_tex_guard_n;
static void tex_guard(const uint64_t *regs) {
    const uint32_t *b = (const uint32_t *)(uintptr_t)regs[1];
    if (!b || (b[6] <= 16384 && b[7] <= 16384 && b[8] <= 16384)) return;
    int n = atomic_fetch_add(&g_tex_guard_n, 1);
    if (n >= 8) return;
    char nm[96] = "?", w[64]; int thr_name_of(pthread_t pt, char *out, size_t n_); thr_name_of(pthread_self(), nm, sizeof nm);
    LOG("[RED] nvnTextureInitialize: a texture of %u x %u x %u asked by thread %s from %s: texture %#llx, builder %#llx { device %#llx, target %u, format %u, flags %#x, samples %u, levels %u, stride %u, pool %#llx + %#llx }",
        b[6], b[7], b[8], nm, nx_where(regs[30], w, sizeof w), (unsigned long long)regs[0], (unsigned long long)regs[1], (unsigned long long)*(const uint64_t *)b, b[2], b[3], b[4], b[5], b[9], b[10],
        (unsigned long long)*(const uint64_t *)(b + 12), (unsigned long long)*(const uint64_t *)(b + 14));
    { char hex[200]; int o = 0; for (int i = 0; i < 24; i++) o += snprintf(hex + o, sizeof hex - (size_t)o, "%08x ", b[i]); LOG("  the builder's 96 bytes: %s", hex); }
    if (n < 3) { nx_ring_dump("an oversized texture"); nx_regs_dump(regs, "the call"); }
}
static char *g_stub_name_of(int id) { return id >= 0 && id < MAX_STUB && g_stub_name[id] ? g_stub_name[id] : "?"; }
EMSCRIPTEN_KEEPALIVE void nx_host_call(double ctx_) {
    uint64_t *regs = (uint64_t *)(uintptr_t)ctx_;
    uint64_t id = (regs[32] - g_stub_base) / 4;
    if (regs[32] >= g_stub_base && id >= HOSTFN_BASE && id < HOSTFN_BASE + (uint64_t)g_nhostfn) {   // a host function the guest was given by address
        void (*fn)(void *) = g_hostfn[id - HOSTFN_BASE];
        regs[32] = regs[30];
        fn((void *)(uintptr_t)regs[0]);
        nx_core_ensure();
        return;
    }
    if (regs[32] >= g_stub_base && id < MAX_STUB && !g_stub_name[id]) {   // not a stub of the loader's: one the owner realm handed out (an NVN entry point)?
        int code = nx_owner_stub((int)id);
        if (code) { char nm[128]; nx_owner_stub_name((int)id, (double)(uintptr_t)nm, sizeof nm); g_stub_owner[id] = code; g_stub_texinit[id] = !strcmp(nm, "nvnTextureInitialize"); g_stub_name[id] = strdup(nm); if ((int)id >= g_nstub) g_nstub = (int)id + 1; }
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
    uint64_t in[3] = {regs[0], regs[1], regs[2]};
    if (g_stub_texinit[id]) tex_guard(regs);
    if ((strstr(g_stub_name[id], "Abort") || strstr(g_stub_name[id], "abort")) && !strstr(g_stub_name[id], "Observer")) {   // the game gives up: what led to it
        nx_ring_dump(g_stub_name[id]);
        nx_regs_dump(regs, "the abort");
#if 0
        LOG("  registers at the abort: x0=%#llx x1=%#llx x2=%#llx x3=%#llx x8=%#llx x19=%#llx x20=%#llx x21=%#llx x22=%#llx x29=%#llx lr=%#llx sp=%#llx", (unsigned long long)regs[0], (unsigned long long)regs[1], (unsigned long long)regs[2], (unsigned long long)regs[3], (unsigned long long)regs[8],
            (unsigned long long)regs[19], (unsigned long long)regs[20], (unsigned long long)regs[21], (unsigned long long)regs[22], (unsigned long long)regs[29], (unsigned long long)regs[30], (unsigned long long)regs[31]);
        { uint64_t fp = regs[29]; char w2[64]; for (int k = 0; k < 10 && fp > 0x8000000 && fp < (16ull << 30) && !(fp & 7); k++) { uint64_t *f = (uint64_t *)(uintptr_t)fp; LOG("  frame %d: return to %s", k, nx_where(f[1], w2, sizeof w2)); if (f[0] <= fp) break; fp = f[0]; } }
#endif
    }
    { void nx_yield_reset(void); nx_yield_reset(); }   // a thread that makes host calls between its yields is working
    int k = trk(); g_trk[k].in_host = (int)id + 1;
    uint64_t hc0 = nx_now_ns(); int hcat = A_HLE;
    int direct = own > 0 ? g_stub_direct[id] : -1;
    if (!direct) { direct = nx_gfx_enabled() ? nx_owner_stub_direct((int)id) : 0; g_stub_direct[id] = direct = direct ? direct : -1; }
    if (direct > 0) { hcat = -1; nx_gfx_direct(direct, regs); }   // (it accounts for itself: the call, the lock, the flush)
    else if (own > 0 && own >> 24 == 1 && nx_fs_enabled()) { hcat = A_FS; owner_serve_start(); nx_core_release(); nx_fs_direct(own & 0xFFFFFF, regs); }
    else if (own > 0) { hcat = own >> 24 == 1 ? A_FS : A_OWNER; if (own >> 24 == 1) nx_core_release();   // nn::fs is a service on the console: the caller's core is free while it is served
                   nx_owner_do(own, regs); }
    else if (e && !(e->flags & NX_HLE_HAND)) { if (nx_core_excl()) nx_core_release();   // (host code may wait in ways the kernel does not see: the audio renderer's host call never returns, nnsocketPoll sleeps. Its core is free meanwhile)
                                               e->thunk(regs); }   // (one that needs a hand-written thunk answers 0 until it has it)
    else { atomic_fetch_add_explicit(&g_host_unported, 1, memory_order_relaxed); regs[0] = 0; }
    g_trk[k].in_host = 0;
    if (hcat >= 0) atomic_fetch_add_explicit(&g_trk[k].acc[hcat], nx_now_ns() - hc0, memory_order_relaxed);
    nx_ring_note(1, (int)id, in, regs[0], in[0] == regs[0] ? regs[30] : regs[30]);
    nx_core_ensure();   // back to guest code
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
static void trk_dump(void) {
    for (int i = 0; i < g_ntrk && i < NTRK; i++) {
        char w[64]; int h = g_trk[i].in_host;
        LOG("  thread %#x: %llu slices of translated code, last slice ended at %s%s%s", g_trk[i].handle, (unsigned long long)g_trk[i].slices, nx_where(g_trk[i].pc, w, sizeof w), h ? "; inside host call " : "", h ? g_stub_name[h - 1] : "");
    }
}
// the host call the calling thread is in ("" when none), for a fault report
const char *nx_cur_host(void) { int k = trk(), h = g_trk[k].in_host; return h && g_stub_name[h - 1] ? g_stub_name[h - 1] : ""; }
void svc_thread_dump(void);
void nx_progress(void) {
    double os[12] = {0}; nx_owner_stats((double)(uintptr_t)os);
    // The watchdog: no present for 10 s (after the first) is a stall. Every thread's state is printed once per stall, and again every 60 s while it lasts
    { static double last_presents; static uint64_t since, dumped; uint64_t now = now_ns();
      if (os[7] != last_presents || !since) { last_presents = os[7]; since = now; dumped = 0; }
      else if (os[7] > 0 && now - since >= 10000000000ull && (!dumped || now - dumped >= 60000000000ull)) {
          dumped = now;
          LOG("[RED] STALL: no present for %.0f s (stopped at present %.0f). Every guest thread: what it waits on (the kernel's list), then where its translated code last was", (now - since) / 1e9, os[7]);
          { void nx_lock_report(void); nx_lock_report(); }   // (consistent: under the kernel's lock. The list after it is not: threads go on while it prints)
          svc_thread_dump(); trk_dump();
          LOG("[RED] STALL: end of the thread list");
      } }
    struct nx_stats s; nx_get_stats(&s); char w[64] = "?"; uint64_t sl = 0; int h = 0;
    for (int i = 0; i < g_ntrk && i < NTRK; i++) if (g_trk[i].handle == 0x1001) { nx_where(g_trk[i].pc, w, sizeof w); sl = g_trk[i].slices; h = g_trk[i].in_host; }
    int rss, swp; nx_rss_mb(&rss, &swp);
    LOG("memory: process %d MB resident (of it the linear memory %d MB) + %d MB swapped; guest: alias region %llu MB mapped, heap %llu MB set; translated wasm %llu MB", rss, linear_rss_mb(), swp, (unsigned long long)(nx_mem_alias_mapped() >> 20), (unsigned long long)(nx_mem_heap_size() >> 20), (unsigned long long)(s.unit_bytes >> 20));
    { extern _Atomic uint64_t nx_svc_by_num[128], nx_stat_yield_parks; uint64_t nx_stat_yield_floor = nx_stat_yield_parks; static uint64_t prev[128]; int top[3] = {0, 0, 0}; uint64_t d[128];
      for (int i = 0; i < 128; i++) { uint64_t v = nx_svc_by_num[i]; d[i] = v - prev[i]; prev[i] = v; }
      for (int k = 0; k < 3; k++) { for (int i = 0; i < 128; i++) if (d[i] > d[top[k]] && (k < 1 || i != top[0]) && (k < 2 || i != top[1])) top[k] = i; if (k < 2 && top[k + 1] == top[k]) top[k + 1] = top[k] ? 0 : 1; }
      LOG("SVCs since the last line: %#x x%llu, %#x x%llu, %#x x%llu; yields parked so far %llu (NX_YIELD_PARK_US)", top[0], (unsigned long long)d[top[0]], top[1], (unsigned long long)d[top[1]], top[2], (unsigned long long)d[top[2]], (unsigned long long)nx_stat_yield_floor); }
    { void nx_core_stats(char *, size_t); __attribute__((weak)) void nx_yield_top(char *, size_t); char cs[240], yt[400] = "";
      nx_core_stats(cs, sizeof cs); if (nx_yield_top) nx_yield_top(yt, sizeof yt);
      LOG("cores: %s", cs); if (yt[0]) LOG("most yields since the last line: %s", yt); }
    { extern _Atomic uint64_t nx_yrun_len[16], nx_yrun_by_host, nx_yrun_by_svc[128]; static uint64_t pl[16], ph, ps[128]; char b[400]; size_t o = 0; uint64_t runs = 0;
      for (int i = 0; i < 16; i++) { uint64_t v = nx_yrun_len[i], d = v - pl[i]; pl[i] = v; runs += d; if (d) o += (size_t)snprintf(b + o, sizeof b - o, " %d+:%llu", 1 << i, (unsigned long long)d); }
      uint64_t hv = nx_yrun_by_host, hd = hv - ph; ph = hv; int top = 0, top2 = 0; uint64_t dv[128];
      for (int i = 0; i < 128; i++) { uint64_t v = nx_yrun_by_svc[i]; dv[i] = v - ps[i]; ps[i] = v; }
      for (int i = 1; i < 128; i++) if (dv[i] > dv[top]) top = i;
      for (int i = 0; i < 128; i++) if (i != top && dv[i] >= dv[top2 == top ? (top ? 0 : 1) : top2]) top2 = i;
      if (runs) LOG("yield runs since the last line: %llu; by length (yields in a row, from):%s; ended by a host call %llu, by svc %#x %llu, by svc %#x %llu", (unsigned long long)runs, b, (unsigned long long)hd, top, (unsigned long long)dv[top], top2, (unsigned long long)dv[top2]); }
    { extern _Atomic uint64_t nx_stat_poll_parks, nx_stat_poll_park_ns; static uint64_t pp, pn, cpu0, wall0; uint64_t a = nx_stat_poll_parks, b = nx_stat_poll_park_ns, wall = now_ns();
      double cpu = nx_js_cpu_us(), cores = cpu >= 0 && wall0 && wall > wall0 ? (cpu - (double)cpu0) * 1e3 / (double)(wall - wall0) : -1;
      char cs[64]; if (cores >= 0) snprintf(cs, sizeof cs, "%.2f host cores busy", cores); else snprintf(cs, sizeof cs, "host CPU not known here (a page cannot ask)");
      LOG("since the last line: %s; polling threads parked %llu times, %.1f ms in all (NX_POLL_PARK_US)", cs, (unsigned long long)(a - pp), (b - pn) / 1e6);
      pp = a; pn = b; cpu0 = cpu >= 0 ? (uint64_t)cpu : 0; wall0 = wall; }
    { static double pres0; char sp[900]; double cores = nx_thread_split((double)(uintptr_t)sp, sizeof sp, os[7] - pres0, 1); pres0 = os[7];
      LOG("guest threads: %.2f running at once on average since the last line; ms per frame (per second when none), the main thread then the three busiest: %s", cores, sp); }
    LOG("progress %4.0f s: %llu SVCs, %llu host calls (%0.f NVN, %0.f fs), %0.f submits, %0.f presents, %u units translated, threads created %d; main thread: %llu slices, at %s%s%s", (now_ns() - g_t0_ns) / 1e9,
        (unsigned long long)nx_stat_svcs, (unsigned long long)g_host_calls, os[10], os[0], os[8], os[7], nx_unit_count(), (int)g_ntrk, (unsigned long long)sl, w, h ? " in " : "", h ? g_stub_name[h - 1] : "");
}

char g_stop_why[400];   // the reason in full, when the caller of nx_boot_report has more than its short one (a guest fault's message)
void nx_units_distribute(void) {
    static _Atomic uint32_t cell; atomic_store(&cell, 0);
    nx_units_share((int)nx_unit_count(), (double)(uintptr_t)&cell);
    while (!atomic_load(&cell)) emscripten_futex_wait(&cell, 0, 1e9);
}

// ---- what a boot run reports when it ends (by time, by a fault, by the guest)
void svc_thread_dump(void);
void nx_boot_report(const char *why) {
    static _Atomic int once; if (atomic_exchange(&once, 1)) return;
    LOG("[RED] STOPPED: %s (%.1f s after the start)", g_stop_why[0] ? g_stop_why : why, (now_ns() - g_t0_ns) / 1e9);   // the reason first: the dump below is long
    nx_js_stopped((double)(uintptr_t)(g_stop_why[0] ? g_stop_why : why));
    smaps_report();
    nx_tr_job(5, 0); { double os[12] = {0}; os[11] = 1; nx_owner_stats((double)(uintptr_t)os); }   // where the JS side's memory is
    nx_tr_job(4, 0);   // keep what this run translated
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
    { void nx_gfx_stats(double); double g[4] = {0}; nx_gfx_stats((double)(uintptr_t)g);
      LOG("recorder on the calling thread: %.0f NVN calls, %.2f us each, of it %.2f us getting the lock; %.0f times a thread slept for the lock%s", g[0], g[0] ? g[1] / 1e3 / g[0] : 0.0, g[0] ? g[3] / 1e3 / g[0] : 0.0, g[2], nx_gfx_enabled() ? "" : " (off: every NVN call goes to the owner)"); }
    { void nx_fs_stats(double); double g[3] = {0}; nx_fs_stats((double)(uintptr_t)g);
      LOG("fs module on the calling thread: %.0f nn::fs calls, %.1f us each (the storage's time included), %.0f waited for the storage%s", g[0], g[0] ? g[1] / 1e3 / g[0] : 0.0, g[2], nx_fs_enabled() ? "" : " (off: every nn::fs call goes to the owner)"); }
    { extern _Atomic uint64_t nx_mono_bumps; LOG("guest clock: %llu reads found the host's clock not ahead of the last value handed out (same step, or behind another thread's) and got that value + 32 ns", (unsigned long long)nx_mono_bumps); }
    LOG("owner slot: %llu requests; waiting for the slot %.1f us each, request to answer %.1f us each (the modules' own time is in the two lines above)", (unsigned long long)g_slot_n,
        g_slot_n ? g_slot_queue_ns / 1e3 / g_slot_n : 0.0, g_slot_n ? g_slot_serve_ns / 1e3 / g_slot_n : 0.0);
    int n = 0;
    for (int pass = 0; pass < 2; pass++) for (int i = 0; i < g_nstub && n < 60; i++) {
        if (!g_stub_calls[i] || g_stub_owner[i] > 0 || (pass == 0) != (g_stub_ent[i] == NULL)) continue;
        if (pass == 0) { LOG("  not ported: %s x%u", g_stub_name[i], g_stub_calls[i]); n++; }
    }
    for (int i = 0; i < g_ntrk && i < NTRK; i++) {
        char w[64]; int h = g_trk[i].in_host;
        LOG("  thread %#x: %llu slices of translated code, last slice ended at %s%s%s", g_trk[i].handle, (unsigned long long)g_trk[i].slices, nx_where(g_trk[i].pc, w, sizeof w), h ? "; inside host call " : "", h ? g_stub_name[h - 1] : "");
    }
    svc_thread_dump();
    LOG("[RED] STOPPED: %s", g_stop_why[0] ? g_stop_why : why);   // and last, where a log that scrolled still shows it
}
