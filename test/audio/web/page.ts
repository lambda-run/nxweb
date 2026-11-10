// audio:browser, the page's side: the AudioContext half of the device (AudioDeviceMain), the Worker, and the
// analysis of what the worklet put out. The Node script (browser.mts) drives it through window.nx.
import { AudioDeviceMain } from "../../../src/glue/audio_device_main.ts";
import { analyzeTone, fitSine } from "../analyze.ts";

let worker: Worker, main: AudioDeviceMain;
let seq = 0;
const waiting = new Map<number, (r: unknown) => void>();
let ready: (v: { transport: string }) => void;

const nx = {
  async init(cfg: Record<string, unknown>, fn: Record<string, number>): Promise<unknown> {
    worker = new Worker("/worker.js");
    main = new AudioDeviceMain((m, t) => worker.postMessage(m, t ?? []), { sampleRate: cfg.sampleRate as number | undefined, watchVisibility: false });
    worker.onmessage = e => {
      const m = e.data;
      if (main.handle(m)) return;
      if (m.ready) ready(m);
      else if (m.id) { waiting.get(m.id)?.(m.result); waiting.delete(m.id); }
    };
    worker.onerror = e => { (window as unknown as { fatal: string }).fatal = String(e.message); };
    const r = await new Promise<{ transport: string }>(res => { ready = res; worker.postMessage({ cmd: "init", cfg, fn }); });
    return { ...r, isolated: crossOriginIsolated };
  },
  ask(cmd: string, extra: Record<string, unknown> = {}): Promise<any> {   // eslint-disable-line @typescript-eslint/no-explicit-any
    return new Promise(res => { const id = ++seq; waiting.set(id, res); worker.postMessage({ cmd, id, ...extra }); });
  },
  context(): string { return main.ctx?.state ?? "none"; },
  contextRate(): number { return main.ctx?.sampleRate ?? 0; },
  record(seconds: number): void { main.record(Math.ceil(seconds * (main.ctx?.sampleRate ?? 48000))); },
  setHidden(h: boolean): void { main.setHidden(h); },
  // the browser suspends the context behind the device's back
  async suspendBehind(): Promise<void> { await main.ctx!.suspend(); },
  sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); },
  // What the worklet put out since record(): the left channel analysed for a tone; parts: [from, to] in seconds to analyse separately
  async heard(freq: number, parts: [number, number][] = [], wav = false): Promise<unknown> {
    const d = await main.dump(), n = d.frames, left = new Float32Array(n);
    let differ = 0;
    for (let i = 0; i < n; i++) { left[i] = d.dump[2 * i]; if (d.dump[2 * i] !== d.dump[2 * i + 1]) differ++; }
    const whole = analyzeTone(left, freq, d.sampleRate);
    // the sounding stretches: split at silences of 20 ms or more
    const stretches: { from: number; to: number; freq: number; snr: number; amp: number }[] = [];
    const minGap = Math.round(d.sampleRate * 0.02);
    for (let i = 0; i < n;) {
      while (i < n && left[i] === 0) i++;
      if (i >= n) break;
      const from = i;
      let lastSound = i;
      for (; i < n && i - lastSound < minGap; i++) if (left[i] !== 0) lastSound = i;
      const to = lastSound + 1;
      if (to - from > 256) { const r = analyzeTone(left, freq, d.sampleRate, from, to), f = fitSine(left, from, to, freq, d.sampleRate); stretches.push({ from, to, freq: r.freq, snr: f.snr, amp: f.amp }); }
    }
    const out: Record<string, unknown> = { rate: d.sampleRate, frames: n, whole, stretches, channelsDiffer: differ, underrun: d.underrun, callbacks: d.callbacks,
      parts: parts.map(([a, b]) => analyzeTone(left, freq, d.sampleRate, Math.round(a * d.sampleRate), Math.min(n, Math.round(b * d.sampleRate)))) };
    if (wav) { const pcm = new Int16Array(n); for (let i = 0; i < n; i++) pcm[i] = Math.round(left[i] * 32767); out.pcm = Array.from(pcm); }
    return out;
  },
  analyzePcm(pcm: number[], freq: number, rate: number, from: number, to: number): unknown { return analyzeTone(Float32Array.from(pcm, v => v / 32768), freq, rate, from, to); },
};
(window as unknown as { nx: typeof nx }).nx = nx;
