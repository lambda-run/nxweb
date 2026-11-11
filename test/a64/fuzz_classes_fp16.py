"""Instruction classes of half-precision floating point (FP16, ARMv8.2: a Switch 2 title's core has it). Reference:
Unicorn's "max" model. Results are compared bit for bit, NaNs included: the translator computes every FP16 lane in
the helper module, ARM's NaN rules and FPCR.RMode included."""
from fuzz_lib import Case, Enc, Seq
from fuzz_classes import CLASSES


def E(*a, **k):
    k.setdefault("cpu", "max")
    k.setdefault("fp", (16, 0))
    CLASSES.append(Enc(*a, **k))


def S(*a, **k):
    k.setdefault("cpu", "max")
    k.setdefault("fp", (16, 0))
    CLASSES.append(Seq(*a, **k))


def _rmode(r, f, pre):
    pre["fpcr"] = r.randrange(4) << 22


_INV = ((0x0000, 0x7C00), (0x8000, 0x7C00), (0x7C00, 0x0000), (0xFC00, 0x8000), (0x7C00, 0xFC00), (0xFC00, 0x7C00),
        (0x7C00, 0x7C00), (0xFC00, 0xFC00))


def _invalid(r, f, pre, regs=("Rn", "Rm")):
    """Lane pairs that make an invalid operation (0 x inf, inf - inf, inf + -inf) in a third of the cases."""
    if r.random() >= 0.35:
        return
    import fuzz_lib
    a, b = fuzz_lib.rnd_v(r, 16), fuzz_lib.rnd_v(r, 16)
    for i in range(8):
        if r.random() < 0.6:
            x, y = r.choice(_INV)
            a = (a & ~(0xFFFF << 16 * i)) | (x << 16 * i)
            b = (b & ~(0xFFFF << 16 * i)) | (y << 16 * i)
    pre["v%d" % f[regs[0]]] = a
    if f[regs[1]] != f[regs[0]]:
        pre["v%d" % f[regs[1]]] = b


def _invalid_rm(r, f, pre):
    _rmode(r, f, pre)
    _invalid(r, f, pre)


def _invalid_idx(r, f, pre):
    # by element: the Vm element is lane H:L:M of v0..v15; put the pair's second value in every lane
    if r.random() >= 0.35:
        return
    x, y = r.choice(_INV)
    pre["v%d" % f["Rn"]] = sum(x << 16 * i for i in range(8))
    if f["Rm"] != f["Rn"]:
        pre["v%d" % f["Rm"]] = sum(y << 16 * i for i in range(8))


# ------------------------------------------------------------------------------ scalar H
E("fp16_fp1", "000 11110 11 1 opcode:6 10000 Rn:5 Rd:5", fix={"opcode": [0, 1, 2, 3, 8, 9, 10, 11, 12, 14, 15]})
E("fp16_fp2", "000 11110 11 1 Rm:5 opcode:4 10 Rn:5 Rd:5", fix={"opcode": list(range(9))}, setup=_invalid)
E("fp16_fmadd", "000 11111 11 o1:1 Rm:5 o0:1 Ra:5 Rn:5 Rd:5", setup=_invalid)
E("fp16_fcmp", "000 11110 11 1 Rm:5 00 1000 Rn:5 op:2 000")
E("fp16_fccmp", "000 11110 11 1 Rm:5 cond:4 01 Rn:5 op:1 nzcv:4")
E("fp16_fcsel", "000 11110 11 1 Rm:5 cond:4 11 Rn:5 Rd:5")
E("fp16_fmov_imm", "000 11110 11 1 imm8:8 100 00000 Rd:5")
E("fp16_fcvt_to_int", "sf:1 00 11110 11 1 rmode:2 00 u:1 000000 Rn:5 Rd:5")
E("fp16_fcvta", "sf:1 00 11110 11 1 00 10 u:1 000000 Rn:5 Rd:5")
E("fp16_int_to_fp", "sf:1 00 11110 11 1 00 01 u:1 000000 Rn:5 Rd:5", fp=(0, 0))
E("fp16_scvtf_fixed", "sf:1 00 11110 11 0 00 01 u:1 scale:6 Rn:5 Rd:5", fp=(0, 0), filt=lambda f: f["sf"] or f["scale"] >= 32)
E("fp16_fcvtz_fixed", "sf:1 00 11110 11 0 11 00 u:1 scale:6 Rn:5 Rd:5", filt=lambda f: f["sf"] or f["scale"] >= 32)
E("fp16_fmov_general", "sf:1 00 11110 11 1 00 11 o:1 000000 Rn:5 Rd:5")
E("fp16_rmode_arith", "000 11110 11 1 Rm:5 opcode:4 10 Rn:5 Rd:5", fix={"opcode": [0, 1, 2, 3, 8]}, setup=_invalid_rm)
E("fp16_rmode_fmadd", "000 11111 11 o1:1 Rm:5 o0:1 Ra:5 Rn:5 Rd:5", setup=_rmode)
E("fp16_rmode_fp1", "000 11110 11 1 opcode:6 10000 Rn:5 Rd:5", fix={"opcode": [3, 14, 15]}, setup=_rmode)
E("fp16_rmode_int_to_fp", "sf:1 00 11110 11 u2:1 00 01 u:1 scale:6 Rn:5 Rd:5", fp=(0, 0), setup=_rmode,
  fix={"scale": lambda r, f, pc: 0 if f["u2"] else f["scale"]}, filt=lambda f: f["u2"] or f["sf"] or f["scale"] >= 32)

# ------------------------------------------------------------------------------ Advanced SIMD .4H / .8H and scalar H
_V3 = (0x00, 0x01, 0x02, 0x03, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0E, 0x0F, 0x10, 0x12, 0x13, 0x16, 0x17, 0x18, 0x1A, 0x1E)
_C3 = (0x04, 0x14, 0x15, 0x1C, 0x1D)
_S3 = (0x03, 0x07, 0x0F, 0x1A)
_key = lambda f: (f["U"] << 4) | (f["a"] << 3) | f["opc"]
E("simd_fp16_3same", "0 Q:1 U:1 01110 a:1 10 Rm:5 00 opc:3 1 Rn:5 Rd:5", filt=lambda f: _key(f) in _V3, setup=_invalid)
E("simd_fp16_3same_cmp", "0 Q:1 U:1 01110 a:1 10 Rm:5 00 opc:3 1 Rn:5 Rd:5", filt=lambda f: _key(f) in _C3)
E("simd_fp16_3same_scalar", "01 U:1 11110 a:1 10 Rm:5 00 opc:3 1 Rn:5 Rd:5", filt=lambda f: _key(f) in _S3 + _C3, setup=_invalid)
E("simd_fp16_3same_rmode", "0 Q:1 U:1 01110 a:1 10 Rm:5 00 opc:3 1 Rn:5 Rd:5", setup=_invalid_rm,
  filt=lambda f: _key(f) in (0x01, 0x02, 0x03, 0x07, 0x09, 0x0A, 0x0F, 0x12, 0x13, 0x17, 0x1A))
# (U, a, opcode)
_V2 = [(0, 0, 0x18), (0, 0, 0x19), (0, 0, 0x1A), (0, 0, 0x1B), (0, 0, 0x1C), (0, 1, 0x0C), (0, 1, 0x0D), (0, 1, 0x0E),
       (0, 1, 0x0F), (0, 1, 0x18), (0, 1, 0x19), (0, 1, 0x1A), (0, 1, 0x1B), (0, 1, 0x1D), (1, 0, 0x18), (1, 0, 0x19),
       (1, 0, 0x1A), (1, 0, 0x1B), (1, 0, 0x1C), (1, 1, 0x0C), (1, 1, 0x0D), (1, 1, 0x0F), (1, 1, 0x19), (1, 1, 0x1A),
       (1, 1, 0x1B), (1, 1, 0x1D), (1, 1, 0x1F)]
_S2 = [t for t in _V2 if t[2] in (0x1A, 0x1B, 0x1C, 0x1D) or (t[1] and t[2] in (0x0C, 0x0D, 0x0E))] + [(0, 1, 0x1F)]


def _two(table, scalar, rmode=False):
    def fn(rng, pc):
        U, a, opc = rng.choice(table)
        w = (0x5E780800 if scalar else 0x0E780800 | (rng.getrandbits(1) << 30)) | (U << 29) | (a << 23) | (opc << 12)
        return Case([w | (rng.randrange(32) << 5) | rng.randrange(32)], {"fpcr": rng.randrange(4) << 22} if rmode else {})
    return fn


S("simd_fp16_2reg", _two(_V2, False))
S("simd_fp16_2reg_scalar", _two(_S2, True))
S("simd_fp16_2reg_rmode", _two([(1, 0, 0x19), (1, 1, 0x19), (1, 1, 0x1F)], False, True))
S("simd_fp16_int_to_fp", _two([(0, 0, 0x1D), (1, 0, 0x1D)], False, True), fp=(0, 0))
S("simd_fp16_int_to_fp_scalar", _two([(0, 0, 0x1D), (1, 0, 0x1D)], True, True), fp=(0, 0))
E("simd_fp16_across", "0 Q:1 0 01110 a:1 0 11000 opc:5 10 Rn:5 Rd:5", fix={"opc": [12, 15]})
E("simd_fp16_pair_scalar", "01 0 11110 a:1 0 11000 opc:5 10 Rn:5 Rd:5", fix={"opc": [12, 13, 15]}, filt=lambda f: not (f["opc"] == 13 and f["a"]))
E("simd_fp16_indexed", "0 Q:1 U:1 01111 00 L:1 M:1 Rm:4 opc:4 H:1 0 Rn:5 Rd:5", fix={"opc": [1, 5, 9]}, filt=lambda f: not f["U"] or f["opc"] == 9, setup=_invalid_idx)
E("simd_fp16_indexed_scalar", "01 U:1 11111 00 L:1 M:1 Rm:4 opc:4 H:1 0 Rn:5 Rd:5", fix={"opc": [1, 5, 9]}, filt=lambda f: not f["U"] or f["opc"] == 9, setup=_invalid_idx)
E("simd_fp16_fixed_conv", "0 Q:1 U:1 011110 001 i:4 111 k:1 k2:1 1 Rn:5 Rd:5", fix={"k2": lambda r, f, pc: f["k"]})
def _h_only(c, st, post, mem0, mem1):
    # Unicorn 2.1 (QEMU 5.0) writes the scalar fixed-point FCVTZS / FCVTZU of a half as a 32-bit lane (sign-extended);
    # the architecture writes the 16-bit element and zeroes the rest of the register (V[d, esize] = result)
    rd = c.insns[0] & 31
    post["v"][rd] &= 0xFFFF


E("simd_fp16_fixed_conv_scalar", "01 U:1 111110 001 i:4 111 k:1 k2:1 1 Rn:5 Rd:5", fix={"k2": lambda r, f, pc: f["k"]}, post=_h_only)


# ------------------------------------------------------------------------------ FHM: FMLAL / FMLSL (half to single)
def _fhm_vals(r, f, pre):
    import fuzz_lib
    pre["v%d" % f["Rd"]] = fuzz_lib.rnd_v(r, 32)
    if r.random() < 0.3:
        pre["fpcr"] = r.randrange(4) << 22


E("simd_fhm", "0 Q:1 U:1 01110 S:1 0 1 Rm:5 1 1 b13:1 0 1 1 Rn:5 Rd:5", fix={"b13": lambda r, f, pc: f["U"] ^ 1}, setup=_fhm_vals)
E("simd_fhm_indexed", "0 Q:1 U:1 01111 1 0 L:1 M:1 Rm:4 o:1 S:1 0 0 H:1 0 Rn:5 Rd:5", fix={"o": lambda r, f, pc: f["U"]}, setup=_fhm_vals)
