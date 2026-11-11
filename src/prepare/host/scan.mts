// `npm run prepare:scan -- <game folder | exefs folder | NSO file>... [--version N] [--json] [--max N]`
// The take-over scan of the prepare step's Code stage (src/glue/hle_scan.ts) from the command line: the SDK functions
// the game's modules define or import that nxnative takes over by name and nxweb does not answer yet
// (src/hle/gen/coverage.ts), by module, demangled name and nxnative file.
//   a game folder: the exefs of the version the prepare step picks (the newest update; --version N, 0 = the base game);
//   an exefs folder: every NSO file in it;   an NSO file: that module alone (a definition in another module is not seen).
// Exit code 1 when something is not answered.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { dynSymbols, takeOverSymbols, hleGaps, hleHeadline, hleLines, type DynSymbol } from "../../glue/hle_scan.ts";
import { NXNATIVE_REF, NXNATIVE_NAMES, NOT_ANSWERED } from "../../hle/gen/coverage.ts";
import { PrepWasm } from "./wasm.ts";
import { WASM, build as buildPrepare } from "./build.mts";
import { detectLayout, pickVersion, loadOrder } from "./detect.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string) => flag(n) ? argv[argv.indexOf(n) + 1] : undefined;
const max = opt("--max") !== undefined ? Number(opt("--max")) : Infinity;
const wanted = opt("--version") !== undefined ? Number(opt("--version")) : undefined;
const paths = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--max" && argv[i - 1] !== "--version");
const usage = "usage: npm run prepare:scan -- <game folder | exefs folder | NSO file>... [--version N] [--json] [--max N]";
if (!paths.length) { console.error(usage); process.exit(2); }
const die = (m: string): never => { console.error(`[RED] prepare:scan: ${m}`); process.exit(2); };
const isNso = (p: string) => { try { const b = readFileSync(p).subarray(0, 4); return b.length === 4 && b.toString("latin1") === "NSO0"; } catch { return false; } };
const nsosIn = (dir: string) => loadOrder(readdirSync(dir).filter(f => statSync(join(dir, f)).isFile() && isNso(join(dir, f)))).map(f => join(dir, f));

function walk(root: string): { files: { path: string; size: number; mtime: number }[]; dirs: string[] } {
  const files: { path: string; size: number; mtime: number }[] = [], dirs: string[] = [];
  const go = (rel: string, depth: number) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { dirs.push(p); if (depth < 4 && e.name !== "romfs") go(p, depth + 1); }
      else if (e.isFile()) { const st = statSync(join(root, p)); files.push({ path: p, size: st.size, mtime: st.mtimeMs }); }
    }
  };
  go("", 0);
  return { files: files.sort((a, b) => a.path < b.path ? -1 : 1), dirs: dirs.sort() };
}

const groups: { label: string; files: string[] }[] = [];
for (const p of paths) {
  if (!existsSync(p)) die(`${p}: no such file or folder`);
  if (!statSync(p).isDirectory()) { groups.push({ label: p, files: [p] }); continue; }
  const direct = nsosIn(p);
  if (direct.length) { groups.push({ label: p, files: direct }); continue; }
  try {
    const v = pickVersion(detectLayout(walk(p)), wanted);
    groups.push({ label: `${p} (${v.version ? `updates/${v.version}` : "the base game"})`, files: nsosIn(join(p, v.root + "exefs")) });
  } catch (e) { die(`${p}: ${(e as Error).message}`); }
}
if (!existsSync(WASM)) buildPrepare();
const prep = new PrepWasm(new WebAssembly.Module(readFileSync(WASM)));
const results = [];
let any = false;
for (const g of groups) {
  if (!g.files.length) die(`${g.label}: no NSO module in there`);
  const mods: { module: string; symbols: DynSymbol[] }[] = [];
  for (const f of g.files) {
    const bytes = new Uint8Array(readFileSync(f)), info = await prep.open(bytes);
    try {
      if ("error" in info) die(`${f}: ${info.error}`);
      const si = prep.scanInput(bytes);
      if (!si) die(`${f}: the module could not be unpacked`);
      mods.push({ module: basename(f), symbols: takeOverSymbols(dynSymbols(si!.image)) });
    } finally { prep.close(); }
  }
  const gaps = hleGaps(mods);
  any ||= gaps.length > 0;
  results.push({ game: g.label, modules: mods.map(m => m.module), gaps });
  if (!flag("--json")) {
    console.log(`${g.label}: ${mods.map(m => m.module).join(", ")}`);
    console.log(gaps.length ? hleHeadline(gaps) + ":" : `every SDK function of these modules that nxnative takes over is answered here`);
    for (const l of hleLines(gaps, max)) console.log("  " + l);
    console.log("");
  }
}
if (flag("--json")) console.log(JSON.stringify(results, null, 1));
else console.log(`(nxnative ${NXNATIVE_REF.slice(0, 12)}: ${NXNATIVE_NAMES} names taken over, ${NOT_ANSWERED.length} of them not answered in nxweb; tools/hle_coverage.py)`);
process.exit(any ? 1 : 0);
