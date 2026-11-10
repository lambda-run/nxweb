// Log lines of the graphics module: built in a static buffer, handed to the embedder's `env.log(ptr, len)` (UTF-8).
// Red lines start with "[RED] ". Nothing here allocates.
// @ts-ignore: decorator
@external("env", "log")
declare function hostLog(ptr: usize, len: i32): void;

const LINE: usize = memory.data(512);
const CAP: i32 = 512;
let n: i32 = 0;

export function begin(s: string): void { n = 0; str(s); }
export function red(s: string): void { n = 0; str("[RED] "); str(s); }
export function ch(c: i32): void { if (n < CAP) { store<u8>(LINE + <usize>n, <u8>c); n++; } }
export function str(s: string): void { for (let i = 0, l = s.length; i < l; i++) ch(s.charCodeAt(i)); }
export function u(v: u64): void { if (v >= 10) u(v / 10); ch(48 + <i32>(v % 10)); }
export function i(v: i64): void { if (v < 0) { ch(45); u(<u64>-v); } else u(<u64>v); }
export function hex(v: u64, digits: i32 = 0): void {
  let d = digits;
  if (!d) { d = 1; let t = v >> 4; while (t) { d++; t >>= 4; } }
  for (let k = d - 1; k >= 0; k--) { const x = <i32>((v >> (<u64>k * 4)) & 15); ch(x < 10 ? 48 + x : 87 + x); }
}
// A NUL-terminated string in memory
export function cstr(p: usize, max: i32 = 96): void { for (let k = 0; k < max; k++) { const c = load<u8>(p + <usize>k); if (!c) break; ch(c); } }
export function end(): void { hostLog(LINE, n); }

// One red line, a fixed text: the common case
export function redLine(s: string): void { red(s); end(); }
