// EXPERIMENTAL (spike, SPIKE.md). Speed under Node worker_threads:
//   node test/spike_workers/bench.mts [--reps 7] [--only sha]
// Every guest on: green threads with today's unshared binaries, green threads with the shared build, 1, 2, 3 and 4
// Workers. Repetitions are interleaved (one of each configuration per round) so that load on the machine hits all alike.
import os from "node:os";
import { run, median, guest, type Config } from "./node_lib.mts";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const REPS = Number(arg("--reps", "7")), only = arg("--only", ""), spin = arg("--spin", ""), budget = arg("--budget", "");
const opts = { spin: spin ? Number(spin) : undefined, budget: budget ? Number(budget) : undefined };
console.log(`machine: ${os.cpus().length} logical CPUs (${os.cpus()[0].model}), Node ${process.version}; load average ${os.loadavg().map(x => x.toFixed(2)).join(" ")}; other jobs may be running`);
console.log(`${REPS} interleaved repetitions; wall time of the run phase (after boot, includes translation), ms: min / median${spin ? "; spin=" + spin : ""}${budget ? "; budget=" + budget : ""}\n`);

const CONFIGS: Config[] = ["unshared", "shared-green", 1, 2, 3, 4];
const label = (c: Config) => c === "unshared" ? "green unshared (today)" : c === "shared-green" ? "green shared" : `${c} Worker${c === 1 ? "" : "s"}`;
const GUESTS: [string, string][] = [
  ["bench_sha", "4 threads x SHA-256 over 64 KB x 400"], ["bench_lz", "4 threads x LZ77 of 64 KB x 500"],
  ["bench_contend", "4 threads x 40000 x (private work, shared atomic, one mutex)"], ["bench_svc", "4 threads x 60000 x (signal, wait, reset own event)"],
  ["bench_sha_1t", "1 thread x SHA-256 over 64 KB x 1600"], ["bench_lz_1t", "1 thread x LZ77 of 64 KB x 2000"],
];
for (const [name, what] of GUESTS) {
  if (only && !name.includes(only)) continue;
  const g = guest(name);
  const configs = name.endsWith("_1t") ? CONFIGS.filter(c => c === "unshared" || c === "shared-green" || c === 1) : CONFIGS;
  const walls = new Map<Config, number[]>(configs.map(c => [c, []]));
  const extra = new Map<Config, string>();
  let ref = "", bad = "";
  for (let r = 0; r < REPS; r++) for (const c of configs) {
    const res = await run(g, c, opts);
    if (res.fault) bad = `${label(c)}: ${res.fault.split("\n")[0]}`;
    if (!ref) ref = res.out; else if (res.out !== ref) bad = `${label(c)}: output differs: ${JSON.stringify(res.out)} vs ${JSON.stringify(ref)}`;
    walls.get(c)!.push(res.wallMs);
    const sum = (f: (s: (typeof res.stats)[0]) => number) => res.stats.reduce((n, s) => n + f(s), 0);
    extra.set(c, `SVCs ${sum(s => s.svcs)}, slices ${sum(s => s.slices)}, unwinds ${sum(s => s.unwinds)}, in-place resumes ${sum(s => s.inplaceResumes)}, idle waits ${sum(s => s.idleWaits)} (spin hits ${sum(s => s.spinHits)}), translate+compile ${sum(s => s.a64.translatorMs + s.a64.compileMs).toFixed(0)} ms, instantiate ${sum(s => s.a64.instantiateMs).toFixed(0)} ms`);
  }
  console.log(`### ${name}: ${what}\n${ref.trim()}${bad ? "\n[RED] " + bad : ""}`);
  const base = walls.get("unshared")!, bmin = Math.min(...base), bmed = median(base);
  console.log("| configuration | min ms | median ms | speedup vs today (min) | (median) | last run |\n|---|---|---|---|---|---|");
  for (const c of configs) {
    const w = walls.get(c)!, mn = Math.min(...w), md = median(w);
    console.log(`| ${label(c)} | ${mn.toFixed(0)} | ${md.toFixed(0)} | ${(bmin / mn).toFixed(2)}x | ${(bmed / md).toFixed(2)}x | ${extra.get(c)} |`);
  }
  console.log("");
}
