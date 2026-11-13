// nxem: the game's RomFS out of the container without unpacking it (the owner, owner.ts romStorage, and the fs worker,
// fs_worker.ts, each build one): the tables are built once from the listing (src/prepare/romfs_build.ts, as the prepare
// step's Index stage does), a read is a read of the container.
import type { PrepTree } from "../../src/prepare/host/tree.ts";
import { DirRomDevice, treeSource } from "../../src/prepare/host/romdev.ts";
import type { PrepWasm } from "../../src/prepare/host/wasm.ts";

// ?skipmovie=1, a test aid: a story movie (Dm_*.webm, not the title's) is read as a VALID short WebM that ends after
// its first cluster: the file's size is the start of its second cluster, and three places of its head are patched in
// every read so that the stream says so itself: the Segment's size (a parser that finds the file shorter than the
// Segment says waits for more data and never ends: seen in Chrome, the game sat on the last picture), the Duration in
// Info (the second cluster's timecode), and the SeekHead's entries that point past the cut (the Cues), which become
// Void elements. Returns null when the file is not cut (not a WebM, one cluster, an element of unknown size).
export const SKIP_MOVIE = /(^|\/)Dm_(?!Title)[^/]*\.webm$/;
export interface WebmCut { size: number; patches: { off: number; bytes: Uint8Array }[]; ms: number }
export async function webmCut(read: (off: number, len: number) => Promise<Uint8Array>, size: number, keep = 1): Promise<WebmCut | null> {
  const head = await read(0, Math.min(4096, size));
  const bytes = async (at: number, n: number) => at + n <= head.length ? head.subarray(at, at + n) : read(at, Math.min(n, size - at));
  const el = async (at: number, end = size) => {   // an element: its id, where its content starts, its size (-1: unknown), its size field's length
    if (at + 2 > end) return null;
    const b = await bytes(at, Math.min(12, size - at)); let il = 1; while (il <= 4 && !(b[0] & (0x80 >> (il - 1)))) il++;
    if (il > 4 || il >= b.length) return null;
    let id = 0; for (let i = 0; i < il; i++) id = id * 256 + b[i];
    let sl = 1; while (sl <= 8 && !(b[il] & (0x80 >> (sl - 1)))) sl++;
    if (sl > 8 || il + sl > b.length) return null;
    let n = b[il] & (0xFF >> sl), all = n === (0xFF >> sl); for (let i = 1; i < sl; i++) { n = n * 256 + b[il + i]; if (b[il + i] !== 0xFF) all = false; }
    return { id, at, c: at + il + sl, n: all ? -1 : n, sl };
  };
  const vint = (v: number, len: number) => { const o = new Uint8Array(len); for (let i = len - 1; i >= 0; i--) { o[i] = v % 256; v = Math.floor(v / 256); } o[0] |= 0x80 >> (len - 1); return o; };
  const ebml = await el(0); if (!ebml || ebml.id !== 0x1A45DFA3 || ebml.n < 0) return null;
  const seg = await el(ebml.c + ebml.n); if (!seg || seg.id !== 0x18538067) return null;
  const tops = []; let clusters = 0, cut = 0;
  for (let at = seg.c, i = 0; i < 4096; i++) {
    const e = await el(at); if (!e || e.n < 0) return null;
    if (e.id === 0x1F43B675 && clusters++ === keep) { cut = at; break; }
    tops.push(e); at = e.c + e.n;
  }
  if (!cut) return null;
  const patches: WebmCut["patches"] = [];
  if (seg.n >= 0) patches.push({ off: seg.c - seg.sl, bytes: vint(cut - seg.c, seg.sl) });
  // the Duration: the timecode of the cluster that is cut off (its first child), in the Info's own unit
  let tc = -1; { const c = await el(cut), t = c ? await el(c.c) : null; if (t && t.id === 0xE7 && t.n <= 6) { tc = 0; for (const v of await bytes(t.c, t.n)) tc = tc * 256 + v; } }
  for (const e of tops) {
    if (e.id === 0x1549A966 && tc >= 0) for (let at = e.c; at < e.c + e.n;) { const k = await el(at, e.c + e.n); if (!k || k.n < 0) break;
      if (k.id === 0x4489 && (k.n === 8 || k.n === 4)) { const b = new Uint8Array(k.n), dv = new DataView(b.buffer); if (k.n === 8) dv.setFloat64(0, tc); else dv.setFloat32(0, tc); patches.push({ off: k.c, bytes: b }); }
      at = k.c + k.n; }
    if (e.id === 0x114D9B74) for (let at = e.c; at < e.c + e.n;) { const k = await el(at, e.c + e.n); if (!k || k.n < 0) break;
      if (k.id === 0x4DBB && k.sl === 1) { let pos = -1; for (let q = k.c; q < k.c + k.n;) { const f = await el(q, k.c + k.n); if (!f || f.n < 0) break; if (f.id === 0x53AC) { pos = 0; for (const v of await bytes(f.c, f.n)) pos = pos * 256 + v; } q = f.c + f.n; }
        if (pos >= 0 && seg.c + pos >= cut) { const b = new Uint8Array(3); b[0] = 0xEC; b.set(vint(k.n, 2), 1); patches.push({ off: k.at, bytes: b }); } }
      at = k.c + k.n; }
  }
  return { size: cut, patches, ms: tc };
}
export async function romDevice(tree: PrepTree, prep: PrepWasm, o: { skipMovie?: boolean; log?: (l: string) => void } = {}): Promise<{ dev: DirRomDevice; files: number; bytes: number; root: string; ms: number; exefs: string }> {
  const t0 = performance.now();
  const l = await tree.list();
  const cuts = new Map<string, WebmCut>();
  if (o.skipMovie) { let was = 0, now = 0, ms = 0;
    for (let i = 0; i < l.files.length; i++) { const f = l.files[i]; if (!SKIP_MOVIE.test(f.path) || !/\/romfs\//.test(f.path)) continue;
      let cut: WebmCut | null = null; try { cut = await webmCut((off, len) => tree.read(f.path, off, len), f.size); } catch { /* left whole */ }
      if (cut && cut.size < f.size) { cuts.set(f.path, cut); was += f.size; now += cut.size; ms += Math.max(0, cut.ms); l.files[i] = { ...f, size: cut.size }; } }
    o.log?.(`[RED] skipmovie=1 (a test aid): ${cuts.size} story movies (Dm_*.webm, not the title's) are read as short WebM files that end after their first cluster (Segment size, Duration and SeekHead patched to say so): ${(was / 1048576).toFixed(0)} MB read as ${(now / 1048576).toFixed(1)} MB, ${(ms / 1000 / Math.max(1, cuts.size)).toFixed(1)} s of movie each on average`); }
  const ver = (r: string) => r.startsWith("updates/") ? Number(r.split("/")[1]) : 0;
  const pick = (kind: string) => [...new Set(l.dirs.filter(d => new RegExp("^(base|updates/\\d+)/" + kind + "$").test(d)).map(d => d + "/"))].sort((a, b) => ver(b) - ver(a))[0];
  const root = pick("romfs");   // an update's romfs is the whole patched tree (src/prepare/host/detect.ts)
  if (!root) throw new Error("owner: no romfs/ in " + tree.name);
  const cut = root.length, files = l.files.filter(f => f.path.startsWith(root));
  const entries = [...l.dirs.filter(d => d.startsWith(root) && d.length > cut).map(d => ({ path: d.slice(cut), size: 0, dir: true })), ...files.map(f => ({ path: f.path.slice(cut), size: f.size }))];
  const r = prep.romTables(entries as any);
  if ("error" in r) throw new Error("owner: RomFS tables: " + r.error);
  const sizes = Float64Array.from(files, f => f.size);
  // (a cut movie's patches are laid over what every read of its head returns)
  const base = treeSource(tree, files.map(f => f.path)), pat = files.map(f => cuts.get(f.path)?.patches);
  const lay = (i: number, off: number, dst: Uint8Array) => { const ps = pat[i]; if (ps) for (const p of ps) { const lo = Math.max(off, p.off), hi = Math.min(off + dst.length, p.off + p.bytes.length); if (lo < hi) dst.set(p.bytes.subarray(lo - p.off, hi - p.off), lo - off); } };
  const source = !cuts.size ? base : { readSync: base.readSync ? (i: number, off: number, dst: Uint8Array) => { const st = base.readSync!(i, off, dst); if (!st) lay(i, off, dst); return st; } : undefined,
    read: async (i: number, off: number, len: number) => { const b = await base.read(i, off, len); lay(i, off, b); return b; } };
  const dev = new DirRomDevice({ tables: r.tables, starts: r.starts, sizes, size: r.size }, source);
  return { dev, files: files.length, bytes: sizes.reduce((a, b) => a + b, 0), root, ms: performance.now() - t0, exefs: pick("exefs") ?? "" };
}
