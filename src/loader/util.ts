// Shared by the loader's files: the log, the "last error" text, sizes and the name hash. Nothing here allocates.

// The embedder's log: UTF-8 bytes in linear memory. Red lines start with "[RED] ".
// @ts-ignore: decorator
@external("env", "log")
declare function log(ptr: usize, len: i32): void;

export const PAGE: u64 = 0x1000;

// The line being built. The last finished line that was an error stays readable at errorPtr()/errorLen().
const LINE: usize = memory.data(512);
const LINE_CAP: i32 = 512;
const ERR: usize = memory.data(512);
let lineLen: i32 = 0;
let errLen: i32 = 0;

export function putc(c: u8): void { if (lineLen < LINE_CAP) { store<u8>(LINE + <usize>lineLen, c); lineLen++; } }
export function puts(s: string): void { for (let i = 0, n = s.length; i < n; i++) putc(<u8>s.charCodeAt(i)); }
export function putu(v: u64): void { if (v >= 10) putu(v / 10); putc(<u8>(48 + v % 10)); }
export function putx(v: u64): void {
  puts("0x");
  let started = false;
  for (let sh: i32 = 60; sh >= 0; sh -= 4) {
    const d = <u8>((v >> sh) & 15);
    if (d || started || !sh) { putc(d < 10 ? 48 + d : 87 + d); started = true; }
  }
}
// Bytes of a name, printable ASCII only (anything else as '?'), at most 96
export function putn(ptr: usize, len: u32): void {
  for (let i: u32 = 0; i < len && i < 96; i++) { const c = load<u8>(ptr + i); putc(c >= 32 && c < 127 ? c : 63); }
  if (len > 96) puts("...");
}
// The module the lines are about (its name's bytes), or none: every line starts with it
let ctxPtr: usize = 0, ctxLen: u32 = 0;
export function context(ptr: usize, len: u32): void { ctxPtr = ptr; ctxLen = len; }
function putContext(): void { if (ctxLen) { putn(ctxPtr, ctxLen); puts(": "); } }
// Start a red line: "[RED] loader: <module>: "
export function red(): void { lineLen = 0; puts("[RED] loader: "); putContext(); }
// Start an ordinary line: "loader: <module>: "
export function info(): void { lineLen = 0; puts("loader: "); putContext(); }
// Finish the line: log it; a red one also becomes the last error
export function emit(): void {
  if (lineLen >= 5 && load<u8>(LINE) == 91 && load<u8>(LINE, 1) == 82) { memory.copy(ERR, LINE, <usize>lineLen); errLen = lineLen; }
  log(LINE, lineLen);
}
export function errorPtr(): usize { return ERR; }
export function errorLen(): i32 { return errLen; }
export function errorClear(): void { errLen = 0; }

// Linear memory's size in bytes
// @ts-ignore: decorator
@inline export function memBytes(): u64 { return <u64>memory.size() << 16; }
// Whether [ptr, ptr + len) lies in linear memory
// @ts-ignore: decorator
@inline export function inMemory(ptr: u64, len: u64): bool { const m = memBytes(); return ptr <= m && len <= m - ptr; }
// Whether [a, a + an) and [b, b + bn) share a byte
// @ts-ignore: decorator
@inline export function overlaps(a: u64, an: u64, b: u64, bn: u64): bool { return an != 0 && bn != 0 && a < b + bn && b < a + an; }

// FNV-1a, the name hash of every table here (as nxnative's sym_hash)
export function fnv(ptr: usize, len: u32): u32 {
  let h: u32 = 2166136261;
  for (let i: u32 = 0; i < len; i++) h = (h ^ <u32>load<u8>(ptr + i)) * 16777619;
  return h;
}
export function bytesEqual(a: usize, b: usize, len: u32): bool { return memory.compare(a, b, len) == 0; }
