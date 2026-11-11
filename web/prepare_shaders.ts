// The Prepare page's Shaders stage (src/prepare/host/shader_prewarm.ts): the scan in a Worker
// (prepare_shader_worker.js), the translation by the runtime's own in-page translator (shader_worker.js, which
// web:build makes; without it the stage scans and reports, and the runtime translates on demand as before), into the
// runtime's store.
import type { PrepTree } from "../src/prepare/host/tree.ts";
import type { ShaderPrewarm, ShaderScanSource, ScanFile } from "../src/prepare/host/shader_prewarm.ts";
import { workerTranslator, webShaderStore, SHADER_CHAIN } from "../src/glue/rt_shaders.ts";
import type { FileScan } from "../src/prepare/host/shader_scan.ts";

const exists = (u: string) => fetch(u, { method: "HEAD" }).then(r => r.ok, () => false);
export async function pagePrewarm(tree: PrepTree, module: WebAssembly.Module): Promise<ShaderPrewarm> {
  const have = (await Promise.all(["shader_worker.js", "shaders/nx_naga.wasm", "shaders/xlate_wasm/_framework/dotnet.js"].map(exists))).every(Boolean);
  // as the runtime will translate: with WGSL subgroups when the adapter has them (GfxHost.deviceDescriptor asks the runtime's device for them)
  const subgroups = have && !!(await (navigator as any).gpu?.requestAdapter().catch(() => null))?.features?.has("subgroups");
  const n = Math.max(1, Math.min(2, Math.floor((navigator.hardwareConcurrency || 2) / 4)));
  return {
    key: `page-1:${have ? SHADER_CHAIN + (subgroups ? "+subgroups" : "") : "scan-only"}`,
    translators: have ? () => Array.from({ length: n }, () => workerTranslator({ worker: "shader_worker.js", framework: new URL("shaders/xlate_wasm/_framework", location.href).href, naga: new URL("shaders/nx_naga.wasm", location.href).href, subgroups })) : null,
    store: typeof caches !== "undefined" ? webShaderStore() : null,
    source: (files: ScanFile[]): ShaderScanSource => {
      const worker = new Worker("prepare_shader_worker.js");
      worker.postMessage({ wasm: module });
      const calls = new Map<number, { res: (r: FileScan) => void; rej: (e: Error) => void }>();
      worker.onmessage = ev => { const c = calls.get(ev.data.id); calls.delete(ev.data.id); if (ev.data.error !== undefined) c?.rej(new Error(ev.data.error)); else c?.res(ev.data.scan); };
      worker.onerror = ev => { for (const c of calls.values()) c.rej(new Error("the shader scan's Worker failed: " + (ev.message || "it could not be started"))); calls.clear(); };
      return {
        scan: async i => {
          const f = files[i], blob = tree.blob?.(f.path);
          const bytes = blob ? undefined : await tree.read(f.path, 0, f.size);
          return new Promise((res, rej) => { calls.set(i, { res, rej }); worker.postMessage({ id: i, path: f.path, size: f.size, module: f.module, blob, bytes }, bytes ? [bytes.buffer] : []); });
        },
        close: () => worker.terminate(),
      };
    },
  };
}
