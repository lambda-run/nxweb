// EXPERIMENTAL (spike, see SPIKE.md): `node src/spike_workers/build.mts` builds everything the spike runs, in
// build/spike_workers/. Needs `npm run rt:build` first (today's unshared binaries are the baseline).
//   kernel.mt.wasm / kernel.mt2.wasm           the kernel for a shared memory, globals moved to memory (mtify): primary / secondary
//   translator.mt.wasm / translator.mt2.wasm   the same for the a64 translator
//   helpers.private.wasm                       the translator's helpers with their own memory (one instance per Worker)
//   guests/*.bin + *.json                      flat test images
//   web/worker.js, web/page.js                 the browser bundles
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { range, A64 } from "../glue/rt_layout.ts";
import { mtify } from "./mtify.mts";
import { KERNEL_GLOBALS, TRANSLATOR_GLOBALS } from "./engine.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const OUT = join(ROOT, "build", "spike_workers");
const ASC = join(ROOT, "node_modules", "assemblyscript", "bin", "asc.js");
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
const asc = (args: string[]) => run(process.execPath, [ASC, ...args]);

export const GUESTS: Record<string, [src: string, ...flags: string[]]> = {
  threads: ["test/runtime/src/threads.c"], race: ["test/runtime/src/race.c"],
  stress: ["test/spike_workers/guests/stress.c"], dekker: ["test/spike_workers/guests/dekker.c"],
  bench_sha: ["test/spike_workers/guests/bench.c", "-DWORK=1", "-DROUNDS=400"],
  bench_lz: ["test/spike_workers/guests/bench.c", "-DWORK=2", "-DROUNDS=500"],
  bench_contend: ["test/spike_workers/guests/bench.c", "-DWORK=3", "-DROUNDS=40000"],
  bench_svc: ["test/spike_workers/guests/bench.c", "-DWORK=4", "-DROUNDS=60000"],
  bench_sha_1t: ["test/spike_workers/guests/bench.c", "-DWORK=1", "-DROUNDS=1600", "-DNT=1"],
  bench_ping: ["test/spike_workers/guests/bench.c", "-DWORK=5", "-DROUNDS=20000", "-DNT=2"],
  bench_lz_1t: ["test/spike_workers/guests/bench.c", "-DWORK=2", "-DROUNDS=2000", "-DNT=1"],
};

export function build(): void {
  mkdirSync(join(OUT, "guests"), { recursive: true }); mkdirSync(join(OUT, "web"), { recursive: true });
  for (const f of ["kernel.wasm", "translator.wasm", "helpers.wasm", "helpers.shared.wasm"])
    if (!existsSync(join(ROOT, "build", "runtime", f))) throw new Error(`build/runtime/${f} is missing: npm run rt:build`);
  const shared = ["--runtime", "stub", "--importMemory", "--zeroFilledMemory", "--sharedMemory", "--maximumMemory", "65536", "--enable", "threads"];
  // the kernel and the translator for a shared memory, as text, then mtify
  asc(["src/kernel/index.ts", "-o", "build/spike_workers/kernel.shared.wasm", "-O2", ...shared, "--memoryBase", String(range("kernel static").lo)]);
  asc(["src/a64/index.ts", "-o", "build/spike_workers/translator.shared.wasm", "-O2", "--enable", "simd", ...shared, "--memoryBase", String(A64.translatorBase)]);
  for (const [name, area] of [["kernel", KERNEL_GLOBALS], ["translator", TRANSLATOR_GLOBALS]] as const) {
    const r = mtify(readFileSync(join(OUT, name + ".shared.wasm")), area);
    writeFileSync(join(OUT, name + ".mt.wasm"), r.primary); writeFileSync(join(OUT, name + ".mt2.wasm"), r.secondary);
    console.log(`mtify ${name}: ${r.globals.length} mutable globals moved to 0x${area.toString(16)}; primary ${r.primary.length} B, secondary ${r.secondary.length} B`);
  }
  // helpers with a private memory: no --importMemory
  asc(["src/a64/helpers.ts", "-o", "build/spike_workers/helpers.private.wasm", "-O2", "--runtime", "stub", "--enable", "simd", "--enable", "relaxed-simd", "--disableWarning", "112"]);
  copyFileSync(join(ROOT, "build", "runtime", "helpers.shared.wasm"), join(OUT, "helpers.shared.wasm"));
  // guests: flat images at 0x0800_0000, the main thread's stack (1 MB) after the bss
  const CFLAGS = ["--target=aarch64-none-elf", "-ffreestanding", "-nostdlib", "-O2", "-mcpu=cortex-a57", "-mno-outline-atomics", "-fno-asynchronous-unwind-tables", "-fno-unwind-tables",
    "-fvisibility=hidden", "-Wall", "-Wno-unused-parameter", "-Wno-unused-function", "-I", "test/runtime/src"];
  const o = (n: string) => join(OUT, "guests", n);
  run("clang", [...CFLAGS, "-c", "test/spike_workers/guests/crt0.S", "-o", o("crt0.o")]);
  run("clang", [...CFLAGS, "-c", "test/runtime/src/svc.S", "-o", o("svc.o")]);
  run("clang", [...CFLAGS, "-c", "test/spike_workers/guests/xsvc.S", "-o", o("xsvc.o")]);
  for (const [name, [src, ...flags]] of Object.entries(GUESTS)) {
    run("clang", [...CFLAGS, ...flags, "-c", src, "-o", o(name + ".o")]);
    run("ld.lld", ["-T", "test/a64/guests/guest.ld", o("crt0.o"), o(name + ".o"), o("svc.o"), o("xsvc.o"), "-o", o(name + ".elf")]);
    run("llvm-objcopy", ["-O", "binary", o(name + ".elf"), o(name + ".bin")]);
    const nm = execFileSync("llvm-nm", [o(name + ".elf")], { encoding: "utf8" });
    const bssEnd = parseInt(nm.split("\n").find(l => l.endsWith(" __bss_end"))!.split(" ")[0], 16);
    const stackTop = ((bssEnd + 0xFFFF) & ~0xFFFF) + 0x100000;
    writeFileSync(o(name + ".json"), JSON.stringify({ base: 0x08000000, entry: 0x08000000, stackTop, top: stackTop }));
  }
  buildSync({ entryPoints: ["src/spike_workers/worker_web.ts"], bundle: true, format: "iife", outfile: "build/spike_workers/web/worker.js", logLevel: "warning", absWorkingDir: ROOT });
  buildSync({ entryPoints: ["test/spike_workers/web/page.ts"], bundle: true, format: "iife", outfile: "build/spike_workers/web/page.js", logLevel: "warning", absWorkingDir: ROOT });
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try { build(); console.log("spike_workers: built build/spike_workers/"); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
}
