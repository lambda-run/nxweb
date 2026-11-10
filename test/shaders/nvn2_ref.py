#!/usr/bin/env python3
"""nxnative's own Python on the bytes run.mts makes: dmsh_build.py job_for (with dmsh_ampere, dmsh_meshstage) and shader_split.py skey / nvn2_stage, cut out of
$NXNATIVE as nxnative's tests do (dm/gfx/tests/test_early_fragment_tests.py), and nxweb's tools/shaders/xlate.py job_for. The answer table (FACTS) holds what
shader_split.py writes for a compute shader (thread group, shared memory); the per-game hooks (VertexA / B, transform feedback) are NVN1 only and absent.

Usage: nvn2_ref.py <cases.json> <work dir>   cases: [{key, stage, control: hex, code: hex}] -> stdout: [{skey, stage, nxnative: job | error, nxweb: job | error}], code as hex"""
import ast, hashlib, json, os, struct, sys
from pathlib import Path

TOOLS = Path(os.environ['NXNATIVE']) / 'dm/gfx/tools'
sys.path.insert(0, str(TOOLS)); import dmsh_ampere, dmsh_meshstage
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools/shaders')); import xlate

def cut(path, names, scope):
    tree = ast.parse(path.read_text())
    named = lambda t: isinstance(t, ast.Name) and t.id in names or isinstance(t, ast.Tuple) and any(named(e) for e in t.elts)
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names or isinstance(n, ast.Assign) and any(named(t) for t in n.targets)]
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), 'exec'), scope)
    return scope

FACTS = {}
build = cut(TOOLS / 'dmsh_build.py', {'early_fragment_tests', 'job_for'}, {'struct': struct, 'os': os, 'sys': sys, 'dmsh_ampere': dmsh_ampere, 'dmsh_meshstage': dmsh_meshstage,
            'FACTS': FACTS, 'tf_layout': lambda key, ctl: None, 'vertex_ab': lambda key, code, ctl: None})
split = cut(TOOLS / 'shader_split.py', {'CTL_MAGIC', 'NVN2_KEY_CTL', 'SPH_STAGE', 'sph_stage', 'nvn2_ctl', 'ctl_len', 'key_ctl', 'skey', 'nvn2_stage'}, {'struct': struct, 'hashlib': hashlib, 'KEY_SKIP': (0, 0)})

def run(f):
    try: return f()
    except (Exception, SystemExit) as e: return {'error': str(e)}

def nxnative(key, stage, ctl, code, w):
    if stage == 'cs':   # shader_split.py's answer-table row for a compute shader
        at = (0x58, 0x64) if split['nvn2_ctl'](ctl) else (0x748, 0x754)
        x, y, z = struct.unpack_from('<3I', ctl, at[0])
        if not x * y * z: raise ValueError(f'compute shader {key}: control +{at[0]:#x} thread group is 0')
        FACTS[key] = {'local': [x, y, z], 'shared': (struct.unpack_from('<I', ctl, at[1])[0] + 15) // 16 * 16}
    rec = bytearray(b'BTCDBTCD' + bytes.fromhex(key) + bytes(0x28)); struct.pack_into('<2I', rec, 0x28, len(ctl), len(code)); rec += code + ctl   # shader_split.py's record
    j, _ = build['job_for'](key, stage + '_x.bin', bytes(rec), str(w))
    j.pop('no_facts', None); j['code'] = Path(j['code']).read_bytes().hex()
    return j

def nxweb(key, stage, ctl, code, w):
    (w / f'{key}.code').write_bytes(code); (w / f'{key}.ctl').write_bytes(ctl)
    j = xlate.job_for(dict(key=key, stage=stage, code=f'{key}.code', control=f'{key}.ctl'), w, w)
    j['code'] = Path(j['code']).read_bytes().hex()
    return j

def main(cases, w):
    w = Path(w); w.mkdir(parents=True, exist_ok=True); out = []
    for c in json.loads(Path(cases).read_text()):
        ctl, code = bytes.fromhex(c['control']), bytes.fromhex(c['code'])
        stage = split['nvn2_stage'](ctl, code) if split['nvn2_ctl'](ctl) else c['stage']
        out.append(dict(skey=split['skey'](ctl, code), stage=stage,
                        nxnative=run(lambda: nxnative(c['key'], stage, ctl, code, w / 'a')) if stage else None, nxweb=run(lambda: nxweb(c['key'], stage, ctl, code, w / 'b')) if stage else None))
    print(json.dumps(out))

if __name__ == '__main__':
    (Path(sys.argv[2]) / 'a').mkdir(parents=True, exist_ok=True); (Path(sys.argv[2]) / 'b').mkdir(parents=True, exist_ok=True)
    main(sys.argv[1], sys.argv[2])
