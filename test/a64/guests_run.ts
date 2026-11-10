// Gate 2 runner (Node): run every test guest (shared corpus + test/a64/guests/out) through the
// translator and compare stdout + exit code with the expected output.
// Usage: node guests_run.ts [--budget N] [--only REGEX] [--maxinsns N] [--maxfuncs N] [--nofma] [--nonan]
//                           [--notail] [--depth N] [--speed] [--quiet] [--dir DIR]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runGuest, defaultOpts, speedLine, totalLine, type Result } from "./guest_core.ts";

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
const only = opt("--only") ? new RegExp(opt("--only")!) : null;
const speed = argv.includes("--speed");
const quiet = argv.includes("--quiet");
const translator = new WebAssembly.Module(readFileSync(join(root, "build/a64/translator.wasm")));
const helpers = new WebAssembly.Module(readFileSync(join(root, "build/a64/helpers.wasm")));

const dirs = opt("--dir") ? [opt("--dir")!] : [join(root, "test/guests/out"), join(root, "test/a64/guests/out")].filter(existsSync);
const results: Result[] = [];
if (!quiet) console.log(`budget=${o.budget} maxInsns=${o.maxInsns} maxFuncs=${o.maxFuncs} fma=${o.fma} nanFix=${o.nanFix} tailCalls=${o.tailCalls} depthLimit=${o.depthLimit}`);
for (const dir of dirs) {
  for (const f of readdirSync(dir).filter(f => f.endsWith(".json") && f !== "manifest.json").sort()) {
    if (only && !only.test(f)) continue;
    let r: Result;
    const name = f.replace(/\.json$/, "");
    try {
      const side = JSON.parse(readFileSync(join(dir, f), "utf8"));
      r = runGuest(translator, helpers, name, side, readFileSync(join(dir, side.image)), readFileSync(join(dir, side.expected_stdout)), o);
    } catch (e) { r = { name, ok: false, why: "runner: " + String(e), insns: 0, runMs: 0, trMs: 0, trOnlyMs: 0, trInsns: 0, funcs: 0, bytes: 0, slices: 0, tableLen: 0 }; }
    results.push(r);
    if (speed) console.log(speedLine(r));
    if (argv.includes("--mem")) console.log(`     modules=${r.modules} largest=${r.maxModule} B total wasm=${r.bytes} B (${(r.bytes / Math.max(1, r.trInsns)).toFixed(1)} B/insn) table=${r.tableLen} translator memory=${((r.trMem ?? 0) / 1048576).toFixed(0)} MB process rss=${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
    else if (!quiet || !r.ok) console.log(`${r.ok ? "ok  " : "[RED] FAIL"} ${r.name}${r.ok ? "" : "  " + r.why}`);
  }
}
const failn = results.filter(r => !r.ok).length;
console.log(`guests: ${results.length - failn} passed, ${failn} failed`);
if (speed) console.log(totalLine(results));
process.exit(failn ? 1 : 0);
