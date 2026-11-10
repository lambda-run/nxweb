// A clean exit: the main thread returns from the entry, and the fini functions run (this module's fini_array
// backwards, its DT_FINI, then the library's), before the process ends with the entry's result.
#include "rt.h"
u32 mutex_slow;
IMPORT int lib_add(int a, int b);
__attribute__((destructor(101))) static void dtor_a(void) { say("main: fini_array[0] (runs last of the array)"); }
__attribute__((destructor(102))) static void dtor_b(void) { say("main: fini_array[1]"); }
EXPORT void _fini(void) { say("main: DT_FINI"); svcSleepThread(1000); say("main: DT_FINI slept"); }
int rt_entry(u64 x0, Handle main_thread) {
  say_u("main: entry returns ", lib_add(20, 3));
  return 23;
}
