// npm run shaders:sweep:test: tools/shaders/sweep.mts on a synthetic game, as a folder and as a .nup, in each memory mode
// (tools/modes.mjs). The stages are the hand-assembled programs of tools/shaders/maxwell_asm.py (NVN, in a BNSH, one of
// them in a Yaz0 SARC) and tools/shaders/ampere_asm.py (NVN2, in an NDSR pack and an NDVE file), plus three made from them:
// one the translator refuses and two the worker hangs on or dies on (SWEEP_SIMULATE, the worker's test hook).
// Nothing here comes from a game. Needs: npm run shaders:sweep:setup, python3 (the two assemblers).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrepWasm } from "../../src/prepare/host/wasm.ts";
import { scanFile } from "../../src/prepare/host/shader_scan.ts";
import { bnsh, nsoOf, sarc, yaz0 } from "../prepare/synth.mts";
import { writeNup, KIND } from "../prepare/nup_synth.mts";
import { categoryOf, firstLine, type SweepResults } from "../../tools/shaders/sweep.mts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const B = join(ROOT, "build/shaders"), W = join(B, "sweep_test"), MODE = process.env.NX_MEM ?? "32";
let passed = 0, failed = 0;
function ok(cond: unknown, what: string) { if (cond) passed++; else { failed++; console.log(`FAIL ${what}`); } }

for (const [dir, asm] of [["maxwell", "maxwell_asm.py"], ["ampere", "ampere_asm.py"]])
  if (!existsSync(join(B, dir, "corpus.json"))) execFileSync("python3", [join(ROOT, "tools/shaders", asm), join(B, dir)], { stdio: "inherit" });
const corpus = (dir: string) => (JSON.parse(readFileSync(join(B, dir, "corpus.json"), "utf8")) as { name: string; stage: string; control: string; code: string }[])
  .map(r => ({ ...r, ctl: new Uint8Array(readFileSync(join(B, dir, r.control))), bin: new Uint8Array(readFileSync(join(B, dir, r.code))) }));
const mx = corpus("maxwell"), am = corpus("ampere");
const IDX: Record<string, number> = { vs: 0, hs: 1, ds: 2, gs: 3, ps: 4, cs: 5 };
const variant = (b: Uint8Array, fill: number, from = 0x50) => { const c = b.slice(); c.fill(fill, from); return c; };

// NDSR: 16-byte records from +0x10 (control offset, control length << 4, code offset, code length / 16 << 8), a zero one, the sections
function ndsr(st: { ctl: Uint8Array; bin: Uint8Array }[]): Uint8Array {
  let top = (0x10 + 16 * (st.length + 1) + 0xff) & ~0xff;
  const at: [number, number][] = st.map(s => { const c = top; top = (c + s.ctl.length + 0xff) & ~0xff; const k = top; top = (k + s.bin.length + 0xff) & ~0xff; return [c, k]; });
  const d = new Uint8Array(top), dv = new DataView(d.buffer);
  d.set([0x4e, 0x44, 0x53, 0x52]);
  st.forEach((s, i) => {
    const [c, k] = at[i];
    dv.setUint32(0x10 + 16 * i, c, true); dv.setUint32(0x14 + 16 * i, s.ctl.length << 4, true);
    dv.setUint32(0x18 + 16 * i, k, true); dv.setUint32(0x1c + 16 * i, (s.bin.length >> 4) << 8, true);
    d.set(s.ctl, c); d.set(s.bin, k);
  });
  return d;
}
// NDVE: 'NDVE', the pack's length at +0xC, the count of 8-byte entries before the pack at +0x14, the pack from +0x18
function ndve(pack: Uint8Array): Uint8Array {
  const d = new Uint8Array(0x18 + pack.length), dv = new DataView(d.buffer);
  d.set([0x4e, 0x44, 0x56, 0x45]); dv.setUint32(0xc, pack.length, true); d.set(pack, 0x18);
  return d;
}

const byName = (n: string) => mx.find(r => r.name === n)!;
const vs = byName("vs_quad_ubo");
const bad = { ...vs, name: "bad", bin: variant(vs.bin, 0xff) };          // all-ones instruction words after the first few
const hang = { ...vs, name: "hang", bin: variant(vs.bin, 0x00, vs.bin.length - 8) };
const crash = { ...vs, name: "crash", bin: variant(vs.bin, 0x11, vs.bin.length - 8) };
const one = (r: typeof vs) => [{ stage: IDX[r.stage], control: r.ctl, code: r.bin }];
const romfs: Record<string, Uint8Array> = {
  "shaders/main.bnsh": bnsh(mx.filter(r => r.name !== "ps_bindless").map(one)),
  "shaders/pack.szs": yaz0(sarc({ "a.bnsh": bnsh([one(byName("ps_bindless")), one(bad), one(hang), one(crash)]) })),
  "nvn/effects.ndsr": ndsr(am.filter(r => r.stage !== "ps")),
  "nvn/net.ndve": ndve(ndsr(am.filter(r => r.stage === "ps"))),
  "nvn/zz_again.ndsr": ndsr(am),                                       // the same keys again (scanned last): swept once, seen twice
  "readme.txt": new TextEncoder().encode("no shaders here"),
};
const exefs: Record<string, Uint8Array> = { main: nsoOf(new Uint8Array(0x4000)), "main.npdm": new Uint8Array(0x100) };

rmSync(join(W, MODE), { recursive: true, force: true });
const game = join(W, MODE, "game");
for (const [p, b] of [...Object.entries(exefs).map(([k, v]) => [`base/exefs/${k}`, v] as const), ...Object.entries(romfs).map(([k, v]) => [`base/romfs/${k}`, v] as const)]) {
  mkdirSync(dirname(join(game, p)), { recursive: true }); writeFileSync(join(game, p), b);
}
const nupPath = join(W, MODE, "game.nup");
writeFileSync(nupPath, writeNup([{ kind: KIND.base, titleId: 0x0100000000ABC000n, exefs, romfs }]).bytes);

const pw = new PrepWasm(new WebAssembly.Module(readFileSync(join(ROOT, "build/prepare/prepare.wasm"))));
const keyOf = (path: string, code: Uint8Array) => scanFile(pw, path, romfs[path]).stages.find(s => Buffer.from(s.code).equals(Buffer.from(code)))!.key;
const K = { bad: keyOf("shaders/pack.szs", bad.bin), hang: keyOf("shaders/pack.szs", hang.bin), crash: keyOf("shaders/pack.szs", crash.bin) };

function sweep(input: string, out: string, extra: string[] = []): SweepResults {
  const r = spawnSync(process.execPath, [join(ROOT, "tools/shaders/sweep.mts"), input, "--out", out, "--jobs", "2", "--timeout", "8", ...extra], {
    env: { ...process.env, SWEEP_SIMULATE: `${K.hang}:hang,${K.crash}:crash` }, encoding: "utf8" });
  if (r.status !== 0) console.log(r.stdout, r.stderr);
  ok(r.status === 0, `sweep ${input} exits 0`);
  return JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
}
const t0 = performance.now();
const folder = sweep(game, join(W, MODE, "out-folder")), nup = sweep(nupPath, join(W, MODE, "out-nup"));
const ms = ((performance.now() - t0) / 1000).toFixed(1);

const expectStages = mx.length + am.length + 3;
for (const [name, r] of [["folder", folder], ["nup", nup]] as const) {
  const s = (k: string) => r.shaders.find(x => x.key === k);
  ok(r.finished && r.shaders.length === expectStages, `${name}: ${expectStages} distinct stages (got ${r.shaders.length})`);
  ok(r.counts.ok === expectStages - 3 && r.counts.failed === 1 && r.counts.crash === 1 && r.counts.timeout === 1, `${name}: counts ${JSON.stringify(r.counts)}`);
  for (const x of r.shaders.filter(x => x.status !== "ok" && ![K.bad, K.hang, K.crash].includes(x.key))) console.log(`  ${name} ${x.key} ${x.where}: ${x.status} ${x.error}`);
  ok(s(K.hang)?.status === "timeout" && s(K.hang)?.category === "timeout: over 8 s", `${name}: the hanging stage is a timeout`);
  ok(s(K.crash)?.status === "crash" && /^crash: the worker process died/.test(s(K.crash)?.category ?? ""), `${name}: the dying stage is a crash (${s(K.crash)?.category})`);
  ok(s(K.bad)?.status === "failed" && s(K.bad)?.phase && s(K.bad)?.category?.startsWith(s(K.bad)!.phase + ": "), `${name}: the refused stage failed with a category (${s(K.bad)?.category})`);
  ok(r.shaders.some(x => x.where.includes("#NDSR@")) && r.shaders.some(x => x.where.includes("#NDVE#NDSR@")) && r.shaders.some(x => x.where.includes(".szs")), `${name}: NDSR, NDVE and SARC stages found`);
  ok(am.every(a => r.shaders.some(x => x.where.includes("NDSR") && x.stage === a.stage && x.seen === 2)), `${name}: NVN2 stages swept once, seen twice`);
  ok(r.shaders.filter(x => x.status === "ok").every(x => x.translateMs > 0 && x.nagaMs > 0 && x.fixMs >= 0), `${name}: ok stages have translate, fix and naga times`);
  ok(r.shaders.some(x => x.stage === "cs" && x.status === "ok" && /compute/.test(x.runtime ?? "")), `${name}: the compute stage translates and says the runtime refuses it`);
  ok(r.scan.unreadable.length === 0 && r.scan.files === 1 + Object.keys(romfs).length, `${name}: every file scanned (${r.scan.files}, ${JSON.stringify(r.scan.unreadable)})`);
}
// the same stages, results and categories from the folder and the .nup
const norm = (r: SweepResults) => r.shaders.map(x => [x.key, x.stage, x.where.replace(/^.*?romfs\//, ""), x.seen, x.status, x.category ?? "", x.runtime ?? ""].join(" "));
ok(JSON.stringify(norm(folder)) === JSON.stringify(norm(nup)), "folder and .nup give the same results");

// no byte of a stage in the shareable output: every 32-byte window (step 16) of every control section and code
const outFiles = (d: string): Buffer[] => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? outFiles(join(d, e.name)) : [readFileSync(join(d, e.name))]);
const leaks = (d: string) => {
  const files = outFiles(d);
  for (const s of [...mx, ...am, bad, hang, crash]) for (const b of [s.ctl, s.bin]) for (let o = 0; o + 32 <= b.length; o += 16) {
    const w = Buffer.from(b.subarray(o, o + 32));
    if (w.every(v => v === w[0])) continue;
    if (files.some(f => f.includes(w))) return true;
  }
  return false;
};
ok(!leaks(join(W, MODE, "out-folder")) && !leaks(join(W, MODE, "out-nup")), "results.json and summary.md hold no shader bytes");
ok(!existsSync(join(W, MODE, "out-folder/records")), "no records/ without --keep-binaries");
const md = readFileSync(join(W, MODE, "out-folder/summary.md"), "utf8");
ok(md.includes("## Errors by category") && md.includes("## Slowest 20") && md.includes("| timeout | 1 |"), "summary.md has the counts, categories and slowest stages");

// --only and --keep-binaries
const okKey = folder.shaders.find(x => x.status === "ok" && x.stage === "ps")!.key;
const kept = sweep(game, join(W, MODE, "out-keep"), ["--only", `${okKey},${K.bad}`, "--keep-binaries"]);
ok(kept.shaders.length === 2 && kept.shaders.every(x => [okKey, K.bad].includes(x.key)), "--only sweeps the stages named");
const rec = readdirSync(join(W, MODE, "out-keep/records")).sort();
ok(["ctl", "code", "spv", "wgsl"].every(e => rec.includes(`${okKey}.ps.${e}`)) && rec.includes(`${K.bad}.vs.code`) && !rec.includes(`${K.bad}.vs.spv`), `--keep-binaries writes records/ (${rec.join(" ")})`);
ok(leaks(join(W, MODE, "out-keep")), "records/ holds the stage bytes");

// the helpers
ok(firstLine("\n  first\nsecond") === "first" && firstLine("word 0x" + "ab".repeat(16)) === "word <hex>", "firstLine");
ok(categoryOf("translate", "Invalid opcode 0x1234 at 56 in 0123456789abcdef (exit 1)") === "translate: Invalid opcode 0x# at # in <key>", "categoryOf");

// the same results in every memory mode: each run leaves its digest, a later one compares
const digest = JSON.stringify(norm(folder));
writeFileSync(join(W, `digest-${MODE}.json`), digest);
for (const m of ["32", "64", "64hi"]) if (m !== MODE && existsSync(join(W, `digest-${m}.json`)))
  ok(readFileSync(join(W, `digest-${m}.json`), "utf8") === digest, `NX_MEM=${MODE} gives the results of NX_MEM=${m}`);

console.log(`sweep (NX_MEM=${MODE}): ${passed} passed, ${failed} failed (two sweeps ${ms} s)`);
process.exit(failed ? 1 : 0);
