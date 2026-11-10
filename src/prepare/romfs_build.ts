// The tables of a standard RomFS image for a directory tree that stays where it is.
//
// src/fs mounts RomFS images through a block device. A folder of extracted game files is not an image, and copying
// a multi-GB tree into one (as nxnative's romfs_image.py does) is what the prepare step avoids: this file builds
// only the image's header and four tables (directory hash table, directory metadata, file hash table, file
// metadata) from a list of paths and sizes, and gives every file a place in a data section that is never written.
// The device (host/romdev.ts) answers reads of the tables from these bytes and reads of the data section from the
// files themselves, by the offsets handed back here.
//
// Layout of the virtual image: header (0x50) | directory hash | directory metadata | file hash | file metadata |
// data section (16-byte aligned; each file 16-byte aligned, in list order). Tables come first so that they sit
// below 2 GB whatever the data's size (src/fs checks that). Format details: tools/mkromfs.py.
//
// The list:  u32 count, then per entry  u64 size, u32 kind (0 file, 1 directory), u32 path length, path bytes
// (UTF-8, components separated by '/', no leading slash). Parent directories are implied; a directory entry only
// matters for an empty directory. Sibling order is list order.
import { red, puts, putu, putx, putn, emit, alloc } from "./base";

const EMPTY: u32 = 0xFFFFFFFF;
const NAME_MAX: u32 = 0x300;

export const ROM_OK: i32 = 0;
export const ROM_BAD_LIST: i32 = -1;
export const ROM_BAD_PATH: i32 = -2;      // an empty component, "." or "..", a NUL, a name over 0x300 bytes
export const ROM_DUPLICATE: i32 = -3;     // a path twice, or a file where a directory is
export const ROM_NOMEM: i32 = -4;
export const ROM_TOO_BIG: i32 = -5;       // a table over 2 GB

// directory record (40 bytes) and file record (40 bytes), working storage in the arena
const D_PARENT: usize = 0, D_NAME: usize = 4, D_NLEN: usize = 8, D_SIB: usize = 12, D_FDIR: usize = 16, D_LDIR: usize = 20, D_FFILE: usize = 24, D_LFILE: usize = 28, D_OFF: usize = 32, D_SIZE: usize = 40;
const F_PARENT: usize = 0, F_NAME: usize = 4, F_NLEN: usize = 8, F_SIB: usize = 12, F_OFF: usize = 16, F_SIZE: usize = 24, F_DATA: usize = 32, F_REC: usize = 40;

let dirs: usize = 0, ndirs: u32 = 0, files: usize = 0, nfiles: u32 = 0;
let table: usize = 0, tableMask: u32 = 0;    // (parent, name) -> index + 1; bit 31 set for a file
let tablesPtr: usize = 0, tablesLen: u32 = 0, offsetsPtr: usize = 0;
let dataOffset: u64 = 0, dataSize: u64 = 0;

// @ts-ignore: decorator
@inline function D(i: u32): usize { return dirs + <usize>i * D_SIZE; }
// @ts-ignore: decorator
@inline function F(i: u32): usize { return files + <usize>i * F_REC; }

function romHash(parent: u32, name: usize, len: u32): u32 {
  let h: u32 = parent ^ 123456789;
  for (let i: u32 = 0; i < len; i++) { h = (h >> 5) | (h << 27); h ^= <u32>load<u8>(name + i); }
  return h;
}
function buckets(n: u32): u32 {
  if (n < 3) return 3;
  if (n < 19) return n | 1;
  while (n % 2 == 0 || n % 3 == 0 || n % 5 == 0 || n % 7 == 0 || n % 11 == 0 || n % 13 == 0 || n % 17 == 0) n++;
  return n;
}
// @ts-ignore: decorator
@inline function slotHash(parent: u32, name: usize, len: u32): u32 {
  let h: u32 = 0x811C9DC5 ^ (parent * 0x9E3779B1);
  for (let i: u32 = 0; i < len; i++) { h ^= <u32>load<u8>(name + i); h *= 0x01000193; }
  return h;
}
// The slot of (parent, name): the entry there, or 0 with `slotAt` the free slot
let slotAt: usize = 0;
function find(parent: u32, name: usize, len: u32): u32 {
  let s = slotHash(parent, name, len) & tableMask;
  for (;;) {
    const p = table + (<usize>s << 2), v = load<u32>(p);
    if (!v) { slotAt = p; return 0; }
    const isFile = (v & 0x80000000) != 0, idx = (v & 0x7FFFFFFF) - 1;
    const rec = isFile ? F(idx) : D(idx);
    // D_PARENT/D_NAME/D_NLEN and F_PARENT/F_NAME/F_NLEN are at the same offsets
    if (load<u32>(rec, D_PARENT) == parent && load<u32>(rec, D_NLEN) == len && memory.compare(<usize>load<u32>(rec, D_NAME), name, len) == 0) return v;
    s = (s + 1) & tableMask;
  }
  return 0;
}
function badName(path: usize, plen: u32, why: string): i32 {
  red(); puts("RomFS path '"); putn(path, plen); puts("': "); puts(why); emit();
  return ROM_BAD_PATH;
}
function checkName(path: usize, plen: u32, name: usize, len: u32): i32 {
  if (!len) return badName(path, plen, "an empty path component");
  if (len > NAME_MAX) return badName(path, plen, "a name longer than 0x300 bytes");
  if (len == 1 && load<u8>(name) == 46) return badName(path, plen, "a component '.'");
  if (len == 2 && load<u8>(name) == 46 && load<u8>(name, 1) == 46) return badName(path, plen, "a component '..'");
  for (let i: u32 = 0; i < len; i++) if (!load<u8>(name + i)) return badName(path, plen, "a NUL byte in a name");
  return 0;
}
// The directory (parent, name), made when it is not there. -1: a file is in the way
function dirOf(parent: u32, name: usize, len: u32): i32 {
  const v = find(parent, name, len);
  if (v) return (v & 0x80000000) ? -1 : <i32>(v - 1);
  const i = ndirs++, r = D(i);
  store<u32>(r, parent, D_PARENT); store<u32>(r, <u32>name, D_NAME); store<u32>(r, len, D_NLEN);
  store<u32>(r, EMPTY, D_SIB); store<u32>(r, EMPTY, D_FDIR); store<u32>(r, EMPTY, D_LDIR); store<u32>(r, EMPTY, D_FFILE); store<u32>(r, EMPTY, D_LFILE);
  store<u32>(slotAt, i + 1);
  const pr = D(parent), last = load<u32>(pr, D_LDIR);
  if (last == EMPTY) store<u32>(pr, i, D_FDIR); else store<u32>(D(last), i, D_SIB);
  store<u32>(pr, i, D_LDIR);
  return <i32>i;
}

export function romBuild(list: usize, listLen: u32): i32 {
  tablesPtr = 0; tablesLen = 0; offsetsPtr = 0; ndirs = 0; nfiles = 0; dataOffset = 0; dataSize = 0;
  if (listLen < 4) { red(); puts("the RomFS list is "); putu(listLen); puts(" bytes"); emit(); return ROM_BAD_LIST; }
  const count = load<u32>(list), end: u64 = <u64>list + listLen;
  // pass 0: bounds, and the most directories and files there can be
  let p: u64 = <u64>list + 4, maxDirs: u64 = 1, maxFiles: u64 = 0;
  for (let i: u32 = 0; i < count; i++) {
    if (p + 16 > end) { red(); puts("the RomFS list ends inside entry "); putu(i); emit(); return ROM_BAD_LIST; }
    const kind = load<u32>(<usize>p, 8), plen = load<u32>(<usize>p, 12);
    if (kind > 1 || p + 16 + <u64>plen > end) { red(); puts("RomFS list entry "); putu(i); puts(" is malformed"); emit(); return ROM_BAD_LIST; }
    const path = <usize>p + 16;
    let slashes: u64 = 0;
    for (let k: u32 = 0; k < plen; k++) if (load<u8>(path + k) == 47) slashes++;
    maxDirs += slashes + (kind ? 1 : 0);
    if (!kind) maxFiles++;
    p += 16 + <u64>plen;
  }
  if (maxDirs > 0x7FFFFFF || maxFiles > 0x7FFFFFF) { red(); puts("too many RomFS entries"); emit(); return ROM_TOO_BIG; }
  let cap: u32 = 16;
  while (<u64>cap < 2 * (maxDirs + maxFiles)) cap <<= 1;
  dirs = alloc(<usize>maxDirs * D_SIZE); files = alloc(<usize>(maxFiles ? maxFiles : 1) * F_REC); table = alloc(<usize>cap << 2);
  if (!dirs || !files || !table) { red(); puts("no memory for the RomFS index of "); putu(maxFiles); puts(" files"); emit(); return ROM_NOMEM; }
  tableMask = cap - 1;
  // the root: its own parent, no name
  ndirs = 1;
  store<u32>(dirs, 0, D_PARENT); store<u32>(dirs, 0, D_NAME); store<u32>(dirs, 0, D_NLEN);
  store<u32>(dirs, EMPTY, D_SIB); store<u32>(dirs, EMPTY, D_FDIR); store<u32>(dirs, EMPTY, D_LDIR); store<u32>(dirs, EMPTY, D_FFILE); store<u32>(dirs, EMPTY, D_LFILE);
  // pass 1: the tree
  p = <u64>list + 4;
  for (let i: u32 = 0; i < count; i++) {
    const size = load<u64>(<usize>p), kind = load<u32>(<usize>p, 8), plen = load<u32>(<usize>p, 12), path = <usize>p + 16;
    p += 16 + <u64>plen;
    let parent: u32 = 0, at: u32 = 0;
    for (;;) {
      let e = at;
      while (e < plen && load<u8>(path + e) != 47) e++;
      const name = path + at, len = e - at;
      const bad = checkName(path, plen, name, len);
      if (bad) return bad;
      if (e < plen || kind == 1) {
        const d = dirOf(parent, name, len);
        if (d < 0) { red(); puts("RomFS path '"); putn(path, plen); puts("': a file is where a directory is needed"); emit(); return ROM_DUPLICATE; }
        parent = <u32>d;
        if (e >= plen) break;
        at = e + 1;
        continue;
      }
      if (find(parent, name, len)) { red(); puts("RomFS path '"); putn(path, plen); puts("' is listed twice"); emit(); return ROM_DUPLICATE; }
      const fi = nfiles++, r = F(fi);
      store<u32>(r, parent, F_PARENT); store<u32>(r, <u32>name, F_NAME); store<u32>(r, len, F_NLEN); store<u32>(r, EMPTY, F_SIB); store<u64>(r, size, F_SIZE);
      store<u32>(slotAt, (fi + 1) | 0x80000000);
      const pr = D(parent), last = load<u32>(pr, D_LFILE);
      if (last == EMPTY) store<u32>(pr, fi, D_FFILE); else store<u32>(F(last), fi, F_SIB);
      store<u32>(pr, fi, D_LFILE);
      break;
    }
  }
  // pass 2: offsets in the metadata tables and in the data section
  let dm: u64 = 0, fm: u64 = 0, pos: u64 = 0;
  for (let i: u32 = 0; i < ndirs; i++) { store<u32>(D(i), <u32>dm, D_OFF); dm += 0x18 + ((<u64>load<u32>(D(i), D_NLEN) + 3) & ~<u64>3); }
  offsetsPtr = alloc(<usize>(nfiles ? nfiles : <u32>1) << 3);
  if (!offsetsPtr) { red(); puts("no memory for the RomFS offsets"); emit(); return ROM_NOMEM; }
  for (let i: u32 = 0; i < nfiles; i++) {
    const r = F(i);
    store<u32>(r, <u32>fm, F_OFF); fm += 0x20 + ((<u64>load<u32>(r, F_NLEN) + 3) & ~<u64>3);
    pos = (pos + 15) & ~<u64>15;
    store<u64>(r, pos, F_DATA); store<u64>(offsetsPtr + (<usize>i << 3), pos);
    pos += load<u64>(r, F_SIZE);
  }
  dataSize = pos;
  const nd = buckets(ndirs), nf = buckets(nfiles);
  const o1: u64 = 0x50, o2 = o1 + (<u64>nd << 2), o3 = o2 + dm, o4 = o3 + (<u64>nf << 2), total = o4 + fm;
  if (total >= 0x7FFFFFF0) { red(); puts("the RomFS tables would be "); putx(total); puts(" bytes, over 2 GB"); emit(); return ROM_TOO_BIG; }
  const out = alloc(<usize>total);
  if (!out) { red(); puts("no memory for RomFS tables of "); putx(total); puts(" bytes"); emit(); return ROM_NOMEM; }
  dataOffset = (total + 15) & ~<u64>15;
  store<u64>(out, 0x50, 0x00);
  store<u64>(out, o1, 0x08); store<u64>(out, <u64>nd << 2, 0x10);
  store<u64>(out, o2, 0x18); store<u64>(out, dm, 0x20);
  store<u64>(out, o3, 0x28); store<u64>(out, <u64>nf << 2, 0x30);
  store<u64>(out, o4, 0x38); store<u64>(out, fm, 0x40);
  store<u64>(out, dataOffset, 0x48);
  const dh = out + <usize>o1, dmp = out + <usize>o2, fh = out + <usize>o3, fmp = out + <usize>o4;
  memory.fill(dh, 0xFF, <usize>nd << 2); memory.fill(fh, 0xFF, <usize>nf << 2);
  for (let i: u32 = 0; i < ndirs; i++) {
    const r = D(i), off = load<u32>(r, D_OFF), e = dmp + off, len = load<u32>(r, D_NLEN), name = <usize>load<u32>(r, D_NAME);
    const poff = load<u32>(D(load<u32>(r, D_PARENT)), D_OFF);
    const sib = load<u32>(r, D_SIB), fd = load<u32>(r, D_FDIR), ff = load<u32>(r, D_FFILE);
    const b = dh + (<usize>(romHash(poff, name, len) % nd) << 2);
    store<u32>(e, poff, 0);
    store<u32>(e, sib == EMPTY ? EMPTY : load<u32>(D(sib), D_OFF), 4);
    store<u32>(e, fd == EMPTY ? EMPTY : load<u32>(D(fd), D_OFF), 8);
    store<u32>(e, ff == EMPTY ? EMPTY : load<u32>(F(ff), F_OFF), 12);
    store<u32>(e, load<u32>(b), 16);
    store<u32>(e, len, 20);
    memory.copy(e + 0x18, name, len);
    store<u32>(b, off);
  }
  for (let i: u32 = 0; i < nfiles; i++) {
    const r = F(i), off = load<u32>(r, F_OFF), e = fmp + off, len = load<u32>(r, F_NLEN), name = <usize>load<u32>(r, F_NAME);
    const poff = load<u32>(D(load<u32>(r, F_PARENT)), D_OFF), sib = load<u32>(r, F_SIB);
    const b = fh + (<usize>(romHash(poff, name, len) % nf) << 2);
    store<u32>(e, poff, 0);
    store<u32>(e, sib == EMPTY ? EMPTY : load<u32>(F(sib), F_OFF), 4);
    store<u64>(e, load<u64>(r, F_DATA), 8);
    store<u64>(e, load<u64>(r, F_SIZE), 16);
    store<u32>(e, load<u32>(b), 24);
    store<u32>(e, len, 28);
    memory.copy(e + 0x20, name, len);
    store<u32>(b, off);
  }
  tablesPtr = out; tablesLen = <u32>total;
  return ROM_OK;
}
export function romTablesPtr(): usize { return tablesPtr; }
export function romTablesLen(): u32 { return tablesLen; }
export function romOffsetsPtr(): usize { return offsetsPtr; }   // u64 per file, in list order: its offset in the data section
export function romDirs(): u32 { return ndirs; }
export function romFiles(): u32 { return nfiles; }
export function romDataOffset(): u64 { return dataOffset; }
export function romDataSize(): u64 { return dataSize; }
