// The C library pass-through table: port of nxnative dm/host/hle_table.c. nxnative connects these names to Apple's
// libc when no module defines them; here they are written out (strings and memory), taken from AssemblyScript's
// native math (musl ports), or computed (number parsing, calendar). They are weak: a module's own definition wins.
// Known differences from a C library: strtod / atof / strtof are not correctly rounded in the last place for long
// digit strings and read no hex floats; math results can differ from Apple's libm in the last place; errno is not set.
import { X, I, P, D, F, retF32, retF64, ls, ps, pc, le } from "./base";
import { breakDown, localBreakDown, fieldsToUtc, localToUtc, writeTm, writeTmZone, ZONE, tSec, tMin, tHour, tMday, tMon, tYear, tWday, tYday, tIsdst, tGmtoff } from "./cal";

// ---------- memory and strings ----------
export function lib_memcpy(a: usize): u64 { memory.copy(P(a, 0), P(a, 1), <usize>X(a, 2)); return X(a, 0); }
export function lib_memmove(a: usize): u64 { memory.copy(P(a, 0), P(a, 1), <usize>X(a, 2)); return X(a, 0); }
export function lib_memset(a: usize): u64 { memory.fill(P(a, 0), <u8>X(a, 1), <usize>X(a, 2)); return X(a, 0); }
export function lib_memcmp(a: usize): u64 {
  const p = P(a, 0), q = P(a, 1), n = <usize>X(a, 2);
  for (let i: usize = 0; i < n; i++) { const d = <i32>load<u8>(p + i) - <i32>load<u8>(q + i); if (d) return <u64><u32>d; }
  return 0;
}
export function lib_memchr(a: usize): u64 {
  const p = P(a, 0), c = <u8>X(a, 1), n = <usize>X(a, 2);
  for (let i: usize = 0; i < n; i++) if (load<u8>(p + i) == c) return <u64>(p + i);
  return 0;
}
function slen(p: usize): usize { let n: usize = 0; while (load<u8>(p + n)) n++; return n; }
export function lib_strlen(a: usize): u64 { return <u64>slen(P(a, 0)); }
export function lib_strnlen(a: usize): u64 { const p = P(a, 0), m = <usize>X(a, 1); let n: usize = 0; while (n < m && load<u8>(p + n)) n++; return <u64>n; }
function lower(c: u32): u32 { return c >= 65 && c <= 90 ? c + 32 : c; }
function cmp(p: usize, q: usize, n: usize, fold: bool): u64 {
  for (let i: usize = 0; i < n; i++) {
    let x: u32 = load<u8>(p + i), y: u32 = load<u8>(q + i);
    if (fold) { x = lower(x); y = lower(y); }
    if (x != y || !x) return <u64><u32>(<i32>x - <i32>y);
  }
  return 0;
}
export function lib_strcmp(a: usize): u64 { return cmp(P(a, 0), P(a, 1), 0xFFFFFFFF, false); }
export function lib_strncmp(a: usize): u64 { return cmp(P(a, 0), P(a, 1), <usize>X(a, 2), false); }
export function lib_strcasecmp(a: usize): u64 { return cmp(P(a, 0), P(a, 1), 0xFFFFFFFF, true); }
export function lib_strncasecmp(a: usize): u64 { return cmp(P(a, 0), P(a, 1), <usize>X(a, 2), true); }
export function lib_strcpy(a: usize): u64 { const d = P(a, 0), s = P(a, 1); memory.copy(d, s, slen(s) + 1); return X(a, 0); }
export function lib_strncpy(a: usize): u64 {
  const d = P(a, 0), s = P(a, 1), n = <usize>X(a, 2);
  let i: usize = 0;
  for (; i < n; i++) { const c = load<u8>(s + i); if (!c) break; store<u8>(d + i, c); }
  for (; i < n; i++) store<u8>(d + i, 0);
  return X(a, 0);
}
export function lib_strcat(a: usize): u64 { const d = P(a, 0), s = P(a, 1); memory.copy(d + slen(d), s, slen(s) + 1); return X(a, 0); }
export function lib_strncat(a: usize): u64 {
  const d = P(a, 0), s = P(a, 1), n = <usize>X(a, 2), at = d + slen(d);
  let i: usize = 0;
  for (; i < n; i++) { const c = load<u8>(s + i); if (!c) break; store<u8>(at + i, c); }
  store<u8>(at + i, 0);
  return X(a, 0);
}
export function lib_strchr(a: usize): u64 {
  const c = <u8>X(a, 1);
  let p = P(a, 0);
  for (;; p++) { const x = load<u8>(p); if (x == c) return <u64>p; if (!x) break; }
  return 0;
}
export function lib_strrchr(a: usize): u64 {
  const c = <u8>X(a, 1); let r: usize = 0;
  let p = P(a, 0);
  for (;; p++) { const x = load<u8>(p); if (x == c) r = p; if (!x) break; }
  return <u64>r;
}
export function lib_strstr(a: usize): u64 {
  const h = P(a, 0), n = P(a, 1), nl = slen(n);
  if (!nl) return <u64>h;
  for (let p = h; load<u8>(p); p++) {
    let i: usize = 0;
    while (i < nl && load<u8>(p + i) == load<u8>(n + i)) i++;
    if (i == nl) return <u64>p;
  }
  return 0;
}
function inSet(c: u8, set: usize): bool { for (let q = set; load<u8>(q); q++) if (load<u8>(q) == c) return true; return false; }
export function lib_strspn(a: usize): u64 { const s = P(a, 0), set = P(a, 1); let n: usize = 0; while (load<u8>(s + n) && inSet(load<u8>(s + n), set)) n++; return <u64>n; }
export function lib_strcspn(a: usize): u64 { const s = P(a, 0), set = P(a, 1); let n: usize = 0; while (load<u8>(s + n) && !inSet(load<u8>(s + n), set)) n++; return <u64>n; }
export function lib_strpbrk(a: usize): u64 { const s = P(a, 0), set = P(a, 1); for (let p = s; load<u8>(p); p++) if (inSet(load<u8>(p), set)) return <u64>p; return 0; }

// ---------- numbers ----------
function isSpace(c: u32): bool { return c == 32 || (c >= 9 && c <= 13); }
function digit(c: u32): i32 { return c >= 48 && c <= 57 ? <i32>c - 48 : c >= 97 && c <= 122 ? <i32>c - 87 : c >= 65 && c <= 90 ? <i32>c - 55 : 99; }
export let pNeg: bool = false, pOver: bool = false;
// strtoull's reading: white space, sign, base prefix, digits. *end (when not 0) = the first byte not read. pNeg, pOver say more
function parseMag(p: usize, end: usize, base: i32): u64 {
  const start = p;
  pNeg = false; pOver = false;
  while (isSpace(load<u8>(p))) p++;
  const s = load<u8>(p);
  if (s == 43 || s == 45) { pNeg = s == 45; p++; }
  if ((base == 0 || base == 16) && load<u8>(p) == 48 && (load<u8>(p + 1) | 32) == 120 && digit(load<u8>(p + 2)) < 16) { p += 2; base = 16; }
  else if (base == 0) base = load<u8>(p) == 48 ? 8 : 10;
  let v: u64 = 0, any = false;
  const lim = <u64>0xFFFFFFFFFFFFFFFF / <u64>base;
  for (;; p++) {
    const d = digit(load<u8>(p));
    if (d >= base) break;
    any = true;
    if (v > lim || v * <u64>base > <u64>0xFFFFFFFFFFFFFFFF - <u64>d) pOver = true; else v = v * <u64>base + <u64>d;
  }
  if (end) store<u64>(end, <u64>(any ? p : start));
  return v;
}
export function parseU64(p: usize, end: usize, base: i32): u64 { const v = parseMag(p, end, base); return pOver ? 0xFFFFFFFFFFFFFFFF : pNeg ? 0 - v : v; }
export function parseI64(p: usize, end: usize, base: i32): i64 {
  const v = parseMag(p, end, base);
  if (pNeg) return pOver || v > 0x8000000000000000 ? i64.MIN_VALUE : <i64>(0 - v);
  return pOver || v > 0x7FFFFFFFFFFFFFFF ? i64.MAX_VALUE : <i64>v;
}
function pow10(e: i32): f64 { let r: f64 = 1, b: f64 = 10, n = e < 0 ? -e : e; while (n) { if (n & 1) r *= b; b *= b; n >>= 1; } return r; }
export function parseF64(p: usize, end: usize): f64 {
  const start = p;
  while (isSpace(load<u8>(p))) p++;
  let neg = false;
  const s = load<u8>(p);
  if (s == 43 || s == 45) { neg = s == 45; p++; }
  const c0 = load<u8>(p) | 32;
  if (c0 == 105 && (load<u8>(p + 1) | 32) == 110 && (load<u8>(p + 2) | 32) == 102) {   // inf, infinity
    p += 3;
    if ((load<u8>(p) | 32) == 105 && (load<u8>(p + 1) | 32) == 110 && (load<u8>(p + 2) | 32) == 105 && (load<u8>(p + 3) | 32) == 116 && (load<u8>(p + 4) | 32) == 121) p += 5;
    if (end) store<u64>(end, <u64>p);
    return neg ? -Infinity : Infinity;
  }
  if (c0 == 110 && (load<u8>(p + 1) | 32) == 97 && (load<u8>(p + 2) | 32) == 110) { if (end) store<u64>(end, <u64>(p + 3)); return NaN; }
  let mant: u64 = 0, exp: i32 = 0, any = false, digits = 0;
  for (;; p++) { const d = <i32>load<u8>(p) - 48; if (d < 0 || d > 9) break; any = true; if (digits < 19) { mant = mant * 10 + <u64>d; if (mant) digits++; } else exp++; }
  if (load<u8>(p) == 46) {
    p++;
    for (;; p++) { const d = <i32>load<u8>(p) - 48; if (d < 0 || d > 9) break; any = true; if (digits < 19) { mant = mant * 10 + <u64>d; if (mant) digits++; exp--; } }
  }
  if (!any) { if (end) store<u64>(end, <u64>start); return 0; }
  if ((load<u8>(p) | 32) == 101) {
    let q = p + 1, eneg = false;
    const es = load<u8>(q);
    if (es == 43 || es == 45) { eneg = es == 45; q++; }
    if (load<u8>(q) >= 48 && load<u8>(q) <= 57) {
      let e = 0;
      for (; load<u8>(q) >= 48 && load<u8>(q) <= 57; q++) if (e < 100000) e = e * 10 + <i32>load<u8>(q) - 48;
      exp += eneg ? -e : e; p = q;
    }
  }
  if (end) store<u64>(end, <u64>p);
  let v = <f64>mant;
  if (exp > 0) v = exp > 308 ? Infinity : v * pow10(exp);
  else if (exp < 0) { if (exp < -340) v = 0; else if (exp < -300) v = v / pow10(300) / pow10(-exp - 300); else v = v / pow10(exp); }
  return neg ? -v : v;
}
export function lib_atoi(a: usize): u64 { return <u64><u32><i32>parseI64(P(a, 0), 0, 10); }
export function lib_strtol(a: usize): u64 { return <u64>parseI64(P(a, 0), P(a, 1), I(a, 2)); }
export function lib_strtoll(a: usize): u64 { return <u64>parseI64(P(a, 0), P(a, 1), I(a, 2)); }
export function lib_strtoul(a: usize): u64 { return parseU64(P(a, 0), P(a, 1), I(a, 2)); }
export function lib_strtoull(a: usize): u64 { return parseU64(P(a, 0), P(a, 1), I(a, 2)); }
export function lib_atof(a: usize): u64 { return retF64(parseF64(P(a, 0), 0)); }
export function lib_strtod(a: usize): u64 { return retF64(parseF64(P(a, 0), P(a, 1))); }
export function lib_strtof(a: usize): u64 { return retF32(<f32>parseF64(P(a, 0), P(a, 1))); }

// ---------- math ----------
export function lib_sqrtf(a: usize): u64 { return retF32(Mathf.sqrt(F(a, 0))); }
export function lib_cbrtf(a: usize): u64 { return retF32(Mathf.cbrt(F(a, 0))); }
export function lib_expf(a: usize): u64 { return retF32(Mathf.exp(F(a, 0))); }
export function lib_acosf(a: usize): u64 { return retF32(Mathf.acos(F(a, 0))); }
export function lib_cosf(a: usize): u64 { return retF32(Mathf.cos(F(a, 0))); }
export function lib_sinf(a: usize): u64 { return retF32(Mathf.sin(F(a, 0))); }
export function lib_atan2f(a: usize): u64 { return retF32(Mathf.atan2(F(a, 0), F(a, 1))); }
export function lib_fmodf(a: usize): u64 { return retF32(F(a, 0) % F(a, 1)); }
export function lib_powf(a: usize): u64 { return retF32(Mathf.pow(F(a, 0), F(a, 1))); }
export function lib_atanf(a: usize): u64 { return retF32(Mathf.atan(F(a, 0))); }
export function lib_tanf(a: usize): u64 { return retF32(Mathf.tan(F(a, 0))); }
export function lib_asinf(a: usize): u64 { return retF32(Mathf.asin(F(a, 0))); }
export function lib_logf(a: usize): u64 { return retF32(Mathf.log(F(a, 0))); }
export function lib_log10f(a: usize): u64 { return retF32(Mathf.log10(F(a, 0))); }
export function lib_log2f(a: usize): u64 { return retF32(Mathf.log2(F(a, 0))); }
export function lib_exp2f(a: usize): u64 { return retF32(Mathf.pow(2, F(a, 0))); }
export function lib_ldexpf(a: usize): u64 { return retF32(Mathf.scalbn(F(a, 0), I(a, 0))); }
export function lib_modff(a: usize): u64 {
  const x = F(a, 0), ip = P(a, 0);
  const t: f32 = isFinite(x) ? Mathf.trunc(x) : x;
  store<f32>(ip, t);
  return retF32(isFinite(x) ? copysign<f32>(x - t, x) : isNaN(x) ? x : copysign<f32>(0, x));
}
export function lib_lroundf(a: usize): u64 {
  const x = F(a, 0);
  const r: f32 = Mathf.trunc(x + copysign<f32>(0.5, x));
  return <u64><i64>r;
}
export function lib_cos(a: usize): u64 { return retF64(Math.cos(D(a, 0))); }
export function lib_sin(a: usize): u64 { return retF64(Math.sin(D(a, 0))); }
export function lib_log(a: usize): u64 { return retF64(Math.log(D(a, 0))); }
export function lib_log10(a: usize): u64 { return retF64(Math.log10(D(a, 0))); }
export function lib_log2(a: usize): u64 { return retF64(Math.log2(D(a, 0))); }
export function lib_pow(a: usize): u64 { return retF64(Math.pow(D(a, 0), D(a, 1))); }
export function lib_atan2(a: usize): u64 { return retF64(Math.atan2(D(a, 0), D(a, 1))); }
export function lib_exp2(a: usize): u64 { return retF64(Math.pow(2, D(a, 0))); }
export function lib_ldexp(a: usize): u64 { return retF64(Math.scalbn(D(a, 0), I(a, 0))); }
export function lib_frexp(a: usize): u64 {
  let x = D(a, 0); const ep = P(a, 0);
  if (x == 0 || !isFinite(x)) { store<i32>(ep, 0); return retF64(x); }
  let bits = reinterpret<u64>(x), e = <i32>((bits >> 52) & 0x7FF), adj = 0;
  if (!e) { x *= 18014398509481984.0; bits = reinterpret<u64>(x); e = <i32>((bits >> 52) & 0x7FF); adj = -54; }   // subnormal: scale by 2^54
  store<i32>(ep, e - 1022 + adj);
  return retF64(reinterpret<f64>((bits & 0x800FFFFFFFFFFFFF) | 0x3FE0000000000000));
}

// ---------- time ----------
function readTmUtc(p: usize): i64 { return fieldsToUtc(load<i32>(p, 20), load<i32>(p, 16), load<i32>(p, 12), load<i32>(p, 8), load<i32>(p, 4), load<i32>(p)); }
export function mktimeAt(p: usize): i64 {
  const t = localToUtc(load<i32>(p, 20), load<i32>(p, 16), load<i32>(p, 12), load<i32>(p, 8), load<i32>(p, 4), load<i32>(p));
  localBreakDown(t); writeTmZone(p, ZONE);   // mktime normalizes its argument
  return t;
}
export function lib_mktime(a: usize): u64 { return <u64>mktimeAt(P(a, 0)); }
const UTC: usize = memory.data<u8>([0x55, 0x54, 0x43, 0]);
export function lib_timegm(a: usize): u64 {
  const p = P(a, 0), t = readTmUtc(p);
  breakDown(t, 0); writeTm(p); store<i32>(p, 0, 32); store<u64>(p, <u64>UTC, 48);
  return <u64>t;
}
export function lib_gmtime_r(a: usize): u64 {
  const p = P(a, 1);
  breakDown(load<i64>(P(a, 0)), 0); writeTm(p); store<i32>(p, 0, 32); store<u64>(p, <u64>UTC, 48);
  return X(a, 1);
}
export function localtimeInto(t: i64, p: usize): void { localBreakDown(t); writeTmZone(p, ZONE); }
export function lib_localtime_r(a: usize): u64 { localtimeInto(load<i64>(P(a, 0)), P(a, 1)); return X(a, 1); }

const WD = "SunMonTueWedThuFriSat", MN = "JanFebMarAprMayJunJulAugSepOctNovDec";
const WDL: string[] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MNL: string[] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
let fo: usize = 0, fcap: usize = 0, fn_: usize = 0, fover: bool = false;
function oc(c: u32): void { if (fn_ + 1 < fcap) { store<u8>(fo + fn_, <u8>c); fn_++; } else fover = true; }
function os(s: string): void { for (let i = 0; i < s.length; i++) oc(s.charCodeAt(i)); }
function osub(s: string, at: i32): void { for (let i = 0; i < 3; i++) oc(s.charCodeAt(at + i)); }
function on(v: i64, width: i32, pad: u32): void {
  if (v < 0) { oc(45); v = -v; }
  let d = 1; for (let t = v; t >= 10; t /= 10) d++;
  for (; d < width; width--) oc(pad);
  let div: i64 = 1; for (let i = 1; i < d; i++) div *= 10;
  for (; div; div /= 10) oc(48 + <u32>((v / div) % 10));
}
let fmtRed: bool = false;
function fmt(f: usize, tm: usize): void {
  const sec = load<i32>(tm), min = load<i32>(tm, 4), hour = load<i32>(tm, 8), mday = load<i32>(tm, 12), mon = load<i32>(tm, 16), year = load<i32>(tm, 20),
    wday = load<i32>(tm, 24), yday = load<i32>(tm, 28);
  for (; load<u8>(f); f++) {
    const c = load<u8>(f);
    if (c != 37) { oc(c); continue; }
    f++;
    let k = load<u8>(f);
    if (k == 69 || k == 79) { f++; k = load<u8>(f); }   // the E and O modifiers: the C locale has no alternatives
    switch (k) {
      case 0: return;
      case 37: oc(37); break;
      case 89: on(<i64>year + 1900, 1, 48); break;                      // Y
      case 67: on((<i64>year + 1900) / 100, 2, 48); break;              // C
      case 121: on(((year % 100) + 100) % 100, 2, 48); break;           // y
      case 109: on(mon + 1, 2, 48); break;                              // m
      case 100: on(mday, 2, 48); break;                                 // d
      case 101: on(mday, 2, 32); break;                                 // e
      case 72: on(hour, 2, 48); break;                                  // H
      case 73: on(hour % 12 == 0 ? 12 : hour % 12, 2, 48); break;       // I
      case 77: on(min, 2, 48); break;                                   // M
      case 83: on(sec, 2, 48); break;                                   // S
      case 106: on(yday + 1, 3, 48); break;                             // j
      case 112: os(hour < 12 ? "AM" : "PM"); break;                     // p
      case 97: if (wday >= 0 && wday < 7) osub(WD, wday * 3); else oc(63); break;      // a
      case 65: if (wday >= 0 && wday < 7) os(WDL[wday]); else oc(63); break;                   // A
      case 98: case 104: if (mon >= 0 && mon < 12) osub(MN, mon * 3); else oc(63); break;   // b h
      case 66: if (mon >= 0 && mon < 12) os(MNL[mon]); else oc(63); break;                     // B
      case 110: oc(10); break;
      case 116: oc(9); break;
      case 117: on(wday == 0 ? 7 : wday, 1, 48); break;                 // u
      case 119: on(wday, 1, 48); break;                                 // w
      case 115: on(fieldsToUtc(year, mon, mday, hour, min, sec) - load<i64>(tm, 40), 1, 48); break;   // s
      case 122: { let o = load<i64>(tm, 40); oc(o < 0 ? 45 : 43); if (o < 0) o = -o; on(o / 3600, 2, 48); on((o / 60) % 60, 2, 48); break; }   // z
      case 90: { const z = <usize>load<u64>(tm, 48); if (z) for (let i: usize = 0; i < 16 && load<u8>(z + i); i++) oc(load<u8>(z + i)); break; }   // Z
      case 70: on(<i64>year + 1900, 1, 48); oc(45); on(mon + 1, 2, 48); oc(45); on(mday, 2, 48); break;   // F
      case 84: case 88: on(hour, 2, 48); oc(58); on(min, 2, 48); oc(58); on(sec, 2, 48); break;           // T X
      case 82: on(hour, 2, 48); oc(58); on(min, 2, 48); break;                                              // R
      case 68: case 120: on(mon + 1, 2, 48); oc(47); on(mday, 2, 48); oc(47); on(((year % 100) + 100) % 100, 2, 48); break;   // D x
      case 114: on(hour % 12 == 0 ? 12 : hour % 12, 2, 48); oc(58); on(min, 2, 48); oc(58); on(sec, 2, 48); oc(32); os(hour < 12 ? "AM" : "PM"); break;   // r
      case 99:                                                                                              // c
        if (wday >= 0 && wday < 7) osub(WD, wday * 3); oc(32); if (mon >= 0 && mon < 12) osub(MN, mon * 3); oc(32); on(mday, 2, 32); oc(32);
        on(hour, 2, 48); oc(58); on(min, 2, 48); oc(58); on(sec, 2, 48); oc(32); on(<i64>year + 1900, 1, 48); break;
      default:
        if (!fmtRed) { fmtRed = true; ls(); ps("[RED] strftime: conversion %"); pc(k); ps(" is not implemented: copied as it is"); le(); }
        oc(37); oc(k);
    }
  }
}
// strftime(buf, max, format, tm): the number of bytes written without the terminating zero, 0 when it does not fit
export function lib_strftime(a: usize): u64 {
  fo = P(a, 0); fcap = <usize>X(a, 1); fn_ = 0; fover = false;
  if (!fcap) return 0;
  fmt(P(a, 2), P(a, 3));
  store<u8>(fo + fn_, 0);
  return fover ? 0 : <u64>fn_;
}
export function libcInit(): void { fmtRed = false; }
