# ARM64 test guests

Small freestanding ARM64 programs plus a reference runner. The ARM64 -> WebAssembly translator is
correct on a guest when it produces the same stdout bytes and the same exit code as the reference
(Unicorn). The ABI is the "Test guest ABI" section of `docs/CONTRACT.md`.

    npm run guests:build              # build + run everything, writes test/guests/out/
    npm run guests:check              # build twice, require byte-identical .bin/.out/.json/coverage
    npm run guests:run -- test/guests/out/control.O2.json [--count] [--trace] [--check]
    python3 tools/build_guests.py neon flags      # only some programs (no coverage.txt)

Needs clang + ld.lld with the aarch64 target, Python 3 with `unicorn` and `capstone`.
`llvm-objcopy` is used if present; otherwise the build tool flattens the ELF itself.

## Layout

| Path | What |
|---|---|
| `rt/crt0.S` | entry stub at offset 0: `bl main`, then `svc #0x07` with main's return value |
| `rt/svc.S` | `svc_output` (0x27), `svc_exit` (0x07), `svc_tick` (0x1E) |
| `rt/libc.c`, `rt/rt.h` | memcpy/memmove/memset/memcmp/strlen, putchar/puts, printf, exit, test helpers (`mix64`, `rng_next`, `f64_bits`...) |
| `rt/setjmp.S` | setjmp/longjmp (x19-x30, sp, d8-d15) |
| `rt/guest.ld` | flat image at 0x0800_0000: text, rodata, data, bss, then a 1 MB stack |
| `src/*.c`, `src/*.S` | the programs |
| `out/` (git-ignored) | build products, see below |
| `../../tools/ref_run.py` | reference runner (Unicorn, cortex-a57 model) |
| `../../tools/build_guests.py` | build + expected outputs + coverage |

## Build products (`out/`)

For each `src/NAME.c` there are three variants, `O0`, `O2` and `Os` (they execute quite different
instructions); a `src/NAME.S` gives one variant called `asm`.

- `NAME.VARIANT.bin`: flat image, load at `base`. bss is **not** in the file.
- `NAME.VARIANT.out`: expected stdout bytes.
- `NAME.VARIANT.json`: the contract's sidecar (`base`, `entry`, `image`, `bss_end`, `stack_top`,
  `expected_stdout`) plus `exit_code` and `insn_count` (instructions executed on the reference).
  Addresses are JSON numbers.
- `manifest.json`: list of all sidecars with exit code and instruction count.
- `coverage.txt`: every instruction mnemonic (capstone spelling, so aliases such as `mov`, `cmp`,
  `lsl`, `cset` appear instead of `orr`, `subs`, `ubfm`, `csinc`) executed anywhere in the corpus,
  with the executed count, its share and the number of images that execute it. Sorted by count:
  the top of the file is what a translator needs first.
- `obj/`: objects and `.elf` files (`llvm-objdump -d out/obj/NAME.VARIANT.elf` to read the code).

What a loader must provide, beyond the contract text: memory from `base` to `stack_top` mapped
read/write/execute, the image copied to `base`, **everything after the image zero filled** (bss
lives in `[base + size of .bin, bss_end)`, the stack in `[bss_end, stack_top)`), NZCV, FPCR and
FPSR zero, `tpidr_el0` zero. crt0 does not clear bss and does not set sp.

Compiler flags: `--target=aarch64-none-elf -ffreestanding -nostdlib -fno-pic -mcpu=cortex-a57
-mno-outline-atomics -fno-math-errno` (no LSE atomics, no SVE; atomics are ldxr/stxr loops; FP
contraction is clang's default, so `fmadd` appears in ordinary code).

## Reference runner

`tools/ref_run.py GUEST.json` (or a bare `.bin`) prints the guest's stdout on stdout and
`exit code: N (svc|return)` on stderr. Options: `--count` (instructions executed), `--trace` (pc of
every executed block on stderr), `--check` (compare with the expected output in the sidecar),
`--exact` (count with a per-instruction hook, slow, for cross-checking `--count`),
`--stack-top`, `--timeout`. Process status is 0 when the guest ended normally, 1 on a `--check`
mismatch, 2 on a guest fault. Faults (unmapped read/write/fetch, undefined instruction, unknown
SVC, timeout) print a `[RED]` line with the pc, a disassembly around it and the registers.

SVC behaviour: `0x27` appends `x1` bytes at `x0` to stdout and returns 0 in x0; `0x07` stops with
exit code `w0`; `0x1E` returns 0 on the first call, then 1000, 2000, ... Returning to
`0xFFFF_FFF0` stops with exit code `w0`. No guest depends on x0 after `svc 0x27`.

Known limits of the reference: Unicorn runs the guest at EL1, so privileged instructions are not
rejected (no guest uses any); the model is cortex-a57, so LSE/SVE/v8.1+ instructions fault as
undefined, as they would on a Switch.

## Programs

| Program | Covers |
|---|---|
| `hello` | smoke test: output SVC, printf formats, tick SVC, return from main |
| `exit_code` | `svc 0x07` from a nested call with exit code 42; nothing printed after the exit |
| `raw_ret` (asm) | no crt0: checks the initial state (registers, NZCV/FPCR, sp, zeroed bss), ends by `ret` to `0xFFFF_FFF0` with w0 = 7 |
| `int_arith` | add/sub/mul/div/mod at 32/64 bit signed and unsigned, division by zero and INT_MIN/-1, multiply-high and 128-bit ops, division/multiplication by constants, shifts, rotates, bitfield extract/insert, struct bitfields, clz/ctz/cls/popcount/rbit/bswap, `__builtin_*_overflow`, compare and conditional-select chains |
| `flags` | inline asm: NZCV after adds/subs/adcs/sbcs/ands/bics/cmp/cmn/tst with immediate, shifted and extended operands; every condition code through csel/csinc/csinv/csneg/ccmp/ccmn/b.cond for all 16 flag states; fcmp/fcmpe/fccmp/fcsel; tbz/tbnz/cbz/cbnz |
| `asm_misc` | inline asm: madd/msub/smaddl/umaddl/smulh/umulh, udiv/sdiv edge cases, variable shifts with counts >= size, extr, bfi/bfxil/ubfx/sbfx/ubfiz/sbfiz, clz/cls/rbit/rev*, movz/movn/movk, logical immediates, adr/adrp, sp arithmetic, **every load/store addressing mode** (scaled, unscaled, register offset with extend, pre/post index, pairs, literal, FP/SIMD registers), tpidr_el0/tpidrro_el0/nzcv/fpcr/fpsr access, hints and barriers |
| `control` | recursion (fib, ackermann, gcd, hanoi, 3000 frames deep), tail calls, dense switch (jump table) and sparse switch, state machine, function pointer tables, callbacks in structs, variadic functions, stack-passed arguments, setjmp/longjmp (direct, across up to 24 frames, 200 times in a loop, callee-saved register restore) |
| `memory` | loads of every width with sign/zero extension and run-time indices, unions, packed/unaligned access, struct copy and pass/return by value (small, 16 byte, large, HFA), memcpy for every size 0..130 at 9 misalignment pairs, overlapping memmove both directions, memset/memcmp/strlen, pointer walks, 2-D arrays |
| `algo` | bump allocator, quicksort, heap sort through comparison callbacks, chained hash table (insert/find/remove), linked list reverse and merge sort, binary search tree |
| `fp_scalar` | float and double add/sub/mul/div/sqrt/abs/neg/fma/min/max/copysign, comparisons with NaN, classification, floor/ceil/trunc/round/rint/nearbyint, float -> int conversions incl. negative, huge, NaN, inf (saturation), int -> float incl. values that round, float <-> double; inline asm for fmin/fmax/fminnm/fmaxnm, fmadd family, fnmul, fabd, frintn, fcvt{n,a,m,p,z}{s,u}, fixed-point scvtf/ucvtf/fcvtz*, fmov forms, scalar fcm*; small numeric kernels. NaN results are canonicalised before printing |
| `fp_nan_bits` | exact NaN bit patterns: default NaN, payload propagation, signalling NaN quieting, sign ops, fminnm/fmaxnm, precision conversion. Fails if NaNs are canonicalised by the host; nothing else in the corpus depends on NaN payloads |
| `fpcr_modes` | the four FPCR rounding modes applied to div/mul/add/sqrt/rint/int->float/double->float. Fails if only round-to-nearest is implemented; nothing else changes the rounding mode |
| `fp_sim` | n-body (1000 steps), Mandelbrot in double and float, 12x12 matrix multiply and determinant; checksums of the raw bits |
| `vec_auto` | loops clang auto-vectorises: saxpy/daxpy, dot products, byte/word sums with widening, min/max reductions, saturating add, average, abs-diff, widening multiply, narrowing, clamp, per-lane shifts, selects, int <-> float and float <-> double lanes, reversal, interleave, stride-2/3 loads (ld2/ld3), popcount, bswap; short lengths for the scalar tails |
| `neon` | arm_neon.h intrinsics, every result printed per lane: add/sub/mul/mla, saturating and halving ops, abd/abs/neg, min/max, compares + vbsl, logic, cnt/clz/cls/rbit/rev, immediate and per-lane shifts incl. rounding/saturating/insert, vmovl/vmovn/vqmovn/vshrn, vmull/vmlal/vaddl/vaddw/vpaddl/vpadal, across-vector reductions, lane get/set/dup/copy, vcombine/vget_low/high, vext, zip/uzp/trn, vqtbl1q/vqtbx1q/vqtbl2q/vtbl1, vld1-4/vst1-4 and lane/dup forms, float arithmetic, compares, vcvt (all rounding variants, fixed point), vrnd*, f64 lanes |
| `neon_estimate` | frecpe/frsqrte/frecps/frsqrts/frecpx/urecpe/ursqrte (table-defined results); kept apart from `neon` |
| `atomics` | `__atomic_*` builtins on 8/16/32/64 bit, stdatomic compare-exchange loops, atomic_flag, spinlock, lock-free stack, raw ldxr/stxr/ldxp/stxp/ldaxr/stlxr/ldar/stlr including the cases where the exclusive store must fail (no prior load, after clrex) |
| `crc32` | crc32b/h/w/x and crc32cb/ch/cw/cx against software CRCs, known check values |
| `mixed_sha256` | SHA-256: standard test vectors (digests are printed next to the known values), block-boundary lengths, split updates, a hash chain |
| `mixed_vm` | bytecode interpreter (dense switch dispatch) running sieve, collatz, bubble sort, recursive fib and a byte mixer |
| `mixed_lz` | LZ77 compressor/decompressor with hash chains over text, random, periodic and structured data; in-guest round-trip check |

Two programs print output that differs between variants for legitimate reasons (each variant
has its own `.out`): `fp_nan_bits` (the compiler may commute operands, which changes which NaN
payload wins) and `vec_auto` (reassociated FP reductions depend on the vector width; `dot_strict`
differs through FP contraction). Every other program prints the same text in all three variants.

Suggested order for bringing up a translator: `raw_ret`, `hello`, `exit_code`, `int_arith`,
`flags`, `asm_misc`, `control`, `memory`, `algo`, `mixed_*`, `fp_scalar`, `fp_sim`, `atomics`,
`crc32`, `vec_auto`, `neon`, then `neon_estimate`, `fp_nan_bits`, `fpcr_modes`.

## Adding a program

1. Create `src/NAME.c` with `#include "rt.h"` and an `int main(void)`; its return value is the
   exit code. Or create `src/NAME.S` that defines `_start` in section `.text.start` (no crt0 is
   linked for `.S` programs; the rt objects are still available).
2. Print enough intermediate values that a wrong instruction changes stdout: one labelled line
   per operation or stage (a hash via `mix64` over a table of inputs works well) rather than one
   final checksum. Use `volatile` inputs or `noinline` helpers where the compiler would otherwise
   fold the computation away.
3. Keep it deterministic and self-contained: no libc beyond `rt.h`, no 128-bit division or other
   operations that need compiler-rt, no reads of uninitialised memory, no dependence on addresses
   (do not print pointers). Stay under 20 million instructions per variant (the build fails above
   that); `-O0` is the slow one.
4. Extra compiler flags for one program go in a source line `// CFLAGS: ...`.
5. `npm run guests:build`, read `out/NAME.*.out`, add a row to the table above.

Only instructions available on a cortex-a57 at EL0 may be executed. Inline asm is fine and is the
right tool when one specific instruction or flag result is the point of the test.
