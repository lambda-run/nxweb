// The browser half of `npm run gfx:test`: bundles the scene page and the demo with esbuild, serves the tree on
// localhost (WebGPU needs a secure context; COOP/COEP so SharedArrayBuffer is there too), runs the scenes in headless
// Chromium on SwiftShader, and takes the demo's screenshot.
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname, normalize, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { ROOT, OUT, guest } from "./harness.mts";
import { readMachines, unexercised } from "../../src/kit/host/reader.mts";

// --expose-gc: the scene page collects after each scene (test/gfx/page.mts)
export const CHROMIUM_ARGS = ["--js-flags=--expose-gc", "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=swiftshader", "--use-vulkan=swiftshader"];
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".png": "image/png", ".map": "application/json", ".json": "application/json" };

export function bundle(): void {
  execFileSync(join(ROOT, "node_modules", "esbuild", "bin", "esbuild"), ["test/gfx/page.mts", "test/gfx/demo.mts", "--bundle", "--format=esm", "--outdir=build/gfx", "--sourcemap", "--log-level=warning"],
    { cwd: ROOT, stdio: "inherit" });
}
export function serve(port = 0): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])), file = join(ROOT, path);
    if (!file.startsWith(ROOT) || !existsSync(file) || !MIME[extname(file)]) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[extname(file)], "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" });
    res.end(readFileSync(file));
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve({ server, url: `http://localhost:${(server.address() as any).port}` })));
}
function playwright(): any {
  const req = createRequire(import.meta.url);
  for (const p of ["playwright", "/opt/node-tools/node_modules/playwright"]) { try { return req(p); } catch { /* next */ } }
  throw new Error("playwright is not installed");
}

export async function browserTests(only?: string): Promise<{ ran: number; failed: number; summary: string }> {
  bundle();
  execFileSync("python3", [join(ROOT, "test/gfx/swizzle_ref.py"), join(OUT, "swizzle.json")], { stdio: "ignore" });
  if (spawnSync("python3", [join(ROOT, "test/gfx/astc_ref.py"), join(OUT, "astc.json")], { stdio: "ignore" }).status !== 0) writeFileSync(join(OUT, "astc.json"), JSON.stringify({ cases: [] }));
  const { server, url } = await serve();
  const browser = await playwright().chromium.launch({ args: CHROMIUM_ARGS });
  let failed = 0, summary = "";
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(String(e)));
    await page.goto(`${url}/test/gfx/test.html?mem=${process.env.NX_MEM ?? "32"}${only ? `&only=${encodeURIComponent(only)}` : ""}`);
    const r = await page.evaluate("window.__gfx");
    if (r.fatal) throw new Error(`the scene page failed: ${r.fatal}\n${errors.join("\n")}`);
    console.log(`\nscenes in headless Chromium, WebGPU adapter: ${r.adapter || "(no info)"}; features ${r.features.join(", ")}\n     adapter limits: ${r.limits}`);
    let checks = 0, calls = 0;
    for (const s of r.results) {
      checks += s.checks; calls += s.calls;
      if (s.error) { failed++; console.error(`[RED] FAIL scene: ${s.name}\n${s.error}\n  last log lines:\n  ${(s.logs ?? []).join("\n  ")}`); }
      else console.log(`ok   scene: ${s.name}  (${s.checks} checks, ${s.calls} NVN calls, ${s.ms} ms)`);
      for (const n of s.notes ?? []) console.log(`     ${n}`);
      for (const f of s.files ?? []) { const out = join(OUT, f.name); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, f.text !== undefined ? f.text : Buffer.from(f.base64, "base64")); }
    }
    summary = ` (${checks} checks, ${calls} NVN calls)`;
    // Which transitions of the graphics machines the real module took while rendering the scenes
    if (!only && r.hits.length) {
      const g = await guest(), x = { ...g.x, memory: g.memory };
      new Uint8Array(g.memory.buffer).set(r.hits, x.kit_hits_ptr());
      const machines = readMachines(x as any), gfx = machines.filter(m => m.name.startsWith("gfx_"));
      const missing = unexercised(gfx, gfx.map(m => m.hits)), total = gfx.reduce((n, m) => n + Array.from(m.table).filter(c => c !== 0xff).length, 0);
      console.log(`machines: the scenes took ${total - missing.length}/${total} transitions of ${gfx.map(m => m.name).join(", ")}${missing.length ? `; not taken by a scene (covered by kit:test): ${missing.join("; ")}` : ""}`);
    }
    // The demo, as a person would open it: a few frames, then a screenshot
    if (!only) {
      const demo = await browser.newPage({ viewport: { width: 720, height: 520 } });
      const derr: string[] = [];
      demo.on("pageerror", (e: Error) => derr.push(String(e)));
      await demo.goto(`${url}/test/gfx/demo.html`);
      try {
        await demo.waitForFunction("window.__demo && window.__demo.frames >= 12", null, { timeout: 60000 });
        const c = await demo.evaluate("window.__demo.check()");
        writeFileSync(join(OUT, "demo.png"), await demo.screenshot());
        const ok = c.red.length === 0 && c.errors === 0 && c.cube > 1500 && c.colours >= 3 && c.background > 1500;
        if (!ok) { failed++; console.error(`[RED] FAIL demo: ${JSON.stringify(c)}`); }
        else console.log(`ok   demo: spinning textured cube, ${c.frames} frames; presented texture ${c.width}x${c.height}: ${c.cube} cube pixels in ${c.colours} colours over ${c.background} background pixels; screenshot build/gfx/demo.png`);
      } catch (e) { failed++; console.error(`[RED] FAIL demo: ${e}\n${derr.join("\n")}`); }
    }
    return { ran: r.results.length + (only ? 0 : 1), failed, summary };
  } finally { await browser.close(); server.close(); }
}
