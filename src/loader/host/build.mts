// Builds build/loader/loader.wasm from src/loader/index.ts (`npm run loader:build`).
// The lifecycle machine (src/loader/defs/module.json) is in the kit's generated tables: run `npm run kit:diagrams`
// after changing it; this build fails when they are out of date.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "../../kit/host/gen.mts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const WASM = join(ROOT, "build", "loader", "loader.wasm");

export function build(): void {
  const stale = check();
  if (stale.length) throw new Error(stale.map(b => `[RED] loader:build: ${b} (run \`npm run kit:diagrams\`)`).join("\n"));
  mkdirSync(dirname(WASM), { recursive: true });
  try {
    execFileSync(process.execPath, [join(ROOT, "node_modules", "assemblyscript", "bin", "asc.js"), "src/loader/index.ts", "-o", relative(ROOT, WASM), "--runtime", "stub", "-O3"],
      { cwd: ROOT, stdio: "inherit" });
  } catch { throw new Error("[RED] loader:build: src/loader/index.ts did not compile"); }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  build();
  console.log(`loader:build: wrote ${relative(ROOT, WASM)}`);
}
