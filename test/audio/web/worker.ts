// audio:browser, the runtime's side in a Worker: the audio module, its device (AudioDevice), and a "guest": an
// audio thread that keeps a few 5 ms buffers of a tone appended and refills when its release event fires. The
// guest clock is the Worker's wall clock; a timer ticks the module as a run loop would between slices.
import { AudioHost, OUT_S, RING } from "../../../src/glue/audio_host.ts";
import { AudioDevice, type AudioTransport } from "../../../src/glue/audio_device.ts";
import { WebCodecsOpus } from "../../../src/glue/audio_opus_webcodecs.ts";

interface Config { shared: boolean; transport?: AudioTransport; sampleRate?: number; targetFrames?: number; freq: number; amp: number; frames: number; inflight: number; tickMs: number; event: boolean }

const post = (m: unknown, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);
let host: AudioHost, device: AudioDevice;
let cfg: Config;
const logs: string[] = [];
const events: { flag: boolean; signals: number }[] = [];
let top = 0;
const alloc = (n: number) => { const p = top; top += (n + 15) & ~15; return p; };
const now = () => BigInt(Math.round(performance.now() * 1e6));
const FN: Record<string, number> = {};

// ---- the guest ----
let g = 0, phase = 0, appending = true, ticking = true;
const queue: number[] = [], free: number[] = [];
let appended = 0, reclaimed = 0, orderErrors = 0;
const releaseTimes: number[] = [];   // performance.now() of each buffer taken back
const states: { t: number; s: string }[] = [];
const call = (name: string, ...x: (number | bigint)[]) => host.call(FN[name], x).x0;

function refill(): void {
  for (let b = Number(call("au_Released", g)); b; b = Number(call("au_Released", g))) {
    if (b !== queue[0]) orderErrors++;
    queue.shift(); free.push(b); reclaimed++; releaseTimes.push(performance.now());
  }
  while (appending && queue.length < cfg.inflight && free.length) {
    const b = free.pop()!, data = Number(host.dv.getBigUint64(b, true)), pcm = new Int16Array(host.x.memory.buffer, data, cfg.frames * 2);
    for (let i = 0; i < cfg.frames; i++, phase++) pcm[2 * i] = pcm[2 * i + 1] = Math.round(cfg.amp * 32767 * Math.sin(2 * Math.PI * cfg.freq * phase / 48000));
    if (call("au_Append", g, b) !== 1n) { free.push(b); break; }
    queue.push(b); appended++;
  }
}
function guestStep(): void {
  if (!g) return;
  if (cfg.event) { const ev = events[0]; if (!ev.flag) return; ev.flag = false; }
  refill();
}
function tick(): void {
  if (!ticking) return;
  const t = now();
  device.tick(t, t);
  if (g) { const s = OUT_S[host.x.audio_out_state(0)] ?? "closed"; if (states.at(-1)?.s !== s) states.push({ t: performance.now(), s }); }
  guestStep();
}
function stats(): Record<string, unknown> {
  const h = host.ringHeader(), x = host.x;
  return { state: g ? OUT_S[x.audio_out_state(0)] : "none", appended, reclaimed, orderErrors, queued: queue.length, underruns: Number(x.audio_out_stat(0, 7)), silenceBytes: Number(x.audio_out_stat(0, 8)),
    signals: events[0]?.signals ?? 0, ringUnder: h[RING.UNDER], callbacks: h[RING.CB], rd: h[RING.RD], wr: h[RING.WR], rate: device.rate, transport: device.transport, context: device.context,
    mixed: Number(x.audio_mixed_frames()), refused: x.kit_refused_total(), red: logs.filter(l => l.startsWith("[RED] ")), states: states.map(s => ({ ...s })), releaseTimes: releaseTimes.slice(),
    isolated: (self as unknown as { crossOriginIsolated: boolean }).crossOriginIsolated, sharedMemory: x.memory.buffer instanceof SharedArrayBuffer, now: performance.now() };
}

// ---- Opus through WebCodecs: encode a tone with the browser's encoder, decode it through the decoder manager ----
async function opus(): Promise<Record<string, unknown>> {
  const G = globalThis as any;   // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!WebCodecsOpus.available() || typeof G.AudioEncoder !== "function") return { skipped: "no WebCodecs audio in this browser" };
  const packets: Uint8Array[] = [];
  const enc = new G.AudioEncoder({ output: (c: any) => { const u = new Uint8Array(c.byteLength); c.copyTo(u); packets.push(u); }, error: (e: unknown) => { throw e; } });   // eslint-disable-line @typescript-eslint/no-explicit-any
  enc.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2, bitrate: 96000 });
  const N = 48000, tone = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) tone[2 * i] = tone[2 * i + 1] = 0.5 * Math.sin(2 * Math.PI * 440 * i / 48000);
  for (let o = 0; o < N; o += 960) enc.encode(new G.AudioData({ format: "f32", sampleRate: 48000, numberOfFrames: 960, numberOfChannels: 2, timestamp: Math.round(o * 1e6 / 48000), data: tone.subarray(o * 2, (o + 960) * 2) }));
  await enc.flush(); enc.close();
  // the game's side: a manager, a decoder, one packet per call with Nintendo's header, Execute once per frame
  host.embedder.opus = new WebCodecsOpus(host);
  host.x.audio_opus_backend(2);
  const gm = alloc(0x18), ev = alloc(64), gd = alloc(0x30), pkt = alloc(0x1800), used = alloc(8), out = alloc(11520), smp = alloc(8);
  if (call("codec_HwOpusMgrInit", gm, ev, 48000, 2, 20000000, 4, 16, 0, 0x1000) !== 0n) return { error: "manager init" };
  const event = events.at(-1)!;
  if (call("codec_HwOpusMgrDecInit", gd, 48000, 2, 20000000, gm) !== 0n) return { error: "decoder init" };
  const pcm: number[] = [];
  let maxExecuting = 0, frames = 0, signalsSeen = 0;
  const take = () => { while (Number(call("codec_HwOpusCompleted", gd)) > 0) { if (call("codec_HwOpusDequeue", gd, smp, out, 11520) !== 0n) break; const n = host.dv.getInt32(smp, true); frames++; const s = new Int16Array(host.x.memory.buffer, out, n * 2); for (let i = 0; i < n; i++) pcm.push(s[2 * i]); } };
  for (const p of packets) {
    const dv = host.dv; dv.setUint32(pkt, p.length, false); dv.setUint32(pkt + 4, 0, false);
    new Uint8Array(host.x.memory.buffer, pkt + 8, p.length).set(p);
    while (Number(call("codec_HwOpusMgrFreeIo", gm)) === 0) { await new Promise(r => setTimeout(r, 1)); take(); }
    if (call("codec_HwOpusEnqueue", gd, used, pkt, 8 + p.length) !== 0n) return { error: "enqueue" };
    call("codec_HwOpusExecute", gm);
    maxExecuting = Math.max(maxExecuting, Number(call("codec_HwOpusExecuting", gd)));
    await new Promise(r => setTimeout(r, 0));   // the game's audio frame; the decoder answers in between
    if (event.flag) { event.flag = false; signalsSeen++; take(); }
  }
  for (let i = 0; i < 200 && frames < packets.length; i++) { await new Promise(r => setTimeout(r, 5)); take(); }
  const counts = [call("codec_HwOpusWaiting", gd), call("codec_HwOpusExecuting", gd), call("codec_HwOpusCompleted", gd)].map(Number);
  const freeIo = Number(call("codec_HwOpusMgrFreeIo", gm));
  call("codec_HwOpusFini", gd); call("codec_HwOpusMgrFini", gm);
  return { packets: packets.length, bytes: packets.reduce((s, p) => s + p.length, 0), frames, samples: pcm.length, pcm: new Int16Array(pcm), maxExecuting, signals: event.signals, signalsSeen, counts, freeIo,
    arena: host.x.audio_arena_used(), red: logs.filter(l => l.startsWith("[RED] ")), refused: host.x.kit_refused_total() };
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.audio) { device.handle(m); return; }
  if (m.cmd === "init") {
    cfg = m.cfg; Object.assign(FN, m.fn);
    const bytes = await (await fetch(cfg.shared ? "/audio.shared.wasm" : "/audio.wasm")).arrayBuffer();
    const module = new WebAssembly.Module(bytes);
    const memory = cfg.shared ? new WebAssembly.Memory({ initial: 512, maximum: 65536, shared: true }) : undefined;
    host = new AudioHost(module, {
      log: l => { logs.push(l); },
      eventBind: () => { events.push({ flag: false, signals: 0 }); return events.length; },
      eventSignal: t => { events[t - 1].flag = true; events[t - 1].signals++; },
    }, memory);
    const x = host.x;
    const end = cfg.shared ? 16 << 20 : (x.audio_static_end() + 0xFFFF) & ~0xFFFF;   // the shared build's static data sits at 1 MB
    const need = end + (8 << 20) + (8 << 20) - x.memory.buffer.byteLength;
    if (need > 0) x.memory.grow(Math.ceil(need / 65536));
    top = end; x.audio_init(end + (8 << 20), 8 << 20);
    x.audio_set_catchup_limit(100_000_000n);   // the guest clock here is a wall clock
    device = new AudioDevice(host, (msg, t) => post(msg, t), { transport: cfg.transport, sampleRate: cfg.sampleRate, targetFrames: cfg.targetFrames });
    host.embedder.device = device;
    setInterval(tick, cfg.tickMs);
    post({ ready: true, transport: device.transport });
  } else if (m.cmd === "guest") {
    // the game opens its output, appends its first buffers and starts
    g = alloc(64);
    const ev = alloc(64), param = alloc(16);
    const t = now(); host.tick(t, t);
    const r = cfg.event ? call("au_Open", g, ev, 0, param) : call("au_Open4", g, 0, param);
    for (let i = 0; i < cfg.inflight + 2; i++) { const data = alloc(cfg.frames * 4), b = alloc(64); call("au_SetBuf", b, data, cfg.frames * 4, cfg.frames * 4); free.push(b); }
    refill();
    const s = call("au_Start", g);
    post({ id: m.id, result: { open: Number(r), start: Number(s) } });
  } else if (m.cmd === "set") {
    if (m.appending !== undefined) { appending = m.appending; if (appending && !cfg.event) refill(); if (appending && cfg.event) { events[0].flag = true; } }
    if (m.ticking !== undefined) ticking = m.ticking;
    post({ id: m.id, result: true });
  } else if (m.cmd === "busy") {
    // the run loop does not come back for ms milliseconds (a long slice): nothing ticks
    const until = performance.now() + m.ms; while (performance.now() < until) { /* spin */ }
    post({ id: m.id, result: true });
  } else if (m.cmd === "stop") { call("au_Stop", g); refill(); post({ id: m.id, result: stats() }); }
  else if (m.cmd === "stats") post({ id: m.id, result: stats() });
  else if (m.cmd === "opus") { const r = await opus(); post({ id: m.id, result: r }, r.pcm ? [(r.pcm as Int16Array).buffer] : []); }
};
