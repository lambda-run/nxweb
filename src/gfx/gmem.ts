// The live NVN buffers, for shaders that read memory through addresses they load (src/shaders/spv.ts globalMemory; nxnative's memory pool table, nvn_mtl.m
// gmem_map). Such an address is a buffer's (nvnBufferGetAddress) plus an offset, kept by the game in a storage buffer; the recorder finds the buffer it lies in at
// each draw or dispatch (lower.ts emitGmem) and the replayer binds that buffer's range. A buffer and not its pool, as nxnative has it: the replayer uploads what it
// binds, and a pool is far more than a shader reads.
// The table holds the buffer objects, not their ranges: a virtual pool's memory is known only once it is mapped (dispatch.ts nvnMemoryPoolMapVirtual)
import * as L from "./log";
import * as O from "./obj";
import { arenaBig } from "./arena";

const CAP: i32 = 131072;      // the game holds more than 32768 live buffers in its first 3D area
let said = false;
export const GMEM_MAX_BYTES: u64 = 128 << 20;   // WebGPU's default maxStorageBufferBindingSize

// The table is found by address, not walked: the game makes and ends some 2,400 buffers a frame and a draw looks up to
// 16 addresses, with 30,000 to 60,000 buffers live (a walk was 34 us per nvnBufferFinalize and most of a draw's lowering).
// An entry is { usize buffer, i32 next, i32 prev } in a chain: the chain of the 64 KiB page its range starts in when the
// buffer is at most 64 KiB and its pool has memory already (an address then lies in a buffer of its own page's chain
// or of the page before), else the one chain of all the others (large buffers, pools not mapped yet), which is walked.
// The buffer object keeps its entry (+16, entry + 1) and its chain (+20, chain + 1): ending it is a few stores.
const ES: usize = 16, NB: i32 = 65536, SLOW: i32 = NB, SMALL: u64 = 65536;
const BUF_ent: usize = 16, BUF_chain: usize = 20;
let ENT: usize = 0, HEAD: usize = 0, nEnt: i32 = 0, freeEnt: i32 = -1, nLive: i32 = 0;
// @ts-ignore: decorator
@inline function eBuf(i: i32): usize { return load<usize>(ENT + <usize>i * ES); }
// @ts-ignore: decorator
@inline function eNext(i: i32): i32 { return load<i32>(ENT + <usize>i * ES, 8); }
// @ts-ignore: decorator
@inline function chainOf(start: u64): i32 { return <i32>((start >> 16) & <u64>(NB - 1)); }
// @ts-ignore: decorator
@inline function headOf(c: i32): i32 { return load<i32>(HEAD + (<usize>c << 2)); }

export function gmemBufInit(buf: usize): void {   // nvnBufferInitialize (the object's fields are set by the caller after this: the range is read from the builder's values through the object later)
  if (!ENT) { ENT = arenaBig(<usize>CAP * ES); HEAD = arenaBig(<usize>(NB + 1) << 2); memory.fill(HEAD, 0xff, <usize>(NB + 1) << 2); }
  let i = freeEnt;
  if (i >= 0) freeEnt = eNext(i);
  else if (nEnt < CAP) i = nEnt++;
  else { if (!said) { said = true; L.redLine("more than 131072 live buffers: memory a shader reads through a loaded address is not found in the others"); } return; }
  store<usize>(ENT + <usize>i * ES, buf); store<i32>(ENT + <usize>i * ES, -1, 8); store<i32>(ENT + <usize>i * ES, -1, 12);
  store<u32>(buf, <u32>(i + 1), BUF_ent); store<u32>(buf, 0, BUF_chain);   // not in a chain yet: gmemBufPlace
  nLive++;
}
// The buffer's pool, offset and size are in the object now: into its chain
export function gmemBufPlace(buf: usize): void {
  const i = <i32>load<u32>(buf, BUF_ent) - 1;
  if (i < 0 || i >= nEnt || eBuf(i) != buf || load<u32>(buf, BUF_chain)) return;
  const pool = <usize>load<u64>(buf, O.BUF_pool), mem = pool ? load<u64>(pool, O.POOL_mem) : 0, size = load<u64>(buf, O.BUF_size);
  // (a virtual pool's memory can move when it is mapped again: its buffers stay in the walked chain)
  const fixed = mem != 0 && !(load<u32>(pool, O.POOL_flags) & O.POOLF_VIRTUAL);
  const c = fixed && size <= SMALL ? chainOf(mem + load<u64>(buf, O.BUF_off)) : SLOW, h = headOf(c);
  store<i32>(ENT + <usize>i * ES, h, 8); store<i32>(ENT + <usize>i * ES, -1, 12);
  if (h >= 0) store<i32>(ENT + <usize>h * ES, i, 12);
  store<i32>(HEAD + (<usize>c << 2), i);
  store<u32>(buf, <u32>(c + 1), BUF_chain);
}
export function gmemBufDrop(buf: usize): void {   // nvnBufferFinalize, or the object initialized again
  const i = <i32>load<u32>(buf, BUF_ent) - 1;
  if (i < 0 || i >= nEnt || eBuf(i) != buf) return;
  const c = <i32>load<u32>(buf, BUF_chain) - 1;
  if (c >= 0 && c <= NB) {
    const nx = eNext(i), pv = load<i32>(ENT + <usize>i * ES, 12);
    if (pv >= 0) store<i32>(ENT + <usize>pv * ES, nx, 8); else if (headOf(c) == i) store<i32>(HEAD + (<usize>c << 2), nx);
    if (nx >= 0) store<i32>(ENT + <usize>nx * ES, pv, 12);
  }
  store<usize>(ENT + <usize>i * ES, 0); store<i32>(ENT + <usize>i * ES, freeEnt, 8); freeEnt = i;
  store<u32>(buf, 0, BUF_ent); store<u32>(buf, 0, BUF_chain);
  nLive--;
}
export function gmemLive(): i32 { return nLive; }
export function gmemWalked(): i32 { let k = 0; if (HEAD) for (let i = headOf(SLOW); i >= 0; i = eNext(i)) k++; return k; }
export let gmemStart: u64 = 0, gmemSize: u64 = 0;
// @ts-ignore: decorator
@inline function holds(buf: usize, p: u64): bool {
  if (load<u32>(buf) != O.MAGIC_BUF) return false;
  const pool = <usize>load<u64>(buf, O.BUF_pool);
  if (!pool || load<u32>(pool) != O.MAGIC_POOL) return false;
  const mem = load<u64>(pool, O.POOL_mem), start = mem + load<u64>(buf, O.BUF_off), size = load<u64>(buf, O.BUF_size);
  if (!mem || p < start || p - start >= size) return false;
  gmemStart = start; gmemSize = size;
  return true;
}
// The smallest live buffer address p lies in (0: none), its range in gmemStart / gmemSize. `hint`: the buffer found for this address last time, tried first
let best: usize = 0, bs: u64 = 0, bz: u64 = 0;
function walk(c: i32, p: u64): void {
  for (let i = headOf(c); i >= 0; i = eNext(i)) {
    const b = eBuf(i);
    if (holds(b, p) && gmemSize < bz) { best = b; bs = gmemStart; bz = gmemSize; }
  }
}
export function gmemFind(p: u64, hint: usize): usize {
  if (!ENT) { gmemStart = 0; gmemSize = 0; return 0; }
  if (hint) { const i = <i32>load<u32>(hint, BUF_ent) - 1; if (i >= 0 && i < nEnt && eBuf(i) == hint && holds(hint, p)) return hint; }
  best = 0; bs = 0; bz = u64.MAX_VALUE;
  const c = chainOf(p), c0 = chainOf(p - SMALL);
  walk(c, p); if (c0 != c) walk(c0, p);
  walk(SLOW, p);
  gmemStart = bs; gmemSize = best ? bz : 0;
  return best;
}
