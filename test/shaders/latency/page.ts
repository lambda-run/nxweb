// The page of npm run shaders:latency: hands the in-page translator (rt_shaders.ts workerTranslator, the bundled
// rt_shader_worker.ts) every stage of a corpus at once, as RtShaders.need does at a game's boot, and times each one's arrival
import { workerTranslator } from "../../../src/glue/rt_shaders.ts";
const g: any = globalThis;
const bytes = async (u: string) => new Uint8Array(await (await fetch(u)).arrayBuffer());
g.run = async (base: string, corpus: { key: string; code: string; control: string }[], o: { workers?: number; batch?: number; first?: string[] }) => {
  const blobs = await Promise.all(corpus.map(async r => ({ key: r.key, control: await bytes(`${base}/${r.control}`), code: await bytes(`${base}/${r.code}`) })));
  const tr: any = workerTranslator({ worker: "/shader_worker.js", framework: location.origin + "/build/shaders/xlate_wasm/_framework", naga: location.origin + "/build/shaders/nx_naga.wasm", workers: o.workers, batch: o.batch } as any);
  const t0 = performance.now(), out: Record<string, { ms: number; wgsl?: number; error?: string; t?: any }> = {};
  const all = blobs.map(b => tr.translate(b).then((t: any) => { out[b.key] = { ms: performance.now() - t0, wgsl: t.wgsl.length, t: t.timing }; },
    (e: Error) => { out[b.key] = { ms: performance.now() - t0, error: e.message }; }));
  // a draw waits on these keys (RtShaders.wanted): asked for after all the others were queued
  for (const k of o.first ?? []) tr.prioritize?.(k);
  await Promise.all(all);
  const total = performance.now() - t0;
  tr.close?.();
  return { total, out, hw: navigator.hardwareConcurrency };
};
g.__ready = true;
