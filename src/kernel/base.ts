// Kernel basics: result codes, the kernel lock, the log line builder and checked access to guest memory.
// Guest addresses are below 4 GB and index the linear memory directly (docs/CONTRACT.md).

// @ts-ignore: decorator
@external("env", "log")
declare function hostLog(ptr: usize, len: i32): void;
// The guest's svcOutputDebugString bytes (not a log line: the embedder decides where they go)
// @ts-ignore: decorator
@external("env", "debug_string")
declare function hostDebugString(ptr: usize, len: i32): void;

// ---- Horizon result codes (kernel module 1), the values nxnative returns ----
export const R_OK: u64 = 0;
export const R_OUT_OF_RES: u64 = 0xCE01;      // 103 ResultOutOfResource
export const R_OUT_OF_MEMORY: u64 = 0xD001;   // 104
export const R_LIMIT: u64 = 0x10801;          // 132 ResultLimitReached
export const R_BAD_SIZE: u64 = 0xCA01;        // 101
export const R_BAD_ADDR: u64 = 0xCC01;        // 102
export const R_BAD_MEMORY: u64 = 0xD401;      // 106 ResultInvalidCurrentMemory
export const R_BAD_REGION: u64 = 0xDC01;      // 110 ResultInvalidMemoryRegion
export const R_BAD_HANDLE: u64 = 0xE401;      // 114
export const R_TIMEOUT: u64 = 0xEA01;         // 117
export const R_CANCELLED: u64 = 0xEC01;       // 118
export const R_OUT_OF_RANGE: u64 = 0xEE01;    // 119
export const R_BAD_STATE: u64 = 0xFA01;       // 125

export const WAITERS_BIT: u32 = 0x40000000;
export const H_CUR_THREAD: u32 = 0xFFFF8000;
export const FOREVER: u64 = u64.MAX_VALUE;

// What kernel_svc tells the embedder to do next
export const ACT_CONTINUE: i32 = 0;   // load the context back and go on in the same thread
export const ACT_SWITCH: i32 = 1;     // the thread is no longer the one to run: unwind, then kernel_schedule()
export const ACT_STOP: i32 = 2;       // the process ended (ExitProcess, a fatal Break): kernel_stop_reason(), kernel_exit_code()

// ---- the kernel lock ----
// Every exported entry point takes it. With green threads on one host thread it only catches re-entry; when guest
// cores become Workers on a shared memory, this pair is the one place that turns into a real lock (an atomic
// compare-exchange loop on `held`). Nothing else in the kernel relies on "nothing runs during an SVC".
let held: u32 = 0;
export function kLock(): void {
  if (held) { lineStart("[RED] kernel: entry point called while the kernel lock is held"); lineEnd(); unreachable(); }
  held = 1;
}
export function kUnlock(): void { held = 0; }

// ---- log lines ----
const LINE: usize = memory.data(512);
const LINE_CAP: i32 = 512;
let lineLen: i32 = 0;
export function putc(c: u8): void { if (lineLen < LINE_CAP) { store<u8>(LINE + <usize>lineLen, c); lineLen++; } }
export function puts(s: string): void { for (let i = 0, n = s.length; i < n; i++) putc(<u8>s.charCodeAt(i)); }
export function putu(v: u64): void { if (v >= 10) putu(v / 10); putc(<u8>(48 + v % 10)); }
export function putx(v: u64): void {
  putc(48); putc(120);
  let started = false;
  for (let sh = 60; sh >= 0; sh -= 4) {
    const d = <u8>((v >> sh) & 15);
    if (d || started || sh == 0) { putc(d < 10 ? 48 + d : 87 + d); started = true; }
  }
}
export function lineStart(s: string): void { lineLen = 0; puts(s); }
export function lineEnd(): void { hostLog(LINE, lineLen); }
export function debugString(ptr: usize, len: i32): void { hostDebugString(ptr, len); }

// ---- guest memory ----
// A guest range the kernel is about to touch must lie inside the linear memory. An address at or above 4 GB, or past
// the memory's current size, would trap the whole instance; the SVC returns ResultInvalidCurrentMemory instead.
// @ts-ignore: decorator
@inline export function guestOk(addr: u64, len: u64): bool {
  const size = <u64>memory.size() << 16;
  return len <= size && addr <= size - len;
}
// @ts-ignore: decorator
@inline export function ld32(addr: u64): u32 { return load<u32>(<usize>addr); }
// @ts-ignore: decorator
@inline export function ld64(addr: u64): u64 { return load<u64>(<usize>addr); }
// @ts-ignore: decorator
@inline export function st32(addr: u64, v: u32): void { store<u32>(<usize>addr, v); }
// Compare and store a lock or arbiter word. Atomic against guest code that runs at the same time on a helper Worker
// (RuntimeOptions.helpers: user-mode lock code is exclusives, which the shared-memory translator makes wasm atomics);
// with everything on one thread it is the compare and the store it always was. A wasm atomic traps on a misaligned
// address, where hardware and the plain form do not: such a word keeps the plain form.
// @ts-ignore: decorator
@inline export function cas32(addr: u64, expect: u32, v: u32): bool {
  if (addr & 3) { if (load<u32>(<usize>addr) != expect) return false; store<u32>(<usize>addr, v); return true; }
  return atomic.cmpxchg<u32>(<usize>addr, expect, v) == expect;
}
// @ts-ignore: decorator
@inline export function st64(addr: u64, v: u64): void { store<u64>(<usize>addr, v); }
