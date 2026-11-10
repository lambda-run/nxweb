// Robustness: an NRO is loaded through nn::ro, called and unloaded stress_rounds() times.
#include "rt.h"
u32 mutex_slow;
typedef struct { void *module; u32 state, pad; const void *image; void *buffer; } RoModule;
IMPORT Result ro_Initialize(void) __asm__("_ZN2nn2ro10InitializeEv");
IMPORT Result ro_LookupModuleSymbol(u64 *out, const RoModule *m, const char *name) __asm__("_ZN2nn2ro18LookupModuleSymbolEPmPKNS0_6ModuleEPKc");
IMPORT Result ro_LoadModule(RoModule *m, const void *image, void *buffer, u64 size, int flag) __asm__("_ZN2nn2ro10LoadModuleEPNS0_6ModuleEPKvPvmi");
IMPORT void ro_UnloadModule(RoModule *m) __asm__("_ZN2nn2ro12UnloadModuleEPNS0_6ModuleE");
IMPORT u64 test_nro(void *buf, u64 cap);
IMPORT u32 stress_rounds(void);
IMPORT void stress_mark(u32 round);
EXPORT int main_twice(int x) { return 2 * x; }
static u8 image[0x10000] __attribute__((aligned(0x1000)));
static u8 bss[0x8000] __attribute__((aligned(0x1000)));
static RoModule mod;
int rt_entry(u64 x0, Handle main_thread) {
  set_self_handle(main_thread);
  ro_Initialize(); test_nro(image, sizeof image);
  u32 rounds = stress_rounds(), bad = 0; u64 sum = 0;
  for (u32 r = 0; r < rounds; r++) {
    if (ro_LoadModule(&mod, image, bss, sizeof bss, 1)) { bad++; continue; }
    u64 calc = 0;
    if (ro_LookupModuleSymbol(&calc, &mod, "plug_calc")) bad++; else sum = sum * 31 + (u64)((int (*)(int))calc)((int)r);
    ro_UnloadModule(&mod);
    if (r == rounds / 10 || r == rounds - 1) stress_mark(r);
  }
  Line l; l.n = 0; l_s(&l, "loaded and unloaded "); l_u(&l, rounds); l_s(&l, " times, "); l_u(&l, bad); l_s(&l, " failures, checksum "); l_x(&l, sum); l_out(&l);
  return 0;
}
