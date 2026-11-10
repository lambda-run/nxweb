// The RomFS device of a game that stays a folder: a virtual standard RomFS image whose header and tables are bytes
// in memory (built by src/prepare/romfs_build.ts) and whose data section is the files themselves, each read where
// it lies. src/fs mounts it like any image: it reads the tables once at mount (and checks them completely), then
// one dev_read per ReadFile, which lands here as one read of one file. Nothing is copied but what a read asks for.
import { DEV, FS_KIND, type FsDevice, type FsStorage } from "../../glue/fs_host.ts";
import type { PrepTree } from "./tree.ts";

export interface RomIndex {
  tables: Uint8Array;        // header + the four tables: the image's bytes from 0
  starts: Float64Array;      // per file: its first byte in the image (ascending)
  sizes: Float64Array;       // per file: its length
  size: number;              // the image's length
}
// Where the bytes of file i come from
export interface RomSource {
  readSync?(i: number, off: number, dst: Uint8Array): number;        // 0 or a DEV status
  read(i: number, off: number, len: number): Promise<Uint8Array>;
}
export const treeSource = (tree: PrepTree, paths: string[], sync = true): RomSource => ({
  readSync: sync && tree.readSync ? (i, off, dst) => tree.readSync!(paths[i], off, dst) ? DEV.IO : DEV.OK : undefined,
  read: (i, off, len) => tree.read(paths[i], off, len),
});
// Files as Blobs (what a Worker gets from the page): synchronous with FileReaderSync, else asynchronous
export function blobSource(blobs: Blob[], sync = typeof (globalThis as any).FileReaderSync === "function"): RomSource {
  let reader: any;
  return {
    readSync: sync ? (i, off, dst) => {
      try { reader ??= new (globalThis as any).FileReaderSync(); const b = new Uint8Array(reader.readAsArrayBuffer(blobs[i].slice(off, off + dst.length))); if (b.length !== dst.length) return DEV.IO; dst.set(b); return DEV.OK; }
      catch { return DEV.IO; }
    } : undefined,
    read: async (i, off, len) => new Uint8Array(await blobs[i].slice(off, off + len).arrayBuffer()),
  };
}

export class DirRomDevice implements FsDevice {
  readonly index: RomIndex;
  private src: RomSource;
  stats = { reads: 0, bytes: 0, tableReads: 0, fileReads: 0, padBytes: 0 };
  readSync?: (off: number, dst: Uint8Array) => number;
  constructor(index: RomIndex, src: RomSource) {
    this.index = index; this.src = src;
    if (src.readSync) this.readSync = (off, dst) => this.sync(off, dst);
  }
  size(): number { return this.index.size; }
  // the last file that starts at or before off, or -1
  private fileAt(off: number): number {
    const s = this.index.starts;
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (s[mid] <= off) lo = mid + 1; else hi = mid; }
    return lo - 1;
  }
  // The pieces of [off, off + len): table bytes, file ranges, zeros (padding between files and after the tables)
  private *pieces(off: number, len: number): Generator<{ at: number; n: number; file: number; fileOff: number }> {
    const { tables, starts, sizes } = this.index;
    let at = off; const end = off + len;
    while (at < end) {
      if (at < tables.length) { const n = Math.min(end, tables.length) - at; yield { at, n, file: -2, fileOff: at }; at += n; continue; }
      const i = this.fileAt(at);
      if (i >= 0 && at < starts[i] + sizes[i]) { const n = Math.min(end, starts[i] + sizes[i]) - at; yield { at, n, file: i, fileOff: at - starts[i] }; at += n; continue; }
      const next = i + 1 < starts.length ? starts[i + 1] : this.index.size;
      const n = Math.min(end, Math.max(next, at + 1)) - at;
      yield { at, n, file: -1, fileOff: 0 }; at += n;
    }
  }
  private sync(off: number, dst: Uint8Array): number {
    if (off < 0 || off + dst.length > this.index.size) return DEV.IO;
    this.stats.reads++; this.stats.bytes += dst.length;
    for (const p of this.pieces(off, dst.length)) {
      const out = dst.subarray(p.at - off, p.at - off + p.n);
      if (p.file === -2) { out.set(this.index.tables.subarray(p.fileOff, p.fileOff + p.n)); this.stats.tableReads++; }
      else if (p.file === -1) { out.fill(0); this.stats.padBytes += p.n; }
      else { this.stats.fileReads++; const r = this.src.readSync!(p.file, p.fileOff, out); if (r) return r; }
    }
    return DEV.OK;
  }
  async readAsync(off: number, len: number): Promise<Uint8Array> {
    if (off < 0 || off + len > this.index.size) throw new Error("read outside the image");
    this.stats.reads++; this.stats.bytes += len;
    const dst = new Uint8Array(len);
    for (const p of this.pieces(off, len)) {
      if (p.file === -2) { dst.set(this.index.tables.subarray(p.fileOff, p.fileOff + p.n), p.at - off); this.stats.tableReads++; }
      else if (p.file === -1) this.stats.padBytes += p.n;
      else { this.stats.fileReads++; const b = await this.src.read(p.file, p.fileOff, p.n); if (b.length !== p.n) throw new Error("short read"); dst.set(b, p.at - off); }
    }
    return dst;
  }
}

// The game's images (the RomFS, add-on contents by index) in front of whatever storage keeps the saves
export class PrepStorage implements FsStorage {
  private rom: FsDevice | null;
  private aoc: Map<number, FsDevice>;
  private saves: FsStorage;
  constructor(rom: FsDevice | null, aoc: Map<number, FsDevice>, saves: FsStorage) { this.rom = rom; this.aoc = aoc; this.saves = saves; }
  open(kind: number, index: bigint): FsDevice | number | Promise<FsDevice | number> {
    if (kind === FS_KIND.ROM) return this.rom ?? DEV.NOT_FOUND;
    if (kind === FS_KIND.AOC) return this.aoc.get(Number(index)) ?? DEV.NOT_FOUND;
    return this.saves.open(kind, index);
  }
  remove(kind: number, index: bigint): number | Promise<number> { return this.saves.remove(kind, index); }
  close(): void { (this.saves as { close?: () => void }).close?.(); }
}
