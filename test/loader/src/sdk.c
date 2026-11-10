// Test module "sdk": loaded after main. Linked without packed relocations (R_AARCH64_RELATIVE in .rela.dyn).
extern int host_weak_only(int);
extern int main_counter;

int sdk_var = 42;
int sdk_data[4] = { 10, 20, 30, 40 };
volatile int sdk_bss[128];   // volatile: or clang runs the constructors at compile time and emits no .init_array

__attribute__((noinline)) int sdk_add(int a, int b) { return a + b; }
__attribute__((noinline)) int host_forced(int x) { return x * 2; }          // the host takes this over, also for sdk's own calls
__attribute__((noinline)) int sdk_and_hle(int x) { return x - 1; }
__attribute__((noinline)) int shared_fn(int x) { return x + 1000; }         // main's definition wins (loaded earlier)

static int helper(int x) { return x ^ 5; }
int (*sdk_table[3])(int) = { helper, sdk_and_hle, shared_fn };   // RELATIVE, ABS64, ABS64
int *sdk_self = &sdk_data[1];                     // ABS64 with an addend, own symbol
volatile int *sdk_bss_ptr = &sdk_bss[3];

__attribute__((constructor(200))) static void sdk_ctor_b(void) { sdk_bss[1] = 2; }
__attribute__((constructor(150))) static void sdk_ctor_a(void) { sdk_bss[0] = 1; }
void _init(void) { sdk_var++; }

int module_entry(int x) {
  return host_forced(x) + shared_fn(x) + host_weak_only(x) + main_counter + sdk_table[x & 1](x) + *sdk_self;
}
