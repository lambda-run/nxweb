// The C library's hot memory and string functions for translated code (helpers' "libc" import). The host names a
// module's definitions of these functions (A64Host.setLibcIntrinsics, by symbol); the translator then gives each
// of them a body that is one call here and a return to x30 (unit.ts intrinsicFunction), so every caller in every
// module, direct or through a pointer, gets wasm's memory.copy / memory.fill and word-at-a-time loops instead of
// the translated SDK routine, without leaving wasm. Only x0 changes (the call clobbers nothing else the AAPCS64
// lets a caller rely on). A pointer below the guard traps as a translated access to it would; so does one whose
// range runs off the end of the memory (memory32: off 4 GB).
@inline const M64: bool = sizeof<usize>() == 8;
export const LIBC_MEMCPY = 1, LIBC_MEMMOVE = 2, LIBC_MEMSET = 3, LIBC_MEMCMP = 4, LIBC_MEMCHR = 5, LIBC_STRLEN = 6,
  LIBC_STRNLEN = 7, LIBC_STRCMP = 8, LIBC_STRNCMP = 9, LIBC_OPS = 10;
const STATS: usize = memory.data(LIBC_OPS * 16, 8);   // per op: calls u64, bytes u64
let guard: usize = 0;
const ONES: u64 = 0x0101010101010101, HIGHS: u64 = 0x8080808080808080;
// @ts-ignore
@inline function zbytes(v: u64): u64 { return (v - ONES) & ~v & HIGHS; }   // the first zero byte's high bit is its lowest set bit
// @ts-ignore
@inline function A(x: u64): usize { return M64 ? <usize>x : <usize><u32>x; }
// @ts-ignore
@inline function L(c: u64): usize { return M64 ? <usize>c : <usize>(c > 0xFFFFFFFF ? 0xFFFFFFFF : c); }   // a size
// @ts-ignore
@inline function chk(p: usize, n: usize): void {
  if (p < guard) unreachable();
  if (!M64 && <u64>p + <u64>n > 0x1_0000_0000) unreachable();
}
// @ts-ignore
@inline function ret(d: i32): u64 { return <u64><i64>d; }

function memcmp(p: usize, q: usize, n: usize): u64 {
  let i: usize = 0;
  while (i + 8 <= n) {
    const x = load<u64>(p + i), y = load<u64>(q + i);
    if (x != y) { const k = <usize>(ctz(x ^ y) >> 3); return ret(<i32>load<u8>(p + i + k) - <i32>load<u8>(q + i + k)); }
    i += 8;
  }
  for (; i < n; i++) { const d = <i32>load<u8>(p + i) - <i32>load<u8>(q + i); if (d) return ret(d); }
  return 0;
}
function strlen(p: usize): usize {
  let i: usize = 0;
  while ((p + i) & 7) { if (!load<u8>(p + i)) return i; i++; }
  while (true) {   // aligned words never cross the end of the memory (a multiple of 64 KB)
    const z = zbytes(load<u64>(p + i));
    if (z) return i + <usize>(ctz(z) >> 3);
    i += 8;
  }
}
function strnlen(p: usize, n: usize): usize {
  let i: usize = 0;
  while (i < n && ((p + i) & 7)) { if (!load<u8>(p + i)) return i; i++; }
  while (i + 8 <= n) {
    const z = zbytes(load<u64>(p + i));
    if (z) return i + <usize>(ctz(z) >> 3);
    i += 8;
  }
  for (; i < n; i++) if (!load<u8>(p + i)) return i;
  return n;
}
// strcmp / strncmp: eight bytes at a time while both words are aligned (an aligned word never crosses the end of the
// memory), equal and without the terminator; bytes otherwise
function strncmp(p: usize, q: usize, n: usize): u64 {
  let i: usize = 0;
  const al = !((p ^ q) & 7);
  while (i < n) {
    if (al && !((p + i) & 7) && i + 8 <= n) {
      const x = load<u64>(p + i);
      if (x == load<u64>(q + i) && !zbytes(x)) { i += 8; continue; }
    }
    const a = <i32>load<u8>(p + i), c = <i32>load<u8>(q + i);
    if (a != c || !a) return ret(a - c);
    i++;
  }
  return 0;
}
function memchr(p: usize, c: u8, n: usize): usize {
  let i: usize = 0;
  const m = <u64>c * ONES;
  while (i < n && ((p + i) & 7)) { if (load<u8>(p + i) == c) return p + i; i++; }
  while (i + 8 <= n) {
    const z = zbytes(load<u64>(p + i) ^ m);
    if (z) return p + i + <usize>(ctz(z) >> 3);
    i += 8;
  }
  for (; i < n; i++) if (load<u8>(p + i) == c) return p + i;
  return 0;
}

export function libc(op: i32, a: u64, b: u64, c: u64): u64 {
  const s = STATS + (<usize>op << 4);
  store<u64>(s, load<u64>(s) + 1);
  const p = A(a), q = A(b);
  let n: usize = 0, r: u64 = 0;
  switch (op) {
    case LIBC_MEMCPY: case LIBC_MEMMOVE:
      n = L(c);
      if (n) { chk(p, n); chk(q, n); memory.copy(p, q, n); }
      r = a; break;
    case LIBC_MEMSET:
      n = L(c);
      if (n) { chk(p, n); memory.fill(p, <u8>b, n); }
      r = a; break;
    case LIBC_MEMCMP:
      n = L(c);
      if (n) { chk(p, n); chk(q, n); r = memcmp(p, q, n); }
      break;
    case LIBC_MEMCHR: {
      n = L(c);
      if (!n) break;
      chk(p, n);
      const f = memchr(p, <u8>b, n);
      r = f ? (M64 ? <u64>f : (a & 0xFFFFFFFF_00000000) | <u64>f) : 0;
      if (f) n = f - p + 1;
      break;
    }
    case LIBC_STRLEN: chk(p, 1); n = strlen(p); r = <u64>n; break;
    case LIBC_STRNLEN: if (!b) break; chk(p, 1); n = strnlen(p, L(b)); r = <u64>n; break;
    case LIBC_STRCMP: chk(p, 1); chk(q, 1); r = strncmp(p, q, <usize>-1); break;
    case LIBC_STRNCMP: if (!c) break; chk(p, 1); chk(q, 1); r = strncmp(p, q, L(c)); break;
    default: unreachable();
  }
  store<u64>(s, load<u64>(s + 8) + <u64>n, 8);
  return r;
}
// how often each op was called (what 0) and the bytes it covered (what 1); the guard for its pointers
export function libcStat(op: i32, what: i32): u64 { return op > 0 && op < LIBC_OPS ? load<u64>(STATS + (<usize>op << 4) + (<usize>(what & 1) << 3)) : 0; }
export function libcGuard(v: u64): void { guard = <usize>v; }
