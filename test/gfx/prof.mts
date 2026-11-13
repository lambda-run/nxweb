// node test/gfx/prof.mts <capture file> [--frame k] [--n 30] [--spin 20000] [--interval 100] [--nowrap] [--notex] [--texmax 256] [--out <json>] [--auto]      (test/gfx/REPLAY.md, "Profiling")
// The replayer's CPU profile on a stream capture, in headless Chromium: serves build/web as `npm run web` does, opens gfxprof.html (web/gfxprof.ts) with
// manual=1 and drives its phases: the timings of frame k executed n times, time per record type, count / ms / bytes per WebGPU method, and CDP's
// sampling profiler (every --interval microseconds) over --spin ms of that frame executed again and again, the WebGPU methods behind named wrappers
// (--nowrap: without them). Prints the tables and writes everything as JSON (default <capture>.prof.json). On SwiftShader the GPU side means nothing:
// what is measured is the JavaScript. --auto: the page runs by itself as in a browser with a real GPU (its own sampler, the result POSTed) and its text is printed.
import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const flag = (name: string) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const frame = opt("--frame"), n = +(opt("--n") ?? 30), spin = +(opt("--spin") ?? 20000), interval = +(opt("--interval") ?? 100), outFile = opt("--out"), nowrap = flag("--nowrap"), auto = flag("--auto"), notex = flag("--notex"), texmax = opt("--texmax"), pageName = opt("--page") ?? "gfxprof.html", file = args[0];
if (!file || !existsSync(file)) { console.error("usage: node test/gfx/prof.mts <capture file> [--frame k] [--n 30] [--spin ms] [--interval us] [--nowrap] [--notex] [--out <json>]"); process.exit(1); }
process.env.NX_REPORTS = dirname(resolve(file));
const { buildGfxProf } = await import("../../web/build.mts"), { serve } = await import("../../web/serve.mts");
if (pageName === "gfxprof.html") buildGfxProf();      // --page <other>.html: a page built by hand (another build of the replayer to compare with), served from build/web as it is
const { server, url } = await serve(0);
const req = createRequire(import.meta.url);
let pw: any;
for (const p of ["playwright", "/opt/node-tools/node_modules/playwright"]) { try { pw = req(p); break; } catch { /* next */ } }
if (!pw) { console.error("playwright is not installed"); process.exit(1); }
const browser = await pw.chromium.launch({ args: (process.env.GPU_FLAGS ?? "--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=swiftshader --use-vulkan=swiftshader").split(" ") });
let code = 0;
// CDP's profile: self and total time per function
function tables(profile: any, top: number) {
  const byId = new Map<number, any>(), parent = new Map<number, number>();
  for (const nd of profile.nodes) { byId.set(nd.id, nd); for (const c of nd.children ?? []) parent.set(c, nd.id); }
  const label = (nd: any) => `${nd.callFrame.functionName || "(anonymous)"}${nd.callFrame.url ? ` ${nd.callFrame.url.split("/").pop()}:${nd.callFrame.lineNumber + 1}` : ""}`;
  const self = new Map<string, number>(), total = new Map<string, number>();
  let all = 0;
  profile.samples.forEach((id: number, i: number) => {
    const dt = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000, l = label(byId.get(id));
    all += dt; self.set(l, (self.get(l) ?? 0) + dt);
    const seen = new Set<string>();
    for (let k: number | undefined = id; k !== undefined; k = parent.get(k)) { const f = label(byId.get(k)); if (!seen.has(f)) { seen.add(f); total.set(f, (total.get(f) ?? 0) + dt); } }
  });
  const tab = (m: Map<string, number>) => [...m].filter(e => e[0] !== "(root)").sort((a, b) => b[1] - a[1]).slice(0, top).map(([fn, ms]) => ({ fn, ms: +ms.toFixed(1), pct: +(100 * ms / Math.max(1e-9, all)).toFixed(1) }));
  return { samples: profile.samples.length, ms: +all.toFixed(1), self: tab(self), total: tab(total) };
}
try {
  const page = await browser.newPage(), errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(String(e)));
  if (auto) {      // the page by itself, as a browser with a real GPU runs it (the Self-Profiling API's samples, the result POSTed to the receiver): its text
    await page.goto(`${url}${pageName}?cap=${encodeURIComponent(basename(file))}&n=${n}&prof=${spin}${frame !== undefined ? `&frame=${frame}` : ""}${notex ? "&notex=1" : ""}${texmax ? `&texmax=${texmax}` : ""}${nowrap ? "&wrap=0" : ""}`);
    const r: any = await page.evaluate("window.__result");
    console.log(await page.evaluate("document.getElementById('out').textContent"));
    if (r.fatal || errors.length) throw new Error(`the profile page failed: ${r.fatal ?? ""}\n${errors.join("\n")}`);
    throw null;
  }
  const cdp = await page.context().newCDPSession(page);
  await page.goto(`${url}${pageName}?cap=${encodeURIComponent(basename(file))}&manual=1&to=http://127.0.0.1:9${frame !== undefined ? `&frame=${frame}` : ""}${notex ? "&notex=1" : ""}${texmax ? `&texmax=${texmax}` : ""}`);
  for (;;) {
    const s = await page.evaluate("Promise.race([window.__result, new Promise(r => setTimeout(() => r(window.__gfxprofReady ? 'ready' : 'wait'), 2000))])");
    if (s === "ready") break;
    if (s !== "wait") throw new Error(`the profile page failed: ${s?.fatal ?? JSON.stringify(s)}\n${errors.join("\n")}`);
  }
  const ev = (js: string) => page.evaluate(js);
  await ev(`window.__gfxprof.plain(${n})`);
  await ev(`window.__gfxprof.records(${Math.min(n, 10)})`);
  await ev(`window.__gfxprof.methods(${Math.min(n, 10)})`);
  let cpu: any = null, spun: any = null;
  if (spin > 0) {
    await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval });
    await cdp.send("Profiler.start");
    spun = await ev(`window.__gfxprof.spin(${spin}, ${!nowrap})`);
    cpu = tables((await cdp.send("Profiler.stop")).profile, 40);
  }
  await ev("window.__gfxprof.finish()");
  const r: any = await ev("window.__result");
  const out = { ...r, cpuProfile: cpu ? { intervalUs: interval, wrapped: !nowrap, ...spun, ...cpu } : null, pageErrors: errors };
  writeFileSync(outFile ?? file + ".prof.json", JSON.stringify(out, null, 1));
  const pad = (v: unknown, w: number) => String(v).padStart(w);
  console.log(`${basename(file)} frame ${r.frame} on ${r.adapter}: ${r.batches} batches, ${r.records} records; loaded in ${r.loadMs} ms`);
  console.log(`  ${r.ledger}`);
  console.log(`exec ms per frame (CPU until submit): ${JSON.stringify(r.execMs)}`);
  console.log(`until the GPU is done: ${JSON.stringify(r.doneMs)}`);
  console.log(`replayer counters per frame: ${JSON.stringify(r.stats)}`);
  console.log(`-- per record type (${r.records_.msPerFrame} ms per frame in all, each record its own exec call) --`);
  for (const [k, v] of Object.entries<any>(r.records_.byType).slice(0, 22)) console.log(`  ${k.padEnd(16)} ${pad(v.perFrame, 8)} x ${pad(v.usEach, 9)} us = ${pad(v.msPerFrame, 8)} ms`);
  console.log(`-- WebGPU methods per frame (exec ${r.methods.execMsPerFrame} ms, ${r.methods.inWebGpuMsPerFrame} ms inside WebGPU calls incl. those outside exec) --`);
  for (const [k, v] of Object.entries<any>(r.methods.byMethod).slice(0, 40)) console.log(`  ${k.padEnd(42)} ${pad(v.perFrame, 8)} x ${pad(v.msPerFrame, 9)} ms${v.bytesPerFrame ? `  ${(v.bytesPerFrame / 1024).toFixed(0)} KB` : ""}`);
  if (cpu) {
    console.log(`-- CPU profile: ${cpu.samples} samples every ${interval} us over ${spun.frames} frames (${spun.execMs} ms inside exec of ${spun.wallMs} ms) --`);
    console.log(`   self time (ms per frame, % of all samples):`);
    for (const e of cpu.self.slice(0, 25)) console.log(`  ${pad((e.ms / spun.frames).toFixed(2), 8)} ${pad(e.pct, 5)}%  ${e.fn}`);
    console.log(`   total time:`);
    for (const e of cpu.total.slice(0, 25)) console.log(`  ${pad((e.ms / spun.frames).toFixed(2), 8)} ${pad(e.pct, 5)}%  ${e.fn}`);
  }
  if (r.deviceLost) console.log("[RED] the WebGPU device was LOST during the run: the timings after that moment mean nothing");
  console.log(`${r.redDistinct} distinct red lines; written to ${outFile ?? file + ".prof.json"}`);
} catch (e) { if (e !== null) { console.error(e instanceof Error ? e.message : e); code = 1; } }
finally { await browser.close(); server.close(); }
process.exit(code);
