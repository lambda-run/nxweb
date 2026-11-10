// The page `npm run gfx:test` opens (test/gfx/test.html): runs every scene in a fresh fake guest on one WebGPU device
// and leaves the results in window.__gfx for the runner.
import { Env } from "./env.mts";
import { scenes as scenes1, T } from "./scenes.mts";
import { scenes2 } from "./scenes2.mts";
const scenes = [...scenes1, ...scenes2];
import { GfxHost } from "../../src/glue/gfx_host.ts";

async function main() {
  const gpu = (navigator as any).gpu;
  if (!gpu) throw new Error("navigator.gpu is missing");
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  // every feature the replayer can use and the adapter's own limits, as an embedder should ask (GfxHost.deviceDescriptor)
  const dd = GfxHost.deviceDescriptor(adapter), want = dd.requiredFeatures;
  const device = await adapter.requestDevice(dd);
  const limits = ["maxUniformBuffersPerShaderStage", "maxSampledTexturesPerShaderStage", "maxSamplersPerShaderStage", "maxStorageBuffersPerShaderStage", "maxStorageTexturesPerShaderStage", "maxDynamicUniformBuffersPerPipelineLayout", "maxVertexAttributes", "maxVertexBuffers"]
    .map(l => `${l} ${adapter.limits[l]} (${device.limits[l]} granted)`).join(", ");
  const wasm = await WebAssembly.compileStreaming(fetch("/build/gfx/gfx.wasm"));
  const only = new URLSearchParams(location.search).get("only");
  const results: any[] = [];
  let hits: number[] = [];
  for (const s of scenes) {
    if (only && !s.name.includes(only)) continue;
    const t = new T(), t0 = performance.now(), notes: string[] = [], log = console.log;
    console.log = (...a: any[]) => { notes.push(a.join(" ")); };
    let e: Env | undefined, error: string | null = null;
    try {
      e = await Env.create(s.ownDevice ? await (await gpu.requestAdapter()).requestDevice(dd) : device, wasm, { cmdBytes: s.cmdBytes, glConventions: s.glConventions, host: s.host });
      e.g.x.kit_cover_enable(1);
      await s.run(e, t);
      await e.settle();
    } catch (err: any) { error = String(err?.stack ?? err); }
    console.log = log;
    if (e) { const h = new Uint8Array(e.g.memory.buffer, e.g.x.kit_hits_ptr(), e.g.x.kit_hits_size()); if (!hits.length) hits = Array.from(h); else h.forEach((v, i) => { if (v) hits[i] = 1; }); }
    results.push({ name: s.name, error, notes, files: t.files, checks: t.checks, ms: Math.round(performance.now() - t0), calls: e?.g.calls ?? 0, logs: error ? e?.g.logs.slice(-12) : undefined, stats: e?.host.stats });
  }
  return { results, hits, adapter: adapter.info ? `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}`.trim() : "", features: want, limits };
}
(window as any).__gfx = main().catch(e => ({ fatal: String(e?.stack ?? e) }));
