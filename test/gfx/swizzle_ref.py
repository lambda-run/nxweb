#!/usr/bin/env python3
"""Reference block-linear (Tegra X1) texture storage for the nxweb graphics tests, independent of src/gfx.

Writes a JSON list of textures: for each, its description, its whole storage as the Switch lays it out, and the same
texels as plain rows per level and layer. The layout is computed here from the rules (GOBs of 64 x 8 bytes, block
height and depth in GOBs, levels packed in order, layers aligned to a block), and each byte is placed one at a time
by its address formula; the recorder's deswizzler works in 16-byte runs from a table, so the two share no code.
Usage: swizzle_ref.py out.json
"""
import base64, json, sys

FORMATS = {0x01: (1, 1, 1), 0x0d: (2, 1, 1), 0x25: (4, 1, 1), 0x29: (8, 1, 1), 0x2e: (16, 1, 1), 0x42: (8, 4, 4), 0x44: (16, 4, 4), 0x4d: (16, 4, 4)}   # bytes per block, block w, h

def ceil_div(a, b): return -(-a // b)
def mip(v, l): return max(1, v >> l)
def pick(gobs): return 4 if gobs >= 16 else 3 if gobs >= 8 else 2 if gobs >= 4 else 1 if gobs >= 2 else 0
def shrink(shift, unit, dim):
    """The block height (or depth) a level really uses: halved while half of it still covers the level."""
    while shift > 0 and (unit << (shift - 1)) >= dim: shift -= 1
    return shift

class Tex:
    def __init__(s, target, fmt, w, h, depth=1, levels=1, pkg=0):
        s.target, s.fmt, s.w, s.h, s.depth, s.levels, s.pkg = target, fmt, w, h, depth, levels, pkg
        s.bpb, s.bw, s.bh = FORMATS[fmt]
        s.is3d = target == 2
        s.layers = 6 if target == 8 else depth if target in (4, 9) else 1
        rows0 = ceil_div(h, s.bh)
        s.th = s.td = 0
        if pkg: s.th = (pkg - 1) & 15; s.td = ((pkg - 1) >> 4) if s.is3d else 0
        elif s.is3d: s.td = pick(depth + depth // 2)
        else: s.th = pick(rows0 * 3 // 16)
        s.level_off, off = [], 0
        for l in range(levels):
            s.level_off.append(off)
            rb, rows, sl, th, td = s.geom(l)
            off += ceil_div(rb, 64) * ceil_div(ceil_div(rows, 8), 1 << th) * ceil_div(sl, 1 << td) * (512 << (th + td))
        if s.layers > 1 or target in (4, 8, 9):       # a layer is a whole number of the blocks its level 0 uses
            th, td = s.th, s.td
            while th and rows0 <= (8 << (th - 1)): th -= 1
            unit = 512 << (th + td)
            off = ceil_div(off, unit) * unit
        s.layer_size = off
        s.size = off * s.layers
    def geom(s, l):
        rb = ceil_div(mip(s.w, l), s.bw) * s.bpb
        rows = ceil_div(mip(s.h, l), s.bh)
        sl = mip(s.depth, l) if s.is3d else 1
        return rb, rows, sl, shrink(s.th, 8, rows), shrink(s.td, 1, sl)
    def address(s, l, layer, xb, y, z):
        rb, rows, sl, th, td = s.geom(l)
        bh, bd = 1 << th, 1 << td
        gobs_x, blocks_y, block = ceil_div(rb, 64), ceil_div(rows, 8 * bh), 512 * bh * bd
        gob = (xb % 64 // 32) * 256 + (y % 8 // 2) * 64 + (xb % 32 // 16) * 32 + (y % 2) * 16 + xb % 16
        return (layer * s.layer_size + s.level_off[l] + (z // bd) * gobs_x * blocks_y * block + (y // (8 * bh)) * gobs_x * block + (xb // 64) * block
                + ((z % bd) * bh + (y % (8 * bh)) // 8) * 512 + gob)

def texel_bytes(seed, n):
    out, x = bytearray(n), (seed * 2654435761 + 12345) & 0xffffffff
    for i in range(n):
        x = (x * 1664525 + 1013904223) & 0xffffffff
        out[i] = x >> 24
    return out

def case(name, *a, **k):
    t = Tex(*a, **k)
    storage, levels = bytearray(t.size), []
    for layer in range(t.layers):
        for l in range(t.levels):
            rb, rows, sl, th, td = t.geom(l)
            lin = texel_bytes(len(levels) * 977 + t.w * 31 + t.fmt, rb * rows * sl)
            for z in range(sl):
                for y in range(rows):
                    for xb in range(rb): storage[t.address(l, layer, xb, y, z)] = lin[(z * rows + y) * rb + xb]
            levels.append({"level": l, "layer": layer, "rowBytes": rb, "rows": rows, "slices": sl, "tileH": th, "tileD": td, "linear": base64.b64encode(lin).decode()})
    return {"name": name, "desc": [t.target, t.fmt, 0, 0, t.w, t.h, t.depth, t.levels, 0, t.pkg], "size": t.size, "layerSize": t.layer_size, "storage": base64.b64encode(storage).decode(), "levels": levels}

CASES = [
    case("RGBA8 16x16", 1, 0x25, 16, 16),
    case("RGBA8 64x64, 7 levels", 1, 0x25, 64, 64, levels=7),
    case("RGBA8 100x60, 7 levels", 1, 0x25, 100, 60, levels=7),
    case("RGBA8 256x256, 9 levels (16-GOB blocks)", 1, 0x25, 256, 256, levels=9),
    case("R8 320x180, 3 levels", 1, 0x01, 320, 180, levels=3),
    case("RG8 37x21", 1, 0x0d, 37, 21),
    case("RGBA16F 33x17, 2 levels", 1, 0x29, 33, 17, levels=2),
    case("RGBA32F 20x20", 1, 0x2e, 20, 20),
    case("BC1 64x64, 7 levels", 1, 0x42, 64, 64, levels=7),
    case("BC3 100x100, 4 levels", 1, 0x44, 100, 100, levels=4),
    case("BC7 256x128, 3 levels", 1, 0x4d, 256, 128, levels=3),
    case("RGBA8 array 32x32x3, 3 levels", 4, 0x25, 32, 32, depth=3, levels=3),
    case("RGBA8 cube 16x16, 5 levels", 8, 0x25, 16, 16, levels=5),
    case("BC1 cube 64x64, 3 levels", 8, 0x42, 64, 64, levels=3),
    case("RGBA8 3D 16x16x8, 2 levels", 2, 0x25, 16, 16, depth=8, levels=2),
    case("R8 3D 32x32x32, 3 levels", 2, 0x01, 32, 32, depth=32, levels=3),
    case("RGBA8 64x64 packaged layout, block height 4 GOBs", 1, 0x25, 64, 64, levels=3, pkg=3),
    case("RGBA8 128x128 packaged layout, block height 1 GOB", 1, 0x25, 128, 128, levels=2, pkg=1),
]
json.dump(CASES, open(sys.argv[1], "w"))
print(f"swizzle_ref: {len(CASES)} textures, {sum(len(c['levels']) for c in CASES)} levels, {sum(c['size'] for c in CASES)} bytes of storage")
