// `npm run a64:browser`: Gate 2 and the translator feature tests in headless Chromium (Playwright), translator
// running in a Worker. Serves the page from http://localhost with COOP same-origin + COEP require-corp.
// The full Chromium build (channel "chromium"), not chrome-headless-shell, which crashes on wasm traps here.
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
const dirs = [join(root, "test/guests/out"), join(root, "test/a64/guests/out"), join(root, "test/a64/guests/out_big")].filter(existsSync);
const list: { name: string; dir: number }[] = [];
dirs.forEach((d, i) => readdirSync(d).filter(f => f.endsWith(".json") && f !== "manifest.json").sort().forEach(f => list.push({ name: f.replace(/\.json$/, ""), dir: i })));
const hasBig = list.some(g => g.name.startsWith("a64_big"));

const page = `<!doctype html><meta charset="utf-8"><title>nxweb a64 guests</title><script>
window.run = (msg) => new Promise((resolve) => {
  const w = new Worker("/worker.js"); const results = [];
  w.onmessage = (ev) => { if (ev.data.result) results.push(ev.data.result); else { w.terminate(); resolve({ results, info: ev.data, isolated: self.crossOriginIsolated }); } };
  w.onerror = (e) => resolve({ results, info: { fatal: String(e.message) } });
  w.postMessage(msg);
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
const channel = process.env.A64_BROWSER_CHANNEL ?? "chromium";
const browser = await chromium.launch({ headless: true, ...(channel === "shell" ? {} : { channel }) });
let bad = 0;
try {
  const p = await browser.newPage();
  p.on("pageerror", (e: Error) => console.log("[RED] page error: " + e.message));
  await p.goto(`http://localhost:${port}/`);
  console.log(`browser: Chromium ${browser.version()} (${channel === "shell" ? "chrome-headless-shell" : "channel " + channel + ", headless"}), crossOriginIsolated=${await p.evaluate("self.crossOriginIsolated")}`);
  const small = "^(?!a64_big)";
  const cacheName = "nxweb-a64-" + Date.now();
  const passes: [string, object][] = [
    ["default", { opts: {}, only: small }],
    ["budget 50 (forced preemption)", { opts: { budget: 50 }, only: small }],
    ["no wasm tail calls", { opts: { tailCalls: false }, only: small }],
    ["shared memory (atomic exclusives)", { opts: { shared: true }, only: small }],
    ["translation cache, cold (Cache API)", { opts: {}, only: small, cache: cacheName }],
    ["translation cache, warm", { opts: {}, only: small, cache: cacheName }],
  ];
  if (hasBig) passes.push(["big guest, cache cold", { opts: {}, only: "^a64_big", cache: cacheName }], ["big guest, cache warm", { opts: {}, only: "^a64_big", cache: cacheName }]);
  for (const [title, msg] of passes) {
    const t0 = Date.now();
    const out: { results: Result[]; info: any; isolated: boolean } = await p.evaluate((o: object) => (window as any).run(o), msg);
    console.log(`--- ${title} (wall ${Date.now() - t0} ms) ---`);
    if (out.info?.fatal) { console.log("[RED] worker failed: " + out.info.fatal); bad++; }
    for (const r of out.results) {
      if (speed && title === "default") console.log(speedLine(r));
      else if (!r.ok) console.log(`[RED] FAIL ${r.name}  ${r.why.slice(0, 200)}`);
    }
    const failn = out.results.filter(r => !r.ok).length;
    bad += failn;
    const hits = out.results.reduce((a, r) => a + (r.cacheHits ?? 0), 0);
    console.log(`guests: ${out.results.length - failn} passed, ${failn} failed${"cache" in msg ? `; units from the cache: ${hits}` : ""}`);
    if (out.results.length) console.log(totalLine(out.results).replace("Infinity", "-").replace("NaN", "-"));
  }
  const ex: { info: { extra?: { name: string; ok: boolean; detail: string }[]; fatal?: string } } = await p.evaluate((o: object) => (window as any).run(o), { extra: true });
  console.log("--- translator feature tests (test/a64/extra_tests.ts) ---");
  if (!ex.info.extra) { console.log("[RED] worker failed: " + ex.info.fatal); bad++; }
  for (const r of ex.info.extra ?? []) { console.log(`${r.ok ? "ok  " : "[RED] FAIL"} ${r.name}\n       ${r.detail.split("\n")[0]}`); if (!r.ok) bad++; }
} finally {
  await browser.close();
  server.close();
}
process.exit(bad ? 1 : 0);
