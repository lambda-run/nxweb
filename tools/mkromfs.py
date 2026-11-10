#!/usr/bin/env python3
"""Build and read standard RomFS images (for the fs tests; no game data).

  mkromfs.py build <dir> <out.img> [--virtual <path>:<size>]...
  mkromfs.py synth <out.img> --seed N [--files N] [--dirs N] [--depth N] [--max-size N] [--max-name N] [--nonascii] [--virtual <path>:<size>]...
  mkromfs.py ls <img>                 one JSON object per line: {"path": hex, "type": "d"|"f", "size", "sha256"|"stamps"}
  mkromfs.py readat <img> <requests.json>   [[path hex, offset, length], ...] -> one hex string per line

Format (little endian): a 0x50-byte header of ten u64 (header size, then offset and size of the directory hash
table, directory metadata, file hash table, file metadata, then the data offset); a directory entry is
parent, sibling, first child directory, first file, next in hash bucket, name length (u32 each) and the name padded
to 4; a file entry is parent, sibling (u32), data offset, size (u64), next in hash bucket, name length (u32) and the
name. 0xFFFFFFFF means none. The hash of (parent offset, name) is rotate-right-5 / xor over the name's bytes,
seeded with parent ^ 123456789.

The builder (class Builder) and the reader (class Reader) share nothing but this description: the reader finds
everything from the root by following child and sibling links, and checks each entry through the hash tables too.

A virtual file has a size and no bytes on disk: its data is a hole of the image file (zeroes) with 8-byte stamps
(offset ^ 0x5A5A5A5A5A5A5A5A, little endian) at offset 0, at every multiple of 1 GiB and in its last 8 bytes.
That is how the tests get a file larger than 4 GB without writing one.
"""
import argparse, hashlib, json, os, random, struct, sys

EMPTY = 0xFFFFFFFF
STAMP = 0x5A5A5A5A5A5A5A5A
GIB = 1 << 30


def rom_hash(parent: int, name: bytes) -> int:
    h = parent ^ 123456789
    for c in name:
        h = ((h >> 5) | (h << 27)) & 0xFFFFFFFF
        h ^= c
    return h


def buckets(n: int) -> int:
    if n < 3:
        return 3
    if n < 19:
        return n | 1
    while any(n % p == 0 for p in (2, 3, 5, 7, 11, 13, 17)):
        n += 1
    return n


def stamp_offsets(size: int):
    if size < 8:
        return []
    offs = {0, size - 8}
    offs.update(o for o in range(GIB, size - 8, GIB))
    return sorted(offs)


def stamp(off: int) -> bytes:
    return struct.pack("<Q", off ^ STAMP)


# ----------------------------------------------------------------------------------------------- builder
class Dir:
    def __init__(self):
        self.dirs = {}    # name (bytes) -> Dir
        self.files = {}   # name (bytes) -> File
        self.off = 0


class File:
    def __init__(self, size=0, data=None, src=None, virtual=False):
        self.size, self.data, self.src, self.virtual = size, data, src, virtual
        self.off = 0       # in the file metadata table
        self.data_off = 0  # in the data section


class Builder:
    def __init__(self):
        self.root = Dir()

    def add_dir(self, parts):
        d = self.root
        for p in parts:
            if p in d.files:
                raise ValueError("a file is in the way: %r" % p)
            d = d.dirs.setdefault(p, Dir())
        return d

    def add_file(self, parts, f: File):
        d = self.add_dir(parts[:-1])
        if parts[-1] in d.dirs or parts[-1] in d.files:
            raise ValueError("duplicate name %r" % parts[-1])
        d.files[parts[-1]] = f

    def add_tree(self, top: str):
        topb = os.fsencode(top)
        for cur, dirs, files in os.walk(topb):
            rel = os.path.relpath(cur, topb)
            parts = [] if rel == b"." else rel.split(b"/")
            self.add_dir(parts)
            for name in files:
                p = os.path.join(cur, name)
                self.add_file(parts + [name], File(size=os.path.getsize(p), src=p))

    def write(self, out: str):
        # entry offsets: directories and files in depth-first order, names sorted by bytes
        dirs, files = [], []   # (entry, parent directory, name, next sibling or None)
        stack = [(self.root, None, b"", None)]
        while stack:
            d, parent, name, sib = stack.pop()
            dirs.append((d, parent, name, sib))
            fl = [(n, d.files[n]) for n in sorted(d.files)]
            for i, (n, f) in enumerate(fl):
                files.append((f, d, n, fl[i + 1][1] if i + 1 < len(fl) else None))
            sub = [(n, d.dirs[n]) for n in sorted(d.dirs)]
            d.first_dir = sub[0][1] if sub else None
            d.first_file = fl[0][1] if fl else None
            for i in reversed(range(len(sub))):
                stack.append((sub[i][1], d, sub[i][0], sub[i + 1][1] if i + 1 < len(sub) else None))
        off = 0
        for d, _, name, _ in dirs:
            d.off = off
            off += 0x18 + ((len(name) + 3) & ~3)
        dir_meta_size = off
        off = 0
        for f, _, name, _ in files:
            f.off = off
            off += 0x20 + ((len(name) + 3) & ~3)
        file_meta_size = off
        data_off = 0x200
        pos = 0
        for f, _, _, _ in files:
            pos = (pos + 15) & ~15
            f.data_off = pos
            pos += f.size
        data_size = pos

        nd, nf = buckets(len(dirs)), buckets(len(files))
        dh, fh = [EMPTY] * nd, [EMPTY] * nf
        dm, fm = bytearray(dir_meta_size), bytearray(file_meta_size)
        for d, parent, name, sib in dirs:
            poff = parent.off if parent is not None else 0
            b = rom_hash(poff, name) % nd
            struct.pack_into("<6I", dm, d.off, poff, sib.off if sib else EMPTY, d.first_dir.off if d.first_dir else EMPTY,
                             d.first_file.off if d.first_file else EMPTY, dh[b], len(name))
            dm[d.off + 0x18:d.off + 0x18 + len(name)] = name
            dh[b] = d.off
        for f, parent, name, sib in files:
            b = rom_hash(parent.off, name) % nf
            struct.pack_into("<IIQQII", fm, f.off, parent.off, sib.off if sib else EMPTY, f.data_off, f.size, fh[b], len(name))
            fm[f.off + 0x20:f.off + 0x20 + len(name)] = name
            fh[b] = f.off

        tables = (data_off + data_size + 3) & ~3
        dh_b, fh_b = struct.pack("<%dI" % nd, *dh), struct.pack("<%dI" % nf, *fh)
        o1 = tables
        o2 = o1 + len(dh_b)
        o3 = o2 + len(dm)
        o4 = o3 + len(fh_b)
        with open(out, "wb") as w:
            w.write(struct.pack("<10Q", 0x50, o1, len(dh_b), o2, len(dm), o3, len(fh_b), o4, len(fm), data_off))
            for f, _, _, _ in files:
                if not f.size:
                    continue
                w.seek(data_off + f.data_off)
                if f.virtual:
                    for so in stamp_offsets(f.size):
                        w.seek(data_off + f.data_off + so)
                        w.write(stamp(so))
                elif f.src is not None:
                    with open(f.src, "rb") as r:
                        while True:
                            chunk = r.read(1 << 20)
                            if not chunk:
                                break
                            w.write(chunk)
                else:
                    w.write(f.data)
            w.seek(tables)
            w.write(dh_b)
            w.write(dm)
            w.write(fh_b)
            w.write(fm)
        return {"dirs": len(dirs), "files": len(files), "size": o4 + len(fm)}


def synth(b: Builder, seed: int, nfiles: int, ndirs: int, depth: int, max_size: int, nonascii: bool, max_name: int = 0x300):
    rnd = random.Random(seed)

    def name():
        n = rnd.choice([1, 2, 3, 5, 8, 13, 31, 64]) if rnd.random() < 0.9 else rnd.randint(100, 0x300)
        n = min(n, max_name)
        if nonascii and rnd.random() < 0.3:
            # any byte but NUL, '/' and '\\' (a path cannot name a backslash: it is a separator): not valid UTF-8 in general
            s = bytes(rnd.choice([c for c in range(1, 256) if c not in (47, 92)]) for _ in range(n))
        else:
            s = bytes(rnd.choice(b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-. ") for _ in range(n))
        return s if s not in (b".", b"..") else b"x" + s

    all_dirs = [[]]
    for _ in range(ndirs):
        parent = rnd.choice(all_dirs)
        if len(parent) >= depth:
            parent = parent[:depth - 1]
        path = parent + [name()]
        try:
            b.add_dir(path)
            all_dirs.append(path)
        except ValueError:
            pass
    if depth > 4:   # one chain as deep as asked
        chain = []
        for i in range(depth):
            chain = chain + [b"deep%d" % i]
            b.add_dir(chain)
        all_dirs.append(chain)
    made = 0
    while made < nfiles:
        parent = rnd.choice(all_dirs)
        r = rnd.random()
        size = 0 if r < 0.1 else rnd.randint(1, 64) if r < 0.5 else rnd.randint(1, max_size)
        try:
            b.add_file(parent + [name()], File(size=size, data=rnd.randbytes(size)))
            made += 1
        except ValueError:
            pass


# ----------------------------------------------------------------------------------------------- reader
class Reader:
    def __init__(self, path: str):
        self.f = open(path, "rb")
        self.size = os.fstat(self.f.fileno()).st_size
        h = struct.unpack("<10Q", self._at(0, 0x50))
        if h[0] != 0x50:
            raise ValueError("not a RomFS image")
        self.dh = self._table(h[1], h[2])
        self.dm = self._at(h[3], h[4])
        self.fh = self._table(h[5], h[6])
        self.fm = self._at(h[7], h[8])
        self.data = h[9]

    def _at(self, off, n):
        if off + n > self.size:
            raise ValueError("read outside the image")
        self.f.seek(off)
        return self.f.read(n)

    def _table(self, off, n):
        raw = self._at(off, n)
        return struct.unpack("<%dI" % (n // 4), raw)

    def dir_entry(self, off):
        parent, sibling, child, file, nxt, n = struct.unpack_from("<6I", self.dm, off)
        return {"off": off, "parent": parent, "sibling": sibling, "child": child, "file": file, "next": nxt, "name": self.dm[off + 0x18:off + 0x18 + n]}

    def file_entry(self, off):
        parent, sibling, doff, size, nxt, n = struct.unpack_from("<IIQQII", self.fm, off)
        return {"off": off, "parent": parent, "sibling": sibling, "data": doff, "size": size, "next": nxt, "name": self.fm[off + 0x20:off + 0x20 + n]}

    def find_dir(self, parent, name):
        e = self.dh[rom_hash(parent, name) % len(self.dh)]
        while e != EMPTY:
            d = self.dir_entry(e)
            if d["parent"] == parent and d["name"] == name and e != 0:
                return d
            e = d["next"]
        return None

    def find_file(self, parent, name):
        e = self.fh[rom_hash(parent, name) % len(self.fh)]
        while e != EMPTY:
            f = self.file_entry(e)
            if f["parent"] == parent and f["name"] == name:
                return f
            e = f["next"]
        return None

    def walk(self):
        """Yield (path parts, 'd'|'f', entry) for everything below the root, by the tree links."""
        stack = [([], 0)]
        while stack:
            parts, off = stack.pop()
            d = self.dir_entry(off)
            f = d["file"]
            while f != EMPTY:
                fe = self.file_entry(f)
                assert self.find_file(off, fe["name"])["off"] == f, "file not found through the hash table"
                yield parts + [fe["name"]], "f", fe
                f = fe["sibling"]
            c = d["child"]
            while c != EMPTY:
                ce = self.dir_entry(c)
                assert self.find_dir(off, ce["name"])["off"] == c, "directory not found through the hash table"
                yield parts + [ce["name"]], "d", ce
                stack.append((parts + [ce["name"]], c))
                c = ce["sibling"]

    def lookup(self, parts):
        off = 0
        for i, p in enumerate(parts):
            d = self.find_dir(off, p)
            if d is not None:
                off = d["off"]
                continue
            if i == len(parts) - 1:
                return self.find_file(off, p)
            return None
        return self.dir_entry(off)

    def read(self, fe, off, n):
        if off >= fe["size"]:
            return b""
        n = min(n, fe["size"] - off)
        return self._at(self.data + fe["data"] + off, n)


def parse_virtual(specs):
    out = []
    for s in specs or []:
        path, size = s.rsplit(":", 1)
        out.append((os.fsencode(path).split(b"/"), int(size, 0)))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("build"); p.add_argument("dir"); p.add_argument("out"); p.add_argument("--virtual", action="append")
    p = sub.add_parser("synth"); p.add_argument("out"); p.add_argument("--seed", type=int, default=1)
    p.add_argument("--files", type=int, default=100); p.add_argument("--dirs", type=int, default=20); p.add_argument("--depth", type=int, default=4)
    p.add_argument("--max-size", type=int, default=4096); p.add_argument("--nonascii", action="store_true"); p.add_argument("--max-name", type=int, default=0x300); p.add_argument("--virtual", action="append")
    p = sub.add_parser("ls"); p.add_argument("img")
    p = sub.add_parser("readat"); p.add_argument("img"); p.add_argument("requests")
    a = ap.parse_args()

    if a.cmd in ("build", "synth"):
        b = Builder()
        if a.cmd == "build":
            b.add_tree(a.dir)
        else:
            synth(b, a.seed, a.files, a.dirs, a.depth, a.max_size, a.nonascii, a.max_name)
        for parts, size in parse_virtual(a.virtual):
            b.add_file(parts, File(size=size, virtual=True))
        print(json.dumps(b.write(a.out)))
    elif a.cmd == "ls":
        r = Reader(a.img)
        for parts, kind, e in r.walk():
            row = {"path": b"/".join(parts).hex(), "type": kind, "size": e.get("size", 0)}
            if kind == "f":
                if e["size"] <= 64 << 20:
                    row["sha256"] = hashlib.sha256(r.read(e, 0, e["size"])).hexdigest()
                else:
                    row["stamps"] = [[o, r.read(e, o, 8).hex()] for o in stamp_offsets(e["size"])]
            print(json.dumps(row))
    elif a.cmd == "readat":
        r = Reader(a.img)
        for path, off, n in json.load(open(a.requests)):
            e = r.lookup(bytes.fromhex(path).split(b"/") if path else [])
            print(r.read(e, off, n).hex() if e is not None and "data" in e else "-")


if __name__ == "__main__":
    main()
