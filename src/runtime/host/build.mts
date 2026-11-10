// `npm run rt:build`: everything the runtime needs, in build/runtime/.
//   rt.wasm, kernel.wasm, loader.wasm   AssemblyScript modules that IMPORT the one shared linear memory (asc --importMemory)
//                                       with their static data at the base src/glue/rt_layout.ts gives them (--memoryBase)
//   translator.wasm, helpers.wasm       the a64 translator and its helpers (src/a64/host/build.mts), on the same memory
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "../../kit/host/gen.mts";
import { range } from "../../glue/rt_layout.ts";
import { a64Build } from "../../a64/host/build.mts";
import { hleBuildShared } from "../../hle/host/build.mts";
import { writeStamp, checkStamp } from "../../kit/host/stamp.mts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const OUT = join(ROOT, "build", "runtime");
export const KIT_MODULES = ["rt", "kernel", "loader", "gfx", "fs", "hle"];
// Refuses modules of build/runtime that were built from other kit tables than the current ones (for whoever loads
// them without having just built them)
export function checkBuilt(): void { for (const n of KIT_MODULES) checkStamp(join(OUT, n + ".wasm")); }
const ASC = join(ROOT, "node_modules", "assemblyscript", "bin", "asc.js");
const asc = (args: string[]) => execFileSync(process.execPath, [ASC, ...args], { cwd: ROOT, stdio: "inherit" });

export function build(o: { a64?: boolean } = {}): void {
  const stale = check();
  // RT_KIT_KEEP=1 (work beside an owner who is adding machines and has not generated yet): build from the tables
  // as they are; the stamps still tie every module of this build to one version of them
  if (stale.length && !process.env.RT_KIT_KEEP) throw new Error(stale.map(b => `[RED] rt:build: ${b} (run \`npm run kit:diagrams\`)`).join("\n"));
  if (stale.length) console.error(`[RED] rt:build: the kit's generated tables are out of date (${stale.length} files); RT_KIT_KEEP is set, building from them as they are`);
  mkdirSync(OUT, { recursive: true });
  const shared = (src: string, out: string, base: number, opt: string) =>
    asc([src, "-o", join("build", "runtime", out), "--runtime", "stub", opt, "--importMemory", "--zeroFilledMemory", "--memoryBase", String(base)]);
  shared("src/runtime/index.ts", "rt.wasm", range("rt static").lo, "-O2");
  shared("src/loader/index.ts", "loader.wasm", range("loader static").lo, "-O3");
  shared("src/kernel/index.ts", "kernel.wasm", range("kernel static").lo, "-O2");
  // the graphics recorder with its static data in the runtime's range (the gfx owner's flags otherwise; its own
  // build, build/gfx/gfx.wasm, sits at 64 KB, which is the runtime core's range here)
  try { asc(["src/gfx/index.ts", "-o", "build/runtime/gfx.wasm", "--runtime", "stub", "-O2", "--importMemory", "--memoryBase", String(range("gfx static").lo)]); }
  catch (e) {
    // Only on request (RT_GFX_KEEP=1, for work beside an owner who is mid-edit in src/gfx): go on with the gfx.wasm
    // that built last. Never the default: a stale recorder may not match src/glue/gfx_host.ts.
    if (!process.env.RT_GFX_KEEP || !existsSync(join(OUT, "gfx.wasm"))) throw e;
    console.error("[RED] rt:build: src/gfx does not compile right now; RT_GFX_KEEP is set, using the existing build/runtime/gfx.wasm");
  }
  // the file system with its static data in the runtime's range (src/fs/README.md, "Shared memory")
  shared("src/fs/index.ts", "fs.wasm", range("fs static").lo, "-O2");
  // the SDK take-over table (src/hle/host/build.mts)
  hleBuildShared(join(OUT, "hle.wasm"), range("hle static").lo);
  // every module above compiles the kit's tables in: the stamps say from which (src/kit/host/stamp.mts)
  for (const n of KIT_MODULES) writeStamp(join(OUT, n + ".wasm"));
  // the translator and helpers: the a64 owner's build (src/a64/host/build.mts), bases from the same layout table.
  // A failure stops the build: a stale artifact would not match src/glue/a64_host.ts.
  if (o.a64 !== false) a64Build(join("build", "runtime"));
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try { build(); console.log("rt:build: wrote build/runtime/{rt,kernel,loader,gfx,fs,hle,translator,helpers}.wasm"); }
  catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
}
