// EXPERIMENTAL (spike, SPIKE.md). The browser page's script (bundled to build/spike_workers/web/page.js): the
// coordinator on the page's main thread, guest cores in Workers. Driven by test/spike_workers/browser.mts.
import { runGuest, type Guest, type RunCfg, type Spawned } from "../../../src/spike_workers/coord.ts";
import type { Mods } from "../../../src/spike_workers/engine.ts";
import { series, demos, type Config, type RunFn } from "../series.ts";

const bytes = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());
const mod = async (name: string) => WebAssembly.compile(await bytes("/wasm/" + name));
const cache = new Map<string, Promise<any>>();
const once = <T>(key: string, f: () => Promise<T>): Promise<T> => { let p = cache.get(key); if (!p) cache.set(key, p = f()); return p; };
const modsUnshared = () => once<Mods>("u", async () => ({ kernel: await mod("rt/kernel.wasm"), translator: await mod("rt/translator.wasm"), helpers: await mod("rt/helpers.wasm") }));
const modsShared = () => once<Mods>("s", async () => ({ kernel: await mod("kernel.mt.wasm"), kernel2: await mod("kernel.mt2.wasm"), translator: await mod("translator.mt.wasm"),
  translator2: await mod("translator.mt2.wasm"), helpers: await mod("helpers.private.wasm") }));
const modsSharedHelpers = () => once<Mods>("h", async () => ({ ...(await modsShared()), helpers: await mod("helpers.shared.wasm") }));
const guest = (name: string) => once<Guest>("g" + name, async () => ({ image: await bytes(`/guest/${name}.bin`), ...(await (await fetch(`/guest/${name}.json`)).json()) }));

function spawn(): Spawned {
  const w = new Worker("/worker.js");
  return { post: m => w.postMessage(m), onmsg: fn => { w.onmessage = ev => fn(ev.data); w.onerror = e => fn({ type: "error", text: String(e.message) }); }, kill: () => w.terminate() };
}
const run: RunFn = async (name, config, o = {}) => {
  const { sharedHelpers, ...opts } = o;
  const g = await guest(name);
  const cfg: RunCfg = config === "unshared" ? { shared: false, workers: 0, mods: await modsUnshared(), guest: g, opts }
    : { shared: true, workers: config === "shared-green" ? 0 : config, mods: sharedHelpers ? await modsSharedHelpers() : await modsShared(), guest: g, opts: sharedHelpers ? { ...opts, helpersPrivate: false } : opts };
  return runGuest(spawn, cfg);
};

(self as any).spike = {
  info: () => ({ isolated: (self as any).crossOriginIsolated, cores: navigator.hardwareConcurrency, ua: navigator.userAgent, sab: typeof SharedArrayBuffer !== "undefined" }),
  series: async (g: string, c: Config, runs: number, opts: any, note: string) => { const r = await series(run, g, c, runs, opts ?? {}, note ?? ""); return { ok: r.ok, line: r.line, passed: r.passed, timingOnly: r.timingOnly }; },
  demos: (n: number) => demos(run, n),
  // one bench run: wall ms and the output
  bench: async (g: string, c: Config, opts: any) => {
    const r = await run(g, c, opts ?? {});
    const sum = (f: (s: any) => number) => r.stats.reduce((n, s) => n + f(s), 0);
    return { wall: r.wallMs, out: r.out, fault: r.fault, svcs: sum(s => s.svcs), unwinds: sum(s => s.unwinds), inplace: sum(s => s.inplaceResumes), compile: sum(s => s.a64.translatorMs + s.a64.compileMs), instantiate: sum(s => s.a64.instantiateMs) };
  },
  // Is a module made from bytes that were compiled before cheaper than one from new bytes? (V8's native module cache)
  modcache: async (name: string) => {
    const b = await bytes("/wasm/" + name);
    const time = (x: Uint8Array) => { const t0 = performance.now(); new WebAssembly.Module(x as unknown as BufferSource); return performance.now() - t0; };
    const variant = (k: number) => { const v = new Uint8Array(b.length + 4); v.set(b); v.set([0, 2, 1, 65 + k], b.length); return v; };   // + a custom section named by one letter
    return { bytes: b.length, first: time(variant(1)), again: time(variant(1)), other: time(variant(2)), otherAgain: time(variant(2)) };
  },
  // What does instantiating a module that imports a function table cost, by table length? (ms per instance)
  tablecost: () => {
    const m = new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 2, 9, 1, 1, 0x65, 1, 0x74, 1, 0x70, 0, 1, 3, 2, 1, 0, 9, 7, 1, 0, 0x41, 0, 0x0b, 1, 0, 10, 4, 1, 2, 0, 0x0b]));
    const out: Record<string, number> = {};
    for (const n of [1024, 65536, 524288]) {
      const t = new WebAssembly.Table({ element: "anyfunc", initial: n });
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) new WebAssembly.Instance(m, { e: { t } });
      out[n] = (performance.now() - t0) / 20;
    }
    return out;
  },
  // What a page without cross-origin isolation can do
  nosab: async () => {
    const out: Record<string, string> = { crossOriginIsolated: String((self as any).crossOriginIsolated), SharedArrayBuffer: typeof SharedArrayBuffer };
    try { const m = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }); out.sharedMemory = "created, buffer is a " + Object.prototype.toString.call(m.buffer);
      try { const w = new Worker("/worker.js"); await new Promise<void>((res, rej) => { w.onmessageerror = () => rej(new Error("messageerror in the Worker")); w.onerror = e => rej(new Error(e.message)); try { w.postMessage({ type: "probe", m }); setTimeout(res, 300); } catch (e) { rej(e as Error); } }); out.postToWorker = "no error raised on the sending side"; w.terminate(); }
      catch (e) { out.postToWorker = "FAILS: " + (e as Error).name + ": " + (e as Error).message; }
    } catch (e) { out.sharedMemory = "FAILS: " + (e as Error).message; }
    return out;
  },
};
