// nxweb a64: function discovery, per-function assembly (register cache analysis), unit and core
// module builders.
import {
  b, leb, i32c, i64c, lget, lset, ltee, gget, gset, simd, P, setP,
  optPcmapBase, optMaxInsns, optMaxFuncs, optTail, optShared, optPrecise, pcmapLookup, writeback,
  inCode, inWin, setWin, WINDOW, insnAt, markAt, findRange, noRange, curLo, curHi, isEntry, isDone, M_VIS, M_LEAD,
  NREG, G_PC, G_BUDGET, G_TBASE, G_DEPTH, NGLOB, NIMPF, F_UNIMPL, F_LIBC, T_I32, T_I64, T_V128, optDepth, L_DEPTH,
  locTy, nLoc, regLocalRaw, resetLocals, newLocal, L_STATE, L_BUD,
  EV_R, EV_W, EV_WB, EV_RELOAD, evBuf, nEv, insPos, insKind, insMI, insMV, nIns, fbBase, overflow,
  rollback, blkPc, succ0, succ1, nBlk, setNBlk, setCurBlk, term, setTerm, gotoPc, emitTrap,
  fnPc, nFn, resetFns, setFnLimit, addFn, initEmit, balloc, ballocEnd, mk, beginFunction, FB_CAP, optChunk, fnLimit,
  M64, optMaxPages,
} from "./emit";
import { trDpImm, trDpReg, trBranchSys, trLoadStoreInt } from "./int";
import { trFp, trLoadStoreVec } from "./fp";

// ---------------------------------------------------------------------------------------------
const HDR_MAX: usize = 128 << 10;
const CS_CAP: usize = 8 << 20;
const SIDE_CAP: i32 = 250000;      // instructions per unit in the offset -> pc side table
const REC_CAP: i32 = 8192;
let sidePtr: usize = 0;            // unit side table: (code offset: u32, guest pc: u32) per instruction
let nSide: i32 = 0;
let recPtr: usize = 0;             // per function: (fb offset: u32, guest pc: u32)
let nRec: i32 = 0;
let hdrLen: u32 = 0;
let csBase: usize = 0;     // code section bodies start at csBase + HDR_MAX
let csP: usize = 0;
let hdrTmp: usize = 0;
let entryPtr: usize = 0;
let metaPtr: usize = 0;
let outP: usize = 0;
const ENTRY_CAP = 4096;
const SINGLE_RUN = 255;   // single-instruction mode: instructions taken along after an entry
let unitInsns: u32 = 0;

export function init(): void {
  initEmit();
  csBase = balloc(CS_CAP);
  hdrTmp = balloc(HDR_MAX);
  entryPtr = balloc(ENTRY_CAP * 8);
  metaPtr = balloc(16 + 4096 * 9);
  sidePtr = balloc(<usize>SIDE_CAP * 8);
  recPtr = balloc(<usize>REC_CAP * 8);
}
export function sideBuf(): usize { return sidePtr; }
// end of everything this module keeps in the shared memory (static data + buffers)
export function staticEnd(): usize { return ballocEnd(); }
export function staticBase(): usize { return <usize>ASC_MEMORY_BASE; }
export function addrBits(): i32 { return M64 ? 64 : 32; }   // the linear memory this build translates for
export function entryBuf(): usize { return entryPtr; }
export function metaBuf(): usize { return metaPtr; }
export function outPtr(): usize { return outP; }

function patch5(at: usize, v: u32): void {
  store<u8>(at, (v & 0x7F) | 0x80); store<u8>(at + 1, ((v >> 7) & 0x7F) | 0x80);
  store<u8>(at + 2, ((v >> 14) & 0x7F) | 0x80); store<u8>(at + 3, ((v >> 21) & 0x7F) | 0x80);
  store<u8>(at + 4, v >> 28);
}
function name(s: string): void { leb(s.length); for (let i = 0; i < s.length; i++) b(s.charCodeAt(i)); }
function nameN(s: string, n: i32): void {
  let l = s.length + (n >= 10 ? 2 : 1);
  leb(l); for (let i = 0; i < s.length; i++) b(s.charCodeAt(i));
  if (n >= 10) b(48 + n / 10);
  b(48 + n % 10);
}
function globName(g: i32): void {
  if (g < 31) nameN("x", g);
  else if (g == 31) name("sp");
  else if (g == 32) name("nf"); else if (g == 33) name("zf"); else if (g == 34) name("cf"); else if (g == 35) name("vf");
  else if (g < 68) nameN("v", g - 36);
  else if (g == 68) name("pc"); else if (g == 69) name("fpcr"); else if (g == 70) name("fpsr");
  else if (g == 71) name("tpidr"); else if (g == 72) name("tpidrro"); else if (g == 73) name("excl_addr");
  else if (g == 74) name("excl_val"); else if (g == 75) name("budget"); else if (g == 76) name("excl_val2");
  else if (g == 77) name("depth");
  else name("table_base");
}
function globType(g: i32): u8 {
  if (g < 32) return T_I64;
  if (g < 36) return T_I32;
  if (g < 68) return T_V128;
  if (g == 69 || g == 70 || g == 75 || g == 77 || g == 78) return T_I32;
  return T_I64;
}
// the limits of the imported memory. memory64: flag bit 2 (an i64 memory), shared with the maximum the embedder set
function memLimits(): void {
  if (M64) { if (optShared) { b(7); b(0); leb(optMaxPages); } else { b(4); b(0); } return; }
  if (optShared) { b(3); b(0); leb(65536); } else { b(0); b(0); }
}
// stack: -> i32: is pc one of the embedder's special values, 0xFFFF_FF00 .. 0xFFFF_FFFF? (memory64: code may lie
// above them, so it is a window, not a lower bound)
function hostPc(): void {
  gget(G_PC); i64c(0xFFFFFF00);
  if (M64) { b(0x7D); i64c(0x100); b(0x54); } else b(0x5A);
}
function secBegin(id: u32): usize { b(id); let at = P; setP(P + 5); return at; }
function secEnd(at: usize): void { patch5(at, <u32>(P - at - 5)); }

// ---------------------------------------------------------------------------------------------
// discovery
const WL_CAP = 8192;
const wl = mk<u64>(WL_CAP);
let wlN: i32 = 0;
const TOUCH_CAP = 65536;
const touched = mk<u64>(TOUCH_CAP);
let nTouched: i32 = 0;
let minPc: u64 = 0, maxPc: u64 = 0;

// @ts-ignore
@inline function sx(x: u32, bits: u32): i64 { return <i64>((<i32>(x << (32 - bits))) >> (32 - bits)); }

function lead(pc: u64, entry: u64): void {
  if (!inCode(pc) || !inWin(pc)) return;
  let p = markAt(pc);
  let m = load<u16>(p);
  if (m & M_LEAD) return;
  if (m == 0) { if (nTouched >= TOUCH_CAP) return; touched[nTouched++] = pc; }
  store<u16>(p, m | M_LEAD);
  if (wlN < WL_CAP) wl[wlN++] = pc;
}

function discover(entry: u64): i32 {
  wlN = 0; nTouched = 0; minPc = entry; maxPc = entry;
  setWin(entry);
  let nVis = 0;
  lead(entry, entry);
  while (wlN > 0) {
    let pc = wl[--wlN];
    while (true) {
      if (!inCode(pc) || !inWin(pc)) break;
      let p = markAt(pc);
      let m = load<u16>(p);
      if (m & M_VIS) break;
      if (nVis >= optMaxInsns) break;
      if (m == 0) { if (nTouched >= TOUCH_CAP) break; touched[nTouched++] = pc; }
      store<u16>(p, m | M_VIS); nVis++;
      if (pc < minPc) minPc = pc;
      if (pc > maxPc) maxPc = pc;
      let insn = insnAt(pc);
      if ((insn & 0x7C000000) == 0x14000000) {
        if (insn >>> 31) { pc += 4; continue; }
        lead(pc + <u64>(sx(insn & 0x3FFFFFF, 26) << 2), entry);
        break;
      }
      if ((insn & 0xFF000010) == 0x54000000 || (insn & 0x7E000000) == 0x34000000) {
        lead(pc + <u64>(sx((insn >> 5) & 0x7FFFF, 19) << 2), entry);
        if ((insn & 0xFF00001E) == 0x5400000E) break;   // b.al
        lead(pc + 4, entry); pc += 4; continue;
      }
      if ((insn & 0x7E000000) == 0x36000000) {
        lead(pc + <u64>(sx((insn >> 5) & 0x3FFF, 14) << 2), entry);
        lead(pc + 4, entry); pc += 4; continue;
      }
      if ((insn & 0xFFFFFC1F) == 0xD61F0000 || (insn & 0xFFFFFC1F) == 0xD65F0000) break; // BR / RET
      if ((insn & 0xFE9FF800) == 0xD61F0800 && ((insn >> 21) & 3) != 1) break;           // BRAA.. / RETAA / RETAB
      if ((insn & 0xFFE0001F) == 0xD4200000 || insn == 0) break;                         // BRK / UDF
      pc += 4;
    }
  }
  // number the blocks in address order
  let n = 0;
  for (let pc = minPc; pc <= maxPc; pc += 4) {
    let p = markAt(pc);
    let m = load<u16>(p);
    if ((m & (M_VIS | M_LEAD)) == (M_VIS | M_LEAD)) {
      blkPc[n] = pc; succ0[n] = -1; succ1[n] = -1;
      store<u16>(p, M_VIS | M_LEAD | <u16>n);
      n++;
    }
  }
  setNBlk(n);
  return n;
}
function clearMarks(): void {
  for (let i = 0; i < nTouched; i++) store<u16>(markAt(touched[i]), 0);
}

// ---------------------------------------------------------------------------------------------
function translateInsn(pc: u64, insn: u32): void {
  let p = P, e = nEv, i = nIns;
  let ok = false;
  let op0 = (insn >> 25) & 15;
  if (optPrecise != 0 && ((op0 & 5) == 4 || (insn & 0xFFFFFFE0) == 0xD50B7420)) {
    // precise faults: the embedder sees this pc (and with level 2 every register) if the access traps
    i64c(<i64>pc); gset(G_PC);
    if (optPrecise >= 2) writeback();
  }
  ok = decode(pc, insn);
  if (!ok) { rollback(p, e, i); emitTrap(F_UNIMPL, pc, insn); }
}
// The decoder: emits the translation of one instruction, or answers false for a word outside the implemented set
// (the caller rolls back what was emitted). The one place that decides; `translateInsn` and `probe` both ask it.
function decode(pc: u64, insn: u32): bool {
  let op0 = (insn >> 25) & 15;
  if ((op0 & 14) == 8) return trDpImm(pc, insn);
  if ((op0 & 14) == 10) return trBranchSys(pc, insn);
  if ((op0 & 5) == 4) return (insn & (1 << 26)) ? trLoadStoreVec(pc, insn) : trLoadStoreInt(pc, insn);
  if ((op0 & 7) == 5) return trDpReg(pc, insn);
  if ((op0 & 7) == 7) return trFp(pc, insn);
  return false;
}

// Is this instruction word translatable? The word goes through the decoder as if it were being translated (into a
// scratch function at a pc outside every code range) and what was emitted is thrown away. The static scan
// (scan.ts) and the coverage tooling ask this.
export function probe(insn: u32): i32 {
  beginFunction(); setNBlk(1); setCurBlk(0); succ0[0] = -1; succ1[0] = -1;
  let pc: u64 = 0x10000;
  noRange(); setWin(pc);
  return decode(pc, insn) ? 1 : 0;
}

// analysis state
const BLK_CAP = 16384;
const evStart = mk<i32>(BLK_CAP + 1);
const dI = mk<u64>(BLK_CAP);
const dV = mk<u32>(BLK_CAP);
const nI = mk<u64>(BLK_CAP);
const nV = mk<u32>(BLK_CAP);

function analyse(): void {
  let n = nBlk;
  for (let k = 0; k < n; k++) { dI[k] = 0; dV[k] = 0; nI[k] = 0; nV[k] = 0; }
  // forward: may-dirty
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = 0; k < n; k++) {
      let di = dI[k], dv = dV[k];
      for (let e = evStart[k], ee = evStart[k + 1]; e < ee; e++) {
        let x = evBuf[e], kind = x & 0xFF, r = x >> 8;
        if (kind == EV_W) { if (r < 36) di |= <u64>1 << r; else dv |= <u32>1 << (r - 36); }
        else if (kind == EV_WB) { insMI[r] = di; insMV[r] = dv; }
        else if (kind == EV_RELOAD) { di = 0; dv = 0; }
      }
      for (let s = 0; s < 2; s++) {
        let j = s == 0 ? succ0[k] : succ1[k];
        if (j < 0) continue;
        if ((dI[j] | di) != dI[j] || (dV[j] | dv) != dV[j]) { dI[j] |= di; dV[j] |= dv; changed = true; }
      }
    }
  }
  // backward: locals that must hold a valid value
  changed = true;
  while (changed) {
    changed = false;
    for (let k = n - 1; k >= 0; k--) {
      let ni: u64 = 0, nv: u32 = 0;
      if (succ0[k] >= 0) { ni |= nI[succ0[k]]; nv |= nV[succ0[k]]; }
      if (succ1[k] >= 0) { ni |= nI[succ1[k]]; nv |= nV[succ1[k]]; }
      for (let e = evStart[k + 1] - 1, es = evStart[k]; e >= es; e--) {
        let x = evBuf[e], kind = x & 0xFF, r = x >> 8;
        if (kind == EV_R) { if (r < 36) ni |= <u64>1 << r; else nv |= <u32>1 << (r - 36); }
        else if (kind == EV_W) { if (r < 36) ni &= ~(<u64>1 << r); else nv &= ~(<u32>1 << (r - 36)); }
        else if (kind == EV_WB) { ni |= insMI[r]; nv |= insMV[r]; }
        else { insMI[r] = ni; insMV[r] = nv; ni = 0; nv = 0; }
      }
      if (ni != nI[k] || nv != nV[k]) { nI[k] |= ni; nV[k] |= nv; changed = true; }
    }
  }
}

function emitMasked(mi: u64, mv: u32, isWb: bool): void {
  for (let r = 0; r < NREG; r++) {
    let on = r < 36 ? ((mi >> r) & 1) != 0 : ((mv >> (r - 36)) & 1) != 0;
    if (!on) continue;
    let l = <u32>regLocalRaw(r);
    if (isWb) { lget(l); gset(r); } else { gget(r); lset(l); }
  }
}

function emitLocals(first: u32): void {
  // run-length groups
  let groups: u32 = 0;
  for (let i = first; i < nLoc; i++) if (i == first || locTy[i] != locTy[i - 1]) groups++;
  leb(groups);
  let i = first;
  while (i < nLoc) {
    let j = i;
    while (j < nLoc && locTy[j] == locTy[i]) j++;
    leb(j - i); b(locTy[i]);
    i = j;
  }
}

// Library functions the host named (setIntrinsic: a module's definition of memcpy, strlen, ...): a function at one of
// these pcs is translated as one call of the helpers' libc(op, x0, x1, x2) into x0 and a return to x30 (libc.ts)
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
function intrinsicAt(pc: u64): i32 { for (let i = 0; i < nIntr; i++) if (intrPc[i] == pc) return intrOp[i]; return 0; }
function intrinsicFunction(op: i32): void {
  let start = csP; setP(csP + 5);
  b(0);
  i32c(op); gget(0); gget(1); gget(2); b(0x10); leb(F_LIBC); gset(0);
  gget(30); gset(G_PC);
  b(0x0B);
  patch5(start, <u32>(P - start - 5));
  csP = P;
}

function stubFunction(entry: u64): void {
  let start = csP; setP(csP + 5);
  b(0);
  i64c(<i64>entry); gset(G_PC); i32c(0);
  if (optTail) { b(0x13); b(0); b(0); } else { b(0x11); b(0); b(0); }
  b(0x0B);
  patch5(start, <u32>(P - start - 5));
  csP = P;
}

function translateFunction(entry: u64): bool {
  if (!findRange(entry)) return false;
  if (csP + 2 * FB_CAP > csBase + CS_CAP) return false;
  let n = discover(entry);
  nRec = 0;
  beginFunction();
  let entryBlk = 0;
  for (let k = 0; k < n; k++) {
    if (blkPc[k] == entry) entryBlk = k;
    setCurBlk(k);
    evStart[k] = nEv;
    let pc = blkPc[k];
    while (true) {
      if (nRec < REC_CAP) { store<u32>(recPtr + (<usize>nRec << 3), <u32>(P - fbBase)); store<u32>(recPtr + (<usize>nRec << 3) + 4, <u32>pc); nRec++; }
      translateInsn(pc, insnAt(pc)); unitInsns++;
      pc += 4;
      if (term) break;
      if (!inCode(pc)) break;
      let m = load<u16>(markAt(pc));
      if ((m & M_VIS) == 0 || (m & M_LEAD) != 0) break;
      if (<usize>(P - fbBase) > FB_CAP - (64 << 10)) break;
    }
    if (!term) gotoPc(pc, true);
    b(0x0B);
  }
  evStart[n] = nEv;
  let bodyEnd = P;
  let bad = overflow || <usize>(bodyEnd - fbBase) > FB_CAP - (32 << 10);
  if (bad || nSide + nRec > SIDE_CAP) { clearMarks(); return false; }
  analyse();
  clearMarks();
  // assemble
  let start = csP; setP(csP + 5);
  emitLocals(0);
  gget(G_BUDGET); i32c(1); b(0x6B); ltee(L_BUD); gset(G_BUDGET);
  lget(L_BUD); i32c(0); b(0x48);
  if (optDepth > 0) { gget(G_DEPTH); ltee(L_DEPTH); i32c(optDepth); b(0x4A); b(0x72); }
  b(0x04); b(0x40); i64c(<i64>entry); gset(G_PC); b(0x0F); b(0x0B);
  emitMasked(nI[entryBlk], nV[entryBlk], false);
  if (entryBlk) { i32c(entryBlk); lset(L_STATE); }
  b(0x03); b(0x40);
  for (let k = 0; k < n; k++) { b(0x02); b(0x40); }
  lget(L_STATE); b(0x0E); leb(n - 1);
  for (let k = 0; k < n; k++) leb(k);
  b(0x0B);
  let src = fbBase;
  let ri = 0;
  let cs0 = csBase + HDR_MAX;
  for (let i = 0; i < nIns; i++) {
    let at = fbBase + insPos[i];
    let len = at - src;
    // instructions starting in this piece: final offset = where the piece lands + distance into it
    while (ri < nRec && load<u32>(recPtr + (<usize>ri << 3)) <= insPos[i]) {
      store<u32>(sidePtr + (<usize>nSide << 3), <u32>(P - cs0) + (load<u32>(recPtr + (<usize>ri << 3)) - <u32>(src - fbBase)));
      store<u32>(sidePtr + (<usize>nSide << 3) + 4, load<u32>(recPtr + (<usize>ri << 3) + 4));
      nSide++; ri++;
    }
    memory.copy(P, src, len); setP(P + len); src = at;
    emitMasked(insMI[i], insMV[i], insKind[i] == EV_WB);
  }
  while (ri < nRec) {
    store<u32>(sidePtr + (<usize>nSide << 3), <u32>(P - cs0) + (load<u32>(recPtr + (<usize>ri << 3)) - <u32>(src - fbBase)));
    store<u32>(sidePtr + (<usize>nSide << 3) + 4, load<u32>(recPtr + (<usize>ri << 3) + 4));
    nSide++; ri++;
  }
  let len = bodyEnd - src;
  memory.copy(P, src, len); setP(P + len);
  b(0x0B);
  patch5(start, <u32>(P - start - 5));
  csP = P;
  return true;
}

// translate a unit: entry pcs are in entryBuf (u64 each). Returns module byte length (0 on failure).
export function translate(nEntries: i32): u32 {
  if (nEntries > ENTRY_CAP) nEntries = ENTRY_CAP;
  resetFns();
  setFnLimit(optMaxFuncs > nEntries ? optMaxFuncs : nEntries);
  for (let i = 0; i < nEntries; i++) addFn(load<u64>(entryPtr + (<usize>i << 3)), true);
  if (optChunk != 0) {
    // region mode: take along the untranslated known entries of each entry's chunk (same code range only)
    for (let i = 0; i < nEntries; i++) {
      let e = load<u64>(entryPtr + (<usize>i << 3));
      if (!findRange(e)) continue;
      let lo = e & ~(<u64>optChunk - 1), hi = lo + optChunk;
      if (lo < curLo) lo = curLo;
      if (hi > curHi) hi = curHi;
      for (let pc = lo; pc < hi && nFn < fnLimit; pc += 4) {
        if (isEntry(pc) && !isDone(pc)) addFn(pc, true);
      }
    }
  }
  if (optMaxInsns == 1) {
    // single-instruction mode: every function is one instruction, and the instruction after it is entered through
    // the pc map. A module per instruction costs the engine hundreds of kilobytes each (a program that runs seven
    // thousand different instructions took 2 GB), so the instructions that follow each entry in its code range and
    // have no translation yet come along as functions of this unit, up to the unit's function limit.
    for (let i = 0; i < nEntries; i++) {
      let e = load<u64>(entryPtr + (<usize>i << 3));
      if (!findRange(e)) continue;
      for (let pc = e + 4, n = 0; pc < curHi && n < SINGLE_RUN && nFn < fnLimit; pc += 4, n++) {
        if (isDone(pc)) break;
        addFn(pc, true);
      }
    }
  }
  csP = csBase + HDR_MAX; unitInsns = 0; nSide = 0;
  for (let f = 0; f < nFn; f++) {
    let op = intrinsicAt(fnPc[f]);
    if (op) { intrinsicFunction(op); store<u8>(metaPtr + 16 + 4096 * 8 + f, 0); unitInsns++; continue; }
    let ok = translateFunction(fnPc[f]);
    store<u8>(metaPtr + 16 + 4096 * 8 + f, ok ? 0 : 1);
    if (!ok) stubFunction(fnPc[f]);
  }
  let codeEnd = csP;
  // name section after the code: f_<hex pc> per function, so that a trap's stack frame identifies the unit
  setP(csP);
  let ns = secBegin(0);
  name("name");
  b(1); let sub = P; setP(P + 5);
  leb(nFn);
  for (let f = 0; f < nFn; f++) {
    leb(NIMPF + f);
    let pc = fnPc[f];
    let digits = 1; for (let v = pc >> 4; v != 0; v >>= 4) digits++;
    leb(2 + digits); b(0x66); b(0x5F);
    for (let d = digits - 1; d >= 0; d--) { let x = <u32>((pc >> (<u64>d * 4)) & 15); b(x < 10 ? 48 + x : 87 + x); }
  }
  patch5(sub, <u32>(P - sub - 5));
  secEnd(ns);
  let modEnd = P;
  // header into hdrTmp
  setP(hdrTmp);
  b(0); b(0x61); b(0x73); b(0x6D); b(1); b(0); b(0); b(0);
  let s = secBegin(1);
  leb(16);
  b(0x60); b(0); b(0);
  b(0x60); b(1); b(T_I32); b(0);
  b(0x60); b(2); b(T_I64); b(T_I32); b(0);
  b(0x60); b(0); b(1); b(T_I64);
  b(0x60); b(4); b(T_I32); b(T_I64); b(T_I32); b(T_I32); b(1); b(T_I32);
  b(0x60); b(4); b(T_I32); b(T_V128); b(T_V128); b(T_V128); b(1); b(T_V128);
  b(0x60); b(1); b(0x7D); b(1); b(0x7D);
  b(0x60); b(1); b(0x7C); b(1); b(0x7C);
  b(0x60); b(2); b(0x7D); b(0x7D); b(1); b(0x7D);
  b(0x60); b(2); b(0x7C); b(0x7C); b(1); b(0x7C);
  b(0x60); b(3); b(0x7D); b(0x7D); b(0x7D); b(1); b(0x7D);
  b(0x60); b(3); b(0x7C); b(0x7C); b(0x7C); b(1); b(0x7C);
  b(0x60); b(2); b(T_I32); b(T_I64); b(1); b(T_I64);
  b(0x60); b(3); b(T_I32); b(0x7D); b(0x7D); b(1); b(0x7D);
  b(0x60); b(3); b(T_I32); b(0x7C); b(0x7C); b(1); b(0x7C);
  b(0x60); b(4); b(T_I32); b(T_I64); b(T_I64); b(T_I64); b(1); b(T_I64);
  secEnd(s);
  s = secBegin(2);
  leb(2 + NGLOB + NIMPF);
  name("env"); name("memory"); b(2); memLimits();
  name("env"); name("table"); b(1); b(0x70); b(0); b(0);
  for (let g = 0; g < NGLOB; g++) {
    if (g == G_TBASE) { name("env"); globName(g); b(3); b(T_I32); b(0); }
    else { name("cpu"); globName(g); b(3); b(globType(g)); b(1); }
  }
  name("env"); name("svc"); b(0); b(1);
  name("env"); name("unimpl"); b(0); b(2);
  name("env"); name("brk"); b(0); b(2);
  name("env"); name("cntpct"); b(0); b(3);
  name("cpu"); name("crc32"); b(0); b(4);
  name("hlp"); name("vop"); b(0); b(5);
  name("hlp"); name("nan1s"); b(0); b(6);
  name("hlp"); name("nan1d"); b(0); b(7);
  name("hlp"); name("nan2s"); b(0); b(8);
  name("hlp"); name("nan2d"); b(0); b(9);
  name("hlp"); name("nan3s"); b(0); b(10);
  name("hlp"); name("nan3d"); b(0); b(11);
  name("hlp"); name("rnd"); b(0); b(12);
  name("hlp"); name("rariths"); b(0); b(13);
  name("hlp"); name("rarithd"); b(0); b(14);
  name("hlp"); name("libc"); b(0); b(15);
  secEnd(s);
  s = secBegin(3);
  leb(nFn); for (let f = 0; f < nFn; f++) b(0);
  secEnd(s);
  s = secBegin(9);
  leb(1); b(0); gget(G_TBASE); b(0x0B); leb(nFn);
  for (let f = 0; f < nFn; f++) leb(NIMPF + f);
  secEnd(s);
  s = secBegin(10);
  leb(nFn);
  patch5(s, <u32>(P - s - 5 + (codeEnd - (csBase + HDR_MAX))));
  let hlen = P - hdrTmp;
  outP = csBase + HDR_MAX - hlen;
  memory.copy(outP, hdrTmp, hlen);
  // meta: nFn, guest instructions, side table entries, header length (side offsets are relative to the code bodies)
  store<u32>(metaPtr, nFn); store<u32>(metaPtr + 4, unitInsns); store<u32>(metaPtr + 8, nSide); store<u32>(metaPtr + 12, <u32>hlen);
  for (let f = 0; f < nFn; f++) store<u64>(metaPtr + 16 + (<usize>f << 3), fnPc[f]);
  return <u32>(modEnd - outP);
}

// ---------------------------------------------------------------------------------------------
// core module
let coreStart: usize = 0;
function coreFnBegin(): void { beginFunction(); resetLocals(); coreStart = csP; }
function coreFnEnd(nParams: u32): void {
  b(0x0B);
  let bodyEnd = P;
  setP(csP + 5);
  emitLocals(nParams);
  let len = bodyEnd - fbBase;
  memory.copy(P, fbBase, len); setP(P + len);
  patch5(csP, <u32>(P - csP - 5));
  csP = P;
}
function idxFromPc(tmp: u32): void { gget(G_PC); pcmapLookup(tmp); }

export function buildCore(): u32 {
  csP = csBase + HDR_MAX;
  // 1: trampoline
  coreFnBegin();
  hostPc(); b(0x04); b(0x40); b(0x0F); b(0x0B);
  gget(G_PC); b(0x10); b(0);
  if (optTail) { b(0x13); b(0); b(0); } else { b(0x11); b(0); b(0); }
  coreFnEnd(0);
  // 2: stop
  coreFnBegin(); i32c(-1); gset(G_BUDGET); coreFnEnd(0);
  // 3: run
  coreFnBegin();
  let t = newLocal(M64 ? T_I64 : T_I32);
  b(0x02); b(0x40); b(0x03); b(0x40);
  hostPc(); b(0x0D); b(1);
  gget(G_BUDGET); i32c(0); b(0x48); b(0x0D); b(1);
  i32c(0); gset(G_DEPTH);
  idxFromPc(t); b(0x11); b(0); b(0);
  b(0x0C); b(0);
  b(0x0B); b(0x0B);
  coreFnEnd(0);
  // 4: save_ctx(ptr)
  coreFnBegin(); newLocal(M64 ? T_I64 : T_I32);
  for (let i = 0; i < 32; i++) { lget(0); gget(i); b(0x37); b(0); leb(i * 8); }
  lget(0); gget(G_PC); b(0x37); b(0); leb(0x100);
  lget(0); gget(32); i32c(3); b(0x74); gget(33); i32c(2); b(0x74); b(0x72); gget(34); i32c(1); b(0x74); b(0x72); gget(35); b(0x72);
  b(0x36); b(0); leb(0x108);
  lget(0); gget(69); b(0x36); b(0); leb(0x10C);
  lget(0); gget(70); b(0x36); b(0); leb(0x110);
  lget(0); gget(71); b(0x37); b(0); leb(0x118);
  lget(0); gget(72); b(0x37); b(0); leb(0x120);
  for (let i = 0; i < 32; i++) { lget(0); gget(36 + i); simd(0x0B); b(0); leb(0x130 + i * 16); }
  coreFnEnd(1);
  // 5: load_ctx(ptr)
  coreFnBegin(); newLocal(M64 ? T_I64 : T_I32);
  for (let i = 0; i < 32; i++) { lget(0); b(0x29); b(0); leb(i * 8); gset(i); }
  lget(0); b(0x29); b(0); leb(0x100); gset(G_PC);
  for (let i = 0; i < 4; i++) { lget(0); b(0x28); b(0); leb(0x108); i32c(3 - i); b(0x76); i32c(1); b(0x71); gset(32 + i); }
  lget(0); b(0x28); b(0); leb(0x10C); gset(69);
  lget(0); b(0x28); b(0); leb(0x110); gset(70);
  lget(0); b(0x29); b(0); leb(0x118); gset(71);
  lget(0); b(0x29); b(0); leb(0x120); gset(72);
  for (let i = 0; i < 32; i++) { lget(0); simd(0x00); b(0); leb(0x130 + i * 16); gset(36 + i); }
  coreFnEnd(1);
  // 6: crc32(acc i32, data i64, nbits i32, poly i32) -> i32
  coreFnBegin(); newLocal(T_I32); newLocal(T_I64); newLocal(T_I32); newLocal(T_I32);
  let sv = newLocal(T_I64);
  lget(1); i64c(-1); i64c(64); lget(2); b(0xAD); b(0x7D); b(0x88); b(0x83); lget(0); b(0xAD); b(0x85); lset(sv);
  b(0x02); b(0x40); b(0x03); b(0x40);
  lget(2); b(0x45); b(0x0D); b(1);
  lget(sv); i64c(1); b(0x88); i64c(0); lget(sv); i64c(1); b(0x83); b(0x7D); lget(3); b(0xAD); b(0x83); b(0x85); lset(sv);
  lget(2); i32c(1); b(0x6B); lset(2);
  b(0x0C); b(0);
  b(0x0B); b(0x0B);
  lget(sv); b(0xA7);
  coreFnEnd(4);
  let codeEnd = csP;

  setP(hdrTmp);
  b(0); b(0x61); b(0x73); b(0x6D); b(1); b(0); b(0); b(0);
  let s = secBegin(1);
  leb(4);
  b(0x60); b(0); b(0);
  b(0x60); b(1); b(T_I64); b(1); b(T_I32);
  b(0x60); b(1); b(M64 ? T_I64 : T_I32); b(0);   // save_ctx / load_ctx (ptr)
  b(0x60); b(4); b(T_I32); b(T_I64); b(T_I32); b(T_I32); b(1); b(T_I32);
  secEnd(s);
  s = secBegin(2);
  leb(3);
  name("env"); name("memory"); b(2); memLimits();
  name("env"); name("table"); b(1); b(0x70); b(0); b(2);
  name("env"); name("translate"); b(0); b(1);
  secEnd(s);
  s = secBegin(3);
  leb(6); b(0); b(0); b(0); b(2); b(2); b(3);
  secEnd(s);
  s = secBegin(6);
  leb(G_TBASE);
  for (let g = 0; g < G_TBASE; g++) {
    let ty = globType(g);
    b(ty); b(1);
    if (ty == T_I64) { b(0x42); b(0); } else if (ty == T_I32) { b(0x41); b(0); } else { simd(0x0C); for (let i = 0; i < 16; i++) b(0); }
    b(0x0B);
  }
  secEnd(s);
  s = secBegin(7);
  leb(G_TBASE + 6);
  for (let g = 0; g < G_TBASE; g++) { globName(g); b(3); leb(g); }
  name("trampoline"); b(0); b(1);
  name("stop"); b(0); b(2);
  name("run"); b(0); b(3);
  name("save_ctx"); b(0); b(4);
  name("load_ctx"); b(0); b(5);
  name("crc32"); b(0); b(6);
  secEnd(s);
  s = secBegin(9);
  leb(1); b(0); i32c(0); b(0x0B); leb(2); b(1); b(2);
  secEnd(s);
  s = secBegin(10);
  leb(6);
  patch5(s, <u32>(P - s - 5 + (codeEnd - (csBase + HDR_MAX))));
  let hlen = P - hdrTmp;
  outP = csBase + HDR_MAX - hlen;
  memory.copy(outP, hdrTmp, hlen);
  return <u32>(codeEnd - outP);
}
