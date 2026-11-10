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
export const ACT_ACK: i32 = 3;      // SPIKE, Workers only: go on in the same thread once the word kernel_mt_ack_word(ctx) names is 0 (a pause it asked for took effect)
export const ACT_STOP: i32 = 2;       // the process ended (ExitProcess, a fatal Break): kernel_stop_reason(), kernel_exit_code()

// ---- the kernel lock ----
// Every exported entry point takes it. With green threads on one host thread it only catches re-entry; when guest
// cores become Workers on a shared memory, this pair is the one place that turns into a real lock (an atomic
// compare-exchange loop on `held`). Nothing else in the kernel relies on "nothing runs during an SVC".
// SPIKE (src/spike_workers, SPIKE.md): in a build with the threads feature (`asc --sharedMemory --enable threads`) the
// lock is real once kernel_mt_config(workers > 0) was called: 0 free, 1 held, 2 held with waiters; a short spin, then
// memory.atomic.wait. Without the feature, or with workers = 0 (green threads), it is the re-entry check it always was.
const LOCKW: usize = memory.data(4);
const MTW: usize = memory.data(4);     // number of Workers that run guest cores; 0 = green threads on one host thread
const SPINW: usize = memory.data(4);   // compare-exchange attempts before a contended kLock sleeps
const KICK: usize = memory.data(16);   // per Worker: a generation counter, bumped and notified when one of its cores must reschedule
// @ts-ignore: decorator
@inline export function mtWorkers(): i32 { return ASC_FEATURE_THREADS ? load<i32>(MTW) : 0; }
export function mtSetWorkers(n: i32, spin: i32): void { store<i32>(MTW, n); store<i32>(SPINW, spin > 0 ? spin : 100); }
export function kickWord(worker: i32): usize { return KICK + (<usize>(worker & 3) << 2); }
// Core c's Worker has something to look at (its ready set changed, a pause was asked for, the process stopped)
export function kick(c: i32): void {
  if (ASC_FEATURE_THREADS) {
    const w = load<i32>(MTW);
    if (w) { const p = KICK + (<usize>(c % w) << 2); atomic.add<u32>(p, 1); atomic.notify(p, 1); }
  }
}
export function kLock(): void {
  if (ASC_FEATURE_THREADS) {
    if (load<i32>(MTW)) {
      for (let i = 0, n = load<i32>(SPINW); i < n; i++) if (atomic.cmpxchg<u32>(LOCKW, 0, 1) == 0) return;
      while (atomic.xchg<u32>(LOCKW, 2) != 0) atomic.wait<i32>(LOCKW, 2, -1);
      return;
    }
  }
  if (load<u32>(LOCKW)) { lineStart("[RED] kernel: entry point called while the kernel lock is held"); lineEnd(); unreachable(); }
  store<u32>(LOCKW, 1);
}
export function kUnlock(): void {
  if (ASC_FEATURE_THREADS) {
    if (load<i32>(MTW)) { if (atomic.xchg<u32>(LOCKW, 0) == 2) atomic.notify(LOCKW, 1); return; }
  }
  store<u32>(LOCKW, 0);
}

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
// @ts-ignore: decorator
@inline export function st64(addr: u64, v: u64): void { store<u64>(<usize>addr, v); }
