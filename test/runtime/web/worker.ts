// The browser side of `npm run rt:browser`: a Worker (wasm compilation and the run loop are synchronous) that fetches
// the wasm modules, the test NSOs and the guest corpus from the test server and runs the same cases as Node.
import { runCases, type CorpusGuest } from "../cases.ts";
import { runGfxCases, type Gpu, type Shot } from "../gfx_cases.ts";
import { runMoreCases, type MoreEnv } from "../more_cases.ts";
import { webCacheStore } from "../../../src/glue/a64_host.ts";
import { OpfsStorage } from "../../../src/glue/fs_dev_opfs.ts";
import { FS_KIND } from "../../../src/glue/fs_host.ts";
import { workerTranslator, webShaderStore } from "../../../src/glue/rt_shaders.ts";

const bytes = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());

self.onmessage = async (ev: MessageEvent) => {
  try {
    const list: { nso: string[]; files: string[]; corpus: string[]; gfx: boolean; big: string | null; shaders: { library: boolean; translator: boolean; why: string } } = await (await fetch("/list")).json();
    const mod = async (n: string) => WebAssembly.compile(await bytes(`/wasm/${n}.wasm`));
    const [rt, kernel, loader, translator, helpers, gfx, fsm] = await Promise.all(["rt", "kernel", "loader", "translator", "helpers", "gfx", "fs"].map(mod));
    const nso = new Map<string, Uint8Array>();
    await Promise.all(list.nso.map(async n => { nso.set(n, await bytes(`/nso/${n}.nso`)); }));
    const corpus: CorpusGuest[] = await Promise.all(list.corpus.map(async name => {
      const side = await (await fetch(`/corpus/${name}.json`)).json();
      return { name, side, image: await bytes(`/corpus/${side.image}`), expected: await bytes(`/corpus/${side.expected_stdout}`) };
    }));
    const files = new Map<string, Uint8Array>();
    await Promise.all(list.files.map(async n => { files.set(n, await bytes(`/guest/${n}`)); }));
    let big: CorpusGuest | undefined;
    if (list.big) { const side = await (await fetch(`/big/${list.big}.json`)).json(); big = { name: list.big, side, image: await bytes(`/big/${side.image}`), expected: await bytes(`/big/${side.expected_stdout}`) }; }
    const env: MoreEnv = { haveGfxGuests: list.gfx, mods: { rt, kernel, loader, translator, helpers, gfx, fs: fsm }, nso: n => nso.get(n) ?? (() => { throw new Error("no NSO " + n); })(),
      file: n => files.get(n) ?? (() => { throw new Error("no file " + n); })(), corpus, big,
      // saves in the Origin Private File System, the container opened ahead so that a mount does not wait; the rom
      // device is the test image in a Blob (read with FileReaderSync)
      fsStorage: async (name, reset) => {
        const dir = "nxweb-rt-test-" + name;
        if (reset) { try { await (await (navigator as any).storage.getDirectory()).removeEntry(dir, { recursive: true }); } catch { /* not there */ } }
        const st = new OpfsStorage(dir);
        st.setRom(new Blob([files.get("romfs.img")! as unknown as BlobPart]));
        if (!await st.preopen(FS_KIND.SAVE)) throw new Error("the save container could not be opened in OPFS");
        return st;
      },
      shaderLibrary: list.shaders.library ? await bytes("/shaders/maxwell.nxsl") : undefined, shaderWhy: list.shaders.why,
      shaderTranslator: list.shaders.translator ? () => workerTranslator({ worker: "/shader_worker.js", framework: location.origin + "/shaders/xlate_wasm/_framework", naga: location.origin + "/shaders/nx_naga.wasm" }) : undefined,
      shaderStore: async name => { const id = "nxweb-rt-test-shaders-" + name; await (self as any).caches.delete(id); return webShaderStore(id); },
      // a new Cache API cache per run and name
      cacheStore: async name => { const id = "nxweb-rt-test-" + name; await (self as any).caches.delete(id); return webCacheStore(id); },
      // Chromium, cross-origin isolated: memory of this agent cluster as the browser measures it (it may wait for a collection)
      heapMb: async () => {
        const f = (performance as any).measureUserAgentSpecificMemory;
        const coarse = () => { const m = (performance as any).memory; return m ? m.usedJSHeapSize / 1e6 : undefined; };   // JavaScript heap only, in coarse steps
        if (!f) return coarse();
        const r: any = await Promise.race([f.call(performance), new Promise(res => setTimeout(() => res(null), 15000))]);
        return r ? r.bytes / 1e6 : coarse();
      } };
    runCases(env, ev.data.only, r => (self as any).postMessage({ result: r }));
    // graphics: WebGPU in this Worker, presenting to an OffscreenCanvas; frames paced by the Worker's requestAnimationFrame
    let gpu: Gpu | undefined, adapterInfo = "no WebGPU";
    const g = (navigator as any).gpu, adapter = g ? await g.requestAdapter() : null;
    if (adapter) {
      const device = await adapter.requestDevice();
      adapterInfo = adapter.info ? `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}`.trim() : "WebGPU";
      gpu = { device, canvas: new OffscreenCanvas(480, 270), nextFrame: () => new Promise(r => (self as any).requestAnimationFrame(r)) };
    }
    const shots: Shot[] = [];
    if (!gpu) (self as any).postMessage({ result: { name: "gfx: this browser has no WebGPU adapter: the graphics cases run on the null replayer only", ok: false, why: "no adapter", info: [], ms: 0 } });
    await runGfxCases(env, gpu, ev.data.only, shots, r => (self as any).postMessage({ result: r }));
    await runMoreCases(env, gpu, ev.data.only, r => (self as any).postMessage({ result: r }));
    for (const s of shots) (self as any).postMessage({ shot: s });
    (self as any).postMessage({ note: "WebGPU adapter: " + adapterInfo });
    (self as any).postMessage({ done: true, isolated: (self as any).crossOriginIsolated, sab: typeof SharedArrayBuffer !== "undefined" });
  } catch (e) {
    (self as any).postMessage({ done: true, fatal: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  }
};
