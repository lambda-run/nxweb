// The host stream: what the lowering (lower.ts) hands to the WebGPU replayer (src/glue/gfx_host.ts).
// Records are { u32 op, u32 size } + fields, written into a static buffer and passed to the embedder's
// `env.gfx_exec(ptr, len)` in order. The replayer executes them one by one and decides nothing: every pass boundary,
// load action, binding and pipeline is already resolved here. Field layouts are documented at each emitter; the
// replayer's reader (gfx_host.ts) is the other end of the same table.
import { arenaAlloc } from "./arena";
// @ts-ignore: decorator
@external("env", "gfx_exec")
declare function hostExec(ptr: usize, len: u32): void;

export const H_TEX_CREATE: u32 = 1;        // +8 u64 serial, +16 nvn_texdesc (40 bytes), +56 u16 channel swizzle
export const H_TEX_DESTROY: u32 = 2;       // +8 u64 serial
export const H_BEGIN_PASS: u32 = 3;        // see lower.ts emitBeginPass
export const H_END_PASS: u32 = 4;
export const H_VIEWPORT: u32 = 5;          // +8 f32 x, y, w, h, near, far
export const H_SCISSOR: u32 = 6;           // +8 u32 x, y, w, h
export const H_PIPELINE_CREATE: u32 = 7;   // +8 u32 id, +12 u32 key (address of the key record, pipeline.ts)
export const H_PIPELINE: u32 = 8;          // +8 u32 id
export const H_VBUF: u32 = 9;              // +8 u32 slot, +12 u32 size, +16 u64 address
export const H_UBO: u32 = 10;              // +8 u32 stage (0 vertex, 1 fragment, 2 compute), +12 u32 index, +16 u64 address, +24 u32 size, +28 u32 bytes the shader's type covers (0 unknown)
export const H_TEX: u32 = 11;              // +8 u32 stage, +12 u32 slot, +16 u64 serial (0 = none), +24 u32 flags (1 snapshot, 2 view), +28 u32 sampler index, +32 view_t
export const H_BLEND_COLOR: u32 = 12;      // +8 f32 rgba
export const H_STENCIL_REF: u32 = 13;      // +8 u32 reference
export const H_DRAW: u32 = 14;             // +8 u32 first, count, instances, base instance, +24 u32 NVN primitive to convert (0: none), +28 u32 draw index (a multi-draw's record)
export const H_DRAW_IDX: u32 = 15;         // +8 u32 index type, count, instances, base instance, +24 i32 base vertex, +28 u32 NVN primitive to convert, +32 u64 index address, +40 u32 draw index
export const H_CLEAR_RECT: u32 = 16;       // +8 u32 kind (0 colour, 1 depth-stencil), +12 u32 index, +16 u32 mask, +20 f32 rgba (or depth, u32 stencil), +36 u32 x, y, w, h
export const H_COPY_B2T: u32 = 17;         // +8 u64 source, +16 u64 serial, +24 u32 level, +28 u32 layer, +32 i32 region[6], +56 u32 row stride, +60 u32 image stride
export const H_COPY_T2T: u32 = 18;         // +8 u64 src, +16 u64 dst, +24 u32 src level, layer, dst level, layer, +40 i32 src region[6], +64 i32 dst region[6], +88 u32 flags (1 linear filter, 0x40000000 multisample resolve)
export const H_SNAPSHOT: u32 = 19;         // +8 u64 serial
export const H_PRESENT: u32 = 20;          // +8 u64 serial, +16 i32 crop[4], +32 u32 window, +36 u32 index, +40 u32 flags (1: flip vertically)
export const H_FENCE: u32 = 21;            // +8 u64 fence number
export const H_FLUSH: u32 = 22;            // the submission ends: finish the encoder, submit
export const H_MEM_DIRTY: u32 = 23;       // guest memory changed under the stream: a record of 8 bytes, anything may have (every upload is dropped); of 24, +8 u64 address, +16 u32 bytes (0: anything)
export const H_TEX_DATA: u32 = 24;         // texels as linear rows: see texcontent.ts emitData
export const H_COPY_T2B: u32 = 25;         // +8 u64 destination, +16 u64 serial, +24 u32 level, +28 u32 layer, +32 i32 region[6], +56 u32 row stride, +60 u32 image stride (lands when the GPU is done)
export const H_FIXUP: u32 = 26;            // +8 f32 x4: what translated vertex shaders multiply into the position (README, "clip space")        // guest memory changed under the stream (UpdateUniformBuffer, CopyBufferToBuffer): drop uploads

export const H_UBO_DATA: u32 = 27;         // +8 u32 stage, +12 u32 index, +16 u32 size, +24 the bytes: a uniform block the recorder makes itself (the support buffer)
export const H_SSBO: u32 = 28;             // +8 u32 stage, +12 u32 index, +16 u64 address, +24 u32 size, +28 u32 flags (1: the shader writes it)
export const H_IMG: u32 = 29;              // +8 u32 stage, +12 u32 slot, +16 u64 serial, +24 u32 flags (1 written, 2 view), +32 view_t
export const H_BEGIN_COMPUTE: u32 = 30;    // a compute pass begins (H_END_PASS ends it)
export const H_DISPATCH: u32 = 31;         // +8 u32 pipeline id, +12 u32 x, y, z work groups
export const H_BUF_READBACK: u32 = 32;     // +8 u64 address, +16 u32 size: a storage range the GPU wrote goes back to guest memory (lands when the GPU is done)
export const H_REPORT: u32 = 33;           // +8 u32 id: a counter report at this point of the stream (report.ts). The replayer notes the segment it lies in
export const H_REPORT_COMMIT: u32 = 34;    // the reports since the last one land together, when the GPU has finished the segment this record is in: gfx_report_land(id, start, end, done) each

// Mesh draws (lower.ts meshDraw; the replayer's "mesh draws"). Between BEGIN and RUN no pass is open; the bindings before TASK and RUN are the task's and the mesh shader's, sent as compute's
export const H_MESH_BEGIN: u32 = 35;       // +8 u32 flags (1 indirect, 2 with a task shader), +12 u32 first, +16 u32 count, +24 u64 address of {count, first} (indirect), +32 u32 mesh shader id, +36 i32 task shader id (-1 none)
export const H_MESH_TASK: u32 = 36;        // +8 u32 compute pipeline of the task shader
export const H_MESH_RUN: u32 = 37;         // +8 u32 compute pipeline of the mesh shader
export const H_MESH_DRAW: u32 = 38;        // +8 u32 render pipeline (the pass is open): the slots of the last RUN are drawn
export const H_CLEAR_TEX: u32 = 39;        // +8 u64 serial, +16 u32 level, +20 u32 layer, +24 i32 region[6], +48 u32 mask, +52 u32 0 floats, 1 unsigned, 2 signed integers, +56 the value x4
export const H_DISPATCH_SKIPPED: u32 = 40; // a watched key's dispatch that cannot run (gfx_watch_key): +8 u64 key, +16 u32 x, y, z work groups, +32 u64 serial[32] of the
                                           // compute stage's texture slots, +288 u64 serial[8] of its image slots (0 = none), +352 its push constants (256 bytes)
export const H_DISPATCH_SKIPPED_SIZE: usize = 608;
export const H_SKIP: u32 = 41;             // a draw or dispatch the recorder skipped (lower.ts skipRec): +8 u32 reason (SKIP_*), +12 u8 kind (0 draw, 1 dispatch,
                                           // 2 mesh draw), +13 u8[3] the state of each key (0 unknown, 1 pending, 2 failed), +16 u64 key[3] (0 = none): the program's
                                           // stages that are not in the library. Nothing to run: the replayer only counts it (gfx_ledger.ts)
export const H_SKIP_SIZE: usize = 40;
export const SKIP_SHADER: u32 = 0, SKIP_NO_STAGE: u32 = 1, SKIP_PIPELINE: u32 = 2, SKIP_STATE: u32 = 3, SKIP_RENDER_COND: u32 = 4, SKIP_DISCARD: u32 = 5, SKIP_EMPTY: u32 = 6;
export const COPY_NOW: u32 = 0x20000000;   // H_COPY_T2T flags: copied in an encoder of its own, submitted at once (texcontent.ts fromTwin: it may come inside a pass)
export const H_MEM_WRITE: u32 = 42;        // +8 u64 address, +16 u32 bytes, +24 the bytes: guest memory takes them HERE in the stream (lower.ts memWrite with
                                           // stream writes on: UpdateUniformBuffer, CopyBufferToBuffer), then as H_MEM_DIRTY with that range
const CAP: usize = 1 << 20;
let BUF: usize = 0;
export function hostInit(): void { BUF = arenaAlloc(CAP); }
let len: usize = 0;
let execs: u32 = 0;

export function hostFlush(): void { if (len) { const n = len; len = 0; execs++; hostExec(BUF, <u32>n); } }
export function hostExecs(): u32 { return execs; }
export function hostPending(): bool { return len != 0; }
// Room for one record of `size` bytes (a multiple of 8), zeroed, its header written
export function hostRec(op: u32, size: usize): usize {
  if (len + size > CAP) hostFlush();
  const p = BUF + len; len += size;
  memory.fill(p, 0, size);
  store<u32>(p, op); store<u32>(p, <u32>size, 4);
  return p;
}
