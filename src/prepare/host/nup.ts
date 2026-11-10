// A game in a NUP container (one .nup file: https://github.com/a55uka/nup, SPEC.md v1) as the prepare step's folder.
// The reader is nxnative's scripts/pack_nup.py, check for check: the superblock, the table of contents against its
// SHA-256, every record's bounds and reserved fields, what `scan` accepts (one base at most, updates by version, DLC
// by title ID, the two forms of "no base game"). The container is never read whole: the superblock and the table of
// contents once, then only the extents a read asks for.
//
// To the stages a container is a dump folder (detect.ts): base/, updates/<version>/, dlc/<title ID>/0/romfs/, each
// with exefs/ and romfs/. An update without romfs/ gets the base's (pack_nup.py romfs_of). A file's "modification
// time" in the listing is made from its SHA-256, so the stages' input hashes follow the content the container
// declares and a 10 GB file is not read to decide whether a stage can be skipped.
//
// File data: a raw file is a range of the container; a zstd file is one frame, decompressed whole on first use
// (fzstd) and kept in a bounded cache. A file is checked against its SHA-256 the first time all of it is in hand:
// always for zstd files and for raw files up to WHOLE_MAX (they are read whole on first use), and for larger raw
// files when one read asks for all of it.
import { decompress } from "fzstd";
import { PrepError } from "./detect.ts";
import { sortListing, type PrepTree, type TreeListing } from "./tree.ts";
import type { RomSource } from "./romdev.ts";

const IO = -2;                         // DEV.IO (src/glue/fs_host.ts)
const NO_DIR = 0xFFFFFFFF;
const BASE = 0, UPDATE = 1, ADDON = 2;
const KINDS = ["base", "update", "addon", "addon_update", "system"];
const STANDALONE = 1;                  // package flags bit 0: an update in a container without a base
const T_NACP = 2, T_ICON = 3, T_LICONS = 10;
const ARTIFACT = ".listing";           // a dump tool's file a producer may have kept (SPEC 6.3): not a game file
const TOC_MAX = 1 << 30;
const META_MAX = 64 << 20;
export const WHOLE_MAX = 8 << 20;      // raw files up to this size are read whole (and checked) on first use
export const SMALL_MAX = 4 << 20;      // files up to this size share the small cache
export const SMALL_CACHE = 32 << 20;   // the small cache's total
export const NO_BASE = "no base game in this NUP: its update is taken as the whole game (if the game then stops on missing files, the update holds only what changed: pack a NUP with the base game)";

// Where a container's bytes come from: a File / Blob in the page or a Worker, a descriptor under Node (nup_node.ts)
export interface NupBytes {
  readonly size: number;
  read(off: number, len: number): Promise<Uint8Array>;
  readSync?(off: number, dst: Uint8Array): number;    // 0, or not 0 on an error
  blob?: Blob;
}
export function blobBytes(file: Blob, sync = typeof (globalThis as any).FileReaderSync === "function"): NupBytes {
  let reader: any;
  return {
    size: file.size, blob: file,
    read: async (off, len) => new Uint8Array(await file.slice(off, off + len).arrayBuffer()),
    readSync: sync ? (off, dst) => {
      try { reader ??= new (globalThis as any).FileReaderSync(); const b = new Uint8Array(reader.readAsArrayBuffer(file.slice(off, off + dst.length))); if (b.length !== dst.length) return IO; dst.set(b); return 0; }
      catch { return IO; }
    } : undefined,
  };
}
export function memBytes(b: Uint8Array): NupBytes {
  return { size: b.length, read: async (off, len) => b.slice(off, off + len), readSync: (off, dst) => { if (off < 0 || off + dst.length > b.length) return IO; dst.set(b.subarray(off, off + dst.length)); return 0; } };
}

export interface NupFile { name: string; size: number; sha: string; off: number; stored: number; codec: number }   // codec 0 raw, 1 one zstd frame
export interface NupDir { name: string; first: number; count: number }
export interface NupPackage { index: number; titleId: bigint; root: number; exefs: number; romfs: number; version: number; kind: number; flags: number; metaOff: number; metaSize: number; label: string }
export interface NupControl { name: string | null; publisher: string | null; displayVersion: string | null; icon: Uint8Array | null; iconType: string }
// What a Worker needs to read files of the container: the File and the records of the files asked for
export interface NupPack { file: Blob; name: string; off: Float64Array; stored: Float64Array; codec: Uint8Array; sha: string[] }
export interface NupOptions {
  sha256: (b: Uint8Array) => string;                  // hex (PrepWasm.sha256)
  log?: (line: string) => void;
}
const hex = (b: Uint8Array) => { let s = ""; for (const v of b) s += v.toString(16).padStart(2, "0"); return s; };
const hex16 = (v: bigint) => v.toString(16).toUpperCase().padStart(16, "0");
const bad = (reason: "layout" | "read" | "version" | "dlc", msg: string) => new PrepError(reason, msg);

// The validated container (SPEC 6.1): superblock, table of contents, records
export class Nup {
  readonly bytes: NupBytes;
  readonly name: string;
  packages: NupPackage[] = [];
  dirs: NupDir[] = [];
  files: NupFile[] = [];
  slots: Uint32Array = new Uint32Array(0);
  tocSha = "";
  uuid = "";
  private constructor(bytes: NupBytes, name: string) { this.bytes = bytes; this.name = name; }

  static async open(bytes: NupBytes, name: string, sha256: (b: Uint8Array) => string): Promise<Nup> {
    const n = new Nup(bytes, name), size = bytes.size;
    const get = async (off: number, len: number): Promise<Uint8Array> => {
      let b: Uint8Array;
      try { b = await bytes.read(off, len); } catch (e) { throw bad("read", `${name}: could not be read at ${off} (${(e as Error).message})`); }
      if (b.length !== len) throw bad("read", `${name}: ${b.length} of ${len} bytes at ${off}`);
      return b;
    };
    if (!size) throw bad("layout", `${name}: empty file`);
    if (size < 0x80) throw bad("layout", `${name}: not a NUP (too short)`);
    const sb = await get(0, 0x80), sv = new DataView(sb.buffer, sb.byteOffset, sb.byteLength);
    const u64 = (v: DataView, at: number) => { const x = v.getBigUint64(at, true); return x > 0x1FFFFFFFFFFFFFn ? Number.MAX_SAFE_INTEGER : Number(x); };
    if (sb[0] !== 0x4E || sb[1] !== 0x55 || sb[2] !== 0x50) throw bad("layout", `${name}: not a NUP`);
    if (sb[3] !== 1) throw bad("layout", `${name}: NUP format version ${sb[3]}; this reads version 1`);
    const hsize = sv.getUint16(4, true), tocOff = u64(sv, 8), tocSize = u64(sv, 16), blob = u64(sv, 56), fsize = u64(sv, 64), npkg = sv.getUint32(72, true), flags = sv.getUint32(76, true);
    if (hsize < 0x80 || tocOff !== hsize || flags) throw bad("layout", `${name}: unsupported NUP header`);
    if (fsize !== size) throw bad("read", `${name}: ${size.toLocaleString("en-US")} bytes, its header says ${fsize.toLocaleString("en-US")} (copied or downloaded partly?)`);
    if (blob < tocOff + tocSize || blob % 16 || blob > fsize) throw bad("layout", `${name}: TOC and data regions overlap`);
    if (tocSize > TOC_MAX) throw bad("layout", `${name}: a table of contents of ${tocSize.toLocaleString("en-US")} bytes is more than this page reads`);
    const toc = await get(tocOff, tocSize), tv = new DataView(toc.buffer, toc.byteOffset, toc.byteLength);
    n.tocSha = hex(sb.subarray(24, 56)); n.uuid = hex(sb.subarray(80, 96));
    if (sha256(toc) !== n.tocSha) throw bad("read", `${name}: table of contents does not match its SHA-256 (damaged file)`);
    const malformed = () => bad("layout", `${name}: malformed table of contents`);
    if (toc.length < 0x30) throw malformed();
    const tpkg = tv.getUint32(4, true), ndirs = u64(tv, 8), nfiles = u64(tv, 16), poolOff = u64(tv, 24), poolSize = u64(tv, 32);
    const need = 0x30 + tpkg * 0x40 + ndirs * 0x18 + nfiles * 0x50;
    if (toc[0] !== 0x54 || toc[1] !== 0x4F || toc[2] !== 0x43 || toc[3] !== 1 || tpkg !== npkg || !npkg || toc.length < need || poolOff < need || poolOff + poolSize > toc.length || (poolOff - need) % 4) throw malformed();
    const dec = new TextDecoder();
    const nameAt = (off: number, len: number): string => {
      if (off + len > poolSize) throw bad("layout", `${name}: name out of bounds`);
      return dec.decode(toc.subarray(poolOff + off, poolOff + off + len));
    };
    let p = 0x30;
    for (let i = 0; i < npkg; i++, p += 0x40) {
      const k: NupPackage = { index: i, titleId: tv.getBigUint64(p, true), root: tv.getUint32(p + 8, true), exefs: tv.getUint32(p + 12, true), romfs: tv.getUint32(p + 16, true), version: tv.getUint32(p + 20, true),
        kind: toc[p + 24], flags: toc[p + 25], metaOff: u64(tv, p + 32), metaSize: tv.getUint32(p + 40, true), label: "" };
      if (k.kind >= KINDS.length) throw bad("layout", `${name}: package ${i} of unknown kind ${k.kind}`);
      if (tv.getUint16(p + 26, true) || tv.getUint32(p + 28, true) || k.flags & ~STANDALONE) throw bad("layout", `${name}: package ${i} has reserved fields or flags set`);
      k.label = `${name} (${KINDS[k.kind]}${k.kind === UPDATE ? " " + k.version : k.kind === ADDON ? " " + hex16(k.titleId) : ""})`;
      n.packages.push(k);
    }
    for (let i = 0; i < ndirs; i++, p += 0x18) n.dirs.push({ name: nameAt(tv.getUint32(p, true), tv.getUint32(p + 4, true)), first: tv.getUint32(p + 8, true), count: tv.getUint32(p + 12, true) });
    for (let i = 0; i < nfiles; i++, p += 0x50) {
      const fname = nameAt(tv.getUint32(p, true), tv.getUint32(p + 4, true)), fsz = u64(tv, p + 8), eoff = u64(tv, p + 16), esz = u64(tv, p + 24), codec = toc[p + 64], cflags = toc[p + 65];
      if ((codec !== 0 && codec !== 1) || cflags) throw bad("layout", `${name}: file ${JSON.stringify(fname)} uses codec ${codec}; this reads raw and zstd`);
      if (fsz && (eoff < blob || eoff + esz > fsize || eoff % 16 || !esz || (codec === 0 && esz !== fsz))) throw bad("layout", `${name}: file ${JSON.stringify(fname)} out of bounds`);
      if (!fsz && (eoff || esz || codec)) throw bad("layout", `${name}: empty file ${JSON.stringify(fname)} with data`);
      n.files.push({ name: fname, size: fsz, sha: hex(toc.subarray(p + 32, p + 64)), off: eoff, stored: esz, codec });
    }
    const nslots = (poolOff - p) / 4;
    n.slots = new Uint32Array(nslots);
    for (let i = 0; i < nslots; i++) n.slots[i] = tv.getUint32(p + 4 * i, true);
    for (const d of n.dirs) if (d.first + d.count > nslots) throw bad("layout", `${name}: folder ${JSON.stringify(d.name)} out of bounds`);
    for (const s of n.slots) if (s >= ndirs + nfiles) throw bad("layout", `${name}: child ${s} out of bounds`);
    for (const k of n.packages) if (k.root >= ndirs || [k.exefs, k.romfs].some(d => d !== NO_DIR && d >= ndirs) || (k.metaSize && k.metaOff + k.metaSize > fsize)) throw bad("layout", `${name}: package ${k.index} out of bounds`);
    return n;
  }

  // [name, is a folder, index into dirs or files] of folder d, sorted by name, artifacts left out
  children(d: number): { name: string; dir: boolean; i: number }[] {
    const { first, count } = this.dirs[d], out: { name: string; dir: boolean; i: number }[] = [], nd = this.dirs.length;
    for (let j = first; j < first + count; j++) {
      const s = this.slots[j];
      if (s < nd) out.push({ name: this.dirs[s].name, dir: true, i: s });
      else if (this.files[s - nd].name !== ARTIFACT) out.push({ name: this.files[s - nd].name, dir: false, i: s - nd });
    }
    return out.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }
  // Every file and folder under folder d: paths relative to it. A folder reached twice is a loop or a shared
  // subtree, which no packer writes: refused (a walk would not end).
  walk(d: number): { files: { path: string; i: number }[]; dirs: string[]; bytes: number } {
    const out = { files: [] as { path: string; i: number }[], dirs: [] as string[], bytes: 0 }, seen = new Set<number>([d]), stack: [number, string][] = [[d, ""]];
    while (stack.length) {
      const [at, prefix] = stack.pop()!;
      for (const c of this.children(at)) {
        if (c.name === "" || c.name === "." || c.name === ".." || c.name.includes("/") || c.name.includes("\0")) throw bad("layout", `${this.name}: invalid name ${JSON.stringify(c.name)} in the container`);
        if (c.dir) {
          if (seen.has(c.i)) throw bad("layout", `${this.name}: folder ${JSON.stringify(c.name)} is listed twice`);
          seen.add(c.i); out.dirs.push(prefix + c.name); stack.push([c.i, prefix + c.name + "/"]);
        } else { out.files.push({ path: prefix + c.name, i: c.i }); out.bytes += this.files[c.i].size; }
      }
    }
    return out;
  }
  // The package's meta block: { TLV type: payload }, the first record of a type
  async meta(k: NupPackage): Promise<Map<number, Uint8Array>> {
    const out = new Map<number, Uint8Array>();
    if (!k.metaSize || k.metaSize > META_MAX) return out;
    const b = await this.bytes.read(k.metaOff, k.metaSize), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let p = 0; p + 8 <= b.length;) {
      const t = v.getUint16(p, true), len = v.getUint32(p + 4, true); p += 8;
      if (p + len > b.length) throw bad("layout", `${this.name}: package ${k.index}: meta record 0x${t.toString(16)} runs past its block`);
      if (!out.has(t)) out.set(t, b.subarray(p, p + len));
      p += len;
    }
    return out;
  }
}

// What the container holds (pack_nup.py scan, without the program IDs: Detect reads those from the NPDMs)
export interface NupScan { base: NupPackage | null; updates: Map<number, NupPackage>; dlc: Map<string, NupPackage>; app: NupPackage; noBase: boolean; ignored: string[] }
export function scanNup(n: Nup): NupScan {
  const bases = n.packages.filter(k => k.kind === BASE), ups = n.packages.filter(k => k.kind === UPDATE);
  if (bases.length > 1) throw bad("layout", `${n.name}: ${bases.length} base packages`);
  if (!bases.length && (!ups.length || ups.some(k => !(k.flags & STANDALONE))))
    throw bad("layout", `${n.name}: no base game: pack the base game and its update into one NUP, or use updates marked standalone_update with complete exefs/ and romfs/`);
  const base = bases.length && n.walk(bases[0].root).bytes ? bases[0] : null;       // a base record with no files is no base game
  const updates = new Map<number, NupPackage>(), dlc = new Map<string, NupPackage>(), ignored: string[] = [];
  for (const k of n.packages) {
    if (k.kind === UPDATE) {
      if (updates.has(k.version)) throw bad("version", `${n.name}: two updates of version ${k.version}`);
      if (!k.version) throw bad("version", `${n.name}: an update of version 0`);
      updates.set(k.version, k);
    } else if (k.kind === ADDON) {
      const id = hex16(k.titleId);
      if (k.romfs === NO_DIR) throw bad("dlc", `${n.name}: DLC ${id} has no romfs/`);
      if (dlc.has(id)) throw bad("dlc", `${n.name}: DLC ${id} more than once`);
      dlc.set(id, k);
    } else if (k.kind !== BASE) ignored.push(k.label);
  }
  // the record that holds application metadata when no base game is there (SPEC 5.1)
  return { base, updates, dlc, app: bases[0] ?? n.packages[0], noBase: base === null, ignored };
}

// File data by index: ranges of raw files, zstd frames decompressed whole, each checked once against its SHA-256.
// Memory: the small cache (SMALL_CACHE in total, files up to SMALL_MAX) and the last file larger than that.
export class NupReader {
  readonly stats = { inflated: 0, verified: 0, wholeReads: 0, rangeReads: 0, cacheHits: 0, compressedBytes: 0, peakCache: 0 };
  private bytes: NupBytes; private files: NupFile[]; private o: Partial<NupOptions>; private label: string;
  private small = new Map<number, Uint8Array>(); private smallBytes = 0;
  private big: { i: number; data: Uint8Array } | null = null;
  private ok = new Set<number>();
  private loading = new Map<number, Promise<Uint8Array>>();
  constructor(bytes: NupBytes, files: NupFile[], label: string, o: Partial<NupOptions> = {}) { this.bytes = bytes; this.files = files; this.label = label; this.o = o; }
  get sync(): boolean { return !!this.bytes.readSync; }
  private cached(i: number): Uint8Array | undefined {
    const s = this.small.get(i);
    if (s) { this.small.delete(i); this.small.set(i, s); this.stats.cacheHits++; return s; }       // most recently used last
    if (this.big?.i === i) { this.stats.cacheHits++; return this.big.data; }
    return undefined;
  }
  private keep(i: number, data: Uint8Array): void {
    if (data.length > SMALL_MAX) this.big = { i, data };
    else {
      this.small.set(i, data); this.smallBytes += data.length;
      while (this.smallBytes > SMALL_CACHE) { const [old, b] = this.small.entries().next().value!; this.small.delete(old); this.smallBytes -= b.length; }
    }
    this.stats.peakCache = Math.max(this.stats.peakCache, this.smallBytes + (this.big?.data.length ?? 0));
  }
  private check(i: number, data: Uint8Array): void {
    const f = this.files[i];
    if (data.length !== f.size || (this.o.sha256 && this.o.sha256(data) !== f.sha)) throw new Error(`${this.label}: ${f.name} does not match its size or SHA-256 (damaged file)`);
    if (this.o.sha256) { this.ok.add(i); this.stats.verified++; }
  }
  private whole(i: number): boolean { const f = this.files[i]; return f.codec === 1 || (f.size <= WHOLE_MAX && !this.ok.has(i)); }
  private unpack(i: number, stored: Uint8Array): Uint8Array {
    const f = this.files[i];
    let data = stored;
    if (f.codec === 1) {
      this.stats.inflated++; this.stats.compressedBytes += stored.length;
      try { data = decompress(stored, new Uint8Array(f.size)); } catch (e) { throw new Error(`${this.label}: ${f.name}: zstd: ${(e as Error).message} (damaged file)`); }
    }
    this.stats.wholeReads++;
    this.check(i, data);
    this.keep(i, data);
    return data;
  }
  private fail(e: unknown): number { this.o.log?.(`[RED] prepare: ${(e as Error).message}`); return IO; }
  readSync(i: number, off: number, dst: Uint8Array): number {
    const f = this.files[i];
    if (!f || off < 0 || off + dst.length > f.size) return IO;
    if (!dst.length) return 0;
    try {
      let c = this.cached(i);
      if (!c && this.whole(i)) {
        const stored = new Uint8Array(f.stored);
        if (this.bytes.readSync!(f.off, stored)) throw new Error(`${this.label}: ${f.name} could not be read`);
        c = this.unpack(i, stored);
      }
      if (c) { dst.set(c.subarray(off, off + dst.length)); return 0; }
      this.stats.rangeReads++;
      if (this.bytes.readSync!(f.off + off, dst)) return IO;
      if (off === 0 && dst.length === f.size && !this.ok.has(i)) this.check(i, dst);
      return 0;
    } catch (e) { return this.fail(e); }
  }
  async read(i: number, off: number, len: number): Promise<Uint8Array> {
    const f = this.files[i];
    if (!f || off < 0 || off + len > f.size) throw new Error(`${this.label}: read outside ${f?.name ?? "the container"}`);
    if (!len) return new Uint8Array(0);
    let c = this.cached(i);
    if (!c && this.whole(i)) {
      let p = this.loading.get(i);
      if (!p) {
        p = (async () => { const stored = await this.bytes.read(f.off, f.stored); if (stored.length !== f.stored) throw new Error(`${this.label}: ${f.name}: ${stored.length} of ${f.stored} bytes (the file changed)`); return this.unpack(i, stored); })();
        this.loading.set(i, p); void p.finally(() => this.loading.delete(i)).catch(() => {});
      }
      c = await p;
    }
    if (c) return c.slice(off, off + len);
    this.stats.rangeReads++;
    const b = await this.bytes.read(f.off + off, len);
    if (b.length !== len) throw new Error(`${this.label}: ${f.name}: ${b.length} of ${len} bytes at ${off} (the file changed)`);
    if (off === 0 && len === f.size && !this.ok.has(i)) this.check(i, b);
    return b;
  }
}
// In the Worker: the files of a hand-off message's pack as the RomFS device's source
export function packSource(pack: NupPack, sizes: Float64Array, o: Partial<NupOptions> = {}): RomSource & { reader: NupReader } {
  const files: NupFile[] = Array.from(sizes, (size, i) => ({ name: `file ${i}`, size, sha: pack.sha[i], off: pack.off[i], stored: pack.stored[i], codec: pack.codec[i] }));
  const reader = new NupReader(blobBytes(pack.file), files, pack.name, o);
  return { reader, readSync: reader.sync ? (i, off, dst) => reader.readSync(i, off, dst) : undefined, read: (i, off, len) => reader.read(i, off, len) };
}

// The container as the folder the stages read
export class NupTree implements PrepTree {
  readonly name: string;
  readonly nup: Nup;
  readonly scan: NupScan;
  readonly reader: NupReader;
  readonly notes: string[] = [];
  private listing: TreeListing = { files: [], dirs: [] };
  private at = new Map<string, number>();              // path -> file index
  private roots = new Map<string, NupPackage>();       // "base/", "updates/<n>/" -> package
  readSync?: (path: string, off: number, dst: Uint8Array) => number;
  private constructor(nup: Nup, scan: NupScan, o: NupOptions) {
    this.nup = nup; this.scan = scan; this.name = nup.name;
    this.reader = new NupReader(nup.bytes, nup.files, nup.name, o);
    if (this.reader.sync) this.readSync = (path, off, dst) => { const i = this.at.get(path); return i === undefined ? IO : this.reader.readSync(i, off, dst); };
  }
  static async open(bytes: NupBytes, name: string, o: NupOptions): Promise<NupTree> {
    const nup = await Nup.open(bytes, name, o.sha256), t = new NupTree(nup, scanNup(nup), o);
    t.build();
    return t;
  }
  private build(): void {
    const { nup, scan } = this, dirs = new Set<string>(), files = this.listing.files;
    const addDir = (p: string) => { for (let d = p; d; d = d.slice(0, Math.max(0, d.lastIndexOf("/")))) dirs.add(d); };
    const mtime = (sha: string) => parseInt(sha.slice(0, 12), 16);       // 48 bits of the content's hash: the file's identity in the listing
    const put = (path: string, i: number) => { const f = nup.files[i]; this.at.set(path, i); files.push({ path, size: f.size, mtime: mtime(f.sha) }); };
    const tree = (d: number, prefix: string) => { addDir(prefix.slice(0, -1)); const w = nup.walk(d); for (const x of w.dirs) addDir(prefix + x); for (const f of w.files) put(prefix + f.path, f.i); };
    const version = (k: NupPackage, root: string) => {
      this.roots.set(root, k);
      if (k.exefs !== NO_DIR) {
        addDir(root + "exefs");
        for (const c of nup.children(k.exefs)) {
          if (c.dir) continue;
          if (c.name === "" || c.name === "." || c.name === ".." || c.name.includes("/") || c.name.includes("\\") || c.name.includes("\0")) throw bad("layout", `${nup.name}: invalid ExeFS name ${JSON.stringify(c.name)}`);
          if (!c.name.startsWith(".")) put(root + "exefs/" + c.name, c.i);
        }
      }
      // an update without romfs/ runs with the base game's
      const rom = k.romfs !== NO_DIR ? k.romfs : scan.base && scan.base.romfs !== NO_DIR ? scan.base.romfs : NO_DIR;
      if (rom !== NO_DIR) tree(rom, root + "romfs/");
      if (k.romfs === NO_DIR && rom !== NO_DIR) this.notes.push(`${k.label} has no romfs/: it runs with the base game's`);
    };
    if (scan.base) version(scan.base, "base/");
    for (const [v, k] of scan.updates) version(k, `updates/${v}/`);
    for (const [id, k] of scan.dlc) tree(k.romfs, `dlc/${id}/0/romfs/`);
    if (scan.noBase) this.notes.push(NO_BASE);
    for (const l of scan.ignored) this.notes.push(`${l}: packages of this kind are not used`);
    this.listing.dirs = [...dirs];
    sortListing(this.listing);
  }
  async list(onProgress?: (files: number) => void): Promise<TreeListing> {
    onProgress?.(this.listing.files.length);
    return { files: this.listing.files.slice(), dirs: this.listing.dirs.slice() };
  }
  async read(path: string, off: number, len: number): Promise<Uint8Array> {
    const i = this.at.get(path);
    if (i === undefined) throw new Error(`no file ${path} in ${this.name}`);
    return this.reader.read(i, off, len);
  }
  // A raw file is a range of the user's File; a compressed one has no Blob (the caller reads its bytes)
  blob(path: string): Blob | undefined {
    const i = this.at.get(path), f = i === undefined ? undefined : this.nup.files[i];
    return f && f.codec === 0 && this.nup.bytes.blob ? this.nup.bytes.blob.slice(f.off, f.off + f.size) : undefined;
  }
  pack(paths: string[]): NupPack {
    const blob = this.nup.bytes.blob;
    if (!blob) throw new Error("prepare: this container cannot be sent to a Worker (no Blob)");
    const fs = paths.map(p => this.nup.files[this.at.get(p)!]);
    return { file: blob, name: this.name, off: Float64Array.from(fs, f => f.off), stored: Float64Array.from(fs, f => f.stored), codec: Uint8Array.from(fs, f => f.codec), sha: fs.map(f => f.sha) };
  }
  // The control data of the version at `root` ("base/", "updates/<n>/"): the NACP's name and display version, the
  // icon. What the package lacks comes from the application record when there is no base game (pack_nup.py control).
  async control(root: string): Promise<NupControl | null> {
    const k = this.roots.get(root);
    if (!k) return null;
    try {
      const meta = this.scan.noBase && this.scan.app !== k ? await this.nup.meta(this.scan.app) : new Map<number, Uint8Array>();
      for (const [t, v] of await this.nup.meta(k)) meta.set(t, v);
      const nacp = meta.get(T_NACP), icons = localized(meta.get(T_LICONS)), icon = meta.get(T_ICON)?.length ? meta.get(T_ICON)! : icons.get("en-us") ?? icons.get("en") ?? icons.values().next().value ?? null;
      const title = nacp ? await nacpTitle(nacp) : null;
      if (!title && !icon) return null;
      return { name: title?.name ?? null, publisher: title?.publisher ?? null, displayVersion: title?.display ?? null, icon: icon ? icon.slice() : null,
        iconType: icon && icon[0] === 0x89 && icon[1] === 0x50 ? "image/png" : "image/jpeg" };
    } catch (e) { this.notes.push(`control data not read: ${(e as Error).message}`); return null; }
  }
}
// The localized icons record (TLV 0x000A): { lowercase language tag: image bytes }
function localized(payload?: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  if (!payload) return out;
  const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength), dec = new TextDecoder();
  for (let p = 0; p < payload.length;) {
    const ln = payload[p], tag = dec.decode(payload.subarray(p + 1, p + 1 + ln)).toLowerCase(); p += 1 + ln;
    if (p + 4 > payload.length) break;
    const dn = v.getUint32(p, true); p += 4;
    if (!out.has(tag)) out.set(tag, payload.subarray(p, p + dn));
    p += dn;
  }
  return out;
}
// A NACP's first non-empty title entry (0x300 a language: name 0x200, publisher 0x100; 0 = American English) and its
// display version (0x10 bytes at 0x3060). Newer SDKs store the title area as a u16 size and raw deflate (nxnative
// dm/tools/nacp.py): inflated where the platform has DecompressionStream.
export async function nacpTitle(b: Uint8Array): Promise<{ name: string; publisher: string; display: string | null } | null> {
  let t = b.subarray(0, 0x3000);
  if (b.length >= 2 && typeof (globalThis as any).DecompressionStream === "function") {
    try {
      const n = b[0] | b[1] << 8, ds = new (globalThis as any).DecompressionStream("deflate-raw"), w = ds.writable.getWriter();
      void w.write(b.slice(2, 2 + n)).catch(() => {}); void w.close().catch(() => {});
      const parts: Uint8Array[] = []; let total = 0;
      for (const r = ds.readable.getReader(); total <= 0x6000;) { const { done, value } = await r.read(); if (done) break; parts.push(value); total += value.length; }
      if (total === 0x6000) { t = new Uint8Array(total); let at = 0; for (const x of parts) { t.set(x, at); at += x.length; } }
    } catch { /* not compressed */ }
  }
  const str = (x: Uint8Array): string | null => {
    const end = x.indexOf(0), raw = x.subarray(0, end < 0 ? x.length : end);
    if (!raw.length) return null;
    try { const s = new TextDecoder("utf-8", { fatal: true }).decode(raw); return /[\u0000-\u001f\u007f]/.test(s) ? null : s; } catch { return null; }
  };
  const dm = /^\d+(\.\d+){0,3}/.exec(new TextDecoder().decode(b.subarray(0x3060, 0x3070)));
  for (let i = 0; i + 0x300 <= t.length; i += 0x300) {
    if (!t[i]) continue;
    const name = str(t.subarray(i, i + 0x200));
    return name ? { name, publisher: str(t.subarray(i + 0x200, i + 0x300)) ?? "", display: dm ? dm[0] : null } : null;
  }
  return null;
}
