// Builds build/gfx/gfx.wasm from src/gfx/index.ts (`npm run gfx:build`). Regenerates src/gfx/gen/names.ts first (the
// name table and which names dispatch.ts implements) and fails when the kit's generated tables are out of date
// (the graphics machines are src/gfx/defs/*.json: run `npm run kit:diagrams` after changing one).
// The module imports its memory (the guest's linear memory); its static data starts at --memoryBase (64 KB here).
// For a shared memory add `--sharedMemory <pages> --enable threads`.
import { buildPair } from "../../../tools/asc64/abi.mjs";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "../../kit/host/gen.mts";
import { generate, OUT as NAMES_OUT } from "./gen_names.mts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const WASM = join(ROOT, "build", "gfx", "gfx.wasm");
export const MEMORY_BASE = 65536;

export function build(): { total: number; implemented: number; nops: number } {
  const stale = check();
  if (stale.length) throw new Error(stale.map(b => `[RED] gfx:build: ${b} (run \`npm run kit:diagrams\`)`).join("\n"));
  const g = generate();
  if (!existsSync(NAMES_OUT) || readFileSync(NAMES_OUT, "utf8") !== g.source) writeFileSync(NAMES_OUT, g.source);
  mkdirSync(dirname(WASM), { recursive: true });
  try {
    // gfx.wasm and gfx64.wasm (the same for a 64-bit memory), each with its address table
    buildPair("src/gfx/index.ts", "build/gfx/gfx.wasm", ["--runtime", "stub", "-O2", "--importMemory", "--memoryBase", String(MEMORY_BASE)]);
  } catch { throw new Error("[RED] gfx:build: src/gfx/index.ts did not compile"); }
  return g;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try { const g = build(); console.log(`gfx:build: wrote build/gfx/gfx.wasm (${g.implemented} NVN functions implemented, ${g.nops} empty by design, ${g.total - g.implemented - g.nops} red stubs, of ${g.total})`); }
  catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
}
