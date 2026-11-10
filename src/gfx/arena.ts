// The module's large tables live in a region of linear memory the embedder gives at gfx_init (the kernel knows the
// address space; a wasm data segment of zeros would also make the binary 14 MB). Bump-allocated once, never freed.
import * as L from "./log";
export const ARENA_BYTES: u32 = 24 << 20;
let top: usize = 0, end: usize = 0;
export function arenaInit(p: usize, n: u32): bool {
  if (n < ARENA_BYTES) { L.red("gfx_init: the arena is "); L.u(n); L.str(" bytes, the module needs "); L.u(ARENA_BYTES); L.end(); return false; }
  top = (p + 15) & ~<usize>15; end = p + n;
  memory.fill(p, 0, n);
  return true;
}
export function arenaAlloc(n: usize): usize {
  const p = top; top += (n + 15) & ~<usize>15;
  if (top > end) { L.redLine("gfx arena exhausted"); unreachable(); }
  return p;
}
