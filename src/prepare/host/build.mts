// `npm run prepare:build`: build/prepare/prepare.wasm (the AssemblyScript of src/prepare, with its own memory) and
// its kit stamp.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "../../kit/host/gen.mts";
import { writeStamp, checkStamp } from "../../kit/host/stamp.mts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const OUT = join(ROOT, "build", "prepare");
export const WASM = join(OUT, "prepare.wasm");
export function build(): void {
  const stale = check();
  if (stale.length) throw new Error(stale.map(b => `[RED] prepare:build: ${b} (run \`npm run kit:diagrams\`)`).join("\n"));
  mkdirSync(OUT, { recursive: true });
  execFileSync(process.execPath, [join(ROOT, "node_modules", "assemblyscript", "bin", "asc.js"), "src/prepare/index.ts", "-o", "build/prepare/prepare.wasm",
    "--runtime", "stub", "-O2", "--maximumMemory", "65535"], { cwd: ROOT, stdio: "inherit" });
  writeStamp(WASM);
}
export function checkBuilt(): void { checkStamp(WASM); }
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try { build(); console.log("prepare:build: wrote build/prepare/prepare.wasm"); }
  catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
}
