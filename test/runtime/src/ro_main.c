// Run-time modules: loads an NRO through nn::ro (host functions standing for it), calls into it, unloads it and
// loads it again, three rounds. The image comes from the host (test_nro), as a game would read it from its RomFS.
#include "rt.h"
u32 mutex_slow;
typedef struct { void *module; u32 state, pad; const void *image; void *buffer; } RoModule;
IMPORT Result ro_Initialize(void) __asm__("_ZN2nn2ro10InitializeEv");
IMPORT Result ro_LookupSymbol(u64 *out, const char *name) __asm__("_ZN2nn2ro12LookupSymbolEPmPKc");
IMPORT Result ro_LookupModuleSymbol(u64 *out, const RoModule *m, const char *name) __asm__("_ZN2nn2ro18LookupModuleSymbolEPmPKNS0_6ModuleEPKc");
IMPORT Result ro_GetBufferSize(u64 *out, const void *image) __asm__("_ZN2nn2ro13GetBufferSizeEPmPKv");
IMPORT Result ro_LoadModule(RoModule *m, const void *image, void *buffer, u64 size, int flag) __asm__("_ZN2nn2ro10LoadModuleEPNS0_6ModuleEPKvPvmi");
IMPORT void ro_UnloadModule(RoModule *m) __asm__("_ZN2nn2ro12UnloadModuleEPNS0_6ModuleE");
IMPORT u64 test_nro(void *buf, u64 cap);
IMPORT __attribute__((weak)) int plug_bump(void);     // the NRO defines it: bound while the NRO is loaded, 0 otherwise
EXPORT int main_twice(int x) { return 2 * x; }       // the NRO imports it

static u8 image[0x10000] __attribute__((aligned(0x1000)));
static u8 bss[0x8000] __attribute__((aligned(0x1000)));
static RoModule mod;
static int (*volatile bump_ptr)(void);

int rt_entry(u64 x0, Handle main_thread) {
  Line l; u64 a = 0, size = 0;
  ro_Initialize();
  u64 n = test_nro(image, sizeof image);
  say_x("GetBufferSize of something that is no NRO: ", ro_GetBufferSize(&size, bss));
  Result rc = ro_GetBufferSize(&size, image);
  l.n = 0; l_s(&l, "image: NRO of "); l_u(&l, n); l_s(&l, " bytes, GetBufferSize rc="); l_x(&l, rc); l_out(&l);
  say_x("LookupSymbol(plug_calc) before any load: rc=", ro_LookupSymbol(&a, "plug_calc"));
  for (int round = 1; round <= 3; round++) {
    rc = ro_LoadModule(&mod, image, bss, size, 1);
    l.n = 0; l_s(&l, "round "); l_u(&l, round); l_s(&l, ": LoadModule rc="); l_x(&l, rc); l_s(&l, " state="); l_u(&l, mod.state); l_out(&l);
    if (rc) return 1;
    say_x("  loading it again while loaded: rc=", ro_LoadModule(&mod, image, bss, size, 1) ? 1 : 0);
    u64 calc = 0, counter = 0;
    ro_LookupModuleSymbol(&calc, &mod, "plug_calc");
    ro_LookupSymbol(&counter, "plug_counter");
    say_u("  plug_counter after its init functions = ", *(int *)counter);
    *(int *)counter += 1000 * round;                  // a reload must not see this
    say_u("  plug_calc(7), which calls main_twice = ", ((int (*)(int))calc)(7));
    say_u("  plug_calc(7) again (its bss word grew) = ", ((int (*)(int))calc)(7));
    bump_ptr = plug_bump;
    say_u("  main's own import plug_bump, bound at load: ", bump_ptr ? (u64)bump_ptr() : 0);
    say_x("  LookupModuleSymbol(no_such_symbol): rc=", ro_LookupModuleSymbol(&a, &mod, "no_such_symbol"));
    ro_UnloadModule(&mod);
    bump_ptr = plug_bump;
    l.n = 0; l_s(&l, "  unloaded: state="); l_u(&l, mod.state); l_s(&l, ", LookupSymbol rc="); l_x(&l, ro_LookupSymbol(&a, "plug_calc"));
    l_s(&l, bump_ptr ? ", main's import still bound" : ", main's import is 0 again"); l_out(&l);
  }
  say("ro done");
  return 0;
}
