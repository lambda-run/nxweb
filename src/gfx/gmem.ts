// The live NVN buffers, for shaders that read memory through addresses they load (src/shaders/spv.ts globalMemory; nxnative's memory pool table, nvn_mtl.m
// gmem_map). Such an address is a buffer's (nvnBufferGetAddress) plus an offset, kept by the game in a storage buffer; the recorder finds the buffer it lies in at
// each draw or dispatch (lower.ts emitGmem) and the replayer binds that buffer's range. A buffer and not its pool, as nxnative has it: the replayer uploads what it
// binds, and a pool is far more than a shader reads.
// The table holds the buffer objects, not their ranges: a virtual pool's memory is known only once it is mapped (dispatch.ts nvnMemoryPoolMapVirtual)
import * as L from "./log";
import * as O from "./obj";
import { arenaAlloc } from "./arena";

const CAP: i32 = 8192;
const PS: usize = sizeof<usize>();
let TAB: usize = 0, n: i32 = 0, said = false;
export const GMEM_MAX_BYTES: u64 = 128 << 20;   // WebGPU's default maxStorageBufferBindingSize

export function gmemBufInit(buf: usize): void {   // nvnBufferInitialize
  if (!TAB) TAB = arenaAlloc(<usize>CAP * PS);
  if (n == CAP) { if (!said) { said = true; L.redLine("more than 8192 live buffers: memory a shader reads through a loaded address is not found in the others"); } return; }
  store<usize>(TAB + <usize>n * PS, buf); n++;
}
export function gmemBufDrop(buf: usize): void {   // nvnBufferFinalize, or the object initialized again
  for (let i = n - 1; i >= 0; i--) if (load<usize>(TAB + <usize>i * PS) == buf) { n--; store<usize>(TAB + <usize>i * PS, load<usize>(TAB + <usize>n * PS)); return; }
}
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
export function gmemFind(p: u64, hint: usize): usize {
  if (hint) for (let i = 0; i < n; i++) if (load<usize>(TAB + <usize>i * PS) == hint) { if (holds(hint, p)) return hint; break; }
  let best: usize = 0, bs: u64 = 0, bz: u64 = u64.MAX_VALUE;
  for (let i = 0; i < n; i++) {
    const b = load<usize>(TAB + <usize>i * PS);
    if (holds(b, p) && gmemSize < bz) { best = b; bs = gmemStart; bz = gmemSize; }
  }
  gmemStart = bs; gmemSize = best ? bz : 0;
  return best;
}
