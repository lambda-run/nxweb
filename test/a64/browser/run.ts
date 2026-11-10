// `npm run a64:browser`: Gate 2 in headless Chromium (Playwright), translator running in a Worker.
// Serves the page from http://localhost with COOP same-origin + COEP require-corp.
import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { speedLine, totalLine, type Result } from "../guest_core.ts";

const root = new URL("../../../", import.meta.url).pathname;
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const argv = process.argv.slice(2);
const speed = argv.includes("--speed");
const dirs = [join(root, "test/guests/out"), join(root, "test/a64/guests/out")].filter(existsSync);
const list: { name: string; dir: number }[] = [];
dirs.forEach((d, i) => readdirSync(d).filter(f => f.endsWith(".json") && f !== "manifest.json").sort().forEach(f => list.push({ name: f.replace(/\.json$/, ""), dir: i })));

const page = `<!doctype html><meta charset="utf-8"><title>nxweb a64 guests</title><script>
window.run = (opts) => new Promise((resolve) => {
  const w = new Worker("/worker.js"); const results = [];
  w.onmessage = (ev) => { if (ev.data.result) results.push(ev.data.result); else resolve({ results, info: ev.data, isolated: self.crossOriginIsolated }); };
  w.onerror = (e) => resolve({ results, info: { fatal: String(e.message) } });
  w.postMessage({ opts });
});
</script>`;
const server = createServer((req, res) => {
  const url = req.url ?? "/";
  const head: Record<string, string> = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
  const send = (body: Buffer | string, type: string) => { res.writeHead(200, { ...head, "Content-Type": type }); res.end(body); };
  try {
    if (url === "/") return send(page, "text/html");
    if (url === "/worker.js") return send(readFileSync(join(root, "build/a64/browser/worker.js")), "text/javascript");
    if (url === "/list") return send(JSON.stringify(list), "application/json");
    if (url.startsWith("/build/")) return send(readFileSync(join(root, "build/a64", url.slice(7).replace(/[^\w.]/g, ""))), "application/wasm");
    const m = /^\/g\/(\d+)\/([\w.]+)$/.exec(url);
    if (m && dirs[Number(m[1])]) return send(readFileSync(join(dirs[Number(m[1])], m[2])), "application/octet-stream");
  } catch { /* fall through */ }
  res.writeHead(404, head); res.end("not found");
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port;
const browser = await chromium.launch({ headless: true });
let bad = 0;
try {
  const p = await browser.newPage();
  p.on("pageerror", (e: Error) => console.log("[RED] page error: " + e.message));
  await p.goto(`http://localhost:${port}/`);
  console.log("browser: " + browser.version() + ", userAgent: " + await p.evaluate("navigator.userAgent"));
  for (const opts of [{}, { budget: 50 }, { tailCalls: false }]) {
    const t0 = Date.now();
    const out: { results: Result[]; info: any; isolated: boolean } = await p.evaluate((o: object) => (window as any).run(o), opts);
    console.log(`--- options ${JSON.stringify(opts)} (crossOriginIsolated=${out.isolated}, wall ${Date.now() - t0} ms) ---`);
    if (out.info?.fatal) { console.log("[RED] worker failed: " + out.info.fatal); bad++; }
    for (const r of out.results) {
      if (speed && !("budget" in opts) && !("tailCalls" in opts)) console.log(speedLine(r));
      else if (!r.ok) console.log(`[RED] FAIL ${r.name}  ${r.why.slice(0, 200)}`);
    }
    const failn = out.results.filter(r => !r.ok).length;
    bad += failn;
    console.log(`guests: ${out.results.length - failn} passed, ${failn} failed (of ${list.length})`);
    if (out.results.length) console.log(totalLine(out.results));
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(bad ? 1 : 0);
