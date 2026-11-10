// NSO0 and NRO0 files: the header, validated against the file's size before anything it says is used, and the
// segments (stored as they are, LZ4 block compressed, or ZBIC compressed: system 22.0.0 on) written to their place
// in memory.
// The checks are those of nxnative's dm/tools/nso.py (Horizon's own, plus bounds so a small file cannot claim gigabytes).
// A damaged file is refused with a "[RED] " line; nothing is ever read outside [file, file + fileLen).
import { lz4Decompress } from "./lz4";
import { zbicBegin, zbicStep, zbicProduced, zbicWhy, ZBIC_MAGIC } from "./zbic";
import { shaStart, shaBlocks, shaFinish } from "./sha256";
import { PAGE, red, puts, putu, putx, emit } from "./util";
import { ModuleRefuseReason } from "../kit/gen/tables";

export const KIND_NSO: u32 = 1;
export const KIND_NRO: u32 = 2;

// Options of a parse
export const OPT_VERIFY_HASH: u32 = 1;   // check a segment's SHA-256 where the header's check-hash flag is set (as Horizon does)

const LZ4_MAX_RATIO: u64 = 255;          // an LZ4 block produces at most 255 bytes per stored byte
const SIZE_MAX: u32 = 0x7FFFFFFF;        // Horizon reads segment sizes as s32
export const NSO_ZSTD: u32 = 1 << 7;     // the compressed segments are ZBIC (zbic.ts), not LZ4: system 22.0.0 on
const NRO_COMPRESSED: u32 = 1 << 1;
export const IMAGE_MAX: u64 = 0xFFFFF000;   // an image, bss included, must fit below 4 GB (docs/CONTRACT.md)

const DIGEST: usize = memory.data(32);

// What a file's header says, once validated. Segment i is 0 text, 1 read-only data, 2 data.
// @ts-ignore: decorator
@unmanaged
export class Layout {
  kind: u32;        // KIND_NSO or KIND_NRO
  flags: u32;       // NSO: bits 0-2 segment i is compressed, bits 3-5 segment i has its hash checked
  file: u32;        // the file's bytes in linear memory; 0 once the module is pinned
  fileLen: u32;
  opts: u32;
  fo0: u32; fo1: u32; fo2: u32;   // offset in the file
  mo0: u32; mo1: u32; mo2: u32;   // offset in the image
  sz0: u32; sz1: u32; sz2: u32;   // size in the image
  st0: u32; st1: u32; st2: u32;   // size in the file
  bss: u32;
  imageSize: u32;   // text .. the end of the bss, in whole pages
  id0: u64; id1: u64; id2: u64; id3: u64;   // the build ID (module id), 0x20 bytes

  // @ts-ignore: decorator
  @inline fileOff(i: u32): u32 { return load<u32>(changetype<usize>(this) + offsetof<Layout>("fo0") + (<usize>i << 2)); }
  // @ts-ignore: decorator
  @inline memOff(i: u32): u32 { return load<u32>(changetype<usize>(this) + offsetof<Layout>("mo0") + (<usize>i << 2)); }
  // @ts-ignore: decorator
  @inline size(i: u32): u32 { return load<u32>(changetype<usize>(this) + offsetof<Layout>("sz0") + (<usize>i << 2)); }
  // @ts-ignore: decorator
  @inline stored(i: u32): u32 { return load<u32>(changetype<usize>(this) + offsetof<Layout>("st0") + (<usize>i << 2)); }
  // @ts-ignore: decorator
  @inline compressed(i: u32): bool { return ((this.flags >> i) & 1) != 0; }
  // @ts-ignore: decorator
  @inline hashed(i: u32): bool { return this.kind == KIND_NSO && ((this.flags >> (3 + i)) & 1) != 0; }
  // @ts-ignore: decorator
  @inline buildIdPtr(): usize { return changetype<usize>(this) + offsetof<Layout>("id0"); }
  // The end of the bytes that come from the file (the bss starts here)
  // @ts-ignore: decorator
  @inline get initEnd(): u32 { return this.mo2 + this.sz2; }
}

function segName(i: u32): string { return i == 0 ? "text" : i == 1 ? "ro" : "data"; }
function bad(i: u32): void { red(); puts(segName(i)); puts(" segment "); }

// Read and validate the header of the file [file, file + len), which the caller has checked to lie in linear memory.
// Returns 0 and fills L, or the reason for the refusal (ModuleRefuseReason) after logging a red line.
export function parseHeader(L: Layout, file: usize, len: u32, opts: u32): u64 {
  const set = changetype<usize>(L);
  L.file = <u32>file; L.fileLen = len; L.opts = opts;
  if (len >= 0x100 && load<u32>(file) == 0x304F534E) {            // "NSO0"
    L.kind = KIND_NSO;
    const flags = load<u32>(file, 0x0C);
    L.flags = flags;
    for (let i: u32 = 0; i < 3; i++) {
      const h = file + 0x10 + (<usize>i << 4);
      const fo = load<u32>(h), mo = load<u32>(h, 4), sz = load<u32>(h, 8);
      const comp = ((flags >> i) & 1) != 0;
      const st = comp ? load<u32>(file + 0x60 + (<usize>i << 2)) : sz;
      store<u32>(set + offsetof<Layout>("fo0") + (<usize>i << 2), fo);
      store<u32>(set + offsetof<Layout>("mo0") + (<usize>i << 2), mo);
      store<u32>(set + offsetof<Layout>("sz0") + (<usize>i << 2), sz);
      store<u32>(set + offsetof<Layout>("st0") + (<usize>i << 2), st);
      if (<u64>mo % PAGE) { bad(i); puts("is at "); putx(mo); puts(", not on a page"); emit(); return ModuleRefuseReason.layout; }
      if (sz > SIZE_MAX) { bad(i); puts("claims "); putx(sz); puts(" bytes, more than Horizon loads"); emit(); return ModuleRefuseReason.layout; }
      if (<u64>fo + <u64>st > <u64>len) {
        bad(i); puts("is stored at "); putx(fo); puts(".."); putx(<u64>fo + st); puts(", past the end of the file ("); putx(len);
        puts(" bytes): the file is cut short or damaged"); emit(); return ModuleRefuseReason.layout;
      }
      if (comp && st > sz) { bad(i); puts("is stored compressed in "); putx(st); puts(" bytes, more than its "); putx(sz); emit(); return ModuleRefuseReason.layout; }
      if (comp && (flags & NSO_ZSTD)) {
        // a ZBIC stream has no fixed ratio (nxnative holds such a segment only to its own size); it must start as one
        const magic = st >= 4 ? load<u32>(file + <usize>fo) : 0;
        if (magic != ZBIC_MAGIC && (magic & 0xFFFFFFF0) != 0x184D2A50) {
          bad(i); puts("is marked ZBIC compressed (NSO flag bit 7) but does not start with a ZBIC frame: the file is damaged"); emit(); return ModuleRefuseReason.header;
        }
      } else if (comp && <u64>sz > <u64>st * LZ4_MAX_RATIO) {
        bad(i); puts("claims "); putx(sz); puts(" bytes from "); putx(st); puts(" stored, more than LZ4 can produce"); emit(); return ModuleRefuseReason.layout;
      }
    }
    if (L.mo0) { bad(0); puts("is at "); putx(L.mo0); puts(", not at 0"); emit(); return ModuleRefuseReason.layout; }
    for (let i: u32 = 1; i < 3; i++) {
      if (<u64>L.memOff(i) < <u64>L.memOff(i - 1) + <u64>L.size(i - 1)) {
        bad(i); puts("at "); putx(L.memOff(i)); puts(" overlaps the "); puts(segName(i - 1)); puts(" segment before it"); emit(); return ModuleRefuseReason.layout;
      }
    }
    L.bss = load<u32>(file, 0x3C);
    memory.copy(L.buildIdPtr(), file + 0x40, 0x20);
  } else if (len >= 0x80 && load<u32>(file, 0x10) == 0x304F524E) {   // "NRO0" at 0x10: the file is the image itself
    L.kind = KIND_NRO;
    L.flags = 0;
    const size = load<u32>(file, 0x18), nflags = load<u32>(file, 0x1C);
    if (nflags & NRO_COMPRESSED) { red(); puts("a compressed NRO (system 23.0.0+), which this loader does not decode"); emit(); return ModuleRefuseReason.header; }
    let at: u64 = 0;
    for (let i: u32 = 0; i < 3; i++) {
      const o = load<u32>(file + 0x20 + (<usize>i << 3)), sz = load<u32>(file + 0x24 + (<usize>i << 3));
      store<u32>(set + offsetof<Layout>("fo0") + (<usize>i << 2), o);
      store<u32>(set + offsetof<Layout>("mo0") + (<usize>i << 2), o);
      store<u32>(set + offsetof<Layout>("sz0") + (<usize>i << 2), sz);
      store<u32>(set + offsetof<Layout>("st0") + (<usize>i << 2), sz);
      if (<u64>sz % PAGE || <u64>o != at) {
        bad(i); putx(o); puts(".."); putx(<u64>o + sz); puts(" is not whole pages right after the one before it (at "); putx(at); puts(")"); emit();
        return ModuleRefuseReason.layout;
      }
      at += sz;
    }
    if (at != <u64>size) { red(); puts("the segments end at "); putx(at); puts(", not at the module's size "); putx(size); emit(); return ModuleRefuseReason.layout; }
    if (size > len) {
      red(); puts("the module is "); putx(size); puts(" bytes, the file "); putx(len); puts(": the file is cut short or damaged"); emit();
      return ModuleRefuseReason.layout;
    }
    L.bss = load<u32>(file, 0x38);
    memory.copy(L.buildIdPtr(), file + 0x40, 0x20);
  } else {
    red(); puts("not an NSO or NRO ("); putu(len); puts(" bytes"); if (len >= 4) { puts(", magic "); putx(load<u32>(file)); } puts(")"); emit();
    return ModuleRefuseReason.header;
  }
  const end = <u64>L.mo2 + <u64>L.sz2;
  if (end > <u64>len * LZ4_MAX_RATIO) {
    red(); puts("the segments span "); putx(end); puts(" bytes, more than a file of "); putx(len); puts(" bytes can fill"); emit();
    return ModuleRefuseReason.layout;
  }
  const image = (end + <u64>L.bss + PAGE - 1) & ~(PAGE - 1);
  if (image > IMAGE_MAX) { red(); puts("the image with its bss is "); putx(image); puts(" bytes, which does not fit below 4 GB"); emit(); return ModuleRefuseReason.layout; }
  L.imageSize = <u32>image;
  return 0;
}

// Write the whole image to [dst, dst + L.imageSize), which the caller has checked to be free linear memory: the three
// segments from the file (decompressed, hashes checked if asked), zeros between them and for the bss.
// Returns 0, or the reason for the refusal after logging a red line. Reads only inside the file: the offsets were
// validated by parseHeader, and the decompressors check every read and write.
export function loadSegments(L: Layout, dst: usize): u64 {
  loadBegin(L, dst);
  let r: i64;
  do r = loadStep(L, 0xFFFFFFFF); while (r == LOAD_MORE);
  return <u64>r;
}

// The same in steps, for an embedder that shows progress and can stop between them (a main module is over 100 MB):
// loadBegin, then loadStep until it does not return LOAD_MORE. One load at a time: the state is this file's.
export const LOAD_MORE: i64 = -1;
let sDst: usize = 0, sSeg: u32 = 0, sPhase: u32 = 0, sAt: u32 = 0, sHashed: u32 = 0, sWork: u64 = 0;

export function loadBegin(L: Layout, dst: usize): void { sDst = dst; sSeg = 0; sPhase = 0; sAt = 0; sHashed = 0; sWork = 0; }
// The bytes a load decompresses and hashes in all, and how many of them are done
export function loadWorkTotal(L: Layout): u64 {
  let n: u64 = 0;
  for (let i: u32 = 0; i < 3; i++) n += (L.compressed(i) ? <u64>L.size(i) : 0) + ((L.opts & OPT_VERIFY_HASH) && L.hashed(i) ? <u64>L.size(i) : 0);
  return n;
}
export function loadWorkDone(): u64 { return sWork; }
// About `budget` more bytes of work (a stored or LZ4 segment is done whole). LOAD_MORE, 0 when the image is complete,
// or the reason for the refusal after logging a red line (the image is then not to be used).
export function loadStep(L: Layout, budget: u32): i64 {
  const file = <usize>L.file, dst = sDst;
  let left: u64 = budget ? budget : 1;
  while (sSeg < 3) {
    const i = sSeg, mo = L.memOff(i), sz = L.size(i), st = L.stored(i), src = file + <usize>L.fileOff(i), out = dst + <usize>mo;
    if (sPhase == 0) {
      memory.fill(dst + <usize>sAt, 0, <usize>(mo - sAt));
      sPhase = 2;
      if (!L.compressed(i)) memory.copy(out, src, <usize>sz);
      else if (L.flags & NSO_ZSTD) { zbicBegin(src, st, out, sz); sPhase = 1; }
      else {
        const n = lz4Decompress(src, st, out, sz);
        if (n < 0) { bad(i); puts("does not decompress (damaged LZ4 block)"); emit(); return ModuleRefuseReason.decompress; }
        if (<u32>n != sz) {
          bad(i); puts("decompresses to "); putx(<u32>n); puts(" bytes, not the "); putx(sz); puts(" of the header: the file is damaged"); emit();
          return ModuleRefuseReason.decompress;
        }
        sWork += sz; left = left > <u64>sz ? left - sz : 0;
      }
    }
    if (sPhase == 1) {
      if (!left) return LOAD_MORE;
      const before = zbicProduced();
      const r = zbicStep(<usize>(left > 0x7FFFFFFF ? 0x7FFFFFFF : left));
      const made = <u64>(zbicProduced() - before);
      sWork += made; left = left > made ? left - made : 0;
      if (r < 0) { bad(i); puts("does not decompress (damaged ZBIC stream: "); puts(zbicWhy(r)); puts(")"); emit(); return ModuleRefuseReason.decompress; }
      if (r > 0) return LOAD_MORE;
      if (<u64>zbicProduced() != <u64>sz) {
        bad(i); puts("decompresses to "); putx(<u64>zbicProduced()); puts(" bytes, not the "); putx(sz); puts(" of the header: the file is damaged"); emit();
        return ModuleRefuseReason.decompress;
      }
      sPhase = 2;
    }
    if (sPhase == 2) {
      if ((L.opts & OPT_VERIFY_HASH) && L.hashed(i)) { shaStart(); sHashed = 0; sPhase = 3; }
      else sPhase = 4;
    }
    if (sPhase == 3) {
      const full = sz & ~63;
      if (sHashed < full) {
        if (!left) return LOAD_MORE;
        let n: u32 = full - sHashed;
        if (<u64>n > left) n = <u32>((left + 63) & ~63);
        shaBlocks(out + <usize>sHashed, n);
        sHashed += n; sWork += n; left = left > <u64>n ? left - n : 0;
        if (sHashed < full) return LOAD_MORE;
      }
      shaFinish(out + <usize>full, sz - full, sz, DIGEST);
      sWork += sz - full;
      if (memory.compare(DIGEST, file + 0xA0 + (<usize>i << 5), 32) != 0) {
        bad(i); puts("does not match its SHA-256 in the header: the file is damaged"); emit(); return ModuleRefuseReason.hash;
      }
      sPhase = 4;
    }
    sAt = mo + sz; sSeg++; sPhase = 0;
  }
  memory.fill(dst + <usize>sAt, 0, <usize>(L.imageSize - sAt));
  return 0;
}
