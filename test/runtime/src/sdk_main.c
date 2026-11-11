// (sdk) A program with an SDK's start functions: the runtime calls them in nn::init::Start's order (nnosInitialize
// with the main thread's handle before any module's DT_INIT, the DT_INITs in load order, then nnMain); crt0 is not run.
#include "rt.h"
u32 mutex_slow;
IMPORT int lib_counter;
static volatile int os_up;
static void step(const char *s) { Line l; l.n = 0; l_s(&l, s); l_s(&l, os_up ? " (os up)" : " (os not up)"); l_out(&l); }
EXPORT void _init_libc0(void) { step("_init_libc0"); }
EXPORT void nnosInitialize(Handle main_thread, u64 x1) {
  Line l; l.n = 0; l_s(&l, "nnosInitialize main thread handle="); l_x(&l, main_thread); l_s(&l, " x1="); l_u(&l, x1); l_out(&l);
  os_up = 1;
}
EXPORT void _init_libc1(void) { step("_init_libc1"); }
EXPORT void nninitInitializeSdkModule(void) { step("nninitInitializeSdkModule"); }
EXPORT void nninitStartup(void) { step("nninitStartup"); }
EXPORT void _init_libc2(void) { step("_init_libc2"); }
__attribute__((constructor)) static void ctor(void) { step("main: init_array[0] (not called by the runtime: an SDK module's DT_INIT runs it)"); }
EXPORT void _init(void) { step("main: DT_INIT"); }
EXPORT void nnMain(void) { step("nnMain"); say_u("lib_counter (5 + 1 by the library's DT_INIT only) = ", lib_counter); svcExitProcess(7); }
int rt_entry(u64 x0, Handle main_thread) { say("crt0 entry (wrong: the SDK start enters nnMain)"); return 1; }
