// node tools/modes.mjs <test script> [arguments]: one test runner in each memory mode.
//   NX_MEM=32    the modules built for a 32-bit linear memory (what every runner did before the 64-bit mode existed)
//   NX_MEM=64    the wasm64 builds (tools/asc64) on a 64-bit memory, the process where it always was
//   NX_MEM=64hi  the same with the whole process above 4 GB (code, heap, stacks, alias region, thread-local region,
//                host-allocated blocks): an address that was cut to 32 bits anywhere lands on untouched pages 4 GB
//                lower and the test fails instead of passing by luck
// With NX_MEM set, only that mode runs. The last line of each run is repeated at the end; the exit code is the worst.
// Node options a runner needs (--expose-gc) go before the script: node tools/modes.mjs --expose-gc test/x/run.mts
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2), nodeArgs = [];
while (argv.length && argv[0].startsWith("--")) nodeArgs.push(argv.shift());
const modes = process.env.NX_MEM ? process.env.NX_MEM.split(",") : ["32", "64", "64hi"];
const names = { "32": "memory32", "64": "memory64", "64hi": "memory64, the process above 4 GB" };
const summary = [];
let worst = 0;
for (const mode of modes) {
  if (modes.length > 1) console.log(`\n--- ${names[mode] ?? mode} (NX_MEM=${mode}) ---`);
  const r = spawnSync(process.execPath, [...nodeArgs, ...argv], { env: { ...process.env, NX_MEM: mode }, stdio: ["inherit", "pipe", "inherit"], encoding: "utf8", maxBuffer: 1 << 30 });
  process.stdout.write(r.stdout ?? "");
  const last = (r.stdout ?? "").trimEnd().split("\n").pop() ?? "";
  const code = r.status ?? 1;
  summary.push(`[${mode}] ${code ? "FAILED (exit " + code + ") " : ""}${last}`);
  if (code > worst) worst = code;
}
if (modes.length > 1) { console.log("\n--- all modes ---"); for (const s of summary) console.log(s); }
process.exit(worst);
