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
import { progShader, libRefl, RF_ubo, RF_tex, RF_io, RF_ssbo, RF_ssbo_w, RF_img, RF_ubo_size, RF_vin, RF_flags, RF_bl, RF_blh, BL_OR, BL_SAMPLER_ID } from "./shader";
import { fmtClass, fmtCanon, fmtTwin } from "./fmt";
import * as PK from "./pipeline";
import { syncFence } from "./sync";
import { contentNeed, contentGpuWrite, contentStage, contentState, contentInUse, regionCopy, submitDone } from "./texcontent";
import { GfxTextureS } from "../kit/gen/tables";

// ---- current state (nxnative's S and R) ----
let prog: usize = 0;
const BLEND: usize = memory.data(64);        // blend_st x 8
let colorSt: u32 = 0, chmask: u32 = 0xffffffff, polySt: u32 = 0, dsSt: u64 = 0;
const MS: usize = memory.data(16);
const VATTR: usize = memory.data(128); let nattr: i32 = 0;
const VSTREAM: usize = memory.data(128); let nstream: i32 = 0;
const VBUF: usize = memory.data(256);        // { u64 address, u64 size } x 16
// Stages here: 0 vertex, 1 fragment, 2 compute (NVN's 0, 1 and 5; the others have no WebGPU stage)
const UBO: usize = memory.data(768);         // [stage 0..2][16] { u64 address, u64 size }
const TEXH: usize = memory.data(768);        // [stage 0..2][32] u64 handle
const SSBO: usize = memory.data(768);        // [stage 0..2][16] { u64 address, u64 size }
const IMGH: usize = memory.data(192);        // [stage 0..2][8] u64 image handle (a texture ID)
let progC: usize = 0, depthClamp = false;
// Storage ranges a compute pass wrote: read back into guest memory when the pass ends
const WR: usize = memory.data(512); let nwr: i32 = 0;
// @ts-ignore: decorator
@inline function hst(st: u32): u32 { return st < 2 ? st : st == 5 ? 2 : 3; }
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
let nPasses: u32 = 0, nDraws: u32 = 0, nSkipped: u32 = 0, nSnapshots: u32 = 0, nClearRects: u32 = 0, nSubmits: u32 = 0, nDispatches: u32 = 0, nComputePasses: u32 = 0, nMirrored: u32 = 0, nBindless: u32 = 0;
export function stat(i: i32): u32 { return i == 0 ? nPasses : i == 1 ? nDraws : i == 2 ? nSkipped : i == 3 ? nSnapshots : i == 4 ? nClearRects : i == 5 ? nSubmits : i == 13 ? nDispatches : i == 14 ? nComputePasses : i == 15 ? nMirrored : i == 16 ? nBindless : 0; }
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
  let fmt = load<u32>(t, O.TEX_d + O.TD_format);
  if (bits & 4) {
    const vf = <u32>load<u16>(view, O.VIEW_format);
    if (fmtCanon(vf) != fmtCanon(fmt)) {
      if (fmtTwin(fmtCanon(fmt)) == fmtCanon(vf)) fmt = vf;
      else if (once(32)) { L.red("a render target view reads format 0x"); L.hex(fmt); L.str(" as 0x"); L.hex(vf); L.str(": WebGPU views can only switch sRGB, the texture's own format is rendered"); L.end(); }
    }
  }
  store<u32>(e, fmt, RT_fmt);
  store<u32>(e, level, RT_level); store<u32>(e, bits & 2 ? <u32>load<u16>(view, O.VIEW_min_layer) : 0, RT_layer);
  store<u32>(e, mipExt(load<u32>(t, O.TEX_d + O.TD_width), level), RT_w); store<u32>(e, mipExt(load<u32>(t, O.TEX_d + O.TD_height), level), RT_h);
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
  for (let st: u32 = 0; st < 2; st++) {
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
  let need = load<u32>(libRefl(curVs), RF_io);
  store<u32>(k, need, PK.PK_attr_mask);
  for (let loc = 0; need; loc++, need >>= 1) {
    if (!(need & 1)) continue;
    const a = loc < nattr ? load<u32>(VATTR + (<usize>loc << 2)) : 0;
    if (!(a & 0xff)) { if (once(4)) { L.red("the vertex shader reads attribute "); L.i(loc); L.str(", which the bound vertex attribute state does not have: the draw is skipped"); L.end(); } return false; }
    const stream = a >> 27;
    if (stream >= 16 || !load<u64>(VBUF + (<usize>stream << 4))) { if (once(5)) { L.red("no vertex buffer bound for stream "); L.u(stream); L.str(": the draw is skipped"); L.end(); } return false; }
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
    for (let loc = 0, need = load<u32>(PK.KEY, PK.PK_attr_mask); need; loc++, need >>= 1) if (need & 1) streams |= 1 << (load<u32>(PK.KEY + PK.PK_attr + (<usize>loc << 2)) >> 27);
    for (let s: u32 = 0; streams; s++, streams >>= 1) {
      if (!(streams & 1)) continue;
      const r = H.hostRec(H.H_VBUF, 24);
      store<u32>(r, s, 8); store<u32>(r, <u32>load<u64>(VBUF + (<usize>s << 4), 8), 12); store<u64>(r, load<u64>(VBUF + (<usize>s << 4)), 16);
    }
  }
  if (dirty & D_UBO) { emitUbos(0, curVs); emitUbos(1, curFs); emitStorage(0, curVs); emitStorage(1, curFs); }
  if ((dirty & D_UBO) && (hasBindless(curVs) || hasBindless(curFs))) dirty |= D_TEX;      // the handles are uniform data
  if (dirty & D_TEX) { emitTexs(0, curVs); emitTexs(1, curFs); }
  if (dirty & D_BLENDC) memory.copy(H.hostRec(H.H_BLEND_COLOR, 24) + 8, BLENDC, 16);
  if (dirty & D_STREF) store<u32>(H.hostRec(H.H_STENCIL_REF, 16), stRef, 8);
  dirty = 0;
}

// What stage st's shader `id` reads, to the replayer: uniform ranges (with the size the WGSL type covers: the replayer
// binds at least that, zero past what the game bound), the translator's support buffer, textures, storage, images
let vpW: f32 = 0, vpH: f32 = 0;
function emitUbos(st: u32, id: i32): void {
  const rf = libRefl(id);
  let m = load<u32>(rf, RF_ubo) & 0x7fff;
  for (let i: u32 = 0; m; i++, m >>= 1) {
    if (!(m & 1)) continue;
    if (i == 14) { emitSupport(st); continue; }
    const b = UBO + (<usize>(st * 16 + i) << 4), r = H.hostRec(H.H_UBO, 32);
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
function emitTexs(st: u32, id: i32): void {
  const rf = libRefl(id);
  let m = load<u32>(rf, RF_tex);
  for (let slot: u32 = 0; m; slot++, m >>= 1) {
    if (!(m & 1)) continue;
    if ((load<u32>(rf, RF_bl) >> slot) & 1) nBindless++;
    const h = slotHandle(st, rf, slot), e = texDesc(<u32>(h & 0xfffff)), serial = handleSerial(h);
    if (serial) contentNeed(serial);       // may upload it now
    const r = H.hostRec(H.H_TEX, 48);
    if (!serial && once(7)) { L.red("a draw samples texture ID "); L.u(h & 0xfffff); L.str(" (stage "); L.u(st); L.str(" slot "); L.u(slot); L.str("), which names no live texture: it reads as empty"); L.end(); }
    store<u32>(r, st, 8); store<u32>(r, slot, 12); store<u64>(r, serial, 16);
    const hasView = serial != 0 && load<u8>(e, TDE_has_view) != 0;
    store<u32>(r, (st < 2 && snapped(serial) ? 1 : 0) | (hasView ? 2 : 0), 24); store<u32>(r, <u32>(h >> 20) & 0xfff, 28);
    if (hasView) memory.copy(r + 32, e + TDE_view, O.VIEW_SIZE);
  }
}
// Storage buffers and images of a draw's or dispatch's stage. A written range is noted for the read-back at the end of the pass
function emitStorage(st: u32, id: i32): void {
  const rf = libRefl(id), wm = load<u32>(rf, RF_ssbo_w);
  let m = load<u32>(rf, RF_ssbo) & 0xffff;
  for (let i: u32 = 0; m; i++, m >>= 1) {
    if (!(m & 1)) continue;
    const b = SSBO + (<usize>(st * 16 + i) << 4), addr = load<u64>(b), size = load<u64>(b, 8), w = (wm >> i) & 1, r = H.hostRec(H.H_SSBO, 32);
    store<u32>(r, st, 8); store<u32>(r, i, 12); store<u64>(r, addr, 16); store<u32>(r, <u32>size, 24); store<u32>(r, w, 28);
    if (w && addr && size) {
      let k = 0; while (k < nwr && (load<u64>(WR + (<usize>k << 4)) != addr || load<u64>(WR + (<usize>k << 4), 8) != size)) k++;
      if (k == nwr) { if (nwr < 32) { store<u64>(WR + (<usize>k << 4), addr); store<u64>(WR + (<usize>k << 4), size, 8); nwr++; } else if (once(34)) L.redLine("a compute pass writes more than 32 storage ranges: the others are not read back into guest memory"); }
    }
  }
  const im = load<u32>(rf, RF_img);
  for (let i: u32 = 0; i < 8; i++) {
    if (!((im >> i) & 1)) continue;
    const h = load<u64>(IMGH + (<usize>(st * 8 + i) << 3)), e = texDesc(<u32>(h & 0xfffff)), serial = handleSerial(h), w = (im >> (8 + i)) & 1;
    if (!serial && once(35)) { L.red("a dispatch binds image ID "); L.u(h & 0xfffff); L.str(", which names no live texture: skipped by the replayer"); L.end(); }
    if (serial) { if (w) contentGpuWrite(serial); else contentNeed(serial); }
    const hasView = serial != 0 && load<u8>(e, TDE_has_view) != 0, r = H.hostRec(H.H_IMG, 48);
    store<u32>(r, st, 8); store<u32>(r, i, 12); store<u64>(r, serial, 16); store<u32>(r, w | (hasView ? 2 : 0), 24);
    if (hasView) memory.copy(r + 32, e + TDE_view, O.VIEW_SIZE);
  }
}
// nvnCommandBufferDispatchCompute(Indirect). A compute pipeline is its shader alone; the pass machine opens a compute
// pass, which consecutive dispatches share. Every binding the shader uses is sent with each dispatch
let curCsPipe: i32 = -1, curCs: i32 = -1;
function dispatch(r: usize): void {
  let x = load<u32>(r), y = load<u32>(r, 4), z = load<u32>(r, 8);
  const ind = <usize>load<u64>(r, O.P_DISPATCH_ind);
  if (ind) { x = load<u32>(ind); y = load<u32>(ind, 4); z = load<u32>(ind, 8); }      // CPU-visible at submit, as indirect draws
  if (!progC || load<u32>(progC) != O.MAGIC_PROG) { if (once(36)) L.redLine("compute dispatch without a bound compute program: skipped"); nSkipped++; return; }
  const cs = progShader(progC, 2);
  if (cs < 0) { nSkipped++; return; }
  if (!x || !y || !z) return;
  if (cs != curCs) {
    const k = PK.KEY;
    memory.fill(k, 0, PK.PK_SIZE);
    store<u16>(k, 0xffff, PK.PK_vs); store<u16>(k, <u16>cs, PK.PK_fs); store<u8>(k, 0xff, PK.PK_prim);
    curCsPipe = PK.pipelineGet(); curCs = cs;
    dirty |= D_PIPE;                         // the key record no longer holds the draw pipeline's key
  }
  if (curCsPipe < 0) { curCs = -1; nSkipped++; return; }
  passEvent(GfxPassE.Dispatch);
  emitUbos(2, cs); emitTexs(2, cs); emitStorage(2, cs);
  const o = H.hostRec(H.H_DISPATCH, 24);
  store<u32>(o, curCsPipe, 8); store<u32>(o, x, 12); store<u32>(o, y, 16); store<u32>(o, z, 20);
  nDispatches++;
}

function draw(r: usize, size: u32, indexed: bool): void {
  if (pass().state == GfxPassS.Unset || !hasTargets()) {
    if (pass().state == GfxPassS.Unset) passEvent(GfxPassE.Draw);      // refused: a draw with no render targets
    else if (once(8)) L.redLine("draw with render targets that have no live texture: skipped");
    nSkipped++; return;
  }
  if (!prog || load<u32>(prog) != O.MAGIC_PROG) { if (once(9)) L.redLine("draw without a bound program: skipped"); nSkipped++; return; }
  const orig = load<i32>(r);
  // WebGPU has points, lines, line strips, triangles and triangle strips. Loops, fans, quads, quad strips and polygons
  // are drawn as strips or lists through an index buffer the replayer builds (conv = the NVN primitive)
  let prim = orig, conv = 0;
  if (orig == 2) { prim = 3; conv = orig; } else if (orig >= 6 && orig <= 9) { prim = 4; conv = orig; }
  else if (!(orig == 0 || orig == 1 || orig == 3 || orig == 4 || orig == 5)) {
    if (once(10 + min<u32>(<u32>orig, 15))) { L.red("draw primitive "); L.i(orig); L.str(" has no WebGPU topology (adjacency and patches need geometry or tessellation stages): skipped"); L.end(); }
    nSkipped++; return;
  }
  // The draw's numbers: from the record, or for an indirect draw from guest memory now (the counts are CPU-visible
  // at submit; a count written by the GPU in the same submission is not supported)
  let count = load<u32>(r, 8), instances: u32, baseInstance = load<u32>(r, 16), first: u32 = 0, baseVertex: i32 = 0, ibuf: u64 = 0;
  const itype = indexed ? load<i32>(r, O.P_DRAW_IDX_itype) : -1;
  if (indexed) { baseVertex = load<i32>(r, O.P_DRAW_IDX_base_vertex); instances = load<u32>(r, O.P_DRAW_IDX_instances); ibuf = load<u64>(r, O.P_DRAW_IDX_ibuf); }
  else { first = load<u32>(r, O.P_DRAW_first); instances = load<u32>(r, O.P_DRAW_instances); }
  if (<usize>size - 8 >= (indexed ? O.P_DRAW_IDX_SIZE : O.P_DRAW_SIZE)) {
    const q = r + (indexed ? O.P_DRAW_IDX_ind : O.P_DRAW_ind), ind = <usize>load<u64>(q), cnt = <usize>load<u64>(q, 8);
    if (cnt && <u32>load<i32>(q, 16) >= load<u32>(cnt)) return;       // draw i of a multi-draw whose count is lower
    if (ind) {
      count = load<u32>(ind); instances = load<u32>(ind, 4);
      if (indexed) { ibuf += <u64>load<u32>(ind, 8) << (itype == 2 ? 2 : itype == 1 ? 1 : 0); baseVertex = load<i32>(ind, 12); baseInstance = load<u32>(ind, 16); }
      else { first = load<u32>(ind, 8); baseInstance = load<u32>(ind, 12); }
    }
  }
  if (!instances) instances = 1;
  if (!count) return;
  const vs = progShader(prog, 0), fs = progShader(prog, 1);
  if (vs < 0 || fs < 0) { nSkipped++; return; }                        // "[RED] shader <key> is not in the shader map", once a key
  if (vs != curVs || fs != curFs) { curVs = vs; curFs = fs; dirty |= D_PIPE | D_UBO | D_TEX | D_VBUF; }
  const kit = conv == 2 ? 2 : conv ? -1 : itype;      // what the strip index format follows: a converted loop is a strip with 32-bit indices
  if (dirty & D_PIPE || load<u8>(PK.KEY, PK.PK_prim) != <u8>prim || load<u8>(PK.KEY, PK.PK_itype) != <u8>(kit >= 0 && (prim == 3 || prim == 5) ? kit + 1 : 0)) {
    if (!fillKey(prim, kit)) { dirty |= D_PIPE; nSkipped++; return; }
    const id = PK.pipelineGet();
    if (id < 0) { dirty |= D_PIPE; nSkipped++; return; }
    if (id != curPipe) { curPipe = id; dirty |= D_BIND | D_VBUF; }
    dirty &= ~D_PIPE;
  }
  if (feedback()) dirty |= D_TEX;
  passEvent(GfxPassE.Draw);
  emitState();
  if (indexed) {
    const o = H.hostRec(H.H_DRAW_IDX, 40);
    store<u32>(o, itype, 8); store<u32>(o, count, 12); store<u32>(o, instances, 16); store<u32>(o, baseInstance, 20); store<i32>(o, baseVertex, 24); store<u32>(o, conv, 28); store<u64>(o, ibuf, 32);
  } else {
    const o = H.hostRec(H.H_DRAW, 32);
    store<u32>(o, first, 8); store<u32>(o, count, 12); store<u32>(o, instances, 16); store<u32>(o, baseInstance, 20); store<u32>(o, conv, 24);
  }
  nDraws++;
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
function memWrite(dst: usize, src: usize, n: usize): void {
  H.hostFlush();
  memory.copy(dst, src, n);
  H.hostRec(H.H_MEM_DIRTY, 8);
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
      case O.OP_CLEAR_COLOR: clearColor(a); break;
      case O.OP_CLEAR_DS: clearDepthStencil(a); break;
      case O.OP_VIEWPORTS:
        if (load<i32>(a) + load<i32>(a, 4) > 1 && once(31)) L.redLine("SetViewports beyond index 0: WebGPU has one viewport and no layer-selected viewports, the others are ignored");
        if (load<i32>(a) == 0 && load<i32>(a, 4) >= 1) { memory.copy(VP, a + O.P_VIEWPORTS_v, 16); hasVp = true; dirty |= D_VP; } break;
      case O.OP_SCISSOR: scX = load<i32>(a); scY = load<i32>(a, 4); scW = load<i32>(a, 8); scH = load<i32>(a, 12); hasSc = true; dirty |= D_SC; break;
      case O.OP_DEPTH_RANGE: depthNear = load<f32>(a); depthFar = load<f32>(a, 4); dirty |= D_VP; break;
      case O.OP_BIND_PROGRAM: {
        const np = <usize>load<u64>(a);
        if (load<i32>(a, 8) & 3) { if (np != prog) { prog = np; dirty |= D_PIPE; } curVs = -1; curFs = -1; }
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
        if (st < 3 && i < 16) { const e = UBO + (<usize>(st * 16 + i) << 4); store<u64>(e, load<u64>(a, 8)); store<u64>(e, small ? <u64>load<u32>(a, 4) : load<u64>(a, 16), 8); dirty |= D_UBO; }
        else if (st >= 3 && once(29)) L.redLine("uniform buffer bound to a geometry or tessellation stage: not replayed (WebGPU has no such stage)");
        break;
      }
      case O.OP_BIND_TEX1: {
        const sv = load<i32>(a), st = hst(<u32>(sv & ~O.BIND_TEX1_NOBASE)), slot = load<u32>(a, 4), h = load<u64>(a, 8);
        let tid = h & 0xfffff, sid = <u64>(<u32>h >> 20);
        if (!(sv & O.BIND_TEX1_NOBASE)) { if (tid) tid += <u64>load<i32>(a, 16); if (sid) sid += <u64>load<i32>(a, 20); }
        if (st < 3 && slot < 32) { store<u64>(TEXH + (<usize>(st * 32 + slot) << 3), tid | sid << 20); dirty |= D_TEX; }
        break;
      }
      case O.OP_BIND_SSBO: {
        const st = hst(load<u32>(a)), i = load<u32>(a, 4);
        if (st < 3 && i < 16) { const e = SSBO + (<usize>(st * 16 + i) << 4); store<u64>(e, load<u64>(a, 8)); store<u64>(e, load<u64>(a, 16), 8); dirty |= D_UBO; }
        break;
      }
      case O.OP_BIND_IMG: {
        const st = hst(load<u32>(a)), first = load<u32>(a, 4), n = load<u32>(a, 8);
        if (st < 3) for (let i: u32 = 0; i < n && first + i < 8; i++) store<u64>(IMGH + (<usize>(st * 8 + first + i) << 3), load<u64>(a + O.P_BIND_HANDLES_h + (<usize>i << 3)) & 0xfffff);
        dirty |= D_UBO; break;
      }
      case O.OP_DISPATCH: dispatch(a); break;
      case O.OP_DEPTH_CLAMP: { const on = load<i32>(a) != 0; if (on != depthClamp) { depthClamp = on; dirty |= D_PIPE; } break; }
      case O.OP_BIND_TEX: {
        const st = hst(load<u32>(a)), first = load<u32>(a, 4), n = load<u32>(a, 8);
        const src = <usize>load<u64>(a, O.P_BIND_HANDLES_src), defer = load<i32>(a, O.P_BIND_HANDLES_defer) != 0 && src != 0;
        if (st < 3) for (let i: u32 = 0; i < n && first + i < 32; i++)
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
      case O.OP_DRAW: draw(a, size, false); break;
      case O.OP_DRAW_IDX: draw(a, size, true); break;
      case O.OP_BARRIER: if (load<i32>(a)) passBreak(); break;
      // The pools' numbering bases were added to bound handles when the binds were recorded; handles read from uniform
      // data (slotHandle) take the bases of the pools set here
      case O.OP_SET_TEX_POOL: { const b = dpoolBase(load<u64>(a), true); if (b != texBase) { texBase = b; dirty |= D_TEX; } break; }
      case O.OP_SET_SAMP_POOL: { const b = dpoolBase(load<u64>(a), false); if (b != sampBase) { sampBase = b; dirty |= D_TEX; } break; }
      case O.OP_COPY_B2T: copyB2T(a, size); break;
      case O.OP_COPY_T2T: copyT2T(a); break;
      case O.OP_COPY_T2B: copyT2B(a, size); break;
      case O.OP_COPY_B2B: memWrite(<usize>load<u64>(a, 8), <usize>load<u64>(a), <usize>load<u64>(a, 16)); break;
      case O.OP_UPDATE_UB: memWrite(<usize>load<u64>(a), a + 16, <usize>load<u64>(a, 8)); break;
      case O.OP_FENCE_SYNC: { const s = <usize>load<u64>(a); passBreak(); emitFence(s); break; }
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
  for (let i = 0; i < n; i++) { const h = <usize>load<u64>(handles + (<usize>i << 3)); if (h) exec(h, 0); }
  passEvent(GfxPassE.Submit);
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
