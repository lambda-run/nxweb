// nxweb runtime glue: where a guest's shaders come from. A stage is named by its key (src/gfx/shader.ts: the first 8
// bytes of sha256(control section + code area)). When a game hands a program its stages (nvnProgramSetShaders) each
// key is looked up, in this order:
//   1. what the embedder registered itself (RtGfx.registerShader);
//   2. a loaded library (.nxsl, src/shaders/library.ts), built offline by tools/shaders;
//   3. the in-page chain, when a translator is attached: a store of earlier translations (key + chain version), then
//      the translator itself (the Ryujinx translator as WebAssembly, the SPIR-V pass and naga, in a Worker of their
//      own: rt_shader_worker.ts). The game goes on meanwhile; the recorder skips the draws that use the stage until
//      the record is registered, which is all it takes for the pipeline to be built at the next draw.
// The gfx side is reached through GfxHost.registerShader only.
import type { RtGfx } from "./rt_gfx.ts";
import { ShaderLibrary, type Reflection } from "../shaders/library.ts";

export interface ShaderBlob { key: string; control: Uint8Array; code: Uint8Array }
export interface Translated { wgsl: string; reflection: Reflection }
export interface ShaderTranslator { chain: string; translate(blob: ShaderBlob): Promise<Translated>; close?(): void }
export interface ShaderStore { get(id: string): Promise<Translated | null>; put(id: string, t: Translated): Promise<void> }
export interface ShaderOptions {
  library?: Uint8Array | ShaderLibrary;   // consulted first
  translator?: ShaderTranslator;          // on a miss
  store?: ShaderStore;                    // translations of earlier runs, by key + the translator's chain version
}

export class RtShaders {
  stats = { stages: 0, registered: 0, fromLibrary: 0, fromStore: 0, translated: 0, failed: 0, unknown: 0, translateMs: 0 };
  readonly library: ShaderLibrary | null;
  private state = new Map<string, "ready" | "pending" | "failed" | "unknown">();
  private waiting: Promise<unknown>[] = [];
  private gfx: RtGfx; private o: ShaderOptions;

  constructor(gfx: RtGfx, o: ShaderOptions = {}) {
    this.gfx = gfx; this.o = o;
    this.library = !o.library ? null : o.library instanceof ShaderLibrary ? o.library : new ShaderLibrary(o.library);
    gfx.shaders = this;
  }
  private log(line: string): void { this.gfx.rt.log(line); }
  // the embedder registered this key itself
  known(key: string): void { this.state.set(key, "ready"); }
  stateOf(key: string): string | undefined { return this.state.get(key); }
  // nothing is being fetched or translated any more
  async settled(): Promise<void> { while (this.waiting.length) await Promise.allSettled(this.waiting.splice(0)); }

  // A program was given a stage with this key. blob() reads the stage's bytes out of guest memory (they are only
  // read when the key has to be translated, and then at once: the game may free them after the call).
  need(key: string, blob: () => ShaderBlob): void {
    if (this.state.has(key)) return;
    this.stats.stages++;
    const lib = this.library?.get(key);
    if (lib) {
      if (this.register(key, { wgsl: lib.wgsl, reflection: lib.reflection }, "the library")) this.stats.fromLibrary++;
      return;
    }
    const tr = this.o.translator;
    if (!tr) { this.state.set(key, "unknown"); this.stats.unknown++; return; }   // the recorder reports the key red at the first draw
    this.state.set(key, "pending");
    let bytes: ShaderBlob;
    try { bytes = blob(); } catch (e) { this.fail(key, `its bytes cannot be read from guest memory (${e instanceof Error ? e.message : e})`); return; }
    this.log(`shader ${key} is not in ${this.library ? "the shader library" : "any shader library"}: it is translated in the page; draws that use it are skipped until it is there`);
    const id = `${key}/${tr.chain}`, t0 = performance.now();
    this.waiting.push((async () => {
      let got: Translated | null = null, from = "the store of earlier translations";
      try { got = await this.o.store?.get(id) ?? null; } catch { got = null; }
      if (!got) {
        from = "the translator";
        try { got = await tr.translate(bytes); } catch (e) { this.fail(key, `translation failed: ${e instanceof Error ? e.message : e}`); return; }
        try { await this.o.store?.put(id, got); } catch (e) { this.log(`shader ${key}: the translation could not be stored (${e instanceof Error ? e.message : e})`); }
      }
      if (this.gfx.rt.disposed) return;
      if (!this.register(key, got, from)) return;
      if (from === "the translator") this.stats.translated++; else this.stats.fromStore++;
      this.stats.translateMs += performance.now() - t0;
      this.log(`shader ${key} arrived from ${from} after ${(performance.now() - t0).toFixed(0)} ms (${got.wgsl.length} bytes of WGSL)`);
      this.gfx.rt.requestWake();
    })());
  }
  private register(key: string, t: Translated, from: string): boolean {
    const r = t.reflection;
    if (r.stage === "compute") return this.fail(key, `${from} has it as a compute stage, which src/gfx does not run`);
    if (r.extra?.length) return this.fail(key, `${from} has it with bindings src/gfx does not provide: ${r.extra.map(x => x.kind).join(", ")}`);
    if (this.gfx.host.registerShader(key, { ...r, entry: r.entry ?? "main", wgsl: t.wgsl } as any) < 0) return this.fail(key, "registerShader refused the record");
    this.state.set(key, "ready"); this.stats.registered++;
    return true;
  }
  // one red line a key
  private fail(key: string, why: string): false {
    this.state.set(key, "failed"); this.stats.failed++;
    this.log(`[RED] shader ${key}: ${why}; its draws are skipped`);
    return false;
  }
  // The recorder's own report of a missing key (`[RED] shader <key> is not in the shader map`, once a key, at the first
  // draw): not passed on for a key that is on its way (the informational line above said so) or that failed (its red
  // line names the reason). Until src/gfx can be told that a key is pending, this is where the two meet.
  dropLine(line: string): boolean {
    const m = /^\[RED\] shader ([0-9a-f]{16}) is not in the shader map$/.exec(line);
    const s = m ? this.state.get(m[1]) : undefined;
    return s === "pending" || s === "failed" || s === "ready";
  }
}

// ---- the in-page translator: a Worker of its own (rt_shader_worker.ts, bundled as a module) ----
export const SHADER_CHAIN = "nxweb-shaders-1/page";
export function workerTranslator(o: { worker: string | URL; framework: string; naga: string; chain?: string }): ShaderTranslator {
  let w: Worker | null = null, seq = 0;
  const calls = new Map<number, { res: (t: Translated) => void; rej: (e: Error) => void }>();
  const start = (): Worker => {
    const nw = new Worker(o.worker, { type: "module" });
    nw.onmessage = ev => { const c = calls.get(ev.data.id); if (!c) return; calls.delete(ev.data.id); if (ev.data.error) c.rej(new Error(ev.data.error)); else c.res({ wgsl: ev.data.wgsl, reflection: ev.data.reflection }); };
    nw.onerror = ev => { for (const c of calls.values()) c.rej(new Error("the shader translator's Worker failed: " + (ev.message || "it could not be started"))); calls.clear(); w = null; };
    nw.postMessage({ init: { framework: o.framework, naga: o.naga } });
    return nw;
  };
  return {
    chain: o.chain ?? SHADER_CHAIN,
    translate: blob => new Promise((res, rej) => { w ??= start(); const id = ++seq; calls.set(id, { res, rej }); w.postMessage({ id, key: blob.key, control: blob.control, code: blob.code }); }),
    close: () => { w?.terminate(); w = null; },
  };
}
// The store of translations in the Cache API (window or Worker, secure context): one entry per key + chain version
export function webShaderStore(name = "nxweb-shaders"): ShaderStore {
  const url = (id: string) => "/shader-cache/" + encodeURIComponent(id);
  return {
    async get(id) { const c = await (globalThis as any).caches.open(name), r = await c.match(url(id)); return r ? await r.json() : null; },
    async put(id, t) { const c = await (globalThis as any).caches.open(name); await c.put(url(id), new Response(JSON.stringify(t), { headers: { "Content-Type": "application/json" } })); },
  };
}
