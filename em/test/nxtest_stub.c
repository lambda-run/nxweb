// Stubs for nxnative's own unit tests of hle_thread.c (dm/host/tests/t_condvar.c, t_sync_wait.c, t_pollwait.c,
// t_clockwait.c) built with Emscripten: the tests never enter guest code. Stands in for tests/t_condvar_stub.c
// together with kernel/nx_shims.c.
#include "dm.h"
#include "nx_port.h"
#ifndef DM_TEST_THREAD_ENTER
void dm_thread_enter(uint64_t entry, uint64_t arg, uint64_t sp) { (void)entry; (void)arg; (void)sp; abort(); }
#endif
uint64_t nx_guest_call(uint64_t pc, uint64_t a0, uint64_t a1, uint64_t a2) { (void)pc; (void)a0; (void)a1; (void)a2; abort(); }
