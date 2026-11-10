// nxweb a64 runtime helpers (AssemblyScript, compiled to build/a64/helpers.wasm).
// Pure functions imported by translated code as module "hlp" for the rare / table-driven
// instructions: reciprocal estimates, NaN propagation, directed rounding, crypto, polynomial
// multiply, saturating odds and ends. Nothing here touches guest memory or CPU state.

// ---------------------------------------------------------------------------------------------
// NaN processing (called only when a result is NaN)
// @ts-ignore
@inline function isNaN64(x: u64): bool { return (x & 0x7FFFFFFFFFFFFFFF) > 0x7FF0000000000000; }
// @ts-ignore
@inline function isSNaN64(x: u64): bool { return isNaN64(x) && (x & 0x0008000000000000) == 0; }
// @ts-ignore
@inline function isNaN32(x: u32): bool { return (x & 0x7FFFFFFF) > 0x7F800000; }
// @ts-ignore
@inline function isSNaN32(x: u32): bool { return isNaN32(x) && (x & 0x00400000) == 0; }
const DN64: u64 = 0x7FF8000000000000;
const DN32: u32 = 0x7FC00000;
const Q64: u64 = 0x0008000000000000;
const Q32: u32 = 0x00400000;

function n1d(a: u64): u64 { return isNaN64(a) ? a | Q64 : DN64; }
function n1s(a: u32): u32 { return isNaN32(a) ? a | Q32 : DN32; }
function n2d(a: u64, b: u64): u64 {
  if (isSNaN64(a)) return a | Q64;
  if (isSNaN64(b)) return b | Q64;
  if (isNaN64(a)) return a;
  if (isNaN64(b)) return b;
  return DN64;
}
function n2s(a: u32, b: u32): u32 {
  if (isSNaN32(a)) return a | Q32;
  if (isSNaN32(b)) return b | Q32;
  if (isNaN32(a)) return a;
  if (isNaN32(b)) return b;
  return DN32;
}
// FPMulAdd(addend, op1, op2)
function n3d(a: u64, n: u64, m: u64): u64 {
  let infz = ((n << 1) == 0xFFE0000000000000 && (m << 1) == 0) || ((m << 1) == 0xFFE0000000000000 && (n << 1) == 0);
  if (isNaN64(a) && !isSNaN64(a) && infz) return DN64;
  if (isSNaN64(a)) return a | Q64;
  if (isSNaN64(n)) return n | Q64;
  if (isSNaN64(m)) return m | Q64;
  if (isNaN64(a)) return a;
  if (isNaN64(n)) return n;
  if (isNaN64(m)) return m;
  return DN64;
}
function n3s(a: u32, n: u32, m: u32): u32 {
  let infz = ((n << 1) == 0xFF000000 && (m << 1) == 0) || ((m << 1) == 0xFF000000 && (n << 1) == 0);
  if (isNaN32(a) && !isSNaN32(a) && infz) return DN32;
  if (isSNaN32(a)) return a | Q32;
  if (isSNaN32(n)) return n | Q32;
  if (isSNaN32(m)) return m | Q32;
  if (isNaN32(a)) return a;
  if (isNaN32(n)) return n;
  if (isNaN32(m)) return m;
  return DN32;
}
export function nan1d(a: f64): f64 { return reinterpret<f64>(n1d(reinterpret<u64>(a))); }
export function nan1s(a: f32): f32 { return reinterpret<f32>(n1s(reinterpret<u32>(a))); }
export function nan2d(a: f64, b: f64): f64 { return reinterpret<f64>(n2d(reinterpret<u64>(a), reinterpret<u64>(b))); }
export function nan2s(a: f32, b: f32): f32 { return reinterpret<f32>(n2s(reinterpret<u32>(a), reinterpret<u32>(b))); }
export function nan3d(a: f64, n: f64, m: f64): f64 { return reinterpret<f64>(n3d(reinterpret<u64>(a), reinterpret<u64>(n), reinterpret<u64>(m))); }
export function nan3s(a: f32, n: f32, m: f32): f32 { return reinterpret<f32>(n3s(reinterpret<u32>(a), reinterpret<u32>(n), reinterpret<u32>(m))); }

// ---------------------------------------------------------------------------------------------
// estimates
function recipEstimate(a: u32): u32 { a = a * 2 + 1; let b: u32 = (1 << 19) / a; return (b + 1) >> 1; }
function recipSqrtEstimate(a: u32): u32 {
  if (a < 256) a = a * 2 + 1; else { a = (a >> 1) << 1; a = (a + 1) * 2; }
  let b: u64 = 512;
  while (<u64>a * (b + 1) * (b + 1) < (1 << 28)) b++;
  return <u32>((b + 1) >> 1);
}
function recpe64(x: u64, single: bool): u64 {
  // works on a double-format view; single: exp range 8 bits
  let sign = x >> 63;
  let ebits: u32 = single ? 8 : 11;
  let exp: i32, frac: u64;
  if (single) { let v = <u32>x; sign = v >> 31; exp = (v >> 23) & 0xFF; frac = <u64>(v & 0x7FFFFF) << 29; }
  else { exp = <i32>((x >> 52) & 0x7FF); frac = x & 0x000FFFFFFFFFFFFF; }
  let emax: i32 = (1 << ebits) - 1;
  let signOut: u64 = single ? sign << 31 : sign << 63;
  if (exp == emax) {
    if (frac != 0) return single ? <u64>(<u32>x | Q32) : x | Q64;
    return signOut;                                   // inf -> zero
  }
  if (exp == 0 && frac == 0) return signOut | (single ? <u64>0x7F800000 : 0x7FF0000000000000);
  // |value| < 2^-(emax/2+1)...: overflow -> infinity (round to nearest)
  if (exp == 0 && (frac >> 50) == 0) return signOut | (single ? <u64>0x7F800000 : 0x7FF0000000000000);
  if (exp == 0) {
    if ((frac >> 51) == 0) { exp = -1; frac = (frac << 2) & 0x000FFFFFFFFFFFFF; }
    else frac = (frac << 1) & 0x000FFFFFFFFFFFFF;
  }
  let scaled: u32 = 0x100 | <u32>(frac >> 44);
  let rexp: i32 = (single ? 253 : 2045) - exp;
  let est: u64 = recipEstimate(scaled) & 0xFF;
  let f: u64 = est << 44;
  if (rexp == 0) f = (<u64>1 << 51) | (f >> 1);
  else if (rexp == -1) { f = (<u64>1 << 50) | (f >> 2); rexp = 0; }
  if (single) return signOut | (<u64>rexp << 23) | (f >> 29);
  return signOut | (<u64>rexp << 52) | f;
}
function rsqrte64(x: u64, single: bool): u64 {
  let sign: u64, exp: i32, frac: u64;
  if (single) { let v = <u32>x; sign = v >> 31; exp = (v >> 23) & 0xFF; frac = <u64>(v & 0x7FFFFF) << 29; }
  else { sign = x >> 63; exp = <i32>((x >> 52) & 0x7FF); frac = x & 0x000FFFFFFFFFFFFF; }
  let emax: i32 = single ? 0xFF : 0x7FF;
  if (exp == emax && frac != 0) return single ? <u64>(<u32>x | Q32) : x | Q64;
  if (exp == 0 && frac == 0) return (single ? sign << 31 : sign << 63) | (single ? <u64>0x7F800000 : 0x7FF0000000000000);
  if (sign) return single ? <u64>DN32 : DN64;
  if (exp == emax) return 0;
  if (exp == 0) {
    while ((frac >> 51) == 0) { frac <<= 1; exp--; }
    frac = (frac << 1) & 0x000FFFFFFFFFFFFF;
  }
  let scaled: u32 = (exp & 1) == 0 ? (0x100 | <u32>(frac >> 44)) : (0x80 | <u32>(frac >> 45));
  let rexp: i32 = ((single ? 380 : 3068) - exp) >> 1;
  let est: u64 = recipSqrtEstimate(scaled) & 0xFF;
  if (single) return (<u64>rexp << 23) | (est << 15);
  return (<u64>rexp << 52) | (est << 44);
}
function recpx(x: u64, single: bool): u64 {
  if (single) {
    let v = <u32>x;
    if (isNaN32(v)) return v | Q32;
    let exp = (v >> 23) & 0xFF, s = v & 0x80000000;
    return exp == 0 ? s | 0x7F000000 : s | ((~exp & 0xFF) << 23);
  }
  if (isNaN64(x)) return x | Q64;
  let exp = (x >> 52) & 0x7FF, s = x & 0x8000000000000000;
  return exp == 0 ? s | 0x7FE0000000000000 : s | ((~exp & 0x7FF) << 52);
}

// ---------------------------------------------------------------------------------------------
// directed rounding conversions. mode: 1 = +inf, 2 = -inf, 3 = zero (0 never reaches here)
function nextUp64(x: f64): f64 {
  let b = reinterpret<u64>(x);
  if (x != x || b == 0x7FF0000000000000) return x;
  if ((b << 1) == 0) return reinterpret<f64>(1);
  return reinterpret<f64>(b >> 63 ? b - 1 : b + 1);
}
function nextDown64(x: f64): f64 { return -nextUp64(-x); }
function nextUp32(x: f32): f32 {
  let b = reinterpret<u32>(x);
  if (x != x || b == 0x7F800000) return x;
  if ((b << 1) == 0) return reinterpret<f32>(1);
  return reinterpret<f32>(b >> 31 ? b - 1 : b + 1);
}
function nextDown32(x: f32): f32 { return -nextUp32(-x); }
// adjust a nearest-rounded result r given the sign of (exact - r): err > 0 means r is below exact
function adj64(r: f64, err: i32, mode: u32): f64 {
  if (err == 0) return r;
  if (mode == 1) return err > 0 ? nextUp64(r) : r;
  if (mode == 2) return err < 0 ? nextDown64(r) : r;
  // toward zero: move back if r overshot in magnitude
  if (r > 0 && err < 0) return nextDown64(r);
  if (r < 0 && err > 0) return nextUp64(r);
  return r;
}
function adj32(r: f32, err: i32, mode: u32): f32 {
  if (err == 0) return r;
  if (mode == 1) return err > 0 ? nextUp32(r) : r;
  if (mode == 2) return err < 0 ? nextDown32(r) : r;
  if (r > 0 && err < 0) return nextDown32(r);
  if (r < 0 && err > 0) return nextUp32(r);
  return r;
}
// sign of (x - r) where r = (f64)x was computed by nearest conversion
function errI64(x: i64, r: f64): i32 {
  if (r >= 9223372036854775808.0) return -1;
  let back = <i64>r;
  return x > back ? 1 : x < back ? -1 : 0;
}
function errU64(x: u64, r: f64): i32 {
  if (r >= 18446744073709551616.0) return -1;
  let back = <u64>r;
  return x > back ? 1 : x < back ? -1 : 0;
}
function i64ToF64(x: i64, mode: u32): f64 { let r = <f64>x; return adj64(r, errI64(x, r), mode); }
function u64ToF64(x: u64, mode: u32): f64 { let r = <f64>x; return adj64(r, errU64(x, r), mode); }
function i64ToF32(x: i64, mode: u32): f32 {
  let r = <f32>x;
  let rd = <f64>r;
  let err: i32 = rd >= 9223372036854775808.0 ? -1 : (x > <i64>rd ? 1 : x < <i64>rd ? -1 : 0);
  return adj32(r, err, mode);
}
function u64ToF32(x: u64, mode: u32): f32 {
  let r = <f32>x;
  let rd = <f64>r;
  let err: i32 = rd >= 18446744073709551616.0 ? -1 : (x > <u64>rd ? 1 : x < <u64>rd ? -1 : 0);
  return adj32(r, err, mode);
}
function f64ToF32(x: f64, mode: u32): f32 {
  let r = <f32>x;
  if (x != x) return r;
  let rd = <f64>r;
  let err: i32 = x > rd ? 1 : x < rd ? -1 : 0;
  if (r == Infinity && x != Infinity) {   // overflowed: directed modes may want the largest finite
    if (mode == 2 || mode == 3) return reinterpret<f32>(0x7F7FFFFF);
    return r;
  }
  if (r == -Infinity && x != -Infinity) {
    if (mode == 1 || mode == 3) return reinterpret<f32>(0xFF7FFFFF);
    return r;
  }
  return adj32(r, err, mode);
}
function rint64(x: f64, mode: u32): f64 { return mode == 1 ? Math.ceil(x) : mode == 2 ? Math.floor(x) : Math.trunc(x); }
function rint32(x: f32, mode: u32): f32 { return mode == 1 ? Mathf.ceil(x) : mode == 2 ? Mathf.floor(x) : Mathf.trunc(x); }

// ---------------------------------------------------------------------------------------------
// half precision
function f16ToF64(h: u32): f64 {
  let s = (h >> 15) & 1, e: i32 = (h >> 10) & 31, f: u32 = h & 0x3FF;
  let r: u64;
  if (e == 31) r = 0x7FF0000000000000 | (<u64>f << 42) | (f ? Q64 : 0);
  else if (e == 0) {
    if (f == 0) r = 0;
    else { let v = <f64>f * 5.960464477539063e-8; r = reinterpret<u64>(v); }   // f * 2^-24
  } else r = (<u64>(e - 15 + 1023) << 52) | (<u64>f << 42);
  return reinterpret<f64>(r | (<u64>s << 63));
}
function f64ToF16(x: f64): u32 {
  let b = reinterpret<u64>(x);
  let s: u32 = <u32>(b >> 63) << 15;
  let e: i32 = <i32>((b >> 52) & 0x7FF);
  let f: u64 = b & 0x000FFFFFFFFFFFFF;
  if (e == 0x7FF) return f ? s | 0x7E00 | <u32>((f >> 42) & 0x1FF) : s | 0x7C00;
  if (e == 0 && f == 0) return s;
  // value = m * 2^(e-1075), m with implicit bit
  let m: u64 = e == 0 ? f : f | 0x0010000000000000;
  let ex: i32 = e == 0 ? -1074 : e - 1075;       // value = m * 2^ex
  // target: half has 10 fraction bits; normal min exponent -14
  let msb: i32 = 63 - <i32>clz<u64>(m);
  let ue: i32 = msb + ex;                        // unbiased exponent
  let shift: i32;                                // result mantissa = m >> shift (keeping 11 bits for normals)
  if (ue < -14) shift = -24 - ex;                // subnormal: units of 2^-24
  else shift = msb - 10;
  let q: u64, rem: u64, half: u64;
  if (shift <= 0) { q = m << (-shift); rem = 0; half = 1; }
  else if (shift >= 64) { q = 0; rem = 1; half = 2; }
  else { q = m >> shift; rem = m & ((<u64>1 << shift) - 1); half = <u64>1 << (shift - 1); }
  if (rem > half || (rem == half && (q & 1))) q++;
  if (ue < -14) return s | <u32>q;               // q may reach 0x400 = smallest normal: encoding still right
  if (q == 0x800) { q = 0x400; ue++; }
  if (ue > 15) return s | 0x7C00;
  return s | (<u32>(ue + 15) << 10) | <u32>(q & 0x3FF);
}

// generic scalar helper on raw bits
// op: 0 frint64(mode) 1 frint32 2 f64->f32 3 i64->f64 4 u64->f64 5 i64->f32 6 u64->f32
//     7 f16->f32 8 f16->f64 9 f32->f16 10 f64->f16 ; mode in bits 8..9, fbits (scale 2^-fbits) in bits 16..23
export function rnd(op: i32, x: i64): i64 {
  let mode: u32 = (op >> 8) & 3, fbits: i32 = (op >> 16) & 0xFF;
  switch (op & 0xFF) {
    case 0: return reinterpret<i64>(rint64(reinterpret<f64>(x), mode));
    case 1: return <i64>reinterpret<u32>(rint32(reinterpret<f32>(<u32>x), mode));
    case 2: return <i64>reinterpret<u32>(f64ToF32(reinterpret<f64>(x), mode));
    case 3: return reinterpret<i64>(i64ToF64(x, mode) * reinterpret<f64>(<u64>(1023 - fbits) << 52));
    case 4: return reinterpret<i64>(u64ToF64(<u64>x, mode) * reinterpret<f64>(<u64>(1023 - fbits) << 52));
    case 5: return <i64>reinterpret<u32>(i64ToF32(x, mode) * reinterpret<f32>(<u32>(127 - fbits) << 23));
    case 6: return <i64>reinterpret<u32>(u64ToF32(<u64>x, mode) * reinterpret<f32>(<u32>(127 - fbits) << 23));
    case 7: return <i64>reinterpret<u32>(<f32>f16ToF64(<u32>x & 0xFFFF));
    case 8: return reinterpret<i64>(f16ToF64(<u32>x & 0xFFFF));
    case 9: return <i64>f64ToF16(<f64>reinterpret<f32>(<u32>x));
    case 10: return <i64>f64ToF16(reinterpret<f64>(x));
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// crypto
const SBOX = memory.data(256);
const ISBOX = memory.data(256);
let sboxReady = false;
function gmul(a: u32, b: u32): u32 {
  let p: u32 = 0;
  for (let i = 0; i < 8; i++) { if (b & 1) p ^= a; let hi = a & 0x80; a = (a << 1) & 0xFF; if (hi) a ^= 0x1B; b >>= 1; }
  return p;
}
function initSbox(): void {
  let p: u32 = 1, q: u32 = 1;
  do {
    p = p ^ ((p << 1) & 0xFF) ^ ((p & 0x80) ? 0x1B : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xFF; if (q & 0x80) q ^= 0x09;
    let x = q ^ rotl<u8>(<u8>q, 1) ^ rotl<u8>(<u8>q, 2) ^ rotl<u8>(<u8>q, 3) ^ rotl<u8>(<u8>q, 4);
    x = (x ^ 0x63) & 0xFF;
    store<u8>(SBOX + p, <u8>x); store<u8>(ISBOX + x, <u8>p);
  } while (p != 1);
  store<u8>(SBOX, 0x63); store<u8>(ISBOX + 0x63, 0);
  sboxReady = true;
}
const TMP = memory.data(64);
function aes(op: i32, a: v128, b: v128): v128 {
  if (!sboxReady) initSbox();
  let S = TMP, D = TMP + 16;
  if (op < 2) {
    v128.store(S, v128.xor(a, b));
    for (let i = 0; i < 16; i++) {
      // AESE: ShiftRows then SubBytes; AESD: InvShiftRows then InvSubBytes
      let col = i >> 2, row = i & 3;
      let src = op == 0 ? (((col + row) & 3) << 2) | row : (((col - row) & 3) << 2) | row;
      store<u8>(D + i, load<u8>((op == 0 ? SBOX : ISBOX) + load<u8>(S + src)));
    }
    return v128.load(D);
  }
  v128.store(S, a);
  for (let c = 0; c < 4; c++) {
    let s0: u32 = load<u8>(S + 4 * c), s1: u32 = load<u8>(S + 4 * c + 1), s2: u32 = load<u8>(S + 4 * c + 2), s3: u32 = load<u8>(S + 4 * c + 3);
    if (op == 2) {
      store<u8>(D + 4 * c, <u8>(gmul(s0, 2) ^ gmul(s1, 3) ^ s2 ^ s3));
      store<u8>(D + 4 * c + 1, <u8>(s0 ^ gmul(s1, 2) ^ gmul(s2, 3) ^ s3));
      store<u8>(D + 4 * c + 2, <u8>(s0 ^ s1 ^ gmul(s2, 2) ^ gmul(s3, 3)));
      store<u8>(D + 4 * c + 3, <u8>(gmul(s0, 3) ^ s1 ^ s2 ^ gmul(s3, 2)));
    } else {
      store<u8>(D + 4 * c, <u8>(gmul(s0, 14) ^ gmul(s1, 11) ^ gmul(s2, 13) ^ gmul(s3, 9)));
      store<u8>(D + 4 * c + 1, <u8>(gmul(s0, 9) ^ gmul(s1, 14) ^ gmul(s2, 11) ^ gmul(s3, 13)));
      store<u8>(D + 4 * c + 2, <u8>(gmul(s0, 13) ^ gmul(s1, 9) ^ gmul(s2, 14) ^ gmul(s3, 11)));
      store<u8>(D + 4 * c + 3, <u8>(gmul(s0, 11) ^ gmul(s1, 13) ^ gmul(s2, 9) ^ gmul(s3, 14)));
    }
  }
  return v128.load(D);
}
// @ts-ignore
@inline function W(p: usize, i: i32): u32 { return load<u32>(p + (<usize>i << 2)); }
// @ts-ignore
@inline function SW(p: usize, i: i32, v: u32): void { store<u32>(p + (<usize>i << 2), v); }
// SHA1C/P/M: kind 0 choose, 1 parity, 2 majority. d = hash state (Qd), n = e (Sn), m = W
function sha1(kind: i32, d: v128, n: v128, m: v128): v128 {
  let X = TMP;
  v128.store(X, d); v128.store(TMP + 16, m);
  let y: u32 = i32x4.extract_lane(n, 0);
  for (let e = 0; e < 4; e++) {
    let a = W(X, 0), b = W(X, 1), c = W(X, 2), dd = W(X, 3);
    let t: u32 = kind == 0 ? (((c ^ dd) & b) ^ dd) : kind == 1 ? (b ^ c ^ dd) : ((b & c) | ((b | c) & dd));
    y = y + rotl<u32>(a, 5) + t + W(TMP + 16, e);
    b = rotl<u32>(b, 30);
    SW(X, 0, y); SW(X, 1, a); SW(X, 2, b); SW(X, 3, c);
    y = dd;
  }
  return v128.load(X);
}
function sha256h(x: v128, y: v128, w: v128, part1: bool): v128 {
  let X = TMP, Y = TMP + 16, Wp = TMP + 32;
  v128.store(X, x); v128.store(Y, y); v128.store(Wp, w);
  for (let e = 0; e < 4; e++) {
    let y0 = W(Y, 0), x0 = W(X, 0);
    let chs = ((W(Y, 1) ^ W(Y, 2)) & y0) ^ W(Y, 2);
    let maj = (x0 & W(X, 1)) | ((x0 | W(X, 1)) & W(X, 2));
    let t = W(Y, 3) + (rotr<u32>(y0, 6) ^ rotr<u32>(y0, 11) ^ rotr<u32>(y0, 25)) + chs + W(Wp, e);
    let x3 = t + W(X, 3);
    let y3 = t + (rotr<u32>(x0, 2) ^ rotr<u32>(x0, 13) ^ rotr<u32>(x0, 22)) + maj;
    // <Y,X> = ROL(Y:X, 32)
    let x2 = W(X, 2), x1 = W(X, 1), y2 = W(Y, 2), y1 = W(Y, 1);
    SW(X, 0, y3); SW(X, 1, x0); SW(X, 2, x1); SW(X, 3, x2);
    SW(Y, 0, x3); SW(Y, 1, y0); SW(Y, 2, y1); SW(Y, 3, y2);
  }
  return part1 ? v128.load(X) : v128.load(Y);
}
function pmul64(a: u64, b: u64, hi: bool): u64 {
  let lo: u64 = 0, h: u64 = 0;
  for (let i = 0; i < 64; i++) {
    if ((b >> i) & 1) { lo ^= a << i; if (i) h ^= a >> (64 - i); }
  }
  return hi ? h : lo;
}
// saturation flagless helpers
function satS(v: i64, bits: i32): i64 {
  if (bits == 64) return v;
  let mx: i64 = (<i64>1 << (bits - 1)) - 1, mn: i64 = -(<i64>1 << (bits - 1));
  return v > mx ? mx : v < mn ? mn : v;
}
// saturating/rounding shift of one lane by a signed register amount
function qshl(x: i64, s: i32, bits: i32, U: bool, round: bool, sat: bool): i64 {
  let mask: u64 = bits == 64 ? ~(<u64>0) : (<u64>1 << bits) - 1;
  if (U) {
    let u: u64 = <u64>x & mask;
    if (s >= 0) {
      if (u == 0) return 0;
      if (s >= bits || (s > 0 && (u >> (bits - s)) != 0)) return sat ? <i64>mask : (s >= bits ? 0 : <i64>((u << s) & mask));
      return <i64>((u << s) & mask);
    }
    let n = -s;
    if (n > bits) return 0;
    let r: u64 = n == 64 ? 0 : u >> n;
    if (round) r += (u >> (n - 1)) & 1;
    return <i64>(r & mask);
  }
  // signed: x is sign-extended
  if (s >= 0) {
    if (x == 0) return 0;
    let mx: i64 = bits == 64 ? i64.MAX_VALUE : (<i64>1 << (bits - 1)) - 1, mn: i64 = bits == 64 ? i64.MIN_VALUE : -(<i64>1 << (bits - 1));
    if (s >= bits) return sat ? (x < 0 ? mn : mx) : 0;
    let r: i64 = x << s;
    let fits = bits == 64 ? (r >> s) == x : (r >= mn && r <= mx);
    if (!fits) return sat ? (x < 0 ? mn : mx) : r;
    return r;
  }
  let n = -s;
  if (n > bits) return round ? 0 : x >> 63;
  let r: i64 = n >= 64 ? (x >> 63) : x >> n;
  if (round) r += <i64>((<u64>x >> (n - 1)) & 1);
  return r;
}
// @ts-ignore
@inline function getLane(p: usize, sz: i32, i: i32, signed: bool): i64 {
  switch (sz) {
    case 0: return signed ? <i64>load<i8>(p + i) : <i64>load<u8>(p + i);
    case 1: return signed ? <i64>load<i16>(p + (i << 1)) : <i64>load<u16>(p + (i << 1));
    case 2: return signed ? <i64>load<i32>(p + (i << 2)) : <i64>load<u32>(p + (i << 2));
  }
  return load<i64>(p + (i << 3));
}
// @ts-ignore
@inline function setLane(p: usize, sz: i32, i: i32, v: i64): void {
  switch (sz) {
    case 0: store<u8>(p + i, <u8>v); break;
    case 1: store<u16>(p + (i << 1), <u16>v); break;
    case 2: store<u32>(p + (i << 2), <u32>v); break;
    default: store<i64>(p + (i << 3), v);
  }
}

const PA: usize = memory.data(16);
const PB: usize = memory.data(16);
const PC: usize = memory.data(16);
const PR: usize = memory.data(16);
// vector helper. op low byte selects the operation, bits 8..9 = size, bit 10 = U, bit 11 = flag, bits 12.. extra
export function vop(op: i32, a: v128, b: v128, c: v128): v128 {
  let k = op & 0xFF, sz = (op >> 8) & 3, U = ((op >> 10) & 1) != 0, fl = ((op >> 11) & 1) != 0;
  switch (k) {
    case 0: case 1: case 2: case 3: return aes(k, a, b);
    case 4: case 5: case 6: return sha1(k - 4, a, b, c);
    case 7: return i32x4.replace_lane(i32x4.splat(0), 0, rotl<u32>(i32x4.extract_lane(a, 0), 30));   // SHA1H
    case 8: { // SHA1SU0(d, n, m)
      let r = v128.shuffle<u64>(a, b, 1, 2);
      return v128.xor(v128.xor(r, a), c);
    }
    case 9: { // SHA1SU1(d, n)
      v128.store(PA, a); v128.store(PB, b);
      let t0 = W(PA, 0) ^ W(PB, 1), t1 = W(PA, 1) ^ W(PB, 2), t2 = W(PA, 2) ^ W(PB, 3), t3 = W(PA, 3);
      SW(PR, 0, rotl<u32>(t0, 1)); SW(PR, 1, rotl<u32>(t1, 1)); SW(PR, 2, rotl<u32>(t2, 1)); SW(PR, 3, rotl<u32>(t3, 1) ^ rotl<u32>(t0, 2));
      return v128.load(PR);
    }
    case 10: return sha256h(a, b, c, true);
    case 11: return sha256h(b, a, c, false);
    case 12: { // SHA256SU0(d, n)
      v128.store(PA, a); v128.store(PB, b);
      for (let e = 0; e < 4; e++) {
        let elt = e < 3 ? W(PA, e + 1) : W(PB, 0);
        elt = rotr<u32>(elt, 7) ^ rotr<u32>(elt, 18) ^ (elt >> 3);
        SW(PR, e, elt + W(PA, e));
      }
      return v128.load(PR);
    }
    case 13: { // SHA256SU1(d, n, m)
      v128.store(PA, a); v128.store(PB, b); v128.store(PC, c);
      for (let e = 0; e < 4; e++) {
        let elt = e < 2 ? W(PC, e + 2) : W(PR, e - 2);
        elt = rotr<u32>(elt, 17) ^ rotr<u32>(elt, 19) ^ (elt >> 10);
        let t0 = e < 3 ? W(PB, e + 1) : W(PC, 0);
        SW(PR, e, elt + W(PA, e) + t0);
      }
      return v128.load(PR);
    }
    case 14: { // PMUL (bytes)
      v128.store(PA, a); v128.store(PB, b);
      for (let i = 0; i < 16; i++) store<u8>(PR + i, <u8>pmul64(load<u8>(PA + i), load<u8>(PB + i), false));
      return v128.load(PR);
    }
    case 15: { // PMULL: sz 0: low 8 bytes -> 8 halfwords; sz 3: low 64 -> 128
      v128.store(PA, a); v128.store(PB, b);
      if (sz == 3) { store<u64>(PR, pmul64(load<u64>(PA), load<u64>(PB), false)); store<u64>(PR + 8, pmul64(load<u64>(PA), load<u64>(PB), true)); }
      else for (let i = 0; i < 8; i++) store<u16>(PR + 2 * i, <u16>pmul64(load<u8>(PA + i), load<u8>(PB + i), false));
      return v128.load(PR);
    }
    case 16: case 17: case 18: case 19: case 20: case 21: case 22: { // estimates, lanewise
      v128.store(PA, a);
      let single = sz == 2;
      if (k == 19 || k == 20) { // URECPE / URSQRTE
        for (let i = 0; i < 4; i++) {
          let v = W(PA, i), r: u32;
          if (k == 19) r = (v >> 31) == 0 ? 0xFFFFFFFF : recipEstimate(v >> 23) << 23;
          else r = (v >> 30) == 0 ? 0xFFFFFFFF : recipSqrtEstimate(v >> 23) << 23;
          SW(PR, i, r);
        }
        return v128.load(PR);
      }
      if (single) for (let i = 0; i < 4; i++) { let v: u64 = W(PA, i); SW(PR, i, <u32>(k == 16 ? recpe64(v, true) : k == 17 ? rsqrte64(v, true) : recpx(v, true))); }
      else for (let i = 0; i < 2; i++) { let v = load<u64>(PA + 8 * i); store<u64>(PR + 8 * i, k == 16 ? recpe64(v, false) : k == 17 ? rsqrte64(v, false) : recpx(v, false)); }
      return v128.load(PR);
    }
    case 25: { // FPMulAdd NaN result per lane: a = addend, b = op1, c = op2 (caller selects the NaN lanes)
      v128.store(PA, a); v128.store(PB, b); v128.store(PC, c);
      if (sz == 2) for (let i = 0; i < 4; i++) SW(PR, i, n3s(W(PA, i), W(PB, i), W(PC, i)));
      else for (let i = 0; i < 2; i++) store<u64>(PR + 8 * i, n3d(load<u64>(PA + 8 * i), load<u64>(PB + 8 * i), load<u64>(PC + 8 * i)));
      return v128.load(PR);
    }
    case 23: case 24: { // NaN fix-up: c = computed result, lanes that are NaN are recomputed. 23: nan1(a) 24: nan2(a,b) 25: nan3(a,b,extra)
      v128.store(PA, a); v128.store(PB, b); v128.store(PR, c);
      if (sz == 2) {
        for (let i = 0; i < 4; i++) if (isNaN32(W(PR, i))) SW(PR, i, k == 23 ? n1s(W(PA, i)) : n2s(W(PA, i), W(PB, i)));
      } else {
        for (let i = 0; i < 2; i++) if (isNaN64(load<u64>(PR + 8 * i))) store<u64>(PR + 8 * i, k == 23 ? n1d(load<u64>(PA + 8 * i)) : n2d(load<u64>(PA + 8 * i), load<u64>(PB + 8 * i)));
      }
      return v128.load(PR);
    }
    case 26: { // lanewise register shift: SQSHL/UQSHL/SQRSHL/UQRSHL (fl = round), always saturating
      v128.store(PA, a); v128.store(PB, b);
      let n = 16 >> sz, bits = 8 << sz;
      for (let i = 0; i < n; i++) setLane(PR, sz, i, qshl(getLane(PA, sz, i, !U), <i32><i8>getLane(PB, sz, i, false), bits, U, fl, true));
      return v128.load(PR);
    }
    case 27: { // SUQADD (U=0: signed acc a + unsigned b) / USQADD (U=1: unsigned acc a + signed b)
      v128.store(PA, a); v128.store(PB, b);
      let n = 16 >> sz, bits = 8 << sz;
      for (let i = 0; i < n; i++) {
        if (!U) {
          let x = getLane(PA, sz, i, true), y = <u64>getLane(PB, sz, i, false);
          let r: i64;
          if (bits == 64) {
            let s = <u64>x + y, MAXU: u64 = 0x7FFFFFFFFFFFFFFF;
            if (x >= 0) r = (s < <u64>x || s > MAXU) ? i64.MAX_VALUE : <i64>s;
            else r = (s < y && s > MAXU) ? i64.MAX_VALUE : <i64>s;
          }
          else r = satS(x + <i64>y, bits);
          setLane(PR, sz, i, r);
        } else {
          let x = <u64>getLane(PA, sz, i, false), y = getLane(PB, sz, i, true);
          let r: u64;
          if (bits == 64) { let s = x + <u64>y; r = y >= 0 ? (s < x ? ~(<u64>0) : s) : (s > x ? 0 : s); }
          else { let s = <i64>x + y; let mx: i64 = (<i64>1 << bits) - 1; r = <u64>(s < 0 ? 0 : s > mx ? mx : s); }
          setLane(PR, sz, i, <i64>r);
        }
      }
      return v128.load(PR);
    }
    case 28: { // SQDMULL/SQDMLAL/SQDMLSL on low-half lanes of a, b (sz = source size 1 or 2); c = accumulator; extra: 0 mull 1 mlal 2 mlsl
      v128.store(PA, a); v128.store(PB, b); v128.store(PC, c);
      let mode = (op >> 12) & 3, n = 8 >> sz, w = sz + 1, wbits = 16 << sz;
      for (let i = 0; i < n; i++) {
        let x = getLane(PA, sz, i, true), y = getLane(PB, sz, i, true);
        let p: i64;
        if (sz == 2 && x == -2147483648 && y == -2147483648) p = i64.MAX_VALUE; else p = satS(2 * x * y, wbits);
        if (mode) {
          let acc = getLane(PC, w, i, true);
          if (wbits == 64) {
            let r: i64 = mode == 1 ? acc + p : acc - p;
            let ovf = mode == 1 ? ((acc ^ r) & (p ^ r)) < 0 : ((acc ^ p) & (acc ^ r)) < 0;
            p = ovf ? (acc < 0 ? i64.MIN_VALUE : i64.MAX_VALUE) : r;
          } else p = satS(mode == 1 ? acc + p : acc - p, wbits);
        }
        setLane(PR, w, i, p);
      }
      return v128.load(PR);
    }
    case 29: { // half precision vector conversions: fl=0 FCVTL from 4 halves (low 64 of a) -> 4 singles ; fl=1 FCVTN 4 singles -> 4 halves
      v128.store(PA, a); store<u64>(PR, 0); store<u64>(PR + 8, 0);
      if (!fl) for (let i = 0; i < 4; i++) SW(PR, i, reinterpret<u32>(<f32>f16ToF64(load<u16>(PA + 2 * i))));
      else for (let i = 0; i < 4; i++) store<u16>(PR + 2 * i, <u16>f64ToF16(<f64>reinterpret<f32>(W(PA, i))));
      return v128.load(PR);
    }
    case 30: { // lanewise directed rounding: extra (bits 12..19) = rnd op, bits 20..21 mode, bits 22..29 fbits; sz 2 = 4 lanes of 32, 3 = 2 lanes of 64
      v128.store(PA, a);
      let rop = ((op >> 12) & 0xFF) | (((op >> 20) & 3) << 8) | (((op >> 22) & 0xFF) << 16);
      if (sz == 2) for (let i = 0; i < 4; i++) SW(PR, i, <u32>rnd(rop, (rop & 0xFF) == 5 ? <i64><i32>W(PA, i) : <i64>W(PA, i)));
      else for (let i = 0; i < 2; i++) store<i64>(PR + 8 * i, rnd(rop, load<i64>(PA + 8 * i)));
      return v128.load(PR);
    }
  }
  return a;
}

// ---------------------------------------------------------------------------------------------
// directed-rounding scalar arithmetic (FPCR.RMode != 0). op: 0 add 1 sub 2 mul 3 div 4 sqrt; mode in bits 8..9
// @ts-ignore
@inline function fma64(a: f64, b: f64, c: f64): f64 { return f64x2.extract_lane(v128.relaxed_madd<f64>(f64x2.splat(a), f64x2.splat(b), f64x2.splat(c)), 0); }
// @ts-ignore
@inline function sgn(x: f64): i32 { return x > 0 ? 1 : x < 0 ? -1 : 0; }
const MAX64: f64 = 1.7976931348623157e308;
function ovf64(r: f64, mode: u32): f64 {   // r is +-inf produced from finite operands
  if (r > 0) return mode == 1 ? r : MAX64;
  return mode == 2 ? r : -MAX64;
}
function tiny64(neg: bool, mode: u32): f64 {   // nonzero exact result that rounded to zero
  if (!neg) return mode == 1 ? reinterpret<f64>(1) : 0.0;
  return mode == 2 ? reinterpret<f64>(0x8000000000000001) : -0.0;
}
function add64(a: f64, b: f64, mode: u32): f64 {
  let s = a + b;
  if (s != s) return reinterpret<f64>(n2d(reinterpret<u64>(a), reinterpret<u64>(b)));
  if (!isFinite(a) || !isFinite(b)) return s;
  if (!isFinite(s)) return ovf64(s, mode);
  if (s == 0) {
    if (a == 0 && b == 0 && reinterpret<u64>(a) == reinterpret<u64>(b)) return a;
    return mode == 2 ? -0.0 : 0.0;
  }
  let bb = s - a;
  let e = (a - (s - bb)) + (b - bb);
  return adj64(s, sgn(e), mode);
}
let gE: i32 = 0;
// exact split a = m * 2^gE with |m| in [1, 2) (a finite, nonzero)
function norm64(a: f64): f64 {
  let b = reinterpret<u64>(a);
  let e = <i32>((b >> 52) & 0x7FF);
  if (e == 0) { a *= 18014398509481984.0; b = reinterpret<u64>(a); e = <i32>((b >> 52) & 0x7FF) - 54; }
  gE = e - 1023;
  return reinterpret<f64>((b & 0x800FFFFFFFFFFFFF) | 0x3FF0000000000000);
}
// @ts-ignore
@inline function pow2(e: i32): f64 { return e >= -1022 ? reinterpret<f64>(<u64>(e + 1023) << 52) : reinterpret<f64>(<u64>1 << (e + 1074)); }
// directed rounding of X * 2^e where x = RN(X) has magnitude in [0.5, 4) and err = sign(X - x)
function fixScaled(x: f64, err: i32, e: i32, mode: u32): f64 {
  if (e > 1030) return ovf64(x > 0 ? Infinity : -Infinity, mode);
  if (e < -1080) return tiny64(x < 0, mode);
  let r: f64;
  if (e > 1000) r = x * pow2(1000) * pow2(e - 1000);
  else if (e < -1074) r = (x * pow2(e + 1074)) * pow2(-1074);
  else r = x * pow2(e);
  if (!isFinite(r)) return ovf64(r, mode);
  if (Math.abs(r) >= 4.450147717014403e-308) return adj64(r, err, mode);   // at least 2^-1021: the scaling was exact
  let back = (r * pow2(537)) * pow2(537) * pow2(-e - 1074);   // exact: r is a multiple of 2^-1074
  let d = x - back;
  let s: i32 = d > 0 ? 1 : d < 0 ? -1 : err;
  return adj64(r, s, mode);
}
export function rarithd(op: i32, a: f64, b: f64): f64 {
  let mode: u32 = (op >> 8) & 3;
  switch (op & 0xFF) {
    case 0: return add64(a, b, mode);
    case 1: return (a != a || b != b) ? reinterpret<f64>(n2d(reinterpret<u64>(a), reinterpret<u64>(b))) : add64(a, -b, mode);
    case 2: {
      let p = a * b;
      if (p != p) return reinterpret<f64>(n2d(reinterpret<u64>(a), reinterpret<u64>(b)));
      if (!isFinite(a) || !isFinite(b) || a == 0 || b == 0) return p;
      let ma = norm64(a), ea = gE, mb = norm64(b), eb = gE;
      let x = ma * mb;
      return fixScaled(x, sgn(fma64(ma, mb, -x)), ea + eb, mode);
    }
    case 3: {
      let q = a / b;
      if (q != q) return reinterpret<f64>(n2d(reinterpret<u64>(a), reinterpret<u64>(b)));
      if (!isFinite(a) || !isFinite(b) || a == 0 || b == 0) return q;
      let ma = norm64(a), ea = gE, mb = norm64(b), eb = gE;
      let x = ma / mb;
      return fixScaled(x, sgn(fma64(-x, mb, ma)) * (mb > 0 ? 1 : -1), ea - eb, mode);
    }
    default: {
      let s = Math.sqrt(a);
      if (s != s) return reinterpret<f64>(n1d(reinterpret<u64>(a)));
      if (!isFinite(a) || a == 0) return s;
      let ma = norm64(a), ea = gE;
      if (ea & 1) { ma *= 2; ea -= 1; }
      let x = Math.sqrt(ma);
      return fixScaled(x, sgn(fma64(-x, x, ma)), ea >> 1, mode);
    }
  }
}
export function rariths(op: i32, a: f32, b: f32): f32 {
  let mode: u32 = (op >> 8) & 3;
  let k = op & 0xFF;
  if (k == 1) { if (a != a || b != b) return reinterpret<f32>(n2s(reinterpret<u32>(a), reinterpret<u32>(b))); k = 0; b = -b; }
  if (k == 0) {
    let s = a + b;
    if (s != s) return reinterpret<f32>(n2s(reinterpret<u32>(a), reinterpret<u32>(b)));
    if (!isFinite<f32>(a) || !isFinite<f32>(b)) return s;
    if (!isFinite<f32>(s)) return s > 0 ? (mode == 1 ? s : reinterpret<f32>(0x7F7FFFFF)) : (mode == 2 ? s : reinterpret<f32>(0xFF7FFFFF));
    if (s == 0) {
      if (a == 0 && b == 0 && reinterpret<u32>(a) == reinterpret<u32>(b)) return a;
      return mode == 2 ? <f32>-0.0 : <f32>0.0;
    }
    let bb = s - a;
    let e = (a - (s - bb)) + (b - bb);
    return adj32(s, e > 0 ? 1 : e < 0 ? -1 : 0, mode);
  }
  let x: f64;
  if (k == 2) x = <f64>a * <f64>b; else if (k == 3) x = <f64>a / <f64>b; else x = Math.sqrt(<f64>a);
  if (x != x) return k == 4 ? reinterpret<f32>(n1s(reinterpret<u32>(a))) : reinterpret<f32>(n2s(reinterpret<u32>(a), reinterpret<u32>(b)));
  let r = f64ToF32(x, mode);
  if (r == 0 && x != 0) {   // underflow to zero from a nonzero value
    if (x > 0) return mode == 1 ? reinterpret<f32>(1) : <f32>0.0;
    return mode == 2 ? reinterpret<f32>(0x80000001) : <f32>-0.0;
  }
  return r;
}

// where this module's static data lives in the shared memory (asc --memoryBase)
export function staticBase(): usize { return <usize>ASC_MEMORY_BASE; }
export function staticEnd(): usize { return __heap_base; }
