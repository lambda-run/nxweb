// node tools/modes.mjs <test script> [arguments]: one test runner in each memory mode.
//   NX_MEM=32    the modules built for a 32-bit linear memory (what every runner did before the 64-bit mode existed)
//   NX_MEM=64    the wasm64 builds (tools/asc64) on a 64-bit memory, the process where it always was
//   NX_MEM=64hi  the same with the whole process above 4 GB (code, heap, stacks, alias region, thread-local region,
//                host-allocated blocks): an address that was cut to 32 bits anywhere lands on untouched pages 4 GB
//                lower and the test fails instead of passing by luck
// The shared-memory axis (RuntimeOptions.shared: the same modules on a shared WebAssembly.Memory, src/runtime/README.md):
//   NX_SHARED=1    each mode on a shared memory instead ([32s], [64s], [64his]); NX_SHARED=all: the unshared and the shared ones
//   NX_MEM=32s     one mode by name: a trailing "s" is the shared form (NX_MEM=32,32s runs both)
// The runner gets NX_MEM without the "s" and NX_SHARED=1 (or unset).
// With NX_MEM set, only that mode runs. The last line of each run is repeated at the end; the exit code is the worst.
// Node options a runner needs (--expose-gc) go before the script: node tools/modes.mjs --expose-gc test/x/run.mts
import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";

// Output goes out with blocking writes. When stdout is a pipe (CI), process.stdout.write hands the pipe 64 KiB and
// queues the rest for the event loop, which the spawnSync of the next step blocks; process.exit then drops it:
// everything after the first 64 KiB of a long run's output and the summary of the modes.
function emit(s) {
  const b = Buffer.from(s);
  for (let o = 0; o < b.length;) {
    try { o += writeSync(1, b, o); } catch (e) { if (e.code !== "EAGAIN") throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
  }
}
const say = (...a) => emit(a.join(" ") + "\n");

const argv = process.argv.slice(2), nodeArgs = [];
while (argv.length && argv[0].startsWith("--")) nodeArgs.push(argv.shift());
const want = process.env.NX_SHARED ?? "";
const base = process.env.NX_MEM ? process.env.NX_MEM.split(",") : ["32", "64", "64hi"];
const modes = base.flatMap(m => m.endsWith("s") ? [m] : want === "all" ? [m, m + "s"] : want === "1" ? [m + "s"] : [m]);
const baseNames = { "32": "memory32", "64": "memory64", "64hi": "memory64, the process above 4 GB" };
const names = new Proxy({}, { get: (_, m) => m.endsWith("s") ? (baseNames[m.slice(0, -1)] ?? m.slice(0, -1)) + ", shared memory" : baseNames[m] });
const summary = [];
let worst = 0;
for (const mode of modes) {
  if (modes.length > 1) say(`\n--- ${names[mode] ?? mode} (NX_MEM=${mode}) ---`);
  const r = spawnSync(process.execPath, [...nodeArgs, ...argv], { env: { ...process.env, NX_MEM: mode.replace(/s$/, ""), NX_SHARED: mode.endsWith("s") ? "1" : "" }, stdio: ["inherit", "pipe", "inherit"], encoding: "utf8", maxBuffer: 1 << 30 });
  emit(r.stdout ?? "");
  const last = (r.stdout ?? "").trimEnd().split("\n").pop() ?? "";
  const code = r.status ?? 1;
  summary.push(`[${mode}] ${code ? "FAILED (exit " + code + ") " : ""}${last}`);
  if (code > worst) worst = code;
}
if (modes.length > 1) { say("\n--- all modes ---"); for (const s of summary) say(s); }
process.exit(worst);
