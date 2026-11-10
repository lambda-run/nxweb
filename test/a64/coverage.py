#!/usr/bin/env python3
"""List instructions in the guest corpus that the translator cannot translate, by mnemonic,
ordered by how often the mnemonic is executed (test/guests/out/coverage.txt)."""
import glob, json, os, struct, subprocess, sys
import capstone
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
md = capstone.Cs(capstone.CS_ARCH_ARM64, capstone.CS_MODE_ARM)
words = {}
for path in glob.glob(os.path.join(ROOT, "test/guests/out/*.bin")) + glob.glob(os.path.join(ROOT, "test/a64/guests/out/*.bin")):
    data = open(path, "rb").read()
    for off in range(0, len(data) - 3, 4):
        w = struct.unpack_from("<I", data, off)[0]
        if w in words:
            continue
        d = list(md.disasm(data[off:off + 4], 0x8000000 + off))
        if d:
            words[w] = (d[0].mnemonic, d[0].op_str)
executed = {}
cov = os.path.join(ROOT, "test/guests/out/coverage.txt")
if os.path.exists(cov):
    for line in open(cov):
        p = line.split()
        if len(p) >= 2 and not line.startswith("#"):
            executed[p[0]] = int(p[1])
inp = json.dumps(list(words))
out = subprocess.run(["node", os.path.join(ROOT, "test/a64/probe.ts")], input=inp, capture_output=True, text=True)
bad = json.loads(out.stdout)
by = {}
for w in bad:
    m, o = words[w]
    by.setdefault(m, []).append("%08x %s %s" % (w, m, o))
print("%d distinct instruction words in the corpus images, %d not translatable (%d mnemonics)" % (len(words), len(bad), len(by)))
for m in sorted(by, key=lambda m: -executed.get(m, 0)):
    print("%-12s executed=%-9d words=%-4d e.g. %s" % (m, executed.get(m, 0), len(by[m]), by[m][0]))
