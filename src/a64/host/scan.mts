// `npm run a64:scan -- <NSO file | folder | flat image>... [--raw] [--json] [--max N]`
// The static instruction scan (src/a64/scan.ts, src/glue/a64_scan.ts) from the command line: which instructions of a
// code module the translator has no translation for, by kind, with counts and the first offsets. The same scan the
// page's prepare step runs in its Code stage.
//   an NSO module (main, sdk, subsdk0, ...; compressed or not): unpacked by the prepare module, scanned by the
//     functions of its unwind table when it has one (text outside them is reported apart);
//   a folder: every NSO file in it (an exefs folder);
//   anything else, or with --raw: the whole file is taken as code (a flat image: its data is scanned too).
// Prints opcode classes, counts and module offsets only. Exit code 1 when an unsupported instruction was found.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { A64Scanner, scanLines, scanHeadline, type ModuleScan } from "../../glue/a64_scan.ts";
import { PrepWasm } from "../../prepare/host/wasm.ts";
import { ROOT, WASM, build as buildPrepare } from "../../prepare/host/build.mts";
import { a64Build } from "./build.mts";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const max = flag("--max") ? Number(argv[argv.indexOf("--max") + 1]) : 40;
const paths = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--max");
if (!paths.length) { console.error("usage: npm run a64:scan -- <NSO file | folder | flat image>... [--raw] [--json] [--max N]"); process.exit(2); }
const TR = join(ROOT, "build", "a64", "translator.wasm");
if (!existsSync(TR)) a64Build();
if (!existsSync(WASM)) buildPrepare();
const scanner = new A64Scanner(readFileSync(TR));
const prep = new PrepWasm(new WebAssembly.Module(readFileSync(WASM)));
const isNso = (b: Uint8Array) => b.length >= 0x100 && b[0] === 0x4E && b[1] === 0x53 && b[2] === 0x4F && b[3] === 0x30;

const files: string[] = [];
for (const p of paths) {
  if (!existsSync(p)) { console.error(`[RED] a64:scan: ${p}: no such file or folder`); process.exit(2); }
  if (statSync(p).isDirectory()) {
    for (const f of readdirSync(p).sort()) { const q = join(p, f); if (statSync(q).isFile() && (flag("--raw") || isNso(new Uint8Array(readFileSync(q).subarray(0, 0x100))))) files.push(q); }
  } else files.push(p);
}
if (!files.length) { console.error("[RED] a64:scan: no NSO module in there (--raw scans any file as code)"); process.exit(2); }
const results: { module: string; file: string; scan: ModuleScan }[] = [];
for (const f of files) {
  const bytes = new Uint8Array(readFileSync(f)), name = basename(f);
  const t0 = performance.now();
  let scan: ModuleScan;
  if (isNso(bytes) && !flag("--raw")) {
    const info = await prep.open(bytes);
    try {
      if ("error" in info) { console.error(`[RED] a64:scan: ${f}: ${info.error}`); process.exit(2); }
      const si = prep.scanInput(bytes);
      if (!si) { console.error(`[RED] a64:scan: ${f}: the module could not be unpacked`); process.exit(2); }
      scan = await scanner.scan(si.text, si.textOff, si.functions);
    } finally { prep.close(); }
  } else scan = await scanner.scan(bytes, 0, null);
  results.push({ module: name, file: f, scan });
  if (!flag("--json")) {
    for (const l of scanLines(name, scan, max)) console.log(l);
    console.log(`${name}: ${(100 * (scan.implemented + scan.implementedOutside) / Math.max(1, scan.words + scan.wordsOutside)).toFixed(3)} % of its words are translated instructions; scanned in ${((performance.now() - t0) / 1000).toFixed(2)} s\n`);
  }
}
if (flag("--json")) console.log(JSON.stringify(results, null, 1));
else console.log(scanHeadline(results) || `every instruction ${results.every(r => r.scan.functions !== null) ? "in the functions " : ""}of ${results.length === 1 ? "this module" : `these ${results.length} modules`} is supported`);
process.exit(results.some(r => r.scan.unsupported > 0) ? 1 : 0);
