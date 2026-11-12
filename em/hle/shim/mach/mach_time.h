// nxem shim for <mach/mach_time.h>: the monotonic clock in nanoseconds, timebase 1/1.
#pragma once
#include <stdint.h>
#include <time.h>
typedef struct { uint32_t numer, denom; } mach_timebase_info_data_t;
typedef mach_timebase_info_data_t *mach_timebase_info_t;
static inline int mach_timebase_info(mach_timebase_info_t i) { i->numer = 1; i->denom = 1; return 0; }
// The host's clock as every guest-visible time is made from it (hle_os.c now_ns -> guest_ns -> the system counter, svc
// GetSystemTick, timeouts): kernel/nx_shims.c nx_mono_ns, which never repeats a value and never goes back, on any thread.
uint64_t nx_mono_ns(void);
static inline uint64_t mach_absolute_time(void) { return nx_mono_ns(); }
static inline uint64_t mach_continuous_time(void) { return mach_absolute_time(); }
