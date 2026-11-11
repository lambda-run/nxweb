// Bit-exact AArch64 FP arithmetic for a non-default FPCR (RMode != RN, FZ or DN set), following the
// ARM ARM pseudocode (FPUnpack, FPProcessNaNs, FPRound). The translator calls it only when
// FPCR & (RMode | FZ | DN) != 0; the default FPCR stays on native Wasm f32/f64 operations.
//
// Formats: fmt 0 = half, 1 = single, 2 = double. FPCR bits: 22..23 RMode, 24 FZ, 25 DN.
// An unpacked finite nonzero value is sig * 2^(exp - 62) with sig's top bit at bit 62.

const C_ZERO = 0, C_NORM = 1, C_INF = 2, C_QNAN = 3, C_SNAN = 4;

// @ts-ignore
@inline function fF(fmt: i32): i32 { return fmt == 2 ? 52 : fmt == 1 ? 23 : 10; }
// @ts-ignore
@inline function fE(fmt: i32): i32 { return fmt == 2 ? 11 : fmt == 1 ? 8 : 5; }
// @ts-ignore
@inline function fBias(fmt: i32): i32 { return (1 << (fE(fmt) - 1)) - 1; }
// @ts-ignore
@inline function fSign(fmt: i32): u64 { return <u64>1 << <u64>(fF(fmt) + fE(fmt)); }
// @ts-ignore
@inline function fInf(fmt: i32): u64 { return <u64>((1 << fE(fmt)) - 1) << <u64>fF(fmt); }
// @ts-ignore
@inline function fQuiet(fmt: i32): u64 { return <u64>1 << <u64>(fF(fmt) - 1); }
function defNaN(fmt: i32): u64 { return fInf(fmt) | fQuiet(fmt); }
function zeroOf(fmt: i32, s: u32): u64 { return s ? fSign(fmt) : 0; }
function infOf(fmt: i32, s: u32): u64 { return fInf(fmt) | (s ? fSign(fmt) : 0); }

// FPUnpack result
let uC: i32 = 0, uS: u32 = 0, uX: i32 = 0, uM: u64 = 0;
function unpack(x: u64, fmt: i32, fz: bool): void {
  let F = fF(fmt), E = fE(fmt);
  let f = x & ((<u64>1 << <u64>F) - 1);
  let e = <i32>((x >> <u64>F) & <u64>((1 << E) - 1));
  uS = <u32>((x >> <u64>(F + E)) & 1);
  if (e == 0) {
    if (f == 0 || fz) { uC = C_ZERO; return; }
    let msb = 63 - <i32>clz(f);
    uC = C_NORM; uM = f << <u64>(62 - msb); uX = 1 - fBias(fmt) - F + msb;
  } else if (e == (1 << E) - 1) {
    uC = f == 0 ? C_INF : (f & fQuiet(fmt)) ? C_QNAN : C_SNAN;
    uM = x;
  } else {
    uC = C_NORM; uM = (f | (<u64>1 << <u64>F)) << <u64>(62 - F); uX = e - fBias(fmt);
  }
}
// @ts-ignore
@inline function isNaNc(c: i32): bool { return c >= C_QNAN; }

// FPRound: sign, exp, sig (top bit at 62, nonzero), sticky (nonzero bits below sig)
function round(s: u32, exp: i32, sig: u64, sticky: bool, fmt: i32, mode: u32, fz: bool): u64 {
  let F = fF(fmt), E = fE(fmt), minexp = 1 - fBias(fmt);
  if (fz && exp < minexp) return zeroOf(fmt, s);
  let biased = exp - minexp + 1;
  let sh = 62 - F;
  if (biased <= 0) { sh += 1 - biased; biased = 0; }
  let im: u64, gt = false, eq = false, nz: bool;
  if (sh >= 64) { im = 0; nz = sig != 0 || sticky; }
  else {
    im = sig >> <u64>sh;
    let r = sig & ((<u64>1 << <u64>sh) - 1), h = <u64>1 << <u64>(sh - 1);
    gt = r > h || (r == h && sticky); eq = r == h && !sticky; nz = r != 0 || sticky;
  }
  let up = mode == 0 ? (gt || (eq && (im & 1) != 0)) : mode == 1 ? (nz && !s) : mode == 2 ? (nz && s != 0) : false;
  if (up) {
    im++;
    if (biased == 0) { if (im == (<u64>1 << <u64>F)) biased = 1; }
    else if (im == (<u64>2 << <u64>F)) { biased++; im >>= 1; }
  }
  if (biased >= (1 << E) - 1) {
    let toInf = mode == 0 || (mode == 1 && !s) || (mode == 2 && s != 0);
    return toInf ? infOf(fmt, s) : (zeroOf(fmt, s) | (fInf(fmt) - (<u64>1 << <u64>F)) | ((<u64>1 << <u64>F) - 1));
  }
  return zeroOf(fmt, s) | (<u64>biased << <u64>F) | (im & ((<u64>1 << <u64>F) - 1));
}

// NaN handling
function quiet(x: u64, fmt: i32, dn: bool): u64 { return dn ? defNaN(fmt) : x | fQuiet(fmt); }
let nDone = false;
function nans2(ca: i32, a: u64, cb: i32, b: u64, fmt: i32, dn: bool): u64 {
  nDone = true;
  if (ca == C_SNAN) return quiet(a, fmt, dn);
  if (cb == C_SNAN) return quiet(b, fmt, dn);
  if (ca == C_QNAN) return quiet(a, fmt, dn);
  if (cb == C_QNAN) return quiet(b, fmt, dn);
  nDone = false; return 0;
}
function nans3(ca: i32, a: u64, cb: i32, b: u64, cc: i32, c: u64, fmt: i32, dn: bool): u64 {
  nDone = true;
  if (ca == C_SNAN) return quiet(a, fmt, dn);
  if (cb == C_SNAN) return quiet(b, fmt, dn);
  if (cc == C_SNAN) return quiet(c, fmt, dn);
  if (ca == C_QNAN) return quiet(a, fmt, dn);
  if (cb == C_QNAN) return quiet(b, fmt, dn);
  if (cc == C_QNAN) return quiet(c, fmt, dn);
  nDone = false; return 0;
}

// 128-bit scratch
let H: u64 = 0, L: u64 = 0;
function mul128(a: u64, b: u64): void {
  let a0 = a & 0xFFFFFFFF, a1 = a >> 32, b0 = b & 0xFFFFFFFF, b1 = b >> 32;
  let p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;
  let mid = (p00 >> 32) + (p01 & 0xFFFFFFFF) + (p10 & 0xFFFFFFFF);
  L = (p00 & 0xFFFFFFFF) | (mid << 32);
  H = p11 + (p01 >> 32) + (p10 >> 32) + (mid >> 32);
}
// (h:l) >> n with the shifted-out bits ORed into bit 0
function shr128j(h: u64, l: u64, n: i32): void {
  if (n == 0) { H = h; L = l; return; }
  if (n >= 128) { H = 0; L = (h | l) != 0 ? 1 : 0; return; }
  if (n >= 64) {
    let lost = l != 0 || (n > 64 && (h << <u64>(128 - n)) != 0);
    L = (n == 64 ? h : h >> <u64>(n - 64)) | (lost ? 1 : 0); H = 0; return;
  }
  let lost = (l << <u64>(64 - n)) != 0;
  L = (l >> <u64>n) | (h << <u64>(64 - n)) | (lost ? 1 : 0); H = h >> <u64>n;
}

// unrounded result of a finite exact computation
let rS: u32 = 0, rX: i32 = 0, rM: u64 = 0, rSt = false, rZero = false;
// normalise (h:l) * 2^scale into rX/rM/rSt
function norm128(h: u64, l: u64, scale: i32): void {
  if (h == 0 && l == 0) { rZero = true; return; }
  rZero = false;
  let k = h != 0 ? 127 - <i32>clz(h) : 63 - <i32>clz(l);
  rX = scale + k;
  if (k >= 62) {
    let n = k - 62;
    if (n == 0) { rM = l; rSt = false; }
    else if (n >= 64) { rM = h >> <u64>(n - 64); rSt = l != 0 || (n > 64 && (h << <u64>(128 - n)) != 0); }
    else { rM = (l >> <u64>n) | (h << <u64>(64 - n)); rSt = (l << <u64>(64 - n)) != 0; }
  } else { rM = l << <u64>(62 - k); rSt = false; }
}

// valueA + value1 * value2 (all finite; a zero class allowed); sets rS/rX/rM/rSt/rZero
function fmaExact(cA: i32, sA: u32, xA: i32, mA: u64, c1: i32, s1: u32, x1: i32, m1: u64, c2: i32, s2: u32, x2: i32, m2: u64): void {
  let sP = s1 ^ s2;
  let pZero = c1 == C_ZERO || c2 == C_ZERO;
  if (pZero && cA == C_ZERO) { rZero = true; rS = 0; return; }
  if (pZero) { rS = sA; rX = xA; rM = mA; rSt = false; rZero = false; return; }
  mul128(m1, m2);
  let ph = H, pl = L, pScale = x1 + x2 - 124;
  if (cA == C_ZERO) { rS = sP; norm128(ph, pl, pScale); return; }
  let ah = mA >> 2, al = mA << 62, aScale = xA - 124;
  let scale: i32;
  if (aScale >= pScale) { shr128j(ph, pl, aScale - pScale); ph = H; pl = L; scale = aScale; }
  else { shr128j(ah, al, pScale - aScale); ah = H; al = L; scale = pScale; }
  if (sA == sP) {
    let lo = al + pl, hi = ah + ph + (lo < al ? 1 : 0);
    rS = sA; norm128(hi, lo, scale);
  } else {
    let aBig = ah > ph || (ah == ph && al >= pl);
    let xh = aBig ? ah : ph, xl = aBig ? al : pl, yh = aBig ? ph : ah, yl = aBig ? pl : al;
    let lo = xl - yl, hi = xh - yh - (xl < yl ? 1 : 0);
    rS = aBig ? sA : sP; norm128(hi, lo, scale);
  }
}

function finish(fmt: i32, mode: u32, fz: bool): u64 {
  if (rZero) return zeroOf(fmt, mode == 2 ? 1 : 0);
  return round(rS, rX, rM, rSt, fmt, mode, fz);
}

function one(fmt: i32): u64 { return <u64>fBias(fmt) << <u64>fF(fmt); }
function two(fmt: i32): u64 { return <u64>(fBias(fmt) + 1) << <u64>fF(fmt); }

// op: 0 add 1 sub 2 mul 3 div 4 sqrt 5 max 6 min 7 maxnm 8 minnm 9 fma (a + b*c) 10 mulx 11 recps
//     12 rsqrts 13 abd 14 frint (bits 8..10: 0 N 1 P 2 M 3 Z 4 A 5 FPCR) ; bits 22..25 = FPCR RMode/FZ/DN
export function sfop(op: i32, a: u64, b: u64, c: u64, fmt: i32): u64 {
  let k = op & 0xFF;
  let mode = <u32>(op >> 22) & 3, fz = ((op >> 24) & 1) != 0, dn = ((op >> 25) & 1) != 0;
  let F = fF(fmt);
  unpack(a, fmt, fz); let cA = uC, sA = uS, xA = uX, mA = uM;
  if (k == 4 || k == 14) {
    if (isNaNc(cA)) return cA == C_SNAN || dn ? quiet(a, fmt, dn) : a;
    if (cA == C_ZERO) return zeroOf(fmt, sA);
    if (cA == C_INF) return k == 4 && sA ? defNaN(fmt) : infOf(fmt, sA);
    if (k == 14) return frint(a, fmt, sA, (op >> 8) & 7, mode);
    if (sA) return defNaN(fmt);
    let M = mA >> 10, e = xA;
    if (e & 1) { M <<= 1; e -= 1; }
    // isqrt(M << 60) to 57 bits
    let h = M >> 4, l = M << 60;
    let res: u64 = 0, rem: u64 = 0;
    for (let i = 56; i >= 0; i--) {
      let sh = 2 * i;
      let two = sh >= 64 ? (h >> <u64>(sh - 64)) & 3 : ((l >> <u64>sh) | (sh > 0 ? h << <u64>(64 - sh) : 0)) & 3;
      rem = (rem << 2) | two;
      let t = (res << 2) | 1;
      if (rem >= t) { rem -= t; res = (res << 1) | 1; } else res <<= 1;
    }
    return round(0, e >> 1, res << 6, rem != 0, fmt, mode, fz);
  }
  if (k == 11 || k == 12) { a ^= fSign(fmt); sA ^= 1; }
  unpack(b, fmt, fz); let cB = uC, sB = uS, xB = uX, mB = uM;
  if (k == 9) {
    unpack(c, fmt, fz); let cC = uC, sC = uS, xC = uX, mC = uM;
    let r = nans3(cA, a, cB, b, cC, c, fmt, dn);
    let infzero = (cB == C_INF && cC == C_ZERO) || (cB == C_ZERO && cC == C_INF);
    if (cA == C_QNAN && infzero) return defNaN(fmt);
    if (nDone) return r;
    let infP = cB == C_INF || cC == C_INF, sP = sB ^ sC;
    if (infzero || (cA == C_INF && infP && sA != sP)) return defNaN(fmt);
    if ((cA == C_INF && !sA) || (infP && !sP)) return infOf(fmt, 0);
    if (cA == C_INF || infP) return infOf(fmt, 1);
    if (cA == C_ZERO && (cB == C_ZERO || cC == C_ZERO) && sA == sP) return zeroOf(fmt, sA);
    fmaExact(cA, sA, xA, mA, cB, sB, xB, mB, cC, sC, xC, mC);
    return finish(fmt, mode, fz);
  }
  if (k == 7 || k == 8) {   // FMAXNM / FMINNM: a quiet NaN loses to a number
    let inf = infOf(fmt, k == 7 ? 1 : 0);
    if (cA == C_QNAN && !isNaNc(cB)) { a = inf; cA = C_INF; sA = k == 7 ? 1 : 0; }
    else if (cB == C_QNAN && !isNaNc(cA)) { b = inf; cB = C_INF; sB = k == 7 ? 1 : 0; }
  }
  let r = nans2(cA, a, cB, b, fmt, dn);
  if (nDone) return k == 13 ? r & ~fSign(fmt) : r;
  switch (k) {
    case 0: case 1: case 13: {
      if (k != 0) sB ^= 1;
      let res: u64;
      if (cA == C_INF && cB == C_INF && sA != sB) return defNaN(fmt);
      if (cA == C_INF || cB == C_INF) res = infOf(fmt, cA == C_INF ? sA : sB);
      else if (cA == C_ZERO && cB == C_ZERO && sA == sB) res = zeroOf(fmt, sA);
      else {
        // a + b as 1 * a + b
        fmaExact(cB, sB, xB, mB, cA == C_ZERO ? C_ZERO : C_NORM, sA, xA, mA, C_NORM, 0, 0, <u64>1 << 62);
        res = finish(fmt, mode, fz);
      }
      return k == 13 ? res & ~fSign(fmt) : res;
    }
    case 2: case 10: {
      let s = sA ^ sB;
      if ((cA == C_INF && cB == C_ZERO) || (cA == C_ZERO && cB == C_INF)) return k == 10 ? zeroOf(fmt, s) | (two(fmt)) : defNaN(fmt);
      if (cA == C_INF || cB == C_INF) return infOf(fmt, s);
      if (cA == C_ZERO || cB == C_ZERO) return zeroOf(fmt, s);
      fmaExact(C_ZERO, 0, 0, 0, C_NORM, sA, xA, mA, C_NORM, sB, xB, mB);
      return round(rS, rX, rM, rSt, fmt, mode, fz);
    }
    case 3: {
      let s = sA ^ sB;
      if ((cA == C_INF && cB == C_INF) || (cA == C_ZERO && cB == C_ZERO)) return defNaN(fmt);
      if (cA == C_INF || cB == C_ZERO) return infOf(fmt, s);
      if (cA == C_ZERO || cB == C_INF) return zeroOf(fmt, s);
      let rr = mA, q: u64 = 0, e = xA - xB, n = 63;
      if (mA < mB) { n = 64; e -= 1; }
      for (let i = 0; i < n; i++) { q <<= 1; if (rr >= mB) { rr -= mB; q |= 1; } rr <<= 1; }
      return round(s, e, q, rr != 0, fmt, mode, fz);
    }
    case 5: case 6: case 7: case 8: {
      let mx = k == 5 || k == 7;
      if (cA == C_ZERO && cB == C_ZERO) return zeroOf(fmt, mx ? sA & sB : sA | sB);
      let gtr = cmpGt(cA, sA, xA, mA, cB, sB, xB, mB);
      let pickA = mx ? gtr : !gtr;
      let w = pickA ? a : b, cw = pickA ? cA : cB, sw = pickA ? sA : sB;
      if (cw == C_ZERO) return zeroOf(fmt, sw);
      return w;
    }
    case 11: case 12: {
      if ((cA == C_INF && cB == C_ZERO) || (cA == C_ZERO && cB == C_INF)) return k == 11 ? two(fmt) : one(fmt) | fQuiet(fmt);
      if (cA == C_INF || cB == C_INF) return infOf(fmt, sA ^ sB);
      // 2 + a*b, or (3 + a*b) / 2
      fmaExact(C_NORM, 0, k == 11 ? 1 : 1, k == 11 ? <u64>1 << 62 : <u64>3 << 61, cA, sA, xA, mA, cB, sB, xB, mB);
      if (rZero) return zeroOf(fmt, mode == 2 ? 1 : 0);
      if (k == 12) rX -= 1;
      return round(rS, rX, rM, rSt, fmt, mode, fz);
    }
  }
  return defNaN(fmt);
}

// value(a) > value(b) for non-NaN unpacked operands
function cmpGt(cA: i32, sA: u32, xA: i32, mA: u64, cB: i32, sB: u32, xB: i32, mB: u64): bool {
  if (cA == C_ZERO && cB == C_ZERO) return false;
  if (cA == C_ZERO) return sB != 0;
  if (cB == C_ZERO) return sA == 0;
  if (sA != sB) return sB != 0;
  let magGt: bool, magEq: bool;
  if (cA == C_INF || cB == C_INF) { magGt = cA == C_INF && cB != C_INF; magEq = cA == cB; }
  else { magGt = xA > xB || (xA == xB && mA > mB); magEq = xA == xB && mA == mB; }
  return sA ? !magGt && !magEq : magGt;
}

// FRINT* on a finite nonzero operand (after FZ)
function frint(a: u64, fmt: i32, s: u32, rm: i32, mode: u32): u64 {
  let x = fmt == 2 ? reinterpret<f64>(a) : <f64>reinterpret<f32>(<u32>a);
  let m = rm == 5 ? <i32>mode : rm;
  let r: f64;
  if (m == 0) r = nearest<f64>(x);
  else if (m == 1) r = Math.ceil(x);
  else if (m == 2) r = Math.floor(x);
  else if (m == 3) r = Math.trunc(x);
  else { let t = Math.trunc(x); r = Math.abs(x - t) >= 0.5 ? t + (x < 0 ? -1.0 : 1.0) : t; }
  if (r == 0) return zeroOf(fmt, s);
  return fmt == 2 ? reinterpret<u64>(r) : <u64>reinterpret<u32>(<f32>r);
}

// FZ input flush (FPCR.FZ applies to single and double operands only)
export function sfflush(x: u64, fmt: i32): u64 {
  let F = fF(fmt), E = fE(fmt);
  return ((x >> <u64>F) & <u64>((1 << E) - 1)) == 0 ? x & fSign(fmt) : x;
}

// FCVT between formats. src/dst fmt 0 h 1 s 2 d; FZ flushes single/double inputs and outputs, not halves
export function sfcvt(x: u64, src: i32, dst: i32, fpcr: i32): u64 {
  let mode = <u32>(fpcr >> 22) & 3, fz = ((fpcr >> 24) & 1) != 0, dn = ((fpcr >> 25) & 1) != 0;
  unpack(x, src, fz && src != 0);
  if (isNaNc(uC)) {
    if (dn) return defNaN(dst);
    let Fs = fF(src), Fd = fF(dst);
    let pay = x & ((<u64>1 << <u64>(Fs - 1)) - 1);
    pay = Fd >= Fs ? pay << <u64>(Fd - Fs) : pay >> <u64>(Fs - Fd);
    return zeroOf(dst, uS) | defNaN(dst) | pay;
  }
  if (uC == C_ZERO) return zeroOf(dst, uS);
  if (uC == C_INF) return infOf(dst, uS);
  return round(uS, uX, uM, false, dst, mode, fz && dst != 0);
}
