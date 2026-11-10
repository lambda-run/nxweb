// nxweb a64: shared emitter state (AssemblyScript).
// Byte writer, wasm opcode helpers, guest register cache (wasm locals), event log used by the
// write-back / reload analysis, and the control-flow protocol helpers.

// ---------------------------------------------------------------------------------------------
// options
export let optPcmapBase: u32 = 0;   // linear-memory address of the pc map (u32 table index per insn)
export let optCodeLo: u32 = 0;      // first guest address covered by the pc map
export let optMapSize: u32 = 0;     // bytes covered by the pc map
export let optMaxInsns: i32 = 1500; // function size cap
export let optMaxFuncs: i32 = 1024; // functions per unit (entries + region entries + auto-added BL targets)
export let optFma: bool = true;     // relaxed-simd fused multiply-add
export let optTail: bool = true;    // wasm tail calls for jumps
export let optNan: bool = true;     // ARM NaN generation/propagation fix-up on FP arithmetic
export let optChunk: u32 = 65536;        // region mode: a unit also takes the untranslated BL targets in the entry's chunk (bytes, power of two; 0 = off)
export let optDepth: i32 = 160;     // nested guest calls before a call unwinds through the run loop (0 = off)

export function setOpt(id: i32, v: u32): void {
  switch (id) {
    case 0: optPcmapBase = v; break;
    case 1: optCodeLo = v; break;
    case 2: optMapSize = v; break;
    case 3: optMaxInsns = v < 1 ? 1 : v > 8000 ? 8000 : <i32>v; break;
    case 4: optMaxFuncs = <i32>v; break;
    case 5: optFma = v != 0; break;
    case 6: optTail = v != 0; break;
    case 7: optNan = v != 0; break;
    case 8: optDepth = <i32>v; break;
    case 9: optChunk = v; break;
  }
}

// ---------------------------------------------------------------------------------------------
// guest code window (copied in by the glue)
export let codePtr: usize = 0;
export let codeBase: u64 = 0;
export let codeLen: u32 = 0;
let codeCap: u32 = 0;
export let markPtr: usize = 0;   // u16 per insn: discovery flags + block index
export let fnMarkPtr: usize = 0; // u16 per insn: unit function index + 1
export let statePtr: usize = 0;  // u8 per insn, persistent: 1 = already translated (in the pc map), 2 = BL target
export const S_DONE: u8 = 1;
export const S_ENTRY: u8 = 2;

export function codeBuf(len: u32): usize {
  if (len > codeCap) {
    codeCap = (len + 0xFFFF) & ~0xFFFF;
    codePtr = heap.alloc(codeCap);
    markPtr = heap.alloc(codeCap >> 1);
    fnMarkPtr = heap.alloc(codeCap >> 1);
    statePtr = heap.alloc(codeCap >> 2);
    memory.fill(markPtr, 0, codeCap >> 1);
    memory.fill(fnMarkPtr, 0, codeCap >> 1);
  }
  return codePtr;
}
export function setCode(base: u64, len: u32): void {
  codeBase = base; codeLen = len & ~3;
  memory.fill(statePtr, 0, codeLen >> 2);
  // every BL target is a function entry
  for (let off: u32 = 0; off < codeLen; off += 4) {
    let insn = load<u32>(codePtr + off);
    if ((insn & 0xFC000000) == 0x94000000) {
      let t = <i64>off + (<i64>((<i32>(insn << 6)) >> 6) << 2);
      if (t >= 0 && t < <i64>codeLen) store<u8>(statePtr + <usize>(t >> 2), S_ENTRY);
    }
    // heuristics for functions only reached through pointers: code right after a RET, and
    // aligned 8-byte words that point into the window
    if (insn == 0xD65F03C0 && off + 8 <= codeLen && load<u32>(codePtr + off + 4) != 0) store<u8>(statePtr + ((off + 4) >> 2), S_ENTRY);
    if ((off & 7) == 0 && off + 8 <= codeLen) {
      let v = load<u64>(codePtr + off) - base;
      if (v < <u64>codeLen && (v & 3) == 0 && load<u64>(codePtr + off) != 0) store<u8>(statePtr + <usize>(v >> 2), S_ENTRY);
    }
  }
}
// forget which pcs are translated (the glue cleared the pc map)
export function resetDone(): void { for (let i: u32 = 0, n = codeLen >> 2; i < n; i++) store<u8>(statePtr + i, load<u8>(statePtr + i) & ~S_DONE); }
// @ts-ignore
@inline export function stateAt(pc: u64): usize { return statePtr + (<usize>(pc - codeBase) >> 2); }
// @ts-ignore
@inline export function inCode(pc: u64): bool { return pc - codeBase < <u64>codeLen && (pc & 3) == 0; }
// @ts-ignore
@inline export function insnAt(pc: u64): u32 { return load<u32>(codePtr + <usize>(pc - codeBase)); }
// @ts-ignore
@inline export function markAt(pc: u64): usize { return markPtr + (<usize>(pc - codeBase) >> 1); }

export const M_VIS: u16 = 0x8000;
export const M_LEAD: u16 = 0x4000;

// ---------------------------------------------------------------------------------------------
// byte writer
export let P: usize = 0;
export function setP(p: usize): void { P = p; }
// @ts-ignore
@inline export function b(x: u32): void { store<u8>(P, <u8>x); P += 1; }
export function leb(x: u32): void { while (x >= 0x80) { b((x & 0x7F) | 0x80); x >>= 7; } b(x); }
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
export function mem(op: u32): void { b(op); b(0); b(0); }
export function vmem(op: u32): void { simd(op); b(0); b(0); }
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
export const NIMPF = 13;

export const T_I32: u8 = 0x7F;
export const T_I64: u8 = 0x7E;
export const T_F32: u8 = 0x7D;
export const T_F64: u8 = 0x7C;
export const T_V128: u8 = 0x7B;

// locals
const MAXLOC = 1024;
export const locTy = new StaticArray<u8>(MAXLOC);
export let nLoc: u32 = 0;
const regLoc = new StaticArray<i32>(NREG);
const tmpLoc = new StaticArray<i32>(5 * 16);
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

// ---------------------------------------------------------------------------------------------
// event log + insertion points
export const EV_R: u32 = 0;
export const EV_W: u32 = 1;
export const EV_WB: u32 = 2;
export const EV_RELOAD: u32 = 3;
const EV_CAP = 1 << 18;
export const evBuf = new StaticArray<u32>(EV_CAP);
export let nEv: i32 = 0;
const INS_CAP = 1 << 15;
export const insPos = new StaticArray<u32>(INS_CAP);
export const insKind = new StaticArray<u8>(INS_CAP);
export const insMI = new StaticArray<u64>(INS_CAP);
export const insMV = new StaticArray<u32>(INS_CAP);
export let nIns: i32 = 0;
export let fbBase: usize = 0;
export const FB_CAP: usize = 6 << 20;
export let ifDepth: i32 = 0;
export let overflow: bool = false;

// @ts-ignore
@inline function ev(kind: u32, payload: u32): void { if (nEv < EV_CAP) { evBuf[nEv++] = kind | (payload << 8); } else overflow = true; }

export function rget(r: i32): void { ev(EV_R, r); lget(regLocal(r)); }
export function rset(r: i32): void { if (ifDepth > 0) ev(EV_R, r); ev(EV_W, r); lset(regLocal(r)); }
export function rtee(r: i32): void { if (ifDepth > 0) ev(EV_R, r); ev(EV_W, r); ltee(regLocal(r)); }

function insertion(kind: u32): void {
  if (nIns >= INS_CAP) { overflow = true; return; }
  insPos[nIns] = <u32>(P - fbBase); insKind[nIns] = <u8>kind; insMI[nIns] = 0; insMV[nIns] = 0;
  ev(kind, nIns); nIns++;
}
export function writeback(): void { insertion(EV_WB); }
export function reload(): void { insertion(EV_RELOAD); lastCmp = 0; }

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
export const blkPc = new StaticArray<u64>(BLK_CAP);
export const succ0 = new StaticArray<i32>(BLK_CAP);
export const succ1 = new StaticArray<i32>(BLK_CAP);
export let nBlk: i32 = 0;
export let curBlk: i32 = 0;
export let term: bool = false;   // current instruction ended the block (no fallthrough)
export function setNBlk(n: i32): void { nBlk = n; }
export function setCurBlk(k: i32): void { curBlk = k; term = false; lastCmp = 0; }
export function setTerm(): void { term = true; }
export function blockOf(pc: u64): i32 {
  if (!inCode(pc)) return -1;
  let m = load<u16>(markAt(pc));
  if ((m & (M_VIS | M_LEAD)) != (M_VIS | M_LEAD)) return -1;
  return <i32>(m & 0x3FFF);
}
function addSucc(j: i32): void {
  if (succ0[curBlk] < 0 || succ0[curBlk] == j) succ0[curBlk] = j; else succ1[curBlk] = j;
}

// unit function registry
const FN_CAP = 4096;
export const fnPc = new StaticArray<u64>(FN_CAP);
export let nFn: i32 = 0;
export let fnLimit: i32 = 0;
export function resetFns(): void {
  for (let i = 0; i < nFn; i++) if (inCode(fnPc[i])) store<u16>(fnMarkPtr + (<usize>(fnPc[i] - codeBase) >> 1), 0);
  nFn = 0;
}
export function setFnLimit(n: i32): void { fnLimit = n < FN_CAP ? n : FN_CAP; }
export function addFn(pc: u64, force: bool): i32 {
  if (inCode(pc)) {
    let p = fnMarkPtr + (<usize>(pc - codeBase) >> 1);
    let m = load<u16>(p);
    if (m != 0) return <i32>m - 1;
    if (nFn >= (force ? FN_CAP : fnLimit)) return -1;
    if (!force && (load<u8>(stateAt(pc)) & S_DONE) != 0) return -1;   // already has a translation: go through the pc map
    store<u16>(p, <u16>(nFn + 1));
  } else {
    if (!force) return -1;
    for (let i = 0; i < nFn; i++) if (fnPc[i] == pc) return i;
    if (nFn >= FN_CAP) return -1;
  }
  fnPc[nFn] = pc;
  return nFn++;
}

// ---------------------------------------------------------------------------------------------
// control-flow protocol
function idxConst(target: u64): void {
  let off = (<u32>target - optCodeLo) & ~3;
  if (off < optMapSize) { i32c(<i32>off); b(0x28); b(2); leb(optPcmapBase); } else i32c(0);
}
// stack: i64 target -> i32 table index
function idxDyn(): void {
  let t = t32(11);
  b(0xA7); i32c(<i32>optCodeLo); b(0x6B); i32c(-4); b(0x71); ltee(t); i32c(<i32>optMapSize); b(0x49);
  b(0x04); b(T_I32); lget(t); b(0x28); b(2); leb(optPcmapBase); b(0x05); i32c(0); b(0x0B);
}
// depth bookkeeping: a nested call announces depth+1, a tail transfer hands on the current depth
function depthForCall(): void { if (optDepth > 0) { lget(L_DEPTH); i32c(1); b(0x6A); gset(G_DEPTH); } }
// stack: i32 table index ->
function tailIndirect(): void {
  if (optTail) { if (optDepth > 0) { lget(L_DEPTH); gset(G_DEPTH); } b(0x13); b(0); b(0); }
  else { depthForCall(); b(0x11); b(0); b(0); b(0x0F); }
}
function pcCheck(ret: u64): void {
  gget(G_PC); i64c(<i64>ret); b(0x52); b(0x04); b(0x40); b(0x0F); b(0x0B);
  reload();
}
function budgetCheck(target: u64): void {
  gget(G_BUDGET); i32c(1); b(0x6B); ltee(L_BUD); gset(G_BUDGET);
  lget(L_BUD); i32c(0); b(0x48);
  ifVoid(); i64c(<i64>target); gset(G_PC); writeback(); b(0x0F); end();
}
// leave the function towards a constant pc (tail transfer through the table)
export function exitConst(target: u64): void {
  i64c(<i64>target); gset(G_PC); writeback(); idxConst(target); tailIndirect();
  term = true;
}
// stack: i64 target ->
export function exitDyn(): void {
  let t = t64(11);
  ltee(t); gset(G_PC); writeback(); lget(t); idxDyn(); tailIndirect();
  term = true;
}
// stack: i64 target -> ; RET
export function exitRet(): void { gset(G_PC); writeback(); b(0x0F); term = true; }
// plain exit with pc already set by the caller of this helper
export function exitNow(): void { writeback(); b(0x0F); term = true; }

// unconditional transfer to a constant pc; ends the block
export function gotoPc(target: u64, isLast: bool): void {
  let j = blockOf(target);
  if (j < 0) { exitConst(target); return; }
  addSucc(j);
  if (j > curBlk) {
    if (!(isLast && j == curBlk + 1 && ifDepth == 0)) { b(0x0C); leb(j - curBlk - 1 + ifDepth); }
  } else {
    budgetCheck(target);
    i32c(j); lset(L_STATE); b(0x0C); leb(nBlk - 1 - curBlk + ifDepth);
  }
  term = true;
}
// stack: i32 cond -> ; conditional transfer, falls through otherwise
export function branchIf(target: u64): void {
  let j = blockOf(target);
  if (j > curBlk) { addSucc(j); b(0x0D); leb(j - curBlk - 1); return; }
  ifVoid(); gotoPc(target, false); end();
  term = false;
}
// BL to constant target
export function callConst(target: u64, ret: u64): void {
  i64c(<i64>ret); rset(30);
  let f = addFn(target, false);
  depthForCall();
  if (f >= 0) { writeback(); b(0x10); leb(NIMPF + f); }
  else { i64c(<i64>target); gset(G_PC); writeback(); idxConst(target); b(0x11); b(0); b(0); }
  pcCheck(ret);
}
// stack: i64 target -> ; BLR
export function callDyn(ret: u64): void {
  let t = t64(11);
  ltee(t); gset(G_PC);
  i64c(<i64>ret); rset(30);
  depthForCall();
  writeback(); lget(t); idxDyn(); b(0x11); b(0); b(0);
  pcCheck(ret);
}
export function emitSvc(imm: u32, ret: u64): void {
  i64c(<i64>ret); gset(G_PC); writeback(); i32c(<i32>imm); b(0x10); leb(F_SVC);
  pcCheck(ret);
}
// call an import that reports (pc, arg) and stop: unimpl / brk
export function emitTrap(fn: u32, pc: u64, arg: u32): void {
  i64c(<i64>pc); gset(G_PC); writeback();
  i64c(<i64>pc); i32c(<i32>arg); b(0x10); leb(fn);
  i32c(-1); gset(G_BUDGET); b(0x0F);
  term = true;
}

// ---------------------------------------------------------------------------------------------
export function resetLocals(): void { nLoc = 0; }
export function initEmit(): void {
  fbBase = heap.alloc(FB_CAP);
}
export function beginFunction(): void {
  P = fbBase; nEv = 0; nIns = 0; ifDepth = 0; overflow = false;
  for (let i = 0; i < NREG; i++) regLoc[i] = -1;
  for (let i = 0; i < 80; i++) tmpLoc[i] = -1;
  cmpA32 = -1; cmpB32 = -1; cmpA64 = -1; cmpB64 = -1;
  nLoc = 0; newLocal(T_I32); newLocal(T_I32); newLocal(T_I32);
  lastCmp = 0;
}
