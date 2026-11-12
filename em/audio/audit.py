#!/usr/bin/env python3
"""audit.py <log> [regexp]: who answers each host name the game's modules refer to, for the names matching the regexp
(default: nn::audio and nn::codec). The log is one of a node run with NX_LIST_REFS=<regexp> (its "[loader] referred:"
line, kernel/nx_guest.js). A name is answered by nxnative's HLE file when build.py builds that file (HLE_HOST, HLE_GFX);
a name of a file that is not built is bound to a stub that answers 0 (kernel/nx_proc.c logs its first call in red);
"called" is taken from the same log's "host call #" lines (first calls; the log keeps the first 460)."""
import re, sys, os
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
log = open(sys.argv[1], errors="replace").read()
rx = re.compile(sys.argv[2] if len(sys.argv) > 2 else r"_ZNK?2nn5(audio|codec)")
m = re.search(r"^\[loader\] referred: (.*)$", log, re.M)
if not m: sys.exit("audit: no '[loader] referred:' line in the log (run with NX_LIST_REFS='5audio|5codec')")
refs = [n for n in m.group(1).split() if rx.search(n)]
b = open(f"{R}/build.py").read()
built = set(re.search(r'HLE_HOST = \("(.*?)"\s*\n\s*"(.*?)"\)', b, re.S).group(0).replace('"', " ").replace("(", " ").replace(")", " ").split()[2:]) | {"hle_nv", "hle_vi"}
where = {}
for l in open(f"{R}/build/hle/report_all.tsv"):
    c = l.rstrip("\n").split("\t")
    if len(c) > 2: where.setdefault(c[2], c[0].split(":")[0][:-2])
called = set(re.findall(r"host call #\d+ (\S+)", log))
rows = {"built": [], "not built": [], "nobody": []}
for n in refs:
    f = where.get(n)
    rows["nobody" if not f else "built" if f in built else "not built"].append((n, f))
print(f"{len(refs)} names referred to: {len(rows['built'])} answered by a built file, {len(rows['not built'])} of a file that is not built (answer 0), {len(rows['nobody'])} nobody has")
for k in ("not built", "nobody"):
    for n, f in rows[k]: print(f"  {k:9} {f or '-':12} {'CALLED' if n in called else 'not called'}  {n}")
by = {}
for n, f in rows["built"]: by.setdefault(f, [0, 0]); by[f][0] += 1; by[f][1] += n in called
print("  built: " + ", ".join(f"{f} {a} names ({c} called)" for f, (a, c) in sorted(by.items())))
