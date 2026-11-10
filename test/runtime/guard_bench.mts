// npm run rt:guard [-- <runs> <rounds>]: what `guard: true` (guest loads and stores below 0x0800_0000 trap) costs,
// measured alone: the 61-image corpus, run time without translation, guard on against off, interleaved rounds, several
// runs. Run it on a machine that does nothing else; the decision rule (src/runtime/README.md, "Memory safety"): the
// guard is the default when its cost is under 5 %.
import { loadEnv } from "./harness.mts";
import { Runtime } from "../../src/glue/rt_runtime.ts";

const env = loadEnv(), runs = Number(process.argv[2] ?? 5), rounds = Number(process.argv[3] ?? 9);
const once = (guard: boolean): number => {
  let ms = 0;
  for (const g of env.corpus) {
    const rt = new Runtime(env.mods, { guard });
    if (!rt.loadFlat(g.image, g.side)) throw new Error(g.name + ": load failed");
    const r = rt.run();
    if (r.stop?.kind !== "exit") throw new Error(`${g.name} with guard ${guard}: ${rt.red.at(-2) ?? r.stop?.kind}`);
    ms += rt.stats.runMs - rt.a64.translateNs / 1e6;
  }
  return ms;
};
const stat = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return { min: s[0], med: s[s.length >> 1], mean: s.reduce((a, b) => a + b, 0) / s.length }; };
const pct = (x: number, y: number) => (x / y - 1) * 100;
const mins: number[] = [], meds: number[] = [], means: number[] = [], pairs: [number, number][] = [];
once(true); once(false);
for (let run = 1; run <= runs; run++) {
  const on: number[] = [], off: number[] = [];
  // the order within a round alternates, so that neither setting always runs on a warmer machine
  for (let i = 0; i < rounds; i++) { if (i & 1) { off.push(once(false)); on.push(once(true)); } else { on.push(once(true)); off.push(once(false)); } }
  const a = stat(on), b = stat(off);
  on.forEach((v, i) => pairs.push([v, off[i]]));
  mins.push(pct(a.min, b.min)); meds.push(pct(a.med, b.med)); means.push(pct(a.mean, b.mean));
  console.log(`run ${run}: ${rounds} rounds; guard on min ${a.min.toFixed(0)} / median ${a.med.toFixed(0)} / mean ${a.mean.toFixed(0)} ms; off ${b.min.toFixed(0)} / ${b.med.toFixed(0)} / ${b.mean.toFixed(0)} ms; cost ${pct(a.min, b.min).toFixed(1)} % (min), ${pct(a.med, b.med).toFixed(1)} % (median), ${pct(a.mean, b.mean).toFixed(1)} % (mean)`);
}
const avg = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
// every round is a pair run back to back: the paired differences say how sure the figure is
const d = pairs.map(([a, b]) => pct(a, b)), m = avg(d), se = Math.sqrt(d.reduce((s, v) => s + (v - m) ** 2, 0) / (d.length - 1) / d.length);
const sd = [...d].sort((a, b) => a - b), cut = Math.floor(sd.length / 10), trimmed = avg(sd.slice(cut, sd.length - cut));
console.log(`rt:guard: ${d.length} pairs: mean of the paired differences ${m.toFixed(2)} % +- ${se.toFixed(2)} (standard error; 95 %: ${(m - 1.96 * se).toFixed(1)} .. ${(m + 1.96 * se).toFixed(1)} %), median ${sd[sd.length >> 1].toFixed(2)} %, mean without the outer tenths ${trimmed.toFixed(2)} %; total time on ${(pairs.reduce((s, p) => s + p[0], 0) / 1000).toFixed(1)} s, off ${(pairs.reduce((s, p) => s + p[1], 0) / 1000).toFixed(1)} s (${pct(pairs.reduce((s, p) => s + p[0], 0), pairs.reduce((s, p) => s + p[1], 0)).toFixed(2)} %)`);
console.log(`rt:guard (node ${process.version}, ${env.corpus.length} images): over ${runs} runs the guard costs ${avg(mins).toFixed(1)} % by the minima (${Math.min(...mins).toFixed(1)} .. ${Math.max(...mins).toFixed(1)}), ${avg(meds).toFixed(1)} % by the medians (${Math.min(...meds).toFixed(1)} .. ${Math.max(...meds).toFixed(1)}), ${avg(means).toFixed(1)} % by the means`);
