// npm run shaders:latency: the in-page shader translator's latency on a synthetic Maxwell corpus (corpus.py) in headless Chromium.
//   node test/shaders/latency/run.mts [--stages N] [--workers W] [--first K]
// Prints per-stage latency (from the moment all are handed over, as at a game's boot), the total, and the worker's own split when it reports one.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg("--stages", "240")), W = arg("--workers", ""), B = arg("--batch", ""), FIRST = Number(arg("--first", "0")), OUT = join(ROOT, "build/shaders/latency");
if (!existsSync(join(ROOT, "build/shaders/xlate_wasm/_framework/dotnet.js")) || !existsSync(join(ROOT, "build/shaders/nx_naga.wasm"))) {
  console.log("shaders:latency: SKIPPED: build/shaders/xlate_wasm or nx_naga.wasm is not built"); process.exit(0);
}
execFileSync("python3", [join(ROOT, "test/shaders/latency/corpus.py"), OUT, String(N)]);
const esb = join(ROOT, "node_modules/esbuild/bin/esbuild");
execFileSync(esb, ["test/shaders/latency/page.ts", "--bundle", "--format=esm", "--outfile=build/shaders/latency/page.js", "--log-level=warning"], { cwd: ROOT, stdio: "inherit" });
execFileSync(esb, ["src/glue/rt_shader_worker.ts", "--bundle", "--format=esm", "--outfile=build/shaders/latency/shader_worker.js", "--log-level=warning"], { cwd: ROOT, stdio: "inherit" });
const MIME: Record<string, string> = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".dat": "application/octet-stream", ".dll": "application/octet-stream", ".blat": "application/octet-stream", ".code": "application/octet-stream", ".ctl": "application/octet-stream", ".pdb": "application/octet-stream", ".webcil": "application/octet-stream", ".icu": "application/octet-stream" };
const server = createServer((q, res) => {
  const u = (q.url ?? "/").split("?")[0];
  if (u === "/") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(`<script type="module" src="/build/shaders/latency/page.js"></script>`); return; }
  const file = u === "/shader_worker.js" ? join(OUT, "shader_worker.js") : join(ROOT, normalize(decodeURIComponent(u)));
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" }); res.end(readFileSync(file));
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
const url = `http://localhost:${(server.address() as any).port}`;
const req = createRequire(import.meta.url);
let pw: any; for (const p of ["playwright", "/opt/node-tools/node_modules/playwright"]) { try { pw = req(p); break; } catch { /* next */ } }
const browser = await pw.chromium.launch();
let bad = 0;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e: Error) => console.error("page error:", e.message));
  await page.goto(url + "/");
  await page.waitForFunction("window.__ready === true", null, { timeout: 30000 });
  const corpus = JSON.parse(readFileSync(join(OUT, "corpus.json"), "utf8"));
  // --first K: the last K stages handed over are the ones a draw waits on
  const first = corpus.slice(-FIRST || corpus.length).map((r: any) => r.key).slice(0, FIRST);
  const r: any = await page.evaluate(([b, c, o]: any) => (globalThis as any).run(b, c, o), [`${url}/build/shaders/latency`, corpus, { workers: W ? Number(W) : undefined, batch: B ? Number(B) : undefined, first }]);
  const rows = corpus.map((c: any) => ({ ...c, ...r.out[c.key] }));
  bad = rows.filter((x: any) => x.error).length;
  const ms = rows.map((x: any) => x.ms).sort((a: number, b: number) => a - b), q = (p: number) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
  const sum = (f: (t: any) => number) => rows.reduce((s: number, x: any) => s + (x.t ? f(x.t) : 0), 0);
  const firstMs = first.map((k: string) => r.out[k].ms).sort((a: number, b: number) => a - b);
  console.log(`shaders:latency: ${rows.length} stages (${rows.reduce((s: number, x: any) => s + x.insts, 0)} instructions, ${rows.reduce((s: number, x: any) => s + (x.wgsl ?? 0), 0)} bytes of WGSL), ${W || "default"} workers, batch ${B || "default"} (hardwareConcurrency ${r.hw}): ` +
    `total ${r.total.toFixed(0)} ms; per stage: median ${q(0.5).toFixed(0)} ms, p90 ${q(0.9).toFixed(0)} ms, max ${ms[ms.length - 1].toFixed(0)} ms, first ${ms[0].toFixed(0)} ms; ${bad} failed`);
  if (rows.some((x: any) => x.t)) console.log(`  worker split (sums over stages): runtime start waited ${sum(t => t.startMs).toFixed(0)} ms, translator ${sum(t => t.xlateMs).toFixed(0)} ms, pass + naga ${sum(t => t.convertMs).toFixed(0)} ms; ${rows.filter((x: any) => x.t?.batch > 1).length} stages in batches`);
  if (FIRST) console.log(`  the ${FIRST} stages a draw waits on (handed over last): median ${firstMs[firstMs.length >> 1].toFixed(0)} ms, max ${firstMs[firstMs.length - 1].toFixed(0)} ms`);
  for (const x of rows.filter((x: any) => x.error).slice(0, 5)) console.log(`  [RED] ${x.name} ${x.key}: ${x.error}`);
} finally { await browser.close(); server.close(); }
process.exit(bad ? 1 : 0);
