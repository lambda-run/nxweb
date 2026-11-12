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
void nx_guest_fault(double pc, double what);   // translated code cannot go on (a trap, no code at pc): report and end the process
void nx_svc(int num, double regs);                // a unit's svc import: regs = the thread's context block (nxweb CONTRACT.md)
int nx_svc_other(int num, uint64_t *regs);        // weak: the SVCs that are not thread SVCs
void nx_host_call(double ctx);                    // the stub thunk's host_call import (kernel/nx_proc.c)
void nx_boot_report(const char *why);
double nx_tlr(void); double nx_tls(void);         // the calling thread's thread-local region and TLS block (0 in the small proofs)

// ---- memory SVCs (kernel/nx_mem.cpp)
int nx_mem_svc(int num, uint64_t *regs);
void nx_mem_module(const char *name, uint64_t base, uint64_t size, uint64_t ro_off, uint64_t data_off);
uint64_t nx_mem_main_stack(uint64_t size);        // maps the main thread's stack; returns its top
uint64_t nx_mem_heap_size(void);
uint64_t nx_mem_alias_mapped(void);

// ---- unit registry and translator service (kernel/nx_units.cpp)
// boot: NULL, or the game to load in the translator thread's realm before it serves (see nx_js_tr_init)
void nx_translator_start(const uint8_t *tr, uint32_t tr_len, const uint8_t *hlp, uint32_t hlp_len, uint64_t code_lo, uint64_t code_size, double *boot);
uint64_t nx_tr_job(int kind, uint64_t arg);       // run a job in the translator thread's realm: 0 translate(pc), 1 symbol address(name), 2 unused
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

// ---- the owner realm (kernel/nx_owner.js -> owner/owner.ts): nxweb's modules that exist once, on the main thread
int nx_owner_lookup(double name);
int nx_owner_call(int code, double ctx);
void nx_owner_stats(double out);
void nx_owner_serve(double slot);
int nx_owner_stub(int id);
void nx_owner_stub_name(int id, double out, int n);

// ---- JS half (kernel/nx_guest.js)
void nx_js_guest_run(uint64_t *io);               // io: x0..x4, pc, sp in; x0 out. Returns when the guest reaches the exit pc
void nx_js_tr_init(const uint8_t *tr, uint32_t tr_len, const uint8_t *hlp, uint32_t hlp_len, double code_lo, double code_size, double *boot);
double nx_js_tr_job(int kind, double arg);
void nx_js_guest_callv(uint64_t *a, int n);       // a[0..7] arguments, a[8] pc; a[0] = the result
void nx_js_guest_setup(double sp);                // a fresh CPU state for the calling thread: sp, tpidr, tpidrro
int nx_js_tid(void);
void nx_js_thread_stats(double *out);
void nx_js_thread_prepare(double *out);
int nx_js_cache_publish(const char *url, double max_pages, double *out);

#ifdef __cplusplus
}
#endif
