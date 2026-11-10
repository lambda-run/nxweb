// Guest memory bookkeeping, one owner for all of it (nxnative hle_svc.c): the address-space layout, the heap, the
// MapMemory table (thread stacks moved into the stack region), the alias region's pages, device-shared ranges and the
// module table, and the one query that answers svcQueryMemory from them. See README.md for the layout.
import { Inst } from "../kit/machine";
import { traceEnable, traceEnabled } from "../kit/machine";
import { ALIAS_PAGE, AliasPageS, AliasPageE } from "../kit/gen/tables";
import { R_OK, R_OUT_OF_RES, R_OUT_OF_MEMORY, R_LIMIT, R_BAD_SIZE, R_BAD_ADDR, R_BAD_MEMORY, R_BAD_REGION,
  lineStart, lineEnd, puts, putx, putu } from "./base";

export const PAGE: u64 = 0x1000;

// ---- layout (kernel_init) ----
export let codeBase: u64 = 0;  export let codeSize: u64 = 0;     // module images
export let tlsBase: u64 = 0;   export let tlsSize: u64 = 0;      // user exception context page, then one slot per thread
export let heapBase: u64 = 0;  export let heapCap: u64 = 0;      // SetHeapSize
export let stackBase: u64 = 0; export let stackCap: u64 = 0;     // MapMemory destinations
export let aliasBase: u64 = 0; export let aliasCap: u64 = 0;     // MapPhysicalMemory
export let asBase: u64 = 0;    export let asEnd: u64 = 0;        // the guest address space: lowest base .. highest end
export let appPool: u64 = 0;       // the application memory pool GetInfo reports (nxnative profile key app_pool)
export let memUsed: u64 = 0;       // the used memory reported beside the heap (profile key mem_used)
export let sysResource: u64 = 0;   // the NPDM's system resource size (profile key sys_resource)
export let mapLimit: bool = false; // maps past the pool fail with ResultLimitReached (profile key mem_map_limit)

export const TLS_SLOT: u64 = 0x3000;      // per thread: ThreadLocalRegion 0x200, thread object 0x400, pad, TLS block 0x2000
export const TLS_TLR: u64 = 0;
export const TLS_THREAD_OBJ: u64 = 0x200;
export const TLS_BLOCK: u64 = 0x1000;

// ---- state ----
let heapCur: u64 = 0;
let heapSeen: u64 = 0;       // the largest heap so far: a heap that grows back below it reads zero there
let aliasMapped: u64 = 0;    // bytes in Mapped pages
let aliasHigh: u64 = 0;      // one past the highest page index ever mapped (bounds the page scans)

export const MAX_MAP: i32 = 4096;
const MAPS: usize = memory.data(98304);    // MAX_MAP * 24: base, size, src
let nmap: i32 = 0;
const MAX_SHARE: i32 = 256;
const SHARES: usize = memory.data(6144);   // MAX_SHARE * 24: lo, hi, count
let nshare: i32 = 0;
export const MAX_MODULES: i32 = 64;
const MODS: usize = memory.data(2048);     // MAX_MODULES * 32: base, size, ro offset, data offset
let nmod: i32 = 0;
// The alias region's pages: one kit instance (16 bytes) per 4 KiB page, in a two-level table.
//   directory  one entry (the address of a leaf, 0 = none) per 16 MB of the region: 4096 entries, 64 GB of address space
//   leaf       4096 instances, 64 KiB. Made when a page of its 16 MB is first mapped or unmapped; a page without a leaf
//              is Fresh. Leaves are never given back before the next memInit.
// The first 224 leaves come from static data (14 MB, what the flat table of a 3.5 GB region was): every layout of a
// 32-bit memory is covered by them. A 64-bit memory's alias region may be larger: further leaves come from the arena
// the embedder gave (aliasArena: host-side memory sized from the process's layout), and a map that needs a leaf
// nobody can give fails with ResultOutOfResource and a red line.
// @ts-ignore: decorator
@inline const M64: bool = sizeof<usize>() == 8;
const LEAF_SHIFT: u64 = 12, LEAF_PAGES: u64 = 4096, LEAF_BYTES: usize = 65536;
const DIR_N: u64 = 4096;
const POOL_LEAVES: usize = 224;
const MAX_ALIAS_PAGES: u64 = M64 ? DIR_N * LEAF_PAGES : 917504;   // 64 GB of directory; a 32-bit memory: 3.5 GB (the static leaves)
const DIR: usize = memory.data(32768);        // DIR_N * 8
const PAGES: usize = memory.data(14680064);   // POOL_LEAVES * LEAF_BYTES
let poolUsed: usize = 0;
let arenaLo: usize = 0, arenaHi: usize = 0;   // the embedder's leaf memory, from arenaLo on still free
let leafCount: u32 = 0;
const AS_LIMIT: u64 = M64 ? 0x3FFFF0000 : 0xFFFF0000;    // no region reaches past it: the memory's most (16 GB / 4 GB) less the last 64 KiB
const MEM_LIMIT: u64 = M64 ? 0x400000000 : 0x100000000;  // the most a linear memory can be

// @ts-ignore: decorator
@inline function leafOf(i: u64): usize { return <usize>load<u64>(DIR + (<usize>(i >> LEAF_SHIFT) << 3)); }
// The state of page i (no leaf: Fresh)
// @ts-ignore: decorator
@inline function pageState(i: u64): u8 { const l = leafOf(i); return l ? Inst.at(l + (<usize>(i & (LEAF_PAGES - 1)) << 4)).state : <u8>AliasPageS.Fresh; }
function leafNew(d: u64): usize {
  let l: usize = 0;
  if (poolUsed < POOL_LEAVES) { l = PAGES + poolUsed * LEAF_BYTES; poolUsed++; }
  else if (arenaHi - arenaLo >= LEAF_BYTES) { l = arenaLo; arenaLo += LEAF_BYTES; }
  else return 0;
  const was = traceEnabled(); traceEnable(false);
  for (let k: u64 = 0; k < LEAF_PAGES; k++) Inst.at(l + (<usize>k << 4)).init(ALIAS_PAGE, <u32>((d << LEAF_SHIFT) + k));
  traceEnable(was);
  store<u64>(DIR + (<usize>d << 3), l);
  leafCount++;
  return l;
}
// Page i's instance, to step it: its leaf is made when there is none. null when no leaf can be had.
function page(i: u64): Inst | null {
  let l = leafOf(i);
  if (!l) { l = leafNew(i >> LEAF_SHIFT); if (!l) return null; }
  return Inst.at(l + (<usize>(i & (LEAF_PAGES - 1)) << 4));
}
// Every page of [first, end) has a leaf (made now when it had none); false when one cannot be had
function leavesFor(first: u64, end: u64): bool {
  for (let d = first >> LEAF_SHIFT, e = (end + LEAF_PAGES - 1) >> LEAF_SHIFT; d < e; d++)
    if (!load<u64>(DIR + (<usize>d << 3)) && !leafNew(d)) return false;
  return true;
}
// Leaf memory beyond the static leaves: [base, base + size), zeroed or not, outside every guest region, the kernel's
// from now until the next memInit. Returns how many leaves it holds.
export function aliasArena(base: usize, size: usize): u32 {
  arenaLo = (base + 15) & ~<usize>15; arenaHi = base + size;
  return arenaHi > arenaLo ? <u32>((arenaHi - arenaLo) / LEAF_BYTES) : 0;
}
// Leaves in use, and how many more the static pool and the arena can give
export function aliasLeaves(): u32 { return leafCount; }
export function aliasLeavesFree(): u32 { return <u32>(POOL_LEAVES - poolUsed) + <u32>((arenaHi - arenaLo) / LEAF_BYTES); }
// @ts-ignore: decorator
@inline function mapP(i: i32): usize { return MAPS + <usize>i * 24; }
// @ts-ignore: decorator
@inline function contains(base: u64, cap: u64, addr: u64, size: u64): bool { return addr >= base && size <= cap && addr - base <= cap - size; }

export function heapSize(): u64 { return heapCur; }
export function aliasMappedBytes(): u64 { return aliasMapped; }
export function mapCount(): i32 { return nmap; }
export function tlsSlots(): u64 { return tlsSize > PAGE ? (tlsSize - PAGE) / TLS_SLOT : 0; }
export function tlsSlotAddr(i: u32): u64 { return tlsBase + PAGE + <u64>i * TLS_SLOT; }

// Layout errors (kernel_init's result)
export const E_LAYOUT_ALIGN: i32 = 1;     // a base or size is not a multiple of 4 KiB
export const E_LAYOUT_RANGE: i32 = 2;     // a region is empty or reaches past 0xFFFF0000 (a 64-bit memory: 0x3_FFFF_0000)
export const E_LAYOUT_OVERLAP: i32 = 3;   // two regions overlap
export const E_LAYOUT_ALIAS: i32 = 4;     // the alias region is larger than 3.5 GB (a 64-bit memory: than the page directory's 64 GB)

const REG: usize = memory.data(80);
function regionsOk(): i32 {
  store<u64>(REG, codeBase, 0);   store<u64>(REG, codeSize, 8);
  store<u64>(REG, tlsBase, 16);   store<u64>(REG, tlsSize, 24);
  store<u64>(REG, heapBase, 32);  store<u64>(REG, heapCap, 40);
  store<u64>(REG, stackBase, 48); store<u64>(REG, stackCap, 56);
  store<u64>(REG, aliasBase, 64); store<u64>(REG, aliasCap, 72);
  asBase = u64.MAX_VALUE; asEnd = 0;
  for (let i = 0; i < 5; i++) {
    const b = load<u64>(REG + (<usize>i << 4)), n = load<u64>(REG + (<usize>i << 4), 8);
    if ((b | n) & (PAGE - 1)) return E_LAYOUT_ALIGN;
    if (!n || b > AS_LIMIT || n > AS_LIMIT - b) return E_LAYOUT_RANGE;
    for (let k = 0; k < i; k++) {
      const b2 = load<u64>(REG + (<usize>k << 4)), n2 = load<u64>(REG + (<usize>k << 4), 8);
      if (b < b2 + n2 && b2 < b + n) return E_LAYOUT_OVERLAP;
    }
    if (b < asBase) asBase = b;
    if (b + n > asEnd) asEnd = b + n;
  }
  if (aliasCap / PAGE > MAX_ALIAS_PAGES) return E_LAYOUT_ALIAS;
  return 0;
}

// cfg: 0 = the default layout, else a block of little-endian u64: code base, code size, tls base, tls size, heap base,
// heap size, stack base, stack size, alias base, alias size, application pool, used memory, system resource
export function memInit(cfg: usize, flagMapLimit: bool): i32 {
  if (cfg) {
    codeBase = load<u64>(cfg, 0);   codeSize = load<u64>(cfg, 8);
    tlsBase = load<u64>(cfg, 16);   tlsSize = load<u64>(cfg, 24);
    heapBase = load<u64>(cfg, 32);  heapCap = load<u64>(cfg, 40);
    stackBase = load<u64>(cfg, 48); stackCap = load<u64>(cfg, 56);
    aliasBase = load<u64>(cfg, 64); aliasCap = load<u64>(cfg, 72);
    appPool = load<u64>(cfg, 80); memUsed = load<u64>(cfg, 88); sysResource = load<u64>(cfg, 96);
  } else {
    codeBase = 0x08000000;  codeSize = 0x0FC00000;    // 252 MB of module images
    tlsBase = 0x17C00000;   tlsSize = 0x00400000;     // 4 MB
    heapBase = 0x18000000;  heapCap = 0x60000000;     // 1.5 GB
    stackBase = 0x78000000; stackCap = 0x10000000;    // 256 MB
    aliasBase = 0x88000000; aliasCap = 0x77FF0000;    // 1.875 GB less the last 64 KiB
    appPool = 0xCD500000; memUsed = 0x04000000; sysResource = 0;
  }
  mapLimit = flagMapLimit;
  heapCur = 0; heapSeen = 0; aliasMapped = 0; aliasHigh = 0; nmap = 0; nshare = 0; nmod = 0;
  // no page has a leaf: every page is Fresh
  memory.fill(DIR, 0, 32768); poolUsed = 0; arenaLo = 0; arenaHi = 0; leafCount = 0;
  return regionsOk();
}

// The linear memory reaches end (grown when it does not)
export function commit(end: u64): bool {
  const have = <u64>memory.size() << 16;
  if (end <= have) return true;
  if (end > MEM_LIMIT) return false;
  return memory.grow(<i32>((end - have + 0xFFFF) >> 16)) >= 0;
}

// ---- modules ----
// base and size of the image; [0, ro) is code (RX), [ro, data) read-only data (R), [data, size) data and bss (RW)
export function moduleAdd(base: u64, size: u64, ro: u64, data: u64): i32 {
  if (nmod == MAX_MODULES || !size || ((base | size | ro | data) & (PAGE - 1)) || ro > data || data > size || !contains(codeBase, codeSize, base, size)) return -1;
  for (let i = 0; i < nmod; i++) {
    const p = MODS + (<usize>i << 5);
    if (base < load<u64>(p) + load<u64>(p, 8) && load<u64>(p) < base + size) return -1;
  }
  const p = MODS + (<usize>nmod << 5);
  store<u64>(p, base); store<u64>(p, size, 8); store<u64>(p, ro, 16); store<u64>(p, data, 24);
  return nmod++;
}
// Refused while a mapped stack borrows its data (nxnative svc_nro_deactivate)
export function moduleRemove(base: u64): bool {
  for (let i = 0; i < nmod; i++) {
    const p = MODS + (<usize>i << 5);
    if (load<u64>(p) != base) continue;
    if (sourceBusy(base, load<u64>(p, 8))) return false;
    nmod--;
    memory.copy(p, MODS + (<usize>nmod << 5), 32);
    return true;
  }
  return false;
}
function moduleOf(addr: u64): i32 {
  for (let i = 0; i < nmod; i++) {
    const p = MODS + (<usize>i << 5);
    if (addr >= load<u64>(p) && addr - load<u64>(p) < load<u64>(p, 8)) return i;
  }
  return -1;
}
// The images' footprint in the pool, in 2 MB units (nxnative image_bytes)
function imageBytes(): u64 {
  let n: u64 = 0;
  for (let i = 0; i < nmod; i++) n += load<u64>(MODS + (<usize>i << 5), 8);
  return (n + 0x1FFFFF) & ~<u64>0x1FFFFF;
}

// ---- device-shared ranges (an NVN memory pool's storage): not given back while registered ----
export function deviceShare(lo: u64, size: u64, share: bool): void {
  const hi = lo + size;
  if (!size || hi < lo) return;
  let i = 0;
  while (i < nshare && (load<u64>(SHARES + <usize>i * 24) != lo || load<u64>(SHARES + <usize>i * 24, 8) != hi)) i++;
  if (share) {
    if (i == nshare) {
      if (nshare == MAX_SHARE) { lineStart("[RED] kernel: device-shared range table full"); lineEnd(); return; }
      const p = SHARES + <usize>i * 24;
      store<u64>(p, lo); store<u64>(p, hi, 8); store<u64>(p, 0, 16);
      nshare++;
    }
    const p = SHARES + <usize>i * 24;
    store<u64>(p, load<u64>(p, 16) + 1, 16);
  } else if (i < nshare) {
    const p = SHARES + <usize>i * 24, n = load<u64>(p, 16) - 1;
    if (n) store<u64>(p, n, 16);
    else { nshare--; memory.copy(p, SHARES + <usize>nshare * 24, 24); }
  } else {
    lineStart("[RED] kernel: device-shared memory "); putx(lo); puts("+"); putx(size); puts(" removed but never registered"); lineEnd();
  }
}
function deviceShared(addr: u64, size: u64): bool {
  for (let i = 0; i < nshare; i++) {
    const p = SHARES + <usize>i * 24;
    if (addr < load<u64>(p, 8) && load<u64>(p) < addr + size) return true;
  }
  return false;
}

// ---- the MapMemory table ----
function mapFind(a: u64, n: u64): i32 {   // 1-based, 0 = no mapping overlaps
  for (let i = 0; i < nmap; i++) { const p = mapP(i); if (a < load<u64>(p) + load<u64>(p, 8) && load<u64>(p) < a + n) return i + 1; }
  return 0;
}
function sourceBusy(addr: u64, size: u64): bool {
  for (let i = 0; i < nmap; i++) { const p = mapP(i); if (addr < load<u64>(p, 16) + load<u64>(p, 8) && load<u64>(p, 16) < addr + size) return true; }
  return false;
}
function mapArguments(dst: u64, src: u64, size: u64): u64 {
  if ((dst | src) & 0xFFF) return R_BAD_ADDR;
  if (!size || (size & 0xFFF)) return R_BAD_SIZE;
  if (size > u64.MAX_VALUE - src || size > u64.MAX_VALUE - dst) return R_BAD_MEMORY;
  return contains(stackBase, stackCap, dst, size) ? R_OK : R_BAD_REGION;
}

// A stack the embedder maps for a thread it starts itself (the main thread's: on Horizon the process creator maps it
// in the stack region before the first instruction runs). It is a MapMemory entry with no source: the source field
// holds an address above 4 GB that no guest range can overlap, so nothing counts as borrowed and UnmapMemory cannot
// match it. The memory reads zero. Returns false when the range is not pages inside the stack region, overlaps a
// mapping, the table is full or the linear memory cannot grow.
export const NO_SOURCE: u64 = 0xFFFFFFFF00000000;
export function hostStackMap(dst: u64, size: u64): bool {
  if (!size || ((dst | size) & 0xFFF) || !contains(stackBase, stackCap, dst, size)) return false;
  if (mapFind(dst, size) || nmap == MAX_MAP || !commit(dst + size)) return false;
  memory.fill(<usize>dst, 0, <usize>size);
  const p = mapP(nmap++);
  store<u64>(p, dst); store<u64>(p, size, 8); store<u64>(p, NO_SOURCE + dst, 16);
  return true;
}

// ---- alias pages ----
function aliasUnmapped(off: u64, size: u64): u64 {
  let c: u64 = 0;
  for (let p = off >> 12, e = (off + size) >> 12; p < e; p++) {
    if (!leafOf(p)) { const next = ((p >> LEAF_SHIFT) + 1) << LEAF_SHIFT, stop = next < e ? next : e; c += stop - p; p = stop - 1; continue; }   // a whole leaf's worth of Fresh pages
    if (pageState(p) != AliasPageS.Mapped) c++;
  }
  return c;
}
// Scans over unmapped pages step over a part of the region that has no leaf in one go. skipDown(lo): page lo - 1 is
// not mapped; the next lo to look below (lo - 1, or the first page of the leafless 16 MB that holds lo - 1).
// skipUp(hi): page hi is not mapped; hi + 1, or the page after its leafless 16 MB.
// @ts-ignore: decorator
@inline function skipDown(lo: u64): u64 { return leafOf(lo - 1) ? lo - 1 : ((lo - 1) >> LEAF_SHIFT) << LEAF_SHIFT; }
// @ts-ignore: decorator
@inline function skipUp(hi: u64): u64 { return leafOf(hi) ? hi + 1 : ((hi >> LEAF_SHIFT) + 1) << LEAF_SHIFT; }
// The run of pages around page p that are mapped like it: [lo, hi) in pages
let runLo: u64 = 0, runHi: u64 = 0;
function aliasRun(p: u64): bool {
  const mapped = pageState(p) == AliasPageS.Mapped, total = aliasCap >> 12;
  if (!mapped && p >= aliasHigh) {   // nothing was ever mapped from aliasHigh up
    runHi = total;
    let lo = aliasHigh;
    while (lo && pageState(lo - 1) != AliasPageS.Mapped) lo = skipDown(lo);
    runLo = lo;
    return false;
  }
  let lo = p, hi = p + 1;
  while (lo && (pageState(lo - 1) == AliasPageS.Mapped) == mapped) lo = mapped ? lo - 1 : skipDown(lo);
  while (hi < aliasHigh && (pageState(hi) == AliasPageS.Mapped) == mapped) hi = mapped ? hi + 1 : skipUp(hi);
  if (!mapped && hi >= aliasHigh) hi = total;
  runLo = lo; runHi = hi;
  return mapped;
}

// A MapMemory source must be memory the process has: the heap, mapped alias pages, or a module's data
function sourceBacked(src: u64, size: u64): bool {
  if (contains(heapBase, heapCur, src, size)) return true;
  if (contains(aliasBase, aliasCap, src, size)) return aliasUnmapped(src - aliasBase, size) == 0;
  const m = moduleOf(src);
  if (m < 0) return false;
  const p = MODS + (<usize>m << 5), off = src - load<u64>(p);
  return off >= load<u64>(p, 24) && size <= load<u64>(p, 8) - off;
}

// ---- SVCs ----
// 0x01 SetHeapSize. The heap's base is heapBase; the result is the Horizon result code
export function setHeapSize(size: u64): u64 {
  if (size > heapCap) {
    lineStart("kernel: SetHeapSize out of memory: "); putx(size); puts(" > heap region "); putx(heapCap); lineEnd();
    return R_OUT_OF_MEMORY;
  }
  if (size < heapCur && (sourceBusy(heapBase + size, heapCur - size) || deviceShared(heapBase + size, heapCur - size))) return R_BAD_MEMORY;
  const image = imageBytes();
  if (image > appPool || size > appPool - image) return R_LIMIT;   // games retry in 2 MB decrements
  if (mapLimit) {
    const charged = memUsed + aliasMapped;
    if (charged > appPool || size > appPool - charged) return R_LIMIT;
  }
  if (size > heapCur) {
    if (!commit(heapBase + size)) return R_OUT_OF_MEMORY;
    // linear memory is never given back: what an earlier, larger heap left behind reads zero again
    if (heapSeen > heapCur) memory.fill(<usize>(heapBase + heapCur), 0, <usize>((size < heapSeen ? size : heapSeen) - heapCur));
  }
  if (size > heapSeen) heapSeen = size;
  heapCur = size;
  return R_OK;
}
// 0x02 SetMemoryPermission / 0x03 SetMemoryAttribute: nothing to change, but a borrowed source is refused
export function permissionStub(addr: u64, size: u64): u64 {
  return size > u64.MAX_VALUE - addr || (size && sourceBusy(addr, size)) ? R_BAD_MEMORY : R_OK;
}
// 0x04 MapMemory: the SDK moves a thread's stack from the heap into the stack region
export function mapMemory(dst: u64, src: u64, size: u64): u64 {
  let r = mapArguments(dst, src, size);
  if (r) return r;
  if (mapFind(dst, size) || sourceBusy(src, size) || !sourceBacked(src, size)) r = R_BAD_MEMORY;
  else if (nmap == MAX_MAP || !commit(dst + size)) r = R_OUT_OF_RES;
  if (r) {
    lineStart("[RED] kernel: MapMemory refused ("); putx(r); puts("): "); putx(dst); puts(" <- "); putx(src); puts(" +"); putx(size); lineEnd();
    return r;
  }
  memory.copy(<usize>dst, <usize>src, <usize>size);
  const p = mapP(nmap++);
  store<u64>(p, dst); store<u64>(p, size, 8); store<u64>(p, src, 16);
  return R_OK;
}
// 0x05 UnmapMemory: the bytes move back to the source
export function unmapMemory(dst: u64, src: u64, size: u64): u64 {
  const r = mapArguments(dst, src, size);
  if (r) return r;
  const k = mapFind(dst, size);
  if (!k) return R_BAD_MEMORY;
  const p = mapP(k - 1);
  if (load<u64>(p) != dst || load<u64>(p, 8) != size || load<u64>(p, 16) != src) return R_BAD_MEMORY;
  memory.copy(<usize>src, <usize>dst, <usize>size);
  nmap--;
  memory.copy(p, mapP(nmap), 24);
  return R_OK;
}
// 0x2C MapPhysicalMemory / 0x2D UnmapPhysicalMemory
export function physicalMemory(addr: u64, size: u64, map: bool): u64 {
  if (!size || ((addr | size) & 0xFFF) || !contains(aliasBase, aliasCap, addr, size)) return R_BAD_MEMORY;
  if (!map && (sourceBusy(addr, size) || deviceShared(addr, size))) return R_BAD_MEMORY;
  const off = addr - aliasBase, first = off >> 12, end = (off + size) >> 12;
  if (map) {
    const need = aliasUnmapped(off, size) * PAGE;
    if (mapLimit && need) {
      const used = heapCur + memUsed + aliasMapped;
      if (used > appPool || need > appPool - used) return R_LIMIT;
    }
    if (!commit(addr + size)) return R_LIMIT;
  }
  if (!leavesFor(first, end)) {
    lineStart("[RED] kernel: no memory for the alias region's page table at "); putx(addr); puts(" +"); putx(size); puts(" ("); putu(leafCount); puts(" leaves in use)"); lineEnd();
    return R_OUT_OF_RES;
  }
  // a page's transitions go through the kit like any other, but not into the trace ring: one large map would fill it
  const was = traceEnabled(); traceEnable(false);
  for (let p = first; p < end; p++) {
    const pg = page(p)!, st = pg.state;
    if (map) {
      if (st == AliasPageS.Stale) memory.fill(<usize>(aliasBase + (p << 12)), 0, 0x1000);
      pg.step(AliasPageE.Map);
      if (st != AliasPageS.Mapped) aliasMapped += PAGE;
    } else {
      pg.step(AliasPageE.Unmap);
      if (st == AliasPageS.Mapped) aliasMapped -= PAGE;
    }
  }
  traceEnable(was);
  if (map && end > aliasHigh) aliasHigh = end;
  return R_OK;
}

// 0x06 QueryMemory: the segment around addr
export let qBase: u64 = 0, qSize: u64 = 0;
export let qState: u32 = 0, qAttr: u32 = 0, qPerm: u32 = 0;
export const MS_FREE: u32 = 0, MS_CODE: u32 = 3, MS_CODE_DATA: u32 = 4, MS_HEAP: u32 = 5, MS_STACK: u32 = 0xB, MS_TLS: u32 = 0xC;

// @ts-ignore: decorator
@inline function seg(base: u64, size: u64, state: u32, perm: u32): void { qBase = base; qSize = size; qState = state; qPerm = perm; }
// A mapped range [b, e) narrows the free range [lo, hi) around addr
let fLo: u64 = 0, fHi: u64 = 0;
// @ts-ignore: decorator
@inline function bound(addr: u64, b: u64, e: u64): void {
  if (e <= addr) { if (e > fLo) fLo = e; }
  else if (b > addr && b < fHi) fHi = b;
}

export function queryMemory(addr: u64): void {
  qAttr = 0;
  let k: i32, m: i32;
  const inAlias = addr >= aliasBase && addr - aliasBase < aliasCap;
  if (addr >= heapBase && addr - heapBase < heapCur) seg(heapBase, heapCur, MS_HEAP, 3);
  else if ((k = mapFind(addr, 1)) != 0) seg(load<u64>(mapP(k - 1)), load<u64>(mapP(k - 1), 8), MS_STACK, 3);
  else if (inAlias && aliasRun((addr - aliasBase) >> 12)) seg(aliasBase + (runLo << 12), (runHi - runLo) << 12, MS_HEAP, 3);
  else if ((m = moduleOf(addr)) >= 0) {
    // Horizon's layout of an image: the SDK's exception unwinding walks back over Code+RX to the module start
    const p = MODS + (<usize>m << 5), mb = load<u64>(p), size = load<u64>(p, 8), ro = load<u64>(p, 16), da = load<u64>(p, 24), off = addr - mb;
    if (off < ro) seg(mb, ro, MS_CODE, 5);
    else if (off < da) seg(mb + ro, da - ro, MS_CODE, 1);
    else seg(mb + da, size - da, MS_CODE_DATA, 3);
  }
  else if (addr >= tlsBase && addr - tlsBase < tlsSize) seg(tlsBase, tlsSize, MS_TLS, 3);
  else if (addr >= asBase && addr < asEnd) {
    // free: up to the nearest mapped thing on either side
    fLo = asBase; fHi = asEnd;
    if (heapCur) bound(addr, heapBase, heapBase + heapCur);
    bound(addr, tlsBase, tlsBase + tlsSize);
    for (let i = 0; i < nmap; i++) bound(addr, load<u64>(mapP(i)), load<u64>(mapP(i)) + load<u64>(mapP(i), 8));
    for (let i = 0; i < nmod; i++) { const p = MODS + (<usize>i << 5); bound(addr, load<u64>(p), load<u64>(p) + load<u64>(p, 8)); }
    if (inAlias) {   // aliasRun above left the unmapped run around addr
      if (runLo) bound(addr, aliasBase, aliasBase + (runLo << 12));
      if (runHi < aliasCap >> 12) bound(addr, aliasBase + (runHi << 12), aliasBase + aliasCap);
    } else {
      // the alias region's mapped pages nearest to addr: the first when it lies above, the last when below
      let lo: u64 = 0, hi = aliasHigh;
      while (lo < hi && pageState(lo) != AliasPageS.Mapped) lo = skipUp(lo);
      if (lo > hi) lo = hi;
      while (hi > lo && pageState(hi - 1) != AliasPageS.Mapped) hi = skipDown(hi);
      if (hi < lo) hi = lo;
      if (lo < hi) bound(addr, addr < aliasBase ? aliasBase + (lo << 12) : aliasBase, addr < aliasBase ? aliasBase + aliasCap : aliasBase + (hi << 12));
    }
    seg(fLo, fHi - fLo, MS_FREE, 0);
  }
  else seg(addr & ~<u64>0xFFF, 0x1000, MS_FREE, 0);   // outside the guest address space: the page around it, free
  // A range a mapped stack borrows is its own segment: Locked (attribute 1), no permissions (nxnative map_source_query)
  let lo = qBase, remaining = qSize;
  for (let i = 0; i < nmap; i++) {
    const src = load<u64>(mapP(i), 16), end = src + load<u64>(mapP(i), 8);
    let lower = lo, upper = remaining;
    if (addr >= src && addr < end) {
      if (src > lower) lower = src;
      if (end - lo < upper) upper = end - lo;
      qAttr = 1; qPerm = 0;
    } else if (end <= addr && end > lower) lower = end;
    else if (src > addr && src - lo < upper) upper = src - lo;
    remaining = upper - (lower - lo); lo = lower;
  }
  qBase = lo; qSize = remaining;
}

// What GetInfo reports as used memory (nxnative: heap + profile mem_used, plus the mapped alias pages under mem_map_limit)
export function usedMemory(): u64 { return heapCur + memUsed + (mapLimit ? aliasMapped : 0); }

// For the consistency check: the page counter agrees with the pages. 0 = fine
export function memCheck(): i32 {
  let n: u64 = 0;
  for (let p: u64 = 0; p < aliasHigh; p = leafOf(p) ? p + 1 : skipUp(p)) if (pageState(p) == AliasPageS.Mapped) n++;
  if (n * PAGE != aliasMapped) return 30;
  for (let p = aliasHigh, e = aliasCap >> 12; p < e && p < aliasHigh + 64; p++) if (pageState(p) != AliasPageS.Fresh) return 31;
  if (heapCur > heapCap || heapSeen < heapCur) return 32;
  return 0;
}
// One alias page's state (AliasPageS), for tests and dumps
export function aliasPageState(addr: u64): i32 {
  return addr >= aliasBase && addr - aliasBase < aliasCap ? pageState((addr - aliasBase) >> 12) : -1;
}
