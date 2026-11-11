// node tools/shaders/one.mts <sh-KEY.bin ...> [--out DIR] [--quiet]
// One stage through the page's chain outside the page: the translator (build/shaders/xlate_wasm), fixForWgsl, naga, as
// tools/shaders/sweep_worker.mts does it. The input is what the page's ?shaderdump= posts for a stage that failed
// (u32 control length, control, code). Prints one line per stage; with --out the translator's SPIR-V, the SPIR-V after
// the pass (when the pass got that far) and the WGSL are written there, for spirv-dis and reading.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { load } from "./naga_node.mts";
import { convertStage } from "../../src/shaders/convert.ts";
import { jobFor } from "../../src/shaders/job.ts";
import { fixForWgsl, type FixOptions } from "../../src/shaders/spv.ts";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argv = process.argv.slice(2), files: string[] = [];
let out = "", quiet = false;
for (let i = 0; i < argv.length; i++) { if (argv[i] === "--out") out = argv[++i]; else if (argv[i] === "--quiet") quiet = true; else files.push(argv[i]); }
if (!files.length) { console.error("usage: node tools/shaders/one.mts <sh-KEY.bin ...> [--out DIR] [--quiet]"); process.exit(2); }
if (out) mkdirSync(out, { recursive: true });

const { dotnet } = await import(pathToFileURL(join(ROOT, "build/shaders/xlate_wasm/_framework/dotnet.js")).href);
const lines: string[] = [];
const rt = await dotnet.withModuleConfig({ print: (l: string) => lines.push(l), printErr: (l: string) => lines.push(l) }).create();
const FS = rt.Module.FS;
FS.mkdir("/w");
const naga = await load(join(ROOT, "build/shaders/nx_naga.wasm"));
let serial = 0, ok = 0;
const kinds = new Map<string, number>();
for (const f of files) {
  const raw = new Uint8Array(readFileSync(f)), cl = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true);
  const key = basename(f).replace(/^sh-/, "").replace(/\.bin$/, ""), control = raw.subarray(4, 4 + cl), code = raw.subarray(4 + cl);
  let phase = "translate", stage = "?";
  try {
    const n = ++serial, dir = `/w/out${n}`, bin = `/w/${key}.bin`, jobs = `/w/jobs${n}.json`;
    const { job, body } = jobFor(key, control, code, bin);
    stage = (job as any).stage ?? "?";
    FS.writeFile(bin, body);
    const { mesh, ...xjob } = job;
    FS.writeFile(jobs, JSON.stringify([xjob]));
    lines.length = 0;
    const rc = await rt.runMain("xlate_wasm", [jobs, dir]);
    let spv: Uint8Array;
    try { spv = FS.readFile(`${dir}/${key}.spv`); } catch { throw new Error(`the translator wrote no SPIR-V (exit ${rc}): ${lines.filter(l => l.includes("[RED]")).join(" | ") || lines.slice(-2).join(" | ")}`); }
    let res: { sbufs?: FixOptions["sbufs"] } = {};
    try { res = JSON.parse(FS.readFile(`${dir}/${key}.res.json`, { encoding: "utf8" })); } catch { /* none */ }
    if (out) { writeFileSync(join(out, `${key}.xlate.spv`), spv); writeFileSync(join(out, `${key}.res.json`), JSON.stringify({ job: xjob, res }, null, 1)); }
    phase = "fix";
    const opts = { bindings: "nxweb" as const, sbufs: res.sbufs ?? [], mesh, c1: (job as any).c1 };
    if (out) { try { writeFileSync(join(out, `${key}.fixed.spv`), fixForWgsl(spv, opts as any).spv); } catch { /* the pass failed: convertStage says why */ } }
    const c = convertStage({ spvToWgsl(s: Uint8Array, flags?: number) { phase = "naga"; const w = naga.spvToWgsl(s, flags); phase = "fix"; return w; } }, spv, opts);
    if (out) writeFileSync(join(out, `${key}.wgsl`), c.wgsl);
    ok++;
    if (!quiet) console.log(`${key} ${stage}: ok (${c.wgsl.length} bytes of WGSL)`);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).replace(/\s+/g, " ");
    const kind = `${phase}: ` + msg.replace(/\b[0-9a-f]{16}\b/g, "<key>").replace(/handle: \[\d+\]/g, "handle:[N]").replace(/expr: \[\d+\]/g, "expr:[N]").replace(/Span \{[^}]*\}.*/, "<span>").slice(0, 150);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    if (!quiet) console.log(`${key} ${stage}: FAILED in ${phase}: ${msg.slice(0, 500)}`);
  }
}
console.log(`${ok} of ${files.length} ok`);
for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${k}`);
process.exit(0);
