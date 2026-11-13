// The page of `node test/gfx/replay.mts <capture>`: replays a stream capture (src/glue/gfx_stream_capture.ts) on this browser's WebGPU device and hands
// each presented image (PNG, and the live image the capture holds) and the list of red lines back to the runner. No game, no recorder.
import { GfxHost } from "../../src/glue/gfx_host.ts";
import { png, toRgba8 } from "../../src/glue/gfx_capture.ts";
import { replayCapture, type CaptureIndex } from "../../src/glue/gfx_stream_capture.ts";

const out = (name: string, body: Uint8Array | string) => fetch(`/__out/${name}`, { method: "POST", body: body as any }).then(r => r.text());
function image(format: string, w: number, h: number, data: Uint8Array, flip: boolean): Uint8Array | null {
  const rgba = toRgba8(format, data, w * h);
  if (!rgba) return null;
  if (flip) for (let y = 0; y < h >> 1; y++) { const a = rgba.subarray(y * w * 4, (y + 1) * w * 4), b = rgba.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), tmp = a.slice(); a.set(b); b.set(tmp); }
  return png(w, h, rgba);
}
async function main() {
  const q = new URLSearchParams(location.search), gpu = (navigator as any).gpu;
  if (!gpu) throw new Error("navigator.gpu is missing");
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice(GfxHost.deviceDescriptor(adapter));
  const index: CaptureIndex = await (await fetch("/__index")).json();
  const payload = async (i: number) => { const c = index.chunks[i]; if (!c.len) return new Uint8Array(0); return new Uint8Array(await (await fetch("/__cap", { headers: { Range: `bytes=${c.off}-${c.off + c.len - 1}` } })).arrayBuffer()); };
  const limits: Record<string, number> = {};
  for (const kv of (q.get("limits") ?? "").split(",")) { const [k, v] = kv.split(":"); if (k && v) limits[k] = +v; }
  // stages translated again (--shaders): the new WGSL and the bindings that changed with it; what the stream binds (textures, uniform slots) is the capture's
  const again: Record<string, { wgsl: string; refl: any }> = await (await fetch("/__shaders")).json(), replaced: string[] = [];
  const blockOf = (e: any) => e.kind === "c1" ? 0 : e.kind === "drvcb" ? (e.bank === 0 ? 1 : e.bank === 2 ? 2 : -1) : e.kind === "push" ? 3 : e.kind === "gmem" ? 4 : -1;
  const shader = (key: string, info: any) => {
    const a = again[key];
    if (!a) return undefined;
    replaced.push(key);
    const { variants: _v, variant: _f, gmem: _g, ...rest } = info;
    return { ...rest, wgsl: a.wgsl, storage: a.refl.storage, ...(a.refl.gmem ? { gmem: a.refl.gmem } : {}), extra: a.refl.extra,
      hostBlocks: (a.refl.extra ?? []).filter((e: any) => blockOf(e) >= 0).map((e: any) => ({ k: blockOf(e), size: e.size ?? 0 })).sort((x: any, y: any) => x.k - y.k) };
  };
  const flips = new Map<number, boolean>(), dumps: any[] = [], dump = (q.get("dump") ?? "").split(",").filter(Boolean).map(Number);
  // ?trace=1: every pipeline the replayer builds at its first use and every device call that takes over 50 ms, with wall-clock times (trace.txt): what a
  // software device was doing when its process died
  const trace: string[] = [], tr = q.get("trace") === "1";
  const stamp = () => new Date().toISOString().slice(11, 23);
  if (tr) for (const m of ["createComputePipeline", "createRenderPipeline", "createShaderModule", "createTexture", "createBuffer"]) {
    const f = (device as any)[m].bind(device);
    (device as any)[m] = (d: any) => { const t0 = performance.now(), at = stamp(); try { return f(d); } finally { const ms = performance.now() - t0; if (ms > 50 || m.endsWith("Pipeline")) trace.push(`${at} ${m} ${ms.toFixed(0)} ms ${m === "createShaderModule" ? `${d.code.length} chars` : m === "createTexture" ? `${d.format} ${JSON.stringify(d.size)}` : m === "createBuffer" ? `${d.size} bytes` : (d.compute?.module ?? d.fragment?.module)?.__key ?? ""}`); } };
  }
  // Pipelines are built when a draw or dispatch first uses them (GfxHost.usePipeline), one at a time: the asynchronous requests the replayer makes for every
  // pipeline at once (a software device compiles hundreds of shaders of up to a megabyte of WGSL side by side and runs out of memory) never start.
  // ?skipbig=<chars>[&keep=key,key]: a pipeline with a shader of more WGSL than that is not built at all (its draws and dispatches are skipped) unless one of its keys is kept
  const never = () => new Promise<never>(() => {});
  (device as any).createRenderPipelineAsync = never; (device as any).createComputePipelineAsync = never;
  const skipBig = Number(q.get("skipbig") ?? 0), keep = new Set((q.get("keep") ?? "").split(",").filter(Boolean)), skipped = new Map<string, number>();
  const mk = (memory: any, log: (l: string) => void) => {
    const h: any = new GfxHost(device, memory, { log: l => { if (tr) trace.push(`${stamp()} log ${l.slice(0, 200)}`); log(l); }, capture: false, limits });
    if (skipBig) { const use0 = h.usePipeline.bind(h); h.usePipeline = (id: number) => {
      const pp = h.pipes.get(id);
      if (pp && !pp.gpu && pp.desc) { const ks: string[] = (h.pipeShaders?.(id) ?? pp.stages).map((sid: number) => h.shaders[sid]).filter((x: any) => x && x.info.wgsl.length > skipBig).map((x: any) => x.key);
        if (ks.length && !ks.some(k => keep.has(k))) { pp.desc = null; for (const k of ks) skipped.set(k, (skipped.get(k) ?? 0) + 1); } }
      return use0(id); }; }
    if (tr) { const use = h.usePipeline.bind(h); h.usePipeline = (id: number) => { const pp = h.pipes.get(id); if (pp && !pp.gpu && pp.desc) trace.push(`${stamp()} pipeline ${id} built at its use: ${pp.stages.map((sid: number) => `${h.shaders[sid]?.info.stage} ${h.shaders[sid]?.key} (${h.shaders[sid]?.info.wgsl.length} chars)`).join(", ")}`); return use(id); }; }
    return h;
  };
  const r = await replayCapture(index, payload, mk, {
    shader,
    onLive: async (n, head, data) => { flips.set(n, !!head.flip); const p = image(head.format, head.width, head.height, data, !!head.flip); if (p) await out(`frame-${n}.live.png`, p); },
    texMax: Number(q.get("texmax") ?? 0) || undefined,
    dump, dumpPasses: /^\d+-\d+$/.test(q.get("dumpat") ?? "") ? (q.get("dumpat")!.split("-").map(Number) as [number, number]) : undefined, onDump: async d => { const at = d.pass !== undefined ? `-p${d.pass}` : ""; const p = d.data.length ? image(d.format, d.width, d.height, d.data, false) : null; if (q.get("raw") === "1" && d.data.length) await out(`f${d.frame}${at}-tex${d.serial}.${d.format}.${d.width}x${d.height}.raw`, d.data);  /* --raw: the texels as they were read, for NaN and range checks */ if (p) await out(`f${d.frame}${at}-tex${d.serial}.png`, p);
      dumps.push({ pass: d.pass, frame: d.frame, serial: d.serial, width: d.width, height: d.height, format: d.format, nonZero: d.nonZero, note: d.note || (p ? "" : "no PNG for this format") }); },
    onFrame: async f => { const p = f.data ? image(f.format, f.width, f.height, f.data, f.flip) : null; if (p) await out(`frame-${f.n}.png`, p); },
  });
  const adapterName = adapter.info ? `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}`.trim() : "";
  await out("replay.log", r.log.join("\n") + "\n");
  if (skipped.size) r.notes.push(`--skipbig ${skipBig}: ${skipped.size} shaders of more WGSL were left out with their pipelines (${[...skipped.keys()].join(" ")})`);
  if (tr) await out("trace.txt", trace.join("\n") + "\n");
  // errors.txt: what the frame ledger counted and how often each red line's cause came up, frame by frame; then every red line of the run with its count
  await out("errors.txt", r.frames.map(f => `frame ${f.n}: ${f.line}\n${f.reds.map(([l, n]) => `${String(n).padStart(6)}  ${l}`).join("\n")}\n`).join("\n") + "\nwhole run:\n" + r.errors.map(([l, n]) => `${String(n).padStart(6)}  ${l}`).join("\n") + (r.errors.length ? "\n" : ""));
  if (replaced.length) r.notes.push(`${replaced.length} shaders of the capture replaced by ones translated again (--shaders)`);
  return { adapter: adapterName, notes: r.notes, ms: r.ms, stats: r.stats, errors: r.errors, dumps, frames: r.frames.map(f => ({ n: f.n, serial: f.serial, width: f.width, height: f.height, format: f.format, live: f.live, differing: f.differing, note: f.note, line: f.line, reds: f.reds })) };
}
(window as any).__replay = main().catch(e => ({ fatal: String(e?.stack ?? e) }));
