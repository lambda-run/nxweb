#!/usr/bin/env python3
"""A synthetic corpus for the in-page shader translator's latency (npm run shaders:latency): hand-assembled Maxwell stages of
tools/shaders/maxwell_asm.py's kind, each pixel stage the ps_ops body repeated 1..R times (GLSLC's real stages are far larger than
maxwell_asm.py's four; Zelda's arrive as up to ~8 KB of WGSL), every one a distinct key (its control section names it).
Usage: corpus.py <out dir> <stages> [max repeats]   writes <name>.code, <name>.ctl and corpus.json as maxwell_asm.py"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'tools' / 'shaders'))
import maxwell_asm as M

def main(out, n, rmax):
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    ops, vs = M.PROGRAMS['ps_ops'], M.PROGRAMS['vs_quad_ubo']
    body = ops['insts'][2:-4]                       # f2i .. fmax: reads R0, R1, writes R4..R16
    corpus = []
    for i in range(n):
        if i % 4 == 0: p, insts = vs, list(vs['insts'])
        else:
            r = 1 + (i * 7) % rmax
            p, insts = ops, ops['insts'][:2] + body * r + ops['insts'][-4:]
        name = f's{i:04d}'
        code = M.code_area(p['stage'], insts, p.get('imap', ()), p.get('omap', 0xf), p.get('kills', False))
        ctl = M.control(code, name.encode())
        (out / f'{name}.code').write_bytes(code); (out / f'{name}.ctl').write_bytes(ctl)
        corpus.append(dict(name=name, stage=p['stage'], key=M.key(ctl, code), code=f'{name}.code', control=f'{name}.ctl', insts=len(insts)))
    (out / 'corpus.json').write_text(json.dumps(corpus))

if __name__ == '__main__': main(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]) if len(sys.argv) > 3 else 12)
