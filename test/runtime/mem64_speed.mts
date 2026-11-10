// npm run rt:mem64 [-- --rounds 15 --launches 3 --tiers default,liftoff,turbofan --doom-frames 600 --cube-frames 12000]
// What the 64-bit memory mode costs in the whole runtime, measured alone. The configurations, workloads and checks are
// in mem64_core.ts (the browser run, rt:mem64:browser, uses the same). This script starts `launches` processes per V8
// tier, the tiers interleaved; each process runs one warm-up round and `rounds` measured rounds, gc() before every run:
//   default    what Node does by itself: lazy compilation, Liftoff, dynamic tier-up to TurboFan; the "execution" of a
//              run also holds the lazy compilation of the code it reaches (compile is only decoding then)
//   liftoff    --liftoff-only --no-wasm-lazy-compilation: every translated module compiled by Liftoff when it is made
//   turbofan   --no-liftoff --no-wasm-lazy-compilation: every translated module compiled by TurboFan when it is made
//              (the steady state of tier-up, without waiting for it)
// Per tier, workload and configuration: execution, V8 compile and translator time (medians, with the range), and for
// memory64 and above 4 GB the median of the per-round ratios to memory32 in the same round of the same process with
// a 95 % interval (bootstrap over launches, then rounds). A program with the wrong stdout or exit code fails the run.
// The results also go to build/runtime/mem64_speed.json.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT, OUT, GUESTS, corpusList } from "./harness.mts";
import { Runtime, type RuntimeModules } from "../../src/glue/rt_runtime.ts";
import { layoutFor } from "../../src/glue/rt_process.ts";
import { bench, report, workloadNames, CONFIGS, type BenchInput, type Flat, type Samples, type Launch } from "./mem64_core.ts";

const argv = process.argv.slice(2);
const arg = (name: string, d: string) => { const i = argv.indexOf("--" + name); return i >= 0 ? argv[i + 1] : d; };
const rounds = Number(arg("rounds", "15")), launches = Number(arg("launches", "3")), tiers = arg("tiers", "default,liftoff,turbofan").split(",");
const doomFrames = Number(arg("doom-frames", "600")), cubeFrames = Number(arg("cube-frames", "12000"));
export const TIERS: Record<string, { flags: string[]; what: string }> = {
  default: { flags: [], what: "lazy compilation, Liftoff, dynamic tier-up (V8's default; execution includes lazy compile)" },
  liftoff: { flags: ["--liftoff-only", "--no-wasm-lazy-compilation"], what: "eager Liftoff only" },
  turbofan: { flags: ["--no-liftoff", "--no-wasm-lazy-compilation"], what: "eager TurboFan only (steady state)" },
};
const MEM = join(OUT, "mem64");
const DOOM_WAD = process.env.DOOM_WAD ?? (existsSync("/usr/share/games/doom/doom1.wad") ? "/usr/share/games/doom/doom1.wad" : "");

export function loadInput(o: { doomFrames: number; cubeFrames: number; doomRef: string[] | null }): BenchInput {
  const mods = (m64: boolean): RuntimeModules => { const mod = (n: string) => new WebAssembly.Module(readFileSync(join(OUT, n + (m64 ? "64" : "") + ".wasm")));
    return { rt: mod("rt"), kernel: mod("kernel"), loader: mod("loader"), translator: mod("translator"), helpers: mod("helpers"), gfx: mod("gfx"), fs: mod("fs"), hle: mod("hle"), audio: mod("audio") }; };
  const corpus = (dir: string): Flat[] => corpusList().map(name => { const side = JSON.parse(readFileSync(join(dir, name + ".json"), "utf8"));
    return { name, side, image: new Uint8Array(readFileSync(join(dir, side.image))), expected: new Uint8Array(readFileSync(join(dir, side.expected_stdout))) }; });
  const doomNso = join(ROOT, "build", "doom", "doom.nso");
  return { m32: mods(false), m64: mods(true), lo: corpus(join(ROOT, "test", "guests", "out")), hi: corpus(join(ROOT, "test", "a64", "guests", "out_hi")),
    cube: new Uint8Array(readFileSync(join(GUESTS, "cube.nso"))), cubeFrames: o.cubeFrames,
    doom: o.doomRef ? { nso: new Uint8Array(readFileSync(doomNso)), wad: new Uint8Array(readFileSync(DOOM_WAD)), ref: o.doomRef, frames: o.doomFrames } : undefined };
}

// ---- a measuring process ----
if (argv[0] === "--child") {
  const ref = existsSync(join(MEM, "doom_ref.txt")) ? readFileSync(join(MEM, "doom_ref.txt"), "utf8").split("\n").filter(Boolean) : null;
  const input = loadInput({ doomFrames, cubeFrames, doomRef: ref });
  const gc = (globalThis as any).gc as (() => void) | undefined;
  if (!gc) { console.error("[RED] rt:mem64: the measuring process needs --expose-gc"); process.exit(1); }
  let samples: Samples;
  try { samples = await bench(input, rounds, gc, l => console.error(`  [${argv[1]} ${argv[2]}]${l}`)); }
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
if (!lo.length || !existsSync(join(ROOT, "test", "a64", "guests", "out_hi", lo[0] + ".json")) || !existsSync(join(GUESTS, "cube.nso"))) {
  console.log("[RED] rt:mem64: build first: npm run rt:build && npm run a64:build && npm run guests:build && npm run a64:guests:build (and NXNATIVE for cube.nso: npm run rt:test builds it)");
  process.exit(1);
}
mkdirSync(MEM, { recursive: true });
// Doom: the engine (npm run doom:fetch), nvn.h (NXNATIVE) and the shareware data file (DOOM_WAD; Debian/Ubuntu package doom-wad-shareware)
let doomWhy = "";
{
  if (DOOM_WAD) process.env.DOOM_WAD = DOOM_WAD;
  const { buildDoom, doomSkip, doomReference } = await import("../doom/harness.mts");
  doomWhy = doomSkip(true);
  if (!doomWhy && !buildDoom(l => console.log(l))) doomWhy = "the Doom guest did not build";
  const ref = doomWhy ? null : doomReference(["-timedemo", "demo3"], l => console.log(l));
  if (!doomWhy && !ref) doomWhy = "the host build of the engine (the reference) failed";
  if (ref) writeFileSync(join(MEM, "doom_ref.txt"), ref.split("\n").filter(l => l.startsWith("REF ")).map(l => l.slice(4)).join("\n") + "\n");
  else rmRef();
}
function rmRef() { try { writeFileSync(join(MEM, "doom_ref.txt"), ""); } catch { /* none */ } }

// the corpus linked twice: the same sources and flags, only the base differs
const sameCode = (() => {
  const dl = join(ROOT, "test", "guests", "out"), dh = join(ROOT, "test", "a64", "guests", "out_hi");
  let sizes = 0, insns = 0, words = 0, diff = 0;
  for (const n of lo) {
    const a = JSON.parse(readFileSync(join(dl, n + ".json"), "utf8")), b = JSON.parse(readFileSync(join(dh, n + ".json"), "utf8"));
    const ia = readFileSync(join(dl, a.image)), ib = readFileSync(join(dh, b.image));
    if (ia.length === ib.length) sizes++;
    if (a.insn_count === b.insn_count) insns++;
    for (let i = 0; i + 4 <= Math.min(ia.length, ib.length); i += 4) { words++; if (ia.readUInt32LE(i) !== ib.readUInt32LE(i)) diff++; }
  }
  return `corpus at 0x0800_0000 and at 0x1_8000_0000: ${sizes}/${lo.length} images of equal size, ${insns}/${lo.length} with equal reference instruction counts, ${diff} of ${words} 32-bit words differ (addresses in code and data)`;
})();

interface Child { v8: string; node: string; execArgv: string[]; samples: Samples; memory: string[] }
const runs: Record<string, Child[]> = Object.fromEntries(tiers.map(t => [t, []]));
console.log(`rt:mem64: ${launches} launches x ${tiers.length} tiers (${tiers.join(", ")}), ${rounds} rounds each after one warm-up round; Doom ${doomWhy ? "SKIPPED: " + doomWhy : doomFrames + " frames"}, cube ${cubeFrames} frames`);
for (let l = 0; l < launches; l++) for (let k = 0; k < tiers.length; k++) {
  const tier = tiers[(k + l) % tiers.length], spec = TIERS[tier];
  if (!spec) { console.log(`[RED] rt:mem64: no tier ${tier}`); process.exit(1); }
  const args = ["--expose-gc", ...spec.flags, fileURLToPath(import.meta.url), "--child", tier, `launch ${l + 1}/${launches}`, "--rounds", String(rounds), "--doom-frames", String(doomFrames), "--cube-frames", String(cubeFrames), ...(l === 0 && tier === "default" ? ["--memory"] : [])];
  const r = spawnSync(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) { console.log(`[RED] rt:mem64: the ${tier} process (launch ${l + 1}) failed with exit code ${r.status}`); process.exit(1); }
  runs[tier].push(JSON.parse(r.stdout.trim().split("\n").pop()!));
}

// ---- report ----
const insns = lo.reduce((a, n) => a + (JSON.parse(readFileSync(join(ROOT, "test", "guests", "out", n + ".json"), "utf8")).insn_count ?? 0), 0);
const launchesOf = (t: string): Launch[] => runs[t].map(x => ({ engine: `node ${x.node}, V8 ${x.v8}`, flags: x.execArgv, samples: x.samples }));
const rep = report(tiers.map(t => ({ name: t, what: TIERS[t].what })), Object.fromEntries(tiers.map(t => [t, launchesOf(t)])), { rounds, ...workloadNames(lo.length, insns, cubeFrames, doomFrames) });
for (const l of rep.lines) console.log(l);
const headline = rep.headline, json: any = { rounds, launches, doomFrames, cubeFrames, sameCode, tiers: rep.json };
console.log("\nsame code above 4 GB: " + sameCode + "; cube and Doom load the same NSO file in every configuration");
const mem = runs.default?.[0]?.memory ?? [];
if (mem.length) { console.log("a default process (one run of hello):"); for (const l of mem) console.log(l); }
json.headline = headline;
writeFileSync(join(OUT, "mem64_speed.json"), JSON.stringify(json, null, 1));
console.log(`\nexecution time against memory32 (median of the paired per-round ratios, 95 % CI):\n  ${headline.join("\n  ")}`);
console.log(`\nrt:mem64: all outputs checked, ${((performance.now() - t0) / 60000).toFixed(1)} min; build/runtime/mem64_speed.json`);
