// npm run rt:mem64 [-- <rounds>]: what the 64-bit memory mode costs in the whole runtime (kernel, loader, translator
// and translated code on one memory), measured alone: the flat corpus through Runtime in three configurations,
// interleaved rounds in one process:
//   memory32      the wasm32 modules on a 32-bit memory
//   memory64      the wasm64 modules on a 64-bit memory, the process where it always was
//   memory64 hi   the same with the whole process above 4 GB (the corpus linked at 0x1_8000_0000)
// Run time without translation (as rt:guard counts it), guest instructions from the corpus' sidecars. Also what a
// default process holds: the linear memory's size and the resident memory of creating and running one program.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, OUT, corpusList } from "./harness.mts";
import { Runtime, type RuntimeModules } from "../../src/glue/rt_runtime.ts";
import { layoutFor } from "../../src/glue/rt_process.ts";

const rounds = Number(process.argv[2] ?? 9);
const mods = (m64: boolean): RuntimeModules => { const mod = (n: string) => new WebAssembly.Module(readFileSync(join(OUT, n + (m64 ? "64" : "") + ".wasm"))); return { rt: mod("rt"), kernel: mod("kernel"), loader: mod("loader"), translator: mod("translator"), helpers: mod("helpers") }; };
const corpus = (dir: string) => corpusList().filter(n => existsSync(join(dir, n + ".json"))).map(name => { const side = JSON.parse(readFileSync(join(dir, name + ".json"), "utf8")); return { name, side, image: new Uint8Array(readFileSync(join(dir, side.image))) }; });
const lo = corpus(join(ROOT, "test", "guests", "out")), hi = corpus(join(ROOT, "test", "a64", "guests", "out_hi"));
const m32 = mods(false), m64 = mods(true), hiLayout = layoutFor({}, { mem64: true, codeBase: 0x1_8000_0000 });
const insns = lo.reduce((a, g) => a + (g.side.insn_count ?? 0), 0);
const CONFIGS = [
  { name: "memory32", run: () => once(m32, lo, {}) },
  { name: "memory64", run: () => once(m64, lo, {}) },
  { name: "memory64 above 4 GB", run: () => once(m64, hi, { layout: hiLayout }) },
];
function once(m: RuntimeModules, set: typeof lo, o: object): number {
  let ms = 0;
  for (const g of set) {
    const rt = new Runtime(m, o);
    if (!rt.loadFlat(g.image, g.side)) throw new Error(g.name + ": load failed: " + rt.red.join(" | "));
    const r = rt.run();
    if (r.stop?.kind !== "exit") throw new Error(`${g.name}: ${r.stop?.fault?.lines[0] ?? r.stop?.kind}`);
    ms += rt.stats.runMs - rt.a64.translateNs / 1e6;
    rt.dispose();
  }
  return ms;
}
for (const c of CONFIGS) c.run();
const t: number[][] = CONFIGS.map(() => []);
for (let i = 0; i < rounds; i++) for (let k = 0; k < CONFIGS.length; k++) { const j = (k + i) % CONFIGS.length; t[j].push(CONFIGS[j].run()); }
const stat = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return { min: s[0], med: s[s.length >> 1] }; };
const base = stat(t[0]);
console.log(`rt:mem64 (node ${process.version}): ${lo.length} programs, ${(insns / 1e6).toFixed(1)} M guest instructions, ${rounds} interleaved rounds, run time without translation`);
CONFIGS.forEach((c, k) => { const s = stat(t[k]); console.log(`  ${c.name.padEnd(20)} best ${s.min.toFixed(0)} ms (${(insns / s.min / 1e3).toFixed(0)} M insn/s), median ${s.med.toFixed(0)} ms (${(insns / s.med / 1e3).toFixed(0)} M insn/s)` + (k ? `: ${((s.min / base.min - 1) * 100).toFixed(1)} % / ${((s.med / base.med - 1) * 100).toFixed(1)} % more time than memory32` : "")); });
// memory of a default process: created, one program loaded and run
const gc = (globalThis as any).gc as undefined | (() => void), rss = () => { gc?.(); return process.memoryUsage().rss / 2 ** 20; };
for (const [name, m, set, o] of [["memory32", m32, lo, {}], ["memory64", m64, lo, {}], ["memory64 above 4 GB", m64, hi, { layout: hiLayout }]] as const) {
  const before = rss(), g = set.find(x => x.name.startsWith("hello")) ?? set[0], rt = new Runtime(m, o);
  const made = rss();
  rt.loadFlat(g.image, g.side); rt.run();
  console.log(`  ${name.padEnd(20)} a process: linear memory ${(rt.memory.buffer.byteLength / 2 ** 20).toFixed(0)} MiB of address space after ${g.name}; resident memory +${(made - before).toFixed(0)} MiB when created, +${(rss() - before).toFixed(0)} MiB after the run`);
  rt.dispose();
}
