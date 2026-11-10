// Gate 2 runner (Node): run every test guest (shared corpus + test/a64/guests/out) through the
// translator and compare stdout + exit code with the expected output.
// Usage: node guests_run.ts [--budget N] [--only REGEX] [--maxinsns N] [--maxfuncs N] [--nofma] [--nonan]
//                           [--notail] [--depth N] [--speed] [--quiet] [--dir DIR]... [--mem64]
// --mem64: a 64-bit memory and the wasm64 translator (the memory64 mode). With --dir test/a64/guests/out_hi the
// images are the ones linked at 0x1_8000_0000 (test/a64/guests/build_hi.py): code, data and stack above 4 GB.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runGuest, defaultOpts, speedLine, totalLine, cacheKey, type Result } from "./guest_core.ts";
import { nodeFileStore } from "./cache_node.ts";

const root = new URL("../../", import.meta.url).pathname;
const argv = process.argv.slice(2);
function opt(name: string, def: string | null = null): string | null {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
}
const o = { ...defaultOpts };
o.budget = Number(opt("--budget", String(o.budget)));
o.maxInsns = Number(opt("--maxinsns", String(o.maxInsns)));
o.maxFuncs = Number(opt("--maxfuncs", String(o.maxFuncs)));
o.depthLimit = Number(opt("--depth", String(o.depthLimit)));
o.chunk = Number(opt("--chunk", String(o.chunk)));
o.fma = !argv.includes("--nofma");
o.nanFix = !argv.includes("--nonan");
o.tailCalls = !argv.includes("--notail");
o.rmodeArith = !argv.includes("--normarith");
o.shared = argv.includes("--shared");
o.cntYield = argv.includes("--cntyield");
o.preciseFaults = Number(opt("--precise", "0")) as 0 | 1 | 2;
o.mem64 = argv.includes("--mem64");
if (opt("--guard")) o.guardBase = Number(opt("--guard"));
const only = opt("--only") ? new RegExp(opt("--only")!) : null;
const store = opt("--cache") ? nodeFileStore(opt("--cache")!) : null;   // translation cache directory
const speed = argv.includes("--speed");
const quiet = argv.includes("--quiet");
const sfx = (o.mem64 ? "64" : "") + (o.shared ? ".shared.wasm" : ".wasm");
const translator = new WebAssembly.Module(readFileSync(join(root, "build/a64/translator" + sfx)));
const helpers = new WebAssembly.Module(readFileSync(join(root, "build/a64/helpers" + sfx)));

const dirArgs = argv.flatMap((a, i) => a === "--dir" ? [argv[i + 1]] : []);
const dirs = dirArgs.length ? dirArgs : [join(root, "test/guests/out"), join(root, "test/a64/guests/out")].filter(existsSync);
const results: Result[] = [];
if (!quiet) console.log(`budget=${o.budget} maxInsns=${o.maxInsns} maxFuncs=${o.maxFuncs} fma=${o.fma} nanFix=${o.nanFix} tailCalls=${o.tailCalls} depthLimit=${o.depthLimit} shared=${o.shared} cntYield=${o.cntYield} preciseFaults=${o.preciseFaults} mem64=${!!o.mem64}`);
for (const dir of dirs) {
  for (const f of readdirSync(dir).filter(f => f.endsWith(".json") && f !== "manifest.json").sort()) {
    if (only && !only.test(f)) continue;
    let r: Result;
    const name = f.replace(/\.json$/, "");
    try {
      const side = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const image = readFileSync(join(dir, side.image));
      const key = store ? await cacheKey(image, side, o) : "";
      const blob = store ? await store.get(key) : null;
      r = runGuest(translator, helpers, name, side, image, readFileSync(join(dir, side.expected_stdout)), { ...o, cacheIn: blob, wantCache: !!store && !blob });
      if (store && !blob && r.cacheBlob && r.ok) await store.put(key, r.cacheBlob);
      if (store) r.name += blob ? " (warm)" : " (cold)";
    } catch (e) { r = { name, ok: false, why: "runner: " + String(e), insns: 0, runMs: 0, trMs: 0, trOnlyMs: 0, trInsns: 0, funcs: 0, bytes: 0, slices: 0, tableLen: 0 }; }
    results.push(r);
    if (speed) console.log(speedLine(r));
    if (argv.includes("--mem")) console.log(`     modules=${r.modules} largest=${r.maxModule} B total wasm=${r.bytes} B (${(r.bytes / Math.max(1, r.trInsns)).toFixed(1)} B/insn) table=${r.tableLen} translator memory=${((r.trMem ?? 0) / 1048576).toFixed(1)} MB pc map=${((r.pcMapBytes ?? 0) / 1024).toFixed(0)} KB process rss=${(process.memoryUsage().rss / 1048576).toFixed(0)} MB cache hits=${r.cacheHits}${r.cacheBlob ? " cache blob=" + r.cacheBlob.length + " B" : ""}`);
    else if (!quiet || !r.ok) console.log(`${r.ok ? "ok  " : "[RED] FAIL"} ${r.name}${r.ok ? "" : "  " + r.why}`);
  }
}
const failn = results.filter(r => !r.ok).length;
console.log(`guests: ${results.length - failn} passed, ${failn} failed`);
if (speed) console.log(totalLine(results));
process.exit(failn ? 1 : 0);
