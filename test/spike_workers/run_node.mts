// EXPERIMENTAL (spike, SPIKE.md). Correctness under Node worker_threads:
//   node test/spike_workers/run_node.mts [--runs 200] [--quick]
// The threads guest of test/runtime and the spike's stress guest, on green threads (both builds) and on 1..4 Workers,
// each run compared with the text every schedule must print. Then two demonstrations that are EXPECTED to differ:
// the race guest (schedule-dependent by design) and the stress guest with one helpers scratch area for all Workers.
// Not part of `npm test`.
import { build } from "../../src/spike_workers/build.mts";
import { run, modsSharedHelpers } from "./node_lib.mts";
import { series, demos, type Config, type RunFn } from "./series.ts";
import os from "node:os";

const arg = (n: string, d: number) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const RUNS = arg("--runs", 200), quick = process.argv.includes("--quick");
if (!process.argv.includes("--nobuild")) build();
console.log(`machine: ${os.cpus().length} logical CPUs (${os.cpus()[0].model}), Node ${process.version}; other jobs may be running`);

let failed = 0;
const runFn: RunFn = (g, c, o = {}) => { const { sharedHelpers, ...opts } = o; return run(g, c, sharedHelpers ? { ...opts, helpersPrivate: false } : opts, sharedHelpers ? modsSharedHelpers() : undefined); };
const one = async (guest: string, config: Config, runs: number, opts = {}, note = "") => { const r = await series(runFn, guest, config, runs, opts, note); console.log(r.line); if (!r.ok) failed++; };

const few = quick ? 3 : 20;
for (const g of ["threads", "stress"]) {
  await one(g, "unshared", few);
  await one(g, "shared-green", few);
  await one(g, 1, few);
  await one(g, 3, few);
  await one(g, 2, RUNS);
  await one(g, 4, RUNS);
}
await one("threads", 4, few, { inplace: false }, "(always unwind)");
await one("stress", 4, few, { inplace: false }, "(always unwind)");
await one("stress", 4, few, { budget: 2000 }, "(budget 2000)");
await one("threads", 4, few, { transport: "message" }, "(units by message)");
await one("stress", 4, few, { transport: "message" }, "(units by message)");
await one("dekker", 4, few);
await one("dekker", 3, few);

console.log("\ndemonstrations (differences are the point):");
for (const l of await demos(runFn, few)) console.log(l);
console.log(failed ? `\n[RED] spike_workers: ${failed} series failed` : "\nspike_workers: every series passed");
process.exit(failed ? 1 : 0);
