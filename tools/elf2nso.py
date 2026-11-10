#!/usr/bin/env python3
"""An AArch64 ELF shared object → a Switch NSO (or NRO), for tests: real module files without any game or SDK data.

The ELF must be laid out like a Switch module (test/loader/src/module.ld, crt0.S): three PT_LOAD segments, text (R+X) at
address 0, then read-only data (R), then data (RW) with the bss as the tail of its memory size, each on a 4 KiB page;
the word at +4 is the offset of the MOD0 header (checked here).

  elf2nso.py in.so out.nso [--lz4[=text,ro,data]] [--zbic[=text,ro,data]] [--no-hash] [--literal] [--nro]
  elf2nso.py --recode in.nso out.nso [the same options]     an NSO written again with other compression

  --lz4       store the segments LZ4 block compressed (all three, or the ones named)
  --literal   with --lz4: literal-only blocks (no matches), the simplest valid stream
  --zbic      store the segments ZBIC compressed (NSO flag bit 7, system 22.0.0 on) with the `zbic` package
              (python3 -m pip install zbic); exit code 3 when it is not installed. --zbic-level=N: its level (3)
  --zbic-own  with --zbic: ZBIC streams written here (zbic_own), no package needed: raw literals and sequences coded
              with the format's predefined tables, so nothing of ZBIC's own table coding or of Huffman is in them
  --no-hash   leave the check-hash flags clear (and the hashes zero): a module Horizon loads without checking
  --nro       write an NRO instead: the image itself with the NRO0 header at 0x10 (never compressed, no hashes)

lz4_compress / lz4_decompress are a self-contained LZ4 block codec (the lz4 package is not needed)."""
import hashlib, struct, sys

PAGE = 0x1000
NAMES = ('text', 'ro', 'data')
PT_LOAD, PF_X, PF_W, PF_R = 1, 1, 2, 4
MINMATCH, LASTLITERALS, MFLIMIT = 4, 5, 12   # the LZ4 block format's end conditions


class Error(ValueError):
    pass


def _length(out, n):
    """The extension bytes of a length whose token nibble is 15"""
    while n >= 255:
        out.append(255); n -= 255
    out.append(n)


def _sequence(out, lit, mlen=0, off=0):
    """One sequence: the literals lit, then (mlen > 0) a match of mlen bytes at distance off"""
    ln, ml = len(lit), mlen - MINMATCH if mlen else 0
    out.append((min(ln, 15) << 4) | min(ml, 15))
    if ln >= 15: _length(out, ln - 15)
    out += lit
    if mlen:
        out += struct.pack('<H', off)
        if ml >= 15: _length(out, ml - 15)


def lz4_compress(d, literal_only=False):
    """d as one LZ4 block. Greedy matcher over a hash of 4-byte sequences; literal_only stores the bytes as they are.
    Follows the format's end rules: the last sequence is literals only, the last 5 bytes are literals, and no match
    starts within the last 12 bytes."""
    d, out, n = bytes(d), bytearray(), len(d)
    if literal_only or n < MFLIMIT + 1:
        _sequence(out, d)
        return bytes(out)
    table, anchor, i, limit = {}, 0, 0, n - MFLIMIT
    while i < limit:
        key = d[i:i + 4]
        cand = table.get(key)
        table[key] = i
        if cand is None or i - cand > 0xFFFF:
            i += 1
            continue
        m, end = 4, n - LASTLITERALS
        while i + m < end and d[cand + m] == d[i + m]: m += 1
        _sequence(out, d[anchor:i], m, i - cand)
        i += m
        anchor = i
    _sequence(out, d[anchor:])
    return bytes(out)


def lz4_decompress(d, size):
    """The block d decompressed, which must give exactly size bytes (the check elf2nso makes on its own output)"""
    out, i, n = bytearray(), 0, len(d)
    while i < n:
        tok = d[i]; i += 1
        ln = tok >> 4
        if ln == 15:
            while True:
                b = d[i]; i += 1; ln += b
                if b != 255: break
        if i + ln > n: raise Error('lz4: literals run past the end')
        out += d[i:i + ln]; i += ln
        if i == n: break
        off = d[i] | d[i + 1] << 8; i += 2
        ml = tok & 15
        if ml == 15:
            while True:
                b = d[i]; i += 1; ml += b
                if b != 255: break
        ml += MINMATCH
        if not off or off > len(out): raise Error('lz4: match before the start')
        for _ in range(ml): out.append(out[-off])
    if len(out) != size: raise Error(f'lz4: {len(out)} bytes, not {size}')
    return bytes(out)


class NoZbic(Error):
    pass


# ---- a small ZBIC compressor (Zstandard, RFC 8878, with the magic 'ZBIC'): raw literals, sequences with the
# predefined tables, real offsets only. Enough for module files a loader must decompress; the zbic package is the
# reference and checks these streams when it is installed. ----
_LL_DEF = [4, 3] + [2] * 11 + [1] * 3 + [2] * 9 + [3, 2] + [1] * 5 + [-1] * 4
_ML_DEF = [1, 4, 3] + [2] * 6 + [1] * 37 + [-1] * 7
_OF_DEF = [1] * 6 + [2] * 3 + [1] * 15 + [-1] * 5
_LL_BASE = list(range(16)) + [16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]
_LL_BITS = [0] * 16 + [1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
_ML_BASE = list(range(3, 35)) + [35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539]
_ML_BITS = [0] * 32 + [1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]


def _fse_table(norm, log):
    """The decoding table of a distribution: per state (symbol, bits to read, base of the next state)"""
    size, nxt = 1 << log, []
    high, spread = size - 1, [0] * size
    for sym, c in enumerate(norm):
        if c == -1: spread[high] = sym; high -= 1
        nxt.append(1 if c == -1 else c)
    step, pos = (size >> 1) + (size >> 3) + 3, 0
    for sym, c in enumerate(norm):
        for _ in range(max(c, 0)):
            spread[pos] = sym
            pos = (pos + step) & (size - 1)
            while pos > high: pos = (pos + step) & (size - 1)
    out = []
    for sym in spread:
        n = nxt[sym]; nxt[sym] += 1
        nb = log - (n.bit_length() - 1)
        out.append((sym, nb, (n << nb) - size))
    return out


_TABLES = None


def _code(v, base):
    c = len(base) - 1
    while base[c] > v: c -= 1
    return c


def _states(table, syms):
    """The decoder's state at each sequence, found from the last one back: the state of a symbol whose range of next
    states holds the state that follows"""
    by_sym = {}
    for u, (sym, nb, base) in enumerate(table): by_sym.setdefault(sym, []).append(u)
    out = [by_sym[syms[-1]][0]]
    for sym in reversed(syms[:-1]):
        out.append(next(u for u in by_sym[sym] if table[u][2] <= out[-1] < table[u][2] + (1 << table[u][1])))
    return out[::-1]


def _block(lits, seqs):
    """A compressed block: the literals raw, the sequences [(literal length, match length, offset)] in one bitstream"""
    global _TABLES
    _TABLES = _TABLES or (_fse_table(_LL_DEF, 6), _fse_table(_OF_DEF, 5), _fse_table(_ML_DEF, 6))
    n = len(lits)
    out = bytearray([n << 3] if n < 32 else struct.pack('<H', n << 4 | 4) if n < 4096 else struct.pack('<I', n << 4 | 12)[:3]) + lits
    k = len(seqs)
    if not k: return bytes(out) + b'\0'
    out += bytes([k]) if k < 128 else bytes([(k >> 8) + 0x80, k & 255]) if k < 0x7F00 else b'\xff' + struct.pack('<H', k - 0x7F00)
    out.append(0)                                  # all three tables predefined
    llc = [_code(ll, _LL_BASE) for ll, _, _ in seqs]
    mlc = [_code(ml, _ML_BASE) for _, ml, _ in seqs]
    ofc = [(off + 3).bit_length() - 1 for _, _, off in seqs]
    tl, to, tm = _TABLES
    sl, so, sm = _states(tl, llc), _states(to, ofc), _states(tm, mlc)
    acc = 1                                        # the bits in the order the decoder reads them, under the end mark
    def push(v, bits):
        nonlocal acc
        acc = acc << bits | v
    push(sl[0], 6); push(so[0], 5); push(sm[0], 6)
    for i, (ll, ml, off) in enumerate(seqs):
        push(off + 3 - (1 << ofc[i]), ofc[i]); push(ml - _ML_BASE[mlc[i]], _ML_BITS[mlc[i]]); push(ll - _LL_BASE[llc[i]], _LL_BITS[llc[i]])
        if i + 1 < k:
            for st, t in ((sl, tl), (sm, tm), (so, to)): push(st[i + 1] - t[st[i]][2], t[st[i]][1])
    return bytes(out) + acc.to_bytes((acc.bit_length() + 7) // 8, 'little')


def zbic_own(d):
    """d as one ZBIC frame (single segment, the content size in the header), in blocks of up to 128 KiB: compressed
    by a greedy matcher over a hash of 4-byte sequences, RLE when a block is one byte repeated, raw when neither helps"""
    d = bytes(d)
    out = bytearray(b'ZBIC')
    out += bytes([0x20, len(d)]) if len(d) < 256 else bytes([0xA0]) + struct.pack('<I', len(d))
    table = {}
    starts = list(range(0, len(d), 0x20000)) or [0]
    for start in starts:
        end, last = min(len(d), start + 0x20000), start == starts[-1]
        chunk = d[start:end]
        lits, seqs, anchor, i = bytearray(), [], start, start
        while i + 4 <= end:
            key = d[i:i + 4]
            cand = table.get(key)
            table[key] = i
            if cand is None or i - cand >= 1 << 28:
                i += 1
                continue
            m = 4
            while i + m < end and m < 65538 and d[cand + m] == d[i + m]: m += 1
            lits += d[anchor:i]
            seqs.append((i - anchor, m, i - cand))
            i += m
            anchor = i
        lits += d[anchor:end]
        body = _block(bytes(lits), seqs) if chunk else b''
        if len(chunk) > 8 and chunk == chunk[:1] * len(chunk): out += struct.pack('<I', len(chunk) << 3 | 2 | last)[:3] + chunk[:1]
        elif chunk and len(body) < len(chunk): out += struct.pack('<I', len(body) << 3 | 4 | last)[:3] + body
        else: out += struct.pack('<I', len(chunk) << 3 | last)[:3] + chunk
    return bytes(out)


def zbic_compress(d, level=3, own=False):
    """d as a ZBIC stream: by the zbic package, or (own) by zbic_own; checked with the package when it is there"""
    try: import zbic
    except ImportError:
        if not own: raise NoZbic('--zbic needs the zbic package (python3 -m pip install zbic); --zbic-own does without') from None
        return zbic_own(d)
    out = zbic_own(d) if own else zbic.compress(bytes(d), level)
    if zbic.decompress(out) != bytes(d): raise Error('zbic: the stream does not decompress to its input')
    return out


def read_nso(d):
    """(segments [(vaddr, bytes)], bss size, build id, module name) of an NSO with stored, LZ4 or ZBIC segments"""
    if d[:4] != b'NSO0' or len(d) < 0x100: raise Error('not an NSO')
    flags, = struct.unpack_from('<I', d, 0x0C)
    segs = []
    for i in range(3):
        fo, va, sz = struct.unpack_from('<III', d, 0x10 + i * 0x10)
        raw = d[fo:fo + sz]
        if flags >> i & 1:
            raw = d[fo:fo + struct.unpack_from('<I', d, 0x60 + i * 4)[0]]
            if flags & 0x80:
                try: import zbic
                except ImportError: raise NoZbic('reading a ZBIC NSO needs the zbic package (python3 -m pip install zbic)') from None
                raw = zbic.decompress(raw)
            else: raw = lz4_decompress(raw, sz)
        if len(raw) != sz: raise Error(f'{NAMES[i]} segment is {len(raw)} bytes, not {sz}')
        if flags >> (3 + i) & 1 and hashlib.sha256(raw).digest() != d[0xA0 + i * 0x20:0xC0 + i * 0x20]: raise Error(f'{NAMES[i]} segment does not match its hash')
        segs.append((va, raw))
    no, ns = struct.unpack_from('<I', d, 0x1C)[0], struct.unpack_from('<I', d, 0x2C)[0]
    return segs, struct.unpack_from('<I', d, 0x3C)[0], d[0x40:0x60], d[no:no + ns] or b'\0'


def read_elf(d):
    """(segments [(vaddr, bytes)] of text, ro, data; bss size; build id or None) of an ELF laid out as a module"""
    if d[:4] != b'\x7fELF' or d[4] != 2 or d[5] != 1: raise Error('not a little-endian ELF64')
    if struct.unpack_from('<H', d, 0x12)[0] != 183: raise Error('not AArch64')
    phoff, = struct.unpack_from('<Q', d, 0x20)
    phentsize, phnum = struct.unpack_from('<HH', d, 0x36)
    loads = []
    for i in range(phnum):
        p_type, p_flags, p_offset, p_vaddr, _, p_filesz, p_memsz, _ = struct.unpack_from('<IIQQQQQQ', d, phoff + i * phentsize)
        if p_type == PT_LOAD: loads.append((p_flags, p_offset, p_vaddr, p_filesz, p_memsz))
    if [f for f, *_ in loads] != [PF_R | PF_X, PF_R, PF_R | PF_W]:
        raise Error('the ELF needs exactly three PT_LOAD segments: R+X, R, R+W (link with test/loader/src/module.ld)')
    segs, at = [], 0
    for i, (_, off, va, fsz, msz) in enumerate(loads):
        if va % PAGE: raise Error(f'{NAMES[i]} segment at {va:#x} is not on a page')
        if va < at: raise Error(f'{NAMES[i]} segment overlaps the one before it')
        if i < 2 and msz != fsz: raise Error(f'{NAMES[i]} segment has bss')
        segs.append((va, d[off:off + fsz]))
        at = va + msz
    if segs[0][0]: raise Error('text is not at address 0')
    bss = loads[2][4] - loads[2][3]
    mod0, = struct.unpack_from('<I', segs[0][1], 4)
    img = bytearray(at)
    for va, b in segs: img[va:va + len(b)] = b
    if img[mod0:mod0 + 4] != b'MOD0': raise Error(f'no MOD0 header at the offset in the word at +4 ({mod0:#x}): link crt0.o first')
    # build id: the .note.gnu.build-id descriptor, if the linker made one
    build_id = None
    shoff, = struct.unpack_from('<Q', d, 0x28)
    shentsize, shnum = struct.unpack_from('<HH', d, 0x3A)
    for i in range(shnum):
        sh_type, = struct.unpack_from('<I', d, shoff + i * shentsize + 4)
        sh_off, sh_size = struct.unpack_from('<QQ', d, shoff + i * shentsize + 0x18)
        if sh_type == 7 and sh_size >= 16:   # SHT_NOTE
            namesz, descsz, ntype = struct.unpack_from('<III', d, sh_off)
            if ntype == 3: build_id = d[sh_off + 12 + (namesz + 3 & ~3):][:descsz]
    return segs, bss, build_id


def make_nso(segs, bss, build_id, compress=(False, False, False), hashes=True, literal_only=False, name=b'\0', zbic=None):
    """zbic: None for LZ4, or (level, own) for ZBIC (flag bit 7: every compressed segment of the module is then ZBIC)"""
    flags, at, body = 0, 0x100 + len(name), bytearray()
    hdr = bytearray(0x100)
    hdr[0:4] = b'NSO0'
    for i, (va, raw) in enumerate(segs):
        stored = raw
        if compress[i]:
            if zbic: stored = zbic_compress(raw, *zbic)
            else:
                stored = lz4_compress(raw, literal_only)
                if lz4_decompress(stored, len(raw)) != raw: raise Error('lz4: the block does not decompress to its input')
            if len(stored) > len(raw): stored = raw    # Horizon refuses a compressed segment larger than its data
            else: flags |= 1 << i
        struct.pack_into('<III', hdr, 0x10 + i * 0x10, at, va, len(raw))
        struct.pack_into('<I', hdr, 0x60 + i * 4, len(stored))
        if hashes:
            flags |= 8 << i
            hdr[0xA0 + i * 0x20:0xC0 + i * 0x20] = hashlib.sha256(raw).digest()
        body += stored; at += len(stored)
    if zbic and flags & 7: flags |= 0x80
    struct.pack_into('<I', hdr, 0x0C, flags)
    struct.pack_into('<I', hdr, 0x1C, 0x100)         # module name offset
    struct.pack_into('<I', hdr, 0x2C, len(name))     # module name size
    struct.pack_into('<I', hdr, 0x3C, bss)
    hdr[0x40:0x60] = (build_id or hashlib.sha256(b''.join(b for _, b in segs)).digest())[:0x20].ljust(0x20, b'\0')
    return bytes(hdr) + name + bytes(body)


def make_nro(segs, bss, build_id):
    """The image as an NRO: every segment padded to whole pages (the data's padding is taken from the bss)"""
    img, hdr_segs, end = bytearray(), [], 0
    for i, (va, raw) in enumerate(segs):
        if va != len(img): raise Error(f'{NAMES[i]} segment at {va:#x} does not follow the one before it (NRO segments are contiguous)')
        size = len(raw) + PAGE - 1 & ~(PAGE - 1)
        img += raw.ljust(size, b'\0')
        hdr_segs.append((va, size))
    pad = len(img) - (segs[2][0] + len(segs[2][1]))
    bss = max(0, bss - pad)
    if any(img[0x10:0x80]): raise Error('the 0x70 bytes at 0x10 are not free for the NRO header (link crt0.o first)')
    struct.pack_into('<4sIII', img, 0x10, b'NRO0', 0, len(img), 0)
    for i, (o, s) in enumerate(hdr_segs): struct.pack_into('<II', img, 0x20 + 8 * i, o, s)
    struct.pack_into('<I', img, 0x38, bss)
    img[0x40:0x60] = (build_id or hashlib.sha256(bytes(img)).digest())[:0x20].ljust(0x20, b'\0')
    return bytes(img)


def main(argv):
    args = [a for a in argv if not a.startswith('--')]
    opts = [a for a in argv if a.startswith('--')]
    if len(args) != 2: sys.exit(__doc__)
    compress, hashes, literal, nro, recode, zbic, level, zraw = [False] * 3, True, False, False, False, False, 3, False
    for o in opts:
        if o in ('--lz4', '--zbic'): compress = [True] * 3; zbic = zbic or o == '--zbic'
        elif o.startswith('--lz4=') or o.startswith('--zbic='):
            zbic = zbic or o.startswith('--zbic=')
            for n in o[o.index('=') + 1:].split(','):
                if n not in NAMES: sys.exit(f'[RED] elf2nso: no segment "{n}" (text, ro, data)')
                compress[NAMES.index(n)] = True
        elif o.startswith('--zbic-level='): level = int(o[13:])
        elif o == '--zbic-own': zraw = True
        elif o == '--recode': recode = True
        elif o == '--no-hash': hashes = False
        elif o == '--literal': literal = True
        elif o == '--nro': nro = True
        else: sys.exit(f'[RED] elf2nso: unknown option {o}')
    try:
        name = b'\0'
        with open(args[0], 'rb') as f:
            if recode: segs, bss, build_id, name = read_nso(f.read())
            else: segs, bss, build_id = read_elf(f.read())
        out = make_nro(segs, bss, build_id) if nro else make_nso(segs, bss, build_id, compress, hashes, literal, name, (level, zraw) if zbic else None)
    except NoZbic as e:
        print(f'[RED] elf2nso: {args[0]}: {e}', file=sys.stderr)
        sys.exit(3)
    except Error as e:
        sys.exit(f'[RED] elf2nso: {args[0]}: {e}')
    with open(args[1], 'wb') as f: f.write(out)


if __name__ == '__main__':
    main(sys.argv[1:])
