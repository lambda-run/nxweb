// nxweb a64: shared emitter state (AssemblyScript).
// Byte writer, wasm opcode helpers, guest register cache (wasm locals), event log used by the
// write-back / reload analysis, and the control-flow protocol helpers.

// ---------------------------------------------------------------------------------------------
// memory: this module lives in the embedder's linear memory (asc --importMemory --memoryBase). Everything it
// keeps there is static data plus what this bump allocator hands out at start; nothing is allocated later and
// the memory is never grown from here (the stub runtime's allocator is not used: it mis-computes on a 4 GB memory).
let bump: usize = 0;
export function balloc(size: usize): usize {
  if (bump == 0) bump = (__heap_base + 15) & ~15;
  let p = bump;
  bump += (size + 15) & ~15;
  return p;
}
export function ballocEnd(): usize { return bump; }
// a StaticArray laid out by hand (the 16-byte object header only needs its byte length); relies on zeroed memory
export function mk<T>(n: i32): StaticArray<T> {
  let bytes = <usize>n << alignof<T>();
  let p = balloc(bytes + 16) + 16;
  store<u32>(p - 4, <u32>bytes);
  return changetype<StaticArray<T>>(p);
}

// ---------------------------------------------------------------------------------------------
// memory64: a translator built for wasm64 (tools/asc64; usize is 64 bits) reads guest code anywhere in an i64 memory
// and emits units for an i64 memory: guest addresses are used whole (no i32.wrap_i64), the pc map is indexed with the
// whole pc. One build is one mode; the wasm32 build compiles none of the M64 branches and emits what it always did.
// @ts-ignore
@inline export const M64: bool = sizeof<usize>() == 8;

// ---------------------------------------------------------------------------------------------
// options (addresses are usize: 32 bits in the wasm32 build, 64 in the wasm64 build, set there with setOptAddr)
export let optPcmapBase: usize = 0; // address of the pc map's first level: one leaf address per 64 KB of guest address space (wasm32: 65536 u32; memory64: optPcSpan / 64 KB + 1 u64)
export let optEntryBase: usize = 0; // address of the entry bitmap (1 bit per instruction of the code region)
export let optRegionLo: usize = 0;  // code region covered by the entry bitmap
export let optRegionSize: usize = 0;
export let optPcSpan: u64 = <u64>1 << 34;   // memory64: the guest addresses [0, optPcSpan) the pc map's first level covers (a multiple of 64 KB); a pc beyond it has no translation
export let optMaxPages: u32 = 262144;       // memory64, shared: the maximum the modules declare for the imported memory (pages)
export let optMaxInsns: i32 = 1500; // function size cap
export let optMaxFuncs: i32 = 1024; // functions per unit (entries + region entries + auto-added BL targets)
export let optFma: bool = true;     // relaxed-simd fused multiply-add
export let optTail: bool = true;    // wasm tail calls for jumps
export let optNan: bool = true;     // ARM NaN generation/propagation fix-up on FP arithmetic
export let optChunk: u32 = 65536;   // region mode: a unit also takes the untranslated known entries in the entry's chunk (bytes, power of two; 0 = off)
export let optRmArith: bool = true; // FP arithmetic honours FPCR.RMode/FZ/DN (one FPCR test per operation; off = always RN, FZ/DN ignored)
export let optDepth: i32 = 160;     // nested guest calls before a call unwinds through the run loop (0 = off)
export let optShared: bool = false; // modules import a shared memory; exclusives and LDAR/STLR are atomic
export let optCntYield: bool = false; // `mrs cntpct_el0` is a yield point (write back, pc = the instruction, pc check after the import)
export let optGuard: usize = 0;     // guest data accesses below this address trap (0 = off): the host area of the shared memory
export let optProf: bool = false;   // dynamic event counters (profile option): an i64 increment at every counted site
export let profBase: usize = 0;
export let optPrecise: i32 = 0;     // 1: pc is written before every memory instruction; 2: the dirty registers instead (pc: side table)

export function setOpt(id: i32, v: u32): void {
  switch (id) {
    case 0: optPcmapBase = v; break;
    case 1: optEntryBase = v; break;
    case 2: optRegionLo = v; break;
    case 3: optMaxInsns = v < 1 ? 1 : v > 8000 ? 8000 : <i32>v; break;
    case 4: optMaxFuncs = <i32>v; break;
    case 5: optFma = v != 0; break;
    case 6: optTail = v != 0; break;
    case 7: optNan = v != 0; break;
    case 8: optDepth = <i32>v; break;
    case 9: optChunk = v; break;
    case 10: optRmArith = v != 0; break;
    case 11: optRegionSize = v; break;
    case 12: optShared = v != 0; break;
    case 13: optCntYield = v != 0; break;
    case 14: optPrecise = <i32>v; break;
    case 15: optGuard = v; break;
    case 17: optMaxPages = v; break;
    case 18: pairLock = v; break;
    case 19: optProf = v != 0; break;
  }
}
// the address-valued options as 64-bit values (the wasm64 build's; the wasm32 build takes them through setOpt)
export function setOptAddr(id: i32, v: u64): void {
  switch (id) {
    case 0: optPcmapBase = <usize>v; break;
    case 1: optEntryBase = <usize>v; break;
    case 2: optRegionLo = <usize>v; break;
    case 11: optRegionSize = <usize>v; break;
    case 15: optGuard = <usize>v; break;
    case 16: optPcSpan = v; break;
    case 18: pairLock = <usize>v; break;
  }
}

// ---------------------------------------------------------------------------------------------
// guest code: read straight from the shared linear memory. Code ranges are registered by the glue
// (addRange / removeRange); a function and everything discovered from it stay inside one range.
const RANGE_CAP = 64;
const rLo = mk<u64>(RANGE_CAP);
const rHi = mk<u64>(RANGE_CAP);
let nRanges: i32 = 0;
export let curLo: u64 = 0;
export let curHi: u64 = 0;
export const WINDOW: u64 = 1 << 18;   // discovery stays within +-WINDOW of the function entry
let markBase: usize = 0;              // u16 per instruction of the discovery window
let winLo: u64 = 0;
export function setWin(entry: u64): void { winLo = entry - WINDOW; }
// @ts-ignore
@inline export function inWin(pc: u64): bool { return pc - winLo < 2 * WINDOW; }
// @ts-ignore
@inline export function inCode(pc: u64): bool { return pc - curLo < curHi - curLo && (pc & 3) == 0; }
// @ts-ignore
@inline export function insnAt(pc: u64): u32 { return load<u32>(<usize>pc); }
// @ts-ignore
@inline export function markAt(pc: u64): usize { return markBase + (<usize>(pc - winLo) >> 1); }
export function findRange(pc: u64): bool {
  if (inCode(pc)) return true;
  for (let i = 0; i < nRanges; i++) {
    if (pc - rLo[i] < rHi[i] - rLo[i]) { curLo = rLo[i]; curHi = rHi[i]; return (pc & 3) == 0; }
  }
  return false;
}
export function noRange(): void { curLo = 0; curHi = 0; }

// entry bitmap (known function entries) and the pc map as "already translated" state
// @ts-ignore
@inline function ebyte(pc: u64): usize { return <usize>optEntryBase + <usize>((pc - optRegionLo) >> 5); }
// @ts-ignore
@inline function inRegion(pc: u64): bool { return pc - optRegionLo < <u64>optRegionSize; }
export function isEntry(pc: u64): bool { return inRegion(pc) && ((load<u8>(ebyte(pc)) >> (<u32>((pc - optRegionLo) >> 2) & 7)) & 1) != 0; }
export function setEntry(pc: u64): void {
  if (!inRegion(pc) || (pc & 3) != 0) return;
  let p = ebyte(pc);
  store<u8>(p, <u8>(<u32>load<u8>(p) | (<u32>1 << (<u32>((pc - optRegionLo) >> 2) & 7))));
}
function clearEntries(lo: u64, hi: u64): void {
  for (let pc = lo; pc < hi; pc += 4) {
    if (!inRegion(pc)) continue;
    let p = ebyte(pc);
    store<u8>(p, <u8>(<u32>load<u8>(p) & ~(<u32>1 << (<u32>((pc - optRegionLo) >> 2) & 7))));
  }
}
export function isDone(pc: u64): bool {
  if (M64) {
    if (pc >= optPcSpan) return false;
    let leaf64 = <usize>load<u64>(optPcmapBase + (<usize>(pc >> 16) << 3));
    return load<u32>(leaf64 + <usize>(pc & 0xFFFC)) != 0;
  }
  let p = <u32>pc;
  let leaf = load<u32>(<usize>optPcmapBase + (<usize>(p >> 16) << 2));
  return load<u32>(<usize>leaf + (p & 0xFFFC)) != 0;
}
// does this instruction look like the first of a function? (frame setup, stack adjustment, PAC/BTI landing pad)
function looksLikeEntry(insn: u32): bool {
  return (insn & 0xFFC003E0) == 0xA98003E0     // stp xA, xB, [sp, #-n]!
      || (insn & 0xFFC003E0) == 0x6D8003E0     // stp dA, dB, [sp, #-n]!
      || (insn & 0xFF8003FF) == 0xD10003FF     // sub sp, sp, #n
      || (insn & 0xFFE00FE0) == 0xF8000FE0     // str xN, [sp, #-n]!
      || insn == 0xD503233F || insn == 0xD503237F || (insn & 0xFFFFFF3F) == 0xD503241F;   // paciasp, pacibsp, bti
}
// register a code range; [tlo, thi) is its text (equal to the range when unknown). Marks the known
// function entries: BL targets, prologue-looking instructions right after a RET, and aligned
// 8-byte words anywhere in the range that point into the text.
export function addRange(lo: u64, hi: u64, tlo: u64, thi: u64): i32 {
  removeRange(lo, hi);
  if (nRanges >= RANGE_CAP) return -1;
  rLo[nRanges] = lo; rHi[nRanges] = hi; nRanges++;
  noRange();
  for (let pc = tlo; pc + 4 <= thi; pc += 4) {
    let insn = load<u32>(<usize>pc);
    if ((insn & 0xFC000000) == 0x94000000) {
      let t = pc + <u64>(<i64>((<i32>(insn << 6)) >> 6) << 2);
      if (t - tlo < thi - tlo) setEntry(t);
    } else if ((insn == 0xD65F03C0 || (insn & 0xFFFFFBFF) == 0xD65F0BFF) && pc + 8 <= thi && looksLikeEntry(load<u32>(<usize>pc + 4))) setEntry(pc + 4);   // after ret / retaa / retab
  }
  for (let a = (lo + 7) & ~7; a + 8 <= hi; a += 8) {
    let v = load<u64>(<usize>a);
    if (v - tlo < thi - tlo && (v & 3) == 0) setEntry(v);
  }
  return nRanges - 1;
}
export function removeRange(lo: u64, hi: u64): void {
  for (let i = 0; i < nRanges; i++) {
    if (rLo[i] < hi && lo < rHi[i]) {
      clearEntries(rLo[i], rHi[i]);
      nRanges--; rLo[i] = rLo[nRanges]; rHi[i] = rHi[nRanges]; i--;
    }
  }
  noRange();
}
export function rangeCount(): i32 { return nRanges; }

export const M_VIS: u16 = 0x8000;
export const M_LEAD: u16 = 0x4000;

// ---------------------------------------------------------------------------------------------
// byte writer
export let P: usize = 0;
export function setP(p: usize): void { P = p; }
// @ts-ignore
@inline export function b(x: u32): void { store<u8>(P, <u8>x); P += 1; }
export function leb(x: u32): void { while (x >= 0x80) { b((x & 0x7F) | 0x80); x >>= 7; } b(x); }
export function leb64(x: u64): void { while (x >= 0x80) { b((<u32>x & 0x7F) | 0x80); x >>= 7; } b(<u32>x); }
export function sleb64(x: i64): void {
  while (true) {
    let c = <u32>(x & 0x7F); x >>= 7;
    if ((x == 0 && (c & 0x40) == 0) || (x == -1 && (c & 0x40) != 0)) { b(c); break; }
    b(c | 0x80);
  }
}
export function i32c(v: i32): void { b(0x41); sleb64(<i64>v); }
export function i64c(v: i64): void { b(0x42); sleb64(v); }
export function f32c(bits: u32): void { b(0x43); store<u32>(P, bits); P += 4; }
export function f64c(bits: u64): void { b(0x44); store<u64>(P, bits); P += 8; }
export function simd(op: u32): void { b(0xFD); leb(op); }
export function v128c(lo: u64, hi: u64): void { simd(0x0C); store<u64>(P, lo); store<u64>(P + 8, hi); P += 16; }
export function lget(i: u32): void { b(0x20); leb(i); }
export function lset(i: u32): void { b(0x21); leb(i); }
export function ltee(i: u32): void { b(0x22); leb(i); }
export function gget(i: u32): void { b(0x23); leb(i); }
export function gset(i: u32): void { b(0x24); leb(i); }
export function mem(op: u32): void { b(op); b(0); if (M64) leb64(optGuard); else leb(<u32>optGuard); }
export function vmem(op: u32): void { simd(op); b(0); if (M64) leb64(optGuard); else leb(<u32>optGuard); }
// Guest data address on the stack: i64 -> i32. With optGuard the address is biased by -optGuard and every memory
// instruction carries the offset optGuard (mem, vmem, moff): an address below optGuard wraps to 4 GB or more and
// the access traps (the effective address is computed without wrapping), at the cost of one subtraction.
// memory64: the i64 address is the memory operand as it is (an address beyond the memory traps); the guard is the
// same subtraction in 64 bits (an address below optGuard wraps to 2^64 - n, and index + offset is not reduced).
export function aw(): void {
  if (M64) { if (optGuard) { i64c(<i64>optGuard); b(0x7D); } return; }
  b(0xA7); if (optGuard) { i32c(<i32>optGuard); b(0x6B); }
}
export function moff(o: u32): void { if (M64) leb64(<u64>o + optGuard); else leb(o + <u32>optGuard); }
// profile counter k += n (counters: profBase, u64 each; see PROF_* in a64_host.ts)
export function prof(k: i32, n: i64): void {
  if (!optProf || n == 0) return;
  let a = profBase + (<usize>k << 3);
  if (M64) { i64c(<i64>a); i64c(<i64>a); } else { i32c(<i32>a); i32c(<i32>a); }
  b(0x29); b(3); b(0); i64c(n); b(0x7C); b(0x37); b(3); b(0);
}
export function fc(op: u32): void { b(0xFC); leb(op); }
// @ts-ignore
@inline export function op(x: u32): void { b(x); }
// integer op by width: i32 opcode given, +0x12 for i64 arithmetic
// @ts-ignore
@inline export function ar(sf: bool, o: u32): void { b(sf ? o + 0x12 : o); }
// comparison by width: i32 opcode given, +0x0B for i64
// @ts-ignore
@inline export function cm(sf: bool, o: u32): void { b(sf ? o + 0x0B : o); }
export function cst(sf: bool, v: i64): void { if (sf) i64c(v); else i32c(<i32>v); }

// ---------------------------------------------------------------------------------------------
// register ids == global indices in a translation unit
export const R_SP = 31;
export const R_N = 32;
export const R_Z = 33;
export const R_C = 34;
export const R_V = 35;
export const R_V0 = 36;
export const NREG = 68;
export const G_PC = 68;
export const G_FPCR = 69;
export const G_FPSR = 70;
export const G_TPIDR = 71;
export const G_TPIDRRO = 72;
export const G_EXADDR = 73;
export const G_EXVAL = 74;
export const G_BUDGET = 75;
export const G_EXVAL2 = 76;
export const G_DEPTH = 77;
export const G_TBASE = 78;
export const NGLOB = 79;

// imported function indices in a unit
export const F_SVC = 0;
export const F_UNIMPL = 1;
export const F_BRK = 2;
export const F_CNTPCT = 3;
export const F_CRC = 4;
export const F_VOP = 5;
export const F_NAN1S = 6;
export const F_NAN1D = 7;
export const F_NAN2S = 8;
export const F_NAN2D = 9;
export const F_NAN3S = 10;
export const F_NAN3D = 11;
export const F_RND = 12;
export const F_SFS = 13;
export const F_SFD = 14;
export const F_LIBC = 15;
export const NIMPF = 16;

export const T_I32: u8 = 0x7F;
export const T_I64: u8 = 0x7E;
export const T_F32: u8 = 0x7D;
export const T_F64: u8 = 0x7C;
export const T_V128: u8 = 0x7B;

// locals
const MAXLOC = 1024;
export const locTy = mk<u8>(MAXLOC);
export let nLoc: u32 = 0;
const regLoc = mk<i32>(NREG);
const tmpLoc = mk<i32>(5 * 16);
export const L_STATE: u32 = 0;
export const L_BUD: u32 = 1;
export const L_DEPTH: u32 = 2;

export function newLocal(ty: u8): u32 { locTy[nLoc] = ty; return nLoc++; }
export function regLocal(r: i32): u32 {
  let l = regLoc[r];
  if (l < 0) { l = <i32>newLocal(r < 32 ? T_I64 : r < 36 ? T_I32 : T_V128); regLoc[r] = l; }
  return <u32>l;
}
export function regLocalRaw(r: i32): i32 { return regLoc[r]; }
function tmp(ty: u8, n: i32): u32 {
  let k = (0x7F - <i32>ty) * 16 + n;
  let l = tmpLoc[k];
  if (l < 0) { l = <i32>newLocal(ty); tmpLoc[k] = l; }
  return <u32>l;
}
export function t32(n: i32): u32 { return tmp(T_I32, n); }
export function t64(n: i32): u32 { return tmp(T_I64, n); }
export function tf32(n: i32): u32 { return tmp(T_F32, n); }
export function tf64(n: i32): u32 { return tmp(T_F64, n); }
export function tv(n: i32): u32 { return tmp(T_V128, n); }
export function tw(sf: bool, n: i32): u32 { return sf ? t64(n) : t32(n); }
// a temp for a guest data address after aw(): i32 slot n, or with memory64 the i64 slot kept for this (10)
export function ta(n: i32): u32 { return M64 ? t64(10) : t32(n); }

// ---------------------------------------------------------------------------------------------
// event log + insertion points
export const EV_R: u32 = 0;
export const EV_W: u32 = 1;
export const EV_WB: u32 = 2;
export const EV_RELOAD: u32 = 3;
const EV_CAP = 1 << 18;
export const evBuf = mk<u32>(EV_CAP);
export let nEv: i32 = 0;
const INS_CAP = 1 << 15;
export const insPos = mk<u32>(INS_CAP);
export const insKind = mk<u8>(INS_CAP);
export const insMI = mk<u64>(INS_CAP);
export const insMV = mk<u32>(INS_CAP);
export const insSite = mk<u8>(INS_CAP);   // which kind of site (WB_* / RL_*): profile counters 17 + site
// an insertion at a call with a summary (sRI): the function called, and INS_CALL (write back dirty & (R | W)),
// INS_BACK (it did not come back: write back dirty & ~W) or INS_AFTER (reload needed & W; dirty & ~(R | W) stays dirty)
export const INS_CALL: u8 = 1, INS_BACK: u8 = 2, INS_AFTER: u8 = 3;
export const INS_SEQ: u8 = 4;   // a write-back on the block's straight path (precise faults): every register is clean after it
export const insMode = mk<u8>(INS_CAP);
export const insG = mk<u16>(INS_CAP);
export let nIns: i32 = 0;
export let fbBase: usize = 0;
export const FB_CAP: usize = 2 << 20;
export let ifDepth: i32 = 0;
export let overflow: bool = false;

// @ts-ignore
@inline function ev(kind: u32, payload: u32): void { if (nEv < EV_CAP) { evBuf[nEv++] = kind | (payload << 8); } else overflow = true; }

export function rget(r: i32): void { ev(EV_R, r); lget(regLocal(r)); }
export function rset(r: i32): void { if (ifDepth > 0) ev(EV_R, r); ev(EV_W, r); lset(regLocal(r)); }
export function rtee(r: i32): void { if (ifDepth > 0) ev(EV_R, r); ev(EV_W, r); ltee(regLocal(r)); }

export const WB_BL: u8 = 0, WB_BLR: u8 = 1, WB_RET: u8 = 2, WB_B: u8 = 3, WB_BR: u8 = 4, WB_BUDGET: u8 = 5, WB_SVC: u8 = 6, WB_OTHER: u8 = 7;
export const RL_ENTRY: u8 = 8, RL_CALL: u8 = 9, RL_OTHER: u8 = 10;
function insertion(kind: u32, site: u8): void {
  if (nIns >= INS_CAP) { overflow = true; return; }
  insPos[nIns] = <u32>(P - fbBase); insKind[nIns] = <u8>kind; insMI[nIns] = 0; insMV[nIns] = 0; insSite[nIns] = site;
  insMode[nIns] = 0;
  ev(kind, nIns); nIns++;
}
export function writeback(site: u8 = WB_OTHER): void { insertion(EV_WB, site); }
export function reload(site: u8 = RL_OTHER): void { insertion(EV_RELOAD, site); lastCmp = 0; }
function insSum(mode: u8, g: i32): void {
  if (nIns == 0 || overflow) return;
  insMode[nIns - 1] = mode; insG[nIns - 1] = <u16>g;
}
export function writebackSeq(): void { writeback(WB_OTHER); insSum(INS_SEQ, 0); }

// rollback support (used when an instruction turns out not to be translatable)
export function rollback(p: usize, e: i32, i: i32): void { P = p; nEv = e; nIns = i; ifDepth = 0; }

// ---------------------------------------------------------------------------------------------
// integer register access. "zr" forms treat r31 as the zero register, "sp" forms as sp.
export function getX(r: i32, sf: bool): void {
  if (r == 31) { cst(sf, 0); return; }
  rget(r); if (!sf) b(0xA7);
}
export function getXsp(r: i32, sf: bool): void { rget(r); if (!sf) b(0xA7); }
export function setX(r: i32, sf: bool): void {
  if (r == 31) { b(0x1A); return; }
  if (!sf) b(0xAD);
  rset(r);
}
export function setXsp(r: i32, sf: bool): void { if (!sf) b(0xAD); rset(r); }

export function ifVoid(): void { b(0x04); b(0x40); ifDepth++; }
export function ifT(t: u8): void { b(0x04); b(t); ifDepth++; }
export function els(): void { b(0x05); }
export function end(): void { b(0x0B); ifDepth--; }

// ---------------------------------------------------------------------------------------------
// flags
export let lastCmp: i32 = 0;   // 0 none, 1 = 32-bit SUBS operands in cmp locals, 2 = 64-bit
export function killCmp(): void { lastCmp = 0; }
let cmpA32: i32 = -1; let cmpB32: i32 = -1; let cmpA64: i32 = -1; let cmpB64: i32 = -1;
function cmpLocA(sf: bool): u32 {
  if (sf) { if (cmpA64 < 0) cmpA64 = <i32>newLocal(T_I64); return <u32>cmpA64; }
  if (cmpA32 < 0) cmpA32 = <i32>newLocal(T_I32); return <u32>cmpA32;
}
function cmpLocB(sf: bool): u32 {
  if (sf) { if (cmpB64 < 0) cmpB64 = <i32>newLocal(T_I64); return <u32>cmpB64; }
  if (cmpB32 < 0) cmpB32 = <i32>newLocal(T_I32); return <u32>cmpB32;
}

// stack: a b -> result ; sets NZCV for a+b or a-b
export function flagsAddSub(sf: bool, sub: bool): void {
  let A = sub ? cmpLocA(sf) : tw(sf, 14);
  let B = sub ? cmpLocB(sf) : tw(sf, 15);
  let R = tw(sf, 13);
  lset(B); lset(A);
  lget(A); lget(B); ar(sf, sub ? 0x6B : 0x6A); lset(R);
  lget(R); cst(sf, 0); cm(sf, 0x48); rset(R_N);
  lget(R); b(sf ? 0x50 : 0x45); rset(R_Z);
  if (sub) { lget(A); lget(B); cm(sf, 0x4F); } else { lget(R); lget(A); cm(sf, 0x49); }
  rset(R_C);
  lget(A); lget(sub ? B : R); ar(sf, 0x73);
  lget(sub ? A : B); lget(R); ar(sf, 0x73);
  ar(sf, 0x71); cst(sf, 0); cm(sf, 0x48); rset(R_V);
  lget(R);
  lastCmp = sub ? (sf ? 2 : 1) : 0;
}
// stack: a b -> result ; a + b + C (b already inverted for SBC); optionally sets flags
export function addCarry(sf: bool, S: bool): void {
  if (!S) { ar(sf, 0x6A); rget(R_C); if (sf) b(0xAD); ar(sf, 0x6A); return; }
  let A = tw(sf, 14), B = tw(sf, 15), R = tw(sf, 13);
  lset(B); lset(A);
  if (sf) {
    let T = t64(12);
    lget(A); lget(B); b(0x7C); ltee(T); rget(R_C); b(0xAD); b(0x7C); lset(R);
    lget(T); lget(A); b(0x54); lget(R); lget(T); b(0x54); b(0x72); rset(R_C);
  } else {
    let T = t64(12);
    lget(A); b(0xAD); lget(B); b(0xAD); b(0x7C); rget(R_C); b(0xAD); b(0x7C); ltee(T); b(0xA7); lset(R);
    lget(T); i64c(32); b(0x88); b(0xA7); rset(R_C);
  }
  lget(R); cst(sf, 0); cm(sf, 0x48); rset(R_N);
  lget(R); b(sf ? 0x50 : 0x45); rset(R_Z);
  lget(A); lget(R); ar(sf, 0x73); lget(B); lget(R); ar(sf, 0x73); ar(sf, 0x71); cst(sf, 0); cm(sf, 0x48); rset(R_V);
  lget(R);
  lastCmp = 0;
}
// stack: r -> r ; N,Z from r, C=V=0
export function flagsNZ(sf: bool): void {
  let R = tw(sf, 13);
  lset(R);
  lget(R); cst(sf, 0); cm(sf, 0x48); rset(R_N);
  lget(R); b(sf ? 0x50 : 0x45); rset(R_Z);
  i32c(0); rset(R_C); i32c(0); rset(R_V);
  lget(R);
  lastCmp = 0;
}
// stack: i32 nzcv (bit3 N .. bit0 V) -> ; unpack into flags
export function setNZCVconst(v: u32): void {
  i32c((v >> 3) & 1); rset(R_N); i32c((v >> 2) & 1); rset(R_Z); i32c((v >> 1) & 1); rset(R_C); i32c(v & 1); rset(R_V);
  lastCmp = 0;
}

// push i32 (0/1) for condition code
export function emitCond(cond: u32): void {
  let base = cond >> 1, inv = (cond & 1) != 0 && cond != 15;
  if (lastCmp != 0 && base != 2 && base != 3 && base != 7) {
    let sf = lastCmp == 2;
    lget(cmpLocA(sf)); lget(cmpLocB(sf));
    let o: u32 = 0;
    switch (cond) {
      case 0: o = 0x46; break; case 1: o = 0x47; break;
      case 2: o = 0x4F; break; case 3: o = 0x49; break;
      case 8: o = 0x4B; break; case 9: o = 0x4D; break;
      case 10: o = 0x4E; break; case 11: o = 0x48; break;
      case 12: o = 0x4A; break; default: o = 0x4C; break;
    }
    cm(sf, o);
    return;
  }
  switch (base) {
    case 0: rget(R_Z); break;
    case 1: rget(R_C); break;
    case 2: rget(R_N); break;
    case 3: rget(R_V); break;
    case 4: rget(R_C); rget(R_Z); b(0x45); b(0x71); break;
    case 5: rget(R_N); rget(R_V); b(0x46); break;
    case 6: rget(R_N); rget(R_V); b(0x46); rget(R_Z); b(0x45); b(0x71); break;
    default: i32c(1); break;
  }
  if (inv) b(0x45);
}

// ---------------------------------------------------------------------------------------------
// blocks of the current function
const BLK_CAP = 16384;
export const blkPc = mk<u64>(BLK_CAP);
export const succ0 = mk<i32>(BLK_CAP);
export const succ1 = mk<i32>(BLK_CAP);
// structured function body (unit.ts structure()): label levels, counted from the function body outwards in
export const STRUCT_CAP = 1536;   // blocks of a function with a structured body at most
export let structOn = false;
export let structFail = false;
export function setStruct(on: bool): void { structOn = on; structFail = false; }
export const lvBlk = mk<i32>(STRUCT_CAP);    // labels around block k's code
export const lvWrap = mk<i32>(STRUCT_CAP);   // the block a forward branch to block j leaves (-1: none)
export const fwLo = mk<i32>(STRUCT_CAP);     // first block of the region that block is in
export const lvLoop = mk<i32>(STRUCT_CAP);   // the loop of header j (-1: not a header)
export const loopEnd = mk<i32>(STRUCT_CAP);  // last block of the loop of header j
// (the arrays above are by position in the structured order; posOf: block -> position)
export const posOf = mk<i32>(STRUCT_CAP);
function pos(j: i32): i32 { return structOn ? posOf[j] : j; }
function fwdDepth(j: i32): i32 {
  if (!structOn) return j - curBlk - 1;
  let pj = posOf[j], pk = posOf[curBlk];
  if (lvWrap[pj] < 0 || pk < fwLo[pj]) { structFail = true; return 0; }
  return lvBlk[pk] - lvWrap[pj];
}
function backDepth(j: i32): i32 {
  let pj = posOf[j], pk = posOf[curBlk];
  if (lvLoop[pj] < 0 || pk > loopEnd[pj]) { structFail = true; return 0; }
  return lvBlk[pk] - lvLoop[pj];
}
export let nBlk: i32 = 0;
export let curBlk: i32 = 0;
export let term: bool = false;   // current instruction ended the block (no fallthrough)
export function setNBlk(n: i32): void { nBlk = n; }
export function setCurBlk(k: i32): void { curBlk = k; term = false; lastCmp = 0; }
export function setTerm(): void { term = true; }
export function blockOf(pc: u64): i32 {
  if (!inCode(pc) || !inWin(pc)) return -1;
  let m = load<u16>(markAt(pc));
  if ((m & (M_VIS | M_LEAD)) != (M_VIS | M_LEAD)) return -1;
  return <i32>(m & 0x3FFF);
}
function addSucc(j: i32): void {
  if (succ0[curBlk] < 0 || succ0[curBlk] == j) succ0[curBlk] = j; else succ1[curBlk] = j;
}

// unit function registry (pc -> function index, open-addressing hash)
const FN_CAP = 4096;
const HSZ = 16384;
export const fnPc = mk<u64>(FN_CAP);
const hKey = mk<u64>(HSZ);   // pc + 1, 0 = empty
const hVal = mk<u16>(HSZ);
export let nFn: i32 = 0;
export let fnLimit: i32 = 0;
export function resetFns(): void {
  for (let i = 0; i < HSZ; i++) hKey[i] = 0;
  nFn = 0;
}
// Call summaries. A function of the unit that has been translated has a summary: R, the registers it (or a function
// it calls) may read from the globals, and W, the ones it may write there. A BL to it writes back only the dirty
// registers in R | W and reloads only those in W; the rest stay in locals across the call. When the call does not
// come back to the return address (budget, depth, a yield further down) the dirty registers outside W are written
// back before the return. A function with a call or jump the unit cannot see (BLR, BR, B out of the function, a
// call through the table, SVC, a trap) has R = W = everything. Not with precise faults.
export const sRI = mk<u64>(FN_CAP);
export const sRV = mk<u32>(FN_CAP);
export const sWI = mk<u64>(FN_CAP);
export const sWV = mk<u32>(FN_CAP);
export const sOk = mk<u8>(FN_CAP);
export let accRI: u64 = 0, accRV: u32 = 0, accWI: u64 = 0, accWV: u32 = 0, accAll = false;
export function resetAcc(): void { accRI = 0; accRV = 0; accWI = 0; accWV = 0; accAll = false; }
export function setFnLimit(n: i32): void { fnLimit = n < FN_CAP ? n : FN_CAP; }
export function addFn(pc: u64, force: bool): i32 {
  let h = <i32>((<u32>(pc >> 2) * 0x9E3779B1) >> 18);
  while (hKey[h] != 0) {
    if (hKey[h] == pc + 1) return <i32>hVal[h];
    h = (h + 1) & (HSZ - 1);
  }
  if (nFn >= (force ? FN_CAP : fnLimit)) return -1;
  // a BL target joins the unit only when it is in the caller's range and has no translation yet
  if (!force && (!inCode(pc) || isDone(pc))) return -1;
  hKey[h] = pc + 1; hVal[h] = <u16>nFn;
  fnPc[nFn] = pc;
  return nFn++;
}

// ---------------------------------------------------------------------------------------------
// control-flow protocol
// two-level pc map: leaf = L1[pc >> 16], index = leaf[pc & 0xFFFC]; unmapped leaves are a shared zero page
function idxConst(target: u64): void {
  if (M64) {
    if (target >= optPcSpan) { i32c(0); return; }   // beyond the pc map: the trampoline, which asks the embedder
    i64c(<i64>(<u64>optPcmapBase + ((target >> 16) << 3))); b(0x29); b(3); b(0);
    b(0x28); b(2); leb(<u32>(target & 0xFFFC));
    return;
  }
  let t = <u32>target;
  i32c(<i32>(<u32>optPcmapBase + ((t >> 16) << 2))); b(0x28); b(2); b(0);
  b(0x28); b(2); leb(t & 0xFFFC);
}
// stack: i64 target -> i32 table index
function idxDyn(): void {
  pcmapLookup(M64 ? t64(10) : t32(11));
}
// stack: i64 pc -> i32 table index (tmp: an i32 local; memory64: an i64 local)
export function pcmapLookup(tmp: u32): void {
  if (M64) {
    // leaf = L1[pc < span ? pc >> 16 : span >> 16] (the entry after the last is always the zero leaf: a pc beyond
    // the map reads index 0, the trampoline); index = u32 at leaf + (pc & 0xFFFC)
    ltee(tmp); i64c(16); b(0x88);
    i64c(<i64>(optPcSpan >> 16));
    lget(tmp); i64c(<i64>optPcSpan); b(0x54);
    b(0x1B);
    i64c(3); b(0x86); b(0x29); b(3); leb64(optPcmapBase);
    lget(tmp); i64c(0xFFFC); b(0x83); b(0x7C); b(0x28); b(2); b(0);
    return;
  }
  b(0xA7); ltee(tmp); i32c(16); b(0x76); i32c(2); b(0x74); b(0x28); b(2); leb(<u32>optPcmapBase);
  lget(tmp); i32c(0xFFFC); b(0x71); b(0x6A); b(0x28); b(2); b(0);
}
// depth bookkeeping: a nested call announces depth+1, a tail transfer hands on the current depth
function depthForCall(): void { if (optDepth > 0) { lget(L_DEPTH); i32c(1); b(0x6A); gset(G_DEPTH); } }
// stack: i32 table index ->
function tailIndirect(): void {
  if (optTail) { if (optDepth > 0) { lget(L_DEPTH); gset(G_DEPTH); } b(0x13); b(0); b(0); }
  else { depthForCall(); b(0x11); b(0); b(0); b(0x0F); }
}
function pcCheck(ret: u64, g: i32 = -1): void {
  gget(G_PC); i64c(<i64>ret); b(0x52); b(0x04); b(0x40);
  if (g >= 0) { writeback(WB_OTHER); insSum(INS_BACK, g); }
  b(0x0F); b(0x0B);
  reload(RL_CALL);
  if (g >= 0) insSum(INS_AFTER, g);
}
function budgetCheck(target: u64): void {
  gget(G_BUDGET); i32c(1); b(0x6B); ltee(L_BUD); gset(G_BUDGET);
  prof(1, 1);
  lget(L_BUD); i32c(0); b(0x48);
  ifVoid(); i64c(<i64>target); gset(G_PC); writeback(WB_BUDGET); b(0x0F); end();
}
// leave the function towards a constant pc (tail transfer through the table)
export function exitConst(target: u64): void {
  accAll = true;
  prof(5, 1); i64c(<i64>target); gset(G_PC); writeback(WB_B); idxConst(target); tailIndirect();
  term = true;
}
// stack: i64 target ->
export function exitDyn(): void {
  let t = t64(11);
  accAll = true;
  prof(6, 1); ltee(t); gset(G_PC); writeback(WB_BR); lget(t); idxDyn(); tailIndirect();
  term = true;
}
// stack: i64 target -> ; RET
export function exitRet(): void { prof(7, 1); gset(G_PC); writeback(WB_RET); b(0x0F); term = true; }
// plain exit with pc already set by the caller of this helper
export function exitNow(): void { writeback(); b(0x0F); term = true; }

// Library functions the host named (setIntrinsic: a module's definition of memcpy, strlen, ...): a function at one of
// these pcs is translated as one call of the helpers' libc(op, x0, x1, x2) into x0 and a return to x30 (libc.ts), and a
// BL or B to one is that call in place: no write-back, reload or pc check (it changes only x0; not with precise faults)
const INTR_CAP = 64;
const intrPc = mk<u64>(INTR_CAP);
const intrOp = mk<i32>(INTR_CAP);
let nIntr: i32 = 0;
// op 0 forgets the pc; returns the number of named pcs, -1 when the table is full
export function setIntrinsic(pc: u64, op: i32): i32 {
  for (let i = 0; i < nIntr; i++) {
    if (intrPc[i] != pc) continue;
    if (op) intrOp[i] = op; else { nIntr--; intrPc[i] = intrPc[nIntr]; intrOp[i] = intrOp[nIntr]; }
    return nIntr;
  }
  if (!op) return nIntr;
  if (nIntr == INTR_CAP) return -1;
  intrPc[nIntr] = pc; intrOp[nIntr] = op; nIntr++;
  return nIntr;
}
export function intrinsicAt(pc: u64): i32 { for (let i = 0; i < nIntr; i++) if (intrPc[i] == pc) return intrOp[i]; return 0; }
// stack: -> ; x0 = libc(op, x0, x1, x2)
function callIntrinsic(op: i32): void {
  prof(16, 1);
  i32c(op); rget(0); rget(1); rget(2); b(0x10); leb(F_LIBC); rset(0);
}
// unconditional transfer to a constant pc; ends the block
export function gotoPc(target: u64, isLast: bool): void {
  let j = blockOf(target);
  if (j < 0) {
    let op = optPrecise ? 0 : intrinsicAt(target);
    if (op) { callIntrinsic(op); rget(30); exitRet(); } else exitConst(target);
    return;
  }
  addSucc(j);
  if (pos(j) > pos(curBlk)) {
    if (!(isLast && pos(j) == pos(curBlk) + 1 && ifDepth == 0)) { b(0x0C); leb(fwdDepth(j) + ifDepth); }
  } else {
    budgetCheck(target);
    if (structOn) { b(0x0C); leb(backDepth(j) + ifDepth); }
    else { i32c(j); lset(L_STATE); b(0x0C); leb(nBlk - 1 - curBlk + ifDepth); }
  }
  term = true;
}
// stack: i32 cond -> ; conditional transfer, falls through otherwise
export function branchIf(target: u64): void {
  let j = blockOf(target);
  if (j >= 0 && pos(j) > pos(curBlk)) { addSucc(j); b(0x0D); leb(structOn ? fwdDepth(j) + ifDepth : j - curBlk - 1); return; }
  ifVoid(); gotoPc(target, false); end();
  term = false;
}
// BL to constant target
export function callConst(target: u64, ret: u64): void {
  i64c(<i64>ret); rset(30);
  let op = optPrecise ? 0 : intrinsicAt(target);
  if (op) { callIntrinsic(op); return; }
  let f = addFn(target, false);
  depthForCall();
  prof(f >= 0 ? 2 : 3, 1);
  let g = f >= 0 && optPrecise == 0 && sOk[f] != 0 ? f : -1;
  if (g >= 0) { accRI |= sRI[g]; accRV |= sRV[g]; accWI |= sWI[g]; accWV |= sWV[g]; } else accAll = true;
  if (f >= 0) { writeback(WB_BL); if (g >= 0) insSum(INS_CALL, g); b(0x10); leb(NIMPF + f); }
  else { i64c(<i64>target); gset(G_PC); writeback(WB_BL); idxConst(target); b(0x11); b(0); b(0); }
  pcCheck(ret, g);
}
// stack: i64 target -> ; BLR
export function callDyn(ret: u64): void {
  let t = t64(11);
  ltee(t); gset(G_PC);
  i64c(<i64>ret); rset(30);
  depthForCall(); prof(4, 1); accAll = true;
  writeback(WB_BLR); lget(t); idxDyn(); b(0x11); b(0); b(0);
  pcCheck(ret);
}
// `mrs xN, cntpct_el0` as a yield point: leaves the i64 counter on the stack
export function emitCntYield(pc: u64): void {
  let t = t64(9);
  accAll = true;
  i64c(<i64>pc); gset(G_PC); writeback(WB_SVC); b(0x10); leb(F_CNTPCT); lset(t);
  pcCheck(pc);
  lget(t);
}
export function emitSvc(imm: u32, ret: u64): void {
  accAll = true;
  i64c(<i64>ret); gset(G_PC); writeback(WB_SVC); i32c(<i32>imm); b(0x10); leb(F_SVC);
  pcCheck(ret);
}
// call an import that reports (pc, arg) and stop: unimpl / brk
export function emitTrap(fn: u32, pc: u64, arg: u32): void {
  accAll = true;
  i64c(<i64>pc); gset(G_PC); writeback();
  i64c(<i64>pc); i32c(<i32>arg); b(0x10); leb(fn);
  i32c(-1); gset(G_BUDGET); b(0x0F);
  term = true;
}

// ---------------------------------------------------------------------------------------------
// Shared memory: the address of the word that serialises 16-byte compare-and-swaps (CASP of two X registers), which
// wasm cannot do as one atomic operation. The embedder sets it (option 18): a fixed place of the memory's layout, so
// that every translator build, every instance and every cached unit use the same word.
export let pairLock: usize = 0;
export function resetLocals(): void { nLoc = 0; }
export function initEmit(): void {
  fbBase = balloc(FB_CAP);
  markBase = balloc(<usize>(2 * WINDOW / 4) * 2);
  profBase = balloc(256); memory.fill(profBase, 0, 256);
  memory.fill(markBase, 0, <usize>(2 * WINDOW / 4) * 2);
}
export function beginFunction(): void {
  P = fbBase; nEv = 0; nIns = 0; ifDepth = 0; overflow = false;
  for (let i = 0; i < NREG; i++) regLoc[i] = -1;
  for (let i = 0; i < 80; i++) tmpLoc[i] = -1;
  cmpA32 = -1; cmpB32 = -1; cmpA64 = -1; cmpB64 = -1;
  nLoc = 0; newLocal(T_I32); newLocal(T_I32); newLocal(T_I32);
  lastCmp = 0;
}
