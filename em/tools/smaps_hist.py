#!/usr/bin/env python3
"""smaps_hist.py <pid>: the process's anonymous mappings by size and protection: how many, how much is resident."""
import sys, collections
rows = []; cur = None
for l in open(f"/proc/{sys.argv[1]}/smaps"):
    p = l.split()
    if "-" in p[0] and len(p) >= 5 and not p[0].endswith(":"):
        a, b = (int(x, 16) for x in p[0].split("-")); cur = [b - a, p[1], len(p) > 5, 0]; rows.append(cur)
    elif p[0] == "Rss:": cur[3] = int(p[1])
h = collections.defaultdict(lambda: [0, 0])
for size, perm, named, rss in rows:
    if named or not rss: continue
    k = (perm, size if size < (1 << 30) else -1)
    h[k][0] += 1; h[k][1] += rss
top = sorted(h.items(), key=lambda kv: -kv[1][1])[:14]
for (perm, size), (n, rss) in top:
    print(f"{perm} {'>=1GB' if size < 0 else str(size >> 10) + ' KB':>10}  x{n:<6} resident {rss >> 10} MB")
