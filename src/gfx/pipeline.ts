// The render pipeline cache. WebGPU bakes into a pipeline what NVN leaves dynamic: the shaders, the vertex layout,
// blend, depth-stencil and raster state and the target formats. The lowering fills a key record with all of it and asks
// here; an entry is a kit instance (gfx_pipeline: Missing, Building, Ready, Failed) beside its key.
// The replayer reads the key record at the address H_PIPELINE_CREATE carries; the layout below is that interface.
import * as L from "./log";
import { Inst } from "../kit/machine";
import { GFX_PIPELINE, GfxPipelineE, GfxPipelineS } from "../kit/gen/tables";
import { hostRec, H_PIPELINE_CREATE } from "./hostops";

export const PK_vs: usize = 0;             // u16 library id of the vertex shader
export const PK_fs: usize = 2;             // u16 library id of the fragment shader
export const PK_prim: usize = 4;           // u8 NVNdrawPrimitive
export const PK_cull: usize = 5;           // u8 NVNface
export const PK_front: usize = 6;          // u8 NVNfrontFace
export const PK_poly_mode: usize = 7;      // u8 NVNpolygonMode
export const PK_offset_en: usize = 8;      // u8 NVNpolygonOffsetEnable bits
export const PK_samples: usize = 9;        // u8 sample count of the targets (1 = single-sampled)
export const PK_ncolor: usize = 10;        // u8
export const PK_depth_fmt: usize = 11;     // u8 NVNformat of the depth target, 0 = none
export const PK_color_fmt: usize = 12;     // u8[8] NVNformat of each colour target, 0 = none
export const PK_a2c: usize = 20;           // u8 alpha to coverage
export const PK_blend_en: usize = 22;      // u8 bit i: blending on for target i (color_st.blend_en)
export const PK_stencil_vmask: usize = 23; // u8 stencil value (read) mask
export const PK_stencil_wmask: usize = 24; // u8 stencil write mask
export const PK_itype: usize = 25;         // u8 strip index format + 1 for strips drawn indexed (WebGPU wants it in the pipeline), else 0
export const PK_chmask: usize = 28;        // u32 chmask_st
export const PK_ds: usize = 32;            // u64 ds_st
export const PK_blend: usize = 40;         // u64[8] blend_st of each target
export const PK_offset: usize = 104;       // f32 factor, units, clamp (when PK_offset_en)
export const PK_attr_mask: usize = 116;    // u32 bit l: attribute location l is in the layout
export const PK_attr: usize = 120;         // u32[32] va_st by location
export const PK_stream: usize = 248;       // vs_st[16]
export const PK_SIZE: usize = 376;

const N: u32 = 2048;                       // entries, a power of two; the table is open-addressed by the key's hash
const E_SIZE: usize = 400;                 // key, +376 Inst, +392 u32 hash, +396 u32 used
const TAB: usize = memory.data(819200);
let count: u32 = 0;
let lastRed: i32 = -1;

export const KEY: usize = memory.data(376);   // the key the lowering fills before pipelineGet

function hashKey(k: usize): u32 {
  let h: u32 = 0x811c9dc5;
  for (let i: usize = 0; i < PK_SIZE; i += 4) { h ^= load<u32>(k + i); h *= 0x01000193; h ^= h >> 15; }
  return h ? h : 1;
}
// @ts-ignore: decorator
@inline function entry(i: u32): usize { return TAB + <usize>i * E_SIZE; }
// @ts-ignore: decorator
@inline function instOf(i: u32): Inst { return Inst.at(entry(i) + PK_SIZE); }

// The id of the pipeline with the key at KEY, requesting it from the replayer the first time; -1 when it failed to
// build (the draw is skipped) or the cache is full
export function pipelineGet(): i32 {
  const h = hashKey(KEY);
  let i = h & (N - 1);
  for (let probe: u32 = 0; probe < N; probe++, i = (i + 1) & (N - 1)) {
    const e = entry(i);
    if (!load<u32>(e, 396)) {
      if (count >= N - N / 4) { if (lastRed != -2) { lastRed = -2; L.redLine("pipeline cache full (1536 pipelines): the draw is skipped"); } return -1; }
      memory.copy(e, KEY, PK_SIZE); store<u32>(e, h, 392); store<u32>(e, 1, 396); count++;
      const m = instOf(i); m.init(GFX_PIPELINE, i);
      m.step(GfxPipelineE.Request);
      const r = hostRec(H_PIPELINE_CREATE, 16); store<u32>(r, i, 8); store<u32>(r, <u32>e, 12);
      return <i32>i;
    }
    if (load<u32>(e, 392) == h && memory.compare(e, KEY, PK_SIZE) == 0) {
      if (instOf(i).state == GfxPipelineS.Failed) {
        if (lastRed != <i32>i) { lastRed = <i32>i; L.red("pipeline "); L.u(i); L.str(" failed to build: its draws are skipped"); L.end(); }
        return -1;
      }
      return <i32>i;
    }
  }
  return -1;
}
// The replayer reports the end of createRenderPipelineAsync
export function pipelineDone(id: u32, ok: bool): void {
  if (id >= N || !load<u32>(entry(id), 396)) { L.red("gfx_pipeline_done: no pipeline "); L.u(id); L.end(); return; }
  instOf(id).step(ok ? GfxPipelineE.Built : GfxPipelineE.Error);
}
export function pipelineState(id: u32): i32 { return id < N && load<u32>(entry(id), 396) ? <i32>instOf(id).state : -1; }
export function pipelineCount(): u32 { return count; }
