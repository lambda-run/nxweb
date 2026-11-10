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
// One kit instance per alias page: 16 bytes each, room for a 2 GB alias region
const MAX_ALIAS_PAGES: u64 = 524288;
const PAGES: usize = memory.data(8388608);

// @ts-ignore: decorator
@inline function page(i: u64): Inst { return Inst.at(PAGES + (<usize>i << 4)); }
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
export const E_LAYOUT_RANGE: i32 = 2;     // a region is empty or reaches past 0xFFFF0000
export const E_LAYOUT_OVERLAP: i32 = 3;   // two regions overlap
export const E_LAYOUT_ALIAS: i32 = 4;     // the alias region is larger than 2 GB

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
    if (!n || b > 0xFFFF0000 || n > 0xFFFF0000 - b) return E_LAYOUT_RANGE;
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
  const e = regionsOk();
  if (e) return e;
  const was = traceEnabled(); traceEnable(false);
  for (let i: u64 = 0, n = aliasCap / PAGE; i < n; i++) page(i).init(ALIAS_PAGE, <u32>i);
  traceEnable(was);
  return 0;
}

// The linear memory reaches end (grown when it does not)
export function commit(end: u64): bool {
  const have = <u64>memory.size() << 16;
  if (end <= have) return true;
  if (end > 0x100000000) return false;
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

// ---- alias pages ----
function aliasUnmapped(off: u64, size: u64): u64 {
  let c: u64 = 0;
  for (let p = off >> 12, e = (off + size) >> 12; p < e; p++) if (page(p).state != AliasPageS.Mapped) c++;
  return c;
}
// The run of pages around page p that are mapped like it: [lo, hi) in pages
let runLo: u64 = 0, runHi: u64 = 0;
function aliasRun(p: u64): bool {
  const mapped = page(p).state == AliasPageS.Mapped, total = aliasCap >> 12;
  if (!mapped && p >= aliasHigh) {   // nothing was ever mapped from aliasHigh up
    runHi = total;
    let lo = aliasHigh;
    while (lo && page(lo - 1).state != AliasPageS.Mapped) lo--;
    runLo = lo;
    return false;
  }
  let lo = p, hi = p + 1;
  while (lo && (page(lo - 1).state == AliasPageS.Mapped) == mapped) lo--;
  while (hi < aliasHigh && (page(hi).state == AliasPageS.Mapped) == mapped) hi++;
  if (!mapped && hi == aliasHigh) hi = total;
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
  // a page's transitions go through the kit like any other, but not into the trace ring: one large map would fill it
  const was = traceEnabled(); traceEnable(false);
  for (let p = first; p < end; p++) {
    const pg = page(p), st = pg.state;
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
      while (lo < hi && page(lo).state != AliasPageS.Mapped) lo++;
      while (hi > lo && page(hi - 1).state != AliasPageS.Mapped) hi--;
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
  for (let p: u64 = 0; p < aliasHigh; p++) if (page(p).state == AliasPageS.Mapped) n++;
  if (n * PAGE != aliasMapped) return 30;
  for (let p = aliasHigh, e = aliasCap >> 12; p < e && p < aliasHigh + 64; p++) if (page(p).state != AliasPageS.Fresh) return 31;
  if (heapCur > heapCap || heapSeen < heapCur) return 32;
  return 0;
}
// One alias page's state (AliasPageS), for tests and dumps
export function aliasPageState(addr: u64): i32 {
  return addr >= aliasBase && addr - aliasBase < aliasCap ? page((addr - aliasBase) >> 12).state : -1;
}
