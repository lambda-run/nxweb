"""Instruction classes of the ARMv8.1+ extensions a Switch 2 title executes (Cortex-A78C class core): pointer
authentication, LSE atomics, RCPC, RDM, DotProd, FP16, FlagM. Reference: Unicorn's "max" CPU model.

Pointer authentication. The translator's contract is the identity (what a system with the keys disabled does).
Unicorn's model starts with SCTLR_EL1.EnIA/EnIB/EnDA/EnDB clear, so there PACIx/PACDx/AUTIx/AUTDx, the hint forms,
the authenticating branches, returns and loads are that identity too and are compared bit for bit. Two things do
not depend on the enable bits: XPACI/XPACD/XPACLRI always strip (compared on canonical pointers, the only ones an
identity signer ever produces) and PACGA always computes: Unicorn's model traps it (no EL3 to enable it), so the
reference runs a NOP in its place and the expected Xd is the translator's documented keyless function, computed
here; every other register, the flags and the pc still come from Unicorn."""
from fuzz_lib import WIN_BASE, WIN_MID, M64, Case, Enc, Seq
import fuzz_classes
from fuzz_classes import CLASSES


def E(*a, **k):
    k.setdefault("cpu", "max")
    CLASSES.append(Enc(*a, **k))


def S(*a, **k):
    k.setdefault("cpu", "max")
    CLASSES.append(Seq(*a, **k))


def _canon(rng):
    k = rng.randrange(4)
    if k == 0:
        return WIN_MID + rng.randrange(-0x400, 0x400)
    if k == 1:
        return rng.getrandbits(rng.randrange(1, 40))
    if k == 2:
        return (-rng.getrandbits(rng.randrange(1, 40))) & M64
    return 0


# ------------------------------------------------------------------------------ pointer authentication
E("pac_sign_auth", "1 1 0 11010110 00001 000 op:3 Rn:5 Rd:5")                 # PACIA PACIB PACDA PACDB AUTIA AUTIB AUTDA AUTDB
E("pac_sign_auth_z", "1 1 0 11010110 00001 001 op:3 11111 Rd:5")              # ...ZA ...ZB forms
E("pac_xpac", "1 1 0 11010110 00001 01000 D:1 11111 Rd:5",
  setup=lambda r, f, pre: pre.__setitem__("x%d" % f["Rd"], _canon(r)) if f["Rd"] != 31 else None)


def _pacga(x, y):
    y = ((y << 32) | (y >> 32)) & M64
    return ((((x ^ y) * 0x9E3779B97F4A7C15) & M64) >> 32) << 32


def _pacga_post(c, st, post, mem0, mem1):
    w = c.insns[0]
    rd, rn, rm = w & 31, (w >> 5) & 31, (w >> 16) & 31
    if rd != 31:
        post["x"][rd] = _pacga(0 if rn == 31 else st["x"][rn], st["sp"] if rm == 31 else st["x"][rm])


def pacga_case(rng, pc):
    return Case([0x9AC03000 | (rng.randrange(32) << 16) | (rng.randrange(32) << 5) | rng.randrange(32)], ref=[0xD503201F])


S("pac_pacga", pacga_case, post=_pacga_post)


def pac_hint(rng, pc):
    # PACIA1716 PACIB1716 AUTIA1716 AUTIB1716, PACIAZ PACIASP PACIBZ PACIBSP AUTIAZ AUTIASP AUTIBZ AUTIBSP, XPACLRI
    w = rng.choice((0xD503211F, 0xD503215F, 0xD503219F, 0xD50321DF, 0xD503231F, 0xD503233F, 0xD503235F, 0xD503237F,
                    0xD503239F, 0xD50323BF, 0xD50323DF, 0xD50323FF, 0xD50320FF))
    return Case([w], {"x30": _canon(rng)} if w == 0xD50320FF else {})


S("pac_hints", pac_hint)
# BRAAZ BRABZ BLRAAZ BLRABZ RETAA RETAB (Z = 0, Rm = 31) and BRAA BRAB BLRAA BLRAB (Z = 1, modifier Xm|SP)
E("pac_branch", "1101011 Z:1 0 op:2 11111 0000 1 M:1 Rn:5 Rm:5", fix={"op": [0, 1, 2, 0, 1]},
  filt=lambda f: (f["Z"] == 1 or f["Rm"] == 31) and (f["op"] != 2 or (f["Z"] == 0 and f["Rn"] == 31)))
E("pac_ldraa", "11 111 0 00 M:1 S:1 1 imm9:9 W:1 1 Rn:5 Rt:5", base="Rn",
  fix={"imm9": lambda r, f, pc: r.randrange(0, 230) if f["S"] == 0 else r.randrange(282, 512)},
  filt=lambda f: not (f["W"] and f["Rn"] == f["Rt"]))


# ------------------------------------------------------------------------------ LSE atomics, RCPC
# Every base is 16-byte aligned and every offset a multiple of 8, so the same cases run with --shared (wasm atomic
# instructions trap on a misaligned address).
def _base(rng, rn):
    return {("sp" if rn == 31 else "x%d" % rn): WIN_MID + 16 * rng.randrange(-8, 9)}


def cas_case(rng, pc):
    size, L, o0 = rng.randrange(4), rng.getrandbits(1), rng.getrandbits(1)
    rn = rng.choice([r for r in range(32) if r != 30])
    regs = [r for r in range(32) if r != rn]
    rs, rt = rng.choice(regs), rng.choice(regs)
    cas = (size << 30) | 0x08A07C00 | (L << 22) | (rs << 16) | (o0 << 15) | (rn << 5) | rt
    if rng.random() < 0.5 and rs != 31:      # the compare value is what memory holds: the exchange happens
        return Case([(size << 30) | 0x39400000 | (rn << 5) | rs, cas], _base(rng, rn))
    return Case([cas], _base(rng, rn))


def casp_case(rng, pc):
    sz, L, o0 = rng.getrandbits(1), rng.getrandbits(1), rng.getrandbits(1)
    rs, rt = rng.sample(range(0, 32, 2), 2) if rng.random() < 0.9 else [rng.randrange(0, 32, 2)] * 2
    rn = rng.choice([r for r in range(32) if r not in (30, rs, rs + 1)])
    casp = (sz << 30) | 0x08207C00 | (L << 22) | (rs << 16) | (o0 << 15) | (rn << 5) | rt
    k = rng.randrange(4)
    ldp = (0xA9400000 if sz else 0x29400000) | (((rs + 1) & 31) << 10) | (rn << 5) | rs
    if k == 0:
        return Case([casp], _base(rng, rn))
    if k == 1:                               # both words equal
        return Case([ldp, casp], _base(rng, rn))
    # one word equal, the other not: flip a bit of Rs or of Rs+1 (eor with the logical immediate #1)
    r = rs if k == 2 else rs + 1
    if r == 31:
        return Case([ldp, casp], _base(rng, rn))
    return Case([ldp, 0xD2400000 | (r << 5) | r, casp], _base(rng, rn))


S("lse_cas", cas_case)
S("lse_casp", casp_case)
def _smaxmin_post(c, st, post, mem0, mem1):
    # Unicorn 2.1 (QEMU 5.0) compares LDSMAX / LDSMIN of 8, 16 and 32 bits wrongly: the zero-extended memory value
    # against the whole 64-bit register, as signed 64-bit numbers (fixed in later QEMU). The architecture compares the
    # two values as signed numbers of the access size (MemAtomicOp_SMAX: SInt(data) > SInt(value)); for those cases
    # the expected memory is computed here. Xt (the value read) and everything else stay Unicorn's.
    w = c.insns[0]
    size, opc, rs, rn = w >> 30, (w >> 12) & 7, (w >> 16) & 31, (w >> 5) & 31
    if opc not in (4, 5) or size == 3:
        return None
    n, bits = 1 << size, 8 << size
    addr = (st["sp"] if rn == 31 else st["x"][rn]) - WIN_BASE
    sx = lambda v: (v & ((1 << bits) - 1)) - ((v >> (bits - 1) & 1) << bits)
    old = sx(int.from_bytes(mem0[addr:addr + n], "little"))
    val = sx(0 if rs == 31 else st["x"][rs])
    new = max(old, val) if opc == 4 else min(old, val)
    m = bytearray(mem0)
    m[addr:addr + n] = (new & ((1 << bits) - 1)).to_bytes(n, "little")
    return m


E("lse_ldop", "size:2 111000 A:1 R:1 1 Rs:5 0 opc:3 00 Rn:5 Rt:5", base="Rn", post=_smaxmin_post)   # LDADD LDCLR LDEOR LDSET LDSMAX LDSMIN LDUMAX LDUMIN (Rt = 31: ST*)
E("lse_swp", "size:2 111000 A:1 R:1 1 Rs:5 1 000 00 Rn:5 Rt:5", base="Rn")
E("rcpc_ldapr", "size:2 111000 1 0 1 11111 1 100 00 Rn:5 Rt:5", base="Rn")
E("rcpc2_ldapur_stlur", "size:2 011001 opc:2 0 imm9:9 00 Rn:5 Rt:5", base="Rn",
  fix={"imm9": [0, 8, 16, 24, 32, 64, 120, 512 - 8, 512 - 16, 512 - 64, 512 - 128]},
  filt=lambda f: not (f["opc"] == 2 and f["size"] == 3) and not (f["opc"] == 3 and f["size"] >= 2))


# ------------------------------------------------------------------------------ SHA-512, SHA-3, SM3, SM4 (ARMv8.2)
E("sha512_3reg", "1100 1110 011 Rm:5 1 0 00 k:2 Rn:5 Rd:5")                     # SHA512H SHA512H2 SHA512SU1 RAX1
E("sha512su0_sm4e", "1100 1110 1100 0000 1000 k:2 Rn:5 Rd:5", fix={"k": [0, 1]})  # SHA512SU0 SM4E
E("sm3partw_sm4ekey", "1100 1110 011 Rm:5 1 1 00 k:2 Rn:5 Rd:5", fix={"k": [0, 1, 2]})  # SM3PARTW1 SM3PARTW2 SM4EKEY
E("sha3_4reg", "1100 1110 0 k:2 Rm:5 0 Ra:5 Rn:5 Rd:5", fix={"k": [0, 1, 2]})   # EOR3 BCAX SM3SS1
E("sha3_xar", "1100 1110 100 Rm:5 imm6:6 Rn:5 Rd:5")                           # XAR
E("sm3tt", "1100 1110 010 Rm:5 10 imm2:2 k:2 Rn:5 Rd:5")                        # SM3TT1A SM3TT1B SM3TT2A SM3TT2B


# ------------------------------------------------------------------------------ FJCVTZS (ARMv8.3)
def _jscvt(r, f, pre):
    import struct
    k = r.randrange(8)
    if k == 0:
        x = float(r.randrange(-2 ** 31, 2 ** 31))                                 # exact
    elif k == 1:
        x = float(r.choice((2 ** 31 - 1, -2 ** 31, 2 ** 31, -2 ** 31 - 1, 2 ** 32, 0))) * r.choice((1, -1))
    elif k == 2:
        x = r.randrange(-2 ** 40, 2 ** 40) / r.choice((2, 4, 1024, 3))            # inexact / fractional
    elif k == 3:
        x = float(r.getrandbits(r.randrange(32, 90))) * r.choice((1, -1))        # modulo 2^32
    elif k == 4:
        x = r.choice((float("inf"), float("-inf"), float("nan"), -0.0, 5e-324, -5e-324, 2.2e-308, 1e300, -1e300))
    else:
        bits = r.getrandbits(64)
        if k == 5:
            bits = (bits & ~(0x7FF << 52)) | ((1023 + r.randrange(-4, 90)) << 52)
        pre["v%d" % f["Rn"]] = bits
        return
    pre["v%d" % f["Rn"]] = struct.unpack("<Q", struct.pack("<d", x))[0] | (r.getrandbits(64) << 64)


E("fjcvtzs", "0001 1110 0111 1110 0000 00 Rn:5 Rd:5", setup=_jscvt)
