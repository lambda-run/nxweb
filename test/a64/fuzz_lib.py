"""Differential fuzz support for the nxweb a64 translator: encoding DSL, random state,
Unicorn execution of single instructions (or short sequences), case file writer."""
import os
import random
import struct

from unicorn import UC_ERR_FETCH_UNMAPPED, UC_ARCH_ARM64, UC_MODE_ARM, UC_PROT_ALL, Uc, UcError
from unicorn import arm64_const as A

# A64_FUZZ_UP moves the code and the memory window up by that much (fuzz.py --hi: 0x1_8000_0000, above 4 GB, for the
# translator's memory64 mode: every base register, pc-relative address and branch target is then a 33-bit value)
UP = int(os.environ.get("A64_FUZZ_UP", "0"), 0)
CODE_BASE = 0x100000 + UP
SLOT = 16                 # bytes of code per case (up to 4 instructions)
WIN_BASE = 0x200000 + UP
WIN_SIZE = 0x1000
WIN_MID = WIN_BASE + 0x800
CTX_SIZE = 0x330
NCASES = 2000
M64 = (1 << 64) - 1
M32 = (1 << 32) - 1

XREGS = [getattr(A, "UC_ARM64_REG_X%d" % i) for i in range(29)] + [A.UC_ARM64_REG_X29, A.UC_ARM64_REG_X30]
VREGS = [getattr(A, "UC_ARM64_REG_V%d" % i) for i in range(32)]
ALLREGS = XREGS + [A.UC_ARM64_REG_SP, A.UC_ARM64_REG_PC, A.UC_ARM64_REG_NZCV, A.UC_ARM64_REG_FPCR,
                   A.UC_ARM64_REG_FPSR, A.UC_ARM64_REG_TPIDR_EL0, A.UC_ARM64_REG_TPIDRRO_EL0] + VREGS

SPECIAL64 = [0, 1, 2, 3, M64, M64 - 1, 1 << 63, (1 << 63) - 1, (1 << 63) + 1, 1 << 31, (1 << 31) - 1, M32, 1 << 32,
             0xFFFFFFFF80000000, 0xFFFFFFFF7FFFFFFF, 0xFFFFFFFF00000000, 0x5555555555555555, 0xAAAAAAAAAAAAAAAA,
             0x00FF00FF00FF00FF, 0x8000000080000000, 0x7FFFFFFF7FFFFFFF, 0xFFFF, 0xFF, 0x80, 0x8000, 0x10000]


def rnd_x(rng):
    k = rng.random()
    if k < 0.40:
        return rng.getrandbits(64)
    if k < 0.58:
        return rng.choice(SPECIAL64)
    if k < 0.70:
        return rng.getrandbits(32)
    if k < 0.80:
        return rng.randrange(-256, 256) & M64
    if k < 0.90:
        return rng.getrandbits(rng.randrange(1, 65))
    return (rng.getrandbits(32) | 0xFFFFFFFF00000000) if rng.random() < 0.5 else (-rng.getrandbits(rng.randrange(1, 64))) & M64


def f64bits(x):
    return struct.unpack("<Q", struct.pack("<d", x))[0]


def f32bits(x):
    try:
        return struct.unpack("<I", struct.pack("<f", x))[0]
    except OverflowError:
        return 0x7F800000 if x > 0 else 0xFF800000


F64_SPECIAL = [0, 1 << 63, 0x7FF0000000000000, 0xFFF0000000000000, 0x7FF8000000000000, 0xFFF8000000000000,
               0x7FF0000000000001, 0xFFF4000000000000, 0x7FF8000000001234, 1, 0x000FFFFFFFFFFFFF, 0x0010000000000000,
               0x7FEFFFFFFFFFFFFF, 0xFFEFFFFFFFFFFFFF, 0x8000000000000001] + [f64bits(v) for v in (
                   1.0, -1.0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 3.5, 0.49999999999999994, -0.49999999999999994, 0.25, 0.75, -0.75,
                   2147483647.0, 2147483648.0, -2147483648.0, -2147483649.0, 2147483647.5, -2147483648.5,
                   4294967295.0, 4294967296.0, 4294967295.5, 9223372036854775808.0, -9223372036854775808.0,
                   18446744073709551616.0, 9007199254740992.0, 9007199254740993.0, 4503599627370496.0, 4503599627370497.0,
                   4503599627370495.5, 1e300, -1e300, 1e-300, 3.4028234663852886e38, 3.5e38, 1.401298464324817e-45, 1e-46)]
F32_SPECIAL = [0, 1 << 31, 0x7F800000, 0xFF800000, 0x7FC00000, 0xFFC00000, 0x7F800001, 0xFFA00000, 0x7FC01234, 1,
               0x007FFFFF, 0x00800000, 0x7F7FFFFF, 0xFF7FFFFF, 0x80000001] + [f32bits(v) for v in (
                   1.0, -1.0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 3.5, 0.49999997, -0.49999997, 0.25, 0.75, -0.75,
                   2147483648.0, -2147483648.0, 2147483520.0, 4294967296.0, 4294967040.0, 9223372036854775808.0,
                   -9223372036854775808.0, 18446744073709551616.0, 16777216.0, 16777217.0, 8388608.0, 8388609.0, 8388607.5,
                   1e30, -1e30, 1e-30)]


def rnd_f64(rng):
    k = rng.random()
    if k < 0.22:
        return rng.choice(F64_SPECIAL)
    if k < 0.50:
        v = float(rng.randrange(-(1 << rng.randrange(1, 70)), 1 << rng.randrange(1, 70)))
        v += rng.choice((0, 0, 0.5, 0.25, 0.75, rng.random()))
        return f64bits(v)
    if k < 0.80:
        return (rng.getrandbits(1) << 63) | ((1023 + rng.randrange(-40, 70)) << 52) | rng.getrandbits(52)
    return rng.getrandbits(64)


def rnd_f32(rng):
    k = rng.random()
    if k < 0.22:
        return rng.choice(F32_SPECIAL)
    if k < 0.50:
        v = float(rng.randrange(-(1 << rng.randrange(1, 40)), 1 << rng.randrange(1, 40)))
        v += rng.choice((0, 0, 0.5, 0.25, 0.75, rng.random()))
        return f32bits(v)
    if k < 0.80:
        return (rng.getrandbits(1) << 31) | ((127 + rng.randrange(-30, 40)) << 23) | rng.getrandbits(23)
    return rng.getrandbits(32)


def rnd_v(rng, fp):
    if fp == 64:
        return rnd_f64(rng) | (rnd_f64(rng) << 64)
    if fp == 32:
        return rnd_f32(rng) | (rnd_f32(rng) << 32) | (rnd_f32(rng) << 64) | (rnd_f32(rng) << 96)
    k = rng.random()
    if k < 0.45:
        return rng.getrandbits(128)
    esz = rng.choice((8, 16, 32, 64))
    v = 0
    for i in range(128 // esz):
        j = rng.random()
        if j < 0.3:
            e = rng.choice((0, 1, (1 << esz) - 1, 1 << (esz - 1), (1 << (esz - 1)) - 1, (1 << (esz - 1)) + 1, 2, (1 << esz) - 2))
        elif j < 0.6:
            e = rng.randrange(-70, 70) & ((1 << esz) - 1)
        else:
            e = rng.getrandbits(esz)
        v |= e << (i * esz)
    return v


class Case:
    __slots__ = ("insns", "pre", "ref")

    def __init__(self, insns, pre=None, ref=None):
        self.insns = insns if isinstance(insns, (list, tuple)) else [insns]
        self.pre = pre or {}
        self.ref = ref      # what Unicorn runs in place of insns (same length), for a class with a `post` that completes the result


def parse_pattern(pat):
    out = []
    for tok in pat.split():
        if ":" in tok:
            name, w = tok.split(":")
            out.append((name, int(w), None))
        else:
            out.append((None, len(tok), int(tok, 2)))
    assert sum(w for _, w, _ in out) == 32, (pat, sum(w for _, w, _ in out))
    return out


class Enc:
    """One instruction class described by a bit pattern.
    fix:   {field: value | [choices] | callable(rng, fields, pc)}
    filt:  callable(fields) -> bool
    base:  field naming the base register (pointed into the memory window)
    small: fields naming registers that get small values (index registers)
    setup: callable(rng, fields, pre) to adjust the initial state
    fp:    (input lane type, output lane type) for NaN-tolerant compare: 0, 16, 32 or 64
    cpu:   "a57" (the default: the first Switch's core) or "max" (Unicorn's model with every extension; the classes
           of the ARMv8.1+ instructions a Switch 2 title uses)
    post:  callable(case, pre_state, post_state, mem_before, mem_after) -> None or the corrected memory window:
           adjust what Unicorn answered where the translator's contract differs on purpose (PACGA: the documented
           keyless function) or where this Unicorn is wrong (LDSMAX / LDSMIN below 64 bits)
    """

    def __init__(self, name, pat, fix=None, filt=None, base=None, small=(), setup=None, fp=(0, 0), weight=1.0, cpu="a57", post=None):
        self.cpu = cpu
        self.post = post
        self.name = name
        self.pat = parse_pattern(pat)
        self.fix = fix or {}
        self.filt = filt
        self.base = base
        self.small = small
        self.setup = setup
        self.fp = fp if isinstance(fp, tuple) else (fp, fp)
        self.weight = weight

    def gen(self, rng, pc):
        for _ in range(200):
            f = {}
            for name, w, lit in self.pat:
                if name is not None:
                    f[name] = rng.getrandbits(w)
            for k, v in self.fix.items():
                if callable(v):
                    f[k] = v(rng, f, pc)
                elif isinstance(v, (list, tuple, range)):
                    f[k] = rng.choice(v)
                else:
                    f[k] = v
            if self.filt and not self.filt(f):
                continue
            word = 0
            for name, w, lit in self.pat:
                val = lit if name is None else f[name]
                word = (word << w) | (val & ((1 << w) - 1))
            pre = {}
            if self.base:
                r = f[self.base]
                if any(f[s] == r for s in self.small):
                    continue
                pre["sp" if r == 31 else "x%d" % r] = WIN_MID + 16 * rng.randrange(-8, 9)
            for s in self.small:
                if f[s] != 31:
                    pre["x%d" % f[s]] = rng.randrange(-60, 61) & M64
            if self.setup:
                self.setup(rng, f, pre)
            return Case([word], pre)
        raise RuntimeError("cannot generate " + self.name)


class Seq:
    """A class generated by a custom function(rng, pc) -> Case."""

    def __init__(self, name, fn, fp=(0, 0), cpu="a57", post=None):
        self.cpu = cpu
        self.post = post
        self.name = name
        self.fn = fn
        self.fp = fp if isinstance(fp, tuple) else (fp, fp)

    def gen(self, rng, pc):
        return self.fn(rng, pc)


def pack_ctx(st):
    """st: dict with x (31 ints), sp, pc, nzcv (4 bits), fpcr, fpsr, tpidr, tpidrro, v (32 ints)"""
    out = bytearray(CTX_SIZE)
    struct.pack_into("<31Q", out, 0, *st["x"])
    struct.pack_into("<QQIII", out, 0xF8, st["sp"], st["pc"], st["nzcv"], st["fpcr"], st["fpsr"])
    struct.pack_into("<QQ", out, 0x118, st["tpidr"], st["tpidrro"])
    for i, v in enumerate(st["v"]):
        out[0x130 + 16 * i:0x140 + 16 * i] = v.to_bytes(16, "little")
    return out


def random_state(rng, fp_in, pc, pre):
    st = {
        "x": [rnd_x(rng) for _ in range(31)],
        "sp": (rnd_x(rng) & ~0xF) & M64,
        "pc": pc,
        "nzcv": rng.getrandbits(4),
        "fpcr": 0,
        "fpsr": 0,
        "tpidr": rng.getrandbits(64),
        "tpidrro": rng.getrandbits(64),
        "v": [rnd_v(rng, fp_in) for _ in range(32)],
    }
    for k, v in pre.items():
        if k[0] == "x":
            st["x"][int(k[1:])] = v & M64
        elif k[0] == "v":
            st["v"][int(k[1:])] = v
        else:
            st[k] = v
    return st


class Runner:
    def __init__(self, ncases, cpu="a57"):
        self.uc = uc = Uc(UC_ARCH_ARM64, UC_MODE_ARM)
        try:
            from unicorn.arm64_const import UC_CPU_ARM64_A57, UC_CPU_ARM64_MAX
            uc.ctl_set_cpu_model(UC_CPU_ARM64_MAX if cpu == "max" else UC_CPU_ARM64_A57)
        except Exception:
            if cpu == "max":
                raise
        self.code_size = (ncases * SLOT + 0xFFF) & ~0xFFF
        uc.mem_map(CODE_BASE, self.code_size, UC_PROT_ALL)
        uc.mem_map(WIN_BASE, WIN_SIZE, UC_PROT_ALL)
        uc.reg_write(A.UC_ARM64_REG_CPACR_EL1, 0x300000)

    def run(self, st, n, win_init):
        uc = self.uc
        uc.mem_write(WIN_BASE, win_init)
        vals = st["x"] + [st["sp"], st["pc"], st["nzcv"] << 28, st["fpcr"], st["fpsr"], st["tpidr"], st["tpidrro"]] + st["v"]
        for r, v in zip(ALLREGS, vals):
            uc.reg_write(r, v)
        try:
            uc.emu_start(st["pc"], 0, count=n)
        except UcError as e:
            # a single branch to an unmapped target has still executed completely
            if not (n == 1 and e.errno == UC_ERR_FETCH_UNMAPPED):
                return None
        o = [uc.reg_read(r) for r in ALLREGS]
        post = {"x": o[0:31], "sp": o[31], "pc": o[32], "nzcv": (o[33] >> 28) & 15, "fpcr": o[34], "fpsr": o[35],
                "tpidr": o[36], "tpidrro": o[37], "v": o[38:70]}
        mem = bytes(uc.mem_read(WIN_BASE, WIN_SIZE))
        return post, mem


def generate_class(cls, ncases, seed, path):
    """Generate `ncases` cases for one class and write the case file. Returns (generated, rejected)."""
    rng = random.Random("%s/%d" % (cls.name, seed))
    runner = Runner(ncases, getattr(cls, "cpu", "a57"))
    win_init = bytes(rng.getrandbits(8) for _ in range(WIN_SIZE))
    cases = []
    rejected = 0
    tries = 0
    # all code is laid out before anything runs (literal loads read it)
    code = bytearray(ncases * SLOT)
    ucode = bytearray(ncases * SLOT)      # the same, with a case's `ref` words where it has them
    for i in range(ncases):
        pc = CODE_BASE + i * SLOT
        c = cls.gen(rng, pc)
        cases.append(c)
        struct.pack_into("<%dI" % len(c.insns), code, i * SLOT, *c.insns)
        struct.pack_into("<%dI" % len(c.insns), ucode, i * SLOT, *(c.ref or c.insns))
    runner.uc.mem_write(CODE_BASE, bytes(ucode))
    records = []
    for i in range(ncases):
        pc = CODE_BASE + i * SLOT
        c = cases[i]
        while True:
            st = random_state(rng, cls.fp[0], pc, c.pre)
            res = runner.run(st, len(c.insns), win_init)
            if res is not None:
                break
            rejected += 1
            tries += 1
            if tries > ncases * 20 + 1000:
                raise RuntimeError("class %s: Unicorn rejects too many encodings (last %s)" % (cls.name, ["%08x" % w for w in c.insns]))
            c = cls.gen(rng, pc)
            cases[i] = c
            code[i * SLOT:(i + 1) * SLOT] = bytes(SLOT)
            ucode[i * SLOT:(i + 1) * SLOT] = bytes(SLOT)
            struct.pack_into("<%dI" % len(c.insns), code, i * SLOT, *c.insns)
            struct.pack_into("<%dI" % len(c.insns), ucode, i * SLOT, *(c.ref or c.insns))
            runner.uc.mem_write(pc, bytes(ucode[i * SLOT:(i + 1) * SLOT]))
            runner.uc.ctl_remove_cache(pc, pc + SLOT)
        records.append((c, st, res))
    # literal loads may have read a slot that was regenerated later: re-run everything once on the final code
    final = []
    for i, (c, st, res) in enumerate(records):
        res2 = runner.run(st, len(c.insns), win_init)
        if res2 is None:
            raise RuntimeError("class %s: unstable case" % cls.name)
        if getattr(cls, "post", None):
            m2 = cls.post(c, st, res2[0], win_init, res2[1])
            if m2 is not None:
                res2 = (res2[0], bytes(m2))
        final.append((c, st, res2))
    with open(path, "wb") as f:
        name = cls.name.encode()
        name += b"\0" * (-len(name) % 4)
        f.write(struct.pack("<4sIIIII", b"A64F", 1, ncases, cls.fp[1], len(name), WIN_SIZE))
        f.write(name)
        f.write(code)
        f.write(win_init)
        for c, st, (post, mem) in final:
            diffs = [] if mem == win_init else [(o, mem[o]) for o in range(WIN_SIZE) if mem[o] != win_init[o]]
            f.write(struct.pack("<II", len(c.insns), len(diffs)))
            f.write(pack_ctx(st))
            f.write(pack_ctx(post))
            for o, v in diffs:
                f.write(struct.pack("<HBB", o, v, 0))
    return ncases, rejected
