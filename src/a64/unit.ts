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
  M64, optMaxPages, blockOf,
} from "./emit";
import { posOf, optProf, STRUCT_CAP, structOn, structFail, setStruct, lvBlk, lvWrap, fwLo, lvLoop, loopEnd } from "./emit";
import { prof, profBase, intrinsicAt, insSite, RL_ENTRY, insMode, insG, INS_CALL, INS_BACK, INS_AFTER, INS_SEQ, writebackSeq, sRI, sRV, sWI, sWV, sOk, accRI, accRV, accWI, accWV, accAll, resetAcc } from "./emit";
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
    if (optPrecise >= 2) writebackSeq();
  }
  prof(10, 1); if (!structOn) prof(30, 1); prof((op0 & 5) == 4 ? 11 : (op0 & 14) == 8 ? 12 : (op0 & 14) == 10 ? 13 : (op0 & 7) == 5 ? 14 : 15, 1);
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
const evEnd = mk<i32>(BLK_CAP);
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
      for (let e = evStart[k], ee = evEnd[k]; e < ee; e++) {
        let x = evBuf[e], kind = x & 0xFF, r = x >> 8;
        if (kind == EV_W) { if (r < 36) di |= <u64>1 << r; else dv |= <u32>1 << (r - 36); }
        else if (kind == EV_WB) {
          let m = insMode[r], g = <i32>insG[r];
          insMI[r] = m == INS_CALL ? di & (sRI[g] | sWI[g]) : m == INS_BACK ? di & ~sWI[g] : di;
          insMV[r] = m == INS_CALL ? dv & (sRV[g] | sWV[g]) : m == INS_BACK ? dv & ~sWV[g] : dv;
          if (m == INS_SEQ) { di = 0; dv = 0; }
        }
        else if (kind == EV_RELOAD) {
          if (insMode[r] == INS_AFTER) { let g = <i32>insG[r]; di &= ~(sRI[g] | sWI[g]); dv &= ~(sRV[g] | sWV[g]); }
          else { di = 0; dv = 0; }
        }
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
      for (let e = evEnd[k] - 1, es = evStart[k]; e >= es; e--) {
        let x = evBuf[e], kind = x & 0xFF, r = x >> 8;
        if (kind == EV_R) { if (r < 36) ni |= <u64>1 << r; else nv |= <u32>1 << (r - 36); }
        else if (kind == EV_W) { if (r < 36) ni &= ~(<u64>1 << r); else nv &= ~(<u32>1 << (r - 36)); }
        else if (kind == EV_WB) { ni |= insMI[r]; nv |= insMV[r]; }
        else if (insMode[r] == INS_AFTER) { let g = <i32>insG[r]; insMI[r] = ni & sWI[g]; insMV[r] = nv & sWV[g]; ni &= ~sWI[g]; nv &= ~sWV[g]; }
        else { insMI[r] = ni; insMV[r] = nv; ni = 0; nv = 0; }
      }
      if (ni != nI[k] || nv != nV[k]) { nI[k] |= ni; nV[k] |= nv; changed = true; }
    }
  }
}

function emitMasked(mi: u64, mv: u32, isWb: bool, site: u8): void {
  prof(isWb ? 8 : 9, <i64>(popcnt(mi) + <u64>popcnt(mv))); prof(17 + site, <i64>(popcnt(mi) + <u64>popcnt(mv)));
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

// Structured body (not when a function has more than STRUCT_CAP blocks). The blocks' branches are scanned; blocks are
// put in reverse post-order from the entry, loops found from the retreating edges (natural loops, innermost first;
// an edge into a loop past its header = irreducible: not structured), and each loop's blocks made contiguous (the
// header, then its blocks and inner loops in reverse post-order). Then every loop is a wasm `loop` and every region
// (the function, a loop) has a block per item after its first:
//   block..block { item0 } item1 } ... itemN      item = a block, or a loop (loop block..block { header } .. })
// A back edge is a `br` to its loop and a forward branch a `br` out of the target's block, so the engine sees the
// guest's loops. Otherwise (or when a branch the scan did not see turns up) the dispatch loop of the README.
const sc0 = mk<i32>(STRUCT_CAP);
const sc1 = mk<i32>(STRUCT_CAP);
const psc0 = mk<i32>(STRUCT_CAP);
const psc1 = mk<i32>(STRUCT_CAP);
const rpoBlk = mk<i32>(STRUCT_CAP);
const rpoOf = mk<i32>(STRUCT_CAP);
const lpar = mk<i32>(STRUCT_CAP);
const predStart = mk<i32>(STRUCT_CAP + 1);
const predList = mk<i32>(2 * STRUCT_CAP);
const firstIt = mk<i32>(STRUCT_CAP + 1);
const lastIt = mk<i32>(STRUCT_CAP + 1);
const nextIt = mk<i32>(STRUCT_CAP);
const ordBlk = mk<i32>(STRUCT_CAP);
const dStk = mk<i32>(2 * STRUCT_CAP);
const dIt = mk<i32>(STRUCT_CAP);
const seen = mk<u8>(STRUCT_CAP);
const isH = mk<u8>(STRUCT_CAP);
const hEnd = mk<i32>(STRUCT_CAP);
const par = mk<i32>(STRUCT_CAP);
const inner = mk<i32>(STRUCT_CAP);
const mItems = mk<i32>(STRUCT_CAP);
const itemT = mk<i32>(STRUCT_CAP);
const nOpen = mk<i32>(STRUCT_CAP);   // blocks opened before position p (wrappers of the function's region)
const nClose = mk<i32>(STRUCT_CAP);  // loops ending at position p
let mRoot = 0;
function scanAdd(k: i32, j: i32): void { if (j < 0) return; if (sc0[k] < 0) sc0[k] = j; else if (sc0[k] != j) sc1[k] = j; }
function structure(n: i32, entryBlk: i32): bool {
  if (n > STRUCT_CAP) return false;
  for (let k = 0; k < n; k++) {
    sc0[k] = -1; sc1[k] = -1;
    let pc = blkPc[k];
    while (true) {
      let insn = insnAt(pc);
      if ((insn & 0xFC000000) == 0x14000000) { scanAdd(k, blockOf(pc + <u64>(sx(insn & 0x3FFFFFF, 26) << 2))); break; }
      if ((insn & 0xFF000010) == 0x54000000 || (insn & 0x7E000000) == 0x34000000) {
        scanAdd(k, blockOf(pc + <u64>(sx((insn >> 5) & 0x7FFFF, 19) << 2)));
        if ((insn & 0xFF00001E) != 0x5400000E) scanAdd(k, blockOf(pc + 4));
        break;
      }
      if ((insn & 0x7E000000) == 0x36000000) {
        scanAdd(k, blockOf(pc + <u64>(sx((insn >> 5) & 0x3FFF, 14) << 2))); scanAdd(k, blockOf(pc + 4)); break;
      }
      if ((insn & 0xFFFFFC1F) == 0xD61F0000 || (insn & 0xFFFFFC1F) == 0xD65F0000) break;
      if ((insn & 0xFE9FF800) == 0xD61F0800 && ((insn >> 21) & 3) != 1) break;
      if ((insn & 0xFFE0001F) == 0xD4200000 || insn == 0) break;
      pc += 4;
      if (!inCode(pc) || !inWin(pc)) break;
      let m = load<u16>(markAt(pc));
      if ((m & M_VIS) == 0) break;
      if (m & M_LEAD) { scanAdd(k, blockOf(pc)); break; }
    }
  }
  // reverse post-order from the entry (blocks the scan does not reach go last)
  for (let k = 0; k < n; k++) seen[k] = 0;
  let nPost = 0, sp = 0;
  dStk[0] = entryBlk; dIt[0] = 0; seen[entryBlk] = 1;
  while (sp >= 0) {
    let x = dStk[sp], it = dIt[sp];
    if (it < 2) {
      dIt[sp] = it + 1;
      let y = it == 0 ? sc0[x] : sc1[x];
      if (y >= 0 && !seen[y]) { seen[y] = 1; sp++; dStk[sp] = y; dIt[sp] = 0; }
    } else { rpoBlk[nPost++] = x; sp--; }
  }
  for (let a = 0, z = nPost - 1; a < z; a++, z--) { let t = rpoBlk[a]; rpoBlk[a] = rpoBlk[z]; rpoBlk[z] = t; }
  let nR = nPost;
  for (let k = 0; k < n; k++) if (!seen[k]) rpoBlk[nR++] = k;
  for (let i = 0; i < n; i++) rpoOf[rpoBlk[i]] = i;
  // predecessors
  for (let k = 0; k <= n; k++) predStart[k] = 0;
  for (let k = 0; k < n; k++) { if (sc0[k] >= 0) predStart[sc0[k] + 1]++; if (sc1[k] >= 0) predStart[sc1[k] + 1]++; }
  for (let k = 0; k < n; k++) predStart[k + 1] += predStart[k];
  for (let k = 0; k < n; k++) dIt[k] = predStart[k];
  for (let k = 0; k < n; k++) { if (sc0[k] >= 0) predList[dIt[sc0[k]]++] = k; if (sc1[k] >= 0) predList[dIt[sc1[k]]++] = k; }
  // natural loops, innermost (latest header) first; lpar: the loop a block or an inner loop's header is in
  for (let k = 0; k < n; k++) { lpar[k] = -1; isH[k] = 0; }
  for (let i = n - 1; i >= 0; i--) {
    let h = rpoBlk[i];
    sp = 0;
    for (let e = predStart[h]; e < predStart[h + 1]; e++) { let u = predList[e]; if (rpoOf[u] >= i) dStk[sp++] = u; }
    if (sp == 0) continue;
    isH[h] = 1;
    while (sp > 0) {
      let y = dStk[--sp];
      while (lpar[y] >= 0) y = lpar[y];
      if (y == h) continue;
      if (rpoOf[y] < i) return false;
      lpar[y] = h;
      for (let e = predStart[y]; e < predStart[y + 1]; e++) { if (sp >= 2 * STRUCT_CAP) return false; dStk[sp++] = predList[e]; }
    }
  }
  // order: each region's items in reverse post-order, a loop's header first
  for (let k = 0; k <= n; k++) { firstIt[k] = -1; lastIt[k] = -1; }
  for (let i = 0; i < n; i++) {
    let x = rpoBlk[i], R = lpar[x] < 0 ? n : lpar[x];
    nextIt[x] = -1;
    if (lastIt[R] < 0) firstIt[R] = x; else nextIt[lastIt[R]] = x;
    lastIt[R] = x;
  }
  let np = 0;
  sp = 0; dStk[0] = firstIt[n];
  while (sp >= 0) {
    let x = dStk[sp];
    if (x < 0) { sp--; continue; }
    dStk[sp] = nextIt[x];
    ordBlk[np++] = x;
    if (isH[x]) { sp++; dStk[sp] = firstIt[x]; }
  }
  if (np != n || ordBlk[0] != entryBlk) return false;
  for (let p = 0; p < n; p++) posOf[ordBlk[p]] = p;
  for (let p = 0; p < n; p++) {
    let k = ordBlk[p];
    psc0[p] = sc0[k] >= 0 ? posOf[sc0[k]] : -1; psc1[p] = sc1[k] >= 0 ? posOf[sc1[k]] : -1;
    hEnd[p] = -1;
  }
  // in positions: loop = [header, furthest back-edge source]; they must nest, and be entered at the header only
  for (let k = 0; k < n; k++) {
    let a = psc0[k], c = psc1[k];
    if (a >= 0 && a <= k && hEnd[a] < k) hEnd[a] = k;
    if (c >= 0 && c <= k && hEnd[c] < k) hEnd[c] = k;
  }
  sp = 0;
  for (let k = 0; k < n; k++) {
    while (sp > 0 && hEnd[dStk[sp - 1]] < k) sp--;
    nClose[k] = 0; mItems[k] = 0;
    if (hEnd[k] >= 0) {
      if (sp > 0 && hEnd[k] > hEnd[dStk[sp - 1]]) return false;
      par[k] = sp > 0 ? dStk[sp - 1] : -1; dStk[sp++] = k;
    }
    inner[k] = sp > 0 ? dStk[sp - 1] : -1;
  }
  for (let k = 0; k < n; k++) {
    for (let s = 0; s < 2; s++) {
      let j = s == 0 ? psc0[k] : psc1[k];
      if (j <= k) continue;
      let R = hEnd[j] >= 0 ? par[j] : inner[j];
      if (R >= 0 && k < R) return false;
    }
  }
  mRoot = 0;
  for (let k = 0; k < n; k++) {
    let R = hEnd[k] >= 0 ? par[k] : inner[k];
    if (R < 0) itemT[k] = mRoot++; else itemT[k] = mItems[R]++;
    if (hEnd[k] >= 0) { nClose[hEnd[k]]++; mItems[k] = 1; }   // the header is its loop's item 0
  }
  for (let k = 0; k < n; k++) {
    let R = hEnd[k] >= 0 ? par[k] : inner[k];
    let ib = R < 0 ? 0 : lvLoop[R], m = R < 0 ? mRoot : mItems[R], t = itemT[k];
    let cl = ib + m - 1 - t;
    lvWrap[k] = t > 0 ? ib + m - t : -1;
    fwLo[k] = R < 0 ? 0 : R;
    nOpen[k] = k == 0 ? mRoot - 1 : 0;
    if (hEnd[k] >= 0) {
      lvLoop[k] = cl + 1; loopEnd[k] = hEnd[k];
      lvBlk[k] = cl + 1 + mItems[k] - 1;
    } else { lvLoop[k] = -1; lvBlk[k] = cl; }
  }
  return true;
}

function translateFunction(entry: u64, f: i32): bool {
  let u0 = unitInsns;
  let ok = translateBody(entry, f, true);
  if (!ok && structFail) { unitInsns = u0; ok = translateBody(entry, f, false); }
  if (ok && optProf) { let a = profBase + (<usize>(structOn ? 28 : 29) << 3); store<u64>(a, load<u64>(a) + 1); }
  return ok;
}
function translateBody(entry: u64, f: i32, tryStruct: bool): bool {
  setStruct(false);
  if (!findRange(entry)) return false;
  if (csP + 2 * FB_CAP > csBase + CS_CAP) return false;
  resetAcc();
  let n = discover(entry);
  nRec = 0;
  beginFunction();
  let entryBlk = 0;
  for (let k = 0; k < n; k++) if (blkPc[k] == entry) entryBlk = k;
  if (tryStruct && structure(n, entryBlk)) setStruct(true);
  for (let q = 0; q < n; q++) {
    let k = structOn ? ordBlk[q] : q;
    if (structOn) {
      for (let i = 0; i < nOpen[q]; i++) { b(0x02); b(0x40); }
      if (lvLoop[q] >= 0) { b(0x03); b(0x40); for (let i = 1; i < mItems[q]; i++) { b(0x02); b(0x40); } }
    }
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
    evEnd[k] = nEv;
    if (structOn) { for (let i = 0; i < nClose[q]; i++) b(0x0B); if (q + 1 < n) b(0x0B); }
    else b(0x0B);
  }
  evStart[n] = nEv;
  let bodyEnd = P;
  if (structFail) { clearMarks(); return false; }
  let bad = overflow || <usize>(bodyEnd - fbBase) > FB_CAP - (32 << 10);
  if (bad || nSide + nRec > SIDE_CAP) { clearMarks(); return false; }
  analyse();
  clearMarks();
  // the summary (see sRI in emit.ts): what this function reads at its reloads and writes at its write-backs, with
  // that of the functions it calls
  if (accAll) { sRI[f] = ~(<u64>0); sRV[f] = ~(<u32>0); sWI[f] = ~(<u64>0); sWV[f] = ~(<u32>0); }
  else {
    let ri = accRI | nI[entryBlk], rv = accRV | nV[entryBlk], wi = accWI, wv = accWV;
    for (let i = 0; i < nIns; i++) {
      if (insKind[i] == EV_WB) { wi |= insMI[i]; wv |= insMV[i]; } else { ri |= insMI[i]; rv |= insMV[i]; }
    }
    sRI[f] = ri; sRV[f] = rv; sWI[f] = wi; sWV[f] = wv;
  }
  // assemble
  let start = csP; setP(csP + 5);
  emitLocals(0);
  gget(G_BUDGET); i32c(1); b(0x6B); ltee(L_BUD); gset(G_BUDGET);
  lget(L_BUD); i32c(0); b(0x48);
  if (optDepth > 0) { gget(G_DEPTH); ltee(L_DEPTH); i32c(optDepth); b(0x4A); b(0x72); }
  b(0x04); b(0x40); i64c(<i64>entry); gset(G_PC); b(0x0F); b(0x0B);
  prof(0, 1);
  emitMasked(nI[entryBlk], nV[entryBlk], false, RL_ENTRY);
  if (!structOn) {
    if (entryBlk) { i32c(entryBlk); lset(L_STATE); }
    b(0x03); b(0x40);
    for (let k = 0; k < n; k++) { b(0x02); b(0x40); }
    lget(L_STATE); b(0x0E); leb(n - 1);
    for (let k = 0; k < n; k++) leb(k);
    b(0x0B);
  }
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
    emitMasked(insMI[i], insMV[i], insKind[i] == EV_WB, insSite[i]);
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
  sOk[f] = 1;
  return true;
}

// translate a unit: entry pcs are in entryBuf (u64 each). Returns module byte length (0 on failure).
export function profAddr(): usize { return profBase; }
// Number the unit's functions callees first (a post-order of the BLs between them, found by discovery), so that a
// call finds the summary of the function it calls (sRI in emit.ts); a cycle's back edge gets none.
const E_CAP = 16384;
const eTo = mk<u16>(E_CAP);
const eStart = mk<i32>(4097);
const dfsFn = mk<u16>(4096);
const dfsIt = mk<i32>(4096);
const dfsSt = mk<u8>(4096);
const pcOld = mk<u64>(4096);
const pcOrder = mk<u16>(4096);
function calleesFirst(): void {
  let nE = 0;
  for (let f = 0; f < nFn; f++) {
    eStart[f] = nE;
    let pc = fnPc[f];
    if (intrinsicAt(pc) || !findRange(pc)) continue;
    discover(pc);
    for (let i = 0; i < nTouched; i++) {
      let a = touched[i];
      if ((load<u16>(markAt(a)) & M_VIS) == 0) continue;
      let insn = insnAt(a);
      if ((insn & 0xFC000000) != 0x94000000) continue;
      let t = a + <u64>(sx(insn & 0x3FFFFFF, 26) << 2);
      if (intrinsicAt(t)) continue;
      let g = addFn(t, false);
      if (g >= 0 && nE < E_CAP) eTo[nE++] = <u16>g;
    }
    clearMarks();
  }
  let n = nFn;
  eStart[n] = nE;
  for (let f = 0; f < n; f++) { dfsSt[f] = 0; pcOld[f] = fnPc[f]; }
  let nO = 0;
  for (let root = 0; root < n; root++) {
    if (dfsSt[root]) continue;
    let sp = 0; dfsFn[0] = <u16>root; dfsIt[0] = eStart[root]; dfsSt[root] = 1;
    while (sp >= 0) {
      let f = <i32>dfsFn[sp];
      if (dfsIt[sp] < eStart[f + 1]) {
        let g = <i32>eTo[dfsIt[sp]++];
        if (dfsSt[g] == 0) { sp++; dfsFn[sp] = <u16>g; dfsIt[sp] = eStart[g]; dfsSt[g] = 1; }
      } else { dfsSt[f] = 2; sp--; pcOrder[nO++] = <u16>f; }
    }
  }
  resetFns();
  for (let k = 0; k < nO; k++) addFn(pcOld[pcOrder[k]], true);
}
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
  for (let f = 0; f < sOk.length; f++) sOk[f] = 0;
  if (optPrecise == 0 && optMaxInsns != 1) calleesFirst();
  csP = csBase + HDR_MAX; unitInsns = 0; nSide = 0;
  for (let f = 0; f < nFn; f++) {
    let op = intrinsicAt(fnPc[f]);
    if (op) { intrinsicFunction(op); store<u8>(metaPtr + 16 + 4096 * 8 + f, 0); unitInsns++; continue; }
    let ok = translateFunction(fnPc[f], f);
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
  b(0x60); b(4); b(T_I32); b(0x7D); b(0x7D); b(0x7D); b(1); b(0x7D);
  b(0x60); b(4); b(T_I32); b(0x7C); b(0x7C); b(0x7C); b(1); b(0x7C);
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
  name("hlp"); name("sfs"); b(0); b(13);
  name("hlp"); name("sfd"); b(0); b(14);
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
