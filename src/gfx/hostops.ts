// The host stream: what the lowering (lower.ts) hands to the WebGPU replayer (src/glue/gfx_host.ts).
// Records are { u32 op, u32 size } + fields, written into a static buffer and passed to the embedder's
// `env.gfx_exec(ptr, len)` in order. The replayer executes them one by one and decides nothing: every pass boundary,
// load action, binding and pipeline is already resolved here. Field layouts are documented at each emitter; the
// replayer's reader (gfx_host.ts) is the other end of the same table.
import { arenaAlloc } from "./arena";
// @ts-ignore: decorator
@external("env", "gfx_exec")
declare function hostExec(ptr: usize, len: u32): void;

export const H_TEX_CREATE: u32 = 1;        // +8 u64 serial, +16 nvn_texdesc (40 bytes)
export const H_TEX_DESTROY: u32 = 2;       // +8 u64 serial
export const H_BEGIN_PASS: u32 = 3;        // see lower.ts emitBeginPass
export const H_END_PASS: u32 = 4;
export const H_VIEWPORT: u32 = 5;          // +8 f32 x, y, w, h, near, far
export const H_SCISSOR: u32 = 6;           // +8 u32 x, y, w, h
export const H_PIPELINE_CREATE: u32 = 7;   // +8 u32 id, +12 u32 key (address of the key record, pipeline.ts)
export const H_PIPELINE: u32 = 8;          // +8 u32 id
export const H_VBUF: u32 = 9;              // +8 u32 slot, +12 u32 size, +16 u64 address
export const H_UBO: u32 = 10;              // +8 u32 stage, +12 u32 index, +16 u64 address, +24 u32 size
export const H_TEX: u32 = 11;              // +8 u32 stage, +12 u32 slot, +16 u64 serial (0 = none), +24 u32 flags (1 snapshot, 2 view), +28 u32 sampler index, +32 view_t
export const H_BLEND_COLOR: u32 = 12;      // +8 f32 rgba
export const H_STENCIL_REF: u32 = 13;      // +8 u32 reference
export const H_DRAW: u32 = 14;             // +8 u32 first, count, instances, base instance, +24 u32 NVN primitive to convert (0: none)
export const H_DRAW_IDX: u32 = 15;         // +8 u32 index type, count, instances, base instance, +24 i32 base vertex, +28 u32 NVN primitive to convert, +32 u64 index address
export const H_CLEAR_RECT: u32 = 16;       // +8 u32 kind (0 colour, 1 depth-stencil), +12 u32 index, +16 u32 mask, +20 f32 rgba (or depth, u32 stencil), +36 u32 x, y, w, h
export const H_COPY_B2T: u32 = 17;         // +8 u64 source, +16 u64 serial, +24 u32 level, +28 u32 layer, +32 i32 region[6], +56 u32 row stride, +60 u32 image stride
export const H_COPY_T2T: u32 = 18;         // +8 u64 src, +16 u64 dst, +24 u32 src level, layer, dst level, layer, +40 i32 src region[6], +64 i32 dst region[6], +88 u32 flags
export const H_SNAPSHOT: u32 = 19;         // +8 u64 serial
export const H_PRESENT: u32 = 20;          // +8 u64 serial, +16 i32 crop[4], +32 u32 window, +36 u32 index, +40 u32 flags (1: flip vertically)
export const H_FENCE: u32 = 21;            // +8 u64 fence number
export const H_FLUSH: u32 = 22;            // the submission ends: finish the encoder, submit
export const H_MEM_DIRTY: u32 = 23;
export const H_TEX_DATA: u32 = 24;         // texels as linear rows: see texcontent.ts emitData
export const H_COPY_T2B: u32 = 25;         // +8 u64 destination, +16 u64 serial, +24 u32 level, +28 u32 layer, +32 i32 region[6], +56 u32 row stride, +60 u32 image stride (lands when the GPU is done)
export const H_FIXUP: u32 = 26;            // +8 f32 x4: what translated vertex shaders multiply into the position (README, "clip space")        // guest memory changed under the stream (UpdateUniformBuffer, CopyBufferToBuffer): drop uploads

const CAP: usize = 1 << 20;
let BUF: usize = 0;
export function hostInit(): void { BUF = arenaAlloc(CAP); }
let len: usize = 0;
let execs: u32 = 0;

export function hostFlush(): void { if (len) { const n = len; len = 0; execs++; hostExec(BUF, <u32>n); } }
export function hostExecs(): u32 { return execs; }
// Room for one record of `size` bytes (a multiple of 8), zeroed, its header written
export function hostRec(op: u32, size: usize): usize {
  if (len + size > CAP) hostFlush();
  const p = BUF + len; len += size;
  memory.fill(p, 0, size);
  store<u32>(p, op); store<u32>(p, <u32>size, 4);
  return p;
}
