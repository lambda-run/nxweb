// The nn::fs take-overs: the mount-name table, paths, the handle tables, the call contexts that can wait for
// storage, and one function per name of names.ts. Behaviour and result values follow nxnative dm/host/hle_fs.c;
// README.md lists the departures.
import { Inst } from "../kit/machine";
import { FS_MOUNT, FsMountS, FsMountE, FS_FILE, FsFileS, FsFileE, FS_DIR, FsDirS, FsDirE, FS_PEND, FsPendS, FsPendE, FsPendWaitFor,
  FsImageS, FsImageE, FsSaveS, FsSaveE } from "../kit/gen/tables";
import { RES_OK, RES_FAIL, RES_PATH_NOT_FOUND, RES_PATH_EXISTS, RES_TARGET_NOT_FOUND, FS_PENDING, FS_RETRY, R_WAIT,
  MODE_READ, MODE_WRITE, MODE_APPEND, ENT_DIR, ENT_FILE, DIRMODE_DIR, DIRMODE_FILE, NAME_MAX, DIRENT_SIZE, SIZE_256MB,
  DEV_OK, DEV_PENDING, DEV_NOT_FOUND, KIND_ROM, KIND_AOC, KIND_SAVE, KIND_DEVICE_SAVE, KIND_CACHE, KIND_TEMP, EIO, devErrno,
  dev_open, dev_size, dev_read, dev_flush, dev_remove, save_failed,
  lb, ls, lu, li, lx, lc, lbytes, le, gok, gstrlen, alloc, free } from "./base";
import { Fn, FN_COUNT, NAMES } from "./names";
import { Img, img, imgOf, imgCount, EMPTY, imgFindDir, imgFindFile, imgWorkSize, imgHdrBuf, imgHdrSize, imgHeader, imgTabOff, imgTabPtr,
  imgTabLen, imgDrop, imgValidate, dSibling, dChildDir, dChildFile, dNameLen, dName, fSibling, fDataOff, fSize, fNameLen, fName } from "./romfs";
import { Save, save, saveOf, saveFind, saveCount, N_DIR, N_FILE, nParent, nNext, nType, nNameLen, nName, nSize, nSerial, nLive, nValid, firstChild,
  nodeChild, nodeChildCount, nodeWithin, saveCreate, saveRemove, saveClean, saveRename, saveOpenRef, saveCloseRef, saveRead, saveWrite,
  saveSetSize, saveLoad, saveFormat, LOAD_OK, LOAD_BAD, OP_OK, commitWriteManifest, commitAbandon, commitWriteSlot, commitFinish,
  saveLastErr } from "./save";

// ---------- configuration ----------
let programId: u64 = 0;
let accountSave: i32 = -1;        // whether the game imports MountSaveData: -1 = as fs_lookup saw it
let sawMountSave: bool = false;
export function setProgramId(id: u64): void { programId = id; }
export function setAccountSave(v: i32): void { accountSave = v; }

// ---------- the mount-name table ----------
// +0 kit instance (fs_mount), +16 name (NUL-terminated, at most 31 bytes: a longer name is cut, as nxnative's
// strlcpy into name[32] does, and then matches no path), +48 u8 kind, +49 u8 add-on content, +50 u16 image / save index
export const MAX_MOUNT: u32 = 512;
const M_IMAGE: u8 = 1, M_SAVE: u8 = 2;
const MOUNTS: usize = memory.data(32768);
let nMnt: u32 = 0;
// @ts-ignore: decorator
@inline function mp(i: u32): usize { return MOUNTS + <usize>i * 64; }
// @ts-ignore: decorator
@inline function mInst(i: u32): Inst { return Inst.at(mp(i)); }
// @ts-ignore: decorator
@inline function mKind(i: u32): u8 { return load<u8>(mp(i), 48); }
// @ts-ignore: decorator
@inline function mTarget(i: u32): u32 { return load<u16>(mp(i), 50); }
function mNameLen(i: u32): u32 { let n: u32 = 0; while (load<u8>(mp(i) + 16 + n)) n++; return n; }
export function mountCount(): u32 { return nMnt; }

// The entry mounted under the len-byte name at p (a released entry is under none), or -1
function mntFind(p: usize, len: u32): i32 {
  if (len > 31) return -1;
  for (let i: u32 = 0; i < nMnt; i++) {
    if (mInst(i).state != FsMountS.Mounted) continue;
    const q = mp(i) + 16;
    if (load<u8>(q + len) == 0 && memory.compare(q, p, len) == 0) return <i32>i;
  }
  return -1;
}
function mntSetName(i: u32, p: usize, len: u32): void {
  const k = len > 31 ? 31 : len;
  memory.fill(mp(i) + 16, 0, 32);
  memory.copy(mp(i) + 16, p, k);
}
function mntAdd(p: usize, len: u32, kind: u8, target: u32, aoc: bool): i32 {
  if (nMnt >= MAX_MOUNT) { lb("[RED] fs mount "); lbytes(p, len); ls(": the mount table is full (512 names)"); le(); return -1; }
  const i = nMnt++;
  memory.fill(mp(i), 0, 64);
  mInst(i).init(FS_MOUNT, i);
  mntSetName(i, p, len);
  store<u8>(mp(i), kind, 48); store<u8>(mp(i), <u8>aoc, 49); store<u16>(mp(i), <u16>target, 50);
  mInst(i).step(FsMountE.Mount);
  return <i32>i;
}

// ---------- paths ----------
// A resolved path: the mount entry and the components after the name, "." dropped and ".." applied, as
// [u16 length][bytes] records in a buffer. Backslashes are slashes (Horizon's SetUpPath does that before it
// normalizes); going above the root is "not found".
const PB0: usize = memory.data(4096);
const PB1: usize = memory.data(4096);
const PTMP: usize = memory.data(1024);
const PSTK: usize = memory.data(2048);
let rMnt: u32 = 0, rN: u32 = 0;
function resolve(path: u64, pb: usize): u32 {
  const len = gstrlen(path, 4096);
  if (len < 0) return RES_FAIL;
  let src = <usize>path;
  if (len < 1024) {   // a longer path is left as it is, and is refused below
    let has = false;
    for (let i = 0; i < len; i++) if (load<u8>(src + i) == 92) { has = true; break; }
    if (has) {
      for (let i = 0; i < len; i++) { const c = load<u8>(src + i); store<u8>(PTMP + i, c == 92 ? 47 : c); }
      src = PTMP;
    }
  }
  let colon = -1;
  for (let i = 0; i < len; i++) if (load<u8>(src + i) == 58) { colon = i; break; }
  if (colon < 0) return RES_PATH_NOT_FOUND;
  const m = mntFind(src, <u32>colon);
  if (m < 0) return RES_PATH_NOT_FOUND;
  rMnt = <u32>m;
  if (len >= 1024) return RES_FAIL;   // nxnative: ENAMETOOLONG from its 1024-byte path buffers
  let n: u32 = 0, w: u32 = 0, i = colon + 1;
  while (i < len) {
    while (i < len && load<u8>(src + i) == 47) i++;
    const start = i;
    while (i < len && load<u8>(src + i) != 47) i++;
    const k = <u32>(i - start);
    if (!k) break;
    if (k == 1 && load<u8>(src + start) == 46) continue;
    if (k == 2 && load<u16>(src + start) == 0x2E2E) {
      if (!n) return RES_PATH_NOT_FOUND;
      n--; w = <u32>load<u16>(PSTK + <usize>n * 2);
      continue;
    }
    if (k > NAME_MAX) return RES_FAIL;
    store<u16>(PSTK + <usize>n * 2, <u16>w);
    store<u16>(pb + w, <u16>k);
    memory.copy(pb + w + 2, src + start, k);
    w += 2 + k; n++;
  }
  rN = n;
  return RES_OK;
}
function compPtr(pb: usize, i: u32): usize { let p = pb; for (; i; i--) p += 2 + <usize>load<u16>(p); return p; }

// The node the first `upto` components name in a save's working tree, or -1
function svWalk(s: Save, pb: usize, upto: u32): i32 {
  if (!s.nodes) return upto ? -1 : 0;
  let n: i32 = 0, p = pb;
  for (let i: u32 = 0; i < upto; i++) {
    const len = <u32>load<u16>(p);
    if (nType(s, n) != N_DIR) return -1;
    n = nodeChild(s, n, p + 2, len);
    if (n < 0) return -1;
    p += 2 + len;
  }
  return n;
}
// The entry the components name in an image: true with gIsFile / gEnt set
let gIsFile: bool = false, gEnt: u32 = 0;
function imWalk(m: Img, pb: usize, count: u32): bool {
  let d: u32 = 0, p = pb;
  for (let i: u32 = 0; i < count; i++) {
    const len = <u32>load<u16>(p);
    const e = imgFindDir(m, d, p + 2, len);
    if (e != EMPTY) { d = e; p += 2 + len; continue; }
    if (i == count - 1) {
      const f = imgFindFile(m, d, p + 2, len);
      if (f != EMPTY) { gIsFile = true; gEnt = f; return true; }
    }
    return false;
  }
  gIsFile = false; gEnt = d;
  return true;
}
// @ts-ignore: decorator
@inline function svBusy(s: Save): bool { const st = s.state; return st == FsSaveS.Recovering || st == FsSaveS.Committing || st == FsSaveS.Sealing; }
// @ts-ignore: decorator
@inline function svWritable(s: Save): bool { const st = s.state; return st == FsSaveS.Clean || st == FsSaveS.Dirty || st == FsSaveS.Poisoned; }

// ---------- handles ----------
// A guest handle is ((tag << 28) | (generation << 12) | slot) << 4: never 0 (0 is the handle a game keeps after a
// failed open), 16-byte aligned like the FileAccessor pointer it is on Horizon (a game may use the low bits:
// they are ignored on the way in), and a slot that was closed and opened again answers to a new value.
// file slot:      +0 kit instance (fs_file), +16 u8 mode, +18 u16 generation, +20 u16 save / image index, +24 u32 node / file entry, +28 u32 node serial
// directory slot: +0 kit instance (fs_dir), +16 u8 mode, +18 u16 generation, +20 u16 save / image index, +24 u32 snapshot / directory entry,
//                 +28 u32 snapshot length, +32 u32 position / next entry, +36 u32 image phase (0 directories, 1 files, 2 end)
const MAX_FH: u32 = 1024, MAX_DH: u32 = 256, TAG_FILE: u32 = 1, TAG_DIR: u32 = 2;
const FHS: usize = memory.data(32768);
const DHS: usize = memory.data(12288);
let fhInit: bool = false;
// @ts-ignore: decorator
@inline function fp(i: u32): usize { return FHS + <usize>i * 32; }
// @ts-ignore: decorator
@inline function dp(i: u32): usize { return DHS + <usize>i * 48; }
function handlesInit(): void {
  for (let i: u32 = 0; i < MAX_FH; i++) Inst.at(fp(i)).init(FS_FILE, i);
  for (let i: u32 = 0; i < MAX_DH; i++) Inst.at(dp(i)).init(FS_DIR, i);
  fhInit = true;
}
function handleOf(tag: u32, slot: usize, i: u32): u64 { return <u64>((tag << 28) | (<u32>load<u16>(slot, 18) << 12) | i) << 4; }
function badHandle(what: string, h: u64): void { lb("[RED] fs: "); ls(what); ls(" handle "); lx(h); ls(" is not open"); le(); }
// The slot of an open (or stale) handle, or 0
function slotOf(h: u64, tag: u32, max: u32, base: usize, size: usize): usize {
  const v = h >> 4;
  if (v >> 32) return 0;
  const w = <u32>v, i = w & 0xFFF;
  if ((w >> 28) != tag || i >= max) return 0;
  const p = base + <usize>i * size;
  if (<u32>load<u16>(p, 18) != ((w >> 12) & 0xFFFF) || load<u8>(p) == 0) return 0;   // state 0 is Closed in both machines
  return p;
}
function slotNew(max: u32, base: usize, size: usize): i32 {
  for (let i: u32 = 0; i < max; i++) if (load<u8>(base + <usize>i * size) == 0) return <i32>i;
  lb("[RED] fs: every handle slot is in use ("); lu(max); ls(")"); le();
  return -1;
}
function slotClose(p: usize): void { store<u16>(p, load<u16>(p, 18) + 1, 18); }
export function openFiles(): u32 { let n: u32 = 0; for (let i: u32 = 0; i < MAX_FH; i++) if (load<u8>(fp(i))) n++; return n; }
export function openDirs(): u32 { let n: u32 = 0; for (let i: u32 = 0; i < MAX_DH; i++) if (load<u8>(dp(i))) n++; return n; }
// The save was rebuilt from its committed version: what was open in the discarded working copy is stale
function invalidate(si: u32): void {
  let n: u32 = 0;
  for (let i: u32 = 0; i < MAX_FH; i++) {
    const p = fp(i), st = load<u8>(p);
    if ((st == FsFileS.OpenRead || st == FsFileS.OpenWrite || st == FsFileS.OpenReadWrite) && <u32>load<u16>(p, 20) == si) { Inst.at(p).step(FsFileE.Invalidate); n++; }
  }
  for (let i: u32 = 0; i < MAX_DH; i++) {
    const p = dp(i);
    if (load<u8>(p) == FsDirS.Open && <u32>load<u16>(p, 20) == si) { free(<usize>load<u32>(p, 24)); store<u32>(p, 0, 24); Inst.at(p).step(FsDirE.Invalidate); n++; }
  }
  if (n) { lb("[RED] fs save: "); lu(n); ls(" handle(s) were still open in the discarded working copy; they fail until closed"); le(); }
}

// ---------- call contexts ----------
const K_MOUNT_IMG: u32 = 1, K_QUERY_IMG: u32 = 2, K_IMG_READ: u32 = 3, K_MOUNT_SAVE: u32 = 4, K_COMMIT: u32 = 5, K_REMOVE: u32 = 6;
const MAX_PEND: u32 = 64;
// @ts-ignore: decorator
@unmanaged class Pend {
  m0: u64; m1: u64;      // kit instance (fs_pend)
  kind: u32; phase: u32;
  status: i32; i: u32;
  token: i32; wf: u32;
  a0: u64; a1: u64; a2: u64; a3: u64; a4: u64;
  v0: u64; v1: u64; v2: u64;
  // @ts-ignore: decorator
  @inline get inst(): Inst { return Inst.at(changetype<usize>(this)); }
}
const PENDS: usize = memory.data(8192);   // MAX_PEND * 128
// @ts-ignore: decorator
@inline function pend(i: u32): Pend { return changetype<Pend>(PENDS + <usize>i * 128); }
function pendBegin(kind: u32): Pend | null {
  for (let i: u32 = 0; i < MAX_PEND; i++) {
    const p = pend(i);
    if (p.inst.state != FsPendS.Free) continue;
    p.kind = kind; p.phase = 0; p.status = 0; p.i = 0; p.token = <i32>i + 1; p.v0 = 0; p.v1 = 0; p.v2 = 0;
    p.inst.step(FsPendE.Begin);
    return p;
  }
  return null;
}
// A storage call returned st: true when the context must wait for fs_complete; either way it continues at `next`
function wait(p: Pend, st: i32, next: u32, wf: u64): bool {
  p.phase = next;
  if (st == DEV_PENDING) { p.wf = <u32>wf; return true; }
  p.status = st;
  return false;
}
function pendRun(p: Pend): i64 {
  let r: i64;
  switch (p.kind) {
    case K_MOUNT_IMG: r = stepMountImg(p); break;
    case K_QUERY_IMG: r = stepQueryImg(p); break;
    case K_IMG_READ: r = stepImgRead(p); break;
    case K_MOUNT_SAVE: r = stepMountSave(p); break;
    case K_COMMIT: r = stepCommit(p); break;
    default: r = stepRemove(p);
  }
  if (r == R_WAIT) { p.inst.step(FsPendE.Park, p.wf); return FS_PENDING | <i64>p.token; }
  p.inst.step(FsPendE.Finish);
  return r;
}
export function complete(token: i32, status: i32): i64 {
  if (token < 1 || <u32>token > MAX_PEND || pend(<u32>token - 1).inst.state != FsPendS.Waiting) {
    lb("[RED] fs_complete: no call waits under token "); li(token); le();
    return RES_FAIL;
  }
  const p = pend(<u32>token - 1);
  p.status = status;
  p.inst.step(FsPendE.Resume);
  return pendRun(p);
}
export function pendWaiting(): u32 { let n: u32 = 0; for (let i: u32 = 0; i < MAX_PEND; i++) if (pend(i).inst.state == FsPendS.Waiting) n++; return n; }

export function init(): void {
  if (fhInit) return;
  handlesInit();
  for (let i: u32 = 0; i < MAX_PEND; i++) pend(i).inst.init(FS_PEND, i);
}

// ---------- images ----------
const L_OK: i32 = 0, L_WAIT: i32 = 1, L_RETRY: i32 = 2, L_MISSING: i32 = 3, L_BAD: i32 = 4;
function imgDamaged(m: Img): i32 { imgDrop(m); m.inst.step(FsImageE.Damaged); return L_BAD; }
// Bring an image to Ready: open its device, read the header and the tables, check them
function imgLoad(p: Pend, m: Img): i32 {
  for (;;) switch (p.phase) {
    case 0: {
      const st = m.state;
      if (st == FsImageS.Ready) return L_OK;
      if (st == FsImageS.Bad) return L_BAD;
      if (st != FsImageS.Absent) return L_RETRY;   // another call is loading it
      m.inst.step(FsImageE.Open);
      if (wait(p, dev_open(m.kind, m.index, p.token), 1, FsPendWaitFor.open)) return L_WAIT;
      break;
    }
    case 1: {
      if (p.status < 0x100) {
        m.inst.step(FsImageE.Missing);
        if (p.status == DEV_NOT_FOUND) return L_MISSING;
        lb("[RED] fs RomFS image (kind "); li(m.kind); ls(", index "); li(m.index); ls("): the storage device cannot be opened"); le();
        return L_BAD;
      }
      m.dev = p.status;
      m.inst.step(FsImageE.Opened);
      const size = dev_size(m.dev);
      const hdr = imgHdrBuf(m);
      if (size < <i64>imgHdrSize() || !hdr) {
        lb("[RED] fs RomFS image (kind "); li(m.kind); ls(", index "); li(m.index); ls(") refused: shorter than a header ("); li(size); ls(" bytes)"); le();
        return imgDamaged(m);
      }
      m.devSize = <u64>size;
      if (wait(p, dev_read(m.dev, 0, hdr, imgHdrSize(), p.token), 2, FsPendWaitFor.read)) return L_WAIT;
      break;
    }
    case 2: {
      if (p.status != DEV_OK) { lb("[RED] fs RomFS image: reading the header failed"); le(); return imgDamaged(m); }
      if (!imgHeader(m)) return imgDamaged(m);
      p.i = 0; p.phase = 3;
      break;
    }
    case 3: {
      if (p.i >= 4) { p.phase = 5; break; }
      const len = imgTabLen(m, p.i);
      if (!len) { p.status = DEV_OK; p.phase = 4; break; }
      if (wait(p, dev_read(m.dev, imgTabOff(m, p.i), imgTabPtr(m, p.i), len, p.token), 4, FsPendWaitFor.read)) return L_WAIT;
      break;
    }
    case 4: {
      if (p.status != DEV_OK) { lb("[RED] fs RomFS image: reading table "); lu(p.i); ls(" failed"); le(); return imgDamaged(m); }
      p.i++; p.phase = 3;
      break;
    }
    default: {
      if (!imgValidate(m)) { m.inst.step(FsImageE.Damaged); return L_BAD; }
      m.inst.step(FsImageE.Loaded);
      lb("fs RomFS image (kind "); li(m.kind); ls(", index "); li(m.index); ls("): "); lu(m.ndir); ls(" directories, "); lu(m.nfile); ls(" files"); le();
      return L_OK;
    }
  }
  return L_BAD;
}
function opMountImg(name: u64, kind: i32, index: i64, aoc: bool): i64 {
  const nl = gstrlen(name, 4096);
  if (nl < 0) return RES_FAIL;
  if (!aoc && mntFind(<usize>name, <u32>nl) >= 0) return RES_OK;   // a name in use keeps its target
  const im = imgOf(kind, index);
  if (im < 0) { lb("[RED] fs mount: the image table is full"); le(); return RES_FAIL; }
  const p = pendBegin(K_MOUNT_IMG);
  if (p === null) return FS_RETRY;
  p.a0 = name; p.v0 = <u64>im; p.v1 = <u64>aoc;
  return pendRun(p);
}
function stepMountImg(p: Pend): i64 {
  const m = img(<u32>p.v0), aoc = p.v1 != 0, name = <usize>p.a0;
  const nl = <u32>gstrlen(p.a0, 4096);
  const r = imgLoad(p, m);
  if (r == L_WAIT) return R_WAIT;
  if (r == L_RETRY) return FS_RETRY;
  if (r == L_MISSING) {
    if (aoc) { lb("fs mount add-on content "); lbytes(name, nl); ls(": index "); li(m.index); ls(" does not exist"); le(); return RES_TARGET_NOT_FOUND; }
    lb("[RED] fs mount "); lbytes(name, nl); ls(": the game files are missing (no RomFS image was given)"); le();
    return RES_FAIL;
  }
  if (r == L_BAD) {
    lb("[RED] fs mount "); lbytes(name, nl); ls(": the image is not a complete RomFS image"); le();
    return RES_FAIL;
  }
  if (mntFind(name, nl) >= 0) return RES_OK;
  if (aoc) {
    // an entry this add-on had before its Unmount is taken back under the new name
    for (let i: u32 = 0; i < nMnt; i++)
      if (mInst(i).state == FsMountS.Released && mKind(i) == M_IMAGE && mTarget(i) == <u32>p.v0) {
        mntSetName(i, name, nl);
        mInst(i).step(FsMountE.Remount);
        lb("fs mount "); lbytes(name, nl); ls(": add-on content "); li(m.index); ls(" (read-only, the entry it had before its unmount)"); le();
        return RES_OK;
      }
  }
  if (mntAdd(name, nl, M_IMAGE, <u32>p.v0, aoc) < 0) return RES_FAIL;
  lb("fs mount "); lbytes(name, nl); ls(": RomFS image (kind "); li(m.kind); ls(", index "); li(m.index); ls(", read-only)"); le();
  return RES_OK;
}
function opQueryImg(out: u64, kind: i32, index: i64): i64 {
  if (!gok(out, 8)) return RES_FAIL;
  const im = imgOf(kind, index);
  if (im < 0) { store<u64>(<usize>out, 0x1000); return RES_OK; }
  const p = pendBegin(K_QUERY_IMG);
  if (p === null) return FS_RETRY;
  p.a0 = out; p.v0 = <u64>im;
  return pendRun(p);
}
function stepQueryImg(p: Pend): i64 {
  const m = img(<u32>p.v0);
  const r = imgLoad(p, m);
  if (r == L_WAIT) return R_WAIT;
  if (r == L_RETRY) return FS_RETRY;
  // an index the host does not have: the minimum; the mount then fails
  store<u64>(<usize>p.a0, r == L_OK ? imgWorkSize(m) : 0x1000);
  return RES_OK;
}

// ---------- save mounts ----------
function unusable(s: Save, err: i32): void {
  s.inst.step(FsSaveE.Unusable);
  lb("[RED] fs save "); li(s.kind); ls(": mounted read-only (errno "); li(err); ls("): saves cannot be written this session, what is stored is left as it is"); le();
  save_failed(err);
}
function addSaveMount(name: u64, si: u32): i64 {
  const nl = <u32>gstrlen(name, 4096), s = save(si);
  if (mntFind(<usize>name, nl) >= 0) return RES_OK;
  if (mntAdd(<usize>name, nl, M_SAVE, si, false) < 0) return RES_FAIL;
  lb("fs mount "); lbytes(<usize>name, nl); ls(": save backing (kind "); li(s.kind); ls(", index "); li(s.index);
  ls(s.state == FsSaveS.ReadOnly ? ", read-only)" : s.txn ? ", transactional)" : ", not transactional)"); le();
  return RES_OK;
}
function opMountSave(name: u64, kind: i32, index: i64): i64 {
  const nl = gstrlen(name, 4096);
  if (nl < 0) return RES_FAIL;
  if (mntFind(<usize>name, <u32>nl) >= 0) return RES_OK;
  const si = saveOf(kind, index);
  if (si < 0) { lb("[RED] fs mount: the save table is full"); le(); return RES_FAIL; }
  const s = save(<u32>si);
  if (svBusy(s)) return FS_RETRY;
  // a second name for a save that is mounted shares its transaction
  if (s.state != FsSaveS.Unmounted) return addSaveMount(name, <u32>si);
  const p = pendBegin(K_MOUNT_SAVE);
  if (p === null) return FS_RETRY;
  p.a0 = name; p.v0 = <u64>si;
  return pendRun(p);
}
function stepMountSave(p: Pend): i64 {
  const s = save(<u32>p.v0);
  for (;;) switch (p.phase) {
    case 0: {
      s.inst.step(FsSaveE.Mount); s.owner = <u32>p.token;
      if (wait(p, dev_open(s.kind, s.index, p.token), 1, FsPendWaitFor.open)) return R_WAIT;
      break;
    }
    case 1: {
      p.phase = 9;
      if (p.status < 0x100) { unusable(s, EIO); break; }
      s.dev = p.status;
      const r = saveLoad(s);
      if (r == LOAD_OK) { s.inst.step(FsSaveE.Recovered); break; }
      if (r == LOAD_BAD) { unusable(s, EIO); break; }
      // a new container: its first superblock
      if (!saveFormat(s)) { unusable(s, saveLastErr()); break; }
      if (wait(p, dev_flush(s.dev, p.token), 2, FsPendWaitFor.flush)) return R_WAIT;
      break;
    }
    case 2: {
      if (p.status != DEV_OK) unusable(s, devErrno(p.status)); else s.inst.step(FsSaveE.Recovered);
      p.phase = 9;
      break;
    }
    default: {
      s.owner = 0;
      return addSaveMount(p.a0, <u32>p.v0);
    }
  }
  return RES_FAIL;
}

// ---------- commit ----------
const C_OK: i32 = 0, C_WAIT: i32 = 1, C_RETRY: i32 = 2, C_FAIL: i32 = 3;
// A storage write failed in this transaction: the commit is refused, the working copy is discarded and rebuilt
// from the committed version, and the front end is told
function refuse(s: Save, si: u32): void {
  const err = <i32>s.inst.data;
  s.inst.step(FsSaveE.Discard);
  const r = saveLoad(s);
  if (r != LOAD_BAD) { invalidate(si); s.inst.step(FsSaveE.Recovered); }
  else s.inst.step(FsSaveE.StillPoisoned, <u64>err);
  lb("[RED] save commit refused: a save write failed in this transaction (errno "); li(err); ls("); the committed version is unchanged, the working copy ");
  ls(r != LOAD_BAD ? "was rebuilt from it" : "could not be rebuilt and stays tainted (the next commit is refused again and retries)"); le();
  save_failed(err);
}
// The superblock write or the barrier after it failed: which version is committed is not known here, so ask the device
function uncertain(s: Save, si: u32): void {
  s.inst.step(FsSaveE.SealUncertain);
  s.newOff = 0; s.newLen = 0; s.newCap = 0;
  const r = saveLoad(s);
  s.owner = 0;
  lb("[RED] save commit: writing the superblock failed; the save was read again from storage"); le();
  if (r != LOAD_BAD) { invalidate(si); s.inst.step(FsSaveE.Recovered); save_failed(EIO); }
  else unusable(s, EIO);
}
function commitRun(p: Pend, si: u32): i32 {
  const s = save(si);
  for (;;) switch (p.phase) {
    case 0: {
      const st = s.state;
      if (svBusy(s)) return C_RETRY;
      if (st == FsSaveS.ReadOnly || st == FsSaveS.Unmounted) return C_OK;
      if (st == FsSaveS.Clean) { s.inst.step(FsSaveE.Commit); s.commits++; return C_OK; }
      if (st == FsSaveS.Poisoned) { refuse(s, si); return C_FAIL; }
      s.inst.step(FsSaveE.Commit); s.owner = <u32>p.token;
      if (!commitWriteManifest(s)) {
        s.inst.step(FsSaveE.CommitFailed); s.owner = 0;
        lb("[RED] save commit: writing the manifest failed (errno "); li(saveLastErr()); ls("); the committed version is unchanged"); le();
        return C_FAIL;
      }
      if (wait(p, dev_flush(s.dev, p.token), 1, FsPendWaitFor.flush)) return C_WAIT;
      break;
    }
    case 1: {
      if (p.status != DEV_OK) {
        commitAbandon(s); s.inst.step(FsSaveE.CommitFailed); s.owner = 0;
        lb("[RED] save commit: the data could not be made durable; the committed version is unchanged"); le();
        return C_FAIL;
      }
      s.inst.step(FsSaveE.DataDurable);
      if (!commitWriteSlot(s)) { uncertain(s, si); return C_FAIL; }
      if (wait(p, dev_flush(s.dev, p.token), 2, FsPendWaitFor.flush)) return C_WAIT;
      break;
    }
    default: {
      if (p.status != DEV_OK) { uncertain(s, si); return C_FAIL; }
      commitFinish(s);
      s.inst.step(FsSaveE.Sealed); s.owner = 0;
      lb("save commit #"); lu(s.commits); ls(": save backing (kind "); li(s.kind); ls(") generation "); lu(s.gen); le();
      return C_OK;
    }
  }
  return C_FAIL;
}
function stepCommit(p: Pend): i64 {
  for (;;) {
    const mask = <u32>p.v0;
    if (!mask) return RES_OK;
    const si = <u32>ctz<u32>(mask);
    const r = commitRun(p, si);
    if (r == C_WAIT) return R_WAIT;
    if (r == C_RETRY) return FS_RETRY;
    if (r == C_FAIL) return RES_FAIL;
    p.v0 = <u64>(mask & ~(<u32>1 << si)); p.phase = 0;
  }
  return RES_FAIL;
}
function commitStart(mask: u32): i64 {
  const p = pendBegin(K_COMMIT);
  if (p === null) return FS_RETRY;
  p.v0 = <u64>mask;
  return pendRun(p);
}
function opCommit(name: u64): i64 {
  const nl = gstrlen(name, 4096);
  if (nl < 0) return RES_OK;
  const i = mntFind(<usize>name, <u32>nl);
  if (i < 0 || mKind(<u32>i) != M_SAVE) return RES_OK;   // not a transactional mount: nothing to commit
  const s = save(mTarget(<u32>i));
  if (!s.txn || s.state == FsSaveS.ReadOnly) return RES_OK;
  return commitStart(<u32>1 << mTarget(<u32>i));
}
// A list is atomic only when every save data mount in it is the same backing: checked before anything is committed.
// Cache storages in the list are committed one after the other (nxnative skips them: its cache folders are not journaled)
function opCommitList(names: u64, count: i32): i64 {
  if (count < 0 || count > <i32>MAX_MOUNT || (count && !<usize>names)) return RES_FAIL;
  if (!count) return RES_OK;
  if (!gok(names, <u64>count * 8)) return RES_FAIL;
  let target: i32 = -1, mask: u32 = 0;
  for (let k = 0; k < count; k++) {
    const np = load<u64>(<usize>names + <usize>k * 8);
    const nl = gstrlen(np, 4096);
    if (nl < 0 || nl >= 32) return RES_FAIL;
    const i = mntFind(<usize>np, <u32>nl);
    if (i < 0 || mKind(<u32>i) != M_SAVE) return RES_FAIL;   // unknown, or read-only game files
    const si = mTarget(<u32>i), s = save(si);
    if (s.state == FsSaveS.ReadOnly) return RES_FAIL;
    if (!s.txn) continue;
    if (s.strict) {
      if (target >= 0 && target != <i32>si) { lb("[RED] Commit mount list spans independent saves; refused without a partial commit"); le(); return RES_FAIL; }
      target = <i32>si;
    }
    mask |= <u32>1 << si;
  }
  return mask ? commitStart(mask) : RES_OK;
}
function opDeleteCache(index: i32): i64 {
  const si = saveFind(KIND_CACHE, index);
  if (si >= 0 && save(<u32>si).state != FsSaveS.Unmounted) {
    lb("[RED] fs delete cache storage "); li(index); ls(": it is mounted; not deleted"); le();
    return RES_FAIL;
  }
  const p = pendBegin(K_REMOVE);
  if (p === null) return FS_RETRY;
  p.a0 = <u64>index;
  return pendRun(p);
}
function stepRemove(p: Pend): i64 {
  if (p.phase == 0 && wait(p, dev_remove(KIND_CACHE, <i64>p.a0, p.token), 1, FsPendWaitFor.remove)) return R_WAIT;
  return RES_OK;
}

// ---------- files ----------
function opOpenFile(out: u64, path: u64, mode: u32): i64 {
  const r = resolve(path, PB0);
  if (r) return r;
  if (!gok(out, 8)) return RES_FAIL;
  const wr = (mode & (MODE_WRITE | MODE_APPEND)) != 0;
  const mi = rMnt, target = mTarget(mi);
  if (mKind(mi) == M_IMAGE) {
    const m = img(target);
    if (!imWalk(m, PB0, rN) || !gIsFile) return RES_PATH_NOT_FOUND;
    if (wr) { lb("fs write to a read-only mount: "); lbytes(<usize>path, <u32>gstrlen(path, 4096)); le(); return RES_FAIL; }
    const i = slotNew(MAX_FH, FHS, 32);
    if (i < 0) return RES_FAIL;
    const p = fp(<u32>i);
    Inst.at(p).step(FsFileE.OpenImage);
    store<u8>(p, <u8>MODE_READ, 16); store<u16>(p, <u16>target, 20); store<u32>(p, gEnt, 24); store<u32>(p, 0, 28);
    store<u64>(<usize>out, handleOf(TAG_FILE, p, <u32>i));
    return RES_OK;
  }
  const s = save(target);
  if (wr && svBusy(s)) return FS_RETRY;
  const n = svWalk(s, PB0, rN);
  if (n < 0) return RES_PATH_NOT_FOUND;
  if (wr && !svWritable(s)) { lb("fs write to a read-only mount: "); lbytes(<usize>path, <u32>gstrlen(path, 4096)); le(); return RES_FAIL; }
  if (!s.nodes || nType(s, n) != N_FILE) return wr ? RES_FAIL : RES_PATH_NOT_FOUND;   // open(2) of a directory: EISDIR for writing
  const i = slotNew(MAX_FH, FHS, 32);
  if (i < 0) return RES_FAIL;
  const p = fp(<u32>i);
  Inst.at(p).step(wr ? ((mode & MODE_READ) ? FsFileE.OpenReadWrite : FsFileE.OpenWrite) : FsFileE.OpenRead);
  store<u8>(p, <u8>mode, 16); store<u16>(p, <u16>target, 20); store<u32>(p, <u32>n, 24); store<u32>(p, nSerial(s, n), 28);
  saveOpenRef(s, n);
  store<u64>(<usize>out, handleOf(TAG_FILE, p, <u32>i));
  return RES_OK;
}
function readDone(out: u64, got: u64, want: u64, exact: bool): i64 {
  if (exact) {
    if (got != want) { lb("fs ReadFile short read: wanted "); lu(want); ls(" got "); lu(got); le(); return RES_FAIL; }
    return RES_OK;
  }
  store<u64>(<usize>out, got);
  return RES_OK;
}
// The four ReadFile overloads: with the bytes-read output, or (exact) the read must be complete
function opRead(out: u64, h: u64, off: i64, buf: u64, sz: u64, exact: bool): i64 {
  if (!exact && !gok(out, 8)) return RES_FAIL;
  if (!(h >> 4)) { if (!exact) store<u64>(<usize>out, 0); return RES_FAIL; }   // the null handle a game keeps using after a failed open
  const p = slotOf(h, TAG_FILE, MAX_FH, FHS, 32);
  if (!p) { badHandle("file", h); return RES_FAIL; }
  const st = load<u8>(p);
  if (st == FsFileS.OpenImageEntry) {
    const m = img(<u32>load<u16>(p, 20)), f = load<u32>(p, 24), size = fSize(m, f);
    const n: u64 = off < 0 || <u64>off >= size ? 0 : (size - <u64>off < sz ? size - <u64>off : sz);
    if (!n) return readDone(out, 0, sz, exact);
    if (n > 0xFFFFFFFF || !gok(buf, n)) return RES_FAIL;
    const c = pendBegin(K_IMG_READ);
    if (c === null) return FS_RETRY;
    c.a0 = out; c.a1 = m.dataOff + fDataOff(m, f) + <u64>off; c.a2 = buf; c.a3 = n; c.a4 = sz; c.v0 = <u64>m.dev; c.v1 = <u64>exact;
    return pendRun(c);
  }
  if (st != FsFileS.OpenRead && st != FsFileS.OpenReadWrite) return RES_FAIL;   // write-only (EBADF), or stale
  const s = save(<u32>load<u16>(p, 20)), node = <i32>load<u32>(p, 24);
  if (!nValid(s, node, load<u32>(p, 28)) || off < 0) return RES_FAIL;
  const size = nSize(s, node);
  const n: u64 = <u64>off >= size ? 0 : (size - <u64>off < sz ? size - <u64>off : sz);
  if (n && (n > 0xFFFFFFFF || !gok(buf, n))) return RES_FAIL;
  if (saveRead(s, node, <u64>off, <usize>buf, n) < 0) { lb("fs read failed (storage error)"); le(); return RES_FAIL; }
  return readDone(out, n, sz, exact);
}
function stepImgRead(p: Pend): i64 {
  if (p.phase == 0 && wait(p, dev_read(<i32>p.v0, <i64>p.a1, <usize>p.a2, <u32>p.a3, p.token), 1, FsPendWaitFor.read)) return R_WAIT;
  if (p.status != DEV_OK) { lb("fs read of a RomFS file failed (storage error "); li(p.status); ls(")"); le(); return RES_FAIL; }
  return readDone(p.a0, p.a3, p.a4, p.v1 != 0);
}
// The slot of a handle that may write, with gSave / gNode set; 0 and gRes otherwise
let gSave: u32 = 0, gNode: i32 = 0, gRes: i64 = 0;
function writable(h: u64): usize {
  gRes = RES_FAIL;
  if (!(h >> 4)) return 0;
  const p = slotOf(h, TAG_FILE, MAX_FH, FHS, 32);
  if (!p) { badHandle("file", h); return 0; }
  const st = load<u8>(p);
  if (st != FsFileS.OpenWrite && st != FsFileS.OpenReadWrite) return 0;   // an image entry, a file opened for reading (EBADF), or stale
  gSave = <u32>load<u16>(p, 20); gNode = <i32>load<u32>(p, 24);
  const s = save(gSave);
  if (svBusy(s)) { gRes = FS_RETRY; return 0; }
  if (!svWritable(s) || !nValid(s, gNode, load<u32>(p, 28))) return 0;
  return p;
}
function opWrite(h: u64, off: i64, buf: u64, sz: u64): i64 {
  if (!writable(h)) return gRes;
  if (!sz) return RES_OK;
  if (off < 0 || sz > 0xFFFFFFFF || !gok(buf, sz) || <u64>off + sz > <u64>i64.MAX_VALUE) return RES_FAIL;
  return saveWrite(save(gSave), gNode, <u64>off, <usize>buf, sz) == OP_OK ? RES_OK : RES_FAIL;
}
function opSetSize(h: u64, sz: i64): i64 {
  if (!writable(h)) return gRes;
  if (sz < 0) return RES_FAIL;
  return saveSetSize(save(gSave), gNode, <u64>sz) == OP_OK ? RES_OK : RES_FAIL;
}
function opGetSize(out: u64, h: u64): i64 {
  if (!(h >> 4)) return RES_FAIL;
  const p = slotOf(h, TAG_FILE, MAX_FH, FHS, 32);
  if (!p) { badHandle("file", h); return RES_FAIL; }
  if (!gok(out, 8)) return RES_FAIL;
  const st = load<u8>(p);
  if (st == FsFileS.OpenImageEntry) { store<u64>(<usize>out, fSize(img(<u32>load<u16>(p, 20)), load<u32>(p, 24))); return RES_OK; }
  const s = save(<u32>load<u16>(p, 20)), node = <i32>load<u32>(p, 24);
  if (st == FsFileS.Stale || !nValid(s, node, load<u32>(p, 28))) return RES_FAIL;
  store<u64>(<usize>out, nSize(s, node));
  return RES_OK;
}
function opCloseFile(h: u64): void {
  if (!(h >> 4)) return;   // the null handle after a failed open
  const p = slotOf(h, TAG_FILE, MAX_FH, FHS, 32);
  if (!p) { badHandle("file", h); return; }
  const st = load<u8>(p);
  if (st != FsFileS.OpenImageEntry && st != FsFileS.Stale) {
    const s = save(<u32>load<u16>(p, 20)), node = <i32>load<u32>(p, 24);
    if (nValid(s, node, load<u32>(p, 28))) saveCloseRef(s, node);
  }
  Inst.at(p).step(FsFileE.Close);
  slotClose(p);
}
function opOpenMode(h: u64): i64 {
  const p = slotOf(h, TAG_FILE, MAX_FH, FHS, 32);
  return p ? <i64>load<u8>(p, 16) : 0;
}

// ---------- path operations ----------
const P_CREATE_FILE: u32 = 0, P_CREATE_DIR: u32 = 1, P_DELETE_FILE: u32 = 2, P_DELETE_DIR: u32 = 3, P_DELETE_REC: u32 = 4, P_CLEAN: u32 = 5;
function roLog(path: u64): i64 { lb("fs write to a read-only mount: "); lbytes(<usize>path, <u32>gstrlen(path, 4096)); le(); return RES_FAIL; }
function opCreate(path: u64, size: i64, type: u8): i64 {
  const r = resolve(path, PB0);
  if (r) return r;
  const mi = rMnt;
  if (mKind(mi) == M_IMAGE) return imWalk(img(mTarget(mi)), PB0, rN) ? RES_PATH_EXISTS : RES_FAIL;   // as a read-only folder answers
  const s = save(mTarget(mi));
  if (svBusy(s)) return FS_RETRY;
  if (!rN) return RES_PATH_EXISTS;   // the root
  const parent = svWalk(s, PB0, rN - 1);
  if (parent < 0 || (s.nodes && nType(s, parent) != N_DIR)) return RES_PATH_NOT_FOUND;
  const c = compPtr(PB0, rN - 1), len = <u32>load<u16>(c);
  if (nodeChild(s, parent, c + 2, len) >= 0) return RES_PATH_EXISTS;
  if (!svWritable(s)) return roLog(path);
  if (size < 0) return RES_FAIL;
  return saveCreate(s, parent, type, c + 2, len, <u64>size) == OP_OK ? RES_OK : RES_FAIL;
}
function opDelete(path: u64, what: u32): i64 {
  const r = resolve(path, PB0);
  if (r) return r;
  const mi = rMnt;
  if (mKind(mi) == M_IMAGE) return imWalk(img(mTarget(mi)), PB0, rN) ? roLog(path) : RES_PATH_NOT_FOUND;
  const s = save(mTarget(mi));
  if (svBusy(s)) return FS_RETRY;
  const n = svWalk(s, PB0, rN);
  if (n < 0) return RES_PATH_NOT_FOUND;
  if (!svWritable(s)) return roLog(path);
  const isDir = nType(s, n) == N_DIR;
  if (what == P_DELETE_FILE) {
    if (isDir) return RES_FAIL;            // unlink(2) of a directory
    saveRemove(s, n);
  } else {
    if (!isDir) return RES_PATH_NOT_FOUND; // ENOTDIR
    if (what == P_DELETE_DIR) {
      if (n == 0 || firstChild(s, n) >= 0) return RES_FAIL;   // rmdir(2): not empty
      saveRemove(s, n);
    } else if (what == P_CLEAN || n == 0) saveClean(s, n);
    else saveRemove(s, n);
  }
  return RES_OK;
}
function opRename(from: u64, to: u64): i64 {
  let r = resolve(from, PB0);
  if (r) return r;
  const mi = rMnt, n0 = rN;
  if (mKind(mi) == M_IMAGE) return imWalk(img(mTarget(mi)), PB0, n0) ? roLog(from) : RES_PATH_NOT_FOUND;
  const si = mTarget(mi), s = save(si);
  if (svBusy(s)) return FS_RETRY;
  const n = svWalk(s, PB0, n0);
  if (n < 0) return RES_PATH_NOT_FOUND;
  if (!svWritable(s)) return roLog(from);
  r = resolve(to, PB1);
  if (r) return r;
  if (mKind(rMnt) != M_SAVE || mTarget(rMnt) != si) { lb("fs rename across mounts is not possible"); le(); return RES_FAIL; }
  if (!rN) return RES_PATH_EXISTS;
  const parent = svWalk(s, PB1, rN - 1);
  if (parent < 0 || nType(s, parent) != N_DIR) return RES_PATH_NOT_FOUND;
  const c = compPtr(PB1, rN - 1), len = <u32>load<u16>(c);
  if (nodeChild(s, parent, c + 2, len) >= 0) return RES_PATH_EXISTS;
  if (n == 0 || nodeWithin(s, parent, n)) return RES_FAIL;   // rename(2): EINVAL
  return saveRename(s, n, parent, c + 2, len) == OP_OK ? RES_OK : RES_FAIL;
}
function opEntryType(out: u64, path: u64): i64 {
  const r = resolve(path, PB0);
  if (r) return r;
  const mi = rMnt;
  let type: i32;
  if (mKind(mi) == M_IMAGE) {
    if (!imWalk(img(mTarget(mi)), PB0, rN)) return RES_PATH_NOT_FOUND;
    type = gIsFile ? ENT_FILE : ENT_DIR;
  } else {
    const s = save(mTarget(mi)), n = svWalk(s, PB0, rN);
    if (n < 0) return RES_PATH_NOT_FOUND;
    type = s.nodes && nType(s, n) == N_FILE ? ENT_FILE : ENT_DIR;
  }
  if (!gok(out, 4)) return RES_FAIL;
  store<i32>(<usize>out, type);
  return RES_OK;
}

// ---------- directories ----------
function opOpenDir(out: u64, path: u64, mode: u32): i64 {
  const r = resolve(path, PB0);
  if (r) return r;
  if (!gok(out, 8)) return RES_FAIL;
  const mi = rMnt, target = mTarget(mi);
  if (mKind(mi) == M_IMAGE) {
    const m = img(target);
    if (!imWalk(m, PB0, rN) || gIsFile) return RES_PATH_NOT_FOUND;
    const i = slotNew(MAX_DH, DHS, 48);
    if (i < 0) return RES_FAIL;
    const p = dp(<u32>i);
    Inst.at(p).step(FsDirE.OpenImage);
    store<u8>(p, <u8>mode, 16); store<u16>(p, <u16>target, 20); store<u32>(p, gEnt, 24); store<u32>(p, 0, 28);
    store<u32>(p, dChildDir(m, gEnt), 32); store<u32>(p, 0, 36);
    store<u64>(<usize>out, handleOf(TAG_DIR, p, <u32>i));
    return RES_OK;
  }
  const s = save(target), n = svWalk(s, PB0, rN);
  if (n < 0 || (s.nodes && nType(s, n) != N_DIR)) return RES_PATH_NOT_FOUND;
  // the entries as they are now; one deleted before it is read is skipped, sizes are read when listed
  const count = nodeChildCount(s, n), snap = alloc((count ? <usize>count : 1) * 8);
  if (!snap) { lb("[RED] fs open directory: the arena is full"); le(); return RES_FAIL; }
  let k: u32 = 0;
  for (let c = firstChild(s, n); c >= 0; c = nNext(s, c), k++) { store<u32>(snap + <usize>k * 8, <u32>c); store<u32>(snap + <usize>k * 8, nSerial(s, c), 4); }
  const i = slotNew(MAX_DH, DHS, 48);
  if (i < 0) { free(snap); return RES_FAIL; }
  const p = dp(<u32>i);
  Inst.at(p).step(FsDirE.Open);
  store<u8>(p, <u8>mode, 16); store<u16>(p, <u16>target, 20); store<u32>(p, <u32>snap, 24); store<u32>(p, count, 28); store<u32>(p, 0, 32);
  store<u64>(<usize>out, handleOf(TAG_DIR, p, <u32>i));
  return RES_OK;
}
function entWrite(e: usize, name: usize, len: u32, type: i32, size: u64): void {
  memory.fill(e, 0, DIRENT_SIZE);
  memory.copy(e, name, len > NAME_MAX ? NAME_MAX : len);
  store<i8>(e, <i8>type, 0x304); store<u64>(e, size, 0x308);
}
// Read (ents != 0) or count (ents == 0) up to max entries from the handle's position; -1: the buffer is not guest memory
function dirScan(p: usize, ents: u64, max: i64, advance: bool): i64 {
  const mode = <u32>load<u8>(p, 16), wantD = (mode & DIRMODE_DIR) != 0, wantF = (mode & DIRMODE_FILE) != 0;
  let n: i64 = 0;
  if (load<u8>(p) == FsDirS.OpenImage) {
    const m = img(<u32>load<u16>(p, 20));
    let phase = advance ? load<u32>(p, 36) : 0, pos = advance ? load<u32>(p, 32) : dChildDir(m, load<u32>(p, 24));
    while (n < max && phase < 2) {
      if (pos == EMPTY) { phase++; if (phase == 1) pos = dChildFile(m, load<u32>(p, 24)); continue; }
      const isDir = phase == 0;
      if (isDir ? wantD : wantF) {
        if (ents) {
          const e = ents + <u64>n * DIRENT_SIZE;
          if (!gok(e, DIRENT_SIZE)) return -1;
          if (isDir) entWrite(<usize>e, dName(m, pos), dNameLen(m, pos), ENT_DIR, 0);
          else entWrite(<usize>e, fName(m, pos), fNameLen(m, pos), ENT_FILE, fSize(m, pos));
        }
        n++;
      } else if (isDir && !wantD) { pos = EMPTY; continue; }   // no directories wanted: straight to the files
      pos = isDir ? dSibling(m, pos) : fSibling(m, pos);
    }
    if (advance) { store<u32>(p, pos, 32); store<u32>(p, phase, 36); }
    return n;
  }
  const s = save(<u32>load<u16>(p, 20)), snap = <usize>load<u32>(p, 24), count = load<u32>(p, 28);
  let pos: u32 = advance ? load<u32>(p, 32) : 0;
  while (n < max && pos < count) {
    const c = <i32>load<u32>(snap + <usize>pos * 8);
    if (nLive(s, c, load<u32>(snap + <usize>pos * 8, 4))) {
      const isDir = nType(s, c) == N_DIR;
      if (isDir ? wantD : wantF) {
        if (ents) {
          const e = ents + <u64>n * DIRENT_SIZE;
          if (!gok(e, DIRENT_SIZE)) return -1;
          entWrite(<usize>e, nName(s, c), nNameLen(s, c), isDir ? ENT_DIR : ENT_FILE, isDir ? 0 : nSize(s, c));
        }
        n++;
      }
    }
    pos++;
  }
  if (advance) store<u32>(p, pos, 32);
  return n;
}
function dirSlot(h: u64): usize {
  if (!h) return 0;
  const p = slotOf(h, TAG_DIR, MAX_DH, DHS, 48);
  if (!p) { badHandle("directory", h); return 0; }
  return load<u8>(p) == FsDirS.Stale ? 0 : p;
}
function opReadDir(count: u64, ents: u64, h: u64, max: i64): i64 {
  if (!gok(count, 8)) return RES_FAIL;
  store<i64>(<usize>count, 0);
  const p = dirSlot(h);
  if (!p || !<usize>ents) return RES_FAIL;
  const n = dirScan(p, ents, max, true);
  if (n < 0) return RES_FAIL;
  store<i64>(<usize>count, n);
  return RES_OK;
}
function opDirCount(out: u64, h: u64): i64 {
  const p = dirSlot(h);
  if (!p || !gok(out, 8)) return RES_FAIL;
  store<i64>(<usize>out, dirScan(p, 0, i64.MAX_VALUE, false));
  return RES_OK;
}
function opCloseDir(h: u64): void {
  if (!h) return;   // the game also closes after a failed open
  const p = slotOf(h, TAG_DIR, MAX_DH, DHS, 48);
  if (!p) { badHandle("directory", h); return; }
  if (load<u8>(p) == FsDirS.Open) free(<usize>load<u32>(p, 24));
  Inst.at(p).step(FsDirE.Close);
  slotClose(p);
}

// ---------- the rest ----------
function nameMounted(name: u64): i64 {
  const nl = gstrlen(name, 4096);
  return nl >= 0 && mntFind(<usize>name, <u32>nl) >= 0 ? 1 : 0;
}
function pathMounted(path: u64): i64 {
  const len = gstrlen(path, 4096);
  for (let i = 0; i < len; i++) if (load<u8>(<usize>path + i) == 58) return mntFind(<usize>path, <u32>i) >= 0 ? 1 : 0;
  return 0;
}
function unmount(name: u64): void {
  const nl = gstrlen(name, 4096);
  if (nl < 0) return;
  const i = mntFind(<usize>name, <u32>nl);
  // mounts are permanent; an add-on content mount releases its name
  if (i >= 0 && load<u8>(mp(<u32>i), 49)) {
    mInst(<u32>i).step(FsMountE.Release);
    lb("fs unmount "); lbytes(<usize>name, <u32>nl); ls(": add-on content released"); le();
  }
}
function put64(out: u64, v: u64): i64 { if (!gok(out, 8)) return RES_FAIL; store<u64>(<usize>out, v); return RES_OK; }
function sizes(size: u64, journal: u64): i64 {
  if (<usize>size) { if (!gok(size, 8)) return RES_FAIL; store<u64>(<usize>size, SIZE_256MB); }
  if (<usize>journal) { if (!gok(journal, 8)) return RES_FAIL; store<u64>(<usize>journal, SIZE_256MB); }
  return RES_OK;
}
function utf16Max(limited: u64, out: u64): i64 {
  if (!gok(limited, 1) || !gok(out, 8)) return RES_FAIL;
  store<u8>(<usize>limited, 0); store<u64>(<usize>out, NAME_MAX);
  return RES_OK;
}
const STUBBED: usize = memory.data(128);
function stub(fn: u32, result: u32): i64 {
  if (!load<u8>(STUBBED + fn)) {
    store<u8>(STUBBED + fn, 1);
    lb("[RED] "); ls(unchecked(NAMES[fn - 1])); ls(" unimplemented"); le();
  }
  return result;
}
// Whether fn is answered by a stub (for the embedder's report)
export function isStub(fn: u32): bool { return fn == Fn.MountSysData; }

export function lookup(name: u64): u32 {
  const len = gstrlen(name, 512);
  if (len < 0) return 0;
  const p = <usize>name;
  for (let i: u32 = 0; i < FN_COUNT; i++) {
    const s = unchecked(NAMES[i]);
    if (s.length != len) continue;
    let k = 0;
    while (k < len && <u32>load<u8>(p + k) == <u32>s.charCodeAt(k)) k++;
    if (k == len) {
      if (i + 1 == Fn.MountSave) sawMountSave = true;
      return i + 1;
    }
  }
  return 0;
}

export function call(fn: u32, a: usize): i64 {
  const a0 = load<u64>(a), a1 = load<u64>(a, 8), a2 = load<u64>(a, 16), a3 = load<u64>(a, 24), a4 = load<u64>(a, 32);
  switch (fn) {
    case Fn.QueryRomCache: case Fn.QueryRomCacheIdx: return put64(a0, 0x1000);
    case Fn.MountRomIdx:
      if (<i32>a1) { lb("[RED] fs::MountRom(program index "); li(<i32>a1); ls("): there is one RomFS, this program's"); le(); }
      return opMountImg(a0, KIND_ROM, 0, false);
    case Fn.MountRom: case Fn.MountRom1: return opMountImg(a0, KIND_ROM, 0, false);
    case Fn.QueryAocCache: return opQueryImg(a0, KIND_AOC, <i64><i32>a1);
    case Fn.MountAoc: return opMountImg(a0, KIND_AOC, <i64><i32>a1, true);
    case Fn.QuerySysDataCache: return put64(a0, 0x1000);
    case Fn.MountSysData: return stub(fn, RES_TARGET_NOT_FOUND);
    case Fn.IsMounted: return nameMounted(a0);
    case Fn.IsPathMounted: return pathMounted(a0);
    case Fn.GetPathLengthMax: case Fn.GetEntryNameLengthMax: return put64(a0, NAME_MAX);
    case Fn.GetUtf16PathLengthMax: case Fn.GetUtf16EntryNameLengthMax: return utf16Max(a0, a1);
    case Fn.MountTemp: return opMountSave(a0, KIND_TEMP, 0);
    case Fn.OpenCacheList: return RES_OK;
    case Fn.ReadCacheList: if (!gok(a0, 4)) return RES_FAIL; store<i32>(<usize>a0, 0); return RES_OK;
    case Fn.CloseCacheList: return 0;
    case Fn.CreateCache: return RES_OK;   // the container is created when it is mounted
    case Fn.MountCache: return opMountSave(a0, KIND_CACHE, <i64><i32>a1);
    case Fn.MountCache0: return opMountSave(a0, KIND_CACHE, 0);
    case Fn.DeleteCache: return opDeleteCache(<i32>a0);
    case Fn.SaveSize: case Fn.SaveSizeMax: case Fn.CacheSize: case Fn.DeviceSaveSize: return sizes(a0, a1);
    case Fn.FreeSpace: if (<usize>a0) return put64(a0, SIZE_256MB); return RES_OK;
    case Fn.ExtendSave: case Fn.ExtendDeviceSave: case Fn.EnsureSave: return RES_OK;
    case Fn.SaveExisting: return a0 == programId ? 1 : 0;
    case Fn.MountSaveRO: {
      lb("[RED] fs read-only mount of another program's save data: program "); lx(a1); ls(", there is none"); le();
      return RES_TARGET_NOT_FOUND;
    }
    case Fn.MountSave: return opMountSave(a0, KIND_SAVE, 0);
    case Fn.MountDeviceSave:
      // one save for the console: the account save's backing, or one of its own when the game mounts account save data too
      return opMountSave(a0, (accountSave < 0 ? sawMountSave : accountSave != 0) ? KIND_DEVICE_SAVE : KIND_SAVE, 0);
    case Fn.RestoreFlag: if (!gok(a0, 1)) return RES_FAIL; store<u8>(<usize>a0, 0); return RES_OK;
    case Fn.Commit: case Fn.CommitOpt: case Fn.CommitSaveData: return opCommit(a0);
    case Fn.CommitList: return opCommitList(a0, <i32>a1);
    case Fn.Unmount: unmount(a0); return 0;
    case Fn.OpenFile: return opOpenFile(a0, a1, <u32>a2);
    case Fn.ReadFile: case Fn.ReadFileOpt: return opRead(a0, a1, <i64>a2, a3, a4, false);
    case Fn.ReadFileExact: case Fn.ReadFileExactOpt: return opRead(0, a0, <i64>a1, a2, a3, true);
    case Fn.WriteFile: return opWrite(a0, <i64>a1, a2, a3);
    case Fn.GetFileSize: return opGetSize(a0, a1);
    case Fn.SetFileSize: return opSetSize(a0, <i64>a1);
    case Fn.FlushFile: return RES_OK;     // durability is Commit's business
    case Fn.CloseFile: opCloseFile(a0); return 0;
    case Fn.GetFileOpenMode: return opOpenMode(a0);
    case Fn.CreateFile: return opCreate(a0, <i64>a1, N_FILE);
    case Fn.CreateDirectory: return opCreate(a0, 0, N_DIR);
    case Fn.DeleteFile: return opDelete(a0, P_DELETE_FILE);
    case Fn.DeleteDir: return opDelete(a0, P_DELETE_DIR);
    case Fn.DeleteDirRec: return opDelete(a0, P_DELETE_REC);
    case Fn.CleanDirRec: return opDelete(a0, P_CLEAN);
    case Fn.EnableGlobalCache: case Fn.DisableFileCache: case Fn.DisableGlobalCache: case Fn.SetPrio: return 0;
    case Fn.EnableFileCache: return RES_OK;
    case Fn.RenameFile: case Fn.RenameDir: return opRename(a0, a1);
    case Fn.GetEntryType: return opEntryType(a0, a1);
    case Fn.OpenDirectory: return opOpenDir(a0, a1, <u32>a2);
    case Fn.ReadDirectory: return opReadDir(a0, a1, a2, <i64>a3);
    case Fn.CloseDirectory: opCloseDir(a0); return 0;
    case Fn.DirCount: return opDirCount(a0, a1);
    case Fn.SaveExists: return 1;
    case Fn.AccessLogMask: case Fn.AccessLog: return 0;
    default: {
      lb("[RED] fs_call: no function with id "); lu(fn); le();
      return RES_FAIL;
    }
  }
}

// ---------- what the embedder and the tests read ----------
export function saveState(kind: i32, index: i64): i32 { const i = saveFind(kind, index); return i < 0 ? -1 : <i32>save(<u32>i).state; }
export function saveGen(kind: i32, index: i64): i64 { const i = saveFind(kind, index); return i < 0 ? -1 : <i64>save(<u32>i).gen; }
export function commitCount(): u64 { let n: u64 = 0; for (let i: u32 = 0; i < saveCount(); i++) n += save(i).commits; return n; }
export function imageState(kind: i32, index: i64): i32 {
  for (let i: u32 = 0; i < imgCount(); i++) { const m = img(i); if (m.kind == kind && m.index == index) return <i32>m.state; }
  return -1;
}
