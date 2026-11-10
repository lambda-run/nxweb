// The recording side of a command buffer: the port of nxnative hle_nvn.c (cmd_alloc_keep, cmd_new_segment, host-lent
// segments, the NVN commands of this pass). Every NVN call appends one record to the command memory the game gave
// (nvnCommandBufferAddCommandMemory); the handle of a recording is the address of its first record. Record layouts and
// sizes are nxnative's (obj.ts): games size command memory by what GetCommandMemoryUsed reports.
import * as L from "./log";
import { Inst } from "../kit/machine";
import { GFX_CMDBUF, GfxCmdbufE, GfxCmdbufS } from "../kit/gen/tables";
import * as O from "./obj";
import { dpoolBase } from "./tables";
import { arenaAlloc } from "./arena";

// @ts-ignore: decorator
@external("env", "gfx_guest_call")
declare function guestCall(fn: u64, x0: u64, x1: u64, x2: u64, x3: u64): u64;

let cmdSeq: u32 = 0;
// @ts-ignore: decorator
@inline function inst(c: usize): Inst { return Inst.at(c + O.CMD_inst); }

export function cmdInitialize(c: usize, dev: u64): u64 {
  memory.fill(c, 0, O.CMD_SIZE);
  store<u32>(c, O.MAGIC_CMD, O.CMD_magic); store<u64>(c, dev, O.CMD_dev);
  inst(c).init(GFX_CMDBUF, ++cmdSeq);
  return 1;
}

// ---- host-lent segments (hle_nvn.c hostseg_*): command memory the host lends when the game's own runs short ----
// The records here may be larger than the hardware's commands, so a game that budgets for the hardware can run out
// without being wrong; its callback may also add nothing (an empty pool). A segment hangs off one recording through
// the JUMP at the end of that recording's guest bytes and is taken back when the game gives those bytes out again.
const HOSTSEG_SZ: usize = 256 << 10;
const HOSTSEG_SMALL: usize = 4 << 10;
const ARENA_SIZE: usize = 8 << 20;
let ARENA: usize = 0;
export function cmdInit(): void { ARENA = arenaAlloc(ARENA_SIZE); }
const NSEG: i32 = 512;
const SEG: usize = memory.data(16384);       // { u32 mem, u32 n, u32 busy, u32 pad, u64 org_lo, u64 org_hi } x NSEG
let nseg: i32 = 0;
let arenaUsed: usize = 0;
let lent: u32 = 0;
export function hostSegsLent(): u32 { return lent; }
export function hostSegRange(lo: usize, hi: usize): bool { return lo >= ARENA && hi <= ARENA + ARENA_SIZE; }

function hostsegSize(c: usize, emptyPool: bool, want: usize): usize {
  if (emptyPool) return want && want <= HOSTSEG_SMALL && inst(c).state == GfxCmdbufS.Idle ? HOSTSEG_SMALL : HOSTSEG_SZ;
  return want + 16 > HOSTSEG_SZ ? (want + 16 + 0xfff) & ~<usize>0xfff : HOSTSEG_SZ;
}
function hostsegTake(c: usize, n: usize): usize {
  const cur = <usize>load<u64>(c, O.CMD_cur), end = <usize>load<u64>(c, O.CMD_end), begin = <usize>load<u64>(c, O.CMD_begin);
  let lo: u64 = 0, hi: u64 = 0, inSeg = false;
  for (let i = 0; i < nseg && cur; i++) {
    const s = SEG + <usize>i * 32, m = <usize>load<u32>(s);
    if (cur >= m && end == m + <usize>load<u32>(s, 4)) { lo = load<u64>(s, 16); hi = load<u64>(s, 24); inSeg = true; break; }
  }
  const st = inst(c).state;
  if (!inSeg && st != GfxCmdbufS.Idle && cur) { lo = st == GfxCmdbufS.Recording && begin && begin <= cur ? begin : cur; hi = <u64>cur + 16; }
  let m: usize = 0;
  for (let i = 0; i < nseg && !m; i++) {
    const s = SEG + <usize>i * 32;
    if (!load<u32>(s, 8) && <usize>load<u32>(s, 4) == n) { m = load<u32>(s); store<u32>(s, 1, 8); store<u64>(s, lo, 16); store<u64>(s, hi, 24); }
  }
  if (!m && nseg < NSEG && arenaUsed + n <= ARENA_SIZE) {
    m = ARENA + arenaUsed; arenaUsed += n;
    const s = SEG + <usize>nseg * 32; nseg++;
    store<u32>(s, <u32>m); store<u32>(s, <u32>n, 4); store<u32>(s, 1, 8); store<u64>(s, lo, 16); store<u64>(s, hi, 24);
  }
  if (!m) { L.redLine("NVN command memory: the game's pool is empty and the host's lent segments (8 MB) are all in use"); unreachable(); }
  if (!lent++) { L.begin("[nvn] the game's command memory ran short, the host lends a segment of "); L.u(n >> 10); L.str(" KB"); L.end(); }
  return m;
}
function hostsegRelease(lo: u64, hi: u64): void {
  for (let i = 0; i < nseg; i++) {
    const s = SEG + <usize>i * 32;
    if (load<u32>(s, 8) && load<u64>(s, 24) > lo && load<u64>(s, 16) < hi) store<u32>(s, 0, 8);
  }
}

// A new segment: a recording that already has records is linked to it by a JUMP at the old write position
function newSegment(c: usize, mem: usize, n: usize): void {
  const start = (mem + 7) & ~<usize>7, cur = <usize>load<u64>(c, O.CMD_cur);
  if (inst(c).state == GfxCmdbufS.Recording && cur) {
    store<u32>(cur, O.OP_JUMP); store<u32>(cur, 16, 4); store<u64>(cur, start, 8);
    store<u64>(c, load<u64>(c, O.CMD_used) + 16, O.CMD_used);
  }
  store<u64>(c, start, O.CMD_cur); store<u64>(c, mem + n, O.CMD_end);
}

export function addCommandMemory(c: usize, pool: usize, off: i64, n: u64): void {
  if (pool) store<u64>(c, n, O.CMD_cmd_size);
  if (!pool || n < 64) { const sz = hostsegSize(c, !pool, <usize>n); newSegment(c, hostsegTake(c, sz), sz); return; }
  const mem = load<u64>(pool, O.POOL_mem);
  if (!mem) { L.redLine("AddCommandMemory: pool has no CPU storage"); return; }
  hostsegRelease(mem + off, mem + off + n);
  newSegment(c, <usize>(mem + off), <usize>n);
  store<u64>(c, 0, O.CMD_used);
}

// Space for one record of `size` bytes, keeping `keep` bytes after it (OP_RESERVE; 0 for the END). When the segment
// is full the game's callback is asked for more, twice at most; then (or with no callback) the host lends a segment
function allocKeep(c: usize, size: u32, keep: u32): usize {
  size = (size + 7) & ~7;
  for (let tries = 0; ; tries++) {
    const cur = load<u64>(c, O.CMD_cur);
    if (cur && cur + size + keep <= load<u64>(c, O.CMD_end)) break;
    const cb = load<u64>(c, O.CMD_cb);
    if (!cb || tries == 2) { const sz = hostsegSize(c, false, size + keep); newSegment(c, hostsegTake(c, sz), sz); break; }
    guestCall(cb, c, 0 /* OUT_OF_COMMAND_MEMORY */, size + keep, load<u64>(c, O.CMD_cb_data));
  }
  const p = <usize>load<u64>(c, O.CMD_cur);
  store<u64>(c, p + size, O.CMD_cur); store<u64>(c, load<u64>(c, O.CMD_used) + size, O.CMD_used);
  store<u32>(p, 0); store<u32>(p, size, 4);
  if (inst(c).state == GfxCmdbufS.Begun) store<u64>(c, p, O.CMD_begin);   // the recording's first record is its handle
  return p;
}

export function beginRecording(c: usize): void {
  const m = inst(c);
  if (m.state != GfxCmdbufS.Idle) { L.redLine("BeginRecording re-entered"); m.step(GfxCmdbufE.Restart); }
  else m.step(GfxCmdbufE.Begin);
}
export function endRecording(c: usize): u64 {
  const m = inst(c);
  if (!m.can(GfxCmdbufE.End)) { m.step(GfxCmdbufE.End); return 0; }       // refused: EndRecording without BeginRecording
  const p = allocKeep(c, 8, 0);
  store<u32>(p, O.OP_END);
  m.step(GfxCmdbufE.End);
  return load<u64>(c, O.CMD_begin);
}
export function isRecording(c: usize): bool { return inst(c).state != GfxCmdbufS.Idle; }
export function memoryUsed(c: usize): u64 { return load<u64>(c, O.CMD_begin) ? load<u64>(c, O.CMD_used) : 0; }
export function memoryFree(c: usize): u64 { const cur = load<u64>(c, O.CMD_cur), end = load<u64>(c, O.CMD_end); return cur && end > cur ? end - cur : 0; }

// One record with `payload` bytes after its header, zeroed; the result is the payload. 0 when the command buffer is
// not recording: the kit refuses Record in Idle with a red line and the command is dropped.
// DEPARTS: nxnative writes such a record anyway, where it belongs to no handle
function rec(c: usize, op: u32, payload: usize): usize {
  const m = inst(c);
  if (!m.can(GfxCmdbufE.Record)) { m.step(GfxCmdbufE.Record); return 0; }
  const sz = (<u32>payload + 15) & ~7;
  const p = allocKeep(c, sz, O.OP_RESERVE);
  m.step(GfxCmdbufE.Record);
  store<u32>(p, op);
  memory.fill(p + 8, 0, sz - 8);
  return p + 8;
}
// @ts-ignore: decorator
@inline function snapOff(n: usize): usize { return (n + 7) & ~<usize>7; }
// Records with textures carry a snapshot of each texture object after the record: a command no longer depends on the
// API object once recorded (the game may finalize or reuse it before submitting). The result is what the record's
// pointer field holds: the snapshot, or the object itself when it is not a live texture at recording (read at submit)
function texSnap(r: usize, off: usize, k: i32, t: usize): u64 {
  if (!t) return 0;
  const s = r + off + <usize>k * O.TEX_SIZE;
  memory.copy(s, t, O.TEX_SIZE);
  if (load<u32>(s) != O.MAGIC_TEX) { L.red("texture object invalid while recording (uninitialized or already finalized): "); L.hex(t); L.str(" index "); L.i(k); L.str("; read again at submit"); L.end(); return t; }
  return s;
}
function copyView(dst: usize, has: usize, v: usize): void { store<u8>(has, v ? 1 : 0); if (v) memory.copy(dst, v, O.VIEW_SIZE); }

export function callCommands(c: usize, n: i32, h: usize): void {
  for (let i = 0; i < n; i++) { const p = rec(c, O.OP_CALL, 8); if (p) store<u64>(p, load<u64>(h + (<usize>i << 3))); }
}
export function setRenderTargets(c: usize, n: i32, ct: usize, cv: usize, dt: usize, dv: usize): void {
  if (n < 0 || n > 8) { L.red("SetRenderTargets count "); L.i(n); L.end(); n = n < 0 ? 0 : 8; }
  const r = rec(c, O.OP_SET_RT, O.P_SET_RT_SIZE + <usize>(n + 1) * O.TEX_SIZE);
  if (!r) return;
  store<i32>(r, n, O.P_SET_RT_n);
  for (let i = 0; i < n; i++) {
    store<u64>(r + O.P_SET_RT_color + (<usize>i << 3), ct ? texSnap(r, O.P_SET_RT_SIZE, i, <usize>load<u64>(ct + (<usize>i << 3))) : 0);
    copyView(r + O.P_SET_RT_cview + <usize>i * O.VIEW_SIZE, r + O.P_SET_RT_has_cview + <usize>i, cv ? <usize>load<u64>(cv + (<usize>i << 3)) : 0);
  }
  store<u64>(r, texSnap(r, O.P_SET_RT_SIZE, n, dt), O.P_SET_RT_depth);
  copyView(r + O.P_SET_RT_dview, r + O.P_SET_RT_has_dview, dv);
}
// kind 0: floats at rgba, 1: i32, 2: u32 (recorded as floats, as nxnative)
export function clearColor(c: usize, index: i32, rgba: usize, mask: i32, kind: i32): void {
  const r = rec(c, O.OP_CLEAR_COLOR, O.P_CLEAR_COLOR_SIZE);
  if (!r) return;
  store<i32>(r, index, O.P_CLEAR_COLOR_index); store<i32>(r, mask, O.P_CLEAR_COLOR_mask);
  for (let i: usize = 0; i < 4; i++)
    store<f32>(r + O.P_CLEAR_COLOR_rgba + (i << 2), kind == 0 ? load<f32>(rgba + (i << 2)) : kind == 1 ? <f32>load<i32>(rgba + (i << 2)) : <f32>load<u32>(rgba + (i << 2)));
}
export function clearDepthStencil(c: usize, depth: f32, dmask: u32, stencil: i32, smask: i32): void {
  const r = rec(c, O.OP_CLEAR_DS, O.P_CLEAR_DS_SIZE);
  if (!r) return;
  store<f32>(r, depth); store<i32>(r, dmask & 0xff, 4); store<i32>(r, stencil, 8); store<i32>(r, smask, 12);
}
export function setViewports(c: usize, first: i32, n: i32, v: usize): void {
  if (n < 0 || first < 0 || first + n > 16) { L.red("SetViewports first="); L.i(first); L.str(" n="); L.i(n); L.end(); return; }
  const r = rec(c, O.OP_VIEWPORTS, O.P_VIEWPORTS_SIZE);
  if (!r) return;
  store<i32>(r, first); store<i32>(r, n, 4);
  for (let i = 0; i < n; i++) memory.copy(r + O.P_VIEWPORTS_v + <usize>i * 24, v + <usize>i * 16, 16);
}
export function setViewport(c: usize, x: i32, y: i32, w: i32, h: i32): void {
  const r = rec(c, O.OP_VIEWPORTS, O.P_VIEWPORTS_SIZE);
  if (!r) return;
  store<i32>(r, 0); store<i32>(r, 1, 4);
  store<f32>(r, <f32>x, 8); store<f32>(r, <f32>y, 12); store<f32>(r, <f32>w, 16); store<f32>(r, <f32>h, 20);
}
export function setScissor(c: usize, x: i32, y: i32, w: i32, h: i32): void {
  const r = rec(c, O.OP_SCISSOR, O.P_SCISSOR_SIZE);
  if (r) { store<i32>(r, x); store<i32>(r, y, 4); store<i32>(r, w, 8); store<i32>(r, h, 12); }
}
export function setDepthRange(c: usize, n: f32, f: f32): void { const r = rec(c, O.OP_DEPTH_RANGE, O.P_DEPTH_RANGE_SIZE); if (r) { store<f32>(r, n); store<f32>(r, f, 4); } }
export function bindProgram(c: usize, prog: u64, stages: i32): void { const r = rec(c, O.OP_BIND_PROGRAM, O.P_BIND_PROGRAM_SIZE); if (r) { store<u64>(r, prog); store<i32>(r, stages, 8); } }
// kind: 0 blend 1 color 2 channel mask 3 multisample 4 polygon 5 depth-stencil; only the state's own bytes are recorded
export function bindState(c: usize, kind: i32, st: usize, n: usize): void {
  const r = rec(c, O.OP_BIND_STATE, O.P_BIND_STATE_bytes + n);
  if (r) { store<i32>(r, kind); memory.copy(r + O.P_BIND_STATE_bytes, st, n); }
}
export function bindVertexAttribState(c: usize, n: i32, st: usize): void {
  if (n < 0 || n > 32) { L.red("BindVertexAttribState n="); L.i(n); L.end(); return; }
  const r = rec(c, O.OP_BIND_VATTR, O.P_BIND_VATTR_st + (<usize>n << 2));
  if (r) { store<i32>(r, 0); store<i32>(r, n, 4); memory.copy(r + O.P_BIND_VATTR_st, st, <usize>n << 2); }
}
export function bindVertexStreamState(c: usize, n: i32, st: usize): void {
  if (n < 0 || n > 16) { L.red("BindVertexStreamState n="); L.i(n); L.end(); return; }
  const r = rec(c, O.OP_BIND_VSTREAM, O.P_BIND_VSTREAM_st + (<usize>n << 3));
  if (r) { store<i32>(r, 0); store<i32>(r, n, 4); memory.copy(r + O.P_BIND_VSTREAM_st, st, <usize>n << 3); }
}
// rg: NVNbufferRange { u64 address, u64 size } x n
export function bindVertexBuffers(c: usize, first: i32, n: i32, rg: usize): void {
  if (first >= 16 && n == 1 && !load<u64>(rg) && !load<u64>(rg, 8)) return;
  if (n < 0 || first < 0 || first + n > 16) { L.red("BindVertexBuffers first="); L.i(first); L.str(" n="); L.i(n); L.end(); return; }
  if (n == 1 && load<u64>(rg, 8) <= 0xffffffff) {
    const r = rec(c, O.OP_BIND_VBUF1, O.P_BIND_VBUF1_SIZE);
    if (r) { store<u32>(r, first); store<u32>(r, <u32>load<u64>(rg, 8), 4); store<u64>(r, load<u64>(rg), 8); }
    return;
  }
  const r = rec(c, O.OP_BIND_VBUF, O.P_BIND_VBUF_r + (<usize>n << 4));
  if (r) { store<i32>(r, first); store<i32>(r, n, 4); memory.copy(r + O.P_BIND_VBUF_r, rg, <usize>n << 4); }
}
// Tessellation stages arrive as 6 / 7 in some SDKs' numbering
// @ts-ignore: decorator
@inline function stHost(st: i32): i32 { return st == 6 ? 3 : st == 7 ? 4 : st; }
export function bindUniformBuffer(c: usize, st: i32, i: i32, addr: u64, n: u64): void {
  st = stHost(st);
  if (<u32>st < 6 && <u32>i < 16 && n <= 0xffffffff) {
    const r = rec(c, O.OP_BIND_UBO_SMALL, O.P_BIND_UBO_SMALL_SIZE);
    if (r) { store<u16>(r, <u16>st); store<u16>(r, <u16>i, 2); store<u32>(r, <u32>n, 4); store<u64>(r, addr, 8); }
    return;
  }
  const r = rec(c, O.OP_BIND_UBO, O.P_BIND_BUF_SIZE);
  if (r) { store<i32>(r, st); store<i32>(r, i, 4); store<u64>(r, addr, 8); store<u64>(r, n, 16); }
}
// One combined handle (texture ID | sampler ID << 20): the handle 16 bytes into the record, as the hardware's command
export function bindTexture(c: usize, st: i32, slot: i32, h: u64): void {
  st = stHost(st);
  const tb = load<i32>(c, O.CMD_tex_base), sb = load<i32>(c, O.CMD_samp_base);
  if (tb || sb) {
    const r = rec(c, O.OP_BIND_TEX1, O.P_BIND_TEX1_SIZE);
    if (r) { store<i32>(r, st); store<i32>(r, slot, 4); store<u64>(r, h, 8); store<i32>(r, tb, 16); store<i32>(r, sb, 20); }
    return;
  }
  const r = rec(c, O.OP_BIND_TEX1, O.P_BIND_TEX1_tbase);
  if (r) { store<i32>(r, st | O.BIND_TEX1_NOBASE); store<i32>(r, slot, 4); store<u64>(r, h, 8); }
}
export function bindTextures(c: usize, st: i32, first: i32, n: i32, h: usize): void {
  st = stHost(st);
  if (n < 0 || n > 32) { L.red("bind handle count "); L.i(n); L.end(); return; }
  const r = rec(c, O.OP_BIND_TEX, O.P_BIND_HANDLES_h + (<usize>n << 3));
  if (!r) return;
  store<i32>(r, st); store<i32>(r, first, 4); store<i32>(r, n, 8);
  const tb = <u64>load<i32>(c, O.CMD_tex_base), sb = <u64>load<i32>(c, O.CMD_samp_base);
  for (let i = 0; i < n; i++) {
    const v = <u64>load<u32>(h + (<usize>i << 3));
    let tid = v & 0xfffff, sid = v >> 20;
    if (tid) tid += tb;
    if (sid) sid += sb;
    store<u64>(r + O.P_BIND_HANDLES_h + (<usize>i << 3), tid | sid << 20);
  }
}
// which: 0 value mask, 1 write mask, 2 reference
export function setStencil(c: usize, face: i32, v: i32, which: i32): void {
  const r = rec(c, O.OP_STENCIL, O.P_STENCIL_SIZE);
  if (r) { store<i32>(r, face); store<i32>(r + 4 + (<usize>which << 2), v); store<i32>(r, which, 16); }
}
export function setPolygonOffsetClamp(c: usize, factor: f32, units: f32, clamp: f32): void {
  const r = rec(c, O.OP_POLY_OFFSET, O.P_POLY_OFFSET_SIZE);
  if (r) { store<f32>(r, factor); store<f32>(r, units, 4); store<f32>(r, clamp, 8); }
}
export function setBlendColor(c: usize, v: usize): void { const r = rec(c, O.OP_BLEND_COLOR, O.P_BLEND_COLOR_SIZE); if (r) memory.copy(r, v, 16); }
// A plain draw record stops before `ind`: 0x20 bytes for arrays, 0x28 for elements, with the header
export function drawArrays(c: usize, prim: i32, first: i32, n: i32, baseInstance: i32, instances: i32): void {
  const r = rec(c, O.OP_DRAW, O.P_DRAW_ind);
  if (r) { store<i32>(r, prim); store<i32>(r, first, 4); store<i32>(r, n, 8); store<i32>(r, instances, 12); store<i32>(r, baseInstance, 16); }
}
export function drawElements(c: usize, prim: i32, itype: i32, n: i32, ibuf: u64, baseVertex: i32, baseInstance: i32, instances: i32): void {
  const r = rec(c, O.OP_DRAW_IDX, O.P_DRAW_IDX_ind);
  if (r) { store<i32>(r, prim); store<i32>(r, itype, 4); store<i32>(r, n, 8); store<i32>(r, baseVertex, 12); store<i32>(r, baseInstance, 16); store<i32>(r, instances, 20); store<u64>(r, ibuf, 24); }
}
export function barrier(c: usize, bits: i32): void { const r = rec(c, O.OP_BARRIER, 8); if (r) store<i32>(r, bits); }
export function setPool(c: usize, pool: u64, tex: bool): void {
  const r = rec(c, tex ? O.OP_SET_TEX_POOL : O.OP_SET_SAMP_POOL, O.P_SET_POOL_SIZE);
  if (r) store<u64>(r, pool);
  store<i32>(c + (tex ? O.CMD_tex_base : O.CMD_samp_base), dpoolBase(pool, tex));
}
// The copy strides are command buffer state, written into the record only when one is set (SetCopyRowStride takes
// no command memory)
function recCopy(c: usize, op: u32): usize {
  const row = load<i64>(c, O.CMD_copy_row), img = load<i64>(c, O.CMD_copy_image), st = row != 0 || img != 0;
  const r = rec(c, op, O.COPY_STRIDES_OFF + (st ? O.P_COPY_STRIDES_SIZE : 0));
  if (r && st) { store<i64>(r, row, O.COPY_STRIDES_OFF); store<i64>(r, img, O.COPY_STRIDES_OFF + 8); }
  return r;
}
// toBuffer: CopyTextureToBuffer (the same record; src is the destination address)
export function copyBufferTexture(c: usize, addr: u64, t: usize, v: usize, region: usize, flags: i32, toBuffer: bool): void {
  const r = recCopy(c, toBuffer ? O.OP_COPY_T2B : O.OP_COPY_B2T);
  if (!r) return;
  store<u64>(r, addr, O.P_COPY_B2T_src);
  store<u64>(r, texSnap(r, snapOff(O.P_COPY_B2T_SIZE), 0, t), O.P_COPY_B2T_tex);
  copyView(r + O.P_COPY_B2T_view, r + O.P_COPY_B2T_has_view, v);
  memory.copy(r + O.P_COPY_B2T_r, region, 24); store<i32>(r, flags, O.P_COPY_B2T_flags);
}
export function copyTextureToTexture(c: usize, s: usize, sv: usize, sr: usize, d: usize, dv: usize, dr: usize, flags: i32): void {
  const r = rec(c, O.OP_COPY_T2T, snapOff(O.P_COPY_T2T_SIZE) + 2 * O.TEX_SIZE);
  if (!r) return;
  store<u64>(r, texSnap(r, snapOff(O.P_COPY_T2T_SIZE), 0, s), O.P_COPY_T2T_src);
  store<u64>(r, texSnap(r, snapOff(O.P_COPY_T2T_SIZE), 1, d), O.P_COPY_T2T_dst);
  copyView(r + O.P_COPY_T2T_sv, r + O.P_COPY_T2T_has_sv, sv); copyView(r + O.P_COPY_T2T_dv, r + O.P_COPY_T2T_has_dv, dv);
  memory.copy(r + O.P_COPY_T2T_sr, sr, 24); memory.copy(r + O.P_COPY_T2T_dr, dr, 24); store<i32>(r, flags, O.P_COPY_T2T_flags);
}
export function copyBufferToBuffer(c: usize, src: u64, dst: u64, n: u64): void {
  const r = rec(c, O.OP_COPY_B2B, 24);
  if (r) { store<u64>(r, src); store<u64>(r, dst, 8); store<u64>(r, n, 16); }
}
// The data is copied into command memory at record time (the caller may change the original afterwards)
export function updateUniformBuffer(c: usize, buf: u64, off: i64, n: u64, data: usize): void {
  const r = rec(c, O.OP_UPDATE_UB, 16 + <usize>n);
  if (r) { store<u64>(r, buf + off); store<u64>(r, n, 8); memory.copy(r + 16, data, <usize>n); }
}
export function fenceSync(c: usize, sync: u64): void { const r = rec(c, O.OP_FENCE_SYNC, 8); if (r) store<u64>(r, sync); }
// Indirect draws carry the address of their arguments (read at submit); cnt / i: draw i of a multi-draw with a count in memory
export function drawArraysIndirect(c: usize, prim: i32, ind: u64, cnt: u64, i: i32): void {
  const r = rec(c, O.OP_DRAW, O.P_DRAW_SIZE);
  if (r) { store<i32>(r, prim); store<i32>(r, 1, 12); store<u64>(r, ind, O.P_DRAW_ind); store<u64>(r, cnt, O.P_DRAW_ind + 8); store<i32>(r, i, O.P_DRAW_ind + 16); }
}
export function drawElementsIndirect(c: usize, prim: i32, itype: i32, ibuf: u64, ind: u64, cnt: u64, i: i32): void {
  const r = rec(c, O.OP_DRAW_IDX, O.P_DRAW_IDX_SIZE);
  if (r) { store<i32>(r, prim); store<i32>(r, itype, 4); store<i32>(r, 1, 20); store<u64>(r, ibuf, 24); store<u64>(r, ind, O.P_DRAW_IDX_ind); store<u64>(r, cnt, O.P_DRAW_IDX_ind + 8); store<i32>(r, i, O.P_DRAW_IDX_ind + 16); }
}
