// `npm run shaders:test`: the shader chain's tests.
//   Node:    SPIR-V reader / writer, the library format and its loader, the GLSL corpus against test/shaders/corpus/expect.json, spirv-val on every rewritten module,
//            the hand-assembled Maxwell programs through nxnative's translator (when dotnet and the translator are there), garbage into every stage.
//   Browser: every WGSL module compiled by Chromium's own compiler, the end-to-end scene rendered with WebGPU on SwiftShader and its pixels compared, the conversion
//            run inside the page. `--no-browser` leaves that half out.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, extname, normalize, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse, serialize, fixForWgsl } from "../../src/shaders/spv.ts";
import { ShaderLibrary, writeLibrary, type Reflection } from "../../src/shaders/library.ts";
import { build, glslToSpv } from "../../tools/shaders/build_lib.mts";
import { load } from "../../tools/shaders/naga_node.mts";

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
  if (/c25/.test(v.wgsl.replace(/var<private> \w+c25_/, "")) === false) throw new Error("expected the bound-size table as a private constant");
  if (/var<uniform> \w*c25/.test(v.wgsl + f.wgsl)) throw new Error("the bound-size table is still a uniform buffer");
  return `${maxwell.report.length} stages, ${maxwell.library.length} bytes`;
});

// ---- the browser half ----
if (!process.argv.includes("--no-browser")) {
  const req = createRequire(import.meta.url);
  let pw: any; for (const p of ["playwright", "/opt/node-tools/node_modules/playwright"]) { try { pw = req(p); break; } catch { /* next */ } }
  if (!pw) { failed++; console.error("[RED] playwright is not installed: the browser half did not run"); }
  else {
    execFileSync(join(ROOT, "node_modules/esbuild/bin/esbuild"), ["test/shaders/page.mts", "--bundle", "--format=esm", "--outfile=build/shaders/page.js", "--log-level=warning"], { cwd: ROOT, stdio: "inherit" });
    const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".nxsl": "application/octet-stream", ".spv": "application/octet-stream", ".code": "application/octet-stream", ".json": "application/json" };
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

      const libs = ["corpus", "e2e", ...(maxwell ? ["maxwell"] : [])];
      for (const l of libs) await test(`browser: Chromium's WGSL compiler accepts every module of ${l}.nxsl`, async () => {
        const r: any[] = await page.evaluate(`validate("${url}/build/shaders/${l}.nxsl")`);
        const names = new Map((l === "corpus" ? corpus : l === "e2e" ? e2e : maxwell!).report.map(x => [x.key, x.name]));
        const known: Record<string, string> = l === "corpus" ? JSON.parse(readFileSync(join(CORPUS, "expect_wgsl.json"), "utf8")) : {};
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
        return `.NET runtime up in ${r.startMs.toFixed(0)} ms; 3 stages translated in ${r.firstMs.toFixed(0)} ms the first time, ${r.warmMs.toFixed(0)} ms the second; pass + naga for the 3: ${r.convertMs.toFixed(0)} ms`;
      });
      if (errors.length) { failed++; console.error(`[RED] page errors:\n${errors.join("\n")}`); }
    } finally { await browser.close(); server.close(); }
  }
}
console.log(`\nshaders: ${ran} tests, ${failed} failed`);
process.exit(failed ? 1 : 0);
