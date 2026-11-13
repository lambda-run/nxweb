// node em/tools/png_diff.mjs a.png b.png: two screenshots compared (8-bit RGB / RGBA PNGs, not interlaced): the mean
// absolute difference per channel value, the share of pixels where a channel differs by more than 8, and each
// picture's mean brightness (a black picture compares equal to another black one and proves nothing).
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
const png = (path) => { const b = readFileSync(path); let at = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (at < b.length) { const n = b.readUInt32BE(at), t = b.toString("latin1", at + 4, at + 8), d = b.subarray(at + 8, at + 8 + n);
    if (t === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; if (d[8] !== 8 || (ct !== 2 && ct !== 6) || d[12]) throw new Error(path + ": not an 8-bit RGB(A) PNG"); } else if (t === "IDAT") idat.push(d);
    at += 12 + n; }
  const bpp = ct === 6 ? 4 : 3, raw = inflateSync(Buffer.concat(idat)), px = new Uint8Array(w * h * bpp), row = w * bpp;
  for (let y = 0; y < h; y++) { const f = raw[y * (row + 1)], s = y * (row + 1) + 1, o = y * row;
    for (let x = 0; x < row; x++) { const a = x >= bpp ? px[o + x - bpp] : 0, u = y ? px[o + x - row] : 0, c = x >= bpp && y ? px[o + x - row - bpp] : 0; let v = raw[s + x];
      if (f === 1) v += a; else if (f === 2) v += u; else if (f === 3) v += (a + u) >> 1; else if (f === 4) { const p = a + u - c, pa = Math.abs(p - a), pb = Math.abs(p - u), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? u : c; }
      px[o + x] = v; } }
  return { w, h, bpp, px }; };
const A = png(process.argv[2]), B = png(process.argv[3]);
if (A.w !== B.w || A.h !== B.h) { console.log(`sizes differ: ${A.w}x${A.h} and ${B.w}x${B.h}`); process.exit(0); }
let sum = 0, over = 0, la = 0, lb = 0;
for (let i = 0; i < A.w * A.h; i++) { let big = false; for (let c = 0; c < 3; c++) { const a = A.px[i * A.bpp + c], b = B.px[i * B.bpp + c], d = Math.abs(a - b); sum += d; la += a; lb += b; if (d > 8) big = true; } if (big) over++; }
const n = A.w * A.h;
console.log(`${A.w}x${A.h}: mean difference ${(sum / n / 3).toFixed(2)} of 255, ${(100 * over / n).toFixed(2)} % of pixels differ by more than 8; mean brightness ${(la / n / 3).toFixed(1)} and ${(lb / n / 3).toFixed(1)}`);
