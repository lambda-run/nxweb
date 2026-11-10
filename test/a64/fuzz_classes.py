"""Instruction classes for the a64 differential fuzz (Gate 1)."""
import fuzz_lib
from fuzz_lib import CODE_BASE, SLOT, WIN_MID, M64, Case, Enc, Seq

CLASSES = []


def E(*a, **k):
    CLASSES.append(Enc(*a, **k))


def S(*a, **k):
    CLASSES.append(Seq(*a, **k))


# ------------------------------------------------------------------------------ T1: data processing
E("adr_adrp", "op:1 immlo:2 10000 immhi:19 Rd:5")
E("addsub_imm", "sf:1 op:1 S:1 100010 sh:1 imm12:12 Rn:5 Rd:5")
def _logimm_ok(f):
    v = (f["N"] << 6) | (~f["imms"] & 0x3F)
    ln = v.bit_length() - 1
    return ln >= 1 and (f["imms"] & ((1 << ln) - 1)) != (1 << ln) - 1


E("logical_imm", "sf:1 opc:2 100100 N:1 immr:6 imms:6 Rn:5 Rd:5", fix={"N": lambda r, f, pc: f["N"] & f["sf"]}, filt=_logimm_ok)
E("movwide", "sf:1 opc:2 100101 hw:2 imm16:16 Rd:5", fix={"opc": [0, 2, 3]}, filt=lambda f: f["sf"] or f["hw"] < 2)
E("bitfield", "sf:1 opc:2 100110 N:1 immr:6 imms:6 Rn:5 Rd:5", fix={"opc": [0, 1, 2], "N": lambda r, f, pc: f["sf"]},
  filt=lambda f: f["sf"] or (f["immr"] < 32 and f["imms"] < 32))
E("extr", "sf:1 00 100111 N:1 0 Rm:5 imms:6 Rn:5 Rd:5", fix={"N": lambda r, f, pc: f["sf"]},
  filt=lambda f: f["sf"] or f["imms"] < 32)
E("logical_sreg", "sf:1 opc:2 01010 shift:2 N:1 Rm:5 imm6:6 Rn:5 Rd:5", filt=lambda f: f["sf"] or f["imm6"] < 32)
E("addsub_sreg", "sf:1 op:1 S:1 01011 shift:2 0 Rm:5 imm6:6 Rn:5 Rd:5", fix={"shift": [0, 1, 2]},
  filt=lambda f: f["sf"] or f["imm6"] < 32)
E("addsub_ext", "sf:1 op:1 S:1 01011 00 1 Rm:5 option:3 imm3:3 Rn:5 Rd:5", fix={"imm3": [0, 1, 2, 3, 4]})
E("adc_sbc", "sf:1 op:1 S:1 11010000 Rm:5 000000 Rn:5 Rd:5")
E("ccmp_ccmn", "sf:1 op:1 1 11010010 Rm:5 cond:4 imm:1 0 Rn:5 0 nzcv:4")
E("csel", "sf:1 op:1 0 11010100 Rm:5 cond:4 0 o2:1 Rn:5 Rd:5")
E("cset_csetm", "sf:1 op:1 0 11010100 11111 cond:4 0 o2:1 11111 Rd:5", filt=lambda f: f["op"] != f["o2"])
E("shift_var", "sf:1 0 0 11010110 Rm:5 0010 op:2 Rn:5 Rd:5")
E("div", "sf:1 0 0 11010110 Rm:5 00001 o:1 Rn:5 Rd:5")
E("crc32", "sf:1 0 0 11010110 Rm:5 010 C:1 sz:2 Rn:5 Rd:5", fix={"sf": lambda r, f, pc: 1 if f["sz"] == 3 else 0})
E("dp1_rbit_rev_clz_cls", "sf:1 1 0 11010110 00000 000 opcode:3 Rn:5 Rd:5", fix={"opcode": [0, 1, 2, 3, 4, 5]},
  filt=lambda f: f["sf"] or f["opcode"] != 3)
E("madd_msub", "sf:1 00 11011 000 Rm:5 o0:1 Ra:5 Rn:5 Rd:5")
E("maddl_msubl", "1 00 11011 U:1 01 Rm:5 o0:1 Ra:5 Rn:5 Rd:5")
E("mulh", "1 00 11011 U:1 10 Rm:5 0 11111 Rn:5 Rd:5")

# ------------------------------------------------------------------------------ T1: branches
E("b_bl", "op:1 00101 imm26:26")
E("b_cond", "01010100 imm19:19 0 cond:4")
E("cbz_cbnz", "sf:1 011010 op:1 imm19:19 Rt:5")
E("tbz_tbnz", "b5:1 011011 op:1 b40:5 imm14:14 Rt:5")
E("br_blr_ret", "1101011 0 0 op:2 11111 000000 Rn:5 00000", fix={"op": [0, 1, 2]})


def b_self(rng, pc):
    # branches whose target is the instruction itself or its neighbours
    k = rng.randrange(4)
    off = rng.choice((0, 1, 2, 0x3FFFFFF))
    if k == 0:
        return Case([0x14000000 | off])
    if k == 1:
        return Case([0x54000000 | ((off & 0x7FFFF) << 5) | rng.randrange(16)])
    if k == 2:
        return Case([0x34000000 | (rng.getrandbits(1) << 31) | (rng.getrandbits(1) << 24) | ((off & 0x7FFFF) << 5) | rng.randrange(32)])
    return Case([0x36000000 | (rng.getrandbits(1) << 31) | (rng.getrandbits(1) << 24) | (rng.randrange(32) << 19) | ((off & 0x3FFF) << 5) | rng.randrange(32)])


S("branch_near", b_self)

# ------------------------------------------------------------------------------ T1: system
FPCR_MASK = 0x07C00000
FPSR_MASK = 0xF800009F


def sys_case(rng, pc):
    rt = rng.randrange(31)
    k = rng.randrange(12)
    pre = {}
    regs = {"tpidr": 0xDE82, "tpidrro": 0xDE83, "fpcr": 0xDA20, "fpsr": 0xDA21, "nzcv": 0xDA10}
    if k < 5:
        name = list(regs)[k]
        L = rng.getrandbits(1)
        if name == "tpidrro":
            L = 1
        if name == "fpcr":
            pre["fpcr"] = rng.getrandbits(32) & FPCR_MASK
            pre["x%d" % rt] = rng.getrandbits(32) & FPCR_MASK
        if name == "fpsr":
            pre["fpsr"] = rng.getrandbits(32) & FPSR_MASK
            pre["x%d" % rt] = rng.getrandbits(32) & FPSR_MASK
        return Case([0xD5100000 | (L << 21) | (regs[name] << 5) & 0xFFFE0 | rt], pre)
    if k == 5:
        return Case([0xD53B0000 | (rng.choice((0x00E0, 0x0020)) & 0xFFE0) | rt])  # DCZID, CTR (CNTFRQ is deliberately 19200000 here, Unicorn says 62500000)
    if k == 6:
        return Case([0xD503201F | (rng.randrange(128) << 5)])      # hints
    if k == 7:
        return Case([0xD503301F | (rng.randrange(16) << 8) | (rng.choice((2, 4, 5, 6)) << 5)])
    if k == 8:
        pre["x%d" % rt] = WIN_MID + rng.randrange(-0x400, 0x400)
        return Case([0xD50B7420 | rt], pre)                         # DC ZVA
    if k == 9:
        pre["x%d" % rt] = WIN_MID + rng.randrange(-0x400, 0x400)
        return Case([rng.choice((0xD50B7B20, 0xD50B7520, 0xD50B7A20, 0xD50B7E20)) | rt], pre)
    return Case([0xD503201F])


S("system", sys_case)

# ------------------------------------------------------------------------------ T1: loads / stores
_wb_ok = lambda f: f["mode"] == 0 or f["Rt"] != f["Rn"]
E("ldst_uimm", "size:2 111001 opc:2 imm12:12 Rn:5 Rt:5", fix={"imm12": range(64)}, base="Rn",
  filt=lambda f: not (f["opc"] == 3 and f["size"] >= 2) and (f["opc"] == 0 or f["Rt"] != 99))
E("ldst_imm9", "size:2 111000 opc:2 0 imm9:9 mode:2 Rn:5 Rt:5", fix={"mode": [0, 1, 3]}, base="Rn",
  filt=lambda f: not (f["opc"] == 3 and f["size"] >= 2) and _wb_ok(f) and not (f["size"] == 3 and f["opc"] == 2 and f["mode"]))
E("ldst_regoff", "size:2 111000 opc:2 1 Rm:5 option:3 S:1 10 Rn:5 Rt:5", fix={"option": [2, 3, 6, 7]}, base="Rn",
  small=("Rm",), filt=lambda f: not (f["opc"] == 3 and f["size"] >= 2) and f["Rm"] != 31)
E("ldst_pair", "opc:2 101 0 0 type:2 L:1 imm7:7 Rt2:5 Rn:5 Rt:5", fix={"opc": [0, 1, 2]}, base="Rn",
  filt=lambda f: not (f["opc"] == 1 and not f["L"]) and not (f["type"] in (1, 3) and f["Rn"] in (f["Rt"], f["Rt2"]))
  and not (f["L"] and f["Rt"] == f["Rt2"]))


def lit_case(rng, pc):
    opc = rng.randrange(4)
    tgt = CODE_BASE + rng.randrange(0, min(fuzz_lib.NCASES, 4096) * SLOT // 4) * 4
    imm = ((tgt - pc) >> 2) & 0x7FFFF
    return Case([(opc << 30) | 0x18000000 | (imm << 5) | rng.randrange(32)])


S("ldr_literal", lit_case)


def excl_case(rng, pc):
    size = rng.randrange(4)
    rn = rng.choice([r for r in range(32) if r != 30])
    pre = {("sp" if rn == 31 else "x%d" % rn): WIN_MID + 16 * rng.randrange(-8, 9)}
    regs = [r for r in range(31) if r != rn]
    rt, rt2, rs, rx = rng.sample(regs, 4)
    o0 = rng.getrandbits(1)
    if rng.random() < 0.15:   # LDAR / STLR
        return Case([(size << 30) | 0x08800000 | (rng.getrandbits(1) << 22) | (0x1F << 16) | (1 << 15) | (0x1F << 10) | (rn << 5) | rt], pre)
    pair = rng.random() < 0.3
    if pair:
        size = rng.choice((2, 3))

    def ld():
        return (size << 30) | 0x08400000 | (pair << 21) | (0x1F << 16) | (o0 << 15) | ((rt2 if pair else 31) << 10) | (rn << 5) | rt

    def st(rsrc=None):
        return (size << 30) | 0x08000000 | (pair << 21) | (rs << 16) | (o0 << 15) | ((rt2 if pair else 31) << 10) | (rn << 5) | (rsrc if rsrc is not None else rt)

    c = _excl_seq(rng, ld, st, size, rn, rt, rx)
    return Case([0xD503305F] + c, pre)   # CLREX first: Unicorn keeps its monitor between runs


def _excl_seq(rng, ld, st, size, rn, rt, rx):
    k = rng.randrange(8)
    if k == 0:
        return [ld()]
    if k == 1:
        return [st()]
    if k == 2:
        return [ld(), ld()]
    if k in (3, 4):
        return [ld(), st(rx)]
    if k == 5:   # intervening plain store of a (probably) different value
        return [ld(), 0x38000000 | (size << 30) | (rn << 5) | rx | (1 << 24), st()]
    if k == 6:   # monitor cleared
        return [ld(), 0xD503305F, st(rx)]
    # typical atomic add: ldxr; add; stxr
    return [ld(), 0x91000400 | (rt << 5) | rt, st()]


S("exclusive", excl_case)

# ---------------------------------------------------------------------------------------------- later tiers
try:
    import fuzz_classes_fp  # noqa: F401  (registers T2..T4 classes)
except ImportError:
    pass
import fuzz_classes_v8x  # noqa: E402,F401  (ARMv8.1+: what a Switch 2 title adds; Unicorn's "max" model)
