// npm run rt:mem64 [-- --rounds 15 --launches 10 --tiers default,dynamic,liftoff,turbofan --doom-frames 1500 --cpus 0-1/2-3]
// What the 64-bit memory mode costs in the whole runtime, measured alone. The configurations, workloads and checks are
// in mem64_core.ts (the browser run, rt:mem64:browser, uses the same). This script starts `launches` processes per V8
// tier, the tiers interleaved; each process runs one warm-up round and `rounds` measured rounds, gc() before every run:
//   default    what Node does by itself: lazy compilation, Liftoff, dynamic tier-up to TurboFan; the "execution" of a
//              run also holds the lazy Liftoff compilation of the code it reaches (compile is only decoding then)
//   dynamic    --no-wasm-lazy-compilation: the same tiers with every module compiled by Liftoff when it is made, so its
//              execution has no compilation in it; default minus dynamic is the lazy compilation (reported at the end)
//   liftoff    --liftoff-only --no-wasm-lazy-compilation: every translated module compiled by Liftoff when it is made
//   turbofan   --no-liftoff --no-wasm-lazy-compilation: every translated module compiled by TurboFan when it is made
//              (the steady state of tier-up, without waiting for it)
// --cpus pins the processes with taskset: each /-separated set of CPUs runs one process at a time, as many at once as
// there are sets. Per tier, workload and configuration: execution, V8 compile and translator time (medians, with the
// range), the GC pauses inside execution and compile (perf_hooks "gc" entries) and both phases without them, and for
// memory64 and above 4 GB the median of the per-round ratios to memory32 in the same round of the same process with
// a 95 % interval (bootstrap over launches, then rounds). A program with the wrong stdout or exit code, or a Doom
// frame that differs from the host build of the engine, fails the run. The results also go to build/runtime/mem64_speed.json.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PerformanceObserver } from "node:perf_hooks";
import { ROOT, OUT, corpusList } from "./harness.mts";
import { Runtime, type RuntimeModules } from "../../src/glue/rt_runtime.ts";
import { layoutFor } from "../../src/glue/rt_process.ts";
import { bench, report, workloadNames, sameCode, selfTestSameCode, bootstrapMedian, CONFIGS, type BenchInput, type Flat, type Samples, type Launch } from "./mem64_core.ts";

const argv = process.argv.slice(2);
const arg = (name: string, d: string) => { const i = argv.indexOf("--" + name); return i >= 0 ? argv[i + 1] : d; };
const rounds = Number(arg("rounds", "15")), launches = Number(arg("launches", "10")), tiers = arg("tiers", "default,dynamic,liftoff,turbofan").split(",");
const doomFrames = Number(arg("doom-frames", "1500")), cpus = arg("cpus", "").split("/").filter(Boolean);
export const TIERS: Record<string, { flags: string[]; what: string }> = {
  default: { flags: [], what: "V8's default: lazy compilation, Liftoff, dynamic tier-up; its execution includes the lazy Liftoff compile of the code a run reaches" },
  dynamic: { flags: ["--no-wasm-lazy-compilation"], what: "eager Liftoff, dynamic tier-up; execution without compilation" },
  liftoff: { flags: ["--liftoff-only", "--no-wasm-lazy-compilation"], what: "eager Liftoff only" },
  turbofan: { flags: ["--no-liftoff", "--no-wasm-lazy-compilation"], what: "eager TurboFan only (steady state)" },
};
const MEM = join(OUT, "mem64");
const DOOM_WAD = process.env.DOOM_WAD ?? (existsSync("/usr/share/games/doom/doom1.wad") ? "/usr/share/games/doom/doom1.wad" : "");
const LO = join(ROOT, "test", "guests", "out"), HI = join(ROOT, "test", "a64", "guests", "out_hi");
const flats = (dir: string): Flat[] => corpusList().map(name => { const side = JSON.parse(readFileSync(join(dir, name + ".json"), "utf8"));
  return { name, side, image: new Uint8Array(readFileSync(join(dir, side.image))), expected: new Uint8Array(readFileSync(join(dir, side.expected_stdout))) }; });

export function loadInput(o: { doomFrames: number; doomRef: string[] | null }): BenchInput {
  const mods = (m64: boolean): RuntimeModules => { const mod = (n: string) => new WebAssembly.Module(readFileSync(join(OUT, n + (m64 ? "64" : "") + ".wasm")));
    return { rt: mod("rt"), kernel: mod("kernel"), loader: mod("loader"), translator: mod("translator"), helpers: mod("helpers"), gfx: mod("gfx"), fs: mod("fs"), hle: mod("hle"), audio: mod("audio") }; };
  const same = sameCode(flats(LO), flats(HI)), doomNso = join(ROOT, "build", "doom", "doom.nso");
  return { m32: mods(false), m64: mods(true), lo: same.lo, hi: same.hi,
    doom: o.doomRef ? { nso: new Uint8Array(readFileSync(doomNso)), wad: new Uint8Array(readFileSync(DOOM_WAD)), ref: o.doomRef, frames: o.doomFrames } : undefined };
}

// ---- a measuring process ----
// --coverage [simulations]: how often the bootstrap interval holds the true median, for 3 and for `--launches`
// launches of `--rounds` rounds, launch effects N(0, 1) and rounds N(0, k^2) within a launch
if (argv[0] === "--coverage") {
  const sims = Number(argv[1] ?? 400); let s = 12345;
  const u = () => (s = (s * 1103515245 + 12345) % 2147483648, (s + 0.5) / 2147483648);
  const n = () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  for (const L of [3, launches]) for (const k of [0.5, 1, 2, 4]) {
    let hit = 0;
    for (let i = 0; i < sims; i++) {
      const b = bootstrapMedian(Array.from({ length: L }, () => { const m = n(); return Array.from({ length: rounds }, () => m + k * n()); }), 2000, i + 1);
      if (b.lo <= 0 && b.hi >= 0) hit++;
    }
    console.log(`${L} launches x ${rounds} rounds, round sd ${k} x launch sd: the 95 % interval holds the median in ${(hit / sims * 100).toFixed(1)} % of ${sims}`);
  }
  process.exit(0);
}

if (argv[0] === "--child") {
  const ref = existsSync(join(MEM, "doom_ref.txt")) ? readFileSync(join(MEM, "doom_ref.txt"), "utf8").split("\n").filter(Boolean) : null;
  const input = loadInput({ doomFrames, doomRef: ref });
  const gc = (globalThis as any).gc as (() => void) | undefined;
  if (!gc) { console.error("[RED] rt:mem64: the measuring process needs --expose-gc"); process.exit(1); }
  const seen: { s: number; d: number }[] = [];
  new PerformanceObserver(l => { for (const e of l.getEntries()) seen.push({ s: e.startTime, d: e.duration }); }).observe({ entryTypes: ["gc"] });
  const pauses = async (t0: number, t1: number) => {
    await new Promise(r => setTimeout(r, 20));   // the entries come in a later task
    const p = seen.filter(g => g.s + g.d > t0 && g.s < t1);
    seen.splice(0, seen.length, ...seen.filter(g => g.s >= t1));
    return p;
  };
  let samples: Samples;
  try { samples = await bench(input, rounds, { gc, pauses }, l => console.error(`  [${argv[1]} ${argv[2]}]${l}`)); }
  catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
  let memory: string[] = [];
  if (argv.includes("--memory")) memory = memoryLines(input);
  process.stdout.write(JSON.stringify({ v8: process.versions.v8, node: process.version, execArgv: process.execArgv, samples, memory }) + "\n");
  process.exit(0);
}
// what a default process holds: the linear memory's size and the resident memory of creating and running one program
function memoryLines(input: BenchInput): string[] {
  const sgn = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(0), gc = (globalThis as any).gc as () => void, rss = () => { gc(); return process.memoryUsage().rss / 2 ** 20; }, lines: string[] = [];
  for (const [k, m, set, o] of [[0, input.m32, input.lo, {}], [1, input.m64, input.lo, {}], [2, input.m64, input.hi, { layout: layoutFor({}, { mem64: true, codeBase: 0x1_8000_0000 }) }]] as const) {
    const before = rss(), g = set.find(x => x.name.startsWith("hello")) ?? set[0], rt = new Runtime(m, o), made = rss();
    rt.loadFlat(g.image, g.side); rt.run();
    lines.push(`  ${CONFIGS[k].padEnd(20)} linear memory ${(rt.memory.buffer.byteLength / 2 ** 20).toFixed(0)} MiB of address space after ${g.name}; resident ${sgn(made - before)} MiB when created, ${sgn(rss() - before)} MiB after the run`);
    rt.dispose();
  }
  return lines;
}

// ---- the parent: preparation, the launches, the report ----
const t0 = performance.now();
const lo = corpusList();
if (!lo.length || !existsSync(join(HI, lo[0] + ".json"))) {
  console.log("[RED] rt:mem64: build first: npm run rt:build && npm run a64:build && npm run guests:build && npm run a64:guests:build");
  process.exit(1);
}
if (cpus.length && spawnSync("taskset", ["-c", cpus[0], "true"]).status !== 0) { console.log(`[RED] rt:mem64: --cpus needs taskset and CPUs ${cpus.join(", ")}`); process.exit(1); }
mkdirSync(MEM, { recursive: true });
{ let st: string;
  try { st = selfTestSameCode(flats(LO), flats(HI)); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
  console.log(st); if (argv[0] === "--self-test") process.exit(0); }
// Doom: the engine (npm run doom:fetch), nvn.h (NXNATIVE) and the shareware data file (DOOM_WAD; Debian/Ubuntu package doom-wad-shareware)
let doomWhy = "";
{
  if (DOOM_WAD) process.env.DOOM_WAD = DOOM_WAD;
  const { buildDoom, doomSkip, doomReference } = await import("../doom/harness.mts");
  doomWhy = doomSkip(true);
  if (!doomWhy && !buildDoom(l => console.log(l))) doomWhy = "the Doom guest did not build";
  const ref = doomWhy ? null : doomReference(["-timedemo", "demo3"], l => console.log(l));
  if (!doomWhy && !ref) doomWhy = "the host build of the engine (the reference) failed";
  writeFileSync(join(MEM, "doom_ref.txt"), ref ? ref.split("\n").filter(l => l.startsWith("REF ")).map(l => l.slice(4)).join("\n") + "\n" : "");
}
const same = sameCode(flats(LO), flats(HI));

interface Child { v8: string; node: string; execArgv: string[]; samples: Samples; memory: string[] }
const runs: Record<string, Child[]> = Object.fromEntries(tiers.map(t => [t, []]));
console.log(`rt:mem64: ${launches} launches x ${tiers.length} tiers (${tiers.join(", ")}), ${rounds} rounds each after one warm-up round; Doom ${doomWhy ? "SKIPPED: " + doomWhy : doomFrames + " frames"}; ${cpus.length ? `pinned to CPUs ${cpus.join(" / ")}, one process per set` : "one process at a time, not pinned"}`);
const jobs: { tier: string; l: number }[] = [];
for (let l = 0; l < launches; l++) for (let k = 0; k < tiers.length; k++) {
  const tier = tiers[(k + l) % tiers.length];
  if (!TIERS[tier]) { console.log(`[RED] rt:mem64: no tier ${tier}`); process.exit(1); }
  jobs.push({ tier, l });
}
const results: (Child | undefined)[] = [];
async function slot(set: string | undefined) {
  for (let j; (j = jobs.findIndex((_, i) => !(i in results))) >= 0;) {
    const { tier, l } = jobs[j];
    results[j] = undefined;
    const args = ["--expose-gc", ...TIERS[tier].flags, fileURLToPath(import.meta.url), "--child", tier, `launch ${l + 1}/${launches}`, "--rounds", String(rounds), "--doom-frames", String(doomFrames), ...(l === 0 && tier === "default" ? ["--memory"] : [])];
    const [cmd, all] = set ? ["taskset", ["-c", set, process.execPath, ...args]] : [process.execPath, args];
    const p = spawn(cmd, all, { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.setEncoding("utf8").on("data", d => { out += d; });
    const code = await new Promise<number | null>(r => p.on("close", r));
    if (code !== 0) { console.log(`[RED] rt:mem64: the ${tier} process (launch ${l + 1}) failed with exit code ${code}`); process.exit(1); }
    results[j] = JSON.parse(out.trim().split("\n").pop()!);
  }
}
await Promise.all(cpus.length ? cpus.map(slot) : [slot(undefined)]);
jobs.forEach(({ tier }, j) => runs[tier].push(results[j]!));

// ---- report ----
const insns = same.lo.reduce((a, g) => a + (g.side.insn_count ?? 0), 0);
const launchesOf = (t: string): Launch[] => runs[t].map(x => ({ engine: `node ${x.node}, V8 ${x.v8}`, flags: x.execArgv, samples: x.samples }));
const rep = report(tiers.map(t => ({ name: t, what: TIERS[t].what })), Object.fromEntries(tiers.map(t => [t, launchesOf(t)])),
  { rounds, ...workloadNames(`${same.lo.length} programs, ${(insns / 1e6).toFixed(1)} M guest instructions`, doomFrames), lazy: ["default", "dynamic"] });
for (const l of rep.lines) console.log(l);
const headline = rep.headline, json: any = { rounds, launches, doomFrames, cpus, sameCode: same.line, tiers: rep.json };
console.log("\nsame code above 4 GB: " + same.line + "; Doom loads the same NSO file in every configuration");
const mem = runs.default?.[0]?.memory ?? [];
if (mem.length) { console.log("a default process (one run of hello):"); for (const l of mem) console.log(l); }
json.headline = headline;
writeFileSync(join(OUT, "mem64_speed.json"), JSON.stringify(json, null, 1));
console.log(`\nexecution time against memory32 (median of the paired per-round ratios, 95 % CI):\n  ${headline.join("\n  ")}`);
console.log(`\nrt:mem64: all outputs checked, ${((performance.now() - t0) / 60000).toFixed(1)} min; build/runtime/mem64_speed.json`);
