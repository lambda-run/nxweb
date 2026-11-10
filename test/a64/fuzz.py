#!/usr/bin/env python3
"""Gate 1: differential fuzz of the a64 translator against Unicorn.

    python3 test/a64/fuzz.py [--cases N] [--only REGEX] [--seed S] [--show K] [--jobs J]

For every instruction class: generate random encodings + random state, run each on Unicorn,
then let the Node runner (fuzz_run.ts) translate/run the same cases and compare all state.
"""
import argparse
import json
import multiprocessing
import os
import re
import struct
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import fuzz_lib  # noqa: E402


def _gen(args):
    name, ncases, seed, path = args
    fuzz_lib.NCASES = ncases
    import fuzz_classes
    cls = next(c for c in fuzz_classes.CLASSES if c.name == name)
    try:
        g, r = fuzz_lib.generate_class(cls, ncases, seed, path)
        return name, path, g, r, None
    except Exception as e:  # noqa: BLE001
        return name, path, 0, 0, "%s: %s" % (type(e).__name__, e)


def disasm(words, pc):
    import capstone
    md = capstone.Cs(capstone.CS_ARCH_ARM64, capstone.CS_MODE_ARM)
    out = []
    for i, w in enumerate(words):
        d = list(md.disasm(struct.pack("<I", w), pc + 4 * i))
        out.append("%08x  %s" % (w, ("%s %s" % (d[0].mnemonic, d[0].op_str)) if d else "<capstone: invalid>"))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", type=int, default=2000)
    ap.add_argument("--only", default=None)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--show", type=int, default=4)
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 2)
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--nofma", action="store_true")
    ap.add_argument("--strictnan", action="store_true", help="compare NaNs bitwise too")
    ap.add_argument("--nonan", action="store_true", help="translate without the NaN fix-up")
    a = ap.parse_args()
    fuzz_lib.NCASES = a.cases
    import fuzz_classes
    names = [c.name for c in fuzz_classes.CLASSES]
    if a.only:
        names = [n for n in names if re.search(a.only, n)]
    outdir = os.path.join(ROOT, "build", "a64", "fuzz")
    os.makedirs(outdir, exist_ok=True)
    jobs = [(n, a.cases, a.seed, os.path.join(outdir, n + ".bin")) for n in names]
    results = {}
    t0 = time.time()

    def check(batch):
        cmd = ["node", os.path.join(HERE, "fuzz_run.ts")] + (["--nofma"] if a.nofma else []) + (["--strictnan"] if a.strictnan else []) + (["--nonan"] if a.nonan else []) + [p for _, p in batch]
        p = subprocess.run(cmd, capture_output=True, text=True)
        got = {}
        for line in p.stdout.splitlines():
            if line.startswith("{"):
                r = json.loads(line)
                got[r["name"]] = r
        for n, path in batch:
            if n in got:
                results[n].update(got[n])
            else:
                results[n]["error"] = "runner crashed: " + (p.stderr.strip().splitlines() or ["?"])[-1][:300]
            if not a.keep and os.path.exists(path):
                os.remove(path)

    with multiprocessing.Pool(a.jobs) as pool:
        batch = []
        for name, path, g, r, err in pool.imap_unordered(_gen, jobs):
            results[name] = {"name": name, "cases": g, "rejected": r}
            if err:
                results[name]["error"] = "generator: " + err
                continue
            batch.append((name, path))
            if len(batch) >= 6:
                check(batch)
                batch = []
        if batch:
            check(batch)

    total = fails = 0
    bad = []
    print("%-34s %8s %8s %9s" % ("class", "cases", "fail", "rejected"))
    for n in names:
        r = results[n]
        if "error" in r:
            print("%-34s %8d %8s %9d  ERROR %s" % (n, r["cases"], "-", r["rejected"], r["error"]))
            bad.append(n)
            continue
        total += r["cases"]
        fails += r["fail"]
        print("%-34s %8d %8d %9d" % (n, r["cases"], r["fail"], r["rejected"]))
        if r["fail"]:
            bad.append(n)
    print("%-34s %8d %8d   (%.0fs)" % ("TOTAL", total, fails, time.time() - t0))
    for n in bad:
        r = results[n]
        for fc in r.get("failures", [])[:a.show]:
            print("\n[RED] %s case %d @0x%x" % (n, fc["idx"], fc["pc"]))
            for line in disasm(fc["insns"], fc["pc"]):
                print("      " + line)
            for d in fc["diffs"][:8]:
                print("      " + d)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
