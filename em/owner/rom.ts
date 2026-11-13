// nxem: the game's RomFS out of the container without unpacking it (the owner, owner.ts romStorage, and the fs worker,
// fs_worker.ts, each build one): the tables are built once from the listing (src/prepare/romfs_build.ts, as the prepare
// step's Index stage does), a read is a read of the container.
import type { PrepTree } from "../../src/prepare/host/tree.ts";
import { DirRomDevice, treeSource } from "../../src/prepare/host/romdev.ts";
import type { PrepWasm } from "../../src/prepare/host/wasm.ts";

export async function romDevice(tree: PrepTree, prep: PrepWasm): Promise<{ dev: DirRomDevice; files: number; bytes: number; root: string; ms: number; exefs: string }> {
  const t0 = performance.now();
  const l = await tree.list();
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
