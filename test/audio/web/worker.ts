// audio:browser, the runtime's side in a Worker: the audio module, its device (AudioDevice), and a "guest": an
// audio thread that keeps a few 5 ms buffers of a tone appended and refills when its release event fires. The
// guest clock is the Worker's wall clock; a timer ticks the module as a run loop would between slices.
import { AudioHost, OUT_S, RING, RET, REQ } from "../../../src/glue/audio_host.ts";
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
// Where this Worker's timer came late: the gaps of 12 ms or more between two ticks (the timer is cfg.tickMs)
let lastUnder = 0, lastLive = 0; const ringLog: unknown[] = [];
let lastTick = 0; const lateTicks: { at: number; gap: number }[] = [];
function tick(): void {
  if (!ticking) return;
  const pn = performance.now();
  if (lastTick && pn - lastTick >= 12 && lateTicks.length < 64) lateTicks.push({ at: Math.round(pn), gap: Math.round(pn - lastTick) });
  lastTick = pn;
  const t = now();
  const hb = host.ringHeader(), b4 = [hb[RING.WR], hb[RING.RD], hb[RING.UNDER], hb[RING.CB], hb[RING.LIVE]];
  device.tick(t, t);
  const ha = host.ringHeader();
  if ((ha[RING.UNDER] !== lastUnder || ha[RING.LIVE] !== lastLive) && ringLog.length < 40) ringLog.push({ at: Math.round(pn * 10) / 10, before: b4, after: [ha[RING.WR], ha[RING.RD], ha[RING.UNDER], ha[RING.CB], ha[RING.LIVE]], state: OUT_S[host.x.audio_out_state(0)] });
  lastUnder = ha[RING.UNDER]; lastLive = ha[RING.LIVE];
  if (g || ren.started) { const s = OUT_S[host.x.audio_out_state(0)] ?? "closed"; if (states.at(-1)?.s !== s) states.push({ t: performance.now(), s }); }
  guestStep();
  renStep();
}
function stats(): Record<string, unknown> {
  const h = host.ringHeader(), x = host.x;
  return { state: g || ren.started ? OUT_S[x.audio_out_state(0)] ?? "closed" : "none", ren: { renders: ren.renders, signals: ren.signals, updates: ren.updates, closed: ren.closed, threadEnded: ren.render?.at.done ?? false, frames: x.audio_ren_frames(), catchups: ren.catchups, played: ren.played, locks: ren.locks }, appended, reclaimed, orderErrors, queued: queue.length, underruns: Number(x.audio_out_stat(0, 7)), silenceBytes: Number(x.audio_out_stat(0, 8)),
    signals: events[0]?.signals ?? 0, ringUnder: h[RING.UNDER], callbacks: h[RING.CB], rd: h[RING.RD], wr: h[RING.WR], rate: device.rate, transport: device.transport, context: device.context,
    mixed: Number(x.audio_mixed_frames()), refused: x.kit_refused_total(), red: logs.filter(l => l.startsWith("[RED] ")), states: states.map(s => ({ ...s })), trace: host.outTrace(0), releaseTimes: releaseTimes.slice(),
    lateTicks: lateTicks.slice(), ringLog,
    isolated: (self as unknown as { crossOriginIsolated: boolean }).crossOriginIsolated, sharedMemory: typeof SharedArrayBuffer !== "undefined" && x.memory.buffer instanceof SharedArrayBuffer, now: performance.now() };
}

// ---- the audio renderer: the module's take-overs (src/audio/ren.ts) with an SDK in JavaScript ----
// The module asks for SDK functions to be run on a guest thread (CALL) and for waits (WAIT); here a guest thread is
// a generator, the SDK's renderer renders the tone into two mix buffers and writes an SDK 16 command list with a
// DeviceSink, and the Worker's timer plays the scheduler. The same take-overs with a translated guest: rt:browser.
type Stop = { wait: number; ns: number; since: number };
type Co = Generator<Stop, bigint, bigint>;
type CoThread = { id: number; g: Co; at: IteratorResult<Stop, bigint> };
const N = {
  OPEN: "_ZN2nn5audio17OpenAudioRendererEPNS0_19AudioRendererHandleEPNS_2os11SystemEventERKNS0_22AudioRendererParameterEPvm", CLOSE: "_ZN2nn5audio18CloseAudioRendererENS0_19AudioRendererHandleE",
  WORK: "_ZN2nn5audio30GetAudioRendererWorkBufferSizeERKNS0_22AudioRendererParameterE", EXEC: "_ZN2nn5audio29ExecuteAudioRendererRenderingENS0_19AudioRendererHandleE",
  UPDATE: "_ZN2nn5audio6server17AudioRenderSystem6UpdateEPvmS3_mPKvm", GEN: "_ZN2nn5audio6server17AudioRenderSystem15GenerateCommandEPvm",
  MODE: "_ZNK2nn5audio6server17AudioRenderSystem16GetExecutionModeEv", DEVICE: "_ZNK2nn5audio6server17AudioRenderSystem18GetRenderingDeviceEv",
  CBUF: "_ZNK2nn5audio6server17AudioRenderSystem26GetCommandBufferWorkBufferEv", CBSZ: "_ZNK2nn5audio6server17AudioRenderSystem30GetCommandBufferWorkBufferSizeEv",
  TMAX: "_ZN2nn5audio3dsp20CommandListProcessor17SetProcessTimeMaxEj", SETUP: "_ZN2nn5audio3dsp20CommandListProcessor5SetupEPKvm", PROCESS: "_ZN2nn5audio3dsp20CommandListProcessor7ProcessEv",
  LOCK: "_ZN2nn2os12SdkMutexType4LockEv", UNLOCK: "_ZN2nn2os12SdkMutexType6UnlockEv",
  EV_DESTROY: "_ZN2nn2os18DestroySystemEventEPNS0_15SystemEventTypeE", EV_ATTACH: "_ZN2nn2os33AttachReadableHandleToSystemEventEPNS0_15SystemEventTypeEjbNS0_14EventClearModeE",
  EV_READABLE: "_ZN2nn2os30GetReadableHandleOfSystemEventEPKNS0_15SystemEventTypeE",
  TH_CREATE: "_ZN2nn2os12CreateThreadEPNS0_10ThreadTypeEPFvPvES3_S3_mi", TH_START: "_ZN2nn2os11StartThreadEPNS0_10ThreadTypeE", TH_WAIT: "_ZN2nn2os10WaitThreadEPNS0_10ThreadTypeE", TH_DESTROY: "_ZN2nn2os13DestroyThreadEPNS0_10ThreadTypeE",
};
const ren = { on: false, started: false, catchups: 0, played: 0, playing: false, closed: false, renders: 0, signals: 0, updates: 0, locks: 0, phase: 0, impl: 0, state: 0, mix: 0, cl: 0, gameEvent: 0, threadArg: 0,
  addr: new Map<string, bigint>(), name: new Map<bigint, string>(), threads: [] as CoThread[], render: null as CoThread | null,
  // what the module has run on a guest thread: these may take long or block
  co: {} as Record<string, (x: bigint[], id: number) => Co | bigint | number>,
  // what it calls itself in the middle of a step
  direct: {} as Record<string, (x: BigUint64Array) => bigint | number> };
function renSdk(): void {
  const dv = () => host.dv, sys = () => ren.impl + 0x60;
  ren.co = {
    [N.OPEN]: x => { ren.impl = alloc(0x400); ren.state = alloc(64); ren.mix = alloc(3 * 240 * 4); ren.cl = alloc(0x400); dv().setBigUint64(Number(x[0]), BigInt(ren.impl), true); dv().setBigUint64(Number(x[0]) + 8, BigInt(ren.state), true); return 0n; },
    [N.CLOSE]: () => { ren.closed = true; return 0n; },
    // the SDK's own ExecuteAudioRendererRendering: the AudioRendererImpl's (the host's take-over), then the renderer's event
    [N.EXEC]: function* (_x, id): Co { const r = yield* takeover(id, "ar_ImplExec", [ren.impl]); ren.signals++; events[ren.gameEvent - 1].flag = true; return r; },
    [N.LOCK]: () => { ren.locks++; return 0n; }, [N.UNLOCK]: () => 0n,
    [N.GEN]: () => {   // SDK 8-20 wire layout: five commands and a DeviceSink (ID 0x13, 0x148 bytes) with inputs 0 and 1
      const d = dv(), cl = ren.cl; new Uint8Array(host.x.memory.buffer, cl, 0x400).fill(0);
      d.setUint32(cl + 4, 6, true); d.setBigUint64(cl + 8, BigInt(ren.mix), true); d.setUint32(cl + 0x14, 240, true); d.setUint32(cl + 0x18, 48000, true);
      let q = cl + 0x20;
      const put = (id: number, size: number) => { d.setUint32(q, 0xcafebabe, true); d.setUint8(q + 4, 1); d.setUint8(q + 5, id); d.setInt16(q + 6, size, true); q += size; return q - size; };
      for (let i = 0; i < 5; i++) put(6, 0x20);
      const sink = put(0x13, 0x148);
      d.setUint32(sink + 0x130, 2, true); d.setInt16(sink + 0x134, 0, true); d.setInt16(sink + 0x136, 1, true);
      return q - cl;
    },
    [N.PROCESS]: () => {   // the CPU "DSP": the tone while the game's voice plays, into mix buffers 0 and 1 (int32 holding 16-bit range)
      const m = new Int32Array(host.x.memory.buffer, ren.mix, 480);
      for (let i = 0; i < 240; i++) { const v = ren.playing ? Math.round(cfg.amp * 32767 * Math.sin(2 * Math.PI * cfg.freq * ren.phase++ / 48000)) : 0; m[i] = v; m[240 + i] = v; }
      ren.renders++;
      return 0n;
    },
    [N.UPDATE]: () => { ren.updates++; return 0n; },
    malloc: x => alloc(Number(x[0])), free: () => 0n,
    [N.TH_CREATE]: x => { ren.threadArg = Number(x[2]); return 0n; },
    [N.TH_START]: () => { const id = 2, g = renEnter(id, ren.threadArg); ren.render = { id, g, at: g.next() }; ren.threads.push(ren.render); return 0n; },
    [N.TH_WAIT]: function* (): Co { while (!ren.render!.at.done) yield { wait: -1, ns: 0, since: 0 }; return 0n; },
    [N.TH_DESTROY]: () => 0n,
  };
  ren.direct = { [N.MODE]: () => 1, [N.DEVICE]: () => 1, [N.CBUF]: () => ren.cl, [N.CBSZ]: () => 0x400, [N.TMAX]: () => 0, [N.SETUP]: () => 0, [N.WORK]: () => 0x4000,
    [N.EV_DESTROY]: () => 0, [N.EV_READABLE]: () => 0x100, [N.EV_ATTACH]: () => 0 };
  // The SDK's code as far as the host reads it: Update's first instructions take the update lock at this + 0x1d8
  // (add x19, x0, #0x1d8; mov x0, x19; bl Lock)
  const code = alloc(0x100), lock = code + 0x80;
  dv().setUint32(code, (0x91000000 | 0x1d8 << 10 | 19) >>> 0, true); dv().setUint32(code + 4, 0xaa0003e0 | 19 << 16, true); dv().setUint32(code + 8, (0x94000000 | ((lock - (code + 8)) >> 2)) >>> 0, true);
  let next = 0x7100_0000n;
  for (const n of [...Object.keys(ren.co), ...Object.keys(ren.direct)]) { const a = n === N.UPDATE ? BigInt(code) : n === N.LOCK ? BigInt(lock) : (next += 0x100n); ren.addr.set(n, a); ren.name.set(a, n); }
  host.embedder.guestFn = name => ren.addr.get(name) ?? 0n;
  host.embedder.guestCall = (fn, x) => BigInt.asUintN(64, BigInt(ren.direct[ren.name.get(fn)!](x)));
  host.embedder.threadEntry = () => 0x7200_0000n;
  host.embedder.handleDup = h => h + 0x1000;
}
function* renServe(id: number): Co {
  const x = host.x, q = x.audio_co_req() >>> 0;
  for (;;) {
    const d = host.dv, kind = d.getUint32(q, true);
    let x0 = 0n;
    if (kind === REQ.CALL) {
      const args: bigint[] = []; for (let i = 0; i < 8; i++) args.push(d.getBigUint64(q + 24 + 8 * i, true));
      const r = ren.co[ren.name.get(d.getBigUint64(q + 8, true))!](args, id);
      x0 = typeof r === "object" ? yield* r : BigInt(r);
    } else x0 = yield { wait: Number(d.getBigUint64(q + 8, true)), ns: Number(d.getBigUint64(q + 16, true)), since: performance.now() };
    const t = now(); host.tick(t, t);
    x.audio_co_thread(id);
    const k = x.audio_co_resume(x0, 0n);
    if (k !== RET.CO) return k & 1 ? host.dv.getBigUint64(q + 8, true) : 0n;
  }
}
function* takeover(id: number, name: string, x: (number | bigint)[]): Co {
  const t = now(); host.tick(t, t);
  host.x.audio_co_thread(id);
  const r = host.call(FN[name], x, { lr: 0x4000 });
  return r.kind === RET.CO ? yield* renServe(id) : r.x0;
}
function* renEnter(id: number, arg: number): Co {
  host.x.audio_co_thread(id);
  return host.x.audio_co_enter(arg, 0x5000n) === RET.CO ? yield* renServe(id) : 0n;
}
// the game: opens its renderer for the DSP with an event, then one RequestUpdate per renderer event; closes when told
let renResult: { open: number } | null = null;
function* renGame(): Co {
  const handle = alloc(16), ev = alloc(64), param = alloc(0x40), d = host.dv;
  [48000, 240, 3, 0, 4, 1, 0, 0].forEach((v, i) => d.setInt32(param + 4 * i, v, true));
  d.setUint32(param + 0x34, 0x38564552, true);   // "REV8"; rendering device 0 (the DSP), execution mode 0
  const size = Number(host.call(FN.ar_WorkSize, [param]).x0), work = (alloc(size + 0x2000) + 0xfff) & ~0xfff;
  events.push({ flag: false, signals: 0 }); ren.gameEvent = events.length;   // the game's read end of the renderer's event
  const rc = yield* takeover(1, "ar_Open", [handle, ev, param, work, size]);
  renResult = { open: Number(rc) };
  ren.playing = true;
  yield* takeover(1, "ars_Update", [ren.impl + 0x60, 0, 0, 0, 0, 0, 0]);
  while (ren.on) { yield { wait: ren.gameEvent, ns: 1e12, since: performance.now() }; yield* takeover(1, "ars_Update", [ren.impl + 0x60, 0, 0, 0, 0, 0, 0]); }
  ren.playing = false;
  yield* takeover(1, "ar_Close", [ren.impl, ren.state]);
  return 0n;
}
// the scheduler: a thread goes on when what it waits for has happened (its event's flag, the thread it joins) or its time is up
function renStep(): void {
  if (!ren.started) return;
  for (let again = true, rounds = 0; again && rounds < 64; rounds++) {
    again = false;
    for (const t of ren.threads) {
      if (t.at.done) continue;
      const s = t.at.value as Stop;
      if (s.wait < 0) { if (!ren.render!.at.done) continue; t.at = t.g.next(0n); }
      else if (events[s.wait - 1]?.flag) { events[s.wait - 1].flag = false; t.at = t.g.next(0n); }
      else if (performance.now() - s.since >= s.ns / 1e6) t.at = t.g.next(1n);
      else continue;
      again = true;
    }
  }
  // the sink's counters while it is open (the render thread closes it when the renderer closes)
  if (Number(BigInt.asIntN(64, host.x.audio_ren_stat(0, 2))) >= 0) { ren.catchups = Number(host.x.audio_rs_stat(0, 4)); ren.played = Number(host.x.audio_rs_stat(0, 5)); }
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
    states.push({ t: performance.now(), s: OUT_S[host.x.audio_out_state(0)] });
    post({ id: m.id, result: { open: Number(r), start: Number(s) } });
  } else if (m.cmd === "renderer") {
    ren.on = ren.started = true; renSdk();
    const g0 = renGame(); ren.threads.push({ id: 1, g: g0, at: g0.next() });
    states.push({ t: performance.now(), s: OUT_S[host.x.audio_out_state(0)] });
    post({ id: m.id, result: renResult });
  } else if (m.cmd === "renclose") {
    ren.on = false; events[ren.gameEvent - 1].flag = true;   // the game's loop ends at its next wake-up
    for (let i = 0; i < 200 && !ren.threads[0].at.done; i++) { renStep(); if (!ren.threads[0].at.done) await new Promise(r => setTimeout(r, 2)); }
    post({ id: m.id, result: stats() });
  } else if (m.cmd === "set") {
    if (m.appending !== undefined) { appending = m.appending; if (appending && !cfg.event) refill(); if (appending && cfg.event) { events[0].flag = true; } }
    if (m.ticking !== undefined) ticking = m.ticking;
    post({ id: m.id, result: true });
  } else if (m.cmd === "busy") {
    // the run loop does not come back for ms milliseconds (a long slice): nothing ticks
    const until = performance.now() + m.ms; while (performance.now() < until) { /* spin */ }
    post({ id: m.id, result: true });
  } else if (m.cmd === "stop") { appending = false; call("au_Stop", g); refill(); post({ id: m.id, result: stats() }); }
  else if (m.cmd === "stats") post({ id: m.id, result: stats() });
  else if (m.cmd === "opus") { const r = await opus(); post({ id: m.id, result: r }, r.pcm ? [(r.pcm as Int16Array).buffer] : []); }
};
