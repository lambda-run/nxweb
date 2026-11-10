// Test module "plugin": an NRO, loaded and unloaded at run time. main imports plugin_entry from it.
extern int sdk_add(int a, int b);
extern int shared_fn(int);
extern int host_forced(int);

int plugin_state = 99;
int plugin_values[8] = { 1, 2, 3, 4, 5, 6, 7, 8 };
volatile int plugin_bss[2048];   // 8 KiB: an NRO's data is padded to a page out of the bss, and some bss must be left
int *plugin_ptr = &plugin_values[4];
int (*plugin_fp)(int) = shared_fn;

__attribute__((constructor)) static void plugin_ctor(void) { plugin_bss[0] = plugin_state; }

int plugin_entry(int x) { plugin_state++; return sdk_add(x, plugin_state) + shared_fn(x) + host_forced(x) + plugin_bss[7]; }
int module_entry(int x) { return plugin_entry(x); }
