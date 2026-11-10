// npm run rt:browser [-- <filter>]: the cases of cases.ts in headless Chromium (Playwright), inside a Worker.
// The page is served from http://localhost with COOP same-origin and COEP require-corp.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { ROOT, OUT, GUESTS, MODULES, build, buildModules, corpusList } from "./harness.mts";
import { formatResult, type CaseResult } from "./cases.ts";

process.chdir(ROOT);
try {
  build(); buildModules();
  buildSync({ entryPoints: ["test/runtime/web/worker.ts"], bundle: true, format: "iife", outfile: "build/runtime/web/worker.js", logLevel: "warning", absWorkingDir: ROOT });
} catch (e) { console.error(e instanceof Error ? e.message : e); console.error("[RED] rt:browser: the build failed"); process.exit(1); }

const { chromium } = createRequire(import.meta.url)("playwright");
const only = process.argv[2];
const page = `<!doctype html><meta charset="utf-8"><title>nxweb runtime tests</title><script>
window.results = []; window.finished = null;
window.start = (only) => { const w = new Worker("/worker.js");
  w.onmessage = (ev) => { if (ev.data.result) window.results.push(ev.data.result); else window.finished = ev.data; };
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
    if (url === "/list") return send(JSON.stringify({ nso: Object.keys(MODULES), corpus: corpusList() }), "application/json");
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
const browser = await chromium.launch({ headless: true, ...(channel === "shell" ? {} : { channel }), args: process.env.RT_BROWSER_LOG ? ["--enable-logging=stderr", "--v=0"] : [] });
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
      if (got.finished.fatal) { console.log("[RED] worker failed: " + got.finished.fatal); failed++; }
      else console.log(`worker: crossOriginIsolated=${got.finished.isolated}, SharedArrayBuffer available=${got.finished.sab}`);
      break;
    }
    await new Promise(r => setTimeout(r, 200));
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`\nrt:browser (Chromium ${browser.version()}): ${ran} tests, ${failed} failed`);
process.exit(failed ? 1 : 0);
