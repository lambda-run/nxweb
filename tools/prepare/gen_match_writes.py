#!/usr/bin/env python3
"""Measure, from Capstone, which general registers an AArch64 instruction is listed as writing, and write the
result as a table for src/prepare/match.ts (src/prepare/gen/match_writes.ts).

  gen_match_writes.py [--check] [--fuzz N [--seed S]] [--truth N FILE]

Why a measurement. nxnative's function fingerprints (dm/tools/nso_match.py) mask the low part of an address an
ADRP started: from the ADRP they walk up to eight instructions, and stop at one that Capstone's `regs_access()`
lists as writing the ADRP's register. A fingerprint computed here must be the one nxnative computed, so the walk
must stop where Capstone stops it, and Capstone's list is not the architecture's: `cmp x1, #1` is listed as writing
x1, `adds w3, w2, #1` as writing nothing, `ldadda` as writing nothing. So the list is taken from Capstone itself,
class by class, and whatever was not measured as regular counts as "writes every register".

That last rule is what makes the table safe. The walk masks an immediate only while no write was seen, so answering
"written" where Capstone says "not written" masks less than nxnative did: the fingerprint differs and a patch is
not placed (a miss, reported). The other direction would mask more and could accept a function that differs in
that immediate. The table therefore only ever errs towards "written": a key is regular only when every sample of
it agreed, and --fuzz checks the table against Capstone on words it was not made from.

The table. A class is (mask, value) over the instruction word with the bit ranges that form its key (the opcode
bits the class does not fix) and one flag per register field that says "this field is 31" (aliases such as cmp
depend on it). For each key, words are sampled with every other bit random (immediates also all zeroes / all ones,
register fields also equal to one another) and the set of written registers is explained as a subset of the four
register fields (bits 0, 5, 10, 16) and x16, x17, x30; a key with no explanation that holds for every sample, and a
key Capstone never decodes, is "unknown". Classes are tried in order; a word in no class is unknown.

The output names the Capstone version: the test compares against the installed one and skips on another.
"""
import argparse, os, random, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "src", "prepare", "gen", "match_writes.ts")
SEED, SAMPLES = 20261110, 48
FIELD_LO = (0, 5, 10, 16)          # d, n, a, m: where a register number can stand
IMPLICIT = (16, 17, 30)
UNKNOWN = 0xFF
TRAP_WORD = 0xE7FFDEFE             # nso_match.py decodes this word as brk #0

# name, mask, value, key bit ranges [(low bit, width)], flags (which of d n a m get an "is 31" key bit)
CLASSES = [
    ("pc-relative address",           0x1F000000, 0x10000000, [(31, 1)], "d"),
    ("add / subtract immediate",      0x1F800000, 0x11000000, [(29, 3), (22, 1)], "dn"),
    ("logical immediate",             0x1F800000, 0x12000000, [(29, 3), (22, 1)], "dn"),
    ("move wide",                     0x1F800000, 0x12800000, [(29, 3)], "d"),
    ("bitfield",                      0x1F800000, 0x13000000, [(29, 3), (22, 1)], "dn"),
    ("extract",                       0x1F800000, 0x13800000, [(29, 3), (21, 2)], "dnm"),
    ("exception generation",          0xFF000000, 0xD4000000, [(21, 3), (0, 5)], ""),
    ("hints",                         0xFFFFF01F, 0xD503201F, [(5, 7)], ""),
    ("system",                        0xFFC00000, 0xD5000000, [(19, 3), (12, 4)], "d"),
    ("logical shifted register",      0x1F000000, 0x0A000000, [(29, 3), (21, 3)], "dnm"),
    ("add / subtract shifted",        0x1F200000, 0x0B000000, [(29, 3), (22, 2)], "dnm"),
    ("add / subtract extended",       0x1F200000, 0x0B200000, [(29, 3), (22, 2), (13, 3)], "dnm"),
    ("add / subtract with carry",     0x1FE00000, 0x1A000000, [(29, 3), (10, 6)], "dnm"),
    ("conditional compare",           0x1FE00000, 0x1A400000, [(29, 3), (10, 2), (4, 1)], "nm"),
    ("conditional select",            0x1FE00000, 0x1A800000, [(29, 3), (10, 2)], "dnm"),
    ("data processing, one source",   0x5FE00000, 0x5AC00000, [(31, 1), (29, 1), (10, 11)], "dn"),
    ("data processing, two sources",  0x5FE00000, 0x1AC00000, [(31, 1), (29, 1), (10, 6)], "dnm"),
    ("multiply and add",              0x1F000000, 0x1B000000, [(29, 3), (21, 3), (15, 1)], "dnam"),
    ("load / store exclusive",        0x3F000000, 0x08000000, [(30, 2), (21, 3), (15, 1)], "dnam"),
    ("load literal",                  0x3B000000, 0x18000000, [(30, 2), (26, 1)], "d"),
    ("load / store pair",             0x3A000000, 0x28000000, [(30, 2), (26, 1), (22, 3)], "dna"),
    ("load / store, 9-bit offset",    0x3B200000, 0x38000000, [(30, 2), (26, 1), (22, 2), (10, 2)], "dn"),
    ("load / store, register offset", 0x3B200C00, 0x38200800, [(30, 2), (26, 1), (22, 2), (12, 4)], "dnm"),
    ("load / store, unsigned offset", 0x3B000000, 0x39000000, [(30, 2), (26, 1), (22, 2)], "dn"),
    ("vector load / store",           0xBF000000, 0x0C000000, [(30, 1), (21, 3), (12, 4)], "nm"),
    ("vector load / store, one lane", 0xBF000000, 0x0D000000, [(30, 1), (21, 3), (13, 3)], "nm"),
    ("scalar float and integer",      0x5F20FC00, 0x1E200000, [(31, 1), (22, 2), (16, 5)], "d"),
    ("float immediate",               0x5F201FE0, 0x1E201000, [(22, 2)], ""),
    ("float compare",                 0x5F203C00, 0x1E202000, [(22, 2), (14, 2), (0, 5)], ""),
    ("float, one source",             0x5F207C00, 0x1E204000, [(22, 2), (15, 6)], ""),
    ("scalar float",                  0x5F200000, 0x1E200000, [(22, 2), (10, 6)], ""),
    ("scalar float and fixed point",  0x5F200000, 0x1E000000, [(31, 1), (22, 2), (16, 5)], "d"),
    ("float multiply and add",        0x5F000000, 0x1F000000, [(21, 3), (15, 1)], ""),
    ("vector, two registers",         0x9F3E0C00, 0x0E200800, [(29, 2), (22, 2), (12, 5)], "d"),
    ("vector, three registers",       0x9F200400, 0x0E200400, [(29, 2), (22, 2), (11, 5)], ""),
    ("vector, widening and narrowing", 0x9F200C00, 0x0E200000, [(29, 2), (22, 2), (12, 4)], ""),
    ("vector copy",                   0x9FE08400, 0x0E000400, [(29, 2), (11, 4)], "d"),
    ("scalar vector, two registers",  0xDF3E0C00, 0x5E200800, [(29, 1), (22, 2), (12, 5)], "d"),
    ("scalar vector, three registers", 0xDF200400, 0x5E200400, [(29, 1), (22, 2), (11, 5)], ""),
    ("vector",                        0x9F000000, 0x0E000000, [(29, 2), (21, 3), (10, 6)], "d"),
    ("vector, shift or element",      0x9F000000, 0x0F000000, [(29, 2), (23, 1), (10, 6)], "d"),
    ("scalar vector",                 0xDF000000, 0x5E000000, [(29, 1), (21, 3), (10, 6)], "d"),
    ("scalar vector, shift or element", 0xDF000000, 0x5F000000, [(29, 1), (23, 1), (10, 6)], "d"),
]


def class_of(w):
    for i, (_, mask, val, _, _) in enumerate(CLASSES):
        if w & mask == val: return i
    return -1


def key_of(i, w):
    _, _, _, ranges, flags = CLASSES[i]
    k = 0
    for lo, width in ranges: k = (k << width) | ((w >> lo) & ((1 << width) - 1))
    for f in flags: k = (k << 1) | (((w >> FIELD_LO["dnam".index(f)]) & 31) == 31)
    return k


def key_bits(i):
    return sum(w for _, w in CLASSES[i][3]) + len(CLASSES[i][4])


def explain(code, w):
    """The registers a code names for a word, as a mask of x0..x30"""
    m = 0
    for b in range(4):
        if code >> b & 1:
            r = (w >> FIELD_LO[b]) & 31
            if r != 31: m |= 1 << r
    for b, r in enumerate(IMPLICIT):
        if code >> (4 + b) & 1: m |= 1 << r
    return m


_md = None
def capstone_version():
    import capstone
    return capstone.__version__


def cap_writes(w):
    """What nso_match.py reads: the general registers regs_access() lists as written (x and w names, fp, lr), as a mask of x0..x30; None when Capstone does not decode the word"""
    global _md
    if _md is None:
        from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM
        _md = Cs(CS_ARCH_ARM64, CS_MODE_ARM); _md.detail = True
    if w == TRAP_WORD: w = 0xD4200000
    ins = next(_md.disasm(struct.pack("<I", w), 0x100000), None)
    if ins is None: return None
    m = 0
    for r in ins.regs_access()[1]:
        n = ins.reg_name(r)
        if n == "fp": m |= 1 << 29
        elif n == "lr": m |= 1 << 30
        elif n and n[0] in "xw" and n[1:].isdigit() and int(n[1:]) <= 30: m |= 1 << int(n[1:])
    return m


def vary(rnd, w, fixed):
    """A word with the fixed bits kept: random elsewhere, with stretches of zeroes and ones, and register fields that repeat"""
    r = rnd.getrandbits(32)
    t = rnd.random()
    if t < 0.2: r &= rnd.getrandbits(32) & rnd.getrandbits(32)
    elif t < 0.4: r |= rnd.getrandbits(32) | rnd.getrandbits(32)
    elif t < 0.5: r &= ~(0xFFF << 10)
    elif t < 0.6: r |= 0xFFF << 10
    if rnd.random() < 0.3:
        a, b = rnd.sample(FIELD_LO, 2)
        r = (r & ~(31 << b)) | (((r >> a) & 31) << b)
    return (w & fixed) | (r & ~fixed & 0xFFFFFFFF)


def measure(report=lambda s: None):
    rnd = random.Random(SEED)
    tables, stats = [], []
    for i, (name, mask, val, ranges, flags) in enumerate(CLASSES):
        nkeys = 1 << key_bits(i)
        codes = bytearray([UNKNOWN]) * nkeys
        seen = regular = 0
        for key in range(nkeys):
            # the word that has this key: the class's fixed bits, the key's bits, and 31 in the flagged fields
            w, fixed, k = val, mask, key
            for f in reversed(flags):
                lo = FIELD_LO["dnam".index(f)]
                if k & 1: w |= 31 << lo; fixed |= 31 << lo
                k >>= 1
            for lo, width in reversed(ranges):
                w |= (k & ((1 << width) - 1)) << lo; fixed |= ((1 << width) - 1) << lo; k >>= width
            cand, n, undecoded = None, 0, 0
            for _ in range(SAMPLES * 4):
                x = vary(rnd, w, fixed)
                if class_of(x) != i or key_of(i, x) != key or x == TRAP_WORD: continue
                c = cap_writes(x)
                if c is None:
                    undecoded += 1
                    if not n and undecoded >= 24: break    # a key Capstone does not decode
                    continue
                n += 1
                cand = [code for code in (range(128) if cand is None else cand) if explain(code, x) == c]
                if not cand or n >= SAMPLES: break
            if n: seen += 1
            if n >= SAMPLES // 2 and cand:
                codes[key] = min(cand, key=lambda c: (bin(c).count("1"), c)); regular += 1
        tables.append(codes); stats.append((name, nkeys, seen, regular))
        report(f"  {name}: {nkeys} keys, {seen} decode, {regular} regular")
    return tables, stats


def runs(codes):
    """[(first key, code)] for each stretch of equal codes"""
    out, last = [], None
    for k, c in enumerate(codes):
        if c != last: out.append((k, c)); last = c
    return out


def render(tables, stats, version):
    L = ["// GENERATED by tools/prepare/gen_match_writes.py: which general registers Capstone lists an AArch64 instruction",
         f"// as writing, measured from Capstone {version} (seed {SEED}, {SAMPLES} samples a key). Do not edit: see the tool for the",
         "// method and for why an unmeasured word counts as writing every register.",
         f"export const WRITES_CAPSTONE: string = \"{version}\";",
         f"export const WRITES_CLASSES: i32 = {len(CLASSES)};",
         "// per class: mask, value, first run, number of runs, number of key ranges, flags (bit 0..3: d n a m), then 4 x (low bit, width)",
         "export const WRITES_CLASS: usize = memory.data<u32>(["]
    first, allruns = 0, []
    for (name, mask, val, ranges, flags), codes, st in zip(CLASSES, tables, stats):
        r = runs(codes)
        fl = sum(1 << "dnam".index(f) for f in flags)
        rr = [x for lo, w in ranges for x in (lo, w)] + [0, 0] * (4 - len(ranges))
        L.append(f"  0x{mask:08X}, 0x{val:08X}, {first}, {len(r)}, {len(ranges)}, {fl}, {', '.join(map(str, rr))},   // {name}: {st[3]} of {st[2]} decoded keys regular")
        first += len(r); allruns += r
    L.append("]);")
    L.append("// runs of keys with one answer: key << 8 | code. Code bits 0..3: the register in field d n a m; 4..6: x16 x17 x30; 0xFF: unknown")
    L.append("export const WRITES_RUNS: usize = memory.data<u32>([")
    for o in range(0, len(allruns), 12): L.append("  " + ", ".join(f"0x{k << 8 | c:X}" for k, c in allruns[o:o + 12]) + ",")
    L.append("]);")
    return "\n".join(L) + "\n"


def lookup(tables, w):
    """The table's answer for a word (the reference for src/prepare/match.ts writesMask): a mask of x0..x30"""
    if w == TRAP_WORD: return 0
    i = class_of(w)
    if i < 0: return 0x7FFFFFFF
    c = tables[i][key_of(i, w)]
    return 0x7FFFFFFF if c == UNKNOWN else explain(c, w)


def fuzz(tables, n, seed, report=print):
    """Random words against Capstone: the table must never say "not written" where Capstone says "written". Returns (unsound, exact, decoded)"""
    rnd = random.Random(seed)
    bad = exact = dec = 0
    for j in range(n):
        if j & 1:
            _, mask, val, _, _ = CLASSES[rnd.randrange(len(CLASSES))]
            w = vary(rnd, val, mask)
        else: w = vary(rnd, 0, 0)
        c = cap_writes(w)
        if c is None: continue
        dec += 1
        m = lookup(tables, w)
        if c & ~m:
            bad += 1
            if bad <= 10: report(f"[RED] gen_match_writes: {w:#010x}: Capstone lists {c:#x} as written, the table says {m:#x}")
        elif c == m: exact += 1
    return bad, exact, dec


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="fail when the generated file is not what this run would write (needs the Capstone version it names)")
    ap.add_argument("--fuzz", type=int, default=0, metavar="N", help="after measuring, compare the table with Capstone on N more words")
    ap.add_argument("--truth", nargs=2, metavar=("N", "FILE"), help="write N words with Capstone's answer (u32 word, u32 mask; 0xFFFFFFFF = not decoded) for the test of match.ts")
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    try: version = capstone_version()
    except ImportError: sys.exit("[RED] gen_match_writes: Capstone is not installed (pip install capstone)")
    if a.truth:
        rnd = random.Random(a.seed)
        with open(a.truth[1], "wb") as f:
            for j in range(int(a.truth[0])):
                if j & 1:
                    _, mask, val, _, _ = CLASSES[rnd.randrange(len(CLASSES))]
                    w = vary(rnd, val, mask)
                else: w = vary(rnd, 0, 0)
                c = cap_writes(w)
                f.write(struct.pack("<II", w, 0xFFFFFFFF if c is None else c))
        print(f"gen_match_writes: {a.truth[0]} words with Capstone {version}'s answer in {a.truth[1]}"); return
    tables, stats = measure(print)
    text = render(tables, stats, version)
    if a.fuzz:
        bad, exact, dec = fuzz(tables, a.fuzz, a.seed)
        print(f"fuzz: {dec} decoded words of {a.fuzz}: {exact} exact, {dec - exact - bad} answered \"written\" where Capstone lists less (safe), {bad} unsound")
        if bad: sys.exit(1)
    if a.check:
        if not os.path.exists(OUT) or open(OUT, encoding="utf-8").read() != text: sys.exit(f"[RED] gen_match_writes --check: {os.path.relpath(OUT)} is not what Capstone {version} gives (run tools/prepare/gen_match_writes.py)")
        print("gen_match_writes --check: up to date"); return
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f: f.write(text)
    print(f"gen_match_writes: wrote {os.path.relpath(OUT)} ({sum(len(runs(t)) for t in tables)} runs)")


if __name__ == "__main__":
    main()
