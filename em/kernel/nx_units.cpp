// nxem: the unit registry and the translator service (C++; the C side is kernel/nx_guest.c, the JS side nx_guest.js).
//   - registry: the bytes of every translated unit, in the shared memory, so that each thread can instantiate them
//     into its own table (a WebAssembly.Module cannot be handed to a thread that is blocked or running). One writer
//     (the translator thread, or the cache loader before guest threads run); readers take the count first.
//   - translator service: one pthread owns nxweb's translator (its state is one JS realm's); a thread that reaches
//     code nobody translated yet asks it and waits.
#include "nx_guest.h"
#include "nx_port.h"
#include <atomic>
#include <array>
#include <condition_variable>
#include <mutex>
#include <pthread.h>
#include <cstdio>
#include <emscripten.h>

namespace {
struct Unit { uint8_t *bytes; uint32_t len, table_base, nfuncs; };
constexpr uint32_t kMaxUnits = 1u << 16;
std::array<Unit, kMaxUnits> g_units;
std::atomic<uint32_t> g_nunits{0};
std::atomic<uint32_t> g_table_cap{1u << 18};   // slots of every thread's table
struct { uint8_t *p; uint32_t len; } g_wmod[2];
std::atomic<uint64_t> g_translate_ns{0}, g_translate_calls{0}, g_unit_bytes{0};

// A guest thread that waits for the translator blocks like in a native HLE wait: it holds no guest core meanwhile,
// so nxnative's same-core handoff does not wait for it.
struct NativeWait { NativeWait() { nx_native_wait(1); } ~NativeWait() { nx_native_wait(0); } };

class Translator {
public:
    void start(const uint8_t *tr, uint32_t tr_len, const uint8_t *hlp, uint32_t hlp_len, uint64_t lo, uint64_t size, double *boot) {
        boot_ = boot; tr_ = tr; tr_len_ = tr_len; hlp_ = hlp; hlp_len_ = hlp_len; lo_ = lo; size_ = size;
        pthread_t th; pthread_attr_t a; pthread_attr_init(&a); pthread_attr_setstacksize(&a, 4 << 20);
        if (pthread_create(&th, &a, [](void *self) -> void * { static_cast<Translator *>(self)->run(); return nullptr; }, this)) nx_die("pthread_create (translator)");
        pthread_attr_destroy(&a);
        std::unique_lock<std::mutex> l(m_);
        cv_.wait(l, [this] { return ready_; });
    }
    uint64_t job(int kind, uint64_t arg) {
        NativeWait nw;
        std::lock_guard<std::mutex> one(gate_);   // one request at a time
        std::unique_lock<std::mutex> l(m_);
        kind_ = kind; pc_ = arg; state_ = Requested; cv_.notify_all();
        cv_.wait(l, [this] { return state_ == Answered; });
        state_ = Idle;
        return res_;
    }
private:
    enum State { Idle, Requested, Answered };
    void run() {
        nx_setname_self("nx translator");
        nx_js_tr_init(tr_, tr_len_, hlp_, hlp_len_, (double)lo_, (double)size_, boot_);
        std::unique_lock<std::mutex> l(m_);
        ready_ = true; cv_.notify_all();
        for (;;) {
            cv_.wait(l, [this] { return state_ == Requested; });
            uint64_t pc = pc_; int kind = kind_;
            l.unlock();
            uint64_t t0 = nx_now_ns();
            uint64_t r = (uint64_t)nx_js_tr_job(kind, (double)pc);   // 0: translates if needed, instantiates in this realm, publishes the bytes
            if (kind == 0) { g_translate_ns += nx_now_ns() - t0; g_translate_calls++; }
            l.lock();
            res_ = r; state_ = Answered; cv_.notify_all();
        }
    }
    std::mutex m_, gate_; std::condition_variable cv_;
    State state_ = Idle; bool ready_ = false; uint64_t pc_ = 0, res_ = 0; int kind_ = 0; double *boot_ = nullptr;
    const uint8_t *tr_ = nullptr, *hlp_ = nullptr; uint32_t tr_len_ = 0, hlp_len_ = 0; uint64_t lo_ = 0, size_ = 0;
};
Translator g_translator;
}  // namespace

extern "C" {
// Addresses cross the JS boundary as doubles (exact to 2^53): the same code for a 32-bit and a 64-bit memory.
EMSCRIPTEN_KEEPALIVE void nx_unit_publish(double bytes, uint32_t len, uint32_t table_base, uint32_t nfuncs) {
    uint32_t i = g_nunits.load();
    if (i >= kMaxUnits || table_base + nfuncs > g_table_cap.load()) {
        char b[160]; snprintf(b, sizeof b, "translated-unit registry or function table full (%u units, table index %u)", i, table_base + nfuncs); nx_die(b);
    }
    g_units[i] = Unit{(uint8_t *)(uintptr_t)bytes, len, table_base, nfuncs};
    g_unit_bytes += len;
    g_nunits.store(i + 1);
}
EMSCRIPTEN_KEEPALIVE uint32_t nx_unit_count(void) { return g_nunits.load(); }
EMSCRIPTEN_KEEPALIVE double nx_unit_bytes(uint32_t i) { return (double)(uintptr_t)g_units[i].bytes; }
EMSCRIPTEN_KEEPALIVE uint32_t nx_unit_len(uint32_t i) { return g_units[i].len; }
EMSCRIPTEN_KEEPALIVE uint32_t nx_unit_base(uint32_t i) { return g_units[i].table_base; }
EMSCRIPTEN_KEEPALIVE uint32_t nx_unit_nfuncs(uint32_t i) { return g_units[i].nfuncs; }
EMSCRIPTEN_KEEPALIVE uint32_t nx_table_cap(void) { return g_table_cap.load(); }
EMSCRIPTEN_KEEPALIVE void nx_set_table_cap(uint32_t n) { g_table_cap.store(n); }
EMSCRIPTEN_KEEPALIVE void nx_mod_set(int which, double p, uint32_t len) { g_wmod[which].p = (uint8_t *)(uintptr_t)p; g_wmod[which].len = len; }
EMSCRIPTEN_KEEPALIVE double nx_mod_ptr(int which) { return (double)(uintptr_t)g_wmod[which].p; }
EMSCRIPTEN_KEEPALIVE uint32_t nx_mod_len(int which) { return g_wmod[which].len; }
EMSCRIPTEN_KEEPALIVE int nx_is64(void) { return sizeof(void *) == 8; }
static std::atomic<double> g_pcmap_base{0};   // where the translator's pc map is (nxweb's layout), for the guest threads' lookups
EMSCRIPTEN_KEEPALIVE void nx_pcmap_set(double base) { g_pcmap_base.store(base); }
EMSCRIPTEN_KEEPALIVE double nx_pcmap_base(void) { return g_pcmap_base.load(); }
void nx_get_stats(struct nx_stats *out) { out->translate_ns = g_translate_ns; out->translate_calls = g_translate_calls; out->unit_bytes = g_unit_bytes; }
void nx_translator_start(const uint8_t *tr, uint32_t tr_len, const uint8_t *hlp, uint32_t hlp_len, uint64_t code_lo, uint64_t code_size, double *boot) {
    g_translator.start(tr, tr_len, hlp, hlp_len, code_lo, code_size, boot);
}
EMSCRIPTEN_KEEPALIVE uint32_t nx_translate(double pc) { return (uint32_t)g_translator.job(0, (uint64_t)pc); }
uint64_t nx_tr_job(int kind, uint64_t arg) { return g_translator.job(kind, arg); }
}
