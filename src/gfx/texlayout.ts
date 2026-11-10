// Storage size, alignment and level offsets of NVN textures (Tegra X1 block-linear layout): the port of nxnative
// dm/gfx/nvn/nvn_tex.c, itself after deko3d's dk_image.cpp (zlib license, Copyright (C) 2018-2020 fincs).
// Games allocate texture storage by these numbers (nvnTextureBuilderGetStorageSize / Alignment), so they are nxnative's
// exactly; test/gfx checks a table of shapes against nvn_tex.c compiled from the reference tree.
import { TD_target, TD_format, TD_flags, TD_samples, TD_width, TD_height, TD_depth, TD_levels, TD_stride, TD_pkg_block_h,
  TL_size, TL_layer_size, TL_align, TL_layers, TL_bpb, TL_tileH, TL_tileD } from "./obj";

// Format: bytes per block, block width, block height (results of fmtOf)
export let fBpb: u32 = 0;
export let fBw: u32 = 1;
export let fBh: u32 = 1;
const ASTC: usize = memory.data<u8>([4, 4, 5, 4, 5, 5, 6, 5, 6, 6, 8, 5, 8, 6, 8, 8, 10, 5, 10, 6, 10, 8, 10, 10, 12, 10, 12, 12]);
const RANGES: usize = memory.data<u8>([
  0x01, 0x04, 1, 0x05, 0x09, 2, 0x0A, 0x0C, 4, 0x0D, 0x10, 2, 0x11, 0x15, 4, 0x16, 0x18, 8,
  0x19, 0x1C, 3, 0x1D, 0x21, 6, 0x22, 0x24, 12, 0x25, 0x28, 4, 0x29, 0x2D, 8, 0x2E, 0x30, 16,
  0x31, 0x31, 1, 0x32, 0x32, 2, 0x33, 0x35, 4, 0x36, 0x36, 8, 0x37, 0x38, 4, 0x39, 0x3C, 2, 0x3D, 0x40, 4,
  0x51, 0x52, 1, 0x53, 0x54, 2, 0x55, 0x56, 4, 0x57, 0x58, 2, 0x59, 0x5A, 4, 0x5B, 0x5C, 8,
  0x5D, 0x5E, 3, 0x5F, 0x60, 6, 0x61, 0x62, 12, 0x63, 0x64, 4, 0x65, 0x66, 8, 0x67, 0x68, 16,
  0x69, 0x6C, 4, 0x6D, 0x70, 4, 0x71, 0x75, 8, 0x76, 0x78, 16, 0x95, 0x98, 2, 0x99, 0x9C, 4]);
const NRANGES: i32 = 37;

export function fmtOf(f: i32): u32 {
  fBw = 1; fBh = 1; fBpb = 0;
  if (f >= 0x79 && f <= 0x94) { const k = <usize>((f - 0x79) % 14); fBpb = 16; fBw = load<u8>(ASTC + k * 2); fBh = load<u8>(ASTC + k * 2 + 1); return fBpb; }
  if (f >= 0x41 && f <= 0x50) { fBpb = f <= 0x42 || f == 0x45 || f == 0x46 || f == 0x49 || f == 0x4A ? 8 : 16; fBw = 4; fBh = 4; return fBpb; }
  for (let i = 0; i < NRANGES; i++) {
    const r = RANGES + <usize>i * 3;
    if (f >= <i32>load<u8>(r) && f <= <i32>load<u8>(r, 1)) { fBpb = load<u8>(r, 2); return fBpb; }
  }
  return 0;
}

// @ts-ignore: decorator
@inline function mip(s: u32, l: u32): u32 { s >>= l; return s ? s : 1; }
// @ts-ignore: decorator
@inline function blk(s: u32, b: u32): u32 { return (s + b - 1) / b; }
function pickTile(gobs: u32): u32 { return gobs >= 16 ? 4 : gobs >= 8 ? 3 : gobs >= 4 ? 2 : gobs >= 2 ? 1 : 0; }
function adjTile(shift: u32, unit: u32, dim: u32): u32 {
  if (!shift) return 0;
  let x = unit << (shift - 1);
  if (x >= dim) while (--shift) { x >>= 1; if (x < dim) break; }
  return shift;
}

// shape(): dimensions, layered, and the extents the layout uses
let dpl: u32 = 2, layered: bool = false, sw: u32 = 0, sh: u32 = 0, sz: u32 = 0, sx: u32 = 1, sy: u32 = 1;
function shape(d: usize): void {
  sw = load<u32>(d, TD_width); sh = load<u32>(d, TD_height); sz = load<u32>(d, TD_depth); layered = false;
  switch (load<i32>(d, TD_target)) {
    case 0: dpl = 1; sh = 1; sz = 1; break;
    case 3: dpl = 1; sz = load<u32>(d, TD_height); sh = 1; layered = true; break;
    case 2: dpl = 3; break;
    case 4: case 6: dpl = 2; layered = true; break;
    case 8: dpl = 2; sz = 6; layered = true; break;
    case 9: dpl = 2; layered = true; break;
    default: dpl = 2; sz = 1; break;
  }
  if (sz == 0) sz = 1;
  const s = load<i32>(d, TD_samples);
  sx = 1; sy = 1;
  if (s == 2) sx = 2; else if (s == 4) { sx = 2; sy = 2; } else if (s == 8) { sx = 4; sy = 2; }
}

const SPARSE_TILE: u64 = 0x10000;
function sparseOf(d: usize): bool { const f = load<i32>(d, TD_flags); return (f & 0x20) != 0 && (f & 0x50) == 0 && load<i32>(d, TD_target) != 10; }
function sparseTileH(bpb: u32): i32 { return bpb == 1 ? 5 : bpb == 2 || bpb == 4 ? 4 : bpb == 8 || bpb == 16 ? 3 : -1; }
function sparseTileH3(bpb: u32): i32 { return bpb == 1 || bpb == 2 || bpb == 4 ? 2 : bpb == 8 || bpb == 16 ? 1 : -1; }
function sparseTileD3(bpb: u32): i32 { return bpb == 1 || bpb == 2 ? 5 : bpb == 4 || bpb == 8 || bpb == 16 ? 4 : -1; }
function tileShapeH(d: usize, tileH: u32): u32 {
  return dpl == 2 && !load<i32>(d, TD_pkg_block_h) && sparseTileH(fBpb) >= 0 ? <u32>sparseTileH(fBpb) : tileH;
}

// Offset of level `level` from the start of its layer (shape() and fmtOf() already called for d)
function levelOffset(d: usize, level: u32, tileH: u32, tileD: u32): u64 {
  const shp = tileShapeH(d, tileH);
  let tw: u32 = 128 >> (shp + tileD); if (!tw) tw = 1;
  let tiled = sparseOf(d);
  let off: u64 = 0;
  for (let i: u32 = 0; ; i++) {
    const lw = blk(mip(sw * sx, i), fBw);
    const lh = dpl >= 2 ? blk(mip(sh * sy, i), fBh) : 1;
    const ld = dpl >= 3 ? mip(sz, i) : 1;
    const lwb = lw * fBpb;
    const th = adjTile(tileH, 8, lh), td = adjTile(tileD, 1, ld);
    let wg = (lwb + 63) / 64; const hg = (lh + 7) / 8;
    tiled = tiled && lwb >= tw * 64 && lh >= (<u32>8 << shp) && ld >= (<u32>1 << tileD);
    if (tiled) wg = (wg + tw - 1) / tw * tw;
    if (i == level) return off;
    const ht = (hg + (<u32>1 << th) - 1) >> th, dt = (ld + (<u32>1 << td) - 1) >> td;
    off += (<u64>wg * ht * dt) << (9 + th + td);
  }
}
function layerBytes(d: usize, tileH: u32, tileD: u32): u64 {
  const levels = load<u32>(d, TD_levels);
  let ls = levelOffset(d, levels ? levels : 1, tileH, tileD);
  if (sparseOf(d)) ls = (ls + SPARSE_TILE - 1) & ~(SPARSE_TILE - 1);
  if (layered) {
    const hh = blk(sh, fBh); let th = tileH, td = tileD;
    while (th && hh <= (<u32>8 << (th - 1))) th--;
    while (td && sz <= (<u32>1 << (td - 1))) td--;
    const s = <u64>(th + td + 9), g = ls >> s;
    if (ls != g << s) ls = (g + 1) << s;
  }
  return ls;
}

// nvn_tex_layout: d = nvn_texdesc, o = nvn_texlayout (both in memory)
export function texLayout(d: usize, o: usize): void {
  fmtOf(load<i32>(d, TD_format));
  shape(d);
  const flags = load<i32>(d, TD_flags), bpb = fBpb;
  store<u32>(o, bpb, TL_bpb); store<u32>(o, 0, TL_tileH); store<u32>(o, 0, TL_tileD); store<u32>(o, layered ? sz : 1, TL_layers);
  if (!bpb) { store<u64>(o, 0, TL_size); store<u32>(o, 512, TL_align); store<u64>(o, 0, TL_layer_size); return; }
  if (load<i32>(d, TD_target) == 10) {
    const n = <u64>bpb * load<u32>(d, TD_width);
    store<u64>(o, n, TL_size); store<u64>(o, n, TL_layer_size); store<u32>(o, bpb == 12 ? 4 : bpb, TL_align); return;
  }
  if (flags & 0x50) {
    const align: u32 = (flags & 0x40) ? 128 : 32;
    let stride = load<u32>(d, TD_stride);
    if (!stride) stride = (bpb * blk(sw, fBw) + align - 1) & ~(align - 1);
    const n = <u64>stride * sh;
    store<u32>(o, align, TL_align); store<u64>(o, n, TL_size); store<u64>(o, n, TL_layer_size); return;
  }
  let tileH: u32 = 0, tileD: u32 = 0;
  const pkg = load<i32>(d, TD_pkg_block_h);
  if (pkg) {
    const pl = <u32>(pkg - 1) & 0xff;
    if (dpl >= 2) tileH = pl & 0xf;
    if (dpl == 3) tileD = pl >> 4;
  } else if (dpl == 2 && sparseOf(d) && sparseTileH(bpb) >= 0 && blk(sw * sx, fBw) * bpb >= (<u32>128 >> sparseTileH(bpb)) * 64
    && blk(sh * sy, fBh) >= (<u32>8 << sparseTileH(bpb))) tileH = <u32>sparseTileH(bpb);
  else if (dpl == 3 && sparseOf(d) && sparseTileH3(bpb) >= 0 && blk(sw * sx, fBw) * bpb >= (<u32>128 >> (sparseTileH3(bpb) + sparseTileD3(bpb))) * 64
    && blk(sh * sy, fBh) >= (<u32>8 << sparseTileH3(bpb)) && sz >= (<u32>1 << sparseTileD3(bpb))) { tileH = <u32>sparseTileH3(bpb); tileD = <u32>sparseTileD3(bpb); }
  else if (dpl == 2) { const ah = blk(sh * sy, fBh); tileH = pickTile(ah * 3 / 16); }
  else if (dpl == 3) tileD = pickTile(sz + sz / 2);
  let ls = layerBytes(d, tileH, tileD);
  if ((flags & 0x200) && !pkg && !sparseOf(d) && (tileH || tileD)) {
    const one = layerBytes(d, 0, 0);
    if (one != ls) { tileH = 0; tileD = 0; ls = one; }
  }
  store<u32>(o, tileH, TL_tileH); store<u32>(o, tileD, TL_tileD);
  store<u64>(o, ls, TL_layer_size);
  store<u64>(o, layered ? ls * sz : ls, TL_size);
  store<u32>(o, sparseOf(d) ? <u32>SPARSE_TILE : 512, TL_align);
}

const TMP_L: usize = memory.data(40);
// nvn_tex_level_offset
export function texLevelOffset(d: usize, level: u32): u64 {
  if (!fmtOf(load<i32>(d, TD_format)) || (load<i32>(d, TD_flags) & 0x50) || load<i32>(d, TD_target) == 10) return 0;
  texLayout(d, TMP_L);
  return levelOffset(d, level, load<u32>(TMP_L, TL_tileH), load<u32>(TMP_L, TL_tileD));
}
