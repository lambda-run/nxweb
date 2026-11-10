"""Instruction classes of the ARMv8.1+ extensions a Switch 2 title executes (Cortex-A78C class core): pointer
authentication, LSE atomics, RCPC, RDM, DotProd, FP16, FlagM. Reference: Unicorn's "max" CPU model.

Pointer authentication. The translator's contract is the identity (what a system with the keys disabled does).
Unicorn's model starts with SCTLR_EL1.EnIA/EnIB/EnDA/EnDB clear, so there PACIx/PACDx/AUTIx/AUTDx, the hint forms,
the authenticating branches, returns and loads are that identity too and are compared bit for bit. Two things do
not depend on the enable bits: XPACI/XPACD/XPACLRI always strip (compared on canonical pointers, the only ones an
identity signer ever produces) and PACGA always computes: Unicorn's model traps it (no EL3 to enable it), so the
reference runs a NOP in its place and the expected Xd is the translator's documented keyless function, computed
here; every other register, the flags and the pc still come from Unicorn."""
from fuzz_lib import WIN_MID, M64, Case, Enc, Seq
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


def _pacga_post(c, st, post):
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
