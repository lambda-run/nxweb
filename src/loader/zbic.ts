// ZBIC decompression: the format of a compressed NSO segment from system 22.0.0 on (NSO flag bit 7).
//
// ZBIC is Zstandard (RFC 8878) with two changes:
//   1. the frame magic is "ZBIC" (5A 42 49 43) instead of 28 B5 2F FD;
//   2. an FSE table description (the normalized counts of a sequence table in FSE_Compressed mode, and of the
//      table that codes Huffman weights) is not Zstandard's variable-width bit field but a byte string coded by
//      binary interpolation (readCounts below).
// Everything else is Zstandard as published: frame header, block types, literals (raw, RLE, Huffman in 1 or 4
// streams, a repeated tree), sequences (predefined, RLE, FSE and repeated tables, the three repeat offsets), the
// optional XXH64 checksum, skippable frames.
//
// Written here from the format: Zstandard from RFC 8878, the two changes from reading the ZBIC changes of
// Atmosphere-NX's zstd (https://github.com/Atmosphere-NX/Atmosphere, as packaged by https://github.com/kinnay/zbic,
// both GPLv2) as a description of the format. No code or table of either is copied: the interpolation order is
// computed (bicOrder), and the decoder shares nothing with zstd's structure. The tests compare this decoder with
// that package on generated streams (test/loader/f_zbic.test.mts).
//
// No heap: the work area is static (a block's literals, the Huffman table, the three sequence tables). The output is
// its own window: a match copies from what was already written to dst, so memory beyond the output is about 150 KB
// whatever the size of the segment. Every read is checked against the end of the input and every write against the
// end of the output; a damaged stream gives a negative reason, never a read or write outside. Bytes of
// [dst, dst + dstCap) past what was produced may have been written (copies run a few bytes ahead inside the output).

export const ZBIC_MAGIC: u32 = 0x4349425A;

// Why a stream was refused (the result is the negated value)
export const ZE_TRUNCATED: i32 = 1;    // the input ends inside a frame
export const ZE_MAGIC: i32 = 2;        // no "ZBIC" where a frame must start
export const ZE_HEADER: i32 = 3;       // frame header: reserved bit, or a window larger than 2 GB
export const ZE_DICT: i32 = 4;         // the frame names a dictionary
export const ZE_BLOCK: i32 = 5;        // block header: reserved type, or a compressed block larger than the frame allows
export const ZE_LITERALS: i32 = 6;     // literals section header
export const ZE_HUF_TABLE: i32 = 7;    // Huffman tree description
export const ZE_HUF_STREAM: i32 = 8;   // Huffman-coded literals
export const ZE_SEQ_HEADER: i32 = 9;   // sequences section header
export const ZE_FSE_TABLE: i32 = 10;   // FSE table description
export const ZE_SEQ_STREAM: i32 = 11;  // sequence bitstream
export const ZE_OFFSET: i32 = 12;      // a match that starts before the frame's output
export const ZE_OUTPUT: i32 = 13;      // more output than there is room for
export const ZE_SIZE: i32 = 14;        // a frame produced another size than its header says
export const ZE_CHECKSUM: i32 = 15;    // the frame's checksum does not match
export const ZE_EMPTY: i32 = 16;       // no frame at all

export function zbicWhy(code: i32): string {
  switch (code < 0 ? -code : code) {
    case ZE_TRUNCATED: return "the stream is cut short";
    case ZE_MAGIC: return "no ZBIC frame where one must start";
    case ZE_HEADER: return "bad frame header";
    case ZE_DICT: return "the frame needs a dictionary";
    case ZE_BLOCK: return "bad block header";
    case ZE_LITERALS: return "bad literals header";
    case ZE_HUF_TABLE: return "bad Huffman table";
    case ZE_HUF_STREAM: return "damaged Huffman stream";
    case ZE_SEQ_HEADER: return "bad sequences header";
    case ZE_FSE_TABLE: return "bad FSE table";
    case ZE_SEQ_STREAM: return "damaged sequence stream";
    case ZE_OFFSET: return "a match before the start of the output";
    case ZE_OUTPUT: return "more output than the header's size";
    case ZE_SIZE: return "a frame's output is not the size its header says";
    case ZE_CHECKSUM: return "checksum mismatch";
    case ZE_EMPTY: return "no frame";
  }
  return "unknown error";
}

const BLOCK_MAX: u32 = 1 << 17;          // the largest block a frame may hold (and the most literals of one block)
const LIT_PAD: usize = 32;
const HUF_LOG_MAX: u32 = 12;
const LL_MAX: u32 = 35, OF_MAX: u32 = 31, ML_MAX: u32 = 52;
const LL_LOG_MAX: u32 = 9, OF_LOG_MAX: u32 = 8, ML_LOG_MAX: u32 = 9;

// What the streams decoded since zbicStatsClear() used (zbicStat): the tests check that every part of the format was
// reached.
export const ZS_FRAMES: u32 = 0, ZS_SKIPPABLE: u32 = 1, ZS_CHECKSUMS: u32 = 2, ZS_BLOCK_RAW: u32 = 3, ZS_BLOCK_RLE: u32 = 4, ZS_BLOCK_COMPRESSED: u32 = 5,
  ZS_LIT_RAW: u32 = 6, ZS_LIT_RLE: u32 = 7, ZS_LIT_HUF1: u32 = 8, ZS_LIT_HUF4: u32 = 9, ZS_LIT_REPEAT1: u32 = 10, ZS_LIT_REPEAT4: u32 = 11,
  ZS_WEIGHTS_DIRECT: u32 = 12, ZS_WEIGHTS_FSE: u32 = 13, ZS_LL_MODE: u32 = 14, ZS_OF_MODE: u32 = 18, ZS_ML_MODE: u32 = 22,   // + mode: predefined, RLE, FSE, repeat
  ZS_NO_SEQUENCES: u32 = 26, ZS_REP_FIRST: u32 = 27, ZS_REP_SECOND: u32 = 28, ZS_REP_THIRD: u32 = 29, ZS_REP_FIRST_LESS_1: u32 = 30,
  ZS_FAR_MATCH: u32 = 31, ZS_LOW_COUNTS: u32 = 32, ZS_COUNT: u32 = 33;
const STATS: usize = memory.data(4 * 33);
// @ts-ignore: decorator
@inline function stat(i: u32, n: u32 = 1): void { const p = STATS + (<usize>i << 2); store<u32>(p, load<u32>(p) + n); }
export function zbicStat(i: u32): u32 { return i < ZS_COUNT ? load<u32>(STATS + (<usize>i << 2)) : 0; }
export function zbicStatsClear(): void { memory.fill(STATS, 0, 4 * 33); }

// ---- static work area ----
const LIT: usize = memory.data(<i32>(BLOCK_MAX + 32));          // a block's literals when they are not raw
const HUF: usize = memory.data(2 << 12);                         // Huffman table: u16 per code prefix = symbol | bits << 8
// A sequence table entry (8 bytes): u16 next-state base, u8 state bits, u8 extra bits, u32 base value
const LLT: usize = memory.data(8 << 9), OFT: usize = memory.data(8 << 8), MLT: usize = memory.data(8 << 9);
const LLD: usize = memory.data(8 << 6), OFD: usize = memory.data(8 << 5), MLD: usize = memory.data(8 << 6);   // the predefined tables
const WFT: usize = memory.data(4 << 6);                          // the table that decodes Huffman weights: u16 base, u8 symbol, u8 bits
const NORM: usize = memory.data(2 * 64);                         // i16 normalized counts of the table being read
const CUM: usize = memory.data(4 * 65);                          // u32 cumulative counts (readCounts)
const NEXT: usize = memory.data(2 * 64);                         // u16 per symbol (table building)
const SPREAD: usize = memory.data(512);                          // u8 symbol per state (table building)
const WEIGHTS: usize = memory.data(256);
const RANK: usize = memory.data(4 * 16);
const ORDER: usize = memory.data(3 * 64);                        // the interpolation order over [0, 64]: (middle, low, high) bytes
let orderReady: bool = false;
let defaultsReady: bool = false;

const LL_BASE = memory.data<u32>([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 0x80, 0x100, 0x200, 0x400, 0x800, 0x1000, 0x2000, 0x4000, 0x8000, 0x10000]);
const LL_BITS = memory.data<u8>([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const ML_BASE = memory.data<u32>([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
  35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 0x83, 0x103, 0x203, 0x403, 0x803, 0x1003, 0x2003, 0x4003, 0x8003, 0x10003]);
const ML_BITS = memory.data<u8>([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
// Offsets: code c has c extra bits; from code 2 on the base is (1 << c) - 3, codes 0 and 1 name the repeat offsets
const OF_BASE: usize = memory.data(4 * 32);
const OF_BITS: usize = memory.data(32);
const LL_DEF = memory.data<i16>([4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1]);
const ML_DEF = memory.data<i16>([1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  -1, -1, -1, -1, -1, -1, -1]);
const OF_DEF = memory.data<i16>([1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1]);

// ---- a bitstream read backwards (FSE and Huffman streams): the last byte's highest set bit ends it ----
// `bCont` holds the 8 bytes at bPtr, of which the top bUsed bits are consumed. Bits before the first byte read as 0;
// consuming any of them is found by the "exact end" test every stream ends with.
let bStart: usize = 0, bPtr: usize = 0, bCont: u64 = 0, bUsed: u32 = 0;

function bitInit(src: usize, len: usize): bool {
  if (!len) return false;
  const last = <u32>load<u8>(src + len - 1);
  if (!last) return false;
  bStart = src;
  if (len >= 8) { bPtr = src + len - 8; bCont = load<u64>(bPtr); bUsed = <u32>clz<u32>(last) - 23; }
  else {
    let c: u64 = 0;
    for (let i: usize = 0; i < len; i++) c |= <u64>load<u8>(src + i) << (<u64>i << 3);
    bPtr = src; bCont = c; bUsed = <u32>clz<u32>(last) - 23 + ((8 - <u32>len) << 3);
  }
  return true;
}
// Bring the container forward. False once more bits were consumed than the stream holds.
function bitReload(): bool {
  if (bUsed > 64) return false;
  if (bPtr >= bStart + 8) { bPtr -= <usize>(bUsed >> 3); bUsed &= 7; bCont = load<u64>(bPtr); }
  else if (bPtr > bStart) {
    let nb = <usize>(bUsed >> 3);
    if (nb > bPtr - bStart) nb = bPtr - bStart;
    bPtr -= nb; bUsed -= <u32>nb << 3; bCont = load<u64>(bPtr);
  }
  return true;
}
// n bits (0..32). The caller reloads often enough that bUsed + n <= 64 while the stream has bits.
function bitRead(n: u32): u32 {
  const v = bUsed >= 64 ? 0 : <u32>(((bCont << <u64>bUsed) >> 1) >> <u64>(63 - n));
  bUsed += n;
  return v;
}
// @ts-ignore: decorator
@inline function bitsLeft(start: usize, ptr: usize, used: u32): i64 { return (<i64>(ptr - start) << 3) + 64 - <i64>used; }

// ---- FSE table description, ZBIC's coding ----
// The interpolation order over [0, 64]: each node of the binary subdivision gives (middle, low, high); a node, then
// its upper half, then its lower half. A table of fewer symbols uses the subdivision of [0, P], which is the tail of
// this list (P - 1 nodes).
function bicNode(at: i32, lo: u32, hi: u32): i32 {
  if (hi - lo < 2) return at;
  const mid = (lo + hi) >> 1, p = ORDER + <usize>at * 3;
  store<u8>(p, <u8>mid); store<u8>(p, <u8>lo, 1); store<u8>(p, <u8>hi, 2);
  at = bicNode(at + 1, mid, hi);
  return bicNode(at, lo, mid);
}
let cSym: u32 = 0, cLog: u32 = 0;   // what readCounts found: the highest symbol and the table's log2 size

// The description at [src, src + len): the counts of symbols 0..cSym into NORM (-1: a symbol of probability "less
// than one"), their table size 1 << cLog. Returns the bytes it takes, or 0 when it is damaged.
//
// The first byte holds the number of bytes that follow (low 7 bits) and whether counts are stored plus one (bit 7,
// which is how -1 is written). Those bytes are one large number in mixed radix, read from the last byte to the first
// through a 64-bit accumulator that takes another byte whenever it is below 2^40. Its digits, in order:
//   base 52: the highest symbol, minus 1          base 8: the table log, minus 5
//   base 1 << log: the total of the stored counts, minus 1 (minus symbols + 1 more when stored plus one)
//   then the cumulative counts C[1..P-1] (C[0] = 0, C[P] = the total, P the power of two above the highest symbol)
//   by interpolation: C[middle] - C[low] in base C[high] - C[low] + 1, a node being skipped (its whole range takes
//   C[low]) when C[low] = C[high]; and a last digit in base C[1] + 1 when C[1] is not 0.
function readCounts(src: usize, len: usize, maxSym: u32): usize {
  if (!len) return 0;
  const b0 = <u32>load<u8>(src);
  let n: usize = b0 & 0x7F;
  const plusOne: u32 = b0 >> 7;
  if (n + 1 >= len) return 0;          // the description is always followed by the stream it describes
  const size = n + 1;
  let x: u64 = 0;
  while (n && x < 0x10000000000) { x = (x << 8) | load<u8>(src + n); n--; }
  const sym = <u32>(x % 52) + 1; x /= 52;
  while (n && x < 0x10000000000) { x = (x << 8) | load<u8>(src + n); n--; }
  if (sym > maxSym) return 0;
  const log = <u32>(x & 7) + 5; x >>= 3;
  while (n && x < 0x10000000000) { x = (x << 8) | load<u8>(src + n); n--; }
  const tsize: u32 = 1 << log;
  let total = <u32>(x % tsize) + 1; x /= tsize;
  while (n && x < 0x10000000000) { x = (x << 8) | load<u8>(src + n); n--; }
  if (plusOne) total += sym + 1;
  let p: u32 = 2;
  while (p <= sym) p <<= 1;            // sym <= 52, so p <= 64
  if (!orderReady) { bicNode(0, 0, 64); orderReady = true; }
  store<u32>(CUM, 0); store<u32>(CUM + (<usize>p << 2), total);
  let node = ORDER + <usize>(64 - p) * 3;
  for (let i: u32 = 1; i < p; i++, node += 3) {
    const mid = <usize>load<u8>(node), lo = <usize>load<u8>(node, 1), hi = <usize>load<u8>(node, 2);
    const a = load<u32>(CUM + (lo << 2)), b = load<u32>(CUM + (hi << 2));
    if (a == b) { for (let k = lo + 1; k < hi; k++) store<u32>(CUM + (k << 2), a); }
    else {
      const r = <u64>(b - a + 1);
      store<u32>(CUM + (mid << 2), a + <u32>(x % r)); x /= r;
      while (n && x < 0x10000000000) { x = (x << 8) | load<u8>(src + n); n--; }
    }
  }
  const c1 = load<u32>(CUM, 4);
  if (c1) {                             // the last digit carries nothing
    x /= <u64>(c1 + 1);
    while (n && x < 0x10000000000) { x = (x << 8) | load<u8>(src + n); n--; }
  }
  let acc: u32 = 0, remaining: i32 = <i32>tsize;
  for (let s: u32 = 0; s <= sym; s++) {
    const c = load<u32>(CUM + (<usize>(s + 1) << 2));
    const count = <i32>(c - acc) - <i32>plusOne;
    acc = c;
    store<i16>(NORM + (<usize>s << 1), <i16>count);
    remaining -= count < 0 ? -count : count;
  }
  if (remaining || n) return 0;         // the counts must fill the table exactly, and every byte must be used
  cSym = sym; cLog = log;
  if (plusOne) stat(ZS_LOW_COUNTS);
  return size;
}

// The symbols of an FSE table of 1 << log states spread over SPREAD from the counts at `norm` (symbols 0..maxSym),
// and each symbol's first "next state" into NEXT (RFC 8878 4.1.1)
function fseSpread(norm: usize, maxSym: u32, log: u32): void {
  const size: u32 = 1 << log, mask = size - 1, step = (size >> 1) + (size >> 3) + 3;
  let high = size - 1;
  for (let s: u32 = 0; s <= maxSym; s++) {
    const c = <i32>load<i16>(norm + (<usize>s << 1));
    if (c == -1) { store<u8>(SPREAD + <usize>high, <u8>s); high--; store<u16>(NEXT + (<usize>s << 1), 1); }
    else store<u16>(NEXT + (<usize>s << 1), <u16>c);
  }
  let pos: u32 = 0;
  for (let s: u32 = 0; s <= maxSym; s++) {
    const c = <i32>load<i16>(norm + (<usize>s << 1));
    for (let i: i32 = 0; i < c; i++) {
      store<u8>(SPREAD + <usize>pos, <u8>s);
      do pos = (pos + step) & mask; while (pos > high);
    }
  }
}
// A sequence table at tbl from the counts at `norm`
function buildSeqTable(tbl: usize, norm: usize, maxSym: u32, log: u32, bases: usize, bits: usize): void {
  fseSpread(norm, maxSym, log);
  const size: u32 = 1 << log;
  for (let u: u32 = 0; u < size; u++) {
    const s = <usize>load<u8>(SPREAD + <usize>u);
    const next = <u32>load<u16>(NEXT + (s << 1));
    store<u16>(NEXT + (s << 1), <u16>(next + 1));
    const nb = log - (31 - <u32>clz<u32>(next));
    const e = tbl + (<usize>u << 3);
    store<u16>(e, <u16>((next << nb) - size)); store<u8>(e, <u8>nb, 2); store<u8>(e, load<u8>(bits + s), 3); store<u32>(e, load<u32>(bases + (s << 2)), 4);
  }
}
function buildDefaults(): void {
  store<u32>(OF_BASE, 0); store<u32>(OF_BASE, 1, 4);
  for (let c: u32 = 2; c < 32; c++) store<u32>(OF_BASE + (<usize>c << 2), (<u32>1 << c) - 3);
  for (let c: u32 = 0; c < 32; c++) store<u8>(OF_BITS + <usize>c, <u8>c);
  buildSeqTable(LLD, LL_DEF, 35, 6, LL_BASE, LL_BITS);
  buildSeqTable(OFD, OF_DEF, 28, 5, OF_BASE, OF_BITS);
  buildSeqTable(MLD, ML_DEF, 52, 6, ML_BASE, ML_BITS);
  defaultsReady = true;
}

// ---- Huffman ----
let hufLog: u32 = 0;      // the current tree's depth; 0: no tree yet (a "repeat" literals block is then damaged)

// The FSE-coded weights at [src, src + len) into WEIGHTS: how many, or -1
function readWeightsFse(src: usize, len: usize): i32 {
  const used = readCounts(src, len, 255);
  if (!used || cLog > 6) return -1;
  fseSpread(NORM, cSym, cLog);
  const size: u32 = 1 << cLog;
  for (let u: u32 = 0; u < size; u++) {
    const s = <usize>load<u8>(SPREAD + <usize>u);
    const next = <u32>load<u16>(NEXT + (s << 1));
    store<u16>(NEXT + (s << 1), <u16>(next + 1));
    const nb = cLog - (31 - <u32>clz<u32>(next));
    const e = WFT + (<usize>u << 2);
    store<u16>(e, <u16>((next << nb) - size)); store<u8>(e, <u8>s, 2); store<u8>(e, <u8>nb, 3);
  }
  if (!bitInit(src + used, len - used)) return -1;
  let s1 = <usize>bitRead(cLog), s2 = <usize>bitRead(cLog);
  if (!bitReload()) return -1;
  // two states take turns; the stream ends when an update asks for more bits than there are, and the other state
  // then gives the last symbol
  let n: usize = 0;
  for (;;) {
    if (n > 253) return -1;
    let e = WFT + (s1 << 2);
    store<u8>(WEIGHTS + n++, load<u8>(e, 2));
    s1 = <usize>load<u16>(e) + bitRead(load<u8>(e, 3));
    if (!bitReload()) { store<u8>(WEIGHTS + n++, load<u8>(WFT + (s2 << 2), 2)); break; }
    if (n > 253) return -1;
    e = WFT + (s2 << 2);
    store<u8>(WEIGHTS + n++, load<u8>(e, 2));
    s2 = <usize>load<u16>(e) + bitRead(load<u8>(e, 3));
    if (!bitReload()) { store<u8>(WEIGHTS + n++, load<u8>(WFT + (s1 << 2), 2)); break; }
  }
  return <i32>n;
}
// The tree description at [src, src + len) into HUF and hufLog: the bytes it takes, or 0
function readHufTable(src: usize, len: usize): usize {
  if (!len) return 0;
  const h = <usize>load<u8>(src);
  let n: i32, used: usize;
  if (h >= 128) {                        // weights as 4-bit fields
    n = <i32>h - 127;
    used = 1 + ((<usize>n + 1) >> 1);
    if (used > len) return 0;
    stat(ZS_WEIGHTS_DIRECT);
    for (let i: i32 = 0; i < n; i++) { const b = load<u8>(src + 1 + (<usize>i >> 1)); store<u8>(WEIGHTS + <usize>i, (i & 1) ? b & 15 : b >> 4); }
  } else {
    used = 1 + h;
    if (used > len) return 0;
    n = readWeightsFse(src + 1, h);
    if (n < 0) return 0;
    stat(ZS_WEIGHTS_FSE);
  }
  memory.fill(RANK, 0, 64);
  let total: u32 = 0;
  for (let i: i32 = 0; i < n; i++) {
    const w = <u32>load<u8>(WEIGHTS + <usize>i);
    if (w > HUF_LOG_MAX) return 0;
    store<u32>(RANK + (<usize>w << 2), load<u32>(RANK + (<usize>w << 2)) + 1);
    total += (<u32>1 << w) >> 1;
  }
  if (!total) return 0;
  const log: u32 = 32 - <u32>clz<u32>(total);
  if (log > HUF_LOG_MAX) return 0;
  const rest = (<u32>1 << log) - total;                   // the last symbol's weight is what completes the tree
  if (rest & (rest - 1)) return 0;
  const lastW: u32 = 32 - <u32>clz<u32>(rest);
  store<u8>(WEIGHTS + <usize>n, <u8>lastW);
  store<u32>(RANK + (<usize>lastW << 2), load<u32>(RANK + (<usize>lastW << 2)) + 1);
  const r1 = load<u32>(RANK, 4);
  if (r1 < 2 || (r1 & 1)) return 0;
  // codes in order of weight, then of symbol: the lightest symbols take the lowest prefixes
  let at: u32 = 0;
  for (let w: u32 = 1; w <= log; w++) { const c = load<u32>(RANK + (<usize>w << 2)); store<u32>(RANK + (<usize>w << 2), at); at += c << (w - 1); }
  for (let s: i32 = 0; s <= n; s++) {
    const w = <u32>load<u8>(WEIGHTS + <usize>s);
    if (!w) continue;
    const span: u32 = <u32>1 << (w - 1), e = <u16>(<u32>s | ((log + 1 - w) << 8));
    const from = load<u32>(RANK + (<usize>w << 2));
    store<u32>(RANK + (<usize>w << 2), from + span);
    for (let p = HUF + (<usize>from << 1), pe = p + (<usize>span << 1); p < pe; p += 2) store<u16>(p, e);
  }
  hufLog = log;
  return used;
}
// One Huffman stream [src, src + len) decoded to exactly n bytes at dst (which has room for them)
function hufStream(src: usize, len: usize, dst: usize, n: usize): bool {
  if (!bitInit(src, len)) return false;
  const start = bStart, fast = start + 8, sh: u64 = 64 - hufLog;
  let p = bPtr, c = bCont, used = bUsed;
  let o = dst;
  const oEnd = dst + n;
  // four symbols per reload while 8 whole bytes lie below the container (4 * 12 bits + 7 fit in it)
  while (p >= fast && oEnd - o >= 4) {
    p -= <usize>(used >> 3); used &= 7; c = load<u64>(p);
    let e = <u32>load<u16>(HUF + (<usize>((c << <u64>used) >> sh) << 1)); store<u8>(o, <u8>e); used += e >> 8;
    e = <u32>load<u16>(HUF + (<usize>((c << <u64>used) >> sh) << 1)); store<u8>(o, <u8>e, 1); used += e >> 8;
    e = <u32>load<u16>(HUF + (<usize>((c << <u64>used) >> sh) << 1)); store<u8>(o, <u8>e, 2); used += e >> 8;
    e = <u32>load<u16>(HUF + (<usize>((c << <u64>used) >> sh) << 1)); store<u8>(o, <u8>e, 3); used += e >> 8;
    o += 4;
  }
  while (o < oEnd) {
    if (used >= 64) {
      if (used > 64 || p == start) return false;       // nothing left to decode from
    }
    if (p > start) {
      let nb = <usize>(used >> 3);
      if (nb > p - start) nb = p - start;
      p -= nb; used -= <u32>nb << 3; c = load<u64>(p);
    }
    const e = <u32>load<u16>(HUF + (<usize>((c << <u64>used) >> sh) << 1));
    store<u8>(o++, <u8>e); used += e >> 8;
  }
  return bitsLeft(start, p, used) == 0;
}

// ---- frame state ----
let gSrc: usize = 0, gEnd: usize = 0, gIp: usize = 0;     // the input and where it is read
let gDst: usize = 0, gDstEnd: usize = 0, gOp: usize = 0;  // the output and where it is written
let gFrame: usize = 0;                                    // where the current frame's output starts
let gInFrame: bool = false, gFrames: u32 = 0, gDone: bool = false, gErr: i32 = 0;
let gChecksum: bool = false, gHasSize: bool = false, gSize: u64 = 0, gBlockMax: u32 = 0;
let rep0: usize = 1, rep1: usize = 4, rep2: usize = 8;
let seqReady: bool = false;                               // a block of this frame had sequences: its tables can be repeated
let llT: usize = 0, ofT: usize = 0, mlT: usize = 0, llLog: u32 = 0, ofLog: u32 = 0, mlLog: u32 = 0;
// the literals of the block being decoded: [litPtr, litEnd), readable up to litLimit
let litPtr: usize = 0, litEnd: usize = 0, litLimit: usize = 0;

function frameHeader(): i32 {
  const ip = gIp, left = gEnd - ip;
  if (left < 4) return ZE_TRUNCATED;
  const magic = load<u32>(ip);
  if ((magic & 0xFFFFFFF0) == 0x184D2A50) {             // a skippable frame
    if (left < 8) return ZE_TRUNCATED;
    const n = <usize>load<u32>(ip, 4);
    if (n > left - 8) return ZE_TRUNCATED;
    gIp = ip + 8 + n;
    stat(ZS_SKIPPABLE);
    return 0;
  }
  if (magic != ZBIC_MAGIC) return ZE_MAGIC;
  if (left < 5) return ZE_TRUNCATED;
  const fhd = <u32>load<u8>(ip, 4);
  if (fhd & 8) return ZE_HEADER;
  const single = (fhd >> 5) & 1, fcsId = fhd >> 6, dictId = fhd & 3;
  const dictLen: usize = dictId == 3 ? 4 : dictId, fcsLen: usize = fcsId ? <usize>1 << fcsId : single;
  let at: usize = 5;
  if (left < 5 + (single ^ 1) + dictLen + fcsLen) return ZE_TRUNCATED;
  let window: u64 = 0;
  if (!single) {
    const wd = <u32>load<u8>(ip + at++), wlog = (wd >> 3) + 10;
    if (wlog > 31) return ZE_HEADER;
    window = (<u64>1 << wlog) + ((<u64>1 << wlog) >> 3) * (wd & 7);
  }
  let dict: u32 = 0;
  if (dictLen == 1) dict = load<u8>(ip + at); else if (dictLen == 2) dict = load<u16>(ip + at); else if (dictLen == 4) dict = load<u32>(ip + at);
  at += dictLen;
  if (dict) return ZE_DICT;
  gHasSize = fcsLen != 0;
  if (fcsLen == 1) gSize = load<u8>(ip + at); else if (fcsLen == 2) gSize = <u64>load<u16>(ip + at) + 256;
  else if (fcsLen == 4) gSize = load<u32>(ip + at); else if (fcsLen == 8) gSize = load<u64>(ip + at);
  at += fcsLen;
  if (single) window = gSize;
  if (gHasSize && gSize > <u64>(gDstEnd - gOp)) return ZE_OUTPUT;
  gBlockMax = window < <u64>BLOCK_MAX ? <u32>window : BLOCK_MAX;
  gChecksum = (fhd & 4) != 0;
  gIp = ip + at;
  gFrame = gOp; gInFrame = true;
  rep0 = 1; rep1 = 4; rep2 = 8; seqReady = false; hufLog = 0;
  return 0;
}

// ---- XXH64 (the frame checksum is its low 32 bits, seed 0) ----
const P1: u64 = 0x9E3779B185EBCA87, P2: u64 = 0xC2B2AE3D27D4EB4F, P3: u64 = 0x165667B19E3779F9, P4: u64 = 0x85EBCA77C2B2AE63, P5: u64 = 0x27D4EB2F165667C5;
// @ts-ignore: decorator
@inline function xxRound(acc: u64, v: u64): u64 { return rotl<u64>(acc + v * P2, 31) * P1; }
// @ts-ignore: decorator
@inline function xxMerge(h: u64, v: u64): u64 { return (h ^ xxRound(0, v)) * P1 + P4; }
export function xxh64(ptr: usize, len: usize): u64 {
  let p = ptr, h: u64;
  const end = ptr + len;
  if (len >= 32) {
    let v1: u64 = P1 + P2, v2: u64 = P2, v3: u64 = 0, v4: u64 = 0 - P1;
    const limit = end - 32;
    do {
      v1 = xxRound(v1, load<u64>(p)); v2 = xxRound(v2, load<u64>(p, 8)); v3 = xxRound(v3, load<u64>(p, 16)); v4 = xxRound(v4, load<u64>(p, 24));
      p += 32;
    } while (p <= limit);
    h = rotl<u64>(v1, 1) + rotl<u64>(v2, 7) + rotl<u64>(v3, 12) + rotl<u64>(v4, 18);
    h = xxMerge(h, v1); h = xxMerge(h, v2); h = xxMerge(h, v3); h = xxMerge(h, v4);
  } else h = P5;
  h += <u64>len;
  while (end - p >= 8) { h = rotl<u64>(h ^ xxRound(0, load<u64>(p)), 27) * P1 + P4; p += 8; }
  if (end - p >= 4) { h = rotl<u64>(h ^ (<u64>load<u32>(p) * P1), 23) * P2 + P3; p += 4; }
  while (p < end) { h = rotl<u64>(h ^ (<u64>load<u8>(p) * P5), 11) * P1; p++; }
  h ^= h >> 33; h *= P2; h ^= h >> 29; h *= P3; h ^= h >> 32;
  return h;
}

// ---- a compressed block ----
// The literals section at [src, src + len): sets litPtr / litEnd / litLimit; the bytes it takes, or a negative reason
function literals(src: usize, len: usize): i32 {
  const b0 = <u32>load<u8>(src), type = b0 & 3, fmt = (b0 >> 2) & 3;
  if (type < 2) {                                         // raw or one repeated byte
    let hs: usize, n: usize;
    if (!(fmt & 1)) { hs = 1; n = b0 >> 3; }
    else if (fmt == 1) { hs = 2; n = <usize>load<u16>(src) >> 4; }
    else { if (len < 3) return -ZE_LITERALS; hs = 3; n = (<usize>load<u16>(src) | (<usize>load<u8>(src, 2) << 16)) >> 4; }
    if (n > <usize>gBlockMax) return -ZE_LITERALS;
    if (type == 0) {
      if (hs + n > len) return -ZE_LITERALS;
      litPtr = src + hs; litEnd = litPtr + n; litLimit = gEnd;
      stat(ZS_LIT_RAW);
      return <i32>(hs + n);
    }
    if (hs + 1 > len) return -ZE_LITERALS;
    memory.fill(LIT, load<u8>(src + hs), n);
    stat(ZS_LIT_RLE);
    litPtr = LIT; litEnd = LIT + n; litLimit = LIT + <usize>BLOCK_MAX + LIT_PAD;
    return <i32>(hs + 1);
  }
  if (len < 5) return -ZE_LITERALS;
  if (type == 3 && !hufLog) return -ZE_LITERALS;          // a repeated tree with no tree before it
  const h = load<u32>(src);
  let hs: usize, n: usize, cn: usize;
  if (fmt < 2) { hs = 3; n = <usize>((h >> 4) & 0x3FF); cn = <usize>((h >> 14) & 0x3FF); }
  else if (fmt == 2) { hs = 4; n = <usize>((h >> 4) & 0x3FFF); cn = <usize>(h >> 18); }
  else { hs = 5; n = <usize>((h >> 4) & 0x3FFFF); cn = <usize>(h >> 22) + (<usize>load<u8>(src, 4) << 10); }
  if (n > <usize>gBlockMax) return -ZE_LITERALS;
  if (fmt && n < 6) return -ZE_LITERALS;                  // four streams need at least 6 literals
  if (hs + cn > len) return -ZE_LITERALS;
  let s = src + hs, sl = cn;
  if (type == 2) {
    const t = readHufTable(s, sl);
    if (!t) { hufLog = 0; return -ZE_HUF_TABLE; }
    if (t >= sl) return -ZE_HUF_STREAM;
    s += t; sl -= t;
  }
  if (!fmt) { if (!hufStream(s, sl, LIT, n)) return -ZE_HUF_STREAM; }
  else {
    if (sl < 10) return -ZE_HUF_STREAM;                   // the 6 bytes of sizes and a byte per stream
    const l1 = <usize>load<u16>(s), l2 = <usize>load<u16>(s, 2), l3 = <usize>load<u16>(s, 4), q = (n + 3) >> 2;
    if (<usize>6 + l1 + l2 + l3 >= sl || <usize>3 * q > n) return -ZE_HUF_STREAM;
    const l4 = sl - <usize>6 - l1 - l2 - l3;
    s += 6;
    if (!hufStream(s, l1, LIT, q) || !hufStream(s + l1, l2, LIT + q, q) || !hufStream(s + l1 + l2, l3, LIT + <usize>2 * q, q)
      || !hufStream(s + l1 + l2 + l3, l4, LIT + <usize>3 * q, n - <usize>3 * q)) return -ZE_HUF_STREAM;
  }
  stat((type == 2 ? ZS_LIT_HUF1 : ZS_LIT_REPEAT1) + (fmt ? 1 : 0));
  litPtr = LIT; litEnd = LIT + n; litLimit = LIT + <usize>BLOCK_MAX + LIT_PAD;
  return <i32>(hs + cn);
}

// One of the three tables of a sequences section, by its mode. Returns the bytes it takes, or a negative reason;
// the table and its log go to tOut / tLog.
let tOut: usize = 0, tLog: u32 = 0;
function seqTable(mode: u32, src: usize, len: usize, own: usize, def: usize, defLog: u32, cur: usize, curLog: u32, maxSym: u32, maxLog: u32, bases: usize, bits: usize): i32 {
  if (mode == 0) { tOut = def; tLog = defLog; return 0; }
  if (mode == 1) {
    if (!len) return -ZE_SEQ_HEADER;
    const s = <usize>load<u8>(src);
    if (s > <usize>maxSym) return -ZE_SEQ_HEADER;
    store<u16>(own, 0); store<u8>(own, 0, 2); store<u8>(own, load<u8>(bits + s), 3); store<u32>(own, load<u32>(bases + (s << 2)), 4);
    tOut = own; tLog = 0;
    return 1;
  }
  if (mode == 3) {
    if (!seqReady) return -ZE_SEQ_HEADER;
    tOut = cur; tLog = curLog;
    return 0;
  }
  const used = readCounts(src, len, maxSym);
  if (!used || cLog > maxLog) return -ZE_FSE_TABLE;
  buildSeqTable(own, NORM, cSym, cLog, bases, bits);
  tOut = own; tLog = cLog;
  return <i32>used;
}

// The compressed block [src, src + len) decoded at gOp. 0, or a reason.
function block(src: usize, len: usize): i32 {
  if (len < 2) return ZE_LITERALS;
  const ln = literals(src, len);
  if (ln < 0) return -ln;
  let ip = src + <usize>ln;
  const iend = src + len;
  if (ip >= iend) return ZE_SEQ_HEADER;
  let nseq = <u32>load<u8>(ip++);
  if (nseq > 0x7F) {
    if (nseq == 0xFF) { if (iend - ip < 2) return ZE_SEQ_HEADER; nseq = <u32>load<u16>(ip) + 0x7F00; ip += 2; }
    else { if (ip >= iend) return ZE_SEQ_HEADER; nseq = ((nseq - 0x80) << 8) + load<u8>(ip++); }
  }
  let o = gOp;
  const oEnd = gDstEnd, base = gFrame;
  let lit = litPtr;
  const lEnd = litEnd, lLimit = litLimit;
  if (nseq) {
    if (ip >= iend) return ZE_SEQ_HEADER;
    const modes = <u32>load<u8>(ip++);
    if (modes & 3) return ZE_SEQ_HEADER;
    if (!defaultsReady) buildDefaults();
    let r = seqTable(modes >> 6, ip, iend - ip, LLT, LLD, 6, llT, llLog, LL_MAX, LL_LOG_MAX, LL_BASE, LL_BITS);
    if (r < 0) return -r;
    ip += <usize>r; const tl = tOut, tlLog = tLog;
    r = seqTable((modes >> 4) & 3, ip, iend - ip, OFT, OFD, 5, ofT, ofLog, OF_MAX, OF_LOG_MAX, OF_BASE, OF_BITS);
    if (r < 0) return -r;
    ip += <usize>r; const to = tOut, toLog = tLog;
    r = seqTable((modes >> 2) & 3, ip, iend - ip, MLT, MLD, 6, mlT, mlLog, ML_MAX, ML_LOG_MAX, ML_BASE, ML_BITS);
    if (r < 0) return -r;
    ip += <usize>r;
    llT = tl; llLog = tlLog; ofT = to; ofLog = toLog; mlT = tOut; mlLog = tLog;
    stat(ZS_LL_MODE + (modes >> 6)); stat(ZS_OF_MODE + ((modes >> 4) & 3)); stat(ZS_ML_MODE + ((modes >> 2) & 3));
    seqReady = true;
    if (!bitInit(ip, iend - ip)) return ZE_SEQ_STREAM;
    let sl = <usize>bitRead(llLog); bitReload();
    let so = <usize>bitRead(ofLog); bitReload();
    let sm = <usize>bitRead(mlLog);
    const start = bStart, fast = start + 8, tL = llT, tO = ofT, tM = mlT;
    let p = bPtr, c = bCont, used = bUsed;
    let r0 = rep0, r1 = rep1, r2 = rep2;
    let n1: u32 = 0, n2: u32 = 0, n3: u32 = 0, n4: u32 = 0, nFar: u32 = 0;
    for (; nseq; nseq--) {
      const le = tL + (sl << 3), oe = tO + (so << 3), me = tM + (sm << 3);
      // reload: at most 7 bits of the container are consumed after it while bytes remain below
      if (used > 64) return ZE_SEQ_STREAM;
      if (p >= fast) { p -= <usize>(used >> 3); used &= 7; c = load<u64>(p); }
      else if (p > start) { let nb = <usize>(used >> 3); if (nb > p - start) nb = p - start; p -= nb; used -= <u32>nb << 3; c = load<u64>(p); }
      const llBase = <usize>load<u32>(le, 4);
      const ob = <u32>load<u8>(oe, 3);
      let off: usize;
      if (ob > 1) {
        off = <usize>(<u64>load<u32>(oe, 4) + (((c << <u64>used) >> 1) >> <u64>(63 - ob)));
        used += ob;
        r2 = r1; r1 = r0; r0 = off;
        if (off > <usize>BLOCK_MAX) nFar++;
      } else if (!ob) {
        if (llBase) { off = r0; n1++; }
        else { off = r1; r1 = r0; r0 = off; n2++; }
      } else {
        const which = (llBase ? 1 : 2) + <u32>((c << <u64>used) >> 63);
        used += 1;
        if (which == 1) { off = r1; n2++; } else if (which == 2) { off = r2; n3++; } else { off = r0 - 1; n4++; }
        if (!off) return ZE_OFFSET;
        if (which != 1) r2 = r1;
        r1 = r0; r0 = off;
      }
      const mb = <u32>load<u8>(me, 3);
      const ml = <usize>load<u32>(me, 4) + <usize>(((c << <u64>used) >> 1) >> <u64>(63 - mb));
      used += mb;
      if (used > 64) return ZE_SEQ_STREAM;
      if (p >= fast) { p -= <usize>(used >> 3); used &= 7; c = load<u64>(p); }
      else if (p > start) { let nb = <usize>(used >> 3); if (nb > p - start) nb = p - start; p -= nb; used -= <u32>nb << 3; c = load<u64>(p); }
      const lb = <u32>load<u8>(le, 3);
      const ll = llBase + <usize>(used >= 64 ? 0 : ((c << <u64>used) >> 1) >> <u64>(63 - lb));
      used += lb;
      if (nseq > 1) {
        let nb = <u32>load<u8>(le, 2);
        sl = <usize>load<u16>(le) + <usize>(used >= 64 ? 0 : ((c << <u64>used) >> 1) >> <u64>(63 - nb)); used += nb;
        nb = <u32>load<u8>(me, 2);
        sm = <usize>load<u16>(me) + <usize>(used >= 64 ? 0 : ((c << <u64>used) >> 1) >> <u64>(63 - nb)); used += nb;
        nb = <u32>load<u8>(oe, 2);
        so = <usize>load<u16>(oe) + <usize>(used >= 64 ? 0 : ((c << <u64>used) >> 1) >> <u64>(63 - nb)); used += nb;
      }
      // the sequence: ll literals, then ml bytes from off bytes back
      if (ll > lEnd - lit) return ZE_SEQ_STREAM;
      if (ll + ml > oEnd - o) return ZE_OUTPUT;
      if (ll <= 16 && lLimit - lit >= 16 && oEnd - o >= 16) { store<u64>(o, load<u64>(lit)); store<u64>(o, load<u64>(lit, 8), 8); }
      else memory.copy(o, lit, ll);
      o += ll; lit += ll;
      if (off > o - base) return ZE_OFFSET;
      const m = o - off, mEnd = o + ml;
      if (off >= 8 && oEnd - mEnd >= 8) {
        if (off >= ml && ml > 64) memory.copy(o, m, ml);
        else { let d = o, s = m; do { store<u64>(d, load<u64>(s)); d += 8; s += 8; } while (d < mEnd); }
      } else if (off == 1) memory.fill(o, load<u8>(m), ml);
      else for (let i: usize = 0; i < ml; i++) store<u8>(o + i, load<u8>(m + i));
      o = mEnd;
    }
    if (bitsLeft(start, p, used) != 0) return ZE_SEQ_STREAM;
    rep0 = r0; rep1 = r1; rep2 = r2;
    stat(ZS_REP_FIRST, n1); stat(ZS_REP_SECOND, n2); stat(ZS_REP_THIRD, n3); stat(ZS_REP_FIRST_LESS_1, n4); stat(ZS_FAR_MATCH, nFar);
  } else if (ip != iend) return ZE_SEQ_HEADER;
  else stat(ZS_NO_SEQUENCES);
  const rest = lEnd - lit;
  if (rest > oEnd - o) return ZE_OUTPUT;
  memory.copy(o, lit, rest);
  gOp = o + rest;
  return 0;
}

// ---- the stream, a block at a time ----
// Start decoding [src, src + srcLen) to [dst, dst + dstCap), both of which the caller has checked to lie in memory
// and not to overlap.
export function zbicBegin(src: usize, srcLen: usize, dst: usize, dstCap: usize): void {
  gSrc = src; gEnd = src + srcLen; gIp = src; gDst = dst; gDstEnd = dst + dstCap; gOp = dst;
  gInFrame = false; gFrames = 0; gDone = false; gErr = 0;
}
// Decode whole blocks until at least `budget` more bytes are produced or the stream ends. 1: there is more; 0: the
// stream ended (zbicProduced() bytes); negative: the reason it is refused, which every later call gives again.
export function zbicStep(budget: usize): i32 {
  if (gErr) return -gErr;
  if (gDone) return 0;
  const stop = gOp + (budget < gDstEnd - gOp ? budget : gDstEnd - gOp);
  let e: i32 = 0;
  for (;;) {
    if (!gInFrame) {
      if (gIp == gEnd) { if (!gFrames) e = ZE_EMPTY; else gDone = true; break; }
      e = frameHeader();
      if (e) break;
      continue;
    }
    if (gEnd - gIp < 3) { e = ZE_TRUNCATED; break; }
    const bh = <u32>load<u16>(gIp) | (<u32>load<u8>(gIp, 2) << 16), type = (bh >> 1) & 3, n = <usize>(bh >> 3);
    const ip = gIp + 3;
    if (type == 0) {
      if (n > gEnd - ip) { e = ZE_TRUNCATED; break; }
      if (n > gDstEnd - gOp) { e = ZE_OUTPUT; break; }
      memory.copy(gOp, ip, n); gOp += n; gIp = ip + n; stat(ZS_BLOCK_RAW);
    } else if (type == 1) {
      if (ip >= gEnd) { e = ZE_TRUNCATED; break; }
      if (n > gDstEnd - gOp) { e = ZE_OUTPUT; break; }
      memory.fill(gOp, load<u8>(ip), n); gOp += n; gIp = ip + 1; stat(ZS_BLOCK_RLE);
    } else if (type == 2) {
      if (n > <usize>gBlockMax) { e = ZE_BLOCK; break; }
      if (n > gEnd - ip) { e = ZE_TRUNCATED; break; }
      e = block(ip, n);
      if (e) break;
      gIp = ip + n; stat(ZS_BLOCK_COMPRESSED);
    } else { e = ZE_BLOCK; break; }
    if (bh & 1) {                                           // the frame's last block
      if (gHasSize && <u64>(gOp - gFrame) != gSize) { e = ZE_SIZE; break; }
      if (gChecksum) {
        if (gEnd - gIp < 4) { e = ZE_TRUNCATED; break; }
        if (load<u32>(gIp) != <u32>xxh64(gFrame, gOp - gFrame)) { e = ZE_CHECKSUM; break; }
        gIp += 4; stat(ZS_CHECKSUMS);
      }
      gInFrame = false; gFrames++; stat(ZS_FRAMES);
    }
    if (gOp >= stop && gInFrame) return 1;
  }
  if (e) { gErr = e; return -e; }
  return 0;
}
export function zbicProduced(): usize { return gOp - gDst; }
export function zbicConsumed(): usize { return gIp - gSrc; }

// The whole stream at once: the number of bytes produced, or a negative reason (ZE_*)
export function zbicDecompress(src: usize, srcLen: usize, dst: usize, dstCap: usize): i64 {
  zbicBegin(src, srcLen, dst, dstCap);
  let r: i32;
  do r = zbicStep(dstCap); while (r > 0);      // more than once only for empty blocks after the output is full
  return r < 0 ? r : <i64>zbicProduced();
}
// The size the first frame's header declares, -1 when it declares none, or a negative reason below -1 (-(ZE_* + 1))
export function zbicContentSize(src: usize, srcLen: usize): i64 {
  if (srcLen < 5) return -(ZE_TRUNCATED + 1);
  if (load<u32>(src) != ZBIC_MAGIC) return -(ZE_MAGIC + 1);
  const fhd = <u32>load<u8>(src, 4), single = (fhd >> 5) & 1, fcsId = fhd >> 6, dictId = fhd & 3;
  const fcsLen: usize = fcsId ? <usize>1 << fcsId : single;
  const at: usize = 5 + (single ^ 1) + (dictId == 3 ? 4 : dictId);
  if (srcLen < at + fcsLen) return -(ZE_TRUNCATED + 1);
  if (!fcsLen) return -1;
  if (fcsLen == 1) return load<u8>(src + at);
  if (fcsLen == 2) return <i64>load<u16>(src + at) + 256;
  if (fcsLen == 4) return load<u32>(src + at);
  const v = load<u64>(src + at);
  return v > <u64>i64.MAX_VALUE ? -(ZE_HEADER + 1) : <i64>v;
}
