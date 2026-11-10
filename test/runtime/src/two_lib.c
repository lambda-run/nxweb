// (b) The second module: exports functions and data; has DT_INIT and an init_array of its own.
#include "rt.h"
u32 mutex_slow;
EXPORT int lib_counter = 5;
EXPORT int lib_table[4] = { 10, 20, 30, 40 };
static int mul(int a, int b) { return a * b; }
EXPORT int (*lib_op)(int, int) = mul;     // RELATIVE in this module, read by main through its GOT
EXPORT int lib_add(int a, int b) { return a + b; }
EXPORT int lib_get_counter(void) { return lib_counter; }
EXPORT const char *lib_name(void) { return "two_lib"; }

__attribute__((constructor(101))) static void ctor_a(void) { lib_counter *= 2; say("lib: init_array[0]"); }
__attribute__((constructor(102))) static void ctor_b(void) { lib_counter += 1; say("lib: init_array[1]"); }
EXPORT void _init(void) { lib_counter += 1; say("lib: DT_INIT"); }
__attribute__((destructor)) static void dtor(void) { say("lib: fini_array[0]"); }
EXPORT void _fini(void) { say("lib: DT_FINI"); }
void rt_entry(void) { }
