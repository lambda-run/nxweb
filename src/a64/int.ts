// nxweb a64: integer, branch, system and integer load/store translators.
import {
  b, leb, i32c, i64c, lget, lset, ltee, gget, gset, mem, ar, cm, cst, fc,
  getX, getXsp, setX, setXsp, rget, rset, t32, t64, tw, ifVoid, ifT, els, end,
  flagsAddSub, addCarry, flagsNZ, setNZCVconst, emitCond, killCmp,
  gotoPc, branchIf, callConst, callDyn, exitDyn, exitRet, emitSvc, emitTrap,
  R_N, R_Z, R_C, R_V, G_FPCR, G_FPSR, G_TPIDR, G_TPIDRRO, G_EXADDR, G_EXVAL, G_EXVAL2,
  F_BRK, F_CNTPCT, F_CRC, T_I32, T_I64,
} from "./emit";

// @ts-ignore
@inline function sx(x: u32, bits: u32): i64 { return <i64>((<i32>(x << (32 - bits))) >> (32 - bits)); }

// DecodeBitMasks: returns wmask; tmask in dbmT. ok=false if reserved.
let dbmT: u64 = 0;
let dbmOk: bool = false;
function decodeBitMasks(n: u32, imms: u32, immr: u32, sf: bool, immediate: bool): u64 {
  dbmOk = false;
  let v = (n << 6) | (~imms & 0x3F);
  if (v == 0) return 0;
  let len = 31 - clz<u32>(v);
  if (len < 1) return 0;
  let size: u32 = 1 << len;
  if (!sf && size == 64) return 0;
  let levels = size - 1;
  let S = imms & levels, R = immr & levels;
  if (immediate && S == levels) return 0;
  let d = (S - R) & levels;
  let welem: u64 = S == 63 ? ~(<u64>0) : ((<u64>1 << (S + 1)) - 1);
  let telem: u64 = d == 63 ? ~(<u64>0) : ((<u64>1 << (d + 1)) - 1);
  // rotate welem right by R within size
  if (R != 0) {
    let m: u64 = size == 64 ? ~(<u64>0) : ((<u64>1 << size) - 1);
    welem = ((welem >> R) | (welem << (size - R))) & m;
  }
  let w: u64 = 0, t: u64 = 0;
  for (let i: u32 = 0; i < 64; i += size) { w |= welem << i; t |= telem << i; }
  if (!sf) { w &= 0xFFFFFFFF; t &= 0xFFFFFFFF; }
  dbmT = t; dbmOk = true;
  return w;
}
export function logicalImm(n: u32, imms: u32, immr: u32, sf: bool): u64 { return decodeBitMasks(n, imms, immr, sf, true); }
export function logicalImmOk(): bool { return dbmOk; }

// ---------------------------------------------------------------------------------------------
export function trDpImm(pc: u64, insn: u32): bool {
  let sf = (insn >>> 31) != 0;
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31);
  let opc = (insn >> 29) & 3;
  switch ((insn >> 23) & 7) {
    case 0: case 1: {
      let imm = (sx((insn >> 5) & 0x7FFFF, 19) << 2) | <i64>((insn >> 29) & 3);
      let v: i64 = sf ? ((<i64>pc & ~0xFFF) + (imm << 12)) : (<i64>pc + imm);
      i64c(v); setX(rd, true);
      return true;
    }
    case 2: {
      let imm: i64 = (insn >> 10) & 0xFFF;
      if (insn & (1 << 22)) imm <<= 12;
      let sub = (opc & 2) != 0, S = (opc & 1) != 0;
      getXsp(rn, sf); cst(sf, imm);
      if (S) { flagsAddSub(sf, sub); setX(rd, sf); }
      else { ar(sf, sub ? 0x6B : 0x6A); setXsp(rd, sf); }
      return true;
    }
    case 4: {
      let w = decodeBitMasks((insn >> 22) & 1, (insn >> 10) & 63, (insn >> 16) & 63, sf, true);
      if (!dbmOk) return false;
      getX(rn, sf); cst(sf, <i64>w);
      switch (opc) {
        case 0: ar(sf, 0x71); setXsp(rd, sf); break;
        case 1: ar(sf, 0x72); setXsp(rd, sf); break;
        case 2: ar(sf, 0x73); setXsp(rd, sf); break;
        default: ar(sf, 0x71); flagsNZ(sf); setX(rd, sf); break;
      }
      return true;
    }
    case 5: {
      let hw = (insn >> 21) & 3;
      if (opc == 1 || (!sf && hw >= 2)) return false;
      let imm: u64 = <u64>((insn >> 5) & 0xFFFF) << (hw * 16);
      if (opc == 0) { imm = ~imm; if (!sf) imm &= 0xFFFFFFFF; i64c(<i64>imm); setX(rd, true); }
      else if (opc == 2) { i64c(<i64>imm); setX(rd, true); }
      else {
        if (rd == 31) return true;
        rget(rd); i64c(<i64>(~(<u64>0xFFFF << (hw * 16)) & (sf ? ~(<u64>0) : 0xFFFFFFFF))); b(0x83);
        i64c(<i64>imm); b(0x84); rset(rd);
      }
      return true;
    }
    case 6: {
      let N = (insn >> 22) & 1, R = (insn >> 16) & 63, S = (insn >> 10) & 63;
      if (opc == 3 || N != <u32>sf) return false;
      if (!sf && (R >= 32 || S >= 32)) return false;
      let sz: u32 = sf ? 64 : 32;
      if (opc == 0) { // SBFM
        getX(rn, sf);
        if (S != sz - 1) { cst(sf, sz - 1 - S); ar(sf, 0x74); cst(sf, sz - 1 - S); ar(sf, 0x75); }
        if (S >= R) { if (R) { cst(sf, R); ar(sf, 0x75); } }
        else { cst(sf, sz - R); ar(sf, 0x74); }
        setX(rd, sf);
        return true;
      }
      let w = decodeBitMasks(N, S, R, sf, false);
      if (!dbmOk) return false;
      let m = w & dbmT;
      if (opc == 2) { // UBFM
        getX(rn, sf);
        if (R) { cst(sf, R); ar(sf, 0x78); }
        cst(sf, <i64>m); ar(sf, 0x71);
        setX(rd, sf);
        return true;
      }
      // BFM
      getX(rd, sf); cst(sf, <i64>~m); ar(sf, 0x71);
      getX(rn, sf);
      if (R) { cst(sf, R); ar(sf, 0x78); }
      cst(sf, <i64>m); ar(sf, 0x71);
      ar(sf, 0x72);
      setX(rd, sf);
      return true;
    }
    case 7: {
      let N = (insn >> 22) & 1, lsb = (insn >> 10) & 63, rm = <i32>((insn >> 16) & 31);
      if (opc != 0 || (insn & (1 << 21)) != 0 || N != <u32>sf || (!sf && lsb >= 32)) return false;
      let sz: u32 = sf ? 64 : 32;
      if (rn == rm) { getX(rn, sf); if (lsb) { cst(sf, lsb); ar(sf, 0x78); } }
      else if (lsb == 0) getX(rm, sf);
      else {
        getX(rm, sf); cst(sf, lsb); ar(sf, 0x76);
        getX(rn, sf); cst(sf, sz - lsb); ar(sf, 0x74);
        ar(sf, 0x72);
      }
      setX(rd, sf);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
function getShifted(rm: i32, sf: bool, type: u32, amt: u32): void {
  getX(rm, sf);
  if (amt) { cst(sf, amt); ar(sf, type == 0 ? 0x74 : type == 1 ? 0x76 : type == 2 ? 0x75 : 0x78); }
}
// extended register operand (rm, r31 = zr)
export function getExtended(rm: i32, sf: bool, option: u32, shift: u32): void {
  getX(rm, true);
  switch (option) {
    case 0: i64c(0xFF); b(0x83); break;
    case 1: i64c(0xFFFF); b(0x83); break;
    case 2: i64c(0xFFFFFFFF); b(0x83); break;
    case 4: b(0xC2); break;
    case 5: b(0xC3); break;
    case 6: b(0xC4); break;
  }
  if (!sf) b(0xA7);
  if (shift) { cst(sf, shift); ar(sf, 0x74); }
}
// stack: x -> byteswapped x (steps: 1 = bytes in halfwords, 2 = +halfwords in words, 3 = full)
function bswap(sf: bool, steps: i32): void {
  let t = tw(sf, 0);
  let m1: i64 = sf ? 0x00FF00FF00FF00FF : 0x00FF00FF;
  lset(t);
  lget(t); cst(sf, m1); ar(sf, 0x71); cst(sf, 8); ar(sf, 0x74);
  lget(t); cst(sf, 8); ar(sf, 0x76); cst(sf, m1); ar(sf, 0x71); ar(sf, 0x72);
  if (steps >= 2) {
    if (!sf) { i32c(16); b(0x77); }
    else {
      lset(t);
      lget(t); i64c(0x0000FFFF0000FFFF); b(0x83); i64c(16); b(0x86);
      lget(t); i64c(16); b(0x88); i64c(0x0000FFFF0000FFFF); b(0x83); b(0x84);
      if (steps >= 3) { i64c(32); b(0x89); }
    }
  }
}
function bitswapStep(sf: bool, m: i64, s: i32): void {
  let t = tw(sf, 0);
  lset(t);
  lget(t); cst(sf, m); ar(sf, 0x71); cst(sf, s); ar(sf, 0x74);
  lget(t); cst(sf, s); ar(sf, 0x76); cst(sf, m); ar(sf, 0x71); ar(sf, 0x72);
}
// stack: a b -> high 64 bits of unsigned product
function umulh(): void {
  let a = t64(0), bb = t64(1), t = t64(2), a0b0 = t64(3);
  lset(bb); lset(a);
  // t = a1*b0 + (a0*b0 >> 32)
  lget(a); i64c(32); b(0x88); lget(bb); i64c(0xFFFFFFFF); b(0x83); b(0x7E);
  lget(a); i64c(0xFFFFFFFF); b(0x83); lget(bb); i64c(0xFFFFFFFF); b(0x83); b(0x7E); i64c(32); b(0x88);
  b(0x7C); lset(t);
  // w1 = (t & M) + a0*b1
  lget(t); i64c(0xFFFFFFFF); b(0x83);
  lget(a); i64c(0xFFFFFFFF); b(0x83); lget(bb); i64c(32); b(0x88); b(0x7E);
  b(0x7C); lset(a0b0);
  // hi = a1*b1 + (t>>32) + (w1>>32)
  lget(a); i64c(32); b(0x88); lget(bb); i64c(32); b(0x88); b(0x7E);
  lget(t); i64c(32); b(0x88); b(0x7C);
  lget(a0b0); i64c(32); b(0x88); b(0x7C);
}

export function trDpReg(pc: u64, insn: u32): bool {
  let sf = (insn >>> 31) != 0;
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31), rm = <i32>((insn >> 16) & 31);
  let opc = (insn >> 29) & 3;
  if ((insn & 0x1F000000) == 0x0A000000) { // logical shifted register
    let imm6 = (insn >> 10) & 63, sh = (insn >> 22) & 3, N = (insn >> 21) & 1;
    if (!sf && imm6 >= 32) return false;
    if (opc == 1 && N == 0 && rn == 31 && imm6 == 0) { getX(rm, sf); setX(rd, sf); return true; }
    getX(rn, sf);
    getShifted(rm, sf, sh, imm6);
    if (N) { cst(sf, -1); ar(sf, 0x73); }
    switch (opc) {
      case 0: ar(sf, 0x71); break;
      case 1: ar(sf, 0x72); break;
      case 2: ar(sf, 0x73); break;
      default: ar(sf, 0x71); flagsNZ(sf); break;
    }
    setX(rd, sf);
    return true;
  }
  if ((insn & 0x1F200000) == 0x0B000000) { // add/sub shifted register
    let imm6 = (insn >> 10) & 63, sh = (insn >> 22) & 3;
    if (sh == 3 || (!sf && imm6 >= 32)) return false;
    let sub = (opc & 2) != 0, S = (opc & 1) != 0;
    getX(rn, sf); getShifted(rm, sf, sh, imm6);
    if (S) flagsAddSub(sf, sub); else ar(sf, sub ? 0x6B : 0x6A);
    setX(rd, sf);
    return true;
  }
  if ((insn & 0x1FE00000) == 0x0B200000) { // add/sub extended register
    let option = (insn >> 13) & 7, imm3 = (insn >> 10) & 7;
    if (imm3 > 4) return false;
    let sub = (opc & 2) != 0, S = (opc & 1) != 0;
    getXsp(rn, sf); getExtended(rm, sf, option, imm3);
    if (S) { flagsAddSub(sf, sub); setX(rd, sf); }
    else { ar(sf, sub ? 0x6B : 0x6A); setXsp(rd, sf); }
    return true;
  }
  if ((insn & 0x1F000000) == 0x1B000000) { // 3-source
    let op31 = (insn >> 21) & 7, o0 = (insn >> 15) & 1, ra = <i32>((insn >> 10) & 31);
    if (opc != 0) return false;
    if (op31 == 0) {
      if (ra == 31 && o0 == 0) { getX(rn, sf); getX(rm, sf); ar(sf, 0x6C); setX(rd, sf); return true; }
      getX(ra, sf); getX(rn, sf); getX(rm, sf); ar(sf, 0x6C); ar(sf, o0 ? 0x6B : 0x6A); setX(rd, sf);
      return true;
    }
    if (!sf) return false;
    if (op31 == 1 || op31 == 5) {
      let ext: u32 = op31 == 1 ? 0xAC : 0xAD;
      if (ra != 31 || o0) getX(ra, true);
      getX(rn, false); b(ext); getX(rm, false); b(ext); b(0x7E);
      if (ra != 31 || o0) b(o0 ? 0x7D : 0x7C);
      setX(rd, true);
      return true;
    }
    if ((op31 == 2 || op31 == 6) && o0 == 0) {
      getX(rn, true); getX(rm, true); umulh();
      if (op31 == 2) {
        let a = t64(0), bb = t64(1);
        lget(a); i64c(63); b(0x87); lget(bb); b(0x83); b(0x7D);
        lget(bb); i64c(63); b(0x87); lget(a); b(0x83); b(0x7D);
      }
      setX(rd, true);
      return true;
    }
    return false;
  }
  if ((insn & 0x1F000000) != 0x1A000000) return false;
  let S = (opc & 1) != 0;
  switch ((insn >> 21) & 7) {
    case 0: { // ADC/SBC
      if ((insn >> 10) & 63) return false;
      getX(rn, sf); getX(rm, sf);
      if (opc & 2) { cst(sf, -1); ar(sf, 0x73); }
      addCarry(sf, S);
      setX(rd, sf);
      return true;
    }
    case 2: { // CCMN/CCMP
      if (!S || (insn & 0x410) != 0) return false;
      let c = t32(0), cond = (insn >> 12) & 15, nzcv = insn & 15;
      emitCond(cond); lset(c);
      getX(rn, sf);
      if (insn & 0x800) cst(sf, rm); else getX(rm, sf);
      flagsAddSub(sf, (opc & 2) != 0); b(0x1A);
      rget(R_N); i32c((nzcv >> 3) & 1); lget(c); b(0x1B); rset(R_N);
      rget(R_Z); i32c((nzcv >> 2) & 1); lget(c); b(0x1B); rset(R_Z);
      rget(R_C); i32c((nzcv >> 1) & 1); lget(c); b(0x1B); rset(R_C);
      rget(R_V); i32c(nzcv & 1); lget(c); b(0x1B); rset(R_V);
      killCmp();
      return true;
    }
    case 4: { // CSEL family
      if (S || (insn & 0x800) != 0) return false;
      let cond = (insn >> 12) & 15, o2 = (insn >> 10) & 1, inv = (opc & 2) != 0;
      if (rn == 31 && rm == 31 && cond < 14) {
        if (!inv && o2) { emitCond(cond ^ 1); if (sf) b(0xAD); setX(rd, sf); return true; }
        if (inv && !o2) { cst(sf, 0); emitCond(cond ^ 1); if (sf) b(0xAD); ar(sf, 0x6B); setX(rd, sf); return true; }
      }
      getX(rn, sf);
      getX(rm, sf);
      if (!inv && o2) { cst(sf, 1); ar(sf, 0x6A); }
      else if (inv && !o2) { cst(sf, -1); ar(sf, 0x73); }
      else if (inv && o2) { let t = tw(sf, 0); lset(t); cst(sf, 0); lget(t); ar(sf, 0x6B); }
      emitCond(cond); b(0x1B);
      setX(rd, sf);
      return true;
    }
    case 6: {
      if (S) return false;
      let opcode = (insn >> 10) & 63;
      if (opc & 2) { // 1-source
        if (rm != 0) return false;
        switch (opcode) {
          case 0: // RBIT
            getX(rn, sf); bswap(sf, 3);
            bitswapStep(sf, sf ? 0x0F0F0F0F0F0F0F0F : 0x0F0F0F0F, 4);
            bitswapStep(sf, sf ? 0x3333333333333333 : 0x33333333, 2);
            bitswapStep(sf, sf ? 0x5555555555555555 : 0x55555555, 1);
            break;
          case 1: getX(rn, sf); bswap(sf, 1); break;
          case 2: getX(rn, sf); bswap(sf, 2); break;
          case 3: if (!sf) return false; getX(rn, sf); bswap(sf, 3); break;
          case 4: getX(rn, sf); ar(sf, 0x67); break;
          case 5: {
            let t = tw(sf, 0);
            getX(rn, sf); ltee(t); lget(t); cst(sf, 1); ar(sf, 0x75); ar(sf, 0x73); ar(sf, 0x67); cst(sf, 1); ar(sf, 0x6B);
            break;
          }
          default: return false;
        }
        setX(rd, sf);
        return true;
      }
      switch (opcode) {
        case 2: { // UDIV
          let x = tw(sf, 0), y = tw(sf, 1);
          getX(rn, sf); lset(x); getX(rm, sf); lset(y);
          lget(y); b(sf ? 0x50 : 0x45);
          b(0x04); b(sf ? T_I64 : T_I32); cst(sf, 0); b(0x05); lget(x); lget(y); ar(sf, 0x6E); b(0x0B);
          break;
        }
        case 3: { // SDIV
          let x = tw(sf, 0), y = tw(sf, 1);
          getX(rn, sf); lset(x); getX(rm, sf); lset(y);
          lget(y); b(sf ? 0x50 : 0x45);
          b(0x04); b(sf ? T_I64 : T_I32); cst(sf, 0); b(0x05);
          lget(y); cst(sf, -1); cm(sf, 0x46);
          b(0x04); b(sf ? T_I64 : T_I32); cst(sf, 0); lget(x); ar(sf, 0x6B); b(0x05); lget(x); lget(y); ar(sf, 0x6D); b(0x0B);
          b(0x0B);
          break;
        }
        case 8: getX(rn, sf); getX(rm, sf); ar(sf, 0x74); break;
        case 9: getX(rn, sf); getX(rm, sf); ar(sf, 0x76); break;
        case 10: getX(rn, sf); getX(rm, sf); ar(sf, 0x75); break;
        case 11: getX(rn, sf); getX(rm, sf); ar(sf, 0x78); break;
        case 16: case 17: case 18: case 19: case 20: case 21: case 22: case 23: {
          let sz = opcode & 3;
          if ((sz == 3) != sf) return false;
          getX(rn, false); getX(rm, true); i32c(8 << sz); i32c(opcode & 4 ? <i32>0x82F63B78 : <i32>0xEDB88320);
          b(0x10); leb(F_CRC);
          setX(rd, false);
          return true;
        }
        default: return false;
      }
      setX(rd, sf);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
function sysreg(insn: u32): bool {
  let rt = <i32>(insn & 31);
  let L = (insn >> 21) & 1;
  let key = (insn >> 5) & 0x7FFF; // o0(1) op1(3) CRn(4) CRm(4) op2(3)
  let g: i32 = -1;
  switch (key) {
    case 0x5E82: g = G_TPIDR; break;      // S3_3_C13_C0_2
    case 0x5E83: g = G_TPIDRRO; break;    // S3_3_C13_C0_3
    case 0x5A20: g = G_FPCR; break;       // S3_3_C4_C4_0
    case 0x5A21: g = G_FPSR; break;       // S3_3_C4_C4_1
  }
  if (g >= 0) {
    let is32 = g == G_FPCR || g == G_FPSR;
    if (L) { gget(g); if (is32) b(0xAD); setX(rt, true); }
    else { getX(rt, true); if (is32) b(0xA7); gset(g); }
    return true;
  }
  if (key == 0x5A10) { // NZCV
    if (L) {
      rget(R_N); i32c(31); b(0x74); rget(R_Z); i32c(30); b(0x74); b(0x72);
      rget(R_C); i32c(29); b(0x74); b(0x72); rget(R_V); i32c(28); b(0x74); b(0x72);
      b(0xAD); setX(rt, true);
    } else {
      let t = t32(0);
      getX(rt, false); lset(t);
      lget(t); i32c(31); b(0x76); rset(R_N);
      lget(t); i32c(30); b(0x76); i32c(1); b(0x71); rset(R_Z);
      lget(t); i32c(29); b(0x76); i32c(1); b(0x71); rset(R_C);
      lget(t); i32c(28); b(0x76); i32c(1); b(0x71); rset(R_V);
      killCmp();
    }
    return true;
  }
  if (!L) return false;
  switch (key) {
    case 0x5F01: case 0x5F02: b(0x10); leb(F_CNTPCT); break;   // CNTPCT_EL0 / CNTVCT_EL0
    case 0x5F00: i64c(19200000); break;                         // CNTFRQ_EL0
    case 0x5807: i64c(4); break;                                // DCZID_EL0: 64-byte blocks
    case 0x5801: i64c(0x8444C004); break;                       // CTR_EL0
    default: return false;
  }
  setX(rt, true);
  return true;
}

export function trBranchSys(pc: u64, insn: u32): bool {
  let rt = <i32>(insn & 31);
  if ((insn & 0x7C000000) == 0x14000000) { // B / BL
    let tgt = pc + <u64>(sx(insn & 0x3FFFFFF, 26) << 2);
    if (insn >>> 31) callConst(tgt, pc + 4); else gotoPc(tgt, true);
    return true;
  }
  if ((insn & 0x7E000000) == 0x34000000) { // CBZ / CBNZ
    let sf = (insn >>> 31) != 0;
    let tgt = pc + <u64>(sx((insn >> 5) & 0x7FFFF, 19) << 2);
    getX(rt, sf); b(sf ? 0x50 : 0x45);
    if (insn & (1 << 24)) b(0x45);
    branchIf(tgt);
    return true;
  }
  if ((insn & 0x7E000000) == 0x36000000) { // TBZ / TBNZ
    let bit = ((insn >> 19) & 31) | ((insn >>> 31) << 5);
    let tgt = pc + <u64>(sx((insn >> 5) & 0x3FFF, 14) << 2);
    getX(rt, true); i64c(<i64>1 << bit); b(0x83); b(0x50);
    if (insn & (1 << 24)) b(0x45);
    branchIf(tgt);
    return true;
  }
  if ((insn & 0xFF000010) == 0x54000000) { // B.cond
    let tgt = pc + <u64>(sx((insn >> 5) & 0x7FFFF, 19) << 2);
    let cond = insn & 15;
    if (cond >= 14) { gotoPc(tgt, true); return true; }
    emitCond(cond);
    branchIf(tgt);
    return true;
  }
  if ((insn & 0xFFE0001F) == 0xD4000001) { emitSvc((insn >> 5) & 0xFFFF, pc + 4); return true; }
  if ((insn & 0xFFE0001F) == 0xD4200000) { emitTrap(F_BRK, pc, (insn >> 5) & 0xFFFF); return true; }
  if ((insn & 0xFFFFFC1F) == 0xD61F0000) {
    // BR. `br x30` is a return in disguise (longjmp, hand-written epilogues): unwind like RET so that
    // abandoned wasm frames are released; every other BR is a tail transfer.
    let r = <i32>((insn >> 5) & 31);
    getX(r, true); if (r == 30) exitRet(); else exitDyn();
    return true;
  }
  if ((insn & 0xFFFFFC1F) == 0xD63F0000) { getX(<i32>((insn >> 5) & 31), true); callDyn(pc + 4); return true; }
  if ((insn & 0xFFFFFC1F) == 0xD65F0000) { getX(<i32>((insn >> 5) & 31), true); exitRet(); return true; }
  if ((insn & 0xFFFFF01F) == 0xD503201F) return true;   // hints (NOP, YIELD, PAC/BTI hints...)
  if ((insn & 0xFFFFF01F) == 0xD503301F) {              // barriers / CLREX
    let op2 = (insn >> 5) & 7;
    if (op2 == 2) { i64c(-1); gset(G_EXADDR); return true; }
    return op2 == 4 || op2 == 5 || op2 == 6 || op2 == 7 || op2 == 1;
  }
  if ((insn & 0xFFF80000) == 0xD5080000) { // SYS
    let key = (insn >> 5) & 0x3FFF;      // op1 CRn CRm op2
    if (key == 0x1BA1) {                 // DC ZVA  (op1=3 C7 C4 1)
      getX(rt, true); i64c(-64); b(0x83); b(0xA7); i32c(0); i32c(64); fc(11); b(0);
      return true;
    }
    if (((key >> 7) & 15) == 7) return true; // other cache maintenance: no-op
    return false;
  }
  if ((insn & 0xFFD00000) == 0xD5100000) return sysreg(insn);
  return false;
}

// ---------------------------------------------------------------------------------------------
// integer loads / stores. Address is kept in an i64 temp.
const A = 8;   // temp slot for address
// stack: (i64 addr on stack) -> value loaded into rt
function loadInt(rt: i32, size: u32, sgn: bool, to64: bool): void {
  b(0xA7);
  if (!sgn) { mem(size == 0 ? 0x31 : size == 1 ? 0x33 : size == 2 ? 0x35 : 0x29); }
  else if (to64) { mem(size == 0 ? 0x30 : size == 1 ? 0x32 : 0x34); }
  else { mem(size == 0 ? 0x2C : 0x2E); b(0xAD); }
  setX(rt, true);
}
// stack: i64 addr ; then value pushed by this fn -> store
function storeInt(rt: i32, size: u32): void {
  b(0xA7); getX(rt, true); mem(size == 0 ? 0x3C : size == 1 ? 0x3D : size == 2 ? 0x3E : 0x37);
}

function exclusive(insn: u32): bool {
  let size = insn >>> 30, o2 = (insn >> 23) & 1, L = (insn >> 22) & 1, o1 = (insn >> 21) & 1;
  let rs = <i32>((insn >> 16) & 31), rt2 = <i32>((insn >> 10) & 31), rn = <i32>((insn >> 5) & 31), rt = <i32>(insn & 31);
  let a = t64(A);
  if (o2) {
    if (o1) return false; // CAS family
    getXsp(rn, true);
    if (L) loadInt(rt, size, false, true); else storeInt(rt, size);
    return true;
  }
  let ld: u32 = size == 0 ? 0x31 : size == 1 ? 0x33 : size == 2 ? 0x35 : 0x29;
  let st: u32 = size == 0 ? 0x3C : size == 1 ? 0x3D : size == 2 ? 0x3E : 0x37;
  if (o1 && size < 2) return false;
  let step: i64 = <i64>1 << size;
  getXsp(rn, true); lset(a);
  if (L) {
    lget(a); gset(G_EXADDR);
    lget(a); b(0xA7); mem(ld); let v = t64(0); ltee(v); gset(G_EXVAL);
    if (o1) {
      lget(a); i64c(step); b(0x7C); b(0xA7); mem(ld); let v2 = t64(1); ltee(v2); gset(G_EXVAL2);
      lget(v); setX(rt, true); lget(v2); setX(rt2, true);
    } else { lget(v); setX(rt, true); }
    return true;
  }
  // store exclusive: status into rs (0 = success)
  let ok = t32(0);
  lget(a); gget(G_EXADDR); b(0x51);
  b(0x04); b(T_I32);
  lget(a); b(0xA7); mem(ld); gget(G_EXVAL); b(0x51);
  if (o1) { lget(a); i64c(step); b(0x7C); b(0xA7); mem(ld); gget(G_EXVAL2); b(0x51); b(0x71); }
  b(0x05); i32c(0); b(0x0B);
  lset(ok);
  // values to store are read unconditionally, the store itself is conditional
  let s1 = t64(0), s2 = t64(1);
  getX(rt, true); lset(s1);
  if (o1) { getX(rt2, true); lset(s2); }
  lget(ok);
  b(0x04); b(0x40);
  lget(a); b(0xA7); lget(s1); mem(st);
  if (o1) { lget(a); i64c(step); b(0x7C); b(0xA7); lget(s2); mem(st); }
  b(0x0B);
  i64c(-1); gset(G_EXADDR);
  lget(ok); b(0x45); b(0xAD); setX(rs, true);
  return true;
}

export function trLoadStoreInt(pc: u64, insn: u32): bool {
  let rt = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31);
  let size = insn >>> 30;
  let a = t64(A);
  if ((insn & 0x3F000000) == 0x08000000) return exclusive(insn);
  if ((insn & 0x3B000000) == 0x18000000) { // load literal (integer)
    let addr = <i64>pc + (sx((insn >> 5) & 0x7FFFF, 19) << 2);
    switch (size) {
      case 0: i64c(addr); loadInt(rt, 2, false, true); break;
      case 1: i64c(addr); loadInt(rt, 3, false, true); break;
      case 2: i64c(addr); loadInt(rt, 2, true, true); break;
      default: break; // PRFM literal
    }
    return true;
  }
  if ((insn & 0x3A000000) == 0x28000000) { // pair
    let type = (insn >> 23) & 3, L = (insn >> 22) & 1, rt2 = <i32>((insn >> 10) & 31);
    let opc = size;
    if (opc == 3 || (opc == 1 && !L)) return false;
    let sz: u32 = opc == 2 ? 3 : 2;
    let imm: i64 = sx((insn >> 15) & 0x7F, 7) << sz;
    getXsp(rn, true);
    if (type != 1 && imm != 0) { i64c(imm); b(0x7C); }
    lset(a);
    if (L) {
      let v = t64(0);
      lget(a); b(0xA7); mem(sz == 3 ? 0x29 : opc == 1 ? 0x34 : 0x35); lset(v);
      lget(a); i64c(<i64>1 << sz); b(0x7C); loadInt(rt2, sz, opc == 1, true);
      if (rt != rt2) { lget(v); setX(rt, true); }
    } else {
      lget(a); storeInt(rt, sz);
      lget(a); i64c(<i64>1 << sz); b(0x7C); storeInt(rt2, sz);
    }
    if (type == 1) { lget(a); i64c(imm); b(0x7C); setXsp(rn, true); }
    else if (type == 3) { lget(a); setXsp(rn, true); }
    return true;
  }
  if ((insn & 0x3A000000) != 0x38000000) return false;
  let opc = (insn >> 22) & 3;
  let wb = 0; // 1 post, 2 pre
  let imm: i64 = 0;
  if (insn & (1 << 24)) { // unsigned offset
    imm = <i64>((insn >> 10) & 0xFFF) << size;
    getXsp(rn, true); if (imm) { i64c(imm); b(0x7C); }
  } else if (insn & (1 << 21)) {
    if (((insn >> 10) & 3) != 2) return false;
    let option = (insn >> 13) & 7, S = (insn >> 12) & 1;
    if ((option & 2) == 0) return false;
    getXsp(rn, true); getExtended(<i32>((insn >> 16) & 31), true, option, S ? size : 0); b(0x7C);
  } else {
    let m = (insn >> 10) & 3;
    imm = sx((insn >> 12) & 0x1FF, 9);
    if (m == 2) return false; // unprivileged
    wb = m == 1 ? 1 : m == 3 ? 2 : 0;
    getXsp(rn, true); if (wb != 1 && imm) { i64c(imm); b(0x7C); }
  }
  if (size == 3 && opc == 2) { b(0x1A); return wb == 0; } // PRFM
  if (opc == 3 && size >= 2) { return false; }
  lset(a);
  if (opc == 0) { lget(a); storeInt(rt, size); }
  else {
    // for writeback loads the base update happens first so that rt wins if rt == rn
    if (wb == 1) { lget(a); i64c(imm); b(0x7C); setXsp(rn, true); }
    else if (wb == 2) { lget(a); setXsp(rn, true); }
    lget(a); loadInt(rt, size, opc >= 2, opc == 2);
    return true;
  }
  if (wb == 1) { lget(a); i64c(imm); b(0x7C); setXsp(rn, true); }
  else if (wb == 2) { lget(a); setXsp(rn, true); }
  return true;
}
