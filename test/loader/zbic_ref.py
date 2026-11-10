#!/usr/bin/env python3
"""ZBIC streams from the reference codec (the `zbic` package: python3 -m pip install zbic), for the decoder's tests.

  zbic_ref.py check                         exit 0 when the package can be imported, 3 when it cannot
  zbic_ref.py fuzz SEED COUNT MAXSIZE OUT   COUNT generated inputs of varied statistics, each compressed at a level
                                            drawn from -7..22, written to OUT as a pack
  zbic_ref.py damage SEED COUNT OUT         COUNT streams of generated inputs, each damaged in one to three places (or cut
                                            short), with what the package makes of it: decoded (and to what) or refused
  zbic_ref.py fixtures OUT FILE...          the fixed set of test/loader/zbic_fixtures.bin: generated inputs chosen to
                                            reach every part of the format, and the given files (our test guests' code)
  zbic_ref.py pack LEVEL OUT FILE...        the given files, each compressed at LEVEL

A pack is a sequence of records: u32 name length, u32 level (signed), u32 raw length, u32 compressed length, 32 bytes
SHA-256 of the raw bytes, the name, the compressed bytes; `fuzz` packs also carry the raw bytes after them (flag bit 31
of the name length). Every stream is decompressed again by the package before it is written. A `damage` record has
flag bit 30, its level field is 1 when the package decoded the stream and 0 when it refused it, and its raw length and
SHA-256 are those of what the package decoded."""
import hashlib, random, struct, sys


def record(out, name, level, raw, keep_raw):
    import zbic
    comp = zbic.compress(raw, level)
    if not keep_raw: print(f'{len(comp):8} from {len(raw):8}  level {level:3}  {name}', file=sys.stderr)
    if zbic.decompress(comp) != raw: raise SystemExit(f'zbic_ref: {name}: the package does not decompress its own output')
    nm = name.encode()
    out.write(struct.pack('<IiII', len(nm) | (0x80000000 if keep_raw else 0), level, len(raw), len(comp)) + hashlib.sha256(raw).digest() + nm + comp)
    if keep_raw: out.write(raw)


def words(r, n, vocab=200, wl=(2, 9)):
    """Text of a small vocabulary: skewed letters (Huffman literals) and repeats at many distances"""
    v = [bytes(r.choice(b'etaoinshrdlucmfwypvbgkqjxz') for _ in range(r.randint(*wl))) for _ in range(vocab)]
    out = bytearray()
    while len(out) < n: out += r.choice(v) + (b' ' if r.random() < .9 else b'\n')
    return bytes(out[:n])


def skewed(r, n, k):
    """Independent bytes from k symbols with a geometric distribution: literals only, a Huffman tree of k leaves"""
    syms = r.sample(range(256), k)
    w = [0.5 ** (i * r.uniform(.2, 1.2)) for i in range(k)]
    return bytes(r.choices(syms, w, k=n))


def records(r, n, width):
    """Fixed-width records that differ in a few bytes: matches at one distance, the repeat offsets"""
    base = bytearray(r.randbytes(width))
    out = bytearray()
    while len(out) < n:
        for _ in range(r.randint(0, 3)): base[r.randrange(width)] = r.randrange(256)
        out += base
    return bytes(out[:n])


def code_like(r, n):
    """32-bit words with a few common high bytes, like AArch64 instructions"""
    tops = [0x91, 0xF9, 0xB9, 0x94, 0x97, 0xAA, 0x52, 0xD6, 0x54, 0x36, 0xA9, 0x71]
    out = bytearray()
    while len(out) < n:
        if r.random() < .15 and len(out) > 64:
            back = r.randrange(4, min(len(out), 4096), 4); ln = r.randrange(4, 64, 4)
            out += out[len(out) - back:len(out) - back + ln]
        else: out += struct.pack('<I', r.choice(tops) << 24 | r.getrandbits(r.choice((5, 10, 16, 24))))
    return bytes(out[:n])


def stitched(r, n, noise, mlen, lit):
    """`noise` random bytes, then copies of mlen bytes of them (mlen None: varied) separated by the literal bytes
    `lit` (None: one varied byte): with a fixed mlen every match has one length, with a fixed lit every literal of the
    later blocks is the same byte. A copy never continues into its neighbours, so the lengths are exact."""
    a = r.randbytes(noise)
    out = bytearray(a)
    while len(out) < n:
        m = mlen or r.randint(4, 40)
        at = r.randrange(1, noise - m - 1)
        sep = lit if lit is not None else bytes([r.randrange(256)])
        if sep[0] == a[at + m] or sep[-1] == a[at - 1] or out[-1] == a[at - 1]: continue
        out += a[at:at + m] + sep
    return bytes(out[:n])


def generate(r, maxsize):
    """(kind, bytes): one input"""
    n = r.choice((0, 1, 2, 3, 5, 8, 17, 60, 200, 255, 256, 257, 1000, 5000, 20000, 70000, 131071, 131072, 131073, 300000, maxsize))
    n = min(maxsize, n if r.random() < .5 else r.randint(0, min(maxsize, max(1, n * 2))))
    kind = r.choice(('random', 'zeros', 'run', 'words', 'skewed', 'records', 'code', 'mixed', 'sparse', 'far', 'flat', 'stitched'))
    if kind == 'random': d = r.randbytes(n)
    elif kind == 'zeros': d = bytes(n)
    elif kind == 'run': d = bytes([r.randrange(256)]) * n
    elif kind == 'words': d = words(r, n, r.choice((3, 20, 200, 3000)))
    elif kind == 'skewed': d = skewed(r, n, r.choice((2, 3, 5, 16, 60, 130, 256)))
    elif kind == 'records': d = records(r, n, r.choice((1, 2, 3, 4, 7, 8, 16, 24, 100, 1000)))
    elif kind == 'code': d = code_like(r, n)
    elif kind == 'flat': d = bytes(r.choices(range(r.choice((2, 4, 8, 16, 32, 64, 128))), k=n))   # every code the same length
    elif kind == 'stitched': d = stitched(r, n, r.choice((100, 2000, 131072, 140000)), r.choice((None, 4, 16, 40)), r.choice((None, b'\x00', b'ab', b'\x07')))
    elif kind == 'sparse':
        b = bytearray(n)
        for _ in range(n // r.choice((7, 50, 400)) + 1):
            if n: b[r.randrange(n)] = r.randrange(256)
        d = bytes(b)
    elif kind == 'far':   # a block of noise that comes back after more than one block of other data
        a = r.randbytes(min(n, r.choice((100, 3000, 40000))))
        d = (a + words(r, r.choice((1000, 140000, 400000))) + a + r.randbytes(50) + a)[:n]
    else:
        parts, left = [], n
        while left > 0:
            m = min(left, r.choice((10, 300, 5000, 50000, 140000)))
            parts.append(generate(r, m)[1][:m] or bytes(m)); left -= len(parts[-1])
        d = b''.join(parts)[:n]
    return kind, d


def main(a):
    if a[:1] == ['check']:
        try: import zbic   # noqa: F401
        except ImportError: return 3
        return 0
    if a[:1] == ['fuzz']:
        seed, count, maxsize = int(a[1]), int(a[2]), int(a[3])
        r = random.Random(seed)
        with open(a[4], 'wb') as out:
            for i in range(count):
                kind, d = generate(r, maxsize)
                level = r.choice((-7, -1, 1, 1, 2, 3, 3, 3, 4, 5, 6, 7, 9, 12, 15, 17, 19, 22))
                record(out, f'{seed}.{i}.{kind}', level, d, True)
        return 0
    if a[:1] == ['damage']:
        import zbic
        r = random.Random(int(a[1]))
        edges = (0, 1, 0x7F, 0x80, 0xFF, 0xFE, 0x20, 0x40)
        with open(a[3], 'wb') as out:
            n = 0
            while n < int(a[2]):
                kind, d = generate(r, r.choice((300, 3000, 30000, 150000)))
                comp = bytearray(zbic.compress(d, r.choice((-3, 1, 3, 3, 9, 19))))
                near = 40 if r.random() < .4 else len(comp)
                for _ in range(r.randint(1, 3)):
                    at = r.randrange(min(near, len(comp)))
                    how = r.randrange(5)
                    if how == 0: comp[at] ^= 1 << r.randrange(8)
                    elif how == 1: comp[at] = r.randrange(256)
                    elif how == 2: comp[at] = r.choice(edges)
                    elif how == 3: comp[at:] = comp[r.randrange(len(comp)):][:len(comp) - at].ljust(len(comp) - at, b'\0')
                    elif near == len(comp) and len(comp) > 12: del comp[r.randrange(9, len(comp)):]
                comp = bytes(comp)
                # the package allocates what the frame header declares, and wants it declared: leave those out
                fhd = comp[4] if len(comp) > 4 else 0
                fcs_len = (1 << (fhd >> 6)) if fhd >> 6 else (fhd >> 5 & 1)
                at = 5 + (0 if fhd >> 5 & 1 else 1) + (0, 1, 2, 4)[fhd & 3]
                if comp[:4] != b'ZBIC' or not fcs_len or len(comp) < at + fcs_len: continue
                size = int.from_bytes(comp[at:at + fcs_len], 'little') + (256 if fcs_len == 2 else 0)
                if size > 0x400000: continue
                try: got = zbic.decompress(comp)
                except zbic.error: got = None
                nm = f'{a[1]}.{n}.{kind}'.encode()
                out.write(struct.pack('<IiII', len(nm) | 0x40000000, int(got is not None), len(got or b''), len(comp)) + hashlib.sha256(got or b'').digest() + nm + comp)
                n += 1
        return 0
    if a[:1] == ['fixtures']:
        r = random.Random(22)
        with open(a[1], 'wb') as out:
            for f in a[2:]:
                d = open(f, 'rb').read()
                for level in (1, 3, 19): record(out, 'guest:' + f.replace('\\', '/').split('/')[-1], level, d, False)
            cases = [
                ('empty', 3, b''), ('one byte', 3, b'x'), ('short text', 3, b'the loader reads the header, the header names the segments'),
                ('random 1000', 3, r.randbytes(1000)), ('zeros 1000', 3, bytes(1000)), ('zeros 300000', 3, bytes(300000)), ('run 70000', 1, b'\x91' * 70000),
                ('two symbols', 3, skewed(r, 5000, 2)), ('skewed 16 x 200', 3, skewed(r, 200, 16)), ('skewed 60 x 15000', 3, skewed(r, 15000, 60)),
                ('skewed 256 x 30000', 5, skewed(r, 30000, 256)), ('skewed 130 x 900', 19, skewed(r, 900, 130)),
                ('words 20', 1, words(r, 30000, 20)), ('words 200', 3, words(r, 30000, 200)), ('words 3000', 19, words(r, 30000, 3000)), ('words fast', -5, words(r, 20000, 200)),
                ('records 4', 3, records(r, 20000, 4)), ('records 24', 9, records(r, 50000, 24)), ('records 1000', 19, records(r, 300000, 1000)),
                ('code', 3, code_like(r, 30000)), ('code best', 22, code_like(r, 60000)),
                ('far', 3, (lambda a: a + words(r, 140000, 20) + a + r.randbytes(50) + a)(r.randbytes(3000))),
                ('flat 2', 3, bytes(r.choices(range(2), k=3000))), ('flat 16', 3, bytes(r.choices(range(16), k=20000))), ('flat 128', 3, bytes(r.choices(range(128), k=9000))),
                ('stitched one length', 3, stitched(r, 150000, 3000, 40, None)), ('stitched one literal', 3, stitched(r, 150000, 3000, None, b'\x00')),
                ('stitched both', 19, stitched(r, 280000, 5000, 40, b'\x07')), ('stitched near', 1, stitched(r, 12000, 2000, 4, b'ab')),
                ('mixed', 3, b''.join((r.randbytes(9000), bytes(140000), words(r, 140000, 20), skewed(r, 20000, 5), records(r, 9000, 7), r.randbytes(77)))),
                ('mixed best', 19, b''.join((words(r, 9000, 20), r.randbytes(300), bytes(131072), records(r, 140000, 16), skewed(r, 20000, 3)))),
            ]
            for name, level, d in cases: record(out, name, level, d, False)
        return 0
    if a[:1] == ['pack']:
        with open(a[2], 'wb') as out:
            for f in a[3:]: record(out, f.replace('\\', '/').split('/')[-1], int(a[1]), open(f, 'rb').read(), True)
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
