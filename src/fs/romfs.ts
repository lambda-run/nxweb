// RomFS images: the standard format (a 0x50-byte header, directory and file hash tables, directory and file
// metadata tables, the data section). The four tables are read into the arena and checked completely when the
// image is loaded: after that every offset a lookup or a listing follows is known to be an entry of its table,
// every chain is known to end, and every file's bytes are known to lie inside the device. File data is never
// copied here: a read goes from the device straight into the guest's buffer.
import { Inst } from "../kit/machine";
import { FS_IMAGE, FsImageS, FsImageE } from "../kit/gen/tables";
import { alloc, allocZ, free, lb, ls, lu, lx, le } from "./base";

export const EMPTY: u32 = 0xFFFFFFFF;
export const MAX_IMG: u32 = 600;
const HDR_SIZE: u32 = 0x50;

// @ts-ignore: decorator
@unmanaged export class Img {
  m0: u64; m1: u64;                 // kit instance (fs_image)
  kind: i32; dev: i32;
  index: i64;
  devSize: u64; dataOff: u64;
  dh: usize; dhN: u32;              // directory hash table, bucket count
  dm: usize; dmSize: u32;           // directory metadata
  fh: usize; fhN: u32;              // file hash table
  fm: usize; fmSize: u32;           // file metadata
  ndir: u32; nfile: u32;
  hdr: usize; used: u32;
  tabOff0: u64; tabOff1: u64; tabOff2: u64; tabOff3: u64;
  // @ts-ignore: decorator
  @inline get inst(): Inst { return Inst.at(changetype<usize>(this)); }
  get state(): u8 { return this.inst.state; }
}
const IMG_REC: usize = offsetof<Img>();
const IMGS: usize = memory.data(76800);   // MAX_IMG * 128
let nImg: u32 = 0;

// @ts-ignore: decorator
@inline export function img(i: u32): Img { return changetype<Img>(IMGS + <usize>i * 128); }
export function imgCount(): u32 { return nImg; }
// The image of (kind, index): the existing record, or a new one in state Absent; -1 when the table is full
export function imgOf(kind: i32, index: i64): i32 {
  for (let i: u32 = 0; i < nImg; i++) { const m = img(i); if (m.kind == kind && m.index == index) return <i32>i; }
  if (nImg >= MAX_IMG || IMG_REC > 128) return -1;
  const m = img(nImg);
  memory.fill(changetype<usize>(m), 0, 128);
  m.inst.init(FS_IMAGE, nImg); m.kind = kind; m.index = index; m.dev = -1; m.used = 1;
  return <i32>nImg++;
}

// ---- table access (offsets are checked at load) ----
// directory entry: +0 parent, +4 sibling, +8 first child directory, +12 first file, +16 next in hash bucket, +20 name length, +24 name
// file entry:      +0 parent, +4 sibling, +8 u64 data offset, +16 u64 size, +24 next in hash bucket, +28 name length, +32 name
// @ts-ignore: decorator
@inline export function dParent(m: Img, d: u32): u32 { return load<u32>(m.dm + d); }
// @ts-ignore: decorator
@inline export function dSibling(m: Img, d: u32): u32 { return load<u32>(m.dm + d, 4); }
// @ts-ignore: decorator
@inline export function dChildDir(m: Img, d: u32): u32 { return load<u32>(m.dm + d, 8); }
// @ts-ignore: decorator
@inline export function dChildFile(m: Img, d: u32): u32 { return load<u32>(m.dm + d, 12); }
// @ts-ignore: decorator
@inline function dHashNext(m: Img, d: u32): u32 { return load<u32>(m.dm + d, 16); }
// @ts-ignore: decorator
@inline export function dNameLen(m: Img, d: u32): u32 { return load<u32>(m.dm + d, 20); }
// @ts-ignore: decorator
@inline export function dName(m: Img, d: u32): usize { return m.dm + d + 24; }
// @ts-ignore: decorator
@inline function fParent(m: Img, f: u32): u32 { return load<u32>(m.fm + f); }
// @ts-ignore: decorator
@inline export function fSibling(m: Img, f: u32): u32 { return load<u32>(m.fm + f, 4); }
// @ts-ignore: decorator
@inline export function fDataOff(m: Img, f: u32): u64 { return load<u64>(m.fm + f, 8); }
// @ts-ignore: decorator
@inline export function fSize(m: Img, f: u32): u64 { return load<u64>(m.fm + f, 16); }
// @ts-ignore: decorator
@inline function fHashNext(m: Img, f: u32): u32 { return load<u32>(m.fm + f, 24); }
// @ts-ignore: decorator
@inline export function fNameLen(m: Img, f: u32): u32 { return load<u32>(m.fm + f, 28); }
// @ts-ignore: decorator
@inline export function fName(m: Img, f: u32): usize { return m.fm + f + 32; }

function romHash(parent: u32, name: usize, len: u32): u32 {
  let h: u32 = parent ^ 123456789;
  for (let i: u32 = 0; i < len; i++) { h = (h >>> 5) | (h << 27); h ^= <u32>load<u8>(name + i); }
  return h;
}
// The child directory / file of directory `parent` with this name, or EMPTY
export function imgFindDir(m: Img, parent: u32, name: usize, len: u32): u32 {
  let e = load<u32>(m.dh + <usize>(romHash(parent, name, len) % m.dhN) * 4);
  while (e != EMPTY) {
    if (dParent(m, e) == parent && dNameLen(m, e) == len && e != 0 && memory.compare(dName(m, e), name, len) == 0) return e;
    e = dHashNext(m, e);
  }
  return EMPTY;
}
export function imgFindFile(m: Img, parent: u32, name: usize, len: u32): u32 {
  if (!m.fhN) return EMPTY;
  let e = load<u32>(m.fh + <usize>(romHash(parent, name, len) % m.fhN) * 4);
  while (e != EMPTY) {
    if (fParent(m, e) == parent && fNameLen(m, e) == len && memory.compare(fName(m, e), name, len) == 0) return e;
    e = fHashNext(m, e);
  }
  return EMPTY;
}

// The hash table size of the RomFS builder (nxnative romfs_buckets)
function buckets(n: u64): u64 {
  if (n < 3) return 3;
  if (n < 19) return n | 1;
  while (!(n % 2 && n % 3 && n % 5 && n % 7 && n % 11 && n % 13 && n % 17)) n++;
  return n;
}
// What RomFsFileSystem::GetRequiredWorkingMemorySize would ask for (nxnative romfs_work_size)
export function imgWorkSize(m: Img): u64 {
  return 4 * buckets(m.ndir) + <u64>m.dmSize + 4 * buckets(m.nfile) + <u64>m.fmSize;
}

// ---- loading ----
function bad(m: Img, why: string, v: u64 = 0): bool {
  lb("[RED] fs RomFS image (kind "); lu(m.kind); ls(", index "); lu(m.index); ls(") refused: "); ls(why);
  if (v) { ls(" ("); lx(v); ls(")"); }
  le();
  return false;
}
export function imgHdrBuf(m: Img): usize { if (!m.hdr) m.hdr = alloc(HDR_SIZE); return m.hdr; }
export function imgHdrSize(): u32 { return HDR_SIZE; }

// The header was read into imgHdrBuf: check it and allocate the tables. False: refused.
export function imgHeader(m: Img): bool {
  const h = m.hdr, size = m.devSize;
  if (load<u64>(h) != HDR_SIZE) return bad(m, "the header size is not 0x50", load<u64>(h));
  for (let i = 0; i < 4; i++) {
    const off = load<u64>(h, 8 + 16 * i), len = load<u64>(h, 16 + 16 * i);
    if (off < HDR_SIZE || off > size || len > size - off) return bad(m, "a table lies outside the image", off);
    if (len > 0x7FFFFFF0 || (off & 3) || (len & 3)) return bad(m, "a table's size or alignment is impossible", len);
  }
  const dataOff = load<u64>(h, 72);
  if (dataOff < HDR_SIZE || dataOff > size) return bad(m, "the data section starts outside the image", dataOff);
  m.dataOff = dataOff;
  m.tabOff0 = load<u64>(h, 8); m.tabOff1 = load<u64>(h, 24); m.tabOff2 = load<u64>(h, 40); m.tabOff3 = load<u64>(h, 56);
  const dhS = <u32>load<u64>(h, 16), dmS = <u32>load<u64>(h, 32), fhS = <u32>load<u64>(h, 48), fmS = <u32>load<u64>(h, 64);
  if (dhS < 4) return bad(m, "the directory hash table is empty");
  if (dmS < 0x18) return bad(m, "there is no root directory");
  if (fmS && fhS < 4) return bad(m, "files without a file hash table");
  m.dhN = dhS / 4; m.dmSize = dmS; m.fhN = fhS / 4; m.fmSize = fmS;
  m.dh = alloc(dhS); m.dm = alloc(dmS); m.fh = alloc(fhS ? fhS : 4); m.fm = alloc(fmS ? fmS : 4);
  if (!m.dh || !m.dm || !m.fh || !m.fm) { imgDrop(m); return bad(m, "the arena has no room for its tables", <u64>dhS + dmS + fhS + fmS); }
  return true;
}
export function imgTabOff(m: Img, i: u32): u64 { return i == 0 ? m.tabOff0 : i == 1 ? m.tabOff1 : i == 2 ? m.tabOff2 : m.tabOff3; }
export function imgTabPtr(m: Img, i: u32): usize { return i == 0 ? m.dh : i == 1 ? m.dm : i == 2 ? m.fh : m.fm; }
export function imgTabLen(m: Img, i: u32): u32 { return i == 0 ? m.dhN * 4 : i == 1 ? m.dmSize : i == 2 ? m.fhN * 4 : m.fmSize; }
export function imgDrop(m: Img): void {
  free(m.dh); free(m.dm); free(m.fh); free(m.fm); free(m.hdr);
  m.dh = 0; m.dm = 0; m.fh = 0; m.fm = 0; m.hdr = 0;
}

// @ts-ignore: decorator
@inline function bit(map: usize, off: u32): bool { return (load<u8>(map + (off >> 5)) & (1 << ((off >> 2) & 7))) != 0; }
// @ts-ignore: decorator
@inline function setBit(map: usize, off: u32): void { const p = map + (off >> 5); store<u8>(p, load<u8>(p) | (1 << ((off >> 2) & 7))); }
function nameOk(p: usize, n: u32): bool {
  if (n == 0 || n > 0x300) return false;
  if (n == 1 && load<u8>(p) == 46) return false;
  if (n == 2 && load<u16>(p) == 0x2E2E) return false;
  for (let i: u32 = 0; i < n; i++) { const c = load<u8>(p + i); if (c == 0 || c == 47) return false; }
  return true;
}
// Mark the entry starts of a metadata table; the number of entries, or -1
function scan(tab: usize, size: u32, fixed: u32, map: usize, root: bool): i32 {
  let p: u32 = 0, n: i32 = 0;
  while (p < size) {
    if (size - p < fixed) return -1;
    const len = load<u32>(tab + p, fixed - 4);
    if (len > 0x300) return -1;
    const step = fixed + ((len + 3) & ~3);
    if (step > size - p) return -1;
    if (root && p == 0) { if (len != 0) return -1; }
    else if (!nameOk(tab + p + fixed, len)) return -1;
    setBit(map, p);
    p += step; n++;
  }
  return n;
}
// @ts-ignore: decorator
@inline function ref(map: usize, size: u32, off: u32): bool { return off == EMPTY || (off < size && (off & 3) == 0 && bit(map, off)); }

// The four tables were read: check every reference. False: refused (tables dropped).
export function imgValidate(m: Img): bool {
  const dm = m.dm, fm = m.fm, dS = m.dmSize, fS = m.fmSize;
  const mapLen: usize = <usize>(dS >> 5) + <usize>(fS >> 5) + 2;
  const maps = allocZ(mapLen * 2);
  if (!maps) { imgDrop(m); return bad(m, "the arena has no room to check it"); }
  const dStart = maps, fStart = maps + (dS >> 5) + 1, dSeen = maps + mapLen, fSeen = dSeen + (dS >> 5) + 1;
  let ok = imgCheck(m, dStart, fStart, dSeen, fSeen);
  free(maps);
  if (!ok) imgDrop(m);
  else { free(m.hdr); m.hdr = 0; }
  return ok;
}
function imgCheck(m: Img, dStart: usize, fStart: usize, dSeen: usize, fSeen: usize): bool {
  const dm = m.dm, fm = m.fm, dS = m.dmSize, fS = m.fmSize;
  const nd = scan(dm, dS, 0x18, dStart, true), nf = scan(fm, fS, 0x20, fStart, false);
  if (nd < 1) return bad(m, "the directory table is damaged");
  if (nf < 0) return bad(m, "the file table is damaged");
  m.ndir = <u32>nd; m.nfile = <u32>nf;
  // every reference names an entry
  for (let p: u32 = 0; p < dS; p += 0x18 + ((load<u32>(dm + p, 20) + 3) & ~3)) {
    if (!ref(dStart, dS, load<u32>(dm + p)) || load<u32>(dm + p) == EMPTY) return bad(m, "a directory's parent is no directory", p);
    if (!ref(dStart, dS, load<u32>(dm + p, 4)) || !ref(dStart, dS, load<u32>(dm + p, 8)) || !ref(fStart, fS, load<u32>(dm + p, 12))
      || !ref(dStart, dS, load<u32>(dm + p, 16))) return bad(m, "a directory entry points outside the tables", p);
  }
  const room = m.devSize - m.dataOff;
  for (let p: u32 = 0; p < fS; p += 0x20 + ((load<u32>(fm + p, 28) + 3) & ~3)) {
    if (!ref(dStart, dS, load<u32>(fm + p)) || load<u32>(fm + p) == EMPTY) return bad(m, "a file's parent is no directory", p);
    if (!ref(fStart, fS, load<u32>(fm + p, 4)) || !ref(fStart, fS, load<u32>(fm + p, 24))) return bad(m, "a file entry points outside the tables", p);
    const off = load<u64>(fm + p, 8), size = load<u64>(fm + p, 16);
    if (off > room || size > room - off) return bad(m, "a file's data lies outside the image", p);
  }
  // the tree: from the root every entry is reached exactly once, through a parent that names it
  if (dParent(m, 0) != 0 || dSibling(m, 0) != EMPTY) return bad(m, "the root directory has a parent or a sibling");
  let seenD: u32 = 1, seenF: u32 = 0, cur: u32 = 0;
  setBit(dSeen, 0);
  for (;;) {
    for (let f = dChildFile(m, cur); f != EMPTY; f = fSibling(m, f)) {
      if (bit(fSeen, f) || fParent(m, f) != cur) return bad(m, "a file is listed twice or under the wrong directory", f);
      setBit(fSeen, f); seenF++;
    }
    let next = dChildDir(m, cur), parent = cur;
    while (next == EMPTY) {
      if (cur == 0) break;
      next = dSibling(m, cur); parent = dParent(m, cur);
      if (next == EMPTY) cur = parent;
    }
    if (next == EMPTY) break;
    if (bit(dSeen, next) || dParent(m, next) != parent) return bad(m, "a directory is listed twice or under the wrong directory", next);
    setBit(dSeen, next); seenD++;
    cur = next;
  }
  if (seenD != m.ndir || seenF != m.nfile) return bad(m, "entries that no directory lists");
  // the hash chains: every entry is in the bucket of its (parent, name), once
  let steps: u32 = 0;
  for (let b: u32 = 0; b < m.dhN; b++) {
    for (let e = load<u32>(m.dh + <usize>b * 4); e != EMPTY; e = dHashNext(m, e)) {
      if (!ref(dStart, dS, e) || ++steps > m.ndir) return bad(m, "the directory hash table is damaged", b);
      if (romHash(dParent(m, e), dName(m, e), dNameLen(m, e)) % m.dhN != b) return bad(m, "a directory is in the wrong hash bucket", e);
    }
  }
  if (steps != m.ndir) return bad(m, "directories missing from the hash table");
  steps = 0;
  for (let b: u32 = 0; b < m.fhN; b++) {
    for (let e = load<u32>(m.fh + <usize>b * 4); e != EMPTY; e = fHashNext(m, e)) {
      if (!ref(fStart, fS, e) || ++steps > m.nfile) return bad(m, "the file hash table is damaged", b);
      if (romHash(fParent(m, e), fName(m, e), fNameLen(m, e)) % m.fhN != b) return bad(m, "a file is in the wrong hash bucket", e);
    }
  }
  if (steps != m.nfile) return bad(m, "files missing from the hash table");
  return true;
}
