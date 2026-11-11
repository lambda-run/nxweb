// `npm run shaders:test`: the shader chain's tests.
//   Node:    SPIR-V reader / writer, the library format and its loader, the GLSL corpus against test/shaders/corpus/expect.json, spirv-val on every rewritten module,
//            the hand-assembled Maxwell programs through nxnative's translator (when dotnet and the translator are there), garbage into every stage.
//   Browser: every WGSL module compiled by Chromium's own compiler, the end-to-end scene rendered with WebGPU on SwiftShader and its pixels compared, the conversion
//            run inside the page. `--no-browser` leaves that half out.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, extname, normalize, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse, serialize, fixForWgsl } from "../../src/shaders/spv.ts";
import { ShaderLibrary, writeLibrary, unsupportedExtra, type Reflection } from "../../src/shaders/library.ts";
import { build, glslToSpv } from "../../tools/shaders/build_lib.mts";
import { load } from "../../tools/shaders/naga_node.mts";
import { jobFor, keyControl, ctlLens } from "../../src/shaders/job.ts";
import { convertStage } from "../../src/shaders/convert.ts";
import { imageVariant, formatClass } from "../../src/shaders/images.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../.."), OUT = join(ROOT, "build/shaders");
mkdirSync(OUT, { recursive: true });
let ran = 0, failed = 0;
async function test(name: string, f: () => void | string | Promise<void | string>) {
  ran++;
  try { const note = await f(); console.log(`ok   ${name}${note ? `  (${note})` : ""}`); } catch (e: any) { failed++; console.error(`[RED] FAIL ${name}\n     ${String(e.stack ?? e).split("\n").slice(0, 6).join("\n     ")}`); }
}
function eq(a: unknown, b: unknown, what: string) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${what}: got ${x}, want ${y}`); }
function throws(f: () => unknown, re: RegExp, what: string) { try { f(); } catch (e: any) { if (!re.test(String(e.message))) throw new Error(`${what}: threw "${e.message}", want ${re}`); return; } throw new Error(`${what}: did not throw`); }
const have = (cmd: string, arg = "--version") => spawnSync(cmd, [arg], { stdio: "ignore" }).status === 0;

const naga = await load();
const CORPUS = join(ROOT, "test/shaders/corpus"), E2E = join(ROOT, "test/shaders/e2e");
const corpus = await build({ glsl: CORPUS });
writeFileSync(join(OUT, "corpus.nxsl"), corpus.library); writeFileSync(join(OUT, "corpus.report.json"), JSON.stringify(corpus.report, null, 1));
// the corpus again as for a device with WebGPU subgroups (warp operations as WGSL subgroup builtins, src/shaders/spv_subgroups.ts)
const corpusSg = await build({ glsl: CORPUS, subgroups: "native" });
writeFileSync(join(OUT, "corpus_sg.nxsl"), corpusSg.library);
const e2e = await build({ glsl: E2E });
writeFileSync(join(OUT, "e2e.nxsl"), e2e.library);
const byName = (r: typeof corpus, n: string) => { const x = r.report.find(e => e.name === n)!; return { ...x, entry: r.entries.find(e => e.key === x.key) }; };

await test("SPIR-V: parse and serialize give the bytes back (every corpus module)", () => {
  let n = 0;
  for (const m of JSON.parse(readFileSync(join(CORPUS, "manifest.json"), "utf8"))) { const b = glslToSpv(join(CORPUS, m.file)); eq(Buffer.from(serialize(parse(b))).toString("hex"), Buffer.from(b).toString("hex"), m.file); n++; }
  return `${n} modules`;
});
await test("SPIR-V: garbage is refused with a reason", () => {
  throws(() => parse(new Uint8Array(7)), /whole number of words/, "7 bytes");
  throws(() => parse(new Uint8Array(64)), /magic/, "zeros");
  const cut = glslToSpv(join(E2E, "tex.frag")).slice(); new DataView(cut.buffer).setUint32(20, 0xffff0011, true);
  throws(() => parse(cut), /runs past the end/, "an instruction longer than the file");
  throws(() => naga.spvToWgsl(new Uint8Array(40)), /cannot read the SPIR-V/, "naga on zeros");
});
await test("corpus: each stage converts or fails as test/shaders/corpus/expect.json says", () => {
  const expect: Record<string, string> = JSON.parse(readFileSync(join(CORPUS, "expect.json"), "utf8"));
  const bad: string[] = [];
  for (const r of corpus.report) {
    const want = expect[r.name];
    if (want === undefined) bad.push(`${r.name}: not in expect.json (${r.ok ? "ok" : r.error})`);
    else if (want === "ok" ? !r.ok : r.ok || !r.error!.includes(want)) bad.push(`${r.name}: want ${want}, got ${r.ok ? "ok" : r.error}`);
  }
  for (const n of Object.keys(expect)) if (!corpus.report.some(r => r.name === n)) bad.push(`${n}: in expect.json, not in the corpus`);
  if (bad.length) throw new Error(bad.join("\n     "));
  return `${corpus.report.filter(r => r.ok).length} convert, ${corpus.report.filter(r => !r.ok).length} refused`;
});
await test("SPIR-V pass: every rewritten module passes spirv-val", () => {
  if (!have("spirv-val")) return "SKIPPED: spirv-val is not installed";
  const d = mkdtempSync(join(tmpdir(), "nxsl-val-")); let n = 0;
  for (const dir of [CORPUS, E2E]) for (const m of JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))) {
    let f; try { f = fixForWgsl(glslToSpv(join(dir, m.file)), { bindings: "keep" }); } catch { continue; }
    writeFileSync(join(d, "m.spv"), f.spv);
    const r = spawnSync("spirv-val", [join(d, "m.spv")], { encoding: "utf8" });
    if (r.status) throw new Error(`${m.file}: ${r.stderr.trim()}`);
    n++;
  }
  return `${n} modules`;
});
await test("SPIR-V pass: warp operations, native (WGSL subgroups, a 32-lane warp view) and one-invocation subgroups; vertex shaders always the latter", () => {
  const cases = JSON.parse(readFileSync(join(CORPUS, "manifest.json"), "utf8")).filter((m: any) => m.name.startsWith("subgroup_"));
  const d = mkdtempSync(join(tmpdir(), "nxsl-sg-")), warp = (b: Uint8Array) => parse(b).insts.filter(i => i.op >= 333 && i.op <= 366).length;
  for (const m of cases) {
    const spv = glslToSpv(join(CORPUS, m.file)), vertex = m.file.endsWith(".vert");
    if (!warp(spv)) throw new Error(`${m.name}: glslang wrote no warp operation`);
    const one = fixForWgsl(spv, { bindings: "keep", subgroups: "single" }), nat = fixForWgsl(spv, { bindings: "keep", subgroups: "native" });
    eq([one.subgroups, nat.subgroups, warp(one.spv)], ["single", vertex ? "single" : "native", 0], `${m.name}: paths taken, warp operations left on the one-invocation path`);
    if (!one.notes.some(n => /one-invocation subgroups \(the device has no WebGPU subgroups feature\)/.test(n))) throw new Error(`${m.name}: no one-invocation note: ${one.notes}`);
    if (vertex ? !nat.notes.some(n => /no subgroup operations in vertex shaders/.test(n)) : !warp(nat.spv) || !nat.notes.some(n => /32-lane Maxwell warps/.test(n))) throw new Error(`${m.name}: native path: ${nat.notes}`);
    for (const f of [one, nat]) {
      writeFileSync(join(d, "m.spv"), f.spv);
      const r = spawnSync("spirv-val", ["--target-env", "vulkan1.1", join(d, "m.spv")], { encoding: "utf8" });
      if (have("spirv-val") && r.status) throw new Error(`${m.name} (${f.subgroups}): ${r.stderr.trim()}`);
    }
    const w = convertStage(naga, spv, { bindings: "keep", subgroups: "native" }).wgsl, w1 = convertStage(naga, spv, { bindings: "keep" }).wgsl;
    if (/subgroup[A-Z]|subgroup_|enable subgroups/.test(w1)) throw new Error(`${m.name}: subgroup builtins on the one-invocation path:\n${w1}`);
    if (!vertex && (!w.startsWith("enable subgroups;\ndiagnostic(off, subgroup_uniformity);\n") || !/subgroup(Ballot|Shuffle|Add)/.test(w))) throw new Error(`${m.name}: native WGSL:\n${w}`);
  }
  // the one-invocation values (lane 0 of 1): a ballot of p is p's bit 0, an exclusive min scan the identity, SubgroupSize 1
  const b1 = convertStage(naga, glslToSpv(join(CORPUS, "subgroup_ballot.frag")), { bindings: "keep" }).wgsl;
  if (!/select\(0u, 1u,/.test(b1) && !/select\(vec4<u32>\(0u, 0u, 0u, 0u\), vec4<u32>\(1u, 0u, 0u, 0u\)/.test(b1)) throw new Error(`one-invocation ballot:\n${b1}`);
  return `${cases.length} stages, both paths pass spirv-val`;
});
await test("SPIR-V pass: uniform blocks are cut to what is read; a computed index keeps the whole array", () => {
  eq(byName(corpus, "ubo_const_index").entry!.reflection.uboSize, { "0": 96 }, "data[0] and data[5] read");
  eq(byName(corpus, "ubo_dynamic_index").entry!.reflection.uboSize, { "1": 65536 }, "indexed by a bone number");
  eq(byName(e2e, "e2e_fs").entry!.reflection.uboSize, { "0": 32 }, "the scene's pixel shader");
  if (!/array<vec4<f32>, 6>/.test(byName(corpus, "ubo_const_index").entry!.wgsl)) throw new Error("the WGSL does not declare array<vec4<f32>, 6>");
});
await test("SPIR-V pass: a combined sampler becomes a texture at its binding and a sampler at the next", () => {
  const w = byName(e2e, "e2e_fs").entry!.wgsl;
  if (!/@group\(1\) @binding\(64\)\s+var \w+: texture_2d<f32>;/.test(w) || !/@group\(1\) @binding\(65\)\s+var \w+: sampler;/.test(w)) throw new Error(w);
  const s = byName(corpus, "tex_shadow").entry!;
  if (!/@binding\(66\)\s+var \w+: texture_depth_2d;/.test(s.wgsl) || !/@binding\(67\)\s+var \w+: sampler_comparison;/.test(s.wgsl)) throw new Error(s.wgsl);
  eq(s.reflection.textures, [{ slot: 1, dim: "2d", depth: true }], "shadow reflection");
  eq(byName(corpus, "tex_types").entry!.reflection.textures.map(t => t.dim + (t.depth ? "/depth" : "")), ["3d", "cube", "2d-array", "cube-array", "cube/depth", "2d-array/depth"], "dimensions");
});
await test("SPIR-V pass: the vertex stage ends with the position fix-up of src/gfx/README.md", () => {
  const v = byName(e2e, "e2e_vs").entry!;
  eq([v.reflection.fixup, v.reflection.attributes, v.reflection.ubos], [true, [0, 1], [0]], "reflection");
  if (!/@group\(2\) @binding\(0\)\s+var<uniform> nx_fixup/.test(v.wgsl)) throw new Error("no fix-up uniform at group 2 binding 0");
  const body = v.wgsl.slice(v.wgsl.indexOf("fn main_1"));
  if (!/gl_Position\[1u\] = \(_e\d+ \* _e\d+\);\s+\S*gl_Position\[2u\] = \(\(_e\d+ \* _e\d+\) \+ \(_e\d+ \* _e\d+\)\);\s+return;/.test(body)) throw new Error("the fix-up is not the last thing before the return:\n" + body);
  eq(byName(e2e, "e2e_fs").entry!.reflection.fixup, false, "pixel shaders have none");
});
await test("SPIR-V pass: losses are notes, not silence", () => {
  if (!byName(corpus, "point_size_dynamic").notes!.some(n => /gl_PointSize/.test(n))) throw new Error("no note for a computed point size");
  if (!byName(corpus, "clip_distance").notes!.some(n => /gl_ClipDistance/.test(n))) throw new Error("no note for a clip distance");
  eq(byName(corpus, "ubo_const_index").notes, [], "gl_PointSize = 1.0 is no loss");
});
await test("SPIR-V pass: infinite and NaN float constants become run-time values (private bits, bitcast in each function), scalar and in vectors", () => {
  const s = byName(corpus, "nonfinite").entry!, m = parse(fixForWgsl(glslToSpv(join(CORPUS, "nonfinite.frag"))).spv);
  const floats = new Set(m.insts.filter(i => i.op === 22).map(i => i.w[0]));
  const nonFinite = m.insts.filter(i => i.op === 43 && floats.has(i.w[0]) && (i.w[2] & 0x7f800000) === 0x7f800000);
  if (nonFinite.length) throw new Error(`${nonFinite.length} infinite or NaN float constants left`);
  const bits = [...s.wgsl.matchAll(/var<private> nx_nonfinite\w*: u32 = (\d+)u;/g)].map(x => Number(x[1])).sort((a, b) => a - b);
  if (!bits.includes(0x7f800000) || !bits.includes(0xff800000) || !bits.some(b => (b & 0x7fffffff) > 0x7f800000)) throw new Error(`+inf, -inf and a NaN are not all there: ${bits.map(b => b.toString(16))}`);
  if (/\binf\b|\bnan\b|1e\+?39|f32\(inf/i.test(s.wgsl)) throw new Error(s.wgsl);
  if ((s.wgsl.match(/bitcast<f32>\(_e\d+\)/g) ?? []).length < 2) throw new Error("expected the values bitcast where they are read:\n" + s.wgsl);
});
await test("SPIR-V pass: BaseVertex / BaseInstance / DrawIndex are read from the draw-parameter uniform at group 2 binding 2", () => {
  const v = byName(corpus, "draw_params").entry!;
  eq([v.reflection.drawParams, v.reflection.fixup, v.reflection.extra], [true, true, []], "reflection");
  if (!/@group\(2\) @binding\(2\)\s+var<uniform> nx_draw: (\w+);/.test(v.wgsl)) throw new Error("no draw-parameter uniform:\n" + v.wgsl);
  if (/base_instance|base_vertex|draw_index|BaseInstance/.test(v.wgsl)) throw new Error(v.wgsl);
  for (const m of ["member", "member_1", "member_2"]) if (!new RegExp(`nx_draw\\.${m}\\b`).test(v.wgsl)) throw new Error(`nx_draw.${m} not read:\n` + v.wgsl);
  const m = parse(fixForWgsl(glslToSpv(join(CORPUS, "draw_params.vert"))).spv);
  if (m.insts.some(i => (i.op === 71 && i.w[1] === 11 && i.w[2] >= 4424 && i.w[2] <= 4426) || (i.op === 17 && i.w[0] === 4427))) throw new Error("a draw-parameter builtin or the capability is left");
  eq(byName(corpus, "clip_distance").entry!.reflection.drawParams, undefined, "a shader without them has no flag");
});
await test("extended multiply: the 16-bit-half formula the pass emits gives the high word (100,000 random pairs and the edges)", () => {
  const hiU = (a: number, b: number) => { const a0 = a & 0xffff, a1 = a >>> 16, b0 = b & 0xffff, b1 = b >>> 16; const m1 = (Math.imul(a1, b0) + (Math.imul(a0, b0) >>> 16)) >>> 0, m2 = (Math.imul(a0, b1) + (m1 & 0xffff)) >>> 0; return (Math.imul(a1, b1) + (m1 >>> 16) + (m2 >>> 16)) >>> 0; };
  const hiS = (a: number, b: number) => (hiU(a >>> 0, b >>> 0) - (((a >> 31) >>> 0) & (b >>> 0)) - (((b >> 31) >>> 0) & (a >>> 0))) | 0;
  const edge = [0, 1, 2, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0xffffffff, 0xfffffffe, 0x12345678];
  let s = 12345; const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
  const pairs: [number, number][] = []; for (const a of edge) for (const b of edge) pairs.push([a, b]); for (let i = 0; i < 100000; i++) pairs.push([rnd(), rnd()]);
  for (const [a, b] of pairs) {
    if (hiU(a, b) !== Number((BigInt(a) * BigInt(b)) >> 32n)) throw new Error(`unsigned ${a} * ${b}`);
    if (hiS(a | 0, b | 0) !== Number(BigInt.asIntN(32, (BigInt(a | 0) * BigInt(b | 0)) >> 32n))) throw new Error(`signed ${a | 0} * ${b | 0}`);
  }
  if (!byName(corpus, "mul_extended").ok) throw new Error("mul_extended does not convert");
  return "the arithmetic in JavaScript, not on a GPU";
});

const refl = (stage: Reflection["stage"]): Reflection => ({ stage, entry: "main", ubos: [], textures: [], fixup: false, uboSize: {}, extra: [], notes: [] });
await test("library: written and read back; lookup by key; order by key", () => {
  const es = ["ffffffffffffffff", "0000000000000000", "0100000000000000", "00000000000000ff", "6ab809ed2aec5e2b"].map((key, i) => ({ key, wgsl: `// ${i} é`, reflection: { ...refl(i & 1 ? "fragment" : "vertex"), ubos: [i] } }));
  const lib = new ShaderLibrary(writeLibrary(es, { chain: "t" }));
  eq(lib.count, 5, "count"); eq(lib.meta, { chain: "t" }, "meta");
  for (const e of es) { const g = lib.get(e.key)!; eq([g.wgsl, g.reflection, g.stage], [e.wgsl, e.reflection, e.reflection.stage === "vertex" ? 0 : 1], e.key); }
  eq(lib.get("1234567812345678"), undefined, "a key it has not"); eq(lib.has("0100000000000000"), true, "has");
  eq(lib.keys(), ["0000000000000000", "0100000000000000", "6ab809ed2aec5e2b", "00000000000000ff", "ffffffffffffffff"], "sorted as little-endian numbers");
  eq(new ShaderLibrary(writeLibrary([])).count, 0, "empty");
});
await test("library: a damaged file is refused", () => {
  const good = writeLibrary([{ key: "0000000000000001", wgsl: "a", reflection: refl("vertex") }, { key: "0000000000000002", wgsl: "b", reflection: refl("fragment") }]);
  const mut = (f: (b: Uint8Array, dv: DataView) => void) => { const b = good.slice(); f(b, new DataView(b.buffer)); return b; };
  throws(() => new ShaderLibrary(new Uint8Array(8)), /NXSL/, "short");
  throws(() => new ShaderLibrary(mut(b => { b[0] = 0; })), /NXSL/, "magic");
  throws(() => new ShaderLibrary(mut((b, dv) => dv.setUint32(4, 2, true))), /version 2/, "version");
  throws(() => new ShaderLibrary(mut((b, dv) => dv.setUint32(8, 1000, true))), /cut short/, "count");
  throws(() => new ShaderLibrary(mut((b, dv) => dv.setUint32(16 + 12, good.length, true))), /outside the file/, "offset");
  throws(() => new ShaderLibrary(mut((b, dv) => dv.setUint32(16 + 8, 7, true))), /stage 7/, "stage");
  throws(() => new ShaderLibrary(mut(b => { b[16 + 7] = 9; })), /not sorted/, "order");
  throws(() => new ShaderLibrary(good.slice(0, good.length - 1)), /outside the file/, "truncated");
  throws(() => writeLibrary([{ key: "XYZ", wgsl: "", reflection: refl("vertex") }]), /16 lowercase hex/, "bad key");
  throws(() => writeLibrary([{ key: "0000000000000001", wgsl: "", reflection: refl("vertex") }, { key: "0000000000000001", wgsl: "", reflection: refl("vertex") }]), /twice/, "duplicate");
});
await test("library: registerAll hands GfxHost.registerShader the record src/gfx/README.md asks for", () => {
  const got: any[] = [];
  const r = new ShaderLibrary(e2e.library).registerAll({ registerShader: (key, info) => (got.push({ key, ...info }), got.length - 1) });
  eq([r.registered, r.skipped], [2, []], "both stages");
  const v = got.find(g => g.stage === "vertex"), f = got.find(g => g.stage === "fragment");
  eq([v.entry, v.ubos, v.textures, v.attributes, v.fixup, typeof v.wgsl], ["main", [0], [], [0, 1], true, "string"], "vertex");
  eq([f.entry, f.ubos, f.textures, f.outputs, f.fixup], ["main", [0], [{ slot: 0, dim: "2d", depth: false }], [0], false], "fragment");
});

// ---- Maxwell code through nxnative's translator ----
const NXNATIVE = process.env.NXNATIVE ?? "/home/user/nxnative", XLATE_DLL = join(NXNATIVE, "dm/gfx/tools/dmsh_xlate_bin/dmsh_xlate.dll");
const xlate = have("dotnet") && existsSync(XLATE_DLL);
let maxwell: Awaited<ReturnType<typeof build>> | undefined;
const MX = join(OUT, "maxwell");
await test("Maxwell: the hand-assembled programs' keys are sha256(control section + code)[0..8]", () => {
  execFileSync("python3", [join(ROOT, "tools/shaders/maxwell_asm.py"), MX], { stdio: "ignore" });
  const rows = JSON.parse(readFileSync(join(MX, "corpus.json"), "utf8"));
  for (const r of rows) eq(r.key, createHash("sha256").update(readFileSync(join(MX, r.control))).update(readFileSync(join(MX, r.code))).digest("hex").slice(0, 16), r.name);
  return `${rows.length} programs`;
});
await test("Maxwell -> SPIR-V: nxnative's translator (Ryujinx) translates them", () => {
  if (!xlate) return "SKIPPED: dotnet or the translator is not there (see tools/shaders/README.md)";
  const r = spawnSync("python3", [join(ROOT, "tools/shaders/xlate.py"), join(MX, "corpus.json"), join(MX, "spv")], { encoding: "utf8" });
  if (r.status) throw new Error(r.stdout + r.stderr);
  if (have("spirv-val")) for (const x of JSON.parse(readFileSync(join(MX, "spv/xlate.json"), "utf8"))) { const v = spawnSync("spirv-val", [join(MX, "spv", x.spv)], { encoding: "utf8" }); if (v.status) throw new Error(`${x.name}: the translator's own output fails spirv-val: ${v.stderr}`); }
  return r.stdout.trim();
});
await test("Maxwell -> SPIR-V: garbage is refused cleanly (random bytes, an empty file, a missing file)", () => {
  if (!xlate) return "SKIPPED: dotnet or the translator is not there";
  const d = mkdtempSync(join(tmpdir(), "nxsl-bad-"));
  let s = 99; const junk = Uint8Array.from({ length: 0x400 }, () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 24);
  writeFileSync(join(d, "junk.bin"), junk); writeFileSync(join(d, "empty.bin"), new Uint8Array(0));
  const jobs = [["junk", "junk.bin", "ps"], ["junkvs", "junk.bin", "vs"], ["empty", "empty.bin", "vs"], ["missing", "nothing.bin", "ps"]].map(([key, f, stage]) => ({ key, stage, code: join(d, f), tex: {}, img: {}, attr: {}, fout: {}, c1: "" }));
  writeFileSync(join(d, "jobs.json"), JSON.stringify(jobs));
  const r = spawnSync("dotnet", [XLATE_DLL, join(d, "jobs.json"), join(d, "out")], { encoding: "utf8", timeout: 60000 });
  if (r.signal || r.status === null) throw new Error(`the translator died or hung: ${r.signal}`);
  const red = r.stderr.split("\n").filter(l => l.startsWith("[RED] ")), okN = +(/(\d+) ok/.exec(r.stdout)?.[1] ?? -1), badN = +(/(\d+) failed/.exec(r.stdout)?.[1] ?? -1);
  if (okN + badN !== jobs.length || red.length !== badN || (r.status === 0) !== (badN === 0)) throw new Error(`status ${r.status}\n${r.stdout}${r.stderr}`);
  if (!red.some(l => l.includes("missing")) || !red.some(l => l.includes("empty"))) throw new Error("the missing or the empty file was not reported:\n" + r.stderr);
  return `${badN} of ${jobs.length} refused, each with one [RED] line; ${okN} of the random streams decoded to something (random bytes can be instructions)`;
});
await test("Maxwell -> SPIR-V -> WGSL: the library of the translated programs, with nxweb's bindings", async () => {
  if (!xlate) return "SKIPPED: dotnet or the translator is not there";
  maxwell = await build({ spv: join(MX, "spv") });
  writeFileSync(join(OUT, "maxwell.nxsl"), maxwell.library); writeFileSync(join(OUT, "maxwell.report.json"), JSON.stringify(maxwell.report, null, 1));
  const bad = maxwell.report.filter(r => !r.ok);
  if (bad.length) throw new Error(bad.map(b => `${b.name}: ${b.error}`).join("\n"));
  const v = byName(maxwell, "vs_quad_ubo").entry!, f = byName(maxwell, "ps_tex_tint").entry!, o = byName(maxwell, "ps_ops").entry!;
  eq([v.reflection.ubos, v.reflection.uboSize, v.reflection.attributes, v.reflection.fixup, v.reflection.extra], [[0], { "0": 32 }, [0, 1], true, []], "vertex");
  eq([f.reflection.ubos, f.reflection.uboSize, f.reflection.textures, f.reflection.outputs, f.reflection.extra], [[0], { "0": 32 }, [{ slot: 0, dim: "2d", depth: false }], [0], []], "pixel");
  if (!/@group\(0\) @binding\(16\)/.test(f.wgsl) || !/@group\(1\) @binding\(64\)/.test(f.wgsl) || !/@group\(1\) @binding\(65\)/.test(f.wgsl) || !/discard;/.test(f.wgsl)) throw new Error(f.wgsl);
  eq([o.reflection.textures, o.reflection.extra.map(e => `${e.kind}@${e.group}.${e.binding}`)], [[{ slot: 1, dim: "2d", depth: false }], ["support@0.30"]], "ps_ops: texture slot 1 and the support buffer");
  // the draw parameters (the instance ID is InstanceIndex - BaseInstance) and the +inf / NaN immediates of FMNMX: the uniform at group 2 binding 2, private bits
  const d = byName(maxwell, "vs_draw_params").entry!;
  eq([d.reflection.drawParams, d.reflection.extra], [true, []], "vs_draw_params");
  if (!/var<uniform> nx_draw/.test(d.wgsl) || (d.wgsl.match(/var<private> nx_nonfinite/g) ?? []).length !== 2) throw new Error(d.wgsl);
  // bindless: the handle is traced by the translator to the game's uniform slot 2 (c[5]) byte 0x28; the pass gives the texture the first free slot and reports where
  // the host reads the handle. The library hands GfxHost.registerShader that record
  const b = byName(maxwell, "ps_bindless").entry!;
  eq(b.reflection.textures, [{ slot: 0, dim: "2d", depth: false, handle: { ubo: 2, offset: 0x28 } }], "ps_bindless: one texture, its handle in uniform slot 2 + 0x28");
  if (!/@group\(1\) @binding\(64\)/.test(b.wgsl) || !/@group\(1\) @binding\(65\)/.test(b.wgsl)) throw new Error(b.wgsl);
  if (!b.reflection.notes.some(n => /fp_t_cb5_A is bindless: slot 0 takes its handle from uniform slot 2 \+ 0x28/.test(n))) throw new Error(`no bindless note: ${b.reflection.notes}`);
  const got: any[] = []; new ShaderLibrary(maxwell.library).registerAll({ registerShader: (key, info) => (got.push({ key, ...info }), got.length - 1) });
  eq(got.find(g => g.key === b.key)?.textures, b.reflection.textures, "registerAll passes the handle on");
  // TMML (OpImageQueryLod): computed from derivatives; the driver's banks: c[24] push constants, c[1] with the code area's c1 segment, c[0] / c[2] words
  const q = byName(maxwell, "ps_query_lod").entry!, k = byName(maxwell, "ps_banks").entry!;
  if (!/dpdx/.test(q.wgsl) || !/dpdy/.test(q.wgsl) || !/log2/.test(q.wgsl) || !q.reflection.notes.some(n => /LOD queries/.test(n))) throw new Error(q.wgsl);
  eq(k.reflection.extra.map(e => [e.kind, e.binding, e.bank ?? null, e.data ?? null]),
    [["push", 215, 24, null], ["c1", 212, null, "0000803e0000003f0000403f0000803f"], ["drvcb", 213, 0, null], ["drvcb", 214, 2, null]], "ps_banks: pixel stage (1): 208 + 4 + k");
  eq(new ShaderLibrary(maxwell.library).registerAll({ registerShader: () => 0 }).skipped, [], "registerAll takes the host blocks");
  if (/c25/.test(v.wgsl.replace(/var<private> \w+c25_/, "")) === false) throw new Error("expected the bound-size table as a private constant");
  if (/var<uniform> \w*c25/.test(v.wgsl + f.wgsl)) throw new Error("the bound-size table is still a uniform buffer");
  return `${maxwell.report.length} stages, ${maxwell.library.length} bytes`;
});

await test("SPIR-V pass: bindless texture names (handle types 0, 1, 3) are placed in free slots with their handle's place; what has no answer is refused by name", () => {
  // the translated module, with its texture renamed as the translator names other kinds of handle (nxnative dmsh_build.py decode_ubo_tex)
  if (!xlate || !maxwell) return "SKIPPED: dotnet or the translator is not there";
  const spv = readFileSync(join(MX, "spv", byName(maxwell, "ps_bindless").key + ".spv"));
  const renamed = (name: string) => {
    const m = parse(new Uint8Array(spv)), words: number[] = [];
    for (let i = 0; i <= name.length; i += 4) { let v = 0; for (let k = 0; k < 4 && i + k < name.length; k++) v |= name.charCodeAt(i + k) << (8 * k); words.push(v >>> 0); }
    let n = 0;
    for (const i of m.insts) if (i.op === 5 /* OpName */ && String.fromCharCode(...i.w.slice(1).flatMap(w => [w & 255, (w >> 8) & 255, (w >> 16) & 255, w >>> 24]).filter(c => c)) === "fp_t_cb5_A") { i.w = [i.w[0], ...words]; n++; }
    if (n !== 1) throw new Error("the texture's name was not found");
    return fixForWgsl(serialize(m)).bindings.filter(b => b.kind === "tex").map(b => ({ slot: b.reg, handle: b.handle }));
  };
  eq(renamed("fp_t_cb7_2A"), [{ slot: 0, handle: { ubo: 4, offset: 0xa8 } }], "type 0: one word");
  eq(renamed("fp_t_cb458759_10014002"), [{ slot: 0, handle: { ubo: 4, offset: 8, sampler: { ubo: 3, offset: 0x14 } } }], "type 1: texture word in c7, sampler word in c6");   // slots = (6 + 1) << 16 | 7 (sampler bank 6, texture bank 7); handle = 1 << 28 | 5 << 14 | 2
  eq(renamed("fp_t_cb5_3041000A"), [{ slot: 0, handle: { ubo: 2, offset: 0x28, sampler: { id: 0x104 } } }], "type 3: a constant sampler ID");
  throws(() => renamed("fp_t_cb196613_1057000A"), /sampler is a separate sampler of the driver table \(c2 \+ 0x570\): not placed yet/, "type 1 with the sampler in c2");   // slots = (2 + 1) << 16 | 5
  throws(() => renamed("fp_t_cb20_A"), /uniform bank 20, which is not one of the game's uniform slots/, "a bank that is no uniform slot");
  throws(() => renamed("fp_t_cb5_2000000A"), /bindless handle of type 2/, "an unknown handle type");
});

await test("SPIR-V pass: storage buffers go to the NVN slot their address is read from in c0 (nxnative dmsh_reflect.py); what has no slot is refused by name", () => {
  const d = mkdtempSync(join(tmpdir(), "nxsb-")), file = join(d, "sb.comp");
  writeFileSync(file, `#version 450
layout(local_size_x = 64) in;
layout(std430, binding = 5) buffer W { uint w[]; } wb;
layout(std430, binding = 6) readonly buffer R { uint r[]; } rb;
void main() { wb.w[gl_GlobalInvocationID.x] = rb.r[gl_GlobalInvocationID.x] + 1u; }
`);
  let spv: Uint8Array; try { spv = glslToSpv(file); } finally { rmSync(d, { recursive: true, force: true }); }
  const c0 = (slot: number) => (0x310 + 0x10 * slot) / 4;
  const sbufs = [{ binding: 5, cb_slot: 0, cb_offset: c0(2), flags: 1 }, { binding: 6, cb_slot: 0, cb_offset: c0(7), flags: 0 }];
  const got = convertStage(naga, spv, { bindings: "nxweb", sbufs });
  eq(got.reflection.storage, [{ slot: 2, write: true }, { slot: 7, write: false }], "slots from c0 0x330 and 0x380 of the compute table; write unless NonWritable");
  eq(got.reflection.extra, [], "no binding left for the host to refuse");
  if (!/@group\(0\) @binding\(162\)\s*var<storage, read_write>/.test(got.wgsl) || !/@group\(0\) @binding\(167\)\s*var<storage(, read)?>/.test(got.wgsl)) throw new Error(got.wgsl);
  throws(() => fixForWgsl(spv, { sbufs: [sbufs[0]] }), /storage buffer .*no storage buffer at binding 6/, "a binding the translator did not list");
  throws(() => fixForWgsl(spv, { sbufs: [sbufs[0], { binding: 6, cb_slot: 0xff, cb_offset: 0 }] }), /traced to no storage buffer/, "global memory with no buffer");
  throws(() => fixForWgsl(spv, { sbufs: [sbufs[0], { binding: 6, cb_slot: 4, cb_offset: 0xe }] }), /address is in uniform slot 1 \+ 0x38: not placed yet/, "an address in a game uniform slot");
  throws(() => fixForWgsl(spv, { sbufs: [sbufs[0], { binding: 6, cb_slot: 0, cb_offset: 0x110 / 4 }] }), /c0 \+ 0x110, which is no compute stage storage buffer slot/, "the vertex table in a compute shader");
  // a compute uniform slot read through its address (nxnative ubo_ptr, c0 0x210 + 0x10 r): storage slot 16 + r, binding 128 + 32 + 16 + r
  const ptr = convertStage(naga, spv, { bindings: "nxweb", sbufs: [sbufs[0], { binding: 6, cb_slot: 0, cb_offset: 0x2c0 / 4, flags: 0 }] });
  eq(ptr.reflection.storage, [{ slot: 2, write: true }, { slot: 27, write: false, ubo: 11 }], "uniform slot 11's address at c0 0x2c0");
  if (!/@group\(0\) @binding\(187\)\s*var<storage(, read)?>/.test(ptr.wgsl)) throw new Error(ptr.wgsl);
  throws(() => fixForWgsl(spv, { sbufs: [{ ...sbufs[0], cb_offset: 0x2c0 / 4 }, { ...sbufs[1], cb_offset: 0x2c0 / 4 }] }), /a second buffer of the shader traced to uniform slot 11's address/, "two buffers of one address");
  // a task or mesh shader (compute to the translator) reads its own stage's table (DMSH_C0_SSBO_TS 0x670, DMSH_C0_SSBO_MS 0x770), bound in the compute stage's bindings
  const slots = (r: ReturnType<typeof fixForWgsl>) => r.bindings.filter(b => b.kind === "storage").map(b => [b.reg, b.binding]);
  eq(slots(fixForWgsl(spv, { mesh: { kind: "ms" }, sbufs: [{ ...sbufs[0], cb_offset: 0x790 / 4 }, { ...sbufs[1], cb_offset: 0x770 / 4 }] })), [[2, 162], [0, 160]], "the mesh table");
  eq(slots(fixForWgsl(spv, { mesh: { kind: "ts" }, sbufs: [{ ...sbufs[0], cb_offset: 0x680 / 4 }, { ...sbufs[1], cb_offset: 0x670 / 4 }] })), [[1, 161], [0, 160]], "the task table");
  throws(() => fixForWgsl(spv, { mesh: { kind: "ms" }, sbufs: [sbufs[0], sbufs[1]] }), /c0 \+ 0x330, which is no mesh stage storage buffer slot/, "the compute table in a mesh shader");
  throws(() => fixForWgsl(spv, { sbufs: [sbufs[0], { binding: 6, cb_slot: 0, cb_offset: 0x770 / 4 }] }), /c0 \+ 0x770, which is no compute stage storage buffer slot/, "the mesh table in a compute shader");
});

await test("SPIR-V pass: a pool texture (the whole pools indexed by a handle of a storage buffer's record table) becomes slots the recorder fills, each read a switch over them", () => {
  const d = mkdtempSync(join(tmpdir(), "nxpool-"));
  try {
    const src = (handle: string) => `#version 450
layout(location = 0) flat in int light;
layout(location = 1) in vec3 at;
layout(location = 0) out vec4 o;
layout(std430, binding = 6) readonly buffer L { uint data[]; } fp_s1;
layout(std140, binding = 7) uniform C { vec4 data[4096]; } fp_c3;
layout(binding = 1) uniform sampler2D fp_t_tcb_8;
layout(binding = 2) uniform texture2D fp_t2ds_cb0_40000000[1048576];
layout(binding = 3) uniform samplerShadow fp_s_cb0_40000000[4096];
void main() {
  uint h = ${handle};
  float lit = texture(sampler2DShadow(fp_t2ds_cb0_40000000[min(h & 0xfffffu, 1048575u)], fp_s_cb0_40000000[min(h >> 20, 4095u)]), at);
  o = texture(fp_t_tcb_8, at.xy) * lit + fp_c3.data[2];
}
`;
    const fix = (handle: string) => { const f = join(d, "pool.frag"); writeFileSync(f, src(handle)); return fixForWgsl(glslToSpv(f), { sbufs: [{ binding: 6, cb_slot: 0, cb_offset: 0x520 / 4 }] }); };
    const r = fix("fp_s1.data[(light * 96 + 96) >> 2]");
    const tex = r.bindings.filter(b => b.kind === "tex").map(b => ({ slot: b.reg!, binding: b.binding, handle: b.handle })).sort((x, y) => x.slot - y.slot);
    eq(tex, [{ slot: 0, binding: 64, handle: undefined }, ...[0, 1, 2, 3].map(j => ({ slot: 1 + j, binding: 66 + 2 * j, handle: { sbuf: 1, offset: 96, stride: 96, index: j, entry: j } }))],
      "the bound texture keeps slot 0; four pool slots in the next free ones, their handles the first four of storage slot 1's records (96 bytes, the word at 96)");
    eq(r.bindings.filter(b => b.kind === "drvcb").map(b => [b.bank, b.binding, b.size]), [[2, 208 + 4 + 2, 0x990]], "the c2 block is declared for the table (c2 + 0x980, 16 words)");
    if (!r.notes.some(n => /pool texture fp_t2ds_cb0_40000000 .*4 slots.*0x60 \+ 96 i of storage slot 1/.test(n))) throw new Error(`no pool note: ${r.notes}`);
    const wgsl = naga.spvToWgsl(r.spv);
    if ((wgsl.match(/textureSampleCompare\(fp_t2ds_cb0_40000000_p\d_?,/g) ?? []).length !== 4 || !/switch /.test(wgsl) || /binding_array/.test(wgsl)) throw new Error("the read is not a switch over four slots");
    eq(fix("fp_s1.data[5]").bindings.filter(b => b.kind === "tex" && b.handle).map(b => b.handle), [0, 1, 2, 3].map(j => ({ sbuf: 1, offset: 20, stride: 0, index: j, entry: j })), "one constant word: stride 0");
    throws(() => fix("fp_s1.data[light]"), /no record table the recorder can walk/, "a word at a run-time index with no stride");
    throws(() => fix("uint(light)"), /handle is not a word of a storage buffer/, "a handle from a varying");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

await test("SPIR-V pass: storage images go to the image slot of their handle word (group 1, binding 256 + stage * 8 + slot) with format, access and dimension; an image without a format is `bound`; image atomics become a load and a store", () => {
  const d = mkdtempSync(join(tmpdir(), "nximg-"));
  const spvOf = (name: string, src: string) => { const f = join(d, name); writeFileSync(f, src); return glslToSpv(f); };
  try {
    const spv = spvOf("img.comp", `#version 450
layout(local_size_x = 8, local_size_y = 8) in;
layout(binding = 0) uniform writeonly image2D cp_i_tcb_4A_;
layout(binding = 1, r32ui) uniform uimage2D cp_i_tcb_4C_r32ui;
layout(binding = 2, rgba16f) uniform image2DArray cp_i_tcb_48_rgba16f;
layout(binding = 3) uniform writeonly image3D cp_i_tcb_56_;
void main() {
  ivec2 p = ivec2(gl_GlobalInvocationID.xy);
  vec4 v = imageLoad(cp_i_tcb_48_rgba16f, ivec3(p, 1));
  uint o = imageAtomicOr(cp_i_tcb_4C_r32ui, p, 5u);
  if (all(lessThan(p, imageSize(cp_i_tcb_4A_)))) imageStore(cp_i_tcb_4A_, p, v + float(o));
  imageStore(cp_i_tcb_56_, ivec3(p, 2), v);
}
`);
    const got = convertStage(naga, spv, { bindings: "nxweb" });
    eq(got.reflection.images, [
      { slot: 0, format: "rgba16float", access: "read-only", dim: "2d-array", type: "float" },
      { slot: 1, format: "rgba8unorm", access: "write-only", dim: "2d", type: "float", bound: true },
      { slot: 2, format: "r32uint", access: "read-write", dim: "2d", type: "uint" },
      { slot: 7, format: "rgba8unorm", access: "write-only", dim: "3d", type: "float", bound: true }], "slots from c2 0x120 + 8 slot; access from the loads and stores");
    eq(got.reflection.extra, [], "no binding left for the host to refuse");
    const decl = (b: number) => new RegExp(`@group\\(1\\) @binding\\(${b}\\)\\s*var \\w+: (texture_storage_\\w+<\\w+,\\s*\\w+>);`).exec(got.wgsl)?.[1].replace(/\s/g, "");
    eq([272, 273, 274, 279].map(decl), ["texture_storage_2d_array<rgba16float,read>", "texture_storage_2d<rgba8unorm,write>", "texture_storage_2d<r32uint,read_write>", "texture_storage_3d<rgba8unorm,write>"], "the WGSL declarations");
    if (!got.reflection.notes.some(n => /1 image atomic operation done as a load and a store/.test(n)) || !/textureStore\(cp_i_tcb_4C_r32ui, \w+, vec4\(\(\w+\.x \| 5u\)\)\)/.test(got.wgsl)) throw new Error("the atomic OR is not a load, an OR and a store:\n" + got.wgsl);
    if (got.reflection.notes.filter(n => /names no format: declared rgba8unorm/.test(n)).length !== 2) throw new Error("a note for each image without a format: " + got.reflection.notes.join(" | "));
    // the host's variant for the texture bound (src/shaders/images.ts): the format in that declaration alone
    const v = imageVariant(got.wgsl, 1, 273, "rg11b10ufloat")!;
    eq([v.length - got.wgsl.length, /@binding\(273\)\s*var \w+: texture_storage_2d<rg11b10ufloat,\s*write>;/.test(v), /@binding\(279\)\s*var \w+: texture_storage_3d<rgba8unorm,\s*write>;/.test(v)], [3, true, true], "one declaration changed");
    eq([imageVariant(got.wgsl, 1, 275, "r32float"), imageVariant(got.wgsl, 0, 273, "r32float")], [undefined, undefined], "no such declaration: no variant");
    eq(["rgba8unorm", "rg11b10ufloat", "rgba8snorm", "r32uint", "rgba16sint", "bgra8unorm-srgb"].map(formatClass), ["float", "float", "float", "uint", "sint", "float"], "format classes");
    // refused by name
    throws(() => fixForWgsl(spvOf("a.comp", `#version 450\nlayout(local_size_x = 1) in;\nlayout(binding = 0) uniform writeonly image2D cp_i_tcb_5A_;\nvoid main() { imageStore(cp_i_tcb_5A_, ivec2(0), vec4(1)); }\n`)), /handle word at c2 \+ 0x168 is not one of the 8 image slots/, "a word past the image table");
    throws(() => fixForWgsl(spvOf("b.comp", `#version 450\nlayout(local_size_x = 1) in;\nlayout(binding = 0) uniform writeonly image2D cp_i_cb3_0_;\nvoid main() { imageStore(cp_i_cb3_0_, ivec2(0), vec4(1)); }\n`)), /a bindless image \(its handle is in uniform bank 3/, "a handle in the game's uniform data");
    throws(() => fixForWgsl(spvOf("c.comp", `#version 450\nlayout(local_size_x = 1) in;\nlayout(binding = 0, r32i) uniform iimage2D cp_i_tcb_48_r32i;\nvoid main() { imageAtomicMax(cp_i_tcb_48_r32i, ivec2(0), 1); }\n`)), /image atomic instruction 238 .*not lowered/, "an atomic maximum");
    throws(() => fixForWgsl(spvOf("d.comp", `#version 450\nlayout(local_size_x = 1) in;\nlayout(binding = 0) uniform writeonly imageCube cp_i_tcb_48_;\nvoid main() { imageStore(cp_i_tcb_48_, ivec3(0), vec4(1)); }\n`)), /dimension cube has no WGSL storage texture type/, "a cube image");
    // a hand-written shader with the nxweb numbers in its layout ("keep"): the slot from the binding
    const keep = convertStage(naga, spvOf("k.frag", `#version 450\nlayout(set = 1, binding = 267, r32ui) uniform uimage2D i0;\nlayout(location = 0) out vec4 o;\nvoid main() { o = vec4(imageLoad(i0, ivec2(gl_FragCoord.xy)).x); }\n`), { bindings: "keep" });
    eq(keep.reflection.images, [{ slot: 3, format: "r32uint", access: "read-only", dim: "2d", type: "uint" }], "fragment stage: 256 + 8 + 3");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

await test("SPIR-V pass: banks the host supplies (c1, the driver segments c0 and c2, the NVN2 push constants c[24]) go to group 0 binding 208 + stage * 4 + k; another bank is refused", () => {
  const d = mkdtempSync(join(tmpdir(), "nxbank-"));
  const src = (banks: number[]) => `#version 450
layout(local_size_x = 64) in;
layout(std430, binding = 5) buffer W { uint w[]; } wb;
${banks.map((b, i) => `layout(std140, binding = ${20 + i}) uniform B${b} { uvec4 data[16]; } cp_c${b};`).join("\n")}
void main() { wb.w[gl_GlobalInvocationID.x] = ${banks.map(b => `cp_c${b}.data[${b % 4}].y`).join(" + ")}; }
`;
  const spvOf = (banks: number[]) => { const f = join(d, `b${banks.join("_")}.comp`); writeFileSync(f, src(banks)); return glslToSpv(f); };
  try {
    const sbufs = [{ binding: 5, cb_slot: 0, cb_offset: 0x310 / 4, flags: 1 }];
    const got = convertStage(naga, spvOf([0, 1, 2, 24]), { bindings: "nxweb", sbufs, c1: "0102030405060708" });
    eq(got.reflection.extra.map(x => [x.kind, x.group, x.binding, x.bank ?? null, x.data ?? null]),
      [["drvcb", 0, 217, 0, null], ["c1", 0, 216, null, "0102030405060708"], ["drvcb", 0, 218, 2, null], ["push", 0, 219, 24, null]], "compute (stage 2): 208 + 8 + k");
    eq(unsupportedExtra(got.reflection), [], "every one is a block src/gfx supplies");
    for (const b of [216, 217, 218, 219]) if (!new RegExp(`@group\\(0\\) @binding\\(${b}\\)\\s*var<uniform>`).test(got.wgsl)) throw new Error(`binding ${b} is not a uniform in the WGSL:\n${got.wgsl}`);
    throws(() => fixForWgsl(spvOf([20]), { sbufs }), /uniform bank 20 \(cp_c20\): not placed/, "bank 20");
    eq(unsupportedExtra({ extra: [{ kind: "support", group: 0, binding: 14 }, { kind: "other", group: 3, binding: 0 }] }), ["other"], "an unknown kind is still refused");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- the browser half ----
// NVN2 (Switch 2): synthetic control sections and code areas, the same bytes through src/shaders/job.ts, tools/shaders/xlate.py and nxnative's own C and Python
// (cut out of $NXNATIVE as its own tests do). No game's shader is here: these show the layouts agree, not that a game's Ampere code translates
const AM = join(OUT, "ampere"), hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
const nxnativeSrc = existsSync(join(NXNATIVE, "dm/gfx/nvn/hle_nvn.c")) && existsSync(join(NXNATIVE, "dm/gfx/tools/dmsh_ampere.py"));
function rng(seed: number) { return () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) & 0xff; }; }
function nvn2Case(r: () => number, size: number, ncode: number, opts: { stage?: number; sph?: number } = {}) {
  const c = new Uint8Array(size).map(() => r()), dv = new DataView(c.buffer);
  dv.setUint32(0, 0x98761234, true); dv.setUint32(4, 0xc9, true);
  let code: Uint8Array;
  do code = new Uint8Array(ncode).map(() => r()); while (hexOf(code).includes("34127698"));
  const inst = r() & 1 ? Math.min(ncode, 0x80 + (r() << 2)) : r() << 4, c1 = r() % 3 ? (inst + 0xff) & ~0xff : r() << 8;   // in range mostly; past the code area sometimes
  dv.setUint32(0x38, inst, true); dv.setUint32(0x40, c1, true); dv.setUint32(0x44, ncode, true);
  if (size > 0x56) c[0x56] = opts.stage ?? (r() & 7);
  if (opts.sph !== undefined && ncode >= 4) new DataView(code.buffer).setUint32(0, opts.sph, true);
  if (size >= 0x64 && c[0x56] === 5) for (const o of [0x58, 0x5c, 0x60]) dv.setUint32(o, o === 0x58 ? 1 + (r() & 63) : 1 + (r() & 1), true);   // compute's thread group
  else if (size > 0x5b) c[0x5b] = r() & 1 ? 1 + (r() % 255) : 0;   // a pixel shader's early fragment tests byte
  if (ncode >= 0x50 && r() & 1) code[19 * 4] &= ~2;
  return { control: c, code };
}
function nvnCase(r: () => number, own: number) {
  const c = new Uint8Array(0x880).map(() => r()), code = new Uint8Array(0x40 + r()).map(() => r()), dv = new DataView(c.buffer);
  dv.setUint32(0, 0x98761234, true); dv.setUint32(4, 1, true); dv.setUint32(0x20, own, true); dv.setUint32(0x704, code.length, true);
  return { control: c, code };
}
const tsKey = (c: Uint8Array, code: Uint8Array) => createHash("sha256").update(keyControl(c)).update(code.subarray(0, ctlLens(c).ncode)).digest("hex").slice(0, 16);

await test("NVN2: shader keys of src/shaders/job.ts are nxnative's keys_hash (hle_nvn.c, built here) and shader_split.py skey on the same bytes", () => {
  if (!nxnativeSrc) return `SKIPPED: no nxnative checkout at ${NXNATIVE} (NXNATIVE)`;
  if (!have("cc")) return "SKIPPED: no C compiler";
  const r = rng(0x5eed), cases: { control: Uint8Array; code: Uint8Array }[] = [];
  for (let i = 0; i < 120; i++) { const n = 0x80 + (r() << 2); const k = nvn2Case(r, 0x48 + (r() % 0x98), n); new DataView(k.control.buffer).setUint32(0x30, [0, 0xd8, 0xd0, 0x930, r() << 4][i % 5], true); cases.push(k); }
  for (const own of [0, 0x760, 0x850, 0x87f, 0x880, 0x900]) cases.push(nvnCase(r, own));
  // the masked bytes: two sections differing only in +0x30..+0x33 have one key; one differing at +0x43 another (+0x44..+0x47 is the code's length); past +0x48 (NVN2) nothing counts
  const base = nvn2Case(r, 0xd8, 0x100), at = (o: number, v: number) => { const c = base.control.slice(); c[o] = v; return { control: c, code: base.code }; };
  const same = [at(0x30, base.control[0x30] ^ 0x5a), at(0x33, base.control[0x33] ^ 1), at(0x48, base.control[0x48] ^ 1), at(0xd7, base.control[0xd7] ^ 1)], other = at(0x43, base.control[0x43] ^ 1);
  cases.push(base, ...same, other);
  const src = readFileSync(join(NXNATIVE, "dm/gfx/nvn/hle_nvn.c"), "utf8"), a = src.indexOf("#define NVN2_KEY_CTL"), b = src.indexOf("int prog_key(", a);
  if (a < 0 || b < 0) throw new Error("hle_nvn.c: NVN2_KEY_CTL .. prog_key not found (nxnative changed)");
  mkdirSync(AM, { recursive: true }); writeFileSync(join(AM, "keys_hash.inc.c"), src.slice(a, b));
  execFileSync("cc", ["-O1", "-Wno-deprecated-declarations", `-DKEYS_HASH="${join(AM, "keys_hash.inc.c")}"`, join(ROOT, "test/shaders/nvn2_ref.c"), "-o", join(AM, "keys_ref"), "-lcrypto"], { stdio: "inherit" });
  const c = execFileSync(join(AM, "keys_ref"), { input: cases.map(k => `${hexOf(k.control)} ${hexOf(k.code)}\n`).join(""), maxBuffer: 1 << 26 }).toString().trim().split("\n");
  writeFileSync(join(AM, "key_cases.json"), JSON.stringify(cases.map((k, i) => ({ key: i.toString(16).padStart(16, "0"), stage: "vs", control: hexOf(k.control), code: hexOf(k.code) }))));
  const py = JSON.parse(execFileSync("python3", [join(ROOT, "test/shaders/nvn2_ref.py"), join(AM, "key_cases.json"), join(AM, "ref")], { env: { ...process.env, NXNATIVE }, maxBuffer: 1 << 28 }).toString());
  cases.forEach((k, i) => { const t = tsKey(k.control, k.code); eq(t, c[i], `case ${i}: job.ts against hle_nvn.c keys_hash`); eq(t, py[i].skey, `case ${i}: job.ts against shader_split.py skey`); });
  const n = cases.length - 6, k0 = c[n];
  eq(same.map((_, j) => c[n + 1 + j]), same.map(() => k0), "+0x30..+0x33 and the bytes past +0x48 are not in an NVN2 key");
  if (c[n + 5] === k0) throw new Error("+0x43 is in an NVN2 key");
  return `${cases.length} control sections (${cases.length - 6 - 6} NVN2 of 0x48..0xdf bytes, 6 NVN with +0x20 0..0x900, 6 masking cases)`;
});

await test("NVN2: translator jobs of src/shaders/job.ts are nxnative's dmsh_build.py job_for and xlate.py job_for on the same bytes (arch sm86, code cut at +0x38, c1 +0x40..+0x44, nvn2_cs, early fragment tests, thread group)", () => {
  if (!nxnativeSrc) return `SKIPPED: no nxnative checkout at ${NXNATIVE} (NXNATIVE)`;
  const r = rng(0xa86), cases: { key: string; control: Uint8Array; code: Uint8Array }[] = [];
  const sph = (type: number) => 2 | 4 << 5 | type << 10;
  for (let i = 0; i < 90; i++) {
    const kind = i % 6, size = [0xc0, 0xd0, 0xd8][i % 3];
    const opts = kind === 0 ? { stage: 5 } : kind === 1 ? { stage: 0, sph: 0x481 } : kind === 2 ? { stage: 0, sph: sph(5) } : kind === 3 ? { stage: 0, sph: 0x061 } : kind === 4 ? { stage: 6 + ((i / 6) & 1) } : { stage: 0, sph: sph(2 + ((i / 6 | 0) % 3)) };
    cases.push({ key: (0xa000 + i).toString(16).padStart(16, "0"), ...nvn2Case(r, size, 0x100 + (r() << 2), opts) });
    if (kind === 4) {      // a task or mesh shader's own fields (dmsh_meshstage.info): threads, payload, vertices a primitive, vertex and primitive limits, no per-primitive SPH
      const c = cases[i].control, d = new DataView(c.buffer, c.byteOffset);
      d.setUint16(0x58, 32 << (i % 2), true); d.setUint16(0x5a, (i * 12) % 80, true); c[0x5f] = 1 + i % 3; d.setUint16(0x60, 1 + (i * 5) % 64, true); d.setUint16(0x62, 1 + (i * 7) % 126, true); c[0x68] &= 0x7f;
    }
  }
  writeFileSync(join(AM, "job_cases.json"), JSON.stringify(cases.map(k => ({ key: k.key, stage: "", control: hexOf(k.control), code: hexOf(k.code) }))));
  const py = JSON.parse(execFileSync("python3", [join(ROOT, "test/shaders/nvn2_ref.py"), join(AM, "job_cases.json"), join(AM, "ref")], { env: { ...process.env, NXNATIVE }, maxBuffer: 1 << 28 }).toString());
  const canon = (j: any) => JSON.stringify(Object.fromEntries(Object.entries(j).sort(([a], [b]) => a < b ? -1 : 1)));
  const seen: Record<string, number> = {};
  cases.forEach((k, i) => {
    const p = py[i], what = `case ${i} (${p.stage})`;
    let ts: any; try { const { job, body } = jobFor(k.key, k.control, k.code, ""); ts = { ...job, code: hexOf(body) }; } catch (e: any) { ts = { error: e.message }; }
    seen[p.stage + (ts.error ? " refused" : "")] = (seen[p.stage + (ts.error ? " refused" : "")] ?? 0) + 1;
    if (["vs", "ps", "cs"].includes(p.stage)) {
      if (p.nxnative.error) throw new Error(`${what}: nxnative refused it: ${p.nxnative.error}`);
      eq(canon(ts), canon(p.nxnative), `${what}: job.ts against nxnative's job_for`); eq(canon(p.nxweb), canon(p.nxnative), `${what}: xlate.py against nxnative's job_for`);
      eq(ts.arch, "sm86", `${what}: arch`);
    } else if (p.stage === "ts" || p.stage === "ms") {
      // task / mesh: compute with the stage memory in shared memory, nxnative's job but for its Metal-only mesh_stage facts (job.ts keeps its own, "mesh",
      // for src/shaders/meshstage.ts); one with shared memory of its own is refused where nxnative marks it refused
      if (p.nxnative.error) throw new Error(`${what}: nxnative refused it: ${p.nxnative.error}`);
      const { mesh_stage: facts, ...nj } = p.nxnative;
      if (facts?.refused) { if (!/shared memory of its own/.test(ts.error ?? "") || !/shared memory of its own/.test(p.nxweb?.error ?? "")) throw new Error(`${what}: nxnative refuses it (${facts.refused}), nxweb: ${ts.error} / ${p.nxweb?.error}`); return; }
      if (ts.error || p.nxweb?.error) throw new Error(`${what}: refused: ${ts.error} / ${p.nxweb?.error}`);
      const { mesh, ...tj } = ts;
      eq(canon(tj), canon(nj), `${what}: job.ts against nxnative's job_for`); eq(canon(p.nxweb), canon(nj), `${what}: xlate.py against nxnative's job_for`);
      eq([tj.stage, mesh.kind, mesh.threads, mesh.payload], ["cs", p.stage, facts.threads, facts.payload], `${what}: the stage's facts`);
    } else {
      // tessellation / geometry: refused by name on both nxweb sides
      if (!ts.error || !p.nxweb?.error) throw new Error(`${what}: not refused: ${JSON.stringify(ts).slice(0, 200)}`);
      if (!/tessellation or geometry/.test(ts.error) || !/tessellation or geometry/.test(p.nxweb.error)) throw new Error(`${what}: ${ts.error} / ${p.nxweb.error}`);
    }
  });
  if (!seen.cs || !seen.vs || !seen.ps || !seen.ts || !seen.ms) throw new Error(`stages: ${JSON.stringify(seen)}`);
  if (!cases.some((k, i) => py[i].stage === "ps" && py[i].nxnative.early_fragment_tests) || !cases.some((k, i) => py[i].stage === "ps" && !py[i].nxnative.early_fragment_tests)) throw new Error("early fragment tests: both answers not covered");
  // NVN (Maxwell) is the job the page made before: the hand-assembled programs, through job.ts and xlate.py (c1 aside: xlate.py takes code[c1o:c1t] as nxnative does)
  for (const row of JSON.parse(readFileSync(join(MX, "corpus.json"), "utf8"))) {
    const { job, body } = jobFor(row.key, readFileSync(join(MX, row.control)), readFileSync(join(MX, row.code)), "");
    eq([job.stage, job.arch, body.length], [row.stage, undefined, readFileSync(join(MX, row.code)).length - 0x30], `Maxwell ${row.name}`);
  }
  return Object.entries(seen).map(([s, n]) => `${n} ${s}`).join(", ");
});

const ampereXlate = xlate && nxnativeSrc;
let ampere: Awaited<ReturnType<typeof build>> | null = null;
await test("Ampere -> SPIR-V -> WGSL: nxnative's translator takes arch sm86 for the hand-built NVN2 stages (EXIT alone), the pass and naga convert them", async () => {
  if (!ampereXlate) return "SKIPPED: dotnet, the translator or the nxnative checkout is not there";
  execFileSync("python3", [join(ROOT, "tools/shaders/ampere_asm.py"), AM], { stdio: "ignore" });
  const rows = JSON.parse(readFileSync(join(AM, "corpus.json"), "utf8"));
  for (const row of rows) eq(row.key, tsKey(readFileSync(join(AM, row.control)), readFileSync(join(AM, row.code))), `${row.name}: ampere_asm.py's key is job.ts's`);
  const x = spawnSync("python3", [join(ROOT, "tools/shaders/xlate.py"), join(AM, "corpus.json"), join(AM, "spv")], { encoding: "utf8", env: { ...process.env, NXNATIVE } });
  if (x.status) throw new Error(x.stdout + x.stderr);
  if (have("spirv-val")) for (const e of JSON.parse(readFileSync(join(AM, "spv/xlate.json"), "utf8"))) { const v = spawnSync("spirv-val", [join(AM, "spv", e.spv)], { encoding: "utf8" }); if (v.status) throw new Error(`${e.name}: ${v.stderr}`); }
  ampere = await build({ spv: join(AM, "spv") });
  writeFileSync(join(OUT, "ampere.nxsl"), ampere.library);
  const bad = ampere.report.filter(r => !r.ok);
  if (bad.length) throw new Error(bad.map(b => `${b.name}: ${b.error}`).join("\n"));
  eq(ampere.report.map(r => r.name).sort(), rows.map((r: any) => r.name).sort(), "every stage in the library");
  if (!/@compute @workgroup_size\(32, 1, 1\)/.test(byName(ampere, "cs_exit").entry!.wgsl)) throw new Error(`cs_exit: not a 32 x 1 x 1 compute entry:\n${byName(ampere, "cs_exit").entry!.wgsl}`);
  if (!/@fragment/.test(byName(ampere, "ps_exit").entry!.wgsl) || !/@vertex/.test(byName(ampere, "vs_exit").entry!.wgsl)) throw new Error("the graphics stages' entry points");
  return `${rows.length} stages, ${ampere.library.length} bytes`;
});

if (!process.argv.includes("--no-browser")) {
  const req = createRequire(import.meta.url);
  let pw: any; for (const p of ["playwright", "/opt/node-tools/node_modules/playwright"]) { try { pw = req(p); break; } catch { /* next */ } }
  if (!pw) { failed++; console.error("[RED] playwright is not installed: the browser half did not run"); }
  else {
    execFileSync(join(ROOT, "node_modules/esbuild/bin/esbuild"), ["test/shaders/page.mts", "--bundle", "--format=esm", "--outfile=build/shaders/page.js", "--log-level=warning"], { cwd: ROOT, stdio: "inherit" });
    const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".nxsl": "application/octet-stream", ".spv": "application/octet-stream", ".code": "application/octet-stream", ".ctl": "application/octet-stream", ".json": "application/json" };
    const server = createServer((q, res) => {
      const file = join(ROOT, normalize(decodeURIComponent((q.url ?? "/").split("?")[0])));
      if (!file.startsWith(ROOT) || !existsSync(file) || !MIME[extname(file)]) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": MIME[extname(file)], "Cache-Control": "no-store" }); res.end(readFileSync(file));
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://localhost:${(server.address() as any).port}`;
    const browser = await pw.chromium.launch({ args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=swiftshader", "--use-vulkan=swiftshader"] });
    try {
      const page = await browser.newPage();
      const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(String(e)));
      await page.goto(`${url}/test/shaders/test.html`);
      await page.waitForFunction("window.__ready === true", null, { timeout: 30000 });

      const libs = ["corpus", "corpus_sg", "e2e", ...(maxwell ? ["maxwell"] : [])];
      for (const l of libs) await test(`browser: Chromium's WGSL compiler accepts every module of ${l}.nxsl`, async () => {
        if (l === "corpus_sg" && !await page.evaluate("window.__subgroups")) return "SKIPPED: the adapter has no WebGPU subgroups feature";
        const r: any[] = await page.evaluate(`validate("${url}/build/shaders/${l}.nxsl")`);
        const names = new Map((l === "corpus" ? corpus : l === "corpus_sg" ? corpusSg : l === "e2e" ? e2e : maxwell!).report.map(x => [x.key, x.name]));
        const known: Record<string, string> = l.startsWith("corpus") ? JSON.parse(readFileSync(join(CORPUS, "expect_wgsl.json"), "utf8")) : {};
        const bad: string[] = [];
        for (const m of r) {
          const n = names.get(m.key)!, want = known[n];
          if (want ? !m.errors.some((e: string) => e.includes(want)) : m.errors.length) bad.push(`${n}: ${m.errors.join(" | ") || `compiles, expect_wgsl.json says it fails with "${want}"`}`);
        }
        if (bad.length) throw new Error(bad.join("\n     "));
        const refused = r.filter(m => m.errors.length).length;
        return `${r.length - refused} of ${r.length} compile${refused ? `, ${refused} refused as test/shaders/corpus/expect_wgsl.json says` : ""}; adapter: ${await page.evaluate("window.__adapter")}`;
      });

      // The scene: a quad over the left half (vertex uniform: scale 0.5, 1; offset -0.5, 0), a 2 x 2 texture sampled nearest, times a tint; the fourth texel's alpha is
      // under the threshold, so its quarter keeps the clear colour. Expected values are computed here
      const scene = { vsUbo: [0.5, 1, -0.5, 0, 0.5, 0, 0, 0], fsUbo: [1, 0.5, 1, 1, 0.5, 0, 0, 0], texels: [255, 0, 0, 255, 0, 255, 0, 255, 255, 255, 255, 255, 255, 255, 0, 51] };
      const CLEAR = [0, 0, 255, 255];
      const expected = (px: number, py: number, ysign: number): number[] | null => {
        if (px === 15 || px === 16 || px === 31 || px === 32 || py === 31 || py === 32) return null;   // a pixel on an edge
        if (px >= 32) return CLEAR;
        const row = (ysign > 0 ? py : 63 - py) < 32 ? 0 : 1, col = px < 16 ? 0 : 1, t = scene.texels.slice((row * 2 + col) * 4, (row * 2 + col) * 4 + 4);
        const c = t.map((v, i) => v / 255 * scene.fsUbo[i]);
        return c[3] < scene.fsUbo[4] ? CLEAR : c.map(v => v * 255);
      };
      const check = (px: number[], ysign: number) => {
        let n = 0;
        for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
          const want = expected(x, y, ysign); if (!want) continue;
          const got = px.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4);
          if (got.some((v, i) => Math.abs(v - want[i]) > 1)) throw new Error(`pixel (${x}, ${y}): got ${got}, want ${want.map(v => Math.round(v))}`);
          n++;
        }
        return n;
      };
      const pairs: [string, string, string, string][] = [["e2e", byName(e2e, "e2e_vs").key, byName(e2e, "e2e_fs").key, "GLSL -> glslang -> SPIR-V pass -> naga -> library -> WebGPU"]];
      if (maxwell) pairs.push(["maxwell", byName(maxwell, "vs_quad_ubo").key, byName(maxwell, "ps_tex_tint").key, "Maxwell code -> Ryujinx translator -> SPIR-V pass -> naga -> library -> WebGPU"]);
      for (const [lib, vs, fs, what] of pairs) for (const [fix, mode] of [[[1, 1, 1, 0], "upper-left origin, near = 0"], [[1, -1, 0.5, 0.5], "lower-left origin, near = -w"]] as [number[], string][])
        await test(`browser: ${what}; ${mode}`, async () => {
          const px: number[] = await page.evaluate(([u, v, f, fx, sc]: any) => (globalThis as any).render(u, v, f, fx, sc), [`${url}/build/shaders/${lib}.nxsl`, vs, fs, fix, scene]);
          return `${check(px, fix[1])} pixels as computed`;
        });
      await test("browser: the scene's check can fail (the lower-left picture against the upper-left expectation)", async () => {
        const px: number[] = await page.evaluate(([u, v, f, fx, sc]: any) => (globalThis as any).render(u, v, f, fx, sc), [`${url}/build/shaders/e2e.nxsl`, pairs[0][1], pairs[0][2], [1, -1, 1, 0], scene]);
        let threw = false; try { check(px, 1); } catch { threw = true; }
        if (!threw) throw new Error("a flipped picture passed");
      });
      if (maxwell) await test("browser: the SPIR-V pass and naga run inside the page and give the offline WGSL", async () => {
        const f = byName(maxwell!, "ps_tex_tint");
        const r: any = await page.evaluate(([n, s]: any) => (globalThis as any).convertInPage(n, s, "nxweb"), [`${url}/build/shaders/nx_naga.wasm`, `${url}/build/shaders/maxwell/spv/${f.key}.spv`]);
        eq(r.errors, [], "Chromium's diagnostics"); eq(r.wgsl, f.entry!.wgsl, "WGSL"); eq(r.reflection, f.entry!.reflection, "reflection");
        return `naga instantiated in ${r.instantiateMs.toFixed(0)} ms, the stage converted in ${r.convertMs.toFixed(1)} ms`;
      });
      if (maxwell) await test("browser: the whole chain inside the page (the translator as WebAssembly on the .NET runtime, the pass, naga) gives the offline library's WGSL", async () => {
        if (!existsSync(join(OUT, "xlate_wasm/_framework/dotnet.js"))) return "SKIPPED: build/shaders/xlate_wasm is not built (tools/shaders/build_xlate_wasm.sh)";
        const rows = JSON.parse(readFileSync(join(MX, "corpus.json"), "utf8"));
        const r: any = await page.evaluate(([f, n, b, c]: any) => (globalThis as any).translateInPage(f, n, b, c), [`${url}/build/shaders/xlate_wasm/_framework`, `${url}/build/shaders/nx_naga.wasm`, `${url}/build/shaders/maxwell`, rows]);
        eq(r.rc, 0, "the translator's exit status");
        for (const e of maxwell!.entries) { eq(r.out[e.key]?.wgsl, e.wgsl, `WGSL of ${e.key}`); eq(r.out[e.key].reflection, e.reflection, `reflection of ${e.key}`); }
        return `.NET runtime up in ${r.startMs.toFixed(0)} ms; ${rows.length} stages translated in ${r.firstMs.toFixed(0)} ms the first time, ${r.warmMs.toFixed(0)} ms the second; pass + naga for the ${rows.length}: ${r.convertMs.toFixed(0)} ms`;
      });
      if (ampere) await test("browser: NVN2 through the page's chain (job.ts jobs, the translator as WebAssembly with arch sm86, the pass, naga) gives the offline library's WGSL", async () => {
        if (!existsSync(join(OUT, "xlate_wasm/_framework/dotnet.js"))) return "SKIPPED: build/shaders/xlate_wasm is not built (tools/shaders/build_xlate_wasm.sh)";
        const rows = JSON.parse(readFileSync(join(AM, "corpus.json"), "utf8"));
        const r: any = await page.evaluate(([f, n, b, c]: any) => (globalThis as any).translateJobsInPage(f, n, b, c), [`${url}/build/shaders/xlate_wasm/_framework`, `${url}/build/shaders/nx_naga.wasm`, `${url}/build/shaders/ampere`, rows]);
        eq(r.rc, 0, "the translator's exit status"); eq(r.jobs.map((j: any) => j.arch), rows.map(() => "sm86"), "arch");
        for (const e of ampere!.entries) { eq(r.out[e.key]?.wgsl, e.wgsl, `WGSL of ${e.key}`); eq(r.out[e.key].reflection, e.reflection, `reflection of ${e.key}`); }
        return `${rows.length} stages`;
      });
      if (errors.length) { failed++; console.error(`[RED] page errors:\n${errors.join("\n")}`); }
    } finally { await browser.close(); server.close(); }
  }
}
console.log(`\nshaders: ${ran} tests, ${failed} failed`);
process.exit(failed ? 1 : 0);
