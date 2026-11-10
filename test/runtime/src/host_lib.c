// (e) The library of the host-call test: defines forced_fn (which the host takes over all the same) and lib_wins.
#include "rt.h"
u32 mutex_slow;
EXPORT int forced_fn(int x) { return x + 111; }
EXPORT int lib_calls_forced(int x) { return forced_fn(x) + 1; }
EXPORT int lib_wins(int x) { return x + 2000; }
void rt_entry(void) { }
