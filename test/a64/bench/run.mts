// The translator benchmark (npm run a64:bench): real-world-shaped aarch64 code (test/a64/bench/build.py) through
// the translator, against the same C compiled native and to wasm32 by clang. Each measurement is the median of
// --runs runs, interleaved; every translated run's output is checked against the native build's.
//   node test/a64/bench/run.mts [--runs 5] [--only zstd] [--mode memory32|memory64|memory64-high|all] [--json out.json]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runGuest, defaultOpts, type Result } from "../guest_core.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = join(root, "build/a64/bench");
const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const runs = Number(opt("--runs", "5"));
const only = opt("--only") ? new RegExp(opt("--only")!) : null;
const modeArg = opt("--mode", "memory32")!;
const libcArg = opt("--libc", "both")!;   // off | on | both: the C library functions as translated SDK code, as intrinsics
const libcRuns = libcArg === "both" ? [false, true] : [libcArg === "on"];
const LIBC = ["memcpy", "memmove", "memset", "memcmp", "memchr", "strlen", "strnlen", "strcmp", "strncmp"];
const modes0 = modeArg === "all" ? ["memory32", "memory64", "memory64-high"] : modeArg.split(",");
if (!existsSync(join(out, "zstd_bench.json"))) { console.error("[RED] no benchmark images: run npm run a64:bench:build"); process.exit(2); }
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const mods: Record<string, [WebAssembly.Module, WebAssembly.Module]> = {};
const tr = (m64: boolean) => mods[String(m64)] ??= [new WebAssembly.Module(readFileSync(join(root, `build/a64/translator${m64 ? "64" : ""}.wasm`))),
                                                     new WebAssembly.Module(readFileSync(join(root, `build/a64/helpers${m64 ? "64" : ""}.wasm`)))];

function wasmNative(name: string, expected: Uint8Array): number {
  const mod = new WebAssembly.Module(readFileSync(join(out, name + ".wasm")));
  const got: number[] = [];
  let mem!: WebAssembly.Memory;
  const inst = new WebAssembly.Instance(mod, { env: { out: (p: number, n: number) => { const b = new Uint8Array(mem.buffer, p, n); for (const x of b) got.push(x); } } });
  mem = inst.exports.memory as WebAssembly.Memory;
  const t0 = performance.now();
  (inst.exports.main as () => number)();
  const ms = performance.now() - t0;
  if (Buffer.compare(Buffer.from(got), Buffer.from(expected))) throw new Error(`${name}.wasm output differs`);
  return ms;
}
function native(name: string): number {
  const t0 = performance.now();
  const r = spawnSync(join(out, name + ".native"));
  if (r.status !== 0) throw new Error(`${name}.native exited ${r.status}`);
  return performance.now() - t0;
}

const report: any[] = [];
let bad = 0;
const modes = modes0.flatMap(m => libcRuns.map(l => m + (l ? "+libc" : "")));
for (const name of ["zstd_bench", "str_bench"]) {
  if (only && !only.test(name)) continue;
  const expected = readFileSync(join(out, name + ".out"));
  const nat: number[] = [], wn: number[] = [];
  const tx: Record<string, Result[]> = {};
  for (let i = 0; i < runs; i++) {
    nat.push(native(name)); wn.push(wasmNative(name, expected));
    for (const mode of modes) {
      const hi = mode.startsWith("memory64-high"), m64 = !mode.startsWith("memory32"), lc = mode.endsWith("+libc");
      const side = JSON.parse(readFileSync(join(out, name + (hi ? "_hi" : "") + ".json"), "utf8"));
      const image = readFileSync(join(out, side.image));
      const [t, h] = tr(m64);
      const libc = lc ? LIBC.filter(n => side.symbols[n] !== undefined).map(n => ({ pc: side.symbols[n], name: n })) : undefined;
      const r = runGuest(t, h, name, side, image, expected, { ...defaultOpts, mem64: m64, libc });
      if (!r.ok) { console.log(`[RED] a64:bench ${name} ${mode}: ${r.why}`); bad++; }
      (tx[mode] ??= []).push(r);
    }
  }
  const n = median(nat), w = median(wn);
  console.log(`${name}: native ${n.toFixed(1)} ms (process), wasm-native ${w.toFixed(1)} ms`);
  for (const mode of modes) {
    const rs = tx[mode], run = median(rs.map(r => r.runMs)), trm = median(rs.map(r => r.trMs));
    console.log(`  ${mode.padEnd(19)} translated run ${run.toFixed(1).padStart(7)} ms = ${(run / w).toFixed(2)}x wasm-native, ${(run / n).toFixed(2)}x native; translate ${trm.toFixed(0)} ms for ${rs[0].trInsns} insns in ${rs[0].funcs} funcs, ${rs[0].slices} slices${rs[0].libcTook?.length ? `, ${rs[0].libcTook.length} libc intrinsics ${rs[0].libcCalls} calls` : ""}${rs.every(r => r.ok) ? "" : "  FAILED"}`);
    report.push({ name, mode, nativeMs: n, wasmMs: w, runMs: run, trMs: trm, runs: rs.map(r => r.runMs), ok: rs.every(r => r.ok) });
  }
}
if (opt("--json")) writeFileSync(opt("--json")!, JSON.stringify(report, null, 1));
console.log(bad ? `a64:bench: ${bad} failed runs` : `a64:bench: all ${report.length} rows ok, ${runs} runs each (medians)`);
process.exit(bad ? 1 : 0);
