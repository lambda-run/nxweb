// The module's large tables live in a region of linear memory the embedder gives at gfx_init (the kernel knows the
// address space; a wasm data segment of zeros would also make the binary 14 MB). Bump-allocated once, never freed.
import * as L from "./log";
export const ARENA_BYTES: u32 = 32 << 20;
let top: usize = 0, end: usize = 0;
export function arenaInit(p: usize, n: u32): bool {
  if (n < ARENA_BYTES) { L.red("gfx_init: the arena is "); L.u(n); L.str(" bytes, the module needs "); L.u(ARENA_BYTES); L.end(); return false; }
  top = (p + 15) & ~<usize>15; end = p + n;
  memory.fill(p, 0, n);
  return true;
}
// Tables that outgrew the arena's range (the shader library, the live buffers): zeroed memory the embedder allocates for the process's life
// @ts-ignore: decorator
@external("env", "gfx_arena_more")
declare function arenaMore(n: u32): f64;
export function arenaBig(n: usize): usize {
  const p = <usize>arenaMore(<u32>n);
  if (!p) { L.redLine("gfx: no host memory for a table"); unreachable(); }
  return p;
}
export function arenaAlloc(n: usize): usize {
  const p = top; top += (n + 15) & ~<usize>15;
  if (top > end) { L.redLine("gfx arena exhausted"); unreachable(); }
  return p;
}
