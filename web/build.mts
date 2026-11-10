// `npm run web:build`: everything web/index.html needs, in build/web/: the bundled page and Worker scripts, the
// runtime's wasm modules, and the built-in demo (the cube guest, built from test/runtime/src; nothing from any game)
// with the ratio "guest instructions per budget unit" measured for it here, for the page's instructions readout.
import { buildSync } from "esbuild";
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ROOT, OUT, GUESTS, SHADER_OUT, build, buildModules, loadEnv, haveNvn, shaderArtifacts } from "../test/runtime/harness.mts";
import { bootGfx } from "../test/runtime/gfx_cases.ts";

export const WEB = join(ROOT, "build", "web");
export async function buildWeb(): Promise<void> {
  build(); buildModules();
  mkdirSync(join(WEB, "wasm"), { recursive: true }); mkdirSync(join(WEB, "demo"), { recursive: true });
  for (const entry of ["main", "worker"]) buildSync({ entryPoints: [`web/${entry}.ts`], bundle: true, format: "iife", outfile: `build/web/${entry}.js`, logLevel: "warning", absWorkingDir: ROOT });
  copyFileSync(join(ROOT, "web", "index.html"), join(WEB, "index.html"));
  buildSync({ entryPoints: ["src/glue/rt_shader_worker.ts"], bundle: true, format: "esm", outfile: "build/web/shader_worker.js", logLevel: "warning", absWorkingDir: ROOT });
  for (const n of ["rt", "kernel", "loader", "translator", "helpers", "gfx", "fs", "hle"]) copyFileSync(join(OUT, n + ".wasm"), join(WEB, "wasm", n + ".wasm"));
  // the in-page shader translator (the Ryujinx translator as WebAssembly, naga): only when tools/shaders built it
  rmSync(join(WEB, "shaders"), { recursive: true, force: true });
  if (shaderArtifacts().translator) {
    cpSync(join(SHADER_OUT, "xlate_wasm"), join(WEB, "shaders", "xlate_wasm"), { recursive: true });
    copyFileSync(join(SHADER_OUT, "nx_naga.wasm"), join(WEB, "shaders", "nx_naga.wasm"));
  } else console.error("web:build: the in-page shader translator is not built (tools/shaders; dotnet, cargo and the nxnative checkout): the page uses shader libraries only");
  if (!haveNvn()) { writeFileSync(join(WEB, "demo", "demo.json"), "{}"); console.error("[RED] web:build: the demo guest needs nxnative's nvn.h and was not built: the demo button will fail"); return; }
  copyFileSync(join(GUESTS, "cube.nso"), join(WEB, "demo", "cube.nso"));
  // the same frames on the null replayer, normally (budget units) and with one instruction per unit
  const env = loadEnv(), files = [{ name: "cube", bytes: new Uint8Array(readFileSync(join(GUESTS, "cube.nso"))) }];
  // per-frame steady state: the difference between 240 and 120 frames, so that start-up does not count
  const units = async (frames: number, o: object) => { const p = await bootGfx(env, files, { frames, ...o }); await p.rt.runAsync(); if (p.rt.state !== "Stopped") throw new Error("web:build: the demo did not finish"); return p.rt.units; };
  const one = { maxInsns: 1, budget: 1 << 20 };
  const normal = await units(240, {}) - await units(120, {}), insns = await units(240, one) - await units(120, one);
  writeFileSync(join(WEB, "demo", "demo.json"), JSON.stringify({ instructionsPerUnit: insns / normal, frames: 120, instructions: insns, budgetUnits: normal }));
  console.log(`web:build: build/web ready; demo: ${insns} guest instructions and ${normal} budget units per 120 frames in steady state (${(insns / normal).toFixed(1)} instructions per unit, ${Math.round(insns / 120)} per frame)`);
}
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try { await buildWeb(); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
}
