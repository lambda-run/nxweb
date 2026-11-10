// nxweb take-over table attached to a Runtime: every name of the hle module (src/hle) is registered with the loader
// (forced or weak, as nxnative's HLE_FORCE / HLE), a call from translated code lands in hle_call, and what the module
// asks of the outside (HleEnv) is answered from the kernel, the loader and the embedder's front end.
//
//   const hle = attachHle(rt, hleSharedModule, { front, config: { lang: "en-US" } });   // before rt.loadNso()
//
// hleSharedModule is build/hle/hle.shared.wasm built by hleBuildShared(out, base) (src/hle/host/build.mts) with its
// static data in a range of the host area the runtime owner gives it (about 400 KB; see src/hle/README.md "Requests").
// Run by test/runtime (more_cases.ts, "hle": the guest hleg.c calls take-overs of oe, time, account, nifm, socket
// and libc by their mangled names); test/hle drives the same HleHost through a fake outside.
import type { Runtime, HostCpu, HostResult } from "./rt_runtime.ts";
import { range } from "./rt_layout.ts";
import { HleHost, type HleEnv, type HleEntry, type HleResult, type TextRequest, type VibrationState } from "./hle_host.ts";

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
  // The controller applet's prompt for too few players: show it and call answer(true = enough players and OK,
  // false = closed) then or later. Returns false when there is no window (the applet answers as the player closing it)
  ctrlPrompt?(min: number, max: number, answer: (ok: boolean) => void): boolean;
  vibration?(state: VibrationState): void;                    // a player's motors changed (the Gamepad API's vibrationActuator)
  joyMouseWanted?(on: boolean): void;
}
// What the graphics glue offers nn::vi (RtGfx implements it): the layer's shape for the present, the frame count and
// the present queue, and a report of every present the game queues
export interface HleGfx {
  viLayer(w: number, h: number): void; viCrop(x: number, y: number, w: number, h: number): void;
  viFrameCount(): bigint; viPresentProgress(): { queued: bigint; done: bigint }; viPresentedNs(ticket: bigint): bigint;
  onPresentQueued(fn: (frames: number) => void): void;
}
export interface HleRtOptions { front?: HleFront; config?: Parameters<HleHost["config"]>[0]; scratch?: number; gfx?: HleGfx }

export function attachHle(rt: Runtime, module: WebAssembly.Module, o: HleRtOptions = {}): HleHost {
  const front = o.front ?? {};
  let cur: HostCpu | null = null;   // the cpu of the take-over that is running (guest calls go to its thread)
  let host!: HleHost;
  const once = new Set<string>(), redOnce = (key: string, line: string) => { if (!once.has(key)) { once.add(key); rt.log("[RED] " + line); } };
  // nn::ro and nn::jit: the module's token is the image's guest base
  const roHandle = new Map<bigint, number>();
  const ticks: (() => boolean)[] = [];   // vsync events handed out: ticked at every present when graphics are attached
  const gfx = o.gfx;
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
    eventNew: () => { const p = o.scratch ?? (rt.r.rt_scratch_ptr() + 3080); const r = rt.k.kernel_event_new(p) >>> 0; return { r, w: new DataView(rt.memory.buffer).getUint32(p, true) }; },
    eventSignal: h => { const ok = rt.k.kernel_event_signal(h) !== 0; rt.requestWake(); return ok; },
    eventClear: h => rt.k.kernel_event_clear(h) !== 0,
    eventDupReadable: h => rt.k.kernel_event_dup_readable(h) >>> 0,
    guestSym,
    // on the thread of the take-over that is running, or of whatever host function runs now (another area binding a
    // SystemEvent through this table: audio); more than eight arguments go on the guest stack (Runtime.guestCall)
    guestCall: (fn, args) => {
      if (!cur && !rt.inHostCall) { rt.log("[RED] hle: a guest call outside a host function (no guest thread to run it on): answered 0"); return 0n; }
      return rt.guestCall(fn, args);
    },
    moduleOf: a => rt.modules.findIndex(m => a >= BigInt(m.base) && a < BigInt(m.base + m.imageSize)),
    stubAddr: (id, name) => BigInt(rt.lateStub(name, cpu => invoke(cpu, id))),
    hostAlloc: n => { const a = front.hostAlloc?.(n) ?? BigInt(rt.hostAlloc(Number(n))); if (!a) rt.log(`[RED] hle: no host memory for ${n} bytes`); return a; },
    clockFreeze: (reason, on) => rt.freezeClock(reason, on),
    textRequest: req => { if (front.textRequest) front.textRequest(req, t => { host.textAnswer(t); }); else host.textAnswer({ noWindow: true }); },
    webOpen: (p, c, h, d, pu) => front.webOpen?.(p, c, h, d, pu) ?? 2,
    webShow: () => front.webShow?.(), webSend: m => front.webSend?.(m), webClose: () => front.webClose?.(),
    inputHold: on => front.inputHold?.(on),
    vsyncEvent: binding => {
      if (front.vsync) front.vsync(() => host.vsyncTick(binding));
      else if (gfx) ticks.push(() => host.vsyncTick(binding));
      else rt.log("[RED] hle: a vsync event was handed out and nothing ticks it (HleFront.vsync, or graphics attached)");
    },
    connectedNpad: () => front.connectedNpad?.() ?? 0,
    nativeImageBlank: (w, h) => front.nativeImageBlank?.(w, h) ?? 0, nativeImageBlankFree: h => front.nativeImageBlankFree?.(h),
    exitRequest: (reason, value, bytes) => {
      if (front.exitRequest) front.exitRequest(reason, value, bytes, () => host.exitDone());
      else {
        // the process machine's Exit: 0 for a shutdown the host asked for or a program handing over, 1 for an abort
        rt.requestExit(reason === "abort" ? 1 : 0); host.exitDone();
      }
    },
    // ---- controllers ----
    stackArg: i => { const sp = rt.addr(rt.core.sp.value); return rt.dv().getBigUint64(sp + 8 * i, true); },
    ctrlPrompt: front.ctrlPrompt ? (min, max) => front.ctrlPrompt!(min, max, ok => { host.ctrlAnswer(ok); rt.requestWake(); }) : undefined,
    vibration: front.vibration ? s => front.vibration!(s) : undefined,
    joyMouseWanted: on => front.joyMouseWanted?.(on),
    // ---- nn::vi's present side: the graphics glue ----
    viLayer: gfx ? (w, h) => gfx.viLayer(w, h) : undefined,
    viCrop: gfx ? (x, y, w, h) => gfx.viCrop(x, y, w, h) : undefined,
    viFrameCount: gfx ? () => gfx.viFrameCount() : undefined,
    viPresentProgress: gfx ? () => gfx.viPresentProgress() : undefined,
    viPresentedNs: gfx ? t => gfx.viPresentedNs(t) : undefined,
    // ---- nn::ro, nn::jit: the loader and the translator ----
    roLoad: (image, size, _sha, alone) => {
      const a = Number(image);
      if (alone) redOnce("alone", "ro: a module to be linked against itself only (a JIT plugin) is relocated against the loaded modules: the loader has no such mode yet");
      try {
        const m = rt.loadModule(`nro@${a.toString(16)}`, rt.u8().slice(a, a + size));
        roHandle.set(BigInt(m.base), m.handle);
        return BigInt(m.base);
      } catch (e) { rt.log(`[RED] ro: ${(e instanceof Error ? e.message : String(e)).replace(/^\[RED\] /, "")}`); return 0n; }
    },
    roCalls: (token, kind) => {
      const h = roHandle.get(token); if (h === undefined) return [];
      const m = rt.ld.info(h);
      // as RoModule::CallInit / CallFini: DT_INIT (which in an SDK module runs its init_array), else the array itself
      return (kind === "init" ? (m.init ? [m.init] : m.initArray.filter(f => f)) : (m.fini ? [m.fini] : [...m.finiArray].reverse().filter(f => f))).map(BigInt);
    },
    roActivate: token => { const h = roHandle.get(token); if (h !== undefined) rt.activateModule(h); },
    roUnload: token => { const h = roHandle.get(token); if (h !== undefined) { rt.unloadModule(h); roHandle.delete(token); } },
    roLookupIn: (token, name) => { const h = roHandle.get(token); return h === undefined ? 0n : BigInt(rt.ld.lookupIn(h, name) ?? 0); },
    jitMemory: (rxSize, roSize) => rt.jitAlloc(Number(rxSize), Number(roSize)),
    jitCodeWritten: (rx, off, size) => rt.jitCodeWritten(Number(rx), Number(off), Number(size)),
    jitFree: (rx, rxSize, ro, roSize) => rt.jitFree(Number(rx), Number(rxSize), Number(ro), Number(roSize)),
  };
  host = new HleHost(module, env, rt.memory, rt.memImports);
  if (o.config) host.config(o.config);
  rt.onHandleClosed(h => host.handleClosed(h));
  if (gfx) gfx.onPresentQueued(frames => {
    host.viFrameQueued(BigInt(frames));
    for (let i = ticks.length - 1; i >= 0; i--) if (!ticks[i]()) ticks.splice(i, 1);
  });
  if (front.vibration) host.haptics({ output: true });
  rt.expectOutsideEvents();   // the front end's reports (focus, operation mode, an answer) signal events the guest waits on
  const st = range("hle static");
  if (rt.r.rt_static_check(97, BigInt(st.lo), BigInt(st.hi), BigInt(host.x.hle_static_end()))) throw new Error("runtime: the hle module's static data is outside its range (was it built with --memoryBase " + st.lo + "?)");

  const finish = (cpu: HostCpu, id: number, r: HleResult): HostResult => {
    if (r.wait) {
      const pend = host.pending(id);
      return cpu.block(r.wait.handle, r.wait.timeoutNs, (how, c) => { cur = c; try { return finish(c, id, host.resume(pend, how)); } finally { cur = null; } });
    }
    // The process is ending (an abort, ExecuteProgram): the thread must not go on
    if (r.noReturn) return cpu.never();
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
      const a = cpu.args(), dv = cpu.dv(), x: bigint[] = [], d: bigint[] = [];
      for (let i = 0; i < 8; i++) { x.push(dv.getBigUint64(a + 8 * i, true)); d.push(dv.getBigUint64(a + 64 + 8 * i, true)); }
      return finish(cpu, id, host.call(id, { x, d, x8: cpu.x(8), lr: cpu.lr }));
    } finally { cur = prev; }
  }
  const use = (e: HleEntry) => !e.internal && !e.shadowed && !e.duplicate;
  for (const e of host.entries()) if (use(e)) rt.register({ name: e.name, forced: e.forced, fn: cpu => invoke(cpu, e.id) });
  return host;
}
