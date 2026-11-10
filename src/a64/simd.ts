// nxweb a64: Advanced SIMD data processing (vector and scalar-in-SIMD forms).
// Everything is computed on the full v128; 64-bit and scalar forms then clear the unused part.
import {
  b, leb, i32c, i64c, f32c, f64c, v128c, lget, lset, ltee, simd, fc,
  getX, setX, t32, t64, tf32, tf64, tv, optFma,
} from "./emit";
import { vget, vset, setF, setVint, roundMode, vfpExpand32, vfpExpand64, minMaxNum } from "./fp";

const SH = new StaticArray<u8>(16);
function shuffle(): void { simd(0x0D); for (let i = 0; i < 16; i++) b(SH[i]); }
// integer lane op: base 0x60 + 0x20 * sz
// @ts-ignore
@inline function vi(sz: u32, off: u32): void { simd(0x60 + 0x20 * sz + off); }
// k: eq 0, ne 1, lt_s 2, lt_u 3, gt_s 4, gt_u 5, le_s 6, le_u 7, ge_s 8, ge_u 9 (64-bit: signed only)
function vcmp(sz: u32, k: u32): void {
  if (sz < 3) { simd(0x23 + 10 * sz + k); return; }
  simd(k == 0 ? 0xD6 : k == 1 ? 0xD7 : k == 2 ? 0xD8 : k == 4 ? 0xD9 : k == 6 ? 0xDA : 0xDB);
}
// @ts-ignore
@inline function vfo(d: bool, off: u32): void { simd((d ? 0xEC : 0xE0) + off); }
// @ts-ignore
@inline function vfcmp(d: bool, k: u32): void { simd((d ? 0x47 : 0x41) + k); }
function laneConst(sz: u32, v: u64): void {
  let bits: u32 = 8 << sz;
  let x: u64 = bits == 64 ? v : v & ((<u64>1 << bits) - 1);
  for (let s = bits; s < 64; s <<= 1) x |= x << s;
  v128c(x, x);
}
// fm: 0 keep all, 1 low 64, 2 low 32, 3 low 16, 4 low 8
function finish(rd: i32, fm: i32): void {
  switch (fm) {
    case 1: v128c(~(<u64>0), 0); simd(0x4E); break;
    case 2: v128c(0xFFFFFFFF, 0); simd(0x4E); break;
    case 3: v128c(0xFFFF, 0); simd(0x4E); break;
    case 4: v128c(0xFF, 0); simd(0x4E); break;
  }
  vset(rd);
}
function scalarFm(sz: u32): i32 { return sz == 3 ? 1 : sz == 2 ? 2 : sz == 1 ? 3 : 4; }
// stack: a b -> a*b (integer lanes)
function vmul(sz: u32): void {
  if (sz != 0) { vi(sz, 0x15); return; }
  let A = tv(4), B = tv(5);
  lset(B); lset(A);
  lget(A); lget(B); simd(0x9E); v128c(0x00FF00FF00FF00FF, 0x00FF00FF00FF00FF); simd(0x4E);
  lget(A); lget(B); simd(0x9F); v128c(0x00FF00FF00FF00FF, 0x00FF00FF00FF00FF); simd(0x4E);
  simd(0x66);
}
// @ts-ignore
@inline function vext(szWide: u32, high: bool, U: bool): void { simd(0x60 + 0x20 * szWide + 7 + (high ? 1 : 0) + (U ? 2 : 0)); }
// @ts-ignore
@inline function vextmul(szWide: u32, high: bool, U: bool): void { simd(0x60 + 0x20 * szWide + 0x1C + (high ? 1 : 0) + (U ? 2 : 0)); }
// stack: a b c -> a*b + c (neg: c - a*b)
function vfma(d: bool, neg: bool): void {
  if (optFma) { simd(d ? (neg ? 0x108 : 0x107) : (neg ? 0x106 : 0x105)); return; }
  let C = tv(4);
  lset(C); vfo(d, 6); lset(tv(5)); lget(C); lget(tv(5)); vfo(d, neg ? 5 : 4);
}
// SH = pairwise selection (even or odd elements of n:m)
function pairSh(esz: i32, Q: bool, odd: i32): void {
  let cnt = (Q ? 16 : 8) / esz;
  for (let i = 0; i < 16; i++) SH[i] = 0;
  for (let i = 0; i < cnt / 2; i++) {
    for (let k = 0; k < esz; k++) {
      SH[i * esz + k] = <u8>((2 * i + odd) * esz + k);
      SH[(cnt / 2 + i) * esz + k] = <u8>(16 + (2 * i + odd) * esz + k);
    }
  }
}
// stack: x -> x >> sh per lane (sh in 1..esize)
function vshr(sz: u32, U: bool, sh: u32): void {
  let esize: u32 = 8 << sz;
  if (sh >= esize) {
    if (U) { b(0x1A); v128c(0, 0); return; }
    sh = esize - 1;
  }
  i32c(sh); vi(sz, U ? 0xD : 0xC);
}
// stack: x -> rounding shift right
function vrshr(sz: u32, U: bool, sh: u32): void {
  let X = tv(4);
  ltee(X); vshr(sz, U, sh);
  lget(X); i32c(sh - 1); vi(sz, 0xD); laneConst(sz, 1); simd(0x4E);
  vi(sz, 0xE);
}
// stack: wide vector -> narrowed into rd (Q: upper half, keeping the lower; else lower, zero upper)
function narrowTo(sz: u32, Q: bool, rd: i32): void {
  let e: i32 = 1 << sz;
  if (Q) {
    let W = tv(4);
    lset(W); vget(rd); lget(W);
    for (let j = 0; j < 8; j++) { SH[j] = <u8>j; SH[8 + j] = <u8>(16 + (j / e) * 2 * e + (j % e)); }
  } else {
    v128c(0, 0);
    for (let j = 0; j < 8; j++) { SH[j] = <u8>((j / e) * 2 * e + (j % e)); SH[8 + j] = 16; }
  }
  shuffle(); vset(rd);
}

// stack: wide vector -> saturating narrow into rd. srcS: source lanes signed; dstS: destination signed
function satNarrowTo(sz: u32, Q: bool, rd: i32, srcS: bool, dstS: bool): void {
  let W = tv(4);
  if (sz == 2) {
    // 64 -> 32 through scalar code
    let x = t64(0);
    lset(W);
    v128c(0, 0);
    for (let l = 0; l < 2; l++) {
      lget(W); simd(0x1D); b(l); lset(x);
      let lo: i64 = dstS ? -0x80000000 : 0, hi: i64 = dstS ? 0x7FFFFFFF : 0xFFFFFFFF;
      if (srcS) {
        lget(x); i64c(lo); lget(x); i64c(lo); b(0x55); b(0x1B); lset(x);
        lget(x); i64c(hi); lget(x); i64c(hi); b(0x53); b(0x1B);
      } else { lget(x); i64c(hi); lget(x); i64c(hi); b(0x54); b(0x1B); }
      b(0xA7); simd(0x1C); b(l);
    }
  } else {
    if (!srcS) { laneConst(sz + 1, sz == 0 ? 0xFF : 0xFFFF); vi(sz + 1, 0x17); }
    v128c(0, 0); simd((sz == 0 ? 0x65 : 0x85) + (dstS ? 0 : 1));
  }
  if (Q) {
    lset(W); vget(rd); lget(W);
    for (let j = 0; j < 8; j++) { SH[j] = <u8>j; SH[8 + j] = <u8>(16 + j); }
    shuffle();
  }
  vset(rd);
}

// lanewise scalar fallback. kind 0: float -> int (round mode, then saturating convert)
// kind 1: int -> float, kind 2: float rounding, kind 3: float -> int after scaling by 2^fbits,
// kind 4: int -> float then scale by 2^-fbits
function laneOp(kind: i32, d: bool, U: bool, mode: u32, fbits: i32): void {
  switch (kind) {
    case 0: if (mode != 3) roundMode(d, mode); fc((d ? 6 : 0) + (U ? 1 : 0)); break;
    case 1: b(d ? (U ? 0xBA : 0xB9) : (U ? 0xB3 : 0xB2)); break;
    case 2: roundMode(d, mode); break;
    case 3:
      if (d) f64c(<u64>(1023 + fbits) << 52); else f32c(<u32>(127 + fbits) << 23);
      b(d ? 0xA2 : 0x94); fc((d ? 6 : 0) + (U ? 1 : 0)); break;
    default:
      b(d ? (U ? 0xBA : 0xB9) : (U ? 0xB3 : 0xB2));
      if (d) f64c(<u64>(1023 - fbits) << 52); else f32c(<u32>(127 - fbits) << 23);
      b(d ? 0xA2 : 0x94); break;
  }
}
// stack: v -> v' (per-lane scalar op)
function lanewise(kind: i32, d: bool, U: bool, mode: u32, fbits: i32): void {
  let S = tv(6);
  let srcInt = kind == 1 || kind == 4, dstInt = kind == 0 || kind == 3;
  let ex: u32 = d ? (srcInt ? 0x1D : 0x21) : (srcInt ? 0x1B : 0x1F);
  let rep: u32 = d ? (dstInt ? 0x1E : 0x22) : (dstInt ? 0x1C : 0x20);
  let spl: u32 = d ? (dstInt ? 0x12 : 0x14) : (dstInt ? 0x11 : 0x13);
  lset(S);
  lget(S); simd(ex); b(0); laneOp(kind, d, U, mode, fbits); simd(spl);
  let n = d ? 2 : 4;
  for (let l = 1; l < n; l++) { lget(S); simd(ex); b(l); laneOp(kind, d, U, mode, fbits); simd(rep); b(l); }
}
function vround(d: bool, mode: u32): void {
  if (mode == 4) { lanewise(2, d, false, 4, 0); return; }
  if (d) simd(mode == 0 ? 0x94 : mode == 1 ? 0x74 : mode == 2 ? 0x75 : 0x7A);
  else simd(mode == 0 ? 0x6A : mode == 1 ? 0x67 : mode == 2 ? 0x68 : 0x69);
}

// ---------------------------------------------------------------------------------------------
function threeSameFp(insn: u32, scalar: bool): bool {
  let Q = ((insn >> 30) & 1) != 0, U = (insn >> 29) & 1, a = (insn >> 23) & 1, d = ((insn >> 22) & 1) != 0;
  let opcode = (insn >> 11) & 31;
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31), rm = <i32>((insn >> 16) & 31);
  let fm: i32 = scalar ? (d ? 1 : 2) : (Q ? 0 : 1);
  if (!scalar && d && !Q) return false;
  let key = (U << 6) | (a << 5) | opcode;
  switch (key) {
    case 0x19: vget(rn); vget(rm); vget(rd); vfma(d, false); break;
    case 0x39: vget(rn); vget(rm); vget(rd); vfma(d, true); break;
    case 0x1A: vget(rn); vget(rm); vfo(d, 4); break;
    case 0x3A: vget(rn); vget(rm); vfo(d, 5); break;
    case 0x5A: {
      if (scalar) return false;
      let e = d ? 8 : 4;
      pairSh(e, Q, 0); vget(rn); vget(rm); shuffle();
      pairSh(e, Q, 1); vget(rn); vget(rm); shuffle();
      vfo(d, 4); break;
    }
    case 0x7A: vget(rn); vget(rm); vfo(d, 5); vfo(d, 0); break;
    case 0x5B: vget(rn); vget(rm); vfo(d, 6); break;
    case 0x1C: vget(rn); vget(rm); vfcmp(d, 0); break;
    case 0x5C: vget(rn); vget(rm); vfcmp(d, 5); break;
    case 0x7C: vget(rn); vget(rm); vfcmp(d, 3); break;
    case 0x5D: vget(rn); vfo(d, 0); vget(rm); vfo(d, 0); vfcmp(d, 5); break;
    case 0x7D: vget(rn); vfo(d, 0); vget(rm); vfo(d, 0); vfcmp(d, 3); break;
    case 0x1E: vget(rn); vget(rm); vfo(d, 9); break;
    case 0x3E: vget(rn); vget(rm); vfo(d, 8); break;
    case 0x5F: vget(rn); vget(rm); vfo(d, 7); break;
    case 0x5E: case 0x7E: {   // FMAXP / FMINP
      if (scalar) return false;
      let e = d ? 8 : 4;
      pairSh(e, Q, 0); vget(rn); vget(rm); shuffle();
      pairSh(e, Q, 1); vget(rn); vget(rm); shuffle();
      vfo(d, a ? 8 : 9); break;
    }
    case 0x18: case 0x38: { // FMAXNM / FMINNM
      vget(rn); vget(rm); vMinMaxNum(d, a == 0);
      break;
    }
    case 0x58: case 0x78: { // FMAXNMP / FMINNMP
      if (scalar) return false;
      let e = d ? 8 : 4;
      pairSh(e, Q, 0); vget(rn); vget(rm); shuffle();
      pairSh(e, Q, 1); vget(rn); vget(rm); shuffle();
      vMinMaxNum(d, a == 0);
      break;
    }
    default: return false;
  }
  finish(rd, fm);
  return true;
}

// stack: a b -> FMAXNM/FMINNM per lane
function vMinMaxNum(d: bool, isMax: bool): void {
  let A = tv(0), B = tv(1), R = tv(2);
  let q: u64 = d ? 0x0008000000000000 : 0x0040000000400000;
  lset(B); lset(A);
  lget(A); lget(B); vfo(d, isMax ? 9 : 8); lset(R);
  lget(B); lget(R);
  lget(A); lget(A); vfcmp(d, 1); lget(B); lget(B); vfcmp(d, 0); simd(0x4E);
  lget(A); v128c(q, q); simd(0x4E); v128c(q, q); simd(d ? 0xD6 : 0x37); simd(0x4E);
  simd(0x52); lset(R);
  lget(A); lget(R);
  lget(B); lget(B); vfcmp(d, 1); lget(A); lget(A); vfcmp(d, 0); simd(0x4E);
  lget(B); v128c(q, q); simd(0x4E); v128c(q, q); simd(d ? 0xD6 : 0x37); simd(0x4E);
  simd(0x52);
}

// stack: a b -> SQDMULH / SQRDMULH per lane (sz 1 or 2)
function vqdmulh(sz: u32, round: bool): void {
  if (sz == 1) {
    if (round) { simd(0x82); return; }
    let A = tv(0), B = tv(1);
    lset(B); lset(A);
    lget(A); lget(B); simd(0xBC); i32c(15); simd(0xAC);
    lget(A); lget(B); simd(0xBD); i32c(15); simd(0xAC);
    simd(0x85);
    return;
  }
  let A = tv(0), B = tv(1);
  lset(B); lset(A);
  lget(A); lget(B); simd(0xDC); if (round) { v128c(1 << 30, 1 << 30); simd(0xCE); } i32c(31); simd(0xCC);
  lget(A); lget(B); simd(0xDD); if (round) { v128c(1 << 30, 1 << 30); simd(0xCE); } i32c(31); simd(0xCC);
  for (let j = 0; j < 4; j++) { SH[j] = <u8>j; SH[4 + j] = <u8>(8 + j); SH[8 + j] = <u8>(16 + j); SH[12 + j] = <u8>(24 + j); }
  shuffle();
  lget(A); laneConst(2, 0x80000000); simd(0x37); lget(B); laneConst(2, 0x80000000); simd(0x37); simd(0x4E);
  simd(0x51);
}

// saturating shift left by immediate, lane by lane. stack: v -> v'
function satShl(sz: u32, srcS: bool, dstS: bool, sh: u32): void {
  let n: i32 = 16 >> sz, esize: u32 = 8 << sz;
  let ex: u32 = sz == 0 ? (srcS ? 0x15 : 0x16) : sz == 1 ? (srcS ? 0x18 : 0x19) : sz == 2 ? 0x1B : 0x1D;
  let rep: u32 = sz == 0 ? 0x17 : sz == 1 ? 0x1A : sz == 2 ? 0x1C : 0x1E;
  let V = tv(5), R = tv(6), x = t64(0), r = t64(1);
  lset(V); v128c(0, 0); lset(R);
  for (let l = 0; l < n; l++) {
    lget(R);
    lget(V); simd(ex); b(l); if (sz != 3) b(srcS ? 0xAC : 0xAD); lset(x);
    if (sz != 3) {
      let lo: i64 = dstS ? -(<i64>1 << (esize - 1)) : 0;
      let hi: i64 = dstS ? (<i64>1 << (esize - 1)) - 1 : (<i64>1 << esize) - 1;
      lget(x); i64c(sh); b(0x86); lset(r);
      lget(r); i64c(lo); lget(r); i64c(lo); b(0x55); b(0x1B); lset(r);
      lget(r); i64c(hi); lget(r); i64c(hi); b(0x53); b(0x1B);
      b(0xA7);
    } else {
      lget(x); i64c(sh); b(0x86); lset(r);
      if (srcS && dstS) {
        // overflow if (r >> sh) != x
        lget(r);
        i64c(0x7FFFFFFFFFFFFFFF); lget(x); i64c(63); b(0x87); b(0x85);
        lget(r); i64c(sh); b(0x87); lget(x); b(0x51); b(0x1B);
      } else if (!srcS) {
        lget(r); i64c(-1); lget(r); i64c(sh); b(0x88); lget(x); b(0x51); b(0x1B);
      } else {
        // signed -> unsigned: negative -> 0, else unsigned saturation
        lget(r); i64c(-1); lget(r); i64c(sh); b(0x88); lget(x); b(0x51); b(0x1B);
        i64c(0); lget(x); i64c(0); b(0x59); b(0x1B);
      }
    }
    simd(rep); b(l); lset(R);
  }
  lget(R);
}

function threeSame(insn: u32, scalar: bool): bool {
  let Q = ((insn >> 30) & 1) != 0, U = ((insn >> 29) & 1) != 0, sz = (insn >> 22) & 3;
  let opcode = (insn >> 11) & 31;
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31), rm = <i32>((insn >> 16) & 31);
  if (opcode >= 0x18) return threeSameFp(insn, scalar);
  let fm: i32 = scalar ? scalarFm(sz) : (Q ? 0 : 1);
  if (scalar && sz != 3 && opcode != 1 && opcode != 5 && opcode != 0x16) return false;
  if (!scalar && sz == 3 && !Q && opcode != 3) return false;
  switch (opcode) {
    case 1: case 5: { // SQADD/UQADD, SQSUB/UQSUB
      let sub = opcode == 5;
      if (sz < 2) { vget(rn); vget(rm); vi(sz, sub ? (U ? 0x13 : 0x12) : (U ? 0x10 : 0x0F)); break; }
      let A = tv(0), B = tv(1), R = tv(2);
      vget(rn); lset(A); vget(rm); lset(B);
      lget(A); lget(B); vi(sz, sub ? 0x11 : 0x0E); lset(R);
      if (U) {
        // unsigned: add overflows if r <u a ; sub underflows if a <u b
        if (sub) { v128c(0, 0); lget(R); } else { laneConst(sz, ~(<u64>0)); lget(R); }
        let sign: u64 = sz == 2 ? 0x80000000 : 0x8000000000000000;
        if (sub) { lget(A); laneConst(sz, sign); simd(0x51); lget(B); laneConst(sz, sign); simd(0x51); vcmp(sz, 2); }
        else { lget(R); laneConst(sz, sign); simd(0x51); lget(A); laneConst(sz, sign); simd(0x51); vcmp(sz, 2); }
        simd(0x52);
      } else {
        // signed overflow: add: (a^r)&(b^r) < 0 ; sub: (a^b)&(a^r) < 0 ; saturate to MAX ^ (a >> 63)
        lget(A); i32c(sz == 2 ? 31 : 63); vi(sz, 0xC); laneConst(sz, sz == 2 ? 0x7FFFFFFF : 0x7FFFFFFFFFFFFFFF); simd(0x51);
        lget(R);
        lget(A); lget(sub ? B : R); simd(0x51); lget(sub ? A : B); lget(R); simd(0x51); simd(0x4E);
        i32c(sz == 2 ? 31 : 63); vi(sz, 0xC);
        simd(0x52);
      }
      break;
    }
    case 3: {
      if (scalar) return false;
      if (!U) {
        vget(rn); vget(rm);
        if (sz == 0) simd(0x4E); else if (sz == 1) simd(0x4F); else if (sz == 2) simd(0x50); else { simd(0x4D); simd(0x50); }
      } else if (sz == 0) { vget(rn); vget(rm); simd(0x51); }
      else if (sz == 1) { vget(rn); vget(rm); vget(rd); simd(0x52); }
      else if (sz == 2) { vget(rn); vget(rd); vget(rm); simd(0x52); }
      else { vget(rd); vget(rn); vget(rm); simd(0x52); }
      break;
    }
    case 6: case 7: {
      let ge = opcode == 7;
      if (U && sz == 3) {
        vget(rn); laneConst(3, 0x8000000000000000); simd(0x51);
        vget(rm); laneConst(3, 0x8000000000000000); simd(0x51);
        vcmp(3, ge ? 8 : 4);
      } else { vget(rn); vget(rm); vcmp(sz, ge ? (U ? 9 : 8) : (U ? 5 : 4)); }
      break;
    }
    case 12: if (sz == 3) return false; vget(rn); vget(rm); vi(sz, U ? 0x19 : 0x18); break;
    case 13: if (sz == 3) return false; vget(rn); vget(rm); vi(sz, U ? 0x17 : 0x16); break;
    case 14: case 15: { // SABD/UABD, SABA/UABA
      if (sz == 3) return false;
      if (opcode == 15) vget(rd);
      vget(rn); vget(rm); vi(sz, U ? 0x19 : 0x18); vget(rn); vget(rm); vi(sz, U ? 0x17 : 0x16); vi(sz, 0x11);
      if (opcode == 15) vi(sz, 0x0E);
      break;
    }
    case 16: vget(rn); vget(rm); vi(sz, U ? 0x11 : 0x0E); break;
    case 17:
      vget(rn); vget(rm);
      if (U) vcmp(sz, 0); else { simd(0x4E); v128c(0, 0); vcmp(sz, 1); }
      break;
    case 18: if (sz == 3) return false; vget(rd); vget(rn); vget(rm); vmul(sz); vi(sz, U ? 0x11 : 0x0E); break;
    case 19: if (sz == 3 || U) return false; vget(rn); vget(rm); vmul(sz); break;
    case 20: case 21: case 23: { // SMAXP/UMAXP, SMINP/UMINP, ADDP
      if (scalar || (opcode == 23 && U) || (opcode != 23 && sz == 3)) return false;
      let e: i32 = 1 << sz;
      pairSh(e, Q, 0); vget(rn); vget(rm); shuffle();
      pairSh(e, Q, 1); vget(rn); vget(rm); shuffle();
      if (opcode == 23) vi(sz, 0x0E); else if (opcode == 20) vi(sz, U ? 0x19 : 0x18); else vi(sz, U ? 0x17 : 0x16);
      break;
    }
    case 2: { // SRHADD / URHADD
      if (sz == 3) return false;
      if (U && sz < 2) { vget(rn); vget(rm); vi(sz, 0x1B); break; }
      // (a >> 1) + (b >> 1) + ((a | b) & 1)
      vget(rn); i32c(1); vi(sz, U ? 0xD : 0xC); vget(rm); i32c(1); vi(sz, U ? 0xD : 0xC); vi(sz, 0xE);
      vget(rn); vget(rm); simd(0x50); laneConst(sz, 1); simd(0x4E); vi(sz, 0xE);
      break;
    }
    case 0: case 4: { // SHADD/UHADD, SHSUB/UHSUB
      if (sz == 3) return false;
      let sub = opcode == 4;
      // add: (a >> 1) + (b >> 1) + (a & b & 1) ; sub: (a >> 1) - (b >> 1) - (~a & b & 1)
      vget(rn); i32c(1); vi(sz, U ? 0xD : 0xC); vget(rm); i32c(1); vi(sz, U ? 0xD : 0xC); vi(sz, sub ? 0x11 : 0xE);
      if (sub) { vget(rm); vget(rn); simd(0x4F); } else { vget(rn); vget(rm); simd(0x4E); }
      laneConst(sz, 1); simd(0x4E); vi(sz, sub ? 0x11 : 0xE);
      break;
    }
    case 8: sshl(rn, rm, sz, U, false); break;   // SSHL / USHL
    case 10: sshl(rn, rm, sz, U, true); break;   // SRSHL / URSHL
    case 0x16: if (sz == 0 || sz == 3) return false; vget(rn); vget(rm); vqdmulh(sz, U); break;
    default: return false;
  }
  finish(rd, fm);
  return true;
}

// variable shift, lane by lane through scalar code
function sshl(rn: i32, rm: i32, sz: u32, U: bool, round: bool): void {
  let n: i32 = 16 >> sz;
  let esize: i32 = 8 << sz;
  let ex: u32 = sz == 0 ? (U ? 0x16 : 0x15) : sz == 1 ? (U ? 0x19 : 0x18) : sz == 2 ? 0x1B : 0x1D;
  let rep: u32 = sz == 0 ? 0x17 : sz == 1 ? 0x1A : sz == 2 ? 0x1C : 0x1E;
  let R = tv(6), x = t64(0), s = t64(1);
  v128c(0, 0); lset(R);
  for (let l = 0; l < n; l++) {
    vget(rn); simd(ex); b(l); if (sz == 3) { } else b(U ? 0xAD : 0xAC); lset(x);
    vget(rm); simd(sz == 0 ? 0x15 : sz == 1 ? 0x18 : sz == 2 ? 0x1B : 0x1D); b(l);
    if (sz == 3) b(0xC2); else { b(0xAC); b(0xC2); }
    lset(s);
    // value computed in 64 bits: left if s >= 0 (0 when s >= esize), right otherwise
    lget(R);
    lget(s); i64c(0); b(0x59);
    b(0x04); b(0x7E);
    lget(x); lget(s); b(0x86); i64c(0); lget(s); i64c(esize); b(0x53); b(0x1B);
    b(0x05);
    if (round) {
      let nn = t64(2);
      i64c(0); lget(s); b(0x7D); lset(nn);
      if (U) { lget(x); lget(nn); b(0x88); i64c(0); lget(nn); i64c(64); b(0x53); b(0x1B); }
      else { lget(x); lget(nn); i64c(63); lget(nn); i64c(63); b(0x53); b(0x1B); b(0x87); }
      lget(x); lget(nn); i64c(1); b(0x7D); b(0x88); i64c(1); b(0x83); b(0x7C);
      i64c(0); lget(nn); i64c(esize); b(0x57); b(0x1B);
    } else if (U) {
      lget(x); if (sz < 3) { i64c(sz == 0 ? 0xFF : sz == 1 ? 0xFFFF : 0xFFFFFFFF); b(0x83); }
      i64c(0); lget(s); b(0x7D); b(0x88); i64c(0); lget(s); i64c(-esize); b(0x55); b(0x1B);
    } else {
      // arithmetic: clamp the amount to esize-1... operating on the sign-extended 64-bit value clamp to 63
      lget(x); i64c(0); lget(s); b(0x7D); lset(t64(2)); lget(t64(2)); i64c(63); lget(t64(2)); i64c(63); b(0x53); b(0x1B); b(0x87);
    }
    b(0x0B);
    if (sz != 3) b(0xA7);
    simd(rep); b(l); lset(R);
  }
  lget(R);
}

function twoReg(insn: u32, scalar: bool): bool {
  let Q = ((insn >> 30) & 1) != 0, U = ((insn >> 29) & 1) != 0, sz = (insn >> 22) & 3;
  let opcode = (insn >> 12) & 31;
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31);
  let hi = (sz & 2) != 0, d = (sz & 1) != 0;
  let fm: i32 = scalar ? scalarFm(sz) : (Q ? 0 : 1);
  let ffm: i32 = scalar ? (d ? 1 : 2) : (Q ? 0 : 1);
  if (opcode < 0x0C || opcode == 0x12 || opcode == 0x13 || opcode == 0x14) {
    if (scalar && opcode != 7 && (sz != 3 || opcode < 8 || opcode > 11)) return false;
    if (!scalar && sz == 3 && !Q && opcode >= 8 && opcode <= 11) return false;
    switch (opcode) {
      case 0: case 1: {
        let c: i32 = opcode == 1 ? 2 : U ? 4 : 8, e: i32 = 1 << sz;
        if (e >= c || (opcode == 1 && U)) return false;
        for (let i = 0; i < 16; i++) { let off = i % c; SH[i] = <u8>(i - off + (c - e - (off - off % e)) + off % e); }
        vget(rn); vget(rn); shuffle(); break;
      }
      case 2: case 6: { // SADDLP/UADDLP, SADALP/UADALP
        if (sz == 3) return false;
        if (opcode == 6) vget(rd);
        if (sz == 0) { vget(rn); simd(U ? 0x7D : 0x7C); }
        else if (sz == 1) { vget(rn); simd(U ? 0x7F : 0x7E); }
        else {
          for (let i = 0; i < 16; i++) SH[i] = <u8>(i < 4 ? i : i < 8 ? i + 4 : 0);
          vget(rn); vget(rn); shuffle(); vext(3, false, U);
          for (let i = 0; i < 16; i++) SH[i] = <u8>(i < 4 ? i + 4 : i < 8 ? i + 8 : 0);
          vget(rn); vget(rn); shuffle(); vext(3, false, U);
          vi(3, 0xE);
        }
        if (opcode == 6) vi(sz + 1, 0xE);
        break;
      }
      case 5:
        if (!U && sz == 0) { vget(rn); simd(0x62); }
        else if (U && sz == 0) { vget(rn); simd(0x4D); }
        else if (U && sz == 1) {
          // RBIT: nibble lookup
          v128c(0x0E060A020C040800, 0x0F070B030D050901); vget(rn); i32c(4); simd(0x6D); simd(0x0E);
          v128c(0xE060A020C0408000, 0xF070B030D0509010); vget(rn); v128c(0x0F0F0F0F0F0F0F0F, 0x0F0F0F0F0F0F0F0F); simd(0x4E); simd(0x0E);
          simd(0x50);
        } else return false;
        break;
      case 7: { // SQABS / SQNEG
        if (!scalar && sz == 3 && !Q) return false;
        let T = tv(4);
        vget(rn); vi(sz, U ? 1 : 0); ltee(T); lget(T); laneConst(sz, <u64>1 << ((8 << sz) - 1)); vcmp(sz, 0); vi(sz, 0xE);
        break;
      }
      case 8: vget(rn); v128c(0, 0); vcmp(sz, U ? 8 : 4); break;
      case 9: vget(rn); v128c(0, 0); vcmp(sz, U ? 6 : 0); break;
      case 10: if (U) return false; vget(rn); v128c(0, 0); vcmp(sz, 2); break;
      case 11: vget(rn); vi(sz, U ? 1 : 0); break;
      case 0x12: if (sz == 3 || scalar) return false; vget(rn); if (U) satNarrowTo(sz, Q, rd, true, false); else narrowTo(sz, Q, rd); return true;
      case 0x14: if (sz == 3 || scalar) return false; vget(rn); satNarrowTo(sz, Q, rd, !U, !U); return true;
      case 0x13: if (!U || sz == 3) return false; vget(rn); vext(sz + 1, Q, true); i32c(8 << sz); vi(sz + 1, 0xB); vset(rd); return true;
      case 4: { // CLS / CLZ, lane by lane
        if (sz == 3) return false;
        let n: i32 = 16 >> sz, es: i32 = 8 << sz;
        let R = tv(6), x = t32(0);
        v128c(0, 0); lset(R);
        for (let l = 0; l < n; l++) {
          lget(R);
          vget(rn); simd(sz == 0 ? (U ? 0x16 : 0x15) : sz == 1 ? (U ? 0x19 : 0x18) : 0x1B); b(l);
          if (!U) { ltee(x); lget(x); i32c(1); b(0x75); b(0x73); b(0x67); i32c(32 - es + 1); b(0x6B); }
          else { b(0x67); if (es != 32) { i32c(32 - es); b(0x6B); } }
          simd(sz == 0 ? 0x17 : sz == 1 ? 0x1A : 0x1C); b(l); lset(R);
        }
        lget(R);
        break;
      }
      default: return false;
    }
    finish(rd, fm);
    return true;
  }
  // floating point
  if (!scalar && d && !Q && opcode != 0x16 && opcode != 0x17) return false;
  switch (opcode) {
    case 0x0C: if (!hi) return false; vget(rn); v128c(0, 0); vfcmp(d, U ? 5 : 3); break;
    case 0x0D: if (!hi) return false; vget(rn); v128c(0, 0); vfcmp(d, U ? 4 : 0); break;
    case 0x0E: if (!hi || U) return false; vget(rn); v128c(0, 0); vfcmp(d, 2); break;
    case 0x0F: if (!hi) return false; vget(rn); vfo(d, U ? 1 : 0); break;
    case 0x18: if (hi && U) return false; vget(rn); vround(d, hi ? 1 : U ? 4 : 0); break;
    case 0x19: vget(rn); vround(d, hi ? (U ? 0 : 3) : (U ? 0 : 2)); break;
    case 0x1A: case 0x1B: case 0x1C: {
      if (opcode == 0x1C && hi) return false;
      let mode: u32 = opcode == 0x1C ? 4 : opcode == 0x1A ? (hi ? 1 : 0) : (hi ? 3 : 2);
      vget(rn);
      if (d || mode == 4) lanewise(0, d, U, mode, 0);
      else { if (mode != 3) vround(false, mode); simd(U ? 0xF9 : 0xF8); }
      break;
    }
    case 0x1D:
      if (hi) return false;
      vget(rn);
      if (d) lanewise(1, true, U, 0, 0); else simd(U ? 0xFB : 0xFA);
      break;
    case 0x1F: if (!hi || !U) return false; vget(rn); vfo(d, 3); break;
    case 0x16: { // FCVTN / FCVTN2
      if (scalar || U || hi || !d) return false;
      vget(rn); simd(0x5E);
      if (Q) {
        let W = tv(4);
        lset(W); vget(rd); lget(W);
        for (let j = 0; j < 8; j++) { SH[j] = <u8>j; SH[8 + j] = <u8>(16 + j); }
        shuffle();
      }
      vset(rd);
      return true;
    }
    case 0x17: { // FCVTL / FCVTL2
      if (scalar || U || hi || !d) return false;
      vget(rn);
      if (Q) { vget(rn); for (let j = 0; j < 16; j++) SH[j] = <u8>(8 + (j & 7)); shuffle(); }
      simd(0x5F); vset(rd);
      return true;
    }
    default: return false;
  }
  finish(rd, ffm);
  return true;
}

function across(insn: u32): bool {
  let Q = ((insn >> 30) & 1) != 0, U = ((insn >> 29) & 1) != 0, sz = (insn >> 22) & 3;
  let opcode = (insn >> 12) & 31;
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31);
  let S = tv(0);
  if (U && (opcode == 0x0F || opcode == 0x0C)) { // FMAXV / FMINV / FMAXNMV / FMINNMV (4S)
    if (!Q || (sz & 1)) return false;
    let isMin = (sz & 2) != 0;
    for (let l = 0; l < 4; l++) {
      vget(rn); simd(0x1F); b(l);
      if (l & 1) { if (opcode == 0x0F) b(isMin ? 0x96 : 0x97); else minMaxNum(false, !isMin); }
      if (l == 1) lset(tf32(5));
    }
    lset(tf32(6)); lget(tf32(5)); lget(tf32(6));
    if (opcode == 0x0F) b(isMin ? 0x96 : 0x97); else minMaxNum(false, !isMin);
    setF(rd, false);
    return true;
  }
  if (sz == 3 || (sz == 2 && !Q)) return false;
  if (opcode == 0x1B || opcode == 0x03) {
    let long = opcode == 3;
    if (!long && U) return false;
    vget(rn);
    if (!Q) { v128c(~(<u64>0), 0); simd(0x4E); }
    if (sz == 2 && long) {
      lset(S);
      for (let l = 0; l < 4; l++) { lget(S); simd(0x1B); b(l); b(U ? 0xAD : 0xAC); if (l) b(0x7C); }
      setVint(rd, true);
      return true;
    }
    if (sz == 0) { simd(long && !U ? 0x7C : 0x7D); simd(long && !U ? 0x7E : 0x7F); }
    else if (sz == 1) simd(long && !U ? 0x7E : 0x7F);
    lset(S);
    for (let l = 0; l < 4; l++) { lget(S); simd(0x1B); b(l); if (l) b(0x6A); }
    if (sz == 0) { i32c(long ? 0xFFFF : 0xFF); b(0x71); }
    else if (sz == 1 && !long) { i32c(0xFFFF); b(0x71); }
    setVint(rd, false);
    return true;
  }
  if (opcode == 0x0A || opcode == 0x1A) {
    let o: u32 = opcode == 0x0A ? (U ? 0x19 : 0x18) : (U ? 0x17 : 0x16);
    vget(rn);
    if (!Q) { vget(rn); for (let i = 0; i < 16; i++) SH[i] = <u8>(i & 7); shuffle(); }
    lset(S);
    for (let step: i32 = 8; step >= (1 << sz); step >>= 1) {
      lget(S); lget(S); lget(S);
      for (let i = 0; i < 16; i++) SH[i] = <u8>((i + step) & 15);
      shuffle(); vi(sz, o); lset(S);
    }
    lget(S); simd(sz == 0 ? 0x16 : sz == 1 ? 0x19 : 0x1B); b(0);
    setVint(rd, false);
    return true;
  }
  return false;
}

function scalarPairwise(insn: u32): bool {
  let U = ((insn >> 29) & 1) != 0, sz = (insn >> 22) & 3, opcode = (insn >> 12) & 31;
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31);
  if (opcode == 0x1B && !U && sz == 3) {
    vget(rn); simd(0x1D); b(0); vget(rn); simd(0x1D); b(1); b(0x7C); setVint(rd, true);
    return true;
  }
  if (!U) return false;
  let d = (sz & 1) != 0, hi = (sz & 2) != 0;
  let ex: u32 = d ? 0x21 : 0x1F;
  vget(rn); simd(ex); b(0); vget(rn); simd(ex); b(1);
  switch (opcode) {
    case 0x0D: if (hi) return false; b(d ? 0xA0 : 0x92); break;
    case 0x0F: b(d ? (hi ? 0xA4 : 0xA5) : (hi ? 0x96 : 0x97)); break;
    case 0x0C: minMaxNum(d, !hi); break;
    default: return false;
  }
  setF(rd, d);
  return true;
}

function copy(insn: u32, scalar: bool): bool {
  let Q = ((insn >> 30) & 1) != 0, op = ((insn >> 29) & 1) != 0;
  let imm5 = (insn >> 16) & 31, imm4 = (insn >> 11) & 15;
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31);
  if ((imm5 & 15) == 0) return false;
  let sz: u32 = ctz<u32>(imm5);
  let idx = imm5 >> (sz + 1);
  let exU: u32 = sz == 0 ? 0x16 : sz == 1 ? 0x19 : sz == 2 ? 0x1B : 0x1D;
  let rep: u32 = sz == 0 ? 0x17 : sz == 1 ? 0x1A : sz == 2 ? 0x1C : 0x1E;
  if (scalar) {
    if (op || imm4 != 0) return false;
    vget(rn); simd(exU); b(idx);
    if (sz == 3) setVint(rd, true); else setVint(rd, false);
    return true;
  }
  if (op) { // INS element
    if (!Q) return false;
    let idx2 = imm4 >> sz;
    vget(rd); vget(rn); simd(exU); b(idx2); simd(rep); b(idx); vset(rd);
    return true;
  }
  switch (imm4) {
    case 0: // DUP element
      if (sz == 3 && !Q) return false;
      vget(rn); simd(exU); b(idx); simd(0x0F + sz); finish(rd, Q ? 0 : 1); return true;
    case 1: // DUP general
      if (sz == 3 && !Q) return false;
      getX(rn, sz == 3); simd(0x0F + sz); finish(rd, Q ? 0 : 1); return true;
    case 3: // INS general
      if (!Q) return false;
      vget(rd); getX(rn, sz == 3); simd(rep); b(idx); vset(rd); return true;
    case 5: // SMOV
      if (sz == 3 || (!Q && sz == 2)) return false;
      vget(rn); simd(sz == 0 ? 0x15 : sz == 1 ? 0x18 : 0x1B); b(idx);
      if (Q) { b(0xAC); setX(rd, true); } else setX(rd, false);
      return true;
    case 7: // UMOV
      if (Q != (sz == 3)) return false;
      vget(rn); simd(exU); b(idx); setX(rd, sz == 3);
      return true;
  }
  return false;
}

function modImm(insn: u32): bool {
  let Q = ((insn >> 30) & 1) != 0, op = ((insn >> 29) & 1) != 0, cmode = (insn >> 12) & 15;
  let rd = <i32>(insn & 31);
  if (insn & 0x800) return false;
  let imm8: u64 = (((insn >> 16) & 7) << 5) | ((insn >> 5) & 31);
  let imm: u64 = 0;
  let kind = 0; // 0 mov, 1 mvn, 2 orr, 3 bic
  switch (cmode >> 1) {
    case 0: case 1: case 2: case 3:
      imm = imm8 << (8 * (cmode >> 1)); imm |= imm << 32;
      kind = (cmode & 1) ? (op ? 3 : 2) : (op ? 1 : 0); break;
    case 4: case 5:
      imm = imm8 << (8 * ((cmode >> 1) & 1)); imm |= imm << 16; imm |= imm << 32;
      kind = (cmode & 1) ? (op ? 3 : 2) : (op ? 1 : 0); break;
    case 6:
      imm = (cmode & 1) ? ((imm8 << 16) | 0xFFFF) : ((imm8 << 8) | 0xFF); imm |= imm << 32;
      kind = op ? 1 : 0; break;
    default:
      if ((cmode & 1) == 0) {
        if (!op) { imm = imm8 * 0x0101010101010101; }
        else { for (let i = 0; i < 8; i++) if ((imm8 >> i) & 1) imm |= <u64>0xFF << (8 * i); }
      } else {
        if (!op) { imm = vfpExpand32(<u32>imm8); imm |= imm << 32; }
        else { if (!Q) return false; imm = vfpExpand64(<u32>imm8); }
      }
  }
  if (kind == 1) imm = ~imm;
  if (kind < 2) { v128c(imm, Q ? imm : 0); vset(rd); return true; }
  vget(rd); v128c(imm, imm); simd(kind == 2 ? 0x50 : 0x4F);
  finish(rd, Q ? 0 : 1);
  return true;
}

function shiftImm(insn: u32, scalar: bool): bool {
  let Q = ((insn >> 30) & 1) != 0, U = ((insn >> 29) & 1) != 0;
  let immh = (insn >> 19) & 15, immhb = (insn >> 16) & 0x7F, opcode = (insn >> 11) & 31;
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31);
  let sz: u32 = immh >= 8 ? 3 : immh >= 4 ? 2 : immh >= 2 ? 1 : 0;
  let esize: u32 = 8 << sz;
  let rsh: u32 = 2 * esize - immhb, lsh: u32 = immhb - esize;
  let fm: i32 = scalar ? scalarFm(sz) : (Q ? 0 : 1);
  if (opcode < 0x10) {
    if (scalar && sz != 3 && opcode != 0x0C && opcode != 0x0E) return false;
    if (!scalar && sz == 3 && !Q) return false;
  }
  switch (opcode) {
    case 0: vget(rn); vshr(sz, U, rsh); break;
    case 2: vget(rd); vget(rn); vshr(sz, U, rsh); vi(sz, 0xE); break;
    case 4: vget(rn); vrshr(sz, U, rsh); break;
    case 6: vget(rd); vget(rn); vrshr(sz, U, rsh); vi(sz, 0xE); break;
    case 8: { // SRI
      if (!U) return false;
      if (rsh >= esize) { vget(rd); break; }
      let m: u64 = (esize == 64 ? ~(<u64>0) : ((<u64>1 << esize) - 1)) >> rsh;
      vget(rn); i32c(rsh); vi(sz, 0xD); vget(rd); laneConst(sz, m); simd(0x4F); simd(0x50);
      break;
    }
    case 10: {
      if (!U) { vget(rn); if (lsh) { i32c(lsh); vi(sz, 0xB); } break; }
      let m: u64 = (<u64>1 << lsh) - 1;   // SLI
      vget(rn); i32c(lsh); vi(sz, 0xB); vget(rd); laneConst(sz, m); simd(0x4E); simd(0x50);
      break;
    }
    case 0x0C: if (!U) return false; vget(rn); satShl(sz, true, false, lsh); break;   // SQSHLU
    case 0x0E: vget(rn); satShl(sz, !U, !U, lsh); break;                               // SQSHL / UQSHL
    case 0x10: case 0x11: { // SHRN / RSHRN, SQSHRUN / SQRSHRUN
      if (scalar || sz == 3) return false;
      vget(rn);
      if (U) { if (opcode == 0x10) vshr(sz + 1, false, rsh); else vrshr(sz + 1, false, rsh); satNarrowTo(sz, Q, rd, true, false); return true; }
      if (opcode == 0x10) { i32c(rsh); vi(sz + 1, 0xD); } else vrshr(sz + 1, true, rsh);
      narrowTo(sz, Q, rd);
      return true;
    }
    case 0x12: case 0x13: { // SQSHRN / UQSHRN, SQRSHRN / UQRSHRN
      if (scalar || sz == 3) return false;
      vget(rn);
      if (opcode == 0x12) vshr(sz + 1, U, rsh); else vrshr(sz + 1, U, rsh);
      satNarrowTo(sz, Q, rd, !U, !U);
      return true;
    }
    case 0x14: { // SSHLL / USHLL
      if (scalar || sz == 3) return false;
      vget(rn); vext(sz + 1, Q, U);
      if (lsh) { i32c(lsh); vi(sz + 1, 0xB); }
      vset(rd);
      return true;
    }
    case 0x1C: { // SCVTF / UCVTF fixed-point
      if (sz < 2) return false;
      if (!scalar && sz == 3 && !Q) return false;
      vget(rn);
      if (sz == 3) lanewise(4, true, U, 0, rsh);
      else { simd(U ? 0xFB : 0xFA); let k: u32 = <u32>(127 - rsh) << 23; v128c(<u64>k | (<u64>k << 32), <u64>k | (<u64>k << 32)); simd(0xE6); }
      break;
    }
    case 0x1F: { // FCVTZS / FCVTZU fixed-point
      if (sz < 2) return false;
      if (!scalar && sz == 3 && !Q) return false;
      vget(rn);
      if (sz == 3) lanewise(3, true, U, 3, rsh);
      else { let k: u32 = <u32>(127 + rsh) << 23; v128c(<u64>k | (<u64>k << 32), <u64>k | (<u64>k << 32)); simd(0xE6); simd(U ? 0xF9 : 0xF8); }
      break;
    }
    default: return false;
  }
  finish(rd, fm);
  return true;
}

function threeDiff(insn: u32): bool {
  let Q = ((insn >> 30) & 1) != 0, U = ((insn >> 29) & 1) != 0, sz = (insn >> 22) & 3;
  let opcode = (insn >> 12) & 15;
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31), rm = <i32>((insn >> 16) & 31);
  if (sz == 3) return false;
  let w = sz + 1;
  switch (opcode) {
    case 0: case 2: vget(rn); vext(w, Q, U); vget(rm); vext(w, Q, U); vi(w, opcode ? 0x11 : 0xE); break;
    case 1: case 3: vget(rn); vget(rm); vext(w, Q, U); vi(w, opcode == 3 ? 0x11 : 0xE); break;
    case 8: case 10: vget(rd); vget(rn); vget(rm); vextmul(w, Q, U); vi(w, opcode == 10 ? 0x11 : 0xE); break;
    case 12: vget(rn); vget(rm); vextmul(w, Q, U); break;
    case 5: case 7: { // SABAL/UABAL, SABDL/UABDL
      let A = tv(0), B = tv(1);
      vget(rn); vext(w, Q, U); lset(A); vget(rm); vext(w, Q, U); lset(B);
      if (opcode == 5) vget(rd);
      // |a - b| on widened values: max - min (signed compare is right for both after widening, except 64-bit lanes)
      if (w < 3) { lget(A); lget(B); vi(w, 0x18); lget(A); lget(B); vi(w, 0x16); vi(w, 0x11); }
      else {
        lget(A); lget(B); vi(3, 0x11); lget(B); lget(A); vi(3, 0x11); lget(A); lget(B); vcmp(3, 4); simd(0x52);
      }
      if (opcode == 5) vi(w, 0xE);
      break;
    }
    case 4: case 6: { // ADDHN / SUBHN (and rounding variants)
      vget(rn); vget(rm); vi(w, opcode == 6 ? 0x11 : 0xE);
      if (U) { laneConst(w, <u64>1 << ((8 << sz) - 1)); vi(w, 0xE); }
      i32c(8 << sz); vi(w, 0xD);
      narrowTo(sz, Q, rd);
      return true;
    }
    default: return false;
  }
  vset(rd);
  return true;
}

function indexed(insn: u32, scalar: bool): bool {
  let Q = ((insn >> 30) & 1) != 0, U = ((insn >> 29) & 1) != 0, sz = (insn >> 22) & 3;
  let opcode = (insn >> 12) & 15;
  let L = (insn >> 21) & 1, M = (insn >> 20) & 1, H = (insn >> 11) & 1;
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31), rm = <i32>((insn >> 16) & 15);
  let E = tv(2);
  let isF = !U && (opcode == 1 || opcode == 5 || opcode == 9);
  let idx: u32;
  if (isF) {
    if (sz < 2) return false;
    let d = sz == 3;
    rm |= <i32>(M << 4);
    if (d) { if (L) return false; idx = H; } else idx = (H << 1) | L;
    if (!scalar && d && !Q) return false;
    vget(rm); simd(d ? 0x1D : 0x1B); b(idx); simd(d ? 0x12 : 0x11); lset(E);
    if (opcode == 9) { vget(rn); lget(E); vfo(d, 6); }
    else { vget(rn); lget(E); vget(rd); vfma(d, opcode == 5); }
    finish(rd, scalar ? (d ? 1 : 2) : (Q ? 0 : 1));
    return true;
  }
  if (scalar) return false;
  if (sz == 1) idx = (H << 2) | (L << 1) | M;
  else if (sz == 2) { idx = (H << 1) | L; rm |= <i32>(M << 4); }
  else return false;
  vget(rm); simd(sz == 1 ? 0x19 : 0x1B); b(idx); simd(0x0F + sz); lset(E);
  let w = sz + 1;
  if (!U && opcode == 8) { vget(rn); lget(E); vi(sz, 0x15); finish(rd, Q ? 0 : 1); return true; }
  if (U && (opcode == 0 || opcode == 4)) { vget(rd); vget(rn); lget(E); vi(sz, 0x15); vi(sz, opcode == 4 ? 0x11 : 0xE); finish(rd, Q ? 0 : 1); return true; }
  if (!U && (opcode == 12 || opcode == 13)) { vget(rn); lget(E); vqdmulh(sz, opcode == 13); finish(rd, Q ? 0 : 1); return true; }
  if (opcode == 10) { vget(rn); lget(E); vextmul(w, Q, U); vset(rd); return true; }
  if (opcode == 2 || opcode == 6) { vget(rd); vget(rn); lget(E); vextmul(w, Q, U); vi(w, opcode == 6 ? 0x11 : 0xE); vset(rd); return true; }
  return false;
}

function tbl(insn: u32): bool {
  let Q = ((insn >> 30) & 1) != 0, len = ((insn >> 13) & 3) + 1, isTbx = ((insn >> 12) & 1) != 0;
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31), rm = <i32>((insn >> 16) & 31);
  if ((insn >> 22) & 3) return false;
  for (let i: u32 = 0; i < len; i++) {
    vget((rn + <i32>i) & 31); vget(rm);
    if (i) { laneConst(0, 16 * i); simd(0x71); }
    simd(0x0E);
    if (i) simd(0x50);
  }
  if (isTbx) { vget(rd); vget(rm); laneConst(0, 16 * len); simd(0x26); simd(0x52); }
  finish(rd, Q ? 0 : 1);
  return true;
}

function permute(insn: u32): bool {
  let Q = ((insn >> 30) & 1) != 0, sz = (insn >> 22) & 3, opcode = (insn >> 12) & 7;
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31), rm = <i32>((insn >> 16) & 31);
  if ((opcode & 3) == 0 || (sz == 3 && !Q)) return false;
  let e: i32 = 1 << sz, cnt: i32 = (Q ? 16 : 8) / e, part: i32 = opcode >> 2;
  for (let i = 0; i < 16; i++) SH[i] = 0;
  for (let i = 0; i < cnt; i++) {
    let src: i32; // element index in n:m (m elements start at cnt)
    switch (opcode & 3) {
      case 1: src = 2 * i + part; break;                                   // UZP
      case 2: src = (i & 1) ? cnt + (i & ~1) + part : (i & ~1) + part; break; // TRN
      default: src = (i & 1) ? cnt + (i >> 1) + part * (cnt / 2) : (i >> 1) + part * (cnt / 2); break; // ZIP
    }
    let base = src >= cnt ? 16 + (src - cnt) * e : src * e;
    for (let k = 0; k < e; k++) SH[i * e + k] = <u8>(base + k);
  }
  vget(rn); vget(rm); shuffle();
  finish(rd, Q ? 0 : 1);
  return true;
}

function ext(insn: u32): bool {
  let Q = ((insn >> 30) & 1) != 0, imm4: i32 = (insn >> 11) & 15;
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31), rm = <i32>((insn >> 16) & 31);
  if (!Q && imm4 >= 8) return false;
  for (let i = 0; i < 16; i++) {
    let j = imm4 + i;
    if (Q) SH[i] = <u8>j;
    else SH[i] = i < 8 ? <u8>(j < 8 ? j : 16 + (j - 8)) : 0;
  }
  vget(rn); vget(rm); shuffle();
  finish(rd, Q ? 0 : 1);
  return true;
}

export function trSimd(pc: u64, insn: u32): bool {
  let scalar = ((insn >> 28) & 1) != 0;
  if (scalar) { if ((insn >>> 30) != 1) return false; }
  else if (insn >>> 31) return false;
  let U = (insn >> 29) & 1;
  if ((insn & (1 << 24)) == 0) {
    if ((insn & (1 << 21)) == 0) {
      if ((insn & 0x00E08400) == 0x00000400) return copy(insn, scalar);
      if (scalar || (insn & 0x8000) != 0) return false;
      let lo = (insn >> 10) & 3;
      if (!U && lo == 0) return tbl(insn);
      if (!U && lo == 2) return permute(insn);
      if (U && (lo & 1) == 0 && ((insn >> 22) & 3) == 0) return ext(insn);
      return false;
    }
    if (insn & 0x400) return threeSame(insn, scalar);
    if (((insn >> 10) & 3) == 2) {
      let g = (insn >> 17) & 15;
      if (g == 0) return twoReg(insn, scalar);
      if (g == 8) return scalar ? scalarPairwise(insn) : across(insn);
      return false;
    }
    if (((insn >> 10) & 3) == 0 && !scalar) return threeDiff(insn);
    return false;
  }
  if (insn & 0x400) {
    if (insn & (1 << 23)) return false;
    if (((insn >> 19) & 15) == 0) return scalar ? false : modImm(insn);
    return shiftImm(insn, scalar);
  }
  return indexed(insn, scalar);
}
