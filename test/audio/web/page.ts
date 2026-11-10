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
    await main.opened;
    return { ...r, isolated: crossOriginIsolated };
  },
  ask(cmd: string, extra: Record<string, unknown> = {}): Promise<any> {   // eslint-disable-line @typescript-eslint/no-explicit-any
    return new Promise((res, rej) => {
      const id = ++seq;
      const timer = setTimeout(() => rej(new Error(`the worker did not answer "${cmd}" within 20 s`)), 20000);
      waiting.set(id, r => { clearTimeout(timer); res(r); });
      worker.postMessage({ cmd, id, ...extra });
    });
  },
  context(): string { return main.ctx?.state ?? "none"; },
  contextRate(): number { return main.ctx?.sampleRate ?? 0; },
  record(seconds: number): void { main.record(Math.ceil(seconds * (main.ctx?.sampleRate ?? 48000))); },
  setHidden(h: boolean): void { main.setHidden(h); },
  // the browser suspends the context behind the device's back
  async suspendBehind(): Promise<void> { await main.ctx!.suspend(); },
  sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); },
  // What the worklet put out since record(): the left channel analysed for a tone; parts: [from, to] in seconds to analyse separately
  async heard(freq: number, parts: [number, number][] = [], wav = false, amp = 0.5): Promise<unknown> {
    const d = await main.dump(), n = d.frames, left = new Float32Array(n);
    let differ = 0;
    for (let i = 0; i < n; i++) { left[i] = d.dump[2 * i]; if (d.dump[2 * i] !== d.dump[2 * i + 1]) differ++; }
    const whole = analyzeTone(left, freq, d.sampleRate);
    // without the first and last 50 ms: a tone that starts and ends abruptly rings in a band-limited resampler
    const edge = Math.round(d.sampleRate * 0.05);
    const core = whole.last - whole.first > 4 * edge ? analyzeTone(left, freq, d.sampleRate, whole.first + edge, whole.last - edge) : whole;
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
    // ... and the runs in which the tone is continuous: split also where two neighbouring samples jump further than
    // the tone can (the recording holds no time while the context is suspended: what follows continues elsewhere in the stream)
    const runs: { from: number; to: number; snr: number; freq: number }[] = [];
    const slope = 1.5 * amp * 2 * Math.PI * freq / d.sampleRate + 0.002;
    for (const st of stretches) {
      let from = st.from;
      for (let i = st.from + 1; i <= st.to; i++) {
        if (i === st.to || Math.abs(left[i] - left[i - 1]) > slope) {
          if (i - from > d.sampleRate * 0.1) { const a = from + Math.round(d.sampleRate * 0.02), b = i - Math.round(d.sampleRate * 0.02); runs.push({ from, to: i, snr: fitSine(left, a, b, freq, d.sampleRate).snr, freq: analyzeTone(left, freq, d.sampleRate, a, b).freq }); }
          from = i;
        }
      }
    }
    const out: Record<string, unknown> = { rate: d.sampleRate, frames: n, whole, core, stretches, runs, channelsDiffer: differ, underrun: d.underrun, callbacks: d.callbacks,
      parts: parts.map(([a, b]) => analyzeTone(left, freq, d.sampleRate, Math.round(a * d.sampleRate), Math.min(n, Math.round(b * d.sampleRate)))) };
    if (wav) { const pcm = new Int16Array(n); for (let i = 0; i < n; i++) pcm[i] = Math.round(left[i] * 32767); out.pcm = Array.from(pcm); }
    return out;
  },
  analyzePcm(pcm: number[], freq: number, rate: number, from: number, to: number): unknown { return analyzeTone(Float32Array.from(pcm, v => v / 32768), freq, rate, from, to); },
};
(window as unknown as { nx: typeof nx }).nx = nx;

// ?auto=gesture: the page runs by itself and reports on the console. Nothing is evaluated from outside before the
// click: a DevTools evaluation counts as a user gesture and would let the context start.
if (location.search === "?auto=gesture") void (async () => {
  const w = window as unknown as { NXCFG: Record<string, unknown>; NXFN: Record<string, number> };
  await nx.init(w.NXCFG, w.NXFN);
  nx.record(5);
  await nx.ask("guest");
  await nx.sleep(1500);
  const s1 = await nx.ask("stats");
  console.log("NX1 " + JSON.stringify({ s: s1, context: nx.context(), active: navigator.userActivation.hasBeenActive }));
  for (;;) { const s = await nx.ask("stats"); if (s.state === "Live") break; await nx.sleep(20); }
  console.log("NXLIVE " + JSON.stringify({ context: nx.context(), active: navigator.userActivation.hasBeenActive }));
  await nx.sleep(2000);
  const s = await nx.ask("stop");
  await nx.sleep(250);
  console.log("NX2 " + JSON.stringify({ s, h: await nx.heard(440) }));
})();
