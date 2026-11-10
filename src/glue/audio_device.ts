// The audio device, runtime side (the thread the audio module runs on, usually a Worker): the module's
// audio_dev_start / audio_dev_stop, the reports of the page side (audio_device_main.ts), and the transport of the
// ring to the AudioWorklet:
//   "direct"   the process memory is a SharedArrayBuffer: the worklet reads the module's ring in place
//   "sab"      cross-origin isolated, the process memory is not shared: a SharedArrayBuffer of the device's own,
//              into which every tick copies what the module wrote
//   "message"  no SharedArrayBuffer: the frames go to the worklet by messages over a MessageChannel of its own, and
//              the worklet reports back what it took
// Usage: new AudioDevice(host, send); embedder.device = it; it.handle(message) for messages of the page side;
// it.tick(guestNs, hostNs) wherever the embedder would call host.tick.
import { AudioHost, RING, type AudioDeviceLike } from "./audio_host.ts";

export type AudioTransport = "direct" | "sab" | "message";
export interface AudioDeviceOptions {
  transport?: AudioTransport;   // default: the best one available
  sampleRate?: number;          // passed to the page side (see AudioDeviceMainOptions.sampleRate)
  targetFrames?: number;        // frames the mixer keeps ahead of the device; default 40 ms
}
type Send = (m: { audio: Record<string, unknown> }, transfer?: Transferable[]) => void;

export class AudioDevice implements AudioDeviceLike {
  transport: AudioTransport;
  rate = 0;
  context = "none";             // the AudioContext's state as last reported
  hidden = false;
  error = "";
  private sab: SharedArrayBuffer | null = null;
  private sh: Int32Array | null = null; private sd: Float32Array | null = null;
  private port: MessagePort | null = null;
  private report: { rd: number; cb: number; under: number } | null = null;
  private sent = 0;             // frames of the module's ring already handed on (sab, message)
  private live = -1;
  private host: AudioHost; private send: Send; private o: AudioDeviceOptions;

  constructor(host: AudioHost, send: Send, o: AudioDeviceOptions = {}) {
    this.host = host; this.send = send; this.o = o;
    const x = host.x, cap = x.audio_ring_cap();
    const haveSab = typeof SharedArrayBuffer !== "undefined";
    this.transport = o.transport ?? (haveSab && x.memory.buffer instanceof SharedArrayBuffer ? "direct" : haveSab && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ? "sab" : "message");
    const open: Record<string, unknown> = { cmd: "open", cap, sampleRate: o.sampleRate };
    const transfer: Transferable[] = [];
    if (this.transport === "direct") { open.sab = x.memory.buffer; open.hdr = x.audio_ring_ptr() >>> 0; open.data = x.audio_ring_data() >>> 0; }
    else if (this.transport === "sab") {
      this.sab = new SharedArrayBuffer(32 + cap * 8);
      this.sh = new Int32Array(this.sab, 0, 8); this.sd = new Float32Array(this.sab, 32, cap * 2);
      this.sh[RING.CAP] = cap;
      open.sab = this.sab; open.hdr = 0; open.data = 32;
    } else {
      const ch = new MessageChannel();
      this.port = ch.port1;
      this.port.onmessage = e => { this.report = e.data; };
      open.port = ch.port2; transfer.push(ch.port2);
    }
    send({ audio: open }, transfer);
  }

  // A message of the page side; false when it is not one
  handle(m: unknown): boolean {
    const a = (m as { audio?: Record<string, unknown> } | null)?.audio;
    if (!a || !a.ev) return false;
    const x = this.host.x;
    if (a.ev === "open") {
      this.rate = a.rate as number; this.error = (a.error as string) ?? "";
      this.sent = 0; this.report = null;
      x.audio_device_attach(this.rate, this.rate ? this.o.targetFrames ?? 0 : 0);
      if (this.error) this.host.embedder.log(`[RED] audio: no device (${this.error}): every output plays on the silent sink`);
    } else if (a.ev === "state") { this.context = a.context as string; x.audio_device_state(a.state as number); }
    else if (a.ev === "hidden") { this.hidden = !!a.hidden; x.audio_suspend(a.hidden ? 1 : 0); }
    return true;
  }
  start(): void { this.send({ audio: { cmd: "start" } }); }
  stop(): void { this.send({ audio: { cmd: "stop" } }); }
  // The process that used the device is gone: the page side closes its AudioContext (the next process opens its own)
  close(): void { if (this.closed) return; this.closed = true; this.port?.close(); this.port = null; this.send({ audio: { cmd: "close" } }); }
  private closed = false;

  // What the worklet did since the last tick, into the module's ring header
  private before(): void {
    if (this.transport === "direct" || !this.rate) return;
    const h = this.host.ringHeader();
    if (this.sh) { h[RING.RD] = Atomics.load(this.sh, RING.RD); h[RING.UNDER] = Atomics.load(this.sh, RING.UNDER); h[RING.CB] = Atomics.load(this.sh, RING.CB); }
    else if (this.report) { h[RING.RD] = this.report.rd; h[RING.UNDER] = this.report.under; h[RING.CB] = this.report.cb; }
  }
  // What the module wrote in this tick, on to the worklet
  private after(): void {
    if (this.transport === "direct" || !this.rate) return;
    const h = this.host.ringHeader(), d = this.host.ringData(), cap = h[RING.CAP], wr = h[RING.WR], live = h[RING.LIVE];
    const n = (wr - this.sent) >>> 0;
    if (this.sh && this.sd) {
      for (let i = 0; i < n; i++) { const p = (((this.sent + i) >>> 0) & (cap - 1)) << 1; this.sd[p] = d[p]; this.sd[p + 1] = d[p + 1]; }
      // `live` (an empty ring is an underrun) rises only after the frames are there, and falls before anything else
      if (live > (this.live < 0 ? 0 : this.live)) { Atomics.store(this.sh, RING.WR, wr); Atomics.store(this.sh, RING.LIVE, live); }
      else { Atomics.store(this.sh, RING.LIVE, live); Atomics.store(this.sh, RING.WR, wr); }
    } else if (this.port) {
      if (n) {
        const pcm = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) { const p = (((this.sent + i) >>> 0) & (cap - 1)) << 1; pcm[2 * i] = d[p]; pcm[2 * i + 1] = d[p + 1]; }
        this.port.postMessage({ pcm, live }, [pcm.buffer]);
      } else if (live !== this.live) this.port.postMessage({ live });
    }
    this.sent = wr; this.live = live;
  }
  tick(guestNs: bigint, hostNs: bigint): void { this.before(); this.host.tick(guestNs, hostNs); this.after(); }
}
