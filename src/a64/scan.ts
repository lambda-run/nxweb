// nxweb a64: static scan of a code module. Every 32-bit word of a text segment is put to the translator's own
// decoder (`decode` in unit.ts, the function `translate` uses for each instruction): the answer "implemented" is the
// decoder's and cannot drift from it. A word it rejects is then given a name by `classify` below, which only labels:
// a class of ARM instructions the translator does not have ("SVE (any)", "MRS S3_0_C0_C0_0"), or "not an
// instruction" when the word is no A64 encoding this file knows (literal pools, padding, data in text).
//
// Use (src/glue/a64_scan.ts): init(); scanReset(); then per piece of text: copy it to scanBuf(), scanWords(byte offset
// in the buffer, words, module offset of the first, region). Region 0 is code for certain (inside a function of the
// module's unwind table, or the whole text when it has none), region 1 is text outside every function (may be data).
// Results: scanKinds() kinds, each with scanKind / scanCount / scanFirst / scanName.
// Literal pools: scanLiterals(...) on the code first (same arguments, no region) marks the words a PC-relative load
// (LDR Xt/Wt/St/Dt/Qt, =literal; LDRSW) reads; scanWords then leaves those words out and counts them
// (scanLiteralWords). The caller does this only when it knows what is code (a function table): in text of unknown
// content a data word that looks like such a load would hide other words.
// The buffers are taken from the bump allocator at the first scanReset(), so a translator that never scans (the
// runtime's) keeps its footprint.
import { balloc } from "./emit";
import { probe } from "./unit";

const BUF_CAP: usize = 1 << 20;
const HBITS: u32 = 21;                 // memo of distinct words: word -> kind index
const HSIZE: usize = 1 << HBITS;
const KCAP: i32 = 1024;                // distinct kinds (class + detail) per scan
export const FIRST: i32 = 8;           // offsets kept per kind and region
let buf: usize = 0, hKey: usize = 0, hVal: usize = 0, kKey: usize = 0, kCnt: usize = 0, kFirst: usize = 0, kNFirst: usize = 0, nameBuf: usize = 0;
let nKinds: i32 = 0, hUsed: u32 = 0;
const LIT_SPAN: u32 = 1 << 28;         // literal marks cover module offsets [0, 256 MB): 1 bit per word
let litBits: usize = 0, litOn: bool = false, litWords: u64 = 0;
let total0: u64 = 0, total1: u64 = 0, ok0: u64 = 0, ok1: u64 = 0, dropped: u64 = 0;

// ---- classes. A class below C_REAL is "not an instruction"; from C_REAL on it names instructions that exist.
export const C_UDF: u32 = 0;        // permanently undefined (udf #imm16): padding and deliberate traps
export const C_UNALLOC: u32 = 1;    // no A64 encoding known here
export const C_REAL: u32 = 8;
const C_SVE: u32 = 8, C_SME: u32 = 9, C_MTE: u32 = 10, C_BC: u32 = 11, C_HVC: u32 = 12, C_SMC: u32 = 13, C_HLT: u32 = 14, C_DCPS: u32 = 15, C_TME: u32 = 16, C_ERET: u32 = 17, C_DRPS: u32 = 18,
  C_MSR_PSTATE: u32 = 19, C_FLAGM2: u32 = 20, C_SYS: u32 = 21, C_SYSL: u32 = 22, C_MRS: u32 = 23, C_MSR: u32 = 24, C_UNPRIV: u32 = 25, C_LS64: u32 = 26, C_MOPS: u32 = 27, C_LRCPC3: u32 = 28,
  C_CSSC: u32 = 29, C_SHA512: u32 = 30, C_SHA3: u32 = 31, C_SM: u32 = 32, C_FCMA: u32 = 33, C_JSCVT: u32 = 34, C_FRINTTS: u32 = 35, C_FCVTXN: u32 = 36, C_BF16: u32 = 37, C_I8MM: u32 = 38,
  C_FHM: u32 = 39, C_FP16: u32 = 40, C_FLAGM: u32 = 41, C_LSE: u32 = 42, C_PAUTH: u32 = 43, C_RDM: u32 = 44, C_DOTPROD: u32 = 45, C_RCPC: u32 = 46, C_SIMD_OTHER: u32 = 47, C_FP_OTHER: u32 = 48,
  C_LDST_OTHER: u32 = 49, C_SYS_OTHER: u32 = 50, C_WFXT: u32 = 51, C_GCS: u32 = 52, C_LSE128: u32 = 53, C_PRFM: u32 = 54, C_DPREG_OTHER: u32 = 55;

function className(c: u32): string {
  switch (c) {
    case C_UDF: return "UDF (permanently undefined: padding)";
    case C_UNALLOC: return "not an instruction (data in text, or an encoding newer than this scan)";
    case C_SVE: return "SVE (any)";
    case C_SME: return "SME (any)";
    case C_MTE: return "MTE memory tagging (IRG, ADDG, STG, LDG, ...)";
    case C_BC: return "BC.cond (hinted conditional branch, ARMv8.8)";
    case C_HVC: return "HVC";
    case C_SMC: return "SMC";
    case C_HLT: return "HLT";
    case C_DCPS: return "DCPS1/2/3";
    case C_TME: return "TME transactions (TSTART, TCOMMIT, TCANCEL, TTEST)";
    case C_ERET: return "ERET / ERETAA / ERETAB";
    case C_DRPS: return "DRPS";
    case C_MSR_PSTATE: return "MSR PSTATE field, #imm";
    case C_FLAGM2: return "AXFLAG / XAFLAG (FlagM2, ARMv8.5)";
    case C_SYS: return "SYS";
    case C_SYSL: return "SYSL";
    case C_MRS: return "MRS";
    case C_MSR: return "MSR";
    case C_UNPRIV: return "LDTR / STTR (unprivileged load / store)";
    case C_LS64: return "LD64B / ST64B (LS64)";
    case C_MOPS: return "CPY* / SET* (memory copy and set, ARMv8.8)";
    case C_LRCPC3: return "LDIAPP / STILP / LDAPUR, STLUR on SIMD registers (RCPC3)";
    case C_CSSC: return "CSSC (ABS, CNT, CTZ, SMAX, SMIN, UMAX, UMIN on general registers, ARMv8.9)";
    case C_SHA512: return "SHA-512 (SHA512H, SHA512H2, SHA512SU0, SHA512SU1)";
    case C_SHA3: return "SHA-3 (EOR3, BCAX, RAX1, XAR)";
    case C_SM: return "SM3 / SM4";
    case C_FCMA: return "FCMLA / FCADD (complex numbers, ARMv8.3)";
    case C_JSCVT: return "FJCVTZS (ARMv8.3)";
    case C_FRINTTS: return "FRINT32Z / FRINT32X / FRINT64Z / FRINT64X (ARMv8.5)";
    case C_FCVTXN: return "FCVTXN";
    case C_BF16: return "BF16 (BFDOT, BFMMLA, BFMLAL, BFCVT)";
    case C_I8MM: return "I8MM (SMMLA, UMMLA, USMMLA, USDOT, SUDOT)";
    case C_FHM: return "FMLAL / FMLSL (half to single multiply-add, FHM)";
    case C_FP16: return "half-precision floating point (FP16)";
    case C_FLAGM: return "FlagM (CFINV, RMIF, SETF8, SETF16)";
    case C_LSE: return "LSE atomics (CAS, CASP, SWP, LD<op>)";
    case C_PAUTH: return "pointer authentication";
    case C_RDM: return "SQRDMLAH / SQRDMLSH (RDM)";
    case C_DOTPROD: return "SDOT / UDOT (DotProd)";
    case C_RCPC: return "LDAPR / LDAPUR / STLUR (RCPC)";
    case C_SIMD_OTHER: return "AdvSIMD: an encoding the translator does not have";
    case C_FP_OTHER: return "scalar floating point: an encoding the translator does not have";
    case C_LDST_OTHER: return "load / store: an encoding the translator does not have";
    case C_SYS_OTHER: return "system: an encoding the translator does not have";
    case C_WFXT: return "WFET / WFIT (ARMv8.7)";
    case C_GCS: return "GCS guarded control stack";
    case C_LSE128: return "LSE128 (128-bit atomics)";
    case C_PRFM: return "PRFM with writeback or RPRFM";
    case C_DPREG_OTHER: return "data processing (register): an encoding the translator does not have";
  }
  return "?";
}

// A name for a word the decoder rejected: class | detail << 8. The detail (16 bits) completes the name of the system
// classes (the register or operation), so each system register is a kind of its own.
export function classify(insn: u32): u32 {
  let op0 = (insn >> 25) & 15;
  if (op0 == 0) {
    if (insn >>> 31) return C_SME;
    return (insn >>> 16) == 0 ? C_UDF : C_UNALLOC;
  }
  if (op0 == 2) return C_SVE;
  if (op0 == 1 || op0 == 3) return C_UNALLOC;
  if ((op0 & 14) == 8) {   // data processing, immediate
    if ((insn & 0x7F800000) == 0x11800000) return C_MTE;       // ADDG / SUBG
    return C_UNALLOC;
  }
  if ((op0 & 14) == 10) {  // branches, exceptions, system
    if ((insn & 0xFF000010) == 0x54000010) return C_BC;
    if ((insn & 0xFF000000) == 0xD4000000) {
      let opc = (insn >> 21) & 7, ll = insn & 31;
      if (opc == 0 && ll == 2) return C_HVC;
      if (opc == 0 && ll == 3) return C_SMC;
      if (opc == 2 && ll == 0) return C_HLT;
      if (opc == 3 && ll == 0) return C_TME;
      if (opc == 5 && ll >= 1 && ll <= 3) return C_DCPS;
      return C_UNALLOC;
    }
    if ((insn & 0xFFC00000) == 0xD5000000) {
      let L = (insn >> 21) & 1, o0 = (insn >> 19) & 3, key = (insn >> 5) & 0xFFFF;
      if (o0 == 0) {
        if (L) return (insn & 0xFFFFF000) == 0xD5233000 ? C_TME : C_UNALLOC;      // TSTART / TTEST
        let crn = (insn >> 12) & 15, op1 = (insn >> 16) & 7, op2 = (insn >> 5) & 7;
        if (crn == 4) {
          if ((insn & 31) != 31) return C_UNALLOC;
          if (op1 == 0 && op2 == 0) return C_FLAGM;
          if (op1 == 0 && (op2 == 1 || op2 == 2)) return C_FLAGM2;
          return C_MSR_PSTATE | ((op1 << 3 | op2) << 8);
        }
        if (crn == 3 && (insn & 31) == 31) return op2 == 3 ? C_TME : C_SYS_OTHER;
        if (crn == 1 && (insn & 0xFFFFFFC0) == 0xD5031000) return C_WFXT;
        return C_UNALLOC;
      }
      if (o0 == 1) return (L ? C_SYSL : C_SYS) | ((key & 0x3FFF) << 8);
      return (L ? C_MRS : C_MSR) | (key << 8);
    }
    if ((insn & 0xFE000000) == 0xD6000000) {
      if ((insn & 0xFFFFFFFF) == 0xD69F03E0 || (insn & 0xFFFFFBFF) == 0xD69F0BFF) return C_ERET;
      if (insn == 0xD6BF03E0) return C_DRPS;
      if ((insn & 0xFE9FF800) == 0xD61F0800) return C_PAUTH;
      return C_UNALLOC;
    }
    return C_UNALLOC;
  }
  if ((op0 & 5) == 4) {    // loads and stores
    let V = (insn >> 26) & 1;
    if ((insn & 0x3F000000) == 0x08000000) {                 // exclusives, CAS
      if ((insn & 0x00A00000) == 0x00A00000 || ((insn & 0x80A00000) == 0x00200000)) return ((insn >> 10) & 31) == 31 ? C_LSE : C_UNALLOC;
      return C_UNALLOC;
    }
    if ((insn & 0xBF000000) == 0x0C000000 || (insn & 0xBF000000) == 0x0D000000) return C_UNALLOC;   // AdvSIMD structures: reserved forms
    if ((insn & 0x3B200C00) == 0x19000400 && !V) return C_MOPS;                                    // CPY*
    if ((insn & 0x3B200C00) == 0x19000400 && V) return C_MOPS;                                     // SET*
    if ((insn & 0xFF200000) == 0xD9200000 || (insn & 0xFE400000) == 0x68000000) return C_MTE;      // STG.. / LDG, STGP
    if ((insn & 0x3F200C00) == 0x19000000) return V ? C_LRCPC3 : C_RCPC;
    if ((insn & 0x3F200C00) == 0x19000800) return V ? C_UNALLOC : C_LRCPC3;
    if ((insn & 0x3B000000) == 0x38000000) {
      if ((insn & 0x00200C00) == 0x00000800) return V ? C_UNALLOC : C_UNPRIV;
      if ((insn & 0x00200C00) == 0x00200000) {               // atomic memory operations
        if (V) return C_UNALLOC;
        let o3 = (insn >> 15) & 1, opc = (insn >> 12) & 7;
        if ((insn & 0xFFE0FC00) == 0xF83F9000 || (insn & 0xFFE0FC00) == 0xF83FD000 || (insn & 0xFFE0FC00) == 0xF820A000 || (insn & 0xFFE0FC00) == 0xF820B000) return C_LS64;
        if (o3 && opc == 4) return C_RCPC;
        if (!o3 || opc == 0) return C_LSE;
        if ((insn >>> 30) == 0 && o3 && (opc == 1 || opc == 3)) return C_LSE128;
        return C_UNALLOC;
      }
      if ((insn & 0x00200400) == 0x00200400) return (insn >>> 30) == 3 && !V ? C_PAUTH : C_UNALLOC;
      if ((insn >>> 30) == 3 && ((insn >> 22) & 3) == 2 && !V) return C_PRFM;
      return C_UNALLOC;
    }
    if ((insn & 0x3B000000) == 0x39000000) return C_UNALLOC;
    if ((insn & 0x3A000000) == 0x28000000) return C_UNALLOC;
    return C_LDST_OTHER;
  }
  if ((op0 & 7) == 5) {    // data processing, register
    if ((insn & 0x1FE00000) == 0x1AC00000) {
      let opcode = (insn >> 10) & 63, S = (insn >> 29) & 1;
      if ((insn & 0x40000000) != 0) {            // one source
        let o2 = (insn >> 16) & 31;
        if (o2 == 1) return C_PAUTH;
        if (o2 == 0 && opcode >= 6 && opcode <= 8 && !S) return C_CSSC;
        return C_UNALLOC;
      }
      if (opcode == 12) return C_PAUTH;
      if (opcode == 0 || opcode == 4 || opcode == 5) return (insn >>> 31) ? C_MTE : C_UNALLOC;
      if (opcode >= 24 && opcode <= 27 && !S) return C_CSSC;
      return C_UNALLOC;
    }
    if ((insn & 0x1FE00000) == 0x1A000000) {
      let lo = (insn >> 10) & 63;
      if ((lo & 31) == 1 || (lo & 15) == 2) return C_FLAGM;
      return C_UNALLOC;
    }
    if ((insn & 0x7FE00C00) == 0x11C00000 >>> 0) return C_CSSC;
    return C_UNALLOC;
  }
  // SIMD and floating point
  if ((insn & 0xFF000000) == 0xCE000000) {
    if ((insn & 0xFFE0B000) == 0xCE608000 || (insn & 0xFFFFF800) == 0xCEC08000) {
      if ((insn & 0xFFE0FC00) == 0xCE608C00) return C_SHA3;                     // RAX1
      if ((insn & 0xFFFFFC00) == 0xCEC08400) return C_SM;                       // SM4E
      return C_SHA512;
    }
    if ((insn & 0xFF808000) == 0xCE000000 && ((insn >> 21) & 3) != 2) return C_SHA3;   // EOR3, BCAX
    if ((insn & 0xFFE00000) == 0xCE800000) return C_SHA3;                               // XAR
    return C_SM;
  }
  if ((insn & 0xFFFFFC00) == 0x1E7E0000) return C_JSCVT;
  if ((insn & 0xFF3E7C00) == 0x1E284000 || (insn & 0x9FBFEC00) == 0x0E21E800) return C_FRINTTS;
  if ((insn & 0xBFBFFC00) == 0x2E216800 || (insn & 0xFFBFFC00) == 0x7E216800) return C_FCVTXN;
  if ((insn & 0x9F208400) == 0x0E008400) {       // three-same extra (bit 15 = 1, bit 10 = 1, bit 21 = 0)
    let opc = (insn >> 11) & 15, U = (insn >> 29) & 1;
    if (opc <= 1) return U ? C_RDM : C_UNALLOC;
    if (opc == 2) return ((insn >> 22) & 3) == 2 ? C_DOTPROD : C_UNALLOC;
    if (opc == 3) return C_I8MM;                 // USDOT
    if (opc == 4 || opc == 5) return C_I8MM;     // SMMLA / UMMLA / USMMLA
    if (opc >= 8 && opc <= 15) return U ? (opc == 15 || opc == 13 ? C_BF16 : C_FCMA) : C_UNALLOC;
    return C_UNALLOC;
  }
  if ((insn & 0xBF000400) == 0x0F000000) {       // vector by element
    let opc = (insn >> 12) & 15, U = (insn >> 29) & 1, sz = (insn >> 22) & 3;
    if (U && (opc & 9) == 1 && sz != 0 && sz != 3) return C_FCMA;
    if (U && (opc == 13 || opc == 15)) return C_RDM;
    if (opc == 14) return sz == 2 ? C_DOTPROD : C_SIMD_OTHER;
    if (opc == 15 && !U) return sz == 1 || sz == 3 ? C_BF16 : C_I8MM;
    if ((opc == 0 || opc == 4) && !U && sz == 2) return C_FHM;
    if ((opc == 8 || opc == 12) && U && sz == 2) return C_FHM;
    if ((opc == 1 || opc == 5 || opc == 9) && sz == 0) return C_FP16;
    return C_SIMD_OTHER;
  }
  if ((insn & 0xDF000400) == 0x5F000000) {       // scalar by element
    let opc = (insn >> 12) & 15, U = (insn >> 29) & 1, sz = (insn >> 22) & 3;
    if (U && (opc == 13 || opc == 15)) return C_RDM;
    if ((opc == 1 || opc == 5 || opc == 9) && sz == 0) return C_FP16;
    return C_SIMD_OTHER;
  }
  if ((insn & 0x5F200000) == 0x1E200000 || (insn & 0x5F200000) == 0x1E000000 || (insn & 0x5F000000) == 0x1F000000) {   // scalar FP
    return ((insn >> 22) & 3) == 3 ? C_FP16 : ((insn >> 22) & 3) == 2 ? C_UNALLOC : C_FP_OTHER;
  }
  if ((insn & 0x9F000000) == 0x0E000000 || (insn & 0x9F000000) == 0x0F000000 || (insn & 0xDF000000) == 0x5E000000 || (insn & 0xDF000000) == 0x5F000000) {
    if ((insn & 0x9F60C400) == 0x0E400400) return C_FP16;                              // three-same FP16
    if ((insn & 0x9F7E0C00) == 0x0E780800) return C_FP16;                              // two-register FP16
    if ((insn & 0x9FBE0C00) == 0x0E300800 && ((insn >> 12) & 31) >= 12) return C_FP16; // across / pairwise FP16
    if ((insn & 0x9F20EC00) == 0x0E20CC00) return C_FHM;
    return C_SIMD_OTHER;
  }
  return C_UNALLOC;
}

// ---- the scan
export function scanBuf(): usize { return buf; }
export function scanBufSize(): u32 { return <u32>BUF_CAP; }
export function scanReset(): void {
  if (buf == 0) {
    buf = balloc(BUF_CAP); hKey = balloc(HSIZE << 2); hVal = balloc(HSIZE << 1);
    kKey = balloc(<usize>KCAP << 2); kCnt = balloc(<usize>KCAP << 4); kFirst = balloc(<usize>KCAP * FIRST * 8); kNFirst = balloc(<usize>KCAP << 3);
    nameBuf = balloc(256);
    litBits = balloc(LIT_SPAN >> 5);
  }
  if (litOn) memory.fill(litBits, 0, LIT_SPAN >> 5);
  litOn = false; litWords = 0;
  memory.fill(hVal, 0, HSIZE << 1);
  memory.fill(kCnt, 0, <usize>KCAP << 4); memory.fill(kNFirst, 0, <usize>KCAP << 3);
  nKinds = 0; hUsed = 0; total0 = 0; total1 = 0; ok0 = 0; ok1 = 0; dropped = 0;
}
function kindIndex(kind: u32): i32 {
  for (let i = 0; i < nKinds; i++) if (load<u32>(kKey + (<usize>i << 2)) == kind) return i;
  if (nKinds >= KCAP) return -1;
  store<u32>(kKey + (<usize>nKinds << 2), kind);
  return nKinds++;
}
// 0 = implemented, k + 1 = kind index k, -1 = rejected but the kind table is full
function lookup(w: u32): i32 {
  let h = <usize>((w * 0x9E3779B1) >>> (32 - HBITS));
  while (true) {
    let v = <i32>load<u16>(hVal + (h << 1));
    if (v == 0) break;
    if (load<u32>(hKey + (h << 2)) == w) return v - 1;
    h = (h + 1) & (HSIZE - 1);
  }
  let r: i32 = 0;
  if (!probe(w)) { let k = kindIndex(classify(w)); r = k < 0 ? -1 : k + 1; }
  if (hUsed < <u32>(HSIZE - (HSIZE >> 2)) && r >= 0) { store<u32>(hKey + (h << 2), w); store<u16>(hVal + (h << 1), <u16>(r + 1)); hUsed++; }
  return r;
}
// @ts-ignore
@inline function litMark(o: u32): void { if (o < LIT_SPAN) { let q = litBits + (o >> 5); store<u8>(q, <u8>(<u32>load<u8>(q) | (<u32>1 << ((o >> 2) & 7)))); } }
// @ts-ignore
@inline function litIs(o: u32): bool { return o < LIT_SPAN && ((load<u8>(litBits + (o >> 5)) >> ((o >> 2) & 7)) & 1) != 0; }
// n words of code at scanBuf() + at, the first at module offset `off`: mark what their PC-relative loads read
export function scanLiterals(at: u32, n: u32, off: u32): void {
  let p = buf + <usize>at;
  litOn = true;
  for (let i: u32 = 0; i < n; i++) {
    let w = load<u32>(p + (<usize>i << 2));
    if ((w & 0x3B000000) != 0x18000000) continue;
    let opc = w >>> 30, V = (w >> 26) & 1;
    if (opc == 3) continue;                                    // PRFM (literal) reads nothing
    let words: u32 = V ? (<u32>1 << opc) : (opc == 1 ? 2 : 1);  // S, D, Q: 1, 2, 4 words; W / SW: 1; X: 2
    let t = off + (i << 2) + <u32>((<i32>(w << 8) >> 13) << 2);
    for (let k: u32 = 0; k < words; k++) litMark(t + (k << 2));
  }
}
export function scanLiteralWords(): f64 { return <f64>litWords; }
// n words at scanBuf() + at; `off` is the module offset of the first; region 0 = code for certain, 1 = may be data
export function scanWords(at: u32, n: u32, off: u32, region: i32): void {
  let p = buf + <usize>at;
  let okN: u64 = 0, lit: u32 = 0;
  for (let i: u32 = 0; i < n; i++) {
    if (litOn && litIs(off + (i << 2))) { lit++; continue; }
    let r = lookup(load<u32>(p + (<usize>i << 2)));
    if (r == 0) { okN++; continue; }
    if (r < 0) { dropped++; continue; }
    let k = <usize>(r - 1);
    let c = kCnt + (k << 4) + (<usize>region << 3);
    store<u64>(c, load<u64>(c) + 1);
    let nf = kNFirst + (k << 3) + (<usize>region << 2);
    let m = load<u32>(nf);
    if (m < <u32>FIRST) { store<u32>(kFirst + ((k * FIRST * 2 + <usize>region * FIRST + m) << 2), off + (i << 2)); store<u32>(nf, m + 1); }
  }
  litWords += lit; n -= lit;
  if (region) { total1 += n; ok1 += okN; } else { total0 += n; ok0 += okN; }
}
export function scanKinds(): i32 { return nKinds; }
export function scanKind(k: i32): u32 { return load<u32>(kKey + (<usize>k << 2)); }
export function scanCount(k: i32, region: i32): f64 { return <f64>load<u64>(kCnt + (<usize>k << 4) + (<usize>region << 3)); }
export function scanFirstCount(k: i32, region: i32): u32 { return load<u32>(kNFirst + (<usize>k << 3) + (<usize>region << 2)); }
export function scanFirst(k: i32, region: i32, i: i32): u32 { return load<u32>(kFirst + ((<usize>k * FIRST * 2 + <usize>region * FIRST + <usize>i) << 2)); }
export function scanTotal(region: i32): f64 { return <f64>(region ? total1 : total0); }
export function scanImplemented(region: i32): f64 { return <f64>(region ? ok1 : ok0); }
export function scanDropped(): f64 { return <f64>dropped; }
export function scanIsInstruction(kind: u32): i32 { return (kind & 0xFF) >= C_REAL ? 1 : 0; }

let np: usize = 0;
function ch(c: i32): void { if (np < nameBuf + 250) { store<u8>(np, <u8>c); np++; } }
function str(s: string): void { for (let i = 0; i < s.length; i++) ch(s.charCodeAt(i)); }
function num(v: u32): void { if (v >= 10) num(v / 10); ch(48 + v % 10); }
function sysregAlias(key: u32): string {
  switch (key) {     // o0(2) op1(3) CRn(4) CRm(4) op2(3), o0 as the instruction holds it (bit 20 set: op0 = 3)
    case 0xC000: return "MIDR_EL1"; case 0xC005: return "MPIDR_EL1"; case 0xC006: return "REVIDR_EL1";
    case 0xC080: return "SCTLR_EL1"; case 0xC081: return "ACTLR_EL1"; case 0xC082: return "CPACR_EL1";
    case 0xC100: return "TTBR0_EL1"; case 0xC101: return "TTBR1_EL1"; case 0xC102: return "TCR_EL1";
    case 0xC200: return "SPSR_EL1"; case 0xC201: return "ELR_EL1"; case 0xC208: return "SP_EL0"; case 0xC212: return "CurrentEL";
    case 0xC213: return "PAN"; case 0xC214: return "UAO"; case 0xDA15: return "DIT"; case 0xDA16: return "SSBS"; case 0xDA17: return "TCO";
    case 0xDA11: return "DAIF"; case 0xC210: return "SPSel";
    case 0xC600: return "VBAR_EL1"; case 0xC684: return "TPIDR_EL1"; case 0xC681: return "CONTEXTIDR_EL1";
    case 0xC800: return "CCSIDR_EL1"; case 0xC801: return "CLIDR_EL1"; case 0xD000: return "CSSELR_EL1";
    case 0xDF10: return "CNTP_TVAL_EL0"; case 0xDF11: return "CNTP_CTL_EL0"; case 0xDF12: return "CNTP_CVAL_EL0";
    case 0xDF18: return "CNTV_TVAL_EL0"; case 0xDF19: return "CNTV_CTL_EL0"; case 0xDF1A: return "CNTV_CVAL_EL0";
    case 0xDCE0: return "PMCR_EL0"; case 0xDCE8: return "PMCCNTR_EL0"; case 0xDE85: return "TPIDR2_EL0"; case 0xD920: return "RNDR"; case 0xD921: return "RNDRRS";
    case 0xDA22: return "FPMR"; case 0xDA24: return "SVCR"; case 0x9828: return "DBGDTR_EL0";
  }
  return "";
}
// the name of kind k as ASCII at the returned address; scanNameLen() bytes
let nameLen: u32 = 0;
export function scanName(k: i32): usize {
  let kind = scanKind(k), c = kind & 0xFF, d = kind >>> 8;
  np = nameBuf;
  str(className(c));
  if (c == C_MRS || c == C_MSR) {
    ch(32); str("S"); num(2 + ((d >> 14) & 1)); ch(95); num((d >> 11) & 7); str("_C"); num((d >> 7) & 15); str("_C"); num((d >> 3) & 15); ch(95); num(d & 7);
    let a = sysregAlias(d | 0x8000);
    if (a.length) { str(" ("); str(a); ch(41); }
  } else if (c == C_SYS || c == C_SYSL) {
    str(" #"); num((d >> 11) & 7); str(", C"); num((d >> 7) & 15); str(", C"); num((d >> 3) & 15); str(", #"); num(d & 7);
  } else if (c == C_MSR_PSTATE) {
    str(" (op1 "); num((d >> 3) & 7); str(", op2 "); num(d & 7); ch(41);
  }
  nameLen = <u32>(np - nameBuf);
  return nameBuf;
}
export function scanNameLen(): u32 { return nameLen; }
