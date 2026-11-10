// `npm run web:build`: everything web/index.html needs, in build/web/: the bundled page and Worker scripts, the
// runtime's wasm modules, and the built-in demo (the cube guest, built from test/runtime/src; nothing from any game)
// with the ratio "guest instructions per budget unit" measured for it here, for the page's instructions readout.
import { buildSync } from "esbuild";
import { copyFileSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, OUT, GUESTS, build, buildModules, loadEnv, haveNvn } from "../test/runtime/harness.mts";
import { bootGfx } from "../test/runtime/gfx_cases.ts";

export const WEB = join(ROOT, "build", "web");
export async function buildWeb(): Promise<void> {
  build(); buildModules();
  mkdirSync(join(WEB, "wasm"), { recursive: true }); mkdirSync(join(WEB, "demo"), { recursive: true });
  for (const entry of ["main", "worker"]) buildSync({ entryPoints: [`web/${entry}.ts`], bundle: true, format: "iife", outfile: `build/web/${entry}.js`, logLevel: "warning", absWorkingDir: ROOT });
  copyFileSync(join(ROOT, "web", "index.html"), join(WEB, "index.html"));
  for (const n of ["rt", "kernel", "loader", "translator", "helpers", "gfx"]) copyFileSync(join(OUT, n + ".wasm"), join(WEB, "wasm", n + ".wasm"));
  if (!haveNvn()) { writeFileSync(join(WEB, "demo", "demo.json"), "{}"); console.error("[RED] web:build: the demo guest needs nxnative's nvn.h and was not built: the demo button will fail"); return; }
  copyFileSync(join(GUESTS, "cube.nso"), join(WEB, "demo", "cube.nso"));
  // the same 120 frames twice on the null replayer: once normally (budget units), once with one instruction per unit
  const env = loadEnv(), files = [{ name: "cube", bytes: new Uint8Array(readFileSync(join(GUESTS, "cube.nso"))) }];
  const units = async (o: object) => { const p = await bootGfx(env, files, { frames: 120, ...o }); await p.rt.runAsync(); if (p.rt.state !== "Stopped") throw new Error("web:build: the demo did not finish"); return p.rt.units; };
  const normal = await units({}), insns = await units({ maxInsns: 1, budget: 1 << 20 });
  writeFileSync(join(WEB, "demo", "demo.json"), JSON.stringify({ instructionsPerUnit: insns / normal, frames: 120, instructions: insns, budgetUnits: normal }));
  console.log(`web:build: build/web ready; demo: ${insns} guest instructions and ${normal} budget units in 120 frames (${(insns / normal).toFixed(2)} instructions per unit)`);
}
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try { await buildWeb(); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
}
