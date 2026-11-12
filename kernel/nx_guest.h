// nxem: the interface between the C that comes from nxnative (and its C glue), the C++ seam code, and the JS half.
// C++ translation units include this header and kernel/shim/nx_port.h, never nxnative's dm.h / hle.h (those are C
// only: _Atomic, __thread externs, designated initialisers); what C++ needs from them is wrapped here.
#pragma once
#include <stdint.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif

// ---- C glue over nxnative (kernel/nx_guest.c)
_Noreturn void nx_die(const char *what);          // nxnative's die(): log in red and abort
void nx_log(const char *line);                    // nxnative's LOG()
uint64_t nx_now_ns(void);
void nx_native_wait(int entering);                // hle_thread.c dm_thread_native_wait: the caller blocks in host code and holds no guest core
void nx_note_thread(uint64_t entry);
void nx_svc(int num, double regs);                // a unit's svc import: regs = the thread's context block (nxweb CONTRACT.md)
int nx_svc_other(int num, uint64_t *regs);        // weak: the SVCs that are not thread SVCs

// ---- unit registry and translator service (kernel/nx_units.cpp)
void nx_translator_start(const uint8_t *tr, uint32_t tr_len, const uint8_t *hlp, uint32_t hlp_len, uint64_t code_lo, uint64_t code_size);
uint32_t nx_translate(double pc);                 // any guest thread: the table index of the function at pc
void nx_unit_publish(double bytes, uint32_t len, uint32_t table_base, uint32_t nfuncs);
uint32_t nx_unit_count(void);
double nx_unit_bytes(uint32_t i);
uint32_t nx_unit_len(uint32_t i);
uint32_t nx_unit_base(uint32_t i);
uint32_t nx_unit_nfuncs(uint32_t i);
uint32_t nx_table_cap(void);
void nx_set_table_cap(uint32_t n);
void nx_mod_set(int which, double p, uint32_t len);   // 0 = the core module's bytes, 1 = the helpers'
double nx_mod_ptr(int which);
uint32_t nx_mod_len(int which);
int nx_is64(void);
struct nx_stats { uint64_t translate_ns, translate_calls, unit_bytes; };
void nx_get_stats(struct nx_stats *out);

// ---- JS half (kernel/nx_guest.js)
void nx_js_guest_run(uint64_t *io);               // io: x0..x4, pc, sp in; x0 out. Returns when the guest reaches the exit pc
void nx_js_tr_init(const uint8_t *tr, uint32_t tr_len, const uint8_t *hlp, uint32_t hlp_len, double code_lo, double code_size);
uint32_t nx_js_tr_translate(double pc);
int nx_js_tid(void);
void nx_js_thread_stats(double *out);
void nx_js_thread_prepare(double *out);
int nx_js_cache_publish(const char *url, double max_pages, double *out);

#ifdef __cplusplus
}
#endif
