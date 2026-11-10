// The audio device, page side: the AudioContext and its AudioWorkletNode. An AudioContext exists only on the main
// thread, the runtime (and the audio module) usually in a Worker: AudioDevice (audio_device.ts) is the other half,
// and the two talk by messages tagged { audio: ... } over whatever channel the embedder has (worker.postMessage, or
// a direct call when both are on the main thread).
//
// What the browser decides is reported, never waited for: resume() is asked and "starting" reported at once; the
// context runs when the browser lets it (after a user gesture), stops when the browser stops it.
import { workletSource } from "./audio_worklet.ts";

export const DEV = { NONE: 0, STARTING: 1, RUNNING: 2, FAILED: 3, LOST: 4 };

export interface AudioDeviceMainOptions {
  // The context's sample rate: 48000 by default (the browser then resamples to the hardware, and the module's own
  // resampler is a copy); 0 takes the hardware's rate and the module resamples
  sampleRate?: number;
  latencyHint?: AudioContextLatencyCategory | number;
  // Where user gestures are listened for to resume a context that waits for one; null: the embedder calls gesture()
  gestureTarget?: EventTarget | null;
  // false: the embedder reports visibility itself (setHidden)
  watchVisibility?: boolean;
}
type Send = (m: { audio: Record<string, unknown> }, transfer?: Transferable[]) => void;

export class AudioDeviceMain {
  ctx: AudioContext | null = null;
  node: AudioWorkletNode | null = null;
  private wanted = false;       // the module asked for the device (audio_dev_start) and has not stopped it
  private ran = false;          // it has run since it was last asked
  private dumps: ((d: { dump: Float32Array; frames: number; sampleRate: number; underrun: number; callbacks: number }) => void)[] = [];
  private send: Send; private o: AudioDeviceMainOptions;
  // Resolves when the context and its worklet exist (or could not be made)
  opened: Promise<void>;
  private openDone!: () => void;

  constructor(send: Send, o: AudioDeviceMainOptions = {}) {
    this.send = send; this.o = o;
    this.opened = new Promise(r => { this.openDone = r; });
    const target = o.gestureTarget === undefined ? (typeof document !== "undefined" ? document : null) : o.gestureTarget;
    if (target) for (const type of ["pointerdown", "keydown", "touchend"]) target.addEventListener(type, () => this.gesture(), { capture: true, passive: true } as AddEventListenerOptions);
    if (o.watchVisibility !== false && typeof document !== "undefined") document.addEventListener("visibilitychange", () => this.setHidden(document.hidden));
  }

  // A message of the other half; false when it is not one
  handle(m: unknown): boolean {
    const a = (m as { audio?: Record<string, unknown> } | null)?.audio;
    if (!a || !a.cmd) return false;
    if (a.cmd === "open") void this.open(a);
    else if (a.cmd === "start") this.start();
    else if (a.cmd === "stop") this.stop();
    else if (a.cmd === "close") this.close();
    return true;
  }

  // The runtime side went away (its process ended): the context and its node are released. Nothing is reported:
  // there is nobody to report to. A later "open" makes a new context.
  close(): void {
    const ctx = this.ctx, node = this.node;
    this.ctx = null; this.node = null; this.wanted = false; this.ran = false; this.serial++;
    try { node?.disconnect(); } catch { /* gone */ }
    if (ctx) { ctx.onstatechange = null; void ctx.close().catch(() => { /* closed already */ }); }
  }
  private serial = 0;   // which open the context belongs to: an open that finishes after a close or a newer open is dropped
  private async open(a: Record<string, unknown>): Promise<void> {
    if (this.ctx) this.close();   // a second process on the same page: one context at a time
    const serial = ++this.serial;
    try {
      const want = (a.sampleRate as number | undefined) ?? this.o.sampleRate ?? 48000;
      const hint = this.o.latencyHint ?? "interactive";
      try { this.ctx = new AudioContext(want ? { sampleRate: want, latencyHint: hint } : { latencyHint: hint }); }
      catch { this.ctx = new AudioContext({ latencyHint: hint }); }   // a rate the browser does not take: its own
      const ctx = this.ctx;
      const url = URL.createObjectURL(new Blob([workletSource()], { type: "text/javascript" }));
      try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      if (serial !== this.serial) { void ctx.close().catch(() => { /* closed already */ }); return; }
      this.node = new AudioWorkletNode(ctx, "nx-audio", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { sab: a.sab, hdr: a.hdr, data: a.data, cap: a.cap } });
      this.node.port.onmessage = e => { if (e.data.dump) this.dumps.shift()?.(e.data); };
      if (a.port) this.node.port.postMessage({ port: a.port }, [a.port as MessagePort]);   // the runtime's own line to the worklet
      this.node.connect(ctx.destination);
      ctx.onstatechange = () => this.report();
      this.send({ audio: { ev: "open", rate: ctx.sampleRate, baseLatency: ctx.baseLatency ?? 0 } });
      // Where autoplay is allowed a new context runs at once: it only runs while an output wants it
      if (this.wanted) this.start(); else if (ctx.state === "running") void ctx.suspend().catch(() => { /* closed */ });
    } catch (e) {
      if (serial === this.serial) this.send({ audio: { ev: "open", rate: 0, error: String(e) } });
    }
    this.openDone();
  }
  private state(s: number): void { this.send({ audio: { ev: "state", state: s, context: this.ctx?.state ?? "none" } }); }
  private report(): void {
    const ctx = this.ctx;
    if (!ctx || !this.wanted) return;
    if (ctx.state === "running") { this.ran = true; this.state(DEV.RUNNING); }
    else if (this.ran) { this.ran = false; this.state(DEV.LOST); }   // the browser suspended, interrupted or closed it
    else this.state(DEV.STARTING);
  }
  private start(): void {
    this.wanted = true;
    const ctx = this.ctx;
    if (!ctx) return;   // open() goes on from here
    this.ran = false;
    if (ctx.state === "running") { this.ran = true; this.state(DEV.RUNNING); return; }
    this.state(DEV.STARTING);
    // Pending until the browser allows audio (a user gesture); statechange reports the rest
    ctx.resume().then(() => this.report(), () => { if (this.wanted) this.state(DEV.FAILED); });
  }
  private stop(): void {
    this.wanted = false; this.ran = false;
    void this.ctx?.suspend().catch(() => { /* closed */ });
    this.state(DEV.NONE);
  }
  // A user gesture happened: a context that waits for one may run now
  gesture(): void {
    if (this.wanted && this.ctx && this.ctx.state !== "running") this.ctx.resume().then(() => this.report(), () => { /* still not allowed */ });
  }
  setHidden(hidden: boolean): void { this.send({ audio: { ev: "hidden", hidden } }); }

  // What the worklet put out, from record(frames) on (tests, a scope)
  record(frames: number): void { this.node?.port.postMessage({ record: frames }); }
  dump(): Promise<{ dump: Float32Array; frames: number; sampleRate: number; underrun: number; callbacks: number }> {
    return new Promise(r => { this.dumps.push(r); this.node!.port.postMessage({ dump: 1 }); });
  }
}
