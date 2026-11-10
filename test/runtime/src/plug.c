// The module ro_main loads at run time (built as an NRO): data, bss, an init and a fini function, an import from main.
#include "rt.h"
u32 mutex_slow;
IMPORT int main_twice(int x);
EXPORT int plug_counter = 100;
static int bss_word;
__attribute__((constructor)) static void plug_init(void) { plug_counter += 5; say("  plug: init function"); }
__attribute__((destructor)) static void plug_fini(void) { say_u("  plug: fini function, counter ", plug_counter); }
EXPORT NOINLINE int plug_calc(int x) { bss_word += x; return main_twice(x) + plug_counter + bss_word; }
EXPORT int plug_bump(void) { return ++plug_counter; }
void rt_entry(void) { }
