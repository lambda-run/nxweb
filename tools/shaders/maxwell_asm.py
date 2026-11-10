#!/usr/bin/env python3
"""Hand-assembled Maxwell (Tegra X1) shader programs: the only shader binaries this repository can hold.

Nothing here comes from a game or from Nintendo's compiler (GLSLC). Each program is written instruction by instruction from the public
encodings, the same way nxnative's translator tests build theirs (dm/gfx/tests/test_dmsh_maxwell_ftz.py, dm/tools/tests/test_txq_type.py),
and wrapped as a game ships a stage: a code area (0x30-byte header, magic 0x12345678, then the 0x50-byte shader program header and the
instructions) and a 0x880-byte control section (magic 0x98761234, code length at +0x704). They follow the instruction idioms GLSLC is
documented to use (IPA of 1/w, MUFU.RCP, IPA.MUL; fragment colour left in R0..R3), but GLSLC's real output is far larger and uses many
more instructions, so these prove the plumbing of the chain, not its coverage.

Usage: maxwell_asm.py <out dir>     writes <name>.code, <name>.ctl, and corpus.json (name, stage, key, files, facts for the translator)
The encodings are those of Ryujinx's decoder (Decoders/InstTable.cs, InstDecoders.cs in the vendored copy in nxnative).
"""
import hashlib, json, struct, sys
from pathlib import Path

PT, RZ = 7, 255                     # the always-true predicate, the zero register
TOP = lambda bits: int(bits, 2) << (64 - len(bits))   # an opcode's fixed top bits
OP = dict(ald=TOP('1110111111011'), ast=TOP('1110111111110'), ldc=TOP('1110111110010'), fmul=TOP('0101110001101'), fadd=TOP('0101110001011'),
          ffma=TOP('010110011'), mov32i=TOP('000000010000'), ipa=TOP('11100000'), tex=TOP('11000'), kil=TOP('111000110011'), exit=TOP('111000110000'),
          fsetp=TOP('010110111011'), mufu=TOP('0101000010000'), lop=TOP('0101110001000'), shl=TOP('0101110001001'), shr=TOP('0101110000101'),
          popc=TOP('0101110000001'), f2i=TOP('0101110010110'), i2f=TOP('0101110010111'), iadd=TOP('0101110000010'), fmnmx=TOP('0101110001100'),
          tld=TOP('11011100'), txq=TOP('1101111101001'), lop32i=TOP('000001'))

def f32(x): return struct.unpack('<I', struct.pack('<f', x))[0]
def g(pred=PT): return pred << 16
def ald(rd, attr, words=1): return OP['ald'] | (words - 1) << 47 | RZ << 39 | attr << 20 | g() | RZ << 8 | rd                 # ALD Rd.., a[attr]
def ast(attr, rs, words=1): return OP['ast'] | (words - 1) << 47 | RZ << 39 | attr << 20 | g() | RZ << 8 | rs                 # AST a[attr], Rs..
def ldc(rd, bank, off): return OP['ldc'] | 4 << 48 | bank << 36 | off << 20 | g() | RZ << 8 | rd                              # LDC.32 Rd, c[bank][off]
def rrr(op, rd, ra, rb, extra=0): return OP[op] | extra | rb << 20 | g() | ra << 8 | rd
def fmul(rd, ra, rb): return rrr('fmul', rd, ra, rb)
def fadd(rd, ra, rb): return rrr('fadd', rd, ra, rb)
def ffma(rd, ra, rb, rc): return OP['ffma'] | rc << 39 | rb << 20 | g() | ra << 8 | rd                                        # Rd = Ra * Rb + Rc
def fmax(rd, ra, rb): return rrr('fmnmx', rd, ra, rb, PT << 39 | 1 << 42)                                                      # FMNMX with predicate !PT: max
def mov32i(rd, imm): return OP['mov32i'] | (imm & 0xffffffff) << 20 | g() | 15 << 12 | rd
def ipa(rd, attr, mul=None): return OP['ipa'] | (1 if mul is not None else 0) << 54 | RZ << 39 | attr << 28 | (RZ if mul is None else mul) << 20 | g() | RZ << 8 | rd
def mufu(rd, ra, fn): return OP['mufu'] | fn << 20 | g() | ra << 8 | rd                                                       # fn: 0 cos, 1 sin, 4 rcp, 5 rsq, 8 sqrt
def tex(rd, ra, handle, dim=2, mask=15): return OP['tex'] | handle << 36 | mask << 31 | dim << 28 | RZ << 20 | g() | ra << 8 | rd   # TEX Rd.., coordinates in Ra.., c[2] word `handle`
def tld(rd, ra, handle, dim=2, mask=15): return OP['tld'] | handle << 36 | mask << 31 | dim << 28 | RZ << 20 | g() | ra << 8 | rd   # TLD: texel fetch, level 0
def txq(rd, ra, handle, mask=3): return OP['txq'] | handle << 36 | mask << 31 | 1 << 22 | g() | ra << 8 | rd                  # TXQ dimensions, level in Ra
def fsetp(pd, ra, rb, cmp): return OP['fsetp'] | cmp << 48 | PT << 39 | rb << 20 | g() | ra << 8 | pd << 3 | PT               # P<pd> = Ra <cmp> Rb (1 lt, 4 gt, 2 eq)
def kil(pred): return OP['kil'] | g(pred) | 15                                                                                # discard when P<pred>
def lop(rd, ra, rb, fn): return rrr('lop', rd, ra, rb, fn << 41 | PT << 48)                                                   # fn: 0 and, 1 or, 2 xor
def lop32i(rd, ra, imm, fn): return OP['lop32i'] | fn << 53 | (imm & 0xffffffff) << 20 | g() | ra << 8 | rd
def shl(rd, ra, rb): return rrr('shl', rd, ra, rb)
def shr(rd, ra, rb): return rrr('shr', rd, ra, rb)                                                                             # logical: bit 48 clear
def popc(rd, rb): return OP['popc'] | rb << 20 | g() | rd
def iadd(rd, ra, rb): return rrr('iadd', rd, ra, rb)
def f2i(rd, rb): return OP['f2i'] | rb << 20 | g() | 1 << 12 | 2 << 10 | 2 << 8 | 3 << 39 | rd                                # float32 -> signed int32, toward zero
def i2f(rd, rb, signed=True): return OP['i2f'] | rb << 20 | g() | (1 if signed else 0) << 13 | 2 << 10 | 2 << 8 | rd          # int32 -> float32
EXIT = OP['exit'] | g() | 15

HANDLE = lambda slot: (0x20 + 8 * slot) // 4   # the c[2] word of combined texture slot `slot` (nxnative dmsh_abi.h DMSH_C2_TEX)

def code_area(stage, insts, imap=(), omap=0xf, kills=False):
    """0x30-byte header, the shader program header, then scheduling word + three instructions per group"""
    sph = [0] * 20
    if stage == 'vs': sph[0] = 0x0461                                         # type 1 (vertex / tessellation / geometry), version 3, stage 1
    else:
        sph[0] = 0x1462 | (0x8000 if kills else 0)                            # type 2 (pixel), version 3, stage 5; bit 15: kills pixels
        for i, m in enumerate(imap): sph[6 + (i >> 2)] |= m << ((i & 3) * 8)  # generic input i: 2 bits a component (2 = perspective)
        sph[18] = omap                                                        # colour target components written (R0.. in order)
    words = []
    insts = list(insts) + [EXIT]
    for i, inst in enumerate(insts):
        if i % 3 == 0: words.append(0)
        words.append(inst)
    while len(words) % 4: words.append(TOP('0101000010110') | g() | 0xf00)   # NOP to the end of the group
    head = struct.pack('<I', 0x12345678) + bytes(0x2c)
    return head + struct.pack('<20I', *sph) + struct.pack('<%dQ' % len(words), *words)

def control(code, tag):
    c = bytearray(0x880)
    struct.pack_into('<I', c, 0, 0x98761234)
    struct.pack_into('<I', c, 0x20, 0x880)                                    # its own length
    struct.pack_into('<2I', c, 0x700, len(code), len(code))                   # c1 offset, code length: no c1 segment
    c[0x780:0x780 + len(tag)] = tag                                           # GLSLC's compile information lives here; ours names the program
    return bytes(c)

def key(ctl, code):   # src/gfx/shader.ts shaderKey, nxnative hle_nvn.c keys_hash
    return hashlib.sha256(ctl[:0x880] + code).digest()[:8].hex()

PROGRAMS = {}
# Vertex: position.xy (attribute 0) scaled and offset by uniform slot 0 (c[3]: scale.xy, offset.xy, then z), uv (attribute 1) passed on in generic output 0
PROGRAMS['vs_quad_ubo'] = dict(stage='vs', facts=dict(attr={'0': 'float', '1': 'float'}), insts=[
    ald(0, 0x80, 2), ald(2, 0x90, 2),
    ldc(4, 3, 0x00), ldc(5, 3, 0x04), ldc(6, 3, 0x08), ldc(7, 3, 0x0c), ldc(8, 3, 0x10),
    ffma(0, 0, 4, 6), ffma(1, 1, 5, 7), mov32i(9, f32(1.0)),
    ast(0x70, 0), ast(0x74, 1), ast(0x78, 8), ast(0x7c, 9),
    ast(0x80, 2), ast(0x84, 3)])
# Pixel: texture slot 0 sampled at generic input 0, times the colour in uniform slot 0 (c[3]); discarded where the result's alpha is below c[3][0x10]
PROGRAMS['ps_tex_tint'] = dict(stage='ps', imap=[0x0a], kills=True, facts=dict(tex={'0': '2d'}, fout={'0': 'float'}), insts=[
    ipa(4, 0x7c), mufu(4, 4, 4), ipa(0, 0x80, 4), ipa(1, 0x84, 4),
    tex(0, 0, HANDLE(0)),
    ldc(5, 3, 0x00), ldc(6, 3, 0x04), ldc(7, 3, 0x08), ldc(8, 3, 0x0c), ldc(9, 3, 0x10),
    fmul(0, 0, 5), fmul(1, 1, 6), fmul(2, 2, 7), fmul(3, 3, 8),
    fsetp(0, 3, 9, 1), kil(0)])
# Pixel: what the first two leave out. gl_FragCoord (IPA of a[0x70], a[0x74]), a size query, a texel fetch at integer coordinates, float <-> int,
# shifts, logic operations, population count, sine and square root, a maximum. Its colour means nothing; it exists to be translated
PROGRAMS['ps_ops'] = dict(stage='ps', imap=[0x0a], facts=dict(tex={'1': '2d'}, fout={'0': 'float'}), insts=[
    ipa(0, 0x70), ipa(1, 0x74),
    f2i(4, 0), f2i(5, 1),
    mov32i(6, 0), txq(8, 6, HANDLE(1)),                # R8, R9 = size of texture slot 1
    lop32i(4, 4, 3, 0), lop32i(5, 5, 3, 0),            # & 3
    tld(10, 4, HANDLE(1)),                             # R10..R13 = texel (R4, R5)
    mov32i(6, 3), shl(14, 4, 6), shr(15, 14, 6), lop(14, 14, 15, 2), popc(14, 14), iadd(14, 14, 8), i2f(14, 14),
    mufu(15, 0, 1), mufu(16, 1, 8), fmax(15, 15, 16),
    fadd(0, 10, 14), fadd(1, 11, 15), fmul(2, 12, 15), mov32i(3, f32(1.0))])

def main(out):
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    corpus = []
    for name, p in PROGRAMS.items():
        code = code_area(p['stage'], p['insts'], p.get('imap', ()), p.get('omap', 0xf), p.get('kills', False))
        ctl = control(code, name.encode())
        (out / f'{name}.code').write_bytes(code); (out / f'{name}.ctl').write_bytes(ctl)
        corpus.append(dict(name=name, stage=p['stage'], key=key(ctl, code), code=f'{name}.code', control=f'{name}.ctl', facts=p['facts']))
    (out / 'corpus.json').write_text(json.dumps(corpus, indent=1))
    for c in corpus: print(c['key'], c['stage'], c['name'])

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'build/shaders/maxwell')
