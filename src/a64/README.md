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
| `index.ts` | exports: `init, setOpt, codeBuf, setCode, entryBuf, translate, outPtr, metaBuf, buildCore, probe` |

**Core module** (`buildCore()`, bytes produced by the same encoder). Imports `env.memory`,
`env.table`, `env.translate(pc: i64) -> i32`. Defines and exports the contract globals (`x0..x30, sp,
pc, nf, zf, cf, vf, v0..v31, fpcr, fpsr, tpidr, tpidrro, excl_addr, excl_val, budget`, plus
`excl_val2`), `save_ctx/load_ctx` (contract layout), `run()`, `stop`, `trampoline`, `crc32`.
Table index 0 is the trampoline (`if pc >= 0xFFFF_FF00 return; return_call_indirect(translate(pc))`),
index 1 is `stop` (sets `budget = -1`, which makes every frame unwind and `run()` return; the glue's
`translate` returns 1 when it does not want to continue). `run()` loops
`while (pc < 0xFFFF_FF00 && budget >= 0) call_indirect(pcmap[pc])`.

**pc map.** A flat `u32` array in guest memory, one entry per guest instruction of the code range
`[codeLo, codeLo + mapSize)`: `index = load32(pcmapBase + ((pc - codeLo) & ~3))`, 0 (trampoline)
outside the range. The three numbers are translator options baked into the generated code.

**Translation unit** = list of entry pcs -> one wasm module importing memory, table, the `cpu.*`
globals, `env.svc/unimpl/brk/cntpct`, `cpu.crc32` and `env.table_base`; its functions are placed in
the table by an active element segment at `table_base`. `metaBuf()` lists the function pcs so the
glue can fill the pc map. BL targets inside the code window are added to the unit (up to
`maxFuncs`) and become direct `call`s; everything else is an indirect transfer by the protocol.

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
`pc` and return; other BRs and out-of-function B are wasm tail calls.

**Flags** are four i32 locals/globals. A `SUBS/CMP` additionally keeps its operands in dedicated
locals so that a following `b.cond`/`csel`/`cset`/`ccmp` in the same block is emitted as one direct
comparison; dead flag computations are left to the wasm engine's optimizer.

**Memory.** Address = `i32.wrap_i64`. W-register writes zero-extend. Exclusives record address and
value(s) in `excl_addr`/`excl_val` (`excl_val2` for the second word of a pair); the store succeeds
only if the address matches and memory still holds the recorded value. LDAR/STLR are plain.

**Floating point.** Scalar ops work on lane 0 of the v128 and zero the upper bits on write. FMADD
family and vector FMLA/FMLS use relaxed-simd `relaxed_madd/nmadd` (option `fma`, default on; off =
separate multiply and add). Round-to-nearest is assumed; FPCR is stored but ignored; FPSR is stored
but never updated by arithmetic.

**System.** NOP/hints, barriers, CLREX, MRS/MSR for TPIDR_EL0, TPIDRRO_EL0 (read), FPCR, FPSR, NZCV,
CNTPCT_EL0/CNTVCT_EL0 (import `cntpct`), CNTFRQ_EL0 (19200000), DCZID_EL0 (4), CTR_EL0 (0x8444C004),
DC ZVA, other DC/IC ops as no-ops, SVC (import `svc`), BRK (import `brk(pc, imm)`). Anything
undecodable compiles to `unimpl(pc, insn)`; after `unimpl`/`brk` return, the function sets
`budget = -1` and returns with `pc` at the offending instruction.

## Running the gates

```
npm run a64:build            # asc -> build/a64/translator.wasm
npm run a64:fuzz             # Gate 1: differential fuzz against Unicorn (python3 test/a64/fuzz.py)
    python3 test/a64/fuzz.py --cases 2000 --only 'simd_' --show 4 [--nofma] [--seed N]
npm run a64:guests           # Gate 2: every guest in test/guests/out and test/a64/guests/out,
                             #         then the same again with budget=50 (forced preemption)
npm run a64:speed            # per-guest guest-instructions/second and translation time
python3 test/a64/coverage.py # corpus instruction words the translator rejects, by mnemonic
```

Gate 1 (`test/a64/fuzz*.py`, `fuzz_run.ts`): per instruction class a generator produces random valid
encodings, random register/flag/vector state and a 4 KB memory window; each case is executed on
Unicorn (Cortex-A57 model, one instruction, or a short sequence for exclusives) and then translated
with `maxInsns=1` and run under Node. Compared: x0..x30, sp, pc, NZCV, FPCR, TPIDR, v0..v31 and the
memory window. Floats are compared bitwise except that NaN == NaN for the class's lane type.
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
  FCVT s<->d, FCVT{N,P,M,Z,A}{S,U} to W/X, SCVTF/UCVTF from W/X, fixed-point SCVTF/UCVTF/FCVTZS/FCVTZU,
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
- Scalar-in-SIMD forms: ADD/SUB d, CM* d, ABS/NEG d, SHL/SSHR/USHR/SSRA/USRA/... d, SSHL/USHL/SRSHL/
  URSHL d, SQADD/UQADD/SQSUB/UQSUB, SQABS/SQNEG, SQSHL/UQSHL/SQSHLU #imm, SQDMULH/SQRDMULH, ADDP d,
  FADDP/FMAXP/FMINP/FMAXNMP/FMINNMP, FCM*/FAC*/FABD, FCVT*/SCVTF/UCVTF, FMUL/FMLA/FMLS by element.

## Known gaps

Not translated (compile to `unimpl`, reported only if executed):
- FRECPE/FRSQRTE/URECPE/URSQRTE/FRECPS/FRSQRTS/FRECPX/FMULX (guest `neon_estimate` fails on these).
- Half-precision FP (FCVT to/from h, fp16 arithmetic), FCVTXN, FJCVTZS.
- PMUL/PMULL, crypto extensions (AES/SHA), SQDMULL/SQDMLAL/SQDMLSL, SQRSHL/UQRSHL/SQSHL/UQSHL by
  register, SUQADD/USQADD, scalar saturating narrows (SQXTN b/h/s etc.), URECPE.
- LSE atomics (CAS, LDADD, SWP, ...; not on the Switch CPU), pointer authentication BR/BLR/RET forms,
  MSR PSTATE (DAIF/SPSel), LDTR/STTR, BC.cond, SVE/SME, any system register not listed above.

Behavioural differences:
- NaNs: generated NaNs have the host sign/payload (x86 produces 0xFFF8.. where ARM produces the
  default NaN 0x7FF8..), and NaN propagation follows the host (guest `fp_nan_bits` fails).
- Rounding mode: always round-to-nearest-even; FPCR.RMode/FZ/DN are stored but ignored (guest
  `fpcr_modes` fails). FRINTX/FRINTI round to nearest. FPSR cumulative flags and QC are never set.
- FMADD/FMLA are fused only when the engine's relaxed-simd madd is fused (true on x64 with FMA3 and
  on arm64). With `fma` off they are unfused.
- Exclusives are compare-and-store on plain memory, not atomic across wasm threads.
- Guest recursion uses the wasm stack: a few thousand nested guest calls exhaust the default Node
  stack (the npm scripts pass `--stack-size=3000`). A wasm trap (out-of-bounds access, stack
  overflow) leaves registers cached in locals unwritten.
- Only `br x30` unwinds like RET; a longjmp/fiber switch implemented with another `br xN` keeps the
  abandoned wasm frames alive until the target continuation returns.
- One code window at a time (`setCode`); no self-modifying-code detection (`A64Host.invalidate()`
  drops all translations). Wasm memory offsets are used for the pc map, so the map must stay put.
- Multi-structure LD2/3/4 and ST2/3/4 are lane-by-lane (correct but slow).
