// nxweb a64: half-precision floating point (FP16, ARMv8.2): scalar H-register data processing and conversions, the
// Advanced SIMD .4H / .8H and scalar H forms. Every operation is one call of the helper vop (cases 64..71, `hlanes` in
// helpers.ts) with FPCR.RMode, FZ16, FZ and DN folded into the op word at run time; FCVT between H and S / D, FCVTL / FCVTN are in fp.ts / simd.ts.
import {
  b, leb, i32c, v128c, lget, lset, simd, gget, rget, rset, getX, setX, t32, emitCond, killCmp,
  G_FPCR, F_VOP, R_N, R_Z, R_C, R_V, R_V0,
} from "./emit";

const ADD = 0, SUB = 1, MUL = 2, DIV = 3, MAX = 4, MIN = 5, MAXNM = 6, MINNM = 7, NMUL = 8, MULX = 9, ABD = 10, RECPS = 11,
  RSQRTS = 12, FMA = 13, CMEQ = 14, CMGE = 15, CMGT = 16, ACGE = 17, ACGT = 18, SQRT = 19, RINT = 20, RECPE = 21, RSQRTE = 22,
  RECPX = 23, ABS = 24, NEG = 25, TOINT = 26, FROMINT = 27, CMP = 28, FMLAL = 29;
const NONE = 99;
// lane codes (op bits 8..9)
const L1 = 0, L4 = 1, L8 = 2, LGP = 3;
const PAIR: u32 = 1 << 10, RED: u32 = 1 << 11, WIDE: u32 = 0x80000000;
const R_CUR = 5, UNS = 8;   // sub: rounding by FPCR; unsigned conversion

function vget(r: i32): void { rget(R_V0 + r); }
function vset(r: i32): void { rset(R_V0 + r); }
function zero(): void { v128c(0, 0); }
function op(kind: u32, lanes: u32, sub: u32 = 0, fbits: u32 = 0, flags: u32 = 0): void {
  i32c(<i32>(64 | (lanes << 8) | (kind << 12) | (sub << 18) | (fbits << 24) | flags));
  gget(G_FPCR); i32c(0xC00000); b(0x71); b(0x72);                     // RMode -> bits 22..23
  gget(G_FPCR); i32c(19); b(0x76); i32c(1); b(0x71); b(0x72);          // FZ16 -> bit 0
  gget(G_FPCR); i32c(23); b(0x76); i32c(6); b(0x71); b(0x72);          // FZ, DN -> bits 1, 2
}
function call(): void { b(0x10); leb(F_VOP); }
// stack: -> ; three operand registers (-1: zero)
function opnd(r: i32): void { if (r < 0) zero(); else vget(r); }
function emit3(kind: u32, lanes: u32, sub: u32, ra: i32, rb: i32, rc: i32, rd: i32, flags: u32 = 0): void {
  op(kind, lanes, sub, 0, flags); opnd(ra); opnd(rb); opnd(rc); call(); vset(rd);
}
// stack: -> nzcv of comparing Hn with Hm (rm -1: with +0.0)
function cmpFlags(rn: i32, rm: i32): void {
  op(CMP, L1); vget(rn); opnd(rm); zero(); call(); simd(0x1B); b(0);
}
function setFlags(t: u32): void {
  lget(t); i32c(3); b(0x76); rset(R_N);
  lget(t); i32c(2); b(0x76); i32c(1); b(0x71); rset(R_Z);
  lget(t); i32c(1); b(0x76); i32c(1); b(0x71); rset(R_C);
  lget(t); i32c(1); b(0x71); rset(R_V);
  killCmp();
}
function vfpExpand16(imm8: u32): u32 {
  let b6 = (imm8 >> 6) & 1;
  let exp: u32 = ((b6 ^ 1) << 4) | (b6 ? 0xC : 0) | ((imm8 >> 4) & 3);
  return ((imm8 >> 7) << 15) | (exp << 10) | ((imm8 & 15) << 6);
}

// scalar FP data processing with ftype = 3 (FMADD family, 1- and 2-source, compares, FCCMP, FCSEL, FMOV immediate)
export function trFp16Scalar(insn: u32): bool {
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31), rm = <i32>((insn >> 16) & 31);
  if ((insn & 0xFF000000) == 0x1F000000) {
    let o1 = (insn >> 21) & 1, o0 = (insn >> 15) & 1, ra = <i32>((insn >> 10) & 31);
    emit3(FMA, L1, (o1 ^ o0) | (o1 << 1), rn, rm, ra, rd);
    return true;
  }
  if (insn >>> 29) return false;
  switch ((insn >> 10) & 3) {
    case 1: { // FCCMP / FCCMPE
      let c = t32(0), t = t32(1), cond = (insn >> 12) & 15, nzcv = insn & 15;
      emitCond(cond); lset(c);
      cmpFlags(rn, rm); i32c(<i32>nzcv); lget(c); b(0x1B); lset(t);
      setFlags(t);
      return true;
    }
    case 2: { // two-source
      let opcode = (insn >> 12) & 15;
      if (opcode > 8) return false;
      let kind: u32 = opcode == 0 ? MUL : opcode == 1 ? DIV : opcode == 2 ? ADD : opcode == 3 ? SUB : opcode == 8 ? NMUL : MAX + (opcode - 4);
      emit3(kind, L1, 0, rn, rm, -1, rd);
      return true;
    }
    case 3: { // FCSEL
      zero(); vget(rn); simd(0x19); b(0); vget(rm); simd(0x19); b(0); emitCond((insn >> 12) & 15); b(0x1B);
      simd(0x1A); b(0); vset(rd);
      return true;
    }
  }
  if ((insn & 0x1C00) == 0x1000) { // FMOV immediate
    if ((insn & 0x3E0) != 0) return false;
    v128c(vfpExpand16((insn >> 13) & 0xFF), 0); vset(rd);
    return true;
  }
  if ((insn & 0x3C00) == 0x2000) { // FCMP / FCMPE
    if ((insn & 0xC000) != 0 || (insn & 7) != 0) return false;
    let t = t32(1);
    cmpFlags(rn, (insn & 8) ? -1 : rm); lset(t); setFlags(t);
    return true;
  }
  if ((insn & 0x7C00) == 0x4000) { // one-source (FCVT from H is in fp.ts)
    let opcode = (insn >> 15) & 63;
    switch (opcode) {
      case 0: vget(rn); v128c(0xFFFF, 0); simd(0x4E); vset(rd); return true;
      case 1: emit3(ABS, L1, 0, rn, -1, -1, rd); return true;
      case 2: emit3(NEG, L1, 0, rn, -1, -1, rd); return true;
      case 3: emit3(SQRT, L1, 0, rn, -1, -1, rd); return true;
      case 8: case 9: case 10: case 11: case 12: emit3(RINT, L1, opcode - 8, rn, -1, -1, rd); return true;
      case 14: case 15: emit3(RINT, L1, R_CUR, rn, -1, -1, rd); return true;
    }
    return false;
  }
  return false;
}

// conversions between H and a general register: FCVT*, SCVTF / UCVTF (also fixed-point), FMOV
export function trFp16Int(insn: u32): bool {
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31);
  let sf = (insn >>> 31) != 0, rmode = (insn >> 19) & 3, opcode = (insn >> 16) & 7;
  let fixed = (insn & 0x200000) == 0, fbits: u32 = 0;
  let wide: u32 = sf ? WIDE : 0;
  if (fixed) {
    let scale = (insn >> 10) & 63;
    if (!sf && scale < 32) return false;
    fbits = 64 - scale;
    if (!((rmode == 0 && (opcode == 2 || opcode == 3)) || (rmode == 3 && opcode < 2))) return false;
  } else if ((insn & 0xFC00) != 0) return false;
  if (opcode >= 6) {
    if (rmode != 0 || fixed) return false;
    if (opcode == 6) { vget(rn); simd(0x19); b(0); if (sf) b(0xAD); setX(rd, sf); return true; }
    let t = t32(0);
    getX(rn, sf); if (sf) b(0xA7); lset(t); zero(); lget(t); simd(0x1A); b(0); vset(rd);
    return true;
  }
  if (opcode == 2 || opcode == 3) {
    if (rmode != 0) return false;
    op(FROMINT, LGP, (opcode & 1) ? UNS : 0, fbits, wide);
    zero(); getX(rn, sf); simd(sf ? 0x1E : 0x1C); b(0); zero(); zero(); call(); vset(rd);
    return true;
  }
  if (opcode >= 4 && rmode != 0) return false;
  op(TOINT, LGP, (opcode >= 4 ? 4 : rmode) | ((opcode & 1) ? UNS : 0), fbits, wide);
  vget(rn); zero(); zero(); call(); simd(0x1D); b(0); if (!sf) b(0xA7);
  setX(rd, sf);
  return true;
}

// three-same FP16 (vector / scalar): key = U:a:opcode
function threeSame(insn: u32, scalar: bool): bool {
  let Q = (insn >> 30) & 1, key = (((insn >> 29) & 1) << 4) | (((insn >> 23) & 1) << 3) | ((insn >> 11) & 7);
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31), rm = <i32>((insn >> 16) & 31);
  let kind: u32 = NONE, sub: u32 = 0, flags: u32 = 0, rc: i32 = -1;
  switch (key) {
    case 0x00: kind = MAXNM; break;
    case 0x01: kind = FMA; rc = rd; break;
    case 0x02: kind = ADD; break;
    case 0x03: kind = MULX; break;
    case 0x04: kind = CMEQ; break;
    case 0x06: kind = MAX; break;
    case 0x07: kind = RECPS; break;
    case 0x08: kind = MINNM; break;
    case 0x09: kind = FMA; sub = 1; rc = rd; break;
    case 0x0A: kind = SUB; break;
    case 0x0E: kind = MIN; break;
    case 0x0F: kind = RSQRTS; break;
    case 0x10: kind = MAXNM; flags = PAIR; break;
    case 0x12: kind = ADD; flags = PAIR; break;
    case 0x13: kind = MUL; break;
    case 0x14: kind = CMGE; break;
    case 0x15: kind = ACGE; break;
    case 0x16: kind = MAX; flags = PAIR; break;
    case 0x17: kind = DIV; break;
    case 0x18: kind = MINNM; flags = PAIR; break;
    case 0x1A: kind = ABD; break;
    case 0x1C: kind = CMGT; break;
    case 0x1D: kind = ACGT; break;
    case 0x1E: kind = MIN; flags = PAIR; break;
  }
  if (kind == NONE) return false;
  if (scalar && !(key == 0x03 || key == 0x04 || key == 0x07 || key == 0x0F || key == 0x14 || key == 0x15 || key == 0x1A || key == 0x1C || key == 0x1D)) return false;
  emit3(kind, scalar ? L1 : Q ? L8 : L4, sub, rn, rm, rc, rd, flags);
  return true;
}

// two-register miscellaneous FP16 (vector / scalar)
function twoReg(insn: u32, scalar: bool): bool {
  let Q = (insn >> 30) & 1, U = (insn >> 29) & 1, a = (insn >> 23) & 1, opc = (insn >> 12) & 31;
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31);
  let lanes: u32 = scalar ? L1 : Q ? L8 : L4;
  let conv = opc >= 0x1A && opc <= 0x1C;
  if (conv) {
    if (a && opc == 0x1C) return false;
    let mode: u32 = a ? (opc == 0x1A ? 1 : 3) : (opc == 0x1A ? 0 : opc == 0x1B ? 2 : 4);
    emit3(TOINT, lanes, mode | (U ? UNS : 0), rn, -1, -1, rd);
    return true;
  }
  if (opc >= 0x0C && opc <= 0x0E && a) { // compare with zero
    if (U && opc == 0x0E) return false;
    // FCMGT0 x > 0, FCMGE0 x >= 0, FCMEQ0, FCMLE0 0 >= x, FCMLT0 0 > x
    let kind: u32 = opc == 0x0C ? (U ? CMGE : CMGT) : opc == 0x0D ? (U ? CMGE : CMEQ) : CMGT;
    let swap = opc == 0x0E || (opc == 0x0D && U);
    if (swap) emit3(kind, lanes, 0, -1, rn, -1, rd); else emit3(kind, lanes, 0, rn, -1, -1, rd);
    return true;
  }
  if (opc == 0x1D) {
    if (!a) { op(FROMINT, lanes, U ? UNS : 0); vget(rn); zero(); zero(); call(); vset(rd); return true; }
    emit3(U ? RSQRTE : RECPE, lanes, 0, rn, -1, -1, rd);
    return true;
  }
  if (scalar) {
    if (opc == 0x1F && a && !U) { emit3(RECPX, L1, 0, rn, -1, -1, rd); return true; }
    return false;
  }
  if (opc == 0x18 || opc == 0x19) {
    let mode: u32;
    if (!U) mode = a ? (opc == 0x18 ? 1 : 3) : (opc == 0x18 ? 0 : 2);
    else if (!a) mode = opc == 0x18 ? 4 : R_CUR;
    else { if (opc == 0x18) return false; mode = R_CUR; }
    emit3(RINT, lanes, mode, rn, -1, -1, rd);
    return true;
  }
  if (opc == 0x0F && a) { emit3(U ? NEG : ABS, lanes, 0, rn, -1, -1, rd); return true; }
  if (opc == 0x1F && a && U) { emit3(SQRT, lanes, 0, rn, -1, -1, rd); return true; }
  return false;
}

// FMLA / FMLS / FMUL / FMULX by element (vector / scalar): Vm is v0..v15, index H:L:M
function indexed(insn: u32, scalar: bool): bool {
  let Q = (insn >> 30) & 1, U = (insn >> 29) & 1, opc = (insn >> 12) & 15;
  if (!(opc == 9 || (!U && (opc == 1 || opc == 5)))) return false;
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31), rm = <i32>((insn >> 16) & 15);
  let idx = (((insn >> 11) & 1) << 2) | (((insn >> 21) & 1) << 1) | ((insn >> 20) & 1);
  let kind: u32 = opc == 9 ? (U ? MULX : MUL) : FMA;
  op(kind, scalar ? L1 : Q ? L8 : L4, opc == 5 ? 1 : 0);
  vget(rn); vget(rm); simd(0x19); b(idx); simd(0x10); if (kind == FMA) vget(rd); else zero();
  call(); vset(rd);
  return true;
}

// SCVTF / UCVTF / FCVTZS / FCVTZU, fixed-point, immh = 001x (vector / scalar)
function fixedConv(insn: u32, scalar: bool): bool {
  let Q = (insn >> 30) & 1, U = (insn >> 29) & 1, opc = (insn >> 11) & 31;
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31);
  let fbits: u32 = 32 - ((insn >> 16) & 0x7F);
  let lanes: u32 = scalar ? L1 : Q ? L8 : L4;
  if (opc == 0x1C) op(FROMINT, lanes, U ? UNS : 0, fbits);
  else if (opc == 0x1F) op(TOINT, lanes, 3 | (U ? UNS : 0), fbits);
  else return false;
  vget(rn); zero(); zero(); call(); vset(rd);
  return true;
}

// FMLAL / FMLSL / FMLAL2 / FMLSL2 (FHM: half to single, fused), vector and by element (Vm v0..v15, index H:L:M)
function fhm(insn: u32): i32 {
  let Q = (insn >> 30) & 1, U = (insn >> 29) & 1;
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31);
  if ((insn & 0x9F60DC00) == 0x0E20CC00 && ((insn >> 13) & 1) == (U ^ 1)) {
    op(FMLAL, Q ? L8 : L4, ((insn >> 23) & 1) | (U << 1));
    vget(rn); vget(<i32>((insn >> 16) & 31)); vget(rd); call(); vset(rd);
    return 1;
  }
  if ((insn & 0x9FC00400) == 0x0F800000) {
    let opc = (insn >> 12) & 15;
    if (U ? (opc != 8 && opc != 12) : (opc != 0 && opc != 4)) return -1;
    let idx = (((insn >> 11) & 1) << 2) | (((insn >> 21) & 1) << 1) | ((insn >> 20) & 1);
    op(FMLAL, Q ? L8 : L4, ((opc >> 2) & 1) | (U << 1));
    vget(rn); vget(<i32>((insn >> 16) & 15)); simd(0x19); b(idx); simd(0x10); vget(rd); call(); vset(rd);
    return 1;
  }
  return -1;
}

// the Advanced SIMD FP16 encodings; -1 when insn is none of them
export function trFp16Simd(insn: u32): i32 {
  let scalar = (insn & 0x10000000) != 0;
  if (scalar ? (insn >>> 30) != 1 : (insn >>> 31) != 0) return -1;
  if (!scalar) { let f = fhm(insn); if (f >= 0) return f; }
  let w = insn;
  if ((w & 0x9F60C400) == 0x0E400400 || (w & 0xDF60C400) == 0x5E400400) return threeSame(insn, scalar) ? 1 : 0;
  if ((w & 0x9F7E0C00) == 0x0E780800 || (w & 0xDF7E0C00) == 0x5E780800) return twoReg(insn, scalar) ? 1 : 0;
  if (!scalar && (insn & 0xBF7E0C00) == 0x0E300800) { // FMAXNMV / FMINNMV / FMAXV / FMINV
    let opc = (insn >> 12) & 31, a = (insn >> 23) & 1;
    if (opc != 12 && opc != 15) return -1;
    let kind: u32 = opc == 12 ? (a ? MINNM : MAXNM) : (a ? MIN : MAX);
    emit3(kind, (insn >> 30) & 1 ? L8 : L4, 0, <i32>((insn >> 5) & 31), -1, -1, <i32>(insn & 31), RED);
    return 1;
  }
  if (scalar && (insn & 0xFF7E0C00) == 0x5E300800) { // FMAXNMP / FMINNMP / FADDP / FMAXP / FMINP (scalar, two halves)
    let opc = (insn >> 12) & 31, a = (insn >> 23) & 1;
    let kind: u32 = opc == 12 ? (a ? MINNM : MAXNM) : opc == 13 ? (a ? NONE : ADD) : opc == 15 ? (a ? MIN : MAX) : NONE;
    if (kind == NONE) return -1;
    emit3(kind, L1, 0, <i32>((insn >> 5) & 31), -1, -1, <i32>(insn & 31), RED);
    return 1;
  }
  if ((w & 0x9FC00400) == 0x0F000000 || (w & 0xDFC00400) == 0x5F000000) {
    let opc = (insn >> 12) & 15;
    if (opc == 1 || opc == 5 || opc == 9) return indexed(insn, scalar) ? 1 : 0;
    return -1;
  }
  if (((w & 0x9F800400) == 0x0F000400 || (w & 0xDF800400) == 0x5F000400) && ((insn >> 20) & 7) == 1) {
    let opc = (insn >> 11) & 31;
    if (opc == 0x1C || opc == 0x1F) return fixedConv(insn, scalar) ? 1 : 0;
  }
  return -1;
}
