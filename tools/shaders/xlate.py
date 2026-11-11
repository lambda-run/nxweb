#!/usr/bin/env python3
"""Maxwell code + control section -> SPIR-V, through nxnative's translator (dmsh_xlate: Ryujinx.Graphics.Shader with nxnative's driver).

What nxnative's dmsh_build.py job_for does for a graphics or compute stage, and nothing more. NVN (Switch 1, Maxwell): the code area's 0x30-byte
header is taken off (the translator reads the 0x50-byte program header itself), compute code keeps its instructions from +0x100 when it has a header,
the c1 segment is what lies between control +0x700 and +0x704, early fragment tests come from control +0x718. NVN2 (Switch 2, Ampere: control version
0xc9, dmsh_ampere.py): job arch sm86, the code cut to the instructions' length (control +0x38, the 0x80-byte SPH of graphics included), c1 between
control +0x40 and +0x44, compute's c0 layout (nvn2_cs) from +0xa9 / +0xb1..+0xb5 / +0xba, early fragment tests from +0x5b; task and mesh stages are
refused. The same as src/shaders/job.ts, which the page uses. Not done here (nxnative does them, see README.md): VertexA/B merging, transform feedback
layouts, task and mesh stages, geometry lowering, the answer table per game (a corpus row's "facts" stand in for it).

Usage: xlate.py <corpus.json> <out dir>
  corpus.json: [{ "name", "stage": "vs|ps|cs", "key", "code": file, "control": file, "facts": { "tex", "img", "attr", "fout", "local" } }]
  out: <key>.spv, <key>.res.json (the translator's reflection), xlate.json (the corpus rows that translated, with their outputs)
Environment: NXWEB_XLATE = the translator's command line (default: dotnet $NXNATIVE/dm/gfx/tools/dmsh_xlate_bin/dmsh_xlate.dll),
             NXNATIVE = the nxnative checkout (default /home/user/nxnative)
"""
import json, os, shlex, struct, subprocess, sys, tempfile, time
from pathlib import Path

NXNATIVE = os.environ.get('NXNATIVE', '/home/user/nxnative')
XLATE = shlex.split(os.environ.get('NXWEB_XLATE', f'dotnet {NXNATIVE}/dm/gfx/tools/dmsh_xlate_bin/dmsh_xlate.dll'))

def job_for(row, base, work):
    code = (base / row['code']).read_bytes(); ctl = (base / row['control']).read_bytes(); stage = row['stage']
    if struct.unpack_from('<I', ctl, 0)[0] != 0x98761234: raise ValueError(f"{row['key']}: no control section magic")
    if is_nvn2(ctl): return nvn2_job(row, code, ctl, stage, work)
    c1o, c1t = struct.unpack_from('<2I', ctl, 0x700)
    c1 = code[c1o:c1t]
    if stage != 'cs':
        if code[:4] != bytes.fromhex('78563412'): raise ValueError(f"{row['key']}: graphics code area without its header")
        code = code[0x30:]
    elif code[:4] == bytes.fromhex('79563412'):
        if any(code[0x30:0x100]): raise ValueError(f"{row['key']}: compute code area +0x30..+0x100 is not all zero")
        code = code[0x100:]
    cp = work / (row['key'] + '.bin'); cp.write_bytes(code)
    job = dict(key=row['key'], stage=stage, code=str(cp), tex={}, img={}, attr={}, fout={}, c1=c1.hex(), debug=True, reduced=True)   # nxnative's defaults (XLATE_DEBUG, XLATE_REDUCED); debug=False threw in the SPIR-V generator on a texel fetch here
    if stage == 'ps' and len(ctl) > 0x71c and struct.unpack_from('<I', ctl, 0x718)[0] & 1: job['early_fragment_tests'] = True
    job.update(row.get('facts') or {})
    return job

def is_nvn2(ctl): return len(ctl) >= 0x48 and struct.unpack_from('<II', ctl) == (0x98761234, 0xc9)   # dmsh_ampere.is_nvn2

def nvn2_job(row, code, ctl, stage, work):
    """dmsh_build.py job_for's NVN2 branch (dmsh_ampere.c1_segment, inst_len, early_fragment_tests)"""
    if stage in ('ts', 'ms'): raise ValueError(f"{row['key']}: an NVN2 task / mesh shader: WebGPU has no mesh pipeline")
    if stage not in ('vs', 'ps', 'cs'): raise ValueError(f"{row['key']}: an NVN2 {stage} shader (tessellation or geometry) is not translated")
    a, e = struct.unpack_from('<II', ctl, 0x40)
    c1 = code[a:e] if a <= e <= len(code) else b''
    code = code[:struct.unpack_from('<I', ctl, 0x38)[0]]
    cp = work / (row['key'] + '.bin'); cp.write_bytes(code)
    job = dict(key=row['key'], stage=stage, code=str(cp), tex={}, img={}, attr={}, fout={}, c1=c1.hex(), arch='sm86', debug=True, reduced=True)
    if stage == 'cs':
        job['nvn2_cs'] = [ctl[0xb1], ctl[0xb2], ctl[0xb3], struct.unpack_from('<H', ctl, 0xba)[0], ctl[0xa9] * 4, ctl[0xb4], ctl[0xb5]]
        x, y, z = struct.unpack_from('<3I', ctl, 0x58)   # thread group and shared memory as shader_split.py puts them in the answer table
        if not x * y * z: raise ValueError(f"{row['key']}: NVN2 compute thread group (control +0x58) is {x} x {y} x {z}")
        job.update(local=[x, y, z], shared=(struct.unpack_from('<I', ctl, 0x64)[0] + 15) // 16 * 16)
    if stage == 'ps' and len(ctl) > 0x5b and ctl[0x5b] and len(code) >= 0x50 and not struct.unpack_from('<I', code, 19 * 4)[0] & 2: job['early_fragment_tests'] = True
    job.update(row.get('facts') or {})
    return job

def main(corpus_path, out):
    base = Path(corpus_path).parent; out = Path(out); out.mkdir(parents=True, exist_ok=True)
    corpus = json.loads(Path(corpus_path).read_text())
    with tempfile.TemporaryDirectory(prefix='nxweb_xlate_') as d:
        work = Path(d)
        jobs = [job_for(r, base, work) for r in corpus]
        (work / 'jobs.json').write_text(json.dumps(jobs))
        t = time.time()
        r = subprocess.run(XLATE + [str(work / 'jobs.json'), str(out)], capture_output=True, text=True)
        dt = time.time() - t
    sys.stderr.write(r.stderr)
    done = []
    for row in corpus:
        if (out / (row['key'] + '.spv')).exists() and (out / (row['key'] + '.res.json')).exists():
            done.append(dict(name=row['name'], stage=row['stage'], key=row['key'], spv=row['key'] + '.spv', res=row['key'] + '.res.json'))
    (out / 'xlate.json').write_text(json.dumps(done, indent=1))
    print(f'{r.stdout.strip()} ({dt * 1000:.0f} ms for {len(jobs)} stages, process start included)')
    return r.returncode

if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2]))
