// Shared by every file of the fs module: result codes, the storage imports, the log line, guest memory checks,
// and the arena allocator. See README.md.

// ---- nn::fs results, the values nxnative returns (dm/host/hle.h, hle_fs.c) ----
export const RES_OK: u32 = 0;
export const RES_FAIL: u32 = 0x2A2;               // nxnative's generic failure
export const RES_PATH_NOT_FOUND: u32 = 0x202;     // fs 2-1
export const RES_PATH_EXISTS: u32 = 0x402;        // fs 2-2
export const RES_TARGET_NOT_FOUND: u32 = 0x7D402; // fs 2-1002
// Internal only (never reaches the guest): the backing is busy with a parked call, the caller must be retried
export const RES_RETRY: u32 = 0xFFFFFFFE;

// What fs_call returns besides a result: FS_PENDING | token, or FS_RETRY
export const FS_PENDING: i64 = <i64>0xFFFFFFFF00000000;
export const FS_RETRY: i64 = <i64>0xFFFFFFFE00000000;
// Inside the module: "this step waits for storage"
export const R_WAIT: i64 = <i64>0xFFFFFFFD00000000;

export const MODE_READ: u32 = 1, MODE_WRITE: u32 = 2, MODE_APPEND: u32 = 4;
export const ENT_DIR: i32 = 0, ENT_FILE: i32 = 1;
export const DIRMODE_DIR: u32 = 1, DIRMODE_FILE: u32 = 2;
export const NAME_MAX: u32 = 0x300;
export const DIRENT_SIZE: usize = 0x310;
export const SIZE_256MB: u64 = 256 << 20;

// ---- storage devices (implemented by the glue: src/glue/fs_host.ts) ----
export const DEV_OK: i32 = 0, DEV_PENDING: i32 = 1, DEV_NOT_FOUND: i32 = -1, DEV_IO: i32 = -2, DEV_NO_SPACE: i32 = -3;
export const KIND_ROM: i32 = 0, KIND_AOC: i32 = 1, KIND_SYSDATA: i32 = 2, KIND_SAVE: i32 = 3, KIND_DEVICE_SAVE: i32 = 4,
  KIND_CACHE: i32 = 5, KIND_TEMP: i32 = 6;
export const EIO: i32 = 5, ENOSPC: i32 = 28;

// Open the device of (kind, index). >= 0x100: the device id. DEV_PENDING: fs_complete(token, id or error) follows.
// DEV_NOT_FOUND for an image that does not exist; a save kind is created when it does not exist.
// @ts-ignore: decorator
@external("fs", "dev_open") export declare function dev_open(kind: i32, index: i64, token: i32): i32;
// Size in bytes, or a negative error. Never pends.
// @ts-ignore: decorator
@external("fs", "dev_size") export declare function dev_size(dev: i32): i64;
// Read exactly len bytes at off into memory at ptr. DEV_OK, a negative error, or DEV_PENDING (image devices only,
// and only when token != 0): fs_complete(token, DEV_OK or error) follows.
// @ts-ignore: decorator
@external("fs", "dev_read") export declare function dev_read(dev: i32, off: i64, ptr: usize, len: u32, token: i32): i32;
// Write len bytes at off (extends the device). Never pends.
// @ts-ignore: decorator
@external("fs", "dev_write") export declare function dev_write(dev: i32, off: i64, ptr: usize, len: u32): i32;
// Barrier: everything written so far is durable when this completes. May pend.
// @ts-ignore: decorator
@external("fs", "dev_flush") export declare function dev_flush(dev: i32, token: i32): i32;
// Delete the stored device of (kind, index) (DeleteCacheStorage). May pend.
// @ts-ignore: decorator
@external("fs", "dev_remove") export declare function dev_remove(kind: i32, index: i64, token: i32): i32;
// nxnative's front_save_failed(errno): a save could not be written; the front end tells the player
// @ts-ignore: decorator
@external("fs", "save_failed") export declare function save_failed(err: i32): void;
// @ts-ignore: decorator
@external("env", "log") declare function envLog(ptr: usize, len: i32): void;

export function devErrno(st: i32): i32 { return st == DEV_NO_SPACE ? ENOSPC : EIO; }

// ---- the log line ----
const LINE: usize = memory.data(512);
const LINE_CAP: i32 = 512;
let lineLen: i32 = 0;
export function lc(c: u8): void { if (lineLen < LINE_CAP) { store<u8>(LINE + <usize>lineLen, c); lineLen++; } }
export function lb(s: string): void { lineLen = 0; ls(s); }
export function ls(s: string): void { for (let i = 0, n = s.length; i < n; i++) lc(<u8>s.charCodeAt(i)); }
export function lu(v: u64): void { if (v >= 10) lu(v / 10); lc(<u8>(48 + v % 10)); }
export function li(v: i64): void { if (v < 0) { lc(45); lu(<u64>-v); } else lu(<u64>v); }
export function lx(v: u64): void {
  ls("0x");
  let sh: i32 = 60;
  while (sh > 0 && ((v >> sh) & 15) == 0) sh -= 4;
  for (; sh >= 0; sh -= 4) { const d = <u8>((v >> sh) & 15); lc(d < 10 ? 48 + d : 87 + d); }
}
// Bytes of a name or path: printable ASCII as it is, anything else as \xNN; at most 160 bytes
export function lbytes(p: usize, n: u32): void {
  for (let i: u32 = 0; i < n && i < 160; i++) {
    const c = load<u8>(p + i);
    if (c >= 32 && c < 127) lc(c);
    else { lc(92); lc(120); const h = c >> 4, l = c & 15; lc(h < 10 ? 48 + h : 87 + h); lc(l < 10 ? 48 + l : 87 + l); }
  }
  if (n > 160) ls("...");
}
export function le(): void { envLog(LINE, lineLen); }

// ---- guest memory: pointers index linear memory directly (64-bit guest addresses are wrapped) ----
// @ts-ignore: decorator
@inline export function memEnd(): u64 { return <u64>memory.size() << 16; }
// Whether [p, p + n) is non-null and inside linear memory
export function gok(p: u64, n: u64): bool {
  const a = <u64><u32>p;
  return a != 0 && n <= memEnd() && a <= memEnd() - n;
}
// Length of the NUL-terminated guest string at p, or -1 (null, or no NUL within max bytes / before the memory ends)
export function gstrlen(p: u64, max: u32): i32 {
  const a = <usize>p;
  if (!a) return -1;
  const end = memEnd();
  for (let i: u32 = 0; i < max; i++) {
    if (<u64>a + i >= end) return -1;
    if (!load<u8>(a + i)) return <i32>i;
  }
  return -1;
}

export function fnv64(p: usize, n: usize, h: u64 = 0xcbf29ce484222325): u64 {
  for (let i: usize = 0; i < n; i++) h = (h ^ load<u8>(p + i)) * 0x100000001b3;
  return h;
}
export function bytesEq(a: usize, b: usize, n: usize): bool { return memory.compare(a, b, n) == 0; }

// ---- the arena: every dynamic structure of the module (image tables, save trees, directory snapshots) ----
// First fit over an address-ordered free list. A block is [u32 size | u32 next-free | 8 bytes pad] + payload,
// sizes are multiples of 16 and include the 16-byte header.
let aBase: usize = 0, aEnd: usize = 0, aHead: usize = 0, aUsed: usize = 0;
export function arenaInit(base: usize, size: usize): void {
  aBase = (base + 15) & ~15; aEnd = (base + size) & ~15;
  aUsed = 0; aHead = 0;
  if (aEnd >= aBase + 64) { aHead = aBase; store<u32>(aHead, <u32>(aEnd - aBase)); store<u32>(aHead, 0, 4); }
}
export function arenaUsed(): usize { return aUsed; }
export function arenaSize(): usize { return aEnd - aBase; }
// 0 when the arena has no block of n bytes
export function alloc(n: usize): usize {
  if (n > 0xFFFFFF00) return 0;
  const need: usize = ((n + 15) & ~15) + 16;
  let prev: usize = 0, cur = aHead;
  while (cur) {
    const size = <usize>load<u32>(cur), next = <usize>load<u32>(cur, 4);
    if (size >= need) {
      let rest = next;
      if (size - need >= 32) { rest = cur + need; store<u32>(rest, <u32>(size - need)); store<u32>(rest, <u32>next, 4); store<u32>(cur, <u32>need); }
      if (prev) store<u32>(prev, <u32>rest, 4); else aHead = rest;
      aUsed += <usize>load<u32>(cur);
      return cur + 16;
    }
    prev = cur; cur = next;
  }
  return 0;
}
export function free(p: usize): void {
  if (!p) return;
  const b = p - 16;
  let size = <usize>load<u32>(b);
  aUsed -= size;
  let prev: usize = 0, cur = aHead;
  while (cur && cur < b) { prev = cur; cur = <usize>load<u32>(cur, 4); }
  if (cur && b + size == cur) { size += <usize>load<u32>(cur); cur = <usize>load<u32>(cur, 4); }
  store<u32>(b, <u32>size); store<u32>(b, <u32>cur, 4);
  if (prev) {
    const ps = <usize>load<u32>(prev);
    if (prev + ps == b) { store<u32>(prev, <u32>(ps + size)); store<u32>(prev, <u32>cur, 4); }
    else store<u32>(prev, <u32>b, 4);
  } else aHead = b;
}
export function allocZ(n: usize): usize { const p = alloc(n); if (p) memory.fill(p, 0, n); return p; }
