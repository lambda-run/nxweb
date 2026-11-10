"""T2..T4 instruction classes: scalar FP, SIMD&FP loads/stores, Advanced SIMD."""
from fuzz_lib import CODE_BASE, SLOT, WIN_MID, Case, Enc, Seq
import fuzz_lib
from fuzz_classes import E, S

TY = ((0, 32, "s"), (1, 64, "d"))

# ------------------------------------------------------------------------------ T2: scalar FP
for ty, fp, n in TY:
    E("fp1_%s" % n, "000 11110 ty:2 1 opcode:6 10000 Rn:5 Rd:5", fix={"ty": ty, "opcode": [0, 1, 2, 3, 8, 9, 10, 11, 12, 14, 15]}, fp=fp)
    E("fp2_%s" % n, "000 11110 ty:2 1 Rm:5 opcode:4 10 Rn:5 Rd:5", fix={"ty": ty, "opcode": [0, 1, 2, 3, 4, 5, 8]}, fp=fp)
    E("fminnm_fmaxnm_%s" % n, "000 11110 ty:2 1 Rm:5 011 o:1 10 Rn:5 Rd:5", fix={"ty": ty}, fp=fp)
    E("fmadd_%s" % n, "000 11111 ty:2 o1:1 Rm:5 o0:1 Ra:5 Rn:5 Rd:5", fix={"ty": ty}, fp=fp)
    E("fcmp_%s" % n, "000 11110 ty:2 1 Rm:5 00 1000 Rn:5 op:2 000", fix={"ty": ty}, fp=fp)
    E("fccmp_%s" % n, "000 11110 ty:2 1 Rm:5 cond:4 01 Rn:5 op:1 nzcv:4", fix={"ty": ty}, fp=fp)
    E("fcsel_%s" % n, "000 11110 ty:2 1 Rm:5 cond:4 11 Rn:5 Rd:5", fix={"ty": ty}, fp=fp)
    E("fmov_imm_%s" % n, "000 11110 ty:2 1 imm8:8 100 00000 Rd:5", fix={"ty": ty}, fp=fp)
    E("fcvt_to_int_%s" % n, "sf:1 00 11110 ty:2 1 rmode:2 00 u:1 000000 Rn:5 Rd:5", fix={"ty": ty}, fp=fp)
    E("fcvta_%s" % n, "sf:1 00 11110 ty:2 1 00 10 u:1 000000 Rn:5 Rd:5", fix={"ty": ty}, fp=fp)
    E("int_to_fp_%s" % n, "sf:1 00 11110 ty:2 1 00 01 u:1 000000 Rn:5 Rd:5", fix={"ty": ty}, fp=fp)
    E("scvtf_fixed_%s" % n, "sf:1 00 11110 ty:2 0 00 01 u:1 scale:6 Rn:5 Rd:5", fix={"ty": ty}, fp=fp,
      filt=lambda f: f["sf"] or f["scale"] >= 32)
    E("fcvtz_fixed_%s" % n, "sf:1 00 11110 ty:2 0 11 00 u:1 scale:6 Rn:5 Rd:5", fix={"ty": ty}, fp=fp,
      filt=lambda f: f["sf"] or f["scale"] >= 32)
E("fcvt_s_to_d", "000 11110 00 1 000101 10000 Rn:5 Rd:5", fp=(32, 64))
E("fcvt_d_to_s", "000 11110 01 1 000100 10000 Rn:5 Rd:5", fp=(64, 32))


def fmov_gen(rng, pc):
    sf, ty, rmode = rng.choice(((0, 0, 0), (1, 1, 0), (1, 2, 1)))
    return Case([(sf << 31) | 0x1E200000 | (ty << 22) | (rmode << 19) | (rng.choice((6, 7)) << 16) | (rng.randrange(32) << 5) | rng.randrange(32)])


S("fmov_general", fmov_gen)

_vsz_ok = lambda f: f["opc"] < 2 or f["size"] == 0
E("ldst_v_uimm", "size:2 111101 opc:2 imm12:12 Rn:5 Rt:5", fix={"imm12": range(64)}, base="Rn", filt=_vsz_ok)
E("ldst_v_imm9", "size:2 111100 opc:2 0 imm9:9 mode:2 Rn:5 Rt:5", fix={"mode": [0, 1, 3]}, base="Rn", filt=_vsz_ok)
E("ldst_v_regoff", "size:2 111100 opc:2 1 Rm:5 option:3 S:1 10 Rn:5 Rt:5", fix={"option": [2, 3, 6, 7]}, base="Rn", small=("Rm",),
  filt=lambda f: _vsz_ok(f) and f["Rm"] != 31)
E("ldst_v_pair", "opc:2 101 1 0 type:2 L:1 imm7:7 Rt2:5 Rn:5 Rt:5", fix={"opc": [0, 1, 2]}, base="Rn",
  filt=lambda f: not (f["L"] and f["Rt"] == f["Rt2"]))


def vlit_case(rng, pc):
    tgt = CODE_BASE + rng.randrange(0, min(fuzz_lib.NCASES, 4096) * SLOT // 4 - 4) * 4
    return Case([(rng.randrange(3) << 30) | 0x1C000000 | ((((tgt - pc) >> 2) & 0x7FFFF) << 5) | rng.randrange(32)])


S("ldr_v_literal", vlit_case)

# ------------------------------------------------------------------------------ T3: Advanced SIMD
E("simd_modimm", "0 Q:1 op:1 0111100000 abc:3 cmode:4 0 1 defgh:5 Rd:5")


def copy_case(rng, pc):
    Q = rng.getrandbits(1)
    sz = rng.randrange(4)
    imm5 = ((rng.getrandbits(5) << 1) | 1) << sz & 31
    if imm5 & 15 == 0:
        imm5 = 1 << sz if sz < 4 else 8
    k = rng.randrange(7)
    rn, rd = rng.randrange(32), rng.randrange(32)
    base = 0x0E000400 | (imm5 << 16) | (rn << 5) | rd
    if k == 0:
        return Case([base | (Q << 30) | (0 << 11)])            # DUP element
    if k == 1:
        return Case([base | (Q << 30) | (1 << 11)])            # DUP general
    if k == 2:
        return Case([base | (1 << 30) | (3 << 11)])            # INS general
    if k == 3:
        return Case([base | (Q << 30) | (5 << 11)])            # SMOV
    if k == 4:
        return Case([base | (Q << 30) | (7 << 11)])            # UMOV
    if k == 5:
        return Case([base | (1 << 30) | (1 << 29) | ((rng.getrandbits(4) >> sz << sz) << 11)])   # INS element
    return Case([base | 0x50000000])                           # scalar DUP element


S("simd_copy", copy_case)
E("simd_logic", "0 Q:1 U:1 01110 size:2 1 Rm:5 00011 1 Rn:5 Rd:5")
E("simd_int3", "0 Q:1 U:1 01110 size:2 1 Rm:5 opcode:5 1 Rn:5 Rd:5",
  fix={"opcode": [6, 7, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23]},
  filt=lambda f: not (f["opcode"] == 19 and f["U"]) and not (f["opcode"] == 23 and f["U"]))
E("simd_int3_scalar", "01 U:1 11110 11 1 Rm:5 opcode:5 1 Rn:5 Rd:5", fix={"opcode": [6, 7, 16, 17]})
E("simd_halving", "0 Q:1 U:1 01110 size:2 1 Rm:5 00 k:1 0 0 1 Rn:5 Rd:5", fix={"size": [0, 1, 2]})
E("simd_rhadd", "0 Q:1 U:1 01110 size:2 1 Rm:5 00010 1 Rn:5 Rd:5", fix={"size": [0, 1, 2]})
E("simd_qadd_qsub", "0 Q:1 U:1 01110 size:2 1 Rm:5 00 k:1 01 1 Rn:5 Rd:5")
E("simd_qadd_qsub_scalar", "01 U:1 11110 size:2 1 Rm:5 00 k:1 01 1 Rn:5 Rd:5")
E("simd_sshl_ushl", "0 Q:1 U:1 01110 size:2 1 Rm:5 01000 1 Rn:5 Rd:5")
E("simd_sshl_ushl_scalar", "01 U:1 11110 11 1 Rm:5 01000 1 Rn:5 Rd:5")
FP3 = [(0, 0, 0x19), (0, 1, 0x19), (0, 0, 0x1A), (0, 1, 0x1A), (1, 0, 0x1A), (1, 1, 0x1A), (1, 0, 0x1B), (0, 0, 0x1C), (1, 0, 0x1C),
       (1, 1, 0x1C), (1, 0, 0x1D), (1, 1, 0x1D), (0, 0, 0x1E), (0, 1, 0x1E), (1, 0, 0x1F), (1, 0, 0x1E), (1, 1, 0x1E)]
FP3S = [(1, 1, 0x1A), (0, 0, 0x1C), (1, 0, 0x1C), (1, 1, 0x1C), (1, 0, 0x1D), (1, 1, 0x1D)]
F2 = [(0, 1, 0xC), (1, 1, 0xC), (0, 1, 0xD), (1, 1, 0xD), (0, 1, 0xE), (0, 1, 0xF), (1, 1, 0xF), (0, 0, 0x18), (1, 0, 0x18), (0, 1, 0x18),
      (0, 0, 0x19), (1, 0, 0x19), (0, 1, 0x19), (1, 1, 0x19), (1, 1, 0x1F)]
F2C = [(0, 0, 0x1A), (1, 0, 0x1A), (0, 1, 0x1A), (1, 1, 0x1A), (0, 0, 0x1B), (1, 0, 0x1B), (0, 1, 0x1B), (1, 1, 0x1B), (0, 0, 0x1C),
       (1, 0, 0x1C), (0, 0, 0x1D), (1, 0, 0x1D)]


def _pick(table, word, ushift, ashift):
    def gen(sz, scalar):
        def fn(rng, pc):
            U, a, opc = rng.choice(table)
            Q = 1 if (sz or scalar) else rng.getrandbits(1)
            w = word(opc) | (U << ushift) | (a << ashift) | (sz << 22) | (rng.randrange(32) << 16) | (rng.randrange(32) << 5) | rng.randrange(32)
            return Case([w | (0x50000000 if scalar else (Q << 30))])
        return fn
    return gen


_fp3 = _pick(FP3, lambda o: 0x0E200400 | (o << 11), 29, 23)
_fp3s = _pick(FP3S, lambda o: 0x0E200400 | (o << 11), 29, 23)


def _two(table):
    def gen(sz, scalar):
        def fn(rng, pc):
            U, hi, opc = rng.choice(table)
            Q = 1 if (sz or scalar) else rng.getrandbits(1)
            w = 0x0E200800 | (opc << 12) | (U << 29) | (hi << 23) | (sz << 22) | (rng.randrange(32) << 5) | rng.randrange(32)
            return Case([w | (0x50000000 if scalar else (Q << 30))])
        return fn
    return gen


for ty, fp, n in TY:
    S("simd_fp3_%s" % n, _fp3(ty, False), fp=fp)
    S("simd_fp3_scalar_%s" % n, _fp3s(ty, True), fp=fp)
    S("simd_fp2_%s" % n, _two(F2)(ty, False), fp=fp)
    S("simd_fp2_conv_%s" % n, _two(F2C)(ty, False), fp=fp)
    S("simd_fp2_conv_scalar_%s" % n, _two(F2C)(ty, True), fp=fp)
    S("simd_fp2_cmp0_scalar_%s" % n, _two(F2[:5])(ty, True), fp=fp)
    E("simd_fp_pair_scalar_%s" % n, "01 1 11110 hi:1 sz:1 11000 0 11 k:2 10 Rn:5 Rd:5", fix={"sz": ty, "k": [0, 1, 3]},
      filt=lambda f: not (f["k"] == 1 and f["hi"]), fp=fp)
    E("simd_fp_indexed_%s" % n, "0 Q:1 0 01111 1 sz:1 L:1 M:1 Rm:4 opc:2 01 H:1 0 Rn:5 Rd:5",
      fix={"sz": ty, "opc": [0, 1, 2], "L": (lambda r, f, pc, ty=ty: 0 if ty else f["L"]), "Q": (lambda r, f, pc, ty=ty: 1 if ty else f["Q"])}, fp=fp)
    E("simd_fp_indexed_scalar_%s" % n, "01 0 11111 1 sz:1 L:1 M:1 Rm:4 opc:2 01 H:1 0 Rn:5 Rd:5",
      fix={"sz": ty, "opc": [0, 1, 2], "L": (lambda r, f, pc, ty=ty: 0 if ty else f["L"])}, fp=fp)
    E("simd_fixed_conv_%s" % n, "0 Q:1 U:1 011110 immh:4 immb:3 111 k:1 k2:1 1 Rn:5 Rd:5",
      fix={"immh": (lambda r, f, pc, ty=ty: (8 | r.getrandbits(3)) if ty else (4 | r.getrandbits(2))),
           "k2": (lambda r, f, pc: f["k"]), "Q": (lambda r, f, pc, ty=ty: 1 if ty else f["Q"])}, fp=fp)
E("simd_fcvtl", "0 Q:1 0 01110 0 1 10000 10111 10 Rn:5 Rd:5", fp=(32, 64))
E("simd_fcvtn", "0 Q:1 0 01110 0 1 10000 10110 10 Rn:5 Rd:5", fp=(64, 32))
E("simd_int2", "0 Q:1 U:1 01110 size:2 10000 opcode:5 10 Rn:5 Rd:5", fix={"opcode": [0, 1, 2, 4, 5, 6, 8, 9, 10, 11, 0x12, 0x13, 0x14]})
E("simd_int2_scalar", "01 U:1 11110 11 10000 010 k:2 10 Rn:5 Rd:5")
E("simd_across", "0 Q:1 U:1 01110 size:2 11000 opcode:5 10 Rn:5 Rd:5", fix={"opcode": [0x1B, 0x03, 0x0A, 0x1A], "size": [0, 1, 2]})
E("simd_addp_scalar", "01 0 11110 11 11000 11011 10 Rn:5 Rd:5")
E("simd_shift_imm", "0 Q:1 U:1 011110 immh:4 immb:3 opcode:5 1 Rn:5 Rd:5", fix={"opcode": [0, 2, 4, 6, 8, 10, 0x10, 0x11, 0x12, 0x13, 0x14]},
  filt=lambda f: f["immh"] != 0)
E("simd_shift_imm_scalar", "01 U:1 111110 1 immh:3 immb:3 opcode:5 1 Rn:5 Rd:5", fix={"opcode": [0, 2, 4, 6, 8, 10]})
E("simd_3diff", "0 Q:1 U:1 01110 size:2 1 Rm:5 opcode:4 00 Rn:5 Rd:5", fix={"opcode": [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12], "size": [0, 1, 2]})
E("simd_int_indexed", "0 Q:1 U:1 01111 size:2 L:1 M:1 Rm:4 opcode:4 H:1 0 Rn:5 Rd:5", fix={"size": [1, 2], "opcode": [0, 2, 4, 6, 8, 10]},
  filt=lambda f: (f["U"], f["opcode"]) in ((0, 8), (1, 0), (1, 4), (0, 10), (1, 10), (0, 2), (1, 2), (0, 6), (1, 6)))
E("simd_tbl_tbx", "0 Q:1 0 01110 000 Rm:5 0 len:2 op:1 00 Rn:5 Rd:5",
  setup=lambda r, f, pre: pre.__setitem__("v%d" % f["Rm"], int.from_bytes(bytes(r.randrange(0, r.choice((16, 32, 48, 64, 80, 256))) for _ in range(16)), "little")))
E("simd_permute", "0 Q:1 0 01110 size:2 0 Rm:5 0 opcode:3 10 Rn:5 Rd:5", fix={"opcode": [1, 2, 3, 5, 6, 7]})
E("simd_ext", "0 Q:1 1 01110 00 0 Rm:5 0 imm4:4 0 Rn:5 Rd:5", filt=lambda f: f["Q"] or f["imm4"] < 8)
E("simd_ldst_multi", "0 Q:1 0011000 L:1 000000 opcode:4 size:2 Rn:5 Rt:5", fix={"opcode": [7, 10, 6, 2, 8, 4, 0]}, base="Rn")
E("simd_ldst_multi_post", "0 Q:1 0011001 L:1 0 Rm:5 opcode:4 size:2 Rn:5 Rt:5", fix={"opcode": [7, 10, 6, 2, 8, 4, 0]}, base="Rn",
  small=("Rm",), filt=lambda f: f["Rn"] != 31 or True)
E("simd_ldst_single", "0 Q:1 0011010 L:1 R:1 00000 opcode:3 S:1 size:2 Rn:5 Rt:5", base="Rn")
E("simd_ldst_single_post", "0 Q:1 0011011 L:1 R:1 Rm:5 opcode:3 S:1 size:2 Rn:5 Rt:5", base="Rn", small=("Rm",))

# ------------------------------------------------------------------------------ T4
E("simd_srshl_urshl", "0 Q:1 U:1 01110 size:2 1 Rm:5 01010 1 Rn:5 Rd:5")
E("simd_sqdmulh", "0 Q:1 U:1 01110 size:2 1 Rm:5 10110 1 Rn:5 Rd:5", fix={"size": [1, 2]})
E("simd_sqdmulh_scalar", "01 U:1 11110 size:2 1 Rm:5 10110 1 Rn:5 Rd:5", fix={"size": [1, 2]})
E("simd_sqdmulh_indexed", "0 Q:1 0 01111 size:2 L:1 M:1 Rm:4 110 r:1 H:1 0 Rn:5 Rd:5", fix={"size": [1, 2]})
E("simd_sqabs_sqneg", "0 Q:1 U:1 01110 size:2 10000 00111 10 Rn:5 Rd:5")
E("simd_sqabs_sqneg_scalar", "01 U:1 11110 size:2 10000 00111 10 Rn:5 Rd:5")
E("simd_qshl_imm", "0 Q:1 U:1 011110 immh:4 immb:3 011 k:1 0 1 Rn:5 Rd:5", filt=lambda f: f["immh"] != 0 and (f["k"] or f["U"]))
E("simd_qshl_imm_scalar", "01 U:1 111110 immh:4 immb:3 011 k:1 0 1 Rn:5 Rd:5", filt=lambda f: f["immh"] != 0 and (f["k"] or f["U"]))
for ty, fp, n in TY:
    E("simd_fmaxnm_fminnm_%s" % n, "0 Q:1 U:1 01110 a:1 sz:1 1 Rm:5 11000 1 Rn:5 Rd:5",
      fix={"sz": ty, "Q": (lambda r, f, pc, ty=ty: 1 if ty else f["Q"])}, fp=fp)
E("simd_fmaxv_fminv", "0 1 1 01110 a:1 0 11000 011 k:2 10 Rn:5 Rd:5", fix={"k": [0, 3]}, fp=32)
for ty, fp, n in TY:
    E("simd_fixed_conv_scalar_%s" % n, "01 U:1 111110 immh:4 immb:3 111 k:1 k2:1 1 Rn:5 Rd:5",
      fix={"immh": (lambda r, f, pc, ty=ty: (8 | r.getrandbits(3)) if ty else (4 | r.getrandbits(2))), "k2": (lambda r, f, pc: f["k"])}, fp=fp)

# ------------------------------------------------------------------------------ round 2
for ty, fp, n in TY:
    E("simd_frecpe_frsqrte_%s" % n, "0 Q:1 U:1 01110 1 sz:1 10000 11101 10 Rn:5 Rd:5", fix={"sz": ty, "Q": (lambda r, f, pc, ty=ty: 1 if ty else f["Q"])}, fp=fp)
    E("simd_frecpe_frsqrte_scalar_%s" % n, "01 U:1 11110 1 sz:1 10000 11101 10 Rn:5 Rd:5", fix={"sz": ty}, fp=fp)
    E("simd_frecpx_%s" % n, "01 0 11110 1 sz:1 10000 11111 10 Rn:5 Rd:5", fix={"sz": ty}, fp=fp)
    E("simd_frecps_frsqrts_%s" % n, "0 Q:1 0 01110 a:1 sz:1 1 Rm:5 11111 1 Rn:5 Rd:5", fix={"sz": ty, "Q": (lambda r, f, pc, ty=ty: 1 if ty else f["Q"])}, fp=fp)
    E("simd_frecps_frsqrts_scalar_%s" % n, "01 0 11110 a:1 sz:1 1 Rm:5 11111 1 Rn:5 Rd:5", fix={"sz": ty}, fp=fp)
    E("simd_fmulx_%s" % n, "0 Q:1 0 01110 0 sz:1 1 Rm:5 11011 1 Rn:5 Rd:5", fix={"sz": ty, "Q": (lambda r, f, pc, ty=ty: 1 if ty else f["Q"])}, fp=fp)
    E("simd_fmulx_scalar_%s" % n, "01 0 11110 0 sz:1 1 Rm:5 11011 1 Rn:5 Rd:5", fix={"sz": ty}, fp=fp)
E("simd_urecpe_ursqrte", "0 Q:1 U:1 01110 1 0 10000 11100 10 Rn:5 Rd:5")
E("simd_sqdmull", "0 Q:1 0 01110 size:2 1 Rm:5 1 k:2 1 00 Rn:5 Rd:5", fix={"size": [1, 2], "k": [0, 1, 2]})
E("simd_sqdmull_scalar", "01 0 11110 size:2 1 Rm:5 1 k:2 1 00 Rn:5 Rd:5", fix={"size": [1, 2], "k": [0, 1, 2]})
E("simd_sqdmull_indexed", "0 Q:1 0 01111 size:2 L:1 M:1 Rm:4 k:2 11 H:1 0 Rn:5 Rd:5", fix={"size": [1, 2], "k": [0, 1, 2]})
E("simd_sqdmull_indexed_scalar", "01 0 11111 size:2 L:1 M:1 Rm:4 k:2 11 H:1 0 Rn:5 Rd:5", fix={"size": [1, 2], "k": [0, 1, 2]})
E("simd_qshl_reg", "0 Q:1 U:1 01110 size:2 1 Rm:5 010 r:1 1 1 Rn:5 Rd:5")
E("simd_qshl_reg_scalar", "01 U:1 11110 size:2 1 Rm:5 010 r:1 1 1 Rn:5 Rd:5")
E("simd_suqadd_usqadd", "0 Q:1 U:1 01110 size:2 10000 00011 10 Rn:5 Rd:5")
E("simd_suqadd_usqadd_scalar", "01 U:1 11110 size:2 10000 00011 10 Rn:5 Rd:5")
E("simd_qxtn_scalar", "01 U:1 11110 size:2 10000 opcode:5 10 Rn:5 Rd:5", fix={"size": [0, 1, 2], "opcode": [0x12, 0x14]}, filt=lambda f: f["opcode"] == 0x14 or f["U"])
E("simd_qshrn_scalar", "01 U:1 111110 immh:4 immb:3 100 k:2 1 Rn:5 Rd:5", filt=lambda f: 0 < f["immh"] < 8 and (f["U"] or f["k"] >= 2))
E("simd_pmul", "0 Q:1 1 01110 00 1 Rm:5 10011 1 Rn:5 Rd:5")
E("simd_pmull", "0 Q:1 0 01110 size:2 1 Rm:5 1110 00 Rn:5 Rd:5", fix={"size": [0, 3]})
E("aes", "0100 1110 0010 100 001 k:2 10 Rn:5 Rd:5")
E("sha_3reg", "0101 1110 000 Rm:5 0 k:3 00 Rn:5 Rd:5", fix={"k": [0, 1, 2, 3, 4, 5, 6]})
E("sha_2reg", "0101 1110 0010 100 000 k:2 10 Rn:5 Rd:5", fix={"k": [0, 1, 2]})


def _half_vals(r, f, pre):
    v = 0
    for i in range(8):
        k = r.random()
        h = r.choice((0, 0x8000, 0x7C00, 0xFC00, 0x7E00, 0x7C01, 0xFE55, 1, 0x3FF, 0x400, 0x7BFF, 0x3C00, 0xBC00)) if k < 0.3 else r.getrandbits(16)
        v |= h << (16 * i)
    pre["v%d" % f["Rn"]] = v


E("fcvt_h_to_sd", "000 11110 11 1 00010 d:1 10000 Rn:5 Rd:5", setup=_half_vals)
E("fcvt_s_to_h", "000 11110 00 1 000111 10000 Rn:5 Rd:5", fp=(32, 0))
E("fcvt_d_to_h", "000 11110 01 1 000111 10000 Rn:5 Rd:5", fp=(64, 0))
E("simd_fcvtl_h", "0 Q:1 0 01110 0 0 10000 10111 10 Rn:5 Rd:5", setup=_half_vals)
E("simd_fcvtn_h", "0 Q:1 0 01110 0 0 10000 10110 10 Rn:5 Rd:5", fp=(32, 0))


def rmode_case(rng, pc):
    """FPCR.RMode-dependent operations with a random rounding mode."""
    ty = rng.getrandbits(1)
    rn, rd = rng.randrange(32), rng.randrange(32)
    k = rng.randrange(6)
    pre = {"fpcr": rng.randrange(4) << 22}
    base = 0x1E200000 | (ty << 22) | (rn << 5) | rd
    if k == 0:
        w = base | (rng.choice((14, 15)) << 15) | 0x4000                       # FRINTX / FRINTI
    elif k == 1:
        w = base | (rng.getrandbits(1) << 31) | (rng.choice((2, 3)) << 16)      # SCVTF / UCVTF
    elif k == 2:
        sf = rng.getrandbits(1)
        w = (base & ~0x200000) | (sf << 31) | (rng.choice((2, 3)) << 16) | (rng.randrange(32 if not sf else 0, 64) << 10)
    elif k == 3:
        w = 0x1E624000 | (rn << 5) | rd                                         # FCVT d -> s
        pre["v%d" % rn] = fuzz_lib.rnd_f64(rng)
    elif k == 4:
        w = 0x5E21D800 | (rng.getrandbits(1) << 29) | (ty << 22) | (rn << 5) | rd   # scalar SIMD SCVTF/UCVTF
    else:
        Q = 1 if ty else rng.getrandbits(1)
        w = rng.choice((0x2E219800, 0x2EA19800, 0x0E21D800, 0x2E21D800)) | (Q << 30) | (ty << 22) | (rn << 5) | rd  # FRINTX/FRINTI/SCVTF/UCVTF vectors
    return Case([w], pre)


S("fpcr_rmode", rmode_case)
