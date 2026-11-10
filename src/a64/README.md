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
| `index.ts` | exports: `init, setOpt, codeBuf, setCode, resetDone, entryBuf, translate, outPtr, metaBuf, buildCore, probe` |
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

**Memory.** Address = `i32.wrap_i64`. W-register writes zero-extend. Exclusives record address and
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
npm run a64:build            # asc -> build/a64/{translator,helpers}{,.shared}.wasm
npm run a64:extra            # feature tests: fault pcs, code ranges, cntpct yield, cache, shared exclusives
npm run a64:fuzz             # Gate 1: differential fuzz against Unicorn (python3 test/a64/fuzz.py)
    python3 test/a64/fuzz.py --cases 2000 --only 'simd_' --show 4 [--nofma] [--seed N]
npm run a64:guests           # Gate 2: every guest in test/guests/out and test/a64/guests/out, then again with
                             #         budget=50, without wasm tail calls, on a shared memory; then a64:extra
npm run a64:browser          # the same in headless Chromium (full build, Playwright channel "chromium"), in a
                             #         Worker, plus cache cold/warm (Cache API), the big guest and the feature tests
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
`test/a64/guests/build.py` (expected output from `tools/ref_run.py`).

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

## Known gaps

Not translated (compile to `unimpl`, reported only if executed):
- Half-precision arithmetic (fp16 is not on the Switch CPU), FCVTXN, FJCVTZS, vector FCVT*/SCVTF on halves.
- LSE atomics (CAS, LDADD, SWP, ...; not on the Switch CPU), pointer authentication BR/BLR/RET forms,
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
