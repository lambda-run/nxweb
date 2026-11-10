// (b) Two modules: main calls the library's exports and uses its data through the GOT; the order of the init
// functions (DT_INIT, then init_array, the library's before main's) shows in the output.
#include "rt.h"
u32 mutex_slow;
IMPORT int lib_add(int a, int b);
IMPORT int lib_get_counter(void);
IMPORT const char *lib_name(void);
IMPORT int lib_counter;
IMPORT int lib_table[4];
IMPORT int (*lib_op)(int, int);
int *p_counter = &lib_counter;            // ABS64 against the other module
static volatile int inits;

__attribute__((constructor(101))) static void ctor_a(void) { inits = inits * 10 + 1; say("main: init_array[0]"); }
__attribute__((constructor(102))) static void ctor_b(void) { inits = inits * 10 + 2; say("main: init_array[1]"); }
EXPORT void _init(void) { inits = 9; say("main: DT_INIT"); }

int rt_entry(u64 x0, Handle main_thread) {
  Line l; l.n = 0;
  l_s(&l, "main: entry, inits="); l_u(&l, inits); l_s(&l, ", library says \""); l_s(&l, lib_name()); l_s(&l, "\""); l_out(&l);
  say_u("lib_add(40, 2) = ", lib_add(40, 2));
  say_u("lib_table[1] + lib_table[3] = ", lib_table[1] + lib_table[3]);
  say_u("lib_counter (set by the library's init functions) = ", lib_counter);
  lib_counter += 100; *p_counter += 1000;
  say_u("lib_get_counter() after main wrote through the GOT and a data pointer = ", lib_get_counter());
  say_u("lib_op(6, 7) through the library's function pointer = ", lib_op(6, 7));
  svcExitProcess(3);
}
