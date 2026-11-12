// Boot harness: the real game's code modules under nxnative's C kernel (node, memory64).
// nxweb's loader (in the translator thread's realm) maps and relocates main, subsdk0 and sdk into the Emscripten memory;
// the main guest thread then runs the SDK's start sequence and nnMain as translated code. Thread SVCs go to
// hle_thread.c, memory SVCs to nx_mem.cpp, host calls to whatever of nxnative's HLE is linked (the rest answer 0 and
// are listed). It stops at the first thing that is missing, or after the given time, and prints a report.
// Usage: node p4.js <exefs dir> <translator64.shared.wasm> <helpers64.shared.wasm> <loader64.wasm> [seconds]
#include "dm.h"
#include "nx_port.h"
#include "nx_guest.h"
#include <stdatomic.h>
#include <unistd.h>
#include <emscripten.h>
#include <emscripten/heap.h>
#include <emscripten/threading.h>

uint32_t svc_thread_main_init(void);
void guest_thread_init(void);
const char *nx_where(uint64_t pc, char *buf, size_t n);

#define CODE_LO 0x08000000ull
#define CODE_SIZE 0x10000000ull
#define STAGING 0x18000000ull      // the files, while the loader reads them: between the code region and the process's address space
#define STAGING_END 0x1C000000ull   // above it, to 0x2000_0000: the owner realm's low allocations (owner/owner.ts)

static uint8_t *load(const char *path, uint32_t *len) {
    FILE *f = fopen(path, "rb"); if (!f) die("cannot open %s", path);
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *p = malloc((size_t)n); if (fread(p, 1, (size_t)n, f) != (size_t)n) die("short read of %s", path);
    fclose(f); *len = (uint32_t)n; return p;
}
static int g_secs;
void nx_progress(void); void nx_rss_mb(int *rss, int *swap);
static void *watchdog(void *arg) { (void)arg; for (int t = 0; t < g_secs; t += 10) {
        sleep(10); nx_progress();
        int rss, swp; nx_rss_mb(&rss, &swp);   // the VM is shared: stop before this process pushes the others into swap
        int lim = getenv("NX_RSS_LIMIT_MB") ? atoi(getenv("NX_RSS_LIMIT_MB")) : 5200;
        if (rss + swp > lim) { char w[96]; snprintf(w, sizeof w, "memory limit: %d MB resident + %d MB swapped is over %d MB", rss, swp, lim); nx_boot_report(w); emscripten_force_exit(5); }
    } char w[64]; snprintf(w, sizeof w, "the time given (%d s) is over", g_secs); nx_boot_report(w); emscripten_force_exit(0); return NULL; }

int main(int argc, char **argv) {
    if (argc < 5) die("usage: p4 <exefs dir> <translator> <helpers> <loader> [seconds]");
    g_secs = argc > 5 ? atoi(argv[5]) : 120;
    g_t0_ns = now_ns();
    pthread_key_create(&g_key18, NULL);
    guest_thread_init();
    static const char *mods[] = DM_GAME_MODULES;
    static double boot[80];
    uint32_t tlen, hlen, llen;
    uint8_t *tr = load(argv[2], &tlen), *hlp = load(argv[3], &hlen), *ldr = load(argv[4], &llen);
    boot[0] = (double)(uintptr_t)ldr; boot[1] = llen; boot[2] = DM_GAME_NMOD; boot[30] = (double)CODE_LO;
    uint64_t at = STAGING;
    for (int i = 0; i < DM_GAME_NMOD; i++) {
        char path[512]; snprintf(path, sizeof path, "%s/%s", argv[1], mods[i]);
        uint32_t n; uint8_t *b = load(path, &n);
        if (at + n > STAGING_END) die("the module files do not fit the staging range");
        memcpy((void *)(uintptr_t)at, b, n); free(b);
        boot[3 + 3 * i] = (double)(uintptr_t)mods[i]; boot[4 + 3 * i] = (double)at; boot[5 + 3 * i] = n;
        at = (at + n + 0xFFF) & ~0xFFFull;
    }
    printf("memory %zu MB; Emscripten data %p, heap %p; files staged at %#llx .. %#llx\n", emscripten_get_heap_size() >> 20, (void *)boot, malloc(16), STAGING, (unsigned long long)at);
    uint64_t t0 = now_ns();
    nx_translator_start(tr, tlen, hlp, hlen, CODE_LO, CODE_SIZE, boot);
    memset((void *)(uintptr_t)STAGING, 0, at - STAGING);
    printf("loaded and relocated in %.0f ms; start list of %d calls, nnMain at %#llx\n", (now_ns() - t0) / 1e6, (int)boot[40], (unsigned long long)boot[39]);
    if (!boot[39]) die("no nnMain in the modules");
    uint32_t self = svc_thread_main_init();
    nx_note_thread((uint64_t)boot[39]);
    uint64_t sp = nx_mem_main_stack(1 << 20);
    nx_js_guest_setup((double)sp);
    { pthread_t wd; pthread_create(&wd, NULL, watchdog, NULL); }
    char w[64];
    for (int i = 0; i < (int)boot[40]; i++) {
        uint64_t pc = (uint64_t)boot[41 + i]; int os = i == (int)boot[38];
        uint64_t c0 = now_ns();
        uint64_t r = nx_guest_call(pc, os ? self : 0, 0, 0);
        int rss, swp; nx_rss_mb(&rss, &swp);
        LOG("start %d/%d: %s%s returned %#llx after %.0f ms (process %d MB resident)", i + 1, (int)boot[40], nx_where(pc, w, sizeof w), os ? " (nnosInitialize)" : "", (unsigned long long)r, (now_ns() - c0) / 1e6, rss);
    }
    LOG("start: entering nnMain at %s", nx_where((uint64_t)boot[39], w, sizeof w));
    uint64_t io[8] = {0, self, 0, 0, 0, (uint64_t)boot[39], sp};
    nx_js_guest_run(io);
    nx_boot_report("nnMain returned");
    emscripten_force_exit(0);
}
