#!/usr/bin/env python3
"""An AArch64 ELF shared object → a Switch NSO (or NRO), for tests: real module files without any game or SDK data.

The ELF must be laid out like a Switch module (test/loader/src/module.ld, crt0.S): three PT_LOAD segments, text (R+X) at
address 0, then read-only data (R), then data (RW) with the bss as the tail of its memory size, each on a 4 KiB page;
the word at +4 is the offset of the MOD0 header (checked here).

  elf2nso.py in.so out.nso [--lz4[=text,ro,data]] [--no-hash] [--literal] [--nro]

  --lz4       store the segments LZ4 block compressed (all three, or the ones named)
  --literal   with --lz4: literal-only blocks (no matches), the simplest valid stream
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


def make_nso(segs, bss, build_id, compress=(False, False, False), hashes=True, literal_only=False, name=b'\0'):
    flags, at, body = 0, 0x100 + len(name), bytearray()
    hdr = bytearray(0x100)
    hdr[0:4] = b'NSO0'
    for i, (va, raw) in enumerate(segs):
        stored = raw
        if compress[i]:
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
    compress, hashes, literal, nro = [False] * 3, True, False, False
    for o in opts:
        if o == '--lz4': compress = [True] * 3
        elif o.startswith('--lz4='):
            for n in o[6:].split(','):
                if n not in NAMES: sys.exit(f'[RED] elf2nso: no segment "{n}" (text, ro, data)')
                compress[NAMES.index(n)] = True
        elif o == '--no-hash': hashes = False
        elif o == '--literal': literal = True
        elif o == '--nro': nro = True
        else: sys.exit(f'[RED] elf2nso: unknown option {o}')
    try:
        with open(args[0], 'rb') as f: segs, bss, build_id = read_elf(f.read())
        out = make_nro(segs, bss, build_id) if nro else make_nso(segs, bss, build_id, compress, hashes, literal)
    except Error as e:
        sys.exit(f'[RED] elf2nso: {args[0]}: {e}')
    with open(args[1], 'wb') as f: f.write(out)


if __name__ == '__main__':
    main(sys.argv[1:])
