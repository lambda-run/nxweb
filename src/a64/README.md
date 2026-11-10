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

**pc map.** A flat `u32` array in guest memory, one entry per guest instruction of the code range
`[codeLo, codeLo + mapSize)`: `index = load32(pcmapBase + ((pc - codeLo) & ~3))`, 0 (trampoline)
outside the range. The three numbers are translator options baked into the generated code.

**Translation unit** = list of entry pcs -> one wasm module importing memory, table, the `cpu.*`
globals, `env.svc/unimpl/brk/cntpct`, `cpu.crc32`, the `hlp.*` helpers and `env.table_base`; its functions are placed in
the table by an active element segment at `table_base`. `metaBuf()` lists the function pcs so the
glue can fill the pc map. BL targets inside the code window are added to the unit (up to
`maxFuncs`) and become direct `call`s; everything else is an indirect transfer by the protocol.

**Unit size (region mode, default).** `setCode` scans the window once for function entries (every BL
target, the instruction after each RET, aligned 8-byte words pointing into the window). When a pc
needs translating, the unit also takes every not-yet-translated entry of the same 64 KB chunk
(`chunk` option, `maxFuncs` 1024). The translator remembers which pcs are translated, so nothing is
translated twice and a BL to an already translated function goes through the pc map. Chosen from
the larger-code check below: one module per function costs about 230 KB of engine memory per module;
64 KB chunks give modules of 0.2-0.7 MB, the lowest total translate+compile time and 4x less memory.

**Function discovery.** From an entry pc, follow direct branches (B, B.cond, CBZ, TBZ) inside a
+-256 KB window; BL/BLR/SVC fall through; BR/RET/BRK end a path. The size cap (`maxInsns`, default
1500) stops discovery; a branch or fallthrough to an address outside the function becomes a tail
transfer (`pc = target; return_call_indirect pcmap[target]`). `maxInsns = 1` gives one function per
instruction (used by the fuzz gate).

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
npm run a64:build            # asc -> build/a64/translator.wasm and build/a64/helpers.wasm
npm run a64:fuzz             # Gate 1: differential fuzz against Unicorn (python3 test/a64/fuzz.py)
    python3 test/a64/fuzz.py --cases 2000 --only 'simd_' --show 4 [--nofma] [--seed N]
npm run a64:guests           # Gate 2: every guest in test/guests/out and test/a64/guests/out, then again with
                             #         budget=50 (forced preemption), then again without wasm tail calls
npm run a64:browser          # Gate 2 in headless Chromium (Playwright), translator in a Worker; same three passes
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
- NaNs: with `nanFix` on the fuzz gate is bit-exact including NaNs on this x64 host. Operations
  outside the list above (conversions, FRINT, FABS/FNEG, compares) rely on the host, which matches
  ARM on x64 for every fuzzed class.
- FMADD/FMLA/FRECPS/FRSQRTS and the directed-rounding helpers are exact only when the engine's
  relaxed-simd madd is fused (x64 with FMA3, arm64). With `fma` off the translator emits unfused code.
- Exclusives are compare-and-store on plain memory, not atomic across wasm threads.
- A wasm trap (out-of-bounds access) leaves registers cached in locals unwritten.
- One code window at a time (`setCode`); no self-modifying-code detection (`A64Host.invalidate()`
  drops all translations). Wasm memory offsets are used for the pc map, so the map must stay put.
- Region mode's "after RET" entry heuristic also starts functions at mid-function blocks that follow
  an early return; such code is translated twice (about 70% extra wasm on the synthetic big guest).
- Multi-structure LD2/3/4 and ST2/3/4 and everything behind `hlp.vop` are lane-by-lane (correct, slow).

## Status (last full run, Node 22.23 and headless Chromium 153, x64 with FMA3)

- Gate 1: 169 classes x 2000 cases = 338000 cases, 0 failures; the same with `--strictnan --seed 3`.
- Gate 2 (Node): 75 guest images (61 shared corpus + 14 own): 75 pass with the default budget, with
  `--budget 50`, and with `--notail`; no raised `--stack-size`.
- Gate 2 (Chromium, Worker): 75 pass in the same three configurations.
- Speed, all 75 guests (275.7 M guest instructions): Node 343-494 M instructions/s, Chromium 339 M/s;
  translation 1.2-1.7 us per guest instruction including wasm compile + instantiate (translator alone
  0.39-0.49 us).
- Cost of options on the shared corpus (21 runs each, min / median of total run time, ms):
  default 325-331 / 360-378; `--nonan` 336 / 370; `--normarith` 326 / 360; both off 314 / 348;
  on the FP-heavy subset (fp_scalar, neon, vec_auto) default 85 / 100, `--normarith` 77 / 95, both off 79 / 87.
- Larger-code check (`npm run a64:big`: 1.66 MB image, 404k instructions, 2602 functions):

  | unit policy | modules | largest module | wasm total | translate + compile | process RSS |
  | --- | --- | --- | --- | --- | --- |
  | one function per unit (round 1 behaviour incl. duplicates) | 2601 | 42 KB | 25.2 MB | 3823 ms | 1160 MB |
  | one function per unit, no duplicates | 2601 | 11 KB | 12.1 MB | 2089 ms | 591 MB |
  | 16 KB chunks | 100 | 181 KB | 15.5 MB | 294 ms | 160 MB |
  | 64 KB chunks (default) | 25 | 663-704 KB | 15.4-16.3 MB | 215-263 ms | 139-145 MB |
  | 256 KB chunks | 7 | 2.5 MB | 15.4 MB | 232 ms | 136 MB |

  V8 accepted every module size tried (up to 4.7 MB in one module). Translator memory is 98 MB (fixed buffers).
