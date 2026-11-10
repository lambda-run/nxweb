// npm run rt:browser [-- <filter>]: the cases of cases.ts in headless Chromium (Playwright), inside a Worker.
// The page is served from http://localhost with COOP same-origin and COEP require-corp.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { ROOT, OUT, GUESTS, MODULES, GFX_MODULES, haveNvn, build, buildModules, corpusList } from "./harness.mts";
import { writeFileSync } from "node:fs";
import { png } from "./png.mts";
import { formatResult, type CaseResult } from "./cases.ts";

process.chdir(ROOT);
try {
  build(); buildModules();
  buildSync({ entryPoints: ["test/runtime/web/worker.ts"], bundle: true, format: "iife", outfile: "build/runtime/web/worker.js", logLevel: "warning", absWorkingDir: ROOT });
} catch (e) { console.error(e instanceof Error ? e.message : e); console.error("[RED] rt:browser: the build failed"); process.exit(1); }

const { chromium } = createRequire(import.meta.url)("playwright");
const only = process.argv[2];
const page = `<!doctype html><meta charset="utf-8"><title>nxweb runtime tests</title><script>
window.results = []; window.finished = null; window.shots = []; window.notes = [];
window.start = (only) => { const w = new Worker("/worker.js");
  w.onmessage = (ev) => { if (ev.data.result) window.results.push(ev.data.result); else if (ev.data.shot) window.shots.push({ ...ev.data.shot, rgba: Array.from(ev.data.shot.rgba) }); else if (ev.data.note) window.notes.push(ev.data.note); else window.finished = ev.data; };
  w.onerror = (e) => { window.finished = { done: true, fatal: String(e.message) }; };
  w.postMessage({ only }); };
</script>`;
const corpusDir = join(ROOT, "test", "guests", "out");
const server = createServer((req, res) => {
  const url = req.url ?? "/";
  const head = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
  const send = (body: Buffer | string, type: string) => { res.writeHead(200, { ...head, "Content-Type": type }); res.end(body); };
  try {
    let m: RegExpExecArray | null;
    if (url === "/") return send(page, "text/html");
    if (url === "/worker.js") return send(readFileSync(join(OUT, "web", "worker.js")), "text/javascript");
    if (url === "/list") return send(JSON.stringify({ nso: [...Object.keys(MODULES), ...(haveNvn() ? Object.keys(GFX_MODULES) : [])], corpus: corpusList(), gfx: haveNvn() }), "application/json");
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
const browser = await chromium.launch({ headless: true, ...(channel === "shell" ? {} : { channel }), args: [...GPU_ARGS, ...(process.env.RT_BROWSER_LOG ? ["--enable-logging=stderr", "--v=0"] : [])] });
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
    const t0 = Date.now(), name = "page: web/index.html runs the built-in demo; state from the process machine, pause, resume, keyboard input, stop";
    try {
      const { buildWeb } = await import("../../web/build.mts"), { serve } = await import("../../web/serve.mts");
      await buildWeb();
      const web = await serve(0), q = await browser.newPage({ viewport: { width: 1180, height: 900 } });
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
        await q.click("#pause");
        await until("Paused", async () => await text("state") === "Paused");
        const f1 = await text("frames"); await new Promise(r => setTimeout(r, 400));
        if (await text("frames") !== f1) throw new Error("frames advance while Paused");
        await q.click("#resume");
        await until("Running again", async () => await text("state") === "Running" && await text("frames") !== f1);
        await q.click("#stop");
        await until("Stopped", async () => await text("state") === "Stopped");
        const why = await text("why"), red = await q.locator("#log .red").count();
        if (why !== "killed") throw new Error("why: " + why);
        if (red) throw new Error(red + " red log lines: " + (await q.locator("#log .red").allTextContents()).join(" | "));
        if (errors.length) throw new Error("page errors: " + errors.join(" | "));
        console.log(`ok   ${name} (${Date.now() - t0} ms)\n       ${fps.toFixed(1)} frames/s; instructions/s readout: ${ips}\n       per frame: ${split}\n       ${gpu}; canvas ${await shot()}; screenshot build/runtime/web.png`);
      } finally { await q.close(); web.server.close(); }
    } catch (e) { failed++; console.log(`[RED] FAIL ${name}\n${e instanceof Error ? e.stack : e}`); }
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`\nrt:browser (Chromium ${browser.version()}): ${ran} tests, ${failed} failed`);
process.exit(failed ? 1 : 0);
