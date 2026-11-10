// A synthetic NSO far larger than the fixed file staging range, made in the test from the stored (uncompressed) build
// of test/runtime/src/large.c: its two pads are filled here, then the file is written again with the text and the
// data LZ4 compressed and the read-only data stored, all three with their SHA-256. No Node APIs (Node and browser).

const MARK_RO = "LARGE-RO-PAD-0001", MARK_DATA = "LARGE-DATA-PAD-01";
const MINMATCH = 4, LASTLITERALS = 5, MFLIMIT = 12;

// One LZ4 block: a greedy matcher over a hash of 4-byte sequences, with the format's end rules (the last sequence is
// literals only, the last 5 bytes are literals, no match starts within the last 12 bytes)
export function lz4Compress(d: Uint8Array): Uint8Array {
  const n = d.length, out = new Uint8Array(n + Math.ceil(n / 255) + 16), table = new Int32Array(1 << 16).fill(-1);
  let o = 0, anchor = 0, i = 0;
  const seq = (litEnd: number, mlen: number, off: number) => {
    const ln = litEnd - anchor, ml = mlen ? mlen - MINMATCH : 0;
    out[o++] = (Math.min(ln, 15) << 4) | Math.min(ml, 15);
    if (ln >= 15) { let r = ln - 15; while (r >= 255) { out[o++] = 255; r -= 255; } out[o++] = r; }
    out.set(d.subarray(anchor, litEnd), o); o += ln;
    if (mlen) {
      out[o++] = off & 255; out[o++] = off >>> 8;
      if (ml >= 15) { let r = ml - 15; while (r >= 255) { out[o++] = 255; r -= 255; } out[o++] = r; }
    }
  };
  for (const limit = n - MFLIMIT, end = n - LASTLITERALS; i < limit;) {
    const v = d[i] | d[i + 1] << 8 | d[i + 2] << 16 | d[i + 3] << 24, h = Math.imul(v, 2654435761) >>> 16, c = table[h];
    table[h] = i;
    if (c < 0 || i - c > 0xFFFF || d[c] !== d[i] || d[c + 1] !== d[i + 1] || d[c + 2] !== d[i + 2] || d[c + 3] !== d[i + 3]) { i++; continue; }
    let m = 4;
    while (i + m < end && d[c + m] === d[i + m]) m++;
    seq(i, m, i - c);
    i += m; anchor = i;
  }
  seq(n, 0, 0);
  return out.slice(0, o);
}

// 32-bit FNV over little-endian words: what the guest computes
export function fnvWords(d: Uint8Array): number {
  const w = new Uint32Array(d.buffer, d.byteOffset, d.length >>> 2);
  let h = 2166136261;
  for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w[i], 16777619);
  return h >>> 0;
}
function find(d: Uint8Array, mark: string): number {
  const m = Array.from(mark, c => c.charCodeAt(0));
  for (let i = d.indexOf(m[0]); i >= 0; i = d.indexOf(m[0], i + 1)) if (m.every((v, k) => d[i + k] === v)) return i;
  throw new Error(`large_nso: no pad "${mark}" in the segment`);
}

export interface LargeNso { nso: Uint8Array; roSum: number; dataSum: number; roBytes: number; dataBytes: number; imageBytes: number; stored: number[] }
// stored: build/runtime/guests/large.nso (no segment compressed). roBytes / dataBytes: the pads' sizes in large.c
export async function makeLargeNso(stored: Uint8Array, roBytes = 40 << 20, dataBytes = 24 << 20): Promise<LargeNso> {
  const dv = new DataView(stored.buffer, stored.byteOffset, stored.length);
  if (dv.getUint32(0, true) !== 0x304F534E || (dv.getUint32(0x0C, true) & 7)) throw new Error("large_nso: not an NSO with stored segments");
  const seg = [0, 1, 2].map(i => ({ mo: dv.getUint32(0x14 + 16 * i, true), raw: stored.slice(dv.getUint32(0x10 + 16 * i, true), dv.getUint32(0x10 + 16 * i, true) + dv.getUint32(0x18 + 16 * i, true)) }));
  // read-only data: noise (it does not compress; it is stored as it is)
  const ro = seg[1].raw, r0 = find(ro, MARK_RO);
  let x = 0x9E3779B9;
  for (let i = r0; i < r0 + roBytes; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; ro[i] = x >>> 11; }
  // data: per 4 KiB, 256 bytes of noise, then a repeating pattern that changes slowly (literals and long matches)
  const da = seg[2].raw, d0 = find(da, MARK_DATA);
  for (let i = 0; i < dataBytes; i++) {
    if ((i & 0xFFF) < 256) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; da[d0 + i] = x >>> 9; }
    else da[d0 + i] = (i * 7 + (i >>> 16)) & 0xFF;
  }
  const roSum = fnvWords(ro.subarray(r0, r0 + roBytes)), dataSum = fnvWords(da.subarray(d0, d0 + dataBytes));
  const body = [lz4Compress(seg[0].raw), ro, lz4Compress(da)], compressed = [true, false, true];
  if (body[0].length > seg[0].raw.length) { body[0] = seg[0].raw; compressed[0] = false; }
  const nameLen = dv.getUint32(0x2C, true), head = 0x100 + nameLen;
  const nso = new Uint8Array(head + body.reduce((a, b) => a + b.length, 0)), out = new DataView(nso.buffer);
  nso.set(stored.subarray(0, head));
  let at = head, flags = 0;
  for (let i = 0; i < 3; i++) {
    nso.set(body[i], at);
    out.setUint32(0x10 + 16 * i, at, true);
    out.setUint32(0x60 + 4 * i, body[i].length, true);
    nso.set(new Uint8Array(await crypto.subtle.digest("SHA-256", seg[i].raw)), 0xA0 + 0x20 * i);
    flags |= (compressed[i] ? 1 << i : 0) | 8 << i;
    at += body[i].length;
  }
  out.setUint32(0x0C, flags, true);
  const imageBytes = Math.ceil((seg[2].mo + da.length + dv.getUint32(0x3C, true)) / 4096) * 4096;
  return { nso, roSum, dataSum, roBytes, dataBytes, imageBytes, stored: body.map(b => b.length) };
}
