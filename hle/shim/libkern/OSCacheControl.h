// nxem shim for <libkern/OSCacheControl.h>. Wasm has no instruction cache. A caller that patches GUEST code and then
// calls this expects the new instructions to run: in nxem that means the translated unit covering the range must be
// dropped (nx_code_invalidate, a weak hook the translator seam may define). Without the hook the call does nothing.
#pragma once
#include <stddef.h>
__attribute__((weak)) void nx_code_invalidate(void *start, size_t len);
static inline void sys_icache_invalidate(void *start, size_t len) { if (nx_code_invalidate) nx_code_invalidate(start, len); }
static inline void sys_dcache_flush(void *start, size_t len) { (void)start; (void)len; }
