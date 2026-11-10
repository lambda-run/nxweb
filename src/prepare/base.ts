// Shared by the prepare module's files: the log line, the last error, the arena. Nothing here allocates on a heap:
// the module is built with `--runtime stub` and never uses it.

// The embedder's log: UTF-8 bytes in linear memory. Red lines start with "[RED] ".
// @ts-ignore: decorator
@external("env", "log")
declare function log(ptr: usize, len: i32): void;

const LINE: usize = memory.data(768);
const LINE_CAP: i32 = 768;
const ERR: usize = memory.data(768);
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
// Bytes as hex digits, at most 32 of them
export function puthex(ptr: usize, len: u32): void {
  for (let i: u32 = 0; i < len && i < 32; i++) {
    const b = load<u8>(ptr + i), hi = b >> 4, lo = b & 15;
    putc(hi < 10 ? 48 + hi : 87 + hi); putc(lo < 10 ? 48 + lo : 87 + lo);
  }
  if (len > 32) puts("...");
}
// Bytes of a name or path, printable ASCII only (anything else as '?'), at most 160
export function putn(ptr: usize, len: u32): void {
  for (let i: u32 = 0; i < len && i < 160; i++) { const c = load<u8>(ptr + i); putc(c >= 32 && c < 127 ? c : 63); }
  if (len > 160) puts("...");
}
export function red(): void { lineLen = 0; puts("[RED] prepare: "); }
export function info(): void { lineLen = 0; puts("prepare: "); }
// Finish the line: log it; a red one also becomes the last error (prep_error_ptr / prep_error_len)
export function emit(): void {
  if (lineLen >= 5 && load<u8>(LINE) == 91 && load<u8>(LINE, 1) == 82) { memory.copy(ERR, LINE, <usize>lineLen); errLen = lineLen; }
  log(LINE, lineLen);
}
export function errorPtr(): usize { return ERR; }
export function errorLen(): i32 { return errLen; }
export function errorClear(): void { errLen = 0; }
// A red line another file's log made (the loader's NSO reader has its own line buffer) becomes the last error
export function errorSet(ptr: usize, len: i32): void { if (len > LINE_CAP) len = LINE_CAP; memory.copy(ERR, ptr, <usize>len); errLen = len; }

// ---- the arena: everything the embedder hands in and gets back lives here, and goes with one reset ----
let arenaTop: usize = 0;
// @ts-ignore: decorator
@inline function arenaBase(): usize { return (__heap_base + 0xFFFF) & ~<usize>0xFFFF; }
export function arenaReset(): void { arenaTop = arenaBase(); }
export function arenaUsed(): usize { return arenaTop ? arenaTop - arenaBase() : 0; }
// len bytes, 16-byte aligned, zeroed; 0 when the memory cannot grow that far
export function alloc(len: usize): usize {
  if (!arenaTop) arenaTop = arenaBase();
  const p = (arenaTop + 15) & ~<usize>15;
  if (len > <usize>0xFFF00000 - p) return 0;
  const end = p + len, have = <usize>memory.size() << 16;
  if (end > have) {
    const pages = <i32>((end - have + 0xFFFF) >> 16);
    if (memory.grow(pages) < 0) return 0;
  }
  memory.fill(p, 0, len);   // a reset arena is reused: what a caller gets is zero either way
  arenaTop = end;
  return p;
}
// Whether [ptr, ptr + len) lies in linear memory
// @ts-ignore: decorator
@inline export function inMemory(ptr: u64, len: u64): bool { const m = <u64>memory.size() << 16; return ptr <= m && len <= m - ptr; }
