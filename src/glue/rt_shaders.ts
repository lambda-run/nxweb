// nxweb runtime glue: where a guest's shaders come from. A stage is named by its key (src/gfx/shader.ts: the first 8
// bytes of sha256(control section + code area)). When a game hands a program its stages (nvnProgramSetShaders) each
// key is looked up, in this order:
//   1. what the embedder registered itself (RtGfx.registerShader);
//   2. a loaded library (.nxsl, src/shaders/library.ts), built offline by tools/shaders;
//   3. the in-page chain, when a translator is attached: a store of earlier translations (key + chain version), then
//      the translator itself (the Ryujinx translator as WebAssembly, the SPIR-V pass and naga, in a Worker of their
//      own: rt_shader_worker.ts). The game goes on meanwhile; the recorder skips the draws that use the stage until
//      the record is registered, which is all it takes for the pipeline to be built at the next draw.
// The gfx side is reached through GfxHost.registerShader and GfxHost.shaderPending (the key's state in the recorder,
// machine gfx_shader: a key that is on its way or failed is not reported missing by the recorder).
import type { RtGfx } from "./rt_gfx.ts";
import { ndveRole } from "./ndve.ts";
import { ShaderLibrary, type Reflection } from "../shaders/library.ts";

export interface ShaderBlob { key: string; control: Uint8Array; code: Uint8Array }
export interface Translated { wgsl: string; reflection: Reflection }
export interface ShaderTranslator { chain: string; translate(blob: ShaderBlob): Promise<Translated>; prioritize?(key: string): void; close?(): void; stats?: ShaderWorkerStats }
export interface ShaderWorkerStats { workers: number; started: number; batches: number; maxQueued: number }
export interface ShaderStore { get(id: string): Promise<Translated | null>; put(id: string, t: Translated): Promise<void> }
export interface ShaderOptions {
  library?: Uint8Array | ShaderLibrary;   // consulted first
  translator?: ShaderTranslator;          // on a miss
  store?: ShaderStore;                    // translations of earlier runs, by key + the translator's chain version
}

export class RtShaders {
  stats = { stages: 0, registered: 0, fromLibrary: 0, fromStore: 0, translated: 0, failed: 0, unknown: 0, translateMs: 0, maxMs: 0, prioritized: 0 };
  readonly library: ShaderLibrary | null;
  private state = new Map<string, "ready" | "pending" | "failed" | "unknown">();
  private waiting: Promise<unknown>[] = [];
  private gfx: RtGfx; private o: ShaderOptions;

  constructor(gfx: RtGfx, o: ShaderOptions = {}) {
    this.gfx = gfx; this.o = o;
    this.library = !o.library ? null : o.library instanceof ShaderLibrary ? o.library : new ShaderLibrary(o.library);
    gfx.shaders = this;
  }
  private ndveSeen = 0;
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
    const ndve = ndveRole(key);
    if (ndve) this.log(`[ndve] shader ${key} is ${ndve}${this.ndveSeen++ ? "" : " (the movie path reached nn::ndve; a failed one leaves the movie's picture undrawn)"}`);
    const lib = this.library?.get(key);
    if (lib) {
      if (this.register(key, { wgsl: lib.wgsl, reflection: lib.reflection }, "the library")) this.stats.fromLibrary++;
      return;
    }
    const tr = this.o.translator;
    if (!tr) { this.state.set(key, "unknown"); this.stats.unknown++; return; }   // the recorder reports the key red at the first draw
    // the recorder is told: draws that need the key are skipped without its "not in the shader map" line
    this.state.set(key, "pending"); this.gfx.host.shaderPending(key, "pending");
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
      const ms = performance.now() - t0, tm = (got as Translated & { timing?: { startMs: number; xlateMs: number; convertMs: number; batch: number } }).timing;
      this.stats.translateMs += ms; this.stats.maxMs = Math.max(this.stats.maxMs, ms);
      // the split says where the time went: waiting for a free Worker, its runtime's start, the translator, the pass and naga
      const split = tm ? `: ${Math.max(0, ms - tm.startMs - tm.xlateMs - tm.convertMs).toFixed(0)} queued, ${tm.startMs.toFixed(0)} runtime start, ${tm.xlateMs.toFixed(0)} translator` +
        ` (a batch of ${tm.batch}), ${tm.convertMs.toFixed(0)} pass + naga` : "";
      this.log(`shader ${key} arrived from ${from} after ${ms.toFixed(0)} ms${split} (${got.wgsl.length} bytes of WGSL)`);
      this.gfx.rt.requestWake();
    })());
  }
  // At each present: the keys the frame's draws were skipped for go to the front of the translator's queue
  waited(): void {
    const tr = this.o.translator;
    if (!tr?.prioritize || !this.gfx.host.shaderWaited) return;
    for (const k of this.gfx.host.shaderWaited()) if (this.state.get(k) === "pending") { tr.prioritize(k); this.stats.prioritized++; }
  }
  private register(key: string, t: Translated, from: string): boolean {
    const r = t.reflection;
    if (r.extra?.length) return this.fail(key, `${from} has it with bindings src/gfx does not provide: ${r.extra.map(x => x.kind).join(", ")}`);
    if (this.gfx.host.registerShader(key, { ...r, entry: r.entry ?? "main", wgsl: t.wgsl } as any) < 0) return this.fail(key, "registerShader refused the record");
    this.state.set(key, "ready"); this.stats.registered++;
    return true;
  }
  // one red line a key
  private fail(key: string, why: string): false {
    this.state.set(key, "failed"); this.stats.failed++;
    this.gfx.host.shaderPending(key, "failed");   // this line is the report: the recorder adds none of its own
    const ndve = ndveRole(key);
    this.log(`[RED] shader ${key}: ${why}; its draws are skipped${ndve ? ` (${ndve}: the movie's picture is not drawn)` : ""}`);
    return false;
  }
}

// ---- the in-page translator: Workers of their own (rt_shader_worker.ts, bundled as a module) ----
// Stages wait in one queue here, in the order they were asked for, until a Worker is free; a free Worker takes up to
// `batch` of them for one run of the translator. `prioritize` moves a key a draw waits on to the front. Each Worker
// has its own .NET runtime (started when there is work for it), so `workers` of them translate at once.
export const SHADER_CHAIN = "nxweb-shaders-1/page";
export interface WorkerTranslatorOptions { worker: string | URL; framework: string; naga: string; chain?: string; workers?: number; batch?: number }
export const defaultShaderWorkers = (): number => Math.max(1, Math.min(4, Math.floor(((globalThis as any).navigator?.hardwareConcurrency ?? 2) / 2)));
export function workerTranslator(o: WorkerTranslatorOptions): ShaderTranslator & { prioritize(key: string): void; stats: ShaderWorkerStats } {
  type Call = { id: number; key: string; control: Uint8Array; code: Uint8Array; res: (t: Translated) => void; rej: (e: Error) => void };
  type W = { w: Worker; bc: BroadcastChannel; up: boolean; busy: Map<number, Call> };
  const nMax = Math.max(1, o.workers ?? defaultShaderWorkers()), batch = Math.max(1, o.batch ?? 4);
  const pool: W[] = [], queue: Call[] = [], stats = { workers: nMax, started: 0, batches: 0, maxQueued: 0 };
  let seq = 0, closed = false;
  const pump = (): void => {
    for (const x of pool) {
      if (!queue.length) return;
      if (!x.up || x.busy.size) continue;
      const take = queue.splice(0, batch);
      for (const c of take) x.busy.set(c.id, c);
      stats.batches++;
      x.bc.postMessage({ batch: take.map(c => ({ id: c.id, key: c.key, control: c.control, code: c.code })) });
    }
    // more work than Workers that are up or starting: one more
    if (queue.length > pool.filter(x => !x.up).length * batch && pool.length < nMax) start();
  };
  const drop = (x: W, why: string): void => {
    x.w.terminate(); x.bc.close();
    pool.splice(pool.indexOf(x), 1);
    for (const c of x.busy.values()) c.rej(new Error(why));
    x.busy.clear();
    // the queue is another Worker's, unless none can start
    if (!pool.length) { for (const c of queue.splice(0)) c.rej(new Error(why)); }
  };
  const start = (): void => {
    // a Worker is talked to over a BroadcastChannel named like it (rt_shader_worker.ts says why)
    const name = "nxweb-shaders-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const x: W = { w: null as unknown as Worker, bc: new BroadcastChannel(name), up: false, busy: new Map() };
    pool.push(x); stats.started++;
    x.bc.onmessage = ev => {
      const m = ev.data;
      if (m.ready) { x.up = true; x.bc.postMessage({ init: { framework: o.framework, naga: o.naga } }); pump(); return; }
      const c = x.busy.get(m.id);
      if (!c || (m.wgsl === undefined && m.error === undefined)) return;
      x.busy.delete(m.id);
      if (m.error !== undefined) c.rej(new Error(m.error)); else c.res({ wgsl: m.wgsl, reflection: m.reflection, timing: m.timing } as Translated);
      if (!x.busy.size) pump();
    };
    x.w = new Worker(o.worker, { type: "module", name });
    x.w.onerror = ev => drop(x, "the shader translator's Worker failed: " + (ev.message || "it could not be started"));
  };
  return {
    chain: o.chain ?? SHADER_CHAIN,
    stats,
    translate: blob => new Promise((res, rej) => {
      if (closed) { rej(new Error("the shader translator was closed")); return; }
      queue.push({ id: ++seq, key: blob.key, control: blob.control, code: blob.code, res, rej });
      stats.maxQueued = Math.max(stats.maxQueued, queue.length);
      if (!pool.length) start();
      pump();
    }),
    prioritize: key => {
      const i = queue.findIndex(c => c.key === key);
      if (i > 0) queue.unshift(...queue.splice(i, 1));
    },
    close: () => {
      closed = true;
      for (const x of [...pool]) drop(x, "the shader translator was closed");
      for (const c of queue.splice(0)) c.rej(new Error("the shader translator was closed"));
    },
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
