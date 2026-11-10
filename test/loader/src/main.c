// Test module "main": loaded first. Imports from sdk, from the host (forced and weak take-overs), from the plugin
// (an NRO loaded later), and one symbol nobody has.
extern int sdk_add(int a, int b);
extern int sdk_var;
extern int sdk_data[4];
extern int host_forced(int);          // sdk defines it, the host takes it over for everyone
extern int host_weak_only(int);       // nobody defines it: the host's weaker table fills it
extern int sdk_and_hle(int);          // sdk defines it and the weaker table has it: sdk wins
extern int missing_fn(int);           // nobody: reported
extern int plugin_entry(int);         // the plugin NRO, once loaded
extern int maybe_fn(int) __attribute__((weak));   // undefined weak: 0

__attribute__((noinline)) int shared_fn(int x) { return x + 1; }            // sdk has one too: main's wins for every reference (load order)
int main_counter = 7;
int main_bss[64];
static int local_val = 3;

int *p_local = &local_val;                        // RELR (this module is linked with packed relative relocations)
int *p_main_bss = &main_bss[5];
int *p_sdk_var = &sdk_var;                        // ABS64
int *p_sdk_data2 = &sdk_data[2];                  // ABS64 with an addend
int (*p_shared)(int) = shared_fn;                 // ABS64 to an own symbol
int (*p_forced)(int) = host_forced;               // ABS64 to a forced take-over
int (*p_missing)(int) = missing_fn;               // ABS64 unresolved
int (*p_maybe)(int) = maybe_fn;                   // ABS64 weak undefined

// A run of local pointers with holes: with packed relative relocations this gives DT_RELR bitmap entries, more than one
static int local_tab[200];
#define P8(i) &local_tab[i], &local_tab[i + 1], 0, &local_tab[i + 3], 0, 0, &local_tab[i + 6], &local_tab[i + 7]
int *local_ptrs[160] = { P8(0), P8(8), P8(16), P8(24), P8(32), P8(40), P8(48), P8(56), P8(64), P8(72), P8(80), P8(88), P8(96), P8(104), P8(112), P8(120), P8(128), P8(136), P8(144), P8(152) };
const char main_text[] = "nxweb loader test module: main. nxweb loader test module: main. nxweb loader test module: main. "
                         "The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog again.";

static volatile int order;   // volatile: or clang runs the constructors at compile time and emits no .init_array
__attribute__((constructor(101))) static void ctor_first(void) { order = order * 10 + 1; }
__attribute__((constructor(102))) static void ctor_second(void) { order = order * 10 + 2; }
__attribute__((destructor)) static void dtor(void) { order = 0; }
void _init(void) { main_counter++; }
void _fini(void) { main_counter--; }

int module_entry(int x) {
  int r = sdk_add(x, sdk_var);                    // JUMP_SLOT, GLOB_DAT
  r += host_forced(r) + host_weak_only(r) + sdk_and_hle(r) + shared_fn(r);
  r += plugin_entry(r);
  if (maybe_fn) r += maybe_fn(r);
  if (r == 12345) r += missing_fn(r);
  return r + *p_local + main_counter + order;
}
