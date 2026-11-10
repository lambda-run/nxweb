// Saves: one container device per save backing, a working tree in the arena, and the commit protocol.
//
// Container layout (little endian):
//   0x0000  superblock slot A (64 bytes)        0x1000  superblock slot B (64 bytes)        0x2000..  extents
//   slot: +0 magic "NXWSAVE1", +8 generation, +16 manifest offset, +24 manifest length, +32 manifest checksum,
//         +40 node count, +48 0, +56 checksum of the first 56 bytes (FNV-1a 64)
//   manifest: +0 "NXMF", +4 version 1, +8 node count n, +12 0, then n entries in pre-order (parents first):
//         +0 u32 parent (0 = the root, else the 1-based position of an earlier entry), +4 u8 type (0 directory,
//         1 file), +5 u8 0, +6 u16 name length, +8 u64 extent offset, +16 u64 extent capacity, +24 u64 size, +32 name
//         padded to 8
// The committed version is the valid slot with the highest generation, the manifest it names and the extents that
// manifest names. None of those bytes is written again while that version is the committed one: a file's first
// write after a commit moves it to a new extent (copy on write), extents the committed version uses are only
// reused after a later commit has been sealed, and a commit writes the slot the committed version does not use.
// README.md has the recovery argument.
import { Inst } from "../kit/machine";
import { FS_SAVE, FsSaveS, FsSaveE } from "../kit/gen/tables";
import { alloc, allocZ, free, fnv64, lb, ls, lu, lx, le, dev_read, dev_write, dev_size, DEV_OK, DEV_PENDING, DEV_IO, devErrno,
  KIND_SAVE, KIND_DEVICE_SAVE, KIND_TEMP } from "./base";

export const MAX_SAVE: u32 = 24;
const SLOT_SIZE: u32 = 64, SLOT_B: u64 = 0x1000, DATA_START: u64 = 0x2000;
const MAGIC_SLOT: u64 = 0x314556415357584E;   // "NXWSAVE1"
const MAGIC_MAN: u32 = 0x464D584E;            // "NXMF"
const MAN_MAX: u64 = 256 << 20;

export const N_DIR: u8 = 0, N_FILE: u8 = 1;
const NF_USED: u8 = 1, NF_COMMITTED: u8 = 2, NF_DEAD: u8 = 4;
const NODE: usize = 64;

// @ts-ignore: decorator
@unmanaged export class Save {
  m0: u64; m1: u64;                 // kit instance (fs_save)
  kind: i32; dev: i32;
  index: i64;
  txn: u8;                          // Commit does something (false: temporary storage)
  strict: u8;                       // a save data backing: a Commit list may name only one of these
  used: u8; p0: u8;
  owner: u32;                       // token of the parked call that holds it in Recovering / Committing / Sealing
  gen: u64; manOff: u64; manLen: u64;
  newOff: u64; newLen: u64; newCap: u64;   // the manifest of the commit in flight
  end: u64;                         // first byte after the last extent in use
  nodes: usize; nodeCap: u32; nodeFree: i32;
  fl: usize; flN: u32; flCap: u32;  // free extents [u64 off, u64 len], sorted by offset
  df: usize; dfN: u32; dfCap: u32;  // extents of the committed version this transaction no longer uses
  serial: u32; epoch: u32;
  commits: u64;
  // @ts-ignore: decorator
  @inline get inst(): Inst { return Inst.at(changetype<usize>(this)); }
  get state(): u8 { return this.inst.state; }
}
const SAVES: usize = memory.data(3840);   // MAX_SAVE * 160
let nSave: u32 = 0;
// @ts-ignore: decorator
@inline export function save(i: u32): Save { return changetype<Save>(SAVES + <usize>i * 160); }
export function saveCount(): u32 { return nSave; }
export function saveOf(kind: i32, index: i64): i32 {
  for (let i: u32 = 0; i < nSave; i++) { const s = save(i); if (s.kind == kind && s.index == index) return <i32>i; }
  if (nSave >= MAX_SAVE || offsetof<Save>() > 160) return -1;
  const s = save(nSave);
  memory.fill(changetype<usize>(s), 0, 160);
  s.inst.init(FS_SAVE, nSave); s.kind = kind; s.index = index; s.dev = -1; s.used = 1;
  s.txn = <u8>(kind != KIND_TEMP); s.strict = <u8>(kind == KIND_SAVE || kind == KIND_DEVICE_SAVE);
  s.nodeFree = -1;
  nSave++;
  return <i32>nSave - 1;
}
export function saveFind(kind: i32, index: i64): i32 {
  for (let i: u32 = 0; i < nSave; i++) { const s = save(i); if (s.kind == kind && s.index == index) return <i32>i; }
  return -1;
}

// ---- nodes ----
// +0 i32 parent, +4 i32 first child, +8 i32 next sibling, +12 i32 previous sibling, +16 u8 type, +17 u8 flags,
// +18 u16 name length, +20 u32 name pointer, +24 u64 extent offset, +32 u64 capacity, +40 u64 size, +48 u32 open
// handles, +52 u32 serial, +56 u32 scratch
// @ts-ignore: decorator
@inline function np(s: Save, n: i32): usize { return s.nodes + <usize>n * NODE; }
// @ts-ignore: decorator
@inline export function nParent(s: Save, n: i32): i32 { return load<i32>(np(s, n)); }
// @ts-ignore: decorator
@inline export function nChild(s: Save, n: i32): i32 { return load<i32>(np(s, n), 4); }
// @ts-ignore: decorator
@inline export function nNext(s: Save, n: i32): i32 { return load<i32>(np(s, n), 8); }
// @ts-ignore: decorator
@inline export function nType(s: Save, n: i32): u8 { return load<u8>(np(s, n), 16); }
// @ts-ignore: decorator
@inline function nFlags(s: Save, n: i32): u8 { return load<u8>(np(s, n), 17); }
// @ts-ignore: decorator
@inline export function nNameLen(s: Save, n: i32): u32 { return load<u16>(np(s, n), 18); }
// @ts-ignore: decorator
@inline export function nName(s: Save, n: i32): usize { return <usize>load<u32>(np(s, n), 20); }
// @ts-ignore: decorator
@inline function nOff(s: Save, n: i32): u64 { return load<u64>(np(s, n), 24); }
// @ts-ignore: decorator
@inline function nCap(s: Save, n: i32): u64 { return load<u64>(np(s, n), 32); }
// @ts-ignore: decorator
@inline export function nSize(s: Save, n: i32): u64 { return load<u64>(np(s, n), 40); }
// @ts-ignore: decorator
@inline function nOpen(s: Save, n: i32): u32 { return load<u32>(np(s, n), 48); }
// @ts-ignore: decorator
@inline export function nSerial(s: Save, n: i32): u32 { return load<u32>(np(s, n), 52); }
// A node a handle may still use: it exists (a deleted file lives on while it is open)
export function nValid(s: Save, n: i32, serial: u32): bool {
  return s.nodes != 0 && n >= 0 && <u32>n < s.nodeCap && (nFlags(s, n) & NF_USED) != 0 && nSerial(s, n) == serial;
}
// The first child of a directory; -1 also for a save without a tree (a container that could not be opened)
export function firstChild(s: Save, dir: i32): i32 { return s.nodes ? nChild(s, dir) : -1; }
export function nLive(s: Save, n: i32, serial: u32): bool {
  return n >= 0 && <u32>n < s.nodeCap && (nFlags(s, n) & (NF_USED | NF_DEAD)) == NF_USED && nSerial(s, n) == serial;
}

function nodesGrow(s: Save, cap: u32): bool {
  const p = alloc(<usize>cap * NODE);
  if (!p) return false;
  memory.fill(p, 0, <usize>cap * NODE);
  if (s.nodes) { memory.copy(p, s.nodes, <usize>s.nodeCap * NODE); free(s.nodes); }
  for (let i = <i32>cap - 1; i >= <i32>s.nodeCap; i--) { store<i32>(p + <usize>i * NODE, s.nodeFree); s.nodeFree = i; }
  s.nodes = p; s.nodeCap = cap;
  return true;
}
// A new node under parent (name copied into the arena); -1 when the arena is full
function nodeNew(s: Save, parent: i32, type: u8, name: usize, len: u32): i32 {
  if (s.nodeFree < 0 && !nodesGrow(s, s.nodeCap ? s.nodeCap * 2 : 64)) return -1;
  const nm = alloc(len ? <usize>len : 1);
  if (!nm) return -1;
  memory.copy(nm, name, len);
  const n = s.nodeFree, p = np(s, n);
  s.nodeFree = load<i32>(p);
  memory.fill(p, 0, NODE);
  store<u8>(p, type, 16); store<u8>(p, NF_USED, 17); store<u16>(p, <u16>len, 18); store<u32>(p, <u32>nm, 20);
  store<u32>(p, ++s.serial, 52);
  store<i32>(p, -1, 4);
  link(s, n, parent);
  return n;
}
function link(s: Save, n: i32, parent: i32): void {
  const p = np(s, n);
  store<i32>(p, parent); store<i32>(p, -1, 12);
  if (parent < 0) { store<i32>(p, -1, 8); return; }
  const head = nChild(s, parent);
  store<i32>(p, head, 8);
  if (head >= 0) store<i32>(np(s, head), n, 12);
  store<i32>(np(s, parent), n, 4);
}
function unlink(s: Save, n: i32): void {
  const p = np(s, n), parent = load<i32>(p), next = load<i32>(p, 8), prev = load<i32>(p, 12);
  if (prev >= 0) store<i32>(np(s, prev), next, 8); else if (parent >= 0) store<i32>(np(s, parent), next, 4);
  if (next >= 0) store<i32>(np(s, next), prev, 12);
  store<i32>(p, -1); store<i32>(p, -1, 8); store<i32>(p, -1, 12);
}
function nodeRelease(s: Save, n: i32): void {
  const p = np(s, n);
  if (nCap(s, n)) extFree(s, nOff(s, n), nCap(s, n), (nFlags(s, n) & NF_COMMITTED) != 0);
  free(nName(s, n));
  memory.fill(p, 0, NODE);
  store<i32>(p, s.nodeFree); s.nodeFree = n;
}
export function nodeChild(s: Save, dir: i32, name: usize, len: u32): i32 {
  for (let c = firstChild(s, dir); c >= 0; c = nNext(s, c))
    if (nNameLen(s, c) == len && memory.compare(nName(s, c), name, len) == 0) return c;
  return -1;
}
export function nodeChildCount(s: Save, dir: i32): u32 { let k: u32 = 0; for (let c = firstChild(s, dir); c >= 0; c = nNext(s, c)) k++; return k; }
// Whether a is b or inside b
export function nodeWithin(s: Save, a: i32, b: i32): bool { for (; a >= 0; a = nParent(s, a)) if (a == b) return true; return false; }

// ---- extents ----
// @ts-ignore: decorator
@inline function capFor(n: u64): u64 { return n > 4096 ? (n + 4095) & ~4095 : (n + 255) & ~255; }
function listPush(s: Save, isDf: bool, at: u32, off: u64, len: u64): bool {
  let p = isDf ? s.df : s.fl, n = isDf ? s.dfN : s.flN, cap = isDf ? s.dfCap : s.flCap;
  if (n == cap) {
    const nc = cap ? cap * 2 : 32, q = alloc(<usize>nc * 16);
    if (!q) return false;
    if (p) { memory.copy(q, p, <usize>n * 16); free(p); }
    p = q; cap = nc;
  }
  memory.copy(p + <usize>(at + 1) * 16, p + <usize>at * 16, <usize>(n - at) * 16);
  store<u64>(p + <usize>at * 16, off); store<u64>(p + <usize>at * 16, len, 8);
  n++;
  if (isDf) { s.df = p; s.dfN = n; s.dfCap = cap; } else { s.fl = p; s.flN = n; s.flCap = cap; }
  return true;
}
// An extent of len bytes (len > 0, a multiple of 256). 0: the arena cannot hold the free list.
function extAlloc(s: Save, len: u64): u64 {
  const p = s.fl;
  for (let i: u32 = 0; i < s.flN; i++) {
    const e = p + <usize>i * 16, off = load<u64>(e), l = load<u64>(e, 8);
    if (l < len) continue;
    if (l == len) { memory.copy(e, e + 16, <usize>(s.flN - i - 1) * 16); s.flN--; }
    else { store<u64>(e, off + len); store<u64>(e, l - len, 8); }
    return off;
  }
  const off = s.end;
  s.end = off + len;
  return off;
}
// Give an extent back. One the committed version uses is kept until the next commit is sealed.
function extFree(s: Save, off: u64, len: u64, committed: bool): void {
  if (!len) return;
  if (false) {
    if (!listPush(s, true, s.dfN, off, len)) { lb("[RED] fs save: the arena cannot record a freed extent; "); lu(len); ls(" bytes of the container stay unused until the next mount"); le(); }
    return;
  }
  const p = s.fl;
  let i: u32 = 0;
  while (i < s.flN && load<u64>(p + <usize>i * 16) < off) i++;
  const mergePrev = i > 0 && load<u64>(p + <usize>(i - 1) * 16) + load<u64>(p + <usize>(i - 1) * 16, 8) == off;
  const mergeNext = i < s.flN && off + len == load<u64>(p + <usize>i * 16);
  if (mergePrev) {
    const e = p + <usize>(i - 1) * 16;
    let l = load<u64>(e, 8) + len;
    if (mergeNext) { l += load<u64>(e, 24); memory.copy(e + 16, e + 32, <usize>(s.flN - i - 1) * 16); s.flN--; }
    store<u64>(e, l, 8);
  } else if (mergeNext) {
    const e = p + <usize>i * 16;
    store<u64>(e, off); store<u64>(e, load<u64>(e, 8) + len, 8);
  } else if (!listPush(s, false, i, off, len)) { lb("[RED] fs save: the arena cannot record a freed extent"); le(); return; }
  // free space at the very end is no extent: the container's used length shrinks
  if (s.flN) {
    const e = s.fl + <usize>(s.flN - 1) * 16;
    if (load<u64>(e) + load<u64>(e, 8) == s.end) { s.end = load<u64>(e); s.flN--; }
  }
}

// ---- device access; a failure poisons the transaction ----
const SCRATCH: usize = memory.data(65536);
const ZEROS: usize = memory.data(65536);
const SLOT: usize = memory.data(64);
const BACKUP: usize = memory.data(160);
const ENOSPC_: i32 = 28;
let lastErr: i32 = 0;
function wr(s: Save, off: u64, p: usize, len: u32): bool {
  const st = dev_write(s.dev, off, p, len);
  if (st == DEV_OK) return true;
  lastErr = devErrno(st);
  return false;
}
function rd(s: Save, off: u64, p: usize, len: u32): bool {
  const st = dev_read(s.dev, off, p, len, 0);
  if (st == DEV_OK) return true;
  if (st == DEV_PENDING) { lb("[RED] fs save: the storage device answered 'pending' to a save read; save devices must read synchronously"); le(); }
  lastErr = devErrno(st);
  return false;
}
function zeroFill(s: Save, off: u64, len: u64): bool {
  while (len) {
    const n = len > 65536 ? 65536 : <u32>len;
    if (!wr(s, off, ZEROS, n)) return false;
    off += n; len -= n;
  }
  return true;
}
function copyRange(s: Save, from: u64, to: u64, len: u64): bool {
  while (len) {
    const n = len > 65536 ? 65536 : <u32>len;
    if (!rd(s, from, SCRATCH, n) || !wr(s, to, SCRATCH, n)) return false;
    from += n; to += n; len -= n;
  }
  return true;
}
// The first mutation of a transaction: Clean -> Dirty (Dirty and Poisoned stay)
function touch(s: Save): void { s.inst.step(FsSaveE.Write); }
export function savePoison(s: Save, err: i32): void {
  lb("[RED] fs save "); lu(s.kind); ls(": a storage write failed (errno "); lu(err); ls("): this transaction's commit will be refused"); le();
  s.inst.step(FsSaveE.WriteFailed, <u64>err);
}
// Give node n an extent of its own (not the committed version's) of at least `need` bytes, keeping its first `keep` bytes
function ensure(s: Save, n: i32, need: u64, keep: u64): bool {
  const p = np(s, n), committed = (nFlags(s, n) & NF_COMMITTED) != 0, cap = nCap(s, n);
  if (!committed && cap >= need) return true;
  let want = capFor(need);
  if (!committed && want < cap * 2) want = cap * 2;
  const off = extAlloc(s, want);
  if (keep && !copyRange(s, nOff(s, n), off, keep)) { extFree(s, off, want, false); return false; }
  extFree(s, nOff(s, n), cap, committed);
  store<u64>(p, off, 24); store<u64>(p, want, 32); store<u8>(p, nFlags(s, n) & ~NF_COMMITTED, 17);
  return true;
}

// ---- operations on the working tree (the caller has checked the state allows writing) ----
export const OP_OK: i32 = 0, OP_NOMEM: i32 = -1, OP_IO: i32 = -2;
function ioFail(s: Save): i32 { savePoison(s, lastErr); return OP_IO; }

export function saveCreate(s: Save, parent: i32, type: u8, name: usize, len: u32, size: u64): i32 {
  touch(s);
  const n = nodeNew(s, parent, type, name, len);
  if (n < 0) return OP_NOMEM;
  if (size) {
    if (!ensure(s, n, size, 0) || !zeroFill(s, nOff(s, n), size)) { unlink(s, n); nodeRelease(s, n); return ioFail(s); }
    store<u64>(np(s, n), size, 40);
  }
  return OP_OK;
}
// Remove node n (a file, or a directory with everything in it). A file that is still open lives on, nameless, until its last close.
export function saveRemove(s: Save, n: i32): void {
  touch(s);
  unlink(s, n);
  let cur = n;
  for (;;) {   // post-order without a stack: go down to a leaf, release it, continue with its parent
    const c = nChild(s, cur);
    if (c >= 0) { cur = c; continue; }
    const up = nParent(s, cur);
    if (cur != n) unlink(s, cur);
    if (nOpen(s, cur)) store<u8>(np(s, cur), nFlags(s, cur) | NF_DEAD, 17);
    else nodeRelease(s, cur);
    if (cur == n) break;
    cur = up;
  }
}
export function saveClean(s: Save, dir: i32): void {
  touch(s);
  for (let c = nChild(s, dir); c >= 0; c = nChild(s, dir)) saveRemove(s, c);
}
export function saveRename(s: Save, n: i32, parent: i32, name: usize, len: u32): i32 {
  const nm = alloc(len ? <usize>len : 1);
  if (!nm) return OP_NOMEM;
  touch(s);
  memory.copy(nm, name, len);
  free(nName(s, n));
  unlink(s, n);
  store<u16>(np(s, n), <u16>len, 18); store<u32>(np(s, n), <u32>nm, 20);
  link(s, n, parent);
  return OP_OK;
}
export function saveOpenRef(s: Save, n: i32): void { store<u32>(np(s, n), nOpen(s, n) + 1, 48); }
export function saveCloseRef(s: Save, n: i32): void {
  const p = np(s, n), k = nOpen(s, n) - 1;
  store<u32>(p, k, 48);
  if (!k && (nFlags(s, n) & NF_DEAD)) nodeRelease(s, n);
}
// Read up to len bytes at off; the count, or -1 on a device error
export function saveRead(s: Save, n: i32, off: u64, buf: usize, len: u64): i64 {
  const size = nSize(s, n);
  if (off >= size) return 0;
  if (len > size - off) len = size - off;
  if (len && !rd(s, nOff(s, n) + off, buf, <u32>len)) return -1;
  return <i64>len;
}
export function saveWrite(s: Save, n: i32, off: u64, buf: usize, len: u64): i32 {
  if (!len) return OP_OK;
  touch(s);
  const size = nSize(s, n), end = off + len;
  const keep: u64 = off == 0 && end >= size ? 0 : size;
  if (!ensure(s, n, end > size ? end : size, keep)) return ioFail(s);
  if (off > size && !zeroFill(s, nOff(s, n) + size, off - size)) return ioFail(s);
  if (!wr(s, nOff(s, n) + off, buf, <u32>len)) return ioFail(s);
  if (end > size) store<u64>(np(s, n), end, 40);
  return OP_OK;
}
export function saveSetSize(s: Save, n: i32, size: u64): i32 {
  const old = nSize(s, n);
  if (size == old) return OP_OK;
  touch(s);
  if (size > old) {
    if (!ensure(s, n, size, old) || !zeroFill(s, nOff(s, n) + old, size - old)) return ioFail(s);
  }
  store<u64>(np(s, n), size, 40);
  return OP_OK;
}

// ---- loading the committed version ----
export const LOAD_OK: i32 = 0, LOAD_FORMAT: i32 = 1, LOAD_BAD: i32 = -1;
function slotOk(p: usize): bool { return load<u64>(p) == MAGIC_SLOT && load<u64>(p, 56) == fnv64(p, 56); }
function corrupt(s: Save, why: string): i32 {
  lb("[RED] fs save "); lu(s.kind); ls(": the container cannot be used: "); ls(why); le();
  return LOAD_BAD;
}
function dropTree(s: Save): void {
  if (s.nodes) {
    for (let i: u32 = 0; i < s.nodeCap; i++) if (load<u8>(s.nodes + <usize>i * NODE, 17) & NF_USED) free(<usize>load<u32>(s.nodes + <usize>i * NODE, 20));
    free(s.nodes);
  }
  free(s.fl); free(s.df);
  s.nodes = 0; s.nodeCap = 0; s.nodeFree = -1; s.fl = 0; s.flN = 0; s.flCap = 0; s.df = 0; s.dfN = 0; s.dfCap = 0;
}
function emptyTree(s: Save): bool {
  if (!nodesGrow(s, 64)) return false;
  const root = s.nodeFree, p = np(s, root);   // slot 0
  s.nodeFree = load<i32>(p);
  memory.fill(p, 0, NODE);
  store<i32>(p, -1); store<i32>(p, -1, 4); store<i32>(p, -1, 8); store<i32>(p, -1, 12);
  store<u8>(p, N_DIR, 16); store<u8>(p, NF_USED, 17); store<u32>(p, ++s.serial, 52);
  s.end = DATA_START;
  return true;
}
function sortPairs(p: usize, n: u32): void {   // by offset; shell sort
  for (let gap = n >> 1; gap > 0; gap >>= 1)
    for (let i = gap; i < n; i++) {
      const o = load<u64>(p + <usize>i * 16), l = load<u64>(p + <usize>i * 16, 8);
      let j = i;
      for (; j >= gap && load<u64>(p + <usize>(j - gap) * 16) > o; j -= gap) memory.copy(p + <usize>j * 16, p + <usize>(j - gap) * 16, 16);
      store<u64>(p + <usize>j * 16, o); store<u64>(p + <usize>j * 16, l, 8);
    }
}
function nameOk(p: usize, n: u32): bool {
  if (n == 0 || n > 0x300) return false;
  if (n == 1 && load<u8>(p) == 46) return false;
  if (n == 2 && load<u16>(p) == 0x2E2E) return false;
  for (let i: u32 = 0; i < n; i++) { const c = load<u8>(p + i); if (c == 0 || c == 47) return false; }
  return true;
}
// Read the superblock slots and the committed manifest and replace the working tree with the committed version.
// LOAD_FORMAT: a new, empty container (the tree is empty; the caller writes slot A). LOAD_BAD: nothing was changed.
export function saveLoad(s: Save): i32 {
  const size = dev_size(s.dev);
  if (size < 0) return corrupt(s, "its size cannot be read");
  let gen: u64 = 0, manOff: u64 = 0, manLen: u64 = 0, manSum: u64 = 0, count: u64 = 0, found = false;
  for (let k: u64 = 0; k < 2; k++) {
    const off = k * SLOT_B;
    if (<u64>size < off + SLOT_SIZE) continue;
    if (!rd(s, off, SLOT, SLOT_SIZE)) return corrupt(s, "a superblock slot cannot be read");
    if (!slotOk(SLOT) || (found && load<u64>(SLOT, 8) <= gen)) continue;
    found = true; gen = load<u64>(SLOT, 8); manOff = load<u64>(SLOT, 16); manLen = load<u64>(SLOT, 24); manSum = load<u64>(SLOT, 32); count = load<u64>(SLOT, 40);
  }
  if (!found) {
    if (<u64>size > SLOT_B) return corrupt(s, "it holds data but no valid superblock");
    dropTree(s);
    if (!emptyTree(s)) return corrupt(s, "the arena is full");
    s.gen = 0; s.manOff = 0; s.manLen = 0; s.epoch++;
    return LOAD_FORMAT;
  }
  let man: usize = 0;
  if (manLen) {
    if (manOff < DATA_START || manLen > MAN_MAX || manLen < 16 || manOff > <u64>size || manLen > <u64>size - manOff) return corrupt(s, "the manifest lies outside it");
    man = alloc(<usize>manLen);
    if (!man) return corrupt(s, "the arena has no room for the manifest");
    if (!rd(s, manOff, man, <u32>manLen)) { free(man); return corrupt(s, "the manifest cannot be read"); }
    if (fnv64(man, <usize>manLen) != manSum || load<u32>(man) != MAGIC_MAN || load<u32>(man, 4) != 1 || <u64>load<u32>(man, 8) != count) { free(man); return corrupt(s, "the manifest does not match its checksum"); }
  } else if (manOff || count) return corrupt(s, "an empty manifest with a position");
  // build the new tree beside the old one, then swap
  memory.copy(BACKUP, changetype<usize>(s), 160);   // the record as it is, to restore on failure
  s.nodes = 0; s.nodeCap = 0; s.nodeFree = -1; s.fl = 0; s.flN = 0; s.flCap = 0; s.df = 0; s.dfN = 0; s.dfCap = 0;
  const why = build(s, man, <u32>manLen, <u32>count, manOff, <u64>size);
  free(man);
  if (why !== null) {
    dropTree(s);
    memory.copy(changetype<usize>(s), BACKUP, 160);
    return corrupt(s, why);
  }
  // success: drop the old tree (its record is in BACKUP)
  const keepNodes = s.nodes, keepCap = s.nodeCap, keepFree = s.nodeFree, keepFl = s.fl, keepFlN = s.flN, keepFlCap = s.flCap, keepEnd = s.end, keepSerial = s.serial;
  memory.copy(changetype<usize>(s), BACKUP, 160);
  dropTree(s);
  s.nodes = keepNodes; s.nodeCap = keepCap; s.nodeFree = keepFree; s.fl = keepFl; s.flN = keepFlN; s.flCap = keepFlCap; s.end = keepEnd; s.serial = keepSerial;
  s.gen = gen; s.manOff = manOff; s.manLen = manLen; s.epoch++;
  return LOAD_OK;
}
// The tree and the free list of a manifest; null, or why it is refused
function build(s: Save, man: usize, manLen: u32, count: u32, manOff: u64, size: u64): string | null {
  if (!emptyTree(s)) return "the arena is full";
  if (!manLen) return null;
  // map: manifest position (1-based) -> node
  const map = alloc((<usize>count + 1) * 4), ext = alloc((<usize>count + 1) * 16);
  if (!map || !ext) { free(map); free(ext); return "the arena is full"; }
  store<i32>(map, 0);
  let p: u32 = 16, nExt: u32 = 0, why: string | null = null;
  store<u64>(ext, manOff); store<u64>(ext, capFor(manLen), 8); nExt = 1;
  for (let i: u32 = 1; i <= count; i++) {
    if (manLen - p < 32) { why = "the manifest is cut short"; break; }
    const e = man + p, parent = load<u32>(e), type = load<u8>(e, 4), len = <u32>load<u16>(e, 6);
    const off = load<u64>(e, 8), cap = load<u64>(e, 16), fsize = load<u64>(e, 24);
    const step: u32 = 32 + ((len + 7) & ~7);
    if (step > manLen - p) { why = "the manifest is cut short"; break; }
    if (parent >= i || type > 1 || load<u8>(e, 5) != 0 || !nameOk(e + 32, len)) { why = "a manifest entry is damaged"; break; }
    const pn = load<i32>(map + <usize>parent * 4);
    if (nType(s, pn) != N_DIR || nodeChild(s, pn, e + 32, len) >= 0) { why = "a manifest entry has no place in the tree"; break; }
    if (type == N_DIR ? (off | cap | fsize) != 0 : (fsize > cap || (cap == 0 && off != 0) || (cap & 255) != 0)) { why = "a manifest entry's extent is impossible"; break; }
    const n = nodeNew(s, pn, type, e + 32, len);
    if (n < 0) { why = "the arena is full"; break; }
    store<i32>(map + <usize>i * 4, n);
    if (cap) {
      const q = np(s, n);
      store<u64>(q, off, 24); store<u64>(q, cap, 32); store<u64>(q, fsize, 40); store<u8>(q, NF_USED | NF_COMMITTED, 17);
      store<u64>(ext + <usize>nExt * 16, off); store<u64>(ext + <usize>nExt * 16, cap, 8); nExt++;
    }
    p += step;
  }
  if (why === null && p != manLen) why = "the manifest has bytes after its last entry";
  if (why === null) {
    // the extents must lie inside the container and apart from each other; the gaps between them are free
    sortPairs(ext, nExt);
    let at: u64 = DATA_START;
    for (let i: u32 = 0; i < nExt; i++) {
      const off = load<u64>(ext + <usize>i * 16), cap = load<u64>(ext + <usize>i * 16, 8);
      // the last extent may reach past the device's end: capacity is reserved, not written (a file never reads past its size)
      if (off < at || off > size || (cap > size - off && (i != nExt - 1 || off >= size))) { why = "two extents overlap or lie outside the container"; break; }
      if (off > at && !listPush(s, false, s.flN, at, off - at)) { why = "the arena is full"; break; }
      at = off + cap;
    }
    s.end = at;
  }
  free(map); free(ext);
  return why;
}

// ---- commit ----
// Write slot `gen` for the manifest at (off, len) with checksum sum and node count n
function slotWrite(s: Save, gen: u64, off: u64, len: u64, sum: u64, count: u64): bool {
  memory.fill(SLOT, 0, SLOT_SIZE);
  store<u64>(SLOT, MAGIC_SLOT); store<u64>(SLOT, gen, 8); store<u64>(SLOT, off, 16); store<u64>(SLOT, len, 24); store<u64>(SLOT, sum, 32); store<u64>(SLOT, count, 40);
  store<u64>(SLOT, fnv64(SLOT, 56), 56);
  return wr(s, (gen & 1) * SLOT_B, SLOT, SLOT_SIZE);
}
export function saveFormat(s: Save): bool { return slotWrite(s, 0, 0, 0, 0, 0); }
let newSum: u64 = 0, newCount: u32 = 0;
// Step 1 of a commit: serialize the working tree and write it to a fresh extent. False: nothing committed changed.
export function commitWriteManifest(s: Save): bool {
  // pre-order numbering
  let count: u32 = 0, bytes: u64 = 16, cur: i32 = 0;
  for (;;) {
    let next = nChild(s, cur);
    while (next < 0 && cur != 0) { next = nNext(s, cur); if (next < 0) cur = nParent(s, cur); }
    if (next < 0) break;
    cur = next;
    store<u32>(np(s, cur), ++count, 56);
    bytes += 32 + ((nNameLen(s, cur) + 7) & ~7);
  }
  if (bytes > MAN_MAX) { lastErr = ENOSPC_; return false; }
  const man = allocZ(<usize>bytes);
  if (!man) { lastErr = ENOSPC_; lb("[RED] fs save commit: the arena has no room for the manifest"); le(); return false; }
  store<u32>(man, MAGIC_MAN); store<u32>(man, 1, 4); store<u32>(man, count, 8);
  let p: usize = man + 16;
  cur = 0;
  for (;;) {
    let next = nChild(s, cur);
    while (next < 0 && cur != 0) { next = nNext(s, cur); if (next < 0) cur = nParent(s, cur); }
    if (next < 0) break;
    cur = next;
    const parent = nParent(s, cur), len = nNameLen(s, cur);
    store<u32>(p, parent == 0 ? 0 : load<u32>(np(s, parent), 56));
    store<u8>(p, nType(s, cur), 4); store<u16>(p, <u16>len, 6);
    store<u64>(p, nOff(s, cur), 8); store<u64>(p, nCap(s, cur), 16); store<u64>(p, nSize(s, cur), 24);
    memory.copy(p + 32, nName(s, cur), len);
    p += 32 + ((len + 7) & ~7);
  }
  const cap = capFor(bytes), off = extAlloc(s, cap);
  let ok = true;
  for (let done: u64 = 0; ok && done < bytes; done += 0x1000000) {
    const n = bytes - done > 0x1000000 ? 0x1000000 : <u32>(bytes - done);
    ok = wr(s, off + done, man + <usize>done, n);
  }
  newSum = fnv64(man, <usize>bytes); newCount = count;
  free(man);
  if (!ok) { extFree(s, off, cap, false); return false; }
  s.newOff = off; s.newLen = bytes; s.newCap = cap;
  return true;
}
export function commitAbandon(s: Save): void { extFree(s, s.newOff, s.newCap, false); s.newOff = 0; s.newLen = 0; s.newCap = 0; }
// Step 2: the one atomic step
export function commitWriteSlot(s: Save): bool { return slotWrite(s, s.gen + 1, s.newOff, s.newLen, newSum, newCount); }
// Step 3, after the second barrier: the new version is the committed one
export function commitFinish(s: Save): void {
  const oldOff = s.manOff, oldCap = capFor(s.manLen);
  s.gen++; s.manOff = s.newOff; s.manLen = s.newLen; s.newOff = 0; s.newLen = 0; s.newCap = 0;
  for (let i: u32 = 0; i < s.nodeCap; i++) {
    const p = s.nodes + <usize>i * NODE, f = load<u8>(p, 17);
    if ((f & NF_USED) && !(f & NF_DEAD) && load<u64>(p, 32)) store<u8>(p, f | NF_COMMITTED, 17);
  }
  // what the previous version used and this one does not is free now
  const n = s.dfN; s.dfN = 0;
  for (let i: u32 = 0; i < n; i++) extFree(s, load<u64>(s.df + <usize>i * 16), load<u64>(s.df + <usize>i * 16, 8), false);
  if (oldOff) extFree(s, oldOff, oldCap, false);
  s.commits++;
}
export function saveLastErr(): i32 { return lastErr ? lastErr : 5; }
export function saveUsedBytes(s: Save): u64 { return s.end; }
