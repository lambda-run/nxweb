"""FPCR.RMode / FZ / DN variants of the FP classes (issue #16).

Every scalar and vector FP class is registered a second time as fpcr_<name>, run under a random FPCR with at least
one of RMode != RN, FZ, DN set, and with some operands replaced by values near the subnormal range (where FZ and
the directed modes differ from the default)."""
import copy
import re

import fuzz_classes
from fuzz_lib import Enc, Seq

FP_CLASSES = re.compile(r"^(fp1_|fp2_|fminnm_fmaxnm_|fmadd_|fcmp_|fccmp_|fcvt|int_to_fp_|scvtf_fixed_|simd_fp(?!16)|"
                        r"simd_fmaxnm|simd_fmaxv|simd_frec|simd_fmulx|simd_fcvt|simd_fixed_conv)")
# half precision (fuzz_classes_fp16.py): FZ16 (bit 19) too, and FMLAL/FMLSL, whose singles FZ flushes
FP16_CLASSES = re.compile(r"^(fp16_|simd_fp16_|simd_fhm)")


def rnd_fpcr(rng):
    while True:
        v = (rng.randrange(4) << 22) | (rng.getrandbits(1) << 24) | (rng.getrandbits(1) << 25)
        if v:
            return v


def tiny64(rng):
    k = rng.random()
    s = rng.getrandbits(1) << 63
    if k < 0.4:
        return s | rng.getrandbits(rng.randrange(1, 53))                                  # subnormal
    if k < 0.8:
        return s | (rng.randrange(1, 40) << 52) | rng.getrandbits(52)                     # just above
    return s | ((1023 + rng.choice((-511, -512, -513, 511, 512, 1023))) << 52) | rng.getrandbits(52)


def tiny32(rng):
    k = rng.random()
    s = rng.getrandbits(1) << 31
    if k < 0.4:
        return s | rng.getrandbits(rng.randrange(1, 24))
    if k < 0.8:
        return s | (rng.randrange(1, 20) << 23) | rng.getrandbits(23)
    return s | ((127 + rng.choice((-63, -64, -65, 63, 64, 127))) << 23) | rng.getrandbits(23)


def rnd_fpcr16(rng):
    while True:
        v = (rng.randrange(4) << 22) | (rng.getrandbits(1) << 19) | (rng.getrandbits(1) << 24) | (rng.getrandbits(1) << 25)
        if v:
            return v


def tiny16(rng):
    k = rng.random()
    s = rng.getrandbits(1) << 15
    if k < 0.4:
        return s | rng.randrange(1, 0x400)                                                # subnormal
    if k < 0.8:
        return s | (rng.randrange(1, 4) << 10) | rng.getrandbits(10)                      # just above
    return s | (rng.choice((28, 29, 30)) << 10) | rng.getrandbits(10)                     # near 2^14 (FRECPE's FZ16 limit)


def mix(rng, v, tiny, w):
    """v with about half of its w-bit lanes replaced by tiny values"""
    for i in range(128 // w):
        if rng.random() < 0.5:
            v = (v & ~(((1 << w) - 1) << (w * i))) | (tiny(rng) << (w * i))
    return v


def tiny_v(rng, fp):
    if fp == 64:
        return tiny64(rng) | (tiny64(rng) << 64)
    if fp == 32:
        return sum(tiny32(rng) << (32 * i) for i in range(4))
    return None


def _enc_variant(c):
    v = copy.copy(c)
    v.name = "fpcr_" + c.name
    inner = c.setup
    lane = c.fp[0]

    def setup(rng, f, pre):
        if inner:
            inner(rng, f, pre)
        pre["fpcr"] = rnd_fpcr(rng)
        for r in ("Rn", "Rm", "Ra"):
            if r in f and rng.random() < 0.35:
                t = tiny_v(rng, lane)
                if t is not None:
                    pre["v%d" % f[r]] = t
    v.setup = setup
    return v


def _seq_variant(c):
    v = copy.copy(c)
    v.name = "fpcr_" + c.name
    inner = c.fn

    def fn(rng, pc):
        case = inner(rng, pc)
        case.pre["fpcr"] = rnd_fpcr(rng)
        return case
    v.fn = fn
    return v


for _c in list(fuzz_classes.CLASSES):
    if FP_CLASSES.match(_c.name):
        fuzz_classes.CLASSES.append(_enc_variant(_c) if isinstance(_c, Enc) else _seq_variant(_c))


def _fp16_tiny(rng, pre, f, fhm):
    import fuzz_lib
    for r in ("Rn", "Rm", "Ra"):
        if r in f and rng.random() < 0.5:
            k = "v%d" % f[r]
            pre[k] = mix(rng, pre.get(k, fuzz_lib.rnd_v(rng, 16)), tiny16, 16)
    if fhm and rng.random() < 0.5:
        k = "v%d" % f["Rd"]
        pre[k] = mix(rng, pre.get(k, fuzz_lib.rnd_v(rng, 32)), tiny32, 32)


def _fp16_variant(c):
    v = copy.copy(c)
    v.name = "fpcr_" + c.name
    fhm = "fhm" in c.name
    if isinstance(c, Enc):
        inner = c.setup

        def setup(rng, f, pre):
            if inner:
                inner(rng, f, pre)
            pre["fpcr"] = rnd_fpcr16(rng)
            _fp16_tiny(rng, pre, f, fhm)
        v.setup = setup
    else:
        inner_fn = c.fn

        def fn(rng, pc):
            case = inner_fn(rng, pc)
            case.pre["fpcr"] = rnd_fpcr16(rng)
            w = case.insns[0]
            _fp16_tiny(rng, case.pre, {"Rn": (w >> 5) & 31, "Rm": (w >> 16) & 31}, False)
            return case
        v.fn = fn
    return v


for _c in list(fuzz_classes.CLASSES):
    if FP16_CLASSES.match(_c.name):
        fuzz_classes.CLASSES.append(_fp16_variant(_c))
