// `npm run a64:build [-- <out dir>]`: the translator and its helpers, unshared and shared, for the one linear memory;
// and the same four for a 64-bit linear memory (translator64*.wasm, helpers64*.wasm: wasm64 by tools/asc64, the
// memory64 mode of src/a64/README.md), at the same bases.
// The static-data bases are the "a64 translator" and "a64 helpers" ranges of src/glue/rt_layout.ts (the one table of
// the host area); A64Host refuses binaries whose base is not the layout's. `rt:build` calls a64Build("build/runtime").
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { A64 } from "../../glue/rt_layout.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ASC = join(ROOT, "node_modules", "assemblyscript", "bin", "asc.js");
const ASC64 = join(ROOT, "tools", "asc64", "asc64.mjs");
export const MEM64_MAX_PAGES = 262144;   // 16 GB: what the engines give an i64 memory today; the shared builds declare it

export function a64Build(outDir = "build/a64"): string[] {
  mkdirSync(join(ROOT, outDir), { recursive: true });
  const common = ["-O2", "--runtime", "stub", "--enable", "simd", "--importMemory", "--zeroFilledMemory"];
  const shared = ["--sharedMemory", "--maximumMemory", "65536", "--enable", "threads"];
  const helpers = ["--enable", "relaxed-simd", "--disableWarning", "112"];
  const jobs: [src: string, out: string, base: number, extra: string[]][] = [
    ["src/a64/index.ts", "translator.wasm", A64.translatorBase, []],
    ["src/a64/helpers.ts", "helpers.wasm", A64.helpersBase, helpers],
    ["src/a64/index.ts", "translator.shared.wasm", A64.translatorBase, shared],
    ["src/a64/helpers.ts", "helpers.shared.wasm", A64.helpersBase, [...shared, ...helpers]],
  ];
  for (const [src, out, base, extra] of jobs)
    execFileSync(process.execPath, [ASC, src, "-o", join(outDir, out), ...common, "--memoryBase", String(base), ...extra], { cwd: ROOT, stdio: "inherit" });
  // the same sources for an i64 memory
  const outs64: string[] = [];
  for (const [src, out, base, extra] of jobs) {
    const out64 = out.replace(/^(translator|helpers)/, "$164");
    const x = extra.map(a => a === "65536" ? String(MEM64_MAX_PAGES) : a);
    execFileSync(process.execPath, [ASC64, src, "-o", join(outDir, out64), ...common, "--memoryBase", String(base), ...x], { cwd: ROOT, stdio: "inherit" });
    outs64.push(join(outDir, out64));
  }
  return [...jobs.map(j => join(outDir, j[1])), ...outs64];
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try { a64Build(process.argv[2]); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
}
