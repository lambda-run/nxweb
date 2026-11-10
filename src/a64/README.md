# nxweb a64: ARM64 -> WebAssembly translator

Translates guest AArch64 code (Nintendo Switch user mode, Cortex-A57 feature level) into
WebAssembly modules that run against the CPU state globals and the control-flow protocol fixed in
`docs/CONTRACT.md`. The translator is AssemblyScript (`src/a64/*.ts`, compiled with `asc` to
`build/a64/translator.wasm`); it reads guest code bytes from its own linear memory and writes the
bytes of a new wasm module into its linear memory. `src/glue/a64_host.ts` is the only TypeScript: it
instantiates modules, owns the function table and the pc map and provides the imports.

## Architecture

| file | role |
| --- | --- |
| `emit.ts` | byte writer, wasm opcode helpers, guest-register cache (wasm locals), flag helpers, control-flow protocol (`gotoPc`, `branchIf`, `callConst`, `callDyn`, `exitDyn`, `exitRet`, `emitSvc`, `emitTrap`) |
| `int.ts` | integer data processing, branches, system instructions, integer loads/stores, exclusives |
| `fp.ts` | scalar floating point, SIMD&FP register loads/stores, AdvSIMD structure loads/stores |
| `simd.ts` | Advanced SIMD data processing (vector and scalar-in-SIMD forms) |
| `unit.ts` | function discovery, per-function assembly, register write-back/reload analysis, unit module builder, core module builder, `probe` |
| `index.ts` | exports: `init, setOpt, setOptAddr, addRange, removeRange, setEntry, entryBuf, translate, outPtr, metaBuf, sideBuf, buildCore, probe, staticBase, staticEnd, addrBits` |
| `helpers.ts` | separate AssemblyScript module (`build/a64/helpers.wasm`), imported by translated code as `hlp`: pure functions for the table-driven and rare instructions (`vop`: estimates, AES, SHA-1/SHA-256, PMUL/PMULL, SQDMULL family, saturating register shifts, SUQADD/USQADD, half-precision vectors, lanewise directed rounding; `nan1/2/3{s,d}`: ARM NaN selection; `rnd`: directed int<->float / float<->float conversions, half precision; `rarith{s,d}`: directed-rounding scalar arithmetic) |

**Core module** (`buildCore()`, bytes produced by the same encoder). Imports `env.memory`,
`env.table`, `env.translate(pc: i64) -> i32`. Defines and exports the contract globals (`x0..x30, sp,
pc, nf, zf, cf, vf, v0..v31, fpcr, fpsr, tpidr, tpidrro, excl_addr, excl_val, budget`, plus
`excl_val2` and `depth`), `save_ctx/load_ctx` (contract layout), `run()`, `stop`, `trampoline`, `crc32`.
Table index 0 is the trampoline (`if pc >= 0xFFFF_FF00 return; return_call_indirect(translate(pc))`),
index 1 is `stop` (sets `budget = -1`, which makes every frame unwind and `run()` return; the glue's
`translate` returns 1 when it does not want to continue). `run()` loops
`while (pc < 0xFFFF_FF00 && budget >= 0) call_indirect(pcmap[pc])`.

**Memory.** The translator and the helpers import the embedder's one linear memory (`asc --importMemory
--zeroFilledMemory --memoryBase`; `npm run a64:build` is `src/a64/host/build.mts`, which takes the bases from the
"a64 translator" and "a64 helpers" ranges of `src/glue/rt_layout.ts`, and `A64Host` refuses to start when the binaries and the layout disagree or the
data would not fit). Guest code is read where it lies; there is no private copy. Everything the translator keeps is
static data plus buffers taken from its own bump allocator at start (15.4 MB: 8 MB unit output, 2 MB function body,
2 MB side table, the rest tables); it never grows the memory. `translator.shared.wasm` / `helpers.shared.wasm` are
the same code importing a shared memory.

**pc map.** Two levels, covering all 4 GB of guest addresses: a first level of 65536 `u32` leaf addresses (one per
64 KB) and 64 KB leaves (`u32` table index per instruction) that the glue allocates on demand from the "pc map"
range; every untouched 64 KB points at one shared zero leaf, so a lookup is two loads and no branch:
`index = load32(load32(L1 + (pc >> 16) * 4) + (pc & 0xFFFC))`, 0 = trampoline. Cost: 320 KB fixed plus 64 KB per
64 KB of code that has at least one translated function (1.9 MB for the 1.66 MB big guest). `A64Host.setPcMap /
fillPcMap / getPcMap / clearPcMap`; the translator reads the map to know what is already translated.

**Code ranges.** `A64Host.addCode(lo, size, { text, entries })` registers code that is in memory (up to 64 ranges,
any time); `removeCode(lo, size)` forgets one: its pc-map entries are cleared (empty leaves return to the free
list), its units leave `host.units` and their table slots are set to null so the engine can free the modules, and
pending cache entries are dropped. A function, everything discovered from it, the BL targets pulled into its unit
and the region-mode chunk all stay inside one range, so no unit spans two ranges. `host.units[i]` gives
`{ tableBase, pcs, side, insns, cached }`: the guest pc of every function of the unit. `setCode(base, bytes)` is
kept as the one-window shorthand.

**Translation unit** = list of entry pcs -> one wasm module importing memory, table, the `cpu.*`
globals, `env.svc/unimpl/brk/cntpct`, `cpu.crc32`, the `hlp.*` helpers and `env.table_base`; its functions are placed in
the table by an active element segment at `table_base`. `metaBuf()` lists the function pcs so the
glue can fill the pc map. BL targets inside the code window are added to the unit (up to
`maxFuncs`) and become direct `call`s; everything else is an indirect transfer by the protocol.

**Function entries.** `addCode` scans the range once and sets a bit per known entry (bitmap, 1 bit per instruction
of the code region): every BL target; an instruction right after a RET **if it looks like a function start** (`stp
.., [sp, #-n]!`, `sub sp, sp, #n`, `str xN, [sp, #-n]!`, `paciasp`, `bti`); every aligned 8-byte word of the range
that points into its text (function pointers, vtables, init arrays); and whatever the loader passes in `entries`
(symbols, relocation targets) or later through `addEntries`. A missed entry costs nothing but a lazy translation.

**Unit size (region mode, default).** When a pc
needs translating, the unit also takes every not-yet-translated known entry of the same 64 KB chunk
(`chunk` option, `maxFuncs` 1024). Nothing is translated twice: a pc with a pc-map entry is never taken again
and a BL to it goes through the pc map. Chosen from
the larger-code check below: one module per function costs about 230 KB of engine memory per module;
64 KB chunks give modules of 0.2-0.7 MB, the lowest total translate+compile time and 4x less memory.

**Function discovery.** From an entry pc, follow direct branches (B, B.cond, CBZ, TBZ) inside a
+-256 KB window; BL/BLR/SVC fall through; BR/RET/BRK end a path. The size cap (`maxInsns`, default
1500) stops discovery; a branch or fallthrough to an address outside the function becomes a tail
transfer (`pc = target; return_call_indirect pcmap[target]`). `maxInsns = 1` gives one function per
instruction (used by the fuzz gate, and by the runtime to count instructions: one budget unit each).
In that mode the up to 255 instructions that follow an entry and have no translation yet are
functions of the same module, up to `maxFuncs` (the fuzz gate sets 1: one module per instruction).
One module per instruction cost about 280 KB of engine memory each: counting the instructions of a
program with 125,000 of them (the Doom guest, `test/doom`) ran out of memory after 7,000.

**Function body.** Basic blocks sorted by address inside
`loop { block..block { br_table state } b0 } b1 } ... }`: fallthrough and forward branches are plain
`br`/`br_if`, backward branches set the block index and `br` to the loop. Function entry and every
backward branch decrement `budget` and leave with `pc` = function entry / block address when it
goes negative.

**Register cache.** Guest registers used by a function (x0..x30, sp, N, Z, C, V, v0..v31) live in
wasm locals. Every read/write is logged; after the body is emitted two data-flow passes over the
block graph decide (1) which locals are dirty at each write-back point (before calls, SVCs, exits)
and (2) which locals must be (re)loaded at function entry and after each call. The write-back and
reload sequences are spliced into the body at assembly time, so a call only pays for registers
that are actually dirty / needed afterwards.

**Calls and unwinding.** After any `call`/`call_indirect`/`svc` the caller compares `pc` with the
return address and returns at once on mismatch (longjmp, exit, preemption). RET (and `br x30`) set
`pc` and return; other BRs and out-of-function B are wasm tail calls (`tailCalls: false` uses
call + return instead and is exercised by the gates).

**Call depth.** The `depth` global bounds wasm nesting: a function reads it at entry, a nested call
announces `depth + 1`, a tail transfer hands on its own depth, `run()` resets it to 0. A function
entered above `depthLimit` (default 160) sets `pc` to its own entry and returns; every caller
unwinds by the pc check and `run()` continues there with an empty wasm stack. Guest recursion is
therefore bounded only by the guest stack, and frames abandoned by a longjmp done with `br xN` are
released at the latest when the limit is reached.

**Shared memory (`shared: true`, default off).** The core module and every unit import the memory as shared
(needs the threads feature; use the `.shared.wasm` translator and helpers). LDXR/LDAXR are atomic loads, STXR is
`atomic.rmw.cmpxchg` against the value the load saw (after the address check), LDAR/STLR are atomic loads/stores.
A 128-bit STXP is two exchanges with a roll-back of the first when the second loses (not atomic as a pair).
Atomic accesses trap on a misaligned address. DMB and DSB are `atomic.fence` (on an unshared memory, and for ISB,
nothing). CPU state stays in per-instance globals, so each Worker has its own.

**cntpct as a yield point (`cntYield: true`, default off).** `mrs xN, cntpct_el0 / cntvct_el0` becomes: write back,
`pc` = the instruction itself, call `cntpct`, pc check, reload, then use the returned value. The embedder may park:
set `pc` to 0xFFFF_FFE0 inside the import (its return value is ignored), let everything unwind, and later resume at
the saved pc; the read is then executed again. Off, it is a plain call with nothing written back.

**Guard (`guardBase`, default 0 = off; the runtime's `guard: true` sets it).** Guest data accesses below `guardBase` trap: the
address is `wrap(addr) - guardBase` and every memory instruction carries the offset `guardBase` (`aw`, `mem`,
`vmem`, `moff` in `emit.ts`), so a lower address reaches 4 GB or more in the engine's unwrapped effective-address
computation. One subtraction per access, no branch; DC ZVA does a one-byte guarded load before its `memory.fill`.
With 0 the emitted bytes are what they were. Measured by the runtime on the shared corpus: about +6 % run time
(runs between +2 % and +10 % on a busy machine; `src/runtime/README.md`), which is why it is not the default. The pc map, `save_ctx` / `load_ctx` and
the helpers are host accesses and are not biased.

**memory64 (`mem64: true`, default off).** The second mode, for a process that needs more than 4 GB of address
space: one 64-bit linear memory (the memory64 proposal; `makeMemory64` in the glue) in place of the 32-bit one. It
is a second build of the same sources, `translator64.wasm` / `helpers64.wasm` (and `.shared`), compiled for wasm64 by
`tools/asc64` (below), so the translator itself reads guest code at any address; `M64` in `emit.ts` is a compile-time
constant (`sizeof<usize>() == 8`), one build is one mode, and the wasm32 build compiles none of the other's branches.
What differs in the emitted code, all of it:

| | memory32 | memory64 |
|---|---|---|
| imported memory | limits flags 0 (shared 3, maximum 65536 pages) | flags 4 (shared 7, maximum `memoryMaxPages`, default 262144 = 16 GB) |
| a guest data address (`aw`) | `i32.wrap_i64` | nothing: the i64 is the memory operand |
| guard | `i32.sub guardBase`, offset `guardBase` | `i64.sub guardBase`, offset `guardBase` (u64 LEB) |
| `memarg` offsets (`mem`, `vmem`, `moff`; atomic and SIMD lane forms) | u32 | u64 |
| AdvSIMD structure loads / stores: the address temp | i32 local | i64 local |
| DC ZVA | `memory.fill(i32, 0, i32 64)` | `memory.fill(i64, 0, i64 64)` |
| pc map lookup, dynamic | `L1[u32(pc) >> 16]` (u32 entries), `+ (pc & 0xFFFC)` | `L1[pc < span ? pc >> 16 : span >> 16]` (u64 entries, an `i64.lt_u` and a `select`), `+ (pc & 0xFFFC)` |
| pc map lookup, constant target | first-level address folded in | the same; a target at or beyond the span is index 0 at translation time |
| embedder pcs in `run` / trampoline | `pc >= 0xFFFF_FF00` | `pc - 0xFFFF_FF00 < 0x100` |
| `save_ctx` / `load_ctx` | `(ptr: i32)` | `(ptr: i64)` |

Everything else was 64-bit already: registers and `pc` are i64 globals, the return-address check after a call
compares the whole `pc`, address arithmetic (base + offset, extends, pre/post-index, pc-relative literals, ADRP) is
done in i64 before `aw`, exclusives compare the whole address in `excl_addr`, function names carry the whole pc.

*Contract.* "A 64-bit guest address is wrapped to 32 bits" becomes: **a guest address is used whole, and an access
beyond the memory traps** (the engine's bounds check; `faultFromError` gives the pc as before). Nothing aliases: an
address or a pc that differs from a mapped one by 4 GB, or by the pc map's span, is not that one (feature tests
"an address beyond the memory traps", "a pc with no code ... reaches the embedder whole"). The special pc values stay
where the contract has them, 0xFFFF_FF00 .. 0xFFFF_FFFF (x30 = 0xFFFF_FFF0 at thread start, 0xFFFF_FFE0 = yield), so
the kernel and the runtime keep their constants; they are a window now, since code may lie above them: the last 256
bytes below 4 GB cannot hold code (data is fine), and embedders ask `host.isHostPc(pc)` instead of comparing.

*The pc map* covers the guest addresses `[0, pcmapSpan)` whole: a first level of one **u64** leaf address per 64 KB
(so leaves may lie anywhere, above 4 GB too) plus one entry that always holds the zero leaf, which is where a pc at
or beyond the span is looked up (it reads index 0, the trampoline, and the embedder is asked with the whole pc).
Default span 16 GB, the engines' limit for a 64-bit memory: a first level of 2 MB (2.2 MB fixed with the zero leaf,
against 320 KB), leaves as before. It extends by a larger `A64Layout.pcmapSpan` (8 bytes per 64 KB: 128 MB of first
level per TB); nothing else depends on it. The entry bitmap is unchanged (1 bit per instruction of the code region,
whose base and size are 64-bit now and may be above 4 GB), as are the return-address checks.

*The glue.* Addresses in `A64Host`'s interface are JavaScript numbers in both modes (exact to 2^53): layout fields,
`addCode`, the pc map functions, `units[i].pcs` (a `Float64Array` in this mode), fault pcs, `core.save_ctx(ptr)`.
Register values stay BigInt. A number becomes a BigInt only where it enters a wasm64 export's i64 parameter. The
side table keeps the low 32 bits of each instruction's pc and `faultFromError` restores the rest from the function's
pc (an instruction is within 256 KB of its function's entry). Cache blobs of this mode have their own magic (8-byte
pcs) and `optionsKey()` ends in `m64.<span>.<max pages>` (`m32` otherwise): a cache key always names the mode.
Node 22's `WebAssembly.Memory` has no `address: "i64"` (it silently returns a 32-bit memory), so `makeMemory64`
instantiates a 40-byte module that defines and exports the memory, in every engine; `grow` / `pages` are that
module's `memory.grow` / `memory.size`.

*Limits.* Static data of the translator and helpers must be below 4 GB (`--memoryBase` is a u32 in asc); a unit's
side table and the translation window assume a function is smaller than 4 GB; V8 gives a 64-bit memory at most 16 GB.
Atomic accesses (shared memory) take the same i64 address and trap when misaligned, as in memory32.

*Cost* (same machine, same run, modes interleaved; `npm run a64:mem64:speed`, the 75 guests, 276 M guest
instructions): see Status. In short, 5 to 8 % more run time under Node 22 (V8 12.4, explicit bounds checks), about
the same with the images above 4 GB; in Chromium 153 the difference is inside the spread between two runs (from 11 %
slower to 7 % faster; above 4 GB 5 to 15 % slower). Memory-bound -O0 programs pay the most (up to +40 % on single
programs), compute-bound ones nothing.

**tools/asc64: AssemblyScript for wasm64.** `node tools/asc64/asc64.mjs <asc arguments>` (or `asc64([...])`).
AssemblyScript 0.28.20 has the target in its compiler, but four things around it are unfinished; the tool closes them
without touching `node_modules` (the header of `asc64.mjs` has the detail):
1. the command line driver always selects wasm32: a copy of `dist/asc.js` with `setTarget(options, 0)` changed to
   `2` is written to `build/asc64/` and loaded from there (setting the target later, from a transform, is too late:
   pointer arithmetic comes out as `i32.sub` on i64 operands);
2. the module's memory is declared 32-bit whatever the target, and Binaryen's validator and optimizer reject or abort
   on the result: an `afterCompile` hook declares it again as an i64 memory (same limits, segments, import) before
   Binaryen validates, so validation and `-O2` run as usual and no binary patch is needed;
3. `memory.size` / `memory.grow` are typed i32 but are i64 on an i64 memory: in the copy of the driver the library's
   two builtins become imports (`env.memory_size`, `env.memory_grow`, pages; `Memory64.imports()`), and the stub
   runtime is replaced by `tools/asc64/rt.ts` (the same bump allocator, no growing, a heap the module can place with
   `__set_heap(start, end)`). Only `--runtime stub` is accepted;
4. the non-null assertion `x!` compiles to an `if` with an i64 condition: the hook rewrites such conditions to
   `!= 0`.
The output is then checked: one i64 memory, no `memory.size` / `memory.grow` instruction, and the running engine's
`WebAssembly.validate`. `npm run a64:asc64` (`test/a64/asc64/run.mts`) compiles `probe_std.ts` (classes, linked
lists, arrays, typed arrays, strings, maps, sets, function references, generics, Math, nullable references, raw
memory, static data, memory growth) for wasm32 with `asc` and for wasm64 with the tool, and runs both: every result
must be equal, with the wasm64 module's heap and raw pointers above 4 GB and the same addresses minus 4 GB checked
to be untouched.

**Fault pcs.** Default (no run-time cost): every unit carries a side table (module byte offset -> guest pc, 8 bytes
per instruction, kept by the glue) and a name section (`f_<hex pc>` per function). `host.faultFromError(e)` reads
the innermost wasm frame of the trap's stack (`f_8000000 (wasm://wasm/..:wasm-function[N]:0xOFFSET)`, the same in
Node and Chromium), finds the unit by the function name and the instruction by the offset. Registers are then those
of the last write-back (dirty cached registers are lost with the wasm frame). `preciseFaults: 1` writes `pc` before
every memory instruction; `preciseFaults: 2` also writes back the dirty registers there, which makes pc and all
registers exact at the faulting instruction at about twice the run time (see Status).

**Translation cache.** `host.keepBytes = true; ...; blob = host.exportCache(lo, size)` serializes the units of a
range (wasm bytes, function pcs, side tables); `host.importCache(blob)` on a later start makes them available and a
cached unit is compiled and installed when one of its functions is first needed, so nothing is translated. The
caller's key must contain the module's build id, its load address (the code embeds absolute addresses) and
`host.optionsKey()` (translator cache version, layout and every code-changing option). Stores: `webCacheStore()`
(Cache API, used in the browser gate) and `test/a64/cache_node.ts` (files, `guests_run.ts --cache DIR`).

**Flags** are four i32 locals/globals. A `SUBS/CMP` additionally keeps its operands in dedicated
locals so that a following `b.cond`/`csel`/`cset`/`ccmp` in the same block is emitted as one direct
comparison; dead flag computations are left to the wasm engine's optimizer.

**Memory.** Address = `i32.wrap_i64` (memory64: the i64 itself). W-register writes zero-extend. Exclusives record address and
value(s) in `excl_addr`/`excl_val` (`excl_val2` for the second word of a pair); the store succeeds
only if the address matches and memory still holds the recorded value. LDAR/STLR are plain.

**Floating point.** Scalar ops work on lane 0 of the v128 and zero the upper bits on write. FMADD
family and vector FMLA/FMLS use relaxed-simd `relaxed_madd/nmadd` (option `fma`, default on; off =
separate multiply and add). FPSR is stored but never updated by arithmetic.

**NaNs (`nanFix`, default on).** After an FP operation that can produce a NaN (add, sub, mul, div,
sqrt, min/max, fused forms, step/mulx, scalar and vector) the result is tested (`r != r`, one
compare and a never-taken branch); only then a helper recomputes the ARM result from the operands
(default NaN 0x7FF8.. for generated NaNs, FPProcessNaNs order and quieting for propagated ones).

**Rounding mode.** FRINTI/FRINTX, SCVTF/UCVTF (scalar, vector, fixed-point) and FCVT d->s test
FPCR.RMode and call a helper when it is not nearest. With `rmodeArith` (default on) scalar
FADD/FSUB/FMUL/FNMUL/FDIV/FSQRT do the same (helper computes the exactly rounded directed result
with error-free transforms). FZ, DN and AHP are ignored.

**System.** NOP/hints, barriers, CLREX, MRS/MSR for TPIDR_EL0, TPIDRRO_EL0 (read), FPCR, FPSR, NZCV,
CNTPCT_EL0/CNTVCT_EL0 (import `cntpct`), CNTFRQ_EL0 (19200000), DCZID_EL0 (4), CTR_EL0 (0x8444C004),
DC ZVA, other DC/IC ops as no-ops, SVC (import `svc`), BRK (import `brk(pc, imm)`). Anything
undecodable compiles to `unimpl(pc, insn)`; after `unimpl`/`brk` return, the function sets
`budget = -1` and returns with `pc` at the offending instruction.

## Running the gates

```
npm run a64:build            # asc -> build/a64/{translator,helpers}{,.shared}.wasm; tools/asc64 -> {translator64,helpers64}{,.shared}.wasm
npm run a64:extra            # feature tests: fault pcs, code ranges, cntpct yield, cache, shared exclusives, guard,
                             #         contexts; then again in memory64, and in memory64 at addresses above 4 GB
npm run a64:fuzz             # Gate 1: differential fuzz against Unicorn (python3 test/a64/fuzz.py), then 30,000
                             #         cases in memory64 and 30,000 with code and memory window above 4 GB
    python3 test/a64/fuzz.py --cases 2000 --only 'simd_' --show 4 [--nofma] [--seed N] [--mem64 | --hi] [--total N]
npm run a64:fuzz:mem64       # the full 338,000 cases in memory64, and again above 4 GB
npm run a64:guests           # Gate 2: every guest in test/guests/out and test/a64/guests/out, then again with
                             #         budget=50, without wasm tail calls, on a shared memory; in memory64; in
                             #         memory64 with the images linked at 0x1_8000_0000 (test/a64/guests/out_hi,
                             #         built by build_hi.py: default, budget=50, shared, no tail calls); then the
                             #         feature tests in the three configurations and a64:asc64
npm run a64:browser          # the same in headless Chromium (full build, Playwright channel "chromium"), in a
                             #         Worker, plus cache cold/warm (Cache API), the big guest, memory64 (default,
                             #         budget 50, shared, cache cold/warm; above 4 GB: default, shared, no tail
                             #         calls), the three modes' speed in five interleaved rounds, the feature tests
npm run a64:asc64            # the wasm64 build tool against the stock compiler (test/a64/asc64)
npm run a64:mem64:speed      # memory32 / memory64 / memory64 above 4 GB on the guest corpus, interleaved [-- --rounds N --guard --each]
npm run a64:mem64            # the two addressing forms in a hand-assembled loop; how large a 64-bit memory gets
npm run a64:bytes            # a digest of every emitted byte for the corpus, per option set (two translator builds
                             #         emit the same code exactly when these lines are the same)
npm run a64:big              # larger-code check: generated 400k-instruction guest, time / size / memory
    python3 test/a64/fuzz.py --strictnan     # compare NaNs bitwise too
npm run a64:speed            # per-guest guest-instructions/second and translation time
python3 test/a64/coverage.py # corpus instruction words the translator rejects, by mnemonic
```

Gate 1 (`test/a64/fuzz*.py`, `fuzz_run.ts`): per instruction class a generator produces random valid
encodings, random register/flag/vector state and a 4 KB memory window; each case is executed on
Unicorn (Cortex-A57 model, one instruction, or a short sequence for exclusives) and then translated
with `maxInsns=1` and run under Node. Compared: x0..x30, sp, pc, NZCV, FPCR, TPIDR, v0..v31 and the
memory window. Floats are compared bitwise except that NaN == NaN for the class's lane type
(`--strictnan` compares NaNs bitwise as well; that is clean too with `nanFix` on).
Not compared: FPSR (cumulative exception flags are not modelled). CNTFRQ_EL0 is excluded (deliberate
constant) and CNTPCT_EL0 (time).

Gate 2 (`test/a64/guests_run.ts`): loads each flat image per the contract ABI, runs it with the
default budget and with `--budget 50`, compares stdout and exit code. Own guests are built by
`test/a64/guests/build.py` (expected output from `tools/ref_run.py`). A source marked `// ISA: a78c` (and, as a
third variant, the sources in the script's `A78C_TOO`) is compiled with `-mcpu=cortex-a78c
-mbranch-protection=pac-ret+b-key+leaf`, so every function signs its return address (PACIBSP) and returns with
RETAB; the reference for such an image is Unicorn's `max` model (sidecar `"cpu": "max"`), whose authentication keys
are disabled. `npm run a64:bytes` digests those images on lines of their own, after the lines of the images built
for the first Switch's core, which a change that only adds instructions must leave as they were.

Classes of the ARMv8.1+ instructions (`test/a64/fuzz_classes_v8x.py`) run on Unicorn's `max` model, the others on
the Cortex-A57 model as before. Pointer authentication is compared bit for bit: with SCTLR_EL1.EnIA/EnIB/EnDA/EnDB
clear, which is the model's reset state, QEMU's PACIx/AUTIx/PACDx/AUTDx, the hint forms, the authenticating branches,
returns and loads are the identity too. XPACI/XPACD/XPACLRI strip whatever the enable bits say, so they are given
canonical pointers (the only ones an identity signer produces). PACGA traps in the model (it has no EL3 to enable
it): the reference runs a NOP in its place and the expected Xd is computed from the contract's function, all other
state still coming from Unicorn.

## Implemented instruction classes

- Data processing immediate: ADR/ADRP, ADD/SUB(S) imm, logical imm, MOVN/MOVZ/MOVK, SBFM/BFM/UBFM, EXTR.
- Data processing register: logical shifted (AND/BIC/ORR/ORN/EOR/EON/ANDS/BICS), ADD/SUB(S) shifted
  and extended, ADC/SBC(S), CCMP/CCMN (reg and imm), CSEL/CSINC/CSINV/CSNEG, LSLV/LSRV/ASRV/RORV,
  UDIV/SDIV, MADD/MSUB, SMADDL/SMSUBL/UMADDL/UMSUBL, SMULH/UMULH, RBIT/REV16/REV32/REV/CLZ/CLS,
  CRC32{B,H,W,X}, CRC32C{B,H,W,X}.
- Branches: B, BL, B.cond, CBZ/CBNZ, TBZ/TBNZ, BR, BLR, RET, SVC, BRK.
- System: listed above.
- Integer loads/stores: all sizes, unsigned offset, unscaled, pre/post-index, register offset (all
  extends), literal, LDRSB/LDRSH/LDRSW, LDP/STP/LDPSW/LDNP/STNP, PRFM (no-op), LDXR/STXR/LDXP/STXP
  (+A/L forms), LDAR/STLR (+LDLAR/STLLR).
- Scalar FP (single and double): FMOV reg/imm/general (incl. V.D[1]), FABS, FNEG, FSQRT, FADD, FSUB,
  FMUL, FDIV, FNMUL, FMAX, FMIN, FMAXNM, FMINNM, FMADD/FMSUB/FNMADD/FNMSUB, FCMP(E), FCCMP(E), FCSEL,
  FCVT s<->d, FCVT h<->s/d, FCVT{N,P,M,Z,A}{S,U} to W/X, SCVTF/UCVTF from W/X, fixed-point SCVTF/UCVTF/FCVTZS/FCVTZU,
  FRINT{N,P,M,Z,A,X,I}.
- SIMD&FP loads/stores: B/H/S/D/Q in every addressing mode, pairs, literal.
- AdvSIMD structure loads/stores: LD1/ST1 (1-4 registers), LD2/3/4, ST2/3/4, single-lane LD1..LD4 /
  ST1..ST4, LD1R..LD4R, all with post-index.
- AdvSIMD: MOVI/MVNI/ORR/BIC immediates, vector FMOV imm; DUP (element, general), INS (element,
  general), UMOV, SMOV, scalar DUP; AND/BIC/ORR/ORN/EOR/BSL/BIT/BIF/NOT; ADD/SUB/MUL/MLA/MLS/NEG/ABS;
  CMEQ/CMGT/CMGE/CMHI/CMHS/CMTST and CMEQ/CMGE/CMGT/CMLE/CMLT #0; SMAX/UMAX/SMIN/UMIN, SMAXP/UMAXP/
  SMINP/UMINP, ADDP; SABD/UABD/SABA/UABA, SABDL/UABDL/SABAL/UABAL; SHADD/UHADD/SHSUB/UHSUB/SRHADD/
  URHADD; SQADD/UQADD/SQSUB/UQSUB; SQABS/SQNEG; SQDMULH/SQRDMULH (vector, scalar, by element);
  SHL/SSHR/USHR/SSRA/USRA/SRSHR/URSHR/SRSRA/URSRA/SLI/SRI, SQSHL/UQSHL/SQSHLU #imm, SSHL/USHL/SRSHL/
  URSHL; SHRN/RSHRN/SQSHRN/UQSHRN/SQRSHRN/UQRSHRN/SQSHRUN/SQRSHRUN, XTN/SQXTN/UQXTN/SQXTUN,
  SSHLL/USHLL/SHLL, ADDHN/SUBHN/RADDHN/RSUBHN; SADDL/UADDL/SSUBL/USUBL/SADDW/UADDW/SSUBW/USUBW,
  SMULL/UMULL/SMLAL/UMLAL/SMLSL/UMLSL (vector and by element), MUL/MLA/MLS by element;
  SADDLP/UADDLP/SADALP/UADALP; ADDV/SADDLV/UADDLV/SMAXV/UMAXV/SMINV/UMINV; ZIP1/2, UZP1/2, TRN1/2,
  EXT, REV64/REV32/REV16, TBL/TBX (1-4 tables), CNT, CLZ, CLS, RBIT; float vector ADD/SUB/MUL/DIV/
  MIN/MAX/MINNM/MAXNM/ABS/NEG/SQRT/FABD/FMLA/FMLS (vector and by element)/FADDP/FMAXP/FMINP/FMAXNMP/
  FMINNMP, FCMEQ/FCMGE/FCMGT/FACGE/FACGT and the #0 compares, FMAXV/FMINV/FMAXNMV/FMINNMV (4S),
  FRINT{N,P,M,Z,A,X,I}, FCVT{N,P,M,Z,A}{S,U}, SCVTF/UCVTF (plain and fixed-point), FCVTL/FCVTN.
- Round 2 additions: FRECPE/FRSQRTE/URECPE/URSQRTE (table-exact), FRECPS/FRSQRTS (fused), FRECPX,
  FMULX, vector and scalar; SQDMULL/SQDMLAL/SQDMLSL (vector, scalar, by element); SQSHL/UQSHL/SQRSHL/
  UQRSHL by register; SUQADD/USQADD; scalar saturating narrows (SQXTN/UQXTN/SQXTUN, SQSHRN/UQSHRN/
  SQRSHRN/UQRSHRN/SQSHRUN/SQRSHRUN); PMUL, PMULL (8-bit and 64-bit); AESE/AESD/AESMC/AESIMC;
  SHA1C/P/M/H/SU0/SU1, SHA256H/H2/SU0/SU1; FCVTL/FCVTN half<->single.
- Scalar-in-SIMD forms: ADD/SUB d, CM* d, ABS/NEG d, SHL/SSHR/USHR/SSRA/USRA/... d, SSHL/USHL/SRSHL/
  URSHL d, SQADD/UQADD/SQSUB/UQSUB, SQABS/SQNEG, SQSHL/UQSHL/SQSHLU #imm, SQDMULH/SQRDMULH, ADDP d,
  FADDP/FMAXP/FMINP/FMAXNMP/FMINNMP, FCM*/FAC*/FABD, FCVT*/SCVTF/UCVTF, FMUL/FMLA/FMLS by element.

- Pointer authentication (ARMv8.3, code built for the Switch 2), as the identity (`docs/CONTRACT.md`, "Pointer
  authentication": what a system with the keys disabled does): PACIA/PACIB/PACDA/PACDB, PACIZA/PACIZB/PACDZA/PACDZB,
  AUTIA/AUTIB/AUTDA/AUTDB, AUTIZA/AUTIZB/AUTDZA/AUTDZB, XPACI/XPACD, and the hint forms (PACIASP, PACIBSP, PACIAZ,
  PACIBZ, AUTIASP, AUTIBSP, AUTIAZ, AUTIBZ, PACIA1716, PACIB1716, AUTIA1716, AUTIB1716, XPACLRI) change nothing;
  RETAA/RETAB are RET, BRAA/BRAB/BRAAZ/BRABZ are BR, BLRAA/BLRAB/BLRAAZ/BLRABZ are BLR, with the call and return
  protocol unchanged (the return-address check after the call, the pc map, unwinding; `braa x30` returns like
  `br x30`); LDRAA/LDRAB load from base + simm10 * 8, with or without writeback; PACGA is the keyless function of the
  contract. Function discovery ends a path at RETAA/RETAB/BRAA.., and `addCode` takes a `pacibsp` after any return as
  a function entry.

## Known gaps

Not translated (compile to `unimpl`, reported only if executed):
- Half-precision arithmetic (fp16 is not on the Switch CPU), FCVTXN, FJCVTZS, vector FCVT*/SCVTF on halves.
- LSE atomics (CAS, LDADD, SWP, ...; not on the Switch CPU), ERETAA/ERETAB (EL1),
  MSR PSTATE (DAIF/SPSel), LDTR/STTR, BC.cond, SVE/SME, SHA-512/SHA-3/SM3/SM4, any system register not
  listed above.

Behavioural differences:
- Rounding mode: vector arithmetic and the FMADD family always round to nearest; FPCR.FZ/DN/AHP are
  ignored; FRINTX does not raise inexact. FPSR cumulative flags and QC are never set.
- FMADD/FMLA/FRECPS/FRSQRTS and the directed-rounding helpers are exact only when the engine's
  relaxed-simd madd is fused (x64 with FMA3, arm64). With `fma` off the translator emits unfused code.
- Unshared memory: exclusives are compare-and-store, fine for one thread at a time. Shared: see above
  (STXP 64-bit pair not atomic as a pair; atomic forms trap on misaligned addresses, where ARM's LDAR/STLR do not).
- After a wasm trap the registers cached in locals are lost unless `preciseFaults: 2` is on; the fault pc is exact
  either way. The stack-frame format is V8's (Node, Chromium); other engines get `undefined` from `faultFromError`.
- No self-modifying-code detection: the embedder calls `removeCode`/`addCode` (or `invalidate()`) when code changes.
- memory64: see its section for the limits (16 GB, static data below 4 GB). The other AssemblyScript modules and the
  runtime are wasm32 still; only the translator, its helpers and their glue have the mode (`src/runtime/README.md`,
  "memory64, for the 14").
- Code and cache blobs are tied to the load address. At most 64 code ranges; a unit holds at most 250k instructions
  and 8 MB of wasm (more is split over further units).
- Multi-structure LD2/3/4 and ST2/3/4 and everything behind `hlp.vop` are lane-by-lane (correct, slow).
- The speed figures below were taken while other jobs ran on the machine; run-to-run spread is about +-20%.

## Status (last full run, Node 22.23 and headless Chromium 153 full build, x64 with FMA3)

- Gate 1: 169 classes x 2000 cases = 338000 cases, 0 failures; again with `--strictnan --shared --seed 5`, 0 failures.
- Gate 2 (Node): 75 guest images, 75 pass in each of: default, `--budget 50`, `--notail`, `--shared`; also with
  `--precise 2`, `--cntyield` and warm from the translation cache. Feature tests: 9 of 9.
- Gate 2 (Chromium, Worker): 75 pass in default, budget 50, no tail calls, shared memory, cache cold and warm
  (569 units from the Cache API on the warm pass, 0 instructions translated); feature tests 9 of 9.
- Runtime (`npm run rt:test`, `rt:browser`): 25 of 25 and 31 of 31 after the matching edits in `rt_layout.ts`
  (three a64 ranges, `A64` export) and `rt_runtime.ts` (layout option, `fillPcMap` for the stub region).
- Speed, shared corpus, 15 interleaved runs each, total run time min / median ms: default 351 / 495;
  shared 379 / 454; `cntYield` 388 / 530; `preciseFaults: 1` 389 / 507; `preciseFaults: 2` 719 / 921.
  In Chromium, all 75 guests: unshared 298 M guest instructions/s, shared 317 M/s.
- Big guest (1.66 MB image, 404184 instructions, 2602 functions), entry discovery before -> after tightening:
  translated instructions 691506 -> 404184 (1.71x -> 1.00x of the image), wasm 15.4 MB -> 9.6 MB, translate +
  compile 215-263 ms -> 153-204 ms, 25 modules both, largest 663 KB -> 391 KB, pc map 1.9 MB.
- Translation cache on the big guest: Node cold 150 ms of translation + compile, warm 31-36 ms (25 units from a
  12.9 MB file, 0 instructions translated); Chromium cold 138 ms, warm 32 ms.

memory64 (same machine; Node 22.23.4 = V8 12.4, Chromium 153.0.8010):
- memory32 is untouched: `npm run a64:bytes` on the translator built from the tree before the mode and on this one
  gives the same digests: the core module (three variants) and the units of all 75 guests under nine option sets
  (default, no tail calls, shared, cntYield, preciseFaults 1 and 2, guard, no fma / nanFix / rmodeArith, maxInsns
  40 with chunk 0 and depth 0; 70 MB of wasm). Gate 1 and Gate 2 in memory32 as above (338000 cases, 0 failures;
  75 of 75 four times); feature tests 14 of 14 (three added: guard, contexts, mode in key and blob).
- Gate 1 in memory64: 338000 cases, 0 failures; with code and memory window above 4 GB (Unicorn and translator both
  at 0x1_8010_0000 / 0x1_8020_0000): 338000 cases, 0 failures. In `a64:fuzz`: 30082 + 30082 cases, 0 failures.
- Gate 2 in memory64 (Node): 75 of 75; with the images linked at 0x1_8000_0000 (code, data, stack and pc map
  leaves above 4 GB) 75 of 75 in each of default, `--budget 50`, `--shared`, `--notail`; by hand also `--precise 2`,
  `--cntyield` and `--guard 0x08000000` in both placements. Feature tests 17 of 17 in memory64 and 17 of 17 above
  4 GB. `a64:asc64`: 23 of 23.
- Chromium (Worker): 75 of 75 in memory64 default, budget 50, shared, cache cold and warm (569 units from the Cache
  API, 0 instructions translated); above 4 GB 75 of 75 in default, shared, no tail calls; feature tests 14 / 17 / 17.
- Speed, Node, 25 interleaved rounds (`a64:mem64:speed`), M guest instructions/s by the best round / the median
  round / each guest's best round summed: memory32 496 / 391 / 664; memory64 461 / 366 / 634 (run time +7.7 % /
  +7.1 % / +4.8 %); memory64 above 4 GB 463 / 370 / 619 (+7.2 % / +5.7 % / +7.2 %). Per guest (the 50 that run 2 ms
  or more): median +5.0 %, from -10 % to +41 % (a64_sort.O0, memory.O0, mixed_lz.O0 at the top). With the guard at
  0x0800_0000: memory64 +4.0 % / +12.3 % / +7.8 %, above 4 GB +8.4 % / +12.8 % / +10.4 %. With V8's
  `--wasm-memory64-trap-handling`: +4.1 % / +4.9 % / +6.4 %. A guard base above 4 GB (an offset of more than 32
  bits in every memory instruction) costs more: +22 to +27 % with the images above 4 GB; the runtime's guard base
  is in the host area.
- Speed, Chromium, five interleaved rounds, best / median M guest instructions/s, two runs of the gate:
  memory32 343 / 290 and 339 / 313; memory64 307 / 275 and 361 / 343 (-10.6 % / -5.0 %, then +6.6 % / +9.6 %);
  memory64 above 4 GB 291 / 266 and 324 / 294 (-15.2 % / -8.4 %, then -4.5 % / -6.0 %).
- Translator alone (the wasm64 build translating), Chromium: 0.57 to 0.81 us per instruction against 0.49 to 0.66
  for the wasm32 build in the same run. The corpus' units are 6.48 MB against 6.53 MB (no `i32.wrap_i64`); the
  fixed part of the pc map is 2.2 MB against 320 KB.
