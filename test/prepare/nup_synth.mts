// Synthetic NUP containers for the prepare tests (SPEC v1, https://github.com/a55uka/nup): the writer of nxnative's
// dm/tools/tests/test_nsp_nup.py (write_nup) ported, with the offsets of what it wrote so that a test can damage a
// byte in a known place. Nothing here comes from a game. zstd frames are made with Node's own zlib (22.15+).
import { createHash } from "node:crypto";
import * as zlib from "node:zlib";
import type { Files } from "./synth.mts";

export const KIND = { base: 0, update: 1, addon: 2, addon_update: 3, system: 4 } as const;
export const T = { NAME: 5, NACP: 2, ICON: 3, LICONS: 10 } as const;
export const STANDALONE = 1;
export interface NupPackageIn { kind: number; titleId: bigint; version?: number; exefs?: Files; romfs?: Files; meta?: Uint8Array; flags?: number }
export interface NupOut {
  bytes: Uint8Array;
  tocOff: number; tocSize: number; blob: number;
  // where each file lies: "<package index>:<exefs|romfs>/<path>" -> its extent; file: its record's offset in the TOC
  extents: Map<string, { off: number; stored: number; codec: number; size: number; record: number }>;
  packageRecord(i: number): number;            // a package record's offset in the file
  dirRecord(i: number): number;
  slotsOff: number; slots: number; dirs: number; files: number;
}
export interface NupWriteOptions {
  // which files are stored as a zstd frame (default: every file of 200 bytes or more, as nxnative's test writer)
  compress?: (path: string, data: Uint8Array) => boolean;
  updateFlags?: number;                        // the flags of every update package (STANDALONE)
}
const enc = new TextEncoder();
const bytesOf = (v: Uint8Array | string) => typeof v === "string" ? enc.encode(v) : v;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest();
export const haveZstd = typeof (zlib as any).zstdCompressSync === "function";
export const zstd = (b: Uint8Array): Uint8Array => new Uint8Array((zlib as any).zstdCompressSync(b));
export const tlv = (recs: [number, Uint8Array | string][]): Uint8Array => {
  const parts = recs.map(([t, v]) => { const p = bytesOf(v), b = new Uint8Array(8 + p.length), dv = new DataView(b.buffer); dv.setUint16(0, t, true); dv.setUint32(4, p.length, true); b.set(p, 8); return b; });
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
// A console NACP's title entries (0x300 a language, Japanese the third) and display version
export function nacp(name: string, jp: string, display: string, publisher = ""): Uint8Array {
  const b = new Uint8Array(0x4000);
  b.set(enc.encode(name), 0); b.set(enc.encode(publisher), 0x200); b.set(enc.encode(jp), 2 * 0x300); b.set(enc.encode(display), 0x3060);
  return b;
}
export function localizedIcons(icons: [string, Uint8Array][]): Uint8Array {
  const parts: number[] = [];
  for (const [tag, data] of icons) { const t = enc.encode(tag); parts.push(t.length, ...t, data.length & 255, (data.length >> 8) & 255, (data.length >> 16) & 255, data.length >>> 24, ...data); }
  return Uint8Array.from(parts);
}

type Tree = { [name: string]: Uint8Array | Tree };
export function writeNup(packages: NupPackageIn[], o: NupWriteOptions = {}): NupOut {
  const dirs: [string, number, number][] = [], files: [string, Uint8Array, string][] = [], slots: (["f" | "d", number] | null)[] = [];
  const cmp = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const walk = (name: string, tree: Tree, label: string): number => {      // dirs pre-order, children contiguous and sorted
    const d = dirs.length; dirs.push([name, 0, 0]);
    const kids = Object.entries(tree).sort((a, b) => cmp(a[0], b[0])), first = slots.length;
    for (let j = 0; j < kids.length; j++) slots.push(null);
    dirs[d][1] = first; dirs[d][2] = kids.length;
    kids.forEach(([n, v], j) => { if (v instanceof Uint8Array) { slots[first + j] = ["f", files.length]; files.push([n, v, label + n]); } });
    kids.forEach(([n, v], j) => { if (!(v instanceof Uint8Array)) slots[first + j] = ["d", walk(n, v, label + n + "/")]; });
    return d;
  };
  const nest = (flat: Files): Tree => {
    const t: Tree = {};
    for (const [p, v] of Object.entries(flat)) { const parts = p.split("/"), f = parts.pop()!; let c = t; for (const x of parts) c = (c[x] ??= {}) as Tree; c[f] = bytesOf(v); }
    return t;
  };
  const recs: { tid: bigint; root: number; exefs: number; romfs: number; ver: number; kind: number; meta: Uint8Array; flags: number }[] = [];
  packages.forEach((k, pi) => {
    const t: Tree = {};
    if (k.exefs) t.exefs = Object.fromEntries(Object.entries(k.exefs).map(([n, v]) => [n, bytesOf(v)]));     // names as given, also ones that are no path component
    if (k.romfs) t.romfs = nest(k.romfs);
    const root = walk("", t, `${pi}:`), names = Object.keys(t).sort(cmp), sub: Record<string, number> = {};
    names.forEach((n, j) => { sub[n] = slots[dirs[root][1] + j]![1]; });
    recs.push({ tid: k.titleId, root, exefs: sub.exefs ?? 0xFFFFFFFF, romfs: sub.romfs ?? 0xFFFFFFFF, ver: k.version ?? 0, kind: k.kind, meta: k.meta ?? new Uint8Array(0), flags: k.flags ?? (k.kind === KIND.update ? o.updateFlags ?? 0 : 0) });
  });
  const pool: number[] = [];
  const name = (s: string): [number, number] => { const b = enc.encode(s), off = pool.length; pool.push(...b); return [off, b.length]; };
  const tocLen = 0x30 + recs.length * 0x40 + dirs.length * 0x18 + files.length * 0x50 + slots.length * 4, poolOff = tocLen;
  const namesD = dirs.map(d => name(d[0])), namesF = files.map(f => name(f[0]));
  const align = (n: number) => Math.ceil(n / 16) * 16;
  const tocSize = align(poolOff + pool.length);
  let pos = 0x80 + tocSize;
  const metas = recs.map(r => { const at = pos; pos = align(pos + r.meta.length); return at; });
  const blob = pos, blobs: [number, Uint8Array][] = [], ext: [number, number, number][] = [];
  const compress = o.compress ?? ((_p: string, d: Uint8Array) => d.length >= 200);
  for (const [, data, label] of files) {
    if (!data.length) { ext.push([0, 0, 0]); continue; }
    const z = compress(label.replace(/^\d+:/, ""), data), stored = z ? zstd(data) : data;
    ext.push([pos, stored.length, z ? 1 : 0]); blobs.push([pos, stored]); pos = align(pos + stored.length);
  }
  const toc = new Uint8Array(tocSize), tv = new DataView(toc.buffer);
  toc.set([0x54, 0x4F, 0x43, 1]); tv.setUint32(4, recs.length, true); tv.setBigUint64(8, BigInt(dirs.length), true); tv.setBigUint64(16, BigInt(files.length), true); tv.setBigUint64(24, BigInt(poolOff), true); tv.setBigUint64(32, BigInt(pool.length), true);
  let p = 0x30;
  const pkgAt = p;
  recs.forEach((r, i) => {
    tv.setBigUint64(p, r.tid, true); tv.setUint32(p + 8, r.root, true); tv.setUint32(p + 12, r.exefs, true); tv.setUint32(p + 16, r.romfs, true); tv.setUint32(p + 20, r.ver, true);
    toc[p + 24] = r.kind; toc[p + 25] = r.flags; tv.setBigUint64(p + 32, BigInt(r.meta.length ? metas[i] : 0), true); tv.setUint32(p + 40, r.meta.length, true); p += 0x40;
  });
  const dirAt = p;
  dirs.forEach((d, i) => { tv.setUint32(p, namesD[i][0], true); tv.setUint32(p + 4, namesD[i][1], true); tv.setUint32(p + 8, d[1], true); tv.setUint32(p + 12, d[2], true); p += 0x18; });
  const extents: NupOut["extents"] = new Map();
  files.forEach(([, data, label], i) => {
    tv.setUint32(p, namesF[i][0], true); tv.setUint32(p + 4, namesF[i][1], true); tv.setBigUint64(p + 8, BigInt(data.length), true); tv.setBigUint64(p + 16, BigInt(ext[i][0]), true); tv.setBigUint64(p + 24, BigInt(ext[i][1]), true);
    toc.set(sha(data), p + 32); toc[p + 64] = ext[i][2];
    extents.set(label, { off: ext[i][0], stored: ext[i][1], codec: ext[i][2], size: data.length, record: 0x80 + p });
    p += 0x50;
  });
  const slotsOff = 0x80 + p;
  for (const s of slots) { tv.setUint32(p, s![0] === "d" ? s![1] : dirs.length + s![1], true); p += 4; }
  toc.set(pool, p);
  const body = new Uint8Array(pos), bv = new DataView(body.buffer);
  body.set(toc, 0x80);
  recs.forEach((r, i) => body.set(r.meta, metas[i]));
  for (const [at, b] of blobs) body.set(b, at);
  body.set([0x4E, 0x55, 0x50, 1]); bv.setUint16(4, 0x80, true); bv.setUint16(6, 1, true); bv.setBigUint64(8, 0x80n, true); bv.setBigUint64(16, BigInt(tocSize), true);
  body.set(sha(toc), 24); bv.setBigUint64(56, BigInt(blob), true); bv.setBigUint64(64, BigInt(pos), true); bv.setUint32(72, recs.length, true);
  const idh = createHash("sha256"); for (const r of recs) { const b = Buffer.alloc(13); b.writeBigUInt64LE(r.tid, 0); b.writeUInt32LE(r.ver, 8); b[12] = r.kind; idh.update(b); }
  body.set(idh.digest().subarray(0, 16), 80);
  return { bytes: body, tocOff: 0x80, tocSize, blob, extents, packageRecord: i => 0x80 + pkgAt + i * 0x40, dirRecord: i => 0x80 + dirAt + i * 0x18, slotsOff, slots: slots.length, dirs: dirs.length, files: files.length };
}
// A copy with the table of contents changed and its SHA-256 in the superblock made right again: damage that only
// the record checks can find
export function retoc(n: NupOut, change: (file: Uint8Array, dv: DataView) => void): Uint8Array {
  const b = n.bytes.slice();
  change(b, new DataView(b.buffer));
  b.set(sha(b.subarray(n.tocOff, n.tocOff + n.tocSize)), 24);
  return b;
}
