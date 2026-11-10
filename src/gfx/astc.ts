// ASTC decoding on the CPU, for hosts whose WebGPU adapter lacks `texture-compression-astc` (desktop GPUs).
// Written from the specification (Khronos Data Format Specification, chapter "ASTC Compressed Texture Image Formats"):
// 2D blocks, LDR profile, to RGBA8. HDR endpoint modes and illegal blocks give the LDR error colour (opaque magenta).
// Section names in the comments are the specification's. test/gfx checks it against astcenc (an independent decoder).

const ERR: u32 = 0xffff00ff;      // R 255, G 0, B 255, A 255 as little-endian RGBA8

let lo: u64 = 0, hi: u64 = 0;     // the block, bit 0 first
let rlo: u64 = 0, rhi: u64 = 0;   // the block bit-reversed: the weights are stored from the top down
// @ts-ignore: decorator
@inline function bits(pos: u32, n: u32): u32 {
  if (!n) return 0;
  const v: u64 = pos >= 64 ? hi >> (pos - 64) : pos ? (lo >> pos) | (hi << (64 - pos)) : lo;
  return <u32>v & ((1 << n) - 1);
}
// @ts-ignore: decorator
@inline function rbits(pos: u32, n: u32): u32 {
  if (!n) return 0;
  const v: u64 = pos >= 64 ? rhi >> (pos - 64) : pos ? (rlo >> pos) | (rhi << (64 - pos)) : rlo;
  return <u32>v & ((1 << n) - 1);
}
function rev64(v: u64): u64 {
  v = ((v >> 1) & 0x5555555555555555) | ((v & 0x5555555555555555) << 1);
  v = ((v >> 2) & 0x3333333333333333) | ((v & 0x3333333333333333) << 2);
  v = ((v >> 4) & 0x0F0F0F0F0F0F0F0F) | ((v & 0x0F0F0F0F0F0F0F0F) << 4);
  return bswap<u64>(v);
}

// ---- Integer Sequence Encoding ----
// Bits a sequence of n values takes with (trits, quints, bits a value)
function iseBits(n: u32, trits: u32, quints: u32, b: u32): u32 { return n * b + (trits ? (n * 8 + 4) / 5 : 0) + (quints ? (n * 7 + 2) / 3 : 0); }
const VALS: usize = memory.data(80 * 2);      // decoded values: u8 high part (trit or quint), u8 low bits
// n values from bit position pos, forward in the block (rev: in the reversed block). Out of range bits read as 0
function iseDecode(pos: u32, limit: u32, n: u32, trits: u32, quints: u32, b: u32, rev: bool): void {
  let i: u32 = 0;
  if (trits) {
    while (i < n) {
      const m = VALS + (<usize>i << 1);
      let T: u32 = 0;
      for (let k: u32 = 0; k < 5; k++) {
        const tb: u32 = k == 2 || k == 4 ? 1 : 2, sh: u32 = k == 0 ? 0 : k == 1 ? 2 : k == 2 ? 4 : k == 3 ? 5 : 7;
        if (i + k < n) { store<u8>(m + (<usize>k << 1), <u8>rd(pos, limit, b, rev), 1); pos += b; T |= rd(pos, limit, tb, rev) << sh; pos += tb; }
      }
      let C: u32, t4: u32, t3: u32, t2: u32, t1: u32, t0: u32;
      if (((T >> 2) & 7) == 7) { C = ((T >> 5) << 2) | (T & 3); t4 = 2; t3 = 2; }
      else { C = T & 31; if (((T >> 5) & 3) == 3) { t4 = 2; t3 = T >> 7; } else { t4 = T >> 7; t3 = (T >> 5) & 3; } }
      if ((C & 3) == 3) { t2 = 2; t1 = (C >> 4) & 1; t0 = (((C >> 3) & 1) << 1) | (((C >> 2) & 1) & ~((C >> 3) & 1)); }
      else if (((C >> 2) & 3) == 3) { t2 = 2; t1 = 2; t0 = C & 3; }
      else { t2 = (C >> 4) & 1; t1 = (C >> 2) & 3; t0 = (((C >> 1) & 1) << 1) | ((C & 1) & ~((C >> 1) & 1)); }
      store<u8>(m, <u8>t0); store<u8>(m, <u8>t1, 2); store<u8>(m, <u8>t2, 4); store<u8>(m, <u8>t3, 6); store<u8>(m, <u8>t4, 8);
      i += 5;
    }
  } else if (quints) {
    while (i < n) {
      const m = VALS + (<usize>i << 1);
      let Q: u32 = 0;
      for (let k: u32 = 0; k < 3; k++) {
        const qb: u32 = k == 0 ? 3 : 2, sh: u32 = k == 0 ? 0 : k == 1 ? 3 : 5;
        if (i + k < n) { store<u8>(m + (<usize>k << 1), <u8>rd(pos, limit, b, rev), 1); pos += b; Q |= rd(pos, limit, qb, rev) << sh; pos += qb; }
      }
      let q2: u32, q1: u32, q0: u32;
      if (((Q >> 1) & 3) == 3 && ((Q >> 5) & 3) == 0) {
        const z = Q & 1;
        q2 = (z << 2) | ((((Q >> 4) & 1) & ~z) << 1) | (((Q >> 3) & 1) & ~z); q1 = 4; q0 = 4;
      } else {
        let C: u32;
        if (((Q >> 1) & 3) == 3) { q2 = 4; C = (((Q >> 3) & 3) << 3) | ((~(Q >> 5) & 3) << 1) | (Q & 1); }
        else { q2 = (Q >> 5) & 3; C = Q & 31; }
        if ((C & 7) == 5) { q1 = 4; q0 = (C >> 3) & 3; } else { q1 = (C >> 3) & 3; q0 = C & 7; }
      }
      store<u8>(m, <u8>q0); store<u8>(m, <u8>q1, 2); store<u8>(m, <u8>q2, 4);
      i += 3;
    }
  } else {
    for (; i < n; i++) { store<u8>(VALS + (<usize>i << 1), 0); store<u8>(VALS + (<usize>i << 1), <u8>rd(pos, limit, b, rev), 1); pos += b; }
  }
}
// @ts-ignore: decorator
@inline function rd(pos: u32, limit: u32, n: u32, rev: bool): u32 {
  if (pos >= limit) return 0;
  let v = rev ? rbits(pos, n) : bits(pos, n);
  if (pos + n > limit) v &= (1 << (limit - pos)) - 1;
  return v;
}

// Weight ranges by (R - 2) + 6 * H: trits, quints, bits ("Block Mode", table of weight ranges)
const WRANGE: usize = memory.data<u8>([0, 0, 1, 1, 0, 0, 0, 0, 2, 0, 1, 0, 1, 0, 1, 0, 0, 3, 0, 1, 1, 1, 0, 2, 0, 0, 4, 0, 1, 2, 1, 0, 3, 0, 0, 5]);
// Colour endpoint ranges from the largest (0..255) down to 0..5: trits, quints, bits ("Colour Endpoint Unquantization")
const CRANGE: usize = memory.data<u8>([0, 0, 8, 1, 0, 6, 0, 1, 5, 0, 0, 7, 1, 0, 5, 0, 1, 4, 0, 0, 6, 1, 0, 4, 0, 1, 3, 0, 0, 5, 1, 0, 3, 0, 1, 2, 0, 0, 4, 1, 0, 2, 0, 1, 1, 0, 0, 3, 1, 0, 1]);
const NCRANGE: u32 = 17;

function unqColor(d: u32, m: u32, trits: u32, quints: u32, b: u32): i32 {
  if (!trits && !quints) {       // bit replication to 8 bits
    let v = m << (8 - b), s = b;
    while (s < 8) { v |= v >> s; s <<= 1; }
    return <i32>(v & 0xff);
  }
  const A: u32 = m & 1 ? 0x1ff : 0, x = m >> 1;
  let B: u32 = 0, C: u32 = 0;
  if (trits) {
    switch (b) {
      case 1: C = 204; break;
      case 2: C = 93; B = x * 0x116; break;
      case 3: C = 44; B = (x << 7) | (x << 2) | x; break;
      case 4: C = 22; B = (x << 6) | x; break;
      case 5: C = 11; B = (x << 5) | (x >> 2); break;
      default: C = 5; B = (x << 4) | (x >> 4);
    }
  } else {
    switch (b) {
      case 1: C = 113; break;
      case 2: C = 54; B = x * 0x10c; break;
      case 3: C = 26; B = (x << 7) | (x << 1) | (x >> 1); break;
      case 4: C = 13; B = (x << 6) | (x >> 1); break;
      default: C = 6; B = (x << 5) | (x >> 3);
    }
  }
  let T = (d * C + B) ^ A;
  T = (A & 0x80) | (T >> 2);
  return <i32>(T & 0xff);
}
function unqWeight(d: u32, m: u32, trits: u32, quints: u32, b: u32): u32 {
  let T: u32;
  if (!trits && !quints) { T = m << (6 - b); let s = b; while (s < 6) { T |= T >> s; s <<= 1; } T &= 63; }
  else if (!b) T = trits ? (d == 0 ? 0 : d == 1 ? 32 : 63) : (d == 0 ? 0 : d == 1 ? 16 : d == 2 ? 32 : d == 3 ? 47 : 63);
  else {
    const A: u32 = m & 1 ? 0x7f : 0, x = m >> 1;
    let B: u32 = 0, C: u32;
    if (trits) { if (b == 1) C = 50; else if (b == 2) { C = 23; B = x * 0x45; } else { C = 11; B = (x << 5) | x; } }
    else { if (b == 1) C = 28; else { C = 13; B = x * 0x42; } }
    T = (d * C + B) ^ A;
    T = (A & 0x20) | (T >> 2);
  }
  return T > 32 ? T + 1 : T;
}

// ---- partitions ("Partition Pattern Generation") ----
function hash52(p: u32): u32 {
  p ^= p >> 15; p -= p << 17; p += p << 7; p += p << 4; p ^= p >> 5; p += p << 16; p ^= p >> 7; p ^= p >> 3; p ^= p << 6; p ^= p >> 17;
  return p;
}
const SEED: usize = memory.data(16 * 4);
let pRnum: u32 = 0, pCount: u32 = 0, pSmall: bool = false;
function partitionSetup(seed: u32, count: u32, small: bool): void {
  seed += (count - 1) * 1024;
  const r = hash52(seed);
  pRnum = r; pCount = count; pSmall = small;
  const s = SEED;
  store<u32>(s, r & 15, 4); store<u32>(s, (r >> 4) & 15, 8); store<u32>(s, (r >> 8) & 15, 12); store<u32>(s, (r >> 12) & 15, 16);
  store<u32>(s, (r >> 16) & 15, 20); store<u32>(s, (r >> 20) & 15, 24); store<u32>(s, (r >> 24) & 15, 28); store<u32>(s, (r >> 28) & 15, 32);
  let sh1: u32, sh2: u32;
  if (seed & 1) { sh1 = seed & 2 ? 4 : 5; sh2 = count == 3 ? 6 : 5; } else { sh1 = count == 3 ? 6 : 5; sh2 = seed & 2 ? 4 : 5; }
  for (let i: usize = 1; i <= 8; i++) { const v = load<u32>(s + (i << 2)); store<u32>(s + (i << 2), (v * v) >> (i & 1 ? sh1 : sh2)); }
}
// @ts-ignore: decorator
@inline function partitionOf(x: u32, y: u32): u32 {
  if (pSmall) { x <<= 1; y <<= 1; }
  const s = SEED, r = pRnum;
  const a = (load<u32>(s, 4) * x + load<u32>(s, 8) * y + (r >> 14)) & 63, b = (load<u32>(s, 12) * x + load<u32>(s, 16) * y + (r >> 10)) & 63;
  const c: u32 = pCount < 3 ? 0 : (load<u32>(s, 20) * x + load<u32>(s, 24) * y + (r >> 6)) & 63, d: u32 = pCount < 4 ? 0 : (load<u32>(s, 28) * x + load<u32>(s, 32) * y + (r >> 2)) & 63;
  return a >= b && a >= c && a >= d ? 0 : b >= c && b >= d ? 1 : c >= d ? 2 : 3;
}

// ---- endpoints ("Endpoint Unquantization", "LDR Endpoint Decoding") ----
const EP: usize = memory.data(4 * 8 * 4);       // per partition: e0 rgba, e1 rgba (i32)
const CV: usize = memory.data(20 * 4);          // unquantized colour values
// @ts-ignore: decorator
@inline function cv(i: usize): i32 { return load<i32>(CV + (i << 2)); }
// @ts-ignore: decorator
@inline function clamp8(v: i32): i32 { return v < 0 ? 0 : v > 255 ? 255 : v; }
let bA: i32 = 0, bB: i32 = 0;
// @ts-ignore: decorator
@inline function bts(a: i32, b: i32): void { b = (b >> 1) | (a & 0x80); a = (a >> 1) & 0x3f; if (a & 0x20) a -= 0x40; bA = a; bB = b; }
function setEp(e: usize, r: i32, g: i32, b: i32, a: i32, contract: bool): void {
  if (contract) { r = (r + b) >> 1; g = (g + b) >> 1; }
  store<i32>(e, clamp8(r)); store<i32>(e, clamp8(g), 4); store<i32>(e, clamp8(b), 8); store<i32>(e, clamp8(a), 12);
}
function errEp(e: usize): void { setEp(e, 255, 0, 255, 255, false); setEp(e + 16, 255, 0, 255, 255, false); }
// False for an HDR mode
function endpoints(mode: u32, v: usize, e: usize): bool {
  const v0 = cv(v), v1 = cv(v + 1);
  switch (mode) {
    case 0: setEp(e, v0, v0, v0, 255, false); setEp(e + 16, v1, v1, v1, 255, false); return true;
    case 1: { const l0 = (v0 >> 2) | (v1 & 0xc0), l1 = min<i32>(l0 + (v1 & 0x3f), 255); setEp(e, l0, l0, l0, 255, false); setEp(e + 16, l1, l1, l1, 255, false); return true; }
    case 4: setEp(e, v0, v0, v0, cv(v + 2), false); setEp(e + 16, v1, v1, v1, cv(v + 3), false); return true;
    case 5: {
      bts(v1, v0); const l1 = bA, l0 = bB; bts(cv(v + 3), cv(v + 2)); const a1 = bA, a0 = bB;
      setEp(e, l0, l0, l0, a0, false); setEp(e + 16, l0 + l1, l0 + l1, l0 + l1, a0 + a1, false); return true;
    }
    case 6: { const s = cv(v + 3), v2 = cv(v + 2); setEp(e, (v0 * s) >> 8, (v1 * s) >> 8, (v2 * s) >> 8, 255, false); setEp(e + 16, v0, v1, v2, 255, false); return true; }
    case 10: { const s = cv(v + 3), v2 = cv(v + 2); setEp(e, (v0 * s) >> 8, (v1 * s) >> 8, (v2 * s) >> 8, cv(v + 4), false); setEp(e + 16, v0, v1, v2, cv(v + 5), false); return true; }
    case 8: case 12: {
      const v2 = cv(v + 2), v3 = cv(v + 3), v4 = cv(v + 4), v5 = cv(v + 5), a0 = mode == 12 ? cv(v + 6) : 255, a1 = mode == 12 ? cv(v + 7) : 255;
      if (v1 + v3 + v5 >= v0 + v2 + v4) { setEp(e, v0, v2, v4, a0, false); setEp(e + 16, v1, v3, v5, a1, false); }
      else { setEp(e, v1, v3, v5, a1, true); setEp(e + 16, v0, v2, v4, a0, true); }
      return true;
    }
    case 9: case 13: {
      bts(v1, v0); const r1 = bA, r0 = bB; bts(cv(v + 3), cv(v + 2)); const g1 = bA, g0 = bB; bts(cv(v + 5), cv(v + 4)); const b1 = bA, b0 = bB;
      let a0: i32 = 255, a1: i32 = 0;
      if (mode == 13) { bts(cv(v + 7), cv(v + 6)); a1 = bA; a0 = bB; }
      if (r1 + g1 + b1 >= 0) { setEp(e, r0, g0, b0, a0, false); setEp(e + 16, r0 + r1, g0 + g1, b0 + b1, a0 + a1, false); }
      else { setEp(e, r0 + r1, g0 + g1, b0 + b1, a0 + a1, true); setEp(e + 16, r0, g0, b0, a0, true); }
      return true;
    }
  }
  return false;
}

const WGT: usize = memory.data(64 * 2 + 16);     // unquantized weights of the grid (two planes interleaved), padded for the infill's reads
// To 8 bits: the top 8 bits of the 16-bit result, for every channel (the `decode_unorm8` mode of
// EXT_texture_compression_astc_decode_mode, what a decoder writing 8-bit texels does). Endpoints are expanded to 16 bits
// by replication (c * 257), or as (c << 8) | 0x80 for red, green and blue of an sRGB format ("LDR sRGB decoding").
// astcenc's 8-bit output is the same, texel for texel (test/gfx/c_astc.test.mts).
function fill(out: usize, pitch: usize, bw: u32, bh: u32, c: u32): void {
  for (let y: u32 = 0; y < bh; y++) for (let x: u32 = 0; x < bw; x++) store<u32>(out + <usize>y * pitch + (<usize>x << 2), c);
}

// One block of 16 bytes at src to bw x bh RGBA8 texels at out (rows pitch bytes apart). srgb: the format is an sRGB one
export function astcBlock(src: usize, bw: u32, bh: u32, out: usize, pitch: usize, srgb: bool): void {
  lo = load<u64>(src); hi = load<u64>(src, 8);
  const mode = <u32>lo & 0x7ff;
  // "Void-Extent Blocks"
  if ((mode & 0x1ff) == 0x1fc) {
    const allOnes = (lo >> 12) == 0xfffffffffffff;
    const s0 = bits(12, 13), s1 = bits(25, 13), t0 = bits(38, 13), t1 = bits(51, 13);
    if ((mode & 0x200) || ((lo >> 10) & 3) != 3 || (!allOnes && (s0 >= s1 || t0 >= t1))) { fill(out, pitch, bw, bh, ERR); return; }
    let c: u32 = 0;
    for (let i: u32 = 0; i < 4; i++) { const v = bits(64 + i * 16, 16); c |= (v >> 8) << (i * 8); }
    fill(out, pitch, bw, bh, c);
    return;
  }
  // "Block Mode"
  let W: u32, H: u32, R: u32, D: u32 = (mode >> 10) & 1, P: u32 = (mode >> 9) & 1;
  const A = (mode >> 5) & 3;
  if (mode & 3) {
    R = ((mode >> 4) & 1) | ((mode & 3) << 1);
    const B = (mode >> 7) & 3;
    switch ((mode >> 2) & 3) {
      case 0: W = B + 4; H = A + 2; break;
      case 1: W = B + 8; H = A + 2; break;
      case 2: W = A + 2; H = B + 8; break;
      default: if (B & 2) { W = (B & 1) + 2; H = A + 2; } else { W = A + 2; H = (B & 1) + 6; }
    }
  } else {
    if (!(mode & 0xf) || ((mode >> 6) & 7) == 7) { fill(out, pitch, bw, bh, ERR); return; }
    R = ((mode >> 4) & 1) | (((mode >> 2) & 3) << 1);
    switch ((mode >> 7) & 3) {
      case 0: W = 12; H = A + 2; break;
      case 1: W = A + 2; H = 12; break;
      case 2: W = A + 6; H = ((mode >> 9) & 3) + 6; D = 0; P = 0; break;
      default: if ((mode >> 5) & 1) { W = 10; H = 6; } else { W = 6; H = 10; }
    }
  }
  if (R < 2 || W > bw || H > bh) { fill(out, pitch, bw, bh, ERR); return; }
  const wr = WRANGE + <usize>((R - 2) + 6 * P) * 3, wT = <u32>load<u8>(wr), wQ = <u32>load<u8>(wr, 1), wB = <u32>load<u8>(wr, 2);
  const nw = W * H * (D + 1), wbits = iseBits(nw, wT, wQ, wB);
  const parts = (<u32>(lo >> 11) & 3) + 1;
  if (nw > 64 || wbits < 24 || wbits > 96 || (D && parts == 4)) { fill(out, pitch, bw, bh, ERR); return; }
  // "Configuration Bits": colour endpoint modes
  // below the weights: the extra colour endpoint mode bits (several partitions), then the second plane's channel
  let below: u32 = 128 - wbits, plane2: u32 = 4;
  let start: u32, nvals: u32 = 0;
  let m0: u32, m1: u32 = 0, m2: u32 = 0, m3: u32 = 0;
  if (parts == 1) { m0 = bits(13, 4); start = 17; }
  else {
    partitionSetup(bits(13, 10), parts, bw * bh < 31);
    let f = bits(23, 6);
    start = 29;
    if (!(f & 3)) { m0 = f >> 2; m1 = m0; m2 = m0; m3 = m0; }
    else {
      const extra = 3 * parts - 4;
      below -= extra;
      f |= bits(below, extra) << 6;
      const base = (f & 3) - 1;
      m0 = ((((f >> 2) & 1) + base) << 2) | ((f >> (2 + parts)) & 3);
      m1 = ((((f >> 3) & 1) + base) << 2) | ((f >> (4 + parts)) & 3);
      m2 = ((((f >> 4) & 1) + base) << 2) | ((f >> (6 + parts)) & 3);
      m3 = ((((f >> 5) & 1) + base) << 2) | ((f >> (8 + parts)) & 3);
    }
  }
  if (D) { below -= 2; plane2 = bits(below, 2); }
  nvals = ((m0 >> 2) + 1) * 2;
  if (parts > 1) nvals += ((m1 >> 2) + 1) * 2;
  if (parts > 2) nvals += ((m2 >> 2) + 1) * 2;
  if (parts > 3) nvals += ((m3 >> 2) + 1) * 2;
  if (nvals > 18 || <i32>below < <i32>start) { fill(out, pitch, bw, bh, ERR); return; }
  // "Colour Endpoint Data Size Determination": the largest range whose encoding fits
  const avail: u32 = below - start;
  let cT: u32 = 0, cQ: u32 = 0, cB: u32 = 0, found = false;
  for (let i: u32 = 0; i < NCRANGE; i++) {
    const r = CRANGE + <usize>i * 3;
    cT = load<u8>(r); cQ = load<u8>(r, 1); cB = load<u8>(r, 2);
    if (iseBits(nvals, cT, cQ, cB) <= avail) { found = true; break; }
  }
  if (!found) { fill(out, pitch, bw, bh, ERR); return; }
  iseDecode(start, below, nvals, cT, cQ, cB, false);
  for (let i: u32 = 0; i < nvals; i++) store<i32>(CV + (<usize>i << 2), unqColor(load<u8>(VALS + (<usize>i << 1)), load<u8>(VALS + (<usize>i << 1), 1), cT, cQ, cB));
  // An HDR endpoint mode in this LDR decoder: the texels of that partition are the error colour (as astcenc does it)
  let v: usize = 0;
  if (!endpoints(m0, v, EP)) errEp(EP);
  v += ((m0 >> 2) + 1) * 2;
  if (parts > 1) { if (!endpoints(m1, v, EP + 32)) errEp(EP + 32); v += ((m1 >> 2) + 1) * 2; }
  if (parts > 2) { if (!endpoints(m2, v, EP + 64)) errEp(EP + 64); v += ((m2 >> 2) + 1) * 2; }
  if (parts > 3 && !endpoints(m3, v, EP + 96)) errEp(EP + 96);
  // Weights: from the top of the block downwards
  rlo = rev64(hi); rhi = rev64(lo);
  iseDecode(0, wbits, nw, wT, wQ, wB, true);
  memory.fill(WGT, 0, 144);
  for (let i: u32 = 0; i < nw; i++) store<u8>(WGT + i, <u8>unqWeight(load<u8>(VALS + (<usize>i << 1)), load<u8>(VALS + (<usize>i << 1), 1), wT, wQ, wB));
  // "Weight Infill" and "Weight Application"
  const Ds = (1024 + bw / 2) / (bw - 1), Dt = (1024 + bh / 2) / (bh - 1), step: u32 = D + 1;
  for (let y: u32 = 0; y < bh; y++) {
    const gt = (Dt * y * (H - 1) + 32) >> 6, jt = gt >> 4, ft = gt & 15;
    for (let x: u32 = 0; x < bw; x++) {
      const gs = (Ds * x * (W - 1) + 32) >> 6, js = gs >> 4, fs = gs & 15;
      const w11 = (fs * ft + 8) >> 4, w10 = ft - w11, w01 = fs - w11, w00 = 16 - fs - ft + w11;
      const q = WGT + <usize>((js + jt * W) * step), row = <usize>(W * step);
      const wa = (<u32>load<u8>(q) * w00 + <u32>load<u8>(q + step) * w01 + <u32>load<u8>(q + row) * w10 + <u32>load<u8>(q + row + step) * w11 + 8) >> 4;
      const wb2 = D ? (<u32>load<u8>(q, 1) * w00 + <u32>load<u8>(q + step, 1) * w01 + <u32>load<u8>(q + row, 1) * w10 + <u32>load<u8>(q + row + step, 1) * w11 + 8) >> 4 : wa;
      const e = EP + (parts == 1 ? 0 : <usize>partitionOf(x, y) << 5);
      let px: u32 = 0;
      for (let c: u32 = 0; c < 4; c++) {
        let c0 = <u32>load<i32>(e + (<usize>c << 2)), c1 = <u32>load<i32>(e + 16 + (<usize>c << 2));
        if (srgb && c < 3) { c0 = (c0 << 8) | 0x80; c1 = (c1 << 8) | 0x80; } else { c0 *= 257; c1 *= 257; }
        const w = c == plane2 ? wb2 : wa, C = (c0 * (64 - w) + c1 * w + 32) >> 6;
        px |= (C >> 8) << (c * 8);
      }
      store<u32>(out + <usize>y * pitch + (<usize>x << 2), px);
    }
  }
}
// Rows of blocks: nby block rows of nbx blocks each at src (rows srcPitch bytes apart) to RGBA8 at out (pitch bytes a texel row)
export function astcRows(src: usize, srcPitch: usize, nbx: u32, nby: u32, bw: u32, bh: u32, out: usize, pitch: usize, srgb: bool): void {
  for (let by: u32 = 0; by < nby; by++) for (let bx: u32 = 0; bx < nbx; bx++)
    astcBlock(src + <usize>by * srcPitch + (<usize>bx << 4), bw, bh, out + <usize>by * bh * pitch + (<usize>(bx * bw) << 2), pitch, srgb);
}
