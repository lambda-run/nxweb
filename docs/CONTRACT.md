# nxweb shared contract

nxweb is a browser port of nxnative (reference clone, read-only: /home/user/nxnative). Logic is
AssemblyScript (compiled with `npx asc`); TypeScript is glue for browser/Node APIs only.
Nothing from any game is ever committed. Red log lines start with `[RED] `.

## Layout (each area has one owner; do not edit outside yours)
- `src/kit/`, `test/kit/`, `docs/machines/` : state machine kit
- `src/a64/`, `test/a64/`                   : ARM64 -> WebAssembly translator and its differential tests
- `test/guests/`, `tools/`                  : ARM64 test programs, their build, the Unicorn reference runner
- `src/glue/`                               : TypeScript glue (shared; add files, do not rewrite others')
- Root `package.json`: add your own npm scripts under a prefix (`kit:*`, `a64:*`, `guests:*`); do not
  remove others'. Do not `git commit`; the coordinator commits.

## Guest CPU state (translator <-> everything else)
Translated code runs in one shared linear memory (wasm32). Every guest mapping is placed below 4 GB;
a 64-bit guest address is wrapped to 32 bits to index memory.
The CPU state lives in mutable WebAssembly globals exported by one "core" module and imported by every
translated module: `x0`..`x30`, `sp`, `pc` (i64); `nf`,`zf`,`cf`,`vf` (i32, 0 or 1); `v0`..`v31` (v128);
`fpcr`,`fpsr` (i32); `tpidr`,`tpidrro` (i64); `excl_addr`,`excl_val` (i64); `budget` (i32).
The core module also exports `save_ctx(ptr)` / `load_ctx(ptr)` which copy the whole state to/from memory
in this layout (little endian): x0..x30 at +0 (8 each), sp +0xF8, pc +0x100, nzcv packed (N<<3|Z<<2|C<<1|V)
as u32 +0x108, fpcr +0x10C, fpsr +0x110, tpidr +0x118, tpidrro +0x120, v0..v31 at +0x130 (16 each).

## Control flow protocol
- Every guest function is a wasm function `() -> ()`.
- RET: set `pc` = x30, write back registers, return.
- After any call (BL/BLR/SVC), the caller compares `pc` with the address after the call; on mismatch
  it returns at once (this unwinds for longjmp, fibers, thread switch, preemption).
- Indirect or out-of-unit transfer: set `pc` = target, then call through the function table with the
  index read from the pc map in memory; index 0 is the "translate this pc" trampoline.
- `svc #n`: write back, set `pc` = next, call import `svc(n: i32)`, then the same pc check.
- Special pc values >= 0xFFFF_FF00 return control to the embedder (0xFFFF_FFF0 = thread exit/return to
  host, 0xFFFF_FFE0 = yield).
- Unknown instruction: compile to a call of import `unimpl(pc: i64, insn: i32)`, reported only if executed.

## Test guest ABI (test/guests <-> translator Gate 2)
A test guest is a flat little-endian image loaded at guest address 0x0800_0000, entry at offset 0,
with a sidecar JSON: `{ "base", "entry", "image": "<file>.bin", "bss_end", "stack_top", "expected_stdout": "<file>.out" }`.
Initial state: all registers 0, sp = stack_top, x30 = 0xFFFF_FFF0. Guest I/O is by SVC only:
- `svc #0x27` OutputDebugString: x0 = pointer, x1 = length -> bytes appended to stdout.
- `svc #0x07` ExitProcess: stop; exit code in x0 is NOT standard Horizon, tests use `svc #0x07` with w0 = code.
- `svc #0x1E` GetSystemTick: returns a deterministic counter in x0 (starts 0, +1000 per call).
Returning from the entry function to 0xFFFF_FFF0 also ends the run with exit code w0.
