// The browser side of `npm run rt:browser`: a Worker (wasm compilation and the run loop are synchronous) that fetches
// the wasm modules, the test NSOs and the guest corpus from the test server and runs the same cases as Node.
import { runCases, type Env, type CorpusGuest } from "../cases.ts";
import { runGfxCases, type Gpu, type Shot } from "../gfx_cases.ts";

const bytes = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());

self.onmessage = async (ev: MessageEvent) => {
  try {
    const list: { nso: string[]; corpus: string[]; gfx: boolean } = await (await fetch("/list")).json();
    const mod = async (n: string) => WebAssembly.compile(await bytes(`/wasm/${n}.wasm`));
    const [rt, kernel, loader, translator, helpers, gfx] = await Promise.all(["rt", "kernel", "loader", "translator", "helpers", "gfx"].map(mod));
    const nso = new Map<string, Uint8Array>();
    await Promise.all(list.nso.map(async n => { nso.set(n, await bytes(`/nso/${n}.nso`)); }));
    const corpus: CorpusGuest[] = await Promise.all(list.corpus.map(async name => {
      const side = await (await fetch(`/corpus/${name}.json`)).json();
      return { name, side, image: await bytes(`/corpus/${side.image}`), expected: await bytes(`/corpus/${side.expected_stdout}`) };
    }));
    const env: Env = { haveGfxGuests: list.gfx, mods: { rt, kernel, loader, translator, helpers, gfx }, nso: n => nso.get(n) ?? (() => { throw new Error("no NSO " + n); })(), corpus };
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
    for (const s of shots) (self as any).postMessage({ shot: s });
    (self as any).postMessage({ note: "WebGPU adapter: " + adapterInfo });
    (self as any).postMessage({ done: true, isolated: (self as any).crossOriginIsolated, sab: typeof SharedArrayBuffer !== "undefined" });
  } catch (e) {
    (self as any).postMessage({ done: true, fatal: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  }
};
