#!/usr/bin/env python3
"""Compile inventory of nxnative's host / HLE sources under Emscripten (wasm64, pthreads). Run in the VM.

  python3 hle_inventory.py [--nx /ctl/repos/nxnative/dm] [--out /ctl/nxweb-em/em/build/hle/inventory] [-j 4] [files...]

Each file is compiled (-c, no link) three ways; nothing in nxnative is edited:
  asis   the flags of build.py: kernel/ and kernel/shim/ headers only
  shim   plus nxnative's own include directories (gfx/nvn/include, third_party/*) and the mechanical shim headers of hle/shim/
         (nx_darwin.h, the Darwin libc functions musl lacks, is force-included)
  probe  diagnostic only: every header that is still missing is replaced by an EMPTY file (repeated until no
         header is missing) so that the compiler goes on and names what the file uses from those headers
Output: <out>/inventory.tsv (one line per file) and <out>/inventory.json (all causes with counts); a summary on stdout.
"""
import argparse, collections, glob, json, os, re, shutil, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser()
ap.add_argument("--nx", default="/ctl/repos/nxnative/dm")
ap.add_argument("--out", default=f"{R}/build/hle/inventory")
ap.add_argument("-j", type=int, default=4)
ap.add_argument("files", nargs="*")
A = ap.parse_args()
NX = A.nx
os.environ.setdefault("EM_CONFIG", "/ctl/emsdk/emscripten.cfg")
EMCC = "/ctl/emsdk/emscripten/emcc"
BASE = ["-O1", "-pthread", "-D_GNU_SOURCE", "-sMEMORY64=1", f"-I{R}/kernel", f"-I{R}/kernel/shim", f"-I{NX}/host", f"-I{R}/build/gen",
        "-Wno-version-check", "-w", "-ferror-limit=0", "-fno-caret-diagnostics", "-fno-diagnostics-fixit-info"]
# nxnative's own include directories (its Makefile's -I list for these files) and the mechanical shims
SHIM = [f"-I{R}/hle/shim", f"-I{NX}/gfx/nvn/include", f"-I{NX}/third_party/libvpx", f"-I{NX}/third_party/dav1d/include", f"-I{NX}/third_party/stb_vorbis",
        "-include", f"{R}/hle/shim/nx_darwin.h"]

files = A.files or (sorted(glob.glob(f"{NX}/host/*.c")) + [f"{NX}/gfx/hle_nv.c", f"{NX}/gfx/hle_vi.c", f"{NX}/gfx/nvn/hle_nvn.c"])
os.makedirs(A.out, exist_ok=True)

DIAG = re.compile(r"^(.*?):(\d+):(\d+): (fatal error|error): (.*)$")
def classify(msg):
    m = re.search(r"'([^']+)' file not found", msg)
    if m: return ("missing header", m.group(1))
    m = re.search(r"call to undeclared (?:library )?function '([^']+)'", msg)
    if m: return ("undeclared function", m.group(1))
    m = re.search(r"use of undeclared identifier '([^']+)'", msg)
    if m: return ("undeclared identifier", m.group(1))
    m = re.search(r"unknown type name '([^']+)'", msg)
    if m: return ("unknown type", m.group(1))
    m = re.search(r"no member named '([^']+)' in '([^']+)'", msg)
    if m: return ("no such member", f"{m.group(2)}.{m.group(1)}")
    if re.search(r"invalid instruction|unknown directive|unexpected token|unrecognized instruction|invalid operand|in inline assembly|inline asm|unknown register|invalid output constraint|invalid input constraint|asm-specifier", msg, re.I):
        return ("inline asm", re.sub(r"\s+", " ", msg)[:60])
    if "section" in msg and ("specifier" in msg or "attribute" in msg): return ("section attribute", msg[:70])
    return ("other", re.sub(r"\s+", " ", msg)[:90])

def cc(src, obj, extra):
    r = subprocess.run([EMCC, *BASE, *extra, "-c", src, "-o", obj], capture_output=True, text=True)
    causes = collections.Counter(); where = {}
    for line in r.stderr.splitlines():
        m = DIAG.match(line)
        if not m: continue
        c = classify(m.group(5)); causes[c] += 1
        where.setdefault(c, f"{os.path.relpath(m.group(1), NX) if m.group(1).startswith(NX) else m.group(1)}:{m.group(2)}")
    if r.returncode and not causes: causes[("other", (r.stderr.strip().splitlines() or ["?"])[-1][:90])] += 1
    return r.returncode == 0, causes, where

def one(src):
    name = os.path.relpath(src, NX); tag = name.replace("/", "_")
    res = {"file": name, "lines": sum(1 for _ in open(src, encoding="utf-8", errors="replace"))}
    ok, c, w = cc(src, f"{A.out}/{tag}.asis.o", [])
    res["asis"] = ok; res["asis_causes"] = [[k[0], k[1], n, w[k]] for k, n in c.most_common()]
    ok2, c2, w2 = (ok, c, w) if ok else cc(src, f"{A.out}/{tag}.shim.o", SHIM)
    res["shim"] = ok2; res["shim_causes"] = [[k[0], k[1], n, w2[k]] for k, n in c2.most_common()]
    missing, needs = [], []
    if not ok2:
        stub = f"{A.out}/stub_{tag}"; shutil.rmtree(stub, ignore_errors=True); os.makedirs(stub)
        for _ in range(40):
            okp, cp, wp = cc(src, f"{A.out}/{tag}.probe.o", SHIM + [f"-I{stub}"])
            new = [k[1] for k in cp if k[0] == "missing header"]
            if not new: break
            for h in new:
                missing.append(h); p = os.path.join(stub, h); os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "w").close()
        res["probe_ok"] = okp
        needs = [[k[0], k[1], n, wp[k]] for k, n in cp.most_common()]
    res["missing_headers"] = missing; res["probe_causes"] = needs
    return res

with ThreadPoolExecutor(A.j) as ex: out = list(ex.map(one, files))
json.dump(out, open(f"{A.out}/inventory.json", "w"), indent=1)
with open(f"{A.out}/inventory.tsv", "w") as f:
    f.write("file\tlines\tasis\twith_hle_shim\tmissing_headers\terrors_after_empty_headers\tkinds\ttop_names\n")
    for r in out:
        kinds = collections.Counter(); 
        for k, nme, n, _ in r["probe_causes"]: kinds[k] += n
        top = ", ".join(f"{nme}x{n}" for k, nme, n, _ in r["probe_causes"][:8])
        f.write("\t".join([r["file"], str(r["lines"]), "ok" if r["asis"] else "FAIL", "ok" if r["shim"] else "FAIL", " ".join(r["missing_headers"]),
                           str(sum(kinds.values())), " ".join(f"{k}:{n}" for k, n in kinds.most_common()), top]) + "\n")
n = len(out); a = sum(r["asis"] for r in out); s = sum(r["shim"] for r in out)
la = sum(r["lines"] for r in out if r["asis"]); ls = sum(r["lines"] for r in out if r["shim"]); lt = sum(r["lines"] for r in out)
print(f"inventory: {n} files, {lt} lines; as-is {a} files / {la} lines; with hle/shim {s} files / {ls} lines")
