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
  const r = await replayCapture(index, payload, (memory, log) => new GfxHost(device, memory as any, { log, capture: false, limits }), {
    shader,
    onLive: async (n, head, data) => { flips.set(n, !!head.flip); const p = image(head.format, head.width, head.height, data, !!head.flip); if (p) await out(`frame-${n}.live.png`, p); },
    texMax: Number(q.get("texmax") ?? 0) || undefined,
    dump, onDump: async d => { const p = d.data.length ? image(d.format, d.width, d.height, d.data, false) : null; if (p) await out(`f${d.frame}-tex${d.serial}.png`, p);
      dumps.push({ frame: d.frame, serial: d.serial, width: d.width, height: d.height, format: d.format, nonZero: d.nonZero, note: d.note || (p ? "" : "no PNG for this format") }); },
    onFrame: async f => { const p = f.data ? image(f.format, f.width, f.height, f.data, f.flip) : null; if (p) await out(`frame-${f.n}.png`, p); },
  });
  const adapterName = adapter.info ? `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}`.trim() : "";
  await out("replay.log", r.log.join("\n") + "\n");
  await out("errors.txt", r.errors.map(([l, n]) => `${String(n).padStart(6)}  ${l}`).join("\n") + (r.errors.length ? "\n" : ""));
  if (replaced.length) r.notes.push(`${replaced.length} shaders of the capture replaced by ones translated again (--shaders)`);
  return { adapter: adapterName, notes: r.notes, ms: r.ms, stats: r.stats, errors: r.errors, dumps, frames: r.frames.map(f => ({ n: f.n, serial: f.serial, width: f.width, height: f.height, format: f.format, live: f.live, differing: f.differing, note: f.note, line: f.line })) };
}
(window as any).__replay = main().catch(e => ({ fatal: String(e?.stack ?? e) }));
