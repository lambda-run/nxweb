#!/usr/bin/env python3
"""Which of nxnative's take-overs nxweb answers: every SDK function nxnative replaces by name, and what in nxweb
registers the same name.

  python3 tools/hle_coverage.py           write test/hle/coverage.tsv, src/hle/gen/coverage.ts and the coverage
                                          table in src/hle/README.md; print the counts per file
  python3 tools/hle_coverage.py --check   fail when one of them is out of date (part of `npm run hle:check`)

nxnative's side (NXNATIVE overrides /home/user/nxnative), read with tools/hle_names.py's parser: every HLE(...),
HLE_FORCE(...) and HLE_FORCE_BIG(...) of dm/host/*.c and of every source of dm/gfx (hle_vi.c, hle_nv.c,
nvn/hle_nvn.c; tests and tools left out), the libc pass-through list of hle_table.c, the table entries written out
by hand, and the import tables of the GL and Vulkan layers (GL / GLB / EGL in gl/hle_gl.m, VK / VKB in
vk/hle_vk.m: registered by their plain names, as HLE is). An HLE name is taken over when a module imports it and no
module defines it; an HLE_FORCE name also when a module defines it.

nxweb's side, what registers a name with the runtime (rt.register):
  hle    src/hle: every entry of the files tools/hle_names.py puts in scope (src/hle/gen/table.ts)
  fs     src/fs/names.ts (src/glue/rt_fs.ts registers every name)
  audio  src/audio/names.ts (src/glue/rt_audio.ts registers every name)
  glue   a literal `name: "<take-over name>"` in src/glue/*.ts (rt_gfx.ts's nvnBootstrapLoader, ...)

src/hle/gen/coverage.ts lists the names no one in nxweb answers: the Prepare page's Code stage and
`npm run prepare:scan` look them up in each module's dynamic symbol table (src/glue/hle_scan.ts).
"""
import os, re, sys, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hle_names as H

ROOT = H.ROOT
OUT_TSV = os.path.join(ROOT, "test", "hle", "coverage.tsv")
OUT_TS = os.path.join(ROOT, "src", "hle", "gen", "coverage.ts")
README = H.README
GLUE = os.path.join(ROOT, "src", "glue")
TABLE_MACROS = {"gl/hle_gl.m": ("GL", "GLB", "EGL"), "vk/hle_vk.m": ("VK", "VKB")}


def nxnative_entries():
    """[(dm-relative file, mangled, kind)] for every take-over nxnative registers by name"""
    out = []
    for f in sorted(x for x in os.listdir(H.HOST) if x.endswith(".c")):
        for e in H.parse_file(os.path.join(H.HOST, f)):
            out.append(("host/" + f, e["mangled"], e["kind"]))
    for d, dirs, fs in os.walk(H.GFX):
        dirs[:] = sorted(x for x in dirs if x not in ("tests", "tools"))
        for f in sorted(fs):
            p = os.path.join(d, f)
            rel = os.path.relpath(p, H.GFX)
            if f.endswith((".c", ".m")):
                for e in H.parse_file(p):
                    out.append(("gfx/" + rel, e["mangled"], e["kind"]))
            if rel in TABLE_MACROS:
                text = H.strip_comments(open(p, encoding="utf-8", errors="replace").read())
                pat = r"^\s*(?:%s)\(\s*(\w+)\s*," % "|".join(TABLE_MACROS[rel])
                for m in re.finditer(pat, text, re.M):
                    out.append(("gfx/" + rel, m.group(1), "weak"))
    return out


def ts_strings(path):
    text = open(path).read()
    return re.findall(r'^\s*"([^"]+)",\s*$', text[text.index("export const NAMES"):], re.M)


def nxweb_answers(names):
    """mangled -> what in nxweb registers it"""
    ans = {}
    for f in sorted(x for x in os.listdir(H.HOST) if x.endswith(".c")):
        if f in H.SCOPE:
            for e in H.parse_file(os.path.join(H.HOST, f)):
                ans.setdefault(e["mangled"], "hle (src/hle/%s.ts)" % H.SCOPE[f])
    for f in sorted(k for k in H.SCOPE if "/" in k):
        for e in H.parse_file(os.path.join(H.NX, "dm", f)):
            ans.setdefault(e["mangled"], "hle (src/hle/%s.ts)" % H.SCOPE[f])
    for area in ("fs", "audio"):
        for n in ts_strings(os.path.join(ROOT, "src", area, "names.ts")):
            ans.setdefault(n, area + " (src/%s)" % area)
    for f in sorted(os.listdir(GLUE)):
        if f.endswith(".ts"):
            for m in re.finditer(r'\bname:\s*"([^"]+)"', open(os.path.join(GLUE, f)).read()):
                if m.group(1) in names:
                    ans.setdefault(m.group(1), "glue (src/glue/%s)" % f)
    return ans


def ts_str(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def main():
    check = "--check" in sys.argv
    ents = nxnative_entries()
    by = {}
    for f, n, k in ents:
        r = by.setdefault(n, dict(files=[], forced=False))
        if f not in r["files"]:
            r["files"].append(f)
        r["forced"] |= k == "forced"
    names = sorted(by)
    dem = dict(zip(names, H.demangle(names)))
    ans = nxweb_answers(set(names))
    ref = open(os.path.join(ROOT, "NXNATIVE_REF")).read().strip()

    tsv = ["mangled\tdemangled\tnxnative\tkind\tnxweb"]
    for n in names:
        r = by[n]
        tsv.append("\t".join([n, dem[n], ",".join(r["files"]), "forced" if r["forced"] else "weak", ans.get(n, "-")]))
    tsv_text = "\n".join(tsv) + "\n"

    missing = [n for n in names if n not in ans]
    body = "".join("  [%s, %s, %s, %d],\n" % (ts_str(n), ts_str(dem[n]), ts_str(",".join(by[n]["files"])), 1 if by[n]["forced"] else 0) for n in missing)
    key = hashlib.sha256(body.encode()).hexdigest()[:16]
    T = ["// Generated by tools/hle_coverage.py from nxnative's dm/host and dm/gfx and nxweb's answers. Do not edit; run `npm run hle:names`.",
         "// The SDK functions nxnative takes over by name and nxweb does not answer: [mangled, demangled, nxnative files (under dm/), forced].",
         "// forced 1: HLE_FORCE (taken over where a module defines it too); 0: HLE / the GL and Vulkan tables (taken over where imported and defined nowhere).",
         "export const NXNATIVE_REF = %s;" % ts_str(ref),
         "export const NXNATIVE_NAMES = %d;   // names nxnative takes over" % len(names),
         "export const COVERAGE_KEY = %s;   // changes with the list" % ts_str(key),
         "export const NOT_ANSWERED: readonly (readonly [string, string, string, number])[] = [",
         body.rstrip("\n"), "];"]
    ts_text = "\n".join(t for t in T if t) + "\n"

    per = {}
    for n in names:
        for f in by[n]["files"]:
            c = per.setdefault(f, [0, 0])
            c[0] += 1
            c[1] += n not in ans
    rows = ["| nxnative file | names | answered in nxweb | not answered |", "|---|---|---|---|"]
    for f in sorted(per):
        rows.append("| `dm/%s` | %d | %d | %d |" % (f, per[f][0], per[f][0] - per[f][1], per[f][1]))
    rows.append("| **all (distinct names)** | **%d** | **%d** | **%d** |" % (len(names), len(names) - len(missing), len(missing)))
    md = "\n".join(rows)

    outputs = [(OUT_TSV, tsv_text), (OUT_TS, ts_text)]
    r = open(README).read()
    a, b = "<!-- coverage:begin -->", "<!-- coverage:end -->"
    if a in r and b in r:
        outputs.append((README, r[:r.index(a) + len(a)] + "\n" + md + "\n" + r[r.index(b):]))
    elif check:
        print("[RED] hle:coverage: src/hle/README.md has no coverage markers"); sys.exit(1)
    stale = []
    for p, t in outputs:
        old = open(p).read() if os.path.exists(p) else None
        if old != t:
            stale.append(os.path.relpath(p, ROOT))
            if not check:
                open(p, "w").write(t)
    if check:
        for s in stale:
            print("[RED] hle:coverage: %s is out of date (run `npm run hle:names`)" % s)
        sys.exit(1 if stale else 0)
    for f in sorted(per):
        print("%-28s %5d names, %5d not answered" % ("dm/" + f, per[f][0], per[f][1]))
    print("%d names nxnative takes over, %d answered in nxweb, %d not" % (len(names), len(names) - len(missing), len(missing)))


if __name__ == "__main__":
    main()
