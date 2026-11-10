#!/usr/bin/env python3
"""Reference vectors for the ASTC decoder (src/gfx/astc.ts): images compressed and decompressed by astcenc (the
astc-encoder-py module, `pip install astc-encoder-py`), an implementation independent of nxweb's, plus blocks of
random bytes (most are illegal or HDR: the error colour). Writes a JSON file; exits with status 3 and writes nothing
when the module is not installed (the tests then print SKIPPED).  usage: astc_ref.py out.json"""
import sys, json, base64, random
try:
    import astc_encoder as A
except Exception:
    sys.exit(3)

def image(kind, w, h, rnd):
    px = bytearray(w * h * 4)
    for y in range(h):
        for x in range(w):
            o = (y * w + x) * 4
            if kind == "noise": c = [rnd.randrange(256) for _ in range(4)]
            elif kind == "gradient": c = [x * 255 // max(1, w - 1), y * 255 // max(1, h - 1), (x + y) * 255 // max(1, w + h - 2), 255]
            elif kind == "alpha": c = [(x * 37) & 255, 255 - (y * 29) & 255, (x * y) & 255, (x * 255 // max(1, w - 1)) if (x // 4 + y // 4) & 1 else 255 - y * 255 // max(1, h - 1)]
            elif kind == "luma": l = (x * 13 + y * 7) & 255; c = [l, l, l, 255]
            elif kind == "luma-alpha": l = (x * 9 ^ y * 5) & 255; c = [l, l, l, (x * 255 // max(1, w - 1))]
            elif kind == "flat": c = [200, 100, 50, 255] if x < w // 2 else [10, 20, 30, 128]
            elif kind == "edges": c = [255, 0, 0, 255] if (x // 5 + y // 3) & 1 else ([0, 0, 255, 64] if x > y else [0, 255, 0, 255])
            else: c = [rnd.randrange(256), rnd.randrange(256), (x * 255 // max(1, w - 1)), 255 if rnd.random() < .7 else rnd.randrange(256)]
            px[o:o + 4] = bytes(c)
    return bytes(px)

def main(out):
    rnd = random.Random(1234)
    cases = []
    swz = A.ASTCSwizzle.from_str("RGBA")
    blocks = [(4, 4), (5, 4), (5, 5), (6, 5), (6, 6), (8, 5), (8, 6), (8, 8), (10, 5), (10, 6), (10, 8), (10, 10), (12, 10), (12, 12)]
    kinds = ["noise", "gradient", "alpha", "luma", "luma-alpha", "flat", "edges", "mixed"]
    n = 0
    for bi, (bx, by) in enumerate(blocks):
        for ki, kind in enumerate(kinds):
            srgb = (bi + ki) % 3 == 0
            w, h = 24 + 3 * ((bi + ki) % 5), 20 + 2 * ((bi * 3 + ki) % 7)       # not multiples of the block: the last blocks are cut
            quality = [10.0, 60.0, 98.0][(bi + ki) % 3]
            cfg = A.ASTCConfig(A.ASTCProfile.LDR_SRGB if srgb else A.ASTCProfile.LDR, bx, by, 1, quality)
            ctx = A.ASTCContext(cfg)
            comp = ctx.compress(A.ASTCImage(A.ASTCType.U8, w, h, 1, image(kind, w, h, rnd)), swz)
            dec = A.ASTCImage(A.ASTCType.U8, w, h, 1)
            ctx.decompress(comp, dec, swz)
            cases.append({"name": f"{kind} {bx}x{by}{' srgb' if srgb else ''} q{int(quality)}", "bw": bx, "bh": by, "w": w, "h": h, "srgb": srgb,
                          "astc": base64.b64encode(comp).decode(), "rgba": base64.b64encode(bytes(dec.data)).decode()})
            n += 1
    # whole blocks only (a device with ASTC holds such a texture at its exact size: the scenes compare draws from both)
    for bi, (bx, by) in enumerate([(4, 4), (6, 6), (8, 5), (10, 10), (12, 12), (5, 5), (8, 8)]):
        kind, srgb, w, h = kinds[(bi * 3 + 2) % len(kinds)], bi % 2 == 1, bx * 5, by * 4
        ctx = A.ASTCContext(A.ASTCConfig(A.ASTCProfile.LDR_SRGB if srgb else A.ASTCProfile.LDR, bx, by, 1, 60.0))
        comp = ctx.compress(A.ASTCImage(A.ASTCType.U8, w, h, 1, image(kind, w, h, rnd)), swz)
        dec = A.ASTCImage(A.ASTCType.U8, w, h, 1)
        ctx.decompress(comp, dec, swz)
        cases.append({"name": f"aligned {kind} {bx}x{by}{' srgb' if srgb else ''}", "bw": bx, "bh": by, "w": w, "h": h, "srgb": srgb, "aligned": True,
                      "astc": base64.b64encode(comp).decode(), "rgba": base64.b64encode(bytes(dec.data)).decode()})
    # random blocks: every bit pattern must decode to what astcenc gives (mostly the error colour)
    for (bx, by) in [(4, 4), (6, 6), (8, 5), (12, 12)]:
        for srgb in (False, True):
            nb = 16 * 12
            comp = bytes(rnd.randrange(256) for _ in range(nb * 16))
            w, h = bx * 16, by * 12
            ctx = A.ASTCContext(A.ASTCConfig(A.ASTCProfile.LDR_SRGB if srgb else A.ASTCProfile.LDR, bx, by, 1, 60.0))
            dec = A.ASTCImage(A.ASTCType.U8, w, h, 1)
            ctx.decompress(comp, dec, swz)
            cases.append({"name": f"random blocks {bx}x{by}{' srgb' if srgb else ''}", "bw": bx, "bh": by, "w": w, "h": h, "srgb": srgb, "random": True,
                          "astc": base64.b64encode(comp).decode(), "rgba": base64.b64encode(bytes(dec.data)).decode()})
    json.dump({"encoder": "astc-encoder-py (astcenc)", "cases": cases}, open(out, "w"))

main(sys.argv[1])
