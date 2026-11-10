// Texture content from guest memory.
// A texture's storage is a range of a memory pool. Unless the texture is linear, it is in the Tegra X1's block-linear
// layout (texlayout.ts): 64x8-byte GOBs, 16-byte runs in Z order inside a GOB, GOBs stacked into blocks of 2^tileH
// rows and 2^tileD slices. blMove is the port of nxnative dm/gfx/tex/nvn_deswizzle.c (both directions).
// The replayer gets texels as linear rows (H_TEX_DATA): deswizzled into a scratch area band by band, or straight from
// guest memory for linear textures.
//
// When to upload (machine gfx_texture, docs/machines/gfx_texture.md). nxnative write-protects texture pages and
// re-uploads on a fault; a wasm module cannot. Instead, at the first use of a texture in a submission:
//   Unknown   -> upload everything, remember the full hash and the sampled hash
//   Uploaded  -> take the sampled hash again (16 probes of 64 bytes, the whole storage when it is under 1 KB).
//                Different: upload again. Same: take the full hash too when the game flushed a mapped range over the
//                storage since the last submission, or when SCRUB_PERIOD submissions passed since its last full hash
//                and this submission's SCRUB_BUDGET allows; different: upload again
//   GpuOwned  -> nothing: a pass, copy or clear wrote it
// Failure modes, by design: (1) a CPU write that changes none of the probed bytes and is not followed by
// FlushMappedRange is seen up to SCRUB_PERIOD submissions late, later when more textures are due than the budget
// covers; (2) a CPU write into the storage of a GpuOwned texture is never seen (nvnTextureWriteTexels is: it goes to
// the replayer directly); (3) a texture changed while a submission that already used it is being lowered keeps the old
// content for that submission; (4) two textures over the same storage are tracked separately.
import * as L from "./log";
import { Inst } from "../kit/machine";
import { GFX_TEXTURE, GfxTextureE, GfxTextureS } from "../kit/gen/tables";
import * as O from "./obj";
import * as H from "./hostops";
import { texEntry, texSlot, TEX_SLOTS, TE_inst, TE_mem, TE_size, TE_desc, TE_full, TE_last_full, TE_checked } from "./tables";
import { texGeom, texLayers, texSize, fmtOf, fBpb, fBw, fBh, gRowBytes, gRows, gSlices, gTh, gTd, gBase, gGobs, gBw, gBh, gBpb } from "./texlayout";
import { arenaAlloc } from "./arena";
import { fmtXform, unpack16, toHalf, X_NONE, X_D16, X_D24, X_D32F, X_D24S8, X_D32FS8, X_S8, X_PACKED, X_NORM16, X_SNORM16, X_ASTC } from "./fmt";
import { astcRows } from "./astc";

const SCRATCH_BYTES: usize = 4 << 20;
const OUT_BYTES: usize = 6 << 20;        // converted rows (depth as floats, decoded ASTC, unpacked 16-bit texels)
let SCRATCH: usize = 0, OUT: usize = 0;
export function texContentInit(): void { SCRATCH = arenaAlloc(SCRATCH_BYTES); OUT = arenaAlloc(OUT_BYTES); }
const SCRUB_PERIOD: u32 = 60;
const SCRUB_BUDGET: u64 = 1 << 20;

let submitNo: u32 = 1;
let scrubLeft: u64 = SCRUB_BUDGET;
let nUploads: u32 = 0, nUploadBytes: u64 = 0, nSampled: u32 = 0, nFull: u32 = 0, nStale: u32 = 0;
export function texStat(i: i32): u32 { return i == 0 ? nUploads : i == 1 ? <u32>(nUploadBytes >> 10) : i == 2 ? nSampled : i == 3 ? nFull : nStale; }

// Ranges the game flushed (nvnMemoryPoolFlushMappedRange / nvnBufferFlushMappedRange) since the last submission
const FLUSHED: usize = memory.data(256); let nFlushed: i32 = 0, flushedAll = false;
export function noteFlush(lo: u64, n: u64): void {
  if (!n) return;
  if (nFlushed == 16) { flushedAll = true; return; }
  store<u64>(FLUSHED + (<usize>nFlushed << 4), lo); store<u64>(FLUSHED + (<usize>nFlushed << 4), lo + n, 8); nFlushed++;
}
function flushedOver(lo: u64, hi: u64): bool {
  if (flushedAll) return true;
  for (let i = 0; i < nFlushed; i++) if (load<u64>(FLUSHED + (<usize>i << 4)) < hi && load<u64>(FLUSHED + (<usize>i << 4), 8) > lo) return true;
  return false;
}
export function submitDone(): void { submitNo++; scrubLeft = SCRUB_BUDGET; nFlushed = 0; flushedAll = false; }

const KOX: usize = memory.data<u16>([0, 32, 256, 288]);
const KOY: usize = memory.data<u16>([0, 16, 64, 80, 128, 144, 192, 208]);
// Rows y0..y1 (block rows) of every slice of one level and layer between block-linear storage `bl` (the texture's
// storage start) and linear rows at `lin` (slice z, row y at ((z * (y1 - y0)) + y - y0) * pitch). texGeom was called
function blMove(bl: usize, lin: usize, pitch: usize, toLinear: bool, y0: u32, y1: u32): void {
  bl += <usize>gBase;
  let lb = gGobs * 64; if (lb < gRowBytes) lb = gRowBytes;
  const th = gTh, td = gTd, bh: u32 = 1 << th, bd: u32 = 1 << td;
  const block: usize = <usize>512 * bh * bd, gobsX: usize = (lb + 63) >> 6, blocksY: usize = (gRows + 8 * bh - 1) >> (3 + th);
  const nfull = gRowBytes >> 4, tail: usize = gRowBytes & 15;
  for (let z: u32 = 0; z < gSlices; z++) {
    const zb = <usize>(z >> td) * gobsX * blocksY * block + <usize>(z & (bd - 1)) * bh * 512;
    for (let y = y0; y < y1; y++) {
      const yb = bl + zb + <usize>(y >> (3 + th)) * gobsX * block + <usize>((y & (8 * bh - 1)) >> 3) * 512 + <usize>load<u16>(KOY + (<usize>(y & 7) << 1));
      const row = lin + (<usize>z * (y1 - y0) + (y - y0)) * pitch;
      for (let j: u32 = 0; j <= nfull; j++) {
        const n: usize = j < nfull ? 16 : tail;
        if (!n) break;
        const s = yb + <usize>(j >> 2) * block + <usize>load<u16>(KOX + (<usize>(j & 3) << 1));
        if (toLinear) memory.copy(row + (<usize>j << 4), s, n); else memory.copy(s, row + (<usize>j << 4), n);
      }
    }
  }
}
// nvn_deswizzle / nvn_swizzle of a whole level and layer (tests, and what a tool would call). -1 when the texture has no block-linear storage
export function deswizzle(d: usize, level: u32, layer: u32, storage: usize, lin: usize, pitch: usize, toLinear: bool): i32 {
  if (!texGeom(d, level, layer) || pitch < gRowBytes) return -1;
  blMove(storage, lin, pitch, toLinear, 0, gRows);
  return 0;
}

export function hashFull(p: usize, n: usize): u64 {
  let h: u64 = 0x9E3779B97F4A7C15 ^ n, i: usize = 0;
  for (; i + 8 <= n; i += 8) { h = (h ^ load<u64>(p + i)) * 0x9E3779B97F4A7C15; h ^= h >> 29; }
  for (; i < n; i++) { h = (h ^ load<u8>(p + i)) * 0x9E3779B97F4A7C15; h ^= h >> 29; }
  nFull++;
  return h;
}
function hashSample(p: usize, n: usize): u64 {
  nSampled++;
  if (n <= 1024) { let h: u64 = n; for (let i: usize = 0; i + 8 <= n; i += 8) { h = (h ^ load<u64>(p + i)) * 0x9E3779B97F4A7C15; h ^= h >> 29; } return h; }
  let h: u64 = n;
  const step = (n - 64) / 15;
  for (let k: usize = 0; k < 16; k++) {
    const q = p + ((k * step) & ~<usize>7);
    for (let i: usize = 0; i < 64; i += 8) { h = (h ^ load<u64>(q + i)) * 0x9E3779B97F4A7C15; h ^= h >> 29; }
  }
  return h;
}

// H_TEX_DATA: +8 u64 serial, +16 u32 level, +20 u32 z (layer or first slice), +24 u32 y, +28 u32 width, +32 u32 height (texels, whole blocks),
// +36 u32 slices, +40 u64 address of the rows (the scratch area, or the guest's pool memory itself: anywhere in a 64-bit
// memory), +48 u32 bytes per row, +52 u32 x, +56 u32 what the rows are: 0 texels of the
// host texture's format, 1 depth as f32, 2 stencil as u8 (WebGPU takes depth only through a draw, stencil as its own aspect)
function emitData(serial: u64, level: u32, z: u32, x: u32, y: u32, w: u32, h: u32, slices: u32, ptr: usize, pitch: usize, what: u32 = 0): void {
  const r = H.hostRec(H.H_TEX_DATA, 64);
  store<u64>(r, serial, 8); store<u32>(r, level, 16); store<u32>(r, z, 20); store<u32>(r, y, 24); store<u32>(r, w, 28); store<u32>(r, h, 32); store<u32>(r, slices, 36);
  store<u64>(r, ptr, 40); store<u32>(r, <u32>pitch, 48); store<u32>(r, x, 52); store<u32>(r, what, 56); store<u32>(r, 0, 60);
  nUploadBytes += <u64>pitch * (h / fBh) * slices;
}
// Bytes of OUT one row of nbx blocks takes once converted (0: the format goes as it is stored)
function outRowBytes(f: u32, nbx: u32): usize {
  switch (fmtXform(f)) {
    case X_NONE: return 0;
    case X_PACKED: return <usize>nbx * 4;
    case X_NORM16: case X_SNORM16: return <usize>nbx * fBpb;
    case X_ASTC: return <usize>nbx * fBw * 4 * fBh;
    default: return <usize>nbx * 5;      // depth as f32 and stencil as u8
  }
}
// Rows of blocks (nby rows of nbx blocks for each of `slices`, pitch bytes apart at ptr) of format f to the replayer,
// converted when WebGPU has no such format or cannot be given it directly. fmtOf(f) was called; x, y in texels.
// Memory layouts of the depth formats and the packed 16-bit formats: as nxnative reads them (D24: depth in the upper
// 24 bits, stencil in the low 8; D32F_S8: a float, then a word with the stencil in its low byte; packed: red at bit 0)
function send(serial: u64, f: u32, level: u32, z: u32, x: u32, y: u32, nbx: u32, nby: u32, slices: u32, ptr: usize, pitch: usize): void {
  const k = fmtXform(f), rows = nby * slices;
  if (k == X_NONE) { emitData(serial, level, z, x, y, nbx * fBw, nby * fBh, slices, ptr, pitch); return; }
  if (outRowBytes(f, nbx) * rows > OUT_BYTES) { L.redLine("texels to convert do not fit the conversion area: not uploaded"); return; }
  if (k == X_ASTC) {
    const op: usize = <usize>nbx * fBw * 4;
    astcRows(ptr, pitch, nbx, rows, fBw, fBh, OUT, op, f >= 0x87);
    // slices of an ASTC texture are layers: one record each keeps rows = nby * bh
    emitData(serial, level, z, x, y, nbx * fBw, nby * fBh, slices, OUT, op);
    return;
  }
  if (k == X_PACKED) {
    for (let r: u32 = 0; r < rows; r++) { const s = ptr + <usize>r * pitch, o = OUT + (<usize>r * nbx << 2); for (let i: usize = 0; i < nbx; i++) store<u32>(o + (i << 2), unpack16(f, load<u16>(s + (i << 1)))); }
    emitData(serial, level, z, x, y, nbx, nby, slices, OUT, <usize>nbx << 2);
    return;
  }
  if (k == X_NORM16 || k == X_SNORM16) {
    const n: usize = <usize>nbx * fBpb >> 1;
    for (let r: u32 = 0; r < rows; r++) {
      const s = ptr + <usize>r * pitch, o = OUT + <usize>r * (n << 1);
      if (k == X_NORM16) for (let i: usize = 0; i < n; i++) store<u16>(o + (i << 1), toHalf(<f32>load<u16>(s + (i << 1)) / 65535));
      else for (let i: usize = 0; i < n; i++) store<u16>(o + (i << 1), toHalf(max<f32>(<f32>load<i16>(s + (i << 1)) / 32767, -1)));
    }
    emitData(serial, level, z, x, y, nbx, nby, slices, OUT, n << 1);
    return;
  }
  const so = OUT + (<usize>rows * nbx << 2), hasDepth = k != X_S8, hasStencil = k == X_D24S8 || k == X_D32FS8 || k == X_S8;
  for (let r: u32 = 0; r < rows; r++) {
    const s = ptr + <usize>r * pitch, o = OUT + (<usize>r * nbx << 2), q = so + <usize>r * nbx;
    for (let i: usize = 0; i < nbx; i++) {
      switch (k) {
        case X_D16: store<f32>(o + (i << 2), <f32>load<u16>(s + (i << 1)) / 65535); break;
        case X_D24: store<f32>(o + (i << 2), <f32>(<f64>(load<u32>(s + (i << 2)) >> 8) / 16777215)); break;
        case X_D32F: store<f32>(o + (i << 2), load<f32>(s + (i << 2))); break;
        case X_D24S8: { const v = load<u32>(s + (i << 2)); store<f32>(o + (i << 2), <f32>(<f64>(v >> 8) / 16777215)); store<u8>(q + i, <u8>v); break; }
        case X_D32FS8: store<f32>(o + (i << 2), load<f32>(s + (i << 3))); store<u8>(q + i, load<u8>(s + (i << 3), 4)); break;
        default: store<u8>(q + i, load<u8>(s + i));
      }
    }
  }
  if (hasDepth) emitData(serial, level, z, x, y, nbx, nby, slices, OUT, <usize>nbx << 2, 1);
  if (hasStencil) emitData(serial, level, z, x, y, nbx, nby, slices, so, nbx, 2);
}
// @ts-ignore: decorator
@inline function mipExt(v: u32, l: u32): u32 { v >>= l; return v ? v : 1; }

let redFmt = false, redRange = false;
// Everything in the storage to the replayer. False when there is nothing to upload from
function upload(e: usize): bool {
  const d = e + TE_desc, mem = <usize>load<u64>(e, TE_mem), serial = load<u64>(e), flags = load<i32>(d, O.TD_flags), target = load<i32>(d, O.TD_target);
  if (!mem) return false;
  if (!fmtOf(load<i32>(d, O.TD_format))) { if (!redFmt) { redFmt = true; L.red("texture format 0x"); L.hex(<u32>load<i32>(d, O.TD_format)); L.str(" is unknown: its content is not uploaded"); L.end(); } return false; }
  if (<u64>mem + load<u64>(e, TE_size) > <u64>memory.size() << 16) { if (!redRange) { redRange = true; L.redLine("texture storage reaches outside guest memory: not uploaded"); } return false; }
  if (target == 10 || load<i32>(d, O.TD_samples) > 1) return false;
  nUploads++;
  if (flags & 0x50) {       // linear: rows as they are, the stride from the builder
    const w = load<u32>(d, O.TD_width), h = load<u32>(d, O.TD_height), bw = (w + fBw - 1) / fBw;
    let stride = load<u32>(d, O.TD_stride);
    if (!stride) { const al: u32 = (flags & 0x40) ? 128 : 32; stride = (fBpb * bw + al - 1) & ~(al - 1); }
    const f = <u32>load<i32>(d, O.TD_format), nby = (h + fBh - 1) / fBh, orb = outRowBytes(f, bw);
    const band: u32 = orb ? max<u32>(<u32>(OUT_BYTES / orb), 1) : nby;
    for (let y0: u32 = 0; y0 < nby; y0 += band) { send(serial, f, 0, 0, 0, y0 * fBh, bw, min<u32>(band, nby - y0), 1, mem + <usize>y0 * stride, stride); H.hostFlush(); }
    return true;
  }
  const layers = texLayers(d), levels = max<u32>(load<u32>(d, O.TD_levels), 1);
  for (let layer: u32 = 0; layer < layers; layer++) for (let level: u32 = 0; level < levels; level++) {
    if (!texGeom(d, level, layer)) continue;
    const pitch: usize = (gRowBytes + 3) & ~3, per = pitch * gSlices;
    const f = <u32>load<i32>(d, O.TD_format), nbx = gRowBytes / gBpb, orb = outRowBytes(f, nbx) * gSlices;
    let band = <u32>(SCRATCH_BYTES / per);
    if (orb) band = min<u32>(band, <u32>(OUT_BYTES / orb));
    if (!band) { L.redLine("a texture level's slices do not fit the upload scratch area one row at a time: not uploaded"); continue; }
    for (let y0: u32 = 0; y0 < gRows; y0 += band) {
      const y1 = min<u32>(gRows, y0 + band);
      blMove(mem, SCRATCH, pitch, true, y0, y1);
      send(serial, f, level, target == 2 ? 0 : layer, 0, y0 * gBh, nbx, y1 - y0, gSlices, SCRATCH, pitch);
      H.hostFlush();          // the scratch area is read now
    }
  }
  return true;
}

// @ts-ignore: decorator
@inline function inst(e: usize): Inst { return Inst.at(e + TE_inst); }
export function contentInit(serial: u64, tex: usize): void {
  const e = texEntry(serial);
  if (!e) return;
  inst(e).init(GFX_TEXTURE, <u32>(serial & 0xffff));
  store<u64>(e, load<u64>(tex, O.TEX_mem), TE_mem); store<u64>(e, load<u64>(tex, O.TEX_L + O.TL_size), TE_size);
  memory.copy(e + TE_desc, tex + O.TEX_d, O.TD_SIZE);
}
// A submission is about to read the texture (sample it, copy from it, present it)
export function contentNeed(serial: u64): void {
  const e = texEntry(serial);
  if (!e) return;
  const m = inst(e), mem = <usize>load<u64>(e, TE_mem), size = <usize>load<u64>(e, TE_size);
  if (m.state == GfxTextureS.GpuOwned || (load<u32>(e, TE_checked) == submitNo && m.state != GfxTextureS.Staged)) return;
  store<u32>(e, submitNo, TE_checked);
  if (m.state == GfxTextureS.Uploaded) {
    let changed = hashSample(mem, size) != m.data;
    if (!changed) {
      const due = submitNo - load<u32>(e, TE_last_full) >= SCRUB_PERIOD && scrubLeft >= size;
      if (due || flushedOver(mem, <u64>mem + size)) {
        if (due) scrubLeft -= size;
        store<u32>(e, submitNo, TE_last_full);
        changed = hashFull(mem, size) != load<u64>(e, TE_full);
      }
    }
    if (!changed) return;
    nStale++;
    m.step(GfxTextureE.Stale);
  }
  if (!upload(e)) return;
  store<u64>(e, hashFull(mem, size), TE_full); store<u32>(e, submitNo, TE_last_full);
  m.step(GfxTextureE.Upload, hashSample(mem, size));
}
// The GPU writes the texture (attachment of a pass, destination of a copy, an image a compute shader stores to).
// Texels a command staged in the storage are uploaded first: the write may keep what it does not cover
export function contentGpuWrite(serial: u64): void {
  const e = texEntry(serial);
  if (!e) return;
  if (inst(e).state == GfxTextureS.Staged) upload(e);
  inst(e).step(GfxTextureE.GpuWrite);
}
// Whether this submission already read the texture from its storage (it was uploaded or checked for draws that may not be submitted yet)
export function contentInUse(serial: u64): bool { const e = texEntry(serial); return e != 0 && load<u32>(e, TE_checked) == submitNo && inst(e).state != GfxTextureS.GpuOwned; }
// Texels were written into the storage in stream order (CopyBufferToTexture mirrored, WriteTexels): the next use uploads
export function contentStage(serial: u64): void { const e = texEntry(serial); if (e && inst(e).can(GfxTextureE.Stage)) inst(e).step(GfxTextureE.Stage); }
// The GPU device was lost and replaced (device.ts): every live texture's host copy is gone
export function contentLost(): u32 {
  let gone: u32 = 0;
  for (let s: u32 = 1; s < TEX_SLOTS; s++) {
    const e = texSlot(s);
    if (!load<u64>(e)) continue;
    if (inst(e).state == GfxTextureS.GpuOwned) gone++;
    inst(e).step(GfxTextureE.Lost);
    store<u32>(e, 0, TE_checked);
  }
  return gone;
}
export function contentState(serial: u64): i32 { const e = texEntry(serial); return e ? <i32>inst(e).state : -1; }

// ---- regions between a texture's storage and linear memory: ReadTexels, WriteTexels, CopyTextureToBuffer on the CPU ----
// region: NVNcopyRegion { x, y, z, width, height, depth } in texels; rows of the linear side are `row` bytes apart and
// images `img` (0: tight). False when the texture's storage does not hold its content (GpuOwned) or cannot be addressed
export function regionCopy(tex: usize, level: u32, layer0: u32, region: usize, lin: usize, row: usize, img: usize, toStorage: bool): bool {
  const e = texEntry(load<u64>(tex, O.TEX_serial));
  if (!e) return false;
  const d = e + TE_desc, mem = <usize>load<u64>(e, TE_mem), flags = load<i32>(d, O.TD_flags), is3d = load<i32>(d, O.TD_target) == 2;
  if (!mem || inst(e).state == GfxTextureS.GpuOwned || !fmtOf(load<i32>(d, O.TD_format))) return false;
  const x = load<u32>(region), y = load<u32>(region, 4), z = load<u32>(region, 8), w = load<u32>(region, 12), h = load<u32>(region, 16), dep = max<u32>(load<u32>(region, 20), 1);
  const bx0 = x / fBw, by0 = y / fBh, nbx = (w + fBw - 1) / fBw, nby = (h + fBh - 1) / fBh, bpb = fBpb, wb: usize = nbx * bpb;
  if (!row) row = wb;
  if (!img) img = row * nby;
  if (flags & 0x50) {
    let stride = load<u32>(d, O.TD_stride);
    if (!stride) { const al: u32 = (flags & 0x40) ? 128 : 32; stride = (bpb * ((load<u32>(d, O.TD_width) + fBw - 1) / fBw) + al - 1) & ~(al - 1); }
    for (let r: u32 = 0; r < nby; r++) { const s = mem + <usize>(by0 + r) * stride + <usize>bx0 * bpb, l = lin + <usize>r * row; if (toStorage) memory.copy(s, l, wb); else memory.copy(l, s, wb); }
    return true;
  }
  for (let k: u32 = 0; k < dep; k++) {
    if (!texGeom(d, level, is3d ? 0 : layer0 + z + k)) return false;
    let lb = gGobs * 64; if (lb < gRowBytes) lb = gRowBytes;
    const th = gTh, td = gTd, bh: u32 = 1 << th, bd: u32 = 1 << td, zz: u32 = is3d ? z + k : 0;
    const block: usize = <usize>512 * bh * bd, gobsX: usize = (lb + 63) >> 6, blocksY: usize = (gRows + 8 * bh - 1) >> (3 + th);
    const zb = mem + <usize>gBase + <usize>(zz >> td) * gobsX * blocksY * block + <usize>(zz & (bd - 1)) * bh * 512;
    for (let r: u32 = 0; r < nby && by0 + r < gRows; r++) {
      const yy = by0 + r, yb = zb + <usize>(yy >> (3 + th)) * gobsX * block + <usize>((yy & (8 * bh - 1)) >> 3) * 512 + <usize>load<u16>(KOY + (<usize>(yy & 7) << 1));
      const l = lin + <usize>k * img + <usize>r * row;
      let b: u32 = bx0 * bpb; const bEnd = min<u32>(b + <u32>wb, gRowBytes);
      while (b < bEnd) {       // runs up to the next 16-byte boundary
        const j = b >> 4, n = min<u32>(16 - (b & 15), bEnd - b), s = yb + <usize>(j >> 2) * block + <usize>load<u16>(KOX + (<usize>(j & 3) << 1)) + (b & 15), q = l + (b - bx0 * bpb);
        if (toStorage) memory.copy(s, q, n); else memory.copy(q, s, n);
        b += n;
      }
    }
  }
  return true;
}
// nvnTextureWriteTexels: into the storage when it holds the content (the next use uploads it), straight to the replayer when the GPU owns the texture
export function writeTexels(tex: usize, level: u32, layer0: u32, region: usize, data: usize, row: usize, img: usize): void {
  const e = texEntry(load<u64>(tex, O.TEX_serial));
  if (!e) { L.redLine("WriteTexels on a texture that is not live"); return; }
  if (regionCopy(tex, level, layer0, region, data, row, img, true)) { inst(e).step(GfxTextureE.Stage); return; }
  const d = e + TE_desc;
  if (!fmtOf(load<i32>(d, O.TD_format))) return;
  const w = load<u32>(region, 12), h = load<u32>(region, 16), dep = max<u32>(load<u32>(region, 20), 1), nbx = (w + fBw - 1) / fBw, nby = (h + fBh - 1) / fBh;
  if (!row) row = nbx * fBpb;
  if (!img) img = row * nby;
  const is3d = load<i32>(d, O.TD_target) == 2;
  for (let k: u32 = 0; k < dep; k++) { send(load<u64>(e), <u32>load<i32>(d, O.TD_format), level, (is3d ? 0 : layer0) + load<u32>(region, 8) + k, load<u32>(region), load<u32>(region, 4), nbx, nby, 1, data + <usize>k * img, row); H.hostFlush(); }
  H.hostFlush();
}
// The per-use check alone, n times over one texture's storage (the tests time it)
export function benchSample(tex: usize, n: u32): u64 {
  const e = texEntry(load<u64>(tex, O.TEX_serial)); let h: u64 = 0;
  if (e) for (let i: u32 = 0; i < n; i++) h ^= hashSample(<usize>load<u64>(e, TE_mem), <usize>load<u64>(e, TE_size));
  nSampled -= n;
  return h;
}
