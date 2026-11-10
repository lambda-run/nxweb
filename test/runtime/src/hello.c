// (a) One module: OutputDebugString and the exit code (the value the entry function returns).
#include "rt.h"
u32 mutex_slow;
int rt_entry(u64 x0, Handle main_thread) {
  say("hello from an NSO");
  Line l; l.n = 0; l_s(&l, "x0="); l_u(&l, x0); l_s(&l, " main thread handle="); l_x(&l, main_thread); l_out(&l);
  return 42;
}
