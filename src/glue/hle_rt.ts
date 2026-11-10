// nxweb take-over table attached to a Runtime: every name of the hle module (src/hle) is registered with the loader
// (forced or weak, as nxnative's HLE_FORCE / HLE), a call from translated code lands in hle_call, and what the module
// asks of the outside (HleEnv) is answered from the kernel, the loader and the embedder's front end.
//
//   const hle = attachHle(rt, hleSharedModule, { front, config: { lang: "en-US" } });   // before rt.loadNso()
//
// hleSharedModule is build/hle/hle.shared.wasm built by hleBuildShared(out, base) (src/hle/host/build.mts) with its
// static data in a range of the host area the runtime owner gives it (about 400 KB; see src/hle/README.md "Requests").
// NOT RUN YET: this file is type-checked against the runtime's interfaces but no test loads a guest through it;
// test/hle drives the same HleHost through a fake outside. What it cannot do with today's Runtime is listed in
// src/hle/README.md.
import type { Runtime, HostCpu, HostResult } from "./rt_runtime.ts";
import { HleHost, type HleEnv, type HleEntry, type HleResult, type TextRequest } from "./hle_host.ts";

// The front end's side: everything is optional; without it the take-overs answer as nxnative does windowless
export interface HleFront {
  textRequest?(req: TextRequest, answer: (text: string | null | { noWindow: true }) => void): void;   // the input box
  webOpen?(path: string, callback: string, hidden: boolean, keyRepeatDelay: number, keyRepeatPulse: number): number;   // 0 shown, 1 not found, 2 no view
  webShow?(): void; webSend?(message: Uint8Array): void; webClose?(): void;
  inputHold?(on: boolean): void;
  vsync?(tick: () => boolean): void;                          // call tick() at every vertical blank until it returns false
  connectedNpad?(): number;
  nativeImageBlank?(w: number, h: number): number; nativeImageBlankFree?(handle: number): void;
  exitRequest?(reason: string, value: bigint, bytes: Uint8Array, done: () => void): void;   // stop audio and graphics, then done()
  timeZone?(posixSeconds: bigint): { offset: number; dst: boolean; name: string };
  realNs?(): bigint; monoNs?(): bigint;
  hostAlloc?(size: bigint): bigint;                           // guest-addressable host memory (font engine work buffers)
}
export interface HleRtOptions { front?: HleFront; config?: Parameters<HleHost["config"]>[0]; scratch?: number }

export function attachHle(rt: Runtime, module: WebAssembly.Module, o: HleRtOptions = {}): HleHost {
  const front = o.front ?? {};
  let cur: HostCpu | null = null;   // the cpu of the take-over that is running (guest calls go to its thread)
  let host!: HleHost;
  const jsZone = (t: bigint) => {
    const d = new Date(Number(t) * 1000), off = -d.getTimezoneOffset() * 60;
    const jan = -new Date(d.getFullYear(), 0, 1).getTimezoneOffset() * 60, jul = -new Date(d.getFullYear(), 6, 1).getTimezoneOffset() * 60;
    const name = /\(([^)]+)\)$/.exec(d.toString())?.[1]?.split(" ").map(w => w[0]).join("") ?? "UTC";
    return { offset: off, dst: jan !== jul && off === Math.max(jan, jul), name: off === 0 && jan === jul ? "UTC" : name };
  };
  const guestSym = (name: string): bigint => {
    // a module's own definition, never a stub of the host (a forced take-over forwards to "the SDK's own" function)
    for (const m of rt.modules) { const a = rt.ld.lookupIn(m.handle, name); if (a !== undefined && rt.ld.stubId(a) < 0) return BigInt(a); }
    return 0n;
  };
  const env: HleEnv = {
    log: l => rt.log(l),
    guestNs: () => rt.guestNs(),
    monoNs: () => front.monoNs?.() ?? BigInt(Math.round(performance.now() * 1e6)),
    realNs: () => front.realNs?.() ?? BigInt(Date.now()) * 1_000_000n,
    timeZone: t => front.timeZone?.(t) ?? jsZone(t),
    entropy: out => { for (let i = 0; i < out.length; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(out.length, i + 65536)) as Uint8Array<ArrayBuffer>); },
    eventNew: () => { const p = o.scratch ?? ((rt.r.rt_scratch_ptr() >>> 0) + 3080); const r = rt.k.kernel_event_new(p) >>> 0; return { r, w: new DataView(rt.memory.buffer).getUint32(p, true) }; },
    eventSignal: h => rt.k.kernel_event_signal(h) !== 0,
    eventClear: h => rt.k.kernel_event_clear(h) !== 0,
    eventDupReadable: h => rt.k.kernel_event_dup_readable(h) >>> 0,
    guestSym,
    guestCall: (fn, args) => {
      if (!cur) { rt.log("[RED] hle: a guest call outside a take-over (no guest thread to run it on): answered 0"); return 0n; }
      return cur.call(fn, ...args);
    },
    moduleOf: a => rt.modules.findIndex(m => a >= BigInt(m.base) && a < BigInt(m.base + m.imageSize)),
    stubAddr: (id, name) => BigInt(rt.lateStub(name, cpu => invoke(cpu, id))),
    hostAlloc: n => { const a = front.hostAlloc?.(n) ?? 0n; if (!a) rt.log(`[RED] hle: no host memory for ${n} bytes (HleFront.hostAlloc)`); return a; },
    clockFreeze: (reason, on) => rt.freezeClock(reason, on),
    textRequest: req => { if (front.textRequest) front.textRequest(req, t => { host.textAnswer(t); }); else host.textAnswer({ noWindow: true }); },
    webOpen: (p, c, h, d, pu) => front.webOpen?.(p, c, h, d, pu) ?? 2,
    webShow: () => front.webShow?.(), webSend: m => front.webSend?.(m), webClose: () => front.webClose?.(),
    inputHold: on => front.inputHold?.(on),
    vsyncEvent: binding => { if (front.vsync) front.vsync(() => host.vsyncTick(binding)); else rt.log("[RED] hle: a vsync event was handed out and nothing ticks it (HleFront.vsync)"); },
    connectedNpad: () => front.connectedNpad?.() ?? 0,
    nativeImageBlank: (w, h) => front.nativeImageBlank?.(w, h) ?? 0, nativeImageBlankFree: h => front.nativeImageBlankFree?.(h),
    exitRequest: (reason, value, bytes) => {
      if (front.exitRequest) front.exitRequest(reason, value, bytes, () => host.exitDone());
      else { rt.kill(); host.exitDone(); }
    },
  };
  host = new HleHost(module, env, rt.memory);
  if (o.config) host.config(o.config);

  const finish = (cpu: HostCpu, id: number, r: HleResult): HostResult => {
    if (r.wait) {
      const pend = host.pending(id);
      return cpu.block(r.wait.handle, r.wait.timeoutNs, (how, c) => { cur = c; try { return finish(c, id, host.resume(pend, how)); } finally { cur = null; } });
    }
    // The process is ending (an abort, ExecuteProgram): the thread must not go on. Unverified: the runtime has no
    // "this thread never continues" result for a host function; giving the core up is the nearest thing today
    if (r.noReturn) return cpu.jump(0xFFFF_FFE0);
    if (r.x1 !== undefined) cpu.setX(1, r.x1);
    if (r.d0 !== undefined) setD0(cpu, r.d0);
    return r.x0;
  };
  // A float result: the runtime has no way yet to write v0 from a host function (src/runtime/README.md, Gaps)
  let d0Red = false;
  const setD0 = (cpu: HostCpu, bits: bigint) => {
    const c = cpu as HostCpu & { setD?: (i: number, bits: bigint) => void };
    if (c.setD) c.setD(0, bits);
    else if (!d0Red) { d0Red = true; rt.log("[RED] hle: a take-over returned a floating point value and the runtime cannot write d0 (request: HostCpu.setD)"); }
  };
  function invoke(cpu: HostCpu, id: number): HostResult {
    const prev = cur; cur = cpu;
    try {
      const a = cpu.args() >>> 0, dv = cpu.dv(), x: bigint[] = [], d: bigint[] = [];
      for (let i = 0; i < 8; i++) { x.push(dv.getBigUint64(a + 8 * i, true)); d.push(dv.getBigUint64(a + 64 + 8 * i, true)); }
      return finish(cpu, id, host.call(id, { x, d, x8: cpu.x(8), lr: cpu.lr }));
    } finally { cur = prev; }
  }
  const use = (e: HleEntry) => !e.internal && !e.shadowed && !e.duplicate;
  for (const e of host.entries()) if (use(e)) rt.register({ name: e.name, forced: e.forced, fn: cpu => invoke(cpu, e.id) });
  return host;
}
