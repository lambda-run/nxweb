// npm run rt:browser [-- <filter>]: the cases of cases.ts in headless Chromium (Playwright), inside a Worker.
// The page is served from http://localhost with COOP same-origin and COEP require-corp.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { ROOT, OUT, GUESTS, MODULES, GFX_MODULES, NRO_MODULES, BIG_DIR, SHADER_OUT, shaderArtifacts, buildBig, haveNvn, build, buildModules, corpusList } from "./harness.mts";
import { writeFileSync } from "node:fs";
import { png } from "./png.mts";
import { formatResult, type CaseResult } from "./cases.ts";

process.chdir(ROOT);
try {
  build(); buildModules();
  buildSync({ entryPoints: ["test/runtime/web/worker.ts"], bundle: true, format: "iife", outfile: "build/runtime/web/worker.js", logLevel: "warning", absWorkingDir: ROOT });
  buildSync({ entryPoints: ["test/runtime/web/main.ts"], bundle: true, format: "iife", outfile: "build/runtime/web/main.js", logLevel: "warning", absWorkingDir: ROOT });
  buildSync({ entryPoints: ["src/glue/rt_shader_worker.ts"], bundle: true, format: "esm", outfile: "build/runtime/web/shader_worker.js", logLevel: "warning", absWorkingDir: ROOT });
} catch (e) { console.error(e instanceof Error ? e.message : e); console.error("[RED] rt:browser: the build failed"); process.exit(1); }

const { chromium } = createRequire(import.meta.url)("playwright");
const only = process.argv[2];
const page = `<!doctype html><meta charset="utf-8"><title>nxweb runtime tests</title><script src="/main.js"></script>`;
const corpusDir = join(ROOT, "test", "guests", "out");
const haveBig = buildBig(), shaders = shaderArtifacts();
const TYPES: Record<string, string> = { ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".nxsl": "application/octet-stream" };
const server = createServer((req, res) => {
  const url = req.url ?? "/";
  const head = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
  const send = (body: Buffer | string, type: string) => { res.writeHead(200, { ...head, "Content-Type": type }); res.end(body); };
  try {
    let m: RegExpExecArray | null;
    if (url === "/") return send(page, "text/html");
    if (url === "/worker.js") return send(readFileSync(join(OUT, "web", "worker.js")), "text/javascript");
    if (url === "/main.js") return send(readFileSync(join(OUT, "web", "main.js")), "text/javascript");
    if (url === "/list") return send(JSON.stringify({ nso: [...Object.keys(MODULES), ...(haveNvn() ? Object.keys(GFX_MODULES) : [])], files: [...Object.keys(NRO_MODULES).map(n => n + ".nro"), "romfs.img", "romfs_blob.bin"], corpus: corpusList(), gfx: haveNvn(), big: haveBig ? "a64_big.O1" : null, shaders, guardRounds: process.env.RT_GUARD_ROUNDS ? Number(process.env.RT_GUARD_ROUNDS) : null }), "application/json");
    if (url === "/shader_worker.js") return send(readFileSync(join(OUT, "web", "shader_worker.js")), "text/javascript");
    if ((m = /^\/shaders\/([\w./-]+)$/.exec(url)) && !m[1].includes("..")) return send(readFileSync(join(SHADER_OUT, m[1])), TYPES[m[1].slice(m[1].lastIndexOf("."))] ?? "application/octet-stream");
    if ((m = /^\/guest\/([\w.]+)$/.exec(url))) return send(readFileSync(join(GUESTS, m[1])), "application/octet-stream");
    if ((m = /^\/big\/([\w.]+)$/.exec(url))) return send(readFileSync(join(BIG_DIR, m[1])), "application/octet-stream");
    if ((m = /^\/wasm\/(\w+\.wasm)$/.exec(url))) return send(readFileSync(join(OUT, m[1])), "application/wasm");
    if ((m = /^\/nso\/(\w+\.nso)$/.exec(url))) return send(readFileSync(join(GUESTS, m[1])), "application/octet-stream");
    if ((m = /^\/corpus\/([\w.]+)$/.exec(url))) return send(readFileSync(join(corpusDir, m[1])), "application/octet-stream");
  } catch { /* 404 */ }
  res.writeHead(404, head); res.end("not found");
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port;
// The full Chromium build in headless mode (Playwright channel "chromium"), not chrome-headless-shell: in the headless
// shell that is installed here ANY out-of-bounds wasm memory access kills the renderer with SIGSEGV instead of
// throwing WebAssembly.RuntimeError (measured with a 56-byte module; see src/runtime/README.md), so the fault tests
// cannot run there. RT_BROWSER_CHANNEL=shell selects the headless shell all the same.
const channel = process.env.RT_BROWSER_CHANNEL ?? "chromium";
// WebGPU in headless Chromium on a machine without a GPU: SwiftShader (the flags the gfx tests use)
const GPU_ARGS = ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=swiftshader", "--use-vulkan=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
// the page a person opens runs in a browser of its own with the default autoplay policy: its audio must start from a click
const pageBrowser = await chromium.launch({ headless: true, ...(channel === "shell" ? {} : { channel }), args: GPU_ARGS });
const browser = await chromium.launch({ headless: true, ...(channel === "shell" ? {} : { channel }), args: [...GPU_ARGS, "--autoplay-policy=no-user-gesture-required", ...(process.env.RT_BROWSER_LOG ? ["--enable-logging=stderr", "--v=0"] : [])] });
let failed = 0, ran = 0;
try {
  const p = await browser.newPage();
  p.on("pageerror", (e: Error) => { console.log("[RED] page error: " + e.message); failed++; });
  await p.goto(`http://localhost:${port}/`);
  console.log(`browser: Chromium ${browser.version()} (${channel === "shell" ? "chrome-headless-shell" : "channel " + channel + ", headless"}), crossOriginIsolated=${await p.evaluate("self.crossOriginIsolated")}`);
  await p.evaluate((o: string | undefined) => (window as any).start(o), only);
  for (;;) {
    const got: { results: CaseResult[]; finished: any } = await p.evaluate(() => { const w = window as any; return { results: w.results.splice(0), finished: w.finished }; });
    for (const r of got.results) { ran++; if (!r.ok) failed++; console.log(formatResult(r)); }
    if (got.finished) {
      const extra: { shots: { name: string; width: number; height: number; rgba: number[] }[]; notes: string[] } = await p.evaluate(() => ({ shots: (window as any).shots, notes: (window as any).notes }));
      for (const n of extra.notes) console.log(n);
      for (const s of extra.shots) { const f = join(OUT, s.name + ".png"); writeFileSync(f, png(s.width, s.height, Uint8Array.from(s.rgba))); console.log(`wrote build/runtime/${s.name}.png (${s.width}x${s.height}, the presented texture read back)`); }
      if (got.finished.fatal) { console.log("[RED] worker failed: " + got.finished.fatal); failed++; }
      else console.log(`worker: crossOriginIsolated=${got.finished.isolated}, SharedArrayBuffer available=${got.finished.sab}`);
      break;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  // ---- the page a person opens (web/index.html), driven as a person would ----
  if (haveNvn() && (!only || "page".includes(only) || only.includes("page"))) {
    ran++;
    const t0 = Date.now(), name = "page: web/index.html runs the built-in demo; state from the process machine, pause, resume, keyboard input, stop; then started and stopped five more times without a reload";
    try {
      const { buildWeb } = await import("../../web/build.mts"), { serve } = await import("../../web/serve.mts");
      await buildWeb();
      const web = await serve(0), q = await pageBrowser.newPage({ viewport: { width: 1180, height: 900 } });
      const errors: string[] = [];
      q.on("pageerror", (e: Error) => errors.push(e.message));
      try {
        await q.goto(web.url);
        const text = (id: string) => q.textContent("#" + id) as Promise<string>;
        const until = async (what: string, f: () => Promise<boolean>) => { for (let i = 0; i < 150; i++) { if (await f()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error("timed out waiting for " + what + "; state " + await text("state") + ", log: " + (await text("log")).slice(-600)); };
        if (await text("state") !== "Empty") throw new Error("the page does not start in Empty: " + await text("state"));
        if (!await q.evaluate("self.crossOriginIsolated")) throw new Error("the page is not cross-origin isolated");
        await q.click("#demo");
        await until("Running with 30 frames", async () => await text("state") === "Running" && Number((await text("frames")).split(",")[0]) >= 30);
        await until("an fps readout", async () => Number(await text("fps")) > 5);
        const fps = Number(await text("fps")), ips = await text("ips"), split = await text("split"), gpu = await text("gpu");
        const shot = async () => q.evaluate(() => { const c = document.getElementById("canvas") as HTMLCanvasElement; return c.width + "x" + c.height; });
        await q.keyboard.down("ArrowRight");
        await until("the pad readout to show the key", async () => (await text("pad")).includes("L 32767/0"));
        await new Promise(r => setTimeout(r, 500));
        await q.screenshot({ path: join(OUT, "web.png") });
        await q.keyboard.up("ArrowRight");
        // ---- what the page shows besides the picture: machines, modules, the guard ----
        const machine = (name: string) => q.textContent(`#machines tr[data-machine="${name}"]`).catch(() => "") as Promise<string>;
        await until("the machines table", async () => /Running/.test(await machine("process") ?? "") && /Live/.test(await machine("gfx_device") ?? ""));
        const mrows = await q.locator("#machines tbody tr").count(), modrow = await text("modtable"), tko = await text("takeovers");
        if (mrows < 8) throw new Error("the machines table has " + mrows + " rows");
        if (!/cube/.test(modrow) || !/[0-9a-f]{16}/.test(modrow) || !/none/.test(modrow)) throw new Error("the modules table: " + modrow);
        if (!/Take-overs: \d+ forced names hit by this program, \d+ not referenced/.test(tko)) throw new Error("take-overs: " + tko);
        if (!/On by default/.test(await text("guardnote")) || !await q.isChecked("#guard")) throw new Error("the guard note: " + await text("guardnote"));
        // ---- a frame capture: the pass text and the target images ----
        await q.keyboard.press("F9");
        await until("the capture", async () => /\nP /.test("\n" + await text("capturetext")) && await q.locator("#captureimages img").count() >= 1);
        await until("the capture's image to decode", async () => await q.evaluate(() => Array.from(document.querySelectorAll("#captureimages img")).every(i => (i as HTMLImageElement).naturalWidth === 480)));
        const capLines = (await text("capturetext")).split("\n").length, capImages = await q.locator("#captureimages img").count();
        // ---- the GPU device is destroyed under the running demo ----
        const f0 = Number((await text("frames")).split(",")[0]);
        await q.evaluate(() => (document.getElementById("losedevice") as HTMLButtonElement).click());
        await until("the device to be lost and restored", async () => /Live, lost 1 time, restored 1/.test(await machine("gfx_device") ?? ""));
        await until("frames after the loss", async () => Number((await text("frames")).split(",")[0]) > f0 + 30 && await text("state") === "Running");
        const redAfterLoss = await q.locator("#log .red").allTextContents();
        if (!redAfterLoss.length || !redAfterLoss.every(l => /device lost|the GPU device was lost/.test(l))) throw new Error("red lines after the device loss: " + redAfterLoss.join(" | "));
        if (!(await text("redcount")).startsWith(redAfterLoss.length + " red")) throw new Error("the red count: " + await text("redcount"));
        // the log's filter and "red only"
        await q.fill("#logfilter", "device lost");
        const shown = await q.evaluate(() => Array.from(document.querySelectorAll("#log span")).filter(s => getComputedStyle(s).display !== "none").length);
        if (shown < 1 || shown > 4) throw new Error("the log filter shows " + shown + " lines");
        await q.fill("#logfilter", ""); await q.check("#onlyred");
        const onlyRed = await q.evaluate(() => Array.from(document.querySelectorAll("#log span")).filter(s => getComputedStyle(s).display !== "none").length);
        if (onlyRed !== redAfterLoss.length) throw new Error(`"red lines only" shows ${onlyRed} lines of ${redAfterLoss.length}`);
        await q.uncheck("#onlyred");
        // ---- the report: one text block ----
        await q.click("#copyreport");
        await until("the report", async () => (await q.inputValue("#reporttext")).includes("machines (name: state now"));
        const report = await q.inputValue("#reporttext");
        for (const want of ["nxweb report: the built-in demo (cube.nso)", "graphics: WebGPU:", "translator options key: ", "host-area guard on", "process: Running", "fault: none", "cube: build id ", "take-overs: ", "  process: Running", "  gfx_device: Live, lost 1 time", "counters:", "log: the last "])
          if (!report.includes(want)) throw new Error(`the report lacks "${want}":\n` + report.slice(0, 1500));
        await q.click("#pause");
        await until("Paused", async () => await text("state") === "Paused");
        const f1 = await text("frames"); await new Promise(r => setTimeout(r, 400));
        if (await text("frames") !== f1) throw new Error("frames advance while Paused");
        await q.click("#resume");
        await until("Running again", async () => await text("state") === "Running" && await text("frames") !== f1);
        await q.click("#stop");
        await until("Stopped", async () => await text("state") === "Stopped");
        if (await text("why") !== "killed") throw new Error("why: " + await text("why"));
        // a second program without reloading the page: the demo again, stopped again, five times
        for (let i = 1; i <= 5; i++) {
          await q.click("#demo");
          await until(`run ${i + 1}: Running with 20 frames`, async () => await text("state") === "Running" && Number((await text("frames")).split(",")[0]) >= 20);
          await q.click("#stop");
          await until(`run ${i + 1}: Stopped`, async () => await text("state") === "Stopped");
        }
        // ---- the audio demo: the context starts from the click that starts it (this browser has no autoplay) ----
        await q.click("#demotone");
        await until("the audio output to be Live on the device", async () => /Live/.test(await machine("audio_out") ?? "") && await q.evaluate(() => (window as any).nxwebTest.audio.ctx?.state === "running"));
        const audioRow = await machine("audio_out");
        await until("the tone to end by itself", async () => await text("state") === "Stopped" && await text("why") === "exit code 0");
        await q.click("#demo");
        await until("the demo again after the audio demo", async () => await text("state") === "Running" && Number((await text("frames")).split(",")[0]) >= 10);
        await q.click("#stop");
        await until("Stopped", async () => await text("state") === "Stopped");
        // ---- a game folder through the prepare frame: pick, stages, Play: the hand-off starts the process here ----
        // (the folder is the one prepare:browser writes: the file-system guest under a title the profiles know)
        const folder = join(ROOT, "build", "prepare", "scratch", "browser-input", "DarkGame");
        let handoff = "the prepare hand-off was SKIPPED: " + folder + " is not there (npm run prepare:browser writes it)";
        if (existsSync(folder)) {
          const fr = q.frameLocator("#prepare");
          await fr.locator("#dirinput").setInputFiles(folder);
          await until("the prepare stages to be Ready", async () => await fr.locator("#machine").getAttribute("data-state") === "Ready" && await fr.locator("#play").isEnabled());
          await fr.locator("#play").click();
          await until("the handed-over program to run and exit", async () => /handed over DARK SOULS/.test(await text("log")) && await text("state") === "Stopped" && /^exit code/.test(await text("why")));
          const opt = await text("options"), mods = await text("modtable"), out = await q.locator("#log .out").allTextContents();
          if (!/layout from the profile \((profile|pool)\): heap 3\.\d+ GB, alias 0\.25 GB, pool 3\.21 GB/.test(opt)) throw new Error("the options of the handed-over process: " + opt);
          if (!/main/.test(mods) || !/test_mode/.test(mods)) throw new Error("the modules of the handed-over process (its unresolved imports by name): " + mods);
          if (!out.some(l => /^MountRom: 0x0/.test(l)) || !out.some(l => /^rom:\/data\/blob.bin: \d+ bytes of/.test(l))) throw new Error("the guest did not read its RomFS through the hand-off: " + out.join(" | "));
          handoff = `game folder through the prepare frame: Ready, Play, handed over; ${opt.slice(opt.indexOf("layout"))}; the guest read its RomFS from the folder (${await text("why")})`;
        }
        const why = (await q.click("#demo"), await until("the demo after the hand-off", async () => await text("state") === "Running"), await q.click("#stop"), await until("Stopped", async () => await text("state") === "Stopped"), await text("why"));
        const red = (await q.locator("#log .red").allTextContents()).filter(l => !/device lost|the GPU device was lost|unresolved import test_(mode|written)/.test(l)).length, more = await text("more");
        if (why !== "killed") throw new Error("why: " + why);
        if (!/\d+ translated units from the cache/.test(more)) throw new Error("the later runs did not start from the translation cache: " + more);
        if (/read-only|no OPFS/.test(more)) throw new Error("the save containers of the run before were not released: " + more);
        if (red) throw new Error(red + " red log lines: " + (await q.locator("#log .red").allTextContents()).join(" | "));
        if (errors.length) throw new Error("page errors: " + errors.join(" | "));
        console.log(`ok   ${name} (${Date.now() - t0} ms)\n       ${fps.toFixed(1)} frames/s; instructions/s readout: ${ips}\n       per frame: ${split}\n       ${gpu}; canvas ${await shot()}; screenshot build/runtime/web.png\n       last run: ${more}\n       machines table ${mrows} rows; frame capture by F9: ${capLines} lines of pass text, ${capImages} target image(s); device destroyed and restored while running (${redAfterLoss.length} red lines, all about the loss); report of ${report.split("\n").length} lines\n       audio demo started by its click: ${audioRow}\n       ${handoff}`);
      } finally { await q.close(); web.server.close(); }
    } catch (e) { failed++; console.log(`[RED] FAIL ${name}\n${e instanceof Error ? e.stack : e}`); }
  }
} finally {
  await pageBrowser.close();
  await browser.close();
  server.close();
}
console.log(`\nrt:browser (Chromium ${browser.version()}): ${ran} tests, ${failed} failed`);
process.exit(failed ? 1 : 0);
