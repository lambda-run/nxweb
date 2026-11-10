# nxweb shared contract

nxweb is a browser port of nxnative (reference clone, read-only: /home/user/nxnative). Logic is
AssemblyScript (compiled with `npx asc`); TypeScript is glue for browser/Node APIs only.
Nothing from any game is ever committed. Red log lines start with `[RED] `.

## Layout (each area has one owner; do not edit outside yours)
- `src/kit/`, `test/kit/`, `docs/machines/` : state machine kit
- `src/a64/`, `test/a64/`                   : ARM64 -> WebAssembly translator and its differential tests
- `test/guests/`, `tools/`                  : ARM64 test programs, their build, the Unicorn reference runner
- `src/loader/`, `test/loader/`, `tools/elf2nso.py` : NSO/NRO loader
- `src/kernel/`, `test/kernel/`              : Horizon kernel core (threads, sync, memory SVCs)
- `src/gfx/`, `test/gfx/`                    : NVN on WebGPU (recorder in AssemblyScript, replayer in glue)
- `src/glue/`                               : TypeScript glue (shared; add files, do not rewrite others')
- Root `package.json`: add your own npm scripts under a prefix (`kit:*`, `a64:*`, `guests:*`); do not
  remove others'. Do not `git commit`; the coordinator commits.

## Guest CPU state (translator <-> everything else)
Translated code runs in one shared linear memory. There are two modes, built from the same sources
(`src/runtime/README.md`, "memory64"):
- **memory32** (the default): a 32-bit memory. Every guest mapping is placed below 4 GB; a 64-bit guest address is
  wrapped to 32 bits to index memory.
- **memory64** (`RuntimeOptions.mem64`, the wasm64 builds `*64.wasm`): a 64-bit memory of at most 16 GB. A guest
  mapping may be anywhere in it; a guest address is used whole (an address beyond the memory traps, or is refused
  where a module checks it). The host area, 0 .. 0x0800_0000, and every module's static data are the same as in
  memory32 and below 4 GB.
The CPU state lives in mutable WebAssembly globals exported by one "core" module and imported by every
translated module: `x0`..`x30`, `sp`, `pc` (i64); `nf`,`zf`,`cf`,`vf` (i32, 0 or 1); `v0`..`v31` (v128);
`fpcr`,`fpsr` (i32); `tpidr`,`tpidrro` (i64); `excl_addr`,`excl_val` (i64); `budget` (i32).
The core module also exports `save_ctx(ptr)` / `load_ctx(ptr)` which copy the whole state to/from memory
in this layout (little endian): x0..x30 at +0 (8 each), sp +0xF8, pc +0x100, nzcv packed (N<<3|Z<<2|C<<1|V)
as u32 +0x108, fpcr +0x10C, fpsr +0x110, tpidr +0x118, tpidrro +0x120, v0..v31 at +0x130 (16 each).

## Addresses (every module and all glue)
One convention, so that the two memory modes are one source:
- **AssemblyScript.** A guest address, and a size of memory, is `usize` (i32 in the wasm32 build, i64 in the wasm64
  one) or `u64` where the Switch ABI says 64 bits whatever the mode (a guest register, a pointer field of a guest
  structure: always 8 bytes, read with `load<u64>`). It is never cast to `u32` / `i32`, never stored with
  `store<u32>`, never kept in a `u32` field or a 4-byte record slot. A guest register becomes an index by `<usize>x`
  (which wraps in the wasm32 build, as memory32's contract says, and keeps the value in the wasm64 build), not by
  `& 0xFFFFFFFF`. What may stay 32 bits: a count, an id, a handle, a file or image offset the format bounds below
  4 GB, and a pointer into the **host area** (a module's own static data, its arena when that is a range of the
  layout table): those lie below 0x0800_0000 in both modes. An arena the runtime allocates with `hostAlloc` (the
  audio arena, work buffers) is guest-addressable memory anywhere: `usize`. A record with `usize` fields is larger
  in the wasm64 build: a table of such records has the stride of the larger one.
- **Glue (TypeScript).** An address is a JavaScript number, never negative, exact to 2^53. It is converted to and
  from BigInt in exactly one place, `src/glue/wasm_abi.ts` `instantiate()`, which every module is instantiated
  through: each binary carries the table of its address-typed parameters and results (custom section `nx.abi`,
  written by `tools/asc64/abi.mjs` from the difference of the module's two builds), so `x.fn(addr)` takes and
  returns numbers in both modes. A `u64` of a module (a register, a time) is a BigInt on the glue's side in both.
  No 32-bit operator touches an address: not `>>> 0`, `| 0`, `& 0xFFFFFFFF`, `& ~0xFFF`, `>> 2`, not a
  `Uint32Array` of addresses or `DataView.getUint32` for a pointer. Align with arithmetic
  (`Math.ceil(a / 0x1000) * 0x1000`); a guest register becomes an address by `Runtime.addr(x)`.
- **Kept true by** `npm run audit64` (`tools/audit64.mjs`, part of `npm test`): every site of those operators and
  casts in `src/` is either on its reviewed list with the reason, or the run fails; and by running every test
  again in memory64 with the whole process above 4 GB (`NX_MEM=64hi`, `tools/modes.mjs`), where a truncated address
  lands on untouched pages 4 GB lower.

## Control flow protocol
- Every guest function is a wasm function `() -> ()`.
- RET: set `pc` = x30, write back registers, return.
- After any call (BL/BLR/SVC), the caller compares `pc` with the address after the call; on mismatch
  it returns at once (this unwinds for longjmp, fibers, thread switch, preemption).
- Indirect or out-of-unit transfer: set `pc` = target, then call through the function table with the
  index read from the pc map in memory; index 0 is the "translate this pc" trampoline.
- `svc #n`: write back, set `pc` = next, call import `svc(n: i32)`, then the same pc check.
- Special pc values >= 0xFFFF_FF00 return control to the embedder (0xFFFF_FFF0 = thread exit/return to
  host, 0xFFFF_FFE0 = yield). In memory64 they are the window 0xFFFF_FF00 .. 0xFFFF_FFFF, the same values.
- Unknown instruction: compile to a call of import `unimpl(pc: i64, insn: i32)`, reported only if executed.

## Pointer authentication (ARMv8.3; code built for the Switch 2)
Pointer authentication is the identity, which is what a system with the authentication keys disabled does.
- Signing (PACIA/PACIB/PACDA/PACDB, their Z forms, the hint forms PACIASP, PACIBSP, PACIA1716, ...) leaves the
  pointer as it is. Authenticating (AUT*) leaves it as it is and never faults. XPACI/XPACD/XPACLRI have nothing to strip.
- Sign and authenticate are both the identity, so they agree everywhere: a pointer signed in one place (guest code,
  a saved context, a jmp_buf, a return address the kernel or a take-over writes) authenticates in every other. Every
  pointer the embedder reads or writes, in a register, in a context block or in guest memory, is the plain address:
  x30 after BL/BLR/BLRAA is the return address itself, a thread starts with x30 = 0xFFFF_FFF0, no key or modifier
  exists anywhere.
- RETAA/RETAB are RET, BRAA/BRAB/BRAAZ/BRABZ are BR, BLRAA/BLRAB/BLRAAZ/BLRABZ are BLR, with the protocol above
  (the pc check after the call, the pc map, unwinding). LDRAA/LDRAB load from base + simm10 * 8, with optional
  writeback of that address.
- PACGA has no key either: Xd = ((Xn ^ rotl64(Xm|SP, 32)) * 0x9E3779B97F4A7C15) with the low 32 bits cleared. The
  same inputs give the same code on every run and in every instance.

## Test guest ABI (test/guests <-> translator Gate 2)
A test guest is a flat little-endian image loaded at guest address 0x0800_0000, entry at offset 0,
with a sidecar JSON: `{ "base", "entry", "image": "<file>.bin", "bss_end", "stack_top", "expected_stdout": "<file>.out" }`.
Initial state: all registers 0, sp = stack_top, x30 = 0xFFFF_FFF0. Guest I/O is by SVC only:
- `svc #0x27` OutputDebugString: x0 = pointer, x1 = length -> bytes appended to stdout.
- `svc #0x07` ExitProcess: stop; exit code in x0 is NOT standard Horizon, tests use `svc #0x07` with w0 = code.
- `svc #0x1E` GetSystemTick: returns a deterministic counter in x0 (starts 0, +1000 per call).
Returning from the entry function to 0xFFFF_FFF0 also ends the run with exit code w0.

### Clarifications (settled with the guest corpus, tools/ref_run.py is the reference)
- The `.bin` does not contain bss. The embedder zero-fills from the end of the image up to `stack_top`.
- "All registers 0" includes NZCV, FPCR, FPSR, `tpidr_el0` and `tpidrro_el0`.
- GetSystemTick: the first call returns 0, then 1000, 2000, ...
- `svc #0x27` returns 0 in x0.
- Sidecar numbers (`base`, `entry`, `bss_end`, `stack_top`) are JSON numbers. Sidecars also carry `exit_code` and `insn_count`.
- Assembly-only programs produce one variant named `asm`.

## State machines
Every lifecycle uses the kit (src/kit/README.md). An area keeps its definitions in `src/<area>/defs/*.json` and its
machine tests in `test/<area>/*.machine.test.mts`; `npm run kit:diagrams` regenerates tables and diagrams, and
`npm run kit:test` fails while any transition of any machine has no test.
