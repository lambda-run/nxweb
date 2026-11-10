// `npm run rt:build`: everything the runtime needs, in build/runtime/.
//   rt.wasm, kernel.wasm, loader.wasm   AssemblyScript modules that IMPORT the one shared linear memory (asc --importMemory)
//                                       with their static data at the base src/glue/rt_layout.ts gives them (--memoryBase)
//   translator.wasm, helpers.wasm       the a64 translator and its helpers (src/a64/host/build.mts), on the same memory
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "../../kit/host/gen.mts";
import { range } from "../../glue/rt_layout.ts";
import { a64Build } from "../../a64/host/build.mts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const OUT = join(ROOT, "build", "runtime");
const ASC = join(ROOT, "node_modules", "assemblyscript", "bin", "asc.js");
const asc = (args: string[]) => execFileSync(process.execPath, [ASC, ...args], { cwd: ROOT, stdio: "inherit" });

export function build(o: { a64?: boolean } = {}): void {
  const stale = check();
  if (stale.length) throw new Error(stale.map(b => `[RED] rt:build: ${b} (run \`npm run kit:diagrams\`)`).join("\n"));
  mkdirSync(OUT, { recursive: true });
  const shared = (src: string, out: string, base: number, opt: string) =>
    asc([src, "-o", join("build", "runtime", out), "--runtime", "stub", opt, "--importMemory", "--zeroFilledMemory", "--memoryBase", String(base)]);
  shared("src/runtime/index.ts", "rt.wasm", range("rt static").lo, "-O2");
  shared("src/loader/index.ts", "loader.wasm", range("loader static").lo, "-O3");
  shared("src/kernel/index.ts", "kernel.wasm", range("kernel static").lo, "-O2");
  // the graphics recorder with its static data in the runtime's range (the gfx owner's flags otherwise; its own
  // build, build/gfx/gfx.wasm, sits at 64 KB, which is the runtime core's range here)
  asc(["src/gfx/index.ts", "-o", "build/runtime/gfx.wasm", "--runtime", "stub", "-O2", "--importMemory", "--memoryBase", String(range("gfx static").lo)]);
  // the translator and helpers: the a64 owner's build (src/a64/host/build.mts), bases from the same layout table.
  // A failure stops the build: a stale artifact would not match src/glue/a64_host.ts.
  if (o.a64 !== false) a64Build(join("build", "runtime"));
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try { build(); console.log("rt:build: wrote build/runtime/{rt,kernel,loader,gfx,translator,helpers}.wasm"); }
  catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
}
