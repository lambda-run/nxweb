// Code modules: identity (the build ID) and registered cuts.
//
// A registered cut is nxnative's (dm/tools/patch_nso.py "Registered patches", a profile's patches.py or
// sdk_patches.py, keyed by the NSO build ID): at an offset from the module's start, bytes that must be there and the
// bytes that replace them. As in nxnative every original byte is compared first and a mismatch stops everything:
// a cut never lands on a build it was not found in. Cuts are applied in their listed order to the unpacked image
// (text, read-only data, data), and the result is written as an NSO again: segments stored, hashes recomputed and
// checked by the loader, everything else of the header as it was (the build ID too: it still names the build the
// game's other per-build facts are keyed by). The loader then maps it like any other module, so the translator
// only ever sees the code after the cuts.
import { Layout, parseHeader, loadSegments, loadBegin, loadStep, loadWorkTotal, loadWorkDone, LOAD_MORE, KIND_NSO, OPT_VERIFY_HASH } from "../loader/nso";
import { sha256 } from "../loader/sha256";
import { errorPtr as loaderErrorPtr, errorLen as loaderErrorLen, errorClear as loaderErrorClear } from "../loader/util";
import { red, info, puts, putu, putx, puthex, emit, alloc, errorSet } from "./base";
import { imageInit, matchResolve } from "./match";

// the loader's red line (it was logged by the loader) as this module's last error
function refused(r: u64): i32 { errorSet(loaderErrorPtr(), loaderErrorLen()); return <i32>r; }

const L: Layout = changetype<Layout>(memory.data(offsetof<Layout>()));
let parsed: bool = false;

export const CUT_OK: i32 = 0;
export const CUT_BAD_MODULE: i32 = -1;    // not an NSO, or damaged (the loader's red line says what)
export const CUT_BAD_LIST: i32 = -2;      // the cut list itself is malformed
export const CUT_RANGE: i32 = -3;         // a cut lies outside the module's file-backed image
export const CUT_MISMATCH: i32 = -4;      // the original bytes are not what the cut asserts
export const CUT_NOMEM: i32 = -5;

let failedIndex: i32 = -1;
let applied: u32 = 0;
let outPtr: usize = 0;
let outLen: u32 = 0;

// The header of the module file at [file, file + len): 0, or the loader's refusal reason (a red line was logged)
export function nsoParse(file: usize, len: u32): i32 {
  parsed = false;
  loaderErrorClear();
  const r = parseHeader(L, file, len, OPT_VERIFY_HASH);
  if (r) return refused(r);
  if (L.kind != KIND_NSO) { red(); puts("a code module of the ExeFS must be an NSO, this is an NRO"); emit(); return 1; }
  parsed = true;
  return 0;
}
// The first 0x100 bytes of a module file are enough to name its build: 0 and the build ID at nsoBuildIdPtr(), or 1
// when they are not an NSO header. Nothing else of the header is trusted here (nsoParse / nsoCheck do that).
export function nsoPeek(head: usize, len: u32): i32 {
  parsed = false;
  if (len < 0x100 || load<u32>(head) != 0x304F534E) return 1;
  memory.copy(L.buildIdPtr(), head + 0x40, 0x20);
  return 0;
}
// The whole module file: header, segments unpacked into the arena, hashes checked. 0, or the loader's refusal
// reason after its red line (a damaged or cut module is found here, before anything runs)
export function nsoCheck(file: usize, len: u32): i32 {
  const r = nsoParse(file, len);
  if (r) return r;
  if (openReady && file == openFile && len == openLen) return 0;
  const image = alloc(L.imageSize);
  if (!image) { red(); puts("no memory for a module image of "); putx(L.imageSize); puts(" bytes"); emit(); return 1; }
  const s = loadSegments(L, image);
  return s ? refused(s) : 0;
}
// A module opened in steps: nsoOpenBegin, then nsoOpenStep until it does not return NSO_OPEN_MORE. Unpacking a main
// module of 100 MB (LZ4, or ZBIC from system 22.0.0 on) and hashing it takes long enough that the page must draw
// and take a Cancel in between. The file and its verified image then stay in the arena: nsoCheck, matchRun and
// cutApply on the same file use that image instead of unpacking again, until the arena is reset (nsoOpenClear) or a
// cut has changed the image. One module at a time; nothing else of this file may be called between the steps.
export const NSO_OPEN_MORE: i32 = -1;
let openFile: usize = 0, openLen: u32 = 0, openImage: usize = 0, openReady: bool = false;
export function nsoOpenClear(): void { openReady = false; openFile = 0; openImage = 0; }
export function nsoOpenBegin(file: usize, len: u32): i32 {
  nsoOpenClear();
  const r = nsoParse(file, len);
  if (r) return r;
  const image = alloc(L.imageSize);
  if (!image) { red(); puts("no memory for a module image of "); putx(L.imageSize); puts(" bytes"); emit(); return 1; }
  loadBegin(L, image);
  openFile = file; openLen = len; openImage = image;
  return 0;
}
// About `budget` more bytes unpacked or hashed: NSO_OPEN_MORE, 0 when the module is whole and verified, or the
// loader's refusal reason after its red line
export function nsoOpenStep(budget: u32): i32 {
  if (!openImage || openReady) return openReady ? 0 : 1;
  const r = loadStep(L, budget);
  if (r == LOAD_MORE) return NSO_OPEN_MORE;
  if (r) { nsoOpenClear(); return refused(<u64>r); }
  openReady = true;
  return 0;
}
export function nsoOpenWorkTotal(): f64 { return <f64>loadWorkTotal(L); }
export function nsoOpenWorkDone(): f64 { return <f64>loadWorkDone(); }
// The unpacked, verified image of the module file (its header is in L afterwards): the opened module's, or unpacked
// now. 0 after a red line (`code` says which error a caller returns for no memory).
let imageNoMem: bool = false;
function imageOf(file: usize, len: u32): usize {
  imageNoMem = false;
  if (nsoParse(file, len)) return 0;
  if (openReady && file == openFile && len == openLen) return openImage;
  const image = alloc(L.imageSize);
  if (!image) { imageNoMem = true; red(); puts("no memory for a module image of "); putx(L.imageSize); puts(" bytes"); emit(); return 0; }
  if (loadSegments(L, image)) { refused(1); return 0; }
  return image;
}
export function nsoBuildIdPtr(): usize { return L.buildIdPtr(); }
export function nsoImageSize(): u32 { return L.imageSize; }
export function nsoTextSize(): u32 { return L.sz0; }
export function nsoBss(): u32 { return L.bss; }
export function nsoFlags(): u32 { return L.flags; }
export function nsoInitEnd(): u32 { return L.initEnd; }

// @ts-ignore: decorator
@inline function nameSize(file: usize, len: u32): u32 {
  const off = load<u32>(file, 0x1C), n = load<u32>(file, 0x2C);
  return <u64>off + <u64>n <= <u64>len && n <= 0x400 ? n : 0;
}

// Apply the cut list to the module file (parsed again here) and write the cut module. The list:
//   u32 count, then per cut: u32 offset, u32 length, <length> original bytes, <length> replacement bytes
// Returns CUT_OK (cutOutPtr / cutOutLen hold the new file, in the arena) or a CUT_* error with a red line;
// cutFailedIndex() is the cut that stopped it. Nothing is written anywhere on an error.
export function cutApply(file: usize, len: u32, list: usize, listLen: u32): i32 {
  failedIndex = -1; applied = 0; outPtr = 0; outLen = 0;
  const image = imageOf(file, len);
  if (!image) return imageNoMem ? CUT_NOMEM : CUT_BAD_MODULE;
  if (listLen < 4) { red(); puts("the cut list is "); putu(listLen); puts(" bytes"); emit(); return CUT_BAD_LIST; }
  const n = load<u32>(list), end: u64 = <u64>list + listLen;
  let p: u64 = <u64>list + 4;
  const limit = L.initEnd;
  for (let i: u32 = 0; i < n; i++) {
    if (p + 8 > end) { red(); puts("the cut list ends inside cut "); putu(i); emit(); failedIndex = i; return CUT_BAD_LIST; }
    const off = load<u32>(<usize>p), cl = load<u32>(<usize>p, 4);
    if (!cl || p + 8 + 2 * <u64>cl > end) { red(); puts("cut "); putu(i); puts(" at "); putx(off); puts(" has "); putu(cl); puts(" bytes, more than the list holds"); emit(); failedIndex = i; return CUT_BAD_LIST; }
    const ob = <usize>p + 8, nb = ob + cl;
    if (<u64>off + <u64>cl > <u64>limit) {
      red(); puts("cut "); putu(i); puts(" at "); putx(off); puts(".."); putx(<u64>off + cl); puts(" lies outside the module's "); putx(limit); puts(" bytes"); emit();
      failedIndex = i; return CUT_RANGE;
    }
    if (memory.compare(image + off, ob, cl) != 0) {
      // nxnative: assert ..., f'cut original bytes mismatch {off:#x}: {bytes(IMG[off:off + len(ob)]).hex()}'
      red(); puts("cut original bytes mismatch "); putx(off); puts(": the module has "); puthex(image + off, cl); puts(", the cut expects "); puthex(ob, cl);
      puts(" (cut "); putu(i); puts("): this is not the build the cut was made for; nothing was changed"); emit();
      failedIndex = i; return CUT_MISMATCH;
    }
    if (image == openImage) openReady = false;     // the opened module's image is no longer the file's
    memory.copy(image + off, nb, cl);
    applied++;
    p += 8 + 2 * <u64>cl;
  }
  // the module again, as a stored NSO
  const ns = nameSize(file, len);
  const total: u64 = 0x100 + <u64>ns + <u64>L.sz0 + <u64>L.sz1 + <u64>L.sz2;
  if (total > 0xFFF00000) { red(); puts("the cut module would be "); putx(total); puts(" bytes"); emit(); return CUT_NOMEM; }
  const out = alloc(<usize>total);
  if (!out) { red(); puts("no memory for a cut module of "); putx(total); puts(" bytes"); emit(); return CUT_NOMEM; }
  memory.copy(out, file, 0x100);
  store<u32>(out, (L.flags & ~<u32>0xBF) | 0x38, 0x0C);       // nothing compressed (so not ZBIC either), every segment's hash checked
  store<u32>(out, 0x100, 0x1C); store<u32>(out, ns, 0x2C);
  if (ns) memory.copy(out + 0x100, file + load<u32>(file, 0x1C), ns);
  let fo: u32 = 0x100 + ns;
  for (let i: u32 = 0; i < 3; i++) {
    const sz = L.size(i), mo = L.memOff(i);
    store<u32>(out + 0x10 + (<usize>i << 4), fo);
    store<u32>(out + 0x60 + (<usize>i << 2), sz);
    memory.copy(out + fo, image + mo, sz);
    sha256(image + mo, sz, out + 0xA0 + (<usize>i << 5));
    fo += sz;
  }
  outPtr = out; outLen = <u32>total;
  info(); puts("module "); puthex(L.buildIdPtr(), 16); puts(": "); putu(applied); puts(" cuts applied"); emit();
  return CUT_OK;
}
export function cutOutPtr(): usize { return outPtr; }
export function cutOutLen(): u32 { return outLen; }
export function cutFailedIndex(): i32 { return failedIndex; }
export function cutApplied(): u32 { return applied; }

// Function-matched cuts (match.ts) for a module file: the module is unpacked as for cutApply, its functions are read
// from the unwind table, and the rule list is resolved against them. MATCH_OK (the results are behind the match_*
// exports: the cuts found are a list cutApply takes) or CUT_BAD_MODULE / a MATCH_* error. Nothing is changed here.
export function matchRun(file: usize, len: u32, list: usize, listLen: u32): i32 {
  const image = imageOf(file, len);
  if (!image) return imageNoMem ? CUT_NOMEM : CUT_BAD_MODULE;
  imageInit(image, L.initEnd, L.mo0 + L.sz0);
  return matchResolve(list, listLen);
}
