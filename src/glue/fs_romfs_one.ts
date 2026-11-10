// A standard RomFS image that holds one file in its root directory, made in memory: what an embedder needs to hand a
// guest a single data file the user picked (the format is the one tools/mkromfs.py writes and src/fs/romfs.ts reads:
// a 0x50-byte header of ten u64, the data at 0x200, then the directory hash table, directory entries, file hash
// table and file entries). The file's bytes are not copied: the image is returned as the parts of a Blob.
const EMPTY = 0xFFFFFFFF;
function romHash(parent: number, name: Uint8Array): number {
  let h = (parent ^ 123456789) >>> 0;
  for (const c of name) h = (((h >>> 5) | (h << 27)) ^ c) >>> 0;
  return h;
}
// [head, the file's bytes, tail]: concatenated they are the image
export function romfsOfFile(name: string, bytes: Uint8Array): Uint8Array[] {
  const nm = new TextEncoder().encode(name);
  if (!nm.length || nm.includes(0x2f)) throw new Error("romfsOfFile: the name must be a plain file name");
  const DATA = 0x200, tables = (DATA + bytes.length + 3) & ~3, pad = tables - (DATA + bytes.length);
  const dirMeta = 0x18, fileMeta = 0x20 + ((nm.length + 3) & ~3), buckets = 3;
  const o1 = tables, o2 = o1 + buckets * 4, o3 = o2 + dirMeta, o4 = o3 + buckets * 4;
  const head = new Uint8Array(DATA), hv = new DataView(head.buffer);
  [0x50, o1, buckets * 4, o2, dirMeta, o3, buckets * 4, o4, fileMeta, DATA].forEach((v, i) => hv.setBigUint64(i * 8, BigInt(v), true));
  const tail = new Uint8Array(pad + buckets * 8 + dirMeta + fileMeta), tv = new DataView(tail.buffer);
  const u32 = (off: number, v: number) => tv.setUint32(pad + off, v, true);
  // the root directory: no parent, no sibling, no child directory, its first file is the entry at 0
  for (let i = 0; i < buckets; i++) u32(i * 4, EMPTY);
  u32((romHash(0, new Uint8Array(0)) % buckets) * 4, 0);
  const d = buckets * 4;
  u32(d, 0); u32(d + 4, EMPTY); u32(d + 8, EMPTY); u32(d + 12, 0); u32(d + 16, EMPTY); u32(d + 20, 0);
  const fh = d + dirMeta;
  for (let i = 0; i < buckets; i++) u32(fh + i * 4, EMPTY);
  u32(fh + (romHash(0, nm) % buckets) * 4, 0);
  const f = fh + buckets * 4;
  u32(f, 0); u32(f + 4, EMPTY); tv.setBigUint64(pad + f + 8, 0n, true); tv.setBigUint64(pad + f + 16, BigInt(bytes.length), true); u32(f + 24, EMPTY); u32(f + 28, nm.length);
  tail.set(nm, pad + f + 0x20);
  return [head, bytes, tail];
}
// The same as one array (a copy of the file's bytes)
export function romfsImageOfFile(name: string, bytes: Uint8Array): Uint8Array {
  const parts = romfsOfFile(name, bytes), out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
