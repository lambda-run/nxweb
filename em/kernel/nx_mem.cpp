// nxem: the memory SVCs on a flat linear memory (C++; new code, not a port). nxnative's hle_svc.c reserves the guest
// address space with mmap and commits with mprotect; a wasm memory has neither, so the regions are plain ranges of the
// one memory and "mapped" is bookkeeping. The numbers (region sizes, pool, results) follow hle_svc.c, case by case:
//   0x01 SetHeapSize, 0x02/0x03 SetMemoryPermission/Attribute, 0x04/0x05 Map/UnmapMemory (copy in, copy back),
//   0x06 QueryMemory, 0x29 GetInfo, 0x2C/0x2D Map/UnmapPhysicalMemory (a page bitmap of the alias region).
// Fresh memory reads zero; what is given back is zeroed when it is given back, so it reads zero when mapped again.
#include "nx_guest.h"
#include "game_profile.h"
#include <atomic>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <vector>

namespace {
constexpr uint64_t kAs = 0x20000000ull;                        // the address space the process sees ("ASLR region"): above the code region
constexpr uint64_t kReserve = DM_GAME_MEM_RESERVE;             // hle_svc.c: g_reserve = RESERVE - ALIAS + alias, with alias = the profile's
constexpr uint64_t kHeap = kAs + 0x10000000ull;
constexpr uint64_t kHeapCap = DM_GAME_MEM_RESERVE - DM_GAME_MEM_ALIAS - DM_GAME_MEM_STACK - 0x10000000ull;
constexpr uint64_t kStack = kHeap + kHeapCap, kStackCap = DM_GAME_MEM_STACK;
constexpr uint64_t kAlias = kStack + kStackCap, kAliasCap = DM_GAME_MEM_ALIAS;
constexpr uint64_t kPool = DM_GAME_APP_POOL;
enum : uint32_t { R_OutOfMemory = 0xD001, R_InvalidState = 0xD401, R_LimitReached = 0x10801, R_OutOfResource = 0xCE01, R_InvalidAddress = 0xCC01, R_InvalidSize = 0xCA01 };

struct Map { uint64_t base, size, src; uint32_t state; };
struct Mod { char name[16]; uint64_t base, size, ro_off, data_off; };
std::mutex g_lock;
uint64_t g_heap_cur = 0;
std::vector<Map> g_maps;
std::vector<Mod> g_mods;
std::vector<uint64_t> g_alias_bits(kAliasCap / 4096 / 64);     // one bit per 4 KiB page of the alias region
std::atomic<int64_t> g_alias_mapped{0};
uint64_t g_image_bytes = 0;

bool page_on(uint64_t p) { return g_alias_bits[p >> 6] >> (p & 63) & 1; }
// the run of pages around page p that have p's state: [lo, hi)
void alias_run(uint64_t p, uint64_t *lo, uint64_t *hi) {
    bool on = page_on(p); uint64_t n = kAliasCap / 4096, a = p, b = p + 1;
    while (a > 0 && page_on(a - 1) == on) a--;
    while (b < n && page_on(b) == on) b++;
    *lo = a; *hi = b;
}
const Map *map_find(uint64_t addr, uint64_t size) { for (auto &m : g_maps) if (addr < m.base + m.size && m.base < addr + size) return &m; return nullptr; }
const Map *src_find(uint64_t addr, uint64_t size) { for (auto &m : g_maps) if (m.src && addr < m.src + m.size && m.src < addr + size) return &m; return nullptr; }
const Mod *mod_of(uint64_t a) { for (auto &m : g_mods) if (a >= m.base && a < m.base + m.size) return &m; return nullptr; }
uint64_t used_bytes() { return g_heap_cur + DM_GAME_MEM_USED + (DM_GAME_MEM_MAP_LIMIT ? (uint64_t)g_alias_mapped.load() : 0); }
void say(const char *fmt, uint64_t a = 0, uint64_t b = 0, uint64_t c = 0) { char l[200]; snprintf(l, sizeof l, fmt, (unsigned long long)a, (unsigned long long)b, (unsigned long long)c); nx_log(l); }
}  // namespace

extern "C" {
void nx_mem_module(const char *name, uint64_t base, uint64_t size, uint64_t ro_off, uint64_t data_off) {
    std::lock_guard<std::mutex> l(g_lock);
    Mod m{}; snprintf(m.name, sizeof m.name, "%s", name); m.base = base; m.size = size; m.ro_off = ro_off; m.data_off = data_off;
    g_mods.push_back(m); g_image_bytes += size;
}
// A stack the host places itself (the main thread's): the first pages of the stack region, as a mapping of state Stack
uint64_t nx_mem_main_stack(uint64_t size) {
    std::lock_guard<std::mutex> l(g_lock);
    g_maps.push_back(Map{kStack, size, 0, 0x0B});
    return kStack + size;
}
uint64_t nx_mem_alias_mapped(void) { return (uint64_t)g_alias_mapped.load(); }
uint64_t nx_mem_heap_size(void) { std::lock_guard<std::mutex> l(g_lock); return g_heap_cur; }

// Returns 1 when num is one of this file's SVCs (regs[0] = result), 0 otherwise
int nx_mem_svc(int num, uint64_t *regs) {
    switch (num) {
    case 0x01: {  // SetHeapSize(→x1 base; x1 size)
        uint64_t size = regs[1];
        if (size > kHeapCap) { say("SetHeapSize OOM: req %#llx > cap %#llx", size, kHeapCap); regs[0] = R_OutOfMemory; return 1; }
        std::lock_guard<std::mutex> l(g_lock);
        if (size < g_heap_cur && src_find(kHeap + size, g_heap_cur - size)) { regs[0] = R_InvalidState; return 1; }
        uint64_t charged = DM_GAME_MEM_USED + (DM_GAME_MEM_MAP_LIMIT ? (uint64_t)g_alias_mapped.load() : 0);
        if (g_image_bytes > kPool || size > kPool - g_image_bytes || charged > kPool || size > kPool - charged) { regs[0] = R_LimitReached; return 1; }
        if (size < g_heap_cur) memset((void *)(uintptr_t)(kHeap + size), 0, g_heap_cur - size);
        else if (size > g_heap_cur) say("[mem] heap %llu MB (heap region %llu MB)", size >> 20, kHeapCap >> 20);
        g_heap_cur = size;
        regs[0] = 0; regs[1] = kHeap; return 1;
    }
    case 0x02: case 0x03: {  // SetMemoryPermission / SetMemoryAttribute: bookkeeping only; refused over a borrowed source
        std::lock_guard<std::mutex> l(g_lock);
        regs[0] = regs[1] && src_find(regs[0], regs[1]) ? R_InvalidState : 0; return 1;
    }
    case 0x04: case 0x05: {  // MapMemory(dst, src, size) / UnmapMemory: the SDK moves a thread's stack from the heap into the stack region
        uint64_t dst = regs[0], src = regs[1], size = regs[2];
        if ((dst | src) & 0xfff) { regs[0] = R_InvalidAddress; return 1; }
        if (!size || (size & 0xfff)) { regs[0] = R_InvalidSize; return 1; }
        std::lock_guard<std::mutex> l(g_lock);
        if (num == 0x04) {
            if (map_find(dst, size) || src_find(src, size)) { regs[0] = R_InvalidState; say("[RED] MapMemory refused: %#llx <- %#llx +%#llx", dst, src, size); return 1; }
            memcpy((void *)(uintptr_t)dst, (void *)(uintptr_t)src, size);   // move semantics: the source is not accessed while mapped
            g_maps.push_back(Map{dst, size, src, 0x0B});
        } else {
            size_t k = 0; for (; k < g_maps.size(); k++) if (g_maps[k].base == dst && g_maps[k].size == size && g_maps[k].src == src) break;
            if (k == g_maps.size()) { regs[0] = R_InvalidState; say("UnmapMemory does not match a mapping %#llx+%#llx", dst, size); return 1; }
            memcpy((void *)(uintptr_t)src, (void *)(uintptr_t)dst, size);
            memset((void *)(uintptr_t)dst, 0, size);
            g_maps.erase(g_maps.begin() + (long)k);
        }
        regs[0] = 0; return 1;
    }
    case 0x06: {  // QueryMemory(x0 MemoryInfo*, x2 address) → x1 page info
        uint64_t mi = regs[0], addr = regs[2], base, size; uint32_t state = 0, perm = 0, attr = 0;
        std::lock_guard<std::mutex> l(g_lock);
        const Map *m; const Mod *mod;
        bool in_alias = addr >= kAlias && addr < kAlias + kAliasCap;
        uint64_t rlo = 0, rhi = 0; bool on = false;
        if (in_alias) { alias_run((addr - kAlias) >> 12, &rlo, &rhi); on = page_on((addr - kAlias) >> 12); rlo = kAlias + (rlo << 12); rhi = kAlias + (rhi << 12); }
        if (addr >= kHeap && addr < kHeap + g_heap_cur) { base = kHeap; size = g_heap_cur; state = 5; perm = 3; }
        else if ((m = map_find(addr, 1))) { base = m->base; size = m->size; state = m->state; perm = 3; }
        else if (in_alias && on) { base = rlo; size = rhi - rlo; state = 5; perm = 3; }
        else if (addr >= kAs && addr < kAs + kReserve) {   // free: up to the neighbouring heap, mapping or mapped alias pages
            uint64_t lo = kAs, hi = kAs + kReserve;
            if (addr >= kHeap) lo = kHeap + g_heap_cur; else hi = kHeap;
            if (in_alias) { if (rlo > lo) lo = rlo; if (rhi < hi) hi = rhi; }
            else if (addr < kAlias) { uint64_t a, b; alias_run(0, &a, &b); uint64_t edge = page_on(0) ? kAlias : kAlias + (b << 12); if (edge < hi) hi = edge; }
            for (auto &x : g_maps) { uint64_t e = x.base + x.size; if (e <= addr && e > lo) lo = e; if (x.base > addr && x.base < hi) hi = x.base; }
            base = lo; size = hi - lo;
        } else if ((mod = mod_of(addr))) {
            uint64_t off = addr - mod->base;
            if (off < mod->ro_off) { base = mod->base; size = mod->ro_off; state = 3; perm = 5; }
            else if (off < mod->data_off) { base = mod->base + mod->ro_off; size = mod->data_off - mod->ro_off; state = 3; perm = 1; }
            else { base = mod->base + mod->data_off; size = mod->size - mod->data_off; state = 4; perm = 3; }
        } else { base = addr & ~0xFFFull; size = 0x1000; }
        if (const Map *s = src_find(addr, 1)) { (void)s; attr = 1; perm = 0; }   // a borrowed source: locked, inaccessible (hle_svc.c map_source_query)
        if (mi) { struct { uint64_t base, size; uint32_t state, attr, perm, ipc, device, reserved; } out = {base, size, state, attr, perm, 0, 0, 0}; memcpy((void *)(uintptr_t)mi, &out, sizeof out); }
        regs[0] = 0; regs[1] = 0; return 1;
    }
    case 0x2C: case 0x2D: {  // MapPhysicalMemory / UnmapPhysicalMemory(addr, size): only inside the alias region
        uint64_t a = regs[0], size = regs[1];
        if (!size || ((a | size) & 0xfff) || a < kAlias || a + size > kAlias + kAliasCap || a + size < a) {
            say("[RED] svc %#llx outside the alias region: %#llx +%#llx", (uint64_t)num, a, size); regs[0] = R_InvalidState; return 1;
        }
        std::lock_guard<std::mutex> l(g_lock);
        uint64_t p0 = (a - kAlias) >> 12, n = size >> 12; int64_t off = 0;
        for (uint64_t p = p0; p < p0 + n; p++) off += !page_on(p);
        if (num == 0x2C) {
            if (DM_GAME_MEM_MAP_LIMIT && off && (uint64_t)off * 4096 + used_bytes() > kPool) { regs[0] = R_LimitReached; return 1; }
            for (uint64_t p = p0; p < p0 + n; p++) g_alias_bits[p >> 6] |= 1ull << (p & 63);
            g_alias_mapped += off * 4096;
        } else {
            if (src_find(a, size)) { regs[0] = R_InvalidState; return 1; }
            for (uint64_t p = p0; p < p0 + n; p++) if (page_on(p)) { memset((void *)(uintptr_t)(kAlias + (p << 12)), 0, 4096); g_alias_bits[p >> 6] &= ~(1ull << (p & 63)); }
            g_alias_mapped -= ((int64_t)n - off) * 4096;
        }
        regs[0] = 0; return 1;
    }
    case 0x29: {  // GetInfo(→x1 value; x1 id, x2 handle, x3 sub id)
        uint64_t id = regs[1], v = 0;
        switch (id) {
        case 0: v = 7; break;                                         // CoreMask
        case 1: v = 0; break;                                         // PriorityMask (hle_svc.c answers 0)
        case 2: v = kAlias; break;   case 3: v = kAliasCap; break;
        case 4: v = kHeap; break;    case 5: v = kHeapCap; break;
        case 6: case 21: v = kPool; break;                            // TotalMemorySize / TotalNonSystem
        case 7: case 22: { std::lock_guard<std::mutex> l(g_lock); v = used_bytes(); break; }
        case 8: v = 0; break;                                         // DebuggerAttached
        case 11: { static std::atomic<uint64_t> s{0x9E3779B97F4A7C15ull}; uint64_t x = s.load(); x ^= x << 13; x ^= x >> 7; x ^= x << 17; s.store(x); v = x ^ nx_now_ns(); break; }
        case 12: v = kAs; break;     case 13: v = kReserve; break;
        case 14: v = kStack; break;  case 15: v = kStackCap; break;
        case 16: v = DM_GAME_SYS_RESOURCE; break; case 17: v = DM_GAME_SYS_RESOURCE ? 0x400000 : 0; break;
        case 18: v = DM_GAME_PROGRAM_ID; break;
        case 20: { alignas(0x1000) static uint8_t ctx[0x1000]; v = (uint64_t)(uintptr_t)ctx; break; }   // UserExceptionContextAddress
        case 23: v = 1; break;                                        // IsApplication
        case 24: v = 64; break;                                       // FreeThreadCount (hle_svc.c: 96 less the live threads)
        case 25: case 26: case 27: case 28: case 29: case 30: case 31: case 32: v = 0; break;   // thread ticks, IsSvcPermitted, IoRegionHint, alias extra size, remote regions: 0 as in hle_svc.c
        case 33: v = 0x1000; break;                                   // PageSize
        default: { static std::atomic<uint64_t> seen{0}; if (id < 64 && !(seen.fetch_or(1ull << id) >> id & 1)) say("[RED] svc GetInfo: unknown info type %llu (answered 0)", id); }
        }
        regs[0] = 0; regs[1] = v; return 1;
    }
    }
    return 0;
}
}
