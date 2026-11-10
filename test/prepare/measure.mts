// npm run prepare:measure. The RomFS device over a directory against a packed image, on a tree of 50,000 files:
// what it costs to make each, how long the fs module takes to mount each, and what one OpenFile + ReadFile +
// CloseFile of a whole file costs through each (first touch and again). Node; the numbers in src/prepare/README.md
// are from this script. The tree is generated here (random bytes), 50,000 files in 2,600 directories.
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { ROOT, WASM, build } from "../../src/prepare/host/build.mts";
import { PrepWasm } from "../../src/prepare/host/wasm.ts";
import { NodeTree } from "../../src/prepare/host/tree_node.ts";
import { DirRomDevice, treeSource } from "../../src/prepare/host/romdev.ts";
import { MemStorage, FS_KIND, type FsDevice } from "../../src/glue/fs_host.ts";
import { NodeFileDevice } from "../../src/glue/fs_dev_node.ts";
import { Fs, build as fsBuild } from "../fs/harness.mts";
import { SCRATCH, python } from "./synth.mts";

process.chdir(ROOT);
build(); fsBuild();
const N = Number(process.argv[2] ?? 50_000), dir = join(SCRATCH, `big${N}`), image = join(SCRATCH, `big${N}.img`);
let seed = 99; const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
if (!existsSync(join(dir, ".done"))) {
  rmSync(dir, { recursive: true, force: true });
  const t0 = performance.now(), dirs: string[] = [""];
  for (let i = 0; i < Math.round(N * 0.052); i++) { const p = dirs[rnd(dirs.length)]; dirs.push(p.split("/").length > 5 ? `d${i}` : (p ? p + "/" : "") + `d${i}`); }
  for (const d of dirs) mkdirSync(join(dir, d), { recursive: true });
  let bytes = 0;
  for (let i = 0; i < N; i++) {
    const size = rnd(10) === 0 ? 0 : rnd(4) === 0 ? rnd(16000) : rnd(900), b = Buffer.alloc(size);
    for (let k = 0; k < size; k++) { if (!(k & 3)) seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; b[k] = seed >>> (8 * (k & 3)); }
    const d = dirs[rnd(dirs.length)];
    writeFileSync(join(dir, d, `file_${i}_${"x".repeat(rnd(24))}.bin`), b); bytes += size;
  }
  writeFileSync(join(dir, ".done"), "");
  console.log(`made ${N} files, ${dirs.length} directories, ${(bytes / 1e6).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
const ms = (t0: number) => performance.now() - t0;
const w = new PrepWasm(new WebAssembly.Module(readFileSync(WASM)));
// ---- the directory device ----
let t = performance.now();
const tree = new NodeTree(dir, { maxOpen: 256 }), l = tree.listSync();
l.files = l.files.filter(f => f.path !== ".done");
const tList = ms(t);
t = performance.now();
const r = w.romTables([...l.dirs.map(d => ({ path: d, size: 0, dir: true })), ...l.files.map(f => ({ path: f.path, size: f.size }))]);
if ("error" in r) throw new Error(r.error);
const tTables = ms(t);
const bytes = l.files.reduce((n, f) => n + f.size, 0);
const paths = l.files.map(f => f.path);
const dirDev = () => new DirRomDevice({ tables: r.tables, starts: r.starts, sizes: Float64Array.from(l.files.map(f => f.size)), size: r.size }, treeSource(tree, paths));
// ---- the packed image (what copying the tree into one image costs) ----
t = performance.now();
python(["build", dir, image]);   // built every time: its duration is one of the figures (the file .done is one more entry in it)
const tImage = ms(t);
// ---- mount and read through the fs module ----
const pick: number[] = []; for (let i = 0; i < 5000; i++) pick.push(rnd(paths.length));
async function through(what: string, dev: FsDevice): Promise<{ mount: number; cold: number; warm: number; arena: number; sum: number }> {
  const st = new MemStorage(); st.setImage(FS_KIND.ROM, 0, dev);
  const fs = new Fs(st, { cover: false, arena: 256 << 20 });
  let t0 = performance.now();
  const rc = fs.callSync("MountRom", fs.str("rom"), fs.alloc(0x1000), 0x1000);
  const mount = ms(t0);
  if (rc || fs.red.length) throw new Error(`${what}: MountRom ${rc} ${fs.red.join(" | ")}`);
  let sum = 0;
  const pass = async () => {
    const t1 = performance.now();
    for (const i of pick) {
      const [rc, h] = await fs.open("rom:/" + paths[i]);
      if (rc) throw new Error(`${what}: open ${paths[i]}: ${rc}`);
      const [rr, b] = await fs.read(h, 0, l.files[i].size || 1);
      if (rr || b.length !== l.files[i].size) throw new Error(`${what}: read ${paths[i]}: ${rr} ${b.length}`);
      for (let k = 0; k < b.length; k += 97) sum = (sum + b[k]) >>> 0;
      await fs.close(h);
    }
    return ms(t1);
  };
  const cold = await pass(), warm = await pass();
  return { mount, cold, warm, arena: 0, sum };
}
const a = await through("directory", dirDev());
const opens = tree.opens;
const b = await through("image", new NodeFileDevice(image, false));
if (a.sum !== b.sum) throw new Error("the two devices gave different bytes");
const per = (x: number) => (x / pick.length * 1000).toFixed(1);
console.log(`tree: ${l.files.length} files, ${l.dirs.length} directories, ${(bytes / 1e6).toFixed(1)} MB`);
console.log(`directory device: listing ${tList.toFixed(0)} ms, tables ${tTables.toFixed(0)} ms (${(r.tables.length / 1e6).toFixed(2)} MB, ${(r.tables.length / l.files.length).toFixed(0)} bytes a file), nothing copied`);
console.log(`packed image: tools/mkromfs.py build ${(tImage / 1000).toFixed(1)} s for ${(statSync(image).size / 1e6).toFixed(1)} MB (every byte of the tree read and written once)`);
console.log(`fs mount (tables read and checked completely): directory device ${a.mount.toFixed(0)} ms, image ${b.mount.toFixed(0)} ms`);
console.log(`open + read whole + close, ${pick.length} random files: directory device first pass ${per(a.cold)} us a file, second pass ${per(a.warm)} us (${opens} files opened over the two passes, 256 kept open); image ${per(b.cold)} us, second pass ${per(b.warm)} us`);
tree.close();
