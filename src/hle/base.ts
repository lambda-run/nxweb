// hle base: the argument block, results, the log line, configuration and the embedder's imports. See README.md.
//
// A take-over is `export function <cname>(a: usize): u64`: `a` is the argument block, the return value goes to x0.
//   +0   x0..x7      integer and pointer arguments (AAPCS64). Switch code does not extend narrow arguments: read a
//                    bool / char / short with B(), an int with I() or W(), never the whole register
//   +64  d0..d7      floating point arguments (the low 64 bits of v0..v7; a float is the low 32)
//   +128 x8          the indirect result register (a function that returns a struct in memory)
//   +136 x30         the return address (the call site, for abort reports)
//   +144 8 x u64     continuation slots: zero on the first entry, kept by the embedder across a wait

// @ts-ignore: decorator
@external("env", "log")
declare function envLog(ptr: usize, len: i32): void;
// The guest clock, ns (kernel_guest_ns): does not advance while frozen
// @ts-ignore: decorator
@external("env", "hle_guest_ns")
export declare function guestNs(): u64;
// The host's monotonic clock, ns
// @ts-ignore: decorator
@external("env", "hle_mono_ns")
export declare function monoNs(): u64;
// The host's real-time clock: ns since 1970-01-01 UTC
// @ts-ignore: decorator
@external("env", "hle_real_ns")
export declare function realNs(): i64;
// The host's time zone at a moment (seconds since 1970 UTC): out = { i32 UTC offset in seconds, i32 daylight saving 0/1, char name[8] }
// @ts-ignore: decorator
@external("env", "hle_tz")
export declare function hostTz(posix: i64, out: usize): void;
// len random bytes at ptr
// @ts-ignore: decorator
@external("env", "hle_entropy")
export declare function hostEntropy(ptr: usize, len: usize): void;
// Kernel events (kernel_event_new / _signal / _clear / _dup_readable)
// @ts-ignore: decorator
@external("env", "hle_event_new")
export declare function eventNew(writeOut: usize): u32;
// @ts-ignore: decorator
@external("env", "hle_event_signal")
export declare function eventSignal(h: u32): i32;
// @ts-ignore: decorator
@external("env", "hle_event_clear")
export declare function eventClear(h: u32): i32;
// @ts-ignore: decorator
@external("env", "hle_event_dup_readable")
export declare function eventDupReadable(h: u32): u32;
// The address of a symbol in the guest's own modules (never a take-over), 0 when no module defines it
// @ts-ignore: decorator
@external("env", "hle_guest_sym")
export declare function envGuestSym(name: usize): u64;
// Run the guest function fn with n arguments (u64 each at args) on the calling thread; its x0
// @ts-ignore: decorator
@external("env", "hle_guest_call")
export declare function envGuestCall(fn: u64, args: usize, n: i32): u64;
// The index of the loaded module that holds addr, -1 when none does
// @ts-ignore: decorator
@external("env", "hle_module_of")
export declare function moduleOf(addr: u64): i32;
// The address guest code calls to reach take-over `id` (a host stub), 0 when the embedder cannot make one
// @ts-ignore: decorator
@external("env", "hle_stub_addr")
export declare function stubAddr(id: i32): u64;
// size bytes of zeroed memory the guest can address, owned by the host for the life of the process; 0 = none
// @ts-ignore: decorator
@external("env", "hle_host_alloc")
export declare function hostAlloc(size: u64): u64;
// kernel_clock_freeze(reason, on)
// @ts-ignore: decorator
@external("env", "hle_clock_freeze")
export declare function clockFreeze(reason: u32, on: i32): void;

// ---------------- arguments ----------------
// @ts-ignore: decorator
@inline export function X(a: usize, i: i32): u64 { return load<u64>(a + (<usize>i << 3)); }
// @ts-ignore: decorator
@inline export function W(a: usize, i: i32): u32 { return load<u32>(a + (<usize>i << 3)); }
// @ts-ignore: decorator
@inline export function I(a: usize, i: i32): i32 { return load<i32>(a + (<usize>i << 3)); }
// @ts-ignore: decorator
@inline export function B(a: usize, i: i32): u32 { return load<u8>(a + (<usize>i << 3)); }
// A guest pointer: guest addresses index the linear memory, wrapped to 32 bits (contract)
// @ts-ignore: decorator
@inline export function P(a: usize, i: i32): usize { return <usize>load<u64>(a + (<usize>i << 3)); }
// @ts-ignore: decorator
@inline export function D(a: usize, i: i32): f64 { return load<f64>(a + 64 + (<usize>i << 3)); }
// @ts-ignore: decorator
@inline export function F(a: usize, i: i32): f32 { return load<f32>(a + 64 + (<usize>i << 3)); }
// @ts-ignore: decorator
@inline export function X8(a: usize): usize { return <usize>load<u64>(a + 128); }
// @ts-ignore: decorator
@inline export function LR(a: usize): u64 { return load<u64>(a + 136); }
// Continuation slot k (0..7)
// @ts-ignore: decorator
@inline export function C(a: usize, k: i32): u64 { return load<u64>(a + 144 + (<usize>k << 3)); }
// @ts-ignore: decorator
@inline export function setC(a: usize, k: i32, v: u64): void { store<u64>(a + 144 + (<usize>k << 3), v); }
export const ARGS_SIZE: usize = 208;

// ---------------- results beside x0 ----------------
export const R_X1: u32 = 1, R_D0: u32 = 2, R_WAIT: u32 = 4, R_NORETURN: u32 = 8;
export let retFlags: u32 = 0;
export let retX1: u64 = 0;
export let retD0: u64 = 0;
export let waitHandle: u32 = 0;
export let waitTimeout: i64 = -1;
// How the wait this call resumes from ended: 0 first entry, 1 signaled, 2 timeout, 3 cancelled
export let resumeHow: i32 = 0;
export function setResume(how: i32): void { resumeHow = how; }
export function retClear(): void { retFlags = 0; retX1 = 0; retD0 = 0; waitHandle = 0; waitTimeout = -1; }
export function setX1(v: u64): void { retX1 = v; retFlags |= R_X1; }
export function retF64(v: f64): u64 { retD0 = reinterpret<u64>(v); retFlags |= R_D0; return 0; }
export function retF32(v: f32): u64 { retD0 = <u64>reinterpret<u32>(v); retFlags |= R_D0; return 0; }
// "Wait on this readable event handle for at most timeoutNs (-1: no limit), then call me again"
export function wait(handle: u32, timeoutNs: i64): u64 { waitHandle = handle; waitTimeout = timeoutNs; retFlags |= R_WAIT; return 0; }
export function noReturn(): u64 { retFlags |= R_NORETURN; return 0; }

// An event nobody signals: a wait on it is a sleep on the guest clock
let sleepR: u32 = 0;
const SCRATCH4: usize = memory.data(8);
export function sleepEvent(): u32 {
  if (!sleepR) sleepR = eventNew(0);
  return sleepR;
}
// A private event pair: the readable end; the writable end at *w
export function newEventPair(w: usize): u32 {
  store<u32>(SCRATCH4, 0);
  const r = eventNew(SCRATCH4);
  store<u32>(w, load<u32>(SCRATCH4));
  return r;
}

// ---------------- the log line ----------------
const LINE_CAP: i32 = 1024;
const LINE: usize = memory.data(1024);
let lineLen: i32 = 0;
export function ls(): void { lineLen = 0; }
export function pc(c: u32): void { if (lineLen < LINE_CAP) { store<u8>(LINE + <usize>lineLen, <u8>c); lineLen++; } }
export function ps(s: string): void { for (let i = 0, n = s.length; i < n; i++) { const c = s.charCodeAt(i); if (c < 0x80) pc(c); else if (c < 0x800) { pc(0xC0 | (c >> 6)); pc(0x80 | (c & 63)); } else { pc(0xE0 | (c >> 12)); pc(0x80 | ((c >> 6) & 63)); pc(0x80 | (c & 63)); } } }
// A C string in memory (at most max bytes)
export function pz(p: usize, max: i32 = 512): void { if (!p) { ps("(null)"); return; } for (let i = 0; i < max; i++) { const c = load<u8>(p + <usize>i); if (!c) break; pc(c); } }
export function pu(v: u64): void { if (v >= 10) pu(v / 10); pc(48 + <u32>(v % 10)); }
export function pi(v: i64): void { if (v < 0) { pc(45); pu(<u64>(-v)); } else pu(<u64>v); }
export function px(v: u64): void { ps("0x"); let sh: i32 = 60; while (sh > 0 && ((v >> sh) & 15) == 0) sh -= 4; for (; sh >= 0; sh -= 4) { const d = <u32>((v >> sh) & 15); pc(d < 10 ? 48 + d : 87 + d); } }
export function le(): void { envLog(LINE, lineLen); }
export function log(s: string): void { ls(); ps(s); le(); }
export function red(s: string): void { ls(); ps("[RED] "); ps(s); le(); }

// ---------------- memory ----------------
export function zero(p: usize, n: usize): void { memory.fill(p, 0, n); }
export function copy(dst: usize, src: usize, n: usize): void { memory.copy(dst, src, n); }
export function zlen(p: usize, max: usize = 0xFFFFFFFF): usize { let n: usize = 0; while (n < max && load<u8>(p + n)) n++; return n; }
// strlcpy: at most cap - 1 bytes and a terminating zero
export function zcopy(dst: usize, src: usize, cap: usize): void {
  if (!cap) return;
  let i: usize = 0;
  for (; i + 1 < cap; i++) { const c = load<u8>(src + i); if (!c) break; store<u8>(dst + i, c); }
  store<u8>(dst + i, 0);
}
// An AssemblyScript string literal (ASCII) as bytes at dst, no terminator; returns its length
export function sput(dst: usize, s: string): usize { const n = <usize>s.length; for (let i: usize = 0; i < n; i++) store<u8>(dst + i, <u8>s.charCodeAt(<i32>i)); return n; }
// Whether the C string at p equals s
export function zeq(p: usize, s: string): bool { const n = s.length; for (let i = 0; i < n; i++) if (load<u8>(p + <usize>i) != <u8>s.charCodeAt(i)) return false; return load<u8>(p + <usize>n) == 0; }
// Whether the C string at p starts with s
export function zstarts(p: usize, s: string): bool { const n = s.length; for (let i = 0; i < n; i++) if (load<u8>(p + <usize>i) != <u8>s.charCodeAt(i)) return false; return true; }

// ---------------- configuration (what nxnative reads from its environment and the game profile) ----------------
export const CFG_OPMODE = 0;            // DM_OPMODE / profile op_mode: 0 handheld, 1 console (default 1)
export const CFG_PERF_BOOST = 1;        // profile perf_mode boost
export const CFG_FIXED_TIME = 2;        // DM_FIXED_TIME: seconds, -1 = off
export const CFG_PREV_PROGRAM = 3;      // DM_PREV_PROGRAM (default -1)
export const CFG_SDK_MAJOR = 4;         // the sdk module's major version, 0 = unknown
export const CFG_FONT_DECODE = 5;       // 1: main imports ScalableFontEngineHelper::Decode
export const CFG_SHARED_FONT_TTF = 6;   // profile shared_font: -1 unset, 1 the TTF itself, 0 header + TTF
export const CFG_ALLOC_BIG_ALIGN = 7;   // profile alloc_big_align
export const CFG_DET_ENTROPY = 8;       // DM_DETCLOCK: the fixed-seed entropy stream
export const CFG_SF_TRACE = 9;          // DM_SF_TRACE
export const CFG_PROGRAM_INDEX = 10;    // this program's index in a multi-program application
export const CFG_HAS_PROGRAMS = 11;     // the embedder can start another program (ExecuteProgram)
export const CFG_N = 16;
const CFGV: usize = memory.data(128);
export function cfg(k: i32): i64 { return load<i64>(CFGV + (<usize>k << 3)); }
export function cfgSet(k: i32, v: i64): void { if (k >= 0 && k < CFG_N) store<i64>(CFGV + (<usize>k << 3), v); }

export const STR_LANG = 0;              // DM_LANG (default en-US)
export const STR_NICK = 1;              // DM_NICK (default Player)
export const STR_GAME_ENV = 2;          // DM_GAME_ENV / profile game_env: KEY=VALUE separated by spaces
export const STR_LAUNCH_SPEC = 3;       // profile launch_param: lang8 f32:<v> u32:<v> hex:<bytes>
export const STR_LAUNCH_BYTES = 4;      // DM_LAUNCH_PARAM's file contents (set = "the variable is set", even when empty)
export const STR_DISPLAY_VERSION = 5;   // the display version of main's build (default 1.0.0)
export const STR_KBD = 6;               // DM_KBD: the software keyboard's answer without asking
export const STR_N = 8;
const STR_CAP: usize = 1024;
const STRV: usize = memory.data(8192);     // STR_N * STR_CAP
const STRLEN: usize = memory.data(32);     // i32 each; -1 = not set
export function strPtr(k: i32): usize { return STRV + <usize>k * STR_CAP; }
export function strLen(k: i32): i32 { return load<i32>(STRLEN + (<usize>k << 2)); }
export function strSet(k: i32, p: usize, n: i32): void {
  if (k < 0 || k >= STR_N) return;
  if (n < 0) { store<i32>(STRLEN + (<usize>k << 2), -1); store<u8>(strPtr(k), 0); return; }
  if (n > <i32>STR_CAP - 1) n = <i32>STR_CAP - 1;
  copy(strPtr(k), p, <usize>n); store<u8>(strPtr(k) + <usize>n, 0);
  store<i32>(STRLEN + (<usize>k << 2), n);
}
export function baseInit(): void {
  for (let k = 0; k < CFG_N; k++) cfgSet(k, 0);
  cfgSet(CFG_OPMODE, 1); cfgSet(CFG_FIXED_TIME, -1); cfgSet(CFG_PREV_PROGRAM, -1); cfgSet(CFG_SHARED_FONT_TTF, -1);
  for (let k = 0; k < STR_N; k++) strSet(k, 0, -1);
  sleepR = 0;
}

// ---------------- guest code ----------------
const NAMEBUF: usize = memory.data(256);
export function guestSym(name: string): u64 { const n = sput(NAMEBUF, name); store<u8>(NAMEBUF + n, 0); return envGuestSym(NAMEBUF); }
const CALLARGS: usize = memory.data(64);
export function guestCall0(fn: u64): u64 { return envGuestCall(fn, CALLARGS, 0); }
export function guestCall1(fn: u64, a0: u64): u64 { const p = CALLARGS; store<u64>(p, a0); return envGuestCall(fn, p, 1); }
export function guestCall2(fn: u64, a0: u64, a1: u64): u64 { const p = CALLARGS; store<u64>(p, a0); store<u64>(p, a1, 8); return envGuestCall(fn, p, 2); }
export function guestCall3(fn: u64, a0: u64, a1: u64, a2: u64): u64 { const p = CALLARGS; store<u64>(p, a0); store<u64>(p, a1, 8); store<u64>(p, a2, 16); return envGuestCall(fn, p, 3); }
export function guestCall5(fn: u64, a0: u64, a1: u64, a2: u64, a3: u64, a4: u64): u64 {
  const p = CALLARGS; store<u64>(p, a0); store<u64>(p, a1, 8); store<u64>(p, a2, 16); store<u64>(p, a3, 24); store<u64>(p, a4, 32); return envGuestCall(fn, p, 5);
}

export const RES_OK: u64 = 0;
export const RES_FAIL: u64 = 0x2A2;   // generic failure: what every cut feature returns
