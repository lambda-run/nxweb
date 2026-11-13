// The replayer's profile page (build/web/gfxprof.html, test/gfx/REPLAY.md "Profiling"): replays a stream capture on this browser's WebGPU device up to
// frame k, then executes that frame again and again and measures the replayer (src/glue/gfx_host.ts) alone: no game, no recorder.
//
//   gfxprof.html?cap=area.gfxcap[&frame=2][&n=30][&prof=20000][&to=http://localhost:8082][&name=gfxprof-area.json][&notex=1][&wrap=0][&manual=1]
//
//   cap     the capture's file name in the reports directory (web/serve.mts serves it in ranges as /__cap/<name>)
//   frame   which presented frame to repeat (default: the capture's last)
//   n       how many times it is executed for the timings (default 30)
//   prof    ms of wall time the sampled profile runs for (default 20000; 0: none). The JS Self-Profiling API (the page is served with
//           `Document-Policy: js-profiling`); Chrome samples every 10 ms at best, so the time is what buys samples
//   to      where the result goes: POST <to>/<name> (vm/ctl/recv.mjs); when that fails, POST /__report/<name> of this server
//   notex   the textures that were live before the capture are not filled (blank): a quicker load, the same CPU work
//   texmax  those textures are made without the levels that have a side over this many texels (ReplayOptions.texMax): for a device with little memory
//           (SwiftShader in the VM loses the device on the area capture's 1 GB of textures)
//   wrap    0: the sampled profile runs without the counting wrappers around WebGPU's methods (with them, the time inside a WebGPU call shows as
//           the self time of `gpu_<Interface>_<method>`, apart from the replayer function that called it)
//   manual  the page waits for a driver (test/gfx/prof.mts: CDP's profiler around the phases) instead of running the phases itself
//
// The result (JSON, also shown as text): ms per frame inside GfxHost.exec (the CPU side up to the submit) and until the GPU has finished it, the
// replayer's own counters per frame, time and count per record type, count / ms / bytes per WebGPU method, the profile's top functions.
import { GfxHost } from "../src/glue/gfx_host.ts";
import { replayCapture, type CaptureIndex } from "../src/glue/gfx_stream_capture.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const OP: Record<number, string> = { 1: "TEX_CREATE", 2: "TEX_DESTROY", 3: "BEGIN_PASS", 4: "END_PASS", 5: "VIEWPORT", 6: "SCISSOR", 7: "PIPELINE_CREATE", 8: "PIPELINE", 9: "VBUF", 10: "UBO", 11: "TEX", 12: "BLEND_COLOR",
  13: "STENCIL_REF", 14: "DRAW", 15: "DRAW_IDX", 16: "CLEAR_RECT", 17: "COPY_B2T", 18: "COPY_T2T", 19: "SNAPSHOT", 20: "PRESENT", 21: "FENCE", 22: "FLUSH", 23: "MEM_DIRTY", 24: "TEX_DATA", 25: "COPY_T2B", 26: "FIXUP",
  27: "UBO_DATA", 28: "SSBO", 29: "IMG", 30: "BEGIN_COMPUTE", 31: "DISPATCH", 32: "BUF_READBACK", 33: "REPORT", 34: "REPORT_COMMIT", 35: "MESH_BEGIN", 36: "MESH_TASK", 37: "MESH_RUN", 38: "MESH_DRAW", 39: "CLEAR_TEX",
  40: "DISPATCH_SKIPPED", 41: "SKIP" };
const q = new URLSearchParams(location.search), G = globalThis as any;
const num = (k: string, d: number) => { const v = q.get(k); return v === null || v === "" || !isFinite(+v) ? d : +v; };
const say = (l: string) => { const pre = document.getElementById("out"); if (pre) pre.textContent += l + "\n"; console.log(`gfxprof: ${l}`); };
const round = (v: number, d = 3) => +v.toFixed(d);
function summary(a: number[]) { const s = a.slice().sort((x, y) => x - y), n = s.length; return n ? { n, min: round(s[0]), median: round(s[n >> 1]), mean: round(s.reduce((x, y) => x + y, 0) / n), p90: round(s[Math.min(n - 1, Math.floor(n * 0.9))]), max: round(s[n - 1]) } : { n: 0 }; }

// ---- the wrappers around WebGPU's methods: "count" (the sampled profile: a named frame per method) and "time" (ms and bytes per method) ----
interface MCount { count: number; ms: number; bytes: number }
const IFACES = ["GPUDevice", "GPUQueue", "GPUCommandEncoder", "GPURenderPassEncoder", "GPUComputePassEncoder", "GPUTexture", "GPUBuffer", "GPURenderPipeline", "GPUComputePipeline"];
let unwrap: (() => void)[] = [];
async function wrapGpu(mode: "count" | "time", counts: Map<string, MCount>) {
  // Each wrapper is a function with a name of its own in a script with a URL (a module made here and imported from a blob): that is what a sampling
  // profiler names, and the Self-Profiling API leaves out functions of scripts without a URL
  const found: { proto: any; name: string; d: PropertyDescriptor; key: string; fname: string }[] = [];
  let src = "export const make = {\n";
  for (const iface of IFACES) {
    const proto = G[iface]?.prototype;
    if (!proto) continue;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, name)!;
      if (name === "constructor" || typeof d.value !== "function") continue;
      const fname = `gpu_${iface.slice(3)}_${name}`;
      const bytes = name === "writeBuffer" ? "c.bytes += a[4] !== undefined ? a[4] * (a[2].BYTES_PER_ELEMENT || 1) : a[2].byteLength - (a[3] || 0) * (a[2].BYTES_PER_ELEMENT || 1);"
        : name === "writeTexture" ? "c.bytes += a[1].byteLength - ((a[2] && a[2].offset) || 0);" : name === "copyBufferToBuffer" ? "c.bytes += a.length >= 5 ? a[4] : (a[2] || 0);" : "";
      src += mode === "count" ? `  ${fname}(orig, c) { return function ${fname}(...a) { c.count++; ${bytes} return orig.apply(this, a); }; },\n`
        : `  ${fname}(orig, c) { return function ${fname}(...a) { c.count++; ${bytes} const t = performance.now(); try { return orig.apply(this, a); } finally { c.ms += performance.now() - t; } }; },\n`;
      found.push({ proto, name, d, key: `${iface.slice(3)}.${name}`, fname });
    }
  }
  const blob = URL.createObjectURL(new Blob([src + "};\n//# sourceURL=gfxprof_wrappers.js\n"], { type: "text/javascript" }));
  const { make } = await import(blob);
  URL.revokeObjectURL(blob);
  for (const f of found) {
    const c: MCount = { count: 0, ms: 0, bytes: 0 };
    counts.set(f.key, c);
    Object.defineProperty(f.proto, f.name, { ...f.d, value: make[f.fname](f.d.value, c) });
    unwrap.push(() => Object.defineProperty(f.proto, f.name, f.d));
  }
}
function unwrapGpu() { for (const u of unwrap) u(); unwrap = []; }
function methodTable(counts: Map<string, MCount>, frames: number) {
  const o: Record<string, { perFrame: number; msPerFrame: number; bytesPerFrame: number }> = {};
  for (const [k, c] of [...counts].sort((a, b) => b[1].ms - a[1].ms || b[1].count - a[1].count)) if (c.count) o[k] = { perFrame: round(c.count / frames, 1), msPerFrame: round(c.ms / frames), bytesPerFrame: Math.round(c.bytes / frames) };
  return o;
}

// ---- the JS Self-Profiling API's trace: self and total time per function ----
function traceTables(trace: any, top = 40) {
  const frames = trace.frames ?? [], stacks = trace.stacks ?? [], samples = trace.samples ?? [], res = trace.resources ?? [];
  const label = (f: any) => `${f.name || "(anonymous)"}${f.resourceId !== undefined ? ` ${String(res[f.resourceId]).split("/").pop()}:${f.line ?? "?"}` : ""}`;
  const self = new Map<string, number>(), total = new Map<string, number>();
  let all = 0, js = 0;
  for (let i = 0; i + 1 < samples.length; i++) {
    const dt = samples[i + 1].timestamp - samples[i].timestamp, sid = samples[i].stackId;
    all += dt;
    if (sid === undefined) continue;
    js += dt;
    const seen = new Set<string>();
    for (let s = sid, first = true; s !== undefined; s = stacks[s].parentId, first = false) {
      const l = label(frames[stacks[s].frameId]);
      if (first) self.set(l, (self.get(l) ?? 0) + dt);
      if (!seen.has(l)) { seen.add(l); total.set(l, (total.get(l) ?? 0) + dt); }
    }
  }
  const tab = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, top).map(([fn, ms]) => ({ fn, ms: round(ms, 1), pct: round(100 * ms / Math.max(1e-9, js), 1) }));
  return { samples: samples.length, ms: round(all, 1), jsMs: round(js, 1), intervalMs: samples.length > 1 ? round(all / (samples.length - 1), 2) : 0, self: tab(self), total: tab(total) };
}

async function main() {
  const cap = (q.get("cap") ?? "area.gfxcap").replace(/[^A-Za-z0-9._-]/g, ""), N = Math.max(1, num("n", 30)), profMs = num("prof", 20000), manual = q.get("manual") === "1", wrap = q.get("wrap") !== "0";
  const to = (q.get("to") ?? "http://localhost:8082").replace(/\/+$/, ""), name = (q.get("name") ?? `gfxprof-${cap.replace(/\.gfxcap$/, "")}.json`).replace(/[^A-Za-z0-9._-]/g, "");
  const gpu = (navigator as any).gpu;
  if (!gpu) throw new Error("navigator.gpu is missing");
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice(GfxHost.deviceDescriptor(adapter));
  const adapterName = adapter.info ? `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}`.trim() : "";
  say(`adapter: ${adapterName}; cross-origin isolated: ${G.crossOriginIsolated}`);
  const t0 = performance.now();
  const index: CaptureIndex = await (await fetch(`/__cap/${cap}?index`)).json();
  const nFrames = index.chunks.filter(c => c.h.type === "frame").length, frame = Math.min(nFrames - 1, Math.max(0, num("frame", nFrames - 1)));
  say(`${cap}: ${(index.size / 1048576).toFixed(1)} MB, ${nFrames} frames, ${index.chunks.length} chunks; repeating frame ${frame} x${N}`);
  let fetched = 0, lastSay = 0;
  const notex = q.get("notex") === "1";
  if (notex) for (const c of index.chunks) if (c.h.type === "tex") delete c.h.content;      // described, not filled
  const payload = async (i: number) => {
    const c = index.chunks[i];
    if (!c.len || (notex && c.h.type === "tex") || c.h.type === "frame") return new Uint8Array(0);
    const b = new Uint8Array(await (await fetch(`/__cap/${cap}`, { headers: { Range: `bytes=${c.off}-${c.off + c.len - 1}` } })).arrayBuffer());
    fetched += b.length;
    if (performance.now() - lastSay > 2000) { lastSay = performance.now(); say(`  … chunk ${i} of ${index.chunks.length}, ${(fetched / 1048576).toFixed(0)} MB fetched`); }
    return b;
  };
  for (const c of index.chunks) if (c.h.type === "frame") { c.h.width = 0; c.h.why = "profile"; }      // the live images are not needed
  const result: any = { capture: cap, frame, n: N, adapter: adapterName, userAgent: navigator.userAgent, isolated: !!G.crossOriginIsolated, notex, when: new Date().toISOString() };
  let host: any;
  const run = async (r: { host: any; batches: number; records: number; once(hook?: (op: number, ms: number) => void): number; settle(): Promise<void> }) => {
    host = r.host;
    result.loadMs = Math.round(performance.now() - t0); result.batches = r.batches; result.records = r.records; result.ledger = host.ledger.lastLine ?? "";
    say(`frame ${frame} reached after ${result.loadMs} ms: ${r.batches} batches, ${r.records} records\n  ${result.ledger}`);
    if (host.lost) throw new Error("the WebGPU device was lost while the capture was replayed up to the frame (out of memory?): nothing to measure; try &texmax=256 or &notex=1");
    const statsOf = () => ({ ...host.stats }), delta = (a: any, b: any) => { const o: any = {}; for (const k of Object.keys(b)) if (b[k] !== a[k]) o[k] = b[k] - a[k]; return o; };
    const phases = {
      // the timings: nothing wrapped, nothing sampled
      async plain(n: number) {
        for (let i = 0; i < 3; i++) { r.once(); await r.settle(); }
        const exec: number[] = [], done: number[] = [];
        let st: any = {};
        for (let i = 0; i < n; i++) { const s0 = statsOf(), ms = r.once(), t = performance.now(); await r.settle(); exec.push(ms); done.push(ms + performance.now() - t); st = delta(s0, statsOf()); }
        result.execMs = summary(exec); result.doneMs = summary(done); result.execMsAll = exec.map(v => round(v, 2)); result.stats = st; result.ledger = host.ledger.lastLine ?? result.ledger;
        say(`exec (CPU until submit) ms per frame: ${JSON.stringify(result.execMs)}\nuntil the GPU is done:            ${JSON.stringify(result.doneMs)}\nper frame: ${JSON.stringify(st)}`);
        return result.execMs;
      },
      // time and count per record type (each record executed by its own exec call)
      async records(n: number) {
        const by = new Map<number, { count: number; ms: number }>();
        let total = 0;
        for (let i = 0; i < n; i++) { total += r.once((op, ms) => { let e = by.get(op); if (!e) by.set(op, e = { count: 0, ms: 0 }); e.count++; e.ms += ms; }); await r.settle(); }
        const o: Record<string, { perFrame: number; msPerFrame: number; usEach: number }> = {};
        for (const [op, e] of [...by].sort((a, b) => b[1].ms - a[1].ms)) o[OP[op] ?? `op${op}`] = { perFrame: round(e.count / n, 1), msPerFrame: round(e.ms / n), usEach: round(1000 * e.ms / e.count, 2) };
        result.records_ = { msPerFrame: round(total / n), byType: o };
        say(`per record type (ms per frame; ${round(total / n)} in all, each record its own exec call):\n` + Object.entries(o).slice(0, 16).map(([k, v]) => `  ${k.padEnd(16)} ${String(v.perFrame).padStart(8)} x ${String(v.usEach).padStart(8)} us = ${String(v.msPerFrame).padStart(8)} ms`).join("\n"));
        return result.records_;
      },
      // count, ms and bytes per WebGPU method
      async methods(n: number) {
        const counts = new Map<string, MCount>();
        await wrapGpu("time", counts);
        // (the hash of a guest range, by which an upload is found unchanged: the recorder's export in the game, the replay's own loop here)
        const hash: MCount = { count: 0, ms: 0, bytes: 0 }, x = host.x, origHash = x.gfx_hash;
        counts.set("(recorder) gfx_hash", hash);
        x.gfx_hash = (a: number, len: number) => { hash.count++; hash.bytes += len; const t = performance.now(); try { return origHash(a, len); } finally { hash.ms += performance.now() - t; } };
        let total = 0;
        try { for (let i = 0; i < n; i++) { total += r.once(); await r.settle(); } } finally { unwrapGpu(); x.gfx_hash = origHash; }
        const tab = methodTable(counts, n), inGpu = Object.entries(tab).reduce((s, [k, v]) => s + (k.startsWith("(") ? 0 : v.msPerFrame), 0);
        result.methods = { execMsPerFrame: round(total / n), inWebGpuMsPerFrame: round(inGpu), byMethod: tab };
        say(`WebGPU methods per frame (exec ${round(total / n)} ms, of it ${round(inGpu)} ms inside WebGPU calls, settle's included):\n` + Object.entries(tab).slice(0, 24).map(([k, v]) => `  ${k.padEnd(40)} ${String(v.perFrame).padStart(8)} x  ${String(v.msPerFrame).padStart(8)} ms${v.bytesPerFrame ? `  ${v.bytesPerFrame} bytes` : ""}`).join("\n"));
        return result.methods;
      },
      // frames for a sampling profiler to look at (CDP's, or the Self-Profiling API below): for `ms` of wall time
      async spin(ms: number, wrapped: boolean) {
        const counts = new Map<string, MCount>();
        if (wrapped) await wrapGpu("count", counts);
        const t = performance.now(); let frames = 0, exec = 0;
        try { while (performance.now() - t < ms) { exec += r.once(); frames++; await r.settle(); } } finally { unwrapGpu(); }
        return { frames, execMs: round(exec), wallMs: round(performance.now() - t) };
      },
      async selfProfile(ms: number, wrapped: boolean) {
        if (!G.Profiler) { result.profile = { error: "no JS Self-Profiling API here (window.Profiler)" }; say(result.profile.error); return result.profile; }
        let p: any;
        try { p = new G.Profiler({ sampleInterval: 1, maxBufferSize: 200000 }); } catch (e: any) { result.profile = { error: `Profiler: ${e?.message ?? e} (the page needs the header Document-Policy: js-profiling)` }; say(result.profile.error); return result.profile; }
        const spun = await phases.spin(ms, wrapped), trace = await p.stop();
        result.profile = { wrapped, ...spun, ...traceTables(trace) };
        say(`sampled profile: ${result.profile.samples} samples every ${result.profile.intervalMs} ms over ${spun.frames} frames; self time:\n` + result.profile.self.slice(0, 25).map((e: any) => `  ${String(e.pct).padStart(5)}%  ${e.fn}`).join("\n"));
        return result.profile;
      },
    };
    if (manual) { await new Promise<void>(finish => { G.__gfxprof = { ...phases, result, finish }; G.__gfxprofReady = true; }); return; }
    await phases.plain(N);
    await phases.records(Math.min(N, 10));
    await phases.methods(Math.min(N, 10));
    if (profMs > 0) await phases.selfProfile(profMs, wrap);
  };
  const r = await replayCapture(index, payload, (memory, log) => (host = new GfxHost(device, memory as any, { log, capture: false })), { noReadback: true, texMax: num("texmax", 0) || undefined, repeat: { frame, run } });
  result.deviceLost = !!host?.lost; if (result.deviceLost) say("[RED] the WebGPU device was LOST during the run: the timings after that moment mean nothing");
  result.redLines = r.errors.slice(0, 20); result.redDistinct = r.errors.length; result.notes = r.notes; result.totalMs = Math.round(performance.now() - t0);
  const body = JSON.stringify(result, null, 1);
  let posted = "";
  for (const url of [`${to}/${name}`, `/__report/${name}`]) { try { const p = await fetch(url, { method: "POST", body }); if (p.ok) { posted = url; break; } } catch { /* the next one */ } }
  say(posted ? `result written: POST ${posted}` : `the result could not be POSTed (to ${to}/${name} or /__report/${name}); it is in window.__result`);
  result.posted = posted;
  return result;
}
G.__result = main().catch(e => { say(`FAILED: ${e?.stack ?? e}`); return { fatal: String(e?.stack ?? e) }; });
G.__result.then(() => { document.title = "gfxprof: done"; });
