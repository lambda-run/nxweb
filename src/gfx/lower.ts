// Lowering: nvnQueueSubmitCommands walks the recorded commands (CALL and JUMP followed) and turns them into the host
// stream (hostops.ts) the WebGPU replayer executes. All NVN semantics are decided here; the replayer only translates.
//
// The centre is the render pass machine (src/kit defs gfx_pass, docs/machines/gfx_pass.md). NVN has no passes: a game
// sets targets, clears, draws, samples and changes targets freely. WebGPU fixes the attachments and their load
// actions when a pass begins, cannot clear inside a pass, and rejects a draw that samples an attachment of its pass:
//   SetRenderTargets      -> TargetsSet (no pass yet; the same targets again while a pass is open change nothing)
//   full clear            -> ClearPending: it becomes the load action of the next pass; in a pass, the pass ends first
//   partial clear         -> (scissored or masked) drawn as a triangle inside the pass, opening it if needed
//   draw                  -> opens the pass with the pending clears as load actions, or continues it
//   draw sampling a target-> Feedback: the pass ends, the texture is copied (H_SNAPSHOT), the draw reopens with load
//                            and samples the copy; later draws of the same pass sample that copy too
//   texture copy, fence, present, barrier, submit -> the pass ends; clears still pending land in a pass of their own
// The state the commands set (program, state objects, bindings, viewport) is kept here and sent to the replayer only
// as far as a draw needs it and only when it changed since the pass began.
// One lowering state serves all queues (nxnative keeps it per queue; no game seen so far draws from two).
import * as L from "./log";
import { Inst } from "../kit/machine";
import { GFX_PASS, GfxPassE, GfxPassS } from "../kit/gen/tables";
import * as O from "./obj";
import * as H from "./hostops";
import { dpoolBase, texEntry, texDesc, TDE_view, TDE_has_view, originLowerLeft, depthZeroToOne, fenceNew } from "./tables";
import { progShader, progMissingKey, progMissingKeys, libKey, watched, libRefl, RF_ubo, RF_tex, RF_io, RF_ssbo, RF_ssbo_w, RF_img, RF_ubo_size, RF_vin, RF_flags, RF_bl, RF_blh, BL_OR, BL_SAMPLER_ID, BL_POOL, BL_POOL_AT, C2_POOL, RF_gmem, RF_gmem_ptr } from "./shader";
import { gmemFind, gmemStart, gmemSize, GMEM_MAX_BYTES } from "./gmem";
import { fmtClass, fmtCanon, fmtBlockView, fmtTwin } from "./fmt";
import * as PK from "./pipeline";
import { syncFence } from "./sync";
import { contentNeed, contentGpuWrite, contentStage, contentState, contentInUse, regionCopy, submitDone } from "./texcontent";
import { GfxTextureS } from "../kit/gen/tables";
import * as R from "./report";
import { MESH_PRIM } from "./cmd";

// ---- current state (nxnative's S and R) ----
let prog: usize = 0;
const BLEND: usize = memory.data(64);        // blend_st x 8
let colorSt: u32 = 0, chmask: u32 = 0xffffffff, polySt: u32 = 0, dsSt: u64 = 0;
const MS: usize = memory.data(16);
const VATTR: usize = memory.data(128); let nattr: i32 = 0;
const VSTREAM: usize = memory.data(128); let nstream: i32 = 0;
const VBUF: usize = memory.data(256);        // { u64 address, u64 size } x 16
// Stages here: 0 vertex, 1 fragment, 2 compute, 3 task, 4 mesh, 5 geometry (NVN's 0, 1, 5, 6 / 3, 7 / 4 and 2: cmd.ts stHost keeps task and mesh in the
// tessellation stages' places, as nxnative; a program has one pair or the other). Task and mesh run as compute (meshDraw); geometry has no WebGPU stage
const UBO: usize = memory.data(1536);        // [stage 0..5][16] { u64 address, u64 size }
const TEXH: usize = memory.data(1536);       // [stage 0..5][32] u64 handle
const SSBO: usize = memory.data(1536);       // [stage 0..5][16] { u64 address, u64 size }
const IMGH: usize = memory.data(384);        // [stage 0..5][8] u64 image handle (a texture ID)
let progC: usize = 0, depthClamp = false;
// SetRasterizerDiscard: nothing is rasterized, so the draws are not issued (transform feedback, the other reason to draw then, has no host path).
// SetPrimitiveRestart: WebGPU's strips always restart at the all-ones index; turning it off cannot be honoured (one red line at such a strip draw)
let rastDiscard = false, restartSet = false, restartOn = false;
// Storage ranges a compute pass wrote: read back into guest memory when the pass ends
const WR: usize = memory.data(512); let nwr: i32 = 0;
// @ts-ignore: decorator
@inline function hst(st: u32): u32 { return st < 2 ? st : st == 5 ? 2 : st == 3 || st == 4 ? st : 5; }
function geometryBind(st: u32): void { if (st == 5 && once(40)) L.redLine("a resource is bound to the geometry stage: kept, but WebGPU has no geometry stage and geometry shaders are not translated or drawn (nxnative's compute emulation, dmsh_geometry.py, is not ported)"); }
const VP: usize = memory.data(16); let hasVp = false, depthNear: f32 = 0, depthFar: f32 = 1;
let scX: i32 = 0, scY: i32 = 0, scW: i32 = 0, scH: i32 = 0, hasSc = false;
const BLENDC: usize = memory.data(16);
let stValueMask: u32 = 0xff, stWriteMask: u32 = 0xff, stRef: u32 = 0;
const POLYOFF: usize = memory.data(12);

// Render targets: 8 colour + 1 depth, 32 bytes each
const RT: usize = memory.data(288);
const RT_serial: usize = 0, RT_fmt: usize = 8, RT_level: usize = 12, RT_layer: usize = 16, RT_w: usize = 20, RT_h: usize = 24, RT_samples: usize = 28, RT_E: usize = 32;
const RT_NEW: usize = memory.data(288);
let rtN: i32 = 0, rtW: u32 = 0, rtH: u32 = 0;
// Full clears waiting for the next pass
let pendColor: u32 = 0, pendDepth = false, pendStencil = false, pendDepthV: f32 = 0, pendStencilV: u32 = 0;
const PEND_RGBA: usize = memory.data(128);
// Targets of the open pass that were copied for a draw that samples them
const SNAP: usize = memory.data(72); let nsnap: i32 = 0;
const FB: usize = memory.data(72);

const PASS: usize = memory.data(16);
// @ts-ignore: decorator
@inline function pass(): Inst { return Inst.at(PASS); }

const D_PIPE: u32 = 1, D_VBUF: u32 = 2, D_UBO: u32 = 4, D_TEX: u32 = 8, D_VP: u32 = 16, D_SC: u32 = 32, D_BLENDC: u32 = 64, D_STREF: u32 = 128, D_BIND: u32 = 256, D_ALL: u32 = 511;
let dirty: u32 = D_ALL;
let curPipe: i32 = -1, curVs: i32 = -1, curFs: i32 = -1;

// Counters the tests and the README's numbers read (gfx_stat)
let nMesh: u32 = 0, nMeshInd: u32 = 0, nMeshTask: u32 = 0, nMeshSkipped: u32 = 0, meshMode = false;
let nPasses: u32 = 0, nDraws: u32 = 0, nSkipped: u32 = 0, nSnapshots: u32 = 0, nClearRects: u32 = 0, nSubmits: u32 = 0, nDispatches: u32 = 0, nComputePasses: u32 = 0, nMirrored: u32 = 0, nBindless: u32 = 0;
export function stat(i: i32): u32 { return i == 0 ? nPasses : i == 1 ? nDraws : i == 2 ? nSkipped : i == 3 ? nSnapshots : i == 4 ? nClearRects : i == 5 ? nSubmits : i == 13 ? nDispatches : i == 14 ? nComputePasses : i == 15 ? nMirrored : i == 16 ? nBindless : i == 21 ? nMesh : i == 22 ? nMeshInd : i == 23 ? nMeshTask : i == 24 ? nMeshSkipped : 0; }
export function passState(): i32 { return pass().state; }

let onceMask: u64 = 0;
function once(bit: u32): bool { if (onceMask & (<u64>1 << bit)) return false; onceMask |= <u64>1 << bit; return true; }
// The GPU device was replaced: everything the replayer was told about the open submission is told again
export function lowerDeviceReset(): void { dirty = D_ALL; curPipe = -1; }

export function lowerInit(): void {
  pass().init(GFX_PASS, 0);
  for (let i: usize = 0; i < 8; i++) store<u64>(BLEND + (i << 3), blendDefault(<u64>i));
  colorSt = 0 | (3 << 8) | (8 << 12); polySt = 0 | (1 << 2) | (2 << 3); dsSt = dsDefault();
  store<u8>(MS, 1);
}
// The NVN defaults of the state objects (hle_nvn.c *SetDefaults)
export function blendDefault(target: u64): u64 { return target | (<u64>2 << 3) | (<u64>1 << 10) | (<u64>2 << 17) | (<u64>1 << 24) | (<u64>1 << 31) | (<u64>1 << 34); }
export function dsDefault(): u64 { return <u64>((1 << 1) | (2 << 2) | (8 << 7) | (8 << 11) | (1 << 15) | (1 << 19) | (1 << 23) | (1 << 27)) | (<u64>1 << 31) | (<u64>1 << 35); }

// ---- render pass ----
function emitBeginPass(): void {
  // The targets become the GPU's first: a target with texels staged in its storage is uploaded now, before the record
  // (an upload hands the stream over)
  for (let i = 0; i < rtN; i++) contentGpuWrite(load<u64>(RT + <usize>i * RT_E));
  contentGpuWrite(load<u64>(RT + 8 * RT_E));
  const r = H.hostRec(H.H_BEGIN_PASS, 376);
  // +8 u32 colour count, +12 u32 flags (1 depth target, 2 clear depth, 4 clear stencil), +16 f32 clear depth, +20 u32 clear stencil, +24 u32 width, +28 u32 height
  // +32 colour[8]: { u64 serial (0 none), u32 level, u32 layer, u32 format, u32 load (1 = clear), f32 rgba[4] } (40 bytes)
  // +352 depth: { u64 serial, u32 level, u32 layer, u32 format }
  store<u32>(r, rtN, 8);
  const d = RT + 8 * RT_E, hasDepth = load<u64>(d) != 0;
  store<u32>(r, (hasDepth ? 1 : 0) | (pendDepth ? 2 : 0) | (pendStencil ? 4 : 0), 12);
  store<f32>(r, pendDepthV, 16); store<u32>(r, pendStencilV, 20); store<u32>(r, rtW, 24); store<u32>(r, rtH, 28);
  for (let i = 0; i < rtN; i++) {
    const t = RT + <usize>i * RT_E, o = r + 32 + <usize>i * 40;
    store<u64>(o, load<u64>(t)); store<u32>(o, load<u32>(t, RT_level), 8); store<u32>(o, load<u32>(t, RT_layer), 12); store<u32>(o, load<u32>(t, RT_fmt), 16);
    store<u32>(o, (pendColor >> i) & 1, 20); memory.copy(o + 24, PEND_RGBA + (<usize>i << 4), 16);
  }
  if (hasDepth) { store<u64>(r, load<u64>(d), 352); store<u32>(r, load<u32>(d, RT_level), 360); store<u32>(r, load<u32>(d, RT_layer), 364); store<u32>(r, load<u32>(d, RT_fmt), 368); }
  pendColor = 0; pendDepth = false; pendStencil = false;
  dirty = D_ALL; nPasses++;
}
// A pass ends (render or compute): what its shaders wrote into storage buffers goes back to guest memory (it lands when
// the GPU is done; until then the replayer serves binds of those ranges from the GPU's copy)
function emitEndPass(): void {
  H.hostRec(H.H_END_PASS, 8); nsnap = 0;
  if (!nwr) return;
  for (let i = 0; i < nwr; i++) { const r = H.hostRec(H.H_BUF_READBACK, 24); store<u64>(r, load<u64>(WR + (<usize>i << 4)), 8); store<u32>(r, <u32>load<u64>(WR + (<usize>i << 4), 8), 16); }
  nwr = 0;
  dirty |= D_VBUF | D_UBO;
}

// The one place the pass machine steps. What the stream needs follows from the state the event finds:
// leaving Open ends the pass, leaving ClearPending without a draw lands the clears in a pass of their own,
// entering Open begins a pass. False when the table refuses the event (red line from the kit)
function passEvent(ev: u8): bool {
  const m = pass(), from = m.state;
  if (!m.can(ev)) { m.step(ev); return false; }
  const opens = ev == GfxPassE.Draw || ev == GfxPassE.PartialClear, inCompute = from == GfxPassS.Compute || from == GfxPassS.ComputeUnset;
  if (inCompute) { if (ev == GfxPassE.Dispatch) { m.step(ev); return true; } emitEndPass(); }
  if (opens) { if (from != GfxPassS.Open) emitBeginPass(); }
  else if (from == GfxPassS.Open) emitEndPass();
  else if (from == GfxPassS.ClearPending && ev != GfxPassE.FullClear) { emitBeginPass(); emitEndPass(); }
  if (ev == GfxPassE.Dispatch) { H.hostRec(H.H_BEGIN_COMPUTE, 8); nComputePasses++; }
  m.step(ev);
  return true;
}
// Something that cannot be inside a pass is about to go into the stream
export function passBreak(): void { passEvent(GfxPassE.Break); }

// A texture named by a record (a snapshot of the object or the object): its texture object when it is live
function liveTex(t: usize): usize {
  if (!t || load<u32>(t) != O.MAGIC_TEX) return 0;
  return texEntry(load<u64>(t, O.TEX_serial)) ? t : 0;
}
// @ts-ignore: decorator
@inline function mipExt(v: u32, level: u32): u32 { v >>= level; return v ? v : 1; }
function rtFill(e: usize, t: usize, view: usize, hasView: bool): void {
  memory.fill(e, 0, RT_E);
  if (!t) return;
  const bits = hasView ? load<u8>(view) : 0;
  const level: u32 = bits & 1 ? load<u8>(view, O.VIEW_base_level) : 0;
  store<u64>(e, load<u64>(t, O.TEX_serial));
  // A view may only switch between a format and its sRGB twin (WebGPU): any other view format renders in the texture's
  // own, here and therefore in the pipeline key and in the attachment alike
  let fmt = load<u32>(t, O.TEX_d + O.TD_format), blocks = false;
  if (bits & 4) {
    const vf = <u32>load<u16>(view, O.VIEW_format);
    if (fmtCanon(vf) != fmtCanon(fmt)) {
      if (fmtTwin(fmtCanon(fmt)) == fmtCanon(vf)) fmt = vf;
      // the blocks of a compressed texture as integer texels: the replayer renders into a texture of the view's format, a block a texel, and copies it over the level
      else if (fmtBlockView(fmtCanon(fmt), vf)) { fmt = vf; blocks = true; }
      else if (once(32)) { L.red("a render target view reads format 0x"); L.hex(fmt); L.str(" as 0x"); L.hex(vf); L.str(": WebGPU views can only switch sRGB, the texture's own format is rendered"); L.end(); }
    }
  }
  store<u32>(e, fmt, RT_fmt);
  store<u32>(e, level, RT_level); store<u32>(e, bits & 2 ? <u32>load<u16>(view, O.VIEW_min_layer) : 0, RT_layer);
  store<u32>(e, mipExt(load<u32>(t, O.TEX_d + O.TD_width), level), RT_w); store<u32>(e, mipExt(load<u32>(t, O.TEX_d + O.TD_height), level), RT_h);
  if (blocks) { store<u32>(e, (load<u32>(e, RT_w) + 3) >> 2, RT_w); store<u32>(e, (load<u32>(e, RT_h) + 3) >> 2, RT_h); }
  // WebGPU has 1 and 4 samples: 2, 8 and 16 are rendered with 4
  const s = load<i32>(t, O.TEX_d + O.TD_samples); store<u32>(e, s > 1 ? 4 : 1, RT_samples);
  if (s > 1 && s != 4 && once(33)) { L.red("a render target has "); L.i(s); L.str(" samples: WebGPU has 1 and 4, it is rendered with 4"); L.end(); }
}
function setRenderTargets(r: usize): void {
  let n = load<i32>(r, O.P_SET_RT_n); if (n < 0 || n > 8) n = 0;
  memory.fill(RT_NEW, 0, 288);
  let w: u32 = 0, h: u32 = 0;
  for (let i = 0; i < n; i++) {
    const p = <usize>load<u64>(r + O.P_SET_RT_color + (<usize>i << 3)), t = liveTex(p);
    if (p && !t && once(0)) L.redLine("SetRenderTargets: a colour target is not a live texture at submit; the slot is left empty");
    rtFill(RT_NEW + <usize>i * RT_E, t, r + O.P_SET_RT_cview + <usize>i * O.VIEW_SIZE, load<u8>(r + O.P_SET_RT_has_cview + <usize>i) != 0);
    if (t && !w) { w = load<u32>(RT_NEW + <usize>i * RT_E, RT_w); h = load<u32>(RT_NEW + <usize>i * RT_E, RT_h); }
  }
  const dp = <usize>load<u64>(r, O.P_SET_RT_depth), dt = liveTex(dp);
  if (dp && !dt && once(1)) L.redLine("SetRenderTargets: the depth target is not a live texture at submit; no depth target");
  rtFill(RT_NEW + 8 * RT_E, dt, r + O.P_SET_RT_dview, load<u8>(r, O.P_SET_RT_has_dview) != 0);
  if (dt && !w) { w = load<u32>(RT_NEW + 8 * RT_E, RT_w); h = load<u32>(RT_NEW + 8 * RT_E, RT_h); }
  // The same targets again while their pass is open: the pass goes on (games re-send targets before every group of draws)
  if (pass().state == GfxPassS.Open && n == rtN && memory.compare(RT, RT_NEW, 288) == 0) return;
  passEvent(GfxPassE.SetTargets);
  if (R.segCut()) H.hostRec(H.H_FLUSH, 8);      // gpu_timestamps segment: what was encoded so far goes to the GPU (nxnative sub_cut)
  memory.copy(RT, RT_NEW, 288); rtN = n; rtW = w; rtH = h;
  dirty = D_ALL;
}
// @ts-ignore: decorator
@inline function hasTargets(): bool { return rtW != 0; }

// The scissor as a rectangle inside a w x h target, top-left origin; false when it covers all of it
let rX: u32 = 0, rY: u32 = 0, rW: u32 = 0, rH: u32 = 0;
function scissorRect(w: u32, h: u32): bool {
  if (!hasSc) { rX = 0; rY = 0; rW = w; rH = h; return false; }
  let x0 = <i64>scX, y0 = <i64>scY, x1 = x0 + max<i32>(scW, 0), y1 = y0 + max<i32>(scH, 0);
  x0 = max<i64>(x0, 0); y0 = max<i64>(y0, 0); x1 = min<i64>(x1, w); y1 = min<i64>(y1, h);
  if (x1 < x0) x1 = x0; if (y1 < y0) y1 = y0;
  rX = <u32>x0; rY = <u32>y0; rW = <u32>(x1 - x0); rH = <u32>(y1 - y0);
  return !(rX == 0 && rY == 0 && rW == w && rH == h);
}
function clearRect(kind: u32, index: u32, mask: u32, a: f32, b: f32, c: f32, d: f32, stencil: u32): void {
  const r = H.hostRec(H.H_CLEAR_RECT, 56);
  store<u32>(r, kind, 8); store<u32>(r, index, 12); store<u32>(r, mask, 16);
  store<f32>(r, a, 20); if (kind) store<u32>(r, stencil, 24); else store<f32>(r, b, 24); store<f32>(r, c, 28); store<f32>(r, d, 32);
  store<u32>(r, rX, 36); store<u32>(r, rY, 40); store<u32>(r, rW, 44); store<u32>(r, rH, 48);
  dirty = D_ALL; nClearRects++;       // the replayer draws it with a pipeline and scissor of its own
}
function clearColor(r: usize): void {
  const index = load<i32>(r, O.P_CLEAR_COLOR_index), mask = load<i32>(r, O.P_CLEAR_COLOR_mask) & 0xf;
  if (pass().state == GfxPassS.Unset) { passEvent(GfxPassE.FullClear); return; }      // refused: a clear with no render targets
  if (index < 0 || index >= rtN || !load<u64>(RT + <usize>index * RT_E)) { if (once(2)) { L.red("color clear target "); L.i(index); L.str(" invalid"); L.end(); } return; }
  const t = RT + <usize>index * RT_E;
  const partial = scissorRect(load<u32>(t, RT_w), load<u32>(t, RT_h));
  if (!mask) return;
  if (mask != 0xf || partial) {
    if (passEvent(GfxPassE.PartialClear)) clearRect(0, index, mask, load<f32>(r, 8), load<f32>(r, 12), load<f32>(r, 16), load<f32>(r, 20), 0);
    return;
  }
  if (!passEvent(GfxPassE.FullClear)) return;
  pendColor |= 1 << index; memory.copy(PEND_RGBA + (<usize>index << 4), r + O.P_CLEAR_COLOR_rgba, 16);
}
function clearDepthStencil(r: usize): void {
  const depth = load<f32>(r), dmask = load<i32>(r, 4) != 0, stencil = <u32>load<i32>(r, 8), sm = <u32>load<i32>(r, 12) & 0xff;
  if (pass().state == GfxPassS.Unset) { passEvent(GfxPassE.FullClear); return; }
  const t = RT + 8 * RT_E;
  if (!load<u64>(t)) { if (once(3)) L.redLine("depth-stencil clear with no depth target"); return; }
  if (!dmask && !sm) return;
  const partial = scissorRect(load<u32>(t, RT_w), load<u32>(t, RT_h));
  if (partial || (sm && sm != 0xff)) {
    if (passEvent(GfxPassE.PartialClear)) clearRect(1, 0, (dmask ? 1 : 0) | (sm << 8), depth, 0, 0, 0, stencil);
    return;
  }
  if (!passEvent(GfxPassE.FullClear)) return;
  if (dmask) { pendDepth = true; pendDepthV = depth; }
  if (sm) { pendStencil = true; pendStencilV = stencil & 0xff; }
}

// ---- draws ----
// @ts-ignore: decorator
@inline function texHandle(stage: u32, slot: u32): u64 { return load<u64>(TEXH + (<usize>(stage * 32 + slot) << 3)); }
// Bindless handles (nxnative nvn_mtl.m ubo_handle, ubo_tex_id, ubo_samp_id). A slot the reflection marks bindless takes
// its handle from the uniform data bound to the same stage when the draw is lowered: guest memory then holds what the
// GPU would read (inline updates and buffer copies are made in stream order, memWrite). A slot that is not bound, or
// bound shorter than the word, reads 0: no texture. The IDs are those of the pools set when the draw runs, so the
// pools' numbering bases are added here, as BindTexture adds them when it is recorded
let texBase: i32 = 0, sampBase: i32 = 0;
function uboWord(st: u32, reg: u32, off: u32): u32 {
  if (reg >= 16) return 0;
  const b = UBO + (<usize>(st * 16 + reg) << 4), addr = load<u64>(b), size = load<u64>(b, 8);
  return addr && <u64>off + 4 <= size ? load<u32>(<usize>addr + off) : 0;
}
// @ts-ignore: decorator
@inline function hasBindless(id: i32): bool { return id >= 0 && load<u32>(libRefl(id), RF_bl) != 0; }
// The handle (texture ID | sampler ID << 20, pool bases added) of texture slot `slot` of stage st, whose shader's record is rf
function slotHandle(st: u32, rf: usize, slot: u32): u64 {
  if (!((load<u32>(rf, RF_bl) >> slot) & 1)) return texHandle(st, slot);
  const e = rf + RF_blh + (<usize>slot << 3), kind = load<u8>(e);
  if (<u8>(kind & 7) >= BL_POOL) return poolHandle(st, rf, e, false);
  let h = uboWord(st, load<u8>(e, 1), load<u16>(e, 2));
  if (kind == BL_OR) h |= uboWord(st, load<u8>(e, 4), load<u16>(e, 6));
  let tid = <u64>(h & 0xfffff), sid = <u64>(h >> 20);
  if (tid) tid += <u64>texBase;
  if (kind == BL_SAMPLER_ID) sid = <u64>load<u16>(e, 6); else if (sid) sid += <u64>sampBase;
  return tid | sid << 20;
}
// The live serial a handle's texture ID names, 0 for none
function handleSerial(h: u64): u64 {
  const e = texDesc(<u32>(h & 0xfffff));
  if (!e) return 0;
  const s = load<u64>(e);
  return texEntry(s) ? s : 0;
}
// Pool textures (src/shaders/pool.ts; nxnative binds the game's whole pools, tex_pool / samp_pool). The shader reads a texture through a handle it loads from a
// record table in a storage buffer (a light list: one record a light, its shadow map's handle in it) and has a few slots for all of them. The table is walked
// when the draw is lowered: guest memory then holds what the GPU would read, as for bindless handles. The distinct handles that name a live texture take the
// slots in the order they are met, and the shader is told which handle each slot got (poolTable). A table a compute shader writes in the same submission is
// read as it was before; a table with more live textures than the shader has slots leaves the later ones reading 0 (red, once)
const POOLH: usize = memory.data(64);        // the handles of the last table walked, as the game wrote them
let poolN: u32 = 0, poolMore = false, poolAddr: u64 = 0, poolSize: u64 = 0, poolKey: u64 = 0, poolStamp: u32 = 0xffffffff, poolTexBase: i32 = 0;
// e: the slot's RF_blh entry in the shader's record rf. BL_POOL_AT: the shader reads one record, whose index is uniform data (the entry's helper says which
// words: a material's texture reference plus a base); only that record's handles are taken
let poolRec: u32 = 0;
function poolWalk(st: u32, rf: usize, e: usize): u32 {
  const kind = load<u8>(e), reg = <u32>load<u8>(e, 1), off = <u32>load<u16>(e, 2), cols = <u32>load<u8>(e, 5), stride = <u32>load<u16>(e, 6);
  if (reg >= 16) return 0;
  let rec: u32 = 0xffffffff;
  if (<u8>(kind & 7) == BL_POOL_AT) {
    const a = rf + RF_blh + (<usize>(kind >> 3) << 3), fl = <u32>load<u8>(a), w0 = uboWord(st, load<u8>(a, 1) & 15, load<u16>(a, 2));
    rec = fl & 1 ? w0 & 0xfffff : w0;
    if (fl & 8) { const w1 = uboWord(st, load<u8>(a, 1) >> 4, load<u16>(a, 4)); rec += fl & 2 ? w1 & 0xfffff : w1; }
    if ((fl & 4) && (w0 & 0xc0000000) != 0x80000000) rec = 0;
    if (rec == 0xffffffff) rec = 0xfffffffe;
  }
  const b = SSBO + (<usize>(st * 16 + reg) << 4), addr = load<u64>(b), size = load<u64>(b, 8);
  const key = <u64>off | <u64>stride << 16 | <u64>reg << 32 | <u64>st << 40 | <u64>cols << 48, stamp = nDraws + nSkipped + nDispatches;   // one walk a draw: each ends by counting itself
  if (stamp == poolStamp && key == poolKey && rec == poolRec && addr == poolAddr && size == poolSize && texBase == poolTexBase) return poolN;
  poolStamp = stamp; poolKey = key; poolRec = rec; poolAddr = addr; poolSize = size; poolTexBase = texBase; poolN = 0; poolMore = false;
  if (!addr) return 0;
  const one = rec != 0xffffffff || !stride;
  for (let o: u64 = one && stride ? <u64>off + <u64>stride * <u64>rec : off, i = 0; o + 4 <= size && i < 65536 && !poolMore; o += stride, i++) {
    for (let k: u64 = 0, m: u32 = (cols << 1) | 1; m && o + k + 4 <= size; k += 4, m >>= 1) {
      if (!(m & 1)) continue;
      const h = load<u32>(<usize>addr + <usize>(o + k)), tid = h & 0xfffff;
      if (!tid || !handleSerial(<u64>tid + <u64>texBase)) continue;
      let j: u32 = 0;
      while (j < poolN && load<u32>(POOLH + (<usize>j << 2)) != h) j++;
      if (j == poolN) { if (poolN < 16) { store<u32>(POOLH + (<usize>j << 2), h); poolN++; } else { poolMore = true; break; } }
    }
    if (one) break;
  }
  return poolN;
}
// The handle of a pool slot (its RF_blh entry e): with the pools' bases added, as slotHandle gives it, or raw as the shader compares it (0xffffffff: the slot is empty)
function poolHandle(st: u32, rf: usize, e: usize, raw: bool): u64 {
  const j = <u32>load<u8>(e, 4) & 15, n = poolWalk(st, rf, e);
  if (j >= n) return raw ? 0xffffffff : 0;
  const h = load<u32>(POOLH + (<usize>j << 2));
  if (raw) return h;
  let tid = <u64>(h & 0xfffff), sid = <u64>(h >> 20);
  tid += <u64>texBase; if (sid) sid += <u64>sampBase;
  return tid | sid << 20;
}
// A shader that may have pool slots: bindless slots and the c2 block
function hasPool(id: i32): bool { return id >= 0 && load<u32>(libRefl(id), RF_bl) != 0 && ((load<u32>(libRefl(id), RF_ubo) >> 18) & 1) != 0; }
// The table of a shader's pool slots in its c2 block d: word (sreg >> 4) = the handle that slot holds
function poolTable(st: u32, rf: usize, d: usize): void {
  let m = load<u32>(rf, RF_bl), slots: u32 = 0, walked: u32 = 0;
  for (let i: usize = 0; i < 16; i++) store<u32>(d + C2_POOL + (i << 2), 0xffffffff);
  for (let slot: u32 = 0; m; slot++, m >>= 1) {
    if (!(m & 1)) continue;
    const e = rf + RF_blh + (<usize>slot << 3);
    if (<u8>(load<u8>(e) & 7) < BL_POOL) continue;
    if (<u8>(load<u8>(e) & 7) == BL_POOL) walked++;
    store<u32>(d + C2_POOL + (<usize>(load<u8>(e, 4) >> 4) << 2), <u32>poolHandle(st, rf, e, true)); slots++;
  }
  // told of a shader with one walked pool (the last table walked is then its own); a pool read at one record has a slot a handle
  if (slots && walked == slots && (poolMore || poolN > slots) && once(48)) { L.red("a pool texture's table names "); L.u(poolN); L.str(poolMore ? " or more" : ""); L.str(" live textures and its shader has "); L.u(slots); L.str(" slots for them: the others read 0"); L.end(); }
}
function isTarget(serial: u64): bool {
  for (let i = 0; i < 9; i++) if (load<u64>(RT + <usize>i * RT_E) == serial) return true;
  return false;
}
function snapped(serial: u64): bool {
  for (let i = 0; i < nsnap; i++) if (load<u64>(SNAP + (<usize>i << 3)) == serial) return true;
  return false;
}
// The targets this draw samples (into FB); true when one of them has no copy yet in this pass
function feedback(): bool {
  let n = 0, fresh = false;
  for (let st: u32 = meshMode ? 1 : 0; st < 2; st++) {
    const rf = libRefl(st ? curFs : curVs);
    let m = load<u32>(rf, RF_tex);
    for (let slot: u32 = 0; m; slot++, m >>= 1) {
      if (!(m & 1)) continue;
      const s = handleSerial(slotHandle(st, rf, slot));
      if (!s || !isTarget(s)) continue;
      let k = 0; while (k < n && load<u64>(FB + (<usize>k << 3)) != s) k++;
      if (k == n && n < 9) { store<u64>(FB + (<usize>n << 3), s); n++; if (!snapped(s)) fresh = true; }
    }
  }
  if (fresh) {
    passEvent(GfxPassE.Feedback);
    for (let k = 0; k < n; k++) { const r = H.hostRec(H.H_SNAPSHOT, 16); store<u64>(r, load<u64>(FB + (<usize>k << 3)), 8); nSnapshots++; }
    memory.copy(SNAP, FB, <usize>n << 3); nsnap = n;
  }
  return fresh;
}

// Fills the pipeline key for the current state; false when the draw cannot be made (reported red once)
function fillKey(prim: i32, itype: i32): bool {
  const k = PK.KEY;
  memory.fill(k, 0, PK.PK_SIZE);
  store<u16>(k, <u16>curVs, PK.PK_vs); store<u16>(k, <u16>curFs, PK.PK_fs);
  store<u8>(k, <u8>prim, PK.PK_prim);
  store<u8>(k, <u8>(polySt & 3), PK.PK_cull); store<u8>(k, <u8>(((polySt >> 2) & 1) ^ (originLowerLeft ? 1 : 0)), PK.PK_front);   // lower-left origin: the picture is stored bottom-up, so windings are mirrored (below) store<u8>(k, <u8>((polySt >> 3) & 3), PK.PK_poly_mode);
  const offEn = (polySt >> 5) & 7;
  store<u8>(k, <u8>offEn, PK.PK_offset_en);
  if (offEn) memory.copy(k + PK.PK_offset, POLYOFF, 12);
  let samples: u32 = 1;
  for (let i = 0; i < rtN; i++) {
    const t = RT + <usize>i * RT_E;
    if (!load<u64>(t)) continue;
    store<u8>(k + PK.PK_color_fmt + <usize>i, <u8>load<u32>(t, RT_fmt)); samples = load<u32>(t, RT_samples);
    if ((colorSt >> i) & 1) store<u64>(k + PK.PK_blend + (<usize>i << 3), load<u64>(BLEND + (<usize>i << 3)));
  }
  store<u8>(k, <u8>rtN, PK.PK_ncolor); store<u8>(k, <u8>(colorSt & 0xff & ((1 << rtN) - 1)), PK.PK_blend_en);
  store<u32>(k, chmask, PK.PK_chmask);
  const d = RT + 8 * RT_E;
  if (load<u64>(d)) {
    store<u8>(k, <u8>load<u32>(d, RT_fmt), PK.PK_depth_fmt); samples = load<u32>(d, RT_samples);
    store<u64>(k, dsSt, PK.PK_ds);
    if ((dsSt >> 6) & 1) { store<u8>(k, <u8>stValueMask, PK.PK_stencil_vmask); store<u8>(k, <u8>stWriteMask, PK.PK_stencil_wmask); }
  }
  store<u8>(k, <u8>samples, PK.PK_samples); store<u8>(k, load<u8>(MS, 2), PK.PK_a2c);
  let flags: u32 = depthClamp ? 1 : 0, vin: u64 = 0;
  if (itype >= 0 && (prim == 3 || prim == 5)) store<u8>(k, <u8>(itype + 1), PK.PK_itype);
  const rfv = libRefl(curVs);
  let need = load<u32>(rfv, RF_io);
  store<u32>(k, need, PK.PK_attr_mask);
  for (let loc = 0; need; loc++, need >>= 1) {
    if (!(need & 1)) continue;
    const a = loc < nattr ? load<u32>(VATTR + (<usize>loc << 2)) : 0;
    const stream = a >> 27;
    // An attribute the state does not have, or whose stream has no buffer: NVN (as GL) gives the shader the constant (0, 0, 0, 1). The key's entry stays 0
    // (format 0) and the replayer feeds the location from a constant vertex buffer; its class is the one the shader declares, so no variant is needed
    if (!(a & 0xff) || stream >= 16 || !load<u64>(VBUF + (<usize>stream << 4))) {
      if (!(a & 0xff)) { if (once(4)) { L.begin("the vertex shader reads attribute "); L.i(loc); L.str(", which the bound vertex attribute state does not have: it reads the constant (0, 0, 0, 1)"); L.end(); } }
      else if (once(5)) { L.begin("no vertex buffer bound for stream "); L.u(stream); L.str(" of attribute "); L.i(loc); L.str(": it reads the constant (0, 0, 0, 1)"); L.end(); }
      if (load<u32>(rfv, RF_flags) & 1) vin |= ((load<u64>(rfv, RF_vin) >> (<u64>loc * 2)) & 3) << (<u64>loc * 2);
      continue;
    }
    store<u32>(k + PK.PK_attr + (<usize>loc << 2), a);
    store<u64>(k + PK.PK_stream + (<usize>stream << 3), <i32>stream < nstream ? load<u64>(VSTREAM + (<usize>stream << 3)) : 0);
    vin |= <u64>fmtClass(a & 0xff) << (<u64>loc * 2);
  }
  // The class of each input (float, sint, uint) is part of the WGSL text, but in NVN it follows the bound format: a
  // shader bound with another class needs a variant of its module (README, "vertex input classes")
  const rf = libRefl(curVs);
  if ((load<u32>(rf, RF_flags) & 1) && load<u64>(rf, RF_vin) != vin) flags |= 2;
  store<u64>(k, vin, PK.PK_vin); store<u8>(k, <u8>flags, PK.PK_flags);
  return true;
}

// Window origin and depth mode (nxnative: negative-height viewport, reversed winding, flipped present; a near = 0 shader entry).
// With a lower-left origin render targets are stored bottom-up, as GL has them: row 0 is the bottom row. Viewport and
// scissor rectangles are therefore used as given; clip space is mirrored in y instead, which WebGPU can only do in the
// vertex shader. H_FIXUP carries what a translated vertex shader applies last (README, "What the shader chain must emit"):
//   position.y *= fix.y;  position.z = position.z * fix.z + position.w * fix.w
function emitState(): void {
  if (dirty & D_VP) {
    const f = H.hostRec(H.H_FIXUP, 24);
    store<f32>(f, 1, 8); store<f32>(f, originLowerLeft ? -1 : 1, 12); store<f32>(f, depthZeroToOne ? 1 : 0.5, 16); store<f32>(f, depthZeroToOne ? 0 : 0.5, 20);
    const r = H.hostRec(H.H_VIEWPORT, 32);
    let x: f32 = 0, y: f32 = 0, w = <f32>rtW, h = <f32>rtH;
    if (hasVp) {
      x = load<f32>(VP); y = load<f32>(VP, 4); w = load<f32>(VP, 8); h = load<f32>(VP, 12);
      // WebGPU wants the viewport inside the target; a larger one is clipped to it (the picture then scales: reported once)
      if (x < 0 || y < 0 || x + w > <f32>rtW || y + h > <f32>rtH) {
        if (once(6)) L.redLine("viewport reaches outside the render target: clipped to it (WebGPU has no larger viewport)");
        const x1 = min<f32>(x + w, <f32>rtW), y1 = min<f32>(y + h, <f32>rtH);
        x = max<f32>(x, 0); y = max<f32>(y, 0); w = max<f32>(x1 - x, 0); h = max<f32>(y1 - y, 0);
      }
    }
    store<f32>(r, x, 8); store<f32>(r, y, 12); store<f32>(r, w, 16); store<f32>(r, h, 20);
    if (w != vpW || h != vpH) { vpW = w; vpH = h; dirty |= D_UBO; }      // the support buffer carries the viewport size
    store<f32>(r, min<f32>(max<f32>(depthNear, 0), 1), 24); store<f32>(r, min<f32>(max<f32>(depthFar, 0), 1), 28);
  }
  if (dirty & D_SC) {
    scissorRect(rtW, rtH);
    const r = H.hostRec(H.H_SCISSOR, 24);
    store<u32>(r, rX, 8); store<u32>(r, rY, 12); store<u32>(r, rW, 16); store<u32>(r, rH, 20);
  }
  if (dirty & D_BIND) { const r = H.hostRec(H.H_PIPELINE, 16); store<u32>(r, curPipe, 8); }
  if (dirty & D_VBUF) {
    let streams: u32 = 0;
    for (let loc = 0, need = load<u32>(PK.KEY, PK.PK_attr_mask); need; loc++, need >>= 1) if (need & 1) { const va = load<u32>(PK.KEY + PK.PK_attr + (<usize>loc << 2)); if (va & 0xff) streams |= 1 << (va >> 27); }
    for (let s: u32 = 0; streams; s++, streams >>= 1) {
      if (!(streams & 1)) continue;
      const r = H.hostRec(H.H_VBUF, 24);
      store<u32>(r, s, 8); store<u32>(r, <u32>load<u64>(VBUF + (<usize>s << 4), 8), 12); store<u64>(r, load<u64>(VBUF + (<usize>s << 4)), 16);
    }
  }
  if ((dirty & D_TEX) && ((!meshMode && hasPool(curVs)) || hasPool(curFs))) dirty |= D_UBO;     // which handle a pool slot holds is told to the shader in its c2 block
  if (dirty & D_UBO) { if (!meshMode) { emitUbos(0, curVs); emitStorage(0, curVs); } emitUbos(1, curFs); emitStorage(1, curFs); }
  if ((dirty & D_UBO) && ((!meshMode && hasBindless(curVs)) || hasBindless(curFs))) dirty |= D_TEX;      // the handles are uniform data
  if (dirty & D_TEX) { if (!meshMode) emitTexs(0, curVs); emitTexs(1, curFs); }
  if (dirty & D_BLENDC) memory.copy(H.hostRec(H.H_BLEND_COLOR, 24) + 8, BLENDC, 16);
  if (dirty & D_STREF) store<u32>(H.hostRec(H.H_STENCIL_REF, 16), stRef, 8);
  dirty = 0;
}

// What stage st's shader `id` reads, to the replayer: uniform ranges (with the size the WGSL type covers: the replayer
// binds at least that, zero past what the game bound), the translator's support buffer, textures, storage, images
let vpW: f32 = 0, vpH: f32 = 0;
// from: the stage whose bindings are sent (a task or mesh shader runs as compute: its own stage's bindings in the compute slots)
function emitUbos(st: u32, id: i32, from: u32 = 0xff): void {
  if (from == 0xff) from = st;
  const rf = libRefl(id);
  let m = load<u32>(rf, RF_ubo) & 0x7fff;
  const ex = load<u32>(rf, RF_ubo) >> 16;
  if (ex & 2) emitDriver(st, from, 0);
  if (ex & 4) { const d = emitDriver(st, from, 2); if (load<u32>(rf, RF_bl)) poolTable(from, rf, d); }
  if (ex & 8) emitPush(st, from);
  for (let i: u32 = 0; m; i++, m >>= 1) {
    if (!(m & 1)) continue;
    if (i == 14) { emitSupport(st); continue; }
    const b = UBO + (<usize>(from * 16 + i) << 4), r = H.hostRec(H.H_UBO, 32);
    store<u32>(r, st, 8); store<u32>(r, i, 12); store<u64>(r, load<u64>(b), 16); store<u32>(r, <u32>load<u64>(b, 8), 24); store<u32>(r, load<u32>(rf + RF_ubo_size + (<usize>i << 2)), 28);
  }
}
// Ryujinx's support buffer (Ryujinx.Graphics.Shader SupportBuffer, std140): u32 alpha_test +0; u32 is_bgra[8] +16 (16 bytes
// each); vec4 viewport_inverse +144; vec4 viewport_size +160; i32 frag_scale_count +176; f32 render_scale[73] +192 (16
// bytes each); ivec4 tfe_offset +1360; i32 tfe_vertex_count +1376. Render scale 1 throughout, nothing is BGRA-swapped
const SUPPORT_BYTES: usize = 1392;
function emitSupport(st: u32): void {
  const r = H.hostRec(H.H_UBO_DATA, 24 + SUPPORT_BYTES), p = r + 24;
  store<u32>(r, st, 8); store<u32>(r, 14, 12); store<u32>(r, <u32>SUPPORT_BYTES, 16);
  const w = vpW > 0 ? vpW : <f32>rtW, h = vpH > 0 ? vpH : <f32>rtH;
  store<f32>(p, w > 0 ? 2 / w : 0, 144); store<f32>(p, h > 0 ? 2 / h : 0, 148); store<f32>(p, 1, 152); store<f32>(p, 0, 156);
  store<f32>(p, w, 160); store<f32>(p, h, 164); store<f32>(p, 1, 168); store<f32>(p, 1, 172);
  for (let i: usize = 0; i < 73; i++) store<f32>(p + 192 + (i << 4), 1);
}
// The blocks a shader reads beyond the game's uniform slots (RF_ubo bits 16 + k, the replayer's group 0 binding 208 + stage * 4 + k, src/gfx/README.md):
// k = 0 its c1 (constant, the replayer has it), 1 and 2 the NVN driver segments c0 and c2, 3 the NVN2 push constants (c[24]), each sent as a block the recorder makes
const PUSH: usize = memory.data(512);       // [graphics, compute] the PUSH_SIZE bytes PushGraphicsConstants / PushComputeConstants wrote
const DIM: usize = memory.data(16);         // the dispatch's work group counts, for c0
let drawBaseInst: u32 = 0;
const DRV_SIZE: usize = 0xa00;
function emitPush(st: u32, from: u32): void {
  const r = H.hostRec(H.H_UBO_DATA, 24 + 256);
  store<u32>(r, st, 8); store<u32>(r, 19, 12); store<u32>(r, 256, 16);
  memory.copy(r + 24, PUSH + (from == 2 ? 256 : 0), 256);
}
// The driver's constant segments as nxnative fills them (nvn_mtl.m, dmsh_abi.h DMSH_C0_* / DMSH_C2_*). c0: the stage's storage buffer table (address 64 bits,
// size 32 bits a row); graphics: the largest point size at 0x610 and the draw's base instance at 0x644; compute: the work group counts at 0x200 (and at 4, NVN2's
// place) and the uniform slot table at 0x210. c2: the bound texture handles at 0x20 + 8 r and image handles at 0x120 + 8 r
function emitDriver(st: u32, from: u32, bank: u32): usize {
  const r = H.hostRec(H.H_UBO_DATA, 24 + DRV_SIZE), d = r + 24;
  store<u32>(r, st, 8); store<u32>(r, bank ? 18 : 17, 12); store<u32>(r, <u32>DRV_SIZE, 16);
  if (bank == 0) {
    const base: usize = from == 0 ? 0x110 : from == 1 ? 0x510 : from == 2 ? 0x310 : from == 3 ? 0x670 : 0x770;
    for (let i: usize = 0; i < 16; i++) { const b = SSBO + ((<usize>from * 16 + i) << 4); store<u64>(d + base + (i << 4), load<u64>(b)); store<u32>(d + base + (i << 4), <u32>load<u64>(b, 8), 8); }
    if (from == 2) {
      memory.copy(d + 0x200, DIM, 12); memory.copy(d + 4, DIM, 12);
      for (let i: usize = 0; i < 16; i++) { const b = UBO + ((32 + i) << 4); store<u64>(d + 0x210 + (i << 4), load<u64>(b)); store<u32>(d + 0x210 + (i << 4), <u32>load<u64>(b, 8), 8); }
    } else { store<f32>(d, 2047, 0x610); store<u32>(d, drawBaseInst, 0x644); }
  } else {
    for (let i: usize = 0; i < 32; i++) store<u32>(d + 0x20 + (i << 3), <u32>load<u64>(TEXH + ((<usize>from * 32 + i) << 3)));
    for (let i: usize = 0; i < 8; i++) store<u32>(d + 0x120 + (i << 3), <u32>load<u64>(IMGH + ((<usize>from * 8 + i) << 3)));
  }
  return d;
}
function readsDriver0(id: i32): bool { return id >= 0 && ((load<u32>(libRefl(id), RF_ubo) >> 17) & 1) != 0; }
// ClearTexture(i/ui): outside a render pass, on the texture's level and layers of the view, the region's rectangle
function clearTex(r: usize): void {
  const t = liveTex(<usize>load<u64>(r, O.P_CLEAR_TEX_tex));
  if (!t) { if (once(41)) L.redLine("ClearTexture: the texture is not live at submit; the clear is dropped"); return; }
  passBreak();
  const serial = load<u64>(t, O.TEX_serial), has = load<u8>(r, O.P_CLEAR_TEX_has_view) != 0;
  contentNeed(serial); contentGpuWrite(serial);
  const o = H.hostRec(H.H_CLEAR_TEX, 72);
  store<u64>(o, serial, 8); store<u32>(o, viewLevel(r + O.P_CLEAR_TEX_view, has), 16); store<u32>(o, viewLayer(r + O.P_CLEAR_TEX_view, has), 20);
  memory.copy(o + 24, r + O.P_CLEAR_TEX_r, 24); store<u32>(o, load<u32>(r, O.P_CLEAR_TEX_mask), 48); store<u32>(o, load<u8>(r, O.P_CLEAR_TEX_is_uint), 52);
  memory.copy(o + 56, r + O.P_CLEAR_TEX_c, 16);
}
function emitTexs(st: u32, id: i32, from: u32 = 0xff): void {
  if (from == 0xff) from = st;
  const rf = libRefl(id);
  let m = load<u32>(rf, RF_tex);
  for (let slot: u32 = 0; m; slot++, m >>= 1) {
    if (!(m & 1)) continue;
    if ((load<u32>(rf, RF_bl) >> slot) & 1) nBindless++;
    const h = slotHandle(from, rf, slot), e = texDesc(<u32>(h & 0xfffff)), serial = handleSerial(h);
    if (serial) contentNeed(serial);       // may upload it now
    const r = H.hostRec(H.H_TEX, 48);
    if (!serial && <u8>(load<u8>(rf + RF_blh + (<usize>slot << 3)) & 7) < BL_POOL && once(7)) { L.red("a draw samples texture ID "); L.u(h & 0xfffff); L.str(" (stage "); L.u(st); L.str(" slot "); L.u(slot); L.str("), which names no live texture: it reads as empty"); L.end(); }
    store<u32>(r, st, 8); store<u32>(r, slot, 12); store<u64>(r, serial, 16);
    const hasView = serial != 0 && load<u8>(e, TDE_has_view) != 0;
    store<u32>(r, (st < 2 && snapped(serial) ? 1 : 0) | (hasView ? 2 : 0), 24); store<u32>(r, <u32>(h >> 20) & 0xfff, 28);
    if (hasView) memory.copy(r + 32, e + TDE_view, O.VIEW_SIZE);
  }
}
// Memory a stage reaches through addresses it loads (src/shaders/spv.ts globalMemory; docs/gmem-mirror.md). The module reads and writes the replayer's mirror of
// global memory; what the mirror must hold for this draw or dispatch is named here. The 64-bit addresses stand in storage ranges bound to the stage, at words
// the shader's record names: each is read from guest memory, and the live buffer it lies in goes to the replayer as storage "slot" 32 + k of the stage (H_SSBO;
// flag 1 when the shader stores through that address: such a range is read back at the end of the pass, as a written storage slot is). A null address names
// nothing. An address in no live buffer names nothing either, with a red line once: the shader reads 0 there unless the mirror holds the memory for another reason.
// DEPARTS: the words are read from guest memory. When a compute pass of this submission wrote them (a range whose read-back has not landed) they are stale
const GMH: usize = memory.data(128);          // the buffer object each of the 16 addresses was found in last
function wrNote(addr: u64, size: u64): void {
  let k = 0; while (k < nwr && (load<u64>(WR + (<usize>k << 4)) != addr || load<u64>(WR + (<usize>k << 4), 8) != size)) k++;
  if (k == nwr) { if (nwr < 32) { store<u64>(WR + (<usize>k << 4), addr); store<u64>(WR + (<usize>k << 4), size, 8); nwr++; } else if (once(34)) L.redLine("a pass writes more than 32 storage ranges: the others are not read back into guest memory"); }
}
function emitGmem(st: u32, rf: usize, from: u32): void {
  const K = load<u32>(rf, RF_gmem) & 0xff;
  for (let k: u32 = 0; k < K && k < 16; k++) {
    const e = rf + RF_gmem_ptr + (<usize>k << 2), sw = <u32>load<u8>(e), slot = sw & 0x7f, w: u32 = sw >> 7, word = <u32>load<u16>(e, 2);
    const b = slot < 16 ? SSBO + (<usize>(from * 16 + slot) << 4) : UBO + (<usize>(from * 16 + slot - 16) << 4), addr = load<u64>(b), size = load<u64>(b, 8);
    const r = H.hostRec(H.H_SSBO, 32);
    store<u32>(r, st, 8); store<u32>(r, 32 + k, 12);
    if (!addr || <u64>(word * 4 + 8) > size) {
      if (once(42)) { L.red("a shader reaches memory through an address kept at word "); L.u(word); L.str(" of storage slot "); L.u(slot); L.str(", where nothing that long is bound: that memory reads 0"); L.end(); }
      continue;
    }
    const p = load<u64>(<usize>addr + (<usize>word << 2));
    if (!p) continue;
    const buf = gmemFind(p, load<usize>(GMH + (<usize>k << 3)));
    store<usize>(GMH + (<usize>k << 3), buf);
    if (!buf || gmemSize > GMEM_MAX_BYTES) {
      if (once(43)) { L.red("a shader reaches memory through address 0x"); L.hex(p); L.str(" (word "); L.u(word); L.str(" of storage slot "); L.u(slot); L.str(buf ? "), in a buffer of more than 128 MiB, which the mirror of global memory does not take: it reads 0" : "), which lies in no live buffer: it reads 0"); L.end(); }
      continue;
    }
    store<u64>(r, gmemStart, 16); store<u32>(r, <u32>gmemSize, 24); store<u32>(r, w, 28);
    if (w) wrNote(gmemStart, gmemSize);
  }
  // Tables of addresses in uniform slots (RF_gmem bits 8..15; the shader indexes them at run time): every 64-bit word of the bound range (up to 2 KiB) that
  // lies in a live buffer names that buffer, as storage "slot" 48 + j (up to 16 buffers a stage; the rest are not named, with a red line once)
  const tm = (load<u32>(rf, RF_gmem) >> 8) & 0xff, tw: u32 = (load<u32>(rf, RF_gmem) >> 16) & 1;
  if (!tm) return;
  let j: u32 = 0;
  for (let t: u32 = 0; t < 8; t++) {
    if (!((tm >> t) & 1)) continue;
    const b = UBO + (<usize>(from * 16 + t) << 4), addr = load<u64>(b), size = min<u64>(load<u64>(b, 8), 2048);
    if (!addr) continue;
    for (let o: u64 = 0; o + 8 <= size; o += 8) {
      const p = load<u64>(<usize>(addr + o));
      if (p < 0x10000 || (p >> 40)) continue;
      const buf = gmemFind(p, 0);
      if (!buf || gmemSize > GMEM_MAX_BYTES) continue;
      let seen = false;
      for (let q: u32 = 0; q < j; q++) if (load<u64>(GMT + (<usize>q << 3)) == gmemStart) { seen = true; break; }
      if (seen) continue;
      if (j == 16) { if (once(44)) L.redLine("a shader's table of addresses names more than 16 buffers: the others read 0"); break; }
      store<u64>(GMT + (<usize>j << 3), gmemStart);
      const r = H.hostRec(H.H_SSBO, 32);
      store<u32>(r, st, 8); store<u32>(r, 48 + j, 12); store<u64>(r, gmemStart, 16); store<u32>(r, <u32>gmemSize, 24); store<u32>(r, tw, 28);
      if (tw) wrNote(gmemStart, gmemSize);
      j++;
    }
  }
  for (; j < 16; j++) { const r = H.hostRec(H.H_SSBO, 32); store<u32>(r, st, 8); store<u32>(r, 48 + j, 12); }
}
const GMT: usize = memory.data(128);          // the buffers a stage's tables named so far (emitGmem)
// Storage buffers and images of a draw's or dispatch's stage. A written range is noted for the read-back at the end of the pass
function emitStorage(st: u32, id: i32, from: u32 = 0xff): void {
  if (from == 0xff) from = st;
  const rf = libRefl(id), wm = load<u32>(rf, RF_ssbo_w);
  let m = load<u32>(rf, RF_ssbo) & 0xffff;
  for (let i: u32 = 0; m; i++, m >>= 1) {
    if (!(m & 1)) continue;
    const b = SSBO + (<usize>(from * 16 + i) << 4), addr = load<u64>(b), size = load<u64>(b, 8), w = (wm >> i) & 1, r = H.hostRec(H.H_SSBO, 32);
    store<u32>(r, st, 8); store<u32>(r, i, 12); store<u64>(r, addr, 16); store<u32>(r, <u32>size, 24); store<u32>(r, w, 28);
    if (w && addr && size) wrNote(addr, size);
  }
  // Slots 16 + r: a compute stage that takes uniform slot r's address and reads it through global memory (src/shaders/spv.ts storageSlot; nxnative's
  // ubo_ptr): the range bound at the stage's uniform slot r is sent as storage slot 16 + r
  let um = load<u32>(rf, RF_ssbo) >>> 16;
  for (let r: u32 = 0; um; r++, um >>= 1) {
    if (!(um & 1)) continue;
    const b = UBO + (<usize>(from * 16 + r) << 4), addr = load<u64>(b), size = load<u64>(b, 8), rec = H.hostRec(H.H_SSBO, 32);
    store<u32>(rec, st, 8); store<u32>(rec, 16 + r, 12); store<u64>(rec, addr, 16); store<u32>(rec, <u32>size, 24); store<u32>(rec, (wm >> (16 + r)) & 1, 28);
    if (((wm >> (16 + r)) & 1) && addr && size) wrNote(addr, size);
  }
  if (load<u32>(rf, RF_gmem)) emitGmem(st, rf, from);
  const im = load<u32>(rf, RF_img);
  for (let i: u32 = 0; i < 8; i++) {
    if (!((im >> i) & 1)) continue;
    const h = load<u64>(IMGH + (<usize>(from * 8 + i) << 3)), e = texDesc(<u32>(h & 0xfffff)), serial = handleSerial(h), w = (im >> (8 + i)) & 1;
    if (!serial && once(35)) { L.red("a dispatch binds image ID "); L.u(h & 0xfffff); L.str(", which names no live texture: skipped by the replayer"); L.end(); }
    if (serial) { if (w) contentGpuWrite(serial); else contentNeed(serial); }
    const hasView = serial != 0 && load<u8>(e, TDE_has_view) != 0, r = H.hostRec(H.H_IMG, 48);
    store<u32>(r, st, 8); store<u32>(r, i, 12); store<u64>(r, serial, 16); store<u32>(r, w | (hasView ? 2 : 0), 24);
    if (hasView) memory.copy(r + 32, e + TDE_view, O.VIEW_SIZE);
  }
}
// A draw or dispatch that is skipped, for the embedder's counts (H_SKIP; src/glue/gfx_ledger.ts). For a program
// whose stages are not all in the library: those keys and their states, the reason SKIP_SHADER (SKIP_NO_STAGE when
// every key is there but the stage asked for is not)
function skipRec(reason: u32, kind: u8, p: usize): void {
  const r = H.hostRec(H.H_SKIP, H.H_SKIP_SIZE);
  store<u8>(r, kind, 12);
  if (reason == H.SKIP_SHADER) reason = p && load<u32>(p) == O.MAGIC_PROG && progMissingKeys(p, r + 16, r + 13) ? H.SKIP_SHADER : H.SKIP_NO_STAGE;
  store<u32>(r, reason, 8);
}
// A dispatch that cannot run (its shader is not registered, or its pipeline failed) of a key the embedder watches (gfx_watch_key): the replayer is told,
// inside a compute pass as the dispatch would have been, with the compute stage's bound textures, images and push constants (GfxHost's NDVE stand-in).
// Its images count as written by the GPU: the embedder may write them in its place. Keys not watched: nothing is recorded
function skippedDispatch(key: u64, x: u32, y: u32, z: u32): void {
  if (!key || !watched(key)) return;
  passEvent(GfxPassE.Dispatch);
  const r = H.hostRec(H.H_DISPATCH_SKIPPED, H.H_DISPATCH_SKIPPED_SIZE);
  store<u64>(r, key, 8); store<u32>(r, x, 16); store<u32>(r, y, 20); store<u32>(r, z, 24);
  for (let s: u32 = 0; s < 32; s++) { const sr = handleSerial(texHandle(2, s)); if (sr) contentNeed(sr); store<u64>(r + 32 + (<usize>s << 3), sr); }
  for (let i: u32 = 0; i < 8; i++) { const sr = handleSerial(load<u64>(IMGH + (<usize>(16 + i) << 3))); if (sr) contentGpuWrite(sr); store<u64>(r + 288 + (<usize>i << 3), sr); }
  memory.copy(r + 352, PUSH + 256, 256);
}
// nvnCommandBufferDispatchCompute(Indirect). A compute pipeline is its shader alone; the pass machine opens a compute
// pass, which consecutive dispatches share. Every binding the shader uses is sent with each dispatch
let curCsPipe: i32 = -1, curCs: i32 = -1;
function dispatch(r: usize): void {
  let x = load<u32>(r), y = load<u32>(r, 4), z = load<u32>(r, 8);
  const ind = <usize>load<u64>(r, O.P_DISPATCH_ind);
  if (ind) { x = load<u32>(ind); y = load<u32>(ind, 4); z = load<u32>(ind, 8); }      // CPU-visible at submit, as indirect draws
  if (!progC || load<u32>(progC) != O.MAGIC_PROG) { if (once(36)) L.redLine("compute dispatch without a bound compute program: skipped"); skipRec(H.SKIP_STATE, 1, 0); nSkipped++; return; }
  const cs = progShader(progC, 2);
  if (cs < 0) { skippedDispatch(progMissingKey(progC), x, y, z); skipRec(H.SKIP_SHADER, 1, progC); nSkipped++; return; }
  if (!x || !y || !z) return;
  if (cs != curCs) {
    const k = PK.KEY;
    memory.fill(k, 0, PK.PK_SIZE);
    store<u16>(k, 0xffff, PK.PK_vs); store<u16>(k, <u16>cs, PK.PK_fs); store<u8>(k, 0xff, PK.PK_prim);
    curCsPipe = PK.pipelineGet(); curCs = cs;
    dirty |= D_PIPE;                         // the key record no longer holds the draw pipeline's key
  }
  if (curCsPipe < 0) { curCs = -1; skippedDispatch(libKey(cs), x, y, z); skipRec(H.SKIP_PIPELINE, 1, 0); nSkipped++; return; }
  passEvent(GfxPassE.Dispatch);
  store<u32>(DIM, x); store<u32>(DIM, y, 4); store<u32>(DIM, z, 8);
  emitUbos(2, cs); emitTexs(2, cs); emitStorage(2, cs);
  const o = H.hostRec(H.H_DISPATCH, 24);
  store<u32>(o, curCsPipe, 8); store<u32>(o, x, 12); store<u32>(o, y, 16); store<u32>(o, z, 20);
  nDispatches++;
}

function draw(r: usize, size: u32, indexed: bool): void {
  if (pass().state == GfxPassS.Unset || !hasTargets()) {
    if (pass().state == GfxPassS.Unset) passEvent(GfxPassE.Draw);      // refused: a draw with no render targets
    else if (once(8)) L.redLine("draw with render targets that have no live texture: skipped");
    skipRec(H.SKIP_STATE, 0, 0); nSkipped++; return;
  }
  if (!prog || load<u32>(prog) != O.MAGIC_PROG) { if (once(9)) L.redLine("draw without a bound program: skipped"); skipRec(H.SKIP_STATE, 0, 0); nSkipped++; return; }
  const orig = load<i32>(r);
  if (rastDiscard) { skipRec(H.SKIP_DISCARD, 0, 0); return; }      // (counted by the replayer's ledger: nothing is drawn)
  if (indexed && restartSet && !restartOn && (orig == 3 || orig == 5) && once(45)) L.redLine("SetPrimitiveRestart(off) with an indexed strip: WebGPU strips always restart at the all-ones index, a strip that uses that index as a vertex is cut there");
  if (orig == MESH_PRIM) { meshDraw(r); return; }
  // WebGPU has points, lines, line strips, triangles and triangle strips. Loops, fans, quads, quad strips and polygons
  // are drawn as strips or lists through an index buffer the replayer builds (conv = the NVN primitive)
  let prim = orig, conv = 0;
  if (orig == 2) { prim = 3; conv = orig; } else if (orig >= 6 && orig <= 9) { prim = 4; conv = orig; }
  else if (!(orig == 0 || orig == 1 || orig == 3 || orig == 4 || orig == 5)) {
    if (once(10 + min<u32>(<u32>orig, 15))) { L.red("draw primitive "); L.i(orig); L.str(" has no WebGPU topology (adjacency and patches need geometry or tessellation stages): skipped"); L.end(); }
    skipRec(H.SKIP_STATE, 0, 0); nSkipped++; return;
  }
  // The draw's numbers: from the record, or for an indirect draw from guest memory now (the counts are CPU-visible
  // at submit; a count written by the GPU in the same submission is not supported)
  let count = load<u32>(r, 8), instances: u32, baseInstance = load<u32>(r, 16), first: u32 = 0, baseVertex: i32 = 0, ibuf: u64 = 0, drawIndex: u32 = 0;
  const itype = indexed ? load<i32>(r, O.P_DRAW_IDX_itype) : -1;
  if (indexed) { baseVertex = load<i32>(r, O.P_DRAW_IDX_base_vertex); instances = load<u32>(r, O.P_DRAW_IDX_instances); ibuf = load<u64>(r, O.P_DRAW_IDX_ibuf); }
  else { first = load<u32>(r, O.P_DRAW_first); instances = load<u32>(r, O.P_DRAW_instances); }
  if (<usize>size - 8 >= (indexed ? O.P_DRAW_IDX_SIZE : O.P_DRAW_SIZE)) {
    const q = r + (indexed ? O.P_DRAW_IDX_ind : O.P_DRAW_ind), ind = <usize>load<u64>(q), cnt = <usize>load<u64>(q, 8);
    if (cnt && <u32>load<i32>(q, 16) >= load<u32>(cnt)) return;       // draw i of a multi-draw whose count is lower
    drawIndex = <u32>load<i32>(q, 16);                                // a multi-draw's record number: the shader's draw index
    if (ind) {
      count = load<u32>(ind); instances = load<u32>(ind, 4);
      if (indexed) { ibuf += <u64>load<u32>(ind, 8) << (itype == 2 ? 2 : itype == 1 ? 1 : 0); baseVertex = load<i32>(ind, 12); baseInstance = load<u32>(ind, 16); }
      else { first = load<u32>(ind, 8); baseInstance = load<u32>(ind, 12); }
    }
  }
  if (!instances) instances = 1;
  if (!count) { skipRec(H.SKIP_EMPTY, 0, 0); return; }      // (an indirect draw's count is read here, on the CPU, at the submission: a count the GPU writes later is 0 now)
  const vs = progShader(prog, 0), fs = progShader(prog, 1);
  if (vs < 0 || fs < 0) { skipRec(H.SKIP_SHADER, 0, prog); nSkipped++; return; }                        // "[RED] shader <key> is not in the shader map", once a key
  if (vs != curVs || fs != curFs || meshMode) { curVs = vs; curFs = fs; meshMode = false; dirty |= D_PIPE | D_UBO | D_TEX | D_VBUF; }
  const kit = conv == 2 ? 2 : conv ? -1 : itype;      // what the strip index format follows: a converted loop is a strip with 32-bit indices
  if (dirty & D_PIPE || load<u8>(PK.KEY, PK.PK_prim) != <u8>prim || load<u8>(PK.KEY, PK.PK_itype) != <u8>(kit >= 0 && (prim == 3 || prim == 5) ? kit + 1 : 0)) {
    if (!fillKey(prim, kit)) { dirty |= D_PIPE; skipRec(H.SKIP_STATE, 0, 0); nSkipped++; return; }
    const id = PK.pipelineGet();
    if (id < 0) { dirty |= D_PIPE; skipRec(H.SKIP_PIPELINE, 0, 0); nSkipped++; return; }
    if (id != curPipe) { curPipe = id; dirty |= D_BIND | D_VBUF; }
    dirty &= ~D_PIPE;
  }
  if (baseInstance != drawBaseInst) { drawBaseInst = baseInstance; if (readsDriver0(vs) || readsDriver0(fs)) dirty |= D_UBO; }
  if (feedback()) dirty |= D_TEX;
  passEvent(GfxPassE.Draw);
  emitState();
  if (indexed) {
    const o = H.hostRec(H.H_DRAW_IDX, 48);
    store<u32>(o, itype, 8); store<u32>(o, count, 12); store<u32>(o, instances, 16); store<u32>(o, baseInstance, 20); store<i32>(o, baseVertex, 24); store<u32>(o, conv, 28); store<u64>(o, ibuf, 32); store<u32>(o, drawIndex, 40);
  } else {
    const o = H.hostRec(H.H_DRAW, 32);
    store<u32>(o, first, 8); store<u32>(o, count, 12); store<u32>(o, instances, 16); store<u32>(o, baseInstance, 20); store<u32>(o, conv, 24); store<u32>(o, drawIndex, 28);
  }
  nDraws++; R.segDraw();
}

// ---- mesh draws (DrawMeshTasks, DrawMeshTasksIndirect) ----
// WebGPU has no task or mesh stage, and no compute inside a render pass: the pass ends, the task shader (when the mesh shader reads a task's payload) and the
// mesh shader run as compute with their own stages' bindings (src/shaders/meshstage.ts: the outputs go to slots of a buffer the replayer keeps), the pass
// begins again with what it holds, and a vertex shader made from the mesh shader's outputs draws the slots (GfxHost, "mesh draws"). An indirect draw's
// {count, first} is read by the GPU (the game's culling writes it in the same frame): its counts never reach the CPU
function computePipe(id: i32): i32 {
  const k = PK.KEY;
  memory.fill(k, 0, PK.PK_SIZE);
  store<u16>(k, 0xffff, PK.PK_vs); store<u16>(k, <u16>id, PK.PK_fs); store<u8>(k, 0xff, PK.PK_prim);
  dirty |= D_PIPE;
  return PK.pipelineGet();
}
function meshSkip(reason: u32 = H.SKIP_SHADER): void { skipRec(reason, 2, prog); nMeshSkipped++; nSkipped++; }
function meshDraw(r: usize): void {
  const ms = progShader(prog, 4);
  if (ms < 0) { if (once(37)) L.redLine("DrawMeshTasks with a program that has no mesh shader, or whose shaders are not all in the shader map: skipped"); meshSkip(); return; }
  const fs = progShader(prog, 1);
  if (fs < 0) { if (once(38)) L.redLine("DrawMeshTasks with a program that has no fragment shader, or whose shaders are not all in the shader map: skipped"); meshSkip(); return; }
  const ind = load<u64>(r, O.P_DRAW_ind), first = load<u32>(r, O.P_DRAW_first), count = load<u32>(r, O.P_DRAW_count);
  if (!ind && !count) { skipRec(H.SKIP_EMPTY, 2, 0); return; }
  const withTask = (load<u32>(libRefl(ms), RF_flags) & 4) != 0, ts = withTask ? progShader(prog, 3) : -1;
  if (withTask && ts < 0) { if (once(39)) L.redLine("a mesh shader that reads its task's payload, in a program with no task shader (or one not in the shader map): its mesh draws are skipped"); meshSkip(); return; }
  const tp = withTask ? computePipe(ts) : -1, mp = computePipe(ms);
  if (mp < 0 || (withTask && tp < 0)) { meshSkip(H.SKIP_PIPELINE); return; }
  meshMode = true;
  if (ms != curVs || fs != curFs) { curVs = ms; curFs = fs; dirty |= D_UBO | D_TEX | D_VBUF; }
  if (!fillKey(MESH_PRIM, -1)) { dirty |= D_PIPE; meshSkip(H.SKIP_STATE); return; }
  const id = PK.pipelineGet();
  if (id < 0) { dirty |= D_PIPE; meshSkip(H.SKIP_PIPELINE); return; }
  if (id != curPipe) { curPipe = id; dirty |= D_BIND | D_VBUF; }
  dirty &= ~D_PIPE;
  passBreak();
  const b = H.hostRec(H.H_MESH_BEGIN, 40);
  store<u32>(b, (ind ? 1 : 0) | (withTask ? 2 : 0), 8); store<u32>(b, first, 12); store<u32>(b, count, 16); store<u64>(b, ind, 24); store<u32>(b, ms, 32); store<i32>(b, ts, 36);
  if (withTask) { emitUbos(2, ts, 3); emitTexs(2, ts, 3); emitStorage(2, ts, 3); store<u32>(H.hostRec(H.H_MESH_TASK, 16), tp, 8); }
  emitUbos(2, ms, 4); emitTexs(2, ms, 4); emitStorage(2, ms, 4); store<u32>(H.hostRec(H.H_MESH_RUN, 16), mp, 8);
  if (feedback()) dirty |= D_TEX;
  passEvent(GfxPassE.Draw);
  emitState();
  store<u32>(H.hostRec(H.H_MESH_DRAW, 16), curPipe, 8);
  nDraws++; nMesh++; if (ind) nMeshInd++; if (withTask) nMeshTask++;
  R.segDraw();
}

// ---- copies ----
function viewLevel(v: usize, has: bool): u32 { return has && (load<u8>(v) & 1) ? load<u8>(v, O.VIEW_base_level) : 0; }
function viewLayer(v: usize, has: bool): u32 { return has && (load<u8>(v) & 2) ? load<u16>(v, O.VIEW_min_layer) : 0; }
function copyB2T(r: usize, size: u32): void {
  const t = liveTex(<usize>load<u64>(r, O.P_COPY_B2T_tex));
  if (!t) { if (once(27)) L.redLine("CopyBufferToTexture: the texture is not live at submit; the copy is dropped"); return; }
  const has = load<u8>(r, O.P_COPY_B2T_has_view) != 0;
  if (isTarget(load<u64>(t, O.TEX_serial))) passBreak();      // a clear of it may be pending, or its pass open: those come first
  // While the storage holds the texture's content the copy is made there, in stream order (the swizzled bytes a later
  // ReadTexels, CopyTextureToBuffer or re-upload sees, as nxnative mirrors it); the next use uploads. No GPU copy then
  if (contentState(load<u64>(t, O.TEX_serial)) != GfxTextureS.GpuOwned) {
    let row: u32 = 0, img: u32 = 0;
    if (<usize>size - 8 >= O.COPY_STRIDES_OFF + O.P_COPY_STRIDES_SIZE) { row = <u32>load<i64>(r, O.COPY_STRIDES_OFF); img = <u32>load<i64>(r, O.COPY_STRIDES_OFF + 8); }
    // A texture this submission already used was uploaded for draws that are not submitted yet: they go first, so that
    // they see the old texels and the draws after the copy the new ones
    if (contentInUse(load<u64>(t, O.TEX_serial))) { passBreak(); H.hostRec(H.H_FLUSH, 8); }
    if (regionCopy(t, viewLevel(r + O.P_COPY_B2T_view, has), viewLayer(r + O.P_COPY_B2T_view, has), r + O.P_COPY_B2T_r, <usize>load<u64>(r, O.P_COPY_B2T_src), row, img, true)) {
      contentStage(load<u64>(t, O.TEX_serial)); nMirrored++; dirty |= D_TEX; return;
    }
  }
  passBreak();
  contentGpuWrite(load<u64>(t, O.TEX_serial));
  const o = H.hostRec(H.H_COPY_B2T, 64);
  store<u64>(o, load<u64>(r, O.P_COPY_B2T_src), 8); store<u64>(o, load<u64>(t, O.TEX_serial), 16);
  store<u32>(o, viewLevel(r + O.P_COPY_B2T_view, has), 24); store<u32>(o, viewLayer(r + O.P_COPY_B2T_view, has), 28);
  memory.copy(o + 32, r + O.P_COPY_B2T_r, 24);
  if (<usize>size - 8 >= O.COPY_STRIDES_OFF + O.P_COPY_STRIDES_SIZE) { store<u32>(o, <u32>load<i64>(r, O.COPY_STRIDES_OFF), 56); store<u32>(o, <u32>load<i64>(r, O.COPY_STRIDES_OFF + 8), 60); }
}
function copyT2T(r: usize): void {
  const s = liveTex(<usize>load<u64>(r, O.P_COPY_T2T_src)), d = liveTex(<usize>load<u64>(r, O.P_COPY_T2T_dst));
  if (!s || !d) { if (once(28)) L.redLine("CopyTextureToTexture: a texture is not live at submit; the copy is dropped"); return; }
  passBreak();
  contentNeed(load<u64>(s, O.TEX_serial)); contentGpuWrite(load<u64>(d, O.TEX_serial));
  // A Downsample (COPY_RESOLVE) is the same record: the replayer resolves instead of copying
  const hs = load<u8>(r, O.P_COPY_T2T_has_sv) != 0, hd = load<u8>(r, O.P_COPY_T2T_has_dv) != 0, o = H.hostRec(H.H_COPY_T2T, 96);
  store<u64>(o, load<u64>(s, O.TEX_serial), 8); store<u64>(o, load<u64>(d, O.TEX_serial), 16);
  store<u32>(o, viewLevel(r + O.P_COPY_T2T_sv, hs), 24); store<u32>(o, viewLayer(r + O.P_COPY_T2T_sv, hs), 28);
  store<u32>(o, viewLevel(r + O.P_COPY_T2T_dv, hd), 32); store<u32>(o, viewLayer(r + O.P_COPY_T2T_dv, hd), 36);
  memory.copy(o + 40, r + O.P_COPY_T2T_sr, 24); memory.copy(o + 64, r + O.P_COPY_T2T_dr, 24); store<u32>(o, load<u32>(r, O.P_COPY_T2T_flags), 88);
}
// CopyTextureToBuffer. A texture whose content is its storage is copied on the CPU, in stream order; one the GPU wrote
// is read back by the replayer and lands in guest memory when the GPU is done (fences issued after it wait for that)
function copyT2B(r: usize, size: u32): void {
  const t = liveTex(<usize>load<u64>(r, O.P_COPY_B2T_tex));
  if (!t) { if (once(30)) L.redLine("CopyTextureToBuffer: the texture is not live at submit; the copy is dropped"); return; }
  const has = load<u8>(r, O.P_COPY_B2T_has_view) != 0, level = viewLevel(r + O.P_COPY_B2T_view, has), layer = viewLayer(r + O.P_COPY_B2T_view, has);
  let row: u32 = 0, img: u32 = 0;
  if (<usize>size - 8 >= O.COPY_STRIDES_OFF + O.P_COPY_STRIDES_SIZE) { row = <u32>load<i64>(r, O.COPY_STRIDES_OFF); img = <u32>load<i64>(r, O.COPY_STRIDES_OFF + 8); }
  if (isTarget(load<u64>(t, O.TEX_serial))) passBreak();      // a pending clear of it lands first: it is then the GPU's
  H.hostFlush();
  if (regionCopy(t, level, layer, r + O.P_COPY_B2T_r, <usize>load<u64>(r, O.P_COPY_B2T_src), row, img, false)) { H.hostRec(H.H_MEM_DIRTY, 8); dirty |= D_VBUF | D_UBO; return; }
  passBreak();
  const o = H.hostRec(H.H_COPY_T2B, 64);
  store<u64>(o, load<u64>(r, O.P_COPY_B2T_src), 8); store<u64>(o, load<u64>(t, O.TEX_serial), 16); store<u32>(o, level, 24); store<u32>(o, layer, 28);
  memory.copy(o + 32, r + O.P_COPY_B2T_r, 24); store<u32>(o, row, 56); store<u32>(o, img, 60);
}
// A CPU-visible write in stream order: everything before it is executed first (the replayer uploads what the earlier
// draws bound), then guest memory changes, then the replayer is told to forget its uploads
// nvnCommandBufferClearBuffer: the range takes the 32-bit value (as nxnative's OP_CLEAR_BUF), in stream order like memWrite
// The replayer is told which bytes changed: it checks again only the uploads that overlap them (a frame of the game has some 80 such writes, and hundreds of
// megabytes of bound ranges that none of them touches)
function memDirty(dst: usize, n: usize): void { const r = H.hostRec(H.H_MEM_DIRTY, 24); store<u64>(r, <u64>dst, 8); store<u32>(r, n > 0xffffffff ? 0 : <u32>n, 16); }
function memFill(dst: usize, n: usize, v: u32): void {
  if (!dst || !n) return;
  H.hostFlush();
  R.reportOverwrite(dst, n);
  if (!v) memory.fill(dst, 0, n);
  else { let i: usize = 0; for (; i + 4 <= n; i += 4) store<u32>(dst + i, v); for (; i < n; i++) store<u8>(dst + i, <u8>(v >> (<u32>(i & 3) * 8))); }
  memDirty(dst, n);
  dirty |= D_VBUF | D_UBO;
}
// Stream writes (gfx_stream_writes(1); off by default): the bytes travel in the stream and the REPLAYER writes guest
// memory when it gets there, as the console's GPU does (the game may not touch the range before the submission is
// done there either). No flush: a frame of the game's first 3D area has about a hundred of these writes, and each
// flush made the calling thread wait until the replayer had executed everything before it. What is given up: the
// recorder itself (an address a shader loads, lower.ts emitGmem; an indirect draw's count) and the game's CPU read
// the range as it was until the replayer has passed the record.
let streamWrites = false;
export function setStreamWrites(on: bool): void { streamWrites = on; }
function memWrite(dst: usize, src: usize, n: usize): void {
  if (streamWrites && dst && n && n <= 65536) {
    R.reportOverwrite(dst, n);
    const r = H.hostRec(H.H_MEM_WRITE, (24 + n + 7) & ~7);
    store<u64>(r, <u64>dst, 8); store<u32>(r, <u32>n, 16); memory.copy(r + 24, src, n);
    dirty |= D_VBUF | D_UBO;
    return;
  }
  H.hostFlush();
  R.reportOverwrite(dst, n);
  memory.copy(dst, src, n);
  memDirty(dst, n);
  dirty |= D_VBUF | D_UBO;
}

// ---- the walk ----
const NOT_REPLAYED: usize = memory.data(64);
function exec(p: usize, depth: i32): void {
  for (;;) {
    const op = load<u32>(p), size = load<u32>(p, 4), a = p + 8;
    if (op >= O.OP_COUNT_ || size < 8 || (size & 7)) { L.red("command record at "); L.hex(p); L.str(" is not one (op "); L.u(op); L.str(" size "); L.u(size); L.str("): the rest of this handle is dropped"); L.end(); return; }
    switch (op) {
      case O.OP_END: return;
      case O.OP_JUMP: p = <usize>load<u64>(a); continue;
      case O.OP_CALL:
        if (depth >= 8) L.redLine("CALL nested deeper than 8: dropped");
        else exec(<usize>load<u64>(a), depth + 1);
        break;
      case O.OP_SET_RT: setRenderTargets(a); break;
      case O.OP_CLEAR_COLOR: if (!R.renderSkip(1)) clearColor(a); break;
      case O.OP_CLEAR_DS: if (!R.renderSkip(1)) clearDepthStencil(a); break;
      case O.OP_VIEWPORTS:
        if (load<i32>(a) + load<i32>(a, 4) > 1 && once(31)) L.redLine("SetViewports beyond index 0: WebGPU has one viewport and no layer-selected viewports, the others are ignored");
        if (load<i32>(a) == 0 && load<i32>(a, 4) >= 1) { memory.copy(VP, a + O.P_VIEWPORTS_v, 16); hasVp = true; dirty |= D_VP; } break;
      case O.OP_SCISSOR: scX = load<i32>(a); scY = load<i32>(a, 4); scW = load<i32>(a, 8); scH = load<i32>(a, 12); hasSc = true; dirty |= D_SC; break;
      case O.OP_DEPTH_RANGE: depthNear = load<f32>(a); depthFar = load<f32>(a, 4); dirty |= D_VP; break;
      case O.OP_BIND_PROGRAM: {
        const np = <usize>load<u64>(a);
        if (load<i32>(a, 8) & 0xc3) { if (np != prog) { prog = np; dirty |= D_PIPE; } curVs = -1; curFs = -1; }
        if (load<i32>(a, 8) & 0x20) { progC = np; curCs = -1; }
        break;
      }
      case O.OP_BIND_STATE: {
        const b = a + O.P_BIND_STATE_bytes;
        switch (load<i32>(a)) {
          case 0: { const v = load<u64>(b); store<u64>(BLEND + (<usize>(v & 7) << 3), v); break; }
          case 1: colorSt = load<u32>(b); break;
          case 2: chmask = load<u32>(b); break;
          case 3: memory.copy(MS, b, O.MS_ST_SIZE); break;
          case 4: polySt = load<u32>(b); break;
          case 5: dsSt = load<u64>(b); break;
        }
        dirty |= D_PIPE; break;
      }
      case O.OP_BIND_VATTR: nattr = load<i32>(a, 4); memory.copy(VATTR, a + O.P_BIND_VATTR_st, <usize>nattr << 2); dirty |= D_PIPE; break;
      case O.OP_BIND_VSTREAM: nstream = load<i32>(a, 4); memory.copy(VSTREAM, a + O.P_BIND_VSTREAM_st, <usize>nstream << 3); dirty |= D_PIPE; break;
      case O.OP_BIND_VBUF: memory.copy(VBUF + (<usize>load<i32>(a) << 4), a + O.P_BIND_VBUF_r, <usize>load<i32>(a, 4) << 4); dirty |= D_VBUF; break;
      case O.OP_BIND_VBUF1: { const e = VBUF + (<usize>(load<u32>(a) & 15) << 4); store<u64>(e, load<u64>(a, 8)); store<u64>(e, <u64>load<u32>(a, 4), 8); dirty |= D_VBUF; break; }
      case O.OP_BIND_UBO: case O.OP_BIND_UBO_SMALL: {
        const small = op == O.OP_BIND_UBO_SMALL;
        const st: u32 = hst(small ? load<u16>(a) : load<u32>(a)), i: u32 = small ? load<u16>(a, 2) : load<u32>(a, 4);
        if (i < 16) { const e = UBO + (<usize>(st * 16 + i) << 4); store<u64>(e, load<u64>(a, 8)); store<u64>(e, small ? <u64>load<u32>(a, 4) : load<u64>(a, 16), 8); dirty |= D_UBO; }
        geometryBind(st);
        break;
      }
      case O.OP_BIND_TEX1: {
        const sv = load<i32>(a), st = hst(<u32>(sv & ~O.BIND_TEX1_NOBASE)), slot = load<u32>(a, 4), h = load<u64>(a, 8);
        let tid = h & 0xfffff, sid = <u64>(<u32>h >> 20);
        if (!(sv & O.BIND_TEX1_NOBASE)) { if (tid) tid += <u64>load<i32>(a, 16); if (sid) sid += <u64>load<i32>(a, 20); }
        geometryBind(st);
        if (slot < 32) { store<u64>(TEXH + (<usize>(st * 32 + slot) << 3), tid | sid << 20); dirty |= D_TEX; }
        break;
      }
      case O.OP_BIND_SSBO: {
        const st = hst(load<u32>(a)), i = load<u32>(a, 4);
        geometryBind(st);
        if (i < 16) { const e = SSBO + (<usize>(st * 16 + i) << 4); store<u64>(e, load<u64>(a, 8)); store<u64>(e, load<u64>(a, 16), 8); dirty |= D_UBO; }
        break;
      }
      case O.OP_BIND_IMG: {
        const st = hst(load<u32>(a)), first = load<u32>(a, 4), n = load<u32>(a, 8);
        geometryBind(st);
        for (let i: u32 = 0; i < n && first + i < 8; i++) store<u64>(IMGH + (<usize>(st * 8 + first + i) << 3), load<u64>(a + O.P_BIND_HANDLES_h + (<usize>i << 3)) & 0xfffff);
        dirty |= D_UBO; break;
      }
      case O.OP_DISPATCH: dispatch(a); break;
      case O.OP_RAST_DISCARD: rastDiscard = load<i32>(a) != 0; break;
      case O.OP_PRIM_RESTART: restartSet = true; restartOn = load<i32>(a) != 0; break;
      case O.OP_CLEAR_BUF: memFill(<usize>load<u64>(a), <usize>load<u64>(a, 8), load<u32>(a, 16)); break;
      case O.OP_DEPTH_CLAMP: { const on = load<i32>(a) != 0; if (on != depthClamp) { depthClamp = on; dirty |= D_PIPE; } break; }
      case O.OP_BIND_TEX: {
        const st = hst(load<u32>(a)), first = load<u32>(a, 4), n = load<u32>(a, 8);
        const src = <usize>load<u64>(a, O.P_BIND_HANDLES_src), defer = load<i32>(a, O.P_BIND_HANDLES_defer) != 0 && src != 0;
        geometryBind(st);
        for (let i: u32 = 0; i < n && first + i < 32; i++)
          store<u64>(TEXH + (<usize>(st * 32 + first + i) << 3), defer ? <u64>load<u32>(src + (<usize>i << 3)) : load<u64>(a + O.P_BIND_HANDLES_h + (<usize>i << 3)));
        dirty |= D_TEX; break;
      }
      case O.OP_STENCIL: {
        const face = load<i32>(a), which = load<i32>(a, 16);
        if (face & 1) {      // WebGPU has one mask and one reference for both faces: the front face's
          if (which == 0) { stValueMask = load<u32>(a, 4) & 0xff; dirty |= D_PIPE; } else if (which == 1) { stWriteMask = load<u32>(a, 8) & 0xff; dirty |= D_PIPE; } else { stRef = load<u32>(a, 12) & 0xff; dirty |= D_STREF; }
        }
        break;
      }
      case O.OP_POLY_OFFSET: memory.copy(POLYOFF, a, 12); dirty |= D_PIPE; break;
      case O.OP_BLEND_COLOR: memory.copy(BLENDC, a, 16); dirty |= D_BLENDC; break;
      case O.OP_DRAW: if (!R.renderSkip(0)) draw(a, size, false); else skipRec(H.SKIP_RENDER_COND, 0, 0); break;
      case O.OP_DRAW_IDX: if (!R.renderSkip(0)) draw(a, size, true); else skipRec(H.SKIP_RENDER_COND, 0, 0); break;
      case O.OP_BARRIER: if (load<i32>(a)) passBreak(); break;
      // The pools' numbering bases were added to bound handles when the binds were recorded; handles read from uniform
      // data (slotHandle) take the bases of the pools set here
      case O.OP_SET_TEX_POOL: { const b = dpoolBase(load<u64>(a), true); if (b != texBase) { texBase = b; dirty |= D_TEX; } break; }
      case O.OP_SET_SAMP_POOL: { const b = dpoolBase(load<u64>(a), false); if (b != sampBase) { sampBase = b; dirty |= D_TEX; } break; }
      case O.OP_COPY_B2T: copyB2T(a, size); break;
      case O.OP_COPY_T2T: copyT2T(a); break;
      case O.OP_CLEAR_TEX: clearTex(a); break;
      case O.OP_PUSH_CONST: {
        const off = <usize>load<u16>(a, O.P_PUSH_CONST_offset), n = <usize>load<u32>(a, O.P_PUSH_CONST_size);
        if (off + n <= 256) { memory.copy(PUSH + (load<u16>(a, O.P_PUSH_CONST_compute) ? 256 : 0) + off, a + O.P_PUSH_CONST_data, n); dirty |= D_UBO; }
        break;
      }
      case O.OP_COPY_T2B: copyT2B(a, size); break;
      case O.OP_COPY_B2B: memWrite(<usize>load<u64>(a, 8), <usize>load<u64>(a), <usize>load<u64>(a, 16)); break;
      case O.OP_UPDATE_UB: memWrite(<usize>load<u64>(a), a + 16, <usize>load<u64>(a, 8)); break;
      // The replay is in submission order on one host queue: an event signal lands when its submission is replayed, and
      // a wait on an event of this queue has nothing earlier to wait for
      case O.OP_SIGNAL_EVENT: { const w = <usize>load<u64>(a), v = load<u32>(a, 12); if (w) store<u32>(w, load<i32>(a, 8) == 1 ? load<u32>(w) + v : v); break; }
      case O.OP_WAIT_EVENT: break;
      case O.OP_FENCE_SYNC: { const s = <usize>load<u64>(a); passBreak(); emitFence(s); break; }
      // Counter reports and render enable (report.ts). A reset has nothing to do while no counter is counted here
      case O.OP_REPORT_COUNTER: R.reportIssue(<u32>load<u64>(a), load<u64>(a, 8)); break;
      case O.OP_RESET_COUNTER: break;
      case O.OP_RENDER_COND: R.renderCond(load<i32>(a), load<u64>(a, 8)); break;
      default:
        if (!load<u8>(NOT_REPLAYED + op)) { store<u8>(NOT_REPLAYED + op, 1); L.red("command record op "); L.u(op); L.str(" is recorded but not replayed yet"); L.end(); }
    }
    p += size;
  }
}
// A fence at this point of the stream; sync = the NVNsync it belongs to
export function emitFence(sync: usize): void {
  const n = fenceNew();
  store<u64>(H.hostRec(H.H_FENCE, 16), n, 8);
  syncFence(sync, n, false);
}

export function submit(n: i32, handles: usize): void {
  nSubmits++;
  R.segSubmitBegin();
  for (let i = 0; i < n; i++) { const h = <usize>load<u64>(handles + (<usize>i << 3)); if (h) exec(h, 0); }
  passEvent(GfxPassE.Submit);
  R.reportCommit();
  H.hostRec(H.H_FLUSH, 8);
  H.hostFlush();
  submitDone();
}
// nvnQueuePresentTexture: the blit of the window texture to the canvas
export function present(tex: usize, crop: usize, window: usize, index: i32): void {
  passBreak();
  contentNeed(load<u64>(tex, O.TEX_serial));
  const o = H.hostRec(H.H_PRESENT, 48);
  store<u64>(o, load<u64>(tex, O.TEX_serial), 8); memory.copy(o + 16, crop, 16); store<u64>(o, window, 32); store<u32>(o, index, 40);   // the window is the game's object: its address, 8 bytes
  store<u32>(o, originLowerLeft ? 1 : 0, 44);      // stored bottom-up: shown flipped
  H.hostRec(H.H_FLUSH, 8);
  H.hostFlush();
}
