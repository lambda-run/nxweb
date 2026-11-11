#!/usr/bin/env python3
"""Hand-built NVN2 (Switch 2) stages: Ampere code and an NVN2 control section, as nxnative's own translator tests build theirs
(dm/gfx/tests/test_dmsh_ampere_mem.py: EXIT; test_early_fragment_tests.py: the control section). Nothing here comes from a game or from
NVN2's compiler: each program is EXIT alone, so they prove that a stage gets through the chain (key, job, translator arch sm86, SPIR-V pass,
naga), not that Ampere code of a game translates.

Control section (0xd8 bytes, as Donkey Kong Bananza's BNSH files): magic 0x98761234, version 0xc9, sub-version 0x11 at +8, its length at +0x30
(which the key hashes as zero), +0x38 the instructions' length (SPH included), +0x40 that rounded up to 0x100, +0x44 the code area's length
(the c1 segment between the two), +0x56 the stage byte (5 compute), +0x58 compute's thread group, +0x5b early fragment tests, +0xa9..+0xba
compute's c0 layout. Graphics code starts with the 0x80-byte SPH version 4.

Usage: ampere_asm.py <out dir>     writes <name>.code, <name>.ctl, and corpus.json (name, stage, key, files), as maxwell_asm.py
"""
import hashlib, json, struct, sys
from pathlib import Path

def inst(hi, lo): return struct.pack('<QQ', lo, hi)
EXIT = inst(0x000fea0003800000, 0x000000000000794d)
# SPH version 4: word 0 = SPH type (1 VTG, 2 PS) | version 4 << 5 | shader type << 10 (1 vertex, 5 pixel). The pixel one is test_dmsh_ampere_mem.py's (writes colour 0);
# the vertex one writes the position (output map word 13 bits 4..7: attribute 0x70..0x7c)
SPH_PS = struct.pack('<32I', *([0x000c5482] + [0] * 4 + [0xb0000000] + [0] * 12 + [0xf] + [0] * 13))
SPH_VS = struct.pack('<32I', *([0x00000481] + [0] * 12 + [0xf0] + [0] * 18))

def ctl(stage, insts, area, early=0):
    c = bytearray(0xd8); struct.pack_into('<III', c, 0, 0x98761234, 0xc9, 0x11); struct.pack_into('<I', c, 0x30, len(c))
    struct.pack_into('<III', c, 0x38, insts, 0, (insts + 0xff) & ~0xff); struct.pack_into('<I', c, 0x44, area)
    if stage == 'cs':
        c[0x56] = 5; struct.pack_into('<3I', c, 0x58, 32, 1, 1)
        c[0xb3] = 3; struct.pack_into('<H', c, 0xba, 0x40)   # c0: 3 texture handles, 0x40 bytes (test_dmsh_ampere_mem.py's layout)
    if stage == 'ps': c[0x5b] = early
    return bytes(c)

def key(c, code): return hashlib.sha256(c[:0x30] + bytes(4) + c[0x34:0x48] + code).hexdigest()[:16]   # hle_nvn.c keys_hash, NVN2

PROGRAMS = {'cs_exit': ('cs', b''), 'ps_exit': ('ps', SPH_PS), 'vs_exit': ('vs', SPH_VS)}

def main(out):
    out = Path(out); out.mkdir(parents=True, exist_ok=True); corpus = []
    for name, (stage, sph) in PROGRAMS.items():
        body = sph + EXIT; rounded = (len(body) + 0xff) & ~0xff
        c1 = bytes(range(0x100)) if stage == 'vs' else b''   # vertex shaders carry a 0x100-byte c1 segment
        code = body + bytes(rounded - len(body)) + c1
        c = ctl(stage, len(body), len(code), early=1 if stage == 'ps' else 0)
        (out / f'{name}.code').write_bytes(code); (out / f'{name}.ctl').write_bytes(c)
        corpus.append(dict(name=name, stage=stage, key=key(c, code), code=f'{name}.code', control=f'{name}.ctl'))
    (out / 'corpus.json').write_text(json.dumps(corpus, indent=1))
    print(f'{len(corpus)} NVN2 programs in {out}')

if __name__ == '__main__':
    main(sys.argv[1])
