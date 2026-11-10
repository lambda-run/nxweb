// What the recorder must know about NVN formats beyond their block sizes (texlayout.ts fmtOf): the class a vertex
// attribute or a colour target of the format has in a shader, which formats the host holds as the same texture format,
// the sRGB twin a view may switch to, and how texels of formats WebGPU cannot take are converted on upload.
// The replayer's table (src/glue/gfx_formats.ts) names the WebGPU format; test/gfx compares the two.
const UI: usize = memory.data<u8>([0x03, 0x08, 0x0B, 0x0F, 0x14, 0x17, 0x1B, 0x20, 0x23, 0x27, 0x2C, 0x2F, 0x3E, 0x6F, 0x74, 0x77]);
const SI: usize = memory.data<u8>([0x04, 0x09, 0x0C, 0x10, 0x15, 0x18, 0x1C, 0x21, 0x24, 0x28, 0x2D, 0x30, 0x6A, 0x70, 0x75, 0x78]);
// 0 float (unorm, snorm, float, scaled), 1 sint, 2 uint
export function fmtClass(f: u32): u32 {
  for (let i: usize = 0; i < 16; i++) { if (<u32>load<u8>(UI + i) == f) return 2; if (<u32>load<u8>(SI + i) == f) return 1; }
  return 0;
}
// The format the host texture has when two NVN formats share one (RGBX8 = RGBA8 and so on)
export function fmtCanon(f: u32): u32 {
  switch (f) { case 0x37: return 0x38; case 0x6d: return 0x25; case 0x99: return 0x9a; case 0x9b: return 0x9c; case 0x41: return 0x42; case 0x45: return 0x46; }
  return f;
}
// The sRGB (or linear) twin of a canonical format, 0 when it has none: the one reinterpretation a WebGPU view can make
export function fmtTwin(f: u32): u32 {
  switch (f) {
    case 0x25: return 0x38; case 0x38: return 0x25; case 0x9a: return 0x9c; case 0x9c: return 0x9a;
    case 0x42: return 0x46; case 0x46: return 0x42; case 0x43: return 0x47; case 0x47: return 0x43; case 0x44: return 0x48; case 0x48: return 0x44;
    case 0x4d: return 0x4e; case 0x4e: return 0x4d;
  }
  if (f >= 0x79 && f <= 0x86) return f + 14;
  if (f >= 0x87 && f <= 0x94) return f - 14;
  return 0;
}

// What the host can take as it is (gfx_host_caps, from the adapter's features): 1 ASTC, 2 16-bit normalized formats
export let hostCaps: u32 = 0;
export function setHostCaps(c: u32): void { hostCaps = c; }
// How texels of a format go to the replayer (texcontent.ts): X_NONE as stored; the others are converted row by row
export const X_NONE: u32 = 0, X_D16: u32 = 1, X_D24: u32 = 2, X_D32F: u32 = 3, X_D24S8: u32 = 4, X_D32FS8: u32 = 5, X_S8: u32 = 6, X_PACKED: u32 = 7, X_NORM16: u32 = 8, X_SNORM16: u32 = 9, X_ASTC: u32 = 10;
export function fmtXform(f: u32): u32 {
  switch (f) {
    case 0x31: return X_S8; case 0x32: return X_D16; case 0x33: return X_D24; case 0x34: return X_D32F; case 0x35: return X_D24S8; case 0x36: return X_D32FS8;
    case 0x39: case 0x3a: case 0x3b: case 0x3c: case 0x95: case 0x96: case 0x97: case 0x98: return X_PACKED;
    case 0x06: case 0x12: case 0x2a: return hostCaps & 2 ? X_NONE : X_NORM16;
    case 0x07: case 0x13: case 0x2b: return hostCaps & 2 ? X_NONE : X_SNORM16;
  }
  if (f >= 0x79 && f <= 0x94) return hostCaps & 1 ? X_NONE : X_ASTC;
  return X_NONE;
}
// A 16-bit packed texel (red at bit 0 in guest memory, as nxnative's nvn_fmt_to_mtl has it) as RGBA8, little-endian
export function unpack16(f: u32, v: u32): u32 {
  let r: u32, g: u32, b: u32, a: u32 = 255;
  // @ts-ignore: decorator
  switch (f) {
    case 0x39: r = (v & 15) * 17; g = ((v >> 4) & 15) * 17; b = ((v >> 8) & 15) * 17; a = (v >> 12) * 17; break;                 // RGBA4
    case 0x3a: case 0x3b: r = x5(v); g = x5(v >> 5); b = x5(v >> 10); if (f == 0x3b) a = v & 0x8000 ? 255 : 0; break;            // RGB5, RGB5A1
    case 0x3c: r = x5(v); g = x6(v >> 5); b = x5(v >> 11); break;                                                              // RGB565
    case 0x95: b = x5(v); g = x6(v >> 5); r = x5(v >> 11); break;                                                              // BGR565
    case 0x96: case 0x97: b = x5(v); g = x5(v >> 5); r = x5(v >> 10); if (f == 0x97) a = v & 0x8000 ? 255 : 0; break;            // BGR5, BGR5A1
    default: a = v & 1 ? 255 : 0; b = x5(v >> 1); g = x5(v >> 6); r = x5(v >> 11);                                             // A1BGR5
  }
  return r | (g << 8) | (b << 16) | (a << 24);
}
// @ts-ignore: decorator
@inline function x5(v: u32): u32 { v &= 31; return (v << 3) | (v >> 2); }
// @ts-ignore: decorator
@inline function x6(v: u32): u32 { v &= 63; return (v << 2) | (v >> 4); }
// A float as IEEE half, round to nearest (inputs here are in [-1, 1])
export function toHalf(f: f32): u16 {
  const x = reinterpret<u32>(f), sign = <u16>((x >> 16) & 0x8000), e = <i32>((x >> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e <= 0) {
    if (e < -10) return sign;
    m = (m | 0x800000) >> (1 - e);
    return sign | <u16>((m + 0x1000) >> 13);
  }
  if (e >= 31) return sign | 0x7c00;
  return sign | <u16>(((<u32>e << 10) | (m >> 13)) + ((m >> 12) & 1));
}
