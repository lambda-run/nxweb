// nxem: the game's RomFS out of the container without unpacking it (the owner, owner.ts romStorage, and the fs worker,
// fs_worker.ts, each build one): the tables are built once from the listing (src/prepare/romfs_build.ts, as the prepare
// step's Index stage does), a read is a read of the container.
import type { PrepTree } from "../../src/prepare/host/tree.ts";
import { DirRomDevice, treeSource } from "../../src/prepare/host/romdev.ts";
import type { PrepWasm } from "../../src/prepare/host/wasm.ts";

// ?skipmovie=1, a test aid: a story movie (Dm_*.webm, not the title's) ends after its first cluster, as if the file
// were that short: the WebM's top-level elements are walked and the file's size is the start of its second cluster.
// Returns the new size, or 0 when the file is not cut (not a WebM, fewer clusters, a cluster of unknown size).
export const SKIP_MOVIE = /(^|\/)Dm_(?!Title)[^/]*\.webm$/;
export async function webmCut(read: (off: number, len: number) => Promise<Uint8Array>, size: number, keep = 1): Promise<number> {
  const el = async (at: number) => {   // an element's id, the offset of its content and its size (-1: unknown)
    if (at + 2 > size) return null;
    const b = await read(at, Math.min(12, size - at)); let il = 1; while (il <= 4 && !(b[0] & (0x80 >> (il - 1)))) il++;
    if (il > 4 || il >= b.length) return null;
    let id = 0; for (let i = 0; i < il; i++) id = id * 256 + b[i];
    let sl = 1; while (sl <= 8 && !(b[il] & (0x80 >> (sl - 1)))) sl++;
    if (sl > 8 || il + sl > b.length) return null;
    let n = b[il] & (0xFF >> sl), all = n === (0xFF >> sl); for (let i = 1; i < sl; i++) { n = n * 256 + b[il + i]; if (b[il + i] !== 0xFF) all = false; }
    return { id, at: at + il + sl, n: all ? -1 : n };
  };
  const head = await el(0); if (!head || head.id !== 0x1A45DFA3 || head.n < 0) return 0;
  const seg = await el(head.at + head.n); if (!seg || seg.id !== 0x18538067) return 0;
  let clusters = 0;
  for (let at = seg.at, i = 0; i < 4096; i++) {
    const e = await el(at); if (!e || e.n < 0) return 0;
    if (e.id === 0x1F43B675 && clusters++ === keep) return at;
    at = e.at + e.n;
  }
  return 0;
}
export async function romDevice(tree: PrepTree, prep: PrepWasm, o: { skipMovie?: boolean; log?: (l: string) => void } = {}): Promise<{ dev: DirRomDevice; files: number; bytes: number; root: string; ms: number; exefs: string }> {
  const t0 = performance.now();
  const l = await tree.list();
  if (o.skipMovie) { let n = 0, was = 0, now = 0;
    for (let i = 0; i < l.files.length; i++) { const f = l.files[i]; if (!SKIP_MOVIE.test(f.path) || !/\/romfs\//.test(f.path)) continue;
      let cut = 0; try { cut = await webmCut((off, len) => tree.read(f.path, off, len), f.size); } catch { /* left whole */ }
      if (cut > 0 && cut < f.size) { n++; was += f.size; now += cut; l.files[i] = { ...f, size: cut }; } }
    o.log?.(`[RED] skipmovie=1 (a test aid): ${n} story movies (Dm_*.webm, not the title's) end after their first cluster: ${(was / 1048576).toFixed(0)} MB of movie files read as ${(now / 1048576).toFixed(1)} MB`); }
  const ver = (r: string) => r.startsWith("updates/") ? Number(r.split("/")[1]) : 0;
  const pick = (kind: string) => [...new Set(l.dirs.filter(d => new RegExp("^(base|updates/\\d+)/" + kind + "$").test(d)).map(d => d + "/"))].sort((a, b) => ver(b) - ver(a))[0];
  const root = pick("romfs");   // an update's romfs is the whole patched tree (src/prepare/host/detect.ts)
  if (!root) throw new Error("owner: no romfs/ in " + tree.name);
  const cut = root.length, files = l.files.filter(f => f.path.startsWith(root));
  const entries = [...l.dirs.filter(d => d.startsWith(root) && d.length > cut).map(d => ({ path: d.slice(cut), size: 0, dir: true })), ...files.map(f => ({ path: f.path.slice(cut), size: f.size }))];
  const r = prep.romTables(entries as any);
  if ("error" in r) throw new Error("owner: RomFS tables: " + r.error);
  const sizes = Float64Array.from(files, f => f.size);
  const dev = new DirRomDevice({ tables: r.tables, starts: r.starts, sizes, size: r.size }, treeSource(tree, files.map(f => f.path)));
  return { dev, files: files.length, bytes: sizes.reduce((a, b) => a + b, 0), root, ms: performance.now() - t0, exefs: pick("exefs") ?? "" };
}
