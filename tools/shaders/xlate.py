#!/usr/bin/env python3
"""Maxwell code + control section -> SPIR-V, through nxnative's translator (dmsh_xlate: Ryujinx.Graphics.Shader with nxnative's driver).

What nxnative's dmsh_build.py job_for does for a graphics or compute stage, and nothing more. NVN (Switch 1, Maxwell): the code area's 0x30-byte
header is taken off (the translator reads the 0x50-byte program header itself), compute code keeps its instructions from +0x100 when it has a header,
the c1 segment is what lies between control +0x700 and +0x704, early fragment tests come from control +0x718. NVN2 (Switch 2, Ampere: control version
0xc9, dmsh_ampere.py): job arch sm86, the code cut to the instructions' length (control +0x38, the 0x80-byte SPH of graphics included), c1 between
control +0x40 and +0x44, compute's c0 layout (nvn2_cs) from +0xa9 / +0xb1..+0xb5 / +0xba, early fragment tests from +0x5b; task and mesh stages as compute with
their stage memory (mesh_stage). The same as src/shaders/job.ts, which the page uses. Not done here (nxnative does them, see README.md): VertexA/B merging, transform feedback
layouts, the Metal wrapping of task and mesh stages, geometry lowering, the answer table per game (a corpus row's "facts" stand in for it).

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

def sph_outputs(sph):   # dmsh_meshstage.sph_outputs: the components an SPH's output map enables (their count is what the layout needs)
    return (sph[0x35] >> 3 & 1) + sum(sph[0x35] >> (4 + c) & 1 for c in range(4)) + sum(sph[0x36 + (n >> 1)] >> (4 * (n & 1) + c) & 1 for n in range(32) for c in range(4))

def mesh_stage(ctl, area):
    """dmsh_meshstage.info + memory (src/shaders/meshstage.ts meshStage): threads, stage_memory, shared bytes of a task or mesh shader"""
    if len(ctl) < 0x6c: raise ValueError('an NVN2 task / mesh control section under 0x6c bytes')
    threads, payload = struct.unpack_from('<HH', ctl, 0x58); out = 0x10 + (payload + 15 & ~15)
    if not threads: raise ValueError('an NVN2 task / mesh shader of 0 threads (control +0x58)')
    if ctl[0x56] == 6: return threads, [0, 0x10, out, out + payload], out + (payload + 3 & ~3)
    max_v, max_p = struct.unpack_from('<HH', ctl, 0x60); verts = ctl[0x5f] or 3; at = struct.unpack_from('<I', ctl, 0x64)[0] if ctl[0x68] & 0x80 else 0
    if len(area) < 0x80 or (at and at + 0x80 > len(area)): raise ValueError("a mesh shader's code area holds no SPH")
    if verts > 3: raise ValueError(f'a mesh shader with {verts} vertices a primitive (control +0x5f)')
    nv = sph_outputs(area[:0x80]); np_ = 0
    if at: sph = area[at:at + 0x80]; np_ = sum(sph[0x36 + (n >> 1)] >> (4 * (n & 1) + c) & 1 for n in range(32) for c in range(4))
    vb, pb = -(-max(max_v, 1) // 32), -(-max(max_p, 1) // 32)
    prim = out + max(vb * nv + pb * np_, 1) * 32 * 4
    return threads, [0, 0x10, out, prim], prim + (4 + verts * pb * 32 + 3 & ~3)

def own_shared(code):   # dmsh_meshstage.own_shared: LDS, STS or ATOMS would lie over the stage memory
    return any(struct.unpack_from('<H', code, o)[0] & 0xfff in (0x984, 0x388, 0x988, 0x38c, 0x98c, 0xf8c) for o in range(0, len(code) - 15, 16))

def nvn2_job(row, code, ctl, stage, work):
    """dmsh_build.py job_for's NVN2 branch (dmsh_ampere.c1_segment, inst_len, early_fragment_tests)"""
    if stage not in ('vs', 'ps', 'cs', 'ts', 'ms'): raise ValueError(f"{row['key']}: an NVN2 {stage} shader (tessellation or geometry) is not translated")
    a, e = struct.unpack_from('<II', ctl, 0x40)
    c1 = code[a:e] if a <= e <= len(code) else b''
    area, code = code, code[:struct.unpack_from('<I', ctl, 0x38)[0]]
    if stage in ('ts', 'ms'):   # dmsh_build.py job_for: translated as compute, its SPH taken off, its stage memory in shared memory (src/shaders/meshstage.ts)
        threads, layout, shared = mesh_stage(ctl, area)
        code = code[0x80:]
        if own_shared(code): raise ValueError(f"{row['key']}: an NVN2 task / mesh shader with shared memory of its own (LDS / STS / ATOMS): it would lie over the stage memory")
        cp = work / (row['key'] + '.bin'); cp.write_bytes(code)
        job = dict(key=row['key'], stage='cs', code=str(cp), tex={}, img={}, attr={}, fout={}, c1=c1.hex(), arch='sm86', stage_memory=layout, local=[threads, 1, 1], shared=shared, debug=True, reduced=True)
        job.update(row.get('facts') or {})
        return job
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
    done, c1 = [], {j['key']: j['c1'] for j in jobs}
    for row in corpus:
        if (out / (row['key'] + '.spv')).exists() and (out / (row['key'] + '.res.json')).exists():
            done.append(dict(name=row['name'], stage=row['stage'], key=row['key'], spv=row['key'] + '.spv', res=row['key'] + '.res.json', c1=c1[row['key']]))
    (out / 'xlate.json').write_text(json.dumps(done, indent=1))
    print(f'{r.stdout.strip()} ({dt * 1000:.0f} ms for {len(jobs)} stages, process start included)')
    return r.returncode

if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2]))
