// Builds an nxweb shader library (src/shaders/library.ts) from SPIR-V or, for tests, from GLSL.
//   node tools/shaders/build_lib.mts --spv <dir> -o <library.nxsl> [--report <file.json>]
//       <dir>/xlate.json as tools/shaders/xlate.py writes it: [{ name, stage, key, spv, res, c1 }]; bindings come from the translator's names, c1 (hex) is the stage's c1 segment
//   node tools/shaders/build_lib.mts --glsl <dir> -o <library.nxsl> [--report <file.json>]
//       <dir>/manifest.json: [{ name, file, key? }], stage from the file's extension (.vert / .frag); compiled with glslangValidator -V; the GLSL carries the nxweb
//       set and binding numbers itself (a combined sampler at binding b gets its sampler at b + 1). key defaults to sha256(source)[0..8], a test key and nothing else
// Both may be given. A stage that cannot be converted is reported with its reason and left out; the exit status is 1 if any was.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { load } from "./naga_node.mts";
import { convertStage } from "../../src/shaders/convert.ts";
import { writeLibrary, type Reflection } from "../../src/shaders/library.ts";

export interface Report { name: string; key: string; stage: string; ok: boolean; error?: string; notes?: string[]; spvBytes?: number; wgslBytes?: number; ms?: number }
export function glslToSpv(file: string): Uint8Array {
  const d = mkdtempSync(join(tmpdir(), "nxsl-"));
  try {
    execFileSync("glslangValidator", ["-V", "--quiet", file, "-o", join(d, "o.spv")], { stdio: ["ignore", "pipe", "pipe"] });
    return new Uint8Array(readFileSync(join(d, "o.spv")));
  } catch (e: any) { throw new Error(`glslangValidator: ${(e.stdout?.toString() || e.message).trim().split("\n").slice(0, 3).join(" | ")}`); } finally { rmSync(d, { recursive: true, force: true }); }
}

export async function build(opts: { spv?: string; glsl?: string; chain?: string }) {
  const naga = await load();
  const entries: { key: string; wgsl: string; reflection: Reflection }[] = [], report: Report[] = [];
  const one = (name: string, key: string, stage: string, get: () => Uint8Array, mode: "nxweb" | "keep", c1?: string) => {
    const t = performance.now();
    try {
      const spv = get(), c = convertStage(naga, spv, { bindings: mode, c1 });
      entries.push({ key, wgsl: c.wgsl, reflection: c.reflection });
      report.push({ name, key, stage, ok: true, notes: c.reflection.notes, spvBytes: spv.length, wgslBytes: c.wgsl.length, ms: +(performance.now() - t).toFixed(2) });
    } catch (e: any) { report.push({ name, key, stage, ok: false, error: String(e.message ?? e) }); }
  };
  if (opts.spv) for (const r of JSON.parse(readFileSync(join(opts.spv, "xlate.json"), "utf8")))
    one(r.name, r.key, r.stage, () => new Uint8Array(readFileSync(join(opts.spv!, r.spv))), "nxweb", r.c1);
  if (opts.glsl) for (const r of JSON.parse(readFileSync(join(opts.glsl, "manifest.json"), "utf8"))) {
    const file = join(opts.glsl, r.file), key = r.key ?? createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
    one(r.name, key, file.endsWith(".vert") ? "vs" : "ps", () => glslToSpv(file), "keep");
  }
  const library = writeLibrary(entries, { chain: opts.chain ?? "nxweb-shaders-2 (dmsh_xlate -> src/shaders/spv.ts -> naga 30.0.1)", built: entries.length, failed: report.filter(r => !r.ok).length });
  return { library, report, entries };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2), arg = (n: string) => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
  const out = arg("-o");
  if (!out || (!arg("--spv") && !arg("--glsl"))) { console.error("usage: build_lib.mts [--spv <dir>] [--glsl <dir>] -o <library.nxsl> [--report <file.json>]"); process.exit(2); }
  const { library, report } = await build({ spv: arg("--spv"), glsl: arg("--glsl") });
  writeFileSync(out, library);
  if (arg("--report")) writeFileSync(arg("--report")!, JSON.stringify(report, null, 1));
  for (const r of report) {
    if (!r.ok) console.log(`[RED] ${r.key} ${r.stage} ${r.name}: ${r.error}`);
    else for (const n of r.notes ?? []) console.log(`note ${r.key} ${r.name}: ${n}`);
  }
  const bad = report.filter(r => !r.ok).length;
  console.log(`${out}: ${report.length - bad} stages, ${library.length} bytes; ${bad} failed`);
  process.exit(bad ? 1 : 0);
}
