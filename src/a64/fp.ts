// nxweb a64: scalar floating point and SIMD&FP register loads/stores.
import {
  b, leb, i32c, i64c, f32c, f64c, v128c, lget, lset, ltee, simd, vmem, mem, aw, moff, fc, ar, cm, cst,
  getX, getXsp, setX, setXsp, rget, rset, t32, t64, ta, tf32, tf64, tv, emitCond, killCmp, optFma, optNan, gget,
  G_FPCR, F_NAN1S, F_NAN2S, F_NAN3S, F_RND, F_SFS, F_SFD, T_I64, optRmArith,
  R_N, R_Z, R_C, R_V, R_V0, T_I32,
} from "./emit";
import { getExtended } from "./int";
import { trSimd } from "./simd";

// @ts-ignore
@inline function sx(x: u32, bits: u32): i64 { return <i64>((<i32>(x << (32 - bits))) >> (32 - bits)); }

export function vget(r: i32): void { rget(R_V0 + r); }
export function vset(r: i32): void { rset(R_V0 + r); }
// scalar float access (lane 0)
export function getF(r: i32, d: bool): void { vget(r); simd(d ? 0x21 : 0x1F); b(0); }
// stack: f32/f64 -> ; writes lane 0, zeroes the rest
export function setF(r: i32, d: bool): void {
  let t = d ? tf64(7) : tf32(7);
  lset(t); v128c(0, 0); lget(t); simd(d ? 0x22 : 0x20); b(0); vset(r);
}
// stack: i32/i64 -> ; writes low 32/64 bits, zeroes the rest
export function setVint(r: i32, is64: bool): void {
  let t = is64 ? t64(7) : t32(7);
  lset(t); v128c(0, 0); lget(t); simd(is64 ? 0x1E : 0x1C); b(0); vset(r);
}
// float arithmetic opcode by width (f32 opcode given)
// @ts-ignore
@inline function fa(d: bool, o: u32): void { b(d ? o + 0x0E : o); }
// @ts-ignore
@inline function fcm(d: bool, o: u32): void { b(d ? o + 6 : o); }
function fconst(d: bool, v: f64): void { if (d) f64c(reinterpret<u64>(v)); else f32c(reinterpret<u32>(<f32>v)); }

// stack: x -> round-to-nearest-ties-away(x)
export function roundAway(d: bool): void {
  let X = d ? tf64(0) : tf32(0), T = d ? tf64(1) : tf32(1);
  ltee(X); fa(d, 0x8F); lset(T);
  lget(T); fconst(d, 1.0); lget(X); fa(d, 0x98); fa(d, 0x92);
  lget(T);
  lget(X); lget(T); fa(d, 0x93); fa(d, 0x8B); fconst(d, 0.5); fcm(d, 0x60);
  b(0x1B);
}
// stack: x -> rounded x. mode: 0 nearest-even, 1 +inf, 2 -inf, 3 zero, 4 away
export function roundMode(d: bool, mode: u32): void {
  switch (mode) {
    case 0: fa(d, 0x90); break;
    case 1: fa(d, 0x8D); break;
    case 2: fa(d, 0x8E); break;
    case 3: fa(d, 0x8F); break;
    default: roundAway(d); break;
  }
}
// stack: a b -> flags of FP compare
function fpFlags(d: bool): void {
  let A = d ? tf64(0) : tf32(0), B = d ? tf64(1) : tf32(1), lt = t32(1);
  lset(B); lset(A);
  lget(A); lget(B); fcm(d, 0x5D); ltee(lt); rset(R_N);
  lget(A); lget(B); fcm(d, 0x5B); rset(R_Z);
  lget(lt); b(0x45); rset(R_C);
  lget(A); lget(A); fcm(d, 0x5C); lget(B); lget(B); fcm(d, 0x5C); b(0x72); rset(R_V);
  killCmp();
}
// stack: a b -> FMAXNM/FMINNM(a, b)
export function minMaxNum(d: bool, isMax: bool): void {
  let A = d ? tf64(0) : tf32(0), B = d ? tf64(1) : tf32(1), R = d ? tf64(2) : tf32(2);
  lset(B); lset(A);
  lget(A); lget(B); fa(d, isMax ? 0x97 : 0x96); lset(R);
  // a quiet NaN, b a number -> b
  lget(B); lget(R);
  lget(A); lget(A); fcm(d, 0x5C); lget(B); lget(B); fcm(d, 0x5B); b(0x71);
  if (d) { lget(A); b(0xBD); i64c(51); b(0x88); b(0xA7); } else { lget(A); b(0xBC); i32c(22); b(0x76); }
  b(0x71); i32c(1); b(0x71);
  b(0x1B); lset(R);
  lget(A); lget(R);
  lget(B); lget(B); fcm(d, 0x5C); lget(A); lget(A); fcm(d, 0x5B); b(0x71);
  if (d) { lget(B); b(0xBD); i64c(51); b(0x88); b(0xA7); } else { lget(B); b(0xBC); i32c(22); b(0x76); }
  b(0x71); i32c(1); b(0x71);
  b(0x1B);
}
// stack: r -> r' ; scalar NaN fix-up with operands in float temps 3 (a) and 4 (b); n = operand count
export function nanFixS(d: bool, n: i32): void {
  if (!optNan) return;
  let R = d ? tf64(5) : tf32(5), A = d ? tf64(3) : tf32(3), B = d ? tf64(4) : tf32(4);
  ltee(R); lget(R); fcm(d, 0x5C);
  b(0x04); b(0x40);
  lget(A); if (n == 2) lget(B);
  b(0x10); leb((n == 2 ? F_NAN2S : F_NAN1S) + (d ? 1 : 0)); lset(R);
  b(0x0B);
  lget(R);
}
// push i32: FPCR.RMode != 0
export function rmodeTest(): void { gget(G_FPCR); i32c(0xC00000); b(0x71); }
// stack: i64 x -> i64 ; rnd(op | RMode << 8, x)
export function rndCall(op: i32): void {
  let t = t64(6);
  lset(t); gget(G_FPCR); i32c(14); b(0x76); i32c(0x300); b(0x71); i32c(op); b(0x72); lget(t); b(0x10); leb(F_RND);
}
// FPCR.RMode, FZ and DN: the soft-FP slow path (helpers sfs/sfd, softfp.ts) runs when any is set
export const FPCR_SLOW = 0x3C00000;
export const FPCR_FZ = 0x1000000;
export function fpcrTest(): void { gget(G_FPCR); i32c(FPCR_SLOW); b(0x71); }
// push i32: op | FPCR's RMode/FZ/DN bits
export function fpcrOp(op: i32): void { gget(G_FPCR); i32c(FPCR_SLOW); b(0x71); i32c(op); b(0x72); }
// stack: op a b c -> r
export function sfCall(d: bool): void { b(0x10); leb(d ? F_SFD : F_SFS); }
// stack: x -> x, flushed to zero when FPCR.FZ (for operations whose only FPCR dependence is the input flush)
export function fzFlush(d: bool): void {
  if (!optRmArith) return;
  let T = d ? tf64(7) : tf32(7);
  lset(T); gget(G_FPCR); i32c(FPCR_FZ); b(0x71); b(0x04); b(d ? 0x7C : 0x7D);
  i32c(13 | (d ? 2 : 1) << 12); lget(T);
  if (d) b(0xBD); else { b(0xBC); b(0xAD); }
  b(0x10); leb(F_RND);
  if (d) b(0xBF); else { b(0xA7); b(0xBE); }
  b(0x05); lget(T); b(0x0B);
}
// stack: i64 x -> i64 ; FCVT from format src to dst (0 h 1 s 2 d) under FPCR
export function cvtCall(src: i32, dst: i32): void {
  let t = t64(6);
  lset(t); fpcrOp(12 | src << 12 | dst << 14); lget(t); b(0x10); leb(F_RND);
}
// stack: i64 x -> i64 ; rnd(op, x)
export function rndConst(op: i32): void { let t = t64(6); lset(t); i32c(op); lget(t); b(0x10); leb(F_RND); }
// stack: i64 x -> i64 ; a conversion to or from half: rnd(op) under the default FPCR, else cvtCall(src, dst)
function halfCvt(src: i32, dst: i32, op: i32): void {
  if (!optRmArith) { rndConst(op); return; }
  let t = t64(7);
  lset(t); fpcrTest(); b(0x04); b(T_I64); lget(t); cvtCall(src, dst); b(0x05); lget(t); rndConst(op); b(0x0B);
}
// stack: x -> x rounded by FPCR.RMode (FRINTI / FRINTX)
function frintCurrent(d: bool): void {
  let X = d ? tf64(0) : tf32(0);
  lset(X);
  rmodeTest();
  b(0x04); b(d ? 0x7C : 0x7D);
  lget(X); if (d) b(0xBD); else { b(0xBC); b(0xAD); }
  rndCall(d ? 0 : 1);
  if (d) b(0xBF); else { b(0xA7); b(0xBE); }
  b(0x05); lget(X); fa(d, 0x90); b(0x0B);
}
// stack: -> r ; FRINT* of S/D register rn. mode 0 N 1 P 2 M 3 Z 4 A 5 FPCR
function frintOp(rn: i32, d: bool, mode: u32): void {
  if (optRmArith) {
    fpcrTest(); b(0x04); b(d ? 0x7C : 0x7D);
    fpcrOp(14 | mode << 8); getF(rn, d); getF(rn, d); getF(rn, d); sfCall(d);
    b(0x05);
  }
  getF(rn, d);
  if (mode == 5 && !optRmArith) frintCurrent(d); else roundMode(d, mode == 5 ? 0 : mode);
  if (optRmArith) b(0x0B);
}

// stack: i64 (already extended) -> float ; honours FPCR.RMode
function intToFp(d: bool, U: bool, fbits: i32): void {
  let X = t64(5);
  lset(X);
  rmodeTest();
  b(0x04); b(d ? 0x7C : 0x7D);
  lget(X); rndCall((d ? (U ? 4 : 3) : (U ? 6 : 5)) | (fbits << 16));
  if (d) b(0xBF); else { b(0xA7); b(0xBE); }
  b(0x05);
  lget(X); b(d ? (U ? 0xBA : 0xB9) : (U ? 0xB5 : 0xB4));
  if (fbits) { if (d) f64c(<u64>(1023 - fbits) << 52); else f32c(<u32>(127 - fbits) << 23); fa(d, 0x94); }
  b(0x0B);
}

export function vfpExpand64(imm8: u32): u64 {
  let sign: u64 = imm8 >> 7, b6 = (imm8 >> 6) & 1;
  let exp: u64 = (b6 ? 0x3FC : 0x400) | ((imm8 >> 4) & 3);
  return (sign << 63) | (exp << 52) | (<u64>(imm8 & 15) << 48);
}
export function vfpExpand32(imm8: u32): u32 {
  let sign = imm8 >> 7, b6 = (imm8 >> 6) & 1;
  let exp: u32 = (b6 ? 0x7C : 0x80) | ((imm8 >> 4) & 3);
  return (sign << 31) | (exp << 23) | ((imm8 & 15) << 19);
}

function fmaddFast(d: bool, o1: u32, o0: u32, rd: i32, rn: i32, rm: i32, ra: i32): void {
  if (optFma) {
    vget(rn); vget(rm); vget(ra);
    if (o1) simd(d ? 0xED : 0xE1);
    // madd(a,b,c) = a*b+c ; nmadd = -(a*b)+c
    let useN = (o1 ^ o0) != 0;
    simd(d ? (useN ? 0x108 : 0x107) : (useN ? 0x106 : 0x105));
    if (optNan) {
      let R = d ? tf64(5) : tf32(5);
      simd(d ? 0x21 : 0x1F); b(0); ltee(R); lget(R); fcm(d, 0x5C);
      b(0x04); b(0x40);
      getF(ra, d); if (o1) fa(d, 0x8C);
      getF(rn, d); if (o1 ^ o0) fa(d, 0x8C);
      getF(rm, d);
      b(0x10); leb(F_NAN3S + (d ? 1 : 0)); lset(R);
      b(0x0B);
      lget(R); setF(rd, d);
      return;
    }
    if (d) v128c(~(<u64>0), 0); else v128c(0xFFFFFFFF, 0);
    simd(0x4E); vset(rd);
  } else {
    getF(ra, d); if (o1) fa(d, 0x8C);
    getF(rn, d); getF(rm, d); fa(d, 0x94);
    fa(d, (o1 ^ o0) ? 0x93 : 0x92);
    setF(rd, d);
  }
}

// FP data-processing (2 source) opcode -> soft-FP op
const SF2: StaticArray<u8> = [2, 3, 0, 1, 5, 6, 7, 8, 2];

export function trFp(pc: u64, insn: u32): bool {
  let rd = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31), rm = <i32>((insn >> 16) & 31);
  let ty = (insn >> 22) & 3;
  let d = ty == 1;
  if ((insn & 0xFF000000) == 0x1F000000) { // FMADD family
    if (ty > 1) return false;
    let o1 = (insn >> 21) & 1, o0 = (insn >> 15) & 1, ra = <i32>((insn >> 10) & 31);
    if (optRmArith) {
      fpcrTest(); b(0x04); b(0x40);
      fpcrOp(9);
      getF(ra, d); if (o1) fa(d, 0x8C);
      getF(rn, d); if (o1 ^ o0) fa(d, 0x8C);
      getF(rm, d); sfCall(d); setF(rd, d);
      b(0x05);
    }
    fmaddFast(d, o1, o0, rd, rn, rm, ra);
    if (optRmArith) b(0x0B);
    return true;
  }
  if ((insn & 0x7F200000) == 0x1E000000) { // fixed-point conversions
    if (ty > 1) return false;
    let sf = (insn >>> 31) != 0, rmode = (insn >> 19) & 3, opcode = (insn >> 16) & 7, scale = (insn >> 10) & 63;
    let fbits = 64 - scale;
    if (!sf && scale < 32) return false;
    if (rmode == 0 && (opcode == 2 || opcode == 3)) {
      getX(rn, sf); if (!sf) b((opcode & 1) ? 0xAD : 0xAC);
      intToFp(d, (opcode & 1) != 0, fbits); setF(rd, d);
      return true;
    }
    if (rmode == 3 && opcode < 2) {
      getF(rn, d); fzFlush(d);
      if (d) f64c(<u64>(1023 + fbits) << 52); else f32c(<u32>(127 + fbits) << 23);
      fa(d, 0x94); fc((sf ? 4 : 0) + (d ? 2 : 0) + opcode);
      setX(rd, sf);
      return true;
    }
    return false;
  }
  if ((insn & 0x7F200000) != 0x1E200000) return trSimd(pc, insn);
  if ((insn & 0xFC00) == 0) { // FP <-> integer
    let sf = (insn >>> 31) != 0, rmode = (insn >> 19) & 3, opcode = (insn >> 16) & 7;
    if (opcode >= 6) {
      if (rmode == 0 && ty == 0 && !sf) {
        if (opcode == 6) { vget(rn); simd(0x1B); b(0); setX(rd, false); } else { getX(rn, false); setVint(rd, false); }
        return true;
      }
      if (rmode == 3 && ty == 1 && !sf && opcode == 6) { // FJCVTZS: Wd and Z from the helper, N C V clear
        let t = t64(7);
        vget(rn); simd(0x1D); b(0); rndConst(11); ltee(t); b(0xA7); setX(rd, false);
        lget(t); i64c(32); b(0x88); b(0xA7); rset(R_Z);
        i32c(0); rset(R_N); i32c(0); rset(R_C); i32c(0); rset(R_V); killCmp();
        return true;
      }
      if (rmode == 0 && ty == 1 && sf) {
        if (opcode == 6) { vget(rn); simd(0x1D); b(0); setX(rd, true); } else { getX(rn, true); setVint(rd, true); }
        return true;
      }
      if (rmode == 1 && ty == 2 && sf) {
        if (opcode == 6) { vget(rn); simd(0x1D); b(1); setX(rd, true); }
        else { vget(rd); getX(rn, true); simd(0x1E); b(1); vset(rd); }
        return true;
      }
      return false;
    }
    if (ty > 1) return false;
    if (opcode == 2 || opcode == 3) {
      if (rmode != 0) return false;
      getX(rn, sf); if (!sf) b((opcode & 1) ? 0xAD : 0xAC);
      intToFp(d, (opcode & 1) != 0, 0); setF(rd, d);
      return true;
    }
    let mode: u32 = opcode >= 4 ? 4 : rmode;
    if (opcode >= 4 && rmode != 0) return false;
    getF(rn, d); fzFlush(d);
    if (mode != 3) roundMode(d, mode);
    fc((sf ? 4 : 0) + (d ? 2 : 0) + (opcode & 1));
    setX(rd, sf);
    return true;
  }
  if (insn >>> 31) return false;
  if ((insn & 0x7C00) == 0x4000) { // half-precision conversions
    let opcode = (insn >> 15) & 63;
    if (ty == 3 && (opcode == 4 || opcode == 5)) {
      vget(rn); simd(0x19); b(0); b(0xAD); halfCvt(0, opcode == 4 ? 1 : 2, opcode == 4 ? 7 : 8);
      if (opcode == 4) b(0xA7);
      setVint(rd, opcode == 5); return true;
    }
    if (ty < 2 && opcode == 7) {
      getF(rn, d); if (d) b(0xBD); else { b(0xBC); b(0xAD); }
      halfCvt(d ? 2 : 1, 0, d ? 10 : 9); b(0xA7); setVint(rd, false); return true;
    }
  }
  if (ty > 1) return false;
  switch ((insn >> 10) & 3) {
    case 1: { // FCCMP / FCCMPE
      let c = t32(0), cond = (insn >> 12) & 15, nzcv = insn & 15;
      emitCond(cond); lset(c);
      getF(rn, d); fzFlush(d); getF(rm, d); fzFlush(d); fpFlags(d);
      rget(R_N); i32c((nzcv >> 3) & 1); lget(c); b(0x1B); rset(R_N);
      rget(R_Z); i32c((nzcv >> 2) & 1); lget(c); b(0x1B); rset(R_Z);
      rget(R_C); i32c((nzcv >> 1) & 1); lget(c); b(0x1B); rset(R_C);
      rget(R_V); i32c(nzcv & 1); lget(c); b(0x1B); rset(R_V);
      return true;
    }
    case 2: { // two-source
      let opcode = (insn >> 12) & 15;
      let A = d ? tf64(3) : tf32(3), B = d ? tf64(4) : tf32(4);
      if (opcode > 8) return false;
      let dir = optRmArith;
      getF(rn, d); lset(A); getF(rm, d); lset(B);
      if (dir) {
        fpcrTest(); b(0x04); b(d ? 0x7C : 0x7D);
        fpcrOp(<i32>SF2[opcode]); lget(A); lget(B); lget(B); sfCall(d);
        b(0x05);
      }
      lget(A); lget(B);
      switch (opcode) {
        case 0: fa(d, 0x94); break;
        case 1: fa(d, 0x95); break;
        case 2: fa(d, 0x92); break;
        case 3: fa(d, 0x93); break;
        case 4: fa(d, 0x97); break;
        case 5: fa(d, 0x96); break;
        case 6: minMaxNum(d, true); break;
        case 7: minMaxNum(d, false); break;
        case 8: fa(d, 0x94); break;
        default: return false;
      }
      nanFixS(d, 2);
      if (dir) b(0x0B);
      if (opcode == 8) fa(d, 0x8C);
      setF(rd, d);
      return true;
    }
    case 3: { // FCSEL
      getF(rn, d); getF(rm, d); emitCond((insn >> 12) & 15); b(0x1B); setF(rd, d);
      return true;
    }
  }
  if ((insn & 0x1C00) == 0x1000) { // FMOV immediate
    if ((insn & 0x3E0) != 0) return false;
    let imm8 = (insn >> 13) & 0xFF;
    if (d) v128c(vfpExpand64(imm8), 0); else v128c(vfpExpand32(imm8), 0);
    vset(rd);
    return true;
  }
  if ((insn & 0x3C00) == 0x2000) { // FCMP / FCMPE
    if ((insn & 0xC000) != 0 || (insn & 7) != 0) return false;
    getF(rn, d); fzFlush(d);
    if (insn & 8) fconst(d, 0.0); else { getF(rm, d); fzFlush(d); }
    fpFlags(d);
    return true;
  }
  if ((insn & 0x7C00) == 0x4000) { // one-source
    let opcode = (insn >> 15) & 63;
    switch (opcode) {
      case 0: getF(rn, d); setF(rd, d); return true;
      case 1: getF(rn, d); fa(d, 0x8B); setF(rd, d); return true;
      case 2: getF(rn, d); fa(d, 0x8C); setF(rd, d); return true;
      case 3: {
        let A = d ? tf64(3) : tf32(3);
        getF(rn, d); lset(A);
        if (optRmArith) {
          fpcrTest(); b(0x04); b(d ? 0x7C : 0x7D);
          fpcrOp(4); lget(A); lget(A); lget(A); sfCall(d);
          b(0x05);
        }
        lget(A); fa(d, 0x91); nanFixS(d, 1);
        if (optRmArith) b(0x0B);
        setF(rd, d); return true;
      }
      case 4: {
        if (!d) return false;
        let X = tf64(0);
        getF(rn, true); lset(X);
        if (optRmArith) fpcrTest(); else rmodeTest();
        b(0x04); b(0x7D);
        lget(X); b(0xBD);
        if (optRmArith) cvtCall(2, 1); else rndCall(2);
        b(0xA7); b(0xBE);
        b(0x05); lget(X); b(0xB6); b(0x0B);
        setF(rd, false); return true;
      }
      case 5: {
        if (d) return false;
        getF(rn, false);
        if (optRmArith) {
          let X = tf32(0);
          lset(X); fpcrTest(); b(0x04); b(0x7C);
          lget(X); b(0xBC); b(0xAD); cvtCall(1, 2); b(0xBF);
          b(0x05); lget(X); b(0xBB); b(0x0B);
        } else b(0xBB);
        setF(rd, true); return true;
      }
      case 8: frintOp(rn, d, 0); setF(rd, d); return true;
      case 9: frintOp(rn, d, 1); setF(rd, d); return true;
      case 10: frintOp(rn, d, 2); setF(rd, d); return true;
      case 11: frintOp(rn, d, 3); setF(rd, d); return true;
      case 12: frintOp(rn, d, 4); setF(rd, d); return true;
      case 14: case 15: frintOp(rn, d, 5); setF(rd, d); return true;
    }
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// SIMD&FP register loads / stores. scale: 0..4 (B H S D Q)
const A = 8;
// stack: -> ; address in t64(A)
function loadVec(rt: i32, scale: u32): void {
  let a = t64(A);
  switch (scale) {
    case 4: lget(a); aw(); vmem(0x00); break;
    case 3: lget(a); aw(); vmem(0x5D); break;
    case 2: lget(a); aw(); vmem(0x5C); break;
    case 1: v128c(0, 0); lget(a); aw(); mem(0x2F); simd(0x1C); b(0); break;
    default: v128c(0, 0); lget(a); aw(); mem(0x2D); simd(0x1C); b(0); break;
  }
  vset(rt);
}
function storeVec(rt: i32, scale: u32): void {
  let a = t64(A);
  lget(a); aw(); vget(rt);
  if (scale == 4) vmem(0x0B); else { vmem(0x58 + scale); b(0); }
}

function structLoadStore(insn: u32): bool {
  let Q = (insn >> 30) & 1, L = (insn >> 22) & 1, post = (insn >> 23) & 1;
  let rm = <i32>((insn >> 16) & 31), rn = <i32>((insn >> 5) & 31), rt = <i32>(insn & 31);
  let size = (insn >> 10) & 3;
  let a = t64(A), a32 = ta(A), T = tv(7);
  if (!post && rm != 0) return false;
  let total: i32;
  if ((insn & 0x01000000) == 0) { // multiple structures
    if (insn & (1 << 21)) return false;
    let opcode = (insn >> 12) & 15;
    let n: i32 = 1, selem: i32 = 1;
    switch (opcode) {
      case 7: n = 1; break; case 10: n = 2; break; case 6: n = 3; break; case 2: n = 4; break;
      case 8: selem = 2; break; case 4: selem = 3; break; case 0: selem = 4; break;
      default: return false;
    }
    let bytes: i32 = Q ? 16 : 8;
    if (selem > 1 && size == 3 && !Q) return false;
    getXsp(rn, true); ltee(a); aw(); lset(a32);
    total = n * selem * bytes;
    if (selem == 1) {
      for (let i = 0; i < n; i++) {
        let r = (rt + i) & 31;
        if (L) { lget(a32); simd(Q ? 0x00 : 0x5D); b(0); moff(i * bytes); vset(r); }
        else { lget(a32); vget(r); if (Q) { simd(0x0B); b(0); moff(i * bytes); } else { simd(0x5B); b(0); moff(i * bytes); b(0); } }
      }
    } else {
      let elems: i32 = bytes >> size, eb: i32 = 1 << size;
      for (let s = 0; s < selem; s++) {
        let r = (rt + s) & 31;
        if (L) {
          v128c(0, 0); lset(T);
          for (let e = 0; e < elems; e++) { lget(a32); lget(T); simd(0x54 + size); b(0); moff((e * selem + s) * eb); b(e); lset(T); }
          lget(T); vset(r);
        } else {
          for (let e = 0; e < elems; e++) { lget(a32); vget(r); simd(0x58 + size); b(0); moff((e * selem + s) * eb); b(e); }
        }
      }
    }
  } else {
    // single structure
    let R = (insn >> 21) & 1, opcode = (insn >> 13) & 7, S = (insn >> 12) & 1;
    let scale = opcode >> 1, index: u32 = 0;
    let selem: i32 = <i32>(((opcode & 1) << 1) | R) + 1;
    let repl = scale == 3;
    if (repl) { if (!L || S) return false; scale = size; }
    else {
      switch (scale) {
        case 0: index = (Q << 3) | (S << 2) | size; break;
        case 1: if (size & 1) return false; index = (Q << 2) | (S << 1) | (size >> 1); break;
        default:
          if (size == 0) index = (Q << 1) | S;
          else if (size == 1 && !S) { scale = 3; index = Q; }
          else return false;
      }
    }
    let eb: i32 = 1 << scale;
    total = selem * eb;
    getXsp(rn, true); ltee(a); aw(); lset(a32);
    for (let s = 0; s < selem; s++) {
      let r = (rt + s) & 31;
      if (repl) {
        lget(a32); simd(0x07 + scale); b(0); moff(s * eb);
        if (!Q) { v128c(~(<u64>0), 0); simd(0x4E); }
        vset(r);
      } else if (L) { lget(a32); vget(r); simd(0x54 + scale); b(0); moff(s * eb); b(index); vset(r); }
      else { lget(a32); vget(r); simd(0x58 + scale); b(0); moff(s * eb); b(index); }
    }
  }
  if (post) {
    lget(a); if (rm == 31) i64c(total); else getX(rm, true);
    b(0x7C); setXsp(rn, true);
  }
  return true;
}

export function trLoadStoreVec(pc: u64, insn: u32): bool {
  let rt = <i32>(insn & 31), rn = <i32>((insn >> 5) & 31);
  let size = insn >>> 30;
  let a = t64(A);
  if ((insn & 0xBE000000) == 0x0C000000) return structLoadStore(insn);
  if ((insn & 0x3B000000) == 0x18000000) { // literal
    if (size == 3) return false;
    i64c(<i64>pc + (sx((insn >> 5) & 0x7FFFF, 19) << 2)); lset(a);
    loadVec(rt, 2 + size);
    return true;
  }
  if ((insn & 0x3A000000) == 0x28000000) { // pair
    let type = (insn >> 23) & 3, L = (insn >> 22) & 1, rt2 = <i32>((insn >> 10) & 31);
    if (size == 3) return false;
    let sc = 2 + size;
    let imm: i64 = sx((insn >> 15) & 0x7F, 7) << sc;
    getXsp(rn, true);
    if (type != 1 && imm != 0) { i64c(imm); b(0x7C); }
    lset(a);
    let a2 = t64(A + 1);
    if (type == 1) { lget(a); i64c(imm); b(0x7C); setXsp(rn, true); }
    else if (type == 3) { lget(a); setXsp(rn, true); }
    if (L) loadVec(rt, sc); else storeVec(rt, sc);
    lget(a); i64c(<i64>1 << sc); b(0x7C); lset(a);
    if (L) loadVec(rt2, sc); else storeVec(rt2, sc);
    return true;
  }
  if ((insn & 0x3A000000) != 0x38000000) return false;
  let opc = (insn >> 22) & 3;
  let scale = size;
  if (opc & 2) { if (size != 0) return false; scale = 4; }
  let wb = 0;
  let imm: i64 = 0;
  if (insn & (1 << 24)) {
    imm = <i64>((insn >> 10) & 0xFFF) << scale;
    getXsp(rn, true); if (imm) { i64c(imm); b(0x7C); }
  } else if (insn & (1 << 21)) {
    if (((insn >> 10) & 3) != 2) return false;
    let option = (insn >> 13) & 7, S = (insn >> 12) & 1;
    if ((option & 2) == 0) return false;
    getXsp(rn, true); getExtended(<i32>((insn >> 16) & 31), true, option, S ? scale : 0); b(0x7C);
  } else {
    let m = (insn >> 10) & 3;
    imm = sx((insn >> 12) & 0x1FF, 9);
    if (m == 2) return false;
    wb = m == 1 ? 1 : m == 3 ? 2 : 0;
    getXsp(rn, true); if (wb != 1 && imm) { i64c(imm); b(0x7C); }
  }
  lset(a);
  if (opc & 1) loadVec(rt, scale); else storeVec(rt, scale);
  if (wb == 1) { lget(a); i64c(imm); b(0x7C); setXsp(rn, true); }
  else if (wb == 2) { lget(a); setXsp(rn, true); }
  return true;
}
