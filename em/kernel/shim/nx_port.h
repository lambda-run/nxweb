// nxem: what the nxnative host sources need from the platform when the platform is Emscripten.
#pragma once
#include <pthread.h>
#include <stdint.h>
#include <stddef.h>
#include <time.h>
#ifdef __cplusplus
extern "C" {
#endif
// Mac's one-argument form names the calling thread
void nx_setname_self(const char *name);
#define pthread_setname_np(name) nx_setname_self(name)
int pthread_cond_timedwait_relative_np(pthread_cond_t *c, pthread_mutex_t *m, const struct timespec *rel);
// One running guest thread per virtual core (kernel/nx_cores.c)
void nx_core_release(void);
void nx_core_ensure(void);
void nx_core_yield(void);
// Run a guest function on the calling guest thread and return its x0 (kernel/nx_guest.js)
uint64_t nx_guest_call(uint64_t pc, uint64_t a0, uint64_t a1, uint64_t a2);
#ifdef __cplusplus
}
#endif
