// `npm run a64:mem64:speed [-- --rounds N] [--guard]`: the guest corpus in the translator's two memory modes, same
// machine, same process, the modes interleaved guest by guest in every round:
//   memory32          translator.wasm, a 32-bit memory, images at 0x0800_0000       (test/guests/out, test/a64/guests/out)
//   memory64          translator64.wasm, a 64-bit memory, the same images
//   memory64 high     translator64.wasm, a 64-bit memory, the images linked at 0x1_8000_0000 (test/a64/guests/out_hi)
// Run time is what runGuest reports without translation and compile. Per mode: guest instructions per second from
// the sum over the corpus, by the best round and by the median round, and per guest the ratio of the best rounds.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runGuest, defaultOpts, type GuestOpts } from "./guest_core.ts";

const root = new URL("../../", import.meta.url).pathname;
const argv = process.argv.slice(2);
const rounds = Number(argv[argv.indexOf("--rounds") + 1] && argv.includes("--rounds") ? argv[argv.indexOf("--rounds") + 1] : 9);
const guard = argv.includes("--guard"), guardAtBase = argv.includes("--guard-at-base");   // --guard: below 0x0800_0000 (the host area, as the runtime sets it); --guard-at-base: below each image, which for the high images is an offset above 4 GB in every memory instruction
const mod = (f: string) => new WebAssembly.Module(readFileSync(join(root, "build/a64", f)));
const t32 = mod("translator.wasm"), h32 = mod("helpers.wasm"), t64 = mod("translator64.wasm"), h64 = mod("helpers64.wasm");
interface G { name: string; side: any; image: Uint8Array; expected: Uint8Array }
const load = (dirs: string[]): G[] => dirs.filter(existsSync).flatMap(dir => readdirSync(dir).filter(f => f.endsWith(".json") && f !== "manifest.json").sort().map(f => {
  const side = JSON.parse(readFileSync(join(dir, f), "utf8"));
  return { name: f.replace(/\.json$/, ""), side, image: readFileSync(join(dir, side.image)), expected: readFileSync(join(dir, side.expected_stdout)) };
}));
const low = load([join(root, "test/guests/out"), join(root, "test/a64/guests/out")]);
const high = new Map(load([join(root, "test/a64/guests/out_hi")]).map(g => [g.name, g]));
if (!low.length || low.some(g => !high.has(g.name))) { console.log("[RED] a64 mem64 speed: the corpora are not built (npm run guests:build, a64:guests:build)"); process.exit(1); }

const MODES = ["memory32", "memory64", "memory64 high"] as const;
const opts = (m: number, g: G): GuestOpts => ({ ...defaultOpts, mem64: m > 0, ...(guardAtBase ? { guardBase: g.side.base } : guard ? { guardBase: 0x0800_0000 } : {}) });
const run = (m: number, g: G) => {
  const x = m === 2 ? high.get(g.name)! : g;
  const r = runGuest(m ? t64 : t32, m ? h64 : h32, g.name, x.side, x.image, x.expected, opts(m, x));
  if (!r.ok) { console.log(`[RED] ${MODES[m]} ${g.name}: ${r.why}`); process.exit(1); }
  return r.runMs;
};
// ms[mode][round][guest]
const ms: number[][][] = MODES.map(() => []);
for (let r = -1; r < rounds; r++) {   // round -1 warms the engine's caches and is not counted
  const row: number[][] = MODES.map(() => []);
  for (const g of low) {
    const order = [0, 1, 2].map(i => (i + Math.max(r, 0)) % 3);   // a different mode goes first each round
    for (const m of order) row[m].push(run(m, g));
  }
  if (r >= 0) MODES.forEach((_, m) => ms[m].push(row[m]));
}
const insns = low.reduce((a, g) => a + (g.side.insn_count ?? 0), 0);
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
const med = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];
const totals = ms.map(mode => mode.map(sum));
console.log(`a64 mem64 speed: ${low.length} guests, ${insns} guest instructions, ${rounds} rounds, modes interleaved${guardAtBase ? ", guard at each image's base" : guard ? ", guard at 0x0800_0000" : ""} (node ${process.version}, V8 ${process.versions.v8})`);
MODES.forEach((name, m) => {
  const best = Math.min(...totals[m]), mid = med(totals[m]);
  const rel = (a: number, b: number) => m ? ` (${((b / a - 1) * 100 >= 0 ? "+" : "") + ((b / a - 1) * 100).toFixed(1)} % run time against memory32)` : "";
  console.log(`  ${name.padEnd(14)} best round ${best.toFixed(0).padStart(5)} ms = ${(insns / best / 1000).toFixed(1).padStart(6)} M guest instructions/s${rel(Math.min(...totals[0]), best)}; median round ${mid.toFixed(0).padStart(5)} ms = ${(insns / mid / 1000).toFixed(1).padStart(6)} M/s${rel(med(totals[0]), mid)}`);
});
// per guest: best of the rounds, memory64 against memory32 (only guests that run for 2 ms or more say anything)
const best = (m: number, i: number) => Math.min(...ms[m].map(r => r[i]));
{
  // each guest's best round, summed: what the corpus takes when nothing else disturbs any of its programs
  const t = MODES.map((_, m) => sum(low.map((_, i) => best(m, i))));
  console.log(`  each guest's best round, summed: ` + MODES.map((name, m) => `${name} ${t[m].toFixed(0)} ms = ${(insns / t[m] / 1000).toFixed(1)} M/s` + (m ? ` (${((t[m] / t[0] - 1) * 100 >= 0 ? "+" : "") + ((t[m] / t[0] - 1) * 100).toFixed(1)} %)` : "")).join(", "));
}
const per = low.map((g, i) => ({ name: g.name, a: best(0, i), b: best(1, i), c: best(2, i) })).filter(x => x.a >= 2);
const ratio = per.map(x => x.b / x.a).sort((a, b) => a - b), ratioH = per.map(x => x.c / x.a).sort((a, b) => a - b);
const pct = (x: number) => ((x - 1) * 100 >= 0 ? "+" : "") + ((x - 1) * 100).toFixed(1) + " %";
console.log(`  per guest (the ${per.length} that run 2 ms or more, best rounds): memory64 run time against memory32: median ${pct(med(ratio))}, from ${pct(ratio[0])} to ${pct(ratio[ratio.length - 1])}; memory64 high: median ${pct(med(ratioH))}, from ${pct(ratioH[0])} to ${pct(ratioH[ratioH.length - 1])}`);
if (argv.includes("--each")) for (const x of per.sort((p, q) => q.b / q.a - p.b / p.a)) console.log(`    ${x.name.padEnd(22)} memory32 ${x.a.toFixed(1).padStart(7)} ms  memory64 ${x.b.toFixed(1).padStart(7)} ms (${pct(x.b / x.a)})  high ${x.c.toFixed(1).padStart(7)} ms (${pct(x.c / x.a)})`);
