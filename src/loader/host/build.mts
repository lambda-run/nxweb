// Builds build/loader/loader.wasm from src/loader/index.ts (`npm run loader:build`).
//
// The lifecycle machine is defined in src/loader/defs/module.json, but the kit's generator (src/kit/host/gen.mts)
// reads src/kit/defs only and src/kit/machine.ts imports "./gen/tables". Until the kit takes definitions from other
// directories, this build makes the combined tables itself, with the kit's own generator functions, and hands them to
// the compiler in place of src/kit/gen/tables.ts. No kit file is changed. It also writes the machine's diagram to
// src/loader/defs/module.md (what `kit:diagrams` would put in docs/machines/).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDefs, validate, type MachineDef } from "../../kit/host/defs.mts";
import { tablesSource, diagramSource } from "../../kit/host/gen.mts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const WASM = join(ROOT, "build", "loader", "loader.wasm");
const DEF = join(ROOT, "src", "loader", "defs", "module.json");
const DIAGRAM = join(ROOT, "src", "loader", "defs", "module.md");
const TABLES = "src/kit/gen/tables.ts";

// The kit's machines followed by the loader's, with the ids the compiled tables have
export function allDefs(): MachineDef[] {
  const kit = loadDefs();
  const mine = validate(JSON.parse(readFileSync(DEF, "utf8")), "module.json");
  if (kit.some(d => d.name === mine.name)) return kit;   // the kit has taken the definition over: nothing to add
  if (mine.id !== kit.length) throw new Error(`[RED] src/loader/defs/module.json: "id" must be ${kit.length}, the next free machine id (the kit has ${kit.length} machines)`);
  return [...kit, mine];
}

export async function build(opts: { check?: boolean } = {}): Promise<void> {
  const defs = allDefs();
  const tables = tablesSource(defs);
  const mine = defs.find(d => d.name === "module")!;
  const diagram = diagramSource(mine).replaceAll("src/kit/defs/module.json", "src/loader/defs/module.json").replaceAll("npm run kit:diagrams", "npm run loader:build");
  if (!existsSync(DIAGRAM) || readFileSync(DIAGRAM, "utf8") !== diagram) {
    if (opts.check) throw new Error("[RED] src/loader/defs/module.md is out of date: run `npm run loader:build`");
    writeFileSync(DIAGRAM, diagram);
  }
  const asc = (await import("assemblyscript/asc")).default;
  mkdirSync(dirname(WASM), { recursive: true });
  const { error, stderr } = await asc.main(
    ["src/loader/index.ts", "--baseDir", ROOT, "-o", relative(ROOT, WASM), "--runtime", "stub", "-O3", "--initialMemory", "64", "--maximumMemory", "65536"],
    {
      readFile: (name: string, baseDir: string) => {
        if (name.replaceAll("\\", "/") === TABLES) return tables;
        try { return readFileSync(resolve(ROOT, baseDir, name), "utf8"); } catch { return null; }
      },
      writeFile: (name: string, data: Uint8Array | string, baseDir: string) => { writeFileSync(resolve(ROOT, baseDir, name), data); },
      listFiles: () => [],
    });
  if (error) throw new Error(`[RED] loader: src/loader/index.ts did not compile\n${stderr.toString()}`);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  process.chdir(ROOT);
  await build();
  console.log(`loader:build: wrote ${relative(ROOT, WASM)}`);
}
