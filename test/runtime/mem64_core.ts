// The measuring half of `npm run rt:mem64` (Node, test/runtime/mem64_speed.mts) and `npm run rt:mem64:browser`
// (a Worker in Chromium or Firefox, test/runtime/mem64_browser.mts, whose Worker is the end of this file); no Node APIs. Three configurations of the whole
// runtime (kernel, loader, translator, HLE, graphics recorder and translated code on one memory):
//   memory32             the wasm32 modules on a 32-bit memory
//   memory64             the wasm64 modules on a 64-bit memory, the process where it always was
//   memory64 above 4 GB  the same with the whole process at 0x1_8000_0000
// and three workloads, each run in a fresh Runtime (no translation cache) and checked:
//   corpus  the flat corpus (test/guests/out; above 4 GB the same sources linked at 0x1_8000_0000, test/a64/guests/
//           out_hi): stdout and exit code of every program against the Unicorn reference
//   cube    the page's built-in demo (cube.nso) for a fixed number of frames on the null replayer, unpaced: its stdout
//   doom    the Doom guest under -timedemo demo3 for a fixed number of frames on the null replayer: every 50th tic's
//           frame checksum and player state against the same engine built for the host (test/doom/ref), its stdout
//           against memory32's (with addresses masked: the engine prints its zone pointer)
// The NSO workloads load the same file in all three configurations. Per run: translator time, V8 compile and
// instantiation of the translated modules (eager only with --no-wasm-lazy-compilation; lazily compiled code is
// compiled inside the run), execution (time inside Runtime.run without either), and for the frame loops the
// execution time of every frame.
import { Runtime, type RuntimeModules } from "../../src/glue/rt_runtime.ts";
import { layoutFor } from "../../src/glue/rt_process.ts";
import { bootGfx } from "./gfx_cases.ts";
import { bootDoom, fnv } from "../doom/boot.ts";
import type { Env } from "./cases.ts";

export const CONFIGS = ["memory32", "memory64", "memory64 above 4 GB"] as const;
export const WORKLOADS = ["corpus", "cube", "doom"] as const;
export type Workload = typeof WORKLOADS[number];
export interface Flat { name: string; side: any; image: Uint8Array; expected: Uint8Array }
export interface BenchInput {
  m32: RuntimeModules; m64: RuntimeModules;
  lo: Flat[]; hi: Flat[];
  cube: Uint8Array; cubeFrames: number;
  doom?: { nso: Uint8Array; wad: Uint8Array; ref: string[]; frames: number };   // ref: "tic fnv map health bullets x y" lines of the host build
}
export interface Sample {
  translatorMs: number; compileMs: number; execMs: number; wallMs: number;
  insns: number; wasmBytes: number;              // guest instructions translated, bytes of WebAssembly made
  p50?: number; p95?: number; frames?: number;   // frame loops: execution time per frame (ms)
}
// samples[workload][config][round]
export type Samples = Record<string, Sample[][]>;

const HI_LAYOUT = () => layoutFor({}, { mem64: true, codeBase: 0x1_8000_0000 });
const now = () => performance.now();
export function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b), n = s.length;
  return n === 0 ? NaN : n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
export function quantile(v: number[], q: number): number {   // linear interpolation between order statistics
  const s = [...v].sort((a, b) => a - b), x = (s.length - 1) * q, i = Math.floor(x);
  return i + 1 < s.length ? s[i] + (s[i + 1] - s[i]) * (x - i) : s[i];
}
const eqBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const fail = (m: string): never => { throw new Error("[RED] " + m); };

// Time inside Runtime.run (what stats.runMs counts) as a clock that can be read in the middle of a run, from a frame
// callback: the gaps runAsync leaves to the event loop are not in it
function runClock(rt: Runtime): () => number {
  let inRun = 0, start = 0;
  const orig = rt.run.bind(rt);
  rt.run = (l?: Parameters<Runtime["run"]>[0]) => { start = now(); try { return orig(l); } finally { inRun += now() - start; start = 0; } };
  return () => inRun + (start ? now() - start : 0) - rt.a64.translateNs / 1e6;
}
const phases = (rt: Runtime, wallMs: number, execMs: number): Sample => ({
  translatorMs: rt.a64.translatorNs / 1e6, compileMs: (rt.a64.translateNs - rt.a64.translatorNs) / 1e6, execMs, wallMs,
  insns: rt.a64.translatedInsns, wasmBytes: rt.a64.moduleBytes });
const frameStats = (s: Sample, ft: number[]): Sample => ({ ...s, frames: ft.length, p50: quantile(ft, 0.5), p95: quantile(ft, 0.95) });

function corpus(m: RuntimeModules, set: Flat[], o: object): Sample {
  const t: Sample = { translatorMs: 0, compileMs: 0, execMs: 0, wallMs: 0, insns: 0, wasmBytes: 0 };
  for (const g of set) {
    const w0 = now(), rt = new Runtime(m, o);
    if (!rt.loadFlat(g.image, g.side)) fail(`${g.name}: load failed: ${rt.red.join(" | ")}`);
    const r = rt.run();
    if (r.stop?.kind !== "exit") fail(`${g.name}: stopped by ${r.stop?.kind}: ${rt.red.at(-2) ?? ""}`);
    if (g.side.exit_code !== undefined && r.stop!.code !== Number(g.side.exit_code)) fail(`${g.name}: exit code ${r.stop!.code}, expected ${g.side.exit_code}`);
    if (!eqBytes(rt.stdoutBytes(), g.expected)) fail(`${g.name}: stdout differs from the reference (${rt.stdoutBytes().length} bytes, expected ${g.expected.length})`);
    const s = phases(rt, 0, rt.stats.runMs - rt.a64.translateNs / 1e6);
    rt.dispose();
    t.translatorMs += s.translatorMs; t.compileMs += s.compileMs; t.execMs += s.execMs; t.insns += s.insns; t.wasmBytes += s.wasmBytes; t.wallMs += now() - w0;
  }
  return t;
}

async function cube(m: RuntimeModules, nso: Uint8Array, frames: number, o: object): Promise<Sample> {
  const w0 = now(), ft: number[] = [];
  let clock = () => 0, last = 0;
  const p = await bootGfx({ mods: m } as Env, [{ name: "cube", bytes: nso }], { frames, unpaced: true, ...o,
    setup: q => { clock = runClock(q.rt); }, onPresent: () => { const t = clock(); if (last) ft.push(t - last); last = t; } });
  const r = await p.rt.runAsync();
  if (r.stop?.kind !== "exit" || r.stop.code !== 0) fail(`cube: stopped by ${r.stop?.kind} ${r.stop?.code}: ${p.rt.red.join(" | ")}`);
  const want = `cube: ${frames} frames, ${frames} pad reads, buttons seen 0x0\n`;
  if (p.rt.stdout() !== want || p.rt.red.length) fail(`cube: stdout ${JSON.stringify(p.rt.stdout())}, expected ${JSON.stringify(want)}; red lines: ${p.rt.red.join(" | ")}`);
  const s = phases(p.rt, now() - w0, p.rt.stats.runMs - p.rt.a64.translateNs / 1e6);
  p.rt.dispose();
  return frameStats(s, ft);
}

let doomStdout: string | undefined;   // memory32's, addresses masked
async function doom(m: RuntimeModules, d: NonNullable<BenchInput["doom"]>, o: object): Promise<Sample> {
  const w0 = now(), ft: number[] = [], got: string[] = [];
  let clock = () => 0, last = 0, lastTic = -1;
  const p = await bootDoom({ mods: m } as Env, d.nso, d.wad, { nsPerUnit: 20, args: "-timedemo demo3", ...o,
    setup: q => { clock = runClock(q.rt); },
    onFrame: f => {
      const t = clock(); if (f.n) ft.push(t - last); last = t;
      if (f.gametic !== lastTic && f.gametic % 50 === 0) { lastTic = f.gametic; got.push(`${f.gametic} ${fnv(f.pixels)} ${f.map} ${f.health} ${f.bullets} ${f.x} ${f.y}`); }
      return f.n + 1 >= d.frames;
    } });
  const r = await p.rt.runAsync();
  if (r.stop?.kind !== "exit" || r.stop.code !== 0 || p.rt.red.length) fail(`doom: stopped by ${r.stop?.kind} ${r.stop?.code}: ${p.rt.red.join(" | ")}`);
  if (p.frames !== d.frames) fail(`doom: ${p.frames} frames, expected ${d.frames}`);
  const want = d.ref.slice(0, got.length);
  if (got.length < Math.floor(d.frames / 50) - 1 || got.some((l, i) => l !== want[i])) fail(`doom: frames differ from the host build of the engine:\n  got  ${got.join(" / ")}\n  want ${want.join(" / ")}`);
  const out = p.rt.stdout().replace(/0x[0-9a-f]+/gi, "0x?");
  if (doomStdout === undefined) doomStdout = out; else if (out !== doomStdout) fail("doom: stdout differs between configurations:\n" + out);
  const s = phases(p.rt, now() - w0, p.rt.stats.runMs - p.rt.a64.translateNs / 1e6);
  p.rt.dispose();
  return frameStats(s, ft);
}

export function runOne(input: BenchInput, w: Workload, c: number): Promise<Sample> | Sample {
  const m = c ? input.m64 : input.m32, o = c === 2 ? { layout: HI_LAYOUT() } : {};
  if (w === "corpus") return corpus(m, c === 2 ? input.hi : input.lo, o);
  if (w === "cube") return cube(m, input.cube, input.cubeFrames, o);
  return doom(m, input.doom!, o);
}

// One unmeasured round, then `rounds` rounds; in every round each workload in each configuration, the configuration
// that goes first rotating; gc (when the host has one) before every run
export async function bench(input: BenchInput, rounds: number, gc?: () => void, progress?: (l: string) => void): Promise<Samples> {
  const ws = WORKLOADS.filter(w => w !== "doom" || input.doom);
  const out: Samples = Object.fromEntries(ws.map(w => [w, CONFIGS.map(() => [] as Sample[])]));
  for (let r = -1; r < rounds; r++) {
    const t0 = now();
    for (const w of ws) for (let k = 0; k < CONFIGS.length; k++) {
      const c = (k + Math.max(r, 0)) % CONFIGS.length;
      gc?.();
      const s = await runOne(input, w, c);
      if (r >= 0) out[w][c].push(s);
    }
    progress?.(`  round ${r < 0 ? "warm-up" : r + 1 + "/" + rounds} ${((now() - t0) / 1000).toFixed(1)} s`);
  }
  return out;
}

// ---- statistics: paired per-round ratios, a hierarchical bootstrap (launches, then rounds within each) ----
function rng(seed: number): () => number {   // mulberry32: the same intervals for the same data
  return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
}
// ratios[launch][round]: the median ratio over all launches and rounds, and its 95 % interval
export function bootstrapMedian(ratios: number[][], iters = 10000, seed = 1): { med: number; lo: number; hi: number } {
  const r = rng(seed), meds: number[] = [];
  for (let i = 0; i < iters; i++) {
    const pool: number[] = [];
    for (let j = 0; j < ratios.length; j++) { const l = ratios[Math.floor(r() * ratios.length)]; for (let k = 0; k < l.length; k++) pool.push(l[Math.floor(r() * l.length)]); }
    meds.push(median(pool));
  }
  return { med: median(ratios.flat()), lo: quantile(meds, 0.025), hi: quantile(meds, 0.975) };
}

// ---- the report: per tier (a set of launches with the same engine and flags), workload and configuration ----
export interface Launch { engine: string; flags: string[]; samples: Samples }
export interface ReportMeta { rounds: number; corpus: string; cube: string; doom: string }
export function report(tiers: { name: string; what: string }[], runs: Record<string, Launch[]>, meta: ReportMeta): { lines: string[]; headline: string[]; json: any } {
  const f = (v: number, d = 1) => v.toFixed(d), pct = (x: number) => ((x - 1) * 100 >= 0 ? "+" : "") + f((x - 1) * 100) + " %";
  const lines: string[] = [], headline: string[] = [], json: any = {};
  for (const { name: tier, what } of tiers) {
    const ch = runs[tier];
    if (!ch?.length) continue;
    lines.push("", `=== ${tier}: ${what}; ${ch[0].engine}; flags ${ch[0].flags.join(" ") || "(none)"}; ${ch.length} launches x ${meta.rounds} rounds ===`);
    const T: any = json[tier] = { engine: ch[0].engine, flags: ch[0].flags, workloads: {} };
    for (const w of Object.keys(ch[0].samples)) {
      lines.push(`  ${w} (${(meta as any)[w]})`);
      const W: any = T.workloads[w] = {};
      CONFIGS.forEach((name, c) => {
        const s = ch.flatMap(x => x.samples[w][c]), col = (m: keyof Sample) => s.map(x => x[m] as number);
        const rng = (m: keyof Sample, d = 1) => `${f(median(col(m)), d)} [${f(Math.min(...col(m)), d)}..${f(Math.max(...col(m)), d)}]`;
        const frames = s[0].p50 !== undefined, sizes = new Set(s.map(x => `${x.insns}/${x.wasmBytes}`));
        lines.push(`    ${name.padEnd(20)} execution ${rng("execMs")} ms; compile ${rng("compileMs")} ms; translator ${rng("translatorMs")} ms` +
          (frames ? `; frame p50 ${rng("p50", 3)} ms, p95 ${rng("p95", 3)} ms` : "") +
          `; ${s[0].insns} guest instructions translated into ${f(s[0].wasmBytes / 2 ** 20, 2)} MiB of wasm${sizes.size > 1 ? " (varies: " + [...sizes].join(", ") + ")" : ""}`);
        const C: any = W[name] = { n: s.length, insns: s[0].insns, wasmBytes: s[0].wasmBytes };
        for (const m of ["execMs", "compileMs", "translatorMs", ...(frames ? ["p50", "p95"] : [])] as (keyof Sample)[]) C[m] = median(col(m));
        if (!c) return;
        const parts: string[] = [];
        for (const m of ["execMs", "compileMs", "translatorMs", ...(frames ? ["p50", "p95"] : [])] as (keyof Sample)[]) {
          const rs = ch.map(x => x.samples[w][c].map((v, i) => (v[m] as number) / (x.samples[w][0][i][m] as number))), b = bootstrapMedian(rs);
          C[m + "Ratio"] = { median: b.med, lo: b.lo, hi: b.hi, perLaunch: rs.map(median) };
          const label = ({ execMs: "execution", compileMs: "compile", translatorMs: "translator", p50: "frame p50", p95: "frame p95" } as any)[m];
          parts.push(`${label} ${pct(b.med)} [${pct(b.lo)}, ${pct(b.hi)}]` + (m === "execMs" ? ` (launch medians ${rs.map(x => pct(median(x))).join(", ")})` : ""));
          if (m === "execMs") headline.push(`${tier.padEnd(18)} ${w.padEnd(7)} ${name.padEnd(20)} ${pct(b.med).padStart(8)}  [${pct(b.lo)}, ${pct(b.hi)}]`);
        }
        lines.push(`      vs memory32 (paired per round, median, 95 % CI): ${parts.join("; ")}`);
      });
    }
  }
  return { lines, headline, json };
}
export const workloadNames = (programs: number, insns: number, cubeFrames: number, doomFrames: number) => ({
  corpus: `${programs} programs, ${(insns / 1e6).toFixed(1)} M guest instructions, stdout and exit code checked`,
  cube: `the built-in demo, ${cubeFrames} frames, null replayer, unpaced; stdout checked`,
  doom: `-timedemo demo3, ${doomFrames} frames, null replayer; every 50th tic checked against the host build of the engine`,
});

// ---- the Worker of rt:mem64:browser (this file is its bundle's entry): the modules and workloads from the test
// server, the rounds, the samples posted back ----
const bytes = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());
if (typeof (globalThis as any).WorkerGlobalScope !== "undefined") self.onmessage = async () => {
  try {
    const cfg: { corpus: string[]; rounds: number; cubeFrames: number; doomFrames: number; doomRef: string[] | null } = await (await fetch("/config")).json();
    const mods = async (m64: boolean) => {
      const [rt, kernel, loader, translator, helpers, gfx, fs, hle, audio] = await Promise.all(["rt", "kernel", "loader", "translator", "helpers", "gfx", "fs", "hle", "audio"].map(async n => WebAssembly.compile(await bytes(`/wasm/${n}${m64 ? "64" : ""}.wasm`))));
      return { rt, kernel, loader, translator, helpers, gfx, fs, hle, audio };
    };
    const corpus = (dir: string) => Promise.all(cfg.corpus.map(async (name): Promise<Flat> => {
      const side = await (await fetch(`/${dir}/${name}.json`)).json();
      return { name, side, image: await bytes(`/${dir}/${side.image}`), expected: await bytes(`/${dir}/${side.expected_stdout}`) };
    }));
    const input: BenchInput = { m32: await mods(false), m64: await mods(true), lo: await corpus("lo"), hi: await corpus("hi"), cube: await bytes("/cube.nso"), cubeFrames: cfg.cubeFrames,
      doom: cfg.doomRef ? { nso: await bytes("/doom.nso"), wad: await bytes("/doom1.wad"), ref: cfg.doomRef, frames: cfg.doomFrames } : undefined };
    const gc = (self as any).gc as (() => void) | undefined;
    const samples = await bench(input, cfg.rounds, gc, l => (self as any).postMessage({ progress: l }));
    (self as any).postMessage({ done: true, samples, gc: !!gc, isolated: self.crossOriginIsolated });
  } catch (e) { (self as any).postMessage({ done: true, fatal: e instanceof Error ? e.message : String(e) }); }
};
