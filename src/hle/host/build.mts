// `npm run hle:build`: build/hle/hle.wasm, the take-over module with a memory of its own (the tests use it as the
// guest memory). hleBuildShared(out, base) builds it for the runtime: it imports the one shared linear memory and
// keeps its static data from `base` (a range of src/glue/rt_layout.ts; about 400 KB today, hle_static_end() says).
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPair } from "../../../tools/asc64/abi.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const WASM = join(ROOT, "build", "hle", "hle.wasm");
const ASC = join(ROOT, "node_modules", "assemblyscript", "bin", "asc.js");
const asc = (args: string[]) => execFileSync(process.execPath, [ASC, ...args], { cwd: ROOT, stdio: "inherit" });

export function hleBuild(): void {
  mkdirSync(dirname(WASM), { recursive: true });
  // hle.wasm (a memory of its own) and hle64.wasm (it imports a 64-bit memory), each with its address table
  const args = ["--runtime", "stub", "-O2", "--initialMemory", "64"];
  buildPair("src/hle/index.ts", relative(ROOT, WASM), args, { args64: [...args, "--importMemory"] });
}
export function hleBuildShared(out: string, base: number): void {
  mkdirSync(dirname(out), { recursive: true });
  // both builds (out and <out>64.wasm), each with its address table
  buildPair("src/hle/index.ts", relative(ROOT, resolve(ROOT, out)), ["--runtime", "stub", "-O2", "--importMemory", "--zeroFilledMemory", "--memoryBase", String(base)]);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const i = process.argv.indexOf("--base");
  try {
    hleBuild();
    if (i > 0) hleBuildShared(join(ROOT, "build", "hle", "hle.shared.wasm"), Number(process.argv[i + 1]));
    console.log(`hle:build: wrote build/hle/hle.wasm${i > 0 ? " and build/hle/hle.shared.wasm" : ""}`);
  } catch { console.error("[RED] hle:build: src/hle/index.ts did not compile"); process.exit(1); }
}
