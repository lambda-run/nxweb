// EXPERIMENTAL (spike, SPIKE.md). The same correctness series and speed measurement in headless Chromium (Playwright,
// full Chromium build as test/runtime/browser.mts), on a page with COOP same-origin and COEP require-corp:
//   node test/spike_workers/browser.mts [--runs 200] [--reps 5] [--nobench] [--nocorrect]
// Then the page again WITHOUT those headers, to record what a browser without cross-origin isolation allows.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { build, ROOT, OUT } from "../../src/spike_workers/build.mts";

const arg = (n: string, d: number) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const RUNS = arg("--runs", 200), REPS = arg("--reps", 5), FEW = arg("--few", 20);
if (!process.argv.includes("--nobuild")) build();
const { chromium } = createRequire(import.meta.url)("playwright");
const page = `<!doctype html><meta charset="utf-8"><title>nxweb spike: guest cores on Workers</title><script src="/page.js"></script>`;
const TYPES: Record<string, string> = { ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".bin": "application/octet-stream" };
function serve(isolated: boolean): Promise<{ port: number; close(): void }> {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const head: Record<string, string> = { "Cache-Control": "no-store", ...(isolated ? { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } : {}) };
    const send = (body: Buffer | string, type: string) => { res.writeHead(200, { ...head, "Content-Type": type }); res.end(body); };
    try {
      let m: RegExpExecArray | null;
      if (url === "/") return send(page, "text/html");
      if (url === "/page.js" || url === "/worker.js") return send(readFileSync(join(OUT, "web", url.slice(1))), "text/javascript");
      if ((m = /^\/wasm\/rt\/(\w+\.wasm)$/.exec(url))) return send(readFileSync(join(ROOT, "build", "runtime", m[1])), "application/wasm");
      if ((m = /^\/wasm\/([\w.]+\.wasm)$/.exec(url))) return send(readFileSync(join(OUT, m[1])), "application/wasm");
      if ((m = /^\/guest\/(\w+\.(bin|json))$/.exec(url))) return send(readFileSync(join(OUT, "guests", m[1])), TYPES["." + m[2]]);
    } catch { /* 404 */ }
    res.writeHead(404, head); res.end("not found");
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r({ port: (server.address() as any).port, close: () => server.close() })));
}

const browser = await chromium.launch({ headless: true, channel: "chromium" });
let failed = 0;
try {
  const srv = await serve(true);
  const p = await browser.newPage();
  p.on("pageerror", (e: Error) => { console.log("[RED] page error: " + e.message); failed++; });
  await p.goto(`http://localhost:${srv.port}/`);
  const info = await p.evaluate(() => (window as any).spike.info());
  console.log(`browser: Chromium ${browser.version()} (channel chromium, headless), crossOriginIsolated=${info.isolated}, navigator.hardwareConcurrency=${info.cores}`);
  console.log(`machine: ${os.cpus().length} logical CPUs (${os.cpus()[0].model}); load average ${os.loadavg().map(x => x.toFixed(2)).join(" ")}; other jobs may be running`);
  const one = async (g: string, c: unknown, runs: number, opts: unknown = {}, note = "") => {
    const r = await p.evaluate(([g, c, runs, opts, note]: any[]) => (window as any).spike.series(g, c, runs, opts, note), [g, c, runs, opts, note]);
    console.log(r.line); if (!r.ok) failed++;
  };
  if (!process.argv.includes("--nocorrect")) {
    for (const g of ["threads", "stress"]) {
      await one(g, "unshared", FEW); await one(g, "shared-green", FEW); await one(g, 1, FEW); await one(g, 3, FEW);
      await one(g, 2, RUNS); await one(g, 4, RUNS);
      await one(g, 4, FEW, { transport: "message" }, "(units by message)");
    }
    await one("dekker", 4, FEW);
    console.log("\ndemonstrations (differences are the point):");
    for (const l of await p.evaluate((n: number) => (window as any).spike.demos(n), FEW)) console.log(l);
  }
  const tc = await p.evaluate(() => (window as any).spike.tablecost());
  console.log(`instantiating a 44-byte module that imports a function table, ms per instance by table length: ${Object.entries(tc).map(([n, ms]) => `${n}: ${(ms as number).toFixed(3)}`).join(", ")}`);
  if (!process.argv.includes("--nobench")) {
    console.log(`\nspeed: ${REPS} interleaved repetitions; wall time of the run phase, ms`);
    const configs = ["unshared", "shared-green", 1, 2, 3, 4];
    const label = (c: unknown) => c === "unshared" ? "green unshared (today)" : c === "shared-green" ? "green shared" : `${c} Worker${c === 1 ? "" : "s"}`;
    const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
    for (const name of ["bench_sha", "bench_lz", "bench_contend", "bench_svc", "bench_sha_1t", "bench_lz_1t"]) {
      const cs = name.endsWith("_1t") ? configs.slice(0, 3) : configs;
      const walls = new Map<unknown, number[]>(cs.map(c => [c, []])), last = new Map<unknown, any>();
      let ref = "", bad = "";
      for (let r = 0; r < REPS; r++) for (const c of cs) {
        const b = await p.evaluate(([g, c]: any[]) => (window as any).spike.bench(g, c, {}), [name, c]);
        if (b.fault) bad = `${label(c)}: ${b.fault}`;
        if (!ref) ref = b.out; else if (b.out !== ref) bad = `${label(c)}: output differs`;
        walls.get(c)!.push(b.wall); last.set(c, b);
      }
      console.log(`### ${name}\n${ref.trim()}${bad ? "\n[RED] " + bad : ""}`);
      if (bad) failed++;
      const base = walls.get("unshared")!;
      console.log("| configuration | min ms | median ms | speedup vs today (min) | (median) | last run |\n|---|---|---|---|---|---|");
      for (const c of cs) {
        const w = walls.get(c)!, b = last.get(c);
        console.log(`| ${label(c)} | ${Math.min(...w).toFixed(0)} | ${med(w).toFixed(0)} | ${(Math.min(...base) / Math.min(...w)).toFixed(2)}x | ${(med(base) / med(w)).toFixed(2)}x | SVCs ${b.svcs}, unwinds ${b.unwinds}, in-place resumes ${b.inplace}, translate+compile ${b.compile.toFixed(0)} ms, instantiate ${b.instantiate.toFixed(0)} ms |`);
      }
      console.log("");
    }
  }
  srv.close();
  // ---- without cross-origin isolation ----
  const plain = await serve(false);
  const q = await browser.newPage();
  await q.goto(`http://localhost:${plain.port}/`);
  const ns = await q.evaluate(() => (window as any).spike.nosab());
  console.log(`\nthe same page without COOP/COEP: ${Object.entries(ns).map(([k, v]) => `${k}: ${v}`).join("; ")}`);
  plain.close();
  // ---- V8's native module cache, with eager compilation so that the constructor's time is the compile time ----
  const eager = await chromium.launch({ headless: true, channel: "chromium", args: ["--js-flags=--no-wasm-lazy-compilation"] });
  try {
    const srv2 = await serve(true), e = await eager.newPage();
    await e.goto(`http://localhost:${srv2.port}/`);
    for (const name of ["rt/gfx.wasm", "rt/hle.wasm"]) {
      const mc = await e.evaluate((n: string) => (window as any).spike.modcache(n), name);
      console.log(`Chromium with --no-wasm-lazy-compilation: new WebAssembly.Module of ${name} (${mc.bytes} B): first ${mc.first.toFixed(2)} ms, the same bytes again ${mc.again.toFixed(2)} ms; other bytes ${mc.other.toFixed(2)} ms, again ${mc.otherAgain.toFixed(2)} ms`);
    }
    srv2.close();
  } finally { await eager.close(); }
} finally { await browser.close(); }
console.log(failed ? `\n[RED] spike_workers browser: ${failed} failed` : "\nspike_workers browser: every series passed");
process.exit(failed ? 1 : 0);
