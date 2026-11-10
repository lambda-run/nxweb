// NSO0 and NRO0 files: the header, validated against the file's size before anything it says is used, and the
// segments (stored as they are or LZ4 block compressed) written to their place in memory.
// The checks are those of nxnative's dm/tools/nso.py (Horizon's own, plus bounds so a small file cannot claim gigabytes).
// A damaged file is refused with a "[RED] " line; nothing is ever read outside [file, file + fileLen).
import { lz4Decompress } from "./lz4";
import { sha256 } from "./sha256";
import { PAGE, red, puts, putu, putx, emit } from "./util";
import { ModuleRefuseReason } from "../kit/gen/tables";

export const KIND_NSO: u32 = 1;
export const KIND_NRO: u32 = 2;

// Options of a parse
export const OPT_VERIFY_HASH: u32 = 1;   // check a segment's SHA-256 where the header's check-hash flag is set (as Horizon does)

const LZ4_MAX_RATIO: u64 = 255;          // an LZ4 block produces at most 255 bytes per stored byte
const SIZE_MAX: u32 = 0x7FFFFFFF;        // Horizon reads segment sizes as s32
const NSO_ZSTD: u32 = 1 << 7;            // ZBIC segments (system 22.0.0 on): not decoded here
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
      if (comp && (flags & NSO_ZSTD)) { bad(i); puts("is ZBIC (zstd) compressed, which this loader does not decode"); emit(); return ModuleRefuseReason.header; }
      if (comp && <u64>sz > <u64>st * LZ4_MAX_RATIO) {
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
// validated by parseHeader, and the decompressor checks every read and write.
export function loadSegments(L: Layout, dst: usize): u64 {
  const file = <usize>L.file;
  let at: u32 = 0;
  for (let i: u32 = 0; i < 3; i++) {
    const mo = L.memOff(i), sz = L.size(i), st = L.stored(i), src = file + <usize>L.fileOff(i);
    memory.fill(dst + <usize>at, 0, <usize>(mo - at));
    if (L.compressed(i)) {
      const n = lz4Decompress(src, st, dst + <usize>mo, sz);
      if (n < 0) { bad(i); puts("does not decompress (damaged LZ4 block)"); emit(); return ModuleRefuseReason.decompress; }
      if (<u32>n != sz) {
        bad(i); puts("decompresses to "); putx(<u32>n); puts(" bytes, not the "); putx(sz); puts(" of the header: the file is damaged"); emit();
        return ModuleRefuseReason.decompress;
      }
    } else memory.copy(dst + <usize>mo, src, <usize>sz);
    if ((L.opts & OPT_VERIFY_HASH) && L.hashed(i)) {
      sha256(dst + <usize>mo, sz, DIGEST);
      if (memory.compare(DIGEST, file + 0xA0 + (<usize>i << 5), 32) != 0) {
        bad(i); puts("does not match its SHA-256 in the header: the file is damaged"); emit(); return ModuleRefuseReason.hash;
      }
    }
    at = mo + sz;
  }
  memory.fill(dst + <usize>at, 0, <usize>(L.imageSize - at));
  return 0;
}
