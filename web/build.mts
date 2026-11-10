// `npm run web:build`: everything web/index.html needs, in build/web/: the bundled page and Worker scripts, the
// runtime's wasm modules, and the built-in demo (the cube guest, built from test/runtime/src; nothing from any game)
// with the ratio "guest instructions per budget unit" measured for it here, for the page's instructions readout; and
// the Doom demo when its engine is on this machine (see buildDoomDemo).
import { buildSync } from "esbuild";
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, OUT, GUESTS, SHADER_OUT, build, buildModules, loadEnv, haveNvn, shaderArtifacts } from "../test/runtime/harness.mts";
import { bootGfx } from "../test/runtime/gfx_cases.ts";
import { buildPreparePage } from "./prepare_build.mts";
import { buildDoom, doomWad } from "../test/doom/harness.mts";
import { bootDoom } from "../test/doom/boot.ts";

export const WEB = join(ROOT, "build", "web");
// The Doom demo (test/doom): build/web/demo/doom.nso when the engine is here (it is not in this repository:
// tools/doom/fetch.sh or DOOMGENERIC), and the data file beside it only when DOOM_WAD names one (otherwise the page
// asks for it). demo/doom.json tells the page what is there; without the engine the button stays off.
async function buildDoomDemo(): Promise<void> {
  const demo = join(WEB, "demo");
  for (const f of ["doom.nso", "doom1.wad"]) rmSync(join(demo, f), { force: true });
  const info: { present: boolean; wad: boolean; instructionsPerUnit?: number } = { present: false, wad: false };
  const nso = buildDoom(l => console.error("web:build: " + l.replace(/^doom: /, "the Doom demo: ")));
  if (nso) {
    copyFileSync(nso, join(demo, "doom.nso")); info.present = true;
    const wad = doomWad();
    if (wad) {
      copyFileSync(wad, join(demo, "doom1.wad")); info.wad = true;
      // instructions per budget unit over 100 tics of the engine's -timedemo (the same work whatever the clock says)
      const env = loadEnv(), bytes = new Uint8Array(readFileSync(nso)), data = new Uint8Array(readFileSync(wad));
      const units = async (o: object) => {
        let u0 = -1, u1 = 0;
        const p = await bootDoom(env, bytes, data, { args: "-timedemo demo1", ...o, onFrame: f => { if (u0 < 0 && f.gametic >= 100) u0 = p.rt.units; if (f.gametic >= 200) { u1 = p.rt.units; return true; } } });
        await p.rt.runAsync();
        return u1 - u0;
      };
      const normal = await units({}), insns = await units({ maxInsns: 1, budget: 1 << 20 });
      info.instructionsPerUnit = insns / normal;
      console.log(`web:build: the Doom demo: doom.nso and doom1.wad are in build/web/demo; ${Math.round(insns / 100)} guest instructions per frame, ${(insns / normal).toFixed(1)} per budget unit`);
    } else console.error("web:build: the Doom demo: DOOM_WAD is not set, so the page will ask for doom1.wad (the data file is never fetched or committed)");
  }
  writeFileSync(join(demo, "doom.json"), JSON.stringify(info));
}
export async function buildWeb(): Promise<void> { await buildWebFiles(); writeStamp(); }
async function buildWebFiles(): Promise<void> {
  build(); buildModules();
  mkdirSync(join(WEB, "wasm"), { recursive: true }); mkdirSync(join(WEB, "demo"), { recursive: true });
  for (const entry of ["main", "worker"]) buildSync({ entryPoints: [`web/${entry}.ts`], bundle: true, format: "iife", outfile: `build/web/${entry}.js`, logLevel: "warning", absWorkingDir: ROOT });
  copyFileSync(join(ROOT, "web", "index.html"), join(WEB, "index.html"));
  buildPreparePage();   // the game-folder intake (web/prepare.html) is a frame of the page
  buildSync({ entryPoints: ["src/glue/rt_shader_worker.ts"], bundle: true, format: "esm", outfile: "build/web/shader_worker.js", logLevel: "warning", absWorkingDir: ROOT });
  // (and the same modules built for a 64-bit memory, which the worker fetches only for a process that needs them)
  for (const n of ["rt", "kernel", "loader", "translator", "helpers", "gfx", "fs", "hle", "audio"]) for (const m of ["", "64"]) copyFileSync(join(OUT, n + m + ".wasm"), join(WEB, "wasm", n + m + ".wasm"));
  copyFileSync(join(GUESTS, "tone.nso"), join(WEB, "demo", "tone.nso"));   // the audio demo
  // the in-page shader translator (the Ryujinx translator as WebAssembly, naga): only when tools/shaders built it
  rmSync(join(WEB, "shaders"), { recursive: true, force: true });
  if (shaderArtifacts().translator) {
    cpSync(join(SHADER_OUT, "xlate_wasm"), join(WEB, "shaders", "xlate_wasm"), { recursive: true });
    copyFileSync(join(SHADER_OUT, "nx_naga.wasm"), join(WEB, "shaders", "nx_naga.wasm"));
  } else console.error("web:build: the in-page shader translator is not built (tools/shaders; dotnet, cargo and the nxnative checkout): the page uses shader libraries only");
  if (!haveNvn()) { await buildDoomDemo(); writeFileSync(join(WEB, "demo", "demo.json"), "{}"); console.error("[RED] web:build: the demo guest needs nxnative's nvn.h and was not built: the demo button will fail"); return; }
  copyFileSync(join(GUESTS, "cube.nso"), join(WEB, "demo", "cube.nso"));
  // the same frames on the null replayer, normally (budget units) and with one instruction per unit
  const env = loadEnv(), files = [{ name: "cube", bytes: new Uint8Array(readFileSync(join(GUESTS, "cube.nso"))) }];
  // per-frame steady state: the difference between 240 and 120 frames, so that start-up does not count
  const units = async (frames: number, o: object) => { const p = await bootGfx(env, files, { frames, ...o }); await p.rt.runAsync(); if (p.rt.state !== "Stopped") throw new Error("web:build: the demo did not finish"); return p.rt.units; };
  const one = { maxInsns: 1, budget: 1 << 20 };
  const normal = await units(240, {}) - await units(120, {}), insns = await units(240, one) - await units(120, one);
  writeFileSync(join(WEB, "demo", "demo.json"), JSON.stringify({ instructionsPerUnit: insns / normal, frames: 120, instructions: insns, budgetUnits: normal }));
  await buildDoomDemo();
  console.log(`web:build: build/web ready; demo: ${insns} guest instructions and ${normal} budget units per 120 frames in steady state (${(insns / normal).toFixed(1)} instructions per unit, ${Math.round(insns / 120)} per frame)`);
}
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try { await buildWeb(); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
}

// build/web/build.json: which build a page or report is (shown at the top of the page and in the report): the
// commit, whether the tree had changes, the build time, and an md5 of every built file
function writeStamp(): void {
  const git = (a: string) => { try { return execSync("git " + a, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
  const md5 = createHash("md5");
  const files = (readdirSync(WEB, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter(d => d.isFile()).map(d => join(d.parentPath, d.name)).filter(f => f !== join(WEB, "build.json")).sort();
  for (const f of files) { md5.update(f.slice(WEB.length)); md5.update(readFileSync(f)); }
  const stamp = { commit: git("rev-parse --short HEAD") || "unknown", branch: git("rev-parse --abbrev-ref HEAD"), dirty: git("status --porcelain --untracked-files=no") !== "", date: new Date().toISOString(), md5: md5.digest("hex"), files: files.length };
  writeFileSync(join(WEB, "build.json"), JSON.stringify(stamp));
  console.error(`web:build: ${buildLine(stamp)}`);
}
export const buildLine = (b: { commit: string; dirty: boolean; date: string; md5: string }) => `${b.commit}${b.dirty ? "+changes" : ""} · ${b.date.slice(0, 16).replace("T", " ")} UTC · md5 ${b.md5.slice(0, 8)}`;
