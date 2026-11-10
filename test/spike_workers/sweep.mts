// EXPERIMENTAL (spike). `node test/spike_workers/sweep.mts <reps> "<guest> <config> [key=value ...]" ...`
// Wall time of each given case, repetitions interleaved; min / median ms.
import os from "node:os";
import { run, median, type Config } from "./node_lib.mts";
const [reps = "3", ...specs] = process.argv.slice(2);
console.log(`machine: ${os.cpus().length} logical CPUs; load average ${os.loadavg().map(x => x.toFixed(2)).join(" ")}; ${reps} interleaved repetitions`);
const cases = specs.map(s => {
  const [g, c, ...rest] = s.split(" ");
  const opts: any = {};
  for (const [k, v] of rest.map(r => r.split("="))) opts[k] = v === "true" ? true : v === "false" ? false : isNaN(Number(v)) ? v : Number(v);
  return { spec: s, g, c: (c === "unshared" || c === "shared-green" ? c : Number(c)) as Config, opts, walls: [] as number[], note: "" };
});
for (let r = 0; r < Number(reps); r++) for (const k of cases) {
  const res = await run(k.g, k.c, k.opts);
  k.walls.push(res.wallMs);
  const sum = (f: (s: (typeof res.stats)[0]) => number) => res.stats.reduce((n, s) => n + f(s), 0);
  k.note = (res.fault ? "FAULT " + res.fault.split("\n")[0] + " " : "") + `SVCs ${sum(s => s.svcs)}, idle waits ${sum(s => s.idleWaits)}, spin hits ${sum(s => s.spinHits)}, unwinds ${sum(s => s.unwinds)}`;
}
for (const k of cases) console.log(`${k.spec.padEnd(40)} ${Math.min(...k.walls).toFixed(0).padStart(6)} / ${median(k.walls).toFixed(0).padStart(6)} ms   ${k.note}`);
