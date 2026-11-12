// node tools/extract_exefs.mts [/game/zelda-oot.nup] [out dir]: the game's code modules (exefs: main, rtld, sdk, subsdk*,
// main.npdm) copied out of the .nup container with nxweb's own reader, for the node boot harness. Read-only on the game;
// the output (build/game/exefs) is never committed.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Nup, NupReader, scanNup } from "/mnt/src/prepare/host/nup.ts";
import { nodeBytes } from "/mnt/src/prepare/host/nup_node.ts";
const path = process.argv[2] ?? "/game/zelda-oot.nup", out = process.argv[3] ?? "/ctl/nxem/build/game/exefs";
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const src = nodeBytes(path);
const nup = await Nup.open(src, path, sha256 as any);
const scan = scanNup(nup);
const NO_DIR = 0xFFFFFFFF;
const ups = [...scan.updates.keys()].sort((a, b) => b - a);
const pick = [...ups.map(v => scan.updates.get(v)!), ...(scan.base ? [scan.base] : [])].find(k => k.exefs !== NO_DIR && nup.walk(k.exefs).files.length);
if (!pick) throw new Error("no package with an exefs");
console.log(`packages: base ${scan.base ? "yes" : "no"}, updates ${ups.join(",") || "none"}; exefs taken from version ${pick.version}`);
const reader = new NupReader(src, nup.files, path, { sha256: sha256 as any });
mkdirSync(out, { recursive: true });
for (const f of nup.walk(pick.exefs).files) {
  const b = await reader.read(f.i, 0, nup.files[f.i].size);
  writeFileSync(`${out}/${f.path.replace(/\//g, "_")}`, b);
  console.log(`${f.path}\t${b.length}\t${Buffer.from(b.subarray(0, 4)).toString("latin1").replace(/[^ -~]/g, ".")}`);
}
src.close();
