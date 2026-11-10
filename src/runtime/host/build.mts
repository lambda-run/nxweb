// `npm run rt:build`: everything the runtime needs, in build/runtime/.
//   rt.wasm, kernel.wasm, loader.wasm   AssemblyScript modules that IMPORT the one shared linear memory (asc --importMemory)
//                                       with their static data at the base src/glue/rt_layout.ts gives them (--memoryBase)
//   translator.wasm, helpers.wasm       the a64 translator, built with the flags of the root `a64:build` script (its own
//                                       private memory: see README.md, "Memory")
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "../../kit/host/gen.mts";
import { range } from "../../glue/rt_layout.ts";

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
  if (o.a64 !== false) {
    // the a64 owner's build line, with the output redirected: flags stay theirs
    const script: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts["a64:build"];
    for (const cmd of script.split("&&").map(s => s.trim())) {
      const words = cmd.split(/\s+/);
      if (words[0] !== "asc") throw new Error(`[RED] rt:build: cannot read the a64:build script: ${cmd}`);
      const args = words.slice(1).map(w => w.replace(/^build\/a64\//, "build/runtime/")), out = join(ROOT, args[args.indexOf("-o") + 1]);
      try { asc(args); }
      catch (e) {
        // the a64 sources are another owner's and may be mid-edit: keep going with the last artifact that built
        if (!existsSync(out)) throw e;
        console.error(`[RED] rt:build: ${args[0]} does not compile right now; using the existing ${args[args.indexOf("-o") + 1]} (it may not match src/glue/a64_host.ts)`);
      }
    }
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try { build(); console.log("rt:build: wrote build/runtime/{rt,kernel,loader,gfx,translator,helpers}.wasm"); }
  catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
}
